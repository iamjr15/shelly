#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const node = process.execPath;
const scaffold = path.join(root, "scripts/create-android-terminal-attach-evidence-dir.mjs");
const verifier = path.join(root, "scripts/verify-android-terminal-attach-evidence.mjs");
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fieldwork-android-terminal-scaffold-test-"));

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
  expectEqual(manifest.schema, "fieldwork-android-terminal-attach-evidence-v1", "manifest schema should be pinned");
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
  expect(checklist.includes("terminal-replay.txt"), "checklist should mention shell replay capture");
  expect(checklist.includes("claude-replay.txt"), "checklist should mention Claude replay capture");

  const readme = fs.readFileSync(path.join(evidenceDir, "README.md"), "utf8");
  expect(readme.includes("FIELDWORK_ANDROID_TERMINAL_CAPTURE_SHELL=true"), "README should document shell capture mode");
  expect(readme.includes("FIELDWORK_ANDROID_TERMINAL_CAPTURE_CLAUDE=true"), "README should document Claude capture mode");
  expect(readme.includes("FIELDWORK_ANDROID_TERMINAL_CAPTURE_TUI=true"), "README should document TUI capture mode");
  expect(readme.includes("FIELDWORK_ANDROID_TERMINAL_VERIFY=true"), "README should document verify mode");
  expect(readme.includes("bounded UI dumps"), "README should document bounded UI dump capture");
  expect(readme.includes("does not create `terminal-replay.txt`"), "README should state replay transcripts are not fabricated");

  const preflightPath = path.join(evidenceDir, "preflight.sh");
  const preflight = fs.readFileSync(preflightPath, "utf8");
  expect(preflight.startsWith("#!/usr/bin/env bash"), "preflight helper should be a shell script");
  expect(preflight.includes("FIELDWORK_ANDROID_AAB"), "preflight should allow signed AAB override");
  expect(preflight.includes("FIELDWORK_ANDROID_ARTIFACT_SIGNING_FILE"), "preflight should allow captured signing output");
  expect(preflight.includes("FIELDWORK_ANDROID_TERMINAL_CAPTURE_SHELL"), "preflight should support shell capture");
  expect(preflight.includes("FIELDWORK_ANDROID_TERMINAL_CAPTURE_CLAUDE"), "preflight should support Claude capture");
  expect(preflight.includes("FIELDWORK_ANDROID_TERMINAL_CAPTURE_TUI"), "preflight should support TUI capture");
  expect(preflight.includes("FIELDWORK_ANDROID_TERMINAL_VERIFY"), "preflight should support verification mode");
  expect(preflight.includes("FIELDWORK_ANDROID_UI_DUMP_TIMEOUT_SECONDS"), "preflight should bound uiautomator dump capture");
  expect(preflight.includes("require_command python3"), "preflight should require python3 for bounded adb capture");
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
  expect(staticPreflight.stdout.includes("Android terminal attach preflight ok"), "preflight should report static success");
  expect(fs.existsSync(path.join(evidenceDir, "artifact-signing.txt")), "preflight should write artifact signing evidence");
  expect(fs.existsSync(path.join(evidenceDir, "buildconfig.txt")), "preflight should write BuildConfig evidence");
  expect(fs.existsSync(path.join(evidenceDir, "adb-devices.txt")), "preflight should write adb device evidence");
  expect(fs.existsSync(path.join(evidenceDir, "package-info.txt")), "preflight should write package info evidence");
  expect(!fs.existsSync(path.join(evidenceDir, "terminal-replay.txt")), "preflight must not fabricate shell replay");
  expect(!fs.existsSync(path.join(evidenceDir, "claude-replay.txt")), "preflight must not fabricate Claude replay");

  const shellCapture = runPreflight(preflightPath, binDir, artifactSigning, buildConfig, {
    FIELDWORK_ANDROID_TERMINAL_CAPTURE_SHELL: "true",
  });
  expectStatus(shellCapture, 0, "shell capture should collect shell terminal evidence");
  expect(shellCapture.stdout.includes("Android terminal shell capture ok"), "shell capture should report success");
  expect(fs.existsSync(path.join(evidenceDir, "session.png")), "shell capture should write session.png");
  expect(fs.existsSync(path.join(evidenceDir, "session-ui.xml")), "shell capture should write session-ui.xml");
  expect(fs.existsSync(path.join(evidenceDir, "sessions.txt")), "capture should write sessions.txt from fw ls");

  const uiTimeoutDir = path.join(tmpRoot, "ui-timeout");
  expectStatus(
    spawnSync(node, [scaffold, "--dir", uiTimeoutDir, "--quiet"], { cwd: root, encoding: "utf8" }),
    0,
    "scaffold should create UI timeout test evidence directory",
  );
  const uiTimeoutPreflight = spawnSync("bash", [path.join(uiTimeoutDir, "preflight.sh")], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
      FIELDWORK_ANDROID_ARTIFACT_SIGNING_FILE: artifactSigning,
      FIELDWORK_ANDROID_RELEASE_BUILDCONFIG: buildConfig,
      FIELDWORK_ANDROID_TERMINAL_CAPTURE_SHELL: "true",
      FIELDWORK_ANDROID_UI_DUMP_TIMEOUT_SECONDS: "0.1",
      FIELDWORK_ADB_STUB_MODE: "ui-timeout",
    },
  });
  expectStatus(uiTimeoutPreflight, 124, "preflight should fail fast when uiautomator dump hangs");
  expect(
    uiTimeoutPreflight.stderr.includes("uiautomator dump timed out") || uiTimeoutPreflight.stderr.includes("timed out after 0.1s"),
    "UI dump timeout failure should explain the stuck adb capture",
  );

  const claudeCapture = runPreflight(preflightPath, binDir, artifactSigning, buildConfig, {
    FIELDWORK_ANDROID_TERMINAL_CAPTURE_CLAUDE: "true",
  });
  expectStatus(claudeCapture, 0, "Claude capture should collect Claude terminal evidence");
  expect(claudeCapture.stdout.includes("Android terminal Claude capture ok"), "Claude capture should report success");
  expect(fs.existsSync(path.join(evidenceDir, "claude.png")), "Claude capture should write claude.png");

  const tuiCapture = runPreflight(preflightPath, binDir, artifactSigning, buildConfig, {
    FIELDWORK_ANDROID_TERMINAL_CAPTURE_TUI: "true",
  });
  expectStatus(tuiCapture, 0, "TUI capture should collect TUI terminal evidence");
  expect(tuiCapture.stdout.includes("Android terminal TUI capture ok"), "TUI capture should report success");
  expect(fs.existsSync(path.join(evidenceDir, "tui.png")), "TUI capture should write tui.png");

  const verifyMissingReplay = runPreflight(preflightPath, binDir, artifactSigning, buildConfig, {
    FIELDWORK_ANDROID_TERMINAL_VERIFY: "true",
  });
  expectStatus(verifyMissingReplay, 1, "verify mode should require real replay transcripts");
  expect(verifyMissingReplay.stderr.includes("terminal-replay.txt is missing"), "missing replay failure should be explicit");

  fs.writeFileSync(path.join(evidenceDir, "terminal-replay.txt"), "shell bash\nandroid_live_ok\n");
  fs.writeFileSync(path.join(evidenceDir, "claude-replay.txt"), "refactoringjob claude\nclaude_live_ok\n");
  const verifyComplete = runPreflight(preflightPath, binDir, artifactSigning, buildConfig, {
    FIELDWORK_ANDROID_TERMINAL_VERIFY: "true",
  });
  expectStatus(verifyComplete, 0, "verify mode should pass after staged evidence and replay transcripts exist");
  expect(verifyComplete.stdout.includes("Android terminal attach evidence ok"), "verify mode should report terminal evidence success");

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

  console.log("Android terminal attach evidence scaffold self-test ok");
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
    out("I FieldworkRepository: listSessions returned 3 sessions\\n");
  }
  process.exit(0);
}
if (args[0] === "exec-out" && args[1] === "screencap") {
  writePng();
  process.exit(0);
}
if (args[0] === "shell" && args[1] === "uiautomator") {
  if (mode === "ui-timeout") {
    setTimeout(() => {}, 10_000);
    return;
  }
  out("UI hierchary dumped to: /sdcard/fieldwork-terminal.xml\\n");
  process.exit(0);
}
if (args[0] === "pull") {
  const file = args[2];
  if (file.includes("session-ui")) {
    fs.writeFileSync(file, '<hierarchy><node text="Attached"/><node text="shell"/><node text="bash"/></hierarchy>\\n');
  } else if (file.includes("claude-ui")) {
    fs.writeFileSync(file, '<hierarchy><node text="Attached"/><node text="refactoringjob"/><node text="claude"/></hierarchy>\\n');
  } else {
    fs.writeFileSync(file, '<hierarchy><node text="Attached"/><node text="editor"/><node text="F1Help"/><node text="F2Setup"/><node text="F10Quit"/></hierarchy>\\n');
  }
  process.exit(0);
}
if (args[0] === "shell" && args[1] === "rm") {
  process.exit(0);
}
console.error("unexpected adb invocation: " + args.join(" "));
process.exit(64);
`;
}

function buildFwStub() {
  return `#!/usr/bin/env bash
set -euo pipefail
case "\${1:-}" in
  ls)
    printf 'refactoringjob claude\\nshell bash\\neditor htop\\n'
    ;;
  *)
    echo "unexpected fw invocation: $*" >&2
    exit 64
    ;;
esac
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
