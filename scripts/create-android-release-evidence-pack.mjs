#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const generatedFiles = ["README.md", "manifest.json", "capture-order.md", "setup.sh", "readiness.sh", "verify.sh"];
const evidenceItems = [
  {
    id: "release-signing",
    dir: "00-release-signing",
    phase: "Artifact",
    scaffold: "scripts/create-android-release-signing-evidence-dir.mjs",
    verifier: "scripts/verify-android-release-signing-evidence.mjs",
    packageCheck: "pnpm check:android-release-signing-evidence -- \"$FW_ANDROID_RELEASE_EVIDENCE_PACK/00-release-signing\"",
    docs: "docs/DEVELOPMENT.md",
    purpose: "Prove release-android.yml signed the AAB with the operator-owned non-debug release keystore.",
  },
  {
    id: "release-install",
    dir: "01-release-install",
    phase: "Artifact",
    scaffold: "scripts/create-android-release-install-evidence-dir.mjs",
    verifier: "scripts/verify-android-release-install-evidence.mjs",
    packageCheck:
      "pnpm check:android-release-install-evidence -- --strict-release-device \"$FW_ANDROID_RELEASE_EVIDENCE_PACK/01-release-install/apks\" \"$FW_ANDROID_RELEASE_EVIDENCE_PACK/01-release-install/install\"",
    docs: "docs/DEVELOPMENT.md",
    purpose:
      "Prove the operator-signed release package installs on a physical phone as non-debuggable app.fieldwork.android and cold-launches to the locked surface.",
  },
  {
    id: "pair-flow",
    dir: "02-pair-flow",
    phase: "Pairing",
    scaffold: "scripts/create-android-pair-flow-evidence-dir.mjs",
    verifier: "scripts/verify-android-pair-flow-evidence.mjs",
    packageCheck: "pnpm check:android-pair-flow-evidence -- \"$FW_ANDROID_RELEASE_EVIDENCE_PACK/02-pair-flow\"",
    docs: "docs/ANDROID_PAIR_FLOW.md",
    purpose: "Prove real QR pairing, explicit desktop approval, dashboard listing, and pair_flow_ms<=15000.",
  },
  {
    id: "session-subscription",
    dir: "03-session-subscription",
    phase: "Dashboard",
    scaffold: "scripts/create-android-session-subscription-evidence-dir.mjs",
    verifier: "scripts/verify-android-session-subscription-evidence.mjs",
    packageCheck: "pnpm check:android-session-subscription-evidence -- \"$FW_ANDROID_RELEASE_EVIDENCE_PACK/03-session-subscription\"",
    docs: "docs/ANDROID_SESSION_SUBSCRIPTION.md",
    purpose: "Prove a desktop-created session appears on Android within the release-device subscription target.",
  },
  {
    id: "terminal-attach",
    dir: "04-terminal-attach",
    phase: "Terminal",
    scaffold: "scripts/create-android-terminal-attach-evidence-dir.mjs",
    verifier: "scripts/verify-android-terminal-attach-evidence.mjs",
    packageCheck: "pnpm check:android-terminal-attach-evidence -- \"$FW_ANDROID_RELEASE_EVIDENCE_PACK/04-terminal-attach\"",
    docs: "docs/ANDROID_TERMINAL_ATTACH.md",
    purpose: "Prove Android attaches to desktop-created shell, Claude, and TUI sessions and sends input without session leakage.",
  },
  {
    id: "resize-detach",
    dir: "05-resize-detach",
    phase: "Terminal",
    scaffold: "scripts/create-android-resize-detach-evidence-dir.mjs",
    verifier: "scripts/verify-android-resize-detach-evidence.mjs",
    packageCheck: "pnpm check:android-resize-detach-evidence -- \"$FW_ANDROID_RELEASE_EVIDENCE_PACK/05-resize-detach\"",
    docs: "docs/ANDROID_RESIZE_DETACH.md",
    purpose: "Prove release-device resize, detach, and reattach replay behavior.",
  },
  {
    id: "biometric",
    dir: "06-biometric",
    phase: "Security",
    scaffold: "scripts/create-android-biometric-evidence-dir.mjs",
    verifier: "scripts/verify-android-biometric-evidence.mjs",
    packageCheck: "pnpm check:android-biometric-evidence -- \"$FW_ANDROID_RELEASE_EVIDENCE_PACK/06-biometric\"",
    docs: "docs/ANDROID_BIOMETRIC.md",
    purpose: "Prove BiometricPrompt gates launch, stale resume, session sync, and stale terminal input.",
  },
  {
    id: "dogfood",
    dir: "07-dogfood",
    phase: "Terminal",
    scaffold: "scripts/create-android-dogfood-evidence-dir.mjs",
    verifier: "scripts/verify-android-dogfood-evidence.mjs",
    packageCheck: "pnpm check:android-dogfood-evidence -- \"$FW_ANDROID_RELEASE_EVIDENCE_PACK/07-dogfood\"",
    docs: "docs/ANDROID_DOGFOOD.md",
    purpose: "Prove the 30-minute physical renderer dogfood gate with typing, scroll, resize, paste, logs, and replay.",
  },
  {
    id: "cold-start",
    dir: "08-cold-start",
    phase: "Performance",
    scaffold: "scripts/create-android-cold-start-evidence-dir.mjs",
    verifier: "scripts/verify-android-cold-start-evidence.mjs",
    packageCheck: "pnpm check:android-cold-start-evidence -- \"$FW_ANDROID_RELEASE_EVIDENCE_PACK/08-cold-start\"",
    docs: "docs/ANDROID_COLD_START.md",
    purpose: "Prove five signed-release physical-phone cold starts with TotalTime<=1200ms and locked UI.",
  },
  {
    id: "renderer-flood",
    dir: "09-renderer-flood",
    phase: "Terminal",
    scaffold: "scripts/create-android-renderer-flood-evidence-dir.mjs",
    verifier: "scripts/verify-android-renderer-flood-evidence.mjs",
    packageCheck: "pnpm check:android-renderer-flood-evidence -- \"$FW_ANDROID_RELEASE_EVIDENCE_PACK/09-renderer-flood\"",
    docs: "docs/ANDROID_RENDERER_FLOOD.md",
    purpose: "Prove the release renderer handles yes | head -10000 without dropped replay markers.",
  },
  {
    id: "background-foreground",
    dir: "10-background-foreground",
    phase: "Lifecycle",
    scaffold: "scripts/create-android-background-foreground-evidence-dir.mjs",
    verifier: "scripts/verify-android-background-foreground-evidence.mjs",
    packageCheck: "pnpm check:android-background-foreground-evidence -- \"$FW_ANDROID_RELEASE_EVIDENCE_PACK/10-background-foreground\"",
    docs: "docs/ANDROID_BACKGROUND_FOREGROUND.md",
    purpose: "Prove app background/foreground replay and post-foreground Android-originated input on a signed release phone.",
  },
  {
    id: "network-reconnect",
    dir: "11-network-reconnect",
    phase: "Lifecycle",
    scaffold: "scripts/create-android-network-reconnect-evidence-dir.mjs",
    verifier: "scripts/verify-android-network-reconnect-evidence.mjs",
    packageCheck: "pnpm check:android-network-reconnect-evidence -- \"$FW_ANDROID_RELEASE_EVIDENCE_PACK/11-network-reconnect\"",
    docs: "docs/ANDROID_NETWORK_RECONNECT.md",
    purpose: "Prove reconnect_ms<=2000 after a direct-adb network cut and replay of output emitted during the gap.",
  },
  {
    id: "restart-restore",
    dir: "12-restart-restore",
    phase: "Lifecycle",
    scaffold: "scripts/create-android-restart-restore-evidence-dir.mjs",
    verifier: "scripts/verify-android-restart-restore-evidence.mjs",
    packageCheck: "pnpm check:android-restart-restore-evidence -- \"$FW_ANDROID_RELEASE_EVIDENCE_PACK/12-restart-restore\"",
    docs: "docs/ANDROID_RESTART_RESTORE.md",
    purpose: "Prove Android restores saved pairing/session list after daemon restart and replays restored scrollback.",
  },
  {
    id: "multisession",
    dir: "13-multisession",
    phase: "Dashboard",
    scaffold: "scripts/create-android-multisession-evidence-dir.mjs",
    verifier: "scripts/verify-android-multisession-evidence.mjs",
    packageCheck: "pnpm check:android-multisession-evidence -- \"$FW_ANDROID_RELEASE_EVIDENCE_PACK/13-multisession\"",
    docs: "docs/ANDROID_MULTISESSION.md",
    purpose: "Prove switching among three desktop-created sessions has no cross-session replay leakage.",
  },
  {
    id: "fcm-push",
    dir: "14-fcm-push",
    phase: "Push",
    scaffold: "scripts/create-android-fcm-push-evidence-dir.mjs",
    verifier: "scripts/verify-android-fcm-push-evidence.mjs",
    packageCheck: "pnpm check:android-fcm-push-evidence -- \"$FW_ANDROID_RELEASE_EVIDENCE_PACK/14-fcm-push\"",
    docs: "docs/ANDROID_FCM_PUSH.md",
    purpose: "Prove 10/10 FCM AwaitingInput deliveries, hash-only payload privacy, and tap-through to the target session.",
  },
];

