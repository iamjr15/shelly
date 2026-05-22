#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const verifier = path.join(root, "scripts/verify-android-terminal-attach-evidence.mjs");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "fieldwork-android-terminal-attach-"));

try {
  const good = path.join(temp, "good");
  writeFixture(good);
  expectStatus(good, 0, "good Android terminal attach evidence should pass");

  const emulator = path.join(temp, "emulator");
  writeFixture(emulator);
  fs.writeFileSync(
    path.join(emulator, "adb-devices.txt"),
    "List of devices attached\nemulator-5554 device product:sdk_gphone64_arm64 model:sdk_gphone64_arm64 device:emu64a transport_id:1\n",
  );
  expectStatus(emulator, 1, "emulator adb device should fail", "adb-devices.txt must show a physical Android phone");

  const debugBuild = path.join(temp, "debug-build");
  writeFixture(debugBuild);
  fs.writeFileSync(
    path.join(debugBuild, "buildconfig.txt"),
    [
      'APPLICATION_ID = "app.fieldwork.android"',
      'BUILD_TYPE = "debug"',
      'DEBUG = Boolean.parseBoolean("true")',
      "FIELDWORK_BIOMETRIC_BYPASS = false",
      'FIELDWORK_DEBUG_PAIRING_PAYLOAD = ""',
    ].join("\n"),
  );
  expectStatus(debugBuild, 1, "debug BuildConfig should fail", "buildconfig.txt must prove the tested build is the release variant");

  const unsigned = path.join(temp, "unsigned");
  writeFixture(unsigned);
  fs.writeFileSync(path.join(unsigned, "artifact-signing.txt"), "Android AAB ok: unsigned local bundle ok\n");
  expectStatus(unsigned, 1, "unsigned AAB evidence should fail", "artifact-signing.txt must prove the release App Bundle was signed");

  const missingShell = path.join(temp, "missing-shell");
  writeFixture(missingShell);
  fs.writeFileSync(path.join(missingShell, "terminal-replay.txt"), "bash\n");
  expectStatus(missingShell, 1, "missing shell marker should fail", "terminal-replay.txt must contain android_live_ok");

  const mixedClaude = path.join(temp, "mixed-claude");
  writeFixture(mixedClaude);
  fs.writeFileSync(path.join(mixedClaude, "claude-replay.txt"), "refactoringjob claude\nclaude_live_ok\nandroid_live_ok\n");
  expectStatus(mixedClaude, 1, "reused shell replay should fail Claude proof", "claude-replay.txt must not be reused from the shell attach proof");

  const missingTui = path.join(temp, "missing-tui");
  writeFixture(missingTui);
  fs.writeFileSync(path.join(missingTui, "tui-ui.xml"), '<hierarchy><node text="Attached"/><node text="editor"/></hierarchy>\n');
  expectStatus(missingTui, 1, "TUI without terminal content should fail", "tui-ui.xml must show rendered vim or htop terminal content");

  const mobileCreateControl = path.join(temp, "mobile-create-control");
  writeFixture(mobileCreateControl);
  fs.writeFileSync(path.join(mobileCreateControl, "session-ui.xml"), '<hierarchy><node text="Attached"/><node text="bash"/><node text="Create session"/></hierarchy>\n');
  expectStatus(mobileCreateControl, 1, "mobile create control should fail", "session-ui.xml must not expose mobile session creation");

  const missingSession = path.join(temp, "missing-session");
  writeFixture(missingSession);
  fs.writeFileSync(path.join(missingSession, "sessions.txt"), "shell bash\neditor htop\n");
  expectStatus(missingSession, 1, "missing Claude session should fail", "sessions.txt must include the desktop-created refactoringjob claude session");

  const badLog = path.join(temp, "bad-log");
  writeFixture(badLog);
  fs.writeFileSync(path.join(badLog, "session-logcat.log"), "FATAL EXCEPTION: main\napp.fieldwork.android crashed\n");
  expectStatus(badLog, 1, "fatal log should fail", "session-logcat.log must not contain Fieldwork fatal, ANR, or exception entries");
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

console.log("Android terminal attach evidence verifier ok");

function writeFixture(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "adb-devices.txt"),
    "List of devices attached\nR5CT1234567 device usb:336592896X product:oriole model:Pixel_6 device:oriole transport_id:9\n",
  );
  fs.writeFileSync(
    path.join(dir, "artifact-signing.txt"),
    "Android AAB ok: base/lib/arm64-v8a/libfieldwork_mobile_core.so; packaged manifest uses-permission allowlist and privacy surface ok; signed release bundle ok\n",
  );
  fs.writeFileSync(
    path.join(dir, "buildconfig.txt"),
    [
      'APPLICATION_ID = "app.fieldwork.android"',
      'BUILD_TYPE = "release"',
      "DEBUG = false",
      "FIELDWORK_BIOMETRIC_BYPASS = false",
      'FIELDWORK_DEBUG_PAIRING_PAYLOAD = ""',
    ].join("\n"),
  );
  fs.writeFileSync(path.join(dir, "sessions.txt"), "refactoringjob claude\nshell bash\neditor htop\n");
  writePng(path.join(dir, "session.png"), { width: 1080, height: 2400 });
  fs.writeFileSync(path.join(dir, "session-ui.xml"), '<hierarchy><node text="Attached"/><node text="shell"/><node text="bash"/></hierarchy>\n');
  fs.writeFileSync(path.join(dir, "session-logcat.log"), "I FieldworkRepository: listSessions returned 3 sessions\n");
  fs.writeFileSync(path.join(dir, "session-crash.log"), "\n");
  fs.writeFileSync(path.join(dir, "terminal-replay.txt"), "shell bash\nandroid_live_ok\n");
  writePng(path.join(dir, "claude.png"), { width: 1080, height: 2400 });
  fs.writeFileSync(path.join(dir, "claude-ui.xml"), '<hierarchy><node text="Attached"/><node text="refactoringjob"/><node text="claude"/></hierarchy>\n');
  fs.writeFileSync(path.join(dir, "claude-logcat.log"), "I FieldworkRepository: listSessions returned 3 sessions\n");
  fs.writeFileSync(path.join(dir, "claude-crash.log"), "\n");
  fs.writeFileSync(path.join(dir, "claude-replay.txt"), "refactoringjob claude\nclaude_live_ok\n");
  writePng(path.join(dir, "tui.png"), { width: 1080, height: 2400 });
  fs.writeFileSync(path.join(dir, "tui-ui.xml"), '<hierarchy><node text="Attached"/><node text="editor"/><node text="F1Help"/><node text="F2Setup"/><node text="F10Quit"/></hierarchy>\n');
  fs.writeFileSync(path.join(dir, "tui-logcat.log"), "I FieldworkRepository: listSessions returned 3 sessions\n");
  fs.writeFileSync(path.join(dir, "tui-crash.log"), "\n");
}

function writePng(file, { width, height }) {
  const bytes = Buffer.alloc(64);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  bytes[24] = 8;
  bytes[25] = 6;
  bytes.writeUInt32BE(0, 33);
  bytes.write("IEND", 37, "ascii");
  fs.writeFileSync(file, bytes);
}

function expectStatus(dir, expectedStatus, message, expectedOutput = null) {
  const result = spawnSync(process.execPath, [verifier, dir], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.status !== expectedStatus) {
    throw new Error(`${message}: exited ${result.status}, expected ${expectedStatus}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  if (expectedOutput && !`${result.stdout}\n${result.stderr}`.includes(expectedOutput)) {
    throw new Error(`${message}: missing output ${JSON.stringify(expectedOutput)}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
}
