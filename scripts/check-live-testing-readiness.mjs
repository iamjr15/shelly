#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import {
  verifyInstalledAndroidPackageInfo,
  verifyPhysicalAndroidAdbDevices,
} from "./android-evidence-common.mjs";

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
  checkReleaseCommandSurface({ root, failures, ok });
  checkFile(path.join(root, "apps/android/app/build/outputs/apk/debug/app-debug.apk"), "Android debug APK", failures, ok);
  checkFile(path.join(root, "apps/android/app/build/outputs/bundle/release/app-release.aab"), "Android unsigned release AAB", failures, ok);
  checkFile(path.join(root, "scripts/create-live-testing-evidence-dir.mjs"), "live testing evidence scaffold", failures, ok);
  checkFile(path.join(root, "scripts/verify-live-testing-evidence.mjs"), "live testing evidence verifier", failures, ok);
  checkFile(path.join(root, "docs/LIVE_TESTING.md"), "live testing runbook", failures, ok);
  checkFwAlias({ localOnly, failures, pending, ok });

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

function checkFwAlias({ localOnly, failures, pending, ok }) {
  const result = spawnSync("fw", ["--help"], { encoding: "utf8" });
  const strictEvaluation = evaluateFwAliasResult(result, { localOnly: false });
  if (strictEvaluation.failures.length === 0) {
    ok.push(...strictEvaluation.ok);
    return;
  }

  if (localOnly) {
    const shimEvaluation = evaluateRepoLocalFwShim({ root });
    if (shimEvaluation.failures.length === 0) {
      ok.push(...shimEvaluation.ok);
      return;
    }
  }

  const evaluated = evaluateFwAliasResult(result, { localOnly });
  ok.push(...evaluated.ok);
  pending.push(...evaluated.pending);
  failures.push(...evaluated.failures);
}

function checkReleaseCommandSurface({ root, failures, ok }) {
  const fieldwork = path.join(root, "target/release/fieldwork");
  if (fs.existsSync(fieldwork)) {
    const evaluated = evaluateReleaseFieldworkDoctorHelp(
      spawnSync(fieldwork, ["doctor", "--help"], {
        encoding: "utf8",
      }),
    );
    ok.push(...evaluated.ok);
    failures.push(...evaluated.failures);
  }

  const fieldworkd = path.join(root, "target/release/fieldworkd");
  if (fs.existsSync(fieldworkd)) {
    const evaluated = evaluateReleaseDaemonHelp(
      spawnSync(fieldworkd, ["--help"], {
        encoding: "utf8",
      }),
    );
    ok.push(...evaluated.ok);
    failures.push(...evaluated.failures);
  }
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
    [/\bFIELDWORK_DEBUG_PAIRING_CODE\s*=\s*""/, `${file} must not embed a debug pairing code`],
    [/\bFIELDWORK_RELAY_CONTROL_URL\s*=\s*""/, `${file} must not embed a debug relay control URL`],
  ];

  const before = failures.length;
  for (const [pattern, message] of required) {
    if (!pattern.test(text)) {
      failures.push(message);
    }
  }
  if (failures.length === before) {
    ok.push("debug BuildConfig is normal: no bypass, no embedded pairing code, and no relay override");
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
  const pathResult = spawnSync("adb", ["shell", "pm", "path", "app.fieldwork.android"], {
    encoding: "utf8",
  });
  if (pathResult.error) {
    failures.push(`adb package check failed to start: ${pathResult.error.message}`);
    return;
  }
  if (pathResult.status !== 0 || !/^package:/m.test(pathResult.stdout)) {
    failures.push("app.fieldwork.android is not installed on the connected device; run adb install -r apps/android/app/build/outputs/apk/debug/app-debug.apk");
    return;
  }

  const packageResult = spawnSync("adb", ["shell", "dumpsys", "package", "app.fieldwork.android"], {
    encoding: "utf8",
  });
  if (packageResult.error) {
    failures.push(`adb package details check failed to start: ${packageResult.error.message}`);
    return;
  }
  if (packageResult.status !== 0) {
    failures.push(`adb package details check failed:\n${trimCommandOutput(packageResult.stdout)}${trimCommandOutput(packageResult.stderr)}`);
    return;
  }

  const before = failures.length;
  verifyInstalledAndroidPackageInfo(`${pathResult.stdout}\n${packageResult.stdout}`, failures, { file: "adb package check" });
  if (failures.length === before) {
    ok.push("installed app.fieldwork.android package proof matches versionName=1.0 and versionCode=1");
  }
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

  if (localOnly) {
    pending.push(adbPendingMessage(devices));
    return { failures, ok, pending, physicalReady: false };
  }

  failures.push(...adbFailures);
  return { failures, ok, pending, physicalReady: false };
}

