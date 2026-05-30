#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const platforms = ["darwin-arm64", "darwin-x64"];
const binaries = ["fieldwork", "fieldworkd"];
const requiredFiles = [
  "package-identity.txt",
  "release-integrity.txt",
  "darwin-arm64-trust.txt",
  "darwin-arm64-codesign-fieldwork.txt",
  "darwin-arm64-codesign-fieldworkd.txt",
  "darwin-arm64-xattr-fieldwork.txt",
  "darwin-arm64-xattr-fieldworkd.txt",
  "darwin-x64-trust.txt",
  "darwin-x64-codesign-fieldwork.txt",
  "darwin-x64-codesign-fieldworkd.txt",
  "darwin-x64-xattr-fieldwork.txt",
  "darwin-x64-xattr-fieldworkd.txt",
  "doctor-trust.txt",
  "daemon-preflight.txt",
];
const rawArgs = process.argv.slice(2).filter((arg) => arg !== "--");
const failures = [];

if (rawArgs.length !== 1 || rawArgs[0] === "--help" || rawArgs[0] === "-h") {
  console.error("usage: node scripts/verify-macos-signing-evidence.mjs <evidence-dir>");
  process.exit(rawArgs.length === 1 ? 0 : 2);
}

const evidenceDir = path.resolve(rawArgs[0]);
requireDirectory(evidenceDir);
for (const file of requiredFiles) {
  requireFile(file);
}

