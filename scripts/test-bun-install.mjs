#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "shelly-bun-install-"));
const backupRoot = fs.mkdtempSync(path.join(os.tmpdir(), "shelly-bun-install-bin-backup-"));
const cases = [
  { platform: "darwin", arch: "arm64", key: "darwin-arm64" },
  { platform: "darwin", arch: "x64", key: "darwin-x64" },
  { platform: "linux", arch: "arm64", key: "linux-arm64" },
  { platform: "linux", arch: "x64", key: "linux-x64" },
];

let exitCode = 0;
let usingFixtureBins = false;

try {
  ensurePlatformBins();

  const version = run("bun", ["--version"], { cwd: tempRoot }).stdout.trim();
  if (!version) {
    fail("bun --version returned an empty version");
  }

  const packDir = path.join(tempRoot, "packs");
  fs.mkdirSync(packDir, { recursive: true });
  const metaPack = packPackage(path.join(root, "packages", "cli"), packDir);
  const platformPacks = new Map(
    cases.map((testCase) => [
      testCase.key,
      packPackage(path.join(root, "packages", `cli-${testCase.key}`), packDir),
    ]),
  );

  for (const testCase of cases) {
    runCase(testCase, metaPack, platformPacks.get(testCase.key));
  }

  console.log(`bun Shelly package install ok (${cases.length} platform cases, bun ${version})`);
} catch (error) {
  console.error(error.message);
  exitCode = 1;
} finally {
  restorePlatformBins();
  fs.rmSync(backupRoot, { recursive: true, force: true });
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

process.exitCode = exitCode;

function ensurePlatformBins() {
  const missingBins = cases.some(({ key }) => {
    const binDir = path.join(root, "packages", `cli-${key}`, "bin");
    return !fs.existsSync(path.join(binDir, "shelly")) || !fs.existsSync(path.join(binDir, "shellyd"));
  });
  if (!missingBins) {
    return;
  }

  usingFixtureBins = true;
  for (const { key } of cases) {
    const binDir = path.join(root, "packages", `cli-${key}`, "bin");
    if (fs.existsSync(binDir)) {
      const backupDir = path.join(backupRoot, key, "bin");
      fs.mkdirSync(path.dirname(backupDir), { recursive: true });
      fs.cpSync(binDir, backupDir, { recursive: true });
      fs.rmSync(binDir, { recursive: true, force: true });
    }
    fs.mkdirSync(binDir, { recursive: true });
    writeExecutable(path.join(binDir, "shelly"), `#!/bin/sh\necho shelly-${key}\n`);
    writeExecutable(
      path.join(binDir, "shellyd"),
      `#!/bin/sh\nif [ "$1" = "--help" ]; then echo "Usage: shellyd"; else echo shellyd-${key}; fi\n`,
    );
  }
}

function restorePlatformBins() {
  if (!usingFixtureBins) {
    return;
  }

  for (const { key } of cases) {
    const binDir = path.join(root, "packages", `cli-${key}`, "bin");
    fs.rmSync(binDir, { recursive: true, force: true });

    const backupDir = path.join(backupRoot, key, "bin");
    if (fs.existsSync(backupDir)) {
      fs.mkdirSync(path.dirname(binDir), { recursive: true });
      fs.cpSync(backupDir, binDir, { recursive: true });
    }
  }
}

function runCase({ platform, arch, key }, metaPack, platformPack) {
  const caseDir = path.join(tempRoot, key);
  const homeDir = path.join(caseDir, "home");
  const runtimeDir = path.join(caseDir, "runtime");
  const configDir = path.join(caseDir, "config");
  const stateDir = path.join(caseDir, "state");
  fs.mkdirSync(caseDir);
  fs.mkdirSync(homeDir);
  fs.mkdirSync(runtimeDir, { mode: 0o700 });
  fs.mkdirSync(configDir);
  fs.mkdirSync(stateDir);
  fs.writeFileSync(path.join(caseDir, "package.json"), `${JSON.stringify({ private: true }, null, 2)}\n`);

  const env = isolatedEnv({ platform, arch, homeDir, runtimeDir, configDir, stateDir });
  run(
    "bun",
    [
      "install",
      "--no-progress",
      "--backend=copyfile",
      `--os=${platform}`,
      `--cpu=${arch}`,
      platformPack,
      metaPack,
      "--no-save",
    ],
    { cwd: caseDir, env },
  );

  const platformBinDir = path.join(caseDir, "node_modules", `shellykit-${key}`, "bin");
  const metaBinDir = path.join(caseDir, "node_modules", "shellykit", "bin");
  const expectedShelly = path.join(platformBinDir, "shelly");
  const expectedDaemon = path.join(platformBinDir, "shellyd");
  const installedShelly = path.join(metaBinDir, "shelly");
  const installedDaemon = path.join(metaBinDir, "shellyd");

  requireExecutable(expectedShelly);
  requireExecutable(expectedDaemon);
  requireExecutable(installedShelly);
  requireExecutable(installedDaemon);
  assertInstallPath(
    installedShelly,
    expectedShelly,
    { platform, arch, key },
    `${key} shelly install path`,
  );
  assertInstallPath(
    installedDaemon,
    expectedDaemon,
    { platform, arch, key },
    `${key} shellyd install path`,
  );

  const binDir = path.join(caseDir, "node_modules", ".bin");
  requireExecutable(path.join(binDir, "shelly"));
  requireExecutable(path.join(binDir, "shellyd"));

  if (process.platform === platform && process.arch === arch) {
    // Smoke-test the resolved binaries with non-interactive --help only. This is
    // safe whether bun resolved the local fixture stubs (which echo their key) or
    // the real published binaries (which print clap help): --help never starts a
    // session or the daemon, so it needs no TTY or control socket in CI. (Bare
    // `shelly` would try to open an interactive session and fail under non-TTY CI.)
    assertIncludes(
      run(path.join(binDir, "shelly"), ["--help"], { cwd: caseDir, env }).stdout,
      "shelly",
      `${key} shelly smoke`,
    );
    assertIncludes(
      run(path.join(binDir, "shellyd"), ["--help"], { cwd: caseDir, env }).stdout,
      "Usage:",
      `${key} shellyd smoke`,
    );
  }
}

function packPackage(packageDir, packDir) {
  const result = run(npm, ["pack", packageDir, "--pack-destination", packDir, "--json"], {
    cwd: root,
    env: cleanPackageManagerEnv(process.env),
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

function isolatedEnv({ platform, arch, homeDir, runtimeDir, configDir, stateDir }) {
  return cleanPackageManagerEnv({
    ...process.env,
    HOME: homeDir,
    XDG_RUNTIME_DIR: runtimeDir,
    XDG_CONFIG_HOME: configDir,
    XDG_STATE_HOME: stateDir,
    SHELLY_DISABLE_UPDATE_CHECK: "1",
    SHELLY_NPM_PLATFORM: platform,
    SHELLY_NPM_ARCH: arch,
    SHELLY_SCROLLBACK_ENCRYPTION_ENABLED: "false",
  });
}

function cleanPackageManagerEnv(env) {
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

function isJsFallback(file) {
  const firstBytes = fs.readFileSync(file).subarray(0, 64).toString("utf8");
  return firstBytes.startsWith("#!/usr/bin/env node");
}

function assertInstallPath(actual, expected, platformCase, label) {
  if (isJsFallback(actual)) {
    assertDispatcherCanResolvePlatformPackage(actual, platformCase, label);
    return;
  }

  assertSelectedPlatformBinary(actual, expected, platformCase, label);
}

function assertDispatcherCanResolvePlatformPackage(dispatcher, { platform, arch, key }, label) {
  const binaryName = path.basename(dispatcher);
  const script = `
    process.env.SHELLY_NPM_PLATFORM = ${JSON.stringify(platform)};
    process.env.SHELLY_NPM_ARCH = ${JSON.stringify(arch)};
    process.stdout.write(require.resolve(${JSON.stringify(`shellykit-${key}/bin/${binaryName}`)}));
  `;
  const result = spawnSync(process.execPath, ["-e", script], {
    cwd: path.dirname(path.dirname(dispatcher)),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) {
    fail(`${label} dispatcher failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
    fail(`${label} dispatcher could not resolve selected platform package shellykit-${key}:\n${output}`);
  }
  const resolved = result.stdout.trim();
  if (!resolved.includes(`shellykit-${key}`) || !fs.existsSync(resolved)) {
    fail(`${label} resolved unexpected platform binary: ${resolved}`);
  }
}

function assertSelectedPlatformBinary(actual, expected, { platform, arch }, label) {
  if (usingFixtureBins) {
    const actualBytes = fs.readFileSync(actual);
    const expectedBytes = fs.readFileSync(expected);
    if (!actualBytes.equals(expectedBytes)) {
      fail(`${label} did not match selected platform package fixture`);
    }
    return;
  }

  if (platform !== "darwin") {
    const actualBytes = fs.readFileSync(actual);
    const expectedBytes = fs.readFileSync(expected);
    if (!actualBytes.equals(expectedBytes)) {
      fail(`${label} did not match selected platform package binary`);
    }
    return;
  }

  const expectedArch = arch === "x64" ? "x86_64" : arch;
  assertMachOArch(actual, expectedArch, label);
  assertMachOArch(expected, expectedArch, `${label} source package`);
}

function assertMachOArch(file, expectedArch, label) {
  const result = run("file", [file], { cwd: root });
  if (!result.stdout.includes("Mach-O") || !result.stdout.includes(expectedArch)) {
    fail(`${label} must be a Mach-O ${expectedArch} binary, got:\n${result.stdout}`);
  }
}

function writeExecutable(file, contents) {
  fs.writeFileSync(file, contents);
  fs.chmodSync(file, 0o755);
}

function run(command, args, options) {
  const result = spawnSync(command, args, {
    ...options,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error?.code === "ENOENT") {
    fail(`${command} is required on PATH`);
  }
  if (result.error) {
    fail(`${command} failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const rendered = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    fail(`${command} ${args.join(" ")} failed with exit ${result.status}${rendered ? `\n${rendered}` : ""}`);
  }
  return result;
}

function assertIncludes(text, expected, label) {
  if (!text.includes(expected)) {
    fail(`${label} must include ${JSON.stringify(expected)}, got:\n${text}`);
  }
}

function fail(message) {
  throw new Error(message);
}
