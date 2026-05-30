#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const args = process.argv.slice(2).filter((arg) => arg !== "--");
const failures = [];
const requiredBinaries = ["fieldwork", "fieldworkd"];

if (args.length !== 1 || args[0] === "--help" || args[0] === "-h") {
  console.error("usage: node scripts/verify-macos-signing.mjs <darwin-release-dir-or-archive-or-binary>");
  process.exit(args.length === 1 ? 0 : 2);
}

const platform = process.env.FIELDWORK_TEST_DARWIN === "1" ? "darwin" : process.platform;
if (platform !== "darwin") {
  console.error("macOS npm trust verification must run on macOS with codesign and xattr available");
  process.exit(1);
}

const cleanup = [];

try {
  const input = path.resolve(args[0]);
  const binaries = resolveBinaries(input);
  for (const binary of binaries) {
    verifyBinary(binary);
  }

  if (failures.length > 0) {
    console.error(failures.join("\n"));
    process.exit(1);
  }

  console.log(`macOS npm trust ok: ${input}`);
} finally {
  for (const dir of cleanup.reverse()) {
    fs.rmSync(dir, { force: true, recursive: true });
  }
}

function resolveBinaries(input) {
  if (!fs.existsSync(input)) {
    failures.push(`macOS npm trust input does not exist: ${input}`);
    return [];
  }

  const stat = fs.statSync(input);
  if (stat.isDirectory()) {
    return findRequiredBinaries(input);
  }

  if (stat.isFile() && isArchive(input)) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fieldwork-macos-npm-trust-"));
    cleanup.push(dir);
    run("tar", ["-xzf", input, "-C", dir], "extract Darwin release archive");
    return findRequiredBinaries(dir);
  }

  if (stat.isFile() && requiredBinaries.includes(path.basename(input))) {
    return [input];
  }

  failures.push("macOS npm trust input must be a Darwin release directory, Darwin .tar.gz archive, or a fieldwork/fieldworkd binary");
  return [];
}

function findRequiredBinaries(dir) {
  const found = new Map(requiredBinaries.map((name) => [name, []]));
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && found.has(entry.name)) {
        found.get(entry.name).push(full);
      }
    }
  }

  const binaries = [];
  for (const name of requiredBinaries) {
    const matches = found.get(name);
    if (matches.length !== 1) {
      failures.push(`Darwin artifact must contain exactly one ${name} binary, found ${matches.length}`);
      continue;
    }
    binaries.push(matches[0]);
  }
  return binaries;
}

function verifyBinary(binary) {
  const name = path.basename(binary);
  if (!requiredBinaries.includes(name)) {
    failures.push(`macOS npm trust verifier only accepts fieldwork or fieldworkd, got ${name}`);
  }
  if (!fs.existsSync(binary) || !fs.statSync(binary).isFile()) {
    failures.push(`${name} binary does not exist: ${binary}`);
    return;
  }

  const mode = fs.statSync(binary).mode & 0o777;
  if ((mode & 0o111) === 0) {
    failures.push(`${name} must be executable for npm install users`);
  }

  run("codesign", ["--verify", "--verbose=4", binary], `verify ${name} code signature`);
  const display = run("codesign", ["--display", "--verbose=4", binary], `read ${name} code signature details`);
  const signature = `${display.stdout}\n${display.stderr}`;
  const hasAdHoc = /\bSignature=adhoc\b/i.test(signature) || /\bAuthority=Ad Hoc\b/i.test(signature);
  const hasDeveloperId = /\bAuthority=Developer ID Application:/i.test(signature);
  if (!hasAdHoc && !hasDeveloperId) {
    failures.push(`${name} must have an ad-hoc or Developer ID code signature`);
  }
  if (hasDeveloperId && !/\bTeamIdentifier=[A-Z0-9]+\b/.test(signature)) {
    failures.push(`${name} Developer ID signature must include an Apple TeamIdentifier`);
  }

  const quarantine = spawnSync("xattr", ["-p", "com.apple.quarantine", binary], {
    cwd: path.resolve(new URL("..", import.meta.url).pathname),
    encoding: "utf8",
    env: stableToolEnv(),
  });
  if (quarantine.error) {
    failures.push(`read ${name} quarantine xattr failed to start xattr: ${quarantine.error.message}`);
  } else if (quarantine.status === 0 && `${quarantine.stdout}${quarantine.stderr}`.trim().length > 0) {
    failures.push(`${name} must not carry com.apple.quarantine after npm trust prep`);
  }
}

function run(command, commandArgs, label) {
  const result = spawnSync(command, commandArgs, {
    cwd: path.resolve(new URL("..", import.meta.url).pathname),
    encoding: "utf8",
    env: stableToolEnv(),
  });
  if (result.error) {
    failures.push(`${label} failed to start ${command}: ${result.error.message}`);
    return { stdout: "", stderr: "" };
  }
  if (result.status !== 0) {
    failures.push(`${label} failed with exit code ${result.status}\n${result.stdout}${result.stderr}`);
  }
  return result;
}

function stableToolEnv() {
  return {
    ...process.env,
    LC_ALL: "C",
    LANG: "C",
  };
}

function isArchive(file) {
  return file.endsWith(".tar.gz") || file.endsWith(".tgz");
}
