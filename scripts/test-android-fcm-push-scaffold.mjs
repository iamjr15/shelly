#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const node = process.execPath;
const scaffold = path.join(root, "scripts/create-android-fcm-push-evidence-dir.mjs");
const verifier = path.join(root, "scripts/verify-android-fcm-push-evidence.mjs");
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fieldwork-android-fcm-scaffold-test-"));

try {
  const evidenceDir = path.join(tmpRoot, "evidence");
  const scaffoldResult = spawnSync(node, [scaffold, "--dir", evidenceDir, "--quiet", "--print-dir"], {
    cwd: root,
    encoding: "utf8",
  });
  expectStatus(scaffoldResult, 0, "scaffold should create an evidence directory");
  expectEqual(scaffoldResult.stdout.trim(), evidenceDir, "--print-dir should print only the evidence path");

  for (const file of ["README.md", "manifest.json", "missing-files.txt", "capture-checklist.md", "preflight.sh"]) {
    expect(fs.existsSync(path.join(evidenceDir, file)), `${file} should exist`);
  }

  const requiredFiles = readRequiredFiles();
  const manifest = JSON.parse(fs.readFileSync(path.join(evidenceDir, "manifest.json"), "utf8"));
  expectEqual(manifest.schema, "fieldwork-android-fcm-push-evidence-v1", "manifest schema should be pinned");
  expectDeepEqual(manifest.requiredFiles, requiredFiles, "manifest should mirror verifier required files");
  expectDeepEqual(
    manifest.generatedFiles,
    ["README.md", "manifest.json", "missing-files.txt", "capture-checklist.md", "preflight.sh"],
    "manifest should list every scaffold-generated helper file",
  );
  expectEqual(
    fs.readFileSync(path.join(evidenceDir, "missing-files.txt"), "utf8"),
    `${requiredFiles.join("\n")}\n`,
    "missing-files.txt should list every required evidence file",
  );

  const checklist = fs.readFileSync(path.join(evidenceDir, "capture-checklist.md"), "utf8");
  for (const file of requiredFiles) {
    expect(checklist.includes(`\`${file}\``), `capture checklist should mention ${file}`);
    expect(!fs.existsSync(path.join(evidenceDir, file)), `scaffold must not fabricate ${file}`);
  }
  expect(checklist.includes("provider-payloads.json"), "checklist should include provider payload capture");
  expect(checklist.includes("push_delivered=10"), "checklist should include 10/10 delivery evidence");
  expect(checklist.includes("notification.png"), "checklist should include notification screenshot capture");
  expect(checklist.includes("debug build"), "checklist should warn against debug builds");

  const readme = fs.readFileSync(path.join(evidenceDir, "README.md"), "utf8");
  expect(readme.includes("does not create provider payload JSON"), "README should state provider evidence is not fabricated");
  expect(readme.includes("FIELDWORK_ANDROID_AAB=apps/android/app/build/outputs/bundle/release/app-release.aab"), "README should document AAB override");
  expect(readme.includes("FIELDWORK_ANDROID_ARTIFACT_SIGNING_FILE"), "README should document captured signing output override");

  const preflightPath = path.join(evidenceDir, "preflight.sh");
  const preflight = fs.readFileSync(preflightPath, "utf8");
  expect(preflight.startsWith("#!/usr/bin/env bash"), "preflight helper should be a shell script");
  expect(preflight.includes("FIELDWORK_ANDROID_AAB"), "preflight should allow signed AAB override");
  expect(preflight.includes("FIELDWORK_ANDROID_ARTIFACT_SIGNING_FILE"), "preflight should allow captured signing output");
  expect(preflight.includes("devices -l"), "preflight should capture direct adb device evidence");
  expect(preflight.includes("pm path app.fieldwork.android"), "preflight should capture installed package path");
  expect(preflight.includes("dumpsys package app.fieldwork.android"), "preflight should capture installed package details");
  expect(
    (fs.statSync(preflightPath).mode & 0o700) === 0o700,
    "preflight helper should be executable by the owner",
  );

  const verifyEmpty = spawnSync(node, [verifier, evidenceDir], { cwd: root, encoding: "utf8" });
  expectStatus(verifyEmpty, 1, "empty scaffold should not pass the evidence verifier");
  expect(verifyEmpty.stderr.includes("missing evidence file: adb-devices.txt"), "verifier should still require real adb evidence");

  const binDir = path.join(tmpRoot, "bin");
  fs.mkdirSync(binDir);
  const adbStub = path.join(binDir, "adb");
  const curlStub = path.join(binDir, "curl");
  fs.writeFileSync(adbStub, buildAdbStub(), { mode: 0o700 });
  fs.writeFileSync(curlStub, buildCurlStub(), { mode: 0o700 });
  fs.chmodSync(adbStub, 0o700);
  fs.chmodSync(curlStub, 0o700);

  const buildConfig = path.join(tmpRoot, "BuildConfig.java");
  fs.writeFileSync(buildConfig, writeBuildConfig());
  const artifactSigning = path.join(tmpRoot, "artifact-signing.txt");
  fs.writeFileSync(
    artifactSigning,
    "Android AAB ok: base/lib/arm64-v8a/libfieldwork_mobile_core.so; packaged manifest identity, version, uses-permission allowlist, and privacy surface ok; signed release bundle ok\n",
  );

  const preflightResult = spawnSync("bash", [preflightPath], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
      FIELDWORK_ANDROID_ARTIFACT_SIGNING_FILE: artifactSigning,
      FIELDWORK_ANDROID_RELEASE_BUILDCONFIG: buildConfig,
      FIELDWORK_RELAY_VERSION_URL: "https://relay.example.test:8443/v1/version",
    },
  });
  expectStatus(preflightResult, 0, "preflight should capture release/device/package evidence");
  expect(preflightResult.stdout.includes("Android FCM push preflight ok"), "preflight should report success");

  expect(fs.existsSync(path.join(evidenceDir, "artifact-signing.txt")), "preflight should write artifact signing evidence");
  expect(fs.existsSync(path.join(evidenceDir, "buildconfig.txt")), "preflight should write BuildConfig evidence");
  expect(fs.existsSync(path.join(evidenceDir, "relay-version.txt")), "preflight should write relay version evidence");
  expect(fs.existsSync(path.join(evidenceDir, "adb-devices.txt")), "preflight should write adb device evidence");
  expect(fs.existsSync(path.join(evidenceDir, "package-info.txt")), "preflight should write package info evidence");

  const capturedBuildConfig = fs.readFileSync(path.join(evidenceDir, "buildconfig.txt"), "utf8");
  expect(capturedBuildConfig.includes('APPLICATION_ID = "app.fieldwork.android"'), "preflight should capture app id");
  expect(capturedBuildConfig.includes('BUILD_TYPE = "release"'), "preflight should capture release build type");
  expect(capturedBuildConfig.includes("DEBUG = false"), "preflight should capture DEBUG=false");
  expect(capturedBuildConfig.includes("FIELDWORK_BIOMETRIC_BYPASS = false"), "preflight should capture biometric bypass off");
  expect(capturedBuildConfig.includes('FIELDWORK_DEBUG_PAIRING_CODE = ""'), "preflight should capture empty debug pairing code");

  const adbDevices = fs.readFileSync(path.join(evidenceDir, "adb-devices.txt"), "utf8");
  expect(adbDevices.includes("R5CT1234567 device"), "preflight should capture one physical adb device");
  const packageInfo = fs.readFileSync(path.join(evidenceDir, "package-info.txt"), "utf8");
  expect(packageInfo.includes("app.fieldwork.android"), "preflight should capture installed package id");
  expect(packageInfo.includes("versionName=1.0"), "preflight should capture package version name");
  expect(packageInfo.includes("versionCode=1"), "preflight should capture package version code");
  expect(!packageInfo.includes("DEBUGGABLE"), "package-info.txt must not contain debuggable markers");
  expect(!fs.existsSync(path.join(evidenceDir, "provider-payloads.json")), "preflight must not fabricate provider payloads");
  expect(!fs.existsSync(path.join(evidenceDir, "delivery.txt")), "preflight must not fabricate delivery counts");
  expect(!fs.existsSync(path.join(evidenceDir, "notification.png")), "preflight must not fabricate screenshots");

  const verifyAfterPreflight = spawnSync(node, [verifier, evidenceDir], { cwd: root, encoding: "utf8" });
  expectStatus(verifyAfterPreflight, 1, "preflight-only evidence should not pass the FCM verifier");
  expect(
    verifyAfterPreflight.stderr.includes("missing evidence file: token-registration.txt"),
    "verifier should still require real FCM registration evidence",
  );

  const emulatorDir = path.join(tmpRoot, "emulator");
  expectStatus(
    spawnSync(node, [scaffold, "--dir", emulatorDir, "--quiet"], { cwd: root, encoding: "utf8" }),
    0,
    "scaffold should create emulator test evidence directory",
  );
  const emulatorPreflight = spawnSync("bash", [path.join(emulatorDir, "preflight.sh")], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
      FIELDWORK_ANDROID_ARTIFACT_SIGNING_FILE: artifactSigning,
      FIELDWORK_ANDROID_RELEASE_BUILDCONFIG: buildConfig,
      FIELDWORK_ADB_STUB_MODE: "emulator",
    },
  });
  expectStatus(emulatorPreflight, 1, "preflight should reject emulator adb evidence");
  expect(emulatorPreflight.stderr.includes("not an emulator or AVD"), "emulator failure should be explicit");

  const debugDir = path.join(tmpRoot, "debug-package");
  expectStatus(
    spawnSync(node, [scaffold, "--dir", debugDir, "--quiet"], { cwd: root, encoding: "utf8" }),
    0,
    "scaffold should create debug-package test evidence directory",
  );
  const debugPackagePreflight = spawnSync("bash", [path.join(debugDir, "preflight.sh")], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
      FIELDWORK_ANDROID_ARTIFACT_SIGNING_FILE: artifactSigning,
      FIELDWORK_ANDROID_RELEASE_BUILDCONFIG: buildConfig,
      FIELDWORK_ADB_STUB_MODE: "debuggable",
    },
  });
  expectStatus(debugPackagePreflight, 1, "preflight should reject debuggable installed package evidence");
  expect(debugPackagePreflight.stderr.includes("debuggable markers"), "debuggable package failure should be explicit");

  const noForce = spawnSync(node, [scaffold, "--dir", evidenceDir, "--quiet"], { cwd: root, encoding: "utf8" });
  expectStatus(noForce, 1, "scaffold should not overwrite a non-empty directory without --force");
  expect(noForce.stderr.includes("rerun with --force"), "non-empty directory failure should explain --force");

  const force = spawnSync(node, [scaffold, "--dir", evidenceDir, "--force", "--quiet"], {
    cwd: root,
    encoding: "utf8",
  });
  expectStatus(force, 0, "scaffold should refresh metadata with --force");

  console.log("Android FCM push evidence scaffold self-test ok");
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

