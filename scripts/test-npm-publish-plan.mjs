#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const expected = [
  ["shellykit-darwin-arm64", "packages/cli-darwin-arm64"],
  ["shellykit-darwin-x64", "packages/cli-darwin-x64"],
  ["shellykit-linux-arm64", "packages/cli-linux-arm64"],
  ["shellykit-linux-x64", "packages/cli-linux-x64"],
  ["shellykit", "packages/cli"],
];

const env = { ...process.env };
delete env.NODE_AUTH_TOKEN;

assertTrustedPublishingWorkflow();

const result = spawnSync(process.execPath, ["scripts/publish-npm-packages.mjs", "--publish-plan-json"], {
  cwd: root,
  encoding: "utf8",
  env,
});

if (result.status !== 0) {
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exit(result.status ?? 1);
}

const plan = JSON.parse(result.stdout);
assert(plan.command === (process.platform === "win32" ? "npm.cmd" : "npm"), "publish command must use npm");
assert(Array.isArray(plan.packages), "publish plan must include packages array");
assert(plan.packages.length === expected.length, "publish plan must include exactly 5 packages");

for (let index = 0; index < expected.length; index += 1) {
  const [name, packageDir] = expected[index];
  const entry = plan.packages[index];
  const expectedArgs = [
    "publish",
    path.join(root, packageDir),
    "--provenance",
    "--access",
    "public",
  ];

  assert(entry.name === name, `publish plan item ${index} must be ${name}`);
  assert(entry.packageDir === packageDir, `${name} must publish from ${packageDir}`);
  assert(JSON.stringify(entry.args) === JSON.stringify(expectedArgs), `${name} publish args are wrong`);
}

console.log("npm publish plan ok: children first, provenance enabled, public access");

function assertTrustedPublishingWorkflow() {
  const workflow = fs.readFileSync(path.join(root, ".github/workflows/release-npm.yml"), "utf8");
  assert(workflow.includes("id-token: write"), "npm release workflow must request an OIDC identity token");
  assert(workflow.includes("package-manager-cache: false"), "npm release workflow must disable package-manager caching");
  assert(workflow.includes("npm@11.17.0"), "npm release workflow must pin an OIDC-capable npm CLI");
  assert(!workflow.includes("NPM_TOKEN"), "npm release workflow must not use an npm publishing token");
  assert(!workflow.includes("NODE_AUTH_TOKEN"), "npm release workflow must not inject npm token authentication");
}

function assert(condition, message) {
  if (!condition) {
    console.error(message);
    process.exit(1);
  }
}
