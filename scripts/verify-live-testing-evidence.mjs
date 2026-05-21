#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const rawArgs = process.argv.slice(2).filter((arg) => arg !== "--");
const failures = [];

if (rawArgs.length !== 1 || rawArgs[0] === "--help" || rawArgs[0] === "-h") {
  console.error("usage: node scripts/verify-live-testing-evidence.mjs <evidence-dir>");
  process.exit(rawArgs.length === 1 ? 0 : 2);
}

const evidenceDir = path.resolve(rawArgs[0]);

requireDirectory(evidenceDir);

const requiredFiles = [
  "launch.txt",
  "locked.png",
  "locked-ui.xml",
  "locked-logcat.log",
  "locked-crash.log",
  "session.png",
  "session-ui.xml",
  "session-logcat.log",
  "session-crash.log",
  "terminal-replay.txt",
  "tui.png",
  "tui-ui.xml",
  "tui-logcat.log",
  "tui-crash.log",
  "devices.txt",
  "sessions.txt",
  "background.png",
  "background-ui.xml",
  "background-logcat.log",
  "background-crash.log",
  "background-replay.txt",
  "reconnect.png",
  "reconnect-ui.xml",
  "reconnect-logcat.log",
  "reconnect-crash.log",
  "reconnect-replay.txt",
  "restart.png",
  "restart-ui.xml",
  "restart-logcat.log",
  "restart-crash.log",
  "restart-replay.txt",
  "multisession.png",
  "multisession-ui.xml",
  "multisession-logcat.log",
  "multisession-crash.log",
  "multisession-a-replay.txt",
  "multisession-b-replay.txt",
  "multisession-c-replay.txt",
];

for (const file of requiredFiles) {
  requireFile(file);
}

