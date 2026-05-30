#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const verifier = path.join(root, "scripts/verify-android-release-install-evidence.mjs");
const generatedFiles = ["README.md", "manifest.json", "missing-files.txt", "capture-checklist.md", "preflight.sh"];

const options = parseArgs(process.argv.slice(2));
const evidenceRoot = path.resolve(options.dir ?? path.join("/tmp", `fieldwork-android-release-install-${timestampForDir(new Date())}`));
const apksDir = path.join(evidenceRoot, "apks");
const installDir = path.join(evidenceRoot, "install");
const required = readRequiredFiles();

if (fs.existsSync(evidenceRoot)) {
  const existing = fs.readdirSync(evidenceRoot);
  if (existing.length > 0 && !options.force) {
    console.error(`evidence directory is not empty: ${evidenceRoot}`);
    console.error("rerun with --force to refresh scaffold files without deleting captured evidence");
    process.exit(1);
  }
} else {
  fs.mkdirSync(evidenceRoot, { recursive: true, mode: 0o700 });
}
fs.mkdirSync(apksDir, { recursive: true, mode: 0o700 });
fs.mkdirSync(installDir, { recursive: true, mode: 0o700 });

const manifest = {
  schema: "fieldwork-android-release-install-evidence-v1",
  createdAt: new Date().toISOString(),
  evidenceRoot,
  apksDir,
  installDir,
  verifier: path.relative(root, verifier),
  apksRequiredFiles: required.apks,
  installRequiredFiles: required.install,
  generatedFiles,
  note: "This scaffold captures local Android release-install smoke evidence from the current release AAB, bundletool, an ephemeral non-debug signer, and direct adb install/locked-launch output. It is a local substitute only; Play signing and physical release-device gates remain separate.",
};

writeFile("manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
writeFile("missing-files.txt", `${prefixedRequiredFiles(required).join("\n")}\n`);
writeFile("capture-checklist.md", buildCaptureChecklist(evidenceRoot, required));
writeFile("README.md", buildReadme(evidenceRoot, required));
writeFile("preflight.sh", buildPreflightScript(), 0o700);

if (options.printDir) {
  process.stdout.write(`${evidenceRoot}\n`);
} else if (!options.quiet) {
  console.log(`Android release-install evidence scaffold created: ${evidenceRoot}`);
  console.log(`APKS evidence dir: ${apksDir}`);
  console.log(`install evidence dir: ${installDir}`);
  console.log(`next: ${evidenceRoot}/preflight.sh`);
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
  console.error("usage: node scripts/create-android-release-install-evidence-dir.mjs [--dir <path>] [--force] [--print-dir] [--quiet]");
}

function readRequiredFiles() {
  const source = fs.readFileSync(verifier, "utf8");
  const apks = readArrayLiteral(source, "apksRequiredFiles");
  const install = readArrayLiteral(source, "installRequiredFiles");
  if (apks.length === 0 || install.length === 0) {
    console.error(`required file arrays in ${verifier} must not be empty`);
    process.exit(1);
  }
  return { apks, install };
}

function readArrayLiteral(source, name) {
  const match = source.match(new RegExp(`const\\s+${name}\\s*=\\s*\\[(?<body>[\\s\\S]*?)\\];`));
  if (!match?.groups?.body) {
    console.error(`cannot locate ${name} in ${verifier}`);
    process.exit(1);
  }
  return [...match.groups.body.matchAll(/"([^"\n]+)"/g)].map((fileMatch) => fileMatch[1]);
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

function prefixedRequiredFiles(files) {
  return [
    ...files.apks.map((file) => `apks/${file}`),
    ...files.install.map((file) => `install/${file}`),
  ];
}

function buildReadme(dir, files) {
  return `# Fieldwork Android Release-Install Evidence

This directory is a scaffold for the local Android release-install smoke. It
does not replace Play signing, Play internal-track upload, FCM provider testing,
or physical release-device gates. The production Android release evidence pack
runs the same verifier with \`--strict-release-device\`, which rejects emulator
evidence and the local ephemeral \`Fieldwork Release Smoke\` certificate.

Evidence root:

\`\`\`sh
export FW_ANDROID_RELEASE_INSTALL_DIR="${dir}"
\`\`\`

The generated \`preflight.sh\` converts the current release AAB into a universal
APK with \`bundletool-all-1.18.3\`, signs it with an ephemeral non-debug
\`CN=Fieldwork Release Smoke\` certificate, captures \`apksigner\`/\`aapt\`
metadata, installs the APK with direct \`adb\`, cold-launches the locked app, and
runs the verifier.

Run from the repository root with Android SDK build-tools, \`adb\`,
\`bundletool-all-1.18.3.jar\`, Java, and exactly one authorized adb target:

\`\`\`sh
FIELDWORK_ANDROID_AAB=apps/android/app/build/outputs/bundle/release/app-release.aab \\
FIELDWORK_BUNDLETOOL_JAR=/tmp/fieldwork-tools/bundletool-all-1.18.3.jar \\
"$FW_ANDROID_RELEASE_INSTALL_DIR/preflight.sh"
\`\`\`

The APKS evidence directory is \`${path.join(dir, "apks")}\`.
The install evidence directory is \`${path.join(dir, "install")}\`.

After capture, rerun:

\`\`\`sh
pnpm check:android-release-install-evidence -- \\
  "${path.join(dir, "apks")}" \\
  "${path.join(dir, "install")}"
\`\`\`

For operator-signed physical-device evidence, populate the same files from the
real release signer and a physical phone, then run:

\`\`\`sh
pnpm check:android-release-install-evidence -- --strict-release-device \\
  "${path.join(dir, "apks")}" \\
  "${path.join(dir, "install")}"
\`\`\`

Required files:

${prefixedRequiredFiles(files).map((file) => `- \`${file}\``).join("\n")}
`;
}

function buildCaptureChecklist(dir, files) {
  return `# Android Release-Install Capture Checklist

Evidence root:

\`\`\`sh
export FW_ANDROID_RELEASE_INSTALL_DIR="${dir}"
\`\`\`

## APKS Metadata

These files are written under \`apks/\` by \`preflight.sh\`:

${files.apks.map((file) => `- [ ] \`apks/${file}\``).join("\n")}

