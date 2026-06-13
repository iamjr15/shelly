#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const platform = process.env.SHELLY_NPM_PLATFORM || process.platform;
const arch = process.env.SHELLY_NPM_ARCH || process.arch;
const key = `${platform}-${arch}`;
const supported = new Set(["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"]);

if (!supported.has(key)) {
  console.error(`shelly: no native host binary for ${key}`);
  if (platform === "win32") {
    console.error('Windows host support is not part of v1. Install WSL2 and run "npm i -g shellykit" inside Ubuntu.');
  } else {
    console.error("Supported v1 hosts: darwin-arm64, darwin-x64, linux-arm64, linux-x64.");
  }
  process.exit(0);
}

function resolvePlatformBinary(name) {
  try {
    return require.resolve(`shellykit-${key}/bin/${name}`);
  } catch {
    return null;
  }
}

const shellyPath = resolvePlatformBinary("shelly");
const daemonPath = resolvePlatformBinary("shellyd");
if (!shellyPath || !daemonPath) {
  process.exit(0);
}

const binDir = path.join(__dirname, "bin");

try {
  fs.mkdirSync(binDir, { recursive: true });
  const installedShelly = path.join(binDir, "shelly");
  const installedDaemon = path.join(binDir, "shellyd");
  copyExecutable(shellyPath, installedShelly);
  copyExecutable(daemonPath, installedDaemon);
  prepareMacosTrust(installedShelly);
  prepareMacosTrust(installedDaemon);
} catch (err) {
  console.warn(`shelly: postinstall optimization skipped (${err.code || err.message})`);
}

function copyExecutable(from, to) {
  fs.copyFileSync(from, to);
  fs.chmodSync(to, 0o755);
}

function prepareMacosTrust(file) {
  if (platform !== "darwin") {
    return;
  }
  bestEffort("codesign", ["--force", "--sign", "-", file]);
  bestEffort("xattr", ["-d", "com.apple.quarantine", file], { ignoreFailurePattern: /No such xattr/i });
}

function bestEffort(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.error) {
    console.warn(`shelly: macOS npm trust prep skipped ${command} (${result.error.message})`);
    return;
  }
  if (result.status !== 0) {
    const detail = `${result.stdout || ""}${result.stderr || ""}`.trim();
    if (options.ignoreFailurePattern?.test(detail)) {
      return;
    }
    console.warn(
      `shelly: macOS npm trust prep skipped ${command} (exit ${result.status}${detail ? `: ${detail}` : ""})`,
    );
  }
}
