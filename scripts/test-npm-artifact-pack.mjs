#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const npmBin = process.platform === "win32" ? "npm.cmd" : "npm";
const platforms = [
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64",
  "linux-x64",
];

const backupRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fieldwork-native-package-backup-"));
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fieldwork-native-package-fixture-"));

try {
  backupNativeBins();
  createFixtureArtifacts();
  run(process.execPath, ["scripts/prepare-npm-artifacts.mjs"], {
    env: { ...process.env, FIELDWORK_ARTIFACT_DIR: fixtureRoot },
  });
  run(process.execPath, ["scripts/verify-npm-packages.mjs", "--require-binaries"]);

  for (const platform of platforms) {
    assertNativePackagePack(platform);
  }
  assertMetaPackagePack();
  run(process.execPath, ["scripts/publish-npm-packages.mjs", "--dry-run"]);
  expectFailure(process.execPath, ["scripts/publish-npm-packages.mjs", "--check-ready"], {}, "must be a native Mach-O or ELF binary before publish");
  expectFailure(
    process.execPath,
    ["scripts/publish-npm-packages.mjs"],
    { env: publishBlockedEnv() },
    "must be a native Mach-O or ELF binary before publish",
  );

  const missingPlatformRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fieldwork-native-package-missing-"));
  try {
    createFixtureArtifacts(missingPlatformRoot, ["darwin-arm64"]);
    expectFailure(process.execPath, ["scripts/prepare-npm-artifacts.mjs"], {
      env: { ...process.env, FIELDWORK_ARTIFACT_DIR: missingPlatformRoot },
    }, "missing extracted artifact directory for darwin-x64");
  } finally {
    fs.rmSync(missingPlatformRoot, { recursive: true, force: true });
  }

  console.log("npm native artifact preparation and package dry-run ok");
} finally {
  restoreNativeBins();
  fs.rmSync(backupRoot, { recursive: true, force: true });
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}

function backupNativeBins() {
  for (const platform of platforms) {
    const binDir = nativeBinDir(platform);
    if (!fs.existsSync(binDir)) {
      continue;
    }
    const backupDir = path.join(backupRoot, platform, "bin");
    fs.mkdirSync(path.dirname(backupDir), { recursive: true });
    fs.cpSync(binDir, backupDir, { recursive: true });
    fs.rmSync(binDir, { recursive: true, force: true });
  }
}

function restoreNativeBins() {
  for (const platform of platforms) {
    const binDir = nativeBinDir(platform);
    fs.rmSync(binDir, { recursive: true, force: true });

    const backupDir = path.join(backupRoot, platform, "bin");
    if (fs.existsSync(backupDir)) {
      fs.mkdirSync(path.dirname(binDir), { recursive: true });
      fs.cpSync(backupDir, binDir, { recursive: true });
    }
  }
}

function createFixtureArtifacts(rootDir = fixtureRoot, platformNames = platforms) {
  for (const platform of platformNames) {
    const artifactDir = path.join(rootDir, `fieldwork-${platform}`);
    fs.mkdirSync(artifactDir, { recursive: true });
    writeExecutable(path.join(artifactDir, "fieldwork"), `#!/bin/sh\necho fieldwork-${platform}\n`);
    writeExecutable(path.join(artifactDir, "fieldworkd"), `#!/bin/sh\necho fieldworkd-${platform}\n`);
  }
}

function publishBlockedEnv() {
  const home = path.join(fixtureRoot, "blocked-npm-home");
  const userconfig = path.join(fixtureRoot, "blocked-npmrc");
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(userconfig, "");
  return {
    ...process.env,
    HOME: home,
    NODE_AUTH_TOKEN: "fieldwork-test-token",
    NPM_CONFIG_REGISTRY: "http://127.0.0.1:9",
    NPM_CONFIG_USERCONFIG: userconfig,
  };
}

function assertNativePackagePack(platform) {
  const packageDir = path.join(root, "packages", `cli-${platform}`);
  const result = run(npmBin, ["pack", packageDir, "--dry-run", "--json"]);
  const packs = JSON.parse(result.stdout);
  const files = filesByPath(packs);
  assertExecutablePackFile(files, "bin/fieldwork", `${platform} pack`);
  assertExecutablePackFile(files, "bin/fieldworkd", `${platform} pack`);
  assert(files.has("LICENSE"), `${platform} pack is missing LICENSE`);
  assert(files.has("NOTICE"), `${platform} pack is missing NOTICE`);
}

function assertMetaPackagePack() {
  const packageDir = path.join(root, "packages", "cli");
  const result = run(npmBin, ["pack", packageDir, "--dry-run", "--json"]);
  const packs = JSON.parse(result.stdout);
  const files = filesByPath(packs);
  assertExecutablePackFile(files, "bin/fieldwork", "meta pack");
  assertExecutablePackFile(files, "bin/fieldworkd", "meta pack");
  assert(files.has("install.js"), "meta pack is missing install.js");
  assert(files.has("README.md"), "meta pack is missing README.md");
  assert(files.has("LICENSE"), "meta pack is missing LICENSE");
  assert(files.has("NOTICE"), "meta pack is missing NOTICE");
}

function filesByPath(packs) {
  return new Map((packs[0]?.files || []).map((file) => [file.path, file]));
}

function assertExecutablePackFile(files, filePath, label) {
  const entry = files.get(filePath);
  assert(entry, `${label} is missing ${filePath}`);
  assert((entry.mode & 0o111) !== 0, `${label} ${filePath} is not executable`);
}

function writeExecutable(file, contents) {
  fs.writeFileSync(file, contents);
  fs.chmodSync(file, 0o755);
}

function nativeBinDir(platform) {
  return path.join(root, "packages", `cli-${platform}`, "bin");
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    ...options,
  });
  if (result.status !== 0) {
    console.error(result.stdout);
    console.error(result.stderr);
    throw new Error(`${command} ${args.join(" ")} failed with status ${result.status ?? 1}`);
  }
  return result;
}

function expectFailure(command, args, options, expectedStderr) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    ...options,
  });
  if (result.status === 0) {
    console.error("expected command to fail, but it passed");
    process.exit(1);
  }
  if (!result.stderr.includes(expectedStderr)) {
    console.error(result.stdout);
    console.error(result.stderr);
    console.error(`expected stderr to include: ${expectedStderr}`);
    process.exit(1);
  }
}

function assert(condition, message) {
  if (!condition) {
    console.error(message);
    process.exit(1);
  }
}
