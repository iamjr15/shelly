#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const verifier = path.join(root, "scripts/verify-android-multisession-evidence.mjs");
const generatedFiles = ["README.md", "manifest.json", "missing-files.txt", "capture-checklist.md", "preflight.sh"];

const options = parseArgs(process.argv.slice(2));
const evidenceDir = path.resolve(options.dir ?? path.join("/tmp", `fieldwork-android-multisession-${timestampForDir(new Date())}`));
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
  schema: "fieldwork-android-multisession-evidence-v1",
  createdAt: new Date().toISOString(),
  evidenceDir,
  verifier: path.relative(root, verifier),
  requiredFiles,
  generatedFiles,
  note: "This scaffold captures signed release/device proof, desktop session listing, and direct-adb Android multisession screenshot/UI/log evidence. It does not create per-session PTY replay transcripts.",
};

writeFile("manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
writeFile("missing-files.txt", `${requiredFiles.join("\n")}\n`);
writeFile("capture-checklist.md", buildCaptureChecklist(evidenceDir, requiredFiles));
writeFile("README.md", buildReadme(evidenceDir, requiredFiles));
writeFile("preflight.sh", buildPreflightScript(), 0o700);

if (options.printDir) {
  process.stdout.write(`${evidenceDir}\n`);
} else if (!options.quiet) {
  console.log(`Android multisession evidence scaffold created: ${evidenceDir}`);
  console.log(`required evidence files: ${requiredFiles.length}`);
  console.log(`next: ${evidenceDir}/preflight.sh`);
}

function parseArgs(args) {
  const parsed = { dir: null, force: false, printDir: false, quiet: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") continue;
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
  console.error("usage: node scripts/create-android-multisession-evidence-dir.mjs [--dir <path>] [--force] [--print-dir] [--quiet]");
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
  return [date.getFullYear(), pad(date.getMonth() + 1), pad(date.getDate()), pad(date.getHours()), pad(date.getMinutes()), pad(date.getSeconds())].join("");
}

function buildReadme(dir, files) {
  return `# Fieldwork Android Multisession Evidence

This directory is a scaffold for the Android physical release-device
multi-session no-leakage gate.

Evidence directory:

\`\`\`sh
export FW_ANDROID_MULTISESSION_DIR="${dir}"
\`\`\`

Use \`docs/ANDROID_MULTISESSION.md\` as the authoritative runbook. This
scaffold writes helper files plus a direct-adb \`preflight.sh\`.

Before pairing, capture signed release/device/package proof and clear Android
logs:

\`\`\`sh
FIELDWORK_ANDROID_AAB=apps/android/app/build/outputs/bundle/release/app-release.aab \\
"$FW_ANDROID_MULTISESSION_DIR/preflight.sh"
\`\`\`

After the physical phone is paired and the desktop-created \`fwm_a\`, \`fwm_b\`,
and \`fwm_c\` sessions exist, capture the desktop session list:

\`\`\`sh
FIELDWORK_ANDROID_MULTISESSION_CAPTURE_SESSIONS=true "$FW_ANDROID_MULTISESSION_DIR/preflight.sh"
\`\`\`

After Android has switched among the three sessions and sent the per-session
markers, capture Android UI and logs:

\`\`\`sh
FIELDWORK_ANDROID_MULTISESSION_CAPTURE_APP=true "$FW_ANDROID_MULTISESSION_DIR/preflight.sh"
\`\`\`

The helper captures \`sessions.txt\`, \`multisession.png\`,
\`multisession-ui.xml\`, \`multisession-logcat.log\`, and
\`multisession-crash.log\`. It does not create
\`multisession-a-replay.txt\`, \`multisession-b-replay.txt\`, or
\`multisession-c-replay.txt\`; those must come from real desktop \`fw attach\`
transcripts proving each selected marker is present only in its selected PTY.

After all three replay files exist, run:

\`\`\`sh
FIELDWORK_ANDROID_MULTISESSION_VERIFY=true "$FW_ANDROID_MULTISESSION_DIR/preflight.sh"
\`\`\`

If signing was captured elsewhere, pass:

\`\`\`sh
FIELDWORK_ANDROID_ARTIFACT_SIGNING_FILE=/path/to/artifact-signing.txt \\
"$FW_ANDROID_MULTISESSION_DIR/preflight.sh"
\`\`\`

Required files are listed in \`missing-files.txt\` and are derived from
\`scripts/verify-android-multisession-evidence.mjs\`.

Required file count: ${files.length}
`;
}

function buildCaptureChecklist(dir, files) {
  return `# Fieldwork Android Multisession Capture Checklist

Evidence directory:

\`\`\`sh
export FW_ANDROID_MULTISESSION_DIR="${dir}"
\`\`\`

The preflight helper uses direct \`adb\` and local \`fw\`, but it does not
create desktop sessions, switch Android sessions, type markers, or create
per-session PTY replay transcripts.

Required files:
${files.map((file) => `- \`${file}\``).join("\n")}

Commands:

\`\`\`sh
"$FW_ANDROID_MULTISESSION_DIR/preflight.sh"
# Pair Android, create fwm_a/fwm_b/fwm_c from desktop.
FIELDWORK_ANDROID_MULTISESSION_CAPTURE_SESSIONS=true "$FW_ANDROID_MULTISESSION_DIR/preflight.sh"
# Switch among fwm_a/fwm_b/fwm_c on Android and type multi_a_ok/multi_b_ok/multi_c_ok.
FIELDWORK_ANDROID_MULTISESSION_CAPTURE_APP=true "$FW_ANDROID_MULTISESSION_DIR/preflight.sh"
script -q "$FW_ANDROID_MULTISESSION_DIR/multisession-a-replay.txt" fw attach fwm_a
script -q "$FW_ANDROID_MULTISESSION_DIR/multisession-b-replay.txt" fw attach fwm_b
script -q "$FW_ANDROID_MULTISESSION_DIR/multisession-c-replay.txt" fw attach fwm_c
FIELDWORK_ANDROID_MULTISESSION_VERIFY=true "$FW_ANDROID_MULTISESSION_DIR/preflight.sh"
\`\`\`
`;
}

