#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const verifier = path.join(root, "scripts/verify-live-testing-evidence.mjs");

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "fieldwork-live-evidence-"));

try {
  const good = path.join(temp, "good");
  writeFixture(good);
  expectStatus(good, 0, "good evidence fixture should pass");

  const missing = path.join(temp, "missing");
  writeFixture(missing);
  fs.rmSync(path.join(missing, "session.png"));
  expectStatus(missing, 1, "missing session screenshot should fail", "missing evidence file: session.png");

  const missingTui = path.join(temp, "missing-tui");
  writeFixture(missingTui);
  fs.rmSync(path.join(missingTui, "tui.png"));
  expectStatus(missingTui, 1, "missing TUI screenshot should fail", "missing evidence file: tui.png");

  const badTui = path.join(temp, "bad-tui");
  writeFixture(badTui);
  fs.writeFileSync(path.join(badTui, "tui-ui.xml"), '<hierarchy><node text="Attached"/><node text="plain shell"/></hierarchy>\n');
  expectStatus(badTui, 1, "TUI without vim/htop content should fail", "tui-ui.xml must include visible vim/htop terminal content");

  const missingReplay = path.join(temp, "missing-replay");
  writeFixture(missingReplay);
  fs.rmSync(path.join(missingReplay, "terminal-replay.txt"));
  expectStatus(missingReplay, 1, "missing desktop replay transcript should fail", "missing evidence file: terminal-replay.txt");

  const badReplay = path.join(temp, "bad-replay");
  writeFixture(badReplay);
  fs.writeFileSync(path.join(badReplay, "terminal-replay.txt"), "shell prompt only\n");
  expectStatus(badReplay, 1, "desktop replay without Android marker should fail", "terminal-replay.txt must prove Android-originated input/output");

  const crash = path.join(temp, "crash");
  writeFixture(crash);
  fs.writeFileSync(path.join(crash, "session-crash.log"), "FATAL EXCEPTION: main\nProcess: app.fieldwork.android\n");
  expectStatus(crash, 1, "Fieldwork crash-buffer fixture should fail", "session-crash.log must not contain");

  const unlockedLeak = path.join(temp, "locked-leak");
  writeFixture(unlockedLeak);
  fs.writeFileSync(path.join(unlockedLeak, "locked-ui.xml"), '<node text="Unlock"/><node text="refactoringjob"/>');
  expectStatus(unlockedLeak, 1, "locked session-content leak fixture should fail", "locked-ui.xml must not expose");
} finally {
  fs.rmSync(temp, { force: true, recursive: true });
}

console.log("live testing evidence verifier ok");

function writeFixture(dir) {
  fs.mkdirSync(dir, { recursive: true });
  writePng(path.join(dir, "locked.png"));
  writePng(path.join(dir, "session.png"));
  writePng(path.join(dir, "tui.png"));
  fs.writeFileSync(
    path.join(dir, "launch.txt"),
    ["Status: ok", "LaunchState: COLD", "Activity: app.fieldwork.android/.MainActivity", "TotalTime: 934"].join("\n"),
  );
  fs.writeFileSync(path.join(dir, "locked-ui.xml"), '<hierarchy><node text="Unlock"/></hierarchy>\n');
  fs.writeFileSync(path.join(dir, "session-ui.xml"), '<hierarchy><node text="shell"/><node text="Attached"/><node text="android_live_ok"/></hierarchy>\n');
  fs.writeFileSync(path.join(dir, "tui-ui.xml"), '<hierarchy><node text="tui"/><node text="Attached"/><node text="F1Help F2Setup F10Quit"/></hierarchy>\n');
  fs.writeFileSync(path.join(dir, "locked-logcat.log"), "I Fieldwork: locked launch\n");
  fs.writeFileSync(path.join(dir, "locked-crash.log"), "");
  fs.writeFileSync(
    path.join(dir, "session-logcat.log"),
    [
      "I FieldworkRepository: pair completed",
      "I FieldworkRepository: listSessions returned 4 sessions",
      "I Fieldwork: terminal attached",
    ].join("\n"),
  );
  fs.writeFileSync(path.join(dir, "session-crash.log"), "");
  fs.writeFileSync(path.join(dir, "tui-logcat.log"), "I Fieldwork: terminal attached\n");
  fs.writeFileSync(path.join(dir, "tui-crash.log"), "");
  fs.writeFileSync(path.join(dir, "devices.txt"), "Pixel 8 Pro paired\n");
  fs.writeFileSync(path.join(dir, "terminal-replay.txt"), "shell bash\n$ echo android_live_ok\nandroid_live_ok\n");
  fs.writeFileSync(
    path.join(dir, "sessions.txt"),
    ["waffle claude", "refactoringjob claude", "shell bash", "editor vim"].join("\n"),
  );
}

function writePng(file) {
  const bytes = Buffer.alloc(1500);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
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
