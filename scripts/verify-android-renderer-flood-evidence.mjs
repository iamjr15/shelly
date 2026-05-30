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
  "flood.png",
  "flood-ui.xml",
  "flood-replay.txt",
  "logcat.log",
  "crash.log",
];

if (rawArgs.length !== 1 || rawArgs[0] === "--help" || rawArgs[0] === "-h") {
  console.error("usage: node scripts/verify-android-renderer-flood-evidence.mjs <evidence-dir>");
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
  verifyPng("flood.png");
  verifyFloodUi(readText("flood-ui.xml"));
  verifyNoAndroidSystemErrorOverlays([["flood-ui.xml", readText("flood-ui.xml")]], failures);
  verifyFloodReplay(readText("flood-replay.txt"));
  verifyLogs([
    ["logcat.log", readText("logcat.log")],
    ["crash.log", readText("crash.log")],
  ]);
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(`Android renderer flood evidence ok: ${evidenceDir}`);

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

function verifyFloodUi(text) {
  rejectPatternText(text, /\bNo sessions\b/i, "flood-ui.xml must show an attached terminal, not the dashboard");
  requirePatternText(text, /\b(?:Attached|Terminal)\b/i, "flood-ui.xml must show the attached terminal state");
  requirePatternText(text, /\bANDROID_LIVE_FLOOD\b/, "flood-ui.xml must show Android flood marker output in the terminal");
}

function verifyFloodReplay(text) {
  requirePatternText(
    text,
    /\byes\s+ANDROID_LIVE_FLOOD\s*\|\s*head\s+-10000\b/,
    "flood-replay.txt must show the Android-originated yes | head -10000 flood command",
  );
  requirePatternText(text, /\bANDROID_LIVE_FLOOD_START\b/, "flood-replay.txt must include ANDROID_LIVE_FLOOD_START");
  requirePatternText(text, /\bANDROID_LIVE_FLOOD_DONE\b/, "flood-replay.txt must include ANDROID_LIVE_FLOOD_DONE");
  const lineMarker = text.split(/\r?\n/).find((line) => line.trim().match(/^flood_lines=\d+$/))?.match(/^flood_lines=(\d+)$/);
  if (!lineMarker) {
    failures.push("flood-replay.txt must record flood_lines=10000");
  } else if (Number(lineMarker[1]) !== 10_000) {
    failures.push(`flood-replay.txt records flood_lines=${lineMarker[1]}, expected 10000`);
  }
  const markerCount = text.split(/\r?\n/).filter((line) => line.trim() === "ANDROID_LIVE_FLOOD").length;
  if (markerCount < 10_000) {
    failures.push(`flood-replay.txt contains ${markerCount} ANDROID_LIVE_FLOOD markers, expected at least 10000`);
  }
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
