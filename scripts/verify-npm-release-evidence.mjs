#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const expectedPackages = [
  ["fieldwork-darwin-arm64", "packages/cli-darwin-arm64"],
  ["fieldwork-darwin-x64", "packages/cli-darwin-x64"],
  ["fieldwork-linux-arm64", "packages/cli-linux-arm64"],
  ["fieldwork-linux-x64", "packages/cli-linux-x64"],
  ["fieldwork", "packages/cli"],
];
const expectedPackageNames = new Set(expectedPackages.map(([name]) => name));
const expectedVersion = "1.0.0";
const rawArgs = process.argv.slice(2).filter((arg) => arg !== "--");
const requiredFiles = [
  "publish-plan.json",
  "publish-readiness.txt",
  "workflow-run.txt",
  "npm-publish-log.txt",
  "registry-state.txt",
  "package-metadata.json",
];
const failures = [];

if (rawArgs.length !== 1 || rawArgs[0] === "--help" || rawArgs[0] === "-h") {
  console.error("usage: node scripts/verify-npm-release-evidence.mjs <evidence-dir>");
  process.exit(rawArgs.length === 1 ? 0 : 2);
}

const evidenceDir = path.resolve(rawArgs[0]);
requireDirectory(evidenceDir);
for (const file of requiredFiles) {
  requireFile(file);
}

