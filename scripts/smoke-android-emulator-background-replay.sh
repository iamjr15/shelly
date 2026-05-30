#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
package="app.fieldwork.android"
activity="$package/.MainActivity"
fieldwork="${FIELDWORK_CLI_BINARY:-$root/target/release/fieldwork}"
fieldworkd="${FIELDWORK_DAEMON_BINARY:-$root/target/release/fieldworkd}"
iroh_relay_url="${FIELDWORK_ANDROID_IROH_RELAY_URL:-}"
relay_control_url="${FIELDWORK_ANDROID_RELAY_CONTROL_URL:-${FIELDWORK_RELAY_CONTROL_URL:-}}"
relay_signing_key="${FIELDWORK_RELAY_SIGNING_KEY_B64:-BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc}"

if [[ ! -x "$fieldwork" || ! -x "$fieldworkd" ]]; then
  echo "Expected executable release binaries at $fieldwork and $fieldworkd." >&2
  exit 1
fi

if [[ -n "${FIELDWORK_ANDROID_SERIAL:-}" ]]; then
  serial="$FIELDWORK_ANDROID_SERIAL"
else
  devices=()
  while IFS= read -r device; do
    devices+=("$device")
  done < <(adb devices | awk 'NR > 1 && $2 == "device" { print $1 }')
  if [[ "${#devices[@]}" -ne 1 ]]; then
    echo "Expected exactly one booted adb device, found ${#devices[@]}. Set FIELDWORK_ANDROID_SERIAL to choose one." >&2
    adb devices >&2
    exit 1
  fi
  serial="${devices[0]}"
fi

boot_completed="$(adb -s "$serial" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')"
if [[ "$boot_completed" != "1" ]]; then
  echo "Android device $serial is not boot-complete." >&2
  exit 1
fi

dump_ui() {
  local out="$1"
  local tmp="$out.tmp"
  rm -f "$tmp"
  if python3 - "$serial" "$tmp" <<'PY'
import subprocess
import sys

serial, out = sys.argv[1], sys.argv[2]
with open(out, "wb") as stdout:
    try:
        completed = subprocess.run(
            ["adb", "-s", serial, "exec-out", "uiautomator", "dump", "/dev/tty"],
            stdout=stdout,
            timeout=8,
        )
    except subprocess.TimeoutExpired:
        raise SystemExit(124)
raise SystemExit(completed.returncode)
PY
  then
    mv "$tmp" "$out"
    return 0
  fi
  rm -f "$tmp"
  return 1
}

