#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const failures = [];

for (const testCase of [
  {
    name: "domain status",
    args: ["scripts/check-domain-status.mjs"],
    expectedError: "Domain status refresh requires --operator-refresh.",
    forbiddenOutput: "domain status check:",
  },
  {
    name: "GitHub namespace",
    args: ["scripts/check-github-namespace.mjs"],
    expectedError: "GitHub namespace refresh requires --operator-refresh.",
    forbiddenOutput: "GitHub namespace check:",
  },
]) {
  const result = spawnSync(process.execPath, testCase.args, {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      FIELDWORK_DOMAIN: "example.invalid",
      FIELDWORK_GITHUB_API: "https://invalid.localhost",
    },
  });

  if (result.status !== 2) {
    failures.push(`${testCase.name} refresh without --operator-refresh exited ${result.status}, expected 2`);
  }
  if (!result.stderr.includes(testCase.expectedError)) {
    failures.push(`${testCase.name} refresh did not print the expected opt-in error`);
  }
  if (result.stdout.includes(testCase.forbiddenOutput)) {
    failures.push(`${testCase.name} refresh appears to have continued past the opt-in guard`);
  }
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log("external status refresh guards ok");
