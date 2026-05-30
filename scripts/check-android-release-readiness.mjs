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
const node = process.execPath;
const args = parseArgs(process.argv.slice(2));

if (args.selfTest) {
  runSelfTest();
  process.exit(0);
}

const result = runReadinessCheck({
  root,
  localOnly: args.localOnly,
  env: process.env,
  githubSecretNames: args.localOnly ? readGitHubActionsSecretNames(process.env) : new Set(),
});
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

console.log(
  result.pending.length > 0
    ? "android release local readiness ok with pending external/physical release steps"
    : "android release readiness ok",
);

function runReadinessCheck({ root, localOnly, env, githubSecretNames = new Set() }) {
  const ok = [];
  const pending = [];
  const failures = [];

  const aab = path.join(root, "apps/android/app/build/outputs/bundle/release/app-release.aab");
  const releaseBuildConfig = path.join(root, "apps/android/app/build/generated/source/buildConfig/release/app/fieldwork/android/BuildConfig.java");

  checkFile(aab, "Android release AAB", failures, ok);
  checkFile(releaseBuildConfig, "Android release BuildConfig", failures, ok);
  checkFile(path.join(root, ".github/workflows/release-android.yml"), "Android release workflow", failures, ok);
  checkFile(path.join(root, "scripts/verify-android-aab.mjs"), "Android AAB verifier", failures, ok);
  checkFile(path.join(root, "scripts/verify-android-release-signing-evidence.mjs"), "Android release-signing evidence verifier", failures, ok);
  checkFile(path.join(root, "scripts/verify-android-release-install-evidence.mjs"), "Android release-install evidence verifier", failures, ok);
  checkFile(path.join(root, "docs/ANDROID_COLD_START.md"), "Android release-device cold-start runbook", failures, ok);
  checkFile(path.join(root, "docs/ANDROID_DOGFOOD.md"), "Android release-device dogfood runbook", failures, ok);
  checkFile(path.join(root, "docs/ANDROID_FCM_PUSH.md"), "Android FCM release-device push runbook", failures, ok);
  checkDesktopCommandSurface({ localOnly, failures, pending, ok });

  if (fs.existsSync(aab)) {
    runVerifier("Android release AAB content verifier", ["scripts/verify-android-aab.mjs"], failures, ok);
    evaluateAabSigningState({ aab, localOnly, failures, pending, ok });
  }

  runVerifier("mobile privacy verifier", ["scripts/verify-mobile-privacy.mjs"], failures, ok);
  runVerifier("store privacy answer-sheet verifier", ["scripts/verify-store-privacy.mjs"], failures, ok);
  runVerifier("Android release workflow verifier", ["scripts/verify-release-workflows.mjs"], failures, ok);

  evaluateRequiredSecrets(env, { localOnly, failures, pending, ok, githubSecretNames });
  checkAdbState({ localOnly, failures, pending, ok });

  return { failures, ok, pending };
}

