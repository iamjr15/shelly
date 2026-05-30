# Android Biometric Evidence

This runbook verifies the Android side of the Section 13 biometric gate with a
signed release build on a physical Android phone. It does not cover iOS,
provider push delivery, store submission, npm publish, signing setup, domains,
or hosted observability accounts.

The pass condition is a paired release app that gates session access behind
Android BiometricPrompt on launch and again after at least five minutes in the
background. Locked and prompt surfaces must not expose session, terminal,
command, or push-token activity, and stale terminal input before unlock must be
blocked.

## Scope

- Use exactly one physical Android phone with biometrics enrolled, not an emulator or
  AVD.
- Install the signed release App Bundle output or APKs produced from it.
- Do not use a debug build, biometric bypass, or debug pairing code.
- Pair through the real QR scanner and explicit desktop approval before this
  gate, using the same constraints as `docs/ANDROID_PAIR_FLOW.md`.
- Capture evidence with direct `adb`: device listing, locked and biometric
  screenshots, UI dumps, app logcat, crash buffers, and a stale-input transcript.
- Evidence must contain no Android fatal/ANR logcat entries, no Android system
  not-responding overlays, and empty crash buffers after `adb logcat -c`.

This is a QA-only use of USB debugging; end users do not need adb or debugging
enabled.

## Evidence Directory

```sh
export FW_ANDROID_BIOMETRIC_DIR="/tmp/fieldwork-android-biometric-$(date +%Y%m%d%H%M%S)"
pnpm scaffold:android-biometric-evidence -- --dir "$FW_ANDROID_BIOMETRIC_DIR"
```

The scaffold writes `README.md`, `manifest.json`, `missing-files.txt`,
`capture-checklist.md`, and a direct-adb `preflight.sh`. It captures
release/device/package proof plus locked launch, biometric prompt, stale
biometric prompt, logcat, and crash-buffer evidence; it does not create desktop
sessions, pair devices, complete biometric authentication, or create
`stale-biometric.txt`.

Before pairing or biometric testing, capture release/device/package proof and
clear Android logs:

```sh
FIELDWORK_ANDROID_AAB=apps/android/app/build/outputs/bundle/release/app-release.aab \
"$FW_ANDROID_BIOMETRIC_DIR/preflight.sh"
```

After pairing, seeding desktop sessions, and reaching each Android biometric
stage, use the helper capture modes:

```sh
FIELDWORK_ANDROID_BIOMETRIC_CAPTURE_LOCKED=true "$FW_ANDROID_BIOMETRIC_DIR/preflight.sh"
FIELDWORK_ANDROID_BIOMETRIC_CAPTURE_PROMPT=true "$FW_ANDROID_BIOMETRIC_DIR/preflight.sh"
FIELDWORK_ANDROID_BIOMETRIC_CAPTURE_STALE=true "$FW_ANDROID_BIOMETRIC_DIR/preflight.sh"
```

After `stale-biometric.txt` is captured from the real stale-input blocking
test, run the helper verifier:

```sh
FIELDWORK_ANDROID_BIOMETRIC_VERIFY=true "$FW_ANDROID_BIOMETRIC_DIR/preflight.sh"
```

## Release Build

Verify the signed release App Bundle:

```sh
node scripts/verify-android-aab.mjs --expect-signed \
  apps/android/app/build/outputs/bundle/release/app-release.aab \
  | tee "$FW_ANDROID_BIOMETRIC_DIR/artifact-signing.txt"
```

The transcript must include `Android AAB ok:` and `signed release bundle ok`.

Capture the release `BuildConfig` values:

```sh
rg 'APPLICATION_ID = "app\.fieldwork\.android"|BUILD_TYPE = "release"|DEBUG = false|DEBUG = Boolean\.parseBoolean\("false"\)|FIELDWORK_BIOMETRIC_BYPASS = false|FIELDWORK_DEBUG_PAIRING_CODE = ""' \
  apps/android/app/build/generated/source/buildConfig/release/app/fieldwork/android/BuildConfig.java \
  | tee "$FW_ANDROID_BIOMETRIC_DIR/buildconfig.txt"
```

Capture the physical device list and install the release artifact:

```sh
adb devices -l | tee "$FW_ANDROID_BIOMETRIC_DIR/adb-devices.txt"
bundletool install-apks --apks /path/to/fieldwork-release.apks
{
  echo '$ adb shell pm path app.fieldwork.android'
  adb shell pm path app.fieldwork.android
  echo '$ adb shell dumpsys package app.fieldwork.android'
  adb shell dumpsys package app.fieldwork.android
} | tee "$FW_ANDROID_BIOMETRIC_DIR/package-info.txt"
adb logcat -c
adb logcat -b crash -c
```
`package-info.txt` must prove the installed app is `app.fieldwork.android` with
`versionName=1.0`, `versionCode=1`, and no `DEBUGGABLE` or `debuggable=true` markers.


