# Android Renderer Flood Evidence

This runbook verifies the Android side of the Section 13
`yes | head -10000` terminal renderer gate with a signed release build on a
physical Android phone. It does not cover iOS, provider push delivery, store
submission, npm publish, signing setup, domains, or hosted observability
accounts.

The pass condition is rendering and replaying at least 10000
`ANDROID_LIVE_FLOOD` lines from the same daemon-owned PTY without dropped output
or crash evidence. This is the focused Android release-device proof for the
high-volume raw-byte terminal renderer path.

## Scope

- Use a physical Android phone, not an emulator or AVD.
- Install the signed release App Bundle output or APKs produced from it.
- Do not use a debug build, biometric bypass, or debug pairing payload.
- Pair through the real QR scanner and explicit desktop approval.
- Capture evidence with direct `adb`: device listing, terminal screenshot, UI
  dump, app logcat, crash buffer, and desktop PTY replay.

## Evidence Directory

```sh
export FW_ANDROID_FLOOD_DIR="/tmp/fieldwork-android-flood-$(date +%Y%m%d%H%M%S)"
mkdir -p "$FW_ANDROID_FLOOD_DIR"
```

## Release Build

Verify the signed release App Bundle:

```sh
node scripts/verify-android-aab.mjs --expect-signed \
  apps/android/app/build/outputs/bundle/release/app-release.aab \
  | tee "$FW_ANDROID_FLOOD_DIR/artifact-signing.txt"
```

The transcript must include `Android AAB ok:` and `signed release bundle ok`.

Capture the release `BuildConfig` values:

```sh
rg 'APPLICATION_ID = "app\.fieldwork\.android"|BUILD_TYPE = "release"|DEBUG = false|DEBUG = Boolean\.parseBoolean\("false"\)|FIELDWORK_BIOMETRIC_BYPASS = false|FIELDWORK_DEBUG_PAIRING_PAYLOAD = ""' \
  apps/android/app/build/generated/source/buildConfig/release/app/fieldwork/android/BuildConfig.java \
  | tee "$FW_ANDROID_FLOOD_DIR/buildconfig.txt"
```

Capture the physical device list and install the release artifact:

```sh
adb devices -l | tee "$FW_ANDROID_FLOOD_DIR/adb-devices.txt"
bundletool install-apks --apks /path/to/fieldwork-release.apks
adb logcat -c
adb logcat -b crash -c
```

## Pair, Attach, And Flood

Start the desktop daemon and create a desktop-owned shell:

```sh
fw daemon start
fw new --name fw_flood_session bash
```

Pair the physical phone through the real QR scanner and explicit desktop
approval. Attach `fw_flood_session` from Android.

From Android, run this exact command in the attached terminal:

```sh
printf 'ANDROID_LIVE_FLOOD_START\n'; yes ANDROID_LIVE_FLOOD | head -10000; printf 'ANDROID_LIVE_FLOOD_DONE\n'; printf 'flood_lines=10000\n'
```

Capture the Android terminal after the flood finishes:

```sh
adb exec-out screencap -p > "$FW_ANDROID_FLOOD_DIR/flood.png"
adb shell uiautomator dump /sdcard/window.xml
adb pull /sdcard/window.xml "$FW_ANDROID_FLOOD_DIR/flood-ui.xml"
```

Capture the desktop replay of the same PTY:

```sh
script -q "$FW_ANDROID_FLOOD_DIR/flood-replay.txt" fw attach fw_flood_session
# Confirm the exact yes ANDROID_LIVE_FLOOD | head -10000 command,
# ANDROID_LIVE_FLOOD_DONE, flood_lines=10000, and at least 10000
# ANDROID_LIVE_FLOOD lines are visible, then detach.
```

Capture logs:

```sh
adb logcat -d > "$FW_ANDROID_FLOOD_DIR/logcat.log"
adb logcat -d -b crash > "$FW_ANDROID_FLOOD_DIR/crash.log"
```

Verify the evidence:

```sh
pnpm check:android-renderer-flood-evidence -- "$FW_ANDROID_FLOOD_DIR"
```

Passing this verifier only proves the Android release-device high-volume
renderer path. The broader release gate still requires iOS renderer evidence
and any separately listed provider, signing, store-console, and operator-owned
evidence.
