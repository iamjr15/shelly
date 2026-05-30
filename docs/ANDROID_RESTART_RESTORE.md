# Android Restart Restore Evidence

This runbook verifies the Android side of the Section 13 daemon restart restore
gate with a signed release build on a physical Android phone. It does not cover
iOS, provider push delivery, store submission, npm publish, signing setup,
domains, or hosted observability accounts.

The pass condition is that, after a daemon restart, the paired Android release
app relaunches from saved pairing, shows the last-known desktop-created
`fw_restart_session`, opens the restored terminal, and a desktop reattach replay
contains the persisted `ANDROID_RESTART_SCROLLBACK` from before the restart.
Running PTY processes are allowed to die on daemon restart; v1 only promises
last-known session metadata and restored scrollback for this path.

## Scope

- Use exactly one physical Android phone, not an emulator or AVD.
- Install the signed release App Bundle output or APKs produced from it.
- Do not use a debug build, biometric bypass, or debug pairing code.
- Pair through the real QR scanner and explicit desktop approval before this
  gate, using the same constraints as `docs/ANDROID_PAIR_FLOW.md`.
- Capture evidence with direct `adb`: device listing, restored dashboard and
  terminal screenshots, UI dumps, app logcat, crash buffer, and desktop daemon
  restart/replay transcripts.
- Evidence must contain no Android fatal/ANR logcat entries, no Android system
  not-responding overlays, and empty crash buffers after `adb logcat -c`.

This is a QA-only use of USB debugging; end users do not need adb or debugging
enabled.

## Evidence Directory

```sh
export FW_ANDROID_RESTART_DIR="/tmp/fieldwork-android-restart-$(date +%Y%m%d%H%M%S)"
pnpm scaffold:android-restart-restore-evidence -- --dir "$FW_ANDROID_RESTART_DIR"
```

The scaffold writes `README.md`, `manifest.json`, `missing-files.txt`,
`capture-checklist.md`, and a direct-adb `preflight.sh`. It captures signed
release/device/package proof, desktop seed state, daemon restart timing,
restored Android UI, logcat, and crash-buffer evidence; it does not create
desktop sessions, emit scrollback, open the restored session, or create
`restart-replay.txt`.

Before pairing, capture signed release/device/package proof and clear Android
logs:

```sh
FIELDWORK_ANDROID_AAB=apps/android/app/build/outputs/bundle/release/app-release.aab \
"$FW_ANDROID_RESTART_DIR/preflight.sh"
```

After Android is paired and `fw_restart_session` exists with restorable
scrollback, capture the seed state:

```sh
FIELDWORK_ANDROID_RESTART_CAPTURE_SEED=true "$FW_ANDROID_RESTART_DIR/preflight.sh"
```

Restart the daemon and record `restart_ms=<elapsed-ms>` plus
`processes_died_documented`:

```sh
FIELDWORK_ANDROID_RESTART_DAEMON=true "$FW_ANDROID_RESTART_DIR/preflight.sh"
```

Relaunch Android from saved pairing and capture the restored dashboard or
attached terminal plus logs:

```sh
FIELDWORK_ANDROID_RESTART_CAPTURE_APP=true "$FW_ANDROID_RESTART_DIR/preflight.sh"
```

After `restart-replay.txt` exists from a real desktop `fw attach
fw_restart_session` transcript, run the helper verifier:

```sh
FIELDWORK_ANDROID_RESTART_VERIFY=true "$FW_ANDROID_RESTART_DIR/preflight.sh"
```

## Release Build

Verify the signed release App Bundle:

```sh
node scripts/verify-android-aab.mjs --expect-signed \
  apps/android/app/build/outputs/bundle/release/app-release.aab \
  | tee "$FW_ANDROID_RESTART_DIR/artifact-signing.txt"
```

The transcript must include `Android AAB ok:` and `signed release bundle ok`.

Capture the release `BuildConfig` values:

