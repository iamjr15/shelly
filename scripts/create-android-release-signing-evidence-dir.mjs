#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const verifier = path.join(root, "scripts/verify-android-release-signing-evidence.mjs");
const generatedFiles = ["README.md", "manifest.json", "missing-files.txt", "capture-checklist.md", "preflight.sh"];

const options = parseArgs(process.argv.slice(2));
const evidenceDir = path.resolve(options.dir ?? path.join("/tmp", `fieldwork-android-release-signing-${timestampForDir(new Date())}`));
const requiredFiles = readRequiredFiles();

if (fs.existsSync(evidenceDir)) {
  const existing = fs.readdirSync(evidenceDir);
  if (existing.length > 0 && !options.force) {
    console.error(`evidence directory is not empty: ${evidenceDir}`);
    console.error("rerun with --force to refresh scaffold files without deleting captured evidence");
    process.exit(1);
  }
} else {
  fs.mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
}

const manifest = {
  schema: "fieldwork-android-release-signing-evidence-v1",
  createdAt: new Date().toISOString(),
  evidenceDir,
  verifier: path.relative(root, verifier),
  requiredFiles,
  generatedFiles,
  note: "This scaffold captures proof that a real release workflow signed the Android AAB with a non-debug, non-smoke release keystore. It does not create or handle the keystore.",
};

writeFile("manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
writeFile("missing-files.txt", `${requiredFiles.join("\n")}\n`);
writeFile("capture-checklist.md", buildCaptureChecklist(evidenceDir, requiredFiles));
writeFile("README.md", buildReadme(evidenceDir, requiredFiles));
writeFile("preflight.sh", buildPreflightScript(), 0o700);

if (options.printDir) {
  process.stdout.write(`${evidenceDir}\n`);
} else if (!options.quiet) {
  console.log(`Android release signing evidence scaffold created: ${evidenceDir}`);
  console.log(`required evidence files: ${requiredFiles.length}`);
  console.log(`next: ${evidenceDir}/preflight.sh`);
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
  console.error("usage: node scripts/create-android-release-signing-evidence-dir.mjs [--dir <path>] [--force] [--print-dir] [--quiet]");
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

function buildReadme(dir, files) {
  return `# Fieldwork Android Release Signing Evidence

This directory is a scaffold for the Android AAB release-keystore signing gate.
It captures evidence after a real signed release AAB exists; it does not create
or decode the keystore.

Evidence directory:

\`\`\`sh
export FW_ANDROID_SIGNING_DIR="${dir}"
\`\`\`

Run from the repository root with the signed AAB produced by
\`release-android.yml\`:

\`\`\`sh
FIELDWORK_ANDROID_SIGNED_AAB=/path/to/app-release.aab \\
FIELDWORK_ANDROID_RELEASE_REF=android-v1.0.0 \\
FIELDWORK_ANDROID_RELEASE_WORKFLOW_URL=https://github.com/fieldwork-app/fieldwork/actions/runs/<id> \\
"$FW_ANDROID_SIGNING_DIR/preflight.sh"
\`\`\`

The helper writes the signed-AAB verifier output, raw \`jarsigner -verify -certs\`
output, signed AAB SHA-256, release BuildConfig proof including the HTTPS
relay control URL, and workflow metadata, then runs:

\`\`\`sh
pnpm check:android-release-signing-evidence -- "$FW_ANDROID_SIGNING_DIR"
\`\`\`

Required files:

${files.map((file) => `- \`${file}\``).join("\n")}
`;
}

function buildCaptureChecklist(dir, files) {
  return `# Android Release Signing Capture Checklist

Evidence directory:

\`\`\`sh
export FW_ANDROID_SIGNING_DIR="${dir}"
\`\`\`

Required verifier files:

${files.map((file) => `- [ ] \`${file}\``).join("\n")}

Suggested capture:

