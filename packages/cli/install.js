#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const platform = process.env.FIELDWORK_NPM_PLATFORM || process.platform;
const arch = process.env.FIELDWORK_NPM_ARCH || process.arch;
const key = `${platform}-${arch}`;
const supported = new Set(["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"]);

if (!supported.has(key)) {
  console.error(`fieldwork: no native host binary for ${key}`);
  if (platform === "win32") {
    console.error('Windows host support is not part of v1. Install WSL2 and run "npm i -g fieldwork" inside Ubuntu.');
  } else {
    console.error("Supported v1 hosts: darwin-arm64, darwin-x64, linux-arm64, linux-x64.");
  }
  process.exit(0);
}

function resolvePlatformBinary(name) {
  try {
    return require.resolve(`fieldwork-${key}/bin/${name}`);
  } catch {
    return null;
  }
}

const fieldworkPath = resolvePlatformBinary("fieldwork");
const daemonPath = resolvePlatformBinary("fieldworkd");
if (!fieldworkPath || !daemonPath) {
  process.exit(0);
}

const binDir = path.join(__dirname, "bin");

try {
  fs.mkdirSync(binDir, { recursive: true });
  copyExecutable(fieldworkPath, path.join(binDir, "fieldwork"));
  copyExecutable(daemonPath, path.join(binDir, "fieldworkd"));
} catch (err) {
  console.warn(`fieldwork: postinstall optimization skipped (${err.code || err.message})`);
}

function copyExecutable(from, to) {
  fs.copyFileSync(from, to);
  fs.chmodSync(to, 0o755);
}
