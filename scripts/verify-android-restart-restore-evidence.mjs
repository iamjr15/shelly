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
  "sessions-before.txt",
  "devices.txt",
  "daemon-restart.txt",
  "restart.png",
  "restart-ui.xml",
  "restart-logcat.log",
  "restart-crash.log",
  "restart-replay.txt",
];

if (rawArgs.length !== 1 || rawArgs[0] === "--help" || rawArgs[0] === "-h") {
  console.error("usage: node scripts/verify-android-restart-restore-evidence.mjs <evidence-dir>");
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
  verifySeedState(readText("sessions-before.txt"), readText("devices.txt"));
  verifyDaemonRestart(readText("daemon-restart.txt"));
  verifyPng("restart.png");
  verifyRestartEvidence(readText("restart-ui.xml"), readText("restart-logcat.log"), readText("restart-replay.txt"));
  verifyLogs([
    ["restart-logcat.log", readText("restart-logcat.log")],
    ["restart-crash.log", readText("restart-crash.log")],
  ]);
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(`Android restart-restore evidence ok: ${evidenceDir}`);

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

function verifySeedState(sessions, devices) {
  requirePatternText(sessions, /\bfw_restart_session\b/i, "sessions-before.txt must include fw_restart_session before daemon restart");
  requirePatternText(devices, /\b(?:Android|Pixel|phone|paired|device)\b/i, "devices.txt must show the paired Android device");
  rejectPatternText(devices, /\bNo devices\b/i, "devices.txt must not be empty after pairing");
}

function verifyDaemonRestart(text) {
  requirePatternText(text, /\bfw\s+daemon\s+restart\b/, "daemon-restart.txt must show fw daemon restart was run");
  const timing = text.match(/\brestart_ms=(\d+)\b/);
  if (!timing) {
    failures.push("daemon-restart.txt must record restart_ms=<elapsed-ms>");
  } else if (Number(timing[1]) > 30_000) {
    failures.push(`daemon-restart.txt records restart_ms=${timing[1]}, expected <=30000`);
  }
  requirePatternText(
    text,
    /\bprocesses_died_documented\b/,
    "daemon-restart.txt must document that live PTY processes are not expected to survive daemon restart",
  );
}

function verifyRestartEvidence(ui, logcat, replay) {
  requirePatternText(
    ui,
    /\b(?:fw_restart_session|Attached)\b/i,
    "restart-ui.xml must show the restored session after daemon restart",
  );
  requirePatternText(
    logcat,
    /FieldworkRepository:\s+listSessions returned \d+ sessions/i,
    "restart-logcat.log must show session listing after daemon restart restore",
  );
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

function verifyLogs(entries) {
  const fatalPattern = /\bFATAL EXCEPTION\b|\bANR in app\.fieldwork\.android\b|Fieldwork.*\b(FATAL|ANR|Exception)\b/i;
  const crashPattern = /\bapp\.fieldwork\.android\b|\bFATAL EXCEPTION\b|\bANR\b/i;
  for (const [name, text] of entries) {
    rejectPatternText(text, fatalPattern, `${name} must not contain Fieldwork fatal, ANR, or exception entries`);
    if (name === "restart-crash.log") {
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
