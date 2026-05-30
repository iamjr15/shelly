#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const verifier = path.join(root, "scripts/verify-npm-release-evidence.mjs");
const generatedFiles = ["README.md", "manifest.json", "missing-files.txt", "capture-checklist.md", "preflight.sh"];
const options = parseArgs(process.argv.slice(2));
const evidenceDir = path.resolve(options.dir ?? path.join("/tmp", `fieldwork-npm-release-${timestampForDir(new Date())}`));
const requiredFiles = readRequiredFiles();

if (fs.existsSync(evidenceDir)) {
  const existing = fs.readdirSync(evidenceDir);
  if (existing.length > 0 && !options.force) {
    console.error(`evidence directory is not empty: ${evidenceDir}`);
    console.error("rerun with --force to refresh scaffold files without deleting captured release evidence");
    process.exit(1);
  }
} else {
  fs.mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
}

const manifest = {
  schema: "fieldwork-npm-release-evidence-v1",
  createdAt: new Date().toISOString(),
  evidenceDir,
  verifier: path.relative(root, verifier),
  requiredFiles,
  generatedFiles,
  note: "This scaffold does not publish packages, query package-name availability, or create passing registry evidence. Use it to capture the real release-npm.yml run, sanitized publish logs, and post-release registry/provenance metadata after the operator-owned publish has completed.",
};

