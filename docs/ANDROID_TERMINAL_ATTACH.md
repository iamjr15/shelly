# Android Terminal Attach Evidence

This runbook verifies the Android side of the Section 13 live terminal handoff
gate with a signed release build on a physical Android phone. It does not cover
iOS, provider push delivery, store submission, npm publish, signing setup,
domains, or hosted observability accounts.

The pass condition is Android attaching to three desktop-created daemon-owned
PTY sessions: a shell session that accepts Android-originated input, a Claude
session that accepts separate Android-originated input, and a TUI session
rendering real `vim` or `htop` screen content. Desktop replay must prove the
shell marker `android_live_ok` and Claude marker `claude_live_ok` landed in the
right PTYs.

## Scope

- Use exactly one physical Android phone, not an emulator or AVD.
- Install the signed release App Bundle output or APKs produced from it.
- Do not use a debug build, biometric bypass, or debug pairing payload.
- Pair through the real QR scanner and explicit desktop approval before this
  gate, using the same constraints as `docs/ANDROID_PAIR_FLOW.md`.
- Capture evidence with direct `adb`: device listing, terminal screenshots, UI
  dumps, app logcat, crash buffers, and desktop PTY replay transcripts.
- Mobile must not create sessions, kill sessions, or choose commands.

This is a QA-only use of USB debugging; end users do not need adb or debugging
enabled.

## Evidence Directory

```sh
export FW_ANDROID_TERMINAL_DIR="/tmp/fieldwork-android-terminal-$(date +%Y%m%d%H%M%S)"
mkdir -p "$FW_ANDROID_TERMINAL_DIR"
```

## Release Build

Verify the signed release App Bundle:

```sh
node scripts/verify-android-aab.mjs --expect-signed \
  apps/android/app/build/outputs/bundle/release/app-release.aab \
  | tee "$FW_ANDROID_TERMINAL_DIR/artifact-signing.txt"
```

The transcript must include `Android AAB ok:` and `signed release bundle ok`.

Capture the release `BuildConfig` values:

```sh
rg 'APPLICATION_ID = "app\.fieldwork\.android"|BUILD_TYPE = "release"|DEBUG = false|DEBUG = Boolean\.parseBoolean\("false"\)|FIELDWORK_BIOMETRIC_BYPASS = false|FIELDWORK_DEBUG_PAIRING_PAYLOAD = ""' \
  apps/android/app/build/generated/source/buildConfig/release/app/fieldwork/android/BuildConfig.java \
  | tee "$FW_ANDROID_TERMINAL_DIR/buildconfig.txt"
```

Capture the physical device list and install the release artifact:

```sh
adb devices -l | tee "$FW_ANDROID_TERMINAL_DIR/adb-devices.txt"
bundletool install-apks --apks /path/to/fieldwork-release.apks
adb logcat -c
adb logcat -b crash -c
```

## Create Desktop Sessions

Pair the physical phone through the real QR scanner and explicit desktop
approval. Create daemon-owned sessions from the desktop:

```sh
fw daemon start
fw refactoringjob
fw new --name shell bash
fw new --name editor htop
fw ls > "$FW_ANDROID_TERMINAL_DIR/sessions.txt"
```

`sessions.txt` must include `refactoringjob claude`, a desktop-created
`shell`/`bash` session, and a desktop-created `editor`/`vim`/`htop` session.
Android must only list, attach, send input, resize, and detach; it must not
create these sessions or choose the commands.

## Shell Attach

Open the `shell` session from Android. Type:

```sh
echo android_live_ok
```

Capture the Android terminal and a desktop replay of the same PTY:

```sh
adb exec-out screencap -p > "$FW_ANDROID_TERMINAL_DIR/session.png"
adb shell uiautomator dump /sdcard/window.xml
adb pull /sdcard/window.xml "$FW_ANDROID_TERMINAL_DIR/session-ui.xml"
adb logcat -d > "$FW_ANDROID_TERMINAL_DIR/session-logcat.log"
adb logcat -d -b crash > "$FW_ANDROID_TERMINAL_DIR/session-crash.log"
script -q "$FW_ANDROID_TERMINAL_DIR/terminal-replay.txt" fw attach shell
# Confirm android_live_ok is visible, then detach.
```

`session-ui.xml` must show `Attached` and identify the shell session.
`terminal-replay.txt` must contain `android_live_ok` and identify `shell` or
`bash`.

## Claude Attach

Open the `refactoringjob` Claude session from Android. Type:

```sh
echo claude_live_ok
```

Capture the Android terminal and a desktop replay of the same PTY:

```sh
adb exec-out screencap -p > "$FW_ANDROID_TERMINAL_DIR/claude.png"
adb shell uiautomator dump /sdcard/window.xml
adb pull /sdcard/window.xml "$FW_ANDROID_TERMINAL_DIR/claude-ui.xml"
adb logcat -d > "$FW_ANDROID_TERMINAL_DIR/claude-logcat.log"
adb logcat -d -b crash > "$FW_ANDROID_TERMINAL_DIR/claude-crash.log"
script -q "$FW_ANDROID_TERMINAL_DIR/claude-replay.txt" fw attach refactoringjob
# Confirm claude_live_ok is visible and android_live_ok is absent, then detach.
```

`claude-ui.xml` must show `Attached` and identify `claude`, `refactoringjob`, or
`Claude Code`. `claude-replay.txt` must contain `claude_live_ok`, identify the
Claude session, and must not reuse the shell marker `android_live_ok`.

## TUI Attach

Open the `editor` TUI session from Android. Capture the rendered terminal:

```sh
adb exec-out screencap -p > "$FW_ANDROID_TERMINAL_DIR/tui.png"
adb shell uiautomator dump /sdcard/window.xml
adb pull /sdcard/window.xml "$FW_ANDROID_TERMINAL_DIR/tui-ui.xml"
adb logcat -d > "$FW_ANDROID_TERMINAL_DIR/tui-logcat.log"
adb logcat -d -b crash > "$FW_ANDROID_TERMINAL_DIR/tui-crash.log"
```

`tui-ui.xml` must show `Attached` plus real `vim` or `htop` content such as
`F1Help`, `F2Setup`, `F10Quit`, `VIM`, `-- INSERT --`, or `/etc/hosts`.

Verify the evidence:

```sh
pnpm check:android-terminal-attach-evidence -- "$FW_ANDROID_TERMINAL_DIR"
```

Passing this verifier only proves the Android release-device terminal attach,
shell input, Claude input, and TUI rendering path. The broader release gates
still require physical-device pair-flow, renderer flood, reconnect,
background/foreground, biometric, daemon-restore, provider, signing,
store-console, and operator-owned evidence.
