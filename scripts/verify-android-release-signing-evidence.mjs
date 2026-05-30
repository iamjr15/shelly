#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const rawArgs = process.argv.slice(2).filter((arg) => arg !== "--");
const failures = [];

if (rawArgs.length !== 1 || rawArgs[0] === "--help" || rawArgs[0] === "-h") {
  console.error("usage: node scripts/verify-android-release-signing-evidence.mjs <evidence-dir>");
  process.exit(rawArgs.length === 1 ? 0 : 2);
}

const evidenceDir = path.resolve(rawArgs[0]);
const requiredFiles = [
  "artifact-signing.txt",
  "jarsigner.txt",
  "sha256.txt",
  "buildconfig.txt",
  "workflow-run.txt",
];

requireDirectory(evidenceDir);
for (const file of requiredFiles) {
  requireFile(file);
}

if (failures.length === 0) {
  verifyArtifactSigning(readText("artifact-signing.txt"));
  verifyJarsigner(readText("jarsigner.txt"));
  verifySha256(readText("sha256.txt"));
  verifyBuildConfig(readText("buildconfig.txt"));
  verifyWorkflowRun(readText("workflow-run.txt"));
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(`Android release signing evidence ok: ${evidenceDir}`);

function verifyArtifactSigning(text) {
  requirePatternText(
    text,
    /\bAndroid AAB ok\b[\s\S]*\bsigned release bundle ok\b[\s\S]*\brelease relay control URL ok\b/,
    "artifact-signing.txt must be output from node scripts/verify-android-aab.mjs --expect-signed --expect-relay-control-url",
  );
  requirePatternText(
    text,
    /\bbase\/lib\/arm64-v8a\/libfieldwork_mobile_core\.so\b/,
    "artifact-signing.txt must prove arm64-v8a is present",
  );
  requirePatternText(
    text,
    /\bbase\/lib\/armeabi-v7a\/libfieldwork_mobile_core\.so\b/,
    "artifact-signing.txt must prove armeabi-v7a is present",
  );
  requirePatternText(
    text,
    /\bbase\/lib\/x86_64\/libfieldwork_mobile_core\.so\b/,
    "artifact-signing.txt must prove x86_64 is present",
  );
  rejectCommonBadSigningText(text, "artifact-signing.txt");
}

function verifyJarsigner(text) {
  requirePatternText(text, /\bjar verified\b/i, "jarsigner.txt must contain jar verified");
  requirePatternText(
    text,
    /\b(?:X\.509|certificate|Certificate|CN=)\b/,
    "jarsigner.txt must include certificate details from jarsigner -verify -certs",
  );
  rejectCommonBadSigningText(text, "jarsigner.txt");
}

function verifySha256(text) {
  requirePatternText(text, /^[0-9a-f]{64}\s+.*\.aab$/m, "sha256.txt must hash the signed release AAB");
}

function verifyBuildConfig(text) {
  const checks = [
    [/\bAPPLICATION_ID\s*=\s*"app\.fieldwork\.android"/, "buildconfig.txt must prove application id app.fieldwork.android"],
    [/\bBUILD_TYPE\s*=\s*"release"/, "buildconfig.txt must prove release build type"],
    [/\bDEBUG\s*=\s*false\b/, "buildconfig.txt must prove DEBUG=false"],
    [/\bVERSION_CODE\s*=\s*1\b/, "buildconfig.txt must prove VERSION_CODE=1"],
    [/\bVERSION_NAME\s*=\s*"1\.0"/, "buildconfig.txt must prove VERSION_NAME=1.0"],
    [/\bFIELDWORK_BIOMETRIC_BYPASS\s*=\s*false\b/, "buildconfig.txt must prove biometric bypass is disabled"],
    [/\bFIELDWORK_DEBUG_PAIRING_CODE\s*=\s*""/, "buildconfig.txt must prove debug pairing code is empty"],
    [
      /\bFIELDWORK_RELAY_CONTROL_URL\s*=\s*"https:\/\/[^"]+"/,
      "buildconfig.txt must prove FIELDWORK_RELAY_CONTROL_URL is an https:// relay control endpoint",
    ],
  ];
  for (const [pattern, message] of checks) {
    requirePatternText(text, pattern, message);
  }
}

function verifyWorkflowRun(text) {
  requirePatternText(text, /\brelease-android\.yml\b/, "workflow-run.txt must identify release-android.yml");
  requirePatternText(text, /\b(?:tag|ref)=android-v\d+\.\d+\.\d+\b/i, "workflow-run.txt must identify an android-v* release tag/ref");
  requirePatternText(text, /\b(?:run_id|run-url|workflow_url)=\S+/i, "workflow-run.txt must include the GitHub Actions run id or URL");
  rejectPatternText(text, /\b(?:debug|local smoke|Fieldwork Release Smoke)\b/i, "workflow-run.txt must not describe local/debug smoke evidence");
}

function rejectCommonBadSigningText(text, file) {
  rejectPatternText(text, /\bAndroid Debug\b|\bCN\s*=\s*Android Debug\b/i, `${file} must not use the Android debug certificate`);
  rejectPatternText(text, /\bFieldwork Release Smoke\b/i, `${file} must not use the local ephemeral release-smoke certificate`);
  rejectPatternText(text, /\bjar is unsigned\b|\bunsigned\b/i, `${file} must not describe an unsigned bundle`);
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
