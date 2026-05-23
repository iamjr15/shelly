# Android Background/Foreground Evidence

This runbook verifies the Android side of the Section 13
`Background -> Foreground` survival gate with a signed release build on a
physical Android phone. It does not cover iOS, APNs/FCM provider delivery,
store submission, npm publish, signing setup, domains, or hosted observability
accounts.

The pass condition is the same daemon-owned PTY session surviving app
backgrounding: the Android app is attached, the app is backgrounded while the
PTY emits output, the app foregrounds back to the attached terminal, and
Android-originated input after foregrounding is visible when the desktop
reattaches.

## Scope

- Use exactly one physical Android phone, not an emulator or AVD.
- Install the signed release App Bundle output or APKs produced from it.
- Do not use a debug build, biometric bypass, or debug pairing payload.
- Pair through the real QR scanner and explicit desktop approval.
- Capture evidence with direct `adb`: device listing, screenshots, UI dumps,
  background state, app logcat, crash buffer, and desktop PTY replay.
- Evidence must contain no Android fatal/ANR logcat entries, no Android system
  not-responding overlays, and empty crash buffers after `adb logcat -c`.

## Evidence Directory

```sh
export FW_ANDROID_BG_DIR="/tmp/fieldwork-android-background-$(date +%Y%m%d%H%M%S)"
mkdir -p "$FW_ANDROID_BG_DIR"
```

## Release Build

Verify the signed release App Bundle:

```sh
node scripts/verify-android-aab.mjs --expect-signed \
  apps/android/app/build/outputs/bundle/release/app-release.aab \
  | tee "$FW_ANDROID_BG_DIR/artifact-signing.txt"
```

The transcript must include `Android AAB ok:` and `signed release bundle ok`.

Capture the release `BuildConfig` values:

```sh
rg 'APPLICATION_ID = "app\.fieldwork\.android"|BUILD_TYPE = "release"|DEBUG = false|DEBUG = Boolean\.parseBoolean\("false"\)|FIELDWORK_BIOMETRIC_BYPASS = false|FIELDWORK_DEBUG_PAIRING_PAYLOAD = ""' \
  apps/android/app/build/generated/source/buildConfig/release/app/fieldwork/android/BuildConfig.java \
  | tee "$FW_ANDROID_BG_DIR/buildconfig.txt"
```

Capture the physical device list and install the release artifact:

```sh
adb devices -l | tee "$FW_ANDROID_BG_DIR/adb-devices.txt"
bundletool install-apks --apks /path/to/fieldwork-release.apks
adb logcat -c
adb logcat -b crash -c
```

## Pair And Attach

Start the desktop daemon and create a desktop-owned background test session:

```sh
fw daemon start
fw new --name fw_background_session bash
```

In that session, run:

```sh
printf 'ANDROID_BACKGROUND_READY\n'
while IFS= read -r line; do
  printf 'android-background: %s\n' "$line"
  if [ "$line" = "trigger_background_output" ]; then
    ( sleep 3; printf 'ANDROID_BACKGROUND_REPLAY_OUTPUT\n' ) &
  fi
done
```

Pair the physical phone through the real QR scanner and explicit desktop
approval. Attach `fw_background_session` from Android.

Capture the attached terminal before backgrounding:

```sh
adb exec-out screencap -p > "$FW_ANDROID_BG_DIR/attached-before.png"
adb shell uiautomator dump /sdcard/window.xml
adb pull /sdcard/window.xml "$FW_ANDROID_BG_DIR/attached-before-ui.xml"
```

## Background, Emit Output, Foreground

From Android, type `trigger_background_output` and press Enter. Immediately
background the app with direct `adb`:

```sh
backgrounded_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
background_start_ms="$(node -e 'console.log(Date.now())')"
adb shell input keyevent KEYCODE_HOME
sleep 4
background_top_package="$(adb shell dumpsys window | rg -m1 'mCurrentFocus|mFocusedApp' || true)"
{
  printf 'background_command=adb shell input keyevent KEYCODE_HOME\n'
  printf 'background_top_package=%s\n' "$background_top_package"
  printf 'app_backgrounded_ok\n'
} | tee "$FW_ANDROID_BG_DIR/background-state.txt"
```

Before foregrounding Fieldwork, prove the desktop can replay the output emitted
while Android was backgrounded:

```sh
script -q "$FW_ANDROID_BG_DIR/background-output-replay.txt" fw attach fw_background_session
# Confirm ANDROID_BACKGROUND_READY and ANDROID_BACKGROUND_REPLAY_OUTPUT are visible, then detach.
```

Foreground the Android app and wait for the attached terminal to return:

```sh
foreground_start_ms="$(node -e 'console.log(Date.now())')"
adb shell monkey -p app.fieldwork.android 1
# Unlock with BiometricPrompt if required.
# Stop the timer once the terminal is visibly attached again.
foreground_end_ms="$(node -e 'console.log(Date.now())')"
foregrounded_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
```

Capture the reattached terminal and type `after_background_ok` from Android:

```sh
adb exec-out screencap -p > "$FW_ANDROID_BG_DIR/attached-after.png"
adb shell uiautomator dump /sdcard/window.xml
adb pull /sdcard/window.xml "$FW_ANDROID_BG_DIR/attached-after-ui.xml"
```

Then capture a desktop replay of the same PTY:

```sh
script -q "$FW_ANDROID_BG_DIR/post-foreground-replay.txt" fw attach fw_background_session
# Confirm ANDROID_BACKGROUND_REPLAY_OUTPUT, after_background_ok, and
# android-background: after_background_ok are visible, then detach.
```

Record timing:

```sh
{
  printf 'backgrounded_at=%s\n' "$backgrounded_at"
  printf 'foregrounded_at=%s\n' "$foregrounded_at"
  printf 'background_duration_ms=%s\n' "$((foreground_start_ms - background_start_ms))"
  printf 'foreground_reconnect_ms=%s\n' "$((foreground_end_ms - foreground_start_ms))"
  printf 'release_device_background_foreground_candidate=pass\n'
} | tee "$FW_ANDROID_BG_DIR/timing.txt"
```

Capture logs:

```sh
adb logcat -d > "$FW_ANDROID_BG_DIR/logcat.log"
adb logcat -d -b crash > "$FW_ANDROID_BG_DIR/crash.log"
```

Verify the evidence:

```sh
pnpm check:android-background-foreground-evidence -- "$FW_ANDROID_BG_DIR"
```

Passing this verifier only proves the Android release-device
background/foreground path. The broader release gates still require iOS
background/foreground evidence and any separately listed provider, signing,
store-console, and operator-owned evidence.
