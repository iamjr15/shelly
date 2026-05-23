# Android Network Reconnect Evidence

This runbook verifies the Android side of the Section 13 network-change
reconnect gate with a signed release build on a physical Android phone. It does
not cover iOS, provider push delivery, store submission, npm publish, signing
setup, domains, or hosted observability accounts.

The pass condition is reconnecting the same daemon-owned PTY session within
2000 ms after Android networking is restored: the app is attached before the
network cut, the PTY emits output while Android is offline, Android reconnects
after network restore, and Android-originated input after reconnect is visible
when the desktop reattaches.

## Scope

- Use exactly one physical Android phone, not an emulator or AVD.
- Install the signed release App Bundle output or APKs produced from it.
- Do not use a debug build, biometric bypass, or debug pairing payload.
- Pair through the real QR scanner and explicit desktop approval.
- Capture evidence with direct `adb`: device listing, screenshots, UI dumps,
  network cut/restore state, app logcat, crash buffer, and desktop PTY replay.
- Evidence must contain no Android fatal/ANR logcat entries, no Android system
  not-responding overlays, and empty crash buffers after `adb logcat -c`.

## Evidence Directory

```sh
export FW_ANDROID_RECONNECT_DIR="/tmp/fieldwork-android-reconnect-$(date +%Y%m%d%H%M%S)"
mkdir -p "$FW_ANDROID_RECONNECT_DIR"
```

## Release Build

Verify the signed release App Bundle:

```sh
node scripts/verify-android-aab.mjs --expect-signed \
  apps/android/app/build/outputs/bundle/release/app-release.aab \
  | tee "$FW_ANDROID_RECONNECT_DIR/artifact-signing.txt"
```

The transcript must include `Android AAB ok:` and `signed release bundle ok`.

Capture the release `BuildConfig` values:

```sh
rg 'APPLICATION_ID = "app\.fieldwork\.android"|BUILD_TYPE = "release"|DEBUG = false|DEBUG = Boolean\.parseBoolean\("false"\)|FIELDWORK_BIOMETRIC_BYPASS = false|FIELDWORK_DEBUG_PAIRING_PAYLOAD = ""' \
  apps/android/app/build/generated/source/buildConfig/release/app/fieldwork/android/BuildConfig.java \
  | tee "$FW_ANDROID_RECONNECT_DIR/buildconfig.txt"
```

Capture the physical device list and install the release artifact:

```sh
adb devices -l | tee "$FW_ANDROID_RECONNECT_DIR/adb-devices.txt"
bundletool install-apks --apks /path/to/fieldwork-release.apks
adb logcat -c
adb logcat -b crash -c
```

## Pair And Attach

Start the desktop daemon and create a desktop-owned reconnect test session:

```sh
fw daemon start
fw new --name fw_reconnect_session bash
```

In that session, run:

```sh
printf 'ANDROID_RECONNECT_READY\n'
while IFS= read -r line; do
  printf 'android-reconnect: %s\n' "$line"
  if [ "$line" = "trigger_offline_output" ]; then
    ( sleep 3; printf 'ANDROID_RECONNECT_OFFLINE_OUTPUT\n' ) &
  fi
done
```

Pair the physical phone through the real QR scanner and explicit desktop
approval. Attach `fw_reconnect_session` from Android.

Capture the attached terminal before cutting the network:

```sh
adb exec-out screencap -p > "$FW_ANDROID_RECONNECT_DIR/attached-before.png"
adb shell uiautomator dump /sdcard/window.xml
adb pull /sdcard/window.xml "$FW_ANDROID_RECONNECT_DIR/attached-before-ui.xml"
```

## Cut Network, Emit Output, Restore

From Android, type `trigger_offline_output` and press Enter. Immediately cut
Android networking with direct `adb`:

```sh
adb shell cmd connectivity airplane-mode enable
sleep 4
{
  printf 'network_cut_command=adb shell cmd connectivity airplane-mode enable\n'
  printf 'network_state=disconnected\n'
  printf 'network_cut_ok\n'
} | tee "$FW_ANDROID_RECONNECT_DIR/network-cut.txt"
```

Before restoring Android networking, prove the desktop can replay output
emitted while Android was offline:

```sh
script -q "$FW_ANDROID_RECONNECT_DIR/offline-output-replay.txt" fw attach fw_reconnect_session
# Confirm ANDROID_RECONNECT_READY and ANDROID_RECONNECT_OFFLINE_OUTPUT are visible, then detach.
```

Restore Android networking and measure how long the app takes to reconnect:

```sh
restore_start_ms="$(node -e 'console.log(Date.now())')"
adb shell cmd connectivity airplane-mode disable
until adb shell ping -c 1 -W 2 8.8.8.8 >/dev/null 2>&1; do sleep 0.25; done
{
  printf 'network_restore_command=adb shell cmd connectivity airplane-mode disable\n'
  printf 'network_ping_ok\n'
  printf 'network_restored_ok\n'
} | tee "$FW_ANDROID_RECONNECT_DIR/network-restore.txt"
# Stop this timer once the Fieldwork terminal visibly reattaches.
restore_end_ms="$(node -e 'console.log(Date.now())')"
```

Capture the reattached terminal and type `after_reconnect_ok` from Android:

```sh
adb exec-out screencap -p > "$FW_ANDROID_RECONNECT_DIR/attached-after.png"
adb shell uiautomator dump /sdcard/window.xml
adb pull /sdcard/window.xml "$FW_ANDROID_RECONNECT_DIR/attached-after-ui.xml"
```

Then capture a desktop replay of the same PTY and append the timing:

```sh
script -q "$FW_ANDROID_RECONNECT_DIR/reconnect-replay.txt" fw attach fw_reconnect_session
# Confirm ANDROID_RECONNECT_OFFLINE_OUTPUT, after_reconnect_ok, and
# android-reconnect: after_reconnect_ok are visible, then detach.
printf 'reconnect_ms=%s\n' "$((restore_end_ms - restore_start_ms))" \
  >> "$FW_ANDROID_RECONNECT_DIR/reconnect-replay.txt"
```

Capture logs:

```sh
adb logcat -d > "$FW_ANDROID_RECONNECT_DIR/logcat.log"
adb logcat -d -b crash > "$FW_ANDROID_RECONNECT_DIR/crash.log"
```

Verify the evidence:

```sh
pnpm check:android-network-reconnect-evidence -- "$FW_ANDROID_RECONNECT_DIR"
```

Passing this verifier only proves the Android release-device network reconnect
path. The broader release gates still require iOS network/background evidence
and any separately listed provider, signing, store-console, and operator-owned
evidence.
