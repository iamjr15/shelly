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
  "devices.txt",
  "sessions.txt",
];

for (const file of requiredFiles) {
  requireFile(file);
}

if (failures.length === 0) {
  verifyPng("locked.png");
  verifyPng("session.png");
  verifyLaunch(readText("launch.txt"));
  verifyLockedSurface(readText("locked-ui.xml"));
  verifySessionEvidence(readText("session-ui.xml"), readText("session-logcat.log"), readText("sessions.txt"));
  verifyDevices(readText("devices.txt"));
  verifyLogs([
    ["locked-logcat.log", readText("locked-logcat.log")],
    ["locked-crash.log", readText("locked-crash.log")],
    ["session-logcat.log", readText("session-logcat.log")],
    ["session-crash.log", readText("session-crash.log")],
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

function verifySessionEvidence(sessionUi, sessionLogcat, sessionsText) {
  rejectPatternText(sessionUi, /\bNo sessions\b/i, "session-ui.xml must not be the empty dashboard after pairing");
  requirePatternText(sessionLogcat, /FieldworkRepository:\s+pair completed/, "session-logcat.log must show repository pair completion");
  requirePatternText(sessionLogcat, /FieldworkRepository:\s+listSessions returned \d+ sessions/, "session-logcat.log must show session listing after pair");
  requirePatternText(sessionsText, /\brefactoringjob\b/, "sessions.txt must include the named shortcut session refactoringjob");
  requirePatternText(sessionsText, /\bclaude\b/i, "sessions.txt must include a Claude/default session command");
  requirePatternText(sessionsText, /\b(shell|bash)\b/i, "sessions.txt must include a desktop-created shell/bash session");
  requirePatternText(sessionsText, /\b(editor|vim|htop)\b/i, "sessions.txt must include a desktop-created TUI session");
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
