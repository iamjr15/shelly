#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const verifier = path.join(root, "scripts/verify-android-cold-start-evidence.mjs");
const generatedFiles = ["README.md", "manifest.json", "missing-files.txt", "capture-checklist.md", "preflight.sh"];

const options = parseArgs(process.argv.slice(2));
const evidenceDir = path.resolve(options.dir ?? path.join("/tmp", `fieldwork-android-cold-start-${timestampForDir(new Date())}`));
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
  schema: "fieldwork-android-cold-start-evidence-v1",
  createdAt: new Date().toISOString(),
  evidenceDir,
  verifier: path.relative(root, verifier),
  requiredFiles,
  generatedFiles,
  note: "This scaffold can capture passing cold-start evidence only when preflight.sh runs against a signed release artifact installed on exactly one physical Android phone. It rejects emulator, debug, debuggable, biometric-bypass, and debug-pairing evidence.",
};

writeFile("manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
writeFile("missing-files.txt", `${requiredFiles.join("\n")}\n`);
writeFile("capture-checklist.md", buildCaptureChecklist(evidenceDir, requiredFiles));
writeFile("README.md", buildReadme(evidenceDir, requiredFiles));
writeFile("preflight.sh", buildPreflightScript(), 0o700);

if (options.printDir) {
  process.stdout.write(`${evidenceDir}\n`);
} else if (!options.quiet) {
  console.log(`Android cold-start evidence scaffold created: ${evidenceDir}`);
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
  console.error("usage: node scripts/create-android-cold-start-evidence-dir.mjs [--dir <path>] [--force] [--print-dir] [--quiet]");
}

function readRequiredFiles() {
  const source = fs.readFileSync(verifier, "utf8");
  const launchMatch = source.match(/const\s+launchFiles\s*=\s*\[(?<body>[\s\S]*?)\];/);
  const launchFiles = launchMatch?.groups?.body
    ? [...launchMatch.groups.body.matchAll(/"([^"\n]+)"/g)].map((fileMatch) => fileMatch[1])
    : [];
  const requiredMatch = source.match(/const\s+requiredFiles\s*=\s*\[(?<body>[\s\S]*?)\];/);
  if (!requiredMatch?.groups?.body) {
    console.error(`cannot locate requiredFiles in ${verifier}`);
    process.exit(1);
  }

  const files = [];
  for (const match of requiredMatch.groups.body.matchAll(/"([^"\n]+)"|\.\.\.launchFiles/g)) {
    if (match[1]) {
      files.push(match[1]);
    } else {
      files.push(...launchFiles);
    }
  }
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
  return `# Fieldwork Android Cold Start Evidence

This directory is a scaffold for the Android physical release-device cold-start
gate.

Evidence directory:

\`\`\`sh
export FW_ANDROID_COLD_DIR="${dir}"
\`\`\`

Use \`docs/ANDROID_COLD_START.md\` as the authoritative runbook. This scaffold
writes helper files plus a direct-adb \`preflight.sh\` that can capture the
signed artifact proof, release BuildConfig proof, physical device listing,
install transcript, installed package identity/version, five cold launch
samples, locked surface screenshot/UI dump, logcat, and crash buffer.

Run it from the repository root after preparing a signed release artifact and
exactly one physical Android phone:

\`\`\`sh
FIELDWORK_ANDROID_RELEASE_APKS=/path/to/fieldwork-release.apks \\
FIELDWORK_ANDROID_AAB=apps/android/app/build/outputs/bundle/release/app-release.aab \\
"$FW_ANDROID_COLD_DIR/preflight.sh"
\`\`\`

If the signed artifact verifier or install command was run elsewhere, pass the
captured transcripts instead:

\`\`\`sh
FIELDWORK_ANDROID_ARTIFACT_SIGNING_FILE=/path/to/artifact-signing.txt \\
FIELDWORK_ANDROID_INSTALL_TRANSCRIPT_FILE=/path/to/install.txt \\
"$FW_ANDROID_COLD_DIR/preflight.sh"
\`\`\`

For direct APK installs, set \`FIELDWORK_ANDROID_RELEASE_APK=/path/to/release.apk\`
instead of \`FIELDWORK_ANDROID_RELEASE_APKS\`. The helper rejects emulator
evidence, debug BuildConfig, biometric bypass, debug pairing codes,
debuggable installed packages, warm launches, slow \`TotalTime\`, unlocked
surfaces, Android fatal/ANR logs, and non-empty crash buffers.

Required files are listed in \`missing-files.txt\` and are derived from
\`scripts/verify-android-cold-start-evidence.mjs\`. After capture, run:

\`\`\`sh
pnpm check:android-cold-start-evidence -- "$FW_ANDROID_COLD_DIR"
\`\`\`

Required file count: ${files.length}
`;
}