The helper runs:

\`\`\`sh
keytool -genkeypair ... -dname "CN=Fieldwork Release Smoke,O=Fieldwork,L=Local,ST=Local,C=US"
java -jar "$FIELDWORK_BUNDLETOOL_JAR" build-apks --mode=universal ...
unzip -oq "$apks" universal.apk -d "$apks_dir/apks"
apksigner verify --verbose --print-certs "$universal_apk"
aapt dump badging "$universal_apk"
aapt dump permissions "$universal_apk"
aapt dump xmltree "$universal_apk" AndroidManifest.xml
\`\`\`

## Direct ADB Install And Locked Launch

These files are written under \`install/\` by \`preflight.sh\`:

${files.install.map((file) => `- [ ] \`install/${file}\``).join("\n")}

The helper runs:

\`\`\`sh
adb devices -l
adb install -r "$universal_apk"
adb shell pm path app.fieldwork.android
adb shell dumpsys package app.fieldwork.android
adb shell run-as app.fieldwork.android true
adb shell cmd package resolve-activity --brief app.fieldwork.android
adb shell am force-stop app.fieldwork.android
adb logcat -c
adb shell am start -W -n app.fieldwork.android/.MainActivity
adb exec-out screencap -p > "$install_dir/locked.png"
adb shell uiautomator dump /sdcard/window.xml
adb pull /sdcard/window.xml "$install_dir/locked-ui.xml"
adb logcat -d > "$install_dir/logcat.log"
adb logcat -d -b crash > "$install_dir/crash.log"
\`\`\`

## Verify

\`\`\`sh
pnpm check:android-release-install-evidence -- \\
  "$FW_ANDROID_RELEASE_INSTALL_DIR/apks" \\
  "$FW_ANDROID_RELEASE_INSTALL_DIR/install"
\`\`\`
`;
}

