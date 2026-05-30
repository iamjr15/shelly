#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const node = process.execPath;
const scaffold = path.join(root, "scripts/create-android-multisession-evidence-dir.mjs");
const verifier = path.join(root, "scripts/verify-android-multisession-evidence.mjs");
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fieldwork-android-multisession-scaffold-test-"));

try {
  const evidenceDir = path.join(tmpRoot, "evidence");
  expectStatus(
    spawnSync(node, [scaffold, "--dir", evidenceDir, "--quiet", "--print-dir"], { cwd: root, encoding: "utf8" }),
    0,
    "scaffold should create an evidence directory",
  );

  const requiredFiles = readRequiredFiles();
  const manifest = JSON.parse(fs.readFileSync(path.join(evidenceDir, "manifest.json"), "utf8"));
  expectEqual(manifest.schema, "fieldwork-android-multisession-evidence-v1", "manifest schema should be pinned");
  expectDeepEqual(manifest.requiredFiles, requiredFiles, "manifest should mirror verifier required files");
  expectEqual(
    fs.readFileSync(path.join(evidenceDir, "missing-files.txt"), "utf8"),
    `${requiredFiles.join("\n")}\n`,
    "missing-files.txt should list every required evidence file",
  );

  const checklist = fs.readFileSync(path.join(evidenceDir, "capture-checklist.md"), "utf8");
  const readme = fs.readFileSync(path.join(evidenceDir, "README.md"), "utf8");
  for (const file of requiredFiles) {
    expect(checklist.includes(`\`${file}\``), `capture checklist should mention ${file}`);
    expect(!fs.existsSync(path.join(evidenceDir, file)), `scaffold must not fabricate ${file}`);
  }
  expect(readme.includes("FIELDWORK_ANDROID_MULTISESSION_CAPTURE_SESSIONS=true"), "README should document session-list capture mode");
  expect(readme.includes("FIELDWORK_ANDROID_MULTISESSION_CAPTURE_APP=true"), "README should document app capture mode");
  expect(readme.includes("FIELDWORK_ANDROID_MULTISESSION_VERIFY=true"), "README should document verify mode");
  expect(
    readme.includes("It does not create\n`multisession-a-replay.txt`, `multisession-b-replay.txt`, or\n`multisession-c-replay.txt`"),
    "README should state replay files are not fabricated",
  );

  const preflightPath = path.join(evidenceDir, "preflight.sh");
  expect((fs.statSync(preflightPath).mode & 0o700) === 0o700, "preflight helper should be executable by the owner");

  const binDir = path.join(tmpRoot, "bin");
  fs.mkdirSync(binDir);
  const adbStub = path.join(binDir, "adb");
  fs.writeFileSync(adbStub, buildAdbStub(), { mode: 0o700 });
  fs.chmodSync(adbStub, 0o700);
  const fwStub = path.join(binDir, "fw");
  fs.writeFileSync(fwStub, buildFwStub(), { mode: 0o700 });
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
  expect(staticPreflight.stdout.includes("Android multisession preflight ok"), "preflight should report static success");
  for (const replay of ["multisession-a-replay.txt", "multisession-b-replay.txt", "multisession-c-replay.txt"]) {
    expect(!fs.existsSync(path.join(evidenceDir, replay)), `preflight must not fabricate ${replay}`);
  }

  const sessions = runPreflight(preflightPath, binDir, artifactSigning, buildConfig, {
    FIELDWORK_ANDROID_MULTISESSION_CAPTURE_SESSIONS: "true",
  });
  expectStatus(sessions, 0, "session-list capture should collect fwm_a/fwm_b/fwm_c");
  expect(sessions.stdout.includes("session-list capture ok"), "session-list capture should report success");
  expect(fs.existsSync(path.join(evidenceDir, "sessions.txt")), "session-list capture should write sessions.txt");

  const app = runPreflight(preflightPath, binDir, artifactSigning, buildConfig, {
    FIELDWORK_ANDROID_MULTISESSION_CAPTURE_APP: "true",
  });
  expectStatus(app, 0, "app capture should collect multisession Android evidence");
  expect(app.stdout.includes("app capture ok"), "app capture should report success");
  for (const file of ["multisession.png", "multisession-ui.xml", "multisession-logcat.log", "multisession-crash.log"]) {
    expect(fs.existsSync(path.join(evidenceDir, file)), `app capture should write ${file}`);
  }

  const verifyMissingReplay = runPreflight(preflightPath, binDir, artifactSigning, buildConfig, {
    FIELDWORK_ANDROID_MULTISESSION_VERIFY: "true",
  });
  expectStatus(verifyMissingReplay, 1, "verify mode should require real replay evidence");
  expect(verifyMissingReplay.stderr.includes("multisession-a-replay.txt is missing"), "missing replay failure should be explicit");

  fs.writeFileSync(path.join(evidenceDir, "multisession-a-replay.txt"), "fwm_a\nmulti_a_ok\n");
  fs.writeFileSync(path.join(evidenceDir, "multisession-b-replay.txt"), "fwm_b\nmulti_b_ok\n");
  fs.writeFileSync(path.join(evidenceDir, "multisession-c-replay.txt"), "fwm_c\nmulti_c_ok\n");
  const verifyComplete = runPreflight(preflightPath, binDir, artifactSigning, buildConfig, {
    FIELDWORK_ANDROID_MULTISESSION_VERIFY: "true",
  });
  expectStatus(verifyComplete, 0, "verify mode should pass after staged evidence and replay transcripts exist");
  expect(verifyComplete.stdout.includes("Android multisession evidence ok"), "verify mode should report multisession evidence success");

  for (const file of requiredFiles) {
    expect(fs.existsSync(path.join(evidenceDir, file)), `complete staged capture should write ${file}`);
  }

  const emulatorDir = path.join(tmpRoot, "emulator");
  expectStatus(spawnSync(node, [scaffold, "--dir", emulatorDir, "--quiet"], { cwd: root, encoding: "utf8" }), 0, "scaffold should create emulator directory");
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

  console.log("Android multisession evidence scaffold self-test ok");
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
      FIELDWORK_CLI: "fw",
      ...extraEnv,
    },
    maxBuffer: 8 * 1024 * 1024,
  });
}

