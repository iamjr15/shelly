#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import fs from "node:fs";
import os from "node:os";
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

assertMissingTokenFailsBeforeNpm();

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

function assertMissingTokenFailsBeforeNpm() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "shelly-no-token-publish-"));
  const fakeNpm = path.join(temp, process.platform === "win32" ? "npm.cmd" : "npm");
  const marker = path.join(temp, "npm-invoked");

  try {
    fs.writeFileSync(
      fakeNpm,
      process.platform === "win32"
        ? `@echo off\r\ntype nul > "${marker}"\r\nexit /b 9\r\n`
        : `#!/bin/sh\n: > "${marker}"\nexit 9\n`,
      { mode: 0o755 },
    );

    const result = spawnSync(process.execPath, ["scripts/publish-npm-packages.mjs"], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...env,
        PATH: `${temp}${path.delimiter}${env.PATH || ""}`,
      },
    });

    if (result.status === 0) {
      console.error("publish without NODE_AUTH_TOKEN unexpectedly passed");
      process.exit(1);
    }
    if (!result.stderr.includes("NODE_AUTH_TOKEN is required for npm publish")) {
      console.error(result.stdout);
      console.error(result.stderr);
      console.error("publish without NODE_AUTH_TOKEN must fail with the token guard");
      process.exit(1);
    }
    if (fs.existsSync(marker)) {
      console.error("publish without NODE_AUTH_TOKEN invoked npm before failing");
      process.exit(1);
    }
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function assert(condition, message) {
  if (!condition) {
    console.error(message);
    process.exit(1);
  }
}
