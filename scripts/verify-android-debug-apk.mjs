#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const args = process.argv.slice(2).filter((arg) => arg !== "--");
const apkArg = args.find((arg) => !arg.startsWith("--"));
const expectLegacyPairingPayload = args.includes("--expect-legacy-pairing-payload");
const apk = path.resolve(root, apkArg || "apps/android/app/build/outputs/apk/debug/app-debug.apk");
const debugBuildConfig = path.resolve(
  root,
  process.env.FIELDWORK_ANDROID_DEBUG_BUILDCONFIG ||
    "apps/android/app/build/generated/source/buildConfig/debug/app/fieldwork/android/BuildConfig.java",
);
const expectedApplicationId = "app.fieldwork.android";
const expectedVersionName = "1.0";
const expectedVersionCode = "1";

if (args.some((arg) => arg === "--help" || arg === "-h")) {
  printUsage();
  process.exit(0);
}
for (const arg of args) {
  if (arg.startsWith("--") && arg !== "--expect-legacy-pairing-payload") {
    console.error(`unknown argument: ${arg}`);
    printUsage();
    process.exit(2);
  }
}

const failures = [];
if (!fs.existsSync(apk)) {
  fail(`Android debug APK not found: ${path.relative(root, apk)}`);
}

const entries = listZipEntries(apk);
for (const entry of [
  "AndroidManifest.xml",
  "lib/arm64-v8a/libfieldwork_mobile_core.so",
  "lib/armeabi-v7a/libfieldwork_mobile_core.so",
  "lib/x86_64/libfieldwork_mobile_core.so",
]) {
  if (!entries.has(entry)) {
    failures.push(`debug APK is missing ${entry}`);
  }
}
if (entries.has("lib/x86/libfieldwork_mobile_core.so")) {
  failures.push("debug APK unexpectedly includes 32-bit x86 fieldwork mobile core");
}

verifyDebugBuildConfig(failures);
verifyManifest(failures);
verifyLegacyPairingPayloadPolicy(failures);
verifyNoCrashReportingSdk(failures);

if (failures.length > 0) {
  fail(failures.join("\n"));
}

console.log(
  `Android debug APK ok: identity/version/native ABIs/buildConfig/privacy surface ok${
    expectLegacyPairingPayload ? "; legacy pairing payload explicitly allowed" : "; no stale legacy pairing payload"
  }`,
);

function printUsage() {
  console.error(
    "usage: node scripts/verify-android-debug-apk.mjs [--expect-legacy-pairing-payload] [path/to/app-debug.apk]",
  );
}

function listZipEntries(file) {
  const result = spawnSync("unzip", ["-Z1", file], { cwd: root, encoding: "utf8" });
  if (result.status !== 0) {
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    fail(`failed to list Android debug APK: ${path.relative(root, file)}`);
  }
  return new Set(result.stdout.trim().split(/\r?\n/).filter(Boolean));
}

function readZipEntry(file, entry, encoding = "latin1") {
  const result = spawnSync("unzip", ["-p", file, entry], {
    cwd: root,
    encoding,
    maxBuffer: 512 * 1024 * 1024,
  });
  if (result.status !== 0) {
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    fail(`failed to read ${entry} from Android debug APK: ${path.relative(root, file)}`);
  }
  return result.stdout;
}

function verifyDebugBuildConfig(outputFailures) {
  if (!fs.existsSync(debugBuildConfig)) {
    outputFailures.push(
      `missing debug BuildConfig: ${path.relative(root, debugBuildConfig)}; run apps/android/gradlew --no-daemon :app:assembleDebug`,
    );
    return;
  }
  const text = fs.readFileSync(debugBuildConfig, "utf8");
  for (const [pattern, message] of [
    [/APPLICATION_ID\s*=\s*"app\.fieldwork\.android"/, "debug BuildConfig must set APPLICATION_ID=app.fieldwork.android"],
    [/VERSION_CODE\s*=\s*1\b/, "debug BuildConfig must set VERSION_CODE=1"],
    [/VERSION_NAME\s*=\s*"1\.0"/, "debug BuildConfig must set VERSION_NAME=1.0"],
    [/BUILD_TYPE\s*=\s*"debug"/, "debug BuildConfig must be the debug variant"],
    [/DEBUG\s*=\s*Boolean\.parseBoolean\("true"\)/, "debug BuildConfig must set DEBUG=true"],
    [/FIELDWORK_BIOMETRIC_BYPASS\s*=\s*false\b/, "default debug BuildConfig must disable biometric bypass"],
    [/FIELDWORK_DEBUG_PAIRING_CODE\s*=\s*""/, "default debug BuildConfig must have an empty debug pairing code"],
  ]) {
    if (!pattern.test(text)) {
      outputFailures.push(message);
    }
  }
}

