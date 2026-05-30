#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const node = process.execPath;
const scaffold = path.join(root, "scripts/create-android-dogfood-evidence-dir.mjs");
const verifier = path.join(root, "scripts/verify-android-dogfood-evidence.mjs");
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fieldwork-android-dogfood-scaffold-test-"));

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
  expectEqual(manifest.schema, "fieldwork-android-dogfood-evidence-v1", "manifest schema should be pinned");
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
  expect(checklist.includes("does not create sessions"), "checklist should state sessions are not fabricated");
  expect(checklist.includes("create duration proof"), "checklist should state duration proof is not fabricated");
  expect(checklist.includes("create PTY"), "checklist should state replay transcripts are not fabricated");

  const readme = fs.readFileSync(path.join(evidenceDir, "README.md"), "utf8");
  for (const marker of [
    "FIELDWORK_ANDROID_DOGFOOD_CAPTURE_CLAUDE=true",
    "FIELDWORK_ANDROID_DOGFOOD_CAPTURE_SCROLL=true",
    "FIELDWORK_ANDROID_DOGFOOD_CAPTURE_RESIZE=true",
    "FIELDWORK_ANDROID_DOGFOOD_CAPTURE_PASTE=true",
    "FIELDWORK_ANDROID_DOGFOOD_CAPTURE_FINAL=true",
    "FIELDWORK_ANDROID_DOGFOOD_VERIFY=true",
  ]) {
    expect(readme.includes(marker), `README should document ${marker}`);
  }
  expect(readme.includes("does\nnot create `dogfood-duration.txt`"), "README should state duration proof is not fabricated");

  const preflightPath = path.join(evidenceDir, "preflight.sh");
  const preflight = fs.readFileSync(preflightPath, "utf8");
  expect(preflight.startsWith("#!/usr/bin/env bash"), "preflight helper should be a shell script");
  expect(preflight.includes("FIELDWORK_ANDROID_RELEASE_BUILDCONFIG"), "preflight should allow BuildConfig override");
  expect(preflight.includes("FIELDWORK_ANDROID_DOGFOOD_CAPTURE_CLAUDE"), "preflight should support Claude capture");
  expect(preflight.includes("FIELDWORK_ANDROID_DOGFOOD_CAPTURE_FINAL"), "preflight should support final log capture");
  expect(preflight.includes("FIELDWORK_ANDROID_DOGFOOD_VERIFY"), "preflight should support verification mode");
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
  fs.writeFileSync(adbStub, buildAdbStub(), { mode: 0o700 });
  fs.chmodSync(adbStub, 0o700);

  const buildConfig = path.join(tmpRoot, "BuildConfig.java");
  fs.writeFileSync(buildConfig, writeBuildConfig());

  const staticPreflight = runPreflight(preflightPath, binDir, buildConfig);
  expectStatus(staticPreflight, 0, "preflight should capture physical device/package/build evidence");
  expect(staticPreflight.stdout.includes("Android dogfood preflight ok"), "preflight should report static success");
  expect(fs.existsSync(path.join(evidenceDir, "adb-devices.txt")), "preflight should write adb device evidence");
  expect(fs.existsSync(path.join(evidenceDir, "package-info.txt")), "preflight should write package info evidence");
  expect(fs.existsSync(path.join(evidenceDir, "buildconfig.txt")), "preflight should write BuildConfig evidence");
  expect(!fs.existsSync(path.join(evidenceDir, "dogfood-duration.txt")), "preflight must not fabricate duration proof");
  expect(!fs.existsSync(path.join(evidenceDir, "typing-replay.txt")), "preflight must not fabricate typing replay");

  for (const [envName, expectedFile, expectedOutput] of [
    ["FIELDWORK_ANDROID_DOGFOOD_CAPTURE_CLAUDE", "claude.png", "Android dogfood Claude capture ok"],
    ["FIELDWORK_ANDROID_DOGFOOD_CAPTURE_SCROLL", "scroll.png", "Android dogfood scroll capture ok"],
    ["FIELDWORK_ANDROID_DOGFOOD_CAPTURE_RESIZE", "resize.png", "Android dogfood resize capture ok"],
    ["FIELDWORK_ANDROID_DOGFOOD_CAPTURE_PASTE", "paste.png", "Android dogfood paste capture ok"],
  ]) {
    const capture = runPreflight(preflightPath, binDir, buildConfig, { [envName]: "true" });
    expectStatus(capture, 0, `${envName} should capture staged evidence`);
    expect(capture.stdout.includes(expectedOutput), `${envName} should report success`);
    expect(fs.existsSync(path.join(evidenceDir, expectedFile)), `${envName} should write ${expectedFile}`);
  }

  const finalCapture = runPreflight(preflightPath, binDir, buildConfig, {
    FIELDWORK_ANDROID_DOGFOOD_CAPTURE_FINAL: "true",
  });
  expectStatus(finalCapture, 0, "final capture should collect final logs");
  expect(finalCapture.stdout.includes("Android dogfood final log capture ok"), "final capture should report success");
  expect(fs.existsSync(path.join(evidenceDir, "final-logcat.log")), "final capture should write final-logcat.log");
  expect(fs.existsSync(path.join(evidenceDir, "final-crash.log")), "final capture should write final-crash.log");

  const verifyMissingReplay = runPreflight(preflightPath, binDir, buildConfig, {
    FIELDWORK_ANDROID_DOGFOOD_VERIFY: "true",
  });
  expectStatus(verifyMissingReplay, 1, "verify mode should require real dogfood transcripts");
  expect(verifyMissingReplay.stderr.includes("dogfood-duration.txt is missing"), "missing dogfood duration failure should be explicit");

  writeDogfoodTranscripts(evidenceDir);
  const verifyComplete = runPreflight(preflightPath, binDir, buildConfig, {
    FIELDWORK_ANDROID_DOGFOOD_VERIFY: "true",
  });
  expectStatus(verifyComplete, 0, "verify mode should pass after staged evidence and transcripts exist");
  expect(verifyComplete.stdout.includes("Android dogfood evidence ok"), "verify mode should report dogfood evidence success");

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

  console.log("Android dogfood evidence scaffold self-test ok");
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

