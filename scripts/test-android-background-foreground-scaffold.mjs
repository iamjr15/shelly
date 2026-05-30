#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const node = process.execPath;
const scaffold = path.join(root, "scripts/create-android-background-foreground-evidence-dir.mjs");
const verifier = path.join(root, "scripts/verify-android-background-foreground-evidence.mjs");
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fieldwork-android-background-scaffold-test-"));

try {
  const evidenceDir = path.join(tmpRoot, "evidence");
  expectStatus(
    spawnSync(node, [scaffold, "--dir", evidenceDir, "--quiet", "--print-dir"], { cwd: root, encoding: "utf8" }),
    0,
    "scaffold should create an evidence directory",
  );

  const requiredFiles = readRequiredFiles();
  const manifest = JSON.parse(fs.readFileSync(path.join(evidenceDir, "manifest.json"), "utf8"));
  expectEqual(manifest.schema, "fieldwork-android-background-foreground-evidence-v1", "manifest schema should be pinned");
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
  expect(readme.includes("FIELDWORK_ANDROID_BG_CAPTURE_BEFORE=true"), "README should document before-background capture mode");
  expect(readme.includes("FIELDWORK_ANDROID_BG_CAPTURE_BACKGROUND=true"), "README should document background capture mode");
  expect(readme.includes("FIELDWORK_ANDROID_BG_CAPTURE_AFTER=true"), "README should document after-foreground capture mode");
  expect(readme.includes("FIELDWORK_ANDROID_BG_VERIFY=true"), "README should document verify mode");
  expect(
    readme.includes("It does not create\n`background-output-replay.txt`, `post-foreground-replay.txt`, or\n`timing.txt`"),
    "README should state replay and timing evidence are not fabricated",
  );

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
  expect(staticPreflight.stdout.includes("Android background/foreground preflight ok"), "preflight should report static success");
  expect(!fs.existsSync(path.join(evidenceDir, "background-output-replay.txt")), "preflight must not fabricate background replay");
  expect(!fs.existsSync(path.join(evidenceDir, "post-foreground-replay.txt")), "preflight must not fabricate post-foreground replay");
  expect(!fs.existsSync(path.join(evidenceDir, "timing.txt")), "preflight must not fabricate timing");

  const before = runPreflight(preflightPath, binDir, artifactSigning, buildConfig, {
    FIELDWORK_ANDROID_BG_CAPTURE_BEFORE: "true",
  });
  expectStatus(before, 0, "before-background capture should collect attached terminal evidence");
  expect(before.stdout.includes("before-background capture ok"), "before-background capture should report success");
  for (const file of ["attached-before.png", "attached-before-ui.xml"]) {
    expect(fs.existsSync(path.join(evidenceDir, file)), `before-background capture should write ${file}`);
  }

  const background = runPreflight(preflightPath, binDir, artifactSigning, buildConfig, {
    FIELDWORK_ANDROID_BG_CAPTURE_BACKGROUND: "true",
  });
  expectStatus(background, 0, "background capture should record KEYCODE_HOME state");
  expect(background.stdout.includes("background-state capture ok"), "background capture should report success");
  expect(
    fs.readFileSync(path.join(evidenceDir, "background-state.txt"), "utf8").includes("background_command=adb shell input keyevent KEYCODE_HOME"),
    "background-state.txt should record the KEYCODE_HOME command",
  );

  const after = runPreflight(preflightPath, binDir, artifactSigning, buildConfig, {
    FIELDWORK_ANDROID_BG_CAPTURE_AFTER: "true",
  });
  expectStatus(after, 0, "after-foreground capture should collect attached terminal evidence and logs");
  expect(after.stdout.includes("after-foreground capture ok"), "after-foreground capture should report success");
  for (const file of ["attached-after.png", "attached-after-ui.xml", "logcat.log", "crash.log"]) {
    expect(fs.existsSync(path.join(evidenceDir, file)), `after-foreground capture should write ${file}`);
  }

  const verifyMissingReplay = runPreflight(preflightPath, binDir, artifactSigning, buildConfig, {
    FIELDWORK_ANDROID_BG_VERIFY: "true",
  });
  expectStatus(verifyMissingReplay, 1, "verify mode should require real replay and timing evidence");
  expect(verifyMissingReplay.stderr.includes("background-output-replay.txt is missing"), "missing replay failure should be explicit");

  fs.writeFileSync(path.join(evidenceDir, "background-output-replay.txt"), writeBackgroundReplay());
  fs.writeFileSync(path.join(evidenceDir, "post-foreground-replay.txt"), writePostForegroundReplay());
  fs.writeFileSync(path.join(evidenceDir, "timing.txt"), writeTiming());
  const verifyComplete = runPreflight(preflightPath, binDir, artifactSigning, buildConfig, {
    FIELDWORK_ANDROID_BG_VERIFY: "true",
  });
  expectStatus(verifyComplete, 0, "verify mode should pass after staged evidence, replay transcripts, and timing exist");
  expect(
    verifyComplete.stdout.includes("Android background/foreground evidence ok"),
    "verify mode should report background/foreground evidence success",
  );

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
      FIELDWORK_ANDROID_BG_BACKGROUND_SLEEP_SECONDS: "0",
      FIELDWORK_ADB_STUB_MODE: "emulator",
    },
  });
  expectStatus(emulatorPreflight, 1, "preflight should reject emulator adb evidence");
  expect(emulatorPreflight.stderr.includes("not an emulator or AVD"), "emulator failure should be explicit");

  console.log("Android background/foreground evidence scaffold self-test ok");
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
      FIELDWORK_ANDROID_BG_BACKGROUND_SLEEP_SECONDS: "0",
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

function writeBackgroundReplay() {
  return [
    "ANDROID_BACKGROUND_READY",
    "trigger_background_output",
    "ANDROID_BACKGROUND_REPLAY_OUTPUT",
    "",
  ].join("\n");
}

function writePostForegroundReplay() {
  return [
    "ANDROID_BACKGROUND_READY",
    "trigger_background_output",
    "ANDROID_BACKGROUND_REPLAY_OUTPUT",
    "after_background_ok",
    "android-background: after_background_ok",
    "",
  ].join("\n");
}

function writeTiming() {
  return [
    "backgrounded_at=2026-05-24T00:00:00Z",
    "foregrounded_at=2026-05-24T00:00:04Z",
    "background_duration_ms=4000",
    "foreground_reconnect_ms=481",
    "release_device_background_foreground_candidate=pass",
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
  else out("I Fieldwork background foreground ok\\n");
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
    fs.writeFileSync(destination, '<hierarchy><node text="Attached"/><node text="Terminal"/><node text="ANDROID_BACKGROUND_READY"/><node text="fw_background_session"/></hierarchy>\\n');
  } else if (destination.includes("attached-after")) {
    fs.writeFileSync(destination, '<hierarchy><node text="Attached"/><node text="Terminal"/><node text="ANDROID_BACKGROUND_REPLAY_OUTPUT"/><node text="after_background_ok"/></hierarchy>\\n');
  } else {
    fs.writeFileSync(destination, '<hierarchy><node text="Attached"/><node text="Terminal"/></hierarchy>\\n');
  }
  out(args[1] + ": 1 file pulled\\n");
  process.exit(0);
}
if (args[0] === "shell" && args[1] === "input" && args[2] === "keyevent" && args[3] === "KEYCODE_HOME") process.exit(0);
if (args[0] === "shell" && args[1] === "dumpsys" && args[2] === "window") {
  out("mCurrentFocus=Window{123 u0 com.android.launcher3/.Launcher}\\n");
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