if (failures.length === 0) {
  verifyPublishPlan(readJson("publish-plan.json"));
  verifyPublishReadiness(readText("publish-readiness.txt"));
  verifyWorkflowRun(readText("workflow-run.txt"));
  verifyPublishLog(readText("npm-publish-log.txt"));
  verifyRegistryState(readText("registry-state.txt"));
  verifyPackageMetadata(readJson("package-metadata.json"));
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(`npm release evidence ok: ${evidenceDir}`);

function verifyPublishPlan(plan) {
  if (plan?.command !== (process.platform === "win32" ? "npm.cmd" : "npm") && plan?.command !== "npm") {
    failures.push("publish-plan.json must use npm as the publish command");
  }
  if (!Array.isArray(plan?.packages)) {
    failures.push("publish-plan.json must contain a packages array");
    return;
  }
  if (plan.packages.length !== expectedPackages.length) {
    failures.push("publish-plan.json must contain exactly five package entries");
    return;
  }
  for (let index = 0; index < expectedPackages.length; index += 1) {
    const [name, packageDir] = expectedPackages[index];
    const entry = plan.packages[index];
    if (entry?.name !== name) {
      failures.push(`publish-plan.json package ${index} must be ${name}`);
      continue;
    }
    if (entry.packageDir !== packageDir) {
      failures.push(`${name} must publish from ${packageDir}`);
    }
    const args = entry.args || [];
    if (!Array.isArray(args)) {
      failures.push(`${name} publish args must be an array`);
      continue;
    }
    requireArrayContains(args, "publish", `${name} publish args must include npm publish`);
    requireArrayContains(args, "--provenance", `${name} publish args must enable npm provenance`);
    requireArrayContains(args, "--access", `${name} publish args must set public access`);
    requireArrayContains(args, "public", `${name} publish args must set public access`);
    if (!args.some((arg) => String(arg).endsWith(packageDir))) {
      failures.push(`${name} publish args must include ${packageDir}`);
    }
  }
  rejectForbiddenText("publish-plan.json", JSON.stringify(plan));
}

function verifyPublishReadiness(text) {
  requireText(text, "npm publish readiness ok:", "publish-readiness.txt must come from publish-npm-packages --check-ready");
  requireOrderedPackages("publish-readiness.txt", text);
  rejectReleaseContradictions("publish-readiness.txt", text);
  rejectForbiddenText("publish-readiness.txt", text);
}

function verifyWorkflowRun(text) {
  for (const [pattern, message] of [
    [/\brelease-npm\.yml\b/, "workflow-run.txt must identify release-npm.yml"],
    [/\bv?1\.0\.0\b/, "workflow-run.txt must identify the v1.0.0 release tag"],
    [/\b(?:conclusion|status)\s*[:=]\s*success\b/i, "workflow-run.txt must show a successful workflow run"],
    [/https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/actions\/runs\/\d+/i, "workflow-run.txt must include the GitHub Actions run URL"],
    [/\bNPM_TOKEN\s*[:=]\s*<redacted>/i, "workflow-run.txt must prove NPM_TOKEN was present only as redacted secret evidence"],
    [/\bprovenance\s*[:=]\s*enabled\b/i, "workflow-run.txt must prove npm provenance was enabled"],
    [/\bchildren[- ]first\b/i, "workflow-run.txt must document children-first publishing"],
  ]) {
    requirePatternText(text, pattern, message);
  }
  rejectReleaseContradictions("workflow-run.txt", text);
  rejectForbiddenText("workflow-run.txt", text);
}

function verifyPublishLog(text) {
  requireOrderedPackages("npm-publish-log.txt", text);
  for (const [name] of expectedPackages) {
    requirePatternText(text, new RegExp(`\\b${escapeRegExp(name)}@${escapeRegExp(expectedVersion)}\\b`), `npm-publish-log.txt must include ${name}@${expectedVersion}`);
  }
  requireText(text, "--provenance", "npm-publish-log.txt must show provenance publishing");
  requireText(text, "--access public", "npm-publish-log.txt must show public access publishing");
  rejectReleaseContradictions("npm-publish-log.txt", text);
  rejectForbiddenText("npm-publish-log.txt", text);
}

function verifyRegistryState(text) {
  requireText(text, "npm registry-state ok", "registry-state.txt must come from verify-npm-registry-state success output");
  for (const [name] of expectedPackages) {
    requirePatternText(
      text,
      new RegExp(`published:\\s+${escapeRegExp(name)}@${escapeRegExp(expectedVersion)}\\s+\\(provenance:\\s+https://slsa\\.dev/provenance/v1\\)`, "i"),
      `registry-state.txt must show ${name}@${expectedVersion} with npm SLSA provenance`,
    );
  }
  rejectReleaseContradictions("registry-state.txt", text);
  rejectForbiddenText("registry-state.txt", text);
}

function verifyPackageMetadata(metadata) {
  const packages = Array.isArray(metadata) ? metadata : metadata?.packages;
  if (!Array.isArray(packages)) {
    failures.push("package-metadata.json must contain a packages array");
    return;
  }
  if (packages.length !== expectedPackages.length) {
    failures.push("package-metadata.json must contain exactly the five v1 npm packages");
  }
  const byName = new Map(packages.map((entry) => [entry?.name, entry]));
  for (const entry of packages) {
    if (!expectedPackageNames.has(entry?.name)) {
      failures.push(`package-metadata.json must not include non-v1 npm package ${entry?.name ?? "<missing name>"}`);
    }
  }
  for (const [name] of expectedPackages) {
    const entry = byName.get(name);
    if (!entry) {
      failures.push(`package-metadata.json must include ${name}`);
      continue;
    }
    const latest = entry?.["dist-tags"]?.latest ?? entry?.distTags?.latest ?? entry?.version;
    if (latest !== expectedVersion) {
      failures.push(`${name} latest metadata version must be ${expectedVersion}`);
    }
    const versionMetadata = entry?.versions?.[expectedVersion] ?? entry;
    const predicateType =
      versionMetadata?.dist?.attestations?.provenance?.predicateType ??
      entry?.dist?.attestations?.provenance?.predicateType;
    if (predicateType !== "https://slsa.dev/provenance/v1") {
      failures.push(`${name}@${expectedVersion} package metadata must include npm SLSA provenance`);
    }
  }
  rejectForbiddenText("package-metadata.json", JSON.stringify(metadata));
}

function requireOrderedPackages(name, text) {
  let last = -1;
  for (const [packageName] of expectedPackages) {
    const index = indexOfPackageToken(text, packageName);
    if (index === -1) {
      failures.push(`${name} must include ${packageName}`);
      continue;
    }
    if (index <= last) {
      failures.push(`${name} must list packages in children-first order`);
    }
    last = index;
  }
}

function indexOfPackageToken(text, packageName) {
  const pattern = new RegExp(`(^|[^A-Za-z0-9_-])${escapeRegExp(packageName)}(?![A-Za-z0-9_-])`);
  const match = pattern.exec(text);
  if (!match) {
    return -1;
  }
  return match.index + match[1].length;
}

function rejectReleaseContradictions(name, text) {
  for (const [pattern, message] of [
    [/\b0\.0\.0\b/, `${name} must not describe placeholder version 0.0.0 as release evidence`],
    [/\bunpublished\b/i, `${name} must not contain unpublished package state`],
    [/\bmissing\b/i, `${name} must not contain missing release evidence`],
    [/\bfailed\b|\bfailure\b|\berror\b/i, `${name} must not contain failed release output`],
    [/\b--dry-run\b|\bdry-run\b/i, `${name} must not use dry-run output as release evidence`],
  ]) {
    rejectPatternText(name, text, pattern, message);
  }
}

function rejectForbiddenText(name, text) {
  rejectUnexpectedFieldworkPackageTokens(name, text);
  for (const [pattern, message] of [
    [/\bnpm_[A-Za-z0-9]{20,}\b/, `${name} must not contain a raw npm token`],
    [/\b(?:NPM_TOKEN|NODE_AUTH_TOKEN)\s*[:=]\s*(?!<redacted>|redacted|REDACTED|$)\S+/i, `${name} must not contain a raw npm auth token`],
    [/\b_authToken\s*=\s*(?!<redacted>|redacted|REDACTED|$)\S+/i, `${name} must not contain .npmrc auth material`],
    [/\/\/registry\.npmjs\.org\/:_authToken=/i, `${name} must not contain .npmrc auth material`],
    [/\b(?:password|otp|one[-_ ]time[-_ ]password)\s*[:=]\s*(?!<redacted>|redacted|REDACTED|$)\S+/i, `${name} must not contain npm password or OTP material`],
    [/\b(?:email|username)\s*[:=]\s*(?!<redacted>|redacted|REDACTED|$)\S+/i, `${name} must not contain npm user identity`],
    [/@fieldwork\/[A-Za-z0-9._-]+/, `${name} must not contain legacy scoped @fieldwork/* package names; v1 publishes only unscoped npm packages`],
    [/\b(?:terminal_content|terminal_output|terminal_input|last_line|session_name|session_id|pty_output|pty_input)\b/i, `${name} must not contain terminal/session content`],
  ]) {
    rejectPatternText(name, text, pattern, message);
  }
}

function rejectUnexpectedFieldworkPackageTokens(name, text) {
  const pattern = /\bfieldwork-[a-z0-9]+-[a-z0-9]+(?:-[a-z0-9]+)*\b/g;
  for (const match of text.matchAll(pattern)) {
    const packageName = match[0];
    if (!expectedPackageNames.has(packageName)) {
      failures.push(`${name} must not contain non-v1 Fieldwork npm package ${packageName}; v1 publishes exactly five npm packages`);
    }
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

function requireArrayContains(values, expected, message) {
  if (!values.includes(expected)) {
    failures.push(message);
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
