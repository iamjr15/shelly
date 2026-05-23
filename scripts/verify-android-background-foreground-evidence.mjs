#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const rawArgs = process.argv.slice(2).filter((arg) => arg !== "--");
const failures = [];
const packageName = "app.fieldwork.android";
const requiredFiles = [
  "adb-devices.txt",
  "artifact-signing.txt",
  "buildconfig.txt",
  "attached-before.png",
  "attached-before-ui.xml",
  "background-state.txt",
  "background-output-replay.txt",
  "attached-after.png",
  "attached-after-ui.xml",
  "post-foreground-replay.txt",
  "timing.txt",
  "logcat.log",
  "crash.log",
];

if (rawArgs.length !== 1 || rawArgs[0] === "--help" || rawArgs[0] === "-h") {
  console.error("usage: node scripts/verify-android-background-foreground-evidence.mjs <evidence-dir>");
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
  verifyPng("attached-before.png");
  verifyPng("attached-after.png");
  verifyAttachedBefore(readText("attached-before-ui.xml"));
  verifyBackgroundState(readText("background-state.txt"));
  verifyBackgroundReplay(readText("background-output-replay.txt"));
  verifyAttachedAfter(readText("attached-after-ui.xml"));
  verifyPostForegroundReplay(readText("post-foreground-replay.txt"));
  verifyTiming(readText("timing.txt"));
  verifyLogs([
    ["logcat.log", readText("logcat.log")],
    ["crash.log", readText("crash.log")],
  ]);
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(`Android background/foreground evidence ok: ${evidenceDir}`);

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

function verifyAttachedBefore(text) {
  requireAttachedUi("attached-before-ui.xml", text);
  requirePatternText(
    text,
    /\b(?:ANDROID_BACKGROUND_READY|fw_background_session|background)\b/i,
    "attached-before-ui.xml must show the attached background-test terminal before backgrounding",
  );
}

function verifyBackgroundState(text) {
  requirePatternText(
    text,
    /\bbackground_command=adb shell input keyevent KEYCODE_HOME\b/,
    "background-state.txt must record the direct adb KEYCODE_HOME background action",
  );
  requirePatternText(text, /\bapp_backgrounded_ok\b/, "background-state.txt must record app_backgrounded_ok");
  const topPackage = text.match(/\bbackground_top_package=([^\s]+)/);
  if (!topPackage) {
    failures.push("background-state.txt must record background_top_package=<package>");
  } else if (topPackage[1] === packageName) {
    failures.push("background-state.txt must prove Fieldwork was not the top package while backgrounded");
  }
  rejectPatternText(
    text,
    /background_top_package=.*app\.fieldwork\.android/i,
    "background-state.txt must prove Fieldwork was not the focused package while backgrounded",
  );
}

function verifyBackgroundReplay(text) {
  requirePatternText(text, /\bANDROID_BACKGROUND_READY\b/, "background-output-replay.txt must include initial attached-session output");
  requirePatternText(
    text,
    /\bANDROID_BACKGROUND_REPLAY_OUTPUT\b/,
    "background-output-replay.txt must include output emitted while Android was backgrounded",
  );
  rejectPatternText(text, /\bafter_background_ok\b/, "background-output-replay.txt must be captured before post-foreground input");
}

function verifyAttachedAfter(text) {
  requireAttachedUi("attached-after-ui.xml", text);
  requirePatternText(
    text,
    /\b(?:ANDROID_BACKGROUND_REPLAY_OUTPUT|after_background_ok|Attached|Terminal)\b/,
    "attached-after-ui.xml must show the terminal attached after foregrounding",
  );
}

function verifyPostForegroundReplay(text) {
  requirePatternText(
    text,
    /\bANDROID_BACKGROUND_REPLAY_OUTPUT\b/,
    "post-foreground-replay.txt must still include background-emitted output after foregrounding",
  );
  requirePatternText(
    text,
    /\bafter_background_ok\b/,
    "post-foreground-replay.txt must include Android-originated input after foregrounding",
  );
  requirePatternText(
    text,
    /\bandroid-background:\s*after_background_ok\b/,
    "post-foreground-replay.txt must include PTY echo for the Android-originated post-foreground input",
  );
}

function verifyTiming(text) {
  requirePatternText(text, /\bbackgrounded_at=/, "timing.txt must record backgrounded_at=<timestamp>");
  requirePatternText(text, /\bforegrounded_at=/, "timing.txt must record foregrounded_at=<timestamp>");
  const backgroundDuration = text.match(/\bbackground_duration_ms=(\d+)\b/);
  if (!backgroundDuration) {
    failures.push("timing.txt must record background_duration_ms=<elapsed-ms>");
  } else if (Number(backgroundDuration[1]) < 3_000) {
    failures.push(`timing.txt records background_duration_ms=${backgroundDuration[1]}, expected >=3000`);
  }
  const reconnect = text.match(/\bforeground_reconnect_ms=(\d+)\b/);
  if (!reconnect) {
    failures.push("timing.txt must record foreground_reconnect_ms=<elapsed-ms>");
  } else if (Number(reconnect[1]) > 5_000) {
    failures.push(`timing.txt records foreground_reconnect_ms=${reconnect[1]}, expected <=5000`);
  }
  requirePatternText(
    text,
    /\brelease_device_background_foreground_candidate=pass\b/,
    "timing.txt must record release_device_background_foreground_candidate=pass after human review",
  );
}

function requireAttachedUi(file, text) {
  rejectPatternText(text, /\bNo sessions\b/i, `${file} must show an attached terminal, not the dashboard`);
  requirePatternText(text, /\b(?:Attached|Terminal)\b/i, `${file} must show the attached terminal state`);
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
