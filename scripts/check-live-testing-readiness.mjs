#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { verifyPhysicalAndroidAdbDevices } from "./android-evidence-common.mjs";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const options = parseArgs(process.argv.slice(2));

if (options.selfTest) {
  runSelfTest();
  process.exit(0);
}

const result = runReadinessCheck({ root, localOnly: options.localOnly });
for (const line of result.ok) {
  console.log(`ok: ${line}`);
}
for (const line of result.pending) {
  console.log(`pending: ${line}`);
}

if (result.failures.length > 0) {
  console.error(result.failures.map((failure) => `error: ${failure}`).join("\n"));
  process.exit(1);
}

console.log(result.pending.length > 0 ? "live testing local readiness ok with pending physical-device steps" : "live testing readiness ok");

function runReadinessCheck({ root, localOnly }) {
  const ok = [];
  const pending = [];
  const failures = [];

  checkExecutable(path.join(root, "target/release/fieldwork"), "release fieldwork binary", failures, ok);
  checkExecutable(path.join(root, "target/release/fieldworkd"), "release fieldworkd binary", failures, ok);
  checkFile(path.join(root, "apps/android/app/build/outputs/apk/debug/app-debug.apk"), "Android debug APK", failures, ok);
  checkFile(path.join(root, "apps/android/app/build/outputs/bundle/release/app-release.aab"), "Android unsigned release AAB", failures, ok);
  checkFile(path.join(root, "scripts/create-live-testing-evidence-dir.mjs"), "live testing evidence scaffold", failures, ok);
  checkFile(path.join(root, "scripts/verify-live-testing-evidence.mjs"), "live testing evidence verifier", failures, ok);
  checkFile(path.join(root, "docs/LIVE_TESTING.md"), "live testing runbook", failures, ok);

  const buildConfigPath = path.join(root, "apps/android/app/build/generated/source/buildConfig/debug/app/fieldwork/android/BuildConfig.java");
  if (fs.existsSync(buildConfigPath)) {
    checkBuildConfigText(fs.readFileSync(buildConfigPath, "utf8"), failures, ok, { file: path.relative(root, buildConfigPath) });
  } else {
    failures.push(`missing debug BuildConfig: ${path.relative(root, buildConfigPath)}; run apps/android/gradlew --no-daemon :app:assembleDebug`);
  }

  const aabResult = spawnSync(process.execPath, ["scripts/verify-android-aab.mjs", "--expect-unsigned"], {
    cwd: root,
    encoding: "utf8",
  });
  if (aabResult.error) {
    failures.push(`Android AAB verifier failed to start: ${aabResult.error.message}`);
  } else if (aabResult.status !== 0) {
    failures.push(`Android AAB verifier failed:\n${trimCommandOutput(aabResult.stdout)}${trimCommandOutput(aabResult.stderr)}`);
  } else {
    ok.push("Android AAB verifier passed with local unsigned policy");
  }

  checkAdbState({ localOnly, failures, pending, ok });

  return { failures, ok, pending };
}

function checkExecutable(filePath, label, failures, ok) {
  if (!fs.existsSync(filePath)) {
    failures.push(`missing ${label}: ${path.relative(root, filePath)}`);
    return;
  }
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) {
    failures.push(`${label} is not a file: ${path.relative(root, filePath)}`);
    return;
  }
  if ((stat.mode & 0o111) === 0) {
    failures.push(`${label} is not executable: ${path.relative(root, filePath)}`);
    return;
  }
  ok.push(`${label} exists and is executable`);
}

function checkFile(filePath, label, failures, ok) {
  if (!fs.existsSync(filePath)) {
    failures.push(`missing ${label}: ${path.relative(root, filePath)}`);
    return;
  }
  if (!fs.statSync(filePath).isFile()) {
    failures.push(`${label} is not a file: ${path.relative(root, filePath)}`);
    return;
  }
  ok.push(`${label} exists`);
}

