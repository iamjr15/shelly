#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const packageDirs = [
  "packages/cli",
  "packages/cli-darwin-arm64",
  "packages/cli-darwin-x64",
  "packages/cli-linux-arm64",
  "packages/cli-linux-x64",
];
const expectedPackageNames = [
  "fieldwork",
  "fieldwork-darwin-arm64",
  "fieldwork-darwin-x64",
  "fieldwork-linux-arm64",
  "fieldwork-linux-x64",
];

const config = readJson(".changeset/config.json");
const packageNames = packageDirs.map((dir) => readJson(path.join(dir, "package.json")).name);
assert(
  JSON.stringify(packageNames.sort()) === JSON.stringify([...expectedPackageNames].sort()),
  "Changesets package set must stay exactly the v1 npm package set",
);

assert(config.commit === false, "Changesets must not commit directly");
assert(Array.isArray(config.linked) && config.linked.length === 0, "Changesets linked groups must remain empty");
assert(config.access === "public", "Changesets access must be public");
assert(config.baseBranch === "main", "Changesets baseBranch must be main");
assert(Array.isArray(config.ignore) && config.ignore.length === 0, "Changesets must not ignore v1 packages");
assert(
  Array.isArray(config.changelog) &&
    config.changelog[0] === "@changesets/changelog-github" &&
    config.changelog[1]?.repo === "fieldwork-app/fieldwork",
  "Changesets changelog must use @changesets/changelog-github for fieldwork-app/fieldwork",
);

assert(Array.isArray(config.fixed), "Changesets fixed groups must be configured");
const expandedGroups = config.fixed.map((group) => expandFixedGroup(group, packageNames));
const coveringGroups = expandedGroups.filter((group) =>
  expectedPackageNames.every((name) => group.includes(name)),
);
assert(coveringGroups.length === 1, "Changesets fixed group must cover all five v1 npm packages exactly once");
assert(
  coveringGroups[0].length === expectedPackageNames.length,
  "Changesets fixed group must not include packages outside the v1 npm package set",
);

const meta = readJson("packages/cli/package.json");
for (const packageName of expectedPackageNames.slice(1)) {
  assert(
    meta.optionalDependencies?.[packageName] === meta.version,
    `${packageName} must be an optionalDependency pinned to the meta package version`,
  );
}

const rootManifest = readJson("package.json");
assert(
  rootManifest.devDependencies?.["@changesets/cli"],
  "root package.json must keep @changesets/cli as a dev dependency",
);
assert(
  rootManifest.devDependencies?.["@changesets/changelog-github"],
  "root package.json must keep @changesets/changelog-github as a dev dependency",
);

console.log("Changesets fixed-group config ok: all five npm packages stay in lockstep");

function expandFixedGroup(group, knownPackages) {
  assert(Array.isArray(group), "Changesets fixed group entries must be arrays");
  const expanded = new Set();
  for (const pattern of group) {
    assert(typeof pattern === "string" && pattern.length > 0, "Changesets fixed group entries must be package names or globs");
    if (pattern.includes("*")) {
      const matcher = globMatcher(pattern);
      for (const packageName of knownPackages) {
        if (matcher(packageName)) {
          expanded.add(packageName);
        }
      }
    } else {
      expanded.add(pattern);
    }
  }
  return [...expanded].sort();
}

function globMatcher(pattern) {
  const escaped = pattern
    .split("*")
    .map((part) => part.replace(/[|\\{}()[\]^$+?.]/g, "\\$&"))
    .join(".*");
  const regexp = new RegExp(`^${escaped}$`);
  return (value) => regexp.test(value);
}

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8"));
}

function assert(condition, message) {
  if (!condition) {
    console.error(message);
    process.exit(1);
  }
}