const options = parseArgs(process.argv.slice(2));
const evidenceRoot = path.resolve(options.dir ?? path.join("/tmp", `fieldwork-android-release-evidence-${timestampForDir(new Date())}`));
const binDir = path.join(evidenceRoot, "bin");

if (fs.existsSync(evidenceRoot)) {
  const existing = fs.readdirSync(evidenceRoot);
  if (existing.length > 0 && !options.force) {
    console.error(`evidence pack directory is not empty: ${evidenceRoot}`);
    console.error("rerun with --force to refresh scaffold files without deleting captured evidence");
    process.exit(1);
  }
} else {
  fs.mkdirSync(evidenceRoot, { recursive: true, mode: 0o700 });
}

runCommandShim();
for (const item of evidenceItems) {
  runFocusedScaffold(item);
}

const manifest = {
  schema: "fieldwork-android-release-evidence-pack-v1",
  createdAt: new Date().toISOString(),
  evidenceRoot,
  binDir,
  generatedFiles,
  scaffolds: {
    bin: "scripts/create-live-testing-fw-shim.mjs",
  },
  note: "This pack creates a temporary source-checkout command shim plus helper scaffolds for the Android signed-release physical-device pass. It does not create, modify, or fabricate verifier evidence.",
  items: evidenceItems.map((item) => ({
    id: item.id,
    phase: item.phase,
    dir: item.dir,
    scaffold: item.scaffold,
    verifier: item.verifier,
    docs: item.docs,
    packageCheck: item.packageCheck,
    purpose: item.purpose,
  })),
};

