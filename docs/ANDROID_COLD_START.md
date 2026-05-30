# Android Cold Start Evidence

This runbook verifies the Section 13 Android release-device cold-start gate. It
is separate from the first Android live-test runbook because this gate must run
on a physical phone with the signed release artifact, not the local debug APK.

The pass condition is five cold launches of `app.fieldwork.android/.MainActivity`
with `TotalTime <= 1200ms`, clean Android evidence, and the locked biometric
surface visible before session access.

## Scope

- Use exactly one physical Android phone, not an emulator or AVD.
- Install the signed release App Bundle output or APKs produced from it.
- Do not use a debug build, biometric bypass, or debug pairing code.
- Capture evidence with direct `adb`: device listing, install transcript,
  installed package proof, `am start -W` launch transcripts, screenshot, UI
  dump, logcat, and crash buffer.
- Evidence must contain no Android fatal/ANR logcat entries, no Android system
  not-responding overlays, and empty crash buffers after `adb logcat -c`.

## Evidence Directory

```sh
export FW_ANDROID_COLD_DIR="/tmp/fieldwork-android-cold-start-$(date +%Y%m%d%H%M%S)"
pnpm scaffold:android-cold-start-evidence -- --dir "$FW_ANDROID_COLD_DIR"
```

The scaffold writes `README.md`, `manifest.json`, `missing-files.txt`,
`capture-checklist.md`, and a direct-adb `preflight.sh`. It does not bypass the
physical-device gate: `preflight.sh` only passes when run against exactly one
physical Android phone with the signed release artifact installed, and it
rejects emulator, debug, debuggable, biometric-bypass, debug-pairing, warm
launch, slow-launch, unlocked-surface, fatal-log, and non-empty crash-buffer
evidence.

The shortest release-device capture path is:

```sh
FIELDWORK_ANDROID_RELEASE_APKS=/path/to/fieldwork-release.apks \
FIELDWORK_ANDROID_AAB=apps/android/app/build/outputs/bundle/release/app-release.aab \
"$FW_ANDROID_COLD_DIR/preflight.sh"
```

If signing or install was captured outside the helper, pass the transcript
files:

```sh
FIELDWORK_ANDROID_ARTIFACT_SIGNING_FILE=/path/to/artifact-signing.txt \
FIELDWORK_ANDROID_INSTALL_TRANSCRIPT_FILE=/path/to/install.txt \
"$FW_ANDROID_COLD_DIR/preflight.sh"
```

## Signed Release Artifact

Verify the exact release App Bundle before installing it:

```sh
node scripts/verify-android-aab.mjs --expect-signed \
  apps/android/app/build/outputs/bundle/release/app-release.aab \
  | tee "$FW_ANDROID_COLD_DIR/artifact-signing.txt"
```

The transcript must contain `Android AAB ok:` and `signed release bundle ok`.

Capture the release `BuildConfig` values:

```sh
rg 'APPLICATION_ID = "app\.fieldwork\.android"|BUILD_TYPE = "release"|DEBUG = false|DEBUG = Boolean\.parseBoolean\("false"\)|FIELDWORK_BIOMETRIC_BYPASS = false|FIELDWORK_DEBUG_PAIRING_CODE = ""' \
  apps/android/app/build/generated/source/buildConfig/release/app/fieldwork/android/BuildConfig.java \
  | tee "$FW_ANDROID_COLD_DIR/buildconfig.txt"
```

## Install

Capture the physical device list and install transcript:

```sh
adb devices -l | tee "$FW_ANDROID_COLD_DIR/adb-devices.txt"
bundletool install-apks --apks /path/to/fieldwork-release.apks \
  | tee "$FW_ANDROID_COLD_DIR/install.txt"
{
  echo '$ adb shell pm path app.fieldwork.android'
  adb shell pm path app.fieldwork.android
  echo '$ adb shell dumpsys package app.fieldwork.android'
  adb shell dumpsys package app.fieldwork.android
} | tee "$FW_ANDROID_COLD_DIR/package-info.txt"
```

If installing a release APK directly, capture `adb install -r ...` output in the
same `install.txt`. The transcript must include `Success`, `Installed`, or
`installed`. `package-info.txt` must prove the installed release package is
`app.fieldwork.android` with `versionName=1.0`, `versionCode=1`, and no `DEBUGGABLE` or `debuggable=true` markers.

## Cold Launch Samples

Run five cold launches. Force-stop before each launch, clear app logcat before
the first launch, and keep the phone unlocked at the OS level so launch timing
does not include a device unlock flow.

```sh
adb logcat -c
adb logcat -b crash -c
for sample in 1 2 3 4 5; do
  adb shell am force-stop app.fieldwork.android
  adb shell am start -W -n app.fieldwork.android/.MainActivity \
    | tee "$FW_ANDROID_COLD_DIR/launch-${sample}.txt"
done
```

Every `launch-*.txt` file must show:

- `Status: ok`
- `LaunchState: COLD`
- `Activity: app.fieldwork.android/.MainActivity`
- `TotalTime: <ms>` at or below `1200`

Capture the locked surface and logs after the final launch:

```sh
adb exec-out screencap -p > "$FW_ANDROID_COLD_DIR/locked.png"
adb shell uiautomator dump /sdcard/window.xml
adb pull /sdcard/window.xml "$FW_ANDROID_COLD_DIR/locked-ui.xml"
adb logcat -d > "$FW_ANDROID_COLD_DIR/logcat.log"
adb logcat -d -b crash > "$FW_ANDROID_COLD_DIR/crash.log"
```

Verify the evidence:

```sh
pnpm check:android-cold-start-evidence -- "$FW_ANDROID_COLD_DIR"
```

Only check the Android cold-start `PLAN.md` release gate after this verifier
passes against the signed release artifact on a physical Android phone.
