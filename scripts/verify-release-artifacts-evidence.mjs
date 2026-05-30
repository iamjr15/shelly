#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const expectedTag = "v1.0.0";
const expectedPlatforms = [
  ["darwin-arm64", "aarch64-apple-darwin"],
  ["darwin-x64", "x86_64-apple-darwin"],
  ["linux-arm64", "aarch64-unknown-linux-gnu"],
  ["linux-x64", "x86_64-unknown-linux-gnu"],
];
const expectedAssets = expectedPlatforms.flatMap(([platform]) => [
  `fieldwork-${platform}.tar.gz`,
  `fieldwork-${platform}.tar.gz.sha256`,
  `fieldwork-${platform}.tar.gz.bundle`,
]);
const requiredFiles = [
  "workflow-run.txt",
  "github-release-assets.json",
  "artifact-files.txt",
  "verify-release-artifacts.txt",
];
const rawArgs = process.argv.slice(2).filter((arg) => arg !== "--");
const failures = [];

if (rawArgs.length !== 1 || rawArgs[0] === "--help" || rawArgs[0] === "-h") {
  console.error("usage: node scripts/verify-release-artifacts-evidence.mjs <evidence-dir>");
  process.exit(rawArgs.length === 1 ? 0 : 2);
}

const evidenceDir = path.resolve(rawArgs[0]);
requireDirectory(evidenceDir);
for (const file of requiredFiles) {
  requireFile(file);
}

if (failures.length === 0) {
  verifyWorkflowRun(readText("workflow-run.txt"));
  verifyGitHubReleaseAssets(readJson("github-release-assets.json"));
  verifyArtifactFiles(readText("artifact-files.txt"));
  verifyReleaseArtifactsOutput(readText("verify-release-artifacts.txt"));
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(`release artifact evidence ok: ${evidenceDir}`);

function verifyWorkflowRun(text) {
  for (const [pattern, message] of [
    [/\brelease-rust\.yml\b/, "workflow-run.txt must identify release-rust.yml"],
    [/\bv1\.0\.0\b/, "workflow-run.txt must identify the v1.0.0 release tag"],
    [/\b(?:conclusion|status)\s*[:=]\s*success\b/i, "workflow-run.txt must show a successful workflow run"],
    [/https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/actions\/runs\/\d+/i, "workflow-run.txt must include the GitHub Actions run URL"],
    [/\bid[-_ ]token\s*[:=]\s*write\b/i, "workflow-run.txt must show id-token write permission for Sigstore"],
    [/\bcosign attest-blob\b/i, "workflow-run.txt must show cosign attest-blob execution"],
    [/\bslsaprovenance1\b/i, "workflow-run.txt must show SLSA provenance attestation type"],
    [/\bsoftprops\/action-gh-release@v2\b/i, "workflow-run.txt must show GitHub Release asset upload"],
  ]) {
    requirePatternText(text, pattern, message);
  }
  for (const [platform, target] of expectedPlatforms) {
    requireText(text, platform, `workflow-run.txt must include release package ${platform}`);
    requireText(text, target, `workflow-run.txt must include Rust target ${target}`);
  }
  rejectReleaseContradictions("workflow-run.txt", text);
  rejectForbiddenText("workflow-run.txt", text);
}

function verifyGitHubReleaseAssets(release) {
  if (release?.tagName !== expectedTag && release?.tag_name !== expectedTag) {
    failures.push(`github-release-assets.json must describe ${expectedTag}`);
  }
  if (release?.isDraft === true || release?.draft === true) {
    failures.push("github-release-assets.json must not describe a draft release");
  }
  if (release?.isPrerelease === true || release?.prerelease === true) {
    failures.push("github-release-assets.json must not describe a prerelease");
  }
  const assets = Array.isArray(release) ? release : release?.assets;
  if (!Array.isArray(assets)) {
    failures.push("github-release-assets.json must contain an assets array");
    return;
  }
  const byName = new Map(assets.map((asset) => [asset?.name, asset]));
  for (const name of expectedAssets) {
    const asset = byName.get(name);
    if (!asset) {
      failures.push(`github-release-assets.json must include ${name}`);
      continue;
    }
    if (Number(asset.size ?? asset.sizeInBytes ?? 0) <= 0) {
      failures.push(`${name} must have a positive release asset size`);
    }
  }
  rejectForbiddenText("github-release-assets.json", JSON.stringify(release));
}

function verifyArtifactFiles(text) {
  for (const name of expectedAssets) {
    requireText(text, name, `artifact-files.txt must include ${name}`);
  }
  for (const [platform] of expectedPlatforms) {
    const archive = `fieldwork-${platform}.tar.gz`;
    requirePatternText(
      text,
      new RegExp(`(?:[0-9a-f]{64}[^\\n]*${escapeRegExp(archive)}|${escapeRegExp(archive)}[^\\n]*[0-9a-f]{64})`, "i"),
      `artifact-files.txt must include a SHA-256 digest for ${archive}`,
    );
  }
  rejectReleaseContradictions("artifact-files.txt", text);
  rejectForbiddenText("artifact-files.txt", text);
}

function verifyReleaseArtifactsOutput(text) {
  for (const needle of [
    "FIELDWORK_VERIFY_COSIGN_SIGNATURE=1",
    "FIELDWORK_EXPECTED_RELEASE_TAG=v1.0.0",
    "FIELDWORK_COSIGN_IDENTITY_REGEXP=",
    "release-rust\\.yml@refs/tags/v.*",
    "release artifacts ok: archives, sha256 files, and cosign attestation bundles verified",
  ]) {
    requireText(text, needle, `verify-release-artifacts.txt must include ${needle}`);
  }
  rejectReleaseContradictions("verify-release-artifacts.txt", text);
  rejectForbiddenText("verify-release-artifacts.txt", text);
}

function rejectReleaseContradictions(name, text) {
  for (const [pattern, message] of [
    [/\bmissing\b/i, `${name} must not contain missing release artifact evidence`],
    [/\bfailed\b|\bfailure\b|\berror\b/i, `${name} must not contain failed release artifact output`],
    [/\b--dry-run\b|\bdry-run\b/i, `${name} must not use dry-run output as release artifact evidence`],
    [/\bunverified\b/i, `${name} must not contain unverified artifact state`],
    [/\bplaceholder\b/i, `${name} must not contain placeholder artifact state`],
  ]) {
    rejectPatternText(name, text, pattern, message);
  }
}

function rejectForbiddenText(name, text) {
  for (const [pattern, message] of [
    [/\bnpm_[A-Za-z0-9]{20,}\b/, `${name} must not contain a raw npm token`],
    [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b/, `${name} must not contain a raw GitHub token`],
    [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/, `${name} must not contain a raw GitHub token`],
    [/\b(?:NPM_TOKEN|NODE_AUTH_TOKEN|GITHUB_TOKEN|GH_TOKEN)\s*[:=]\s*(?!<redacted>|redacted|REDACTED|$)\S+/i, `${name} must not contain raw auth tokens`],
    [/\b(?:APPLE_P12_PASSWORD|APP_STORE_KEY_JSON|APPLE_P12_BASE64)\s*[:=]\s*(?!<redacted>|redacted|REDACTED|$)\S+/i, `${name} must not contain Apple signing credentials`],
    [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, `${name} must not contain private keys`],
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

function readJson(file) {
  try {
    return JSON.parse(readText(file));
  } catch (error) {
    failures.push(`${file} must be valid JSON: ${error.message}`);
    return null;
  }
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
