#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const verifier = path.join(root, "scripts/verify-relay-honeycomb-evidence.mjs");
const generatedFiles = ["README.md", "manifest.json", "missing-files.txt", "capture-checklist.md", "preflight.sh"];

const options = parseArgs(process.argv.slice(2));
const evidenceDir = path.resolve(options.dir ?? path.join("/tmp", `fieldwork-relay-honeycomb-${timestampForDir(new Date())}`));
const requiredFiles = readRequiredFiles();

if (fs.existsSync(evidenceDir)) {
  const existing = fs.readdirSync(evidenceDir);
  if (existing.length > 0 && !options.force) {
    console.error(`evidence directory is not empty: ${evidenceDir}`);
    console.error("rerun with --force to refresh the scaffold files without deleting captured evidence");
    process.exit(1);
  }
} else {
  fs.mkdirSync(evidenceDir, { recursive: true, mode: 0o700 });
}

const manifest = {
  schema: "fieldwork-relay-honeycomb-evidence-v1",
  createdAt: new Date().toISOString(),
  evidenceDir,
  verifier: path.relative(root, verifier),
  requiredFiles,
  generatedFiles,
  note: "This scaffold does not export hosted Honeycomb query rows or create passing evidence. Run preflight.sh only against a production or release-candidate relay host with relay-only systemd Honeycomb credentials, then capture hosted query JSON and redacted relay logs before running the verifier.",
};

writeFile("manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
writeFile("missing-files.txt", `${requiredFiles.join("\n")}\n`);
writeFile("capture-checklist.md", buildCaptureChecklist(evidenceDir, requiredFiles));
writeFile("README.md", buildReadme(evidenceDir, requiredFiles));
writeFile("preflight.sh", buildPreflightScript(), 0o700);

if (options.printDir) {
  process.stdout.write(`${evidenceDir}\n`);
} else if (!options.quiet) {
  console.log(`relay Honeycomb evidence scaffold created: ${evidenceDir}`);
  console.log(`required evidence files: ${requiredFiles.length}`);
  console.log(`next: pnpm check:relay-honeycomb-evidence -- "${evidenceDir}"`);
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
  console.error("usage: node scripts/create-relay-honeycomb-evidence-dir.mjs [--dir <path>] [--force] [--print-dir] [--quiet]");
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
  return `# Fieldwork Relay Honeycomb Evidence

This directory is a scaffold for the hosted relay Honeycomb receipt gate. It
does not contain passing evidence yet and does not export hosted Honeycomb query
rows.

Evidence directory:

\`\`\`sh
export FW_RELAY_HONEYCOMB_DIR="${dir}"
\`\`\`

Use \`docs/RELAY_HONEYCOMB.md\` as the authoritative runbook. This scaffold
only creates helper files plus a non-secret preflight. The preflight can capture
redacted relay config, systemd credential wiring, and real \`/v1/version\`
request evidence from a production or release-candidate relay host. It does not
create \`honeycomb-query.json\` or \`relay-log.txt\`.

Run the preflight on the relay host, or from an operator machine with a reachable
release-candidate relay URL and a captured systemd unit file:

\`\`\`sh
FIELDWORK_RELAY_VERSION_URL=https://relay.fieldwork.dev:8443/v1/version \\
FIELDWORK_RELAY_SYSTEMD_UNIT_FILE=/path/to/fieldwork-control-plane.service.txt \\
"$FW_RELAY_HONEYCOMB_DIR/preflight.sh"
\`\`\`

If using temporary 100% sampling for the receipt window, explicitly record the
window and restore proof:

\`\`\`sh
FIELDWORK_RELAY_OTLP_SAMPLE_RATE=1.0 \\
FIELDWORK_RELAY_RECEIPT_TEST_WINDOW=true \\
FIELDWORK_RELAY_RESTORED_SAMPLE_RATE=0.01 \\
"$FW_RELAY_HONEYCOMB_DIR/preflight.sh"
\`\`\`

Required files are listed in \`missing-files.txt\` and are derived from
\`scripts/verify-relay-honeycomb-evidence.mjs\`. After exporting the real hosted
Honeycomb query rows and redacted relay logs, run:

\`\`\`sh
pnpm check:relay-honeycomb-evidence -- "$FW_RELAY_HONEYCOMB_DIR"
\`\`\`

Required file count: ${files.length}
`;
}

function buildCaptureChecklist(dir, files) {
  const required = new Set(files);
  const sections = [
    {
      title: "Relay version, config, credentials, and request preflight",
      files: ["relay-version.txt", "relay-config.txt", "systemd-credentials.txt", "request.txt"],
      note: "Run preflight.sh against the production or release-candidate relay. It writes only non-secret relay proof and rejects missing systemd honeycomb-api-key credential wiring.",
      commands: ['FIELDWORK_RELAY_VERSION_URL=https://relay.fieldwork.dev:8443/v1/version "$FW_RELAY_HONEYCOMB_DIR/preflight.sh"'],
    },
    {
      title: "Redacted relay logs",
      files: ["relay-log.txt"],
      note: "Capture relay logs showing OTLP enabled, the Honeycomb endpoint, sample_rate, and /v1/version span/request without keys or headers.",
      commands: [
        'journalctl --user -u fieldwork-control-plane.service --since "10 minutes ago" | rg "fieldwork relay OTLP tracing enabled|relay.version|/v1/version|sample_rate|api.honeycomb.io" | tee "$FW_RELAY_HONEYCOMB_DIR/relay-log.txt"',
      ],
    },
    {
      title: "Hosted Honeycomb query export",
      files: ["honeycomb-query.json"],
      note: "Export the hosted Honeycomb query rows for service.name=fieldwork-relay, span relay.version, endpoint /v1/version, and service.version present.",
      commands: [],
    },
  ];

  const rendered = [];
  const assigned = new Set();
  for (const section of sections) {
    const sectionFiles = section.files.filter((file) => required.has(file));
    if (sectionFiles.length === 0) {
      continue;
    }
    for (const file of sectionFiles) {
      assigned.add(file);
    }
    rendered.push(renderChecklistSection(section, sectionFiles));
  }

  const unassigned = files.filter((file) => !assigned.has(file));
  if (unassigned.length > 0) {
    rendered.push(renderChecklistSection(
      {
        title: "Verifier-only additions",
        note: "These files are required by the verifier but are not assigned to a named runbook stage yet. Capture them before release sign-off.",
        commands: [],
      },
      unassigned,
    ));
  }

  return `# Fieldwork Relay Honeycomb Capture Checklist

Evidence directory:

\`\`\`sh
export FW_RELAY_HONEYCOMB_DIR="${dir}"
\`\`\`

Use this checklist while preparing \`docs/RELAY_HONEYCOMB.md\` evidence. It
does not create passing hosted Honeycomb evidence.

Do not put Honeycomb API keys, \`x-honeycomb-team\` headers, authorization
headers, terminal/session fields, command or path values, daemon node IDs, or
push tokens in this directory.

${rendered.join("\n")}
`;
}

function renderChecklistSection(section, files) {
  const commandBlock = section.commands.length > 0
    ? `\nCommands:\n\n\`\`\`sh\n${section.commands.join("\n")}\n\`\`\`\n`
    : "";
  return `## ${section.title}

${section.note}

Files:
${files.map((file) => `- \`${file}\``).join("\n")}
${commandBlock}`;
}

function buildPreflightScript() {
  return `#!/usr/bin/env bash