function evaluateFwAliasResult(result, { localOnly }) {
  const ok = [];
  const pending = [];
  const failures = [];
  const setupMessage = "install the npm package or run the docs/LIVE_TESTING.md Desktop Setup shim first";

  if (result.error) {
    const message = `fw is unavailable; ${setupMessage}`;
    if (localOnly) {
      pending.push(message);
    } else {
      failures.push(message);
    }
    return { failures, ok, pending };
  }

  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  if (result.status !== 0 || !/\bUsage:\s+fw\b/.test(output)) {
    const message = `fw on PATH must resolve the Fieldwork short alias and print Usage: fw; ${setupMessage}`;
    if (localOnly) {
      pending.push(message);
    } else {
      failures.push(message);
    }
    return { failures, ok, pending };
  }

  ok.push("fw short alias resolves to Fieldwork CLI");
  return { failures, ok, pending };
}

function evaluateRepoLocalFwShim({ root }) {
  const ok = [];
  const failures = [];
  const releaseFieldwork = path.join(root, "target/release/fieldwork");
  if (!fs.existsSync(releaseFieldwork) || !fs.statSync(releaseFieldwork).isFile() || (fs.statSync(releaseFieldwork).mode & 0o111) === 0) {
    failures.push("repo-local release fieldwork is unavailable for the local fw shim");
    return { failures, ok };
  }

  const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), "fieldwork-live-fw-shim-"));
  try {
    const fw = path.join(shimDir, "fw");
    fs.symlinkSync(releaseFieldwork, fw);
    const help = evaluateRepoLocalFwShimHelp(spawnSync(fw, ["--help"], { cwd: root, encoding: "utf8" }));
    const doctorHelp = evaluateRepoLocalFwShimDoctorHelp(spawnSync(fw, ["doctor", "--help"], { cwd: root, encoding: "utf8" }));
    ok.push(...help.ok, ...doctorHelp.ok);
    failures.push(...help.failures, ...doctorHelp.failures);
  } finally {
    fs.rmSync(shimDir, { recursive: true, force: true });
  }
  return { failures, ok };
}

function evaluateRepoLocalFwShimHelp(result) {
  const ok = [];
  const failures = [];
  if (result.error) {
    failures.push(`repo-local fw shim could not start: ${result.error.message}`);
    return { failures, ok };
  }
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  if (result.status !== 0 || !/\bUsage:\s+fw\b/.test(output)) {
    failures.push("repo-local release fieldwork does not render Usage: fw when invoked through the live-testing shim");
    return { failures, ok };
  }
  ok.push("repo-local release fieldwork supports the fw short alias through the live-testing shim");
  return { failures, ok };
}

function evaluateRepoLocalFwShimDoctorHelp(result) {
  const ok = [];
  const failures = [];
  if (result.error) {
    failures.push(`repo-local fw doctor shim could not start: ${result.error.message}`);
    return { failures, ok };
  }
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  if (result.status !== 0 || !/\bUsage:\s+fw\s+doctor\b/.test(output) || !/--no-start\b/.test(output)) {
    failures.push("repo-local release fieldwork does not render the fw doctor command surface through the live-testing shim");
    return { failures, ok };
  }
  ok.push("repo-local release fieldwork supports fw doctor through the live-testing shim");
  return { failures, ok };
}

