# Android Session Subscription Evidence

This runbook verifies the Android side of the Section 13 desktop-created
session subscription gate with a signed release build on a physical Android
phone. It does not cover iOS, provider push delivery, store submission, npm
publish, signing setup, domains, or hosted observability accounts.

The pass condition is a session created from the desktop CLI after the phone is
already paired and watching the dashboard: `fw_live_sub` must appear on Android
in `visible_ms<=2000`, then Android must attach and send input that is visible
when the desktop reattaches to the same daemon-owned PTY.

## Scope

- Use a physical Android phone, not an emulator or AVD.
- Install the signed release App Bundle output or APKs produced from it.
- Do not use a debug build, biometric bypass, or debug pairing payload.
- Pair through the real QR scanner and explicit desktop approval before this
  gate, using the same constraints as `docs/ANDROID_PAIR_FLOW.md`.
- Capture evidence with direct `adb`: device listing, dashboard screenshot, UI
  dumps, app logcat, crash buffer, and desktop CLI/PTY transcripts.
- Mobile must not create sessions, kill sessions, or choose commands.

This is a QA-only use of USB debugging; end users do not need adb or debugging
enabled.

## Evidence Directory

```sh
export FW_ANDROID_SUBSCRIPTION_DIR="/tmp/fieldwork-android-subscription-$(date +%Y%m%d%H%M%S)"
mkdir -p "$FW_ANDROID_SUBSCRIPTION_DIR"
```

## Release Build

Verify the signed release App Bundle:

```sh
node scripts/verify-android-aab.mjs --expect-signed \
  apps/android/app/build/outputs/bundle/release/app-release.aab \
  | tee "$FW_ANDROID_SUBSCRIPTION_DIR/artifact-signing.txt"
```

The transcript must include `Android AAB ok:` and `signed release bundle ok`.

Capture the release `BuildConfig` values:

```sh
rg 'APPLICATION_ID = "app\.fieldwork\.android"|BUILD_TYPE = "release"|DEBUG = false|DEBUG = Boolean\.parseBoolean\("false"\)|FIELDWORK_BIOMETRIC_BYPASS = false|FIELDWORK_DEBUG_PAIRING_PAYLOAD = ""' \
  apps/android/app/build/generated/source/buildConfig/release/app/fieldwork/android/BuildConfig.java \
  | tee "$FW_ANDROID_SUBSCRIPTION_DIR/buildconfig.txt"
```

Capture the physical device list and install the release artifact:

```sh
adb devices -l | tee "$FW_ANDROID_SUBSCRIPTION_DIR/adb-devices.txt"
bundletool install-apks --apks /path/to/fieldwork-release.apks
adb logcat -c
adb logcat -b crash -c
```

## Pair And Prime Dashboard

Pair the physical phone through the real QR scanner and explicit desktop
approval. Unlock through BiometricPrompt if required, then leave Android on the
dashboard before creating `fw_live_sub`.

Capture the dashboard before the desktop creates the subscribed session:

```sh
adb shell uiautomator dump /sdcard/window.xml
adb pull /sdcard/window.xml "$FW_ANDROID_SUBSCRIPTION_DIR/dashboard-before-ui.xml"
```

`dashboard-before-ui.xml` must not already show `fw_live_sub`.

## Desktop-Created Session

Create the session from the desktop CLI while the phone is already on the
dashboard:

```sh
sub_start_ms="$(node -e 'console.log(Date.now())')"
script -q "$FW_ANDROID_SUBSCRIPTION_DIR/desktop-create.txt" \
  fw new --name fw_live_sub bash
```

If `fw new` attaches in the current terminal, leave it running and use another
desktop terminal for the remaining commands. The evidence must show the desktop
command `fw new --name fw_live_sub bash`; the phone must not create this
session or choose `bash`.

Once `fw_live_sub` is visible on Android, record the timing and capture the
dashboard:

```sh
sub_visible_ms="$(node -e 'console.log(Date.now())')"
printf 'created_by_desktop_cli\nvisible_ms=%s\n' "$((sub_visible_ms - sub_start_ms))" \
  | tee "$FW_ANDROID_SUBSCRIPTION_DIR/subscription-visible.txt"
adb exec-out screencap -p > "$FW_ANDROID_SUBSCRIPTION_DIR/subscription.png"
adb shell uiautomator dump /sdcard/window.xml
adb pull /sdcard/window.xml "$FW_ANDROID_SUBSCRIPTION_DIR/subscription-ui.xml"
adb logcat -d > "$FW_ANDROID_SUBSCRIPTION_DIR/subscription-logcat.log"
adb logcat -d -b crash > "$FW_ANDROID_SUBSCRIPTION_DIR/subscription-crash.log"
fw ls > "$FW_ANDROID_SUBSCRIPTION_DIR/sessions-after.txt"
```

`subscription-ui.xml` must show `fw_live_sub`, and
`subscription-visible.txt` must record `visible_ms=<elapsed-ms>` at or below
2000.

## Attach And Replay

Open `fw_live_sub` from Android. Type:

```sh
echo subscription_attach_ok
```

Capture a desktop replay of the same daemon-owned PTY:

```sh
script -q "$FW_ANDROID_SUBSCRIPTION_DIR/subscription-replay.txt" fw attach fw_live_sub
# Confirm subscription_attach_ok is visible, then detach.
```

Verify the evidence:

```sh
pnpm check:android-session-subscription-evidence -- "$FW_ANDROID_SUBSCRIPTION_DIR"
```

Passing this verifier only proves the Android release-device dashboard
subscription and attach/input path for a desktop-created session. The broader
release gates still require physical-device pair-flow, renderer, reconnect,
background/foreground, daemon-restore, biometric, provider, signing,
store-console, and operator-owned evidence.
