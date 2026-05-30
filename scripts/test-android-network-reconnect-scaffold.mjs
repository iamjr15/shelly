#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const node = process.execPath;
const scaffold = path.join(root, "scripts/create-android-network-reconnect-evidence-dir.mjs");
const verifier = path.join(root, "scripts/verify-android-network-reconnect-evidence.mjs");
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fieldwork-android-reconnect-scaffold-test-"));

try {
  const evidenceDir = path.join(tmpRoot, "evidence");
  expectStatus(
    spawnSync(node, [scaffold, "--dir", evidenceDir, "--quiet", "--print-dir"], { cwd: root, encoding: "utf8" }),
    0,
    "scaffold should create an evidence directory",
  );

  const requiredFiles = readRequiredFiles();
  const manifest = JSON.parse(fs.readFileSync(path.join(evidenceDir, "manifest.json"), "utf8"));
  expectEqual(manifest.schema, "fieldwork-android-network-reconnect-evidence-v1", "manifest schema should be pinned");
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
  expect(readme.includes("FIELDWORK_ANDROID_RECONNECT_CAPTURE_BEFORE=true"), "README should document before-cut capture mode");
  expect(readme.includes("FIELDWORK_ANDROID_RECONNECT_CUT_NETWORK=true"), "README should document network-cut mode");
  expect(readme.includes("FIELDWORK_ANDROID_RECONNECT_RESTORE_NETWORK=true"), "README should document network-restore mode");
  expect(readme.includes("FIELDWORK_ANDROID_RECONNECT_CAPTURE_AFTER=true"), "README should document after-restore capture mode");
  expect(readme.includes("FIELDWORK_ANDROID_RECONNECT_VERIFY=true"), "README should document verify mode");
  expect(readme.includes("It does not create\n`offline-output-replay.txt` or `reconnect-replay.txt`"), "README should state replays are not fabricated");

  const preflightPath = path.join(evidenceDir, "preflight.sh");
  expect((fs.statSync(preflightPath).mode & 0o700) === 0o700, "preflight helper should be executable by the owner");

  const binDir = path.join(tmpRoot, "bin");
  fs.mkdirSync(binDir);
  const adbStub = path.join(binDir, "adb");
  fs.writeFileSync(adbStub, buildAdbStub(), { mode: 0o700 });
  fs.chmodSync(adbStub, 0o700);
  const buildConfig = path.join(tmpRoot, "BuildConfig.java");
  fs.writeFileSync(buildConfig, writeBuildConfig());
  const artifactSigning = path.join(tmpRoot, "artifact-signing.txt");
  fs.writeFileSync(
    artifactSigning,
    "Android AAB ok: base/lib/arm64-v8a/libfieldwork_mobile_core.so; packaged manifest identity, version, uses-permission allowlist, and privacy surface ok; signed release bundle ok\n",
  );

  const staticPreflight = runPreflight(preflightPath, binDir, artifactSigning, buildConfig);
  expectStatus(staticPreflight, 0, "preflight should capture release/device/package evidence");
  expect(staticPreflight.stdout.includes("Android network reconnect preflight ok"), "preflight should report static success");
  expect(!fs.existsSync(path.join(evidenceDir, "offline-output-replay.txt")), "preflight must not fabricate offline replay");
  expect(!fs.existsSync(path.join(evidenceDir, "reconnect-replay.txt")), "preflight must not fabricate reconnect replay");

  const before = runPreflight(preflightPath, binDir, artifactSigning, buildConfig, {
    FIELDWORK_ANDROID_RECONNECT_CAPTURE_BEFORE: "true",
  });
  expectStatus(before, 0, "before-cut capture should collect attached terminal evidence");
  expect(before.stdout.includes("before-cut capture ok"), "before-cut capture should report success");
  for (const file of ["attached-before.png", "attached-before-ui.xml"]) {
    expect(fs.existsSync(path.join(evidenceDir, file)), `before-cut capture should write ${file}`);
  }

  const cut = runPreflight(preflightPath, binDir, artifactSigning, buildConfig, {
    FIELDWORK_ANDROID_RECONNECT_CUT_NETWORK: "true",
  });
  expectStatus(cut, 0, "network-cut capture should enable airplane mode and record state");
  expect(cut.stdout.includes("network reconnect cut capture ok"), "network-cut capture should report success");
  expect(
    fs.readFileSync(path.join(evidenceDir, "network-cut.txt"), "utf8").includes("network_state=disconnected"),
    "network-cut.txt should record disconnected state",
  );

  const restore = runPreflight(preflightPath, binDir, artifactSigning, buildConfig, {
    FIELDWORK_ANDROID_RECONNECT_RESTORE_NETWORK: "true",
  });
  expectStatus(restore, 0, "network-restore capture should disable airplane mode and record ping");
  expect(restore.stdout.includes("network reconnect restore capture ok"), "network-restore capture should report success");
  expect(
    fs.readFileSync(path.join(evidenceDir, "network-restore.txt"), "utf8").includes("network_ping_ok"),
    "network-restore.txt should record successful ping",
  );

  const after = runPreflight(preflightPath, binDir, artifactSigning, buildConfig, {
    FIELDWORK_ANDROID_RECONNECT_CAPTURE_AFTER: "true",
  });
  expectStatus(after, 0, "after-restore capture should collect attached terminal evidence and logs");
  expect(after.stdout.includes("after-restore capture ok"), "after-restore capture should report success");
  for (const file of ["attached-after.png", "attached-after-ui.xml", "logcat.log", "crash.log"]) {
    expect(fs.existsSync(path.join(evidenceDir, file)), `after-restore capture should write ${file}`);
  }

  const verifyMissingReplay = runPreflight(preflightPath, binDir, artifactSigning, buildConfig, {
    FIELDWORK_ANDROID_RECONNECT_VERIFY: "true",
  });
  expectStatus(verifyMissingReplay, 1, "verify mode should require real replay evidence");
  expect(verifyMissingReplay.stderr.includes("offline-output-replay.txt is missing"), "missing replay failure should be explicit");

  fs.writeFileSync(path.join(evidenceDir, "offline-output-replay.txt"), writeOfflineReplay());
  fs.writeFileSync(path.join(evidenceDir, "reconnect-replay.txt"), writeReconnectReplay());
  const verifyComplete = runPreflight(preflightPath, binDir, artifactSigning, buildConfig, {
    FIELDWORK_ANDROID_RECONNECT_VERIFY: "true",
  });
  expectStatus(verifyComplete, 0, "verify mode should pass after staged evidence and replay transcripts exist");
  expect(verifyComplete.stdout.includes("Android network reconnect evidence ok"), "verify mode should report network reconnect evidence success");

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
      FIELDWORK_ANDROID_RECONNECT_NETWORK_SLEEP_SECONDS: "0",
      FIELDWORK_ADB_STUB_MODE: "emulator",
    },
  });
  expectStatus(emulatorPreflight, 1, "preflight should reject emulator adb evidence");
  expect(emulatorPreflight.stderr.includes("not an emulator or AVD"), "emulator failure should be explicit");

  console.log("Android network reconnect evidence scaffold self-test ok");
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
      FIELDWORK_ANDROID_RECONNECT_NETWORK_SLEEP_SECONDS: "0",
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

