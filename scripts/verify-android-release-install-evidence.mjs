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

const args = parseArgs(process.argv.slice(2).filter((arg) => arg !== "--"));
const failures = [];

const apksDir = path.resolve(args.paths[0]);
const installDir = path.resolve(args.paths[1]);

const apksRequiredFiles = [
  "summary.txt",
  "apksigner-universal.txt",
  "aapt-badging.txt",
  "aapt-permissions.txt",
  "aapt-manifest-tree.txt",
  "sha256.txt",
];
const installRequiredFiles = [
  "adb-devices.txt",
  "install.txt",
  "pm-path.txt",
  "package-info.txt",
  "run-as.txt",
  "resolve-activity.txt",
  "launch.txt",
  "locked.png",
  "locked-ui.xml",
  "logcat.log",
  "crash.log",
  "sha256.txt",
];

requireDirectory(apksDir, "APKS evidence directory");
requireDirectory(installDir, "install evidence directory");
for (const file of apksRequiredFiles) {
  requireFile(apksDir, file);
}
for (const file of installRequiredFiles) {
  requireFile(installDir, file);
}

if (failures.length === 0) {
  verifyApksSummary(readText(apksDir, "summary.txt"));
  verifyApkSignature(readText(apksDir, "apksigner-universal.txt"), { strictReleaseDevice: args.strictReleaseDevice });
  verifyBadging(readText(apksDir, "aapt-badging.txt"));
  verifyPermissions(readText(apksDir, "aapt-permissions.txt"));
  verifyManifestTree(readText(apksDir, "aapt-manifest-tree.txt"));
  verifyApksSha256(readText(apksDir, "sha256.txt"));

  verifyAdbDevices(readText(installDir, "adb-devices.txt"), { strictReleaseDevice: args.strictReleaseDevice });
  verifyInstall(readText(installDir, "install.txt"));
  verifyPackageInfo(`${readText(installDir, "pm-path.txt")}\n${readText(installDir, "package-info.txt")}`);
  verifyRunAs(readText(installDir, "run-as.txt"));
  verifyResolveActivity(readText(installDir, "resolve-activity.txt"));
  verifyLaunch(readText(installDir, "launch.txt"));
  verifyPng(installDir, "locked.png");
  verifyLockedSurface(readText(installDir, "locked-ui.xml"));
  verifyNoAndroidSystemErrorOverlays([["locked-ui.xml", readText(installDir, "locked-ui.xml")]], failures);
  verifyCleanAndroidLogs(
    [
      ["logcat.log", readText(installDir, "logcat.log")],
      ["crash.log", readText(installDir, "crash.log")],
    ],
    failures,
  );
  verifyInstallSha256(readText(installDir, "sha256.txt"));
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(`Android release install evidence ok: ${apksDir} ${installDir}`);

function parseArgs(argv) {
  const parsed = {
    strictReleaseDevice: false,
    paths: [],
  };

  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }
    if (arg === "--strict-release-device") {
      parsed.strictReleaseDevice = true;
      continue;
    }
    if (arg.startsWith("-")) {
      console.error(`unknown argument: ${arg}`);
      printUsage();
      process.exit(2);
    }
    parsed.paths.push(arg);
  }

  if (parsed.paths.length !== 2) {
    printUsage();
    process.exit(2);
  }

  return parsed;
}

function printUsage() {
  console.error(
    "usage: node scripts/verify-android-release-install-evidence.mjs [--strict-release-device] <apks-evidence-dir> <install-evidence-dir>",
  );
}

function verifyApksSummary(text) {
  requirePatternText(text, /\bbundletool=.*bundletool-all-1\.18\.3\.jar\b/, "summary.txt must identify bundletool-all-1.18.3");
  requirePatternText(text, /\bapks=.*fieldwork-release-universal\.apks\b/, "summary.txt must identify the generated universal .apks archive");
  requirePatternText(text, /\buniversal_apk=.*universal\.apk\b/, "summary.txt must identify the extracted universal.apk");
}