\`\`\`sh
FIELDWORK_ANDROID_SIGNED_AAB=/path/to/app-release.aab \\
FIELDWORK_ANDROID_RELEASE_REF=android-v1.0.0 \\
FIELDWORK_ANDROID_RELEASE_WORKFLOW_URL=https://github.com/fieldwork-app/fieldwork/actions/runs/<id> \\
"$FW_ANDROID_SIGNING_DIR/preflight.sh"
\`\`\`

The preflight helper runs:

\`\`\`sh
node scripts/verify-android-aab.mjs --expect-signed --expect-relay-control-url "$FIELDWORK_ANDROID_SIGNED_AAB" > artifact-signing.txt
jarsigner -verify -certs "$FIELDWORK_ANDROID_SIGNED_AAB" > jarsigner.txt
shasum -a 256 "$FIELDWORK_ANDROID_SIGNED_AAB" > sha256.txt
rg 'APPLICATION_ID|BUILD_TYPE|DEBUG|VERSION_CODE|VERSION_NAME|FIELDWORK_BIOMETRIC_BYPASS|FIELDWORK_DEBUG_PAIRING_CODE|FIELDWORK_RELAY_CONTROL_URL = "https://' BuildConfig.java > buildconfig.txt
printf 'workflow=release-android.yml\\nref=...\\nrun-url=...\\n' > workflow-run.txt
node scripts/verify-android-release-signing-evidence.mjs "$FW_ANDROID_SIGNING_DIR"
\`\`\`
`;
}

function buildPreflightScript() {
  return `#!/usr/bin/env bash
set -euo pipefail

evidence_dir="\${FW_ANDROID_SIGNING_DIR:-$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)}"
repo_root="\${FIELDWORK_REPO_ROOT:-$PWD}"
aab="\${FIELDWORK_ANDROID_SIGNED_AAB:-$repo_root/apps/android/app/build/outputs/bundle/release/app-release.aab}"
build_config="\${FIELDWORK_ANDROID_RELEASE_BUILDCONFIG:-$repo_root/apps/android/app/build/generated/source/buildConfig/release/app/fieldwork/android/BuildConfig.java}"
jarsigner="\${FIELDWORK_JARSIGNER:-jarsigner}"
release_ref="\${FIELDWORK_ANDROID_RELEASE_REF:-\${GITHUB_REF_NAME:-}}"
workflow_url="\${FIELDWORK_ANDROID_RELEASE_WORKFLOW_URL:-}"

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "$1 is required" >&2
    exit 127
  fi
}

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$@"
  else
    shasum -a 256 "$@"
  fi
}

require_command node
require_command rg
require_command "$jarsigner"

if [[ ! -f "$aab" ]]; then
  echo "missing signed Android AAB: $aab" >&2
  exit 1
fi
if [[ ! -f "$build_config" ]]; then
  echo "missing release BuildConfig: $build_config" >&2
  exit 1
fi
if [[ -z "$release_ref" ]]; then
  echo "FIELDWORK_ANDROID_RELEASE_REF or GITHUB_REF_NAME must identify android-v* release ref" >&2
  exit 1
fi
if [[ -z "$workflow_url" ]]; then
  if [[ -n "\${GITHUB_SERVER_URL:-}" && -n "\${GITHUB_REPOSITORY:-}" && -n "\${GITHUB_RUN_ID:-}" ]]; then
    workflow_url="$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID"
  else
    echo "FIELDWORK_ANDROID_RELEASE_WORKFLOW_URL or GitHub Actions URL env is required" >&2
    exit 1
  fi
fi

mkdir -p "$evidence_dir"

node "$repo_root/scripts/verify-android-aab.mjs" --expect-signed --expect-relay-control-url "$aab" > "$evidence_dir/artifact-signing.txt"
"$jarsigner" -verify -certs "$aab" > "$evidence_dir/jarsigner.txt" 2>&1
sha256_file "$aab" > "$evidence_dir/sha256.txt"
rg 'APPLICATION_ID = "app\\.fieldwork\\.android"|BUILD_TYPE = "release"|DEBUG = false|VERSION_CODE = 1|VERSION_NAME = "1\\.0"|FIELDWORK_BIOMETRIC_BYPASS = false|FIELDWORK_DEBUG_PAIRING_CODE = ""|FIELDWORK_RELAY_CONTROL_URL = "https://' "$build_config" > "$evidence_dir/buildconfig.txt"
{
  echo "workflow=release-android.yml"
  echo "ref=$release_ref"
  echo "tag=$release_ref"
  if [[ -n "\${GITHUB_RUN_ID:-}" ]]; then
    echo "run_id=$GITHUB_RUN_ID"
  fi
  echo "run-url=$workflow_url"
} > "$evidence_dir/workflow-run.txt"

node "$repo_root/scripts/verify-android-release-signing-evidence.mjs" "$evidence_dir"
`;
}
