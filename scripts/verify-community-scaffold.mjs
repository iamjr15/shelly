#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const failures = [];

const files = {
  contributing: read("CONTRIBUTING.md"),
  security: read("SECURITY.md"),
  codeOfConduct: read("CODE_OF_CONDUCT.md"),
  license: read("LICENSE"),
  notice: read("NOTICE"),
  prTemplate: read(".github/PULL_REQUEST_TEMPLATE.md"),
  bugTemplate: read(".github/ISSUE_TEMPLATE/bug.yml"),
  featureTemplate: read(".github/ISSUE_TEMPLATE/feature.yml"),
  questionTemplate: read(".github/ISSUE_TEMPLATE/question.yml"),
  preCommit: read(".pre-commit-config.yaml"),
};

verifyRootCommunityDocs();
verifyPullRequestTemplate();
verifyIssueTemplates();
verifyPreCommitGate();

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log("community scaffold ok");

function verifyRootCommunityDocs() {
  requireText(files.contributing, "Fieldwork is built from `PLAN.md`", "CONTRIBUTING.md must keep PLAN.md as the contribution contract");
  requireText(files.contributing, "AGPL-3.0-or-later", "CONTRIBUTING.md must state the contribution license");
  requireText(files.contributing, "Apple App Store distribution additional permission", "CONTRIBUTING.md must mention the NOTICE App Store permission");
  for (const command of [
    "cargo fmt --check",
    "cargo clippy --workspace -- -D warnings",
    "cargo nextest run --workspace",
    "cargo test --workspace --doc",
    "node scripts/verify-secret-boundaries.mjs",
    "node scripts/verify-v1-boundary.mjs",
  ]) {
    requireText(files.contributing, command, `CONTRIBUTING.md must ask contributors to run ${command}`);
  }
  requireText(files.contributing, "Run the focused verifier for the area you touched", "CONTRIBUTING.md must ask contributors to run focused local verifiers");
  requireText(files.contributing, "Stream raw PTY bytes", "CONTRIBUTING.md must preserve the raw-byte terminal invariant");
  requireText(files.contributing, "Reject session creation and killing from non-local clients", "CONTRIBUTING.md must preserve the mobile capability boundary");
  requireText(files.contributing, "npm is the only v1 desktop install/update path", "CONTRIBUTING.md must preserve npm-only distribution");

  requireText(files.security, "Report security issues privately", "SECURITY.md must direct private security reports");
  requireText(files.security, "GitHub private vulnerability reporting", "SECURITY.md must identify the current private reporting path");
  for (const invariant of [
    "Unix socket file mode `0600`",
    "`CreateSession` and `KillSession` authorization restricted to `LocalCli`",
    "Pair tokens are 32 random bytes",
    "encrypted `redb` stores",
    "iOS and Android app sources gate resume and stale input",
    "Relay push payloads reject terminal content fields",
  ]) {
    requireText(files.security, invariant, `SECURITY.md must document security invariant: ${invariant}`);
  }

  requireText(files.codeOfConduct, "Contributor Covenant Code of Conduct, version 2.1", "CODE_OF_CONDUCT.md must identify the Contributor Covenant version");
  requireText(files.codeOfConduct, "GitHub private vulnerability reporting", "CODE_OF_CONDUCT.md must identify the current abuse-report fallback");

  requireText(files.license, "GNU AFFERO GENERAL PUBLIC LICENSE", "LICENSE must be AGPL");
  requireText(files.license, "Version 3, 19 November 2007", "LICENSE must include AGPLv3 text");
  requireText(files.notice, "Additional Permission for Apple App Store Distribution", "NOTICE must include the App Store/TestFlight permission");
  requireText(files.notice, "GNU AGPLv3 section 7", "NOTICE must tie the additional permission to AGPLv3 section 7");
  requireText(files.notice, "https://github.com/fieldwork-app/fieldwork", "NOTICE must publish the canonical source URL");
}

function verifyPullRequestTemplate() {
  for (const section of ["## Summary", "## Verification", "## v1 Boundaries", "## External Gates"]) {
    requireText(files.prTemplate, section, `.github/PULL_REQUEST_TEMPLATE.md must include ${section}`);
  }
  for (const command of [
    "`cargo fmt --check`",
    "`cargo clippy --workspace -- -D warnings`",
    "`cargo nextest run --workspace`",
    "`cargo test --workspace --doc`",
  ]) {
    requireText(files.prTemplate, command, `.github/PULL_REQUEST_TEMPLATE.md must require checkbox ${command}`);
  }
  for (const boundary of [
    "Mobile still cannot create sessions, kill sessions, or choose commands",
    "Push payloads and notification UI remain content-free and generic",
    "npm remains the only desktop install/update path",
    "Future-only work stays in `FUTURE.md`",
  ]) {
    requireText(files.prTemplate, boundary, `.github/PULL_REQUEST_TEMPLATE.md must preserve v1 boundary: ${boundary}`);
  }
  requireText(files.prTemplate, "credentials, provider accounts, signing assets", ".github/PULL_REQUEST_TEMPLATE.md must make external gates explicit");
  requireText(files.prTemplate, "hosted infrastructure, or physical devices", ".github/PULL_REQUEST_TEMPLATE.md must make hosted/device gates explicit");
}

