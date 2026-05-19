#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fieldwork-android-aab-verifier-"));

try {
  const unsigned = writeAab("unsigned", { signed: false });
  run([unsigned], "unsigned synthetic AAB should pass content checks");
  run(["--expect-unsigned", unsigned], "unsigned synthetic AAB should pass unsigned-local checks");

  const signed = writeAab("signed", { signed: true });
  run([signed], "signed synthetic AAB should pass content checks when signature policy is not requested");
  expectFailure(
    ["--expect-unsigned", signed],
    "local AAB should be unsigned but contains signature entries",
    "signed synthetic AAB must fail local unsigned-policy checks",
  );

  const forbiddenPermission = writeAab("forbidden-permission", {
    signed: false,
    extraPermissions: ["android.permission.ACCESS_FINE_LOCATION"],
  });
  expectFailure(
    [forbiddenPermission],
    "AAB manifest unexpectedly contains android.permission.ACCESS_FINE_LOCATION",
    "synthetic AAB with location permission must fail manifest privacy checks",
  );

  const missingPermission = writeAab("missing-permission", {
    signed: false,
    omitPermissions: ["android.permission.POST_NOTIFICATIONS"],
  });
  expectFailure(
    [missingPermission],
    "AAB manifest is missing expected uses-permission android.permission.POST_NOTIFICATIONS",
    "synthetic AAB missing notification permission must fail required-permission checks",
  );

  const terminalContent = writeAab("terminal-content", {
    signed: false,
    extraManifestText: '<meta-data android:name="last_line" android:value="secret" />',
  });
  expectFailure(
    [terminalContent],
    "AAB manifest unexpectedly contains last_line",
    "synthetic AAB with terminal-content metadata must fail manifest privacy checks",
  );

  console.log("android AAB verifier test ok");
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

function writeAab(name, options) {
  const dir = path.join(tempRoot, name);
  const aab = path.join(tempRoot, `${name}.aab`);
  for (const rel of [
    "base/manifest",
    "base/lib/arm64-v8a",
    "base/lib/armeabi-v7a",
    "base/lib/x86_64",
  ]) {
    fs.mkdirSync(path.join(dir, rel), { recursive: true });
  }
  fs.writeFileSync(path.join(dir, "base/manifest/AndroidManifest.xml"), manifestFixture(options));
  for (const rel of [
    "base/lib/arm64-v8a/libfieldwork_mobile_core.so",
    "base/lib/armeabi-v7a/libfieldwork_mobile_core.so",
    "base/lib/x86_64/libfieldwork_mobile_core.so",
  ]) {
    fs.writeFileSync(path.join(dir, rel), `synthetic ${rel}\n`);
  }
  if (options.signed) {
    fs.mkdirSync(path.join(dir, "META-INF"), { recursive: true });
    fs.writeFileSync(path.join(dir, "META-INF/MANIFEST.MF"), "Manifest-Version: 1.0\n");
    fs.writeFileSync(path.join(dir, "META-INF/FIELDWORK.SF"), "Signature-Version: 1.0\n");
    fs.writeFileSync(path.join(dir, "META-INF/FIELDWORK.RSA"), "synthetic signature\n");
  }
  const result = spawnSync("zip", ["-qr", aab, "."], { cwd: dir, encoding: "utf8" });
  if (result.status !== 0) {
    fail(`failed to create synthetic AAB ${name}`, result);
  }
  return aab;
}

function manifestFixture(options = {}) {
  const omitted = new Set(options.omitPermissions || []);
  const permissions = [
    "android.permission.INTERNET",
    "android.permission.CAMERA",
    "android.permission.POST_NOTIFICATIONS",
    "android.permission.USE_BIOMETRIC",
    "android.permission.USE_FINGERPRINT",
    "android.permission.ACCESS_NETWORK_STATE",
    "android.permission.WAKE_LOCK",
    "com.google.android.c2dm.permission.RECEIVE",
    ...(options.extraPermissions || []),
  ]
    .filter((permission) => !omitted.has(permission))
    .map((permission) => `<uses-permission android:name="${permission}" />`)
    .join("\n");

  return `
<manifest package="app.fieldwork.android">
${permissions}
<application allowBackup="false" dataExtractionRules="@xml/data_extraction_rules" fullBackupContent="@xml/backup_rules">
  <meta-data android:name="io.sentry.auto-init" android:value="false" />
  <meta-data android:name="firebase_messaging_auto_init_enabled" android:value="false" />
  <meta-data android:name="firebase_analytics_collection_enabled" android:value="false" />
  ${options.extraManifestText || ""}
  <service android:name="app.fieldwork.android.push.FieldworkFirebaseMessagingService">
    <intent-filter>
      <action android:name="com.google.firebase.MESSAGING_EVENT" />
      <action android:name="FIELDWORK_OPEN_SESSION" />
    </intent-filter>
  </service>
</application>
</manifest>
`.trim();
}

function run(args, message) {
  const result = spawnSync(process.execPath, ["scripts/verify-android-aab.mjs", ...args], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    fail(message, result);
  }
  if (!result.stdout.includes("Android AAB ok")) {
    fail(`${message}: missing success marker`, result);
  }
}

function expectFailure(args, expectedOutput, message) {
  const result = spawnSync(process.execPath, ["scripts/verify-android-aab.mjs", ...args], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.status === 0) {
    fail(`${message}: command unexpectedly passed`, result);
  }
  const combined = `${result.stdout}\n${result.stderr}`;
  if (!combined.includes(expectedOutput)) {
    fail(`${message}: expected output to include ${expectedOutput}`, result);
  }
}

function fail(message, result) {
  console.error(message);
  console.error(result?.stdout || "");
  console.error(result?.stderr || "");
  process.exit(1);
}