function parseArgs(argv) {
  const parsed = {
    localOnly: false,
    selfTest: false,
  };

  for (const arg of argv.filter((value) => value !== "--")) {
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
  console.error("usage: node scripts/check-android-release-readiness.mjs [--local-only] [--self-test]");
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

function runVerifier(label, commandArgs, failures, ok) {
  const result = spawnSync(node, commandArgs, {
    cwd: root,
    encoding: "utf8",
  });
  if (result.error) {
    failures.push(`${label} failed to start: ${result.error.message}`);
    return;
  }
  if (result.status !== 0) {
    failures.push(`${label} failed:\n${trimCommandOutput(result.stdout)}${trimCommandOutput(result.stderr)}`);
    return;
  }
  ok.push(`${label} passed`);
}

function checkDesktopCommandSurface({ localOnly, failures, pending, ok }) {
  const pathOk = [];
  const pathFailures = [];
  const fwHelp = spawnSync("fw", ["--help"], { encoding: "utf8" });
  applyDesktopCheckResult(evaluateFwHelp(fwHelp), { localOnly: false, failures: pathFailures, pending: [], ok: pathOk });

  const fwDoctorHelp = spawnSync("fw", ["doctor", "--help"], { encoding: "utf8" });
  applyDesktopCheckResult(evaluateFwDoctorHelp(fwDoctorHelp), { localOnly: false, failures: pathFailures, pending: [], ok: pathOk });

  const daemonHelp = spawnSync("fieldworkd", ["--help"], { encoding: "utf8" });
  applyDesktopCheckResult(evaluateFieldworkdHelp(daemonHelp), { localOnly: false, failures: pathFailures, pending: [], ok: pathOk });

  if (pathFailures.length === 0) {
    ok.push(...pathOk);
    return;
  }

  if (localOnly) {
    const shimEvaluation = evaluateRepoLocalCommandShim({ root });
    if (shimEvaluation.failures.length === 0) {
      ok.push(...shimEvaluation.ok);
      return;
    }
  }

  ok.push(...pathOk);
  applyDesktopCheckResult({ failures: pathFailures, ok: [] }, { localOnly, failures, pending, ok });
}

function applyDesktopCheckResult(result, { localOnly, failures, pending, ok }) {
  ok.push(...result.ok);
  const target = localOnly ? pending : failures;
  target.push(...result.failures);
}

function evaluateFwHelp(result) {
  const ok = [];
  const failures = [];
  const setupMessage = "install the npm package or source the Android release/live-test evidence pack command shim before capture";

  if (result.error) {
    failures.push(`fw is unavailable; ${setupMessage}`);
    return { failures, ok };
  }

  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  if (result.status !== 0 || !/\bUsage:\s+fw\b/.test(output)) {
    failures.push(`fw on PATH must resolve the Fieldwork short alias and print Usage: fw; ${setupMessage}`);
    return { failures, ok };
  }

  ok.push("fw short alias resolves to Fieldwork CLI");
  return { failures, ok };
}

function evaluateFwDoctorHelp(result) {
  const ok = [];
  const failures = [];
  const setupMessage = "install the current npm package or source the Android release/live-test evidence pack command shim before capture";

  if (result.error) {
    failures.push(`fw doctor --help is unavailable; ${setupMessage}`);
    return { failures, ok };
  }

  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  if (result.status !== 0 || !/\bUsage:\s+fw\s+doctor\b/.test(output) || !/--no-start\b/.test(output)) {
    failures.push(`fw on PATH is stale or missing the doctor command surface; ${setupMessage}`);
    return { failures, ok };
  }

  ok.push("fw doctor command surface is current");
  return { failures, ok };
}

function evaluateFieldworkdHelp(result) {
  const ok = [];
  const failures = [];
  const setupMessage = "install the current npm package or source the Android release/live-test evidence pack command shim before capture";

  if (result.error) {
    failures.push(`fieldworkd is unavailable; ${setupMessage}`);
    return { failures, ok };
  }

  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  if (result.status !== 0 || !/\bUsage:\s+fieldworkd\b/.test(output)) {
    failures.push(`fieldworkd on PATH is stale or missing its help surface; ${setupMessage}`);
    return { failures, ok };
  }

  ok.push("fieldworkd daemon command surface is current");
  return { failures, ok };
}

function evaluateRepoLocalCommandShim({ root }) {
  const ok = [];
  const failures = [];
  const sourceFieldwork = path.join(root, "target/release/fieldwork");
  const sourceDaemon = path.join(root, "target/release/fieldworkd");
  if (!isExecutableFile(sourceFieldwork)) {
    failures.push("repo-local target/release/fieldwork is unavailable for the Android release readiness command shim");
    return { failures, ok };
  }
  if (!isExecutableFile(sourceDaemon)) {
    failures.push("repo-local target/release/fieldworkd is unavailable for the Android release readiness command shim");
    return { failures, ok };
  }

  const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), "fieldwork-android-release-shim-"));
  try {
    const fw = path.join(shimDir, "fw");
    const fieldwork = path.join(shimDir, "fieldwork");
    const fieldworkd = path.join(shimDir, "fieldworkd");
    fs.symlinkSync(sourceFieldwork, fw);
    fs.symlinkSync(sourceFieldwork, fieldwork);
    fs.symlinkSync(sourceDaemon, fieldworkd);
    const fwHelp = evaluateRepoLocalShimFwHelp(spawnSync(fw, ["--help"], { cwd: root, encoding: "utf8" }));
    const fwDoctorHelp = evaluateRepoLocalShimFwDoctorHelp(spawnSync(fw, ["doctor", "--help"], { cwd: root, encoding: "utf8" }));
    const daemonHelp = evaluateRepoLocalShimFieldworkdHelp(spawnSync(fieldworkd, ["--help"], { cwd: root, encoding: "utf8" }));
    ok.push(...fwHelp.ok, ...fwDoctorHelp.ok, ...daemonHelp.ok);
    failures.push(...fwHelp.failures, ...fwDoctorHelp.failures, ...daemonHelp.failures);
  } finally {
    fs.rmSync(shimDir, { recursive: true, force: true });
  }
  return { failures, ok };
}