function verifyIssueTemplates() {
  requireText(files.bugTemplate, "name: Bug report", "bug issue template must be named");
  requireText(files.bugTemplate, 'labels: ["bug"]', "bug issue template must apply the bug label");
  requireYamlField(files.bugTemplate, "id: summary", "bug issue template must collect a summary");
  requireYamlField(files.bugTemplate, "id: reproduce", "bug issue template must collect reproduction steps");
  requireYamlField(files.bugTemplate, "id: expected", "bug issue template must collect expected behavior");
  requireYamlField(files.bugTemplate, "id: logs", "bug issue template must collect logs");
  requireText(files.bugTemplate, "Remove terminal content or secrets first", "bug issue template must warn against leaking terminal content/secrets");
  requirePattern(files.bugTemplate, /id: reproduce[\s\S]*?required: true/, "bug reproduction field must be required");

  requireText(files.featureTemplate, "name: Feature request", "feature issue template must be named");
  requireText(files.featureTemplate, 'labels: ["enhancement"]', "feature issue template must apply the enhancement label");
  requireYamlField(files.featureTemplate, "id: problem", "feature issue template must collect the problem");
  requireYamlField(files.featureTemplate, "id: proposal", "feature issue template must collect the proposal");
  requireYamlField(files.featureTemplate, "id: scope", "feature issue template must collect a scope check");
  requireText(files.featureTemplate, "fits v1 or belongs in FUTURE.md", "feature issue template must steer v1/FUTURE scope decisions");
  requirePattern(files.featureTemplate, /id: problem[\s\S]*?required: true/, "feature problem field must be required");
  requirePattern(files.featureTemplate, /id: proposal[\s\S]*?required: true/, "feature proposal field must be required");

  requireText(files.questionTemplate, "name: Question", "question issue template must be named");
  requireText(files.questionTemplate, 'labels: ["question"]', "question issue template must apply the question label");
  requireYamlField(files.questionTemplate, "id: question", "question issue template must collect the question");
  requireYamlField(files.questionTemplate, "id: context", "question issue template must collect context");
  requireText(files.questionTemplate, "Include OS, install method, command, or app version", "question issue template must request actionable environment context");
  requirePattern(files.questionTemplate, /id: question[\s\S]*?required: true/, "question field must be required");
}

function verifyPreCommitGate() {
  requireText(files.preCommit, "repo: local", ".pre-commit-config.yaml must use local hooks");
  for (const hook of [
    ["cargo-fmt-check", "cargo fmt --check"],
    ["cargo-clippy-workspace", "cargo clippy --workspace -- -D warnings"],
    ["cargo-nextest-workspace", "cargo nextest run --workspace --no-fail-fast"],
    ["fieldwork-secret-boundaries", "node scripts/verify-secret-boundaries.mjs"],
  ]) {
    const [id, entry] = hook;
    requireText(files.preCommit, `id: ${id}`, `.pre-commit-config.yaml must include hook ${id}`);
    requireText(files.preCommit, `entry: ${entry}`, `.pre-commit-config.yaml hook ${id} must run ${entry}`);
  }
  const alwaysRunCount = [...files.preCommit.matchAll(/always_run: true/g)].length;
  if (alwaysRunCount < 4) {
    failures.push(".pre-commit-config.yaml must make all four release-critical hooks always_run");
  }
  const noFilenameCount = [...files.preCommit.matchAll(/pass_filenames: false/g)].length;
  if (noFilenameCount < 4) {
    failures.push(".pre-commit-config.yaml must disable filename passing for all workspace hooks");
  }
}

function read(rel) {
  const absolute = path.join(root, rel);
  if (!fs.existsSync(absolute)) {
    failures.push(`${rel} is missing`);
    return "";
  }
  return fs.readFileSync(absolute, "utf8");
}

function requireText(text, needle, message) {
  if (!text.includes(needle)) {
    failures.push(message);
  }
}

function requirePattern(text, pattern, message) {
  if (!pattern.test(text)) {
    failures.push(message);
  }
}

function requireYamlField(text, needle, message) {
  requirePattern(text, new RegExp(`^\\s*${escapeRegExp(needle)}\\s*$`, "m"), message);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
