#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

const esbuildVersion = "0.25.12";
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fieldwork-bun-install-"));
const cases = [
  { platform: "darwin", arch: "arm64", expected: "@esbuild/darwin-arm64" },
  { platform: "darwin", arch: "x64", expected: "@esbuild/darwin-x64" },
  { platform: "linux", arch: "arm64", expected: "@esbuild/linux-arm64" },
  { platform: "linux", arch: "x64", expected: "@esbuild/linux-x64" },
];

let exitCode = 0;

try {
  const version = run("bun", ["--version"], { cwd: tempRoot }).stdout.trim();
  if (!version) {
    fail("bun --version returned an empty version");
  }

  for (const testCase of cases) {
    runCase(testCase);
  }

  console.log(`bun optional dependency install ok (${cases.length} platform cases, bun ${version})`);
} catch (error) {
  console.error(error.message);
  exitCode = 1;
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

process.exitCode = exitCode;

function runCase({ platform, arch, expected }) {
  const caseDir = path.join(tempRoot, `${platform}-${arch}`);
  fs.mkdirSync(caseDir);
  fs.writeFileSync(
    path.join(caseDir, "package.json"),
    `${JSON.stringify({ private: true }, null, 2)}\n`,
  );

  run(
    "bun",
    [
      "install",
      "--no-progress",
      "--backend=copyfile",
      `--os=${platform}`,
      `--cpu=${arch}`,
      `esbuild@${esbuildVersion}`,
      "--no-save",
    ],
    { cwd: caseDir },
  );

  assertExists(path.join(caseDir, "node_modules/esbuild"), `esbuild meta package missing for ${platform}-${arch}`);
  assertExists(path.join(caseDir, "node_modules", ...expected.split("/")), `${expected} missing for ${platform}-${arch}`);

  const scopeDir = path.join(caseDir, "node_modules/@esbuild");
  const installed = fs
    .readdirSync(scopeDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `@esbuild/${entry.name}`)
    .sort();
  const expectedOnly = [expected];
  if (!arrayEquals(installed, expectedOnly)) {
    fail(`${platform}-${arch} installed ${JSON.stringify(installed)}; expected ${JSON.stringify(expectedOnly)}`);
  }

  if (process.platform === platform && process.arch === arch) {
    const esbuild = process.platform === "win32" ? "esbuild.cmd" : "esbuild";
    const result = run(path.join(caseDir, "node_modules/.bin", esbuild), ["--version"], { cwd: caseDir });
    if (result.stdout.trim() !== esbuildVersion) {
      fail(`host esbuild binary returned ${JSON.stringify(result.stdout.trim())}; expected ${esbuildVersion}`);
    }
  }
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

function assertExists(target, message) {
  if (!fs.existsSync(target)) {
    fail(message);
  }
}

function arrayEquals(actual, expected) {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

function fail(message) {
  throw new Error(message);
}