function isExecutableFile(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() && (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function evaluateRepoLocalShimFwHelp(result) {
  const ok = [];
  const failures = [];
  if (result.error) {
    failures.push(`repo-local fw shim could not start: ${result.error.message}`);
    return { failures, ok };
  }
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  if (result.status !== 0 || !/\bUsage:\s+fw\b/.test(output)) {
    failures.push("repo-local release fieldwork does not render Usage: fw through the Android release readiness shim");
    return { failures, ok };
  }
  ok.push("repo-local release fieldwork supports the fw short alias through the Android release readiness shim");
  return { failures, ok };
}

function evaluateRepoLocalShimFwDoctorHelp(result) {
  const ok = [];
  const failures = [];
  if (result.error) {
    failures.push(`repo-local fw doctor shim could not start: ${result.error.message}`);
    return { failures, ok };
  }
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  if (result.status !== 0 || !/\bUsage:\s+fw\s+doctor\b/.test(output) || !/--no-start\b/.test(output)) {
    failures.push("repo-local release fieldwork does not render the fw doctor command surface through the Android release readiness shim");
    return { failures, ok };
  }
  ok.push("repo-local release fieldwork supports fw doctor through the Android release readiness shim");
  return { failures, ok };
}

function evaluateRepoLocalShimFieldworkdHelp(result) {
  const ok = [];
  const failures = [];
  if (result.error) {
    failures.push(`repo-local fieldworkd shim could not start: ${result.error.message}`);
    return { failures, ok };
  }
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  if (result.status !== 0 || !/\bUsage:\s+fieldworkd\b/.test(output)) {
    failures.push("repo-local release fieldworkd does not render the daemon command surface through the Android release readiness shim");
    return { failures, ok };
  }
  ok.push("repo-local release fieldworkd command surface works through the Android release readiness shim");
  return { failures, ok };
}

function evaluateSourceFieldworkHelp(result) {
  const ok = [];
  const failures = [];
  const setupMessage = "run cargo build --release -p fieldwork-cli -p fieldwork-daemon, install the npm package, or source the Android release/live-test evidence pack command shim before capture";

  if (result.error) {
    failures.push(`repo-local target/release/fieldwork is unavailable; ${setupMessage}`);
    return { failures, ok };
  }

  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  if (result.status !== 0 || !/\bUsage:\s+fieldwork\b/.test(output)) {
    failures.push(`repo-local target/release/fieldwork is stale or missing the Fieldwork CLI help surface; ${setupMessage}`);
    return { failures, ok };
  }

  ok.push("repo-local release fieldwork command surface is current for local readiness");
  return { failures, ok };
}

function evaluateSourceFieldworkDoctorHelp(result) {
  const ok = [];
  const failures = [];
  const setupMessage = "run cargo build --release -p fieldwork-cli -p fieldwork-daemon, install the npm package, or source the Android release/live-test evidence pack command shim before capture";

  if (result.error) {
    failures.push(`repo-local target/release/fieldwork doctor --help is unavailable; ${setupMessage}`);
    return { failures, ok };
  }

  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  if (result.status !== 0 || !/\bUsage:\s+fieldwork\s+doctor\b/.test(output) || !/--no-start\b/.test(output)) {
    failures.push(`repo-local target/release/fieldwork is stale or missing the doctor command surface; ${setupMessage}`);
    return { failures, ok };
  }

  ok.push("repo-local release fieldwork doctor command surface is current for local readiness");
  return { failures, ok };
}

function evaluateSourceFieldworkdHelp(result) {
  const ok = [];
  const failures = [];
  const setupMessage = "run cargo build --release -p fieldwork-cli -p fieldwork-daemon, install the npm package, or source the Android release/live-test evidence pack command shim before capture";

  if (result.error) {
    failures.push(`repo-local target/release/fieldworkd is unavailable; ${setupMessage}`);
    return { failures, ok };
  }

  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  if (result.status !== 0 || !/\bUsage:\s+fieldworkd\b/.test(output)) {
    failures.push(`repo-local target/release/fieldworkd is stale or missing its help surface; ${setupMessage}`);
    return { failures, ok };
  }

  ok.push("repo-local release fieldworkd daemon command surface is current for local readiness");
  return { failures, ok };
}

function evaluateAabSigningState({ aab, localOnly, failures, pending, ok }) {
  const entriesResult = spawnSync("unzip", ["-Z1", aab], {
    cwd: root,
    encoding: "utf8",
  });
  if (entriesResult.error) {
    failures.push(`Android release AAB signing-state check failed to start: ${entriesResult.error.message}`);
    return;
  }
  if (entriesResult.status !== 0) {
    failures.push(`Android release AAB signing-state check failed:\n${trimCommandOutput(entriesResult.stdout)}${trimCommandOutput(entriesResult.stderr)}`);
    return;
  }

  const entries = entriesResult.stdout.split(/\r?\n/).filter(Boolean);
  const signed = entries.some((entry) => /^META-INF\/(?:MANIFEST\.MF|[^/]+\.(?:SF|RSA|DSA|EC))$/i.test(entry));
  if (signed) {
    runVerifier("signed Android release AAB verifier", ["scripts/verify-android-aab.mjs", "--expect-signed"], failures, ok);
    return;
  }

  const message = "Android release AAB is currently unsigned; real release requires ANDROID_KEYSTORE_BASE64 and ANDROID_KEYSTORE_PROPERTIES in release-android.yml";
  if (localOnly) {
    pending.push(message);
  } else {
    failures.push(message);
  }
}

function evaluateRequiredSecrets(env, { localOnly, failures, pending, ok, githubSecretNames = new Set() }) {
  const required = [
    ["ANDROID_GOOGLE_SERVICES_JSON", "Firebase Android app config for FCM tokens"],
    ["ANDROID_KEYSTORE_BASE64", "base64 Android release keystore"],
    ["ANDROID_KEYSTORE_PROPERTIES", "Gradle signing properties for the release keystore"],
    ["FIELDWORK_RELAY_CONTROL_URL", "HTTPS relay control endpoint for Android typed-code pairing"],
    ["PLAY_SERVICE_ACCOUNT_JSON", "Play Console service-account JSON for internal-track upload"],
  ];
  const missing = [];
  for (const [name, description] of required) {
    const value = String(env[name] || "").trim();
    if (value) {
      if (name === "FIELDWORK_RELAY_CONTROL_URL" && !value.startsWith("https://")) {
        failures.push("FIELDWORK_RELAY_CONTROL_URL must be an https:// relay control endpoint for Android typed-code pairing");
        continue;
      }
      ok.push(`${name} is present in the current environment`);
      continue;
    }
    if (localOnly && githubSecretNames.has(name)) {
      ok.push(`${name} is present as a GitHub Actions secret`);
      continue;
    }
    missing.push([name, description]);
  }

  if (missing.length === 0) {
    return;
  }

  for (const [name, description] of missing) {
    const message = `${name} is missing (${description})`;
    if (localOnly) {
      pending.push(message);
    } else {
      failures.push(message);
    }
  }
}

function readGitHubActionsSecretNames(env) {
  const repo = env.FIELDWORK_GITHUB_REPO || "fieldwork-app/fieldwork";
  const result = spawnSync("gh", ["secret", "list", "--repo", repo, "--json", "name"], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.error || result.status !== 0) {
    return new Set();
  }
  try {
    const parsed = JSON.parse(result.stdout);
    return new Set(parsed.map((secret) => secret.name).filter(Boolean));
  } catch {
    return new Set();
  }
}

function checkAdbState({ localOnly, failures, pending, ok }) {
  const adb = spawnSync("adb", ["devices", "-l"], { encoding: "utf8" });
  if (adb.error) {
    const message = `adb is unavailable: ${adb.error.message}`;
    if (localOnly) {
      pending.push(`${message}; install Android platform-tools before release-device evidence capture`);
    } else {
      failures.push(message);
    }
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
    checkInstalledReleasePackage({ failures, ok });
  }
}

function evaluateAdbStateText(text, { localOnly }) {
  const ok = [];
  const pending = [];
  const failures = [];
  const adbFailures = [];
  verifyPhysicalAndroidAdbDevices(text, adbFailures, { file: "adb devices -l" });
  if (adbFailures.length === 0) {
    ok.push("exactly one authorized physical Android phone is connected over adb");
    return { failures, ok, pending, physicalReady: true };
  }

  const message = adbReleasePendingMessage(text);
  if (localOnly) {
    pending.push(message);
  } else {
    failures.push(...adbFailures);
  }
  return { failures, ok, pending, physicalReady: false };
}

function adbReleasePendingMessage(text) {
  const devices = parseAdbDevices(text);
  if (devices.length === 0) {
    return "connect exactly one authorized physical Android phone with the signed release app installed before release-device evidence capture";
  }
  if (devices.some((device) => device.state !== "device")) {
    return "authorize or reconnect the Android release-test phone before release-device evidence capture";
  }
  if (devices.length > 1) {
    return "disconnect extra adb targets before release-device evidence capture; exactly one authorized physical Android phone is required";
  }
  if (/^(?:emulator-\d+|[^\n]*(?:\bsdk_gphone\b|\bsdk_gphone64\b|\bgeneric_x86\b|\bgeneric_x86_64\b|\bgoldfish\b|\branchu\b|\bqemu\b|\bavd\b|\bdevice:emu[^\s]*\b))[^\n]*\s+device(?:\s|$)/im.test(text)) {
    return "disconnect the emulator/AVD and connect exactly one authorized physical Android phone before release-device evidence capture";
  }
  return "connect exactly one authorized physical Android phone with the signed release app installed before release-device evidence capture";
}

function parseAdbDevices(text) {
  return text
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [serial, state] = line.split(/\s+/, 3);
      return { serial, state };
    })
    .filter((device) => device.serial && device.state);
}

