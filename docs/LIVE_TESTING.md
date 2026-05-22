# Live Testing

This runbook is for the first operator-assisted live test round. It is not the
v1 release sign-off. `PLAN.md` remains the completion-checkbox source of truth,
and `docs/RELEASE_AUDIT.md` remains the evidence ledger.

## Round 1 Scope

Run Android physical-device terminal handoff only:

- Verify the phone attaches to the same daemon-owned PTY session the laptop CLI
  can attach to. This is terminal handoff, not screen mirroring, and it does not
  take over arbitrary already-open Terminal.app or iTerm tabs that were not
  started under `fieldworkd`.
- Pair a physical Android phone to a local desktop daemon through the real QR
  scanner and explicit desktop approval.
- Create sessions only from the desktop CLI.
- Attach from Android, send input, resize, detach, background/foreground, and
  reconnect.
- Exercise arbitrary PTY commands: `bash`, `claude`, and one TUI such as `vim`
  or `htop`.
- Capture QA evidence with direct `adb`: screenshots, UI dumps, app logcat,
  crash buffers, and command output.

Do not include iOS, npm publish, store submission, production relay deploy, APNs
or FCM provider delivery, domain checks, or release signing in this first round.

## Prerequisites

- One physical Android phone with biometrics enrolled. USB debugging is not an
  end-user requirement; enable it for this QA run only when capturing direct
  `adb` evidence or installing the local debug APK outside Android Studio.
- Laptop and phone on the same reachable network, or another path where iroh can
  connect without production relay assumptions.
- Local release desktop binaries already built in `target/release/`.
- Android debug APK built from the current checkout.
- No debug biometric bypass and no debug pairing payload for this physical test.

Check the current release gate inventory before starting:

```sh
pnpm check:local-release
pnpm check:release-audit:list
```

## Build And Install

```sh
apps/android/gradlew --no-daemon :app:assembleDebug
adb devices
adb install -r apps/android/app/build/outputs/apk/debug/app-debug.apk
```

If the APK is installed through Android Studio, Firebase App Distribution,
internal app sharing, or another trusted test channel, the user-facing handoff
flow can be exercised without USB debugging. The release-gate evidence will
still need an equivalent bug report, screen recording, logs, and crash data.

Confirm the installed build is the normal debug app, not a bypass build:

```sh
rg 'APPLICATION_ID = "app\.fieldwork\.android"|BUILD_TYPE = "debug"|DEBUG = Boolean\.parseBoolean\("true"\)|FIELDWORK_BIOMETRIC_BYPASS = false|FIELDWORK_DEBUG_PAIRING_PAYLOAD = ""' \
  apps/android/app/build/generated/source/buildConfig/debug/app/fieldwork/android/BuildConfig.java
```

## Desktop Setup

Use a clean terminal so the captured command output is easy to audit. If this
round is running from source before the npm package is installed globally, put a
temporary `fw` shim on `PATH` so the test exercises the same short command users
will type after install:

```sh
export FW_LIVE_BIN="$(mktemp -d /tmp/fieldwork-live-bin.XXXXXX)"
trap 'rm -rf "$FW_LIVE_BIN"' EXIT
ln -sf "$PWD/target/release/fieldwork" "$FW_LIVE_BIN/fieldwork"
ln -sf "$PWD/target/release/fieldwork" "$FW_LIVE_BIN/fw"
ln -sf "$PWD/target/release/fieldworkd" "$FW_LIVE_BIN/fieldworkd"
export PATH="$FW_LIVE_BIN:$PATH"

fw daemon start
fw
fw refactoringjob
fw new --name shell bash
fw new --name editor -- vim
fw new bash
fw new -- claude
fw new -- vim
fw ls
```

The bare `fw` command must create and attach a default `claude` session with a
generated one-word name such as `waffle` or `kazoo`. Press `Ctrl-B` then `D` to
detach after confirming the generated name. The `fw refactoringjob` command must
create or attach that named default `claude` session. Confirm both the generated
name and `refactoringjob` appear as active sessions in the Android dashboard
after pairing; the phone should still only list and attach, never create or
choose commands.

## Evidence Capture

Create a timestamped evidence directory before pairing so the desktop approval
transcript is captured. The scaffold writes only a README, manifest, and
missing-file checklist; it does not create placeholder screenshots, logs, crash
buffers, UI dumps, or transcripts:

