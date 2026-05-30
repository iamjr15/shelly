#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const verifier = path.join(root, "scripts/verify-macos-daemon-survival-evidence.mjs");
const generatedFiles = ["README.md", "manifest.json", "missing-files.txt", "capture-checklist.md", "preflight.sh"];

const options = parseArgs(process.argv.slice(2));
const evidenceDir = path.resolve(options.dir ?? path.join("/tmp", `fieldwork-macos-survival-${timestampForDir(new Date())}`));
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
  schema: "fieldwork-macos-daemon-survival-evidence-v1",
  createdAt: new Date().toISOString(),
  evidenceDir,
  verifier: path.relative(root, verifier),
  requiredFiles,
  generatedFiles,
  note: "This scaffold does not create passing evidence. Run preflight.sh only after installing the npm-trust-prepared daemon service, then capture real sleep/wake and launchd restart transcripts before running the verifier.",
};

writeFile("manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
writeFile("missing-files.txt", `${requiredFiles.join("\n")}\n`);
writeFile("capture-checklist.md", buildCaptureChecklist(evidenceDir, requiredFiles));
writeFile("README.md", buildReadme(evidenceDir, requiredFiles));
writeFile("preflight.sh", buildPreflightScript(evidenceDir), 0o700);

if (options.printDir) {
  process.stdout.write(`${evidenceDir}\n`);
} else if (!options.quiet) {
  console.log(`macOS daemon survival evidence scaffold created: ${evidenceDir}`);
  console.log(`required evidence files: ${requiredFiles.length}`);
  console.log(`next: pnpm check:macos-daemon-survival-evidence -- "${evidenceDir}"`);
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
  console.error(
    "usage: node scripts/create-macos-daemon-survival-evidence-dir.mjs [--dir <path>] [--force] [--print-dir] [--quiet]",
  );
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
  return `# Fieldwork macOS Daemon Survival Evidence

This directory is a scaffold for the npm-trust-prepared macOS daemon survival
gate. It does not contain passing evidence yet.

Evidence directory:

\`\`\`sh
export FW_MACOS_DIR="${dir}"
\`\`\`

Use \`docs/MACOS_DAEMON_SURVIVAL.md\` as the authoritative runbook. This scaffold
only creates helper files and a non-destructive preflight. It does not run
\`pmset sleepnow\`, \`pkill -KILL fieldworkd\`, or fabricate transcripts.

After installing the npm-trust-prepared daemon service, run the preflight from the
repository root with explicit release-candidate paths:

\`\`\`sh
FIELDWORK_CLI=/path/to/fieldwork \\
FIELDWORK_DAEMON=/path/to/fieldworkd \\
"$FW_MACOS_DIR/preflight.sh"
\`\`\`

Required files are listed in \`missing-files.txt\` and are derived from
\`scripts/verify-macos-daemon-survival-evidence.mjs\`. After capture, run:

\`\`\`sh
pnpm check:macos-daemon-survival-evidence -- "$FW_MACOS_DIR"
\`\`\`

Required file count: ${files.length}
`;
}

function buildCaptureChecklist(dir, files) {
  const required = new Set(files);
  const sections = [
    {
      title: "Signed artifact and installed service preflight",
      files: ["macos-signing.txt", "daemon-status-before.txt"],
      note: "Run preflight.sh after the npm-trust-prepared daemon has been installed as a launchd user service.",
      commands: [
        'FIELDWORK_CLI=/path/to/fieldwork FIELDWORK_DAEMON=/path/to/fieldworkd "$FW_MACOS_DIR/preflight.sh"',
      ],
    },
    {
      title: "Service install transcript",
      files: ["service-install.txt"],
      note: "Capture the actual install transcript from the release-candidate CLI. The verifier requires launchd/LaunchAgent proof and a reachable socket.",
      commands: ['fieldwork daemon install | tee "$FW_MACOS_DIR/service-install.txt"'],
    },
    {
      title: "Sleep/wake survival",
      files: ["sleep-wake.txt", "sleep-replay.txt"],
      note: "Use a project directory outside macOS Desktop/Documents TCC-protected locations, create scrollback before sleeping, sleep for at least 30 seconds, wake manually, send after_sleep_wake_ok, and capture replay.",
      commands: [
        'mkdir -p "${FW_MACOS_PROJECT_DIR:-/tmp/fieldwork-macos-survival-project}"',
        'fieldwork new --dir "${FW_MACOS_PROJECT_DIR:-/tmp/fieldwork-macos-survival-project}" --name macos_sleep -- bash -lc \'echo MACOS_SLEEP_SCROLLBACK_BEFORE; sleep 600\'',
        "pmset sleepnow",
        'script -q "$FW_MACOS_DIR/sleep-replay.txt" fieldwork attach macos_sleep',
      ],
    },
    {
      title: "launchd kill/restart survival",
      files: ["kill-restart.txt", "kill-live-replay.txt", "kill-replay.txt"],
      note: "Use a project directory outside macOS Desktop/Documents TCC-protected locations, emit pre-kill scrollback, capture a live replay showing it, wait at least 35 seconds for the daemon persistence checkpoint, kill fieldworkd through pkill, wait for launchd to restore socket reachability within 10 seconds, document PTY child process death, and capture restored scrollback replay.",
      commands: [
        'mkdir -p "${FW_MACOS_PROJECT_DIR:-/tmp/fieldwork-macos-survival-project}"',
        'fieldwork new --dir "${FW_MACOS_PROJECT_DIR:-/tmp/fieldwork-macos-survival-project}" --name macos_kill -- bash -lc \'echo MACOS_KILL_SCROLLBACK_BEFORE; sleep 600\'',
        'script -q "$FW_MACOS_DIR/kill-live-replay.txt" fieldwork attach macos_kill',
        "sleep 35",
        "pkill -KILL fieldworkd",
        'script -q "$FW_MACOS_DIR/kill-replay.txt" fieldwork attach macos_kill',
      ],
    },
    {
      title: "Final status and daemon log",
      files: ["daemon-status-after.txt", "daemon-log.txt"],
      note: "Capture the final service status and daemon log after both survival passes.",
      commands: [
        'fieldwork daemon status | tee "$FW_MACOS_DIR/daemon-status-after.txt"',
        'cp ~/Library/Logs/Fieldwork/daemon.log "$FW_MACOS_DIR/daemon-log.txt"',
      ],
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

  return `# Fieldwork macOS Daemon Survival Capture Checklist

Evidence directory:

\`\`\`sh
export FW_MACOS_DIR="${dir}"
\`\`\`

Use this checklist while running \`docs/MACOS_DAEMON_SURVIVAL.md\` against the
npm-trust-prepared daemon artifact. It does not create passing evidence.

${rendered.join("\n")}
`;
}

function renderChecklistSection(section, files) {
  const commands = section.commands.length > 0
    ? `\nCommands:\n\n\`\`\`sh\n${section.commands.join("\n")}\n\`\`\`\n`
    : "\n";
  return `## ${section.title}

${section.note}

Files:
${files.map((file) => `- [ ] \`${file}\``).join("\n")}
${commands}`;
}

function buildPreflightScript() {
  return `#!/usr/bin/env bash
set -euo pipefail

evidence_dir="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
repo_root="\${FIELDWORK_REPO_ROOT:-$(pwd)}"
cli="\${FIELDWORK_CLI:-fieldwork}"
daemon="\${FIELDWORK_DAEMON:-}"

if [[ -z "$daemon" ]]; then
  echo "set FIELDWORK_DAEMON=/path/to/npm-trust-prepared/fieldworkd before running this preflight" >&2
  exit 1
fi
if [[ ! -x "$daemon" ]]; then
  echo "FIELDWORK_DAEMON is not executable: $daemon" >&2
  exit 1
fi
if [[ ! -x "$repo_root/scripts/verify-macos-signing.mjs" ]]; then
  echo "run this preflight from the Fieldwork repository root, or set FIELDWORK_REPO_ROOT" >&2
  exit 1
fi

node "$repo_root/scripts/verify-macos-signing.mjs" "$daemon" | tee "$evidence_dir/macos-signing.txt"
"$cli" daemon status | tee "$evidence_dir/daemon-status-before.txt"

if ! grep -qiE 'service:[[:space:]]*(installed|running)' "$evidence_dir/daemon-status-before.txt"; then
  echo "daemon-status-before.txt must show service: installed or service: running" >&2
  exit 1
fi
if ! grep -qiE 'socket:[[:space:]]*reachable' "$evidence_dir/daemon-status-before.txt"; then
  echo "daemon-status-before.txt must show socket: reachable" >&2
  exit 1
fi

echo "macOS daemon survival preflight ok: signed fieldworkd and installed reachable service"
`;
}
