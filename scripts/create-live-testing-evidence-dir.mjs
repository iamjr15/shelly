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
  generatedFiles: ["README.md", "manifest.json", "missing-files.txt", "capture-checklist.md", "preflight.sh"],
  note: "This scaffold does not create evidence files. Run preflight.sh only when a real physical Android device is attached, then capture real adb screenshots, UI dumps, logcat, crash buffers, and desktop transcripts before running the verifier.",
};

writeFile("manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
writeFile("missing-files.txt", `${requiredFiles.join("\n")}\n`);
writeFile("capture-checklist.md", buildCaptureChecklist(evidenceDir, requiredFiles));
writeFile("README.md", buildReadme(evidenceDir, requiredFiles));
writeFile("preflight.sh", buildPreflightScript(evidenceDir), 0o700);

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

Run the generated preflight helper from the repository root after the debug APK
is installed, a physical Android phone is connected, and the short \`fw\`
command is on \`PATH\` from either the npm package or the Desktop Setup shim:

\`\`\`sh
"$FW_LIVE_DIR/preflight.sh"
\`\`\`

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

Preflight from the repository root after installing the debug APK:

\`\`\`sh
"$FW_LIVE_DIR/preflight.sh"
\`\`\`

${sections.join("\n\n")}

After all files are captured:

\`\`\`sh
pnpm check:live-testing-evidence -- "$FW_LIVE_DIR"
\`\`\`
`;
}

