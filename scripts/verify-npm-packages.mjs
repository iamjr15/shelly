#!/usr/bin/env node

import fs from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const requireBinaries = process.argv.includes("--require-binaries");
const gitignore = fs.readFileSync(path.join(root, ".gitignore"), "utf8");
const workspaceConfig = fs.readFileSync(path.join(root, "pnpm-workspace.yaml"), "utf8");
const rootLicense = fs.readFileSync(path.join(root, "LICENSE"), "utf8");
const rootNotice = fs.readFileSync(path.join(root, "NOTICE"), "utf8");
const metaReadme = fs.readFileSync(path.join(root, "packages/cli/README.md"), "utf8");
const repositoryUrl = "git+https://github.com/fieldwork-app/fieldwork.git";
const platforms = [
  { key: "darwin-arm64", os: "darwin", cpu: "arm64" },
  { key: "darwin-x64", os: "darwin", cpu: "x64" },
  { key: "linux-arm64", os: "linux", cpu: "arm64" },
  { key: "linux-x64", os: "linux", cpu: "x64" },
];

const meta = readJson("packages/cli/package.json");
const rootPackage = readJson("package.json");
assert(rootLicense.includes("GNU AFFERO GENERAL PUBLIC LICENSE"), "root LICENSE must be full AGPL text");
assert(rootLicense.includes("Version 3, 19 November 2007"), "root LICENSE must be AGPLv3 text");
assert(rootNotice.includes("AGPL-3.0-or-later"), "root NOTICE must preserve AGPL license statement");
assert(
  rootNotice.includes("Additional Permission for Apple App Store Distribution"),
  "root NOTICE must preserve App Store/TestFlight additional permission heading",
);
assert(
  rootNotice.includes("GNU AGPLv3 section 7") && rootNotice.includes("https://github.com/fieldwork-app/fieldwork"),
  "root NOTICE must preserve AGPL section-7 source-availability wording",
);
assert(
  rootPackage.scripts?.["test:bun-install"] === "node scripts/test-bun-install.mjs",
  "root package must expose test:bun-install for Bun compatibility CI",
);
for (const ignoredArtifact of ["/packages/cli-*/bin/fieldwork", "/packages/cli-*/bin/fieldworkd"]) {
  assert(
    gitignore.includes(ignoredArtifact),
    `.gitignore must keep generated platform package artifact ${ignoredArtifact} out of source control`,
  );
}
assertNoTrackedGeneratedNativeBins();
for (const required of [
  '  - "packages/*"',
  "supportedArchitectures:",
  "    - darwin",
  "    - linux",
  "    - arm64",
  "    - x64",
]) {
  assert(workspaceConfig.includes(required), `pnpm-workspace.yaml must include ${required.trim()}`);
}
assert(meta.name === "fieldwork", "meta package name must be fieldwork");
assert(meta.version === "1.0.0", "meta package version must be 1.0.0 for v1 release artifacts");
assertNpmLegalMetadata(meta, "packages/cli/package.json", "packages/cli");
assertMetaReadme();
assert(meta.bin?.fieldwork === "bin/fieldwork", "meta package must expose bin/fieldwork");
assert(meta.bin?.fw === "bin/fieldwork", "meta package must expose fw as a short alias for bin/fieldwork");
assert(meta.bin?.fieldworkd === "bin/fieldworkd", "meta package must expose bin/fieldworkd");
assert(meta.scripts?.postinstall === "node install.js", "meta package must run install.js postinstall");
assert(meta.preferUnplugged === true, "meta package should prefer unplugged installs");
assert(meta.publishConfig?.access === "public", "meta package must publish with public access");
assert(
  arrayEquals(meta.files, ["bin/fieldwork", "bin/fieldworkd", "install.js", "README.md", "LICENSE", "NOTICE"]),
  "meta package must ship dispatchers, install script, README, LICENSE, and NOTICE",
);

const optional = meta.optionalDependencies || {};
for (const platform of platforms) {
  const packageName = `fieldwork-${platform.key}`;
  assert(optional[packageName] === meta.version, `${packageName} optionalDependency must match meta version`);

  const packageJsonPath = `packages/cli-${platform.key}/package.json`;
  const pkg = readJson(packageJsonPath);
  assert(pkg.name === packageName, `${packageJsonPath} has wrong name`);
  assertNpmLegalMetadata(pkg, packageJsonPath, `packages/cli-${platform.key}`);
  assert(pkg.version === meta.version, `${packageName} version must match meta`);
  assert(pkg.preferUnplugged === true, `${packageName} must set preferUnplugged`);
  assert(pkg.publishConfig?.access === "public", `${packageName} must publish with public access`);
  assert(arrayEquals(pkg.os, [platform.os]), `${packageName} must set os ${platform.os}`);
  assert(arrayEquals(pkg.cpu, [platform.cpu]), `${packageName} must set cpu ${platform.cpu}`);
  assert(
    arrayEquals(pkg.files, ["bin/fieldwork", "bin/fieldworkd", "LICENSE", "NOTICE"]),
    `${packageName} must ship both binaries plus LICENSE and NOTICE`,
  );

  if (requireBinaries) {
    assertExecutable(`packages/cli-${platform.key}/bin/fieldwork`);
    assertExecutable(`packages/cli-${platform.key}/bin/fieldworkd`);
    assertMatchesRoot(`packages/cli-${platform.key}/LICENSE`, "LICENSE");
    assertMatchesRoot(`packages/cli-${platform.key}/NOTICE`, "NOTICE");
  }
}