function checkBuildConfigText(text, failures, ok, { file = "BuildConfig.java" } = {}) {
  const required = [
    [/\bAPPLICATION_ID\s*=\s*"app\.fieldwork\.android"/, `${file} must use app.fieldwork.android`],
    [/\bBUILD_TYPE\s*=\s*"debug"/, `${file} must be the debug build for first-round live testing`],
    [/\bDEBUG\s*=\s*(?:Boolean\.parseBoolean\("true"\)|true)/, `${file} must have BuildConfig.DEBUG enabled`],
    [/\bFIELDWORK_BIOMETRIC_BYPASS\s*=\s*false\b/, `${file} must disable the debug biometric bypass`],
    [/\bFIELDWORK_DEBUG_PAIRING_PAYLOAD\s*=\s*""/, `${file} must not embed a debug pairing payload`],
  ];

  const before = failures.length;
  for (const [pattern, message] of required) {
    if (!pattern.test(text)) {
      failures.push(message);
    }
  }
  if (failures.length === before) {
    ok.push("debug BuildConfig is normal: no bypass and no embedded pairing payload");
  }
}

function checkAdbState({ localOnly, failures, pending, ok }) {
  const adb = spawnSync("adb", ["devices", "-l"], { encoding: "utf8" });
  if (adb.error) {
    if (localOnly) {
      pending.push("adb is unavailable; install Android platform-tools before physical evidence capture");
      return;
    }
    failures.push(`adb is unavailable: ${adb.error.message}`);
    return;
  }
  if (adb.status !== 0) {
    failures.push(`adb devices -l failed:\n${trimCommandOutput(adb.stdout)}${trimCommandOutput(adb.stderr)}`);
    return;
  }

  const adbState = evaluateAdbStateText(adb.stdout, { localOnly });
  ok.push(...adbState.ok);
  pending.push(...adbState.pending);
  failures.push(...adbState.failures);

  if (adbState.physicalReady) {
    checkInstalledAndroidPackage({ failures, ok });
  }
}

function checkInstalledAndroidPackage({ failures, ok }) {
  const installed = spawnSync("adb", ["shell", "pm", "path", "app.fieldwork.android"], {
    encoding: "utf8",
  });
  if (installed.error) {
    failures.push(`adb package check failed to start: ${installed.error.message}`);
    return;
  }
  if (installed.status !== 0 || !/^package:/m.test(installed.stdout)) {
    failures.push("app.fieldwork.android is not installed on the connected device; run adb install -r apps/android/app/build/outputs/apk/debug/app-debug.apk");
    return;
  }
  ok.push("app.fieldwork.android is installed on the connected adb device");
}

function evaluateAdbStateText(text, { localOnly }) {
  const ok = [];
  const pending = [];
  const failures = [];
  const adbFailures = [];
  verifyPhysicalAndroidAdbDevices(text, adbFailures, { file: "adb devices -l" });
  const devices = parseAdbDevices(text);

  if (adbFailures.length === 0) {
    ok.push("exactly one authorized physical Android phone is connected over adb");
    return { failures, ok, pending, physicalReady: true };
  }

  if (localOnly && devices.length === 0) {
    pending.push("connect exactly one authorized physical Android phone before the evidence pass");
    return { failures, ok, pending, physicalReady: false };
  }

  failures.push(...adbFailures);
  return { failures, ok, pending, physicalReady: false };
}

function parseAdbDevices(text) {
  return text
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith("* "))
    .map((line) => {
      const [serial, state, ...details] = line.split(/\s+/);
      return { serial, state, details: details.join(" ") };
    });
}

function trimCommandOutput(text) {
  const trimmed = text.trim();
  return trimmed.length > 0 ? `${trimmed}\n` : "";
}

function parseArgs(args) {
  const parsed = {
    localOnly: false,
    selfTest: false,
  };

  for (const arg of args) {
    if (arg === "--") {
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }
    if (arg === "--local-only") {
      parsed.localOnly = true;
      continue;
    }
    if (arg === "--self-test") {
      parsed.selfTest = true;
      continue;
    }
    console.error(`unknown argument: ${arg}`);
    printUsage();
    process.exit(2);
  }

  return parsed;
}

function printUsage() {
  console.error("usage: node scripts/check-live-testing-readiness.mjs [--local-only] [--self-test]");
}

