#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
package="app.fieldwork.android"
activity="$package/.MainActivity"
fieldwork="${FIELDWORK_CLI_BINARY:-$root/target/release/fieldwork}"
fieldworkd="${FIELDWORK_DAEMON_BINARY:-$root/target/release/fieldworkd}"
iroh_relay_url="${FIELDWORK_ANDROID_IROH_RELAY_URL:-}"
relay_signing_key="${FIELDWORK_RELAY_SIGNING_KEY_B64:-BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc}"
# Typed-code pairing resolves the 5-char code at the relay rendezvous endpoint.
# The daemon publishes (POST /v1/pair/publish) and the app resolves
# (GET /v1/pair/resolve/{code}) against this control URL.
relay_control_url="${FIELDWORK_ANDROID_RELAY_CONTROL_URL:?Set FIELDWORK_ANDROID_RELAY_CONTROL_URL to a reachable relay control endpoint for typed-code pairing}"
pair_flow_max_seconds="${FIELDWORK_ANDROID_PAIR_FLOW_MAX_SECONDS:-15}"

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
  local remote="/sdcard/fieldwork-window.xml"
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

  # Android 16 emulator images can hang or return no stream when dumping the
  # hierarchy directly to /dev/tty. The file-backed path is slower but stable.
  if adb -s "$serial" shell uiautomator dump "$remote" >/dev/null 2>&1 \
    && adb -s "$serial" exec-out cat "$remote" >"$tmp" \
    && [[ -s "$tmp" ]]; then
    adb -s "$serial" shell rm -f "$remote" >/dev/null 2>&1 || true
    mv "$tmp" "$out"
    return 0
  fi
  adb -s "$serial" shell rm -f "$remote" >/dev/null 2>&1 || true
  rm -f "$tmp"
  return 1
}

now_ms() {
  python3 - <<'PY'
import time
print(int(time.time() * 1000))
PY
}

# Capture the 5-char Crockford pairing code from a `fw pair` log. The CLI prints
#   Scan the QR with the Fieldwork app — or enter this code:
#       AB 4C7
#       Expires in 10 minutes.
# so we take the line after the prompt and squeeze out whitespace (the grouped
# code separator) to recover the raw 5-character code.
extract_pair_code() {
  local log="$1"
  python3 - "$log" <<'PY'
import re
import sys

text = open(sys.argv[1], encoding="utf-8").read()
lines = text.splitlines()
for index, line in enumerate(lines):
    if "enter this code:" in line:
        for candidate in lines[index + 1:]:
            squeezed = re.sub(r"\s+", "", candidate)
            if re.fullmatch(r"[0-9A-HJKMNP-TV-Z]{5}", squeezed):
                print(squeezed)
                raise SystemExit(0)
        break
raise SystemExit(1)
PY
}

dismiss_blocking_emulator_anr() {
  local ui_xml="$1"
  local coords

  coords="$(
    python3 - "$ui_xml" <<'PY'
import re
import sys
import xml.etree.ElementTree as ET

text = open(sys.argv[1], encoding="utf-8").read()
end = text.find("</hierarchy>")
if end >= 0:
    text = text[:end + len("</hierarchy>")]
try:
    root = ET.fromstring(text)
except ET.ParseError:
    raise SystemExit(1)

title = next(
    (
        node.attrib.get("text", "")
        for node in root.iter("node")
        if node.attrib.get("resource-id") == "android:id/alertTitle"
    ),
    "",
)
if "isn't responding" not in title:
    raise SystemExit(1)

if "fieldwork" in title.lower():
    raise SystemExit(1)

button_text = "Wait" if title == "Process system isn't responding" else "Close app"
for node in root.iter("node"):
    if (
        node.attrib.get("text") == button_text
        and node.attrib.get("clickable") == "true"
        and node.attrib.get("enabled") == "true"
    ):
        left, top, right, bottom = map(int, re.findall(r"\d+", node.attrib["bounds"]))
        print(button_text, (left + right) // 2, (top + bottom) // 2)
        raise SystemExit(0)

raise SystemExit(1)
PY
  )" || return 1

  read -r button_text button_x button_y <<<"$coords"
  echo "Dismissing blocking emulator ANR dialog with $button_text." >&2
  adb -s "$serial" shell input tap "$button_x" "$button_y"
  sleep 1
  return 0
}

