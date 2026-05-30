#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const node = process.execPath;
const scaffold = path.join(root, "scripts/create-android-release-signing-evidence-dir.mjs");
const verifier = path.join(root, "scripts/verify-android-release-signing-evidence.mjs");
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fieldwork-android-release-signing-scaffold-"));

try {
  const evidenceRoot = path.join(tmpRoot, "evidence");
  const result = spawnSync(node, [scaffold, "--dir", evidenceRoot, "--quiet", "--print-dir"], {
    cwd: root,
    encoding: "utf8",
  });
  expectStatus(result, 0, "release-signing scaffold should create an evidence root");
  expectEqual(result.stdout.trim(), evidenceRoot, "--print-dir should print only the evidence root");

  for (const file of ["README.md", "manifest.json", "missing-files.txt", "capture-checklist.md", "preflight.sh"]) {
    expect(fs.existsSync(path.join(evidenceRoot, file)), `${file} should exist`);
  }

  const required = readRequiredFiles();
  const manifest = JSON.parse(fs.readFileSync(path.join(evidenceRoot, "manifest.json"), "utf8"));
  expectEqual(manifest.schema, "fieldwork-android-release-signing-evidence-v1", "manifest schema should be pinned");
  expectDeepEqual(manifest.requiredFiles, required, "manifest should mirror verifier required files");
  expectDeepEqual(
    manifest.generatedFiles,
    ["README.md", "manifest.json", "missing-files.txt", "capture-checklist.md", "preflight.sh"],
    "manifest should list every generated helper",
  );

  const missing = fs.readFileSync(path.join(evidenceRoot, "missing-files.txt"), "utf8");
  for (const file of required) {
    expect(missing.includes(`${file}\n`), `missing-files should list ${file}`);
    expect(!fs.existsSync(path.join(evidenceRoot, file)), `scaffold must not fabricate ${file}`);
  }

  const readme = fs.readFileSync(path.join(evidenceRoot, "README.md"), "utf8");
  expect(readme.includes("release-android.yml"), "README should identify the Android release workflow");
  expect(readme.includes("signed release AAB"), "README should describe signed release AAB evidence");
  expect(readme.includes("does not create"), "README should say the scaffold does not create the keystore");
  expect(readme.includes("pnpm check:android-release-signing-evidence"), "README should show the package verifier");

  const checklist = fs.readFileSync(path.join(evidenceRoot, "capture-checklist.md"), "utf8");
  for (const needle of [
    "node scripts/verify-android-aab.mjs --expect-signed --expect-relay-control-url",
    "jarsigner -verify -certs",
    "shasum -a 256",
    "FIELDWORK_RELAY_CONTROL_URL",
    "FIELDWORK_ANDROID_RELEASE_REF",
    "FIELDWORK_ANDROID_RELEASE_WORKFLOW_URL",
    "release-android.yml",
    "node scripts/verify-android-release-signing-evidence.mjs",
  ]) {
    expect(checklist.includes(needle), `checklist should include ${needle}`);
  }
  for (const file of required) {
    expect(checklist.includes(`\`${file}\``), `checklist should mention ${file}`);
  }

  const preflight = fs.readFileSync(path.join(evidenceRoot, "preflight.sh"), "utf8");
  for (const needle of [
    "FIELDWORK_ANDROID_SIGNED_AAB",
    "FIELDWORK_ANDROID_RELEASE_REF",
    "FIELDWORK_ANDROID_RELEASE_WORKFLOW_URL",
    "FIELDWORK_JARSIGNER",
    "verify-android-aab.mjs\" --expect-signed --expect-relay-control-url",
    "FIELDWORK_RELAY_CONTROL_URL = \"https://",
    "\"$jarsigner\" -verify -certs",
    "sha256_file",
    "release-android.yml",
    "node \"$repo_root/scripts/verify-android-release-signing-evidence.mjs\"",
  ]) {
    expect(preflight.includes(needle), `preflight should include ${needle}`);
  }
  expect(
    (fs.statSync(path.join(evidenceRoot, "preflight.sh")).mode & 0o700) === 0o700,
    "preflight helper should be owner-executable",
  );

  const verifyEmpty = spawnSync(node, [verifier, evidenceRoot], {
    cwd: root,
    encoding: "utf8",
  });
  expectStatus(verifyEmpty, 1, "empty scaffold should not pass the release-signing verifier");
  expect(verifyEmpty.stderr.includes("missing evidence file"), "verifier should still require real signing evidence");

  const noForce = spawnSync(node, [scaffold, "--dir", evidenceRoot, "--quiet"], { cwd: root, encoding: "utf8" });
  expectStatus(noForce, 1, "scaffold should not overwrite a non-empty directory without --force");
  expect(noForce.stderr.includes("rerun with --force"), "non-empty directory failure should explain --force");

  const force = spawnSync(node, [scaffold, "--dir", evidenceRoot, "--force", "--quiet"], {
    cwd: root,
    encoding: "utf8",
  });
  expectStatus(force, 0, "scaffold should refresh metadata with --force");

  console.log("Android release-signing evidence scaffold self-test ok");
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

function readRequiredFiles() {
  const source = fs.readFileSync(verifier, "utf8");
  const match = source.match(/const\s+requiredFiles\s*=\s*\[(?<body>[\s\S]*?)\];/);
  if (!match?.groups?.body) {
    throw new Error("cannot locate requiredFiles");
  }
  return [...match.groups.body.matchAll(/"([^"\n]+)"/g)].map((fileMatch) => fileMatch[1]);
}

function expectStatus(result, status, message) {
  if (result.status !== status) {
    throw new Error(`${message}: expected status ${status}, got ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
}

function expect(value, message) {
  if (!value) {
    throw new Error(message);
  }
}

function expectEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function expectDeepEqual(actual, expected, message) {
  expectEqual(JSON.stringify(actual), JSON.stringify(expected), message);
}
