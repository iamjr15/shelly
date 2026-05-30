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

verifyPlistAndProjectAssets(plistPaths);

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

function verifyPlistAndProjectAssets(relativePaths) {
  if (!process.env.FIELDWORK_STRUCTURED_ASSETS_FORCE_PORTABLE_PLIST && commandAvailable("plutil")) {
    run("plutil", ["-lint", ...relativePaths]);
    console.log(`plist/project syntax ok (${relativePaths.length} files)`);
    return;
  }

  const xmlPlistPaths = relativePaths.filter((relativePath) => !relativePath.endsWith(".pbxproj"));
  const projectPaths = relativePaths.filter((relativePath) => relativePath.endsWith(".pbxproj"));
  if (xmlPlistPaths.length > 0) {
    run(findPythonWithTomllib(), ["-c", plistVerifierSource(), ...xmlPlistPaths]);
  }
  for (const relativePath of projectPaths) {
    verifyXcodeProjectStructure(relativePath);
  }
  console.log(`plist/project syntax ok (${relativePaths.length} files; portable fallback)`);
}

function commandAvailable(command) {
  const result = spawnSync(command, ["-help"], {
    cwd: root,
    encoding: "utf8",
  });
  return !result.error;
}

function plistVerifierSource() {
  return `
import pathlib
import plistlib
import sys

for relative_path in sys.argv[1:]:
    try:
        with pathlib.Path(relative_path).open("rb") as handle:
            plistlib.load(handle)
    except Exception as exc:
        print(f"{relative_path} is not valid plist XML: {exc}", file=sys.stderr)
        sys.exit(1)

print(f"xml plist syntax ok ({len(sys.argv) - 1} files)")
`.trim();
}

function verifyXcodeProjectStructure(relativePath) {
  const source = fs.readFileSync(path.join(root, relativePath), "utf8");
  if (!source.startsWith("// !$*UTF8*$!")) {
    fail(`${relativePath} is missing the Xcode project UTF-8 header`);
  }
  for (const [description, pattern] of [
    ["archiveVersion", /\barchiveVersion\s*=/],
    ["objectVersion", /\bobjectVersion\s*=/],
    ["objects dictionary", /\bobjects\s*=\s*\{/],
    ["rootObject", /\brootObject\s*=/],
  ]) {
    if (!pattern.test(source)) {
      fail(`${relativePath} is missing required ${description} metadata`);
    }
  }
  verifyBalancedXcodeProjectDelimiters(stripXcodeProjectSyntaxNoise(source, relativePath), relativePath);
}

function stripXcodeProjectSyntaxNoise(source, relativePath) {
  let output = "";
  let state = "normal";
  let escaped = false;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];

    if (state === "lineComment") {
      if (char === "\n") {
        state = "normal";
        output += "\n";
      } else {
        output += " ";
      }
      continue;
    }

    if (state === "blockComment") {
      if (char === "*" && next === "/") {
        state = "normal";
        output += "  ";
        index += 1;
      } else {
        output += char === "\n" ? "\n" : " ";
      }
      continue;
    }

    if (state === "string") {
      if (escaped) {
        escaped = false;
        output += " ";
      } else if (char === "\\") {
        escaped = true;
        output += " ";
      } else if (char === "\"") {
        state = "normal";
        output += " ";
      } else {
        output += char === "\n" ? "\n" : " ";
      }
      continue;
    }

    if (char === "/" && next === "/") {
      state = "lineComment";
      output += "  ";
      index += 1;
    } else if (char === "/" && next === "*") {
      state = "blockComment";
      output += "  ";
      index += 1;
    } else if (char === "\"") {
      state = "string";
      output += " ";
    } else {
      output += char;
    }
  }

  if (state === "blockComment") {
    fail(`${relativePath} has an unterminated block comment`);
  }
  if (state === "string") {
    fail(`${relativePath} has an unterminated string literal`);
  }
  return output;
}

function verifyBalancedXcodeProjectDelimiters(source, relativePath) {
  const closingFor = new Map([
    ["{", "}"],
    ["(", ")"],
  ]);
  const openingFor = new Map([
    ["}", "{"],
    [")", "("],
  ]);
  const stack = [];
  let line = 1;
  let column = 0;

  for (const char of source) {
    if (char === "\n") {
      line += 1;
      column = 0;
      continue;
    }
    column += 1;

    if (closingFor.has(char)) {
      stack.push({ char, line, column });
    } else if (openingFor.has(char)) {
      const expectedOpening = openingFor.get(char);
      const last = stack.pop();
      if (!last || last.char !== expectedOpening) {
        fail(`${relativePath} has an unmatched ${char} at ${line}:${column}`);
      }
    }
  }

  const unclosed = stack.pop();
  if (unclosed) {
    fail(
      `${relativePath} has an unclosed ${unclosed.char}; expected ${closingFor.get(unclosed.char)} after ${unclosed.line}:${unclosed.column}`,
    );
  }
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