writeFile("manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
writeFile("capture-order.md", buildCaptureOrder());
writeFile("README.md", buildReadme());
writeFile("setup.sh", buildSetupScript(), 0o700);
writeFile("readiness.sh", buildReadinessScript(), 0o700);
writeFile("verify.sh", buildVerifyScript(), 0o700);

if (options.printDir) {
  process.stdout.write(`${evidenceRoot}\n`);
} else if (!options.quiet) {
  console.log(`Android release evidence pack created: ${evidenceRoot}`);
  console.log(`evidence scaffolds: ${evidenceItems.length}`);
  console.log(`next: ${evidenceRoot}/readiness.sh`);
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
  console.error("usage: node scripts/create-android-release-evidence-pack.mjs [--dir <path>] [--force] [--print-dir] [--quiet]");
}

function runCommandShim() {
  const args = [
    path.join(root, "scripts/create-live-testing-fw-shim.mjs"),
    "--repo-root",
    root,
    "--dir",
    binDir,
    "--quiet",
  ];
  if (options.force) {
    args.push("--force");
  }
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    if (result.stdout) {
      process.stdout.write(result.stdout);
    }
    if (result.stderr) {
      process.stderr.write(result.stderr);
    }
    console.error("failed to create command shim");
    process.exit(result.status ?? 1);
  }
}

function runFocusedScaffold(item) {
  const scriptPath = path.join(root, item.scaffold);
  if (!fs.existsSync(scriptPath)) {
    console.error(`missing scaffold script for ${item.id}: ${item.scaffold}`);
    process.exit(1);
  }

  const targetDir = path.join(evidenceRoot, item.dir);
  const args = [scriptPath, "--dir", targetDir, "--quiet"];
  if (options.force) {
    args.push("--force");
  }
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    if (result.stdout) {
      process.stdout.write(result.stdout);
    }
    if (result.stderr) {
      process.stderr.write(result.stderr);
    }
    console.error(`failed to create ${item.id} scaffold`);
    process.exit(result.status ?? 1);
  }
}

function writeFile(relativePath, contents, mode = 0o600) {
  const filePath = path.join(evidenceRoot, relativePath);
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
  return `# Fieldwork Android Release Evidence Pack

This directory is the top-level scaffold for the Android signed-release
physical-device pass. It creates the focused verifier directories in the
recommended capture order and a temporary source-checkout command shim for
\`fw\`, \`fieldwork\`, and \`fieldworkd\`.

Evidence pack:

\`\`\`sh
export FW_ANDROID_RELEASE_EVIDENCE_PACK="${evidenceRoot}"
source "$FW_ANDROID_RELEASE_EVIDENCE_PACK/setup.sh"
\`\`\`

This pack does not create or fabricate evidence. Every focused verifier still
requires real signed-release artifacts, a non-debuggable installed
\`app.fieldwork.android\` package, direct \`adb\` screenshots/UI/logs, and the
desktop replay transcripts requested by the matching runbook. The release-install
check uses \`--strict-release-device\`, so the local ephemeral
\`Fieldwork Release Smoke\` signer and emulator evidence cannot satisfy the
top-level production pack.

Start with local release readiness through the pack. This puts the generated
\`fw\`/\`fieldworkd\` shim on \`PATH\`, checks the desktop command surfaces,
release AAB, release privacy/build metadata, and physical-device preflight
state, then runs \`fw doctor\` to prove the desktop CLI can auto-start and
handshake with \`fieldworkd\` before physical evidence capture. The top-level
helper runs \`pnpm check:android-release-readiness:local\` first:

\`\`\`sh
"$FW_ANDROID_RELEASE_EVIDENCE_PACK/readiness.sh"
\`\`\`

Strict release readiness still fails until the real Android release secrets,
signed AAB, exactly one authorized physical phone, and installed non-debuggable
release package are available:

\`\`\`sh
pnpm check:android-release-readiness
\`\`\`

Capture order:

${evidenceItems.map((item) => `- \`${item.dir}\` (${item.phase}): ${item.purpose}`).join("\n")}

