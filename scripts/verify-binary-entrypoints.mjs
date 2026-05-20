#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const releaseDir = path.join(root, "target", "release");
const version = workspaceVersion();
const args = new Set(process.argv.slice(2));

for (const arg of args) {
  if (arg !== "--staged-host") {
    fail(`unknown argument: ${arg}`);
  }
}

const binaries = [
  {
    name: "fieldworkd",
    path: path.join(releaseDir, "fieldworkd"),
    description: "Fieldwork host daemon.",
  },
  {
    name: "fieldwork-relay",
    path: path.join(releaseDir, "fieldwork-relay"),
    description: "Fieldwork relay and push gateway.",
  },
];

if (args.has("--staged-host")) {
  binaries.push({
    name: "fieldworkd",
    path: path.join(root, "packages", `cli-${hostPlatformKey()}`, "bin", "fieldworkd"),
    description: "Fieldwork host daemon.",
  });
}

for (const binary of binaries) {
  const binaryPath = binary.path;
  if (!fs.existsSync(binaryPath)) {
    fail(`${binary.name} is missing at ${binaryPath}; run cargo build --release -p ${packageFor(binary.name)}`);
  }
  const stat = fs.statSync(binaryPath);
  if ((stat.mode & 0o111) === 0) {
    fail(`${binary.name} is not executable at ${binaryPath}`);
  }

  const help = run(binaryPath, ["--help"]);
  assert(help.status === 0, `${binary.name} --help must exit 0, got ${help.status}\n${help.stderr}`);
  assert(help.stdout.includes(binary.description), `${binary.name} --help must include its description`);
  assert(help.stdout.includes(`Usage: ${binary.name} [OPTIONS]`), `${binary.name} --help must include usage`);
  assert(help.stdout.includes("-V, --version"), `${binary.name} --help must advertise --version`);
  assert(help.stderr === "", `${binary.name} --help must not write stderr: ${help.stderr}`);

  const versionResult = run(binaryPath, ["--version"]);
  assert(versionResult.status === 0, `${binary.name} --version must exit 0, got ${versionResult.status}\n${versionResult.stderr}`);
  assert(versionResult.stdout.trim() === `${binary.name} ${version}`, `${binary.name} --version stdout mismatch: ${versionResult.stdout}`);
  assert(versionResult.stderr === "", `${binary.name} --version must not write stderr: ${versionResult.stderr}`);

  const badArg = run(binaryPath, ["--definitely-invalid"]);
  assert(badArg.status !== 0, `${binary.name} must reject unknown arguments`);
  assert(badArg.stderr.includes("unexpected argument"), `${binary.name} bad-arg stderr must explain the argument failure: ${badArg.stderr}`);
}

console.log("binary entrypoints ok");

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    timeout: 5000,
  });
  if (result.error) {
    fail(`${path.basename(command)} ${args.join(" ")} failed to start: ${result.error.message}`);
  }
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function packageFor(name) {
  return name === "fieldwork-relay" ? "fieldwork-relay" : "fieldwork-daemon";
}

function hostPlatformKey() {
  const os = {
    darwin: "darwin",
    linux: "linux",
  }[process.platform];
  const arch = {
    arm64: "arm64",
    x64: "x64",
  }[process.arch];

  if (!os || !arch) {
    fail(`unsupported host platform for staged package entrypoint verification: ${process.platform}/${process.arch}`);
  }
  return `${os}-${arch}`;
}

function workspaceVersion() {
  const cargoToml = fs.readFileSync(path.join(root, "Cargo.toml"), "utf8");
  const match = cargoToml.match(/\[workspace\.package\][\s\S]*?\nversion\s*=\s*"([^"]+)"/);
  if (!match) {
    fail("Cargo.toml workspace package version is missing");
  }
  return match[1];
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