function buildPreflightScript(dir) {
  return `#!/usr/bin/env bash
set -euo pipefail

evidence_dir="\${FW_LIVE_DIR:-$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)}"
repo_root="\${FIELDWORK_REPO_ROOT:-$PWD}"
build_config="$repo_root/apps/android/app/build/generated/source/buildConfig/debug/app/fieldwork/android/BuildConfig.java"
adb_devices="$evidence_dir/adb-devices.txt"
package_info="$evidence_dir/package-info.txt"
buildconfig_out="$evidence_dir/buildconfig.txt"

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "$1 is required" >&2
    exit 127
  fi
}

require_command rg
require_command adb
require_command fw

if ! fw --help 2>/dev/null | grep -q 'Usage: fw'; then
  echo "fw on PATH must resolve the Fieldwork short alias" >&2
  echo "install the npm package or run the docs/LIVE_TESTING.md Desktop Setup shim first" >&2
  exit 1
fi

mkdir -p "$evidence_dir"

if [[ ! -f "$build_config" ]]; then
  echo "missing debug BuildConfig: $build_config" >&2
  echo "run apps/android/gradlew --no-daemon :app:assembleDebug from the repo root first" >&2
  exit 1
fi

adb devices -l | tee "$adb_devices"

if rg -q '\\b(?:unauthorized|offline|no permissions)\\b' "$adb_devices"; then
  echo "adb device is unauthorized, offline, or inaccessible" >&2
  exit 1
fi

authorized_count="$(awk 'NR > 1 && $2 == "device" { count += 1 } END { print count + 0 }' "$adb_devices")"
if [[ "$authorized_count" -ne 1 ]]; then
  echo "expected exactly one authorized physical Android device, found $authorized_count" >&2
  exit 1
fi

if rg -q '^(?:emulator-[0-9]+|.*(?:\\bsdk_gphone\\b|\\bsdk_gphone64\\b|\\bgeneric_x86\\b|\\bgeneric_x86_64\\b|\\bgoldfish\\b|\\branchu\\b|\\bqemu\\b|\\bavd\\b|\\bdevice:emu[^[:space:]]*\\b)).*[[:space:]]device(?:[[:space:]]|$)' "$adb_devices"; then
  echo "adb device list includes an emulator/AVD; connect one physical Android phone for this evidence pass" >&2
  exit 1
fi

{
  echo '$ adb shell pm path app.fieldwork.android'
  adb shell pm path app.fieldwork.android
  echo '$ adb shell dumpsys package app.fieldwork.android'
  adb shell dumpsys package app.fieldwork.android
} | tee "$package_info"

if ! rg -q '^package:.*app\\.fieldwork\\.android' "$package_info"; then
  echo "app.fieldwork.android is not installed on the connected device" >&2
  exit 1
fi

if ! rg -q '\\bversionName=1\\.0\\b' "$package_info" || ! rg -q '\\bversionCode=1\\b' "$package_info"; then
  echo "installed app.fieldwork.android version does not match the expected first live-test debug build" >&2
  exit 1
fi

rg 'APPLICATION_ID = "app\\.fieldwork\\.android"|BUILD_TYPE = "debug"|DEBUG = Boolean\\.parseBoolean\\("true"\\)|FIELDWORK_BIOMETRIC_BYPASS = false|FIELDWORK_DEBUG_PAIRING_CODE = ""|FIELDWORK_RELAY_CONTROL_URL = ""' "$build_config" | tee "$buildconfig_out"

for required in \\
  'APPLICATION_ID = "app.fieldwork.android"' \\
  'BUILD_TYPE = "debug"' \\
  'DEBUG = Boolean.parseBoolean("true")' \\
  'FIELDWORK_BIOMETRIC_BYPASS = false' \\
  'FIELDWORK_DEBUG_PAIRING_CODE = ""' \\
  'FIELDWORK_RELAY_CONTROL_URL = ""'
do
  if ! grep -Fq "$required" "$buildconfig_out"; then
    echo "BuildConfig preflight missing: $required" >&2
    exit 1
  fi
done

echo "live-test preflight ok: fw alias, exactly one physical adb device, installed app.fieldwork.android package proof, and normal debug BuildConfig evidence captured"
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

function adbCaptureCommands(prefix) {
  return [
    `adb exec-out screencap -p > "$FW_LIVE_DIR/${prefix}.png"`,
    "adb shell uiautomator dump /sdcard/window.xml",
    `adb pull /sdcard/window.xml "$FW_LIVE_DIR/${prefix}-ui.xml"`,
    `adb logcat -d > "$FW_LIVE_DIR/${prefix}-logcat.log"`,
    `adb logcat -d -b crash > "$FW_LIVE_DIR/${prefix}-crash.log"`,
  ];
}

function captureStages() {
  return [
    {
      title: "1. Build and device proof",
      note: "Capture proof that the fw short alias is available, the installed app package is present, the source build is the normal debug build, and adb is connected to exactly one authorized physical phone.",
      files: ["buildconfig.txt", "adb-devices.txt", "package-info.txt"],
      commands: [
        "command -v fw",
        "adb devices -l | tee \"$FW_LIVE_DIR/adb-devices.txt\"",
        "{",
        "  echo '$ adb shell pm path app.fieldwork.android'",
        "  adb shell pm path app.fieldwork.android",
        "  echo '$ adb shell dumpsys package app.fieldwork.android'",
        "  adb shell dumpsys package app.fieldwork.android",
        "} | tee \"$FW_LIVE_DIR/package-info.txt\"",
        "rg 'APPLICATION_ID = \"app\\.fieldwork\\.android\"|BUILD_TYPE = \"debug\"|DEBUG = Boolean\\.parseBoolean\\(\"true\"\\)|FIELDWORK_BIOMETRIC_BYPASS = false|FIELDWORK_DEBUG_PAIRING_CODE = \"\"|FIELDWORK_RELAY_CONTROL_URL = \"\"' \\",
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
        ...adbCaptureCommands("locked"),
      ],
    },
    {
      title: "3. Biometric prompt before session access",
      note: "Tap Unlock, keep biometric authentication pending, and prove the prompt appears before sessions or terminal content.",
      files: ["biometric.png", "biometric-ui.xml", "biometric-logcat.log", "biometric-crash.log"],
      commands: adbCaptureCommands("biometric"),
    },
    {
      title: "4. QR pairing and active dashboard",
      note: "After pre-pair evidence is captured, start fw pair in a desktop transcript when the phone is ready to scan the QR, approve explicitly, unlock, and capture the dashboard with desktop-created sessions.",
      files: ["pairing.txt", "dashboard.png", "dashboard-ui.xml", "dashboard-logcat.log", "dashboard-crash.log", "devices.txt", "sessions.txt"],
      commands: [
        "pair_start_ms=\"$(node -e 'console.log(Date.now())')\"",
        "script -q \"$FW_LIVE_DIR/pairing.txt\" fw pair",
        "pair_end_ms=\"$(node -e 'console.log(Date.now())')\"",
        "printf 'pair_flow_ms=%s\\n' \"$((pair_end_ms - pair_start_ms))\" | tee -a \"$FW_LIVE_DIR/pairing.txt\"",
        ...adbCaptureCommands("dashboard"),
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
        ...adbCaptureCommands("subscription"),
        "script -q \"$FW_LIVE_DIR/subscription-replay.txt\" fw attach fw_live_sub",
      ],
    },
    {
      title: "6. Shell attach and Android-originated input",
      note: "Attach the desktop-created shell/bash session from Android, type android_live_ok, and prove desktop replay sees it.",
      files: ["session.png", "session-ui.xml", "session-logcat.log", "session-crash.log", "terminal-replay.txt"],
      commands: [
        ...adbCaptureCommands("session"),
        "script -q \"$FW_LIVE_DIR/terminal-replay.txt\" fw attach shell",
      ],
    },
    {
      title: "7. Claude/default attach",
      note: "Attach the refactoringjob or generated default claude session from Android and capture a dedicated replay.",
      files: ["claude.png", "claude-ui.xml", "claude-logcat.log", "claude-crash.log", "claude-replay.txt"],
      commands: [
        ...adbCaptureCommands("claude"),
        "script -q \"$FW_LIVE_DIR/claude-replay.txt\" fw attach refactoringjob",
      ],
    },
    {
      title: "8. High-volume flood",
      note: "Run yes ANDROID_LIVE_FLOOD | head -10000 from Android and capture both phone render and desktop replay.",
      files: ["flood.png", "flood-ui.xml", "flood-logcat.log", "flood-crash.log", "flood-replay.txt"],
      commands: [
        ...adbCaptureCommands("flood"),
        "script -q \"$FW_LIVE_DIR/flood-replay.txt\" fw attach shell",
      ],
    },
    {
      title: "9. TUI attach",
      note: "Attach vim or htop from Android and capture visible TUI terminal content.",
      files: ["tui.png", "tui-ui.xml", "tui-logcat.log", "tui-crash.log"],
      commands: adbCaptureCommands("tui"),
    },
    {
      title: "10. Resize and detach",
      note: "Resize the Android terminal, capture the reported PTY size, then detach and reattach the same shell session.",
      files: ["resize.png", "resize-ui.xml", "resize-logcat.log", "resize-crash.log", "resize-replay.txt", "detach.png", "detach-ui.xml", "detach-logcat.log", "detach-crash.log", "detach-replay.txt"],
      commands: [
        ...adbCaptureCommands("resize"),
        "script -q \"$FW_LIVE_DIR/resize-replay.txt\" fw attach shell",
        ...adbCaptureCommands("detach"),
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
        ...adbCaptureCommands("background"),
        "script -q \"$FW_LIVE_DIR/background-replay.txt\" fw attach shell",
        ...adbCaptureCommands("stale-biometric"),
        "printf 'stale_background_ms=<elapsed-ms>\\nstale_input_before_unlock_blocked\\n' | tee \"$FW_LIVE_DIR/stale-biometric.txt\"",
        ...adbCaptureCommands("reconnect"),
        "script -q \"$FW_LIVE_DIR/reconnect-replay.txt\" fw attach shell",
        ...adbCaptureCommands("restart"),
        "script -q \"$FW_LIVE_DIR/restart-replay.txt\" fw attach fw_restart_session",
        ...adbCaptureCommands("multisession"),
        "script -q \"$FW_LIVE_DIR/multisession-a-replay.txt\" fw attach fwm_a",
        "script -q \"$FW_LIVE_DIR/multisession-b-replay.txt\" fw attach fwm_b",
        "script -q \"$FW_LIVE_DIR/multisession-c-replay.txt\" fw attach fwm_c",
      ],
    },
  ];
}
