#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const defaultRoot = path.resolve(new URL("..", import.meta.url).pathname);
const generatedFiles = ["README.md", "manifest.json", "activate.sh", "fieldwork", "fw", "fieldworkd"];
const options = parseArgs(process.argv.slice(2));
const repoRoot = path.resolve(options.repoRoot ?? defaultRoot);
const shimDir = path.resolve(options.dir ?? path.join("/tmp", `fieldwork-live-bin-${timestampForDir(new Date())}`));
const fieldwork = path.join(repoRoot, "target/release/fieldwork");
const fieldworkd = path.join(repoRoot, "target/release/fieldworkd");

requireExecutable(fieldwork, "release fieldwork binary");
requireExecutable(fieldworkd, "release fieldworkd binary");

if (fs.existsSync(shimDir)) {
  const existing = fs.readdirSync(shimDir);
  if (existing.length > 0 && !options.force) {
    console.error(`shim directory is not empty: ${shimDir}`);
    console.error("rerun with --force to refresh the live-testing fw shim");
    process.exit(1);
  }
} else {
  fs.mkdirSync(shimDir, { recursive: true, mode: 0o700 });
}

const manifest = {
  schema: "fieldwork-live-testing-fw-shim-v1",
  createdAt: new Date().toISOString(),
  repoRoot,
  shimDir,
  binaries: {
    fieldwork,
    fw: fieldwork,
    fieldworkd,
  },
  generatedFiles,
  note: "Source-checkout live testing shim for the npm-style fw, fieldwork, and fieldworkd command names. It does not replace npm package verification.",
};

writeFile("manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
writeFile("README.md", buildReadme());
writeFile("activate.sh", `export PATH=${shellQuote(shimDir)}:"$PATH"\n`, 0o700);
writeSymlink("fieldwork", fieldwork);
writeSymlink("fw", fieldwork);
writeSymlink("fieldworkd", fieldworkd);

if (options.printExport) {
  process.stdout.write(`export PATH=${shellQuote(shimDir)}:"$PATH"\n`);
} else if (options.printDir) {
  process.stdout.write(`${shimDir}\n`);
} else if (!options.quiet) {
  console.log(`Fieldwork live-testing fw shim created: ${shimDir}`);
  console.log(`next: source ${path.join(shimDir, "activate.sh")}`);
}

function parseArgs(args) {
  const parsed = {
    dir: null,
    force: false,
    printDir: false,
    printExport: false,
    quiet: false,
    repoRoot: null,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") {
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }
    if (arg === "--force") {
      parsed.force = true;
      continue;
    }
    if (arg === "--print-dir") {
      parsed.printDir = true;
      continue;
    }
    if (arg === "--print-export") {
      parsed.printExport = true;
      continue;
    }
    if (arg === "--quiet") {
      parsed.quiet = true;
      continue;
    }
    if (arg === "--dir" || arg === "--repo-root") {
      const value = args[index + 1];
      if (!value) {
        console.error(`${arg} requires a path`);
        process.exit(2);
      }
      parsed[arg === "--dir" ? "dir" : "repoRoot"] = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--dir=")) {
      parsed.dir = arg.slice("--dir=".length);
      continue;
    }
    if (arg.startsWith("--repo-root=")) {
      parsed.repoRoot = arg.slice("--repo-root=".length);
      continue;
    }
    console.error(`unknown argument: ${arg}`);
    printUsage();
    process.exit(2);
  }

  return parsed;
}

function printUsage() {
  console.error("usage: node scripts/create-live-testing-fw-shim.mjs [--dir <path>] [--repo-root <path>] [--force] [--print-dir|--print-export] [--quiet]");
}

function requireExecutable(filePath, label) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    console.error(`missing ${label}: ${path.relative(repoRoot, filePath)}`);
    process.exit(1);
  }
  if ((fs.statSync(filePath).mode & 0o111) === 0) {
    console.error(`${label} is not executable: ${path.relative(repoRoot, filePath)}`);
    process.exit(1);
  }
}

function writeFile(relativePath, contents, mode = 0o600) {
  const filePath = path.join(shimDir, relativePath);
  fs.writeFileSync(filePath, contents, { mode });
  fs.chmodSync(filePath, mode);
}

function writeSymlink(relativePath, target) {
  const filePath = path.join(shimDir, relativePath);
  fs.rmSync(filePath, { force: true });
  fs.symlinkSync(target, filePath);
}

function buildReadme() {
  return `# Fieldwork Live-Testing fw Shim

This directory exposes the source-built release binaries under the same command
names users get from the npm package:

- \`fieldwork\`
- \`fw\`
- \`fieldworkd\`

Activate it before the physical Android live-test evidence pass:

\`\`\`sh
source ${shellQuote(path.join(shimDir, "activate.sh"))}
fw --help
pnpm check:live-testing-readiness
\`\`\`

This helper is only for source-checkout live testing. It does not replace the
npm package install, npm provenance, platform package, or release signing gates.
`;
}

function timestampForDir(date) {
  const pad = (value) => `${value}`.padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join("");
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
