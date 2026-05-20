#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const failures = [];

const result = spawnSync(process.execPath, ["scripts/verify-release-audit.mjs", "--list-unchecked"], {
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

for (const expected of [
  "Unchecked PLAN.md gates: 37",
  "ios-xcode (1)",
  "signing (4)",
  "publish (3)",
  "provider (5)",
  "physical-device (13)",
  "store-console (2)",
  "operator (9)",
  "Operator: confirm npm publish rights for the platform child package family",
  "Block out the next 10 weeks",
]) {
  if (!result.stdout.includes(expected)) {
    failures.push(`release-audit list mode missing expected output: ${expected}`);
  }
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log("release audit list mode ok");
