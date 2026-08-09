#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const checkOnly = process.argv.includes("--check");
const unexpectedArgs = process.argv.slice(2).filter((arg) => arg !== "--check");
const workspacePackages = [
  "shelly-cli",
  "shelly-daemon",
  "shelly-mobile-core",
  "shelly-protocol",
  "shelly-relay",
];

assert(unexpectedArgs.length === 0, `unexpected arguments: ${unexpectedArgs.join(" ")}`);

const releaseVersion = readJson("packages/cli/package.json").version;
assert(/^\d+\.\d+\.\d+$/.test(releaseVersion), `expected a stable semver release, got ${releaseVersion}`);

if (!checkOnly) {
  syncRootPackage(releaseVersion);
  syncCargoManifest(releaseVersion);
  refreshCargoLock();
}

checkVersions(releaseVersion);
console.log(`release versions ${checkOnly ? "match" : "synced to"} ${releaseVersion}`);

function syncRootPackage(version) {
  const filePath = path.join(root, "package.json");
  const manifest = JSON.parse(fs.readFileSync(filePath, "utf8"));
  manifest.version = version;
  fs.writeFileSync(filePath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function syncCargoManifest(version) {
  const filePath = path.join(root, "Cargo.toml");
  const original = fs.readFileSync(filePath, "utf8");
  const versionPattern = /(\[workspace\.package\][\s\S]*?^version\s*=\s*")[^"]+("\s*$)/m;
  assert(versionPattern.test(original), "Cargo.toml is missing [workspace.package].version");
  fs.writeFileSync(filePath, original.replace(versionPattern, `$1${version}$2`));
}

function refreshCargoLock() {
  const result = spawnSync("cargo", ["metadata", "--format-version", "1", "--no-deps"], {
    cwd: root,
    encoding: "utf8",
  });

  if (result.status !== 0) {
    process.stdout.write(result.stdout || "");
    process.stderr.write(result.stderr || "");
    fail("cargo metadata could not refresh Cargo.lock");
  }
}

function checkVersions(version) {
  const rootVersion = readJson("package.json").version;
  assert(rootVersion === version, `package.json version ${rootVersion} does not match npm release ${version}`);

  const cargoManifest = fs.readFileSync(path.join(root, "Cargo.toml"), "utf8");
  const cargoVersion = cargoManifest.match(/\[workspace\.package\][\s\S]*?^version\s*=\s*"([^"]+)"/m)?.[1];
  assert(cargoVersion === version, `Cargo.toml workspace version ${cargoVersion ?? "<missing>"} does not match npm release ${version}`);

  const lockPackages = parseCargoLock();
  for (const packageName of workspacePackages) {
    const lockVersion = lockPackages.get(packageName);
    assert(lockVersion === version, `Cargo.lock ${packageName} version ${lockVersion ?? "<missing>"} does not match npm release ${version}`);
  }
}

function parseCargoLock() {
  const lockfile = fs.readFileSync(path.join(root, "Cargo.lock"), "utf8");
  const packages = new Map();

  for (const block of lockfile.split(/\n(?=\[\[package\]\]\n)/)) {
    const name = block.match(/^name = "([^"]+)"$/m)?.[1];
    const version = block.match(/^version = "([^"]+)"$/m)?.[1];
    if (name && version) {
      packages.set(name, version);
    }
  }

  return packages;
}

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8"));
}

function assert(condition, message) {
  if (!condition) {
    fail(message);
  }
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