```sh
export FW_LIVE_DIR="$(pnpm --silent scaffold:live-testing-evidence -- --print-dir --quiet)"
adb devices -l | tee "$FW_LIVE_DIR/adb-devices.txt"
rg 'APPLICATION_ID = "app\.fieldwork\.android"|BUILD_TYPE = "debug"|DEBUG = Boolean\.parseBoolean\("true"\)|FIELDWORK_BIOMETRIC_BYPASS = false|FIELDWORK_DEBUG_PAIRING_PAYLOAD = ""' \
  apps/android/app/build/generated/source/buildConfig/debug/app/fieldwork/android/BuildConfig.java \
  | tee "$FW_LIVE_DIR/buildconfig.txt"
```

Use `pnpm scaffold:live-testing-evidence -- --dir "$FW_LIVE_DIR"` if you need
to choose the directory yourself.

Run `fw pair` inside a desktop transcript. Approve pairing only after the phone
scans the QR payload and the CLI asks for explicit confirmation. Record
`pair_flow_ms` in the same transcript; it must be at or below 15000:

```sh
pair_start_ms="$(node -e 'console.log(Date.now())')"
script -q "$FW_LIVE_DIR/pairing.txt" fw pair
pair_end_ms="$(node -e 'console.log(Date.now())')"
printf 'pair_flow_ms=%s\n' "$((pair_end_ms - pair_start_ms))" | tee -a "$FW_LIVE_DIR/pairing.txt"
```

Capture the locked launch surface:

```sh
adb shell am force-stop app.fieldwork.android
adb logcat -c
adb shell am start -W -n app.fieldwork.android/.MainActivity | tee "$FW_LIVE_DIR/launch.txt"
adb exec-out screencap -p > "$FW_LIVE_DIR/locked.png"
adb shell uiautomator dump /sdcard/window.xml
adb pull /sdcard/window.xml "$FW_LIVE_DIR/locked-ui.xml"
adb logcat -d > "$FW_LIVE_DIR/locked-logcat.log"
adb logcat -d -b crash > "$FW_LIVE_DIR/locked-crash.log"
```

Tap the app's `Unlock` button, hold the phone so biometric authentication does
not complete yet, and capture the Android BiometricPrompt before any session
list or terminal content appears:

```sh
adb exec-out screencap -p > "$FW_LIVE_DIR/biometric.png"
adb shell uiautomator dump /sdcard/window.xml
adb pull /sdcard/window.xml "$FW_LIVE_DIR/biometric-ui.xml"
adb logcat -d > "$FW_LIVE_DIR/biometric-logcat.log"
adb logcat -d -b crash > "$FW_LIVE_DIR/biometric-crash.log"
```

After pairing, capture the active sessions dashboard before tapping into a
terminal. The dashboard evidence must show the generated one-word `fw` default
session, `refactoringjob`, and the desktop-created shell/bash session:

```sh
adb exec-out screencap -p > "$FW_LIVE_DIR/dashboard.png"
adb shell uiautomator dump /sdcard/window.xml
adb pull /sdcard/window.xml "$FW_LIVE_DIR/dashboard-ui.xml"
adb logcat -d > "$FW_LIVE_DIR/dashboard-logcat.log"
adb logcat -d -b crash > "$FW_LIVE_DIR/dashboard-crash.log"
```

Create one additional session from the desktop after the phone is already paired
and watching the dashboard. Record how long it takes to appear in the Android
session list. This pins the live subscription path; the phone still must not
create the session or choose the command:

```sh
sub_start_ms="$(node -e 'console.log(Date.now())')"
fw new --name fw_live_sub bash
# When fw_live_sub is visible on Android:
sub_visible_ms="$(node -e 'console.log(Date.now())')"
printf 'created_by_desktop_cli\nvisible_ms=%s\n' "$((sub_visible_ms - sub_start_ms))" \
  | tee "$FW_LIVE_DIR/subscription-visible.txt"
adb exec-out screencap -p > "$FW_LIVE_DIR/subscription.png"
adb shell uiautomator dump /sdcard/window.xml
adb pull /sdcard/window.xml "$FW_LIVE_DIR/subscription-ui.xml"
adb logcat -d > "$FW_LIVE_DIR/subscription-logcat.log"
adb logcat -d -b crash > "$FW_LIVE_DIR/subscription-crash.log"
```

Open `fw_live_sub` from Android, type `echo subscription_attach_ok`, then
capture the desktop replay transcript:

```sh
script -q "$FW_LIVE_DIR/subscription-replay.txt" fw attach fw_live_sub
# Confirm subscription_attach_ok is visible, then detach.
```

After pairing and attaching each session, capture:

```sh
adb exec-out screencap -p > "$FW_LIVE_DIR/session.png"
adb shell uiautomator dump /sdcard/window.xml
adb pull /sdcard/window.xml "$FW_LIVE_DIR/session-ui.xml"
adb logcat -d > "$FW_LIVE_DIR/session-logcat.log"
adb logcat -d -b crash > "$FW_LIVE_DIR/session-crash.log"
fw devices > "$FW_LIVE_DIR/devices.txt"
fw ls > "$FW_LIVE_DIR/sessions.txt"
```

After typing `echo android_live_ok` from Android into the desktop-created
`shell`/`bash` session, reattach to that same daemon-owned PTY from a desktop
terminal and capture the replay transcript. This is the proof that the phone is
not screen mirroring and is seeing the same PTY state the laptop sees:

```sh
script -q "$FW_LIVE_DIR/terminal-replay.txt" fw attach shell
# Confirm android_live_ok is visible, then press Ctrl-B followed by D to detach.
```

After reattaching the same `shell`/`bash` session from Android, type the
high-volume flood command below, then capture a dedicated Android terminal view
and desktop replay transcript. The replay must contain 10000
`ANDROID_LIVE_FLOOD` output lines plus the completion marker:

```sh
printf 'ANDROID_LIVE_FLOOD_START\n'; yes ANDROID_LIVE_FLOOD | head -10000; printf 'ANDROID_LIVE_FLOOD_DONE\n'; printf 'flood_lines=10000\n'

adb exec-out screencap -p > "$FW_LIVE_DIR/flood.png"
adb shell uiautomator dump /sdcard/window.xml
adb pull /sdcard/window.xml "$FW_LIVE_DIR/flood-ui.xml"
adb logcat -d > "$FW_LIVE_DIR/flood-logcat.log"
adb logcat -d -b crash > "$FW_LIVE_DIR/flood-crash.log"
script -q "$FW_LIVE_DIR/flood-replay.txt" fw attach shell
# Confirm ANDROID_LIVE_FLOOD_DONE and flood_lines=10000 are visible, then detach.
```

After attaching the `refactoringjob` or generated default `claude` session from
Android, send a harmless `claude_live_ok` line, then capture dedicated Claude
evidence and a desktop reattach transcript for that same session:

```sh
adb exec-out screencap -p > "$FW_LIVE_DIR/claude.png"
adb shell uiautomator dump /sdcard/window.xml
adb pull /sdcard/window.xml "$FW_LIVE_DIR/claude-ui.xml"
adb logcat -d > "$FW_LIVE_DIR/claude-logcat.log"
adb logcat -d -b crash > "$FW_LIVE_DIR/claude-crash.log"
script -q "$FW_LIVE_DIR/claude-replay.txt" fw attach refactoringjob
# Confirm claude_live_ok is visible, then detach.
```

After resizing the Android terminal, type
`printf 'resize_size=%s\n' "$(stty size)"; echo after_resize_ok` from Android,
then capture:

```sh
adb exec-out screencap -p > "$FW_LIVE_DIR/resize.png"
adb shell uiautomator dump /sdcard/window.xml
adb pull /sdcard/window.xml "$FW_LIVE_DIR/resize-ui.xml"
adb logcat -d > "$FW_LIVE_DIR/resize-logcat.log"
adb logcat -d -b crash > "$FW_LIVE_DIR/resize-crash.log"
script -q "$FW_LIVE_DIR/resize-replay.txt" fw attach shell
# Confirm resize_size=<rows> <cols> or resize_size=<rows>x<cols> and after_resize_ok are visible, then detach.
```

After detaching from Android, capture the dashboard, reattach to the same shell
session from Android, type `echo after_detach_reattach_ok`, then capture the
desktop replay transcript:

```sh
adb exec-out screencap -p > "$FW_LIVE_DIR/detach.png"
adb shell uiautomator dump /sdcard/window.xml
adb pull /sdcard/window.xml "$FW_LIVE_DIR/detach-ui.xml"
adb logcat -d > "$FW_LIVE_DIR/detach-logcat.log"
adb logcat -d -b crash > "$FW_LIVE_DIR/detach-crash.log"
script -q "$FW_LIVE_DIR/detach-replay.txt" fw attach shell
# Confirm after_detach_reattach_ok is visible, then detach.
```

