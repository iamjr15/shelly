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
node scripts/verify-release-audit.mjs --list-unchecked
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
rg 'FIELDWORK_BIOMETRIC_BYPASS = false|FIELDWORK_DEBUG_PAIRING_PAYLOAD = ""' \
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
fw pair
```

The bare `fw` command must create and attach a default `claude` session with a
generated one-word name such as `waffle` or `kazoo`. Press `Ctrl-B` then `D` to
detach after confirming the generated name. The `fw refactoringjob` command must
create or attach that named default `claude` session. Confirm both the generated
name and `refactoringjob` appear as active sessions in the Android dashboard
after pairing; the phone should still only list and attach, never create or
choose commands.

Approve the pairing only after the phone scans the QR payload and the CLI asks
for explicit confirmation.

## Evidence Capture

Create a timestamped evidence directory:

```sh
export FW_LIVE_DIR="/tmp/fieldwork-live-$(date +%Y%m%d%H%M%S)"
mkdir -p "$FW_LIVE_DIR"
```

Capture the locked launch surface:

```sh
adb shell am force-stop app.fieldwork.android
adb logcat -c
adb shell am start -W app.fieldwork.android/.MainActivity | tee "$FW_LIVE_DIR/launch.txt"
adb exec-out screencap -p > "$FW_LIVE_DIR/locked.png"
adb shell uiautomator dump /sdcard/window.xml
adb pull /sdcard/window.xml "$FW_LIVE_DIR/locked-ui.xml"
adb logcat -d > "$FW_LIVE_DIR/locked-logcat.log"
adb logcat -d -b crash > "$FW_LIVE_DIR/locked-crash.log"
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

After the required files are captured, run the local evidence verifier:

```sh
pnpm check:live-testing-evidence -- "$FW_LIVE_DIR"
```

This verifier does not replace human review of the phone behavior. It checks
that the direct `adb` evidence set is complete, screenshots are nontrivial PNGs,
the locked UI did not expose session or terminal content, the paired run listed
the expected desktop-created sessions, the TUI attach evidence shows real
`vim`/`htop` terminal content in the Android terminal surface, and captured
logs/crash buffers do
not contain Fieldwork fatal, ANR, or crash entries.

## Test Matrix

1. Locked launch shows only the unlock surface and no session or terminal
   content.
2. Biometric unlock is required before session list or terminal input.
3. QR pairing completes through explicit desktop approval.
4. Android dashboard lists the auto-named default `claude` session, the
   `refactoringjob` named shortcut session, and desktop-created `bash`,
   `claude`, and TUI sessions.
5. Attach to `bash`, type `echo android_live_ok`, and verify the output appears.
6. Attach to `claude`, send a harmless line, and verify input/output does not
   affect the other sessions.
7. Attach to `vim` or `htop` and verify the TUI renders usable terminal state.
8. Background the app while a PTY emits output, foreground it, and verify replay.
9. Toggle Wi-Fi or airplane mode, reconnect within the release target, and
   verify missed output replays.
10. Restart the daemon, relaunch Android, and verify last-known sessions and
    scrollback are listed while exited processes are documented as exited.
11. Open three sessions and switch among them; verify no output crosses sessions.
12. Detach and reattach; verify the terminal resumes from the latest seen offset.

## Pass Criteria

- No Fieldwork `FATAL EXCEPTION`, app ANR, or crash-buffer entry in captured
  logs.
- Session list and terminal attach are gated by biometric unlock.
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
node scripts/verify-release-audit.mjs --list-unchecked
```

Do not check provider-push, signing, publish, store-console, iOS, domain, or
operator-reservation boxes from this round unless that exact real evidence was
also produced.
