#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const verifier = path.join(root, "scripts/verify-macos-signing-evidence.mjs");
const generatedFiles = ["README.md", "manifest.json", "missing-files.txt", "capture-checklist.md", "preflight.sh"];
const options = parseArgs(process.argv.slice(2));
const evidenceDir = path.resolve(options.dir ?? path.join("/tmp", `fieldwork-macos-signing-${timestampForDir(new Date())}`));
const requiredFiles = readRequiredFiles();

if (fs.existsSync(evidenceDir)) {
  const existing = fs.readdirSync(evidenceDir);
  if (existing.length > 0 && !options.force) {
    console.error(`evidence directory is not empty: ${evidenceDir}`);
    console.error("rerun with --force to refresh scaffold files without deleting captured signing evidence");
    process.exit(1);
  }
} else {
  fs.mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
}

const manifest = {
  schema: "fieldwork-macos-signing-evidence-v1",
  createdAt: new Date().toISOString(),
  evidenceDir,
  verifier: path.relative(root, verifier),
  requiredFiles,
  generatedFiles,
  note: "This scaffold does not sign binaries, run GitHub workflows, or fabricate passing evidence. Use it to capture installed npm package identity, checksum/provenance verification, codesign/xattr/verifier output for both Darwin artifacts, installed-package doctor trust output, and daemon install preflight evidence.",
};