function runPreflight(preflightPath, binDir, buildConfig, extraEnv = {}) {
  return spawnSync("bash", [preflightPath], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
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

function writeDogfoodTranscripts(dir) {
  fs.writeFileSync(
    path.join(dir, "dogfood-duration.txt"),
    "dogfood_started_at=2026-05-22T10:00:00Z\ndogfood_finished_at=2026-05-22T10:30:01Z\ndogfood_duration_ms=1801000\ntermlib_decision_candidate=pass\n",
  );
  fs.writeFileSync(path.join(dir, "typing-replay.txt"), "refactoringjob claude\ndogfood_typing_ok\n");
  fs.writeFileSync(path.join(dir, "scroll-replay.txt"), "DOGFOOD_SCROLL_TOP\nDOGFOOD_SCROLL_BOTTOM\nscroll_verified_by_operator\n");
  fs.writeFileSync(path.join(dir, "resize-replay.txt"), "resize_size=32x120\ndogfood_resize_ok\n");
  fs.writeFileSync(
    path.join(dir, "paste-replay.txt"),
    [
      "DOGFOOD_PASTE_BEGIN",
      ...Array.from({ length: 20 }, (_, index) => `dogfood_paste_line_${String(index + 1).padStart(3, "0")}`),
      "DOGFOOD_PASTE_END",
      "dogfood_paste_ok",
      "",
    ].join("\n"),
  );
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
  const bytes = Buffer.alloc(2048);
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
    out("List of devices attached\\nR58M1234567 device product:panther model:Pixel_8_Pro device:panther transport_id:1\\n");
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
    out("I Fieldwork dogfood renderer evidence\\n");
  }
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
  const src = args[1] || "";
  const dest = args[2];
  let xml = '<hierarchy><node text="Attached"/></hierarchy>\\n';
  if (src.includes("claude")) {
    xml = '<hierarchy><node text="Attached"/><node text="refactoringjob"/><node text="claude"/></hierarchy>\\n';
  } else if (src.includes("scroll")) {
    xml = '<hierarchy><node text="Attached"/><node text="DOGFOOD_SCROLL_BOTTOM"/></hierarchy>\\n';
  } else if (src.includes("resize")) {
    xml = '<hierarchy><node text="Attached"/><node text="dogfood_resize_ok"/></hierarchy>\\n';
  } else if (src.includes("paste")) {
    xml = '<hierarchy><node text="Attached"/><node text="dogfood_paste_ok"/></hierarchy>\\n';
  }
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
