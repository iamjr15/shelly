#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const verifier = path.join(root, "scripts/verify-macos-daemon-survival-evidence.mjs");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "fieldwork-macos-survival-"));

try {
  const good = path.join(temp, "good");
  writeFixture(good);
  expectStatus(good, 0, "good macOS daemon survival evidence should pass");

  const missingSigning = path.join(temp, "missing-signing");
  writeFixture(missingSigning);
  fs.writeFileSync(path.join(missingSigning, "macos-signing.txt"), "unsigned local build\n");
  expectStatus(missingSigning, 1, "missing signing verifier output should fail", "macos-signing.txt must include");

  const badService = path.join(temp, "bad-service");
  writeFixture(badService);
  fs.writeFileSync(path.join(badService, "service-install.txt"), "fieldwork daemon install\nsocket: reachable\n");
  expectStatus(badService, 1, "service evidence without launchd should fail", "service-install.txt must identify the macOS launchd service path");

  const shortSleep = path.join(temp, "short-sleep");
  writeFixture(shortSleep);
  fs.writeFileSync(
    path.join(shortSleep, "sleep-wake.txt"),
    "sleep_started_at=2026-05-22T10:00:00Z\nwake_finished_at=2026-05-22T10:00:10Z\nsleep_duration_ms=29999\nafter_sleep_wake_ok\n",
  );
  expectStatus(shortSleep, 1, "short sleep should fail", "sleep-wake.txt records sleep_duration_ms=29999");

  const badSleepReplay = path.join(temp, "bad-sleep-replay");
  writeFixture(badSleepReplay);
  fs.writeFileSync(path.join(badSleepReplay, "sleep-replay.txt"), "after_sleep_wake_ok\n");
  expectStatus(badSleepReplay, 1, "sleep replay without prior scrollback should fail", "sleep-replay.txt must include scrollback emitted before sleep");

  const missingKill = path.join(temp, "missing-kill");
  writeFixture(missingKill);
  fs.writeFileSync(path.join(missingKill, "kill-restart.txt"), "restart_ms=500\nsocket: reachable\nafter_kill_restart_ok\n");
  expectStatus(missingKill, 1, "kill evidence without pkill should fail", "kill-restart.txt must show pkill -KILL fieldworkd was run");

  const slowRestart = path.join(temp, "slow-restart");
  writeFixture(slowRestart);
  fs.writeFileSync(
    path.join(slowRestart, "kill-restart.txt"),
    "pkill -KILL fieldworkd\nrestart_ms=10001\nsocket: reachable\nafter_kill_restart_ok\n",
  );
  expectStatus(slowRestart, 1, "slow launchd restart should fail", "kill-restart.txt records restart_ms=10001");

  const badKillReplay = path.join(temp, "bad-kill-replay");
  writeFixture(badKillReplay);
  fs.writeFileSync(path.join(badKillReplay, "kill-replay.txt"), "after_kill_restart_ok\n");
  expectStatus(badKillReplay, 1, "kill replay without prior scrollback should fail", "kill-replay.txt must include scrollback emitted before kill");

  const badLog = path.join(temp, "bad-log");
  writeFixture(badLog);
  fs.writeFileSync(path.join(badLog, "daemon-log.txt"), "thread panicked at daemon\n");
  expectStatus(badLog, 1, "daemon panic log should fail", "daemon-log.txt must not contain");
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

console.log("macOS daemon survival evidence verifier ok");

function writeFixture(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "macos-signing.txt"), "macOS signing ok: /tmp/fieldworkd\n");
  fs.writeFileSync(path.join(dir, "service-install.txt"), "fieldwork daemon install\nLaunchAgent: ~/Library/LaunchAgents/app.fieldwork.daemon.plist\nsocket: reachable\n");
  fs.writeFileSync(path.join(dir, "daemon-status-before.txt"), "service: installed\nsocket: reachable\n");
  fs.writeFileSync(
    path.join(dir, "sleep-wake.txt"),
    "sleep_started_at=2026-05-22T10:00:00Z\nwake_finished_at=2026-05-22T10:00:31Z\nsleep_duration_ms=31000\nafter_sleep_wake_ok\n",
  );
  fs.writeFileSync(path.join(dir, "sleep-replay.txt"), "MACOS_SLEEP_SCROLLBACK_BEFORE\nafter_sleep_wake_ok\n");
  fs.writeFileSync(
    path.join(dir, "kill-restart.txt"),
    "pkill -KILL fieldworkd\nrestart_ms=850\nsocket: reachable\nafter_kill_restart_ok\n",
  );
  fs.writeFileSync(path.join(dir, "kill-replay.txt"), "MACOS_KILL_SCROLLBACK_BEFORE\nafter_kill_restart_ok\n");
  fs.writeFileSync(path.join(dir, "daemon-status-after.txt"), "service: installed\nsocket: reachable\n");
  fs.writeFileSync(path.join(dir, "daemon-log.txt"), "I fieldworkd service survived restart and wake\n");
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
