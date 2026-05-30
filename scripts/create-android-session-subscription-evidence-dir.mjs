#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const verifier = path.join(root, "scripts/verify-android-session-subscription-evidence.mjs");
const generatedFiles = ["README.md", "manifest.json", "missing-files.txt", "capture-checklist.md", "preflight.sh"];

const options = parseArgs(process.argv.slice(2));
const evidenceDir = path.resolve(options.dir ?? path.join("/tmp", `fieldwork-android-subscription-${timestampForDir(new Date())}`));
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
  schema: "fieldwork-android-session-subscription-evidence-v1",
  createdAt: new Date().toISOString(),
  evidenceDir,
  verifier: path.relative(root, verifier),
  requiredFiles,
  generatedFiles,
  note: "This scaffold captures release/device proof and adb UI/log evidence. It does not create desktop-create.txt, subscription-visible.txt, or subscription-replay.txt; those must come from the real desktop-created session and Android-originated input flow.",
};

writeFile("manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
writeFile("missing-files.txt", `${requiredFiles.join("\n")}\n`);
writeFile("capture-checklist.md", buildCaptureChecklist(evidenceDir, requiredFiles));
writeFile("README.md", buildReadme(evidenceDir, requiredFiles));
writeFile("preflight.sh", buildPreflightScript(), 0o700);

if (options.printDir) {
  process.stdout.write(`${evidenceDir}\n`);
} else if (!options.quiet) {
  console.log(`Android session-subscription evidence scaffold created: ${evidenceDir}`);
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
  console.error("usage: node scripts/create-android-session-subscription-evidence-dir.mjs [--dir <path>] [--force] [--print-dir] [--quiet]");
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
  return `# Fieldwork Android Session Subscription Evidence

This directory is a scaffold for the Android physical release-device
desktop-created session subscription gate.

Evidence directory:

\`\`\`sh
export FW_ANDROID_SUBSCRIPTION_DIR="${dir}"
\`\`\`

Use \`docs/ANDROID_SESSION_SUBSCRIPTION.md\` as the authoritative runbook. This
scaffold writes helper files plus a direct-adb \`preflight.sh\`.

Before the desktop creates \`fw_live_sub\`, capture release/device/package proof
and clear Android logs:

\`\`\`sh
FIELDWORK_ANDROID_AAB=apps/android/app/build/outputs/bundle/release/app-release.aab \\
"$FW_ANDROID_SUBSCRIPTION_DIR/preflight.sh"
\`\`\`

After the phone is paired and sitting on the dashboard, prove the subscribed
session is not already visible:

\`\`\`sh
FIELDWORK_ANDROID_SUBSCRIPTION_CAPTURE_BEFORE=true \\
"$FW_ANDROID_SUBSCRIPTION_DIR/preflight.sh"
\`\`\`

Create \`fw_live_sub\` from the desktop, time when it becomes visible on
Android, attach from Android, type \`subscription_attach_ok\`, and capture the
desktop replay exactly as the runbook shows. The helper does not create
\`desktop-create.txt\`, \`subscription-visible.txt\`, or
\`subscription-replay.txt\`.

After those three transcripts exist, capture the post-create dashboard and run
the verifier:

\`\`\`sh
FIELDWORK_ANDROID_SUBSCRIPTION_CAPTURE_AFTER=true \\
"$FW_ANDROID_SUBSCRIPTION_DIR/preflight.sh"
\`\`\`

If signing was captured elsewhere, pass:

\`\`\`sh
FIELDWORK_ANDROID_ARTIFACT_SIGNING_FILE=/path/to/artifact-signing.txt \\
"$FW_ANDROID_SUBSCRIPTION_DIR/preflight.sh"
\`\`\`

The helper rejects emulator evidence, debug BuildConfig, biometric bypass,
debug pairing codes, debuggable installed packages, missing desktop
transcripts, Android fatal/ANR logs, Android not-responding overlays, and
non-empty crash buffers.

Required files are listed in \`missing-files.txt\` and are derived from
\`scripts/verify-android-session-subscription-evidence.mjs\`. After capture,
run:

\`\`\`sh
pnpm check:android-session-subscription-evidence -- "$FW_ANDROID_SUBSCRIPTION_DIR"
\`\`\`

Required file count: ${files.length}
`;
}

function buildCaptureChecklist(dir, files) {
  const required = new Set(files);
  const sections = [
    {
      title: "Signed release and physical device preflight",
      files: ["artifact-signing.txt", "buildconfig.txt", "adb-devices.txt", "package-info.txt"],
      note: "Run preflight.sh before the subscribed session is created. It requires signed release proof, release BuildConfig, exactly one physical phone, and app.fieldwork.android versionName=1.0 versionCode=1 with no debuggable markers.",
      commands: ['"$FW_ANDROID_SUBSCRIPTION_DIR/preflight.sh"'],
    },
    {
      title: "Before-create dashboard",
      files: ["dashboard-before-ui.xml"],
      note: "After real QR pairing and biometric unlock, leave Android on the dashboard and prove fw_live_sub is not already visible.",
      commands: ['FIELDWORK_ANDROID_SUBSCRIPTION_CAPTURE_BEFORE=true "$FW_ANDROID_SUBSCRIPTION_DIR/preflight.sh"'],
    },
    {
      title: "Desktop create and visibility timing",
      files: ["desktop-create.txt", "subscription-visible.txt"],
      note: "Create fw_live_sub from the desktop CLI while Android is already watching the dashboard. Record created_by_desktop_cli and visible_ms<=2000 when the session appears.",
      commands: [
        'sub_start_ms="$(node -e \'console.log(Date.now())\')"',
        'script -q "$FW_ANDROID_SUBSCRIPTION_DIR/desktop-create.txt" fw new --name fw_live_sub bash',
        'sub_visible_ms="$(node -e \'console.log(Date.now())\')"',
        'printf \'created_by_desktop_cli\\nvisible_ms=%s\\n\' "$((sub_visible_ms - sub_start_ms))" | tee "$FW_ANDROID_SUBSCRIPTION_DIR/subscription-visible.txt"',
      ],
    },
    {
      title: "After-create dashboard, replay, and logs",
      files: ["subscription.png", "subscription-ui.xml", "subscription-logcat.log", "subscription-crash.log", "subscription-replay.txt", "sessions-after.txt"],
      note: "Open fw_live_sub from Android, type subscription_attach_ok, capture a desktop replay, then rerun preflight.sh in after mode to collect screenshot/UI/log/session-list evidence and run the verifier.",
      commands: [
        'script -q "$FW_ANDROID_SUBSCRIPTION_DIR/subscription-replay.txt" fw attach fw_live_sub',
        'FIELDWORK_ANDROID_SUBSCRIPTION_CAPTURE_AFTER=true "$FW_ANDROID_SUBSCRIPTION_DIR/preflight.sh"',
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

  return `# Fieldwork Android Session Subscription Capture Checklist

Evidence directory:

\`\`\`sh
export FW_ANDROID_SUBSCRIPTION_DIR="${dir}"
\`\`\`

Use this checklist while preparing \`docs/ANDROID_SESSION_SUBSCRIPTION.md\`
evidence. The preflight helper uses direct \`adb\` but does not create the
desktop session, timing, or Android-originated input transcripts.

Do not use an emulator, debug build, biometric bypass, debug pairing code, or
previously captured transcripts from another artifact.

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

evidence_dir="\${FW_ANDROID_SUBSCRIPTION_DIR:-$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)}"
repo_root="\${FIELDWORK_REPO_ROOT:-$PWD}"
aab="\${FIELDWORK_ANDROID_AAB:-$repo_root/apps/android/app/build/outputs/bundle/release/app-release.aab}"
artifact_signing_file="\${FIELDWORK_ANDROID_ARTIFACT_SIGNING_FILE:-}"
build_config="\${FIELDWORK_ANDROID_RELEASE_BUILDCONFIG:-$repo_root/apps/android/app/build/generated/source/buildConfig/release/app/fieldwork/android/BuildConfig.java}"
adb_serial="\${ANDROID_SERIAL:-}"
capture_before="\${FIELDWORK_ANDROID_SUBSCRIPTION_CAPTURE_BEFORE:-false}"
capture_after="\${FIELDWORK_ANDROID_SUBSCRIPTION_CAPTURE_AFTER:-false}"

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "$1 is required" >&2
    exit 127
  fi
}

adb_cmd() {
  if [[ -n "$adb_serial" ]]; then
    adb -s "$adb_serial" "$@"
  else
    adb "$@"
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

require_regex() {
  local file="$1"
  local pattern="$2"
  local message="$3"
  if ! rg -q "$pattern" "$file"; then
    echo "$message" >&2
    exit 1
  fi
}

require_command adb
require_command node
require_command rg

mkdir -p "$evidence_dir"

if [[ -n "$artifact_signing_file" ]]; then
  if [[ ! -f "$artifact_signing_file" ]]; then
    echo "FIELDWORK_ANDROID_ARTIFACT_SIGNING_FILE does not exist: $artifact_signing_file" >&2
    exit 1
  fi
  cp "$artifact_signing_file" "$evidence_dir/artifact-signing.txt"
else
  if [[ ! -f "$aab" ]]; then
    echo "signed Android AAB is missing: $aab" >&2
    echo "Build/sign the release bundle or set FIELDWORK_ANDROID_ARTIFACT_SIGNING_FILE to captured verifier output." >&2
    exit 1
  fi
  node "$repo_root/scripts/verify-android-aab.mjs" --expect-signed "$aab" > "$evidence_dir/artifact-signing.txt"
fi
chmod 0600 "$evidence_dir/artifact-signing.txt"
require_fixed "$evidence_dir/artifact-signing.txt" "Android AAB ok:" "artifact-signing.txt must contain Android AAB verifier success output"
require_fixed "$evidence_dir/artifact-signing.txt" "signed release bundle ok" "artifact-signing.txt must prove signed release bundle ok"

if [[ ! -f "$build_config" ]]; then
  echo "Android release BuildConfig is missing: $build_config" >&2
  exit 1
fi
rg 'APPLICATION_ID = "app\\.fieldwork\\.android"|BUILD_TYPE = "release"|DEBUG = (false|Boolean\\.parseBoolean\\("false"\\))|FIELDWORK_BIOMETRIC_BYPASS = false|FIELDWORK_DEBUG_PAIRING_CODE = ""' "$build_config" \\
  > "$evidence_dir/buildconfig.txt"
chmod 0600 "$evidence_dir/buildconfig.txt"
require_fixed "$evidence_dir/buildconfig.txt" 'APPLICATION_ID = "app.fieldwork.android"' "buildconfig.txt must prove app.fieldwork.android"
require_fixed "$evidence_dir/buildconfig.txt" 'BUILD_TYPE = "release"' "buildconfig.txt must prove release build"
require_regex "$evidence_dir/buildconfig.txt" 'DEBUG = (false|Boolean\\.parseBoolean\\("false"\\))' "buildconfig.txt must prove DEBUG=false"
require_fixed "$evidence_dir/buildconfig.txt" 'FIELDWORK_BIOMETRIC_BYPASS = false' "buildconfig.txt must prove biometric bypass is off"
require_fixed "$evidence_dir/buildconfig.txt" 'FIELDWORK_DEBUG_PAIRING_CODE = ""' "buildconfig.txt must prove no debug pairing code"

adb_cmd devices -l > "$evidence_dir/adb-devices.txt"
chmod 0600 "$evidence_dir/adb-devices.txt"
node - "$evidence_dir/adb-devices.txt" <<'NODE'
const fs = require("fs");
const text = fs.readFileSync(process.argv[2], "utf8");
const lines = text.split(/\\r?\\n/).slice(1).filter((line) => line.trim());
if (lines.some((line) => /\\b(?:unauthorized|offline|recovery|sideload|no permissions)\\b/i.test(line))) {
  console.error("adb-devices.txt contains an unavailable Android device");
  process.exit(1);
}
const devices = lines.filter((line) => /\\bdevice\\b/.test(line));
if (devices.length !== 1) {
  console.error(\`adb-devices.txt must show exactly one authorized physical Android device, found \${devices.length}\`);
  process.exit(1);
}
if (/\\bemulator-|sdk_gphone|sdk_phone|avd|generic_x86|generic_x64/i.test(devices[0])) {
  console.error("adb-devices.txt must show a physical Android phone, not an emulator or AVD");
  process.exit(1);
}
NODE

{
  echo '$ adb shell pm path app.fieldwork.android'
  adb_cmd shell pm path app.fieldwork.android
  echo '$ adb shell dumpsys package app.fieldwork.android'
  adb_cmd shell dumpsys package app.fieldwork.android
} > "$evidence_dir/package-info.txt"
chmod 0600 "$evidence_dir/package-info.txt"
require_fixed "$evidence_dir/package-info.txt" "app.fieldwork.android" "package-info.txt must show app.fieldwork.android"
require_fixed "$evidence_dir/package-info.txt" "versionName=1.0" "package-info.txt must prove versionName=1.0"
require_fixed "$evidence_dir/package-info.txt" "versionCode=1" "package-info.txt must prove versionCode=1"
if rg -q 'DEBUGGABLE|debuggable=true|android:debuggable="true"' "$evidence_dir/package-info.txt"; then
  echo "package-info.txt must not contain debuggable markers" >&2
  exit 1
fi

if [[ "$capture_before" == "true" ]]; then
  adb_cmd shell uiautomator dump /sdcard/fieldwork-subscription-before.xml >/dev/null
  adb_cmd pull /sdcard/fieldwork-subscription-before.xml "$evidence_dir/dashboard-before-ui.xml" >/dev/null
  adb_cmd shell rm /sdcard/fieldwork-subscription-before.xml >/dev/null 2>&1 || true
  chmod 0600 "$evidence_dir/dashboard-before-ui.xml"
  if rg -q '\\bfw_live_sub\\b' "$evidence_dir/dashboard-before-ui.xml"; then
    echo "dashboard-before-ui.xml must not already show fw_live_sub" >&2
    exit 1
  fi
  echo "Android session-subscription before-create capture ok: $evidence_dir"
  echo "next: create fw_live_sub from desktop, capture visible timing and replay, then rerun with FIELDWORK_ANDROID_SUBSCRIPTION_CAPTURE_AFTER=true"
elif [[ "$capture_after" == "true" ]]; then
  require_command fw
  for file in dashboard-before-ui.xml desktop-create.txt subscription-visible.txt subscription-replay.txt; do
    if [[ ! -f "$evidence_dir/$file" ]]; then
      echo "$file is missing; capture the real desktop/Android transcript first" >&2
      exit 1
    fi
  done
  fw ls > "$evidence_dir/sessions-after.txt"
  adb_cmd exec-out screencap -p > "$evidence_dir/subscription.png"
  adb_cmd shell uiautomator dump /sdcard/fieldwork-subscription-after.xml >/dev/null
  adb_cmd pull /sdcard/fieldwork-subscription-after.xml "$evidence_dir/subscription-ui.xml" >/dev/null
  adb_cmd shell rm /sdcard/fieldwork-subscription-after.xml >/dev/null 2>&1 || true
  adb_cmd logcat -d > "$evidence_dir/subscription-logcat.log"
  adb_cmd logcat -d -b crash > "$evidence_dir/subscription-crash.log"
  chmod 0600 "$evidence_dir/sessions-after.txt" "$evidence_dir/subscription.png" "$evidence_dir/subscription-ui.xml" "$evidence_dir/subscription-logcat.log" "$evidence_dir/subscription-crash.log"
  node "$repo_root/scripts/verify-android-session-subscription-evidence.mjs" "$evidence_dir" >/dev/null
  echo "Android session-subscription after-create capture ok: $evidence_dir"
  echo "next: retain this directory with release sign-off artifacts"
else
  adb_cmd logcat -c
  adb_cmd logcat -b crash -c
  echo "Android session-subscription preflight ok: $evidence_dir"
  echo "next: pair the phone, open the dashboard, then rerun with FIELDWORK_ANDROID_SUBSCRIPTION_CAPTURE_BEFORE=true"
fi
`;
}