tap_text_node() {
  local ui_file="$1"
  local text="$2"
  local coords_file="$tmp_dir/tap-${text//[^A-Za-z0-9]/_}.txt"
  python3 - "$ui_file" "$text" >"$coords_file" <<'PY'
import re
import sys
import xml.etree.ElementTree as ET

text = open(sys.argv[1], encoding="utf-8").read()
target = sys.argv[2]
end = text.find("</hierarchy>")
if end >= 0:
    text = text[:end + len("</hierarchy>")]
root = ET.fromstring(text)
for node in root.iter("node"):
    if node.attrib.get("text") == target:
        left, top, right, bottom = map(int, re.findall(r"\d+", node.attrib["bounds"]))
        print((left + right) // 2, (top + bottom) // 2)
        raise SystemExit(0)
raise SystemExit(f"{target!r} not found")
PY
  local tap_x tap_y
  read -r tap_x tap_y <"$coords_file"
  adb -s "$serial" shell input tap "$tap_x" "$tap_y"
}

tap_content_desc_node() {
  local ui_file="$1"
  local description="$2"
  local coords_file="$tmp_dir/tap-desc-${description//[^A-Za-z0-9]/_}.txt"
  python3 - "$ui_file" "$description" >"$coords_file" <<'PY'
import re
import sys
import xml.etree.ElementTree as ET

text = open(sys.argv[1], encoding="utf-8").read()
target = sys.argv[2]
end = text.find("</hierarchy>")
if end >= 0:
    text = text[:end + len("</hierarchy>")]
root = ET.fromstring(text)
for node in root.iter("node"):
    if node.attrib.get("content-desc") == target:
        left, top, right, bottom = map(int, re.findall(r"\d+", node.attrib["bounds"]))
        print((left + right) // 2, (top + bottom) // 2)
        raise SystemExit(0)
raise SystemExit(f"{target!r} not found")
PY
  local tap_x tap_y
  read -r tap_x tap_y <"$coords_file"
  adb -s "$serial" shell input tap "$tap_x" "$tap_y"
}

tap_session_card() {
  local ui_file="$1"
  local coords_file="$tmp_dir/session-card-coords.txt"
  python3 - "$ui_file" >"$coords_file" <<'PY'
import re
import sys
import xml.etree.ElementTree as ET

text = open(sys.argv[1], encoding="utf-8").read()
end = text.find("</hierarchy>")
if end >= 0:
    text = text[:end + len("</hierarchy>")]
root = ET.fromstring(text)

def center(bounds):
    left, top, right, bottom = map(int, re.findall(r"\d+", bounds))
    return (left + right) // 2, (top + bottom) // 2

def has_session_marker(node):
    return any(
        child.attrib.get("text") in {"fw_background_session", "ANDROID_BACKGROUND_READY"}
        for child in node.iter()
    )

for node in root.iter("node"):
    bounds = node.attrib.get("bounds", "")
    values = list(map(int, re.findall(r"\d+", bounds)))
    if len(values) != 4:
        continue
    width = values[2] - values[0]
    if (
        node.attrib.get("clickable") == "true"
        and node.attrib.get("enabled") == "true"
        and width > 500
        and has_session_marker(node)
    ):
        print(*center(bounds))
        raise SystemExit(0)

raise SystemExit("session card not found")
PY
  local tap_x tap_y
  read -r tap_x tap_y <"$coords_file"
  adb -s "$serial" shell input tap "$tap_x" "$tap_y"
}

wait_for_input_log() {
  local marker="$1"
  for _ in {1..120}; do
    if [[ -f "$session_input_log" ]] && grep -q "$marker" "$session_input_log"; then
      return 0
    fi
    sleep 0.25
  done
  echo "Timed out waiting for PTY input marker $marker." >&2
  [[ -f "$session_input_log" ]] && cat "$session_input_log" >&2
  return 1
}

tmp_parent="${FIELDWORK_ANDROID_BACKGROUND_TMPDIR:-/tmp}"
tmp_dir="$(mktemp -d "${tmp_parent%/}/fw-ab.XXXXXX")"
home="$tmp_dir/home"
run="$tmp_dir/run"
bin="$tmp_dir/bin"
session_input_log="$tmp_dir/session-input.log"
mkdir -p "$home" "$run" "$bin"
chmod 700 "$tmp_dir" "$home" "$run"

daemon_pid=""
pair_pid=""
verifier_pid=""
cleanup() {
  local status=$?
  set +e
  if [[ -n "$verifier_pid" ]]; then
    kill "$verifier_pid" 2>/dev/null || true
    wait "$verifier_pid" 2>/dev/null || true
  fi
  if [[ -n "$pair_pid" ]]; then
    kill "$pair_pid" 2>/dev/null || true
    wait "$pair_pid" 2>/dev/null || true
  fi
  if [[ -n "$daemon_pid" ]]; then
    kill "$daemon_pid" 2>/dev/null || true
    wait "$daemon_pid" 2>/dev/null || true
  fi
  exec 3>&- 2>/dev/null || true
  exec 4>&- 2>/dev/null || true
  if [[ "$status" -ne 0 && "${FIELDWORK_KEEP_ANDROID_BACKGROUND_TMP:-}" == "true" ]]; then
    echo "Preserving Android emulator background smoke state at $tmp_dir" >&2
  else
    adb -s "$serial" shell am force-stop "$package" >/dev/null 2>&1 || true
    adb -s "$serial" shell pm clear "$package" >/dev/null 2>&1 || true
    rm -rf "$tmp_dir"
  fi
}
trap cleanup EXIT

cat >"$bin/fw_background_session" <<EOF
#!/usr/bin/env bash
printf 'ANDROID_BACKGROUND_READY\n'
while IFS= read -r line; do
  printf '%s\n' "\$line" >> "$session_input_log"
  printf 'android-background: %s\n' "\$line"
  if [[ "\$line" == "trigger_background_output" ]]; then
    (
      sleep 3
      printf 'ANDROID_BACKGROUND_REPLAY_OUTPUT\n'
    ) &
  fi
done
EOF
chmod +x "$bin/fw_background_session"

desktop_env() {
  env \
    HOME="$home" \
    XDG_RUNTIME_DIR="$run" \
    PATH="$bin:$PATH" \
    FIELDWORK_IROH_SECRET_KEY_B64=MTIzNDU2Nzg5MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTI \
    FIELDWORK_IROH_RELAY_URL="$iroh_relay_url" \
    FIELDWORK_RELAY_CONTROL_URL="$relay_control_url" \
    FIELDWORK_RELAY_SIGNING_KEY_B64="$relay_signing_key" \
    FIELDWORK_SCROLLBACK_ENCRYPTION_ENABLED=false \
    "$@"
}

desktop_env "$fieldworkd" >"$tmp_dir/daemon.log" 2>&1 &
daemon_pid=$!

socket="$run/fieldwork/control.sock"
for _ in {1..100}; do
  if [[ -S "$socket" ]]; then
    break
  fi
  sleep 0.1
done
if [[ ! -S "$socket" ]]; then
  echo "fieldworkd did not create $socket" >&2
  cat "$tmp_dir/daemon.log" >&2 || true
  exit 1
fi

for _ in {1..100}; do
  if grep -q "iroh transport address refreshed" "$tmp_dir/daemon.log"; then
    break
  fi
  sleep 0.1
done

desktop_env "$fieldwork" new fw_background_session >"$tmp_dir/new-session.log"

mkfifo "$tmp_dir/pair.in"
exec 3<>"$tmp_dir/pair.in"
desktop_env "$fieldwork" pair <"$tmp_dir/pair.in" >"$tmp_dir/pair.log" 2>&1 &
pair_pid=$!

pairing_code=""
for _ in {1..100}; do
  pairing_code="$(grep -A1 'enter this code:' "$tmp_dir/pair.log" | tail -n1 | tr -d '[:space:]' || true)"
  if [[ -n "$pairing_code" ]]; then
    break
  fi
  sleep 0.1
done
if [[ -z "$pairing_code" ]]; then
  echo "fieldwork pair did not print a 5-char pairing code" >&2
  cat "$tmp_dir/pair.log" >&2 || true
  exit 1
fi
if [[ -z "$relay_control_url" ]]; then
  echo "Android emulator background smoke needs FIELDWORK_ANDROID_RELAY_CONTROL_URL set so the app can resolve the typed pairing code." >&2
  exit 1
fi

FIELDWORK_ANDROID_BIOMETRIC_BYPASS=true \
FIELDWORK_ANDROID_PAIRING_CODE="$pairing_code" \
FIELDWORK_RELAY_CONTROL_URL="$relay_control_url" \
  "$root/apps/android/gradlew" --no-daemon :app:installDebug >"$tmp_dir/install-debug.log"

adb -s "$serial" shell pm clear "$package" >/dev/null
adb -s "$serial" shell pm grant "$package" android.permission.CAMERA >/dev/null 2>&1 || true
adb -s "$serial" shell pm grant "$package" android.permission.POST_NOTIFICATIONS >/dev/null 2>&1 || true
adb -s "$serial" logcat -c
adb -s "$serial" logcat -b crash -c
adb -s "$serial" shell am force-stop "$package"
adb -s "$serial" shell am start -W -n "$activity" >"$tmp_dir/launch.log"

if ! grep -q '^Status: ok$' "$tmp_dir/launch.log"; then
  echo "Android emulator background smoke launch did not report Status: ok" >&2
  cat "$tmp_dir/launch.log" >&2
  exit 1
fi

sleep 2
ui_xml="$tmp_dir/ui-before-pair.xml"
for _ in {1..60}; do
  if ! dump_ui "$ui_xml"; then
    sleep 1
    continue
  fi
  if grep -q 'text="Pairing code"' "$ui_xml"; then
    break
  fi
  if grep -Eq "System UI isn't responding|Application Not Responding|Process system isn't responding" "$ui_xml"; then
    tap_text_node "$ui_xml" "Wait" || true
    sleep 2
    continue
  fi
  sleep 1
done
if ! grep -q 'text="Pairing code"' "$ui_xml"; then
  echo "Android emulator background smoke did not reach the pairing screen." >&2
  sed -n '1,120p' "$ui_xml" >&2 || true
  exit 1
fi

read -r pair_x pair_y < <(python3 "$root/scripts/pick-android-pair-button.py" "$ui_xml")

adb -s "$serial" shell input tap "$pair_x" "$pair_y"

for _ in {1..600}; do
  if grep -q 'approve?' "$tmp_dir/pair.log"; then
    break
  fi
  sleep 0.1
done
if ! grep -q 'approve?' "$tmp_dir/pair.log"; then
  echo "desktop did not receive Android pairing approval request" >&2
  cat "$tmp_dir/pair.log" >&2 || true
  cat "$tmp_dir/daemon.log" >&2 || true
  adb -s "$serial" logcat -d | grep -E "FieldworkRepository|FATAL EXCEPTION|ANR in $package|app.fieldwork.android" >&2 || true
  exit 1
fi

printf 'y\n' >&3
wait "$pair_pid"
pair_pid=""

if ! grep -q 'Approved. Device is paired.' "$tmp_dir/pair.log"; then
  echo "desktop pairing did not complete" >&2
  cat "$tmp_dir/pair.log" >&2 || true
  exit 1
fi

paired_ui="$tmp_dir/ui-after-pair.xml"
for _ in {1..60}; do
  if ! dump_ui "$paired_ui"; then
    sleep 1
    continue
  fi
  if grep -q 'text="OK"' "$paired_ui"; then
    tap_text_node "$paired_ui" "OK" || true
    sleep 1
    continue
  fi
  if grep -q 'text="No sessions"' "$paired_ui"; then
    tap_content_desc_node "$paired_ui" "Refresh" || true
    sleep 1
    continue
  fi
  if grep -Eq 'text="fw_background_session|ANDROID_BACKGROUND_READY' "$paired_ui" && ! grep -q 'text="No sessions"' "$paired_ui"; then
    break
  fi
  sleep 1
done

if ! grep -Eq 'text="fw_background_session|ANDROID_BACKGROUND_READY' "$paired_ui" || grep -q 'text="No sessions"' "$paired_ui"; then
  echo "Android emulator background smoke did not show the desktop-created session." >&2
  cat "$tmp_dir/new-session.log" >&2 || true
  desktop_env "$fieldwork" ls >"$tmp_dir/local-sessions.log" 2>&1 || true
  cat "$tmp_dir/local-sessions.log" >&2 || true
  adb -s "$serial" logcat -d | grep -E "FieldworkRepository|FATAL EXCEPTION|ANR in $package|app.fieldwork.android" >&2 || true
  exit 1
fi

tap_session_card "$paired_ui"

terminal_ui="$tmp_dir/ui-terminal.xml"
for _ in {1..60}; do
  if ! dump_ui "$terminal_ui"; then
    sleep 1
    continue
  fi
  if grep -q 'text="Attached"' "$terminal_ui" && grep -q 'fw_background_session' "$terminal_ui"; then
    break
  fi
  sleep 1
done

if ! grep -q 'text="Attached"' "$terminal_ui" || ! grep -q 'fw_background_session' "$terminal_ui"; then
  echo "Android emulator background smoke did not attach to the desktop-created terminal session." >&2
  sed -n '1,120p' "$terminal_ui" >&2 || true
  adb -s "$serial" logcat -d | grep -E "FieldworkRepository|FATAL EXCEPTION|ANR in $package|app.fieldwork.android" >&2 || true
  exit 1
fi

adb -s "$serial" shell input tap 540 1200
adb -s "$serial" shell input text before_background_ok
adb -s "$serial" shell input keyevent ENTER
wait_for_input_log before_background_ok

adb -s "$serial" shell input tap 540 1200
adb -s "$serial" shell input text trigger_background_output
adb -s "$serial" shell input keyevent ENTER
wait_for_input_log trigger_background_output

adb -s "$serial" shell input keyevent 3
sleep 5

adb -s "$serial" shell am start -W -n "$activity" >"$tmp_dir/relaunch.log"
if ! grep -q '^Status: ok$' "$tmp_dir/relaunch.log"; then
  echo "Android emulator background smoke relaunch did not report Status: ok." >&2
  cat "$tmp_dir/relaunch.log" >&2 || true
  exit 1
fi

for _ in {1..60}; do
  if ! dump_ui "$terminal_ui"; then
    sleep 1
    continue
  fi
  if grep -q 'text="Attached"' "$terminal_ui" && grep -q 'fw_background_session' "$terminal_ui"; then
    break
  fi
  sleep 1
done
if ! grep -q 'text="Attached"' "$terminal_ui" || ! grep -q 'fw_background_session' "$terminal_ui"; then
  echo "Android emulator background smoke terminal did not return to Attached after foreground." >&2
  sed -n '1,120p' "$terminal_ui" >&2 || true
  exit 1
fi

adb -s "$serial" shell input tap 540 1200
adb -s "$serial" shell input text after_background_ok
adb -s "$serial" shell input keyevent ENTER
wait_for_input_log after_background_ok

mkfifo "$tmp_dir/verifier-pair.in"
exec 4<>"$tmp_dir/verifier-pair.in"
desktop_env "$fieldwork" pair <"$tmp_dir/verifier-pair.in" >"$tmp_dir/verifier-pair.log" 2>&1 &
pair_pid=$!

verifier_code=""
for _ in {1..100}; do
  verifier_code="$(grep -A1 'enter this code:' "$tmp_dir/verifier-pair.log" | tail -n1 | tr -d '[:space:]' || true)"
  if [[ -n "$verifier_code" ]]; then
    break
  fi
  sleep 0.1
done
if [[ -z "$verifier_code" ]]; then
  echo "Android emulator background smoke could not create verifier pairing code." >&2
  cat "$tmp_dir/verifier-pair.log" >&2 || true
  exit 1
fi

desktop_env "$fieldwork" pair-test \
  --code "$verifier_code" \
  --relay-control-url "$relay_control_url" \
  --name android-background-verifier \
  --attach first \
  --expect-output "android-background: before_background_ok" \
  --expect-output "ANDROID_BACKGROUND_REPLAY_OUTPUT" \
  --expect-output "android-background: after_background_ok" \
  --secret-key-path "$tmp_dir/verifier-secret.key" \
  >"$tmp_dir/verifier.log" 2>&1 &
verifier_pid=$!

for _ in {1..600}; do
  if grep -q 'approve?' "$tmp_dir/verifier-pair.log"; then
    break
  fi
  sleep 0.1
done
if ! grep -q 'approve?' "$tmp_dir/verifier-pair.log"; then
  echo "desktop did not receive verifier pairing approval request" >&2
  cat "$tmp_dir/verifier-pair.log" >&2 || true
  cat "$tmp_dir/verifier.log" >&2 || true
  adb -s "$serial" logcat -d | grep -E "FieldworkRepository|FATAL EXCEPTION|ANR in $package|app.fieldwork.android" >&2 || true
  exit 1
fi

printf 'y\n' >&4
wait "$pair_pid"
pair_pid=""

if ! wait "$verifier_pid"; then
  verifier_pid=""
  echo "Android emulator background smoke did not verify replayed background output." >&2
  cat "$tmp_dir/verifier-pair.log" >&2 || true
  cat "$tmp_dir/verifier.log" >&2 || true
  adb -s "$serial" exec-out screencap -p >"$tmp_dir/android-background-failure.png" || true
  adb -s "$serial" logcat -d | grep -E "FieldworkRepository|FATAL EXCEPTION|ANR in $package|app.fieldwork.android" >&2 || true
  exit 1
fi
verifier_pid=""

crash_log="$tmp_dir/crash.log"
adb -s "$serial" logcat -d -b crash >"$crash_log"
if grep -q "$package" "$crash_log"; then
  echo "Android emulator background smoke found $package in the crash log." >&2
  tail -120 "$crash_log" >&2
  exit 1
fi

full_log="$tmp_dir/logcat.log"
adb -s "$serial" logcat -d >"$full_log"
if grep -Eq "FATAL EXCEPTION.*$package|ANR in $package|am_crash.*$package|am_anr.*$package" "$full_log"; then
  echo "Android emulator background smoke found a Fieldwork crash or ANR in logcat." >&2
  grep -E "FATAL EXCEPTION.*$package|ANR in $package|am_crash.*$package|am_anr.*$package" "$full_log" >&2
  exit 1
fi

echo "android emulator background replay smoke ok: serial=$serial"
