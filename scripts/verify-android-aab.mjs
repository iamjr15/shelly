#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const args = process.argv.slice(2);
const expectUnsigned = args.includes("--expect-unsigned");
const expectSigned = args.includes("--expect-signed");
const aabArg = args.find((arg) => !arg.startsWith("--"));
const aab = path.resolve(
  root,
  aabArg || "apps/android/app/build/outputs/bundle/release/app-release.aab",
);
const requiredEntries = [
  "base/manifest/AndroidManifest.xml",
  "base/lib/arm64-v8a/libfieldwork_mobile_core.so",
  "base/lib/armeabi-v7a/libfieldwork_mobile_core.so",
  "base/lib/x86_64/libfieldwork_mobile_core.so",
];
const requiredManifestStrings = [
  "app.fieldwork.android",
  "android.permission.INTERNET",
  "android.permission.CAMERA",
  "android.permission.POST_NOTIFICATIONS",
  "android.permission.USE_BIOMETRIC",
  "io.sentry.auto-init",
  "firebase_messaging_auto_init_enabled",
  "firebase_analytics_collection_enabled",
  "allowBackup",
  "dataExtractionRules",
  "fullBackupContent",
  "app.fieldwork.android.push.FieldworkFirebaseMessagingService",
  "com.google.firebase.MESSAGING_EVENT",
  "FIELDWORK_OPEN_SESSION",
];
const forbiddenManifestStrings = [
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
];
const allowedUsesPermissions = new Set([
  "android.permission.INTERNET",
  "android.permission.CAMERA",
  "android.permission.POST_NOTIFICATIONS",
  "android.permission.USE_BIOMETRIC",
  "android.permission.USE_FINGERPRINT",
  "android.permission.ACCESS_NETWORK_STATE",
  "android.permission.WAKE_LOCK",
  "com.google.android.c2dm.permission.RECEIVE",
]);

if (!fs.existsSync(aab)) {
  fail(`Android App Bundle not found: ${path.relative(root, aab)}`);
}
if (expectUnsigned && expectSigned) {
  fail("--expect-unsigned and --expect-signed cannot be used together");
}

const result = spawnSync("unzip", ["-Z1", aab], {
  cwd: root,
  encoding: "utf8",
});
if (result.status !== 0) {
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  fail(`failed to list Android App Bundle: ${path.relative(root, aab)}`);
}

const entries = new Set(result.stdout.trim().split(/\r?\n/).filter(Boolean));
const failures = [];
for (const entry of requiredEntries) {
  if (!entries.has(entry)) {
    failures.push(`AAB is missing ${entry}`);
  }
}
if (entries.has("base/lib/x86/libfieldwork_mobile_core.so")) {
  failures.push("AAB unexpectedly includes 32-bit x86 fieldwork mobile core");
}
const signatureEntries = [...entries].filter(isJarSignatureEntry);
if (expectUnsigned) {
  if (signatureEntries.length > 0) {
    failures.push(`local AAB should be unsigned but contains signature entries: ${signatureEntries.join(", ")}`);
  }
}
if (expectSigned && signatureEntries.length === 0) {
  failures.push("release AAB should be signed but contains no META-INF signature entries");
}

const manifest = readBundleEntry("base/manifest/AndroidManifest.xml");
const usesPermissions = extractUsesPermissions(manifest);
for (const required of requiredManifestStrings) {
  if (!manifest.includes(required)) {
    failures.push(`AAB manifest is missing ${required}`);
  }
}
for (const forbidden of forbiddenManifestStrings) {
  if (manifest.includes(forbidden)) {
    failures.push(`AAB manifest unexpectedly contains ${forbidden}`);
  }
}
for (const permission of usesPermissions) {
  if (!allowedUsesPermissions.has(permission)) {
    failures.push(`AAB manifest contains unexpected uses-permission ${permission}`);
  }
}
for (const permission of allowedUsesPermissions) {
  if (!usesPermissions.has(permission)) {
    failures.push(`AAB manifest is missing expected uses-permission ${permission}`);
  }
}

if (failures.length > 0) {
  fail(failures.join("\n"));
}

console.log(
  `Android AAB ok: ${requiredEntries.slice(1).join(", ")}; packaged manifest uses-permission allowlist and privacy surface ok${expectUnsigned ? "; unsigned local bundle ok" : ""}${expectSigned ? "; signed release bundle ok" : ""}`,
);

function isJarSignatureEntry(entry) {
  return /^META-INF\/(?:MANIFEST\.MF|[^/]+\.(?:SF|RSA|DSA|EC))$/i.test(entry);
}

function readBundleEntry(entry) {
  const entryResult = spawnSync("unzip", ["-p", aab, entry], {
    cwd: root,
    encoding: "latin1",
  });
  if (entryResult.status !== 0) {
    process.stdout.write(entryResult.stdout);
    process.stderr.write(entryResult.stderr);
    fail(`failed to read ${entry} from Android App Bundle: ${path.relative(root, aab)}`);
  }
  return entryResult.stdout;
}

function extractUsesPermissions(manifest) {
  const permissions = new Set();
  for (const match of manifest.matchAll(
    /uses-permission[\s\S]{0,160}?((?:android|com\.google)[A-Za-z0-9_.$]+permission[A-Za-z0-9_.$]*)/g,
  )) {
    permissions.add(match[1]);
  }
  return permissions;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