```sh
rg 'APPLICATION_ID = "app\.fieldwork\.android"|BUILD_TYPE = "release"|DEBUG = false|DEBUG = Boolean\.parseBoolean\("false"\)|FIELDWORK_BIOMETRIC_BYPASS = false|FIELDWORK_DEBUG_PAIRING_CODE = ""' \
  apps/android/app/build/generated/source/buildConfig/release/app/fieldwork/android/BuildConfig.java \
  | tee "$FW_ANDROID_RESTART_DIR/buildconfig.txt"
```

Capture the physical device list and install the release artifact:

```sh
adb devices -l | tee "$FW_ANDROID_RESTART_DIR/adb-devices.txt"
bundletool install-apks --apks /path/to/fieldwork-release.apks
{
  echo '$ adb shell pm path app.fieldwork.android'
  adb shell pm path app.fieldwork.android
  echo '$ adb shell dumpsys package app.fieldwork.android'
  adb shell dumpsys package app.fieldwork.android
} | tee "$FW_ANDROID_RESTART_DIR/package-info.txt"
adb logcat -c
adb logcat -b crash -c
```
`package-info.txt` must prove the installed app is `app.fieldwork.android` with
`versionName=1.0`, `versionCode=1`, and no `DEBUGGABLE` or `debuggable=true` markers.


## Seed Restorable Session

Pair the physical phone through the real QR scanner and explicit desktop
approval. Create a desktop-owned session, emit restorable output, then let the
session exit so the daemon persists scrollback:

```sh
fw daemon start
fw new --name fw_restart_session bash
printf 'ANDROID_RESTART_SCROLLBACK\nexit\n'
fw ls > "$FW_ANDROID_RESTART_DIR/sessions-before.txt"
fw devices > "$FW_ANDROID_RESTART_DIR/devices.txt"
```

`sessions-before.txt` must include `fw_restart_session`. `devices.txt` must show
the paired Android device.

## Restart Daemon

Restart the daemon with the same persisted state and document that live PTY
processes are not expected to survive this gate:

```sh
restart_start_ms="$(node -e 'console.log(Date.now())')"
script -q "$FW_ANDROID_RESTART_DIR/daemon-restart.txt" fw daemon restart
restart_end_ms="$(node -e 'console.log(Date.now())')"
{
  printf 'restart_ms=%s\n' "$((restart_end_ms - restart_start_ms))"
  printf 'processes_died_documented\n'
} >> "$FW_ANDROID_RESTART_DIR/daemon-restart.txt"
```

The transcript must include `fw daemon restart`, `restart_ms=<elapsed-ms>`, and
`processes_died_documented`.

## Android Restore

Force-stop and relaunch Android so it restores from saved pairing:

```sh
adb shell am force-stop app.fieldwork.android
adb shell am start -W -n app.fieldwork.android/.MainActivity
# Complete BiometricPrompt if required.
adb exec-out screencap -p > "$FW_ANDROID_RESTART_DIR/restart.png"
adb shell uiautomator dump /sdcard/window.xml
adb pull /sdcard/window.xml "$FW_ANDROID_RESTART_DIR/restart-ui.xml"
adb logcat -d > "$FW_ANDROID_RESTART_DIR/restart-logcat.log"
adb logcat -d -b crash > "$FW_ANDROID_RESTART_DIR/restart-crash.log"
```

`restart-ui.xml` must show the restored `fw_restart_session` or an attached
terminal for that session.

Open `fw_restart_session` from Android, then capture a desktop replay of the
same restored session:

```sh
script -q "$FW_ANDROID_RESTART_DIR/restart-replay.txt" fw attach fw_restart_session
# Confirm ANDROID_RESTART_SCROLLBACK is visible, then detach.
```

Verify the evidence:

```sh
pnpm check:android-restart-restore-evidence -- "$FW_ANDROID_RESTART_DIR"
```

Passing this verifier only proves the Android release-device saved-pairing
restore and scrollback replay path after daemon restart. The broader release
gates still require physical-device pair-flow, renderer, reconnect,
background/foreground, biometric, provider, signing, store-console, and
operator-owned evidence.
