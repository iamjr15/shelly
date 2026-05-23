#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { verifyPhysicalAndroidAdbDevices } from "./android-evidence-common.mjs";

const rawArgs = process.argv.slice(2).filter((arg) => arg !== "--");
const failures = [];

if (rawArgs.length !== 1 || rawArgs[0] === "--help" || rawArgs[0] === "-h") {
  console.error("usage: node scripts/verify-android-cold-start-evidence.mjs <evidence-dir>");
  process.exit(rawArgs.length === 1 ? 0 : 2);
}

const evidenceDir = path.resolve(rawArgs[0]);
const launchFiles = ["launch-1.txt", "launch-2.txt", "launch-3.txt", "launch-4.txt", "launch-5.txt"];
const requiredFiles = [
  "adb-devices.txt",
  "artifact-signing.txt",
  "buildconfig.txt",
  "install.txt",
  ...launchFiles,
  "locked.png",
  "locked-ui.xml",
  "logcat.log",
  "crash.log",
];

requireDirectory(evidenceDir);
for (const file of requiredFiles) {
  requireFile(file);
}

if (failures.length === 0) {
  verifyAdbDevices(readText("adb-devices.txt"));
  verifyArtifactSigning(readText("artifact-signing.txt"));
  verifyBuildConfig(readText("buildconfig.txt"));
  verifyInstall(readText("install.txt"));
  for (const file of launchFiles) {
    verifyLaunch(file, readText(file));
  }
  verifyPng("locked.png");
  verifyLockedSurface(readText("locked-ui.xml"));
  verifyLogs([
    ["logcat.log", readText("logcat.log")],
    ["crash.log", readText("crash.log")],
  ]);
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(`Android cold-start evidence ok: ${evidenceDir}`);

function verifyAdbDevices(text) {
  verifyPhysicalAndroidAdbDevices(text, failures);
}

function verifyArtifactSigning(text) {
  requirePatternText(
    text,
    /\bAndroid AAB ok:/,
    "artifact-signing.txt must include scripts/verify-android-aab.mjs success output",
  );
  requirePatternText(
    text,
    /\bsigned release bundle ok\b/,
    "artifact-signing.txt must prove the release App Bundle was signed",
  );
}

function verifyBuildConfig(text) {
  requirePatternText(
    text,
    /\bAPPLICATION_ID\s*=\s*"app\.fieldwork\.android"/,
    "buildconfig.txt must prove the tested release build targets app.fieldwork.android",
  );
  requirePatternText(
    text,
    /\bBUILD_TYPE\s*=\s*"release"/,
    "buildconfig.txt must prove the tested build is the release variant",
  );
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

function verifyInstall(text) {
  requirePatternText(
    text,
    /\b(?:Success|Installed|installed)\b/,
    "install.txt must show the signed release app was installed on the physical device",
  );
}

function verifyLaunch(file, text) {
  requirePatternText(text, /\bStatus:\s*ok\b/, `${file} must contain Android am start Status: ok`);
  requirePatternText(text, /\bLaunchState:\s*COLD\b/, `${file} must prove the launch was cold after force-stop`);
  requirePatternText(
    text,
    /\bActivity:\s*app\.fieldwork\.android\/\.MainActivity\b/,
    `${file} must launch app.fieldwork.android/.MainActivity`,
  );
  const totalTime = text.match(/\bTotalTime:\s*(\d+)\b/);
  if (!totalTime) {
    failures.push(`${file} must record TotalTime`);
  } else if (Number(totalTime[1]) > 1_200) {
    failures.push(`${file} records TotalTime=${totalTime[1]}ms, expected <=1200ms`);
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

  const ihdrOffset = 8;
  const ihdrLength = bytes.readUInt32BE(ihdrOffset);
  const ihdrType = bytes.toString("ascii", ihdrOffset + 4, ihdrOffset + 8);
  if (ihdrLength !== 13 || ihdrType !== "IHDR") {
    failures.push(`${file} must contain a valid PNG IHDR header`);
    return;
  }
  const width = bytes.readUInt32BE(ihdrOffset + 8);
  const height = bytes.readUInt32BE(ihdrOffset + 12);
  const shortSide = Math.min(width, height);
  const longSide = Math.max(width, height);
  if (shortSide < 360 || longSide < 640) {
    failures.push(`${file} is too small for Android phone evidence (${width}x${height})`);
  }
}

function verifyLockedSurface(text) {
  requirePatternText(text, /(?:>Unlock<|text="Unlock")/, "locked-ui.xml must show the locked biometric unlock surface");
  rejectPatternText(
    text,
    /\b(No sessions|Pairing|Terminal|refactoringjob|bash|claude|ANDROID_)\b/i,
    "locked-ui.xml must not expose session, pairing, terminal, command, or test-marker content before unlock",
  );
}

function verifyLogs(entries) {
  const fatalPattern = /\bFATAL EXCEPTION\b|\bANR in app\.fieldwork\.android\b|Fieldwork.*\b(FATAL|ANR|Exception)\b/i;
  const crashPattern = /\bapp\.fieldwork\.android\b|\bFATAL EXCEPTION\b|\bANR\b/i;
  for (const [name, text] of entries) {
    rejectPatternText(text, fatalPattern, `${name} must not contain Fieldwork fatal, ANR, or exception entries`);
    if (name === "crash.log") {
      rejectPatternText(text, crashPattern, `${name} must not contain app.fieldwork.android crash-buffer entries`);
    }
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
