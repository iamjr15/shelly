#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
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
const cliBinaries = [
  {
    name: "fieldwork",
    path: path.join(releaseDir, "fieldwork"),
  },
];

if (args.has("--staged-host")) {
  cliBinaries.push({
    name: "fieldwork",
    path: path.join(root, "packages", `cli-${hostPlatformKey()}`, "bin", "fieldwork"),
  });
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

for (const binary of cliBinaries) {
  verifyCliEntrypoint(binary.path);
}

console.log("binary entrypoints ok");

function verifyCliEntrypoint(binaryPath) {
  if (!fs.existsSync(binaryPath)) {
    fail(`fieldwork is missing at ${binaryPath}; run cargo build --release -p fieldwork-cli`);
  }
  const stat = fs.statSync(binaryPath);
  if ((stat.mode & 0o111) === 0) {
    fail(`fieldwork is not executable at ${binaryPath}`);
  }

  const help = run(binaryPath, ["--help"]);
  assert(help.status === 0, `fieldwork --help must exit 0, got ${help.status}\n${help.stderr}`);
  assert(help.stdout.includes("Continue terminal sessions from anywhere"), "fieldwork --help must include its description");
  assert(help.stdout.includes("Usage: fieldwork [COMMAND]"), "fieldwork --help must include fieldwork usage");
  assert(help.stdout.includes("completion"), "fieldwork --help must advertise completion generation");
  assert(help.stderr === "", `fieldwork --help must not write stderr: ${help.stderr}`);

  const versionResult = run(binaryPath, ["version"]);
  assert(versionResult.status === 0, `fieldwork version must exit 0, got ${versionResult.status}\n${versionResult.stderr}`);
  assert(versionResult.stdout.trim() === `fieldwork ${version}`, `fieldwork version stdout mismatch: ${versionResult.stdout}`);
  assert(versionResult.stderr === "", `fieldwork version must not write stderr: ${versionResult.stderr}`);

  const completion = run(binaryPath, ["completion", "bash"]);
  assert(completion.status === 0, `fieldwork completion bash must exit 0, got ${completion.status}\n${completion.stderr}`);
  assert(completion.stdout.includes("complete -F _fieldwork"), "fieldwork completion bash must target the fieldwork command");
  assert(completion.stdout.includes(" fieldwork"), "fieldwork completion bash must register fieldwork");
  assert(completion.stderr === "", `fieldwork completion bash must not write stderr: ${completion.stderr}`);

  const aliasTmp = fs.mkdtempSync(path.join(os.tmpdir(), "fieldwork-fw-entrypoint-"));
  try {
    const fwAlias = path.join(aliasTmp, "fw");
    fs.symlinkSync(binaryPath, fwAlias);
    const aliasHelp = run(fwAlias, ["--help"]);
    assert(aliasHelp.status === 0, `fw --help must exit 0, got ${aliasHelp.status}\n${aliasHelp.stderr}`);
    assert(aliasHelp.stdout.includes("Usage: fw [COMMAND]"), "fw --help must show fw usage when invoked through the alias");

    const aliasCompletion = run(fwAlias, ["completion", "bash"]);
    assert(aliasCompletion.status === 0, `fw completion bash must exit 0, got ${aliasCompletion.status}\n${aliasCompletion.stderr}`);
    assert(aliasCompletion.stdout.includes("complete -F _fw"), "fw completion bash must target the fw alias");
    assert(aliasCompletion.stdout.includes(" fw"), "fw completion bash must register fw");
    assert(!aliasCompletion.stdout.includes("complete -F _fieldwork"), "fw completion bash must not register the longer fieldwork command");
    assert(aliasCompletion.stderr === "", `fw completion bash must not write stderr: ${aliasCompletion.stderr}`);
  } finally {
    fs.rmSync(aliasTmp, { recursive: true, force: true });
  }
}

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