set -euo pipefail

evidence_dir="\${FW_RELAY_HONEYCOMB_DIR:-$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)}"
version_url="\${FIELDWORK_RELAY_VERSION_URL:-https://relay.fieldwork.dev:8443/v1/version}"
otlp_endpoint="\${FIELDWORK_RELAY_OTLP_ENDPOINT:-https://api.honeycomb.io/v1/traces}"
sample_rate="\${FIELDWORK_RELAY_OTLP_SAMPLE_RATE:-0.01}"
dataset="\${FIELDWORK_RELAY_HONEYCOMB_DATASET:-fieldwork-relay}"
credential_path="\${FIELDWORK_RELAY_HONEYCOMB_API_KEY_PATH:-/run/credentials/fieldwork-control-plane.service/honeycomb-api-key}"
unit_file="\${FIELDWORK_RELAY_SYSTEMD_UNIT_FILE:-}"
receipt_window="\${FIELDWORK_RELAY_RECEIPT_TEST_WINDOW:-false}"
restored_sample_rate="\${FIELDWORK_RELAY_RESTORED_SAMPLE_RATE:-}"

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "$1 is required" >&2
    exit 127
  fi
}

require_fixed() {
  local file="$1"
  local text="$2"
  local message="$3"
  if ! rg -F -q "$text" "$file"; then
    echo "$message" >&2
    exit 1
  fi
}

reject_secret_patterns() {
  local file="$1"
  if rg -q 'hcaik_[A-Za-z0-9_-]+|x-honeycomb-team|Authorization[[:space:]:=]|Bearer[[:space:]:=]|-----BEGIN [A-Z ]*PRIVATE KEY-----' "$file"; then
    echo "$file contains a Honeycomb key, header, authorization value, or private key" >&2
    exit 1
  fi
  if rg -q '\\b(HONEYCOMB_API_KEY|FIELDWORK_RELAY_HONEYCOMB_API_KEY)\\b[[:space:]]*[:=][[:space:]]*\\S+' "$file"; then
    echo "$file contains a Honeycomb API key value" >&2
    exit 1
  fi
}

