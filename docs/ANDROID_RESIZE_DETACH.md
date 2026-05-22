# Android Resize And Detach Evidence

This runbook verifies the Android side of the Section 13 terminal resize and
detach/reattach replay path with a signed release build on a physical Android
phone. It does not cover iOS, provider push delivery, store submission, npm
publish, signing setup, domains, or hosted observability accounts.

The pass condition is Android attaching to a desktop-created daemon-owned PTY,
resizing the terminal so desktop replay records a plausible `resize_size`, then
detaching and reattaching without losing the session. Desktop replay must prove
`after_resize_ok` and `after_detach_reattach_ok` landed in the same PTY after
the corresponding Android actions.

## Scope

- Use a physical Android phone, not an emulator or AVD.
- Install the signed release App Bundle output or APKs produced from it.
- Do not use a debug build, biometric bypass, or debug pairing payload.
- Pair through the real QR scanner and explicit desktop approval before this
  gate, using the same constraints as `docs/ANDROID_PAIR_FLOW.md`.
- Capture evidence with direct `adb`: device listing, resize/detach
  screenshots, UI dumps, app logcat, crash buffers, and desktop PTY replay
  transcripts.
- Mobile must not create sessions, kill sessions, or choose commands.

This is a QA-only use of USB debugging; end users do not need adb or debugging
enabled.

## Evidence Directory

```sh
export FW_ANDROID_RESIZE_DIR="/tmp/fieldwork-android-resize-detach-$(date +%Y%m%d%H%M%S)"
mkdir -p "$FW_ANDROID_RESIZE_DIR"
```

## Release Build

Verify the signed release App Bundle:

```sh
node scripts/verify-android-aab.mjs --expect-signed \
  apps/android/app/build/outputs/bundle/release/app-release.aab \
  | tee "$FW_ANDROID_RESIZE_DIR/artifact-signing.txt"
```

The transcript must include `Android AAB ok:` and `signed release bundle ok`.

Capture the release `BuildConfig` values:

```sh
rg 'APPLICATION_ID = "app\.fieldwork\.android"|BUILD_TYPE = "release"|DEBUG = false|DEBUG = Boolean\.parseBoolean\("false"\)|FIELDWORK_BIOMETRIC_BYPASS = false|FIELDWORK_DEBUG_PAIRING_PAYLOAD = ""' \
  apps/android/app/build/generated/source/buildConfig/release/app/fieldwork/android/BuildConfig.java \
  | tee "$FW_ANDROID_RESIZE_DIR/buildconfig.txt"
```

Capture the physical device list and install the release artifact:

```sh
adb devices -l | tee "$FW_ANDROID_RESIZE_DIR/adb-devices.txt"
bundletool install-apks --apks /path/to/fieldwork-release.apks
adb logcat -c
adb logcat -b crash -c
```

## Create Desktop Session

Pair the physical phone through the real QR scanner and explicit desktop
approval. Create the daemon-owned session from the desktop:

```sh
fw daemon start
fw new --name shell bash
fw ls > "$FW_ANDROID_RESIZE_DIR/sessions.txt"
```

`sessions.txt` must include the desktop-created session used for
resize/detach. Android must only list, attach, send input, resize, and detach;
it must not create this session or choose the command.

## Resize

Open the `shell` session from Android. Resize the app viewport by rotating the
phone or otherwise changing the terminal bounds, then type:

```sh
printf 'resize_size=%sx%s\n' "$LINES" "$COLUMNS"
echo after_resize_ok
```

Capture the Android terminal and a desktop replay of the same PTY:

```sh
adb exec-out screencap -p > "$FW_ANDROID_RESIZE_DIR/resize.png"
adb shell uiautomator dump /sdcard/window.xml
adb pull /sdcard/window.xml "$FW_ANDROID_RESIZE_DIR/resize-ui.xml"
adb logcat -d > "$FW_ANDROID_RESIZE_DIR/resize-logcat.log"
adb logcat -d -b crash > "$FW_ANDROID_RESIZE_DIR/resize-crash.log"
script -q "$FW_ANDROID_RESIZE_DIR/resize-replay.txt" fw attach shell
# Confirm resize_size=<rows>x<cols> and after_resize_ok are visible, then detach.
```

`resize-ui.xml` must show `Attached`. `resize-replay.txt` must contain
`resize_size=<rows>x<cols>` or `resize_size=<rows> <cols>` with rows at least
5 and columns at least 20, plus `after_resize_ok` from Android-originated
input.

## Detach And Reattach

Detach from Android, return to the session dashboard, reattach to the same
`shell` session, then type:

```sh
echo after_detach_reattach_ok
```

Capture the Android dashboard/terminal state and a desktop replay of the same
PTY:

```sh
adb exec-out screencap -p > "$FW_ANDROID_RESIZE_DIR/detach.png"
adb shell uiautomator dump /sdcard/window.xml
adb pull /sdcard/window.xml "$FW_ANDROID_RESIZE_DIR/detach-ui.xml"
adb logcat -d > "$FW_ANDROID_RESIZE_DIR/detach-logcat.log"
adb logcat -d -b crash > "$FW_ANDROID_RESIZE_DIR/detach-crash.log"
script -q "$FW_ANDROID_RESIZE_DIR/detach-replay.txt" fw attach shell
# Confirm after_detach_reattach_ok is visible, then detach.
```

`detach-ui.xml` must not show an empty `No sessions` dashboard and must still
identify the detachable session. `detach-replay.txt` must contain
`after_detach_reattach_ok` after Android reattached to the same PTY.

Verify the evidence:

```sh
pnpm check:android-resize-detach-evidence -- "$FW_ANDROID_RESIZE_DIR"
```

Passing this verifier only proves the Android release-device terminal resize,
detach, and reattach replay path. The broader release gates still require
physical-device pair-flow, terminal attach, renderer flood, reconnect,
background/foreground, biometric, daemon-restore, provider, signing,
store-console, and operator-owned evidence.
