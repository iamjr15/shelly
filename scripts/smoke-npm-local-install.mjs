#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const supportedHosts = new Set(["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"]);
const hostKey = `${process.platform}-${process.arch}`;
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "shelly-npm-local-install-"));

try {
  if (!supportedHosts.has(hostKey)) {
    fail(`unsupported v1 npm host: ${hostKey}`);
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

  const platformPack = packPackage(platformDir, packDir);
  const metaPack = packPackage(metaDir, packDir);
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
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

function packPackage(packageDir, packDir) {
  const result = run(npm, ["pack", packageDir, "--pack-destination", packDir, "--json"], {
    cwd: root,
    env: cleanNpmEnv(process.env),
  });
  let packs;
  try {
    packs = JSON.parse(result.stdout);
  } catch (error) {
    fail(`could not parse npm pack JSON for ${packageDir}: ${error.message}\n${result.stdout}`);
  }
  const filename = packs?.[0]?.filename;
  if (!filename) {
    fail(`npm pack did not report a tarball filename for ${packageDir}`);
  }
  const tarball = path.join(packDir, filename);
  if (!fs.existsSync(tarball)) {
    fail(`npm pack tarball missing: ${tarball}`);
  }
  return tarball;
}

function isolatedEnv({ homeDir, runtimeDir, configDir, stateDir }) {
  return cleanNpmEnv({
    ...process.env,
    HOME: homeDir,
    XDG_RUNTIME_DIR: runtimeDir,
    XDG_CONFIG_HOME: configDir,
    XDG_STATE_HOME: stateDir,
    SHELLY_SCROLLBACK_ENCRYPTION_ENABLED: "false",
  });
}

function cleanNpmEnv(env) {
  const cleaned = { ...env };
  for (const key of [
    "npm_config_supported_architectures",
    "npm_config_npm_globalconfig",
    "npm_config_verify_deps_before_run",
    "npm_config__jsr_registry",
  ]) {
    delete cleaned[key];
  }
  return cleaned;
}

function requireExecutable(file) {
  if (!fs.existsSync(file)) {
    fail(`expected executable is missing: ${file}`);
  }
  const stat = fs.statSync(file);
  if (!stat.isFile() && !stat.isSymbolicLink?.()) {
    fail(`expected a file executable, got something else: ${file}`);
  }
  if ((stat.mode & 0o111) === 0) {
    fail(`expected executable bit on ${file}`);
  }
}

function rejectJsFallback(file) {
  const firstBytes = fs.readFileSync(file).subarray(0, 64).toString("utf8");
  if (firstBytes.startsWith("#!/usr/bin/env node")) {
    fail(`${file} still contains the JS dispatcher fallback after postinstall`);
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
    fail(`${file} still has com.apple.quarantine metadata`);
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
  if (result.error) {
    fail(`${command} ${args.join(" ")} failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    fail(`${command} ${args.join(" ")} failed with exit ${result.status}${output ? `\n${output}` : ""}`);
  }
  return result;
}

function assertIncludes(text, expected, label) {
  if (!text.includes(expected)) {
    fail(`${label} must include ${JSON.stringify(expected)}, got:\n${text}`);
  }
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
