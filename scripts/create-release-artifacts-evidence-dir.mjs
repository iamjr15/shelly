#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const verifier = path.join(root, "scripts/verify-release-artifacts-evidence.mjs");
const generatedFiles = ["README.md", "manifest.json", "missing-files.txt", "capture-checklist.md", "preflight.sh"];
const options = parseArgs(process.argv.slice(2));
const evidenceDir = path.resolve(options.dir ?? path.join("/tmp", `fieldwork-release-artifacts-${timestampForDir(new Date())}`));
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
  schema: "fieldwork-release-artifacts-evidence-v1",
  createdAt: new Date().toISOString(),
  evidenceDir,
  verifier: path.relative(root, verifier),
  requiredFiles,
  generatedFiles,
  note: "This scaffold does not create release artifacts, run GitHub workflows, or fabricate passing evidence. Use it to capture the real release-rust.yml workflow, GitHub Release asset metadata, artifact file digests, and cosign-backed release-artifact verifier output.",
};

writeFile("manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
writeFile("missing-files.txt", `${requiredFiles.join("\n")}\n`);
writeFile("capture-checklist.md", buildCaptureChecklist());
writeFile("README.md", buildReadme());
writeFile("preflight.sh", buildPreflightScript(), 0o700);

if (options.printDir) {
  process.stdout.write(`${evidenceDir}\n`);
} else if (!options.quiet) {
  console.log(`release artifacts evidence scaffold created: ${evidenceDir}`);
  console.log(`required evidence files: ${requiredFiles.length}`);
  console.log(`next: pnpm check:release-artifacts-evidence -- "${evidenceDir}"`);
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
  console.error("usage: node scripts/create-release-artifacts-evidence-dir.mjs [--dir <path>] [--force] [--print-dir] [--quiet]");
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
  return `# Fieldwork Release Artifacts Evidence

This directory is a scaffold for the release-rust/GitHub Release artifact gate.
It does not create release artifacts, run GitHub workflows, or fabricate passing
evidence.

Evidence directory:

\`\`\`sh
export FW_RELEASE_ARTIFACT_EVIDENCE_DIR="${evidenceDir}"
\`\`\`

After the real \`release-rust.yml\` workflow succeeds for \`v1.0.0\`, capture the
workflow run, GitHub Release asset metadata, artifact file digests, and
cosign-backed verifier output. Final verifier:

\`\`\`sh
pnpm check:release-artifacts-evidence -- "$FW_RELEASE_ARTIFACT_EVIDENCE_DIR"
\`\`\`

Required files are listed in \`missing-files.txt\` and come directly from
\`scripts/verify-release-artifacts-evidence.mjs\`.
`;
}

function buildCaptureChecklist() {
  return `# Release Artifacts Evidence Capture Checklist

## GitHub workflow evidence

Required file:

- \`workflow-run.txt\`

Capture the successful \`release-rust.yml\` run URL, release tag \`v1.0.0\`,
\`conclusion=success\`, \`id-token=write\`, \`cosign attest-blob\`,
\`slsaprovenance1\`, \`softprops/action-gh-release@v2\`, and all four platform
packages/targets:

- \`darwin-arm64\` / \`aarch64-apple-darwin\`
- \`darwin-x64\` / \`x86_64-apple-darwin\`
- \`linux-arm64\` / \`aarch64-unknown-linux-gnu\`
- \`linux-x64\` / \`x86_64-unknown-linux-gnu\`

Do not include raw GitHub tokens, npm tokens, Apple signing credentials, private
keys, or terminal/session content.

## GitHub Release assets

Required file:

- \`github-release-assets.json\`

Capture sanitized GitHub Release asset metadata, for example:

\`\`\`sh
gh release view v1.0.0 --json tagName,isDraft,isPrerelease,assets >"$FW_RELEASE_ARTIFACT_EVIDENCE_DIR/github-release-assets.json"
\`\`\`

The release must not be draft or prerelease and must list these twelve assets:

- \`fieldwork-darwin-arm64.tar.gz\`
- \`fieldwork-darwin-arm64.tar.gz.sha256\`
- \`fieldwork-darwin-arm64.tar.gz.bundle\`
- \`fieldwork-darwin-x64.tar.gz\`
- \`fieldwork-darwin-x64.tar.gz.sha256\`
- \`fieldwork-darwin-x64.tar.gz.bundle\`
- \`fieldwork-linux-arm64.tar.gz\`
- \`fieldwork-linux-arm64.tar.gz.sha256\`
- \`fieldwork-linux-arm64.tar.gz.bundle\`
- \`fieldwork-linux-x64.tar.gz\`
- \`fieldwork-linux-x64.tar.gz.sha256\`
- \`fieldwork-linux-x64.tar.gz.bundle\`

## Local artifact verifier

Required files:

- \`artifact-files.txt\`
- \`verify-release-artifacts.txt\`

Download the GitHub Release assets into a directory, then run:

\`\`\`sh
FIELDWORK_ARTIFACT_SOURCE_DIR=/path/to/downloaded/assets \\
  "$FW_RELEASE_ARTIFACT_EVIDENCE_DIR/preflight.sh"
\`\`\`

The preflight records SHA-256 digests for the downloaded files and runs
\`pnpm check:release-artifacts\` with \`FIELDWORK_VERIFY_COSIGN_SIGNATURE=1\`,
\`FIELDWORK_EXPECTED_RELEASE_TAG=v1.0.0\`, and the expected
\`release-rust.yml@refs/tags/v.*\` cosign identity regex.
`;
}

function buildPreflightScript() {
  return `#!/usr/bin/env bash
set -euo pipefail

repo_root=${shellQuote(root)}
out_dir=${shellQuote(evidenceDir)}
artifact_source="\${FIELDWORK_ARTIFACT_SOURCE_DIR:-$repo_root/artifacts}"
release_tag="\${FIELDWORK_EXPECTED_RELEASE_TAG:-v1.0.0}"
identity_regex="\${FIELDWORK_COSIGN_IDENTITY_REGEXP:-^https://github.com/fieldwork-app/fieldwork/\\.github/workflows/release-rust\\.yml@refs/tags/v.*$}"

if [[ ! -d "$artifact_source" ]]; then
  cat >&2 <<MSG
release artifact source directory is missing: $artifact_source
download the release-rust GitHub Release assets first, then rerun with:
  FIELDWORK_ARTIFACT_SOURCE_DIR=/path/to/downloaded/assets "$out_dir/preflight.sh"
MSG
  exit 1
fi

cd "$repo_root"
mkdir -p "$out_dir"

(
  cd "$artifact_source"
  find . -type f -print | LC_ALL=C sort | while IFS= read -r rel; do
    file="\${rel#./}"
    digest="$(LC_ALL=C shasum -a 256 "$file" | awk '{print $1}')"
    printf '%s  %s\\n' "$digest" "$file"
  done
) >"$out_dir/artifact-files.txt"

{
  printf 'FIELDWORK_ARTIFACT_DIR=%s\\n' "$artifact_source"
  printf 'FIELDWORK_VERIFY_COSIGN_SIGNATURE=1\\n'
  printf 'FIELDWORK_EXPECTED_RELEASE_TAG=%s\\n' "$release_tag"
  printf 'FIELDWORK_COSIGN_IDENTITY_REGEXP=%s\\n' "$identity_regex"
  FIELDWORK_ARTIFACT_DIR="$artifact_source" \\
    FIELDWORK_VERIFY_COSIGN_SIGNATURE=1 \\
    FIELDWORK_EXPECTED_RELEASE_TAG="$release_tag" \\
    FIELDWORK_COSIGN_IDENTITY_REGEXP="$identity_regex" \\
    pnpm check:release-artifacts
} | tee "$out_dir/verify-release-artifacts.txt"

cat <<MSG
release artifact preflight ok: $out_dir
wrote artifact-files.txt and verify-release-artifacts.txt
This did not create release artifacts or run GitHub workflows.
MSG
`;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}