function verifyManifest(outputFailures) {
  const manifest = readManifestEvidence();
  for (const required of [
    expectedApplicationId,
    "versionCode",
    expectedVersionCode,
    "versionName",
    expectedVersionName,
    "android.permission.INTERNET",
    "android.permission.CAMERA",
    "android.permission.POST_NOTIFICATIONS",
    "android.permission.USE_BIOMETRIC",
    "firebase_messaging_auto_init_enabled",
    "firebase_analytics_collection_enabled",
    "app.fieldwork.android.push.FieldworkFirebaseMessagingService",
    "com.google.firebase.MESSAGING_EVENT",
    "FIELDWORK_OPEN_SESSION",
  ]) {
    if (!manifest.includes(required)) {
      outputFailures.push(`debug APK manifest is missing ${required}`);
    }
  }
  for (const forbidden of [
    "android.permission.ACCESS_FINE_LOCATION",
    "android.permission.ACCESS_COARSE_LOCATION",
    "android.permission.RECORD_AUDIO",
    "android.permission.READ_CONTACTS",
    "android.permission.READ_MEDIA_IMAGES",
    "android.permission.READ_EXTERNAL_STORAGE",
    "last_line",
    "session_name",
    "session_name_hash",
    "command",
  ]) {
    if (manifest.includes(forbidden)) {
      outputFailures.push(`debug APK manifest unexpectedly contains ${forbidden}`);
    }
  }
}

function readManifestEvidence() {
  const aapt = findAndroidTool("aapt");
  if (aapt) {
    const parts = [];
    let allSucceeded = true;
    for (const args of [
      ["dump", "badging", apk],
      ["dump", "permissions", apk],
      ["dump", "xmltree", apk, "AndroidManifest.xml"],
    ]) {
      const result = spawnSync(aapt, args, {
        cwd: root,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      });
      if (result.status !== 0) {
        allSucceeded = false;
        break;
      }
      parts.push(result.stdout);
    }
    if (allSucceeded) {
      return parts.join("\n");
    }
  }
  return readZipEntry(apk, "AndroidManifest.xml");
}

function findAndroidTool(tool) {
  const pathResult = spawnSync("bash", ["-lc", `command -v ${tool} 2>/dev/null || true`], {
    cwd: root,
    encoding: "utf8",
  });
  const fromPath = pathResult.stdout.trim();
  if (fromPath) {
    return fromPath;
  }

  const sdkRoots = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    path.join(osHome(), "Library/Android/sdk"),
  ].filter(Boolean);
  for (const sdkRoot of sdkRoots) {
    const buildTools = path.join(sdkRoot, "build-tools");
    if (!fs.existsSync(buildTools)) {
      continue;
    }
    const versions = fs.readdirSync(buildTools).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    for (const version of versions.reverse()) {
      const candidate = path.join(buildTools, version, tool);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

function osHome() {
  return process.env.HOME || process.cwd();
}

function verifyLegacyPairingPayloadPolicy(outputFailures) {
  const legacyPayloadPattern =
    /\{"relay_url":(?:null|"[^"\r\n]*"),"node_id":"[0-9a-f]{64}","addrs":\[[^\]\r\n]*\],"pair_token":"[A-Z2-7]{16,}","expires_at":\d+\}/;
  const dexEntries = [...entries].filter((entry) => /^classes(?:\d*)\.dex$/.test(entry));
  if (dexEntries.length === 0) {
    outputFailures.push("debug APK is missing classes.dex entries");
    return;
  }
  const match = dexEntries
    .map((entry) => readZipEntry(apk, entry))
    .find((contents) => legacyPayloadPattern.test(contents));
  if (expectLegacyPairingPayload) {
    if (!match) {
      outputFailures.push("debug APK was expected to contain a legacy JSON pairing payload but none was found");
    }
    return;
  }
  if (match) {
    outputFailures.push(
      "debug APK contains a stale legacy JSON pairing payload; rebuild :app:assembleDebug with FIELDWORK_ANDROID_PAIRING_CODE unset",
    );
  }
}

function verifyNoCrashReportingSdk(outputFailures) {
  const forbiddenMarkers = ["io/sentry", "io.sentry", "SentryAndroid", "sentry-android"];
  for (const entry of entries) {
    if (forbiddenMarkers.some((marker) => entry.toLowerCase().includes(marker.toLowerCase()))) {
      outputFailures.push(`debug APK contains forbidden Sentry SDK entry ${entry}`);
    }
  }

  const scanEntries = [...entries].filter((entry) => /^classes(?:\d*)\.dex$/.test(entry) || entry === "AndroidManifest.xml");
  for (const entry of scanEntries) {
    const contents = readZipEntry(apk, entry);
    for (const marker of forbiddenMarkers) {
      if (contents.includes(marker)) {
        outputFailures.push(`debug APK contains forbidden Sentry SDK marker ${marker} in ${entry}`);
      }
    }
  }
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
