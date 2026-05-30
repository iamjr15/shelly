#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const node = process.execPath;
const scaffold = path.join(root, "scripts/create-android-biometric-evidence-dir.mjs");
const verifier = path.join(root, "scripts/verify-android-biometric-evidence.mjs");
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fieldwork-android-biometric-scaffold-test-"));

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
  expectEqual(manifest.schema, "fieldwork-android-biometric-evidence-v1", "manifest schema should be pinned");
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
  expect(checklist.includes("does not create desktop sessions"), "checklist should state desktop sessions are not fabricated");
  expect(checklist.includes("does not fabricate stale-biometric.txt"), "checklist should state stale proof is not fabricated");

  const readme = fs.readFileSync(path.join(evidenceDir, "README.md"), "utf8");
  expect(readme.includes("FIELDWORK_ANDROID_BIOMETRIC_CAPTURE_LOCKED=true"), "README should document locked capture mode");
  expect(readme.includes("FIELDWORK_ANDROID_BIOMETRIC_CAPTURE_PROMPT=true"), "README should document prompt capture mode");
  expect(readme.includes("FIELDWORK_ANDROID_BIOMETRIC_CAPTURE_STALE=true"), "README should document stale capture mode");
  expect(readme.includes("FIELDWORK_ANDROID_BIOMETRIC_VERIFY=true"), "README should document verify mode");
  expect(
    readme.includes("It does not create") && readme.includes("`stale-biometric.txt`"),
    "README should state stale proof is not fabricated",
  );

  const preflightPath = path.join(evidenceDir, "preflight.sh");
  const preflight = fs.readFileSync(preflightPath, "utf8");
  expect(preflight.startsWith("#!/usr/bin/env bash"), "preflight helper should be a shell script");
  expect(preflight.includes("FIELDWORK_ANDROID_AAB"), "preflight should allow signed AAB override");
  expect(preflight.includes("FIELDWORK_ANDROID_ARTIFACT_SIGNING_FILE"), "preflight should allow captured signing output");
  expect(preflight.includes("FIELDWORK_ANDROID_BIOMETRIC_CAPTURE_LOCKED"), "preflight should support locked capture");
  expect(preflight.includes("FIELDWORK_ANDROID_BIOMETRIC_CAPTURE_PROMPT"), "preflight should support prompt capture");
  expect(preflight.includes("FIELDWORK_ANDROID_BIOMETRIC_CAPTURE_STALE"), "preflight should support stale capture");
  expect(preflight.includes("FIELDWORK_ANDROID_BIOMETRIC_VERIFY"), "preflight should support verification mode");
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
  const fwStub = path.join(binDir, "fw");
  fs.writeFileSync(adbStub, buildAdbStub(), { mode: 0o700 });
  fs.writeFileSync(fwStub, buildFwStub(), { mode: 0o700 });
  fs.chmodSync(adbStub, 0o700);
  fs.chmodSync(fwStub, 0o700);

  const buildConfig = path.join(tmpRoot, "BuildConfig.java");
  fs.writeFileSync(buildConfig, writeBuildConfig());
  const artifactSigning = path.join(tmpRoot, "artifact-signing.txt");
  fs.writeFileSync(
    artifactSigning,
    "Android AAB ok: base/lib/arm64-v8a/libfieldwork_mobile_core.so; packaged manifest identity, version, uses-permission allowlist, and privacy surface ok; signed release bundle ok\n",
  );

  const staticPreflight = runPreflight(preflightPath, binDir, artifactSigning, buildConfig);
  expectStatus(staticPreflight, 0, "preflight should capture release/device/package evidence");
  expect(staticPreflight.stdout.includes("Android biometric preflight ok"), "preflight should report static success");
  expect(fs.existsSync(path.join(evidenceDir, "artifact-signing.txt")), "preflight should write artifact signing evidence");
  expect(fs.existsSync(path.join(evidenceDir, "buildconfig.txt")), "preflight should write BuildConfig evidence");
  expect(fs.existsSync(path.join(evidenceDir, "adb-devices.txt")), "preflight should write adb device evidence");
  expect(fs.existsSync(path.join(evidenceDir, "package-info.txt")), "preflight should write package info evidence");
  expect(!fs.existsSync(path.join(evidenceDir, "stale-biometric.txt")), "preflight must not fabricate stale input proof");

  const lockedCapture = runPreflight(preflightPath, binDir, artifactSigning, buildConfig, {
    FIELDWORK_ANDROID_BIOMETRIC_CAPTURE_LOCKED: "true",
  });
  expectStatus(lockedCapture, 0, "locked capture should collect launch and locked evidence");
  expect(lockedCapture.stdout.includes("Android biometric locked launch capture ok"), "locked capture should report success");
  expect(fs.existsSync(path.join(evidenceDir, "launch.txt")), "locked capture should write launch.txt");
  expect(fs.existsSync(path.join(evidenceDir, "locked.png")), "locked capture should write locked.png");
  expect(fs.existsSync(path.join(evidenceDir, "sessions.txt")), "locked capture should write sessions.txt from fw ls");
  expect(fs.existsSync(path.join(evidenceDir, "devices.txt")), "locked capture should write devices.txt from fw devices");

  const promptCapture = runPreflight(preflightPath, binDir, artifactSigning, buildConfig, {
    FIELDWORK_ANDROID_BIOMETRIC_CAPTURE_PROMPT: "true",
  });
  expectStatus(promptCapture, 0, "prompt capture should collect biometric prompt evidence");
  expect(promptCapture.stdout.includes("Android biometric prompt capture ok"), "prompt capture should report success");
  expect(fs.existsSync(path.join(evidenceDir, "biometric.png")), "prompt capture should write biometric.png");
  expect(fs.existsSync(path.join(evidenceDir, "biometric-ui.xml")), "prompt capture should write biometric-ui.xml");

  const staleCapture = runPreflight(preflightPath, binDir, artifactSigning, buildConfig, {
    FIELDWORK_ANDROID_BIOMETRIC_CAPTURE_STALE: "true",
  });
  expectStatus(staleCapture, 0, "stale capture should collect stale prompt evidence");
  expect(staleCapture.stdout.includes("Android biometric stale prompt capture ok"), "stale capture should report success");
  expect(fs.existsSync(path.join(evidenceDir, "stale-biometric.png")), "stale capture should write stale-biometric.png");
  expect(fs.existsSync(path.join(evidenceDir, "stale-biometric-ui.xml")), "stale capture should write stale-biometric-ui.xml");
  expect(!fs.existsSync(path.join(evidenceDir, "stale-biometric.txt")), "stale capture must not fabricate stale proof");

  const verifyMissingStaleProof = runPreflight(preflightPath, binDir, artifactSigning, buildConfig, {
    FIELDWORK_ANDROID_BIOMETRIC_VERIFY: "true",
  });
  expectStatus(verifyMissingStaleProof, 1, "verify mode should require real stale proof");
  expect(verifyMissingStaleProof.stderr.includes("stale-biometric.txt is missing"), "missing stale proof failure should be explicit");

  fs.writeFileSync(path.join(evidenceDir, "stale-biometric.txt"), "stale_background_ms=300000\nstale_input_before_unlock_blocked\n");
  const verifyComplete = runPreflight(preflightPath, binDir, artifactSigning, buildConfig, {
    FIELDWORK_ANDROID_BIOMETRIC_VERIFY: "true",
  });
  expectStatus(verifyComplete, 0, "verify mode should pass after staged evidence and stale proof exist");
  expect(verifyComplete.stdout.includes("Android biometric evidence ok"), "verify mode should report biometric evidence success");

  for (const file of requiredFiles) {
    expect(fs.existsSync(path.join(evidenceDir, file)), `complete staged capture should write ${file}`);
  }

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

  const noForce = spawnSync(node, [scaffold, "--dir", evidenceDir, "--quiet"], { cwd: root, encoding: "utf8" });
  expectStatus(noForce, 1, "scaffold should not overwrite a non-empty directory without --force");
  expect(noForce.stderr.includes("rerun with --force"), "non-empty directory failure should explain --force");

  const force = spawnSync(node, [scaffold, "--dir", evidenceDir, "--force", "--quiet"], {
    cwd: root,
    encoding: "utf8",
  });
  expectStatus(force, 0, "scaffold should refresh metadata with --force");

  console.log("Android biometric evidence scaffold self-test ok");
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

