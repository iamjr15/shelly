#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const verifier = path.join(root, "scripts/verify-npm-release-evidence.mjs");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "fieldwork-npm-release-evidence-"));
const expectedNames = [
  "fieldwork-darwin-arm64",
  "fieldwork-darwin-x64",
  "fieldwork-linux-arm64",
  "fieldwork-linux-x64",
  "fieldwork",
];

try {
  const good = path.join(temp, "good");
  writeFixture(good);
  expectStatus(good, 0, "good npm release evidence should pass");

  const wrongOrder = path.join(temp, "wrong-order");
  writeFixture(wrongOrder);
  const plan = publishPlan();
  plan.packages.reverse();
  fs.writeFileSync(path.join(wrongOrder, "publish-plan.json"), `${JSON.stringify(plan, null, 2)}\n`);
  expectStatus(wrongOrder, 1, "wrong publish plan order should fail", "publish-plan.json package 0 must be fieldwork-darwin-arm64");

  const missingProvenance = path.join(temp, "missing-provenance");
  writeFixture(missingProvenance);
  const metadata = packageMetadata();
  delete metadata.packages[3].versions["1.0.0"].dist.attestations;
  fs.writeFileSync(path.join(missingProvenance, "package-metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`);
  expectStatus(missingProvenance, 1, "missing npm provenance should fail", "fieldwork-linux-x64@1.0.0 package metadata must include npm SLSA provenance");

  const tokenLeak = path.join(temp, "token-leak");
  writeFixture(tokenLeak);
  fs.appendFileSync(path.join(tokenLeak, "workflow-run.txt"), `NPM_TOKEN=${"np" + "m_"}abcdefghijklmnopqrstuvwxyz\n`);
  expectStatus(tokenLeak, 1, "raw npm token should fail", "must not contain a raw npm token");

  const dryRun = path.join(temp, "dry-run");
  writeFixture(dryRun);
  fs.appendFileSync(path.join(dryRun, "npm-publish-log.txt"), "npm publish --dry-run\n");
  expectStatus(dryRun, 1, "dry-run publish output should fail", "must not use dry-run output as release evidence");

  const scopedName = path.join(temp, "scoped-name");
  writeFixture(scopedName);
  fs.appendFileSync(path.join(scopedName, "npm-publish-log.txt"), "published @fieldwork/cli@1.0.0\n");
  expectStatus(scopedName, 1, "legacy scoped package evidence should fail", "must not contain legacy scoped @fieldwork/* package names");

  const extraLogPackage = path.join(temp, "extra-log-package");
  writeFixture(extraLogPackage);
  fs.appendFileSync(path.join(extraLogPackage, "npm-publish-log.txt"), "published fieldwork-win32-x64@1.0.0\n");
  expectStatus(extraLogPackage, 1, "extra Fieldwork publish-log package should fail", "must not contain non-v1 Fieldwork npm package fieldwork-win32-x64");

  const extraMetadataPackage = path.join(temp, "extra-metadata-package");
  writeFixture(extraMetadataPackage);
  const extraMetadata = packageMetadata();
  extraMetadata.packages.push({
    name: "fieldwork-linux-musl-x64",
    "dist-tags": { latest: "1.0.0" },
    versions: {
      "1.0.0": {
        dist: {
          attestations: {
            provenance: {
              predicateType: "https://slsa.dev/provenance/v1",
            },
          },
        },
      },
    },
  });
  fs.writeFileSync(path.join(extraMetadataPackage, "package-metadata.json"), `${JSON.stringify(extraMetadata, null, 2)}\n`);
  expectStatus(extraMetadataPackage, 1, "extra package metadata should fail", "package-metadata.json must contain exactly the five v1 npm packages");

  const unpublished = path.join(temp, "unpublished");
  writeFixture(unpublished);
  fs.writeFileSync(path.join(unpublished, "registry-state.txt"), "npm registry-state check: https://registry.npmjs.org\nunpublished: fieldwork-linux-x64 (registry returned 404)\n");
  expectStatus(unpublished, 1, "unpublished registry output should fail", "must show fieldwork-darwin-arm64@1.0.0 with npm SLSA provenance");

  const missingFile = path.join(temp, "missing-file");
  writeFixture(missingFile);
  fs.rmSync(path.join(missingFile, "workflow-run.txt"));
  expectStatus(missingFile, 1, "missing workflow file should fail", "workflow-run.txt is missing");
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

console.log("npm release evidence verifier ok");

function writeFixture(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "publish-plan.json"), `${JSON.stringify(publishPlan(), null, 2)}\n`);
  fs.writeFileSync(path.join(dir, "publish-readiness.txt"), `npm publish readiness ok: ${expectedNames.join(" -> ")}\n`);
  fs.writeFileSync(
    path.join(dir, "workflow-run.txt"),
    [
      "workflow=release-npm.yml",
      "run_url=https://github.com/fieldwork-app/fieldwork/actions/runs/123456789",
      "tag=v1.0.0",
      "conclusion=success",
      "NPM_TOKEN=<redacted>",
      "provenance=enabled",
      "children-first publishing confirmed",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(dir, "npm-publish-log.txt"),
    [
      "npm publish --provenance --access public",
      ...expectedNames.map((name) => `published ${name}@1.0.0`),
      "",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(dir, "registry-state.txt"),
    [
      "npm registry-state check: https://registry.npmjs.org",
      ...expectedNames.map((name) => `published: ${name}@1.0.0 (provenance: https://slsa.dev/provenance/v1)`),
      "npm registry-state ok",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(path.join(dir, "package-metadata.json"), `${JSON.stringify(packageMetadata(), null, 2)}\n`);
}

function publishPlan() {
  const packageDirs = [
    "packages/cli-darwin-arm64",
    "packages/cli-darwin-x64",
    "packages/cli-linux-arm64",
    "packages/cli-linux-x64",
    "packages/cli",
  ];
  return {
    command: "npm",
    packages: expectedNames.map((name, index) => ({
      name,
      packageDir: packageDirs[index],
      args: ["publish", path.join(root, packageDirs[index]), "--provenance", "--access", "public"],
    })),
  };
}

function packageMetadata() {
  return {
    packages: expectedNames.map((name) => ({
      name,
      "dist-tags": { latest: "1.0.0" },
      versions: {
        "1.0.0": {
          name,
          version: "1.0.0",
          dist: {
            attestations: {
              provenance: {
                predicateType: "https://slsa.dev/provenance/v1",
              },
            },
          },
        },
      },
    })),
  };
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
