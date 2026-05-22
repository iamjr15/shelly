#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const verifier = path.join(root, "scripts/verify-live-testing-evidence.mjs");

const options = parseArgs(process.argv.slice(2));
const evidenceDir = path.resolve(options.dir ?? path.join("/tmp", `fieldwork-live-${timestampForDir(new Date())}`));
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
  schema: "fieldwork-live-testing-evidence-v1",
  createdAt: new Date().toISOString(),
  evidenceDir,
  verifier: path.relative(root, verifier),
  requiredFiles,
  generatedFiles: ["README.md", "manifest.json", "missing-files.txt", "capture-checklist.md"],
  note: "This scaffold does not create evidence files. Capture real adb screenshots, UI dumps, logcat, crash buffers, and desktop transcripts before running the verifier.",
};

writeFile("manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
writeFile("missing-files.txt", `${requiredFiles.join("\n")}\n`);
writeFile("capture-checklist.md", buildCaptureChecklist(evidenceDir, requiredFiles));
writeFile("README.md", buildReadme(evidenceDir, requiredFiles));

if (options.printDir) {
  process.stdout.write(`${evidenceDir}\n`);
} else if (!options.quiet) {
  console.log(`live testing evidence scaffold created: ${evidenceDir}`);
  console.log(`required evidence files: ${requiredFiles.length}`);
  console.log(`next: pnpm check:live-testing-evidence -- "${evidenceDir}"`);
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
  console.error("usage: node scripts/create-live-testing-evidence-dir.mjs [--dir <path>] [--force] [--print-dir] [--quiet]");
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

function writeFile(relativePath, contents) {
  fs.writeFileSync(path.join(evidenceDir, relativePath), contents, { mode: 0o600 });
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
  return `# Fieldwork Live Testing Evidence

This directory is a scaffold for the first operator-assisted Android physical-device live test.
It does not contain passing evidence yet.

Evidence directory:

\`\`\`sh
export FW_LIVE_DIR="${dir}"
\`\`\`

Capture real evidence with the direct \`adb\` commands in \`docs/LIVE_TESTING.md\`.
Do not create placeholder screenshots, UI dumps, logs, crash buffers, or transcripts.
Use \`capture-checklist.md\` in this directory as the stage-by-stage capture order
while running the physical Android test.

Required files are listed in \`missing-files.txt\` and are derived from
\`scripts/verify-live-testing-evidence.mjs\`. After capture, run:

\`\`\`sh
pnpm check:live-testing-evidence -- "$FW_LIVE_DIR"
\`\`\`

Required file count: ${files.length}
`;
}

function buildCaptureChecklist(dir, files) {
  const required = new Set(files);
  const assigned = new Set();
  const sections = [];

  for (const stage of captureStages()) {
    const stageFiles = stage.files.filter((file) => required.has(file));
    if (stageFiles.length === 0) {
      continue;
    }
    for (const file of stageFiles) {
      assigned.add(file);
    }
    sections.push(renderChecklistStage(stage, stageFiles));
  }

  const unassigned = files.filter((file) => !assigned.has(file));
  if (unassigned.length > 0) {
    sections.push(renderChecklistStage(
      {
        title: "Verifier-only additions",
        note: "These files are required by the verifier but are not assigned to a named runbook stage yet. Capture them with the same direct adb/transcript pattern and update this scaffold before release sign-off.",
        commands: [],
      },
      unassigned,
    ));
  }

  return `# Fieldwork Android Live-Test Capture Checklist

Evidence directory:

\`\`\`sh
export FW_LIVE_DIR="${dir}"
\`\`\`

Use this file during the first Android physical-device live test. It is a
checklist generated from \`scripts/verify-live-testing-evidence.mjs\`; it does not
replace \`docs/LIVE_TESTING.md\` or create evidence.

Direct adb capture pattern for every UI stage:

\`\`\`sh
adb exec-out screencap -p > "$FW_LIVE_DIR/<stage>.png"
adb shell uiautomator dump /sdcard/window.xml
adb pull /sdcard/window.xml "$FW_LIVE_DIR/<stage>-ui.xml"
adb logcat -d > "$FW_LIVE_DIR/<stage>-logcat.log"
adb logcat -d -b crash > "$FW_LIVE_DIR/<stage>-crash.log"
\`\`\`

${sections.join("\n\n")}

After all files are captured:

\`\`\`sh
pnpm check:live-testing-evidence -- "$FW_LIVE_DIR"
\`\`\`
`;
}

function renderChecklistStage(stage, files) {
  const fileLines = files.map((file) => `- [ ] \`${file}\``).join("\n");
  const commandBlock = stage.commands?.length
    ? `\n\nSuggested direct commands/transcripts:\n\n\`\`\`sh\n${stage.commands.join("\n")}\n\`\`\``
    : "";
  return `## ${stage.title}

${stage.note}

${fileLines}${commandBlock}`;
}

function captureStages() {
  return [
    {
      title: "1. Build and device proof",
      note: "Capture proof that the installed app is the normal debug build and that adb is connected to a physical authorized phone.",
      files: ["buildconfig.txt", "adb-devices.txt"],
      commands: [
        "adb devices -l | tee \"$FW_LIVE_DIR/adb-devices.txt\"",
        "rg 'APPLICATION_ID = \"app\\\\.fieldwork\\\\.android\"|BUILD_TYPE = \"debug\"|DEBUG = Boolean\\\\.parseBoolean\\\\(\"true\"\\\\)|FIELDWORK_BIOMETRIC_BYPASS = false|FIELDWORK_DEBUG_PAIRING_PAYLOAD = \"\"' \\",
        "  apps/android/app/build/generated/source/buildConfig/debug/app/fieldwork/android/BuildConfig.java \\",
        "  | tee \"$FW_LIVE_DIR/buildconfig.txt\"",
      ],
    },
    {
      title: "2. Locked cold launch",
      note: "Clear logs, cold-launch the app, and capture the locked surface before unlock or pairing content is visible.",
      files: ["launch.txt", "locked.png", "locked-ui.xml", "locked-logcat.log", "locked-crash.log"],
      commands: [
        "adb shell am force-stop app.fieldwork.android",
        "adb logcat -c",
        "adb shell am start -W -n app.fieldwork.android/.MainActivity | tee \"$FW_LIVE_DIR/launch.txt\"",
        "adb exec-out screencap -p > \"$FW_LIVE_DIR/locked.png\"",
        "adb shell uiautomator dump /sdcard/window.xml",
        "adb pull /sdcard/window.xml \"$FW_LIVE_DIR/locked-ui.xml\"",
        "adb logcat -d > \"$FW_LIVE_DIR/locked-logcat.log\"",
        "adb logcat -d -b crash > \"$FW_LIVE_DIR/locked-crash.log\"",
      ],
    },
    {
      title: "3. Biometric prompt before session access",
      note: "Tap Unlock, keep biometric authentication pending, and prove the prompt appears before sessions or terminal content.",
      files: ["biometric.png", "biometric-ui.xml", "biometric-logcat.log", "biometric-crash.log"],
      commands: [
        "adb exec-out screencap -p > \"$FW_LIVE_DIR/biometric.png\"",
        "adb shell uiautomator dump /sdcard/window.xml",
        "adb pull /sdcard/window.xml \"$FW_LIVE_DIR/biometric-ui.xml\"",
        "adb logcat -d > \"$FW_LIVE_DIR/biometric-logcat.log\"",
        "adb logcat -d -b crash > \"$FW_LIVE_DIR/biometric-crash.log\"",
      ],
    },
    {
      title: "4. QR pairing and active dashboard",
      note: "Run fw pair in a desktop transcript, approve explicitly, unlock, and capture the dashboard with desktop-created sessions.",
      files: ["pairing.txt", "dashboard.png", "dashboard-ui.xml", "dashboard-logcat.log", "dashboard-crash.log", "devices.txt", "sessions.txt"],
      commands: [
        "pair_start_ms=\"$(node -e 'console.log(Date.now())')\"",
        "script -q \"$FW_LIVE_DIR/pairing.txt\" fw pair",
        "pair_end_ms=\"$(node -e 'console.log(Date.now())')\"",
        "printf 'pair_flow_ms=%s\\n' \"$((pair_end_ms - pair_start_ms))\" | tee -a \"$FW_LIVE_DIR/pairing.txt\"",
        "adb exec-out screencap -p > \"$FW_LIVE_DIR/dashboard.png\"",
        "adb shell uiautomator dump /sdcard/window.xml",
        "adb pull /sdcard/window.xml \"$FW_LIVE_DIR/dashboard-ui.xml\"",
        "adb logcat -d > \"$FW_LIVE_DIR/dashboard-logcat.log\"",
        "adb logcat -d -b crash > \"$FW_LIVE_DIR/dashboard-crash.log\"",
        "fw devices > \"$FW_LIVE_DIR/devices.txt\"",
        "fw ls > \"$FW_LIVE_DIR/sessions.txt\"",
      ],
    },
    {
      title: "5. Post-pair session subscription",
      note: "Create fw_live_sub from the desktop while Android watches the dashboard, then attach from Android and replay from desktop.",
      files: ["subscription.png", "subscription-ui.xml", "subscription-logcat.log", "subscription-crash.log", "subscription-visible.txt", "subscription-replay.txt"],
      commands: [
        "sub_start_ms=\"$(node -e 'console.log(Date.now())')\"",
        "fw new --name fw_live_sub bash",
        "sub_visible_ms=\"$(node -e 'console.log(Date.now())')\"",
        "printf 'created_by_desktop_cli\\nvisible_ms=%s\\n' \"$((sub_visible_ms - sub_start_ms))\" | tee \"$FW_LIVE_DIR/subscription-visible.txt\"",
        "script -q \"$FW_LIVE_DIR/subscription-replay.txt\" fw attach fw_live_sub",
      ],
    },
    {
      title: "6. Shell attach and Android-originated input",
      note: "Attach the desktop-created shell/bash session from Android, type android_live_ok, and prove desktop replay sees it.",
      files: ["session.png", "session-ui.xml", "session-logcat.log", "session-crash.log", "terminal-replay.txt"],
      commands: [
        "script -q \"$FW_LIVE_DIR/terminal-replay.txt\" fw attach shell",
      ],
    },
    {
      title: "7. Claude/default attach",
      note: "Attach the refactoringjob or generated default claude session from Android and capture a dedicated replay.",
      files: ["claude.png", "claude-ui.xml", "claude-logcat.log", "claude-crash.log", "claude-replay.txt"],
      commands: [
        "script -q \"$FW_LIVE_DIR/claude-replay.txt\" fw attach refactoringjob",
      ],
    },
    {
      title: "8. High-volume flood",
      note: "Run yes ANDROID_LIVE_FLOOD | head -10000 from Android and capture both phone render and desktop replay.",
      files: ["flood.png", "flood-ui.xml", "flood-logcat.log", "flood-crash.log", "flood-replay.txt"],
      commands: [
        "script -q \"$FW_LIVE_DIR/flood-replay.txt\" fw attach shell",
      ],
    },
    {
      title: "9. TUI attach",
      note: "Attach vim or htop from Android and capture visible TUI terminal content.",
      files: ["tui.png", "tui-ui.xml", "tui-logcat.log", "tui-crash.log"],
      commands: [],
    },
    {
      title: "10. Resize and detach",
      note: "Resize the Android terminal, capture the reported PTY size, then detach and reattach the same shell session.",
      files: ["resize.png", "resize-ui.xml", "resize-logcat.log", "resize-crash.log", "resize-replay.txt", "detach.png", "detach-ui.xml", "detach-logcat.log", "detach-crash.log", "detach-replay.txt"],
      commands: [
        "script -q \"$FW_LIVE_DIR/resize-replay.txt\" fw attach shell",
        "script -q \"$FW_LIVE_DIR/detach-replay.txt\" fw attach shell",
      ],
    },
    {
      title: "11. Background, stale biometric, reconnect, restart, and multisession",
      note: "Capture dedicated state-preservation evidence sets rather than relying on notes.",
      files: [
        "background.png",
        "background-ui.xml",
        "background-logcat.log",
        "background-crash.log",
        "background-replay.txt",
        "stale-biometric.png",
        "stale-biometric-ui.xml",
        "stale-biometric-logcat.log",
        "stale-biometric-crash.log",
        "stale-biometric.txt",
        "reconnect.png",
        "reconnect-ui.xml",
        "reconnect-logcat.log",
        "reconnect-crash.log",
        "reconnect-replay.txt",
        "restart.png",
        "restart-ui.xml",
        "restart-logcat.log",
        "restart-crash.log",
        "restart-replay.txt",
        "multisession.png",
        "multisession-ui.xml",
        "multisession-logcat.log",
        "multisession-crash.log",
        "multisession-a-replay.txt",
        "multisession-b-replay.txt",
        "multisession-c-replay.txt",
      ],
      commands: [
        "script -q \"$FW_LIVE_DIR/background-replay.txt\" fw attach shell",
        "printf 'stale_background_ms=<elapsed-ms>\\nstale_input_before_unlock_blocked\\n' | tee \"$FW_LIVE_DIR/stale-biometric.txt\"",
        "script -q \"$FW_LIVE_DIR/reconnect-replay.txt\" fw attach shell",
        "script -q \"$FW_LIVE_DIR/restart-replay.txt\" fw attach fw_restart_session",
        "script -q \"$FW_LIVE_DIR/multisession-a-replay.txt\" fw attach fwm_a",
        "script -q \"$FW_LIVE_DIR/multisession-b-replay.txt\" fw attach fwm_b",
        "script -q \"$FW_LIVE_DIR/multisession-c-replay.txt\" fw attach fwm_c",
      ],
    },
  ];
}