assertExecutable("packages/cli/bin/fieldwork");
assertExecutable("packages/cli/bin/fieldworkd");
assert(fs.existsSync(path.join(root, "packages/cli/install.js")), "install.js is missing");
if (requireBinaries) {
  assertMatchesRoot("packages/cli/LICENSE", "LICENSE");
  assertMatchesRoot("packages/cli/NOTICE", "NOTICE");
}

console.log(`npm package metadata ok${requireBinaries ? " with binary artifacts" : ""}`);

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8"));
}

function assert(condition, message) {
  if (!condition) {
    console.error(message);
    process.exit(1);
  }
}

function arrayEquals(actual, expected) {
  return Array.isArray(actual) && actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

function assertExecutable(relativePath) {
  const absolute = path.join(root, relativePath);
  assert(fs.existsSync(absolute), `${relativePath} is missing`);
  const mode = fs.statSync(absolute).mode;
  assert((mode & 0o111) !== 0, `${relativePath} is not executable`);
}

function assertNpmLegalMetadata(pkg, packageJsonPath, directory) {
  assert(pkg.license === "AGPL-3.0-or-later", `${packageJsonPath} must be AGPL-3.0-or-later`);
  assert(pkg.repository?.type === "git", `${packageJsonPath} repository type must be git`);
  assert(pkg.repository?.url === repositoryUrl, `${packageJsonPath} repository URL must point to Fieldwork`);
  assert(pkg.repository?.directory === directory, `${packageJsonPath} repository directory must be ${directory}`);
}

function assertMatchesRoot(relativePath, rootFile) {
  const absolute = path.join(root, relativePath);
  assert(fs.existsSync(absolute), `${relativePath} is missing`);
  const expected = fs.readFileSync(path.join(root, rootFile), "utf8");
  const actual = fs.readFileSync(absolute, "utf8");
  assert(actual === expected, `${relativePath} must match root ${rootFile}`);
}

function assertNoTrackedGeneratedNativeBins() {
  const generatedBinPaths = platforms.flatMap((platform) => [
    `packages/cli-${platform.key}/bin/fieldwork`,
    `packages/cli-${platform.key}/bin/fieldworkd`,
  ]);
  const tracked = execFileSync("git", ["ls-files", "--", ...generatedBinPaths], {
    cwd: root,
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .filter(Boolean);
  assert(
    tracked.length === 0,
    `generated platform package binaries must not be tracked: ${tracked.join(", ")}`,
  );
}

function assertMetaReadme() {
  const normalizedReadme = metaReadme.replace(/\s+/g, " ");
  const requiredText = [
    "Your terminal sessions, from anywhere.",
    "npm i -g fieldwork",
    "The unscoped `fieldwork` package is the v1 desktop install and update path.",
    "`fieldwork`: the user-facing CLI",
    "`fw`: a shorter alias for the same user-facing CLI",
    "`fw` alias accepts the same arguments",
    "`fieldworkd`: the local daemon that owns PTYs, pairing, replay, and transport",
    "fieldwork daemon install",
    "fw pair",
    "fw",
    "fw refactoringjob",
    "fw new --name shell bash",
    "fw new bash",
    "fw attach <session-id>",
    "Mobile clients can pair, list sessions, attach, send input, resize, detach, and register push tokens.",
    "Mobile clients cannot create or kill sessions.",
    "Running `fieldwork` or `fw` with no subcommand creates and attaches a default `claude` session",
    "attaches the only existing session, or lists sessions when several are available.",
    "Running `fw refactoringjob` attaches that named session when it exists",
    "creates and attaches a default `claude` PTY named `refactoringjob`",
    "No-name default sessions get generated one-word names like `waffle` or `kazoo`",
    "same daemon session name appears in the mobile app dashboard",
    "fieldwork-darwin-arm64",
    "fieldwork-darwin-x64",
    "fieldwork-linux-arm64",
    "fieldwork-linux-x64",
    "postinstall scripts",
    "shipped dispatchers still run the matching platform binaries",
    "WSL2",
    "Local persistence is encrypted by default with an OS-keychain-held key",
    "Keychain prompts are only for local key material",
    "terminal output, keystrokes, commands, paths, session names, and push tokens are not stored there",
    "do not include terminal content, commands, paths, or session names",
  ];
  for (const needle of requiredText) {
    assert(normalizedReadme.includes(needle), `packages/cli/README.md must document npm package behavior: ${needle}`);
  }
  for (const forbiddenText of ["Temporary npm publish availability check", "availability check"]) {
    assert(!metaReadme.includes(forbiddenText), `packages/cli/README.md must not contain placeholder text: ${forbiddenText}`);
  }
}
