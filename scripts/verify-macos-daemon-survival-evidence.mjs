#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const rawArgs = process.argv.slice(2).filter((arg) => arg !== "--");
const failures = [];

if (rawArgs.length !== 1 || rawArgs[0] === "--help" || rawArgs[0] === "-h") {
  console.error("usage: node scripts/verify-macos-daemon-survival-evidence.mjs <evidence-dir>");
  process.exit(rawArgs.length === 1 ? 0 : 2);
}

const evidenceDir = path.resolve(rawArgs[0]);
const requiredFiles = [
  "macos-signing.txt",
  "service-install.txt",
  "daemon-status-before.txt",
  "sleep-wake.txt",
  "sleep-replay.txt",
  "kill-restart.txt",
  "kill-live-replay.txt",
  "kill-replay.txt",
  "daemon-status-after.txt",
  "daemon-log.txt",
];

requireDirectory(evidenceDir);
for (const file of requiredFiles) {
  requireFile(file);
}

if (failures.length === 0) {
  verifySigning(readText("macos-signing.txt"));
  verifyServiceInstall(readText("service-install.txt"));
  verifyDaemonStatus("daemon-status-before.txt", readText("daemon-status-before.txt"));
  verifySleepWake(readText("sleep-wake.txt"), readText("sleep-replay.txt"));
  verifyKillRestart(readText("kill-restart.txt"), readText("kill-live-replay.txt"), readText("kill-replay.txt"));
  verifyDaemonStatus("daemon-status-after.txt", readText("daemon-status-after.txt"));
  verifyDaemonLog(readText("daemon-log.txt"));
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(`macOS daemon survival evidence ok: ${evidenceDir}`);

function verifySigning(text) {
  requirePatternText(
    text,
    /\bmacOS npm trust ok:/,
    "macos-signing.txt must include node scripts/verify-macos-signing.mjs npm trust success output",
  );
}

function verifyServiceInstall(text) {
  requirePatternText(text, /\bfieldwork daemon install\b/, "service-install.txt must show fieldwork daemon install was run");
  requirePatternText(text, /\b(?:launchd|LaunchAgent)\b/i, "service-install.txt must identify the macOS launchd service path");
  requirePatternText(text, /\bsocket:\s*reachable\b/i, "service-install.txt must show the service became reachable");
}

function verifyDaemonStatus(file, text) {
  requirePatternText(text, /\bservice:\s*(?:installed|running)\b/i, `${file} must show the daemon service is installed or running`);
  requirePatternText(text, /\bsocket:\s*reachable\b/i, `${file} must show the daemon socket is reachable`);
}

function verifySleepWake(text, replay) {
  requirePatternText(text, /\bsleep_started_at=/, "sleep-wake.txt must record sleep_started_at=<timestamp>");
  requirePatternText(text, /\bwake_finished_at=/, "sleep-wake.txt must record wake_finished_at=<timestamp>");
  const timing = text.match(/\bsleep_duration_ms=(\d+)\b/);
  if (!timing) {
    failures.push("sleep-wake.txt must record sleep_duration_ms=<elapsed-ms>");
  } else if (Number(timing[1]) < 30_000) {
    failures.push(`sleep-wake.txt records sleep_duration_ms=${timing[1]}, expected >=30000`);
  }
  requirePatternText(text, /\bafter_sleep_wake_ok\b/, "sleep-wake.txt must record after_sleep_wake_ok after wake");
  requirePatternText(replay, /\bMACOS_SLEEP_SCROLLBACK_BEFORE\b/, "sleep-replay.txt must include scrollback emitted before sleep");
  requirePatternText(replay, /\bafter_sleep_wake_ok\b/, "sleep-replay.txt must include post-wake terminal input/output");
}

function verifyKillRestart(text, liveReplay, replay) {
  requirePatternText(text, /\bpkill\s+-KILL\s+fieldworkd\b/, "kill-restart.txt must show pkill -KILL fieldworkd was run");
  requirePatternText(
    text,
    /\bprocesses_died_documented\b/,
    "kill-restart.txt must document that PTY child processes are expected to die across daemon kill/restart",
  );
  const timing = text.match(/\brestart_ms=(\d+)\b/);
  if (!timing) {
    failures.push("kill-restart.txt must record restart_ms=<elapsed-ms>");
  } else if (Number(timing[1]) > 10_000) {
    failures.push(`kill-restart.txt records restart_ms=${timing[1]}, expected <=10000`);
  }
  requirePatternText(text, /\bsocket:\s*reachable\b/i, "kill-restart.txt must show the daemon socket became reachable after kill");
  requirePatternText(liveReplay, /\bMACOS_KILL_SCROLLBACK_BEFORE\b/, "kill-live-replay.txt must include scrollback emitted before kill");
  requirePatternText(replay, /\bMACOS_KILL_SCROLLBACK_BEFORE\b/, "kill-replay.txt must include scrollback emitted before kill");
  requirePatternText(replay, /\bfieldwork:\s*session exited\b/i, "kill-replay.txt must show the restored session is exited after daemon kill/restart");
}

function verifyDaemonLog(text) {
  rejectPatternText(
    text,
    /\b(?:panic|panicked|FATAL|segmentation fault|crash|uncaught exception)\b/i,
    "daemon-log.txt must not contain panic, fatal, crash, or uncaught exception markers",
  );
}

function requireDirectory(dir) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    failures.push(`evidence directory is missing: ${dir}`);
  }
}

function requireFile(file) {
  const absolute = path.join(evidenceDir, file);
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
    failures.push(`missing evidence file: ${file}`);
  }
}

function readText(file) {
  return fs.readFileSync(path.join(evidenceDir, file), "utf8");
}

function requirePatternText(text, pattern, message) {
  if (!pattern.test(text)) {
    failures.push(message);
  }
}

function rejectPatternText(text, pattern, message) {
  if (pattern.test(text)) {
    failures.push(message);
  }
}
