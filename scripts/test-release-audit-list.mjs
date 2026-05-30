#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const failures = [];

const result = spawnSync(process.execPath, ["scripts/verify-release-audit.mjs", "--list-unchecked"], {
  cwd: root,
  encoding: "utf8",
});

const pnpmSeparatorResult = spawnSync(process.execPath, ["scripts/verify-release-audit.mjs", "--", "--list-unchecked"], {
  cwd: root,
  encoding: "utf8",
});

const packageScriptResult = spawnSync("pnpm", ["check:release-audit:list"], {
  cwd: root,
  encoding: "utf8",
});

if (result.status !== 0) {
  failures.push(`release-audit list mode exited ${result.status}`);
}
if (result.stderr.trim() !== "") {
  failures.push(`release-audit list mode wrote stderr: ${result.stderr.trim()}`);
}
if (result.stdout.includes("release audit ok")) {
  failures.push("release-audit list mode must print the gate list, not the default ok line");
}
if (pnpmSeparatorResult.status !== 0) {
  failures.push(`release-audit list mode with -- separator exited ${pnpmSeparatorResult.status}`);
}
if (pnpmSeparatorResult.stderr.trim() !== "") {
  failures.push(`release-audit list mode with -- separator wrote stderr: ${pnpmSeparatorResult.stderr.trim()}`);
}
if (pnpmSeparatorResult.stdout !== result.stdout) {
  failures.push("release-audit list mode with -- separator must match direct list output");
}
if (packageScriptResult.status !== 0) {
  failures.push(`release-audit package list script exited ${packageScriptResult.status}`);
}
if (packageScriptResult.stderr.trim() !== "") {
  failures.push(`release-audit package list script wrote stderr: ${packageScriptResult.stderr.trim()}`);
}
if (!packageScriptResult.stdout.includes(result.stdout)) {
  failures.push("release-audit package list script must print the same grouped output");
}

for (const expected of [
  "Unchecked PLAN.md gates: 33",
  "ios-xcode (1)",
  "signing (4)",
  "publish (3)",
  "provider (4)",
  "physical-device (14)",
  "30-minute physical Android terminal renderer dogfood",
  "store-console (2)",
  "operator (5)",
  "Block out the next 10 weeks",
]) {
  if (!result.stdout.includes(expected)) {
    failures.push(`release-audit list mode missing expected output: ${expected}`);
  }
}

const unknownFlag = spawnSync(process.execPath, ["scripts/verify-release-audit.mjs", "--list-uncheked"], {
  cwd: root,
  encoding: "utf8",
});

if (unknownFlag.status !== 2) {
  failures.push(`release-audit unknown flag exited ${unknownFlag.status}, expected 2`);
}
if (!unknownFlag.stderr.includes("unknown argument: --list-uncheked")) {
  failures.push("release-audit unknown flag did not print the expected error");
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log("release audit list mode ok");