function buildPreflightScript() {
  return `#!/usr/bin/env bash
set -euo pipefail

evidence_dir="\${FW_ANDROID_MULTISESSION_DIR:-$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)}"
repo_root="\${FIELDWORK_REPO_ROOT:-$PWD}"
aab="\${FIELDWORK_ANDROID_AAB:-$repo_root/apps/android/app/build/outputs/bundle/release/app-release.aab}"
artifact_signing_file="\${FIELDWORK_ANDROID_ARTIFACT_SIGNING_FILE:-}"
build_config="\${FIELDWORK_ANDROID_RELEASE_BUILDCONFIG:-$repo_root/apps/android/app/build/generated/source/buildConfig/release/app/fieldwork/android/BuildConfig.java}"
fieldwork_cli="\${FIELDWORK_CLI:-fw}"
adb_serial="\${ANDROID_SERIAL:-}"
capture_sessions="\${FIELDWORK_ANDROID_MULTISESSION_CAPTURE_SESSIONS:-false}"
capture_app="\${FIELDWORK_ANDROID_MULTISESSION_CAPTURE_APP:-false}"
verify_evidence="\${FIELDWORK_ANDROID_MULTISESSION_VERIFY:-false}"

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

fw_cmd() {
  "$fieldwork_cli" "$@"
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
require_command "$fieldwork_cli"
mkdir -p "$evidence_dir"

if [[ -n "$artifact_signing_file" ]]; then
  cp "$artifact_signing_file" "$evidence_dir/artifact-signing.txt"
else
  if [[ ! -f "$aab" ]]; then
    echo "signed Android AAB is missing: $aab" >&2
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
const devices = lines.filter((line) => /\\bdevice\\b/.test(line));
if (lines.some((line) => /\\b(?:unauthorized|offline|recovery|sideload|no permissions)\\b/i.test(line))) {
  console.error("adb-devices.txt contains an unavailable Android device");
  process.exit(1);
}
if (devices.length !== 1) {
  console.error("adb-devices.txt must show exactly one authorized physical Android device, found " + devices.length);
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
require_fixed "$evidence_dir/package-info.txt" "versionName=1.0" "package-info.txt must prove versionName=1.0"
require_fixed "$evidence_dir/package-info.txt" "versionCode=1" "package-info.txt must prove versionCode=1"
if rg -q 'DEBUGGABLE|debuggable=true|android:debuggable="true"' "$evidence_dir/package-info.txt"; then
  echo "package-info.txt must not contain debuggable markers" >&2
  exit 1
fi

if [[ "$capture_sessions" == "true" ]]; then
  fw_cmd ls > "$evidence_dir/sessions.txt"
  chmod 0600 "$evidence_dir/sessions.txt"
  require_fixed "$evidence_dir/sessions.txt" "fwm_a" "sessions.txt must include fwm_a"
  require_fixed "$evidence_dir/sessions.txt" "fwm_b" "sessions.txt must include fwm_b"
  require_fixed "$evidence_dir/sessions.txt" "fwm_c" "sessions.txt must include fwm_c"
  echo "Android multisession session-list capture ok: $evidence_dir"
elif [[ "$capture_app" == "true" ]]; then
  adb_cmd exec-out screencap -p > "$evidence_dir/multisession.png"
  adb_cmd shell uiautomator dump /sdcard/fieldwork-multisession.xml >/dev/null
  adb_cmd pull /sdcard/fieldwork-multisession.xml "$evidence_dir/multisession-ui.xml" >/dev/null
  adb_cmd shell rm /sdcard/fieldwork-multisession.xml >/dev/null 2>&1 || true
  adb_cmd logcat -d > "$evidence_dir/multisession-logcat.log"
  adb_cmd logcat -d -b crash > "$evidence_dir/multisession-crash.log"
  chmod 0600 "$evidence_dir/multisession.png" "$evidence_dir/multisession-ui.xml" "$evidence_dir/multisession-logcat.log" "$evidence_dir/multisession-crash.log"
  echo "Android multisession app capture ok: $evidence_dir"
elif [[ "$verify_evidence" == "true" ]]; then
  for required in multisession-a-replay.txt multisession-b-replay.txt multisession-c-replay.txt; do
    if [[ ! -f "$evidence_dir/$required" ]]; then
      echo "$required is missing; capture the real desktop fw attach transcript first" >&2
      exit 1
    fi
  done
  node "$repo_root/scripts/verify-android-multisession-evidence.mjs" "$evidence_dir" >/dev/null
  echo "Android multisession evidence ok: $evidence_dir"
else
  adb_cmd logcat -c
  adb_cmd logcat -b crash -c
  echo "Android multisession preflight ok: $evidence_dir"
  echo "next: pair the phone, create fwm_a/fwm_b/fwm_c, capture sessions, switch Android sessions, capture app UI/logs, then add three replay files"
fi
`;
}
