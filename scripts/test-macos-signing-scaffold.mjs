#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const node = process.execPath;
const scaffold = path.join(root, "scripts/create-macos-signing-evidence-dir.mjs");
const verifier = path.join(root, "scripts/verify-macos-signing-evidence.mjs");
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fieldwork-macos-signing-scaffold-"));

try {
  const evidenceDir = path.join(tmpRoot, "evidence");
  const scaffoldResult = spawnSync(node, [scaffold, "--dir", evidenceDir, "--quiet", "--print-dir"], {
    cwd: root,
    encoding: "utf8",
  });
  expectStatus(scaffoldResult, 0, "scaffold should create a macOS signing evidence directory");
  expectEqual(scaffoldResult.stdout.trim(), evidenceDir, "--print-dir should print only the evidence directory");

  for (const file of ["README.md", "manifest.json", "missing-files.txt", "capture-checklist.md", "preflight.sh"]) {
    expect(fs.existsSync(path.join(evidenceDir, file)), `${file} should exist`);
  }

  const requiredFiles = readRequiredFiles();
  const manifest = JSON.parse(fs.readFileSync(path.join(evidenceDir, "manifest.json"), "utf8"));
  expectEqual(manifest.schema, "fieldwork-macos-signing-evidence-v1", "manifest schema should be pinned");
  expectDeepEqual(manifest.requiredFiles, requiredFiles, "manifest should mirror verifier required files");
  expectDeepEqual(
    manifest.generatedFiles,
    ["README.md", "manifest.json", "missing-files.txt", "capture-checklist.md", "preflight.sh"],
    "manifest should list generated helper files",
  );
  expectEqual(
    fs.readFileSync(path.join(evidenceDir, "missing-files.txt"), "utf8"),
    `${requiredFiles.join("\n")}\n`,
    "missing-files.txt should list every required evidence file",
  );

  const checklist = fs.readFileSync(path.join(evidenceDir, "capture-checklist.md"), "utf8");
  for (const file of requiredFiles) {
    expect(checklist.includes(`\`${file}\``), `capture checklist should mention ${file}`);
    expect(!fs.existsSync(path.join(evidenceDir, file)), `scaffold must not fabricate ${file}`);
  }
  expect(checklist.includes("package-identity.txt"), "checklist should document npm package identity evidence");
  expect(checklist.includes("release-integrity.txt"), "checklist should document release integrity evidence");
  expect(checklist.includes("checksum or npm integrity verification"), "checklist should document checksum/integrity evidence");
  expect(checklist.includes("npm/Sigstore provenance verification"), "checklist should document provenance evidence");
  expect(checklist.includes("separate release-artifacts\nevidence gate"), "checklist should keep release workflow evidence in the release-artifacts gate");
  expect(checklist.includes("com.apple.quarantine"), "checklist should document quarantine evidence");
  expect(checklist.includes("fieldwork doctor --no-start"), "checklist should document doctor trust evidence");
  expect(checklist.includes("fieldwork daemon install"), "checklist should document daemon preflight evidence");
  expect(checklist.includes("Gatekeeper notarization is\noptional/deferred"), "checklist should document deferred Gatekeeper notarization");
  expect(checklist.includes("Do not include raw Apple signing credentials"), "checklist should warn about raw Apple credentials");

  const readme = fs.readFileSync(path.join(evidenceDir, "README.md"), "utf8");
  expect(readme.includes("does not sign binaries"), "README should state scaffold does not sign");
  expect(readme.includes("run GitHub workflows"), "README should state scaffold does not run GitHub workflows");

  const preflight = fs.readFileSync(path.join(evidenceDir, "preflight.sh"), "utf8");
  expect(preflight.startsWith("#!/usr/bin/env bash"), "preflight should be a shell script");
  expect(preflight.includes("FIELDWORK_DARWIN_ARTIFACT_DIR"), "preflight should accept a Darwin artifact directory");
  expect(preflight.includes("FIELDWORK_PACKAGE_IDENTITY_FILE"), "preflight should accept captured package identity evidence");
  expect(preflight.includes("FIELDWORK_RELEASE_INTEGRITY_FILE"), "preflight should accept captured release integrity evidence");
  expect(preflight.includes("FIELDWORK_VERIFY_COSIGN_SIGNATURE"), "preflight should run release integrity with cosign verification enabled");
  expect(preflight.includes('FIELDWORK_RELEASE_PLATFORMS="darwin-arm64,darwin-x64"'), "preflight should scope release integrity to Darwin artifacts");
  expect(preflight.includes("LC_ALL=C LANG=C COPYFILE_DISABLE=1 tar -xzf"), "preflight should extract archives with a stable macOS tar environment");
  expect(preflight.includes("verify-macos-signing.mjs"), "preflight should run the signing verifier");
  expect(preflight.includes("verify-release-artifacts.mjs"), "preflight should run the release artifact verifier");
  expect(preflight.includes("codesign --display --verbose=4"), "preflight should capture codesign display output");
  expect(preflight.includes("xattr -p com.apple.quarantine"), "preflight should capture quarantine state");
  expect(preflight.includes("FIELDWORK_INSTALLED_FIELDWORK"), "preflight should accept an installed fieldwork path");
  expect(preflight.includes("daemon install"), "preflight should capture daemon install output");
  expect(preflight.includes("doctor --no-start"), "preflight should capture doctor trust output");
  expect((fs.statSync(path.join(evidenceDir, "preflight.sh")).mode & 0o700) === 0o700, "preflight should be owner-executable");

  const verifyEmpty = spawnSync(node, [verifier, evidenceDir], { cwd: root, encoding: "utf8" });
  expectStatus(verifyEmpty, 1, "empty scaffold should not pass the macOS signing evidence verifier");
  expect(verifyEmpty.stderr.includes("package-identity.txt is missing"), "verifier should still require real evidence files");

  const noForce = spawnSync(node, [scaffold, "--dir", evidenceDir, "--quiet"], { cwd: root, encoding: "utf8" });
  expectStatus(noForce, 1, "scaffold should not overwrite a non-empty directory without --force");
  expect(noForce.stderr.includes("rerun with --force"), "non-empty directory failure should explain --force");

  const force = spawnSync(node, [scaffold, "--dir", evidenceDir, "--force", "--quiet"], {
    cwd: root,
    encoding: "utf8",
  });
  expectStatus(force, 0, "scaffold should refresh metadata with --force");

  console.log("macOS npm trust evidence scaffold self-test ok");
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

function readRequiredFiles() {
  const source = fs.readFileSync(verifier, "utf8");
  const match = source.match(/const\s+requiredFiles\s*=\s*\[(?<body>[\s\S]*?)\];/);
  if (!match?.groups?.body) {
    throw new Error("cannot locate requiredFiles in verifier");
  }
  return [...match.groups.body.matchAll(/"([^"\n]+)"/g)].map((fileMatch) => fileMatch[1]);
}

function expectStatus(result, expectedStatus, message) {
  if (result.status !== expectedStatus) {
    throw new Error(`${message}: exited ${result.status}, expected ${expectedStatus}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
}

function expectEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function expectDeepEqual(actual, expected, message) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function expect(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