function buildPreflightScript() {
  return `#!/usr/bin/env bash
set -euo pipefail

evidence_root="\${FW_ANDROID_RELEASE_INSTALL_DIR:-$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)}"
repo_root="\${FIELDWORK_REPO_ROOT:-$PWD}"
apks_dir="$evidence_root/apks"
install_dir="$evidence_root/install"
aab="\${FIELDWORK_ANDROID_AAB:-$repo_root/apps/android/app/build/outputs/bundle/release/app-release.aab}"
bundletool="\${FIELDWORK_BUNDLETOOL_JAR:-/tmp/fieldwork-tools/bundletool-all-1.18.3.jar}"
apks="$apks_dir/fieldwork-release-universal.apks"
apk_extract_dir="$apks_dir/apks"
universal_apk="$apk_extract_dir/universal.apk"
keystore="$apks_dir/release-smoke.jks"
storepass="\${FIELDWORK_RELEASE_SMOKE_STOREPASS:-fieldwork-release-smoke-store}"
keypass="\${FIELDWORK_RELEASE_SMOKE_KEYPASS:-fieldwork-release-smoke-key}"
alias_name="fieldwork-release-smoke"

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "$1 is required" >&2
    exit 127
  fi
}

find_android_tool() {
  local tool="$1"
  local sdk="\${ANDROID_HOME:-\${ANDROID_SDK_ROOT:-}}"
  if [[ -z "$sdk" ]]; then
    echo "ANDROID_HOME or ANDROID_SDK_ROOT must point at the Android SDK" >&2
    exit 1
  fi
  local found
  found="$(find "$sdk/build-tools" -type f -name "$tool" 2>/dev/null | sort | tail -n 1 || true)"
  if [[ -z "$found" ]]; then
    echo "could not find $tool under $sdk/build-tools" >&2
    exit 1
  fi
  printf '%s\\n' "$found"
}

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$@"
  else
    shasum -a 256 "$@"
  fi
}

require_command adb
require_command java
require_command keytool
require_command unzip
require_command sort
require_command tail
require_command find
require_command grep
require_command tee

if [[ ! -f "$aab" ]]; then
  echo "missing Android release AAB: $aab" >&2
  echo "run apps/android/gradlew --no-daemon bundleRelease first" >&2
  exit 1
fi
if [[ ! -f "$bundletool" ]]; then
  echo "missing bundletool jar: $bundletool" >&2
  echo "download bundletool-all-1.18.3.jar and set FIELDWORK_BUNDLETOOL_JAR if needed" >&2
  exit 1
fi

apksigner="$(find_android_tool apksigner)"
aapt="$(find_android_tool aapt)"

mkdir -p "$apks_dir" "$install_dir" "$apk_extract_dir"
rm -f "$apks" "$universal_apk" "$keystore"

keytool -genkeypair \\
  -keystore "$keystore" \\
  -storepass "$storepass" \\
  -keypass "$keypass" \\
  -alias "$alias_name" \\
  -keyalg RSA \\
  -keysize 4096 \\
  -validity 30 \\
  -dname "CN=Fieldwork Release Smoke,O=Fieldwork,L=Local,ST=Local,C=US" \\
  -noprompt >/dev/null

java -jar "$bundletool" build-apks \\
  --bundle="$aab" \\
  --output="$apks" \\
  --mode=universal \\
  --ks="$keystore" \\
  --ks-key-alias="$alias_name" \\
  --ks-pass="pass:$storepass" \\
  --key-pass="pass:$keypass"

unzip -oq "$apks" universal.apk -d "$apk_extract_dir"

{
  echo "bundletool=$bundletool"
  echo "aab=$aab"
  echo "apks=$apks"
  echo "universal_apk=$universal_apk"
} > "$apks_dir/summary.txt"

"$apksigner" verify --verbose --print-certs "$universal_apk" > "$apks_dir/apksigner-universal.txt"
"$aapt" dump badging "$universal_apk" > "$apks_dir/aapt-badging.txt"
"$aapt" dump permissions "$universal_apk" > "$apks_dir/aapt-permissions.txt"
"$aapt" dump xmltree "$universal_apk" AndroidManifest.xml > "$apks_dir/aapt-manifest-tree.txt"
sha256_file "$apks" "$universal_apk" > "$apks_dir/sha256.txt"

adb devices -l | tee "$install_dir/adb-devices.txt"
if grep -Eiq '\\b(unauthorized|offline|no permissions)\\b' "$install_dir/adb-devices.txt"; then
  echo "adb target is unauthorized, offline, or inaccessible" >&2
  exit 1
fi
authorized_count="$(awk 'NR > 1 && $2 == "device" { count += 1 } END { print count + 0 }' "$install_dir/adb-devices.txt")"
if [[ "$authorized_count" -ne 1 ]]; then
  echo "expected exactly one authorized adb target, found $authorized_count" >&2
  exit 1
fi

adb install -r "$universal_apk" 2>&1 | tee "$install_dir/install.txt"
adb shell pm path app.fieldwork.android | tee "$install_dir/pm-path.txt"
adb shell dumpsys package app.fieldwork.android | tee "$install_dir/package-info.txt"
set +e
adb shell run-as app.fieldwork.android true > "$install_dir/run-as.txt" 2>&1
set -e
adb shell cmd package resolve-activity --brief app.fieldwork.android | tee "$install_dir/resolve-activity.txt"
adb shell am force-stop app.fieldwork.android
adb logcat -c
adb shell am start -W -n app.fieldwork.android/.MainActivity | tee "$install_dir/launch.txt"
adb exec-out screencap -p > "$install_dir/locked.png"
adb shell uiautomator dump /sdcard/window.xml >/dev/null
adb pull /sdcard/window.xml "$install_dir/locked-ui.xml" >/dev/null
adb logcat -d > "$install_dir/logcat.log"
adb logcat -d -b crash > "$install_dir/crash.log"
sha256_file "$universal_apk" "$install_dir/locked.png" > "$install_dir/sha256.txt"

node "$repo_root/scripts/verify-android-release-install-evidence.mjs" "$apks_dir" "$install_dir"
`;
}
