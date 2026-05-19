#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
package="app.fieldwork.android"
activity="$package/.MainActivity"
fieldwork="${FIELDWORK_CLI_BINARY:-$root/target/release/fieldwork}"
fieldworkd="${FIELDWORK_DAEMON_BINARY:-$root/target/release/fieldworkd}"
iroh_relay_url="${FIELDWORK_ANDROID_IROH_RELAY_URL:-https://aps1-1.relay.n0.iroh-canary.iroh.link./}"

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
  local marker="$2"
  local coords_file="$tmp_dir/session-card-${marker//[^A-Za-z0-9]/_}.txt"
  python3 - "$ui_file" "$marker" >"$coords_file" <<'PY'
import re
import sys
import xml.etree.ElementTree as ET

text = open(sys.argv[1], encoding="utf-8").read()
marker = sys.argv[2]
end = text.find("</hierarchy>")
if end >= 0:
    text = text[:end + len("</hierarchy>")]
root = ET.fromstring(text)

def center(bounds):
    left, top, right, bottom = map(int, re.findall(r"\d+", bounds))
    return (left + right) // 2, (top + bottom) // 2

def has_marker(node):
    return any(marker in child.attrib.get("text", "") for child in node.iter())

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
        and has_marker(node)
    ):
        print(*center(bounds))
        raise SystemExit(0)

raise SystemExit(f"session card not found for {marker}")
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

tmp_parent="${FIELDWORK_ANDROID_SUBSCRIBE_TMPDIR:-/tmp}"
tmp_dir="$(mktemp -d "${tmp_parent%/}/fw-as.XXXXXX")"
home="$tmp_dir/home"
run="$tmp_dir/run"
bin="$tmp_dir/bin"
session_input_log="$tmp_dir/session-input.log"
mkdir -p "$home" "$run" "$bin"
chmod 700 "$tmp_dir" "$home" "$run"

daemon_pid=""
pair_pid=""
cleanup() {
  local status=$?
  set +e
  if [[ -n "$pair_pid" ]]; then
    kill "$pair_pid" 2>/dev/null || true
    wait "$pair_pid" 2>/dev/null || true
  fi
  if [[ -n "$daemon_pid" ]]; then
    kill "$daemon_pid" 2>/dev/null || true
    wait "$daemon_pid" 2>/dev/null || true
  fi
  exec 3>&- 2>/dev/null || true
  if [[ "$status" -ne 0 && "${FIELDWORK_KEEP_ANDROID_SUBSCRIBE_TMP:-}" == "true" ]]; then
    echo "Preserving Android emulator session-subscription smoke state at $tmp_dir" >&2
  else
    adb -s "$serial" shell am force-stop "$package" >/dev/null 2>&1 || true
    adb -s "$serial" shell pm clear "$package" >/dev/null 2>&1 || true
    rm -rf "$tmp_dir"
  fi
}
trap cleanup EXIT

cat >"$bin/fw_subscribe_session" <<EOF
#!/usr/bin/env bash
printf 'ANDROID_SUBSCRIBE_READY\n'
while IFS= read -r line; do
  printf '%s\n' "\$line" >> "$session_input_log"
  printf 'android-subscribe: %s\n' "\$line"
done
EOF
chmod +x "$bin/fw_subscribe_session"

desktop_env() {
  env \
    HOME="$home" \
    XDG_RUNTIME_DIR="$run" \
    PATH="$bin:$PATH" \
    FIELDWORK_IROH_SECRET_KEY_B64=MTIzNDU2Nzg5MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTI \
    FIELDWORK_IROH_RELAY_URL="$iroh_relay_url" \
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

mkfifo "$tmp_dir/pair.in"
exec 3<>"$tmp_dir/pair.in"
desktop_env "$fieldwork" pair <"$tmp_dir/pair.in" >"$tmp_dir/pair.log" 2>&1 &
pair_pid=$!

payload=""
for _ in {1..100}; do
  payload="$(grep -m1 '^{' "$tmp_dir/pair.log" || true)"
  if [[ -n "$payload" ]]; then
    break
  fi
  sleep 0.1
done
if [[ -z "$payload" ]]; then
  echo "fieldwork pair did not print a JSON payload" >&2
  cat "$tmp_dir/pair.log" >&2 || true
  exit 1
fi

FIELDWORK_ANDROID_BIOMETRIC_BYPASS=true \
FIELDWORK_ANDROID_PAIRING_PAYLOAD="$payload" \
  "$root/apps/android/gradlew" --no-daemon :app:installDebug >"$tmp_dir/install-debug.log"

adb -s "$serial" shell pm clear "$package" >/dev/null
adb -s "$serial" shell pm grant "$package" android.permission.CAMERA >/dev/null 2>&1 || true
adb -s "$serial" shell pm grant "$package" android.permission.POST_NOTIFICATIONS >/dev/null 2>&1 || true
adb -s "$serial" logcat -c
adb -s "$serial" shell am force-stop "$package"
adb -s "$serial" shell am start -W -n "$activity" >"$tmp_dir/launch.log"

if ! grep -q '^Status: ok$' "$tmp_dir/launch.log"; then
  echo "Android emulator session-subscription smoke launch did not report Status: ok" >&2
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
  if grep -q 'text="Pairing payload"' "$ui_xml"; then
    break
  fi
  if grep -Eq "isn't responding|Application Not Responding" "$ui_xml"; then
    tap_text_node "$ui_xml" "Wait" || true
    sleep 2
    continue
  fi
  sleep 1
done
if ! grep -q 'text="Pairing payload"' "$ui_xml"; then
  echo "Android emulator session-subscription smoke did not reach the pairing screen." >&2
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
  adb -s "$serial" logcat -d | grep -E "FATAL EXCEPTION|ANR in $package|app.fieldwork.android" >&2 || true
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

sessions_ui="$tmp_dir/ui-sessions-empty.xml"
for _ in {1..60}; do
  if ! dump_ui "$sessions_ui"; then
    sleep 1
    continue
  fi
  if grep -q 'text="OK"' "$sessions_ui"; then
    tap_text_node "$sessions_ui" "OK" || true
    sleep 1
    continue
  fi
  if grep -q 'text="No sessions"' "$sessions_ui"; then
    break
  fi
  sleep 1
done
if ! grep -q 'text="No sessions"' "$sessions_ui"; then
  echo "Android emulator session-subscription smoke expected an empty dashboard before desktop session creation." >&2
  sed -n '1,160p' "$sessions_ui" >&2 || true
  exit 1
fi

created_at_ms="$(python3 - <<'PY'
import time
print(int(time.time() * 1000))
PY
)"
desktop_env "$fieldwork" new fw_subscribe_session >"$tmp_dir/new-session.log"

