#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  verifyCleanAndroidLogs,
  verifyNoAndroidSystemErrorOverlays,
  verifyPhysicalAndroidAdbDevices,
} from "./android-evidence-common.mjs";

const rawArgs = process.argv.slice(2).filter((arg) => arg !== "--");
const failures = [];
const requiredFiles = [
  "adb-devices.txt",
  "artifact-signing.txt",
  "buildconfig.txt",
  "pairing.txt",
  "dashboard.png",
  "dashboard-ui.xml",
  "sessions.txt",
  "devices.txt",
  "logcat.log",
  "crash.log",
];

if (rawArgs.length !== 1 || rawArgs[0] === "--help" || rawArgs[0] === "-h") {
  console.error("usage: node scripts/verify-android-pair-flow-evidence.mjs <evidence-dir>");
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
  verifyPairingTranscript(readText("pairing.txt"));
  verifyPng("dashboard.png");
  verifyDashboard(readText("dashboard-ui.xml"), readText("sessions.txt"), readText("logcat.log"));
  verifyNoAndroidSystemErrorOverlays([["dashboard-ui.xml", readText("dashboard-ui.xml")]], failures);
  verifyDevices(readText("devices.txt"));
  verifyLogs([
    ["logcat.log", readText("logcat.log")],
    ["crash.log", readText("crash.log")],
  ]);
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(`Android pair-flow evidence ok: ${evidenceDir}`);

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

function verifyPairingTranscript(text) {
  requirePatternText(text, /"pair_token"\s*:/, "pairing.txt must include the JSON QR pairing payload from fw pair");
  requirePatternText(text, /Waiting for a device to scan/i, "pairing.txt must show fw pair waited for a device scan");
  requirePatternText(
    text,
    /Pair request from device\b[\s\S]*approve\?\s*\[y\/N\]/i,
    "pairing.txt must show the explicit desktop approval prompt",
  );
  requirePatternText(text, /Approved\. Device is paired\./, "pairing.txt must show the desktop approval completed pairing");
  const timing = text.match(/\bpair_flow_ms=(\d+)\b/);
  if (!timing) {
    failures.push("pairing.txt must record pair_flow_ms=<elapsed-ms>");
  } else if (Number(timing[1]) > 15_000) {
    failures.push(`pairing.txt records pair_flow_ms=${timing[1]}, expected <=15000`);
  }
  rejectPatternText(text, /Denied\. Pair token has been consumed\./, "pairing.txt must not be a denied pairing transcript");
  rejectPatternText(text, /\bFIELDWORK_DEBUG_PAIRING_PAYLOAD\b/, "pairing.txt must not use debug pairing payload injection");
}

function verifyDashboard(ui, sessions, logcat) {
  rejectPatternText(ui, /\bNo sessions\b/i, "dashboard-ui.xml must not be the empty dashboard after pairing");
  requirePatternText(ui, /\brefactoringjob\b/i, "dashboard-ui.xml must show the named shortcut session refactoringjob");
  requirePatternText(ui, /\b(?:shell|bash)\b/i, "dashboard-ui.xml must show a desktop-created shell/bash session");
  requirePatternText(
    logcat,
    /FieldworkRepository:\s+pair completed/i,
    "logcat.log must show repository pair completion",
  );
  requirePatternText(
    logcat,
    /FieldworkRepository:\s+listSessions returned \d+ sessions/i,
    "logcat.log must show session listing after pair",
  );
  requirePatternText(
    sessions,
    /^.*\brefactoringjob\b.*\bclaude\b.*$/im,
    "sessions.txt must include the named shortcut refactoringjob claude session",
  );
  requirePatternText(
    sessions,
    /^.*\b(?:shell|bash)\b.*$/im,
    "sessions.txt must include a desktop-created shell/bash session",
  );
}

function verifyDevices(text) {
  requirePatternText(text, /\b(?:Android|Pixel|phone|paired|device)\b/i, "devices.txt must show the paired Android device");
  rejectPatternText(text, /\bNo devices\b/i, "devices.txt must not be empty after pairing");
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