writeFile("manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
writeFile("missing-files.txt", `${requiredFiles.join("\n")}\n`);
writeFile("capture-checklist.md", buildCaptureChecklist());
writeFile("README.md", buildReadme());
writeFile("preflight.sh", buildPreflightScript(), 0o700);

if (options.printDir) {
  process.stdout.write(`${evidenceDir}\n`);
} else if (!options.quiet) {
  console.log(`npm release evidence scaffold created: ${evidenceDir}`);
  console.log(`required evidence files: ${requiredFiles.length}`);
  console.log(`next: pnpm check:npm-release-evidence -- "${evidenceDir}"`);
}

function parseArgs(args) {
  const parsed = {
    dir: null,
    force: false,
    printDir: false,
    quiet: false,
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
    if (arg === "--dir") {
      const value = args[index + 1];
      if (!value) {
        console.error("--dir requires a path");
        process.exit(2);
      }
      parsed.dir = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--dir=")) {
      parsed.dir = arg.slice("--dir=".length);
      continue;
    }
    console.error(`unknown argument: ${arg}`);
    printUsage();
    process.exit(2);
  }
  return parsed;
}

function printUsage() {
  console.error("usage: node scripts/create-npm-release-evidence-dir.mjs [--dir <path>] [--force] [--print-dir] [--quiet]");
}

function readRequiredFiles() {
  const source = fs.readFileSync(verifier, "utf8");
  const match = source.match(/const\s+requiredFiles\s*=\s*\[(?<body>[\s\S]*?)\];/);
  if (!match?.groups?.body) {
    console.error(`cannot locate requiredFiles in ${verifier}`);
    process.exit(1);
  }
  const files = [...match.groups.body.matchAll(/"([^"\n]+)"/g)].map((fileMatch) => fileMatch[1]);
  if (files.length === 0) {
    console.error(`requiredFiles in ${verifier} is empty`);
    process.exit(1);
  }
  return files;
}

function writeFile(relativePath, contents, mode = 0o600) {
  const filePath = path.join(evidenceDir, relativePath);
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
  return `# Fieldwork npm Release Evidence

This directory is a scaffold for the npm publish/provenance release gate. It
does not publish packages, query package-name availability, or create passing
registry evidence.

Evidence directory:

\`\`\`sh
export FW_NPM_RELEASE_DIR="${evidenceDir}"
\`\`\`

Run the local preflight from the repository root before the release tag. It
writes the deterministic publish plan and local publish-readiness output:

\`\`\`sh
"$FW_NPM_RELEASE_DIR/preflight.sh"
\`\`\`

After the real \`release-npm.yml\` workflow publishes v1.0.0 from a tagged
GitHub release, capture sanitized workflow/publish logs and registry metadata.
Do not paste npm tokens into chat, do not commit \`.npmrc\`, and do not store
publish tokens in this repository. Evidence must use the unscoped v1 package
names only: \`fieldwork\`, \`fieldwork-darwin-arm64\`,
\`fieldwork-darwin-x64\`, \`fieldwork-linux-arm64\`, and
\`fieldwork-linux-x64\`. Do not include legacy scoped \`@fieldwork/*\` package
names or extra unscoped Fieldwork package names in publish logs or metadata.

Final verifier:

\`\`\`sh
pnpm check:npm-release-evidence -- "$FW_NPM_RELEASE_DIR"
\`\`\`

Required files are listed in \`missing-files.txt\` and come directly from
\`scripts/verify-npm-release-evidence.mjs\`.
`;
}

function buildCaptureChecklist() {
  return `# npm Release Evidence Capture Checklist

## Local preflight

Required files:

- \`publish-plan.json\`
- \`publish-readiness.txt\`

Run:

\`\`\`sh
"$FW_NPM_RELEASE_DIR/preflight.sh"
\`\`\`

The preflight runs \`node scripts/publish-npm-packages.mjs --publish-plan-json\`
and \`node scripts/publish-npm-packages.mjs --check-ready\`. It does not publish
or query package-name availability.

## GitHub workflow evidence

Required file:

- \`workflow-run.txt\`

Capture the successful \`release-npm.yml\` run URL, release tag \`v1.0.0\`,
\`conclusion=success\`, \`NPM_TOKEN=<redacted>\`, \`provenance=enabled\`, and a
children-first publish note. Do not include raw token, OTP, password, username,
or email values.

## Publish log evidence

Required file:

- \`npm-publish-log.txt\`

Capture sanitized publish output showing this exact children-first order:

1. \`fieldwork-darwin-arm64@1.0.0\`
2. \`fieldwork-darwin-x64@1.0.0\`
3. \`fieldwork-linux-arm64@1.0.0\`
4. \`fieldwork-linux-x64@1.0.0\`
5. \`fieldwork@1.0.0\`

The log must show \`--provenance\` and \`--access public\`, and must not be
dry-run or placeholder output. It must not include legacy scoped
\`@fieldwork/*\` package names; v1 publishes only the five unscoped packages
listed above, with no Windows, musl, Android, iOS, or other extra package names.

## Registry and provenance evidence

Required files:

- \`registry-state.txt\`
- \`package-metadata.json\`

Run the registry verifier after publish propagation:

\`\`\`sh
node scripts/verify-npm-registry-state.mjs \\
  --expect-meta-published \\
  --expect-platform-published \\
  --expect-latest-version=1.0.0 \\
  --expect-provenance | tee "$FW_NPM_RELEASE_DIR/registry-state.txt"
\`\`\`

Capture package metadata as JSON with a top-level \`packages\` array. Each entry
must include \`name\`, \`dist-tags.latest = "1.0.0"\`, and
\`versions["1.0.0"].dist.attestations.provenance.predicateType =
"https://slsa.dev/provenance/v1"\`. Do not include scoped package metadata or
metadata for non-v1 package names.
`;
}

function buildPreflightScript() {
  return `#!/usr/bin/env bash
set -euo pipefail

repo_root=${shellQuote(root)}
cd "$repo_root"

out_dir="${evidenceDir}"
mkdir -p "$out_dir"

node scripts/publish-npm-packages.mjs --publish-plan-json >"$out_dir/publish-plan.json"
node scripts/publish-npm-packages.mjs --check-ready >"$out_dir/publish-readiness.txt"

cat <<MSG
npm release preflight ok: $out_dir
wrote publish-plan.json and publish-readiness.txt
This did not publish packages or query npm package-name availability.
MSG
`;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}
