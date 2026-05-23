#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const rawArgs = process.argv.slice(2).filter((arg) => arg !== "--");
const failures = [];
const requiredFiles = [
  "adb-devices.txt",
  "artifact-signing.txt",
  "buildconfig.txt",
  "sessions.txt",
  "session.png",
  "session-ui.xml",
  "session-logcat.log",
  "session-crash.log",
  "terminal-replay.txt",
  "claude.png",
  "claude-ui.xml",
  "claude-logcat.log",
  "claude-crash.log",
  "claude-replay.txt",
  "tui.png",
  "tui-ui.xml",
  "tui-logcat.log",
  "tui-crash.log",
];

if (rawArgs.length !== 1 || rawArgs[0] === "--help" || rawArgs[0] === "-h") {
  console.error("usage: node scripts/verify-android-terminal-attach-evidence.mjs <evidence-dir>");
  process.exit(rawArgs.length === 1 ? 0 : 2);
}

const evidenceDir = path.resolve(rawArgs[0]);
requireDirectory(evidenceDir);
for (const file of requiredFiles) {
  requireFile(file);
}

if (failures.length === 0) {
  verifyAdbDevices(readText("adb-devices.txt"));
  verifyArtifactSigning(readText("artifact-signing.txt"));
  verifyBuildConfig(readText("buildconfig.txt"));
  verifySessions(readText("sessions.txt"));
  for (const file of ["session.png", "claude.png", "tui.png"]) {
    verifyPng(file);
  }
  verifyShellAttach(
    readText("session-ui.xml"),
    readText("session-logcat.log"),
    readText("terminal-replay.txt"),
  );
  verifyClaudeAttach(
    readText("claude-ui.xml"),
    readText("claude-logcat.log"),
    readText("claude-replay.txt"),
  );
  verifyTuiAttach(readText("tui-ui.xml"), readText("tui-logcat.log"));
  verifyNoMobileSessionControls([
    ["session-ui.xml", readText("session-ui.xml")],
    ["claude-ui.xml", readText("claude-ui.xml")],
    ["tui-ui.xml", readText("tui-ui.xml")],
  ]);
  verifyLogs([
    ["session-logcat.log", readText("session-logcat.log")],
    ["session-crash.log", readText("session-crash.log")],
    ["claude-logcat.log", readText("claude-logcat.log")],
    ["claude-crash.log", readText("claude-crash.log")],
    ["tui-logcat.log", readText("tui-logcat.log")],
    ["tui-crash.log", readText("tui-crash.log")],
  ]);
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(`Android terminal attach evidence ok: ${evidenceDir}`);

function verifyAdbDevices(text) {
  requirePatternText(text, /^List of devices attached\b/im, "adb-devices.txt must include adb devices output");
  const authorizedDevices = text
    .split(/\r?\n/)
    .filter((line) => /^[^\s#][^\n]*\s+device(?:\s|$)/i.test(line));
  if (authorizedDevices.length === 0) {
    failures.push("adb-devices.txt must show exactly one authorized physical Android device");
  } else if (authorizedDevices.length > 1) {
    failures.push(
      `adb-devices.txt must show exactly one authorized physical Android device, found ${authorizedDevices.length}`,
    );
  }
  rejectPatternText(
    text,
    /^(?:emulator-\d+|[^\n]*(?:\bsdk_gphone\b|\bsdk_gphone64\b|\bgeneric_x86\b|\bgeneric_x86_64\b|\bgoldfish\b|\branchu\b|\bqemu\b|\bavd\b|\bdevice:emu[^\s]*\b))[^\n]*\s+device(?:\s|$)/im,
    "adb-devices.txt must show a physical Android phone, not an emulator or AVD",
  );
  rejectPatternText(
    text,
    /\b(?:unauthorized|offline|no permissions)\b/i,
    "adb-devices.txt must not show the tested device as unauthorized, offline, or inaccessible",
  );
}

function verifyArtifactSigning(text) {
  requirePatternText(text, /\bAndroid AAB ok:/, "artifact-signing.txt must include scripts/verify-android-aab.mjs success output");
  requirePatternText(text, /\bsigned release bundle ok\b/, "artifact-signing.txt must prove the release App Bundle was signed");
}

function verifyBuildConfig(text) {
  requirePatternText(
    text,
    /\bAPPLICATION_ID\s*=\s*"app\.fieldwork\.android"/,
    "buildconfig.txt must prove the tested release build targets app.fieldwork.android",
  );
  requirePatternText(text, /\bBUILD_TYPE\s*=\s*"release"/, "buildconfig.txt must prove the tested build is the release variant");
  requirePatternText(
    text,
    /\bDEBUG\s*=\s*(?:false|Boolean\.parseBoolean\("false"\))/,
    "buildconfig.txt must prove BuildConfig.DEBUG is disabled",
  );
  requirePatternText(
    text,
    /\bFIELDWORK_BIOMETRIC_BYPASS\s*=\s*false\b/,
    "buildconfig.txt must prove biometric bypass is disabled",
  );
  requirePatternText(
    text,
    /\bFIELDWORK_DEBUG_PAIRING_PAYLOAD\s*=\s*""/,
    "buildconfig.txt must prove no debug pairing payload is compiled into the release build",
  );
}

function verifySessions(text) {
  requirePatternText(
    text,
    /^.*\brefactoringjob\b.*\bclaude\b.*$/im,
    "sessions.txt must include the desktop-created refactoringjob claude session",
  );
  requirePatternText(
    text,
    /^.*\b(?:shell|bash)\b.*$/im,
    "sessions.txt must include a desktop-created shell/bash session",
  );
  requirePatternText(
    text,
    /^.*\b(?:editor|vim|htop)\b.*$/im,
    "sessions.txt must include a desktop-created editor/vim/htop session",
  );
}

function verifyShellAttach(ui, logcat, replay) {
  rejectPatternText(ui, /\bNo sessions\b/i, "session-ui.xml must not be the empty dashboard");
  requirePatternText(ui, /\bAttached\b/i, "session-ui.xml must show an attached terminal");
  requirePatternText(ui, /\b(?:shell|bash)\b/i, "session-ui.xml must identify the shell/bash session");
  requirePatternText(
    logcat,
    /FieldworkRepository:\s+listSessions returned \d+ sessions/i,
    "session-logcat.log must show repository session listing before shell attach",
  );
  requirePatternText(replay, /\bandroid_live_ok\b/, "terminal-replay.txt must contain android_live_ok from Android-originated input");
  requirePatternText(replay, /\b(?:shell|bash)\b/i, "terminal-replay.txt must identify the shell/bash PTY replay");
  rejectPatternText(replay, /\bclaude_live_ok\b/, "terminal-replay.txt must not be reused from the Claude attach proof");
}

function verifyClaudeAttach(ui, logcat, replay) {
  rejectPatternText(ui, /\bNo sessions\b/i, "claude-ui.xml must not be the empty dashboard");
  requirePatternText(ui, /\bAttached\b/i, "claude-ui.xml must show an attached terminal");
  requirePatternText(ui, /\b(?:claude|refactoringjob|Claude Code)\b/i, "claude-ui.xml must identify the Claude session");
  requirePatternText(
    logcat,
    /FieldworkRepository:\s+listSessions returned \d+ sessions/i,
    "claude-logcat.log must show repository session listing before Claude attach",
  );
  requirePatternText(replay, /\bclaude_live_ok\b/, "claude-replay.txt must contain claude_live_ok from Android-originated input");
  requirePatternText(replay, /\b(?:claude|refactoringjob)\b/i, "claude-replay.txt must identify the Claude session");
  rejectPatternText(replay, /\bandroid_live_ok\b/, "claude-replay.txt must not be reused from the shell attach proof");
}

function verifyTuiAttach(ui, logcat) {
  rejectPatternText(ui, /\bNo sessions\b/i, "tui-ui.xml must not be the empty dashboard");
  requirePatternText(ui, /\bAttached\b/i, "tui-ui.xml must show an attached terminal");
  requirePatternText(
    ui,
    /\b(?:F1Help|F2Setup|F10Quit|htop|VIM|-- INSERT --|\/etc\/hosts)\b/i,
    "tui-ui.xml must show rendered vim or htop terminal content",
  );
  requirePatternText(
    logcat,
    /FieldworkRepository:\s+listSessions returned \d+ sessions/i,
    "tui-logcat.log must show repository session listing before TUI attach",
  );
}

function verifyNoMobileSessionControls(entries) {
  for (const [name, text] of entries) {
    rejectPatternText(
      text,
      /\b(?:Create session|New session|Kill session|Delete session|Choose command|Run command)\b/i,
      `${name} must not expose mobile session creation, kill, or command-selection controls`,
    );
  }
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
    return;
  }
  if (bytes.length < 64) {
    failures.push(`${file} is too small to be useful evidence (${bytes.length} bytes)`);
    return;
  }
  const ihdrLength = bytes.readUInt32BE(8);
  const ihdrType = bytes.toString("ascii", 12, 16);
  if (ihdrLength !== 13 || ihdrType !== "IHDR") {
    failures.push(`${file} must contain a valid PNG IHDR header`);
    return;
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  const shortSide = Math.min(width, height);
  const longSide = Math.max(width, height);
  if (shortSide < 360 || longSide < 640) {
    failures.push(`${file} is too small for Android phone evidence (${width}x${height})`);
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
