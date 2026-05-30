# Android Multisession Evidence

This runbook verifies the Android side of the Section 13 multi-session
no-leakage gate with a signed release build on a physical Android phone. It does
not cover iOS, provider push delivery, store submission, npm publish, signing
setup, domains, or hosted observability accounts.

The pass condition is three desktop-created sessions running in parallel:
Android switches among `fwm_a`, `fwm_b`, and `fwm_c`, sends a distinct marker to
each, and desktop replay proves each marker lands only in the selected PTY with
no cross-session leakage.

## Scope

- Use exactly one physical Android phone, not an emulator or AVD.
- Install the signed release App Bundle output or APKs produced from it.
- Do not use a debug build, biometric bypass, or debug pairing code.
- Pair through the real QR scanner and explicit desktop approval before this
  gate, using the same constraints as `docs/ANDROID_PAIR_FLOW.md`.
- Capture evidence with direct `adb`: device listing, switched-session
  screenshot, UI dump, app logcat, crash buffer, and three desktop replay files.
- Evidence must contain no Android fatal/ANR logcat entries, no Android system
  not-responding overlays, and empty crash buffers after `adb logcat -c`.
- Mobile must not create sessions, kill sessions, or choose commands.

This is a QA-only use of USB debugging; end users do not need adb or debugging
enabled.

## Evidence Directory

```sh
export FW_ANDROID_MULTISESSION_DIR="/tmp/fieldwork-android-multisession-$(date +%Y%m%d%H%M%S)"
pnpm scaffold:android-multisession-evidence -- --dir "$FW_ANDROID_MULTISESSION_DIR"
```

The scaffold writes `README.md`, `manifest.json`, `missing-files.txt`,
`capture-checklist.md`, and a direct-adb `preflight.sh`. It captures signed
release/device/package proof, desktop session listing, switched Android UI,
logcat, and crash-buffer evidence; it does not create desktop sessions, switch
Android sessions, type markers, or create the three per-session replay files.

Before pairing, capture signed release/device/package proof and clear Android
logs:

```sh
FIELDWORK_ANDROID_AAB=apps/android/app/build/outputs/bundle/release/app-release.aab \
"$FW_ANDROID_MULTISESSION_DIR/preflight.sh"
```

After Android is paired and `fwm_a`, `fwm_b`, and `fwm_c` exist, capture the
desktop session list:

```sh
FIELDWORK_ANDROID_MULTISESSION_CAPTURE_SESSIONS=true "$FW_ANDROID_MULTISESSION_DIR/preflight.sh"
```

After Android switches among the three sessions and sends `multi_a_ok`,
`multi_b_ok`, and `multi_c_ok`, capture the Android UI plus logs:

```sh
FIELDWORK_ANDROID_MULTISESSION_CAPTURE_APP=true "$FW_ANDROID_MULTISESSION_DIR/preflight.sh"
```

After all three replay files exist from real desktop `fw attach` transcripts,
run the helper verifier:

```sh
FIELDWORK_ANDROID_MULTISESSION_VERIFY=true "$FW_ANDROID_MULTISESSION_DIR/preflight.sh"
```

## Release Build

Verify the signed release App Bundle:

```sh
node scripts/verify-android-aab.mjs --expect-signed \
  apps/android/app/build/outputs/bundle/release/app-release.aab \
  | tee "$FW_ANDROID_MULTISESSION_DIR/artifact-signing.txt"
```

The transcript must include `Android AAB ok:` and `signed release bundle ok`.

Capture the release `BuildConfig` values:

```sh
rg 'APPLICATION_ID = "app\.fieldwork\.android"|BUILD_TYPE = "release"|DEBUG = false|DEBUG = Boolean\.parseBoolean\("false"\)|FIELDWORK_BIOMETRIC_BYPASS = false|FIELDWORK_DEBUG_PAIRING_CODE = ""' \
  apps/android/app/build/generated/source/buildConfig/release/app/fieldwork/android/BuildConfig.java \
  | tee "$FW_ANDROID_MULTISESSION_DIR/buildconfig.txt"
```

Capture the physical device list and install the release artifact:

```sh
adb devices -l | tee "$FW_ANDROID_MULTISESSION_DIR/adb-devices.txt"
bundletool install-apks --apks /path/to/fieldwork-release.apks
{
  echo '$ adb shell pm path app.fieldwork.android'
  adb shell pm path app.fieldwork.android
  echo '$ adb shell dumpsys package app.fieldwork.android'
  adb shell dumpsys package app.fieldwork.android
} | tee "$FW_ANDROID_MULTISESSION_DIR/package-info.txt"
adb logcat -c
adb logcat -b crash -c
```
`package-info.txt` must prove the installed app is `app.fieldwork.android` with
`versionName=1.0`, `versionCode=1`, and no `DEBUGGABLE` or `debuggable=true` markers.


## Create Desktop Sessions

Pair the physical phone through the real QR scanner and explicit desktop
approval. Create three desktop-owned sessions:

```sh
fw daemon start
fw new --name fwm_a bash
fw new --name fwm_b bash
fw new --name fwm_c bash
fw ls > "$FW_ANDROID_MULTISESSION_DIR/sessions.txt"
```

`sessions.txt` must include `fwm_a`, `fwm_b`, and `fwm_c`. Android must only
list, attach, switch, and send input; it must not create these sessions.

## Switch And Send Input

On Android, switch among all three sessions. Send exactly one marker to each
selected session:

```sh
echo multi_a_ok
echo multi_b_ok
echo multi_c_ok
```

Capture the switched session set:

```sh
adb exec-out screencap -p > "$FW_ANDROID_MULTISESSION_DIR/multisession.png"
adb shell uiautomator dump /sdcard/window.xml
adb pull /sdcard/window.xml "$FW_ANDROID_MULTISESSION_DIR/multisession-ui.xml"
adb logcat -d > "$FW_ANDROID_MULTISESSION_DIR/multisession-logcat.log"
adb logcat -d -b crash > "$FW_ANDROID_MULTISESSION_DIR/multisession-crash.log"
```

Capture desktop replays for each PTY:

```sh
script -q "$FW_ANDROID_MULTISESSION_DIR/multisession-a-replay.txt" fw attach fwm_a
# Confirm multi_a_ok is visible and multi_b_ok/multi_c_ok are absent, then detach.
script -q "$FW_ANDROID_MULTISESSION_DIR/multisession-b-replay.txt" fw attach fwm_b
# Confirm multi_b_ok is visible and multi_a_ok/multi_c_ok are absent, then detach.
script -q "$FW_ANDROID_MULTISESSION_DIR/multisession-c-replay.txt" fw attach fwm_c
# Confirm multi_c_ok is visible and multi_a_ok/multi_b_ok are absent, then detach.
```

Verify the evidence:

```sh
pnpm check:android-multisession-evidence -- "$FW_ANDROID_MULTISESSION_DIR"
```

Passing this verifier only proves the Android release-device multi-session
switching and no-leakage replay path. The broader release gates still require
physical-device pair-flow, renderer, reconnect, background/foreground,
biometric, daemon-restore, provider, signing, store-console, and operator-owned
evidence.