tmp_parent="${FIELDWORK_ANDROID_PAIR_TMPDIR:-/tmp}"
tmp_dir="$(mktemp -d "${tmp_parent%/}/fw-ap.XXXXXX")"
home="$tmp_dir/home"
run="$tmp_dir/run"
bin="$tmp_dir/bin"
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
  if [[ "$status" -ne 0 && "${FIELDWORK_KEEP_ANDROID_PAIR_TMP:-}" == "true" ]]; then
    echo "Preserving Android emulator pair smoke state at $tmp_dir" >&2
  else
    adb -s "$serial" shell am force-stop "$package" >/dev/null 2>&1 || true
    adb -s "$serial" shell pm clear "$package" >/dev/null 2>&1 || true
    rm -rf "$tmp_dir"
  fi
}
trap cleanup EXIT

cat >"$bin/claude" <<'EOF'
#!/usr/bin/env bash
echo claude android emulator stub ready
while IFS= read -r line; do
  echo "claude android emulator stub: $line"
done
EOF
chmod +x "$bin/claude"

desktop_env() {
  local -a env_vars=(
    HOME="$home"
    XDG_RUNTIME_DIR="$run"
    PATH="$bin:$PATH"
    FIELDWORK_IROH_SECRET_KEY_B64=MTIzNDU2Nzg5MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTI
    FIELDWORK_RELAY_CONTROL_URL="$relay_control_url"
    FIELDWORK_RELAY_SIGNING_KEY_B64="$relay_signing_key"
    FIELDWORK_SCROLLBACK_ENCRYPTION_ENABLED=false
  )
  if [[ -n "$iroh_relay_url" ]]; then
    env_vars+=(FIELDWORK_IROH_RELAY_URL="$iroh_relay_url")
  fi
  env "${env_vars[@]}" "$@"
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

desktop_env "$fieldwork" new bash -lc 'printf "ANDROID_EMULATOR_PAIR_READY\n"; while IFS= read -r line; do printf "android-mobile: %s\n" "$line"; done' >"$tmp_dir/new-session.log"

mkfifo "$tmp_dir/pair.in"
exec 3<>"$tmp_dir/pair.in"
desktop_env "$fieldwork" pair <"$tmp_dir/pair.in" >"$tmp_dir/pair.log" 2>&1 &
pair_pid=$!

pair_code=""
for _ in {1..100}; do
  pair_code="$(extract_pair_code "$tmp_dir/pair.log" || true)"
  if [[ -n "$pair_code" ]]; then
    break
  fi
  sleep 0.1
done
if [[ -z "$pair_code" ]]; then
  echo "fieldwork pair did not print a 5-character pairing code" >&2
  cat "$tmp_dir/pair.log" >&2 || true
  exit 1
fi

FIELDWORK_ANDROID_BIOMETRIC_BYPASS=true \
FIELDWORK_ANDROID_PAIRING_CODE="$pair_code" \
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
  echo "Android emulator pair smoke launch did not report Status: ok" >&2
  cat "$tmp_dir/launch.log" >&2
  exit 1
fi

ui_xml="$tmp_dir/ui-before-pair.xml"
for _ in {1..30}; do
  if dump_ui "$ui_xml"; then
    if grep -q 'text="Pairing code"' "$ui_xml"; then
      break
    fi
    if dismiss_blocking_emulator_anr "$ui_xml"; then
      continue
    fi
  fi
  sleep 1
done
if [[ ! -s "$ui_xml" ]]; then
  echo "Android emulator pair smoke could not dump the pairing screen UI." >&2
  exit 1
fi
if ! grep -q 'text="Pairing code"' "$ui_xml"; then
  echo "Android emulator pair smoke did not reach the Enter-code pairing screen." >&2
  sed -n '1,120p' "$ui_xml" >&2 || true
  exit 1
fi

read -r pair_x pair_y < <(python3 "$root/scripts/pick-android-pair-button.py" "$ui_xml")

pair_flow_started_ms="$(now_ms)"
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
  echo "--- daemon.log ---" >&2
  cat "$tmp_dir/daemon.log" >&2 || true
  echo "--- ui-after-pair-tap.xml ---" >&2
  dump_ui "$tmp_dir/ui-after-pair-tap.xml" || true
  sed -n '1,80p' "$tmp_dir/ui-after-pair-tap.xml" >&2 || true
  echo "--- app logcat ---" >&2
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
pair_flow_completed_ms="$(now_ms)"
pair_flow_ms=$((pair_flow_completed_ms - pair_flow_started_ms))
pair_flow_max_ms=$((pair_flow_max_seconds * 1000))
if (( pair_flow_ms > pair_flow_max_ms )); then
  echo "Android emulator pair flow took ${pair_flow_ms}ms, expected <= ${pair_flow_max_ms}ms." >&2
  cat "$tmp_dir/pair.log" >&2 || true
  exit 1
fi

paired_ui="$tmp_dir/ui-after-pair.xml"
for _ in {1..60}; do
  if ! dump_ui "$paired_ui"; then
    sleep 1
    continue
  fi
  if dismiss_blocking_emulator_anr "$paired_ui"; then
    continue
  fi
  if grep -q 'text="OK"' "$paired_ui"; then
    read -r ok_x ok_y < <(python3 - "$paired_ui" <<'PY'
import re
import sys
import xml.etree.ElementTree as ET

text = open(sys.argv[1], encoding="utf-8").read()
end = text.find("</hierarchy>")
if end >= 0:
    text = text[:end + len("</hierarchy>")]
root = ET.fromstring(text)
for node in root.iter("node"):
    if node.attrib.get("text") == "OK":
        left, top, right, bottom = map(int, re.findall(r"\d+", node.attrib["bounds"]))
        print((left + right) // 2, (top + bottom) // 2)
        raise SystemExit(0)
raise SystemExit("OK not found")
PY
)
    adb -s "$serial" shell input tap "$ok_x" "$ok_y"
    sleep 1
    continue
  fi
  if grep -q 'text="No sessions"' "$paired_ui"; then
    read -r refresh_x refresh_y < <(python3 - "$paired_ui" <<'PY'
import re
import sys
import xml.etree.ElementTree as ET

text = open(sys.argv[1], encoding="utf-8").read()
end = text.find("</hierarchy>")
if end >= 0:
    text = text[:end + len("</hierarchy>")]
root = ET.fromstring(text)

for node in root.iter("node"):
    if node.attrib.get("content-desc") == "Refresh":
        left, top, right, bottom = map(int, re.findall(r"\d+", node.attrib["bounds"]))
        print((left + right) // 2, (top + bottom) // 2)
        raise SystemExit(0)
raise SystemExit("Refresh not found")
PY
)
    adb -s "$serial" shell input tap "$refresh_x" "$refresh_y"
    sleep 1
    continue
  fi
  if grep -Eq 'text="bash|ANDROID_EMULATOR_PAIR_READY' "$paired_ui" && ! grep -q 'text="No sessions"' "$paired_ui"; then
    break
  fi
  sleep 1
done

if ! grep -Eq 'text="bash|ANDROID_EMULATOR_PAIR_READY' "$paired_ui" || grep -q 'text="No sessions"' "$paired_ui"; then
  echo "Android emulator pair smoke did not show the desktop-created session." >&2
  cat "$tmp_dir/new-session.log" >&2 || true
  desktop_env "$fieldwork" ls >"$tmp_dir/local-sessions.log" 2>&1 || true
  cat "$tmp_dir/local-sessions.log" >&2 || true
  adb -s "$serial" logcat -d | grep -E "FieldworkRepository|FATAL EXCEPTION|ANR in $package|app.fieldwork.android" >&2 || true
  cat "$tmp_dir/pair.log" >&2 || true
  exit 1
fi

session_coords="$tmp_dir/session-card-coords.txt"
python3 - "$paired_ui" >"$session_coords" <<'PY'
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
        child.attrib.get("text") in {"bash", "ANDROID_EMULATOR_PAIR_READY"}
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
read -r session_x session_y <"$session_coords"

adb -s "$serial" shell input tap "$session_x" "$session_y"

terminal_ui="$tmp_dir/ui-terminal.xml"
for _ in {1..60}; do
  if ! dump_ui "$terminal_ui"; then
    sleep 1
    continue
  fi
  if dismiss_blocking_emulator_anr "$terminal_ui"; then
    continue
  fi
  if grep -q 'text="Attached"' "$terminal_ui" && grep -q 'bash' "$terminal_ui"; then
    break
  fi
  sleep 1
done

if ! grep -q 'text="Attached"' "$terminal_ui" || ! grep -q 'bash' "$terminal_ui"; then
  echo "Android emulator pair smoke did not attach to the desktop-created terminal session." >&2
  sed -n '1,120p' "$terminal_ui" >&2 || true
  adb -s "$serial" logcat -d | grep -E "FieldworkRepository|FATAL EXCEPTION|ANR in $package|app.fieldwork.android" >&2 || true
  exit 1
fi

adb -s "$serial" shell input keyevent 3
sleep 1
adb -s "$serial" shell am start -W -n "$activity" >"$tmp_dir/relaunch.log"

if ! grep -q '^Status: ok$' "$tmp_dir/relaunch.log"; then
  echo "Android emulator pair smoke relaunch did not report Status: ok." >&2
  cat "$tmp_dir/relaunch.log" >&2 || true
  exit 1
fi

sleep 2
if ! adb -s "$serial" shell dumpsys window | grep -q "$package/.MainActivity"; then
  echo "Android emulator pair smoke did not foreground the Fieldwork activity after relaunch." >&2
  cat "$tmp_dir/relaunch.log" >&2 || true
  exit 1
fi

adb -s "$serial" shell input tap 540 1200
adb -s "$serial" shell input text fw_android_foreground_ok
adb -s "$serial" shell input keyevent ENTER
sleep 1

mkfifo "$tmp_dir/verifier-pair.in"
exec 4<>"$tmp_dir/verifier-pair.in"
desktop_env "$fieldwork" pair <"$tmp_dir/verifier-pair.in" >"$tmp_dir/verifier-pair.log" 2>&1 &
pair_pid=$!

verifier_code=""
for _ in {1..100}; do
  verifier_code="$(extract_pair_code "$tmp_dir/verifier-pair.log" || true)"
  if [[ -n "$verifier_code" ]]; then
    break
  fi
  sleep 0.1
done
if [[ -z "$verifier_code" ]]; then
  echo "Android emulator pair smoke could not create verifier pairing code." >&2
  cat "$tmp_dir/verifier-pair.log" >&2 || true
  exit 1
fi

desktop_env "$fieldwork" pair-test \
  --code "$verifier_code" \
  --relay-control-url "$relay_control_url" \
  --name android-smoke-verifier \
  --attach first \
  --expect-output "android-mobile: fw_android_foreground_ok" \
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
  echo "Android emulator pair smoke did not verify mobile-originated terminal input after foreground resume." >&2
  cat "$tmp_dir/verifier-pair.log" >&2 || true
  cat "$tmp_dir/verifier.log" >&2 || true
  adb -s "$serial" exec-out screencap -p >"$tmp_dir/android-input-failure.png" || true
  adb -s "$serial" logcat -d | grep -E "FieldworkRepository|FATAL EXCEPTION|ANR in $package|app.fieldwork.android" >&2 || true
  exit 1
fi
verifier_pid=""

adb -s "$serial" shell input keyevent BACK
sleep 1

crash_log="$tmp_dir/crash.log"
adb -s "$serial" logcat -d -b crash >"$crash_log"
if grep -q "$package" "$crash_log"; then
  echo "Android emulator pair smoke found $package in the crash log." >&2
  tail -120 "$crash_log" >&2
  exit 1
fi

full_log="$tmp_dir/logcat.log"
adb -s "$serial" logcat -d >"$full_log"
if grep -Eq "FATAL EXCEPTION.*$package|ANR in $package|am_crash.*$package|am_anr.*$package" "$full_log"; then
  echo "Android emulator pair smoke found a Fieldwork crash or ANR in logcat." >&2
  grep -E "FATAL EXCEPTION.*$package|ANR in $package|am_crash.*$package|am_anr.*$package" "$full_log" >&2
  exit 1
fi

echo "android emulator pair smoke ok: serial=$serial pair_flow_ms=$pair_flow_ms"
