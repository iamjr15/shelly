#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  verifyCleanAndroidLogs,
  verifyInstalledAndroidPackageInfo,
  verifyNoAndroidSystemErrorOverlays,
  verifyPhysicalAndroidAdbDevices,
} from "./android-evidence-common.mjs";

const rawArgs = process.argv.slice(2).filter((arg) => arg !== "--");
const failures = [];
const requiredFiles = [
  "adb-devices.txt",
  "artifact-signing.txt",
  "package-info.txt",
  "buildconfig.txt",
  "sessions.txt",
  "devices.txt",
  "launch.txt",
  "locked.png",
  "locked-ui.xml",
  "locked-logcat.log",
  "locked-crash.log",
  "biometric.png",
  "biometric-ui.xml",
  "biometric-logcat.log",
  "biometric-crash.log",
  "stale-biometric.png",
  "stale-biometric-ui.xml",
  "stale-biometric-logcat.log",
  "stale-biometric-crash.log",
  "stale-biometric.txt",
];

if (rawArgs.length !== 1 || rawArgs[0] === "--help" || rawArgs[0] === "-h") {
  console.error("usage: node scripts/verify-android-biometric-evidence.mjs <evidence-dir>");
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
  verifyPackageInfo(readText("package-info.txt"));
  verifyBuildConfig(readText("buildconfig.txt"));
  verifySessions(readText("sessions.txt"), readText("devices.txt"));
  verifyLaunch(readText("launch.txt"));
  verifyPng("locked.png");
  verifyPng("biometric.png");
  verifyPng("stale-biometric.png");
  verifyLockedSurface(readText("locked-ui.xml"));
  verifyPreUnlockLog(readText("locked-logcat.log"), "locked-logcat.log");
  verifyBiometricPrompt(readText("biometric-ui.xml"), readText("biometric-logcat.log"));
  verifyStaleBiometricPrompt(
    readText("stale-biometric-ui.xml"),
    readText("stale-biometric-logcat.log"),
    readText("stale-biometric.txt"),
  );
  verifyNoAndroidSystemErrorOverlays([
    ["locked-ui.xml", readText("locked-ui.xml")],
    ["biometric-ui.xml", readText("biometric-ui.xml")],
    ["stale-biometric-ui.xml", readText("stale-biometric-ui.xml")],
  ], failures);
  verifyLogs([
    ["locked-logcat.log", readText("locked-logcat.log")],
    ["locked-crash.log", readText("locked-crash.log")],
    ["biometric-logcat.log", readText("biometric-logcat.log")],
    ["biometric-crash.log", readText("biometric-crash.log")],
    ["stale-biometric-logcat.log", readText("stale-biometric-logcat.log")],
    ["stale-biometric-crash.log", readText("stale-biometric-crash.log")],
  ]);
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(`Android biometric evidence ok: ${evidenceDir}`);

function verifyAdbDevices(text) {
  verifyPhysicalAndroidAdbDevices(text, failures);
}

function verifyArtifactSigning(text) {
  requirePatternText(text, /\bAndroid AAB ok:/, "artifact-signing.txt must include scripts/verify-android-aab.mjs success output");
  requirePatternText(text, /\bsigned release bundle ok\b/, "artifact-signing.txt must prove the release App Bundle was signed");
}

function verifyPackageInfo(text) {
  verifyInstalledAndroidPackageInfo(text, failures, { forbidDebuggable: true });
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
    /\bFIELDWORK_DEBUG_PAIRING_CODE\s*=\s*""/,
    "buildconfig.txt must prove no debug pairing code is compiled into the release build",
  );
}

function verifySessions(sessions, devices) {
  requirePatternText(
    sessions,
    /^.*\brefactoringjob\b.*\bclaude\b.*$/im,
    "sessions.txt must include the named shortcut refactoringjob claude session",
  );
  requirePatternText(sessions, /^.*\b(?:shell|bash)\b.*$/im, "sessions.txt must include a desktop-created shell/bash session");
  requirePatternText(devices, /\b(?:Android|Pixel|phone|paired|device)\b/i, "devices.txt must show the paired Android device");
  rejectPatternText(devices, /\bNo devices\b/i, "devices.txt must not be empty after pairing");
}

function verifyLaunch(text) {
  requirePatternText(text, /\bStatus:\s*ok\b/, "launch.txt must contain Android am start Status: ok");
  requirePatternText(text, /\bActivity:\s*app\.fieldwork\.android\/\.MainActivity\b/, "launch.txt must launch app.fieldwork.android/.MainActivity");
}

function verifyLockedSurface(text) {
  requirePatternText(text, /(?:>Unlock<|text="Unlock")/, "locked-ui.xml must show only the biometric unlock surface");
  rejectPatternText(
    text,
    /\b(No sessions|Pairing|Terminal|refactoringjob|bash|claude|ANDROID_)\b/i,
    "locked-ui.xml must not expose session, pairing, terminal, command, or test-marker content before unlock",
  );
}

function verifyBiometricPrompt(ui, logcat, options = {}) {
  const uiFile = options.uiFile ?? "biometric-ui.xml";
  const logFile = options.logFile ?? "biometric-logcat.log";
  const stage = options.stage ?? "before session access";
  requirePatternText(
    ui,
    /\b(?:Biometric|Fingerprint|fingerprint|Face|face|Confirm|Authenticate|Unlock Fieldwork|Use fingerprint|Touch the fingerprint sensor)\b/i,
    `${uiFile} must show the Android biometric prompt ${stage}`,
  );
  rejectPatternText(
    ui,
    /\b(No sessions|Terminal|refactoringjob|bash|claude|ANDROID_)\b/i,
    `${uiFile} must not expose session or terminal content behind the prompt`,
  );
  verifyPreUnlockLog(logcat, logFile);
}

function verifyStaleBiometricPrompt(ui, logcat, transcript) {
  verifyBiometricPrompt(ui, logcat, {
    uiFile: "stale-biometric-ui.xml",
    logFile: "stale-biometric-logcat.log",
    stage: "after at least 5 minutes in background",
  });
  const timing = transcript.match(/\bstale_background_ms=(\d+)\b/);
  if (!timing) {
    failures.push("stale-biometric.txt must record stale_background_ms=<elapsed-ms>");
  } else if (Number(timing[1]) < 300_000) {
    failures.push(`stale-biometric.txt records stale_background_ms=${timing[1]}, expected >=300000`);
  }
  requirePatternText(
    transcript,
    /\bstale_input_before_unlock_blocked\b/,
    "stale-biometric.txt must prove terminal input was blocked before stale biometric unlock",
  );
  rejectPatternText(
    transcript,
    /\b(?:stale_input_before_unlock_sent|stale_input_before_unlock_visible)\b/,
    "stale-biometric.txt must not show stale terminal input was sent before unlock",
  );
}

function verifyPreUnlockLog(text, file) {
  rejectPatternText(
    text,
    /\bFieldworkRepository:\s+(?:pair completed|listSessions returned|registerPushToken|attach)|\bterminal attached\b|\bsendInput\b/i,
    `${file} must not show session sync, terminal attach, push-token registration, or input before unlock succeeds`,
  );
}

function verifyLogs(entries) {
  verifyCleanAndroidLogs(entries, failures);
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
