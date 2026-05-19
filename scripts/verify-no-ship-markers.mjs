#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const args = new Set(process.argv.slice(2));

for (const arg of args) {
  if (arg !== "--self-test") {
    console.error(`unknown argument: ${arg}`);
    process.exit(2);
  }
}

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

if (args.has("--self-test")) {
  runSelfTest();
  process.exit(0);
}

const failures = scanRoot(root);

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log("no-ship marker scan ok");

function scanRoot(scanRootPath) {
  const scanFailures = [];
  for (const entry of scanEntries) {
    const absolute = path.join(scanRootPath, entry);
    if (!fs.existsSync(absolute)) {
      scanFailures.push(`no-ship scan entry is missing: ${entry}`);
      continue;
    }
    const stat = fs.statSync(absolute);
    if (stat.isDirectory()) {
      for (const file of walk(absolute)) {
        scanFile(file, scanRootPath, scanFailures);
      }
    } else {
      scanFile(absolute, scanRootPath, scanFailures);
    }
  }
  return scanFailures;
}

function scanFile(file, scanRootPath, scanFailures) {
  const rel = normalize(path.relative(scanRootPath, file));
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
        scanFailures.push(`${rel}:${index + 1}: ${label} is not allowed in production v1 source`);
      }
    }
  }
}

function runSelfTest() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "fieldwork-no-ship-"));
  try {
    createSyntheticTree(temp);

    const failuresWithMarker = scanRoot(temp);
    assert(
      failuresWithMarker.length === 1 &&
        failuresWithMarker[0].includes("crates/daemon/src/lib.rs:2: todo macro"),
      `expected one todo! failure, got: ${failuresWithMarker.join("; ")}`,
    );

    fs.writeFileSync(path.join(temp, "crates/daemon/src/lib.rs"), "pub fn clean() {}\n");
    let failures = scanRoot(temp);
    assert(failures.length === 0, `expected clean synthetic tree, got: ${failures.join("; ")}`);

    fs.writeFileSync(path.join(temp, "apps/android/app/src/main/Main.kt"), "fun pending() = error(\"not yet implemented\")\n");
    failures = scanRoot(temp);
    assert(
      failures.length === 1 && failures[0].includes("not implemented marker"),
      `expected not implemented failure, got: ${failures.join("; ")}`,
    );
  } finally {
    fs.rmSync(temp, { force: true, recursive: true });
  }

  console.log("no-ship marker self-test ok");
}

function createSyntheticTree(temp) {
  for (const entry of scanEntries) {
    const absolute = path.join(temp, entry);
    if (path.extname(entry)) {
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(absolute, "clean\n");
    } else {
      fs.mkdirSync(absolute, { recursive: true });
      fs.writeFileSync(path.join(absolute, "clean.rs"), "pub fn clean() {}\n");
    }
  }

  fs.writeFileSync(path.join(temp, "crates/daemon/src/lib.rs"), "pub fn blocked() {\n    todo!(\"ship me\");\n}\n");
  fs.mkdirSync(path.join(temp, "apps/ios/Sources/Core"), { recursive: true });
  fs.writeFileSync(
    path.join(temp, "apps/ios/Sources/Core/FieldworkCoreStubs.swift"),
    "// TODO allowed in compile-guarded stub shim\n",
  );
  fs.mkdirSync(path.join(temp, "apps/android/generated/uniffi"), { recursive: true });
  fs.writeFileSync(path.join(temp, "apps/android/generated/uniffi/generated.kt"), "// TODO generated\n");
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
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
