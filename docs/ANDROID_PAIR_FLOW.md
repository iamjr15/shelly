# Android Pair Flow Evidence

This runbook verifies the Android side of the Section 13 pair-flow gate with a
signed release build on a physical Android phone. It does not cover iOS,
provider push delivery, store submission, npm publish, signing setup, domains,
or hosted observability accounts.

The pass condition is real QR pairing plus explicit desktop approval in
`pair_flow_ms<=15000`, followed by a non-empty Android dashboard showing
desktop-created sessions. This is a QA-only use of USB debugging; end users do
not need adb or debugging enabled.

Latest local substitute: on 2026-05-23, direct adb emulator evidence under
`/tmp/fieldwork-adb-direct-20260523103948` paired the actual Android Pair UI to
an isolated release daemon through explicit desktop approval, showed `widget`,
`refactoringjob`, and `shell` on the dashboard, proved Android-originated shell
input with `android-direct: fw_android_live_ok` in a desktop replay, restored
the paired dashboard after app relaunch, and restored the default debug build
with `FIELDWORK_BIOMETRIC_BYPASS = false` and
`FIELDWORK_DEBUG_PAIRING_PAYLOAD = ""`. This is debug-emulator confidence only;
the release gate below still requires a physical phone, a signed release build,
and the real QR camera scan.

## Scope

- Use a physical Android phone, not an emulator or AVD.
- Install the signed release App Bundle output or APKs produced from it.
- Do not use a debug build, biometric bypass, or debug pairing payload.
- Pair through the real QR scanner and explicit desktop approval.
- Capture evidence with direct `adb`: device listing, dashboard screenshot, UI
  dump, app logcat, crash buffer, and desktop pairing/session transcripts.

## Evidence Directory

```sh
export FW_ANDROID_PAIR_DIR="/tmp/fieldwork-android-pair-$(date +%Y%m%d%H%M%S)"
mkdir -p "$FW_ANDROID_PAIR_DIR"
```

## Release Build

Verify the signed release App Bundle:

```sh
node scripts/verify-android-aab.mjs --expect-signed \
  apps/android/app/build/outputs/bundle/release/app-release.aab \
  | tee "$FW_ANDROID_PAIR_DIR/artifact-signing.txt"
```

The transcript must include `Android AAB ok:` and `signed release bundle ok`.

Capture the release `BuildConfig` values:

```sh
rg 'APPLICATION_ID = "app\.fieldwork\.android"|BUILD_TYPE = "release"|DEBUG = false|DEBUG = Boolean\.parseBoolean\("false"\)|FIELDWORK_BIOMETRIC_BYPASS = false|FIELDWORK_DEBUG_PAIRING_PAYLOAD = ""' \
  apps/android/app/build/generated/source/buildConfig/release/app/fieldwork/android/BuildConfig.java \
  | tee "$FW_ANDROID_PAIR_DIR/buildconfig.txt"
```

Capture the physical device list and install the release artifact:

```sh
adb devices -l | tee "$FW_ANDROID_PAIR_DIR/adb-devices.txt"
bundletool install-apks --apks /path/to/fieldwork-release.apks
adb logcat -c
adb logcat -b crash -c
```

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

## QR Pairing

Start the desktop pairing prompt and preserve the transcript:

```sh
pair_start_ms="$(node -e 'console.log(Date.now())')"
script -q "$FW_ANDROID_PAIR_DIR/pairing.txt" fw pair
```

Scan the displayed QR code in the Android app with the real camera flow. Approve
the desktop prompt by typing `y` only after the phone scan appears. Append the
timing:

```sh
pair_end_ms="$(node -e 'console.log(Date.now())')"
printf 'pair_flow_ms=%s\n' "$((pair_end_ms - pair_start_ms))" \
  >> "$FW_ANDROID_PAIR_DIR/pairing.txt"
```

The transcript must include:

- the JSON QR payload with `"pair_token"`;
- `Waiting for a device to scan`;
- `Pair request from device`;
- `approve? [y/N]`;
- `Approved. Device is paired.`;
- `pair_flow_ms=<elapsed-ms>` at or below 15000.

Do not use `FIELDWORK_DEBUG_PAIRING_PAYLOAD`.

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

Passing this verifier only proves the Android release-device QR pair and
dashboard path. The broader release gates still require other physical-device
timing, renderer, provider, signing, store-console, and operator-owned evidence.