function evaluateReleaseFieldworkDoctorHelp(result) {
  const ok = [];
  const failures = [];
  const rebuildMessage = "rebuild release desktop binaries with `cargo build --release -p fieldwork-cli -p fieldwork-daemon` or `pnpm build:local-npm-artifacts`";

  if (result.error) {
    failures.push(`release fieldwork doctor --help could not start: ${result.error.message}; ${rebuildMessage}`);
    return { failures, ok };
  }

  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  if (result.status !== 0) {
    failures.push(`release fieldwork doctor --help failed; ${rebuildMessage}\n${trimCommandOutput(output)}`);
    return { failures, ok };
  }

  if (!/\bUsage:\s+(?:fieldwork|fw)\s+doctor\b/.test(output) || !/--no-start\b/.test(output)) {
    failures.push(`release fieldwork binary is stale or missing the doctor command surface; ${rebuildMessage}`);
    return { failures, ok };
  }

  ok.push("release fieldwork command surface includes doctor");
  return { failures, ok };
}

function evaluateReleaseDaemonHelp(result) {
  const ok = [];
  const failures = [];
  const rebuildMessage = "rebuild release desktop binaries with `cargo build --release -p fieldwork-cli -p fieldwork-daemon` or `pnpm build:local-npm-artifacts`";

  if (result.error) {
    failures.push(`release fieldworkd --help could not start: ${result.error.message}; ${rebuildMessage}`);
    return { failures, ok };
  }

  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  if (result.status !== 0) {
    failures.push(`release fieldworkd --help failed; ${rebuildMessage}\n${trimCommandOutput(output)}`);
    return { failures, ok };
  }

  if (!/\bUsage:\s+fieldworkd\b/.test(output)) {
    failures.push(`release fieldworkd binary is stale or missing its help surface; ${rebuildMessage}`);
    return { failures, ok };
  }

  ok.push("release fieldworkd help surface is current");
  return { failures, ok };
}

function adbPendingMessage(devices) {
  if (devices.length === 0) {
    return "connect exactly one authorized physical Android phone before the evidence pass";
  }

  if (devices.some((device) => device.state !== "device")) {
    return "authorize or reconnect the Android phone before the evidence pass; local mode does not accept offline or unauthorized adb targets";
  }

  if (devices.length > 1) {
    return "disconnect extra adb targets before the evidence pass; exactly one authorized physical Android phone is required";
  }

  if (devices.some(isEmulatorDevice)) {
    return "disconnect the emulator/AVD and connect exactly one authorized physical Android phone before the evidence pass";
  }

  return "connect exactly one authorized physical Android phone before the evidence pass";
}

