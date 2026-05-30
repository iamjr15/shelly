#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const node = process.execPath;
const scaffold = path.join(root, "scripts/create-android-cold-start-evidence-dir.mjs");
const verifier = path.join(root, "scripts/verify-android-cold-start-evidence.mjs");
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fieldwork-android-cold-scaffold-test-"));

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
  expectEqual(manifest.schema, "fieldwork-android-cold-start-evidence-v1", "manifest schema should be pinned");
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
  expect(checklist.includes("TotalTime <= 1200ms"), "checklist should include cold-start threshold");
  expect(checklist.includes("direct `adb`"), "checklist should require direct adb capture");
  expect(checklist.includes("debug build"), "checklist should warn against debug builds");

  const readme = fs.readFileSync(path.join(evidenceDir, "README.md"), "utf8");
  expect(readme.includes("FIELDWORK_ANDROID_RELEASE_APKS"), "README should document bundletool APK set installs");
  expect(readme.includes("FIELDWORK_ANDROID_RELEASE_APK"), "README should document direct release APK installs");
  expect(readme.includes("FIELDWORK_ANDROID_ARTIFACT_SIGNING_FILE"), "README should document captured signing output override");
  expect(readme.includes("FIELDWORK_ANDROID_INSTALL_TRANSCRIPT_FILE"), "README should document captured install transcript override");

  const preflightPath = path.join(evidenceDir, "preflight.sh");
  const preflight = fs.readFileSync(preflightPath, "utf8");
  expect(preflight.startsWith("#!/usr/bin/env bash"), "preflight helper should be a shell script");
  expect(preflight.includes("FIELDWORK_ANDROID_AAB"), "preflight should allow signed AAB override");
  expect(preflight.includes("FIELDWORK_ANDROID_RELEASE_APKS"), "preflight should allow release APKS override");
  expect(preflight.includes("FIELDWORK_ANDROID_RELEASE_APK"), "preflight should allow release APK override");
  expect(preflight.includes("FIELDWORK_ANDROID_INSTALL_TRANSCRIPT_FILE"), "preflight should allow install transcript override");
  expect(preflight.includes("devices -l"), "preflight should capture direct adb device evidence");
  expect(preflight.includes("am start -W"), "preflight should capture Android cold-start timing");
  expect(preflight.includes("exec-out screencap -p"), "preflight should capture screenshot evidence");
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
  const bundletoolStub = path.join(binDir, "bundletool");
  fs.writeFileSync(adbStub, buildAdbStub(), { mode: 0o700 });
  fs.writeFileSync(bundletoolStub, buildBundletoolStub(), { mode: 0o700 });
  fs.chmodSync(adbStub, 0o700);
  fs.chmodSync(bundletoolStub, 0o700);

  const buildConfig = path.join(tmpRoot, "BuildConfig.java");
  fs.writeFileSync(buildConfig, writeBuildConfig());
  const artifactSigning = path.join(tmpRoot, "artifact-signing.txt");
  fs.writeFileSync(
    artifactSigning,
    "Android AAB ok: base/lib/arm64-v8a/libfieldwork_mobile_core.so; packaged manifest identity, version, uses-permission allowlist, and privacy surface ok; signed release bundle ok\n",
  );
  const releaseApks = path.join(tmpRoot, "fieldwork-release.apks");
  fs.writeFileSync(releaseApks, "signed release apks placeholder\n");

  const preflightResult = spawnSync("bash", [preflightPath], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
      FIELDWORK_ANDROID_ARTIFACT_SIGNING_FILE: artifactSigning,
      FIELDWORK_ANDROID_RELEASE_BUILDCONFIG: buildConfig,
      FIELDWORK_ANDROID_RELEASE_APKS: releaseApks,
    },
  });
  expectStatus(preflightResult, 0, "preflight should capture complete release cold-start evidence");
  expect(preflightResult.stdout.includes("Android cold-start preflight ok"), "preflight should report success");

  for (const file of requiredFiles) {
    expect(fs.existsSync(path.join(evidenceDir, file)), `preflight should write ${file}`);
  }
  const verifyAfterPreflight = spawnSync(node, [verifier, evidenceDir], { cwd: root, encoding: "utf8" });
  expectStatus(verifyAfterPreflight, 0, "stubbed preflight evidence should pass the verifier shape");
  expect(verifyAfterPreflight.stdout.includes("Android cold-start evidence ok"), "verifier should report cold-start evidence success");

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
  expect(fs.readFileSync(path.join(evidenceDir, "locked-ui.xml"), "utf8").includes('text="Unlock"'), "locked UI should show Unlock");

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
      FIELDWORK_ANDROID_RELEASE_APKS: releaseApks,
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
      FIELDWORK_ANDROID_RELEASE_APKS: releaseApks,
      FIELDWORK_ADB_STUB_MODE: "debuggable",
    },
  });
  expectStatus(debugPackagePreflight, 1, "preflight should reject debuggable installed package evidence");
  expect(debugPackagePreflight.stderr.includes("debuggable markers"), "debuggable package failure should be explicit");

  const slowDir = path.join(tmpRoot, "slow-launch");
  expectStatus(
    spawnSync(node, [scaffold, "--dir", slowDir, "--quiet"], { cwd: root, encoding: "utf8" }),
    0,
    "scaffold should create slow-launch test evidence directory",
  );
  const slowPreflight = spawnSync("bash", [path.join(slowDir, "preflight.sh")], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
      FIELDWORK_ANDROID_ARTIFACT_SIGNING_FILE: artifactSigning,
      FIELDWORK_ANDROID_RELEASE_BUILDCONFIG: buildConfig,
      FIELDWORK_ANDROID_RELEASE_APKS: releaseApks,
      FIELDWORK_ADB_STUB_MODE: "slow",
    },
  });
  expectStatus(slowPreflight, 1, "preflight should reject cold launches above threshold");
  expect(slowPreflight.stderr.includes("TotalTime=1201ms"), "slow-launch failure should include measured TotalTime");

  const noForce = spawnSync(node, [scaffold, "--dir", evidenceDir, "--quiet"], { cwd: root, encoding: "utf8" });
  expectStatus(noForce, 1, "scaffold should not overwrite a non-empty directory without --force");
  expect(noForce.stderr.includes("rerun with --force"), "non-empty directory failure should explain --force");

  const force = spawnSync(node, [scaffold, "--dir", evidenceDir, "--force", "--quiet"], {
    cwd: root,
    encoding: "utf8",
  });
  expectStatus(force, 0, "scaffold should refresh metadata with --force");

  console.log("Android cold-start evidence scaffold self-test ok");
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