writeFile("manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
writeFile("missing-files.txt", `${requiredFiles.join("\n")}\n`);
writeFile("capture-checklist.md", buildCaptureChecklist());
writeFile("README.md", buildReadme());
writeFile("preflight.sh", buildPreflightScript(), 0o700);

if (options.printDir) {
  process.stdout.write(`${evidenceDir}\n`);
} else if (!options.quiet) {
  console.log(`macOS npm trust evidence scaffold created: ${evidenceDir}`);
  console.log(`required evidence files: ${requiredFiles.length}`);
  console.log(`next: pnpm check:macos-signing-evidence -- "${evidenceDir}"`);
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
  console.error("usage: node scripts/create-macos-signing-evidence-dir.mjs [--dir <path>] [--force] [--print-dir] [--quiet]");
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
  return `# Fieldwork macOS npm Trust Evidence

This directory is a scaffold for the macOS npm trust gate. It does not sign binaries,
run GitHub workflows, or fabricate passing evidence.

Evidence directory:

\`\`\`sh
export FW_MACOS_SIGNING_DIR="${evidenceDir}"
\`\`\`

After the Darwin npm release candidate is installed and the Darwin artifacts
have checksum/provenance evidence, run the preflight on a macOS host with
\`codesign\`, \`xattr\`, and the installed \`fieldwork\` command:

\`\`\`sh
FIELDWORK_DARWIN_ARTIFACT_DIR=/path/to/downloaded/assets \\
FIELDWORK_INSTALLED_FIELDWORK="$(command -v fieldwork)" \\
"$FW_MACOS_SIGNING_DIR/preflight.sh"
pnpm check:macos-signing-evidence -- "$FW_MACOS_SIGNING_DIR"
\`\`\`

Required files are listed in \`missing-files.txt\` and come directly from
\`scripts/verify-macos-signing-evidence.mjs\`.
`;
}

function buildCaptureChecklist() {
  return `# macOS npm Trust Evidence Capture Checklist

## npm package identity and integrity evidence

Required files:

- \`package-identity.txt\`
- \`release-integrity.txt\`

\`package-identity.txt\` must prove the installed unscoped npm package family:
\`fieldwork@1.0.0\`, \`fieldwork-darwin-arm64@1.0.0\`,
\`fieldwork-darwin-x64@1.0.0\`, \`fieldwork-linux-arm64@1.0.0\`,
\`fieldwork-linux-x64@1.0.0\`, \`bin/fieldwork\`, and \`bin/fieldworkd\`.
It must not include legacy scoped \`@fieldwork/*\` names.

\`release-integrity.txt\` must name \`fieldwork-darwin-arm64\` and
\`fieldwork-darwin-x64\`, then prove checksum or npm integrity verification and
npm/Sigstore provenance verification for each Darwin package/archive. That
proof can come from npm registry metadata, package-lock \`integrity\` entries,
npm provenance output, or the release-artifact verifier. Sanitized
\`release-rust.yml\` workflow evidence belongs in the separate release-artifacts
evidence gate, not in this macOS npm trust gate.

Do not include raw Apple signing credentials, App Store Connect private keys,
GitHub tokens, npm tokens, or terminal/session content.

## Darwin npm trust evidence

Required files:

- \`darwin-arm64-trust.txt\`
- \`darwin-arm64-codesign-fieldwork.txt\`
- \`darwin-arm64-codesign-fieldworkd.txt\`
- \`darwin-arm64-xattr-fieldwork.txt\`
- \`darwin-arm64-xattr-fieldworkd.txt\`
- \`darwin-x64-trust.txt\`
- \`darwin-x64-codesign-fieldwork.txt\`
- \`darwin-x64-codesign-fieldworkd.txt\`
- \`darwin-x64-xattr-fieldwork.txt\`
- \`darwin-x64-xattr-fieldworkd.txt\`
- \`doctor-trust.txt\`
- \`daemon-preflight.txt\`

Download or stage the Darwin \`fieldwork-darwin-arm64.tar.gz\` and
\`fieldwork-darwin-x64.tar.gz\` artifacts, then run:

\`\`\`sh
FIELDWORK_DARWIN_ARTIFACT_DIR=/path/to/downloaded/assets "$FW_MACOS_SIGNING_DIR/preflight.sh"
\`\`\`

The preflight runs \`node scripts/verify-macos-signing.mjs\`, captures
\`codesign --display --verbose=4\`, and records that \`com.apple.quarantine\` is
absent for both Darwin CLI and daemon artifacts. It requires an ad-hoc or
Developer ID signature and no quarantine xattr. Gatekeeper notarization is
optional/deferred for the desktop npm path.

It also captures the installed package behavior: \`fieldwork daemon install\`
must start a launchd-managed daemon with a reachable socket, and
\`fieldwork doctor --no-start\` must report \`macOS trust: ok\` with
\`npm/ad-hoc/not-notarized\` or \`Developer ID/notarized\` plus
\`summary: ok\`.
`;
}

function buildPreflightScript() {
  return `#!/usr/bin/env bash
set -euo pipefail

repo_root=${shellQuote(root)}
evidence_dir=${shellQuote(evidenceDir)}
artifact_dir="\${FIELDWORK_DARWIN_ARTIFACT_DIR:-$repo_root/artifacts}"
package_identity_file="\${FIELDWORK_PACKAGE_IDENTITY_FILE:-}"
release_integrity_file="\${FIELDWORK_RELEASE_INTEGRITY_FILE:-}"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "macOS npm trust evidence preflight must run on macOS with codesign and xattr" >&2
  exit 1
fi

if [[ ! -d "$artifact_dir" ]]; then
  cat >&2 <<MSG
Darwin artifact directory is missing: $artifact_dir
download fieldwork-darwin-arm64.tar.gz and fieldwork-darwin-x64.tar.gz first, then rerun with:
  FIELDWORK_DARWIN_ARTIFACT_DIR=/path/to/downloaded/assets "$evidence_dir/preflight.sh"
MSG
  exit 1
fi

cd "$repo_root"
mkdir -p "$evidence_dir"
tmp_dir="$(mktemp -d "\${TMPDIR:-/tmp}/fieldwork-macos-npm-trust.XXXXXX")"
trap 'rm -rf "$tmp_dir"' EXIT

for platform in darwin-arm64 darwin-x64; do
  archive="$artifact_dir/fieldwork-$platform.tar.gz"
  if [[ ! -f "$archive" ]]; then
    echo "missing Darwin release archive: $archive" >&2
    exit 1
  fi
  node scripts/verify-macos-signing.mjs "$archive" | tee "$evidence_dir/$platform-trust.txt"
  platform_dir="$tmp_dir/$platform"
  mkdir -p "$platform_dir"
  LC_ALL=C LANG=C COPYFILE_DISABLE=1 tar -xzf "$archive" -C "$platform_dir"
  for binary_name in fieldwork fieldworkd; do
    binary_path="$(find "$platform_dir" -type f -name "$binary_name" -print | head -n 1)"
    if [[ -z "$binary_path" ]]; then
      echo "archive did not contain $binary_name: $archive" >&2
      exit 1
    fi
    codesign --display --verbose=4 "$binary_path" >"$evidence_dir/$platform-codesign-$binary_name.txt" 2>&1
    if xattr -p com.apple.quarantine "$binary_path" >"$evidence_dir/$platform-xattr-$binary_name.txt" 2>&1; then
      echo "unexpected com.apple.quarantine value present" >>"$evidence_dir/$platform-xattr-$binary_name.txt"
    else
      echo "no com.apple.quarantine xattr on $binary_path" >"$evidence_dir/$platform-xattr-$binary_name.txt"
    fi
  done
done

installed_fieldwork="\${FIELDWORK_INSTALLED_FIELDWORK:-}"
if [[ -z "$installed_fieldwork" ]]; then
  installed_fieldwork="$(command -v fieldwork || true)"
fi
if [[ -z "$installed_fieldwork" || ! -x "$installed_fieldwork" ]]; then
  cat >&2 <<MSG
installed fieldwork command is missing. Install the npm release candidate first,
or rerun with:
  FIELDWORK_INSTALLED_FIELDWORK=/path/to/fieldwork "$evidence_dir/preflight.sh"
MSG
  exit 1
fi

if [[ -n "$package_identity_file" ]]; then
  cp "$package_identity_file" "$evidence_dir/package-identity.txt"
else
  FIELDWORK_INSTALLED_FIELDWORK="$installed_fieldwork" node <<'NODE' >"$evidence_dir/package-identity.txt"
const fs = require("fs");
const path = require("path");

const installed = fs.realpathSync(process.env.FIELDWORK_INSTALLED_FIELDWORK);
let dir = path.dirname(installed);
let metaDir = null;
while (dir !== path.dirname(dir)) {
  const candidate = path.join(dir, "package.json");
  if (fs.existsSync(candidate)) {
    const pkg = JSON.parse(fs.readFileSync(candidate, "utf8"));
    if (pkg.name === "fieldwork") {
      metaDir = dir;
      break;
    }
  }
  dir = path.dirname(dir);
}

if (!metaDir) {
  throw new Error(\`could not locate installed fieldwork package metadata from \${installed}\`);
}

const meta = JSON.parse(fs.readFileSync(path.join(metaDir, "package.json"), "utf8"));
console.log("npm package metadata: installed fieldwork package.json");
console.log(\`\${meta.name}@\${meta.version}\`);
console.log(\`bin/fieldwork=\${meta.bin?.fieldwork}\`);
console.log(\`bin/fieldworkd=\${meta.bin?.fieldworkd}\`);

for (const name of [
  "fieldwork-darwin-arm64",
  "fieldwork-darwin-x64",
  "fieldwork-linux-arm64",
  "fieldwork-linux-x64",
]) {
  const version = meta.optionalDependencies?.[name];
  if (!version) {
    throw new Error(\`installed fieldwork package.json is missing optionalDependency \${name}\`);
  }
  console.log(\`\${name}@\${version}\`);
}
NODE
fi

if [[ -n "$release_integrity_file" ]]; then
  cp "$release_integrity_file" "$evidence_dir/release-integrity.txt"
else
  {
    echo "FIELDWORK_VERIFY_COSIGN_SIGNATURE=\${FIELDWORK_VERIFY_COSIGN_SIGNATURE:-1}"
    echo "FIELDWORK_RELEASE_PLATFORMS=darwin-arm64,darwin-x64"
    echo "Sigstore/SLSA provenance verification expected for Darwin npm artifacts"
    for platform in darwin-arm64 darwin-x64; do
      echo "release archive: fieldwork-$platform.tar.gz"
      echo "sha256 checksum: fieldwork-$platform.tar.gz.sha256"
      echo "Sigstore/SLSA provenance bundle: fieldwork-$platform.tar.gz.bundle"
    done
    FIELDWORK_ARTIFACT_DIR="$artifact_dir" \\
      FIELDWORK_VERIFY_COSIGN_SIGNATURE="\${FIELDWORK_VERIFY_COSIGN_SIGNATURE:-1}" \\
      FIELDWORK_RELEASE_PLATFORMS="darwin-arm64,darwin-x64" \\
      node scripts/verify-release-artifacts.mjs
  } >"$evidence_dir/release-integrity.txt"
fi

{
  echo "$installed_fieldwork daemon install"
  echo "launchd LaunchAgent: $HOME/Library/LaunchAgents/app.fieldwork.daemon.plist"
  "$installed_fieldwork" daemon install
  echo "$installed_fieldwork daemon status"
  "$installed_fieldwork" daemon status
} >"$evidence_dir/daemon-preflight.txt" 2>&1

"$installed_fieldwork" doctor --no-start >"$evidence_dir/doctor-trust.txt" 2>&1

echo "macOS npm trust evidence preflight ok: $evidence_dir"
`;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}
