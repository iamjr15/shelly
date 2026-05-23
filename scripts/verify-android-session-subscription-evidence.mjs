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
  "dashboard-before-ui.xml",
  "desktop-create.txt",
  "subscription.png",
  "subscription-ui.xml",
  "subscription-logcat.log",
  "subscription-crash.log",
  "subscription-visible.txt",
  "subscription-replay.txt",
  "sessions-after.txt",
];

if (rawArgs.length !== 1 || rawArgs[0] === "--help" || rawArgs[0] === "-h") {
  console.error("usage: node scripts/verify-android-session-subscription-evidence.mjs <evidence-dir>");
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
  verifyBeforeDashboard(readText("dashboard-before-ui.xml"));
  verifyDesktopCreate(readText("desktop-create.txt"), readText("sessions-after.txt"));
  verifyPng("subscription.png");
  verifySubscriptionEvidence(
    readText("subscription-ui.xml"),
    readText("subscription-logcat.log"),
    readText("subscription-visible.txt"),
    readText("subscription-replay.txt"),
  );
  verifyLogs([
    ["subscription-logcat.log", readText("subscription-logcat.log")],
    ["subscription-crash.log", readText("subscription-crash.log")],
  ]);
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(`Android session-subscription evidence ok: ${evidenceDir}`);

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

function verifyBeforeDashboard(ui) {
  rejectPatternText(
    ui,
    /\bfw_live_sub\b/i,
    "dashboard-before-ui.xml must prove fw_live_sub was not already visible before the desktop create",
  );
  rejectMobileSessionControls(ui, "dashboard-before-ui.xml");
}

function verifyDesktopCreate(transcript, sessionsAfter) {
  requirePatternText(
    transcript,
    /\bfw\s+new\s+--name\s+fw_live_sub\s+bash\b/,
    "desktop-create.txt must show the desktop CLI command fw new --name fw_live_sub bash",
  );
  requirePatternText(transcript, /\bfw_live_sub\b/, "desktop-create.txt must identify the desktop-created fw_live_sub session");
  requirePatternText(sessionsAfter, /^.*\bfw_live_sub\b.*\bbash\b.*$/im, "sessions-after.txt must include fw_live_sub with bash");
}

function verifySubscriptionEvidence(ui, logcat, visibleText, replay) {
  rejectPatternText(ui, /\bNo sessions\b/i, "subscription-ui.xml must not be the empty dashboard after desktop session creation");
  requirePatternText(
    ui,
    /\bfw_live_sub\b/i,
    "subscription-ui.xml must show the post-pair desktop-created fw_live_sub session",
  );
  rejectMobileSessionControls(ui, "subscription-ui.xml");
  requirePatternText(
    logcat,
    /FieldworkRepository:\s+listSessions returned \d+ sessions/i,
    "subscription-logcat.log must show session-list activity after desktop creation",
  );
  requirePatternText(
    visibleText,
    /\bcreated_by_desktop_cli\b/,
    "subscription-visible.txt must record that fw_live_sub was created from the desktop CLI",
  );
  const timing = visibleText.match(/\bvisible_ms=(\d+)\b/);
  if (!timing) {
    failures.push("subscription-visible.txt must record visible_ms=<elapsed-ms>");
  } else if (Number(timing[1]) > 2_000) {
    failures.push(`subscription-visible.txt records visible_ms=${timing[1]}, expected <=2000`);
  }
  requirePatternText(replay, /\bfw_live_sub\b/i, "subscription-replay.txt must identify the subscribed desktop-created session");
  requirePatternText(
    replay,
    /\bsubscription_attach_ok\b/,
    "subscription-replay.txt must include Android-originated input after attaching the subscribed session",
  );
}

function rejectMobileSessionControls(ui, file) {
  rejectPatternText(
    ui,
    /\b(?:Create session|New session|Kill session|Delete session|Choose command|Run command)\b/i,
    `${file} must not expose mobile session creation, kill, or command-selection controls`,
  );
}

function verifyLogs(entries) {
  const fatalPattern = /\bFATAL EXCEPTION\b|\bANR in app\.fieldwork\.android\b|Fieldwork.*\b(FATAL|ANR|Exception)\b/i;
  const crashPattern = /\bapp\.fieldwork\.android\b|\bFATAL EXCEPTION\b|\bANR\b/i;
  for (const [name, text] of entries) {
    rejectPatternText(text, fatalPattern, `${name} must not contain Fieldwork fatal, ANR, or exception entries`);
    if (name === "subscription-crash.log") {
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