sessions_ui="$tmp_dir/ui-sessions-created.xml"
visible_at_ms=""
for _ in {1..80}; do
  if ! dump_ui "$sessions_ui"; then
    sleep 0.25
    continue
  fi
  if grep -Eq 'fw_subscribe_session|ANDROID_SUBSCRIBE_READY' "$sessions_ui"; then
    visible_at_ms="$(python3 - <<'PY'
import time
print(int(time.time() * 1000))
PY
)"
    break
  fi
  if grep -q 'text="No sessions"' "$sessions_ui"; then
    tap_content_desc_node "$sessions_ui" "Refresh" >/dev/null 2>&1 || true
  fi
  sleep 0.25
done

if [[ -z "$visible_at_ms" ]]; then
  echo "Android emulator session-subscription smoke did not show the desktop-created session." >&2
  desktop_env "$fieldwork" ls >"$tmp_dir/local-sessions.log" 2>&1 || true
  cat "$tmp_dir/local-sessions.log" >&2 || true
  sed -n '1,180p' "$sessions_ui" >&2 || true
  adb -s "$serial" logcat -d | grep -E "FieldworkRepository|FATAL EXCEPTION|ANR in $package|app.fieldwork.android" >&2 || true
  exit 1
fi

visible_ms=$((visible_at_ms - created_at_ms))
if [[ "$visible_ms" -gt 8000 ]]; then
  echo "Android emulator session-subscription smoke was too slow: ${visible_ms}ms." >&2
  sed -n '1,180p' "$sessions_ui" >&2 || true
  exit 1
fi

tap_session_card "$sessions_ui" "fw_subscribe_session"

terminal_ui="$tmp_dir/ui-terminal.xml"
for _ in {1..60}; do
  if ! dump_ui "$terminal_ui"; then
    sleep 1
    continue
  fi
  if grep -q 'text="Attached"' "$terminal_ui" && grep -q 'fw_subscribe_session' "$terminal_ui"; then
    break
  fi
  sleep 1
done

if ! grep -q 'text="Attached"' "$terminal_ui" || ! grep -q 'fw_subscribe_session' "$terminal_ui"; then
  echo "Android emulator session-subscription smoke did not attach to the subscribed desktop session." >&2
  sed -n '1,120p' "$terminal_ui" >&2 || true
  exit 1
fi

adb -s "$serial" shell input tap 540 1200
adb -s "$serial" shell input text subscription_attach_ok
adb -s "$serial" shell input keyevent ENTER
wait_for_input_log subscription_attach_ok

crash_log="$tmp_dir/crash.log"
adb -s "$serial" logcat -d -b crash >"$crash_log"
if grep -q "$package" "$crash_log"; then
  echo "Android emulator session-subscription smoke found $package in the crash log." >&2
  tail -120 "$crash_log" >&2
  exit 1
fi

full_log="$tmp_dir/logcat.log"
adb -s "$serial" logcat -d >"$full_log"
if grep -Eq "FATAL EXCEPTION.*$package|ANR in $package|am_crash.*$package|am_anr.*$package" "$full_log"; then
  echo "Android emulator session-subscription smoke found a Fieldwork crash or ANR in logcat." >&2
  grep -E "FATAL EXCEPTION.*$package|ANR in $package|am_crash.*$package|am_anr.*$package" "$full_log" >&2
  exit 1
fi

echo "android emulator session-subscription smoke ok: serial=$serial visible_ms=${visible_ms}"