function readRequiredFiles() {
  const source = fs.readFileSync(verifier, "utf8");
  const match = source.match(/const\s+requiredFiles\s*=\s*\[(?<body>[\s\S]*?)\];/);
  if (!match?.groups?.body) throw new Error("cannot locate requiredFiles in verifier");
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

function buildFwStub() {
  return `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "ls") {
  process.stdout.write("fwm_a bash\\nfwm_b bash\\nfwm_c bash\\n");
  process.exit(0);
}
console.error("unexpected fw args: " + args.join(" "));
process.exit(1);
`;
}

function buildAdbStub() {
  return `#!/usr/bin/env node
const fs = require("fs");
let args = process.argv.slice(2);
const mode = process.env.FIELDWORK_ADB_STUB_MODE || "physical";
if (args[0] === "-s") args = args.slice(2);
function out(text) { process.stdout.write(text); }
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
  if (mode === "emulator") out("List of devices attached\\nemulator-5554 device product:sdk_gphone64_arm64 model:sdk_gphone64_arm64 device:emu64a transport_id:1\\n");
  else out("List of devices attached\\nR5CT1234567 device usb:336592896X product:oriole model:Pixel_6 device:oriole transport_id:9\\n");
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
  if (args.includes("-c")) process.exit(0);
  if (args.includes("-b") && args.includes("crash")) out("\\n");
  else out("I FieldworkRepository: listSessions returned 3 sessions\\n");
  process.exit(0);
}
if (args[0] === "exec-out" && args[1] === "screencap") {
  writePng();
  process.exit(0);
}
if (args[0] === "shell" && args[1] === "uiautomator" && args[2] === "dump") {
  out("UI hierchary dumped to: " + args[3] + "\\n");
  process.exit(0);
}
if (args[0] === "pull") {
  fs.writeFileSync(args[2], '<hierarchy><node text="fwm_a"/><node text="fwm_b"/><node text="fwm_c"/></hierarchy>\\n');
  out(args[1] + ": 1 file pulled\\n");
  process.exit(0);
}
if (args[0] === "shell" && args[1] === "rm") process.exit(0);
console.error("unexpected adb args: " + args.join(" "));
process.exit(1);
`;
}

function expect(value, message) {
  if (!value) throw new Error(message);
}

function expectStatus(result, expected, message) {
  if (result.status !== expected) {
    throw new Error(`${message}: exited ${result.status}, expected ${expected}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
}

function expectEqual(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function expectDeepEqual(actual, expected, message) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