## Pair And Seed Sessions

Pair the physical phone through the real QR scanner and explicit desktop
approval. Create at least one desktop-owned session that would be visible after
unlock:

```sh
fw daemon start
fw refactoringjob
fw new --name shell bash
fw ls > "$FW_ANDROID_BIOMETRIC_DIR/sessions.txt"
fw devices > "$FW_ANDROID_BIOMETRIC_DIR/devices.txt"
```

`sessions.txt` must include `refactoringjob`/`claude` and a shell/bash session.
`devices.txt` must show the paired Android device.

## Locked Launch And Prompt

Force-stop and relaunch the app. The launch should show only the locked
`Unlock` surface; it must not fetch sessions, attach terminals, register push
tokens, or send input before unlock:

```sh
adb shell am force-stop app.fieldwork.android
adb logcat -c
adb logcat -b crash -c
adb shell am start -W -n app.fieldwork.android/.MainActivity | tee "$FW_ANDROID_BIOMETRIC_DIR/launch.txt"
adb exec-out screencap -p > "$FW_ANDROID_BIOMETRIC_DIR/locked.png"
adb shell uiautomator dump /sdcard/window.xml
adb pull /sdcard/window.xml "$FW_ANDROID_BIOMETRIC_DIR/locked-ui.xml"
adb logcat -d > "$FW_ANDROID_BIOMETRIC_DIR/locked-logcat.log"
adb logcat -d -b crash > "$FW_ANDROID_BIOMETRIC_DIR/locked-crash.log"
```

Tap `Unlock`, but hold the phone so biometric authentication does not complete
yet. Capture the Android BiometricPrompt before any session list or terminal
content appears:

```sh
adb exec-out screencap -p > "$FW_ANDROID_BIOMETRIC_DIR/biometric.png"
adb shell uiautomator dump /sdcard/window.xml
adb pull /sdcard/window.xml "$FW_ANDROID_BIOMETRIC_DIR/biometric-ui.xml"
adb logcat -d > "$FW_ANDROID_BIOMETRIC_DIR/biometric-logcat.log"
adb logcat -d -b crash > "$FW_ANDROID_BIOMETRIC_DIR/biometric-crash.log"
```

## Stale Resume Prompt

Complete biometric unlock, open a terminal session, then background the app for
at least five minutes. Foreground the app and tap `Unlock`, again holding the
phone so biometric authentication does not complete yet. Try stale terminal
input before unlock and verify the input is blocked:

```sh
stale_start_ms="$(node -e 'console.log(Date.now())')"
adb shell input keyevent KEYCODE_HOME
sleep 300
adb shell am start -W -n app.fieldwork.android/.MainActivity
# Tap Unlock, hold the biometric prompt open, and try stale terminal input.
stale_end_ms="$(node -e 'console.log(Date.now())')"
{
  printf 'stale_background_ms=%s\n' "$((stale_end_ms - stale_start_ms))"
  printf 'stale_input_before_unlock_blocked\n'
} | tee "$FW_ANDROID_BIOMETRIC_DIR/stale-biometric.txt"
adb exec-out screencap -p > "$FW_ANDROID_BIOMETRIC_DIR/stale-biometric.png"
adb shell uiautomator dump /sdcard/window.xml
adb pull /sdcard/window.xml "$FW_ANDROID_BIOMETRIC_DIR/stale-biometric-ui.xml"
adb logcat -d > "$FW_ANDROID_BIOMETRIC_DIR/stale-biometric-logcat.log"
adb logcat -d -b crash > "$FW_ANDROID_BIOMETRIC_DIR/stale-biometric-crash.log"
```

`stale-biometric.txt` must record `stale_background_ms=<elapsed-ms>` at or
above 300000 and `stale_input_before_unlock_blocked`. It must not contain
`stale_input_before_unlock_sent` or `stale_input_before_unlock_visible`.

Verify the evidence:

```sh
pnpm check:android-biometric-evidence -- "$FW_ANDROID_BIOMETRIC_DIR"
```

Passing this verifier only proves the Android release-device biometric prompt
and stale-input gate. The broader release gates still require physical-device
pair-flow, renderer, reconnect, background/foreground, daemon-restore,
provider, signing, store-console, and operator-owned evidence.
