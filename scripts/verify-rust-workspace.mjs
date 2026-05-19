#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const failures = [];

const workspace = read("Cargo.toml");
const expectedMembers = [
  "crates/protocol",
  "crates/daemon",
  "crates/cli",
  "crates/relay",
  "crates/mobile-core",
];

verifyWorkspaceMembers();
verifyWorkspaceMetadata();
verifyPackage("crates/protocol/Cargo.toml", {
  packageName: "fieldwork-protocol",
  description: "Fieldwork v1 wire protocol types and framing.",
  forbiddenBins: true,
});
verifyPackage("crates/daemon/Cargo.toml", {
  packageName: "fieldwork-daemon",
  description: "Fieldwork host daemon.",
  bins: [{ name: "fieldworkd", path: "src/main.rs" }],
});
verifyPackage("crates/cli/Cargo.toml", {
  packageName: "fieldwork-cli",
  description: "Fieldwork desktop CLI.",
  bins: [{ name: "fieldwork", path: "src/main.rs" }],
});
verifyPackage("crates/relay/Cargo.toml", {
  packageName: "fieldwork-relay",
  description: "Fieldwork relay and push gateway.",
  bins: [{ name: "fieldwork-relay", path: "src/main.rs" }],
});
verifyPackage("crates/mobile-core/Cargo.toml", {
  packageName: "fieldwork-mobile-core",
  description: "Fieldwork Rust mobile core.",
  requiredText: ['crate-type = ["lib", "cdylib", "staticlib"]'],
  bins: [{ name: "uniffi-bindgen", path: "uniffi-bindgen.rs" }],
});

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log("rust workspace contract ok");

function verifyWorkspaceMembers() {
  const members = parseWorkspaceMembers(workspace);
  if (!arrayEquals(members, expectedMembers)) {
    failures.push(
      `Cargo.toml workspace members must be exactly ${JSON.stringify(expectedMembers)}, got ${JSON.stringify(members)}`,
    );
  }
}

function verifyWorkspaceMetadata() {
  for (const needle of [
    'version = "1.0.0"',
    'edition = "2024"',
    'license = "AGPL-3.0-or-later"',
    'repository = "https://github.com/fieldwork-app/fieldwork"',
    'description = "Fieldwork universal terminal handoff workspace."',
  ]) {
    requireText(workspace, needle, `Cargo.toml workspace metadata is missing ${needle}`);
  }
}

function verifyPackage(rel, options) {
  const text = read(rel);
  requireText(text, `[package]\nname = "${options.packageName}"`, `${rel} has wrong package name`);
  for (const needle of [
    "version.workspace = true",
    "edition.workspace = true",
    "license.workspace = true",
    "repository.workspace = true",
    `description = "${options.description}"`,
  ]) {
    requireText(text, needle, `${rel} is missing required package metadata: ${needle}`);
  }
  for (const needle of options.requiredText ?? []) {
    requireText(text, needle, `${rel} is missing required contract text: ${needle}`);
  }
  const bins = parseBins(text);
  if (options.forbiddenBins && bins.length > 0) {
    failures.push(`${rel} must not define binaries, got ${JSON.stringify(bins)}`);
  }
  if (options.bins && !arrayEqualsByJson(bins, options.bins)) {
    failures.push(`${rel} binary declarations must be ${JSON.stringify(options.bins)}, got ${JSON.stringify(bins)}`);
  }
}

function parseWorkspaceMembers(text) {
  const match = text.match(/members\s*=\s*\[([\s\S]*?)\]/);
  if (!match) {
    failures.push("Cargo.toml workspace members block is missing");
    return [];
  }
  return [...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);
}

function parseBins(text) {
  const bins = [];
  const sections = text.split(/\n\[\[bin\]\]\n/).slice(1);
  for (const section of sections) {
    const name = section.match(/\n?name\s*=\s*"([^"]+)"/)?.[1];
    const binPath = section.match(/\npath\s*=\s*"([^"]+)"/)?.[1];
    if (name || binPath) {
      bins.push({ name, path: binPath });
    }
  }
  return bins;
}

function read(rel) {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

function requireText(text, needle, message) {
  if (!text.includes(needle)) {
    failures.push(message);
  }
}

function arrayEquals(actual, expected) {
  return Array.isArray(actual) && actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

function arrayEqualsByJson(actual, expected) {
  return JSON.stringify(actual) === JSON.stringify(expected);
}
