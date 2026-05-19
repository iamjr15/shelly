#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const artifactDir = path.resolve(root, process.env.FIELDWORK_ARTIFACT_DIR || "artifacts");
const mappings = [
  { key: "darwin-arm64", target: "aarch64-apple-darwin" },
  { key: "darwin-x64", target: "x86_64-apple-darwin" },
  { key: "linux-arm64", target: "aarch64-unknown-linux-gnu" },
  { key: "linux-x64", target: "x86_64-unknown-linux-gnu" },
];
const packageDirs = [
  path.join(root, "packages", "cli"),
  ...mappings.map((mapping) => path.join(root, "packages", `cli-${mapping.key}`)),
];

if (!fs.existsSync(artifactDir)) {
  fail(`artifact directory not found: ${artifactDir}`);
}

copyLegalFiles();

for (const mapping of mappings) {
  const candidates = findCandidateRoots(artifactDir, mapping);
  if (candidates.length === 0) {
    fail(`missing extracted artifact directory for ${mapping.key} (${mapping.target})`);
  }
  const pair = findExecutablePair(candidates);
  if (!pair) {
    fail(`missing fieldwork/fieldworkd artifacts for ${mapping.key}`);
  }

  const outDir = path.join(root, "packages", `cli-${mapping.key}`, "bin");
  fs.mkdirSync(outDir, { recursive: true });
  copyExecutable(pair.fieldwork, path.join(outDir, "fieldwork"));
  copyExecutable(pair.fieldworkd, path.join(outDir, "fieldworkd"));
  console.log(`prepared ${mapping.key}`);
}

function copyLegalFiles() {
  for (const packageDir of packageDirs) {
    fs.copyFileSync(path.join(root, "LICENSE"), path.join(packageDir, "LICENSE"));
    fs.copyFileSync(path.join(root, "NOTICE"), path.join(packageDir, "NOTICE"));
  }
}

function findCandidateRoots(rootDir, mapping) {
  const roots = [];
  walk(rootDir, (entry) => {
    if (!entry.isDirectory()) {
      return;
    }
    const value = entry.path;
    if (value.includes(mapping.key) || value.includes(mapping.target)) {
      roots.push(value);
    }
  });
  return roots;
}

function findExecutablePair(roots) {
  for (const rootDir of roots) {
    const fieldwork = findFile([rootDir], "fieldwork");
    const fieldworkd = findFile([rootDir], "fieldworkd");
    if (fieldwork && fieldworkd) {
      return { fieldwork, fieldworkd };
    }
  }
  return null;
}

function findFile(roots, name) {
  for (const rootDir of roots) {
    let found = null;
    walk(rootDir, (entry) => {
      if (!found && entry.isFile() && path.basename(entry.path) === name) {
        found = entry.path;
      }
    });
    if (found) {
      return found;
    }
  }
  return null;
}

function walk(start, visit) {
  for (const dirent of fs.readdirSync(start, { withFileTypes: true })) {
    const entry = {
      path: path.join(start, dirent.name),
      isDirectory: () => dirent.isDirectory(),
      isFile: () => dirent.isFile(),
    };
    visit(entry);
    if (dirent.isDirectory()) {
      walk(entry.path, visit);
    }
  }
}

function copyExecutable(from, to) {
  fs.copyFileSync(from, to);
  fs.chmodSync(to, 0o755);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