After capture, run every focused verifier in order:

\`\`\`sh
"$FW_ANDROID_RELEASE_EVIDENCE_PACK/verify.sh"
\`\`\`

\`verify.sh\` does not weaken any focused verifier. It delegates to the same
commands listed in \`capture-order.md\`, including the strict release-install
physical-device check.
`;
}

function buildCaptureOrder() {
  const lines = [
    "# Android Release Evidence Capture Order",
    "",
    `Evidence pack: \`${evidenceRoot}\``,
    "",
    "Run the focused runbooks in order. The order front-loads artifact/install proof, then pairing/dashboard, then terminal behavior, security/performance, lifecycle, and push.",
    "",
  ];

  for (const [index, item] of evidenceItems.entries()) {
    lines.push(`## ${index + 1}. ${item.id}`);
    lines.push("");
    lines.push(`- Directory: \`${item.dir}\``);
    lines.push(`- Phase: ${item.phase}`);
    lines.push(`- Runbook: \`${item.docs}\``);
    lines.push(`- Scaffold: \`${item.scaffold}\``);
    lines.push(`- Verifier: \`${item.verifier}\``);
    lines.push(`- Purpose: ${item.purpose}`);
    lines.push("");
    lines.push("Verify after capture:");
    lines.push("");
    lines.push("```sh");
    lines.push(item.packageCheck);
    lines.push("```");
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

function buildSetupScript() {
  return `export FW_ANDROID_RELEASE_EVIDENCE_PACK=${shellQuote(evidenceRoot)}
export FW_ANDROID_RELEASE_BIN=${shellQuote(binDir)}
export PATH="$FW_ANDROID_RELEASE_BIN:$PATH"
`;
}

function buildReadinessScript() {
  return `#!/usr/bin/env bash
set -euo pipefail

evidence_pack="\${FW_ANDROID_RELEASE_EVIDENCE_PACK:-$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)}"
export FW_ANDROID_RELEASE_EVIDENCE_PACK="$evidence_pack"
export FW_ANDROID_RELEASE_BIN="\${FW_ANDROID_RELEASE_BIN:-$evidence_pack/bin}"
export PATH="$FW_ANDROID_RELEASE_BIN:$PATH"
repo_root="\${FIELDWORK_REPO_ROOT:-$PWD}"

cd "$repo_root"

echo "Android release evidence pack: $evidence_pack"
echo "fw shim: $FW_ANDROID_RELEASE_BIN"
echo
pnpm check:android-release-readiness:local
echo
fw doctor
echo
echo "Focused evidence directories:"
${evidenceItems.map((item) => `printf '  %-28s %s\\n' '${item.id}' "$evidence_pack/${item.dir}"`).join("\n")}
echo
echo "Capture order and verifier commands:"
echo "  $evidence_pack/capture-order.md"
`;
}

function buildVerifyScript() {
  return `#!/usr/bin/env bash
set -euo pipefail

evidence_pack="\${FW_ANDROID_RELEASE_EVIDENCE_PACK:-$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)}"
export FW_ANDROID_RELEASE_EVIDENCE_PACK="$evidence_pack"
export FW_ANDROID_RELEASE_BIN="\${FW_ANDROID_RELEASE_BIN:-$evidence_pack/bin}"
export PATH="$FW_ANDROID_RELEASE_BIN:$PATH"
repo_root="\${FIELDWORK_REPO_ROOT:-$PWD}"

cd "$repo_root"

echo "Android release evidence pack: $evidence_pack"
echo "verify focused evidence directories in capture order"
echo
${evidenceItems
  .map(
    (item) => `echo "==> ${item.id}"
${item.packageCheck}
echo`,
  )
  .join("\n")}
echo "Android release evidence pack verification complete"
`;
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