function isEmulatorDevice(device) {
  return /^(?:emulator-\d+)$/i.test(device.serial) || /\b(?:sdk_gphone|sdk_gphone64|generic_x86|generic_x86_64|goldfish|ranchu|qemu|avd|device:emu[^\s]*)\b/i.test(device.details);
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
      'public static final String FIELDWORK_DEBUG_PAIRING_CODE = "";',
      'public static final String FIELDWORK_RELAY_CONTROL_URL = "";',
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
        'public static final String FIELDWORK_DEBUG_PAIRING_CODE = "";',
        'public static final String FIELDWORK_RELAY_CONTROL_URL = "";',
      ].join("\n"),
      "must be the debug build",
    ],
    [
      [
        'public static final boolean DEBUG = Boolean.parseBoolean("true");',
        'public static final String APPLICATION_ID = "app.fieldwork.android";',
        'public static final String BUILD_TYPE = "debug";',
        "public static final boolean FIELDWORK_BIOMETRIC_BYPASS = true;",
        'public static final String FIELDWORK_DEBUG_PAIRING_CODE = "";',
        'public static final String FIELDWORK_RELAY_CONTROL_URL = "";',
      ].join("\n"),
      "must disable the debug biometric bypass",
    ],
    [
      [
        'public static final boolean DEBUG = Boolean.parseBoolean("true");',
        'public static final String APPLICATION_ID = "app.fieldwork.android";',
        'public static final String BUILD_TYPE = "debug";',
        "public static final boolean FIELDWORK_BIOMETRIC_BYPASS = false;",
        'public static final String FIELDWORK_DEBUG_PAIRING_CODE = "K7M2Q";',
        'public static final String FIELDWORK_RELAY_CONTROL_URL = "";',
      ].join("\n"),
      "must not embed a debug pairing code",
    ],
    [
      [
        'public static final boolean DEBUG = Boolean.parseBoolean("true");',
        'public static final String APPLICATION_ID = "app.fieldwork.android";',
        'public static final String BUILD_TYPE = "debug";',
        "public static final boolean FIELDWORK_BIOMETRIC_BYPASS = false;",
        'public static final String FIELDWORK_DEBUG_PAIRING_CODE = "";',
        'public static final String FIELDWORK_RELAY_CONTROL_URL = "https://relay.example.test";',
      ].join("\n"),
      "must not embed a debug relay control URL",
    ],
  ]) {
    const textFailures = [];
    checkBuildConfigText(text, textFailures, []);
    expect(textFailures.some((failure) => failure.includes(expected)), `BuildConfig failure should include ${expected}`);
  }

  expectDeepEqual(
    evaluateFwAliasResult({ status: 0, stdout: "Usage: fw [COMMAND]\n", stderr: "" }, { localOnly: false }),
    {
      failures: [],
      ok: ["fw short alias resolves to Fieldwork CLI"],
      pending: [],
    },
    "valid fw alias help should pass",
  );
  expectDeepEqual(
    evaluateFwAliasResult({ error: new Error("ENOENT"), stdout: "", stderr: "" }, { localOnly: true }),
    {
      failures: [],
      ok: [],
      pending: ["fw is unavailable; install the npm package or run the docs/LIVE_TESTING.md Desktop Setup shim first"],
    },
    "local-only missing fw alias should be pending guidance",
  );
  expect(
    evaluateFwAliasResult({ error: new Error("ENOENT"), stdout: "", stderr: "" }, { localOnly: false }).failures.some((failure) =>
      failure.includes("fw is unavailable"),
    ),
    "strict missing fw alias should fail",
  );
  expect(
    evaluateFwAliasResult({ status: 0, stdout: "Usage: fieldwork [COMMAND]\n", stderr: "" }, { localOnly: false }).failures.some((failure) =>
      failure.includes("Usage: fw"),
    ),
    "strict wrong fw alias should fail",
  );
  expect(
    evaluateFwAliasResult({ status: 2, stdout: "", stderr: "not fieldwork\n" }, { localOnly: true }).pending.some((failure) =>
      failure.includes("Usage: fw"),
    ),
    "local-only wrong fw alias should be pending guidance",
  );
  expectDeepEqual(
    evaluateRepoLocalFwShimHelp({ status: 0, stdout: "Usage: fw [COMMAND]\n", stderr: "" }),
    {
      failures: [],
      ok: ["repo-local release fieldwork supports the fw short alias through the live-testing shim"],
    },
    "repo-local fw shim help should pass when argv0 renders fw",
  );
  expect(
    evaluateRepoLocalFwShimHelp({ status: 0, stdout: "Usage: fieldwork [COMMAND]\n", stderr: "" }).failures.some((failure) =>
      failure.includes("Usage: fw"),
    ),
    "repo-local fw shim help should fail when argv0 does not render fw",
  );
  expectDeepEqual(
    evaluateRepoLocalFwShimDoctorHelp({ status: 0, stdout: "Usage: fw doctor [OPTIONS]\n      --no-start\n", stderr: "" }),
    {
      failures: [],
      ok: ["repo-local release fieldwork supports fw doctor through the live-testing shim"],
    },
    "repo-local fw doctor shim help should pass",
  );
  expect(
    evaluateRepoLocalFwShimDoctorHelp({ status: 0, stdout: "Usage: fieldwork doctor [OPTIONS]\n", stderr: "" }).failures.some((failure) =>
      failure.includes("fw doctor"),
    ),
    "repo-local fw doctor shim help should fail without fw doctor usage and no-start",
  );
  expectDeepEqual(
    evaluateReleaseFieldworkDoctorHelp({
      status: 0,
      stdout: "Usage: fieldwork doctor [OPTIONS]\n\nOptions:\n      --no-start\n",
      stderr: "",
    }),
    {
      failures: [],
      ok: ["release fieldwork command surface includes doctor"],
    },
    "current release fieldwork doctor help should pass",
  );
  expect(
    evaluateReleaseFieldworkDoctorHelp({ status: 0, stdout: "Usage: fieldwork [COMMAND]\n", stderr: "" }).failures.some((failure) =>
      failure.includes("stale"),
    ),
    "release fieldwork help without doctor surface should fail as stale",
  );
  expect(
    evaluateReleaseFieldworkDoctorHelp({ status: 2, stdout: "", stderr: "error: unrecognized subcommand 'doctor'\n" }).failures.some((failure) =>
      failure.includes("doctor --help failed"),
    ),
    "release fieldwork doctor command failure should fail readiness",
  );
  expectDeepEqual(
    evaluateReleaseDaemonHelp({ status: 0, stdout: "Usage: fieldworkd [OPTIONS]\n", stderr: "" }),
    {
      failures: [],
      ok: ["release fieldworkd help surface is current"],
    },
    "current release fieldworkd help should pass",
  );
  expect(
    evaluateReleaseDaemonHelp({ status: 0, stdout: "not fieldworkd\n", stderr: "" }).failures.some((failure) => failure.includes("fieldworkd binary is stale")),
    "release fieldworkd help without expected usage should fail",
  );

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
  expectDeepEqual(
    evaluateAdbStateText(emulatorAdbText, { localOnly: true }),
    {
      failures: [],
      ok: [],
      pending: ["disconnect the emulator/AVD and connect exactly one authorized physical Android phone before the evidence pass"],
      physicalReady: false,
    },
    "local-only emulator adb output should be pending guidance, not evidence",
  );
  expect(
    evaluateAdbStateText(emulatorAdbText, { localOnly: false }).failures.some((failure) => failure.includes("not an emulator")),
    "strict emulator adb output should fail",
  );

  const unauthorizedAdbText = "List of devices attached\nR5CT123ABC unauthorized usb:1-1 product:raven model:Pixel_6 device:raven transport_id:2\n";
  expectDeepEqual(
    evaluateAdbStateText(unauthorizedAdbText, { localOnly: true }),
    {
      failures: [],
      ok: [],
      pending: ["authorize or reconnect the Android phone before the evidence pass; local mode does not accept offline or unauthorized adb targets"],
      physicalReady: false,
    },
    "local-only unauthorized adb output should be pending guidance",
  );
  expect(
    evaluateAdbStateText(unauthorizedAdbText, { localOnly: false }).failures.some((failure) => failure.includes("unauthorized")),
    "strict unauthorized adb output should fail",
  );

  const multiDeviceAdbText = [
    "List of devices attached",
    "R5CT123ABC device usb:1-1 product:raven model:Pixel_6 device:raven transport_id:2",
    "R5CT456DEF device usb:1-2 product:oriole model:Pixel_6 device:oriole transport_id:3",
    "",
  ].join("\n");
  expectDeepEqual(
    evaluateAdbStateText(multiDeviceAdbText, { localOnly: true }),
    {
      failures: [],
      ok: [],
      pending: ["disconnect extra adb targets before the evidence pass; exactly one authorized physical Android phone is required"],
      physicalReady: false,
    },
    "local-only multi-device adb output should be pending guidance",
  );
  expect(
    evaluateAdbStateText(multiDeviceAdbText, { localOnly: false }).failures.some((failure) => failure.includes("found 2")),
    "strict multi-device adb output should fail",
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

  const installedPackageFailures = [];
  verifyInstalledAndroidPackageInfo(
    [
      "package:/data/app/~~hash/app.fieldwork.android-base.apk",
      "Packages:",
      "  Package [app.fieldwork.android] (abc):",
      "    versionCode=1 minSdk=30 targetSdk=36",
      "    versionName=1.0",
    ].join("\n"),
    installedPackageFailures,
  );
  expectDeepEqual(installedPackageFailures, [], "installed package proof should pass for expected app id and version");

  const wrongInstalledPackageFailures = [];
  verifyInstalledAndroidPackageInfo(
    [
      "package:/data/app/~~hash/app.fieldwork.android-base.apk",
      "Packages:",
      "  Package [app.fieldwork.android] (abc):",
      "    versionCode=2 minSdk=30 targetSdk=36",
      "    versionName=1.1",
    ].join("\n"),
    wrongInstalledPackageFailures,
  );
  expect(
    wrongInstalledPackageFailures.some((failure) => failure.includes("versionName=1.0")),
    "wrong installed versionName should fail readiness verification",
  );
  expect(
    wrongInstalledPackageFailures.some((failure) => failure.includes("versionCode=1")),
    "wrong installed versionCode should fail readiness verification",
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