if (failures.length === 0) {
  verifyPackageIdentity(readText("package-identity.txt"));
  verifyReleaseIntegrity(readText("release-integrity.txt"));
  for (const platform of platforms) {
    verifyTrustOutput(platform, readText(`${platform}-trust.txt`));
    for (const binary of binaries) {
      verifyCodesignOutput(platform, binary, readText(`${platform}-codesign-${binary}.txt`));
      verifyXattrOutput(platform, binary, readText(`${platform}-xattr-${binary}.txt`));
    }
  }
  verifyDoctorTrustOutput(readText("doctor-trust.txt"));
  verifyDaemonPreflightOutput(readText("daemon-preflight.txt"));
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(`macOS npm trust evidence ok: ${evidenceDir}`);

function verifyPackageIdentity(text) {
  requirePatternText(
    text,
    /\b(?:npm package metadata|npm ls|npm view|npm pack|package-lock\.json)\b/i,
    "package-identity.txt must identify the npm package metadata source",
  );
  for (const packageName of [
    "fieldwork",
    "fieldwork-darwin-arm64",
    "fieldwork-darwin-x64",
    "fieldwork-linux-arm64",
    "fieldwork-linux-x64",
  ]) {
    requirePatternText(
      text,
      new RegExp(`\\b${escapeRegExp(packageName)}@1\\.0\\.0\\b`, "i"),
      `package-identity.txt must prove ${packageName}@1.0.0`,
    );
  }
  requirePatternText(text, /\bbin\/fieldwork\b/, "package-identity.txt must prove the fieldwork bin entry");
  requirePatternText(text, /\bbin\/fieldworkd\b/, "package-identity.txt must prove the fieldworkd bin entry");
  if (/@fieldwork\//.test(text)) {
    failures.push("package-identity.txt must not use legacy scoped @fieldwork/* package names");
  }
  rejectContradictions("package-identity.txt", text);
  rejectForbiddenText("package-identity.txt", text);
}

function verifyReleaseIntegrity(text) {
  for (const platform of platforms) {
    const packagePattern = new RegExp(`\\bfieldwork-${escapeRegExp(platform)}(?:@1\\.0\\.0|\\.tar\\.gz)?\\b`, "i");
    requirePatternText(
      text,
      packagePattern,
      `release-integrity.txt must name fieldwork-${platform} npm package or release archive`,
    );
    requirePatternText(
      text,
      new RegExp(
        `(?:sha-?256|shasum -a 256|dist\\.integrity|integrity)[^\\n]*fieldwork-${escapeRegExp(platform)}|fieldwork-${escapeRegExp(platform)}[^\\n]*(?:sha-?256|shasum -a 256|dist\\.integrity|integrity|\\.sha256)`,
        "i",
      ),
      `release-integrity.txt must prove checksum or npm integrity verification for fieldwork-${platform}`,
    );
    requirePatternText(
      text,
      new RegExp(
        `(?:provenance|attestation|attest|sigstore|slsa|npm\\s+provenance)[^\\n]*fieldwork-${escapeRegExp(platform)}|fieldwork-${escapeRegExp(platform)}[^\\n]*(?:provenance|attestation|attest|sigstore|slsa|\\.bundle)`,
        "i",
      ),
      `release-integrity.txt must prove npm or Sigstore provenance verification for fieldwork-${platform}`,
    );
  }
  requirePatternText(
    text,
    /\b(?:provenance|attestation|attest|sigstore|slsa|npm\s+provenance)\b/i,
    "release-integrity.txt must prove npm or Sigstore provenance verification",
  );
  rejectContradictions("release-integrity.txt", text);
  rejectForbiddenText("release-integrity.txt", text);
}

function verifyTrustOutput(platform, text) {
  requirePatternText(
    text,
    /macOS npm trust ok: /i,
    `${platform}-trust.txt must include node scripts/verify-macos-signing.mjs success output`,
  );
  rejectContradictions(`${platform}-trust.txt`, text);
  rejectForbiddenText(`${platform}-trust.txt`, text);
}

function verifyCodesignOutput(platform, binary, text) {
  requirePatternText(text, new RegExp(`\\b${binary}\\b`, "i"), `${platform}-codesign-${binary}.txt must describe ${binary}`);
  if (!/\bSignature=adhoc\b/i.test(text) && !/\bAuthority=Developer ID Application:/i.test(text)) {
    failures.push(`${platform}-codesign-${binary}.txt must show an ad-hoc or Developer ID signature`);
  }
  rejectContradictions(`${platform}-codesign-${binary}.txt`, text);
  rejectForbiddenText(`${platform}-codesign-${binary}.txt`, text);
}

function verifyXattrOutput(platform, binary, text) {
  requirePatternText(
    text,
    /\bno com\.apple\.quarantine\b/i,
    `${platform}-xattr-${binary}.txt must prove com.apple.quarantine is absent`,
  );
  rejectContradictions(`${platform}-xattr-${binary}.txt`, text);
  rejectForbiddenText(`${platform}-xattr-${binary}.txt`, text);
}

function verifyDoctorTrustOutput(text) {
  requirePatternText(text, /\bFieldwork doctor\b/, "doctor-trust.txt must include fieldwork doctor output");
  requirePatternText(text, /\bmacOS trust:\s*ok\b/i, "doctor-trust.txt must show macOS trust passed");
  if (!/\bnpm\/ad-hoc\/not-notarized\b/i.test(text) && !/\bDeveloper ID\/notarized\b/i.test(text)) {
    failures.push("doctor-trust.txt must report npm/ad-hoc/not-notarized or Developer ID/notarized");
  }
  requirePatternText(text, /\bsummary:\s*ok\b/i, "doctor-trust.txt must show fieldwork doctor summary ok");
  rejectContradictions("doctor-trust.txt", text);
  rejectForbiddenText("doctor-trust.txt", text);
}

function verifyDaemonPreflightOutput(text) {
  requirePatternText(text, /\bfieldwork daemon install\b/i, "daemon-preflight.txt must show fieldwork daemon install was run");
  requirePatternText(text, /\b(?:launchd|LaunchAgent)\b/i, "daemon-preflight.txt must identify the launchd install path");
  requirePatternText(text, /\bsocket:\s*reachable\b/i, "daemon-preflight.txt must show the installed daemon socket is reachable");
  rejectContradictions("daemon-preflight.txt", text);
  rejectForbiddenText("daemon-preflight.txt", text);
}

function rejectContradictions(name, text) {
  for (const [pattern, message] of [
    [/\bmissing\b/i, `${name} must not contain missing npm trust evidence`],
    [/\bfailed\b|\bfailure\b|\berror\b/i, `${name} must not contain failed npm trust output`],
    [/\bunsigned\b/i, `${name} must not contain unsigned artifact state`],
    [/\brejected\b/i, `${name} must not contain Gatekeeper rejection output`],
    [/\bcom\.apple\.quarantine\s*[:=]\s*(?!absent|none|not present)/i, `${name} must not contain quarantine xattr values`],
  ]) {
    rejectPatternText(name, text, pattern, message);
  }
}

function rejectForbiddenText(name, text) {
  for (const [pattern, message] of [
    [/\b(?:APPLE_P12_PASSWORD|APPLE_P12_BASE64|APP_STORE_KEY_JSON)\s*[:=]\s*(?!<redacted>|redacted|REDACTED|$)\S+/i, `${name} must not contain raw Apple signing credentials`],
    [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, `${name} must not contain private keys`],
    [/\bnpm_[A-Za-z0-9]{20,}\b/, `${name} must not contain a raw npm token`],
    [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b/, `${name} must not contain a raw GitHub token`],
    [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/, `${name} must not contain a raw GitHub token`],
    [/\b(?:terminal_content|terminal_output|terminal_input|last_line|session_name|session_id|pty_output|pty_input)\b/i, `${name} must not contain terminal/session content`],
  ]) {
    rejectPatternText(name, text, pattern, message);
  }
}

function requireDirectory(dir) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    failures.push(`evidence directory does not exist: ${dir}`);
  }
}

function requireFile(file) {
  const absolute = path.join(evidenceDir, file);
  if (!fs.existsSync(absolute)) {
    failures.push(`${file} is missing`);
    return;
  }
  if (!fs.statSync(absolute).isFile()) {
    failures.push(`${file} must be a regular file`);
    return;
  }
  if (fs.statSync(absolute).size === 0) {
    failures.push(`${file} must not be empty`);
  }
}

function readText(file) {
  return fs.readFileSync(path.join(evidenceDir, file), "utf8");
}

function requireText(text, expected, message) {
  if (!text.includes(expected)) {
    failures.push(message);
  }
}

function requirePatternText(text, pattern, message) {
  if (!pattern.test(text)) {
    failures.push(message);
  }
}

function rejectPatternText(name, text, pattern, message) {
  if (pattern.test(text)) {
    failures.push(message ?? `${name} contains forbidden content matching ${pattern}`);
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