function runPreflight(preflightPath, binDir, artifactSigning, buildConfig, extraEnv = {}) {
  return spawnSync("bash", [preflightPath], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
      FIELDWORK_ANDROID_ARTIFACT_SIGNING_FILE: artifactSigning,
      FIELDWORK_ANDROID_RELEASE_BUILDCONFIG: buildConfig,
      ...extraEnv,
    },
  });
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
if (args[0] === "shell" && args[1] === "pm" && args[2] === "path") {
  out("package:/data/app/~~hash/app.fieldwork.android-base.apk\\n");
  process.exit(0);
}
if (args[0] === "shell" && args[1] === "dumpsys" && args[2] === "package") {
  out("Packages:\\n  Package [app.fieldwork.android] (abc):\\n    versionCode=1 minSdk=30 targetSdk=36\\n    versionName=1.0\\n");
  process.exit(0);
}
if (args[0] === "logcat") {
  if (args.includes("-c")) {
    process.exit(0);
  }
  if (args.includes("-b") && args.includes("crash")) {
    out("\\n");
  } else {
    out("I Fieldwork biometric gate visible\\n");
  }
  process.exit(0);
}
if (args[0] === "exec-out" && args[1] === "screencap") {
  writePng();
  process.exit(0);
}
if (args[0] === "shell" && args[1] === "am" && args[2] === "force-stop") {
  process.exit(0);
}
if (args[0] === "shell" && args[1] === "am" && args[2] === "start") {
  out("Status: ok\\nLaunchState: COLD\\nActivity: app.fieldwork.android/.MainActivity\\nTotalTime: 920\\n");
  process.exit(0);
}
if (args[0] === "shell" && args[1] === "uiautomator" && args[2] === "dump") {
  out("UI hierchary dumped to: " + args[3] + "\\n");
  process.exit(0);
}
if (args[0] === "pull") {
  const src = args[1] || "";
  const dest = args[2];
  const xml = src.includes("locked")
    ? '<hierarchy><node text="Unlock"/></hierarchy>\\n'
    : '<hierarchy><node text="Confirm fingerprint"/><node text="Touch the fingerprint sensor"/></hierarchy>\\n';
  fs.writeFileSync(dest, xml);
  out(src + ": 1 file pulled\\n");
  process.exit(0);
}
if (args[0] === "shell" && args[1] === "rm") {
  process.exit(0);
}
console.error("unexpected adb args: " + args.join(" "));
process.exit(1);
`;
}

function buildFwStub() {
  return `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "ls") {
  process.stdout.write("refactoringjob\\tclaude\\nshell\\tbash\\n");
  process.exit(0);
}
if (args[0] === "devices") {
  process.stdout.write("Android Pixel_6 paired device\\n");
  process.exit(0);
}
console.error("unexpected fw args: " + args.join(" "));
process.exit(1);
`;
}

function expect(value, message) {
  if (!value) {
    throw new Error(message);
  }
}

function expectStatus(result, expected, message) {
  if (result.status !== expected) {
    throw new Error(`${message}: exited ${result.status}, expected ${expected}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
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