require_command curl
require_command node
require_command rg

mkdir -p "$evidence_dir"

if [[ "$otlp_endpoint" != "https://api.honeycomb.io/v1/traces" ]]; then
  echo "FIELDWORK_RELAY_OTLP_ENDPOINT must be https://api.honeycomb.io/v1/traces" >&2
  exit 1
fi

node -e '
const sample = Number(process.argv[1]);
if (!Number.isFinite(sample) || sample <= 0 || sample > 1) {
  console.error("FIELDWORK_RELAY_OTLP_SAMPLE_RATE must be greater than 0 and at most 1");
  process.exit(1);
}
if (sample > 0.01 && process.argv[2] !== "true") {
  console.error("temporary sample rates above 0.01 require FIELDWORK_RELAY_RECEIPT_TEST_WINDOW=true");
  process.exit(1);
}
if (sample > 0.01 && process.argv[3] !== "0.01") {
  console.error("temporary sample rates above 0.01 require FIELDWORK_RELAY_RESTORED_SAMPLE_RATE=0.01");
  process.exit(1);
}
' "$sample_rate" "$receipt_window" "$restored_sample_rate"

{
  printf 'FIELDWORK_RELAY_OTLP_ENDPOINT=%s\\n' "$otlp_endpoint"
  printf 'production_default_sample_rate=0.01\\n'
  printf 'FIELDWORK_RELAY_OTLP_SAMPLE_RATE=%s\\n' "$sample_rate"
  if [[ "$receipt_window" == "true" ]]; then
    printf 'receipt_test_window=true\\n'
  fi
  if [[ -n "$restored_sample_rate" ]]; then
    printf 'restored_sample_rate=%s\\n' "$restored_sample_rate"
  fi
  printf 'FIELDWORK_RELAY_HONEYCOMB_DATASET=%s\\n' "$dataset"
  printf 'FIELDWORK_RELAY_HONEYCOMB_API_KEY_PATH=%s\\n' "$credential_path"
} > "$evidence_dir/relay-config.txt"
chmod 0600 "$evidence_dir/relay-config.txt"

curl -fsS "$version_url" > "$evidence_dir/relay-version.txt"
chmod 0600 "$evidence_dir/relay-version.txt"
require_fixed "$evidence_dir/relay-version.txt" "contract_version" "relay version response must include contract_version"

{
  printf 'request=GET /v1/version\\n'
  curl -fsS -o /dev/null -w 'status=%{http_code}\\n' "$version_url"
} > "$evidence_dir/request.txt"
chmod 0600 "$evidence_dir/request.txt"
require_fixed "$evidence_dir/request.txt" "status=200" "relay /v1/version request must return status=200"

if [[ -n "$unit_file" ]]; then
  if [[ ! -f "$unit_file" ]]; then
    echo "FIELDWORK_RELAY_SYSTEMD_UNIT_FILE does not exist: $unit_file" >&2
    exit 1
  fi
  rg 'LoadCredential=honeycomb-api-key|CREDENTIALS_DIRECTORY|FIELDWORK_RELAY_HONEYCOMB_API_KEY_PATH|FIELDWORK_RELAY_OTLP' "$unit_file" > "$evidence_dir/systemd-credentials.txt"
else
  if ! command -v systemctl >/dev/null 2>&1; then
    echo "systemctl is required unless FIELDWORK_RELAY_SYSTEMD_UNIT_FILE is set" >&2
    exit 127
  fi
  systemctl --user cat fieldwork-control-plane.service \\
    | rg 'LoadCredential=honeycomb-api-key|CREDENTIALS_DIRECTORY|FIELDWORK_RELAY_HONEYCOMB_API_KEY_PATH|FIELDWORK_RELAY_OTLP' \\
    > "$evidence_dir/systemd-credentials.txt"
fi
chmod 0600 "$evidence_dir/systemd-credentials.txt"
if [[ ! -s "$evidence_dir/systemd-credentials.txt" ]]; then
  echo "systemd-credentials.txt is empty; expected relay OTLP and honeycomb-api-key credential wiring" >&2
  exit 1
fi
require_fixed "$evidence_dir/systemd-credentials.txt" "honeycomb-api-key" "systemd credential proof must mention honeycomb-api-key"
reject_secret_patterns "$evidence_dir/systemd-credentials.txt"

echo "relay Honeycomb preflight ok: $evidence_dir"
echo "next: capture relay-log.txt and hosted honeycomb-query.json before running the verifier"
`;
}