function checkInstalledReleasePackage({ failures, ok }) {
  const pathResult = spawnSync("adb", ["shell", "pm", "path", "app.fieldwork.android"], {
    encoding: "utf8",
  });
  if (pathResult.error) {
    failures.push(`adb package path check failed to start: ${pathResult.error.message}`);
    return;
  }
  if (pathResult.status !== 0 || !/^package:/m.test(pathResult.stdout)) {
    failures.push("app.fieldwork.android is not installed on the connected release-test phone");
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
  verifyInstalledAndroidPackageInfo(`${pathResult.stdout}\n${packageResult.stdout}`, failures, {
    file: "adb package check",
    forbidDebuggable: true,
  });
  if (failures.length === before) {
    ok.push("connected Android phone has non-debuggable app.fieldwork.android versionName=1.0 versionCode=1 installed");
  }
}

function trimCommandOutput(text) {
  const trimmed = String(text || "").trim();
  return trimmed.length > 0 ? `${trimmed}\n` : "";
}

function runSelfTest() {
  assertDeepEqual(
    evaluateAdbStateText("List of devices attached\n\n", { localOnly: true }),
    {
      failures: [],
      ok: [],
      pending: ["connect exactly one authorized physical Android phone with the signed release app installed before release-device evidence capture"],
      physicalReady: false,
    },
    "local missing adb device should be pending",
  );
  assert(
    evaluateAdbStateText("List of devices attached\nemulator-5554 device product:sdk_gphone64\n", { localOnly: true }).pending[0].includes("emulator/AVD"),
    "local emulator adb target should be pending guidance",
  );
  assert(
    evaluateAdbStateText("List of devices attached\nR5CT physical device product:oriole model:Pixel_6\n", { localOnly: true }).physicalReady,
    "single authorized physical adb target should be release-ready",
  );
  assertDeepEqual(
    evaluateFwHelp({ status: 0, stdout: "Usage: fw [COMMAND]\n", stderr: "" }),
    {
      failures: [],
      ok: ["fw short alias resolves to Fieldwork CLI"],
    },
    "valid fw alias help should pass",
  );
  assert(
    evaluateFwHelp({ error: new Error("ENOENT"), stdout: "", stderr: "" }).failures.some((line) => line.includes("fw is unavailable")),
    "missing fw should fail desktop command surface evaluation",
  );
  assertDeepEqual(
    evaluateFwDoctorHelp({ status: 0, stdout: "Usage: fw doctor [OPTIONS]\n      --no-start\n", stderr: "" }),
    {
      failures: [],
      ok: ["fw doctor command surface is current"],
    },
    "valid fw doctor help should pass",
  );
  assert(
    evaluateFwDoctorHelp({ status: 2, stdout: "", stderr: "error: unrecognized subcommand 'doctor'\n" }).failures.some((line) =>
      line.includes("stale"),
    ),
    "stale fw without doctor should fail desktop command surface evaluation",
  );
  assertDeepEqual(
    evaluateFieldworkdHelp({ status: 0, stdout: "Usage: fieldworkd [OPTIONS]\n", stderr: "" }),
    {
      failures: [],
      ok: ["fieldworkd daemon command surface is current"],
    },
    "valid fieldworkd help should pass",
  );
  assert(
    evaluateFieldworkdHelp({ status: 0, stdout: "not fieldworkd\n", stderr: "" }).failures.some((line) => line.includes("fieldworkd on PATH is stale")),
    "stale fieldworkd help should fail desktop command surface evaluation",
  );
  assertDeepEqual(
    evaluateSourceFieldworkHelp({ status: 0, stdout: "Usage: fieldwork [COMMAND]\n", stderr: "" }),
    {
      failures: [],
      ok: ["repo-local release fieldwork command surface is current for local readiness"],
    },
    "valid repo-local fieldwork help should pass local readiness fallback",
  );
  assertDeepEqual(
    evaluateSourceFieldworkDoctorHelp({ status: 0, stdout: "Usage: fieldwork doctor [OPTIONS]\n      --no-start\n", stderr: "" }),
    {
      failures: [],
      ok: ["repo-local release fieldwork doctor command surface is current for local readiness"],
    },
    "valid repo-local fieldwork doctor help should pass local readiness fallback",
  );
  assertDeepEqual(
    evaluateSourceFieldworkdHelp({ status: 0, stdout: "Usage: fieldworkd [OPTIONS]\n", stderr: "" }),
    {
      failures: [],
      ok: ["repo-local release fieldworkd daemon command surface is current for local readiness"],
    },
    "valid repo-local fieldworkd help should pass local readiness fallback",
  );
  assert(
    evaluateSourceFieldworkDoctorHelp({ status: 2, stdout: "", stderr: "error: unrecognized subcommand 'doctor'\n" }).failures.some((line) =>
      line.includes("repo-local target/release/fieldwork is stale"),
    ),
    "stale repo-local fieldwork without doctor should fail local readiness fallback",
  );
  assertDeepEqual(
    evaluateRepoLocalShimFwHelp({ status: 0, stdout: "Usage: fw [COMMAND]\n", stderr: "" }),
    {
      failures: [],
      ok: ["repo-local release fieldwork supports the fw short alias through the Android release readiness shim"],
    },
    "valid repo-local fw shim help should pass local readiness fallback",
  );
  assert(
    evaluateRepoLocalShimFwHelp({ status: 0, stdout: "Usage: fieldwork [COMMAND]\n", stderr: "" }).failures.some((line) =>
      line.includes("Usage: fw"),
    ),
    "repo-local fw shim help must require alias-aware Usage: fw output",
  );
  assertDeepEqual(
    evaluateRepoLocalShimFwDoctorHelp({ status: 0, stdout: "Usage: fw doctor [OPTIONS]\n      --no-start\n", stderr: "" }),
    {
      failures: [],
      ok: ["repo-local release fieldwork supports fw doctor through the Android release readiness shim"],
    },
    "valid repo-local fw doctor shim help should pass local readiness fallback",
  );
  assert(
    evaluateRepoLocalShimFwDoctorHelp({ status: 0, stdout: "Usage: fieldwork doctor [OPTIONS]\n", stderr: "" }).failures.some((line) =>
      line.includes("fw doctor"),
    ),
    "repo-local fw doctor shim help must require alias-aware Usage: fw doctor output",
  );
  assertDeepEqual(
    evaluateRepoLocalShimFieldworkdHelp({ status: 0, stdout: "Usage: fieldworkd [OPTIONS]\n", stderr: "" }),
    {
      failures: [],
      ok: ["repo-local release fieldworkd command surface works through the Android release readiness shim"],
    },
    "valid repo-local fieldworkd shim help should pass local readiness fallback",
  );

  const localSecrets = {};
  const local = { failures: [], pending: [], ok: [] };
  evaluateRequiredSecrets(localSecrets, { localOnly: true, ...local });
  assert(local.pending.some((line) => line.includes("ANDROID_GOOGLE_SERVICES_JSON")), "local missing Firebase secret should be pending");
  assert(local.pending.some((line) => line.includes("FIELDWORK_RELAY_CONTROL_URL")), "local missing relay control URL should be pending");
  assert(local.failures.length === 0, "local missing release secrets should not fail");

  const localGithubSecret = { failures: [], pending: [], ok: [] };
  evaluateRequiredSecrets(localSecrets, {
    localOnly: true,
    githubSecretNames: new Set(["ANDROID_GOOGLE_SERVICES_JSON", "FIELDWORK_RELAY_CONTROL_URL"]),
    ...localGithubSecret,
  });
  assert(
    localGithubSecret.ok.some((line) => line.includes("ANDROID_GOOGLE_SERVICES_JSON is present as a GitHub Actions secret")),
    "local readiness should accept Firebase config from GitHub Actions secret",
  );
  assert(
    !localGithubSecret.pending.some((line) => line.includes("ANDROID_GOOGLE_SERVICES_JSON")),
    "local readiness should not keep Firebase pending when the GitHub Actions secret exists",
  );
  assert(
    localGithubSecret.ok.some((line) => line.includes("FIELDWORK_RELAY_CONTROL_URL is present as a GitHub Actions secret")),
    "local readiness should accept the relay control URL from GitHub Actions secret",
  );
  assert(localGithubSecret.pending.some((line) => line.includes("ANDROID_KEYSTORE_BASE64")), "local readiness should still report missing release signing secret");

  const strict = { failures: [], pending: [], ok: [] };
  evaluateRequiredSecrets(localSecrets, { localOnly: false, ...strict });
  assert(strict.failures.some((line) => line.includes("ANDROID_KEYSTORE_BASE64")), "strict missing release keystore should fail");
  assert(strict.pending.length === 0, "strict missing release secrets should not be pending");

  const invalidRelay = { failures: [], pending: [], ok: [] };
  evaluateRequiredSecrets({ FIELDWORK_RELAY_CONTROL_URL: "http://127.0.0.1:8443" }, { localOnly: true, ...invalidRelay });
  assert(
    invalidRelay.failures.some((line) => line.includes("FIELDWORK_RELAY_CONTROL_URL must be an https://")),
    "local readiness should reject non-HTTPS Android relay control URL values",
  );

  console.log("android release readiness self-test ok");
}

function assert(value, message) {
  if (!value) {
    throw new Error(message);
  }
}

function assertDeepEqual(actual, expected, message) {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`${message}: expected ${expectedJson}, got ${actualJson}`);
  }
}
