#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const args = process.argv.slice(2).filter((arg) => arg !== "--");
const failures = [];

if (args.length !== 1 || args[0] === "--help" || args[0] === "-h") {
  console.error("usage: node scripts/verify-macos-signing.mjs <fieldworkd-or-darwin-archive.tar.gz>");
  process.exit(args.length === 1 ? 0 : 2);
}

const platform = process.env.FIELDWORK_TEST_DARWIN === "1" ? "darwin" : process.platform;
if (platform !== "darwin") {
  console.error("macOS signing verification must run on macOS with codesign and spctl available");
  process.exit(1);
}

const cleanup = [];

try {
  const binary = resolveFieldworkd(path.resolve(args[0]));
  verifyDaemonBinary(binary);

  if (failures.length > 0) {
    console.error(failures.join("\n"));
    process.exit(1);
  }

  console.log(`macOS signing ok: ${binary}`);
} finally {
  for (const dir of cleanup.reverse()) {
    fs.rmSync(dir, { force: true, recursive: true });
  }
}

function resolveFieldworkd(input) {
  if (!fs.existsSync(input)) {
    failures.push(`macOS signing input does not exist: ${input}`);
    return input;
  }

  const stat = fs.statSync(input);
  if (stat.isFile() && path.basename(input) === "fieldworkd" && !isArchive(input)) {
    return input;
  }

  if (stat.isFile() && isArchive(input)) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fieldwork-macos-signing-"));
    cleanup.push(dir);
    run("tar", ["-xzf", input, "-C", dir], "extract Darwin release archive");
    const matches = findFieldworkd(dir);
    if (matches.length !== 1) {
      failures.push(`Darwin archive must contain exactly one fieldworkd binary, found ${matches.length}`);
      return path.join(dir, "fieldworkd");
    }
    return matches[0];
  }

  failures.push("macOS signing input must be a fieldworkd binary or a Darwin release .tar.gz archive");
  return input;
}

function verifyDaemonBinary(binary) {
  if (path.basename(binary) !== "fieldworkd") {
    failures.push(`macOS signing verifier only accepts the daemon binary, got ${path.basename(binary)}`);
  }
  if (!fs.existsSync(binary) || !fs.statSync(binary).isFile()) {
    failures.push(`fieldworkd binary does not exist: ${binary}`);
    return;
  }

  run("codesign", ["--verify", "--verbose=4", binary], "verify macOS code signature");
  const display = run("codesign", ["--display", "--verbose=4", binary], "read macOS code signature details");
  const signature = `${display.stdout}\n${display.stderr}`;
  requirePattern(signature, /Authority=Developer ID Application:/, "fieldworkd must be signed with a Developer ID Application certificate");
  requirePattern(signature, /TeamIdentifier=[A-Z0-9]+/, "fieldworkd signature must include an Apple TeamIdentifier");
  requirePattern(signature, /(?:Runtime Version=|flags=.*\bruntime\b)/i, "fieldworkd signature must enable the hardened runtime");

  const assessment = run("spctl", ["--assess", "--type", "execute", "--verbose=4", binary], "assess Gatekeeper notarization");
  const gatekeeper = `${assessment.stdout}\n${assessment.stderr}`;
  requirePattern(gatekeeper, /\baccepted\b/i, "Gatekeeper must accept the signed fieldworkd binary");
  requirePattern(gatekeeper, /Notarized Developer ID|notarized/i, "Gatekeeper assessment must identify notarized Developer ID software");
}

function run(command, commandArgs, label) {
  const result = spawnSync(command, commandArgs, {
    cwd: path.resolve(new URL("..", import.meta.url).pathname),
    encoding: "utf8",
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

function requirePattern(text, pattern, message) {
  if (!pattern.test(text)) {
    failures.push(message);
  }
}

function isArchive(file) {
  return file.endsWith(".tar.gz") || file.endsWith(".tgz");
}

function findFieldworkd(dir) {
  const matches = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && entry.name === "fieldworkd") {
        matches.push(full);
      }
    }
  }
  return matches;
}
