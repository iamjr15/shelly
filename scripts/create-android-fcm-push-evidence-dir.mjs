#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const verifier = path.join(root, "scripts/verify-android-fcm-push-evidence.mjs");
const generatedFiles = ["README.md", "manifest.json", "missing-files.txt", "capture-checklist.md", "preflight.sh"];

const options = parseArgs(process.argv.slice(2));
const evidenceDir = path.resolve(options.dir ?? path.join("/tmp", `fieldwork-android-fcm-push-${timestampForDir(new Date())}`));
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
  schema: "fieldwork-android-fcm-push-evidence-v1",
  createdAt: new Date().toISOString(),
  evidenceDir,
  verifier: path.relative(root, verifier),
  requiredFiles,
  generatedFiles,
  note: "This scaffold does not create passing FCM evidence. Run preflight.sh only with a signed release artifact installed on one physical Android phone and a reachable production relay. Capture provider payloads, delivery count, notification/tap UI, replay, and logs from the real provider test before running the verifier.",
};

writeFile("manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
writeFile("missing-files.txt", `${requiredFiles.join("\n")}\n`);
writeFile("capture-checklist.md", buildCaptureChecklist(evidenceDir, requiredFiles));
writeFile("README.md", buildReadme(evidenceDir, requiredFiles));
writeFile("preflight.sh", buildPreflightScript(), 0o700);

if (options.printDir) {
  process.stdout.write(`${evidenceDir}\n`);
} else if (!options.quiet) {
  console.log(`Android FCM push evidence scaffold created: ${evidenceDir}`);
  console.log(`required evidence files: ${requiredFiles.length}`);
  console.log(`next: pnpm check:android-fcm-push-evidence -- "${evidenceDir}"`);
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
  console.error("usage: node scripts/create-android-fcm-push-evidence-dir.mjs [--dir <path>] [--force] [--print-dir] [--quiet]");
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
  return `# Fieldwork Android FCM Push Evidence

This directory is a scaffold for the Android FCM provider-push gate. It does not
contain passing evidence yet.

Evidence directory:

\`\`\`sh
export FW_ANDROID_FCM_DIR="${dir}"
\`\`\`

Use \`docs/ANDROID_FCM_PUSH.md\` as the authoritative runbook. This scaffold
only creates helper files plus a direct-adb preflight. The preflight can capture
signed release artifact proof, release BuildConfig proof, relay version output,
one physical Android device listing, and installed package identity/version. It
does not create provider payload JSON, delivery-count evidence, notification
screenshots, tap UI evidence, replay transcripts, or logs.

Run the preflight from the repository root after installing the signed release
artifact on one physical Android phone:

\`\`\`sh
FIELDWORK_ANDROID_AAB=apps/android/app/build/outputs/bundle/release/app-release.aab \\
FIELDWORK_RELAY_VERSION_URL=https://relay.fieldwork.dev:8443/v1/version \\
"$FW_ANDROID_FCM_DIR/preflight.sh"
\`\`\`

If the signed artifact verifier was run elsewhere, pass a captured verifier
output file instead of rerunning it locally:

\`\`\`sh
FIELDWORK_ANDROID_ARTIFACT_SIGNING_FILE=/path/to/artifact-signing.txt \\
"$FW_ANDROID_FCM_DIR/preflight.sh"
\`\`\`

Required files are listed in \`missing-files.txt\` and are derived from
\`scripts/verify-android-fcm-push-evidence.mjs\`. After the real FCM payload,
delivery, notification, tap-through, replay, and log evidence is captured, run:

\`\`\`sh
pnpm check:android-fcm-push-evidence -- "$FW_ANDROID_FCM_DIR"
\`\`\`

Required file count: ${files.length}
`;
}

function buildCaptureChecklist(dir, files) {
  const required = new Set(files);
  const sections = [
    {
      title: "Signed release, relay, physical device, and installed package preflight",
      files: ["artifact-signing.txt", "buildconfig.txt", "relay-version.txt", "adb-devices.txt", "package-info.txt"],
      note: "Run preflight.sh after installing the signed release artifact on exactly one physical Android phone. It rejects emulators, debug BuildConfig, biometric bypass, debug pairing codes, missing package version, and debuggable package markers.",
      commands: ['FIELDWORK_ANDROID_AAB=/path/to/app-release.aab "$FW_ANDROID_FCM_DIR/preflight.sh"'],
    },
    {
      title: "FCM token registration",
      files: ["token-registration.txt"],
      note: "After real QR pairing and biometric unlock, capture logcat proof that Android registered an FCM token through the daemon and relay.",
      commands: [
        "adb logcat -c",
        "adb logcat -d | rg -i 'fcm|registerPushToken|RegisterPushToken|push token' | tee \"$FW_ANDROID_FCM_DIR/token-registration.txt\"",
      ],
    },
    {
      title: "Provider payload inspection and delivery count",
      files: ["provider-payloads.json", "delivery.txt"],
      note: "Capture at least 10 inspected FCM HTTP v1 payloads from the relay provider path plus 10/10 delivered AwaitingInput notifications. delivery.txt must record push_attempts=10 and push_delivered=10. Redact only the raw FCM token.",
      commands: [],
    },
    {
      title: "Notification UI and tap-through",
      files: ["notification.png", "notification-ui.xml", "tap-ui.xml", "tap-replay.txt"],
      note: "Capture the notification shade, tap the notification, unlock if needed, and prove Android-originated notify_tap_ok reaches the target daemon-owned PTY.",
      commands: [
        'adb exec-out screencap -p > "$FW_ANDROID_FCM_DIR/notification.png"',
        "adb shell uiautomator dump /sdcard/window.xml",
        'adb pull /sdcard/window.xml "$FW_ANDROID_FCM_DIR/notification-ui.xml"',
        'script -q "$FW_ANDROID_FCM_DIR/tap-replay.txt" fw attach <target-session-name>',
      ],
    },
    {
      title: "Final Android logs",
      files: ["logcat.log", "crash.log"],
      note: "Capture logs after clearing buffers at the start of the test. The verifier rejects fatal/ANR/exception entries and non-empty crash buffers.",
      commands: [
        'adb logcat -d > "$FW_ANDROID_FCM_DIR/logcat.log"',
        'adb logcat -d -b crash > "$FW_ANDROID_FCM_DIR/crash.log"',
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

  return `# Fieldwork Android FCM Push Capture Checklist

Evidence directory:

\`\`\`sh
export FW_ANDROID_FCM_DIR="${dir}"
\`\`\`

Use this checklist while preparing \`docs/ANDROID_FCM_PUSH.md\` evidence. It
does not create passing provider evidence.

Do not use an emulator, debug build, biometric bypass, debug pairing code, or
provider payloads that contain terminal content, command names, paths, plaintext
session names, or extra keys.

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

evidence_dir="\${FW_ANDROID_FCM_DIR:-$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)}"
repo_root="\${FIELDWORK_REPO_ROOT:-$PWD}"
aab="\${FIELDWORK_ANDROID_AAB:-$repo_root/apps/android/app/build/outputs/bundle/release/app-release.aab}"
artifact_signing_file="\${FIELDWORK_ANDROID_ARTIFACT_SIGNING_FILE:-}"
build_config="\${FIELDWORK_ANDROID_RELEASE_BUILDCONFIG:-$repo_root/apps/android/app/build/generated/source/buildConfig/release/app/fieldwork/android/BuildConfig.java}"
relay_url="\${FIELDWORK_RELAY_VERSION_URL:-https://relay.fieldwork.dev:8443/v1/version}"
adb_serial="\${ANDROID_SERIAL:-}"

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
require_command curl
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

curl -fsS "$relay_url" > "$evidence_dir/relay-version.txt"
chmod 0600 "$evidence_dir/relay-version.txt"
require_fixed "$evidence_dir/relay-version.txt" "contract_version" "relay-version.txt must include contract_version"

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

echo "Android FCM push preflight ok: $evidence_dir"
echo "next: capture token-registration.txt, provider-payloads.json, delivery.txt, notification/tap UI, replay, and clean logs"
`;
}
