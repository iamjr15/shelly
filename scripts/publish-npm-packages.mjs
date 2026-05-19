#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const dryRun = process.argv.includes("--dry-run");
const checkReady = process.argv.includes("--check-ready");
const printPublishPlanJson = process.argv.includes("--publish-plan-json");
const npmBin = process.platform === "win32" ? "npm.cmd" : "npm";
const publishOrder = [
  "packages/cli-darwin-arm64",
  "packages/cli-darwin-x64",
  "packages/cli-linux-arm64",
  "packages/cli-linux-x64",
  "packages/cli",
];

const expectedNames = [
  "fieldwork-darwin-arm64",
  "fieldwork-darwin-x64",
  "fieldwork-linux-arm64",
  "fieldwork-linux-x64",
  "fieldwork",
];

if (!dryRun && !checkReady && !printPublishPlanJson && !process.env.NODE_AUTH_TOKEN) {
  fail("NODE_AUTH_TOKEN is required for npm publish");
}

verifyPackageGraph();

if (printPublishPlanJson) {
  process.stdout.write(`${JSON.stringify(publishPlan(), null, 2)}\n`);
  process.exit(0);
}

if (checkReady) {
  for (const packageDir of publishOrder) {
    assertPublishReady(packageDir);
  }
  console.log(`npm publish readiness ok: ${expectedNames.join(" -> ")}`);
  process.exit(0);
}

for (const packageDir of publishOrder) {
  if (dryRun) {
    dryRunPack(packageDir);
  } else {
    assertPublishReady(packageDir);
    publish(packageDir);
  }
}

console.log(`npm publish order ${dryRun ? "dry-run " : ""}ok: ${expectedNames.join(" -> ")}`);

function verifyPackageGraph() {
  const meta = readJson("packages/cli/package.json");
  assert(meta.name === "fieldwork", "meta package name must be fieldwork");

  const optional = meta.optionalDependencies || {};
  for (let index = 0; index < publishOrder.length; index += 1) {
    const packageDir = publishOrder[index];
    const expectedName = expectedNames[index];
    const manifest = readJson(path.join(packageDir, "package.json"));
    assert(manifest.name === expectedName, `${packageDir} has unexpected package name ${manifest.name}`);
    assert(manifest.publishConfig?.access === "public", `${expectedName} must publish with public access`);
    assert(manifest.license === "AGPL-3.0-or-later", `${expectedName} must be AGPL-3.0-or-later`);

    if (expectedName !== "fieldwork") {
      assert(optional[expectedName] === meta.version, `${expectedName} must be an optionalDependency of fieldwork`);
      assert(manifest.version === meta.version, `${expectedName} version must match fieldwork`);
    }
  }
}

function dryRunPack(packageDir) {
  const result = run(npmBin, ["pack", path.join(root, packageDir), "--dry-run", "--json"]);
  const packs = JSON.parse(result.stdout);
  const files = new Map((packs[0]?.files || []).map((file) => [file.path, file]));
  const packageName = readJson(path.join(packageDir, "package.json")).name;

  if (packageName === "fieldwork") {
    assertExecutablePackFile(files, "bin/fieldwork", packageName);
    assertExecutablePackFile(files, "bin/fieldworkd", packageName);
    assert(files.has("install.js"), `${packageName} pack is missing install.js`);
    assert(files.has("README.md"), `${packageName} pack is missing README.md`);
  } else {
    assertExecutablePackFile(files, "bin/fieldwork", packageName);
    assertExecutablePackFile(files, "bin/fieldworkd", packageName);
  }
}

function assertPublishReady(packageDir) {
  dryRunPack(packageDir);

  const packageName = readJson(path.join(packageDir, "package.json")).name;
  if (packageName === "fieldwork") {
    return;
  }

  assertNativeBinary(path.join(packageDir, "bin", "fieldwork"), packageName);
  assertNativeBinary(path.join(packageDir, "bin", "fieldworkd"), packageName);
}

function assertNativeBinary(filePath, packageName) {
  const bytes = fs.readFileSync(filePath);
  const isElf = bytes.length >= 4 && bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46;
  const isMachO =
    bytes.length >= 4 &&
    ((bytes[0] === 0xcf && bytes[1] === 0xfa && bytes[2] === 0xed && bytes[3] === 0xfe) ||
      (bytes[0] === 0xfe && bytes[1] === 0xed && bytes[2] === 0xfa && bytes[3] === 0xcf) ||
      (bytes[0] === 0xca && bytes[1] === 0xfe && bytes[2] === 0xba && bytes[3] === 0xbe) ||
      (bytes[0] === 0xbe && bytes[1] === 0xba && bytes[2] === 0xfe && bytes[3] === 0xca));
  assert(isElf || isMachO, `${packageName} ${path.relative(root, filePath)} must be a native Mach-O or ELF binary before publish`);
}

function assertExecutablePackFile(files, filePath, packageName) {
  const entry = files.get(filePath);
  assert(entry, `${packageName} pack is missing ${filePath}`);
  assert((entry.mode & 0o111) !== 0, `${packageName} pack ${filePath} is not executable`);
}

function publish(packageDir) {
  run(npmBin, publishArgs(packageDir));
}

function publishPlan() {
  return {
    command: npmBin,
    packages: publishOrder.map((packageDir, index) => ({
      name: expectedNames[index],
      packageDir,
      args: publishArgs(packageDir),
    })),
  };
}

function publishArgs(packageDir) {
  return ["publish", path.join(root, packageDir), "--provenance", "--access", "public"];
}

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8"));
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      LC_ALL: "C",
      LANG: "C",
    },
  });
  if (result.status !== 0) {
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }
  return result;
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
