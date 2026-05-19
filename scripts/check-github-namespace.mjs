#!/usr/bin/env node
import process from "node:process";

const owner = process.env.FIELDWORK_GITHUB_OWNER || "fieldwork-app";
const repo = process.env.FIELDWORK_GITHUB_REPO || "fieldwork";
const args = new Set(process.argv.slice(2));
const operatorRefresh = args.has("--operator-refresh");
const expectAvailable = args.has("--expect-available");
const api = (process.env.FIELDWORK_GITHUB_API || "https://api.github.com").replace(/\/+$/, "");

if (args.has("--help") || args.has("-h")) {
  console.log("usage: node scripts/check-github-namespace.mjs --operator-refresh [--expect-available]");
  console.log("Performs an operator-requested GitHub namespace status refresh; it does not reserve anything.");
  process.exit(0);
}

if (!operatorRefresh) {
  console.error("GitHub namespace refresh requires --operator-refresh.");
  console.error("This live GitHub API lookup is not a routine local check and does not reserve anything.");
  process.exit(2);
}

const checks = [
  { label: "org", path: `/orgs/${owner}` },
  { label: "user", path: `/users/${owner}` },
  { label: "repo", path: `/repos/${owner}/${repo}` },
];

const results = [];
for (const check of checks) {
  results.push(await query(check));
}

console.log(`GitHub namespace check: ${owner}/${repo}`);
for (const result of results) {
  console.log(`${result.label}: ${result.status}`);
}

const failures = [];
if (expectAvailable) {
  for (const result of results) {
    if (result.status !== "absent") {
      failures.push(`${result.label} ${result.path} is ${result.status}, expected absent`);
    }
  }
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

if (expectAvailable) {
  console.log("GitHub namespace availability ok");
} else {
  console.log("GitHub namespace status ok");
}

async function query(check) {
  const response = await fetch(`${api}${check.path}`, {
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": "fieldwork-release-audit",
    },
    signal: AbortSignal.timeout(10_000),
  });

  if (response.status === 404) {
    return { ...check, status: "absent" };
  }
  if (response.ok) {
    return { ...check, status: "present" };
  }
  throw new Error(`GitHub ${check.path} returned HTTP ${response.status}`);
}