function buildCaptureChecklist(dir, files) {
  const required = new Set(files);
  const sections = [
    {
      title: "Signed release artifact",
      files: ["artifact-signing.txt", "buildconfig.txt"],
      note: "Run preflight.sh with a signed release AAB or captured verifier output. It requires release BuildConfig values and rejects debug, biometric-bypass, or debug-pairing builds.",
      commands: [
        'FIELDWORK_ANDROID_AAB=/path/to/app-release.aab "$FW_ANDROID_COLD_DIR/preflight.sh"',
        'FIELDWORK_ANDROID_ARTIFACT_SIGNING_FILE=/path/to/artifact-signing.txt "$FW_ANDROID_COLD_DIR/preflight.sh"',
      ],
    },
    {
      title: "Physical device and install",
      files: ["adb-devices.txt", "install.txt", "package-info.txt"],
      note: "Use exactly one authorized physical Android phone. The installed package must be app.fieldwork.android versionName=1.0 versionCode=1 with no DEBUGGABLE markers.",
      commands: [
        'FIELDWORK_ANDROID_RELEASE_APKS=/path/to/fieldwork-release.apks "$FW_ANDROID_COLD_DIR/preflight.sh"',
        'FIELDWORK_ANDROID_RELEASE_APK=/path/to/app-release.apk "$FW_ANDROID_COLD_DIR/preflight.sh"',
      ],
    },
    {
      title: "Cold launch samples",
      files: ["launch-1.txt", "launch-2.txt", "launch-3.txt", "launch-4.txt", "launch-5.txt"],
      note: "Preflight force-stops before each sample and requires Status: ok, LaunchState: COLD, Activity: app.fieldwork.android/.MainActivity, and TotalTime <= 1200ms.",
      commands: ['"$FW_ANDROID_COLD_DIR/preflight.sh"'],
    },
    {
      title: "Locked surface and logs",
      files: ["locked.png", "locked-ui.xml", "logcat.log", "crash.log"],
      note: "Preflight captures the locked Unlock surface after the final launch and rejects terminal/session/pairing content, Android system error overlays, fatal/ANR logs, and non-empty crash buffers.",
      commands: ['"$FW_ANDROID_COLD_DIR/preflight.sh"'],
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

  return `# Fieldwork Android Cold Start Capture Checklist

Evidence directory:

\`\`\`sh
export FW_ANDROID_COLD_DIR="${dir}"
\`\`\`

Use this checklist while preparing \`docs/ANDROID_COLD_START.md\` evidence. The
preflight helper uses direct \`adb\` and only creates passing evidence when it is
run against a signed release artifact on exactly one physical phone.

Do not use an emulator, debug build, biometric bypass, debug pairing code, or
previously captured launch/install transcripts from another artifact.

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

evidence_dir="\${FW_ANDROID_COLD_DIR:-$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)}"
repo_root="\${FIELDWORK_REPO_ROOT:-$PWD}"
aab="\${FIELDWORK_ANDROID_AAB:-$repo_root/apps/android/app/build/outputs/bundle/release/app-release.aab}"
artifact_signing_file="\${FIELDWORK_ANDROID_ARTIFACT_SIGNING_FILE:-}"
build_config="\${FIELDWORK_ANDROID_RELEASE_BUILDCONFIG:-$repo_root/apps/android/app/build/generated/source/buildConfig/release/app/fieldwork/android/BuildConfig.java}"
release_apks="\${FIELDWORK_ANDROID_RELEASE_APKS:-}"
release_apk="\${FIELDWORK_ANDROID_RELEASE_APK:-}"
install_transcript_file="\${FIELDWORK_ANDROID_INSTALL_TRANSCRIPT_FILE:-}"
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

if [[ -n "$install_transcript_file" ]]; then
  if [[ ! -f "$install_transcript_file" ]]; then
    echo "FIELDWORK_ANDROID_INSTALL_TRANSCRIPT_FILE does not exist: $install_transcript_file" >&2
    exit 1
  fi
  cp "$install_transcript_file" "$evidence_dir/install.txt"
elif [[ -n "$release_apks" ]]; then
  if [[ ! -f "$release_apks" ]]; then
    echo "FIELDWORK_ANDROID_RELEASE_APKS does not exist: $release_apks" >&2
    exit 1
  fi
  require_command bundletool
  bundletool install-apks --apks "$release_apks" > "$evidence_dir/install.txt" 2>&1
elif [[ -n "$release_apk" ]]; then
  if [[ ! -f "$release_apk" ]]; then
    echo "FIELDWORK_ANDROID_RELEASE_APK does not exist: $release_apk" >&2
    exit 1
  fi
  adb_cmd install -r "$release_apk" > "$evidence_dir/install.txt" 2>&1
else
  echo "set FIELDWORK_ANDROID_RELEASE_APKS, FIELDWORK_ANDROID_RELEASE_APK, or FIELDWORK_ANDROID_INSTALL_TRANSCRIPT_FILE" >&2
  exit 1
fi
chmod 0600 "$evidence_dir/install.txt"
require_regex "$evidence_dir/install.txt" '\\b(Success|Installed|installed)\\b' "install.txt must show the signed release app was installed"

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

adb_cmd logcat -c
adb_cmd logcat -b crash -c
for sample in 1 2 3 4 5; do
  adb_cmd shell am force-stop app.fieldwork.android
  adb_cmd shell am start -W -n app.fieldwork.android/.MainActivity > "$evidence_dir/launch-\${sample}.txt"
  chmod 0600 "$evidence_dir/launch-\${sample}.txt"
  node - "$evidence_dir/launch-\${sample}.txt" <<'NODE'
const fs = require("fs");
const path = require("path");
const file = path.basename(process.argv[2]);
const text = fs.readFileSync(process.argv[2], "utf8");
function fail(message) {
  console.error(message);
  process.exit(1);
}
if (!/\\bStatus:\\s*ok\\b/.test(text)) {
  fail(\`\${file} must contain Android am start Status: ok\`);
}
if (!/\\bLaunchState:\\s*COLD\\b/.test(text)) {
  fail(\`\${file} must prove the launch was cold after force-stop\`);
}
if (!/\\bActivity:\\s*app\\.fieldwork\\.android\\/\\.MainActivity\\b/.test(text)) {
  fail(\`\${file} must launch app.fieldwork.android/.MainActivity\`);
}
const totalTime = text.match(/\\bTotalTime:\\s*(\\d+)\\b/);
if (!totalTime) {
  fail(\`\${file} must record TotalTime\`);
}
if (Number(totalTime[1]) > 1200) {
  fail(\`\${file} records TotalTime=\${totalTime[1]}ms, expected <=1200ms\`);
}
NODE
done

adb_cmd exec-out screencap -p > "$evidence_dir/locked.png"
chmod 0600 "$evidence_dir/locked.png"
adb_cmd shell uiautomator dump /sdcard/fieldwork-window.xml >/dev/null
adb_cmd pull /sdcard/fieldwork-window.xml "$evidence_dir/locked-ui.xml" >/dev/null
adb_cmd shell rm /sdcard/fieldwork-window.xml >/dev/null 2>&1 || true
chmod 0600 "$evidence_dir/locked-ui.xml"
adb_cmd logcat -d > "$evidence_dir/logcat.log"
adb_cmd logcat -d -b crash > "$evidence_dir/crash.log"
chmod 0600 "$evidence_dir/logcat.log" "$evidence_dir/crash.log"

node "$repo_root/scripts/verify-android-cold-start-evidence.mjs" "$evidence_dir" >/dev/null
echo "Android cold-start preflight ok: $evidence_dir"
echo "next: retain this directory with release sign-off artifacts"
`;
}
