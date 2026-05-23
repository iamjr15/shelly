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
  "resize.png",
  "resize-ui.xml",
  "resize-logcat.log",
  "resize-crash.log",
  "resize-replay.txt",
  "detach.png",
  "detach-ui.xml",
  "detach-logcat.log",
  "detach-crash.log",
  "detach-replay.txt",
];

if (rawArgs.length !== 1 || rawArgs[0] === "--help" || rawArgs[0] === "-h") {
  console.error("usage: node scripts/verify-android-resize-detach-evidence.mjs <evidence-dir>");
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
  verifyPng("resize.png");
  verifyPng("detach.png");
  verifyResizeEvidence(
    readText("resize-ui.xml"),
    readText("resize-logcat.log"),
    readText("resize-replay.txt"),
  );
  verifyDetachEvidence(
    readText("detach-ui.xml"),
    readText("detach-logcat.log"),
    readText("detach-replay.txt"),
  );
  verifyNoMobileSessionControls([
    ["resize-ui.xml", readText("resize-ui.xml")],
    ["detach-ui.xml", readText("detach-ui.xml")],
  ]);
  verifyLogs([
    ["resize-logcat.log", readText("resize-logcat.log")],
    ["resize-crash.log", readText("resize-crash.log")],
    ["detach-logcat.log", readText("detach-logcat.log")],
    ["detach-crash.log", readText("detach-crash.log")],
  ]);
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(`Android resize/detach evidence ok: ${evidenceDir}`);

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
    /^.*\b(?:refactoringjob|shell|bash)\b.*$/im,
    "sessions.txt must include the desktop-created session used for resize/detach",
  );
}

function verifyResizeEvidence(ui, logcat, replay) {
  rejectPatternText(ui, /\bNo sessions\b/i, "resize-ui.xml must not be the empty dashboard");
  requirePatternText(ui, /\bAttached\b/i, "resize-ui.xml must show an attached terminal");
  requirePatternText(ui, /\b(?:shell|bash|refactoringjob|claude)\b/i, "resize-ui.xml must identify the attached session");
  requirePatternText(
    logcat,
    /FieldworkRepository:\s+listSessions returned \d+ sessions/i,
    "resize-logcat.log must show repository session listing before resize",
  );
  requirePatternText(replay, /\bafter_resize_ok\b/, "resize-replay.txt must contain after_resize_ok from Android-originated input");
  requirePatternText(replay, /\b(?:shell|bash|refactoringjob|claude)\b/i, "resize-replay.txt must identify the resized PTY");
  const size = replay.match(/\bresize_size=(\d+)(?:x|\s+)(\d+)\b/);
  if (!size) {
    failures.push("resize-replay.txt must record resize_size=<rows>x<cols> or resize_size=<rows> <cols>");
    return;
  }
  const rows = Number(size[1]);
  const cols = Number(size[2]);
  if (rows < 5 || cols < 20) {
    failures.push(`resize-replay.txt records implausible resize_size=${rows}x${cols}, expected rows>=5 and cols>=20`);
  }
}

function verifyDetachEvidence(ui, logcat, replay) {
  rejectPatternText(ui, /\bNo sessions\b/i, "detach-ui.xml must not be the empty dashboard after detach");
  requirePatternText(ui, /\b(?:shell|bash|refactoringjob|claude)\b/i, "detach-ui.xml must show the detachable session on the dashboard");
  requirePatternText(
    logcat,
    /FieldworkRepository:\s+listSessions returned \d+ sessions/i,
    "detach-logcat.log must show repository session listing after detach",
  );
  requirePatternText(replay, /\bafter_detach_reattach_ok\b/, "detach-replay.txt must contain after_detach_reattach_ok after reattach");
  requirePatternText(replay, /\b(?:shell|bash|refactoringjob|claude)\b/i, "detach-replay.txt must identify the detached and reattached PTY");
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
