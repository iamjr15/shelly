# Android Pair Flow Evidence

This runbook verifies the Android side of the Section 13 pair-flow gate with a
signed release build on a physical Android phone. It does not cover iOS,
provider push delivery, store submission, npm publish, signing setup, domains,
or hosted observability accounts.

The pass condition is real pairing — either scanning the QR ticket or typing the
5-character code — plus explicit desktop approval in `pair_flow_ms<=15000`,
followed by a non-empty Android dashboard showing desktop-created sessions. This
is a QA-only use of USB debugging; end users do not need adb or debugging
enabled.

`fw pair` now prints a QR encoding the compact `fw1…` pairing ticket (which
carries both the daemon's reachability and the short code) plus the bare
5-character Crockford code for manual entry. Scanning the QR yields reachability
and the code with no typing; typing the code resolves it to the same ticket via
the relay rendezvous endpoint, which requires the app's
`BuildConfig.FIELDWORK_RELAY_CONTROL_URL` (from the `FIELDWORK_RELAY_CONTROL_URL`
environment variable at build time) to point at a reachable relay. The QR path
works with no relay hosting; the typed-code path is only exercisable once a relay
is configured. Either path ends in `PairWithCode` over iroh and explicit desktop
approval.

Latest local substitute: on 2026-05-23, direct adb emulator evidence under
`/tmp/fieldwork-adb-direct-20260523103948` paired the actual Android Pair UI to
an isolated release daemon through explicit desktop approval, showed `widget`,
`refactoringjob`, and `shell` on the dashboard, proved Android-originated shell
input with `android-direct: fw_android_live_ok` in a desktop replay, restored
the paired dashboard after app relaunch, and restored the default debug build
with `FIELDWORK_BIOMETRIC_BYPASS = false` and
`FIELDWORK_DEBUG_PAIRING_CODE = ""`. This is debug-emulator confidence only;
the release gate below still requires a physical phone, a signed release build,
and a real QR camera scan or a relay-backed manual code entry.

Fresh direct-adb refresh on 2026-05-30 retained
`/tmp/fieldwork-adb-direct-20260530042105`: the current debug app paired
through the real Pair UI and hosted relay typed-code path after explicit
desktop approval, showed desktop-created `adbpair` plus
`ANDROID_ADB_DIRECT_READY` on the dashboard, attached the live terminal, sent
`android_adb_direct_ok` from Android, and `desktop-replay.txt` confirmed the
same daemon-owned PTY replay contained `android-direct:
android_adb_direct_ok`. The run captured locked, pair, dashboard, terminal,
logcat, and crash-buffer evidence; crash buffers were empty and the emulator was
restored afterward to the default debug build with
`FIELDWORK_BIOMETRIC_BYPASS = false`, `FIELDWORK_DEBUG_PAIRING_CODE = ""`, and
an empty debug relay URL.

## Scope

- Use exactly one physical Android phone, not an emulator or AVD.
- Install the signed release App Bundle output or APKs produced from it.
- Do not use a debug build, biometric bypass, or the debug pairing code.
- Pair through the real QR scanner (or relay-backed manual code entry) and
  explicit desktop approval.
- Capture evidence with direct `adb`: device listing, installed package proof,
  dashboard screenshot, UI dump, app logcat, crash buffer, and desktop
  pairing/session transcripts.
- Evidence must contain no Android fatal/ANR logcat entries, no Android system
  not-responding overlays, and empty crash buffers after `adb logcat -c`.

## Evidence Directory

```sh
export FW_ANDROID_PAIR_DIR="/tmp/fieldwork-android-pair-$(date +%Y%m%d%H%M%S)"
pnpm scaffold:android-pair-flow-evidence -- --dir "$FW_ANDROID_PAIR_DIR"
```

The scaffold writes `README.md`, `manifest.json`, `missing-files.txt`,
`capture-checklist.md`, and a direct-adb `preflight.sh`. It preserves the human
pairing (QR scan or manual code entry) and explicit approval requirement: the
helper does not create `pairing.txt`.

Before pairing, capture signed release/device/package proof and clear Android
logs:

```sh
FIELDWORK_ANDROID_AAB=apps/android/app/build/outputs/bundle/release/app-release.aab \
"$FW_ANDROID_PAIR_DIR/preflight.sh"
```

If signing was captured elsewhere, pass the transcript:

```sh
FIELDWORK_ANDROID_ARTIFACT_SIGNING_FILE=/path/to/artifact-signing.txt \
"$FW_ANDROID_PAIR_DIR/preflight.sh"
```

After Android shows the paired dashboard, rerun the helper to collect dashboard
screenshot/UI, `fw devices`, `fw ls`, logcat, crash buffer, and to run the
verifier:

```sh
FIELDWORK_ANDROID_PAIR_CAPTURE_DASHBOARD=true \
"$FW_ANDROID_PAIR_DIR/preflight.sh"
```

## Release Build

Verify the signed release App Bundle:

```sh
node scripts/verify-android-aab.mjs --expect-signed --expect-relay-control-url \
  apps/android/app/build/outputs/bundle/release/app-release.aab \
  | tee "$FW_ANDROID_PAIR_DIR/artifact-signing.txt"
```

The transcript must include `Android AAB ok:`, `signed release bundle ok`, and
`release relay control URL ok`.

Capture the release `BuildConfig` values:

```sh
rg 'APPLICATION_ID = "app\.fieldwork\.android"|BUILD_TYPE = "release"|DEBUG = false|DEBUG = Boolean\.parseBoolean\("false"\)|FIELDWORK_BIOMETRIC_BYPASS = false|FIELDWORK_DEBUG_PAIRING_CODE = ""|FIELDWORK_RELAY_CONTROL_URL = "https://' \
  apps/android/app/build/generated/source/buildConfig/release/app/fieldwork/android/BuildConfig.java \
  | tee "$FW_ANDROID_PAIR_DIR/buildconfig.txt"
```

Capture the physical device list and install the release artifact:

```sh
adb devices -l | tee "$FW_ANDROID_PAIR_DIR/adb-devices.txt"
bundletool install-apks --apks /path/to/fieldwork-release.apks
{
  echo '$ adb shell pm path app.fieldwork.android'
  adb shell pm path app.fieldwork.android
  echo '$ adb shell dumpsys package app.fieldwork.android'
  adb shell dumpsys package app.fieldwork.android
} | tee "$FW_ANDROID_PAIR_DIR/package-info.txt"
adb logcat -c
adb logcat -b crash -c
```

`package-info.txt` must prove the installed release package is
`app.fieldwork.android` with `versionName=1.0`, `versionCode=1`, and no `DEBUGGABLE` or `debuggable=true` markers.

## Desktop Sessions

Start the desktop daemon and create sessions before pairing:

```sh
fw daemon start
fw refactoringjob
fw new --name shell bash
fw ls | tee "$FW_ANDROID_PAIR_DIR/sessions.txt"
```

`sessions.txt` must include `refactoringjob` with the default `claude` command
and a desktop-created `shell`/`bash` session.

## Pairing (scan QR or type code)

Start the desktop pairing prompt and preserve the transcript:

```sh
pair_start_ms="$(node -e 'console.log(Date.now())')"
script -q "$FW_ANDROID_PAIR_DIR/pairing.txt" fw pair
```

Pair the Android app one of two ways:

- **Scan**: point the real camera flow at the displayed QR, which encodes the
  compact `fw1…` pairing ticket (reachability plus the code).
- **Type**: enter the 5-character Crockford code printed alongside the QR into
  the app's manual-entry field. This requires the app's
  `BuildConfig.FIELDWORK_RELAY_CONTROL_URL` to point at a reachable relay so the
  app can resolve the code to the ticket; without a hosted relay, use the scan
  path.

Approve the desktop prompt by typing `y` only after the phone pairing attempt
appears. Append the timing:

```sh
pair_end_ms="$(node -e 'console.log(Date.now())')"
printf 'pair_flow_ms=%s\n' "$((pair_end_ms - pair_start_ms))" \
  >> "$FW_ANDROID_PAIR_DIR/pairing.txt"
```

The transcript must include:

- `Scan the QR with the Fieldwork app — or enter this code:`, the printed
  5-character code, and `Expires in 10 minutes.`;
- `Pair request from device`;
- `approve? [y/N]`;
- `Approved. Device is paired.`;
- `pair_flow_ms=<elapsed-ms>` at or below 15000.

Do not use `FIELDWORK_DEBUG_PAIRING_CODE`.

## Dashboard Evidence

Unlock through BiometricPrompt if required. Capture the Android dashboard after
pairing:

```sh
adb exec-out screencap -p > "$FW_ANDROID_PAIR_DIR/dashboard.png"
adb shell uiautomator dump /sdcard/window.xml
adb pull /sdcard/window.xml "$FW_ANDROID_PAIR_DIR/dashboard-ui.xml"
fw devices > "$FW_ANDROID_PAIR_DIR/devices.txt"
adb logcat -d > "$FW_ANDROID_PAIR_DIR/logcat.log"
adb logcat -d -b crash > "$FW_ANDROID_PAIR_DIR/crash.log"
```

The dashboard must not show `No sessions`; it must show `refactoringjob` and a
desktop-created `shell`/`bash` session. `logcat.log` must show
`FieldworkRepository: pair completed` and
`FieldworkRepository: listSessions returned <n> sessions`.

Verify the evidence:

```sh
pnpm check:android-pair-flow-evidence -- "$FW_ANDROID_PAIR_DIR"
```

Passing this verifier only proves the Android release-device pair (QR scan or
relay-backed code entry) and dashboard path. The broader release gates still
require other physical-device timing, renderer, provider, signing,
store-console, and operator-owned evidence.