if (failures.length === 0) {
  verifyPng("locked.png");
  verifyPng("session.png");
  verifyPng("tui.png");
  verifyPng("background.png");
  verifyPng("reconnect.png");
  verifyPng("restart.png");
  verifyPng("multisession.png");
  verifyLaunch(readText("launch.txt"));
  verifyLockedSurface(readText("locked-ui.xml"));
  verifySessionEvidence(
    readText("session-ui.xml"),
    readText("session-logcat.log"),
    readText("sessions.txt"),
    readText("terminal-replay.txt"),
  );
  verifyTuiEvidence(readText("tui-ui.xml"));
  verifyBackgroundEvidence(readText("background-ui.xml"), readText("background-replay.txt"));
  verifyReconnectEvidence(readText("reconnect-ui.xml"), readText("reconnect-replay.txt"));
  verifyRestartEvidence(readText("restart-ui.xml"), readText("restart-replay.txt"));
  verifyMultisessionEvidence(
    readText("multisession-ui.xml"),
    readText("multisession-a-replay.txt"),
    readText("multisession-b-replay.txt"),
    readText("multisession-c-replay.txt"),
  );
  verifyDevices(readText("devices.txt"));
  verifyLogs([
    ["locked-logcat.log", readText("locked-logcat.log")],
    ["locked-crash.log", readText("locked-crash.log")],
    ["session-logcat.log", readText("session-logcat.log")],
    ["session-crash.log", readText("session-crash.log")],
    ["tui-logcat.log", readText("tui-logcat.log")],
    ["tui-crash.log", readText("tui-crash.log")],
    ["background-logcat.log", readText("background-logcat.log")],
    ["background-crash.log", readText("background-crash.log")],
    ["reconnect-logcat.log", readText("reconnect-logcat.log")],
    ["reconnect-crash.log", readText("reconnect-crash.log")],
    ["restart-logcat.log", readText("restart-logcat.log")],
    ["restart-crash.log", readText("restart-crash.log")],
    ["multisession-logcat.log", readText("multisession-logcat.log")],
    ["multisession-crash.log", readText("multisession-crash.log")],
  ]);
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(`live testing evidence ok: ${evidenceDir}`);

function verifyLaunch(text) {
  requirePatternText(text, /\bStatus:\s*ok\b/, "launch.txt must contain Android am start Status: ok");
  requirePatternText(text, /\bActivity:\s*app\.fieldwork\.android\/\.MainActivity\b/, "launch.txt must launch app.fieldwork.android/.MainActivity");
  requirePatternText(text, /\bTotalTime:\s*\d+\b/, "launch.txt must record TotalTime");
}

function verifyLockedSurface(text) {
  requirePatternText(text, /(?:>Unlock<|text="Unlock")/, "locked-ui.xml must show only the biometric unlock surface");
  rejectPatternText(
    text,
    /\b(No sessions|Pairing|Terminal|refactoringjob|bash|claude|ANDROID_)/i,
    "locked-ui.xml must not expose session, pairing, terminal, command, or test-marker content before unlock",
  );
}

function verifySessionEvidence(sessionUi, sessionLogcat, sessionsText, terminalReplay) {
  rejectPatternText(sessionUi, /\bNo sessions\b/i, "session-ui.xml must not be the empty dashboard after pairing");
  requirePatternText(sessionUi, /\bAttached\b/i, "session-ui.xml must show the normal terminal attached state");
  requirePatternText(sessionLogcat, /FieldworkRepository:\s+pair completed/, "session-logcat.log must show repository pair completion");
  requirePatternText(sessionLogcat, /FieldworkRepository:\s+listSessions returned \d+ sessions/, "session-logcat.log must show session listing after pair");
  requirePatternText(sessionsText, /\brefactoringjob\b/, "sessions.txt must include the named shortcut session refactoringjob");
  requirePatternText(sessionsText, /\bclaude\b/i, "sessions.txt must include a Claude/default session command");
  requirePatternText(sessionsText, /\b(shell|bash)\b/i, "sessions.txt must include a desktop-created shell/bash session");
  requirePatternText(sessionsText, /\b(editor|vim|htop)\b/i, "sessions.txt must include a desktop-created TUI session");
  requirePatternText(
    terminalReplay,
    /\bandroid_live_ok\b/,
    "terminal-replay.txt must prove Android-originated input/output was visible from a desktop reattach",
  );
  requirePatternText(
    terminalReplay,
    /\b(shell|bash)\b/i,
    "terminal-replay.txt must identify the desktop-created shell/bash session",
  );
}

function verifyTuiEvidence(text) {
  rejectPatternText(text, /\bNo sessions\b/i, "tui-ui.xml must show an attached TUI, not the dashboard");
  requirePatternText(text, /\bAttached\b/i, "tui-ui.xml must show the terminal attached state");
  requirePatternText(
    text,
    /(F1\s*Help|F1Help|F2\s*Setup|F2Setup|F10\s*Quit|F10Quit|VIM|--\s*INSERT\s*--|\/etc\/hosts|~\s*$)/im,
    "tui-ui.xml must include visible vim/htop terminal content",
  );
}

function verifyBackgroundEvidence(ui, replay) {
  requirePatternText(ui, /\bAttached\b/i, "background-ui.xml must show the app returned to an attached terminal after foreground");
  requirePatternText(
    replay,
    /\bANDROID_BACKGROUND_REPLAY_OUTPUT\b/,
    "background-replay.txt must include output emitted while Android was backgrounded",
  );
  requirePatternText(
    replay,
    /\bafter_background_ok\b/,
    "background-replay.txt must include Android-originated input after foreground resume",
  );
}

function verifyReconnectEvidence(ui, replay) {
  requirePatternText(ui, /\bAttached\b/i, "reconnect-ui.xml must show the app returned to an attached terminal after network reconnect");
  requirePatternText(
    replay,
    /\b(?:NETWORK_REPLAY_OUTPUT|ANDROID_RECONNECT_REPLAY_OUTPUT)\b/,
    "reconnect-replay.txt must include output emitted during the network gap",
  );
  requirePatternText(
    replay,
    /\bafter_reconnect_ok\b/,
    "reconnect-replay.txt must include Android-originated input after network restore",
  );
  const timing = replay.match(/\breconnect_ms=(\d+)\b/);
  if (!timing) {
    failures.push("reconnect-replay.txt must record reconnect_ms=<elapsed-ms>");
  } else if (Number(timing[1]) > 2_000) {
    failures.push(`reconnect-replay.txt records reconnect_ms=${timing[1]}, expected <=2000`);
  }
}

function verifyRestartEvidence(ui, replay) {
  requirePatternText(ui, /\b(?:fw_restart_session|Attached)\b/i, "restart-ui.xml must show the restored session after daemon restart");
  requirePatternText(
    replay,
    /\bANDROID_RESTART_SCROLLBACK\b/,
    "restart-replay.txt must include restored daemon scrollback from before restart",
  );
  requirePatternText(
    replay,
    /\bfw_restart_session\b/,
    "restart-replay.txt must identify the restored desktop-created session",
  );
}

function verifyMultisessionEvidence(ui, replayA, replayB, replayC) {
  requirePatternText(ui, /\bfwm_a\b/i, "multisession-ui.xml must include fwm_a in the switched session set");
  requirePatternText(ui, /\bfwm_b\b/i, "multisession-ui.xml must include fwm_b in the switched session set");
  requirePatternText(ui, /\bfwm_c\b/i, "multisession-ui.xml must include fwm_c in the switched session set");
  verifyMultisessionReplay("multisession-a-replay.txt", replayA, "fwm_a", "multi_a_ok", ["multi_b_ok", "multi_c_ok"]);
  verifyMultisessionReplay("multisession-b-replay.txt", replayB, "fwm_b", "multi_b_ok", ["multi_a_ok", "multi_c_ok"]);
  verifyMultisessionReplay("multisession-c-replay.txt", replayC, "fwm_c", "multi_c_ok", ["multi_a_ok", "multi_b_ok"]);
}

function verifyMultisessionReplay(file, text, sessionName, requiredMarker, forbiddenMarkers) {
  requirePatternText(text, new RegExp(`\\b${escapeRegExp(sessionName)}\\b`, "i"), `${file} must identify ${sessionName}`);
  requirePatternText(text, new RegExp(`\\b${escapeRegExp(requiredMarker)}\\b`), `${file} must contain ${requiredMarker}`);
  for (const marker of forbiddenMarkers) {
    rejectPatternText(text, new RegExp(`\\b${escapeRegExp(marker)}\\b`), `${file} must not contain ${marker} from another session`);
  }
}

function verifyDevices(text) {
  requirePatternText(text, /\S/, "devices.txt must not be empty");
  rejectPatternText(text, /\bUnauthorized\b/i, "devices.txt must not show the tested device as unauthorized");
}

function verifyLogs(entries) {
  const fatalPattern = /\bFATAL EXCEPTION\b|\bANR in app\.fieldwork\.android\b|Fieldwork.*\b(FATAL|ANR|Exception)\b/i;
  const crashPattern = /\bapp\.fieldwork\.android\b|\bFATAL EXCEPTION\b|\bANR\b/i;
  for (const [name, text] of entries) {
    rejectPatternText(text, fatalPattern, `${name} must not contain Fieldwork fatal, ANR, or exception entries`);
    if (name.endsWith("-crash.log")) {
      rejectPatternText(text, crashPattern, `${name} must not contain app.fieldwork.android crash-buffer entries`);
    }
  }
}

function verifyPng(file) {
  const absolute = path.join(evidenceDir, file);
  const bytes = fs.readFileSync(absolute);
  const pngMagic = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const hasMagic = pngMagic.every((byte, index) => bytes[index] === byte);
  if (!hasMagic) {
    failures.push(`${file} must be a PNG screenshot`);
  }
  if (bytes.length < 1024) {
    failures.push(`${file} is too small to be useful evidence (${bytes.length} bytes)`);
  }
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

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