function verifyApkSignature(text, { strictReleaseDevice }) {
  requirePatternText(text, /^Verifies\b/m, "apksigner-universal.txt must prove the APK verifies");
  requirePatternText(
    text,
    /\bVerified using v3 scheme \(APK Signature Scheme v3\): true\b/,
    "apksigner-universal.txt must prove APK Signature Scheme v3 verification",
  );
  requirePatternText(text, /\bNumber of signers:\s*1\b/, "apksigner-universal.txt must prove exactly one signer");
  if (strictReleaseDevice) {
    requirePatternText(text, /\bSigner #1 certificate DN:\s*\S/m, "apksigner-universal.txt must include the release signer DN");
    rejectPatternText(
      text,
      /\bFieldwork Release Smoke\b/i,
      "apksigner-universal.txt must not use the local ephemeral release-smoke certificate in strict release-device mode",
    );
  } else {
    requirePatternText(
      text,
      /\bSigner #1 certificate DN:\s*CN=Fieldwork Release Smoke\b/,
      "apksigner-universal.txt must prove the ephemeral non-debug release-smoke signer",
    );
  }
  rejectPatternText(text, /\bCN=Android Debug\b/i, "apksigner-universal.txt must not use the Android debug certificate");
}

function verifyBadging(text) {
  requirePatternText(
    text,
    /\bpackage:\s*name='app\.fieldwork\.android'\s+versionCode='1'\s+versionName='1\.0'/,
    "aapt-badging.txt must prove package identity and v1 release version",
  );
  requirePatternText(text, /\btargetSdkVersion:'36'/, "aapt-badging.txt must prove targetSdkVersion 36");
  requirePatternText(
    text,
    /\blaunchable-activity:\s*name='app\.fieldwork\.android\.MainActivity'/,
    "aapt-badging.txt must prove MainActivity is launchable",
  );
  for (const permission of [
    "android.permission.INTERNET",
    "android.permission.CAMERA",
    "android.permission.POST_NOTIFICATIONS",
    "android.permission.USE_BIOMETRIC",
    "android.permission.ACCESS_NETWORK_STATE",
  ]) {
    requirePatternText(text, new RegExp(`\\buses-permission:\\s*name='${escapeRegExp(permission)}'`), `aapt-badging.txt must include ${permission}`);
  }
  rejectPatternText(text, /\bdebuggable\b/i, "aapt-badging.txt must not contain debuggable markers");
}

function verifyPermissions(text) {
  for (const forbidden of [
    "android.permission.ACCESS_FINE_LOCATION",
    "android.permission.ACCESS_COARSE_LOCATION",
    "android.permission.RECORD_AUDIO",
    "android.permission.READ_CONTACTS",
    "android.permission.READ_EXTERNAL_STORAGE",
    "android.permission.WRITE_EXTERNAL_STORAGE",
  ]) {
    rejectPatternText(text, new RegExp(`\\b${escapeRegExp(forbidden)}\\b`), `aapt-permissions.txt must not request ${forbidden}`);
  }
}

function verifyManifestTree(text) {
  requirePatternText(text, /\bpackage="app\.fieldwork\.android"/, "aapt-manifest-tree.txt must prove package identity");
  requirePatternText(
    text,
    /\bversionCode\(0x0101021b\)=(?:1|\(type 0x10\)0x1)\b/,
    "aapt-manifest-tree.txt must prove versionCode=1",
  );
  requirePatternText(text, /\bversionName\(0x0101021c\)="1\.0"/, "aapt-manifest-tree.txt must prove versionName=1.0");
  rejectPatternText(text, /\bdebuggable\b/i, "aapt-manifest-tree.txt must not contain debuggable markers");
}

function verifyApksSha256(text) {
  requirePatternText(text, /^[0-9a-f]{64}\s+.*fieldwork-release-universal\.apks$/m, "sha256.txt must hash the generated .apks archive");
  requirePatternText(text, /^[0-9a-f]{64}\s+.*universal\.apk$/m, "sha256.txt must hash the extracted universal.apk");
}

function verifyAdbDevices(text, { strictReleaseDevice }) {
  if (strictReleaseDevice) {
    verifyPhysicalAndroidAdbDevices(text, failures, { file: "adb-devices.txt" });
    return;
  }

  requirePatternText(text, /^List of devices attached\b/im, "adb-devices.txt must include adb devices output");
  const authorizedDevices = text
    .split(/\r?\n/)
    .filter((line) => /^[^\s#][^\n]*\s+device(?:\s|$)/i.test(line));
  if (authorizedDevices.length !== 1) {
    failures.push(`adb-devices.txt must show exactly one authorized Android device, found ${authorizedDevices.length}`);
  }
  rejectPatternText(text, /\b(?:unauthorized|offline|no permissions)\b/i, "adb-devices.txt must not show an unusable adb state");
}

function verifyInstall(text) {
  requirePatternText(text, /\bSuccess\b/, "install.txt must show adb install Success");
}

function verifyPackageInfo(text) {
  verifyInstalledAndroidPackageInfo(text, failures, { forbidDebuggable: true });
  rejectPatternText(text, /\bDEBUGGABLE\b/i, "package-info.txt must not include the DEBUGGABLE flag");
  requirePatternText(text, /\bapkSigningVersion=3\b/, "package-info.txt must prove the installed APK uses signature version 3");
}

function verifyRunAs(text) {
  requirePatternText(
    text,
    /\brun-as:\s*package not debuggable:\s*app\.fieldwork\.android\b/,
    "run-as.txt must prove app.fieldwork.android is not debuggable",
  );
}

function verifyResolveActivity(text) {
  requirePatternText(
    text,
    /\bapp\.fieldwork\.android\/\.MainActivity\b/,
    "resolve-activity.txt must resolve app.fieldwork.android/.MainActivity",
  );
}

function verifyLaunch(text) {
  requirePatternText(text, /\bStatus:\s*ok\b/, "launch.txt must contain Android am start Status: ok");
  requirePatternText(text, /\bLaunchState:\s*COLD\b/, "launch.txt must prove the launch was cold");
  requirePatternText(text, /\bActivity:\s*app\.fieldwork\.android\/\.MainActivity\b/, "launch.txt must launch app.fieldwork.android/.MainActivity");
  const totalTime = text.match(/\bTotalTime:\s*(\d+)\b/);
  if (!totalTime) {
    failures.push("launch.txt must record TotalTime");
  } else if (Number(totalTime[1]) > 1_200) {
    failures.push(`launch.txt records TotalTime=${totalTime[1]}ms, expected <=1200ms`);
  }
}

function verifyPng(root, file) {
  const bytes = fs.readFileSync(path.join(root, file));
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
  requirePatternText(text, /(?:>Unlock<|text="Unlock")/, "locked-ui.xml must show the locked unlock surface");
  rejectPatternText(
    text,
    /\b(No sessions|Pairing|Terminal|refactoringjob|bash|claude|ANDROID_)\b/i,
    "locked-ui.xml must not expose session, pairing, terminal, command, or test-marker content before unlock",
  );
}

function verifyInstallSha256(text) {
  requirePatternText(text, /^[0-9a-f]{64}\s+.*universal\.apk$/m, "install sha256.txt must hash the installed universal.apk");
  requirePatternText(text, /^[0-9a-f]{64}\s+.*locked\.png$/m, "install sha256.txt must hash the locked screenshot");
}

function requireDirectory(dir, label) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    failures.push(`${label} is missing: ${dir}`);
  }
}

function requireFile(root, file) {
  const absolute = path.join(root, file);
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
    failures.push(`missing evidence file: ${path.basename(root)}/${file}`);
  }
}

function readText(root, file) {
  return fs.readFileSync(path.join(root, file), "utf8");
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

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