function runSelfTest() {
  const failures = [];
  const ok = [];
  checkBuildConfigText(
    [
      'public static final boolean DEBUG = Boolean.parseBoolean("true");',
      'public static final String APPLICATION_ID = "app.fieldwork.android";',
      'public static final String BUILD_TYPE = "debug";',
      "public static final boolean FIELDWORK_BIOMETRIC_BYPASS = false;",
      'public static final String FIELDWORK_DEBUG_PAIRING_PAYLOAD = "";',
    ].join("\n"),
    failures,
    ok,
  );
  expectDeepEqual(failures, [], "normal debug BuildConfig should pass");

  for (const [text, expected] of [
    [
      [
        'public static final boolean DEBUG = false;',
        'public static final String APPLICATION_ID = "app.fieldwork.android";',
        'public static final String BUILD_TYPE = "release";',
        "public static final boolean FIELDWORK_BIOMETRIC_BYPASS = false;",
        'public static final String FIELDWORK_DEBUG_PAIRING_PAYLOAD = "";',
      ].join("\n"),
      "must be the debug build",
    ],
    [
      [
        'public static final boolean DEBUG = Boolean.parseBoolean("true");',
        'public static final String APPLICATION_ID = "app.fieldwork.android";',
        'public static final String BUILD_TYPE = "debug";',
        "public static final boolean FIELDWORK_BIOMETRIC_BYPASS = true;",
        'public static final String FIELDWORK_DEBUG_PAIRING_PAYLOAD = "";',
      ].join("\n"),
      "must disable the debug biometric bypass",
    ],
    [
      [
        'public static final boolean DEBUG = Boolean.parseBoolean("true");',
        'public static final String APPLICATION_ID = "app.fieldwork.android";',
        'public static final String BUILD_TYPE = "debug";',
        "public static final boolean FIELDWORK_BIOMETRIC_BYPASS = false;",
        'public static final String FIELDWORK_DEBUG_PAIRING_PAYLOAD = "{\\"pair\\":true}";',
      ].join("\n"),
      "must not embed a debug pairing payload",
    ],
  ]) {
    const textFailures = [];
    checkBuildConfigText(text, textFailures, []);
    expect(textFailures.some((failure) => failure.includes(expected)), `BuildConfig failure should include ${expected}`);
  }

  const emptyAdbFailures = [];
  verifyPhysicalAndroidAdbDevices("List of devices attached\n\n", emptyAdbFailures, { file: "adb devices -l" });
  expect(emptyAdbFailures.some((failure) => failure.includes("exactly one authorized physical")), "empty adb output should fail physical-device verification");
  expectEqual(parseAdbDevices("List of devices attached\n\n").length, 0, "empty adb output should parse zero devices");
  expectDeepEqual(
    evaluateAdbStateText("List of devices attached\n\n", { localOnly: true }),
    {
      failures: [],
      ok: [],
      pending: ["connect exactly one authorized physical Android phone before the evidence pass"],
      physicalReady: false,
    },
    "local-only empty adb output should be pending",
  );
  expect(
    evaluateAdbStateText("List of devices attached\n\n", { localOnly: false }).failures.some((failure) =>
      failure.includes("exactly one authorized physical"),
    ),
    "strict empty adb output should fail",
  );

  const emulatorFailures = [];
  const emulatorAdbText = "List of devices attached\nemulator-5554 device product:sdk_gphone64 model:sdk_gphone64_arm64 device:emu64a transport_id:1\n";
  verifyPhysicalAndroidAdbDevices(emulatorAdbText, emulatorFailures, { file: "adb devices -l" });
  expect(emulatorFailures.some((failure) => failure.includes("not an emulator")), "emulator adb output should fail physical-device verification");
  expect(
    evaluateAdbStateText(emulatorAdbText, { localOnly: true }).failures.some((failure) => failure.includes("not an emulator")),
    "local-only emulator adb output should still fail",
  );

  const physicalFailures = [];
  const physicalAdbText = "List of devices attached\nR5CT123ABC device usb:1-1 product:raven model:Pixel_6 device:raven transport_id:2\n";
  verifyPhysicalAndroidAdbDevices(physicalAdbText, physicalFailures, { file: "adb devices -l" });
  expectDeepEqual(physicalFailures, [], "single authorized physical adb output should pass");
  expectDeepEqual(
    evaluateAdbStateText(physicalAdbText, { localOnly: false }),
    {
      failures: [],
      ok: ["exactly one authorized physical Android phone is connected over adb"],
      pending: [],
      physicalReady: true,
    },
    "single authorized physical adb output should be ready",
  );

  console.log("live testing readiness self-test ok");
}

function expect(value, message) {
  if (!value) {
    throw new Error(message);
  }
}

function expectEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function expectDeepEqual(actual, expected, message) {
  expectEqual(JSON.stringify(actual), JSON.stringify(expected), message);
}