function writeOfflineReplay() {
  return [
    "ANDROID_RECONNECT_READY",
    "trigger_offline_output",
    "ANDROID_RECONNECT_OFFLINE_OUTPUT",
    "",
  ].join("\n");
}

function writeReconnectReplay() {
  return [
    "ANDROID_RECONNECT_READY",
    "trigger_offline_output",
    "ANDROID_RECONNECT_OFFLINE_OUTPUT",
    "after_reconnect_ok",
    "android-reconnect: after_reconnect_ok",
    "reconnect_ms=399",
    "",
  ].join("\n");
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
  else out("I Fieldwork network reconnect ok\\n");
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
  const destination = args[2];
  if (destination.includes("attached-before")) {
    fs.writeFileSync(destination, '<hierarchy><node text="Attached"/><node text="Terminal"/><node text="ANDROID_RECONNECT_READY"/><node text="fw_reconnect_session"/></hierarchy>\\n');
  } else if (destination.includes("attached-after")) {
    fs.writeFileSync(destination, '<hierarchy><node text="Attached"/><node text="Terminal"/><node text="ANDROID_RECONNECT_OFFLINE_OUTPUT"/><node text="after_reconnect_ok"/></hierarchy>\\n');
  } else {
    fs.writeFileSync(destination, '<hierarchy><node text="Attached"/><node text="Terminal"/></hierarchy>\\n');
  }
  out(args[1] + ": 1 file pulled\\n");
  process.exit(0);
}
if (args[0] === "shell" && args[1] === "cmd" && args[2] === "connectivity" && args[3] === "airplane-mode") process.exit(0);
if (args[0] === "shell" && args[1] === "settings" && args[2] === "get" && args[3] === "global" && args[4] === "airplane_mode_on") {
  out("1\\n");
  process.exit(0);
}
if (args[0] === "shell" && args[1] === "ping") process.exit(0);
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
