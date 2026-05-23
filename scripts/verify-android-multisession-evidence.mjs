#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { verifyPhysicalAndroidAdbDevices } from "./android-evidence-common.mjs";

const rawArgs = process.argv.slice(2).filter((arg) => arg !== "--");
const failures = [];
const requiredFiles = [
  "adb-devices.txt",
  "artifact-signing.txt",
  "buildconfig.txt",
  "sessions.txt",
  "multisession.png",
  "multisession-ui.xml",
  "multisession-logcat.log",
  "multisession-crash.log",
  "multisession-a-replay.txt",
  "multisession-b-replay.txt",
  "multisession-c-replay.txt",
];

if (rawArgs.length !== 1 || rawArgs[0] === "--help" || rawArgs[0] === "-h") {
  console.error("usage: node scripts/verify-android-multisession-evidence.mjs <evidence-dir>");
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
  verifyPng("multisession.png");
  verifyMultisessionEvidence(
    readText("multisession-ui.xml"),
    readText("multisession-logcat.log"),
    readText("multisession-a-replay.txt"),
    readText("multisession-b-replay.txt"),
    readText("multisession-c-replay.txt"),
  );
  verifyLogs([
    ["multisession-logcat.log", readText("multisession-logcat.log")],
    ["multisession-crash.log", readText("multisession-crash.log")],
  ]);
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(`Android multisession evidence ok: ${evidenceDir}`);

function verifyAdbDevices(text) {
  verifyPhysicalAndroidAdbDevices(text, failures);
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
  for (const session of ["fwm_a", "fwm_b", "fwm_c"]) {
    requirePatternText(text, new RegExp(`\\b${session}\\b`, "i"), `sessions.txt must include desktop-created ${session}`);
  }
}

function verifyMultisessionEvidence(ui, logcat, replayA, replayB, replayC) {
  for (const session of ["fwm_a", "fwm_b", "fwm_c"]) {
    requirePatternText(ui, new RegExp(`\\b${session}\\b`, "i"), `multisession-ui.xml must include ${session} in the switched session set`);
  }
  rejectPatternText(
    ui,
    /\b(?:Create session|New session|Kill session|Delete session|Choose command|Run command)\b/i,
    "multisession-ui.xml must not expose mobile session creation, kill, or command-selection controls",
  );
  requirePatternText(
    logcat,
    /FieldworkRepository:\s+listSessions returned \d+ sessions/i,
    "multisession-logcat.log must show session listing for the switched session set",
  );
  verifyMultisessionReplay("multisession-a-replay.txt", replayA, "fwm_a", "multi_a_ok", ["multi_b_ok", "multi_c_ok"]);
  verifyMultisessionReplay("multisession-b-replay.txt", replayB, "fwm_b", "multi_b_ok", ["multi_a_ok", "multi_c_ok"]);
  verifyMultisessionReplay("multisession-c-replay.txt", replayC, "fwm_c", "multi_c_ok", ["multi_a_ok", "multi_b_ok"]);
}

function verifyMultisessionReplay(file, text, session, expected, rejected) {
  requirePatternText(text, new RegExp(`\\b${session}\\b`, "i"), `${file} must identify ${session}`);
  requirePatternText(text, new RegExp(`\\b${expected}\\b`), `${file} must contain ${expected}`);
  for (const marker of rejected) {
    rejectPatternText(text, new RegExp(`\\b${marker}\\b`), `${file} must not contain ${marker}`);
  }
}

function verifyLogs(entries) {
  const fatalPattern = /\bFATAL EXCEPTION\b|\bANR in app\.fieldwork\.android\b|Fieldwork.*\b(FATAL|ANR|Exception)\b/i;
  const crashPattern = /\bapp\.fieldwork\.android\b|\bFATAL EXCEPTION\b|\bANR\b/i;
  for (const [name, text] of entries) {
    rejectPatternText(text, fatalPattern, `${name} must not contain Fieldwork fatal, ANR, or exception entries`);
    if (name === "multisession-crash.log") {
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