After attaching the TUI session (`vim` or `htop`), capture a dedicated TUI
evidence set. The UI dump must show the `Attached` terminal state plus visible
TUI terminal content such as `htop` function-key labels or a `vim` status line:

```sh
adb exec-out screencap -p > "$FW_LIVE_DIR/tui.png"
adb shell uiautomator dump /sdcard/window.xml
adb pull /sdcard/window.xml "$FW_LIVE_DIR/tui-ui.xml"
adb logcat -d > "$FW_LIVE_DIR/tui-logcat.log"
adb logcat -d -b crash > "$FW_LIVE_DIR/tui-crash.log"
```

For the state-preservation rows in the matrix, capture dedicated evidence sets
instead of relying on human notes. Use visible marker strings so the verifier can
prove the Android app rejoined the same daemon-owned PTY:

- Background/foreground: while the app is backgrounded, emit
  `ANDROID_BACKGROUND_REPLAY_OUTPUT` from the PTY, foreground the app, type
  `after_background_ok` from Android, then capture `background.png`,
  `background-ui.xml`, `background-logcat.log`, `background-crash.log`, and a
  desktop reattach transcript at `background-replay.txt`.
- Stale biometric resume: background the app for at least five minutes
  (`300000ms`), foreground it, tap `Unlock`, hold the phone so biometric
  authentication does not complete yet, try stale terminal input before unlock
  and verify it is blocked, then capture `stale-biometric.png`,
  `stale-biometric-ui.xml`, `stale-biometric-logcat.log`,
  `stale-biometric-crash.log`, and `stale-biometric.txt` containing
  `stale_background_ms=<elapsed-ms>` and `stale_input_before_unlock_blocked`.
- Network reconnect: toggle Wi-Fi or airplane mode, emit `NETWORK_REPLAY_OUTPUT`
  while disconnected, restore the network, type `after_reconnect_ok` from
  Android, record `reconnect_ms=<elapsed-ms>` in the transcript, and capture
  `reconnect.png`, `reconnect-ui.xml`, `reconnect-logcat.log`,
  `reconnect-crash.log`, and `reconnect-replay.txt`.
- Daemon restart restore: use a desktop-created `fw_restart_session` that has
  persisted `ANDROID_RESTART_SCROLLBACK`, restart the daemon, relaunch Android,
  open the restored session, and capture `restart.png`, `restart-ui.xml`,
  `restart-logcat.log`, `restart-crash.log`, and `restart-replay.txt`.
- Multi-session switching: use desktop-created `fwm_a`, `fwm_b`, and `fwm_c`
  sessions, switch among all three on Android, send `multi_a_ok`, `multi_b_ok`,
  and `multi_c_ok` only to their matching sessions, and capture
  `multisession.png`, `multisession-ui.xml`, `multisession-logcat.log`,
  `multisession-crash.log`, `multisession-a-replay.txt`,
  `multisession-b-replay.txt`, and `multisession-c-replay.txt`.

Each screenshot/UI/log/crash capture follows the same direct `adb` pattern as
the attached session evidence:

```sh
adb exec-out screencap -p > "$FW_LIVE_DIR/<name>.png"
adb shell uiautomator dump /sdcard/window.xml
adb pull /sdcard/window.xml "$FW_LIVE_DIR/<name>-ui.xml"
adb logcat -d > "$FW_LIVE_DIR/<name>-logcat.log"
adb logcat -d -b crash > "$FW_LIVE_DIR/<name>-crash.log"
```

After the required files are captured, run the local evidence verifier:

```sh
pnpm check:live-testing-evidence -- "$FW_LIVE_DIR"
```