function readRequiredFiles() {
  const source = fs.readFileSync(verifier, "utf8");
  const match = source.match(/const\s+requiredFiles\s*=\s*\[(?<body>[\s\S]*?)\];/);
  if (!match?.groups?.body) {
    throw new Error("cannot locate requiredFiles in verifier");
  }
  return [...match.groups.body.matchAll(/"([^"\n]+)"/g)].map((fileMatch) => fileMatch[1]);
}

function writeBuildConfig() {
  return [
    "public final class BuildConfig {",
    '  public static final String APPLICATION_ID = "app.fieldwork.android";',
    '  public static final String BUILD_TYPE = "release";',
    "  public static final boolean DEBUG = false;",
    "  public static final boolean FIELDWORK_BIOMETRIC_BYPASS = false;",
    '  public static final String FIELDWORK_DEBUG_PAIRING_CODE = "";',
    "}",
    "",
  ].join("\n");
}

function buildAdbStub() {
  return `#!/usr/bin/env bash
set -euo pipefail
mode="\${FIELDWORK_ADB_STUB_MODE:-physical}"
if [[ "$1" == "devices" ]]; then
  if [[ "$mode" == "emulator" ]]; then
    printf 'List of devices attached\\nemulator-5554 device product:sdk_gphone64_arm64 model:sdk_gphone64_arm64 device:emu64a transport_id:1\\n'
  else
    printf 'List of devices attached\\nR5CT1234567 device usb:336592896X product:oriole model:Pixel_6 device:oriole transport_id:9\\n'
  fi
  exit 0
fi
if [[ "$1" == "shell" && "$2" == "pm" && "$3" == "path" ]]; then
  printf 'package:/data/app/~~hash/app.fieldwork.android-base.apk\\n'
  exit 0
fi
if [[ "$1" == "shell" && "$2" == "dumpsys" && "$3" == "package" ]]; then
  printf 'Packages:\\n  Package [app.fieldwork.android] (abc):\\n    versionCode=1 minSdk=30 targetSdk=36\\n    versionName=1.0\\n'
  if [[ "$mode" == "debuggable" ]]; then
    printf '    pkgFlags=[ DEBUGGABLE HAS_CODE ]\\n'
  fi
  exit 0
fi
echo "unexpected adb invocation: $*" >&2
exit 64
`;
}

function buildCurlStub() {
  return `#!/usr/bin/env bash
set -euo pipefail
printf '{"relay_version":"1.0.0","contract_version":2}\\n'
`;
}

function expectStatus(result, expectedStatus, message) {
  if (result.status !== expectedStatus) {
    throw new Error(`${message}: exited ${result.status}, expected ${expectedStatus}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
}

function expectEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function expectDeepEqual(actual, expected, message) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function expect(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
