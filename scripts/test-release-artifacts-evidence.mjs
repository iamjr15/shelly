#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const verifier = path.join(root, "scripts/verify-release-artifacts-evidence.mjs");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "fieldwork-release-artifacts-evidence-"));
const platforms = [
  ["darwin-arm64", "aarch64-apple-darwin"],
  ["darwin-x64", "x86_64-apple-darwin"],
  ["linux-arm64", "aarch64-unknown-linux-gnu"],
  ["linux-x64", "x86_64-unknown-linux-gnu"],
];
const assets = platforms.flatMap(([platform]) => [
  `fieldwork-${platform}.tar.gz`,
  `fieldwork-${platform}.tar.gz.sha256`,
  `fieldwork-${platform}.tar.gz.bundle`,
]);

try {
  const good = path.join(temp, "good");
  writeFixture(good);
  expectStatus(good, 0, "good release artifact evidence should pass");

  const missingAsset = path.join(temp, "missing-asset");
  writeFixture(missingAsset);
  const metadata = githubReleaseAssets();
  metadata.assets = metadata.assets.filter((asset) => asset.name !== "fieldwork-linux-x64.tar.gz.bundle");
  fs.writeFileSync(path.join(missingAsset, "github-release-assets.json"), `${JSON.stringify(metadata, null, 2)}\n`);
  expectStatus(missingAsset, 1, "missing bundle asset should fail", "github-release-assets.json must include fieldwork-linux-x64.tar.gz.bundle");

  const noCosign = path.join(temp, "no-cosign");
  writeFixture(noCosign);
  fs.writeFileSync(path.join(noCosign, "verify-release-artifacts.txt"), "release artifacts ok: archives, sha256 files, and cosign attestation bundles verified\n");
  expectStatus(noCosign, 1, "missing cosign command proof should fail", "verify-release-artifacts.txt must include FIELDWORK_VERIFY_COSIGN_SIGNATURE=1");

  const failedWorkflow = path.join(temp, "failed-workflow");
  writeFixture(failedWorkflow);
  fs.appendFileSync(path.join(failedWorkflow, "workflow-run.txt"), "conclusion=failure\n");
  expectStatus(failedWorkflow, 1, "failed workflow evidence should fail", "workflow-run.txt must not contain failed release artifact output");

  const tokenLeak = path.join(temp, "token-leak");
  writeFixture(tokenLeak);
  fs.appendFileSync(path.join(tokenLeak, "workflow-run.txt"), `GH_TOKEN=${"gh" + "p_"}abcdefghijklmnopqrstuvwxyz123456\n`);
  expectStatus(tokenLeak, 1, "raw GitHub token should fail", "must not contain a raw GitHub token");

  const missingFile = path.join(temp, "missing-file");
  writeFixture(missingFile);
  fs.rmSync(path.join(missingFile, "artifact-files.txt"));
  expectStatus(missingFile, 1, "missing artifact file list should fail", "artifact-files.txt is missing");
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

console.log("release artifact evidence verifier ok");

function writeFixture(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "workflow-run.txt"),
    [
      "workflow=release-rust.yml",
      "run_url=https://github.com/fieldwork-app/fieldwork/actions/runs/123456789",
      "tag=v1.0.0",
      "conclusion=success",
      "id-token=write",
      "cosign attest-blob --type slsaprovenance1",
      "softprops/action-gh-release@v2 uploaded release assets",
      ...platforms.map(([platform, target]) => `package=${platform} target=${target}`),
      "",
    ].join("\n"),
  );
  fs.writeFileSync(path.join(dir, "github-release-assets.json"), `${JSON.stringify(githubReleaseAssets(), null, 2)}\n`);
  fs.writeFileSync(
    path.join(dir, "artifact-files.txt"),
    [
      ...assets.map((asset, index) => `${digest(index)}  ${asset}`),
      "",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(dir, "verify-release-artifacts.txt"),
    [
      "FIELDWORK_ARTIFACT_DIR=/tmp/fieldwork-release-assets",
      "FIELDWORK_VERIFY_COSIGN_SIGNATURE=1",
      "FIELDWORK_EXPECTED_RELEASE_TAG=v1.0.0",
      "FIELDWORK_COSIGN_IDENTITY_REGEXP=^https://github.com/fieldwork-app/fieldwork/\\.github/workflows/release-rust\\.yml@refs/tags/v.*$",
      "release artifacts ok: archives, sha256 files, and cosign attestation bundles verified",
      "",
    ].join("\n"),
  );
}

function githubReleaseAssets() {
  return {
    tagName: "v1.0.0",
    isDraft: false,
    isPrerelease: false,
    assets: assets.map((name, index) => ({
      name,
      size: 1024 + index,
      url: `https://github.com/fieldwork-app/fieldwork/releases/download/v1.0.0/${name}`,
    })),
  };
}

function digest(index) {
  return `${index + 1}`.repeat(64).slice(0, 64);
}

function expectStatus(dir, expectedStatus, message, expectedOutput = null) {
  const result = spawnSync(process.execPath, [verifier, dir], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.status !== expectedStatus) {
    throw new Error(`${message}: exited ${result.status}, expected ${expectedStatus}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  if (expectedOutput && !`${result.stdout}\n${result.stderr}`.includes(expectedOutput)) {
    throw new Error(`${message}: missing output ${JSON.stringify(expectedOutput)}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
}