This verifier does not replace human review of the phone behavior. It checks
that the direct `adb` evidence set is complete, screenshots are nontrivial
full-size Android PNGs,
`adb-devices.txt` shows at least one authorized connected device and no
unauthorized/offline/emulator/AVD device state,
the locked UI and freshly cleared locked-launch logcat did not expose or fetch
session, terminal, push-token, or input content before unlock, `biometric-ui.xml`
shows an Android biometric prompt with no session or terminal content behind it,
`stale-biometric-ui.xml` shows the same prompt after at least five minutes in
background and `stale-biometric.txt` proves stale terminal input was blocked
before unlock,
the paired run listed the expected desktop-created sessions, `pairing.txt` proves the desktop-side
QR payload, device-scan wait, explicit approval prompt, and approved completion,
records `pair_flow_ms=<elapsed-ms>` at or below 15000,
`subscription-ui.xml` shows the post-pair desktop-created `fw_live_sub` session,
`subscription-visible.txt` records `created_by_desktop_cli` plus
`visible_ms=<elapsed-ms>` at or below 2000, `subscription-replay.txt` contains
`subscription_attach_ok` from Android-originated input in the subscribed session,
the desktop replay transcript contains `android_live_ok` from the
Android-originated shell input,
`flood-ui.xml` shows the `ANDROID_LIVE_FLOOD` marker in the Android terminal
view and `flood-replay.txt` proves the Android-originated
`yes ANDROID_LIVE_FLOOD | head -10000` stream completed with
`flood_lines=10000` and at least 10000 replayed marker lines,
`claude-replay.txt` contains `claude_live_ok` from Android-originated input in a
dedicated Claude/default session transcript,
the captured UI dumps do not expose mobile session creation, session kill, or
command-selection controls,
`resize-replay.txt` contains a plausible `resize_size=<rows>x<cols>` or
`resize_size=<rows> <cols>` plus `after_resize_ok`, `detach-replay.txt` contains
`after_detach_reattach_ok`, the TUI attach
evidence shows real `vim`/`htop` terminal content in the Android terminal
surface, the background/foreground, network reconnect, daemon restart restore,
and multi-session switching transcripts contain the expected replay/no-leakage
markers, the network reconnect transcript records `reconnect_ms=<elapsed-ms>`
at or below 2000, and captured logs/crash buffers do not contain Fieldwork
fatal, ANR, or crash entries.

## Test Matrix

1. Locked launch shows only the unlock surface and no session or terminal
   content.
2. Biometric unlock is required before session list or terminal input.
3. QR pairing completes through explicit desktop approval.
4. Android dashboard lists the auto-named default `claude` session, the
   `refactoringjob` named shortcut session, and desktop-created `bash`,
   `claude`, and TUI sessions.
5. Create `fw_live_sub` from the desktop after pairing, verify it appears on the
   phone within 2 seconds, attach from Android, and verify
   `subscription_attach_ok` appears in a desktop replay.
6. Attach to `bash`, type `echo android_live_ok`, and verify the output appears.
7. Run `yes ANDROID_LIVE_FLOOD | head -10000` from Android in the same shell and
   verify the Android terminal view plus desktop replay keep all 10000 marker
   lines.
8. Attach to `claude`, send `claude_live_ok`, and verify the desktop can reattach
   to the same Claude/default session and see that output without affecting
   other sessions.
9. Attach to `vim` or `htop` and verify the TUI renders usable terminal state.
10. Resize the terminal and verify the PTY reports a plausible row/column size.
11. Detach and reattach; verify the terminal resumes from the latest seen offset.
12. Background the app while a PTY emits output, foreground it, and verify replay.
13. Leave the app backgrounded for at least five minutes, foreground it, and
    verify BiometricPrompt gates session access and stale terminal input.
14. Toggle Wi-Fi or airplane mode, reconnect within the release target, and
   verify missed output replays.
15. Restart the daemon, relaunch Android, and verify last-known sessions and
    scrollback are listed while exited processes are documented as exited.
16. Open three sessions and switch among them; verify no output crosses sessions.

## Pass Criteria

- No Fieldwork `FATAL EXCEPTION`, app ANR, or crash-buffer entry in captured
  logs.
- Session list and terminal attach are gated by biometric unlock.
- Five-minute stale resume gates session access and terminal input behind
  BiometricPrompt.
- Mobile never creates or kills sessions and never chooses commands.
- Raw terminal output remains session-correct across attach, background,
  reconnect, daemon restart, and multi-session switching.
- Any failed step has a screenshot, UI dump, logcat, command transcript, and
  exact reproduction notes.

## After The Run

If the run passes, update the matching physical-device rows in `PLAN.md` with
the exact evidence paths, then update `docs/RELEASE_AUDIT.md` and rerun:

```sh
pnpm check:release-audit
pnpm check:docs-sync
pnpm check:live-testing-evidence -- "$FW_LIVE_DIR"
pnpm check:release-audit:list
```

Do not check provider-push, signing, publish, store-console, iOS, domain, or
operator-reservation boxes from this round unless that exact real evidence was
also produced.
