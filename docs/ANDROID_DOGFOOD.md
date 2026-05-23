# Android Renderer Dogfood

This runbook is the Section 7.6 physical Android terminal renderer decision
gate. It is Android-only and does not cover iOS, provider push, store
submission, npm publish, signing, domains, or hosted relay deployment.

The purpose is to decide whether the v1 Android app ships with
`connectbot/termlib`: pair a physical Android phone, attach to a live
daemon-owned `claude` session, type, scroll, resize, and paste for at least
30 minutes. The phone must only list and attach. It must not create sessions,
kill sessions, or choose commands.

## Prerequisites

- Exactly one physical Android phone with biometrics enrolled.
- Android app installed from the current checkout or release candidate.
- `FIELDWORK_BIOMETRIC_BYPASS = false`.
- `FIELDWORK_DEBUG_PAIRING_PAYLOAD = ""`.
- Local desktop `fieldwork`/`fw` and `fieldworkd` available.

USB debugging is not an end-user requirement. It is used here only to capture
direct QA evidence with `adb`.

Evidence must contain no Android fatal/ANR logcat entries, no Android system
not-responding overlays, and empty crash buffers after `adb logcat -c`.

## Setup

```sh
export FW_DOGFOOD_DIR="/tmp/fieldwork-android-dogfood-$(date +%Y%m%d%H%M%S)"
mkdir -p "$FW_DOGFOOD_DIR"

adb devices -l | tee "$FW_DOGFOOD_DIR/adb-devices.txt"
rg 'APPLICATION_ID = "app\.fieldwork\.android"|BUILD_TYPE = "(debug|release)"|FIELDWORK_BIOMETRIC_BYPASS = false|FIELDWORK_DEBUG_PAIRING_PAYLOAD = ""' \
  apps/android/app/build/generated/source/buildConfig/debug/app/fieldwork/android/BuildConfig.java \
  | tee "$FW_DOGFOOD_DIR/buildconfig.txt"

fw daemon start
fw refactoringjob
```

Pair the physical phone through the normal QR scanner and explicit desktop
approval. Open `refactoringjob` or another desktop-created `claude` session
from Android.

## Required Evidence

Start the timer after the Android app is attached to the live `claude` session:

```sh
dogfood_started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
dogfood_start_ms="$(node -e 'console.log(Date.now())')"
```

Capture the attached Claude surface:

```sh
adb exec-out screencap -p > "$FW_DOGFOOD_DIR/claude.png"
adb shell uiautomator dump /sdcard/window.xml
adb pull /sdcard/window.xml "$FW_DOGFOOD_DIR/claude-ui.xml"
adb logcat -d > "$FW_DOGFOOD_DIR/claude-logcat.log"
adb logcat -d -b crash > "$FW_DOGFOOD_DIR/claude-crash.log"
```

Type `dogfood_typing_ok` from Android, then prove the desktop can reattach to
the same session and see it:

```sh
script -q "$FW_DOGFOOD_DIR/typing-replay.txt" fw attach refactoringjob
# Confirm dogfood_typing_ok is visible, then detach.
```

Generate scroll markers from Android and physically scroll through the terminal
surface:

```sh
printf 'DOGFOOD_SCROLL_TOP\n'; seq 1 120; printf 'DOGFOOD_SCROLL_BOTTOM\n'

adb exec-out screencap -p > "$FW_DOGFOOD_DIR/scroll.png"
adb shell uiautomator dump /sdcard/window.xml
adb pull /sdcard/window.xml "$FW_DOGFOOD_DIR/scroll-ui.xml"
adb logcat -d > "$FW_DOGFOOD_DIR/scroll-logcat.log"
adb logcat -d -b crash > "$FW_DOGFOOD_DIR/scroll-crash.log"
script -q "$FW_DOGFOOD_DIR/scroll-replay.txt" fw attach refactoringjob
printf 'scroll_verified_by_operator\n' >> "$FW_DOGFOOD_DIR/scroll-replay.txt"
```

Resize the Android terminal and type the size probe from Android:

```sh
printf 'resize_size=%s\n' "$(stty size)"; echo dogfood_resize_ok

adb exec-out screencap -p > "$FW_DOGFOOD_DIR/resize.png"
adb shell uiautomator dump /sdcard/window.xml
adb pull /sdcard/window.xml "$FW_DOGFOOD_DIR/resize-ui.xml"
adb logcat -d > "$FW_DOGFOOD_DIR/resize-logcat.log"
adb logcat -d -b crash > "$FW_DOGFOOD_DIR/resize-crash.log"
script -q "$FW_DOGFOOD_DIR/resize-replay.txt" fw attach refactoringjob
```

Paste a multi-line block from Android:

```sh
cat <<'EOF'
DOGFOOD_PASTE_BEGIN
dogfood_paste_line_001
dogfood_paste_line_002
dogfood_paste_line_003
dogfood_paste_line_004
dogfood_paste_line_005
dogfood_paste_line_006
dogfood_paste_line_007
dogfood_paste_line_008
dogfood_paste_line_009
dogfood_paste_line_010
dogfood_paste_line_011
dogfood_paste_line_012
dogfood_paste_line_013
dogfood_paste_line_014
dogfood_paste_line_015
dogfood_paste_line_016
dogfood_paste_line_017
dogfood_paste_line_018
dogfood_paste_line_019
dogfood_paste_line_020
DOGFOOD_PASTE_END
dogfood_paste_ok
EOF

adb exec-out screencap -p > "$FW_DOGFOOD_DIR/paste.png"
adb shell uiautomator dump /sdcard/window.xml
adb pull /sdcard/window.xml "$FW_DOGFOOD_DIR/paste-ui.xml"
adb logcat -d > "$FW_DOGFOOD_DIR/paste-logcat.log"
adb logcat -d -b crash > "$FW_DOGFOOD_DIR/paste-crash.log"
script -q "$FW_DOGFOOD_DIR/paste-replay.txt" fw attach refactoringjob
```

After at least 30 minutes of physical use, capture the final timing and logs:

```sh
dogfood_finished_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
dogfood_end_ms="$(node -e 'console.log(Date.now())')"
{
  printf 'dogfood_started_at=%s\n' "$dogfood_started_at"
  printf 'dogfood_finished_at=%s\n' "$dogfood_finished_at"
  printf 'dogfood_duration_ms=%s\n' "$((dogfood_end_ms - dogfood_start_ms))"
  printf 'termlib_decision_candidate=pass\n'
} | tee "$FW_DOGFOOD_DIR/dogfood-duration.txt"

adb logcat -d > "$FW_DOGFOOD_DIR/final-logcat.log"
adb logcat -d -b crash > "$FW_DOGFOOD_DIR/final-crash.log"
```

Run the local evidence verifier:

```sh
pnpm check:android-dogfood-evidence -- "$FW_DOGFOOD_DIR"
```

The verifier checks physical-device adb evidence, normal app BuildConfig,
30-minute minimum duration, attached Claude UI, typing, scroll, resize, paste,
and clean Android evidence. Passing the verifier does not
replace human review; the operator must still confirm the terminal remained
usable for the full dogfood window before checking the `PLAN.md` gate.
