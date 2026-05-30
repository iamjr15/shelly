#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const node = process.execPath;
const scaffold = path.join(root, "scripts/create-android-release-install-evidence-dir.mjs");
const verifier = path.join(root, "scripts/verify-android-release-install-evidence.mjs");
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fieldwork-android-release-install-scaffold-"));

try {
  const evidenceRoot = path.join(tmpRoot, "evidence");
  const result = spawnSync(node, [scaffold, "--dir", evidenceRoot, "--quiet", "--print-dir"], {
    cwd: root,
    encoding: "utf8",
  });
  expectStatus(result, 0, "release-install scaffold should create an evidence root");
  expectEqual(result.stdout.trim(), evidenceRoot, "--print-dir should print only the evidence root");

  for (const dir of ["apks", "install"]) {
    expect(fs.existsSync(path.join(evidenceRoot, dir)), `${dir} directory should exist`);
    expect(fs.statSync(path.join(evidenceRoot, dir)).isDirectory(), `${dir} should be a directory`);
  }
  for (const file of ["README.md", "manifest.json", "missing-files.txt", "capture-checklist.md", "preflight.sh"]) {
    expect(fs.existsSync(path.join(evidenceRoot, file)), `${file} should exist`);
  }

  const required = readRequiredFiles();
  const manifest = JSON.parse(fs.readFileSync(path.join(evidenceRoot, "manifest.json"), "utf8"));
  expectEqual(manifest.schema, "fieldwork-android-release-install-evidence-v1", "manifest schema should be pinned");
  expectDeepEqual(manifest.apksRequiredFiles, required.apks, "manifest should mirror APKS verifier files");
  expectDeepEqual(manifest.installRequiredFiles, required.install, "manifest should mirror install verifier files");
  expectDeepEqual(
    manifest.generatedFiles,
    ["README.md", "manifest.json", "missing-files.txt", "capture-checklist.md", "preflight.sh"],
    "manifest should list every generated helper",
  );

  const missing = fs.readFileSync(path.join(evidenceRoot, "missing-files.txt"), "utf8");
  for (const file of required.apks) {
    expect(missing.includes(`apks/${file}\n`), `missing-files should list apks/${file}`);
  }
  for (const file of required.install) {
    expect(missing.includes(`install/${file}\n`), `missing-files should list install/${file}`);
  }

  const readme = fs.readFileSync(path.join(evidenceRoot, "README.md"), "utf8");
  expect(readme.includes("bundletool-all-1.18.3"), "README should pin bundletool-all 1.18.3");
  expect(readme.includes("CN=Fieldwork Release Smoke"), "README should explain the ephemeral non-debug signer");
  expect(readme.includes("Play signing"), "README should distinguish this local substitute from Play signing");
  expect(readme.includes("`--strict-release-device`"), "README should document strict physical release-device verification");
  expect(readme.includes("rejects emulator"), "README should say strict mode rejects emulator evidence");

  const checklist = fs.readFileSync(path.join(evidenceRoot, "capture-checklist.md"), "utf8");
  for (const needle of [
    "keytool -genkeypair",
    "java -jar \"$FIELDWORK_BUNDLETOOL_JAR\" build-apks",
    "apksigner verify --verbose --print-certs",
    "aapt dump badging",
    "aapt dump permissions",
    "aapt dump xmltree",
    "adb devices -l",
    "adb install -r \"$universal_apk\"",
    "adb shell run-as app.fieldwork.android true",
    "adb shell am start -W -n app.fieldwork.android/.MainActivity",
    "adb exec-out screencap -p",
    "adb shell uiautomator dump",
    "adb logcat -d -b crash",
  ]) {
    expect(checklist.includes(needle), `checklist should include ${needle}`);
  }
  for (const file of [...required.apks.map((file) => `apks/${file}`), ...required.install.map((file) => `install/${file}`)]) {
    expect(checklist.includes(`\`${file}\``), `checklist should mention ${file}`);
  }

  const preflight = fs.readFileSync(path.join(evidenceRoot, "preflight.sh"), "utf8");
  for (const needle of [
    "FIELDWORK_BUNDLETOOL_JAR",
    "bundletool-all-1.18.3.jar",
    "find_android_tool apksigner",
    "find_android_tool aapt",
    "-dname \"CN=Fieldwork Release Smoke,O=Fieldwork,L=Local,ST=Local,C=US\"",
    "build-apks",
    "--mode=universal",
    "apksigner\" verify --verbose --print-certs",
    "aapt\" dump badging",
    "aapt\" dump permissions",
    "aapt\" dump xmltree",
    "adb install -r \"$universal_apk\"",
    "adb shell pm path app.fieldwork.android",
    "adb shell dumpsys package app.fieldwork.android",
    "adb shell run-as app.fieldwork.android true",
    "adb shell am force-stop app.fieldwork.android",
    "adb logcat -c",
    "adb shell am start -W -n app.fieldwork.android/.MainActivity",
    "node \"$repo_root/scripts/verify-android-release-install-evidence.mjs\"",
  ]) {
    expect(preflight.includes(needle), `preflight should include ${needle}`);
  }
  expect(
    (fs.statSync(path.join(evidenceRoot, "preflight.sh")).mode & 0o700) === 0o700,
    "preflight helper should be owner-executable",
  );

  for (const file of required.apks) {
    expect(!fs.existsSync(path.join(evidenceRoot, "apks", file)), `scaffold must not fabricate apks/${file}`);
  }
  for (const file of required.install) {
    expect(!fs.existsSync(path.join(evidenceRoot, "install", file)), `scaffold must not fabricate install/${file}`);
  }

  const verifyEmpty = spawnSync(node, [verifier, path.join(evidenceRoot, "apks"), path.join(evidenceRoot, "install")], {
    cwd: root,
    encoding: "utf8",
  });
  expectStatus(verifyEmpty, 1, "empty scaffold should not pass the release-install verifier");
  expect(
    verifyEmpty.stderr.includes("missing evidence file"),
    "verifier should still require real captured release-install evidence",
  );

  const noForce = spawnSync(node, [scaffold, "--dir", evidenceRoot, "--quiet"], { cwd: root, encoding: "utf8" });
  expectStatus(noForce, 1, "scaffold should not overwrite a non-empty directory without --force");
  expect(noForce.stderr.includes("rerun with --force"), "non-empty directory failure should explain --force");

  const force = spawnSync(node, [scaffold, "--dir", evidenceRoot, "--force", "--quiet"], {
    cwd: root,
    encoding: "utf8",
  });
  expectStatus(force, 0, "scaffold should refresh metadata with --force");

  console.log("Android release-install evidence scaffold self-test ok");
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

function readRequiredFiles() {
  const source = fs.readFileSync(verifier, "utf8");
  return {
    apks: readArray(source, "apksRequiredFiles"),
    install: readArray(source, "installRequiredFiles"),
  };
}

function readArray(source, name) {
  const match = source.match(new RegExp(`const\\s+${name}\\s*=\\s*\\[(?<body>[\\s\\S]*?)\\];`));
  if (!match?.groups?.body) {
    throw new Error(`cannot locate ${name}`);
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
