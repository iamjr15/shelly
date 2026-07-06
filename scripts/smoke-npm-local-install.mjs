#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  assertIncludes,
  cleanPackageManagerEnv,
  packPackage,
  requireExecutable,
  run,
} from "./lib/npm-test-util.mjs";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const supportedHosts = new Set(["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"]);
const hostKey = `${process.platform}-${process.arch}`;
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "shelly-npm-local-install-"));

try {
  if (!supportedHosts.has(hostKey)) {
    throw new Error(`unsupported v1 npm host: ${hostKey}`);
  }

  const platformDir = path.join(root, "packages", `cli-${hostKey}`);
  const metaDir = path.join(root, "packages", "cli");
  requireExecutable(path.join(platformDir, "bin", "shelly"));
  requireExecutable(path.join(platformDir, "bin", "shellyd"));

  const packDir = path.join(tempRoot, "packs");
  const projectDir = path.join(tempRoot, "project");
  const homeDir = path.join(tempRoot, "home");
  const runtimeDir = path.join(tempRoot, "runtime");
  const configDir = path.join(tempRoot, "config");
  const stateDir = path.join(tempRoot, "state");
  fs.mkdirSync(packDir, { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, "package.json"), `${JSON.stringify({ private: true }, null, 2)}\n`);

  const platformPack = packPackage(npm, platformDir, packDir, { cwd: root });
  const metaPack = packPackage(npm, metaDir, packDir, { cwd: root });
  run(
    npm,
    [
      "install",
      "--package-lock=false",
      "--no-audit",
      "--no-fund",
      platformPack,
      metaPack,
    ],
    { cwd: projectDir, env: isolatedEnv({ homeDir, runtimeDir, configDir, stateDir }) },
  );

  const installedBinDir = path.join(projectDir, "node_modules", "shellykit", "bin");
  const installedShelly = path.join(installedBinDir, "shelly");
  const installedDaemon = path.join(installedBinDir, "shellyd");
  requireExecutable(installedShelly);
  requireExecutable(installedDaemon);
  rejectJsFallback(installedShelly);
  rejectJsFallback(installedDaemon);

  const binDir = path.join(projectDir, "node_modules", ".bin");
  const shellyBin = path.join(binDir, "shelly");
  const daemonBin = path.join(binDir, "shellyd");
  requireExecutable(shellyBin);
  requireExecutable(daemonBin);

  assertIncludes(run(shellyBin, ["version"], { cwd: projectDir, env: isolatedEnv({ homeDir, runtimeDir, configDir, stateDir }) }).stdout, "shelly", "shelly version output");
  assertIncludes(run(shellyBin, ["doctor", "--help"], { cwd: projectDir, env: isolatedEnv({ homeDir, runtimeDir, configDir, stateDir }) }).stdout, "Usage: shelly doctor", "shelly doctor help");
  assertIncludes(run(daemonBin, ["--help"], { cwd: projectDir, env: isolatedEnv({ homeDir, runtimeDir, configDir, stateDir }) }).stdout, "Usage:", "shellyd help");

  if (process.platform === "darwin") {
    assertDarwinTrust(installedShelly);
    assertDarwinTrust(installedDaemon);
  }

  console.log(`npm local install smoke ok: shellykit + shellykit-${hostKey}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

function isolatedEnv({ homeDir, runtimeDir, configDir, stateDir }) {
  return cleanPackageManagerEnv({
    ...process.env,
    HOME: homeDir,
    XDG_RUNTIME_DIR: runtimeDir,
    XDG_CONFIG_HOME: configDir,
    XDG_STATE_HOME: stateDir,
    SHELLY_SCROLLBACK_ENCRYPTION_ENABLED: "false",
  });
}

function rejectJsFallback(file) {
  const firstBytes = fs.readFileSync(file).subarray(0, 64).toString("utf8");
  if (firstBytes.startsWith("#!/usr/bin/env node")) {
    throw new Error(`${file} still contains the JS dispatcher fallback after postinstall`);
  }
}

function assertDarwinTrust(file) {
  run("codesign", ["--verify", "--verbose=2", file], { cwd: root });
  const quarantine = spawnSync("xattr", ["-p", "com.apple.quarantine", file], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (quarantine.status === 0) {
    throw new Error(`${file} still has com.apple.quarantine metadata`);
  }
}
