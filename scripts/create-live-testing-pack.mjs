#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

const defaultRoot = path.resolve(new URL("..", import.meta.url).pathname);
const generatedFiles = ["README.md", "manifest.json", "setup.sh", "preflight.sh"];

const options = parseArgs(process.argv.slice(2));
const repoRoot = path.resolve(options.repoRoot ?? defaultRoot);
const packDir = path.resolve(options.dir ?? path.join("/tmp", `fieldwork-live-testing-${timestampForDir(new Date())}`));
const binDir = path.join(packDir, "bin");
const evidenceDir = path.join(packDir, "evidence");

if (fs.existsSync(packDir)) {
  const existing = fs.readdirSync(packDir);
  if (existing.length > 0 && !options.force) {
    console.error(`live-testing pack directory is not empty: ${packDir}`);
    console.error("rerun with --force to refresh scaffold files without deleting captured evidence");
    process.exit(1);
  }
} else {
  fs.mkdirSync(packDir, { recursive: true, mode: 0o700 });
}

runScaffold("fw shim", [
  path.join(defaultRoot, "scripts/create-live-testing-fw-shim.mjs"),
  "--repo-root",
  repoRoot,
  "--dir",
  binDir,
  "--quiet",
  ...(options.force ? ["--force"] : []),
]);
runScaffold("evidence directory", [
  path.join(defaultRoot, "scripts/create-live-testing-evidence-dir.mjs"),
  "--dir",
  evidenceDir,
  "--quiet",
  ...(options.force ? ["--force"] : []),
]);

const manifest = {
  schema: "fieldwork-live-testing-pack-v1",
  createdAt: new Date().toISOString(),
  repoRoot,
  packDir,
  binDir,
  evidenceDir,
  generatedFiles,
  scaffolds: {
    bin: "scripts/create-live-testing-fw-shim.mjs",
    evidence: "scripts/create-live-testing-evidence-dir.mjs",
  },
  note: "First-round Android live-testing pack for source checkouts. It creates a temporary npm-style fw shim and an evidence scaffold, but it does not create or fabricate test evidence.",
};

writeFile("manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
writeFile("README.md", buildReadme());
writeFile("setup.sh", buildSetupScript(), 0o700);
writeFile("preflight.sh", buildPreflightScript(), 0o700);

if (options.printDir) {
  process.stdout.write(`${packDir}\n`);
} else if (!options.quiet) {
  console.log(`Fieldwork live-testing pack created: ${packDir}`);
  console.log(`next: source ${path.join(packDir, "setup.sh")}`);
}

function parseArgs(args) {
  const parsed = {
    dir: null,
    force: false,
    printDir: false,
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
  console.error("usage: node scripts/create-live-testing-pack.mjs [--dir <path>] [--repo-root <path>] [--force] [--print-dir] [--quiet]");
}

function runScaffold(label, args) {
  const result = spawnSync(process.execPath, args, {
    cwd: defaultRoot,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    if (result.stdout) {
      process.stdout.write(result.stdout);
    }
    if (result.stderr) {
      process.stderr.write(result.stderr);
    }
    console.error(`failed to create ${label} scaffold`);
    process.exit(result.status ?? 1);
  }
}

function writeFile(relativePath, contents, mode = 0o600) {
  const filePath = path.join(packDir, relativePath);
  fs.writeFileSync(filePath, contents, { mode });
  fs.chmodSync(filePath, mode);
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

function buildReadme() {
  return `# Fieldwork Live-Testing Pack

This directory contains the two local helpers needed for the first Android
physical-device live-test pass from a source checkout:

- \`bin/\`: temporary npm-style \`fw\`, \`fieldwork\`, and \`fieldworkd\` commands
- \`evidence/\`: live-test evidence scaffold and direct-adb preflight helper

It does not create passing evidence. The physical test still requires a real
Android phone, the normal debug APK, real QR pairing, direct \`adb\`
screenshots/UI/logcat/crash-buffer capture, and desktop replay transcripts.

Use it from the repository root:

\`\`\`sh
export FW_LIVE_PACK="${packDir}"
source "$FW_LIVE_PACK/setup.sh"
fw --help
"$FW_LIVE_PACK/preflight.sh"
\`\`\`

The top-level preflight runs the local readiness check with the generated
\`fw\` shim on \`PATH\`, runs \`fw doctor\` to prove the desktop CLI can
auto-start and handshake with \`fieldworkd\`, then delegates to
\`evidence/preflight.sh\` for the strict direct-adb capture preflight when a
physical phone is connected.

Verifier after capture:

\`\`\`sh
pnpm check:live-testing-evidence -- "$FW_LIVE_DIR"
\`\`\`

Round 1 stays scoped to Android physical-device terminal handoff. It does not replace npm package, provenance, platform package, release signing, provider
push, iOS, store, or operator-owned checks.
`;
}

function buildSetupScript() {
  return `export FW_LIVE_PACK=${shellQuote(packDir)}
export FW_LIVE_BIN=${shellQuote(binDir)}
export FW_LIVE_DIR=${shellQuote(evidenceDir)}
export PATH="$FW_LIVE_BIN:$PATH"
`;
}

function buildPreflightScript() {
  return `#!/usr/bin/env bash
set -euo pipefail

pack_dir="\${FW_LIVE_PACK:-$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)}"
repo_root="\${FIELDWORK_REPO_ROOT:-$PWD}"
export FW_LIVE_PACK="$pack_dir"
export FW_LIVE_BIN="\${FW_LIVE_BIN:-$pack_dir/bin}"
export FW_LIVE_DIR="\${FW_LIVE_DIR:-$pack_dir/evidence}"
export PATH="$FW_LIVE_BIN:$PATH"

cd "$repo_root"

echo "Fieldwork live-testing pack: $FW_LIVE_PACK"
echo "fw shim: $FW_LIVE_BIN"
echo "evidence: $FW_LIVE_DIR"
echo
pnpm check:live-testing-readiness:local
echo
fw doctor
echo
"$FW_LIVE_DIR/preflight.sh"
`;
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
