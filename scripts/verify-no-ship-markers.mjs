#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const failures = [];

const scanEntries = [
  "crates/cli/src",
  "crates/daemon/src",
  "crates/mobile-core/src",
  "crates/protocol/src",
  "crates/relay/src",
  "apps/android/app/src/main",
  "apps/ios/Sources",
  "packages/cli/bin",
  "packages/cli/install.js",
];

const excludedFiles = new Set([
  normalize("apps/ios/Sources/Core/FieldworkCoreStubs.swift"),
]);

const textExtensions = new Set([
  ".kt",
  ".kts",
  ".rs",
  ".sh",
  ".swift",
  ".js",
]);

const forbiddenMarkers = [
  ["todo macro", /\btodo!\s*\(/i],
  ["unimplemented macro", /\bunimplemented!\s*\(/i],
  ["TODO marker", /\bTODO\b/],
  ["FIXME marker", /\bFIXME\b/],
  ["HACK marker", /\bHACK\b/],
  ["XXX marker", /\bXXX\b/],
  ["not implemented marker", /\bnot\s+(?:yet\s+)?implemented\b/i],
];

for (const entry of scanEntries) {
  const absolute = path.join(root, entry);
  if (!fs.existsSync(absolute)) {
    failures.push(`no-ship scan entry is missing: ${entry}`);
    continue;
  }
  const stat = fs.statSync(absolute);
  if (stat.isDirectory()) {
    for (const file of walk(absolute)) {
      scanFile(file);
    }
  } else {
    scanFile(absolute);
  }
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log("no-ship marker scan ok");

function scanFile(file) {
  const rel = normalize(path.relative(root, file));
  if (excludedFiles.has(rel)) {
    return;
  }
  if (!textExtensions.has(path.extname(file)) && !isExtensionlessScript(file)) {
    return;
  }

  const text = fs.readFileSync(file, "utf8");
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    for (const [label, pattern] of forbiddenMarkers) {
      if (pattern.test(line)) {
        failures.push(`${rel}:${index + 1}: ${label} is not allowed in production v1 source`);
      }
    }
  }
}

function isExtensionlessScript(file) {
  const base = path.basename(file);
  if (base.includes(".")) {
    return false;
  }
  try {
    return fs.readFileSync(file, "utf8").startsWith("#!");
  } catch {
    return false;
  }
}

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (["build", "generated", "node_modules", "target"].includes(entry.name)) {
        continue;
      }
      yield* walk(absolute);
    } else if (entry.isFile()) {
      yield absolute;
    }
  }
}

function normalize(value) {
  return value.split(path.sep).join("/");
}