function readRequiredFiles() {
  const source = fs.readFileSync(verifier, "utf8");
  const launchMatch = source.match(/const\s+launchFiles\s*=\s*\[(?<body>[\s\S]*?)\];/);
  const launchFiles = launchMatch?.groups?.body
    ? [...launchMatch.groups.body.matchAll(/"([^"\n]+)"/g)].map((fileMatch) => fileMatch[1])
    : [];
  const requiredMatch = source.match(/const\s+requiredFiles\s*=\s*\[(?<body>[\s\S]*?)\];/);
  if (!requiredMatch?.groups?.body) {
    throw new Error("cannot locate requiredFiles in verifier");
  }
  const files = [];
  for (const match of requiredMatch.groups.body.matchAll(/"([^"\n]+)"|\.\.\.launchFiles/g)) {
    if (match[1]) {
      files.push(match[1]);
    } else {
      files.push(...launchFiles);
    }
  }
  return files;
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
  return `#!/usr/bin/env node
const fs = require("fs");
let args = process.argv.slice(2);
const mode = process.env.FIELDWORK_ADB_STUB_MODE || "physical";
if (args[0] === "-s") {
  args = args.slice(2);
}
function out(text) {
  process.stdout.write(text);
}
function writePng() {
  const bytes = Buffer.alloc(128);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(1080, 16);
  bytes.writeUInt32BE(2400, 20);
  bytes[24] = 8;
  bytes[25] = 6;
  bytes.writeUInt32BE(0, 33);
  bytes.write("IEND", 37, "ascii");
  process.stdout.write(bytes);
}
if (args[0] === "devices") {
  if (mode === "emulator") {
    out("List of devices attached\\nemulator-5554 device product:sdk_gphone64_arm64 model:sdk_gphone64_arm64 device:emu64a transport_id:1\\n");
  } else {
    out("List of devices attached\\nR5CT1234567 device usb:336592896X product:oriole model:Pixel_6 device:oriole transport_id:9\\n");
  }
  process.exit(0);
}
if (args[0] === "install") {
  out("Success\\n");
  process.exit(0);
}
if (args[0] === "shell" && args[1] === "pm" && args[2] === "path") {
  out("package:/data/app/~~hash/app.fieldwork.android-base.apk\\n");
  process.exit(0);
}
if (args[0] === "shell" && args[1] === "dumpsys" && args[2] === "package") {
  out("Packages:\\n  Package [app.fieldwork.android] (abc):\\n    versionCode=1 minSdk=30 targetSdk=36\\n    versionName=1.0\\n");
  if (mode === "debuggable") {
    out("    pkgFlags=[ DEBUGGABLE HAS_CODE ]\\n");
  }
  process.exit(0);
}
if (args[0] === "shell" && args[1] === "am" && args[2] === "force-stop") {
  process.exit(0);
}
if (args[0] === "shell" && args[1] === "am" && args[2] === "start") {
  const totalTime = mode === "slow" ? 1201 : 850;
  out([
    "Starting: Intent { cmp=app.fieldwork.android/.MainActivity }",
    "Status: ok",
    "LaunchState: COLD",
    "Activity: app.fieldwork.android/.MainActivity",
    "TotalTime: " + totalTime,
    "",
  ].join("\\n"));
  process.exit(0);
}
if (args[0] === "logcat") {
  if (args.includes("-c")) {
    process.exit(0);
  }
  if (args.includes("-b") && args.includes("crash")) {
    out("\\n");
  } else {
    out("I Fieldwork cold launch ok\\n");
  }
  process.exit(0);
}
if (args[0] === "exec-out" && args[1] === "screencap") {
  writePng();
  process.exit(0);
}
if (args[0] === "shell" && args[1] === "uiautomator") {
  out("UI hierchary dumped to: /sdcard/fieldwork-window.xml\\n");
  process.exit(0);
}
if (args[0] === "pull") {
  fs.writeFileSync(args[2], '<hierarchy><node text="Unlock"/></hierarchy>\\n');
  process.exit(0);
}
if (args[0] === "shell" && args[1] === "rm") {
  process.exit(0);
}
console.error("unexpected adb invocation: " + args.join(" "));
process.exit(64);
`;
}

function buildBundletoolStub() {
  return `#!/usr/bin/env bash
set -euo pipefail
printf 'Installed successfully\\n'
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
