#!/usr/bin/env node
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

const root = path.resolve(new URL("..", import.meta.url).pathname);

const jsonPaths = gitLsFiles([
  "*.json",
  ":!:apps/android/app/build/**",
  ":!:node_modules/**",
  ":!:references/**",
  ":!:site/dist/**",
  ":!:site/node_modules/**",
  ":!:target/**",
]);
const tomlPaths = gitLsFiles([
  "*.toml",
  ":!:apps/android/app/build/**",
  ":!:node_modules/**",
  ":!:references/**",
  ":!:site/dist/**",
  ":!:site/node_modules/**",
  ":!:target/**",
]);
const plistPaths = [
  "apps/ios/Fieldwork.xcodeproj/project.pbxproj",
  "apps/ios/Resources/Info.plist",
  "apps/ios/Resources/Fieldwork.entitlements",
];
const xmlSvgPaths = gitLsFiles([
  "apps/android/app/src/main/AndroidManifest.xml",
  "apps/android/app/src/main/res/**/*.xml",
  "docs/assets/*.svg",
]);

if (jsonPaths.length === 0) {
  fail("no tracked JSON assets found");
}
if (tomlPaths.length === 0) {
  fail("no tracked TOML assets found");
}
if (xmlSvgPaths.length === 0) {
  fail("no tracked Android XML or docs SVG assets found");
}

for (const relativePath of jsonPaths) {
  try {
    JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8"));
  } catch (error) {
    fail(`${relativePath} is not valid JSON: ${error.message}`);
  }
}
console.log(`json asset syntax ok (${jsonPaths.length} files)`);

run(findPythonWithTomllib(), ["-c", tomlVerifierSource(), ...tomlPaths]);

run("plutil", ["-lint", ...plistPaths]);
console.log(`plist/project syntax ok (${plistPaths.length} files)`);

run("xmllint", ["--noout", ...xmlSvgPaths]);
console.log(`xml/svg asset syntax ok (${xmlSvgPaths.length} files)`);

function gitLsFiles(pathspecs) {
  const result = spawnSync("git", ["ls-files", ...pathspecs], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.error) {
    fail(`git ls-files failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(`git ls-files failed with exit code ${result.status}: ${result.stderr.trim()}`);
  }
  return result.stdout.split("\n").filter(Boolean).sort();
}

function findPythonWithTomllib() {
  for (const command of ["python3", "python3.14", "python3.13", "python3.12", "python3.11"]) {
    const result = spawnSync(command, ["-c", "import tomllib"], {
      cwd: root,
      encoding: "utf8",
    });
    if (!result.error && result.status === 0) {
      return command;
    }
  }
  fail("python3.11+ with the standard tomllib module is required for TOML asset syntax checks");
}

function tomlVerifierSource() {
  return `
import pathlib
import sys
import tomllib

for relative_path in sys.argv[1:]:
    try:
        tomllib.loads(pathlib.Path(relative_path).read_text(encoding="utf-8"))
    except Exception as exc:
        print(f"{relative_path} is not valid TOML: {exc}", file=sys.stderr)
        sys.exit(1)

print(f"toml asset syntax ok ({len(sys.argv) - 1} files)")
`.trim();
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
  });
  if (result.error) {
    fail(`${command} failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(`${command} failed with exit code ${result.status}`);
  }
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
