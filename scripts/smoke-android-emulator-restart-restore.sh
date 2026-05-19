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
  local dump_timeout="${FIELDWORK_ANDROID_UI_DUMP_TIMEOUT_SECONDS:-5}"
  rm -f "$tmp"
  if python3 - "$serial" "$tmp" "$dump_timeout" <<'PY'
import subprocess
import sys

serial, out, timeout = sys.argv[1], sys.argv[2], float(sys.argv[3])
remote = "/data/local/tmp/fieldwork-window.xml"
try:
    dump = subprocess.run(
        ["adb", "-s", serial, "shell", "uiautomator", "dump", remote],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        timeout=timeout,
    )
    if dump.returncode != 0:
        raise SystemExit(dump.returncode)
    with open(out, "wb") as stdout:
        cat = subprocess.run(
            ["adb", "-s", serial, "exec-out", "cat", remote],
            stdout=stdout,
            stderr=subprocess.DEVNULL,
            timeout=timeout,
        )
    raise SystemExit(cat.returncode)
except subprocess.TimeoutExpired:
    raise SystemExit(124)
PY
  then
    if grep -q '<hierarchy' "$tmp"; then
      mv "$tmp" "$out"
      return 0
    fi
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

wait_for_dashboard_marker() {
  local marker="$1"
  local out="$2"
  for _ in {1..90}; do
    if ! dump_ui "$out"; then
      sleep 1
      continue
    fi
    if grep -q 'text="OK"' "$out"; then
      tap_text_node "$out" "OK" || true
      sleep 1
      continue
    fi
    if grep -Eq "isn't responding|Application Not Responding|Process system isn't responding" "$out"; then
      tap_text_node "$out" "Wait" || true
      sleep 2
      continue
    fi
    if grep -q 'text="No sessions"' "$out"; then
      tap_content_desc_node "$out" "Refresh" || true
      sleep 1
      continue
    fi
    if grep -q "$marker" "$out" && ! grep -q 'text="No sessions"' "$out"; then
      return 0
    fi
    sleep 1
  done
  return 1
}

launch_app() {
  local log_file="$1"
  adb -s "$serial" shell am force-stop "$package"
  adb -s "$serial" shell am start -W -n "$activity" >"$log_file"

  if ! grep -q '^Status: ok$' "$log_file"; then
    echo "Android emulator restart smoke launch did not report Status: ok" >&2
    cat "$log_file" >&2
    exit 1
  fi

  for _ in {1..10}; do
    if adb -s "$serial" shell dumpsys window | grep -q "$package/.MainActivity"; then
      return 0
    fi
    adb -s "$serial" shell monkey -p "$package" 1 >/dev/null 2>&1 || true
    sleep 1
  done

  echo "Android emulator restart smoke launch did not focus $activity" >&2
  cat "$log_file" >&2
  adb -s "$serial" shell dumpsys window | grep -E 'mCurrentFocus|mFocusedApp' >&2 || true
  exit 1
}

tmp_parent="${FIELDWORK_ANDROID_RESTART_TMPDIR:-/tmp}"
tmp_dir="$(mktemp -d "${tmp_parent%/}/fw-ar.XXXXXX")"
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
  if [[ "$status" -ne 0 && "${FIELDWORK_KEEP_ANDROID_RESTART_TMP:-}" == "true" ]]; then
    echo "Preserving Android emulator restart smoke state at $tmp_dir" >&2
  else
    adb -s "$serial" shell am force-stop "$package" >/dev/null 2>&1 || true
    adb -s "$serial" shell pm clear "$package" >/dev/null 2>&1 || true
    rm -rf "$tmp_dir"
  fi
}
trap cleanup EXIT

cat >"$bin/fw_restart_session" <<'EOF'
#!/usr/bin/env bash
printf 'ANDROID_RESTART_READY\n'
printf 'ANDROID_RESTART_SCROLLBACK\n'
EOF
chmod +x "$bin/fw_restart_session"

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

kill_state_holders() {
  command -v lsof >/dev/null 2>&1 || return 0

  local db_paths=(
    "$home/Library/Caches/app.fieldwork/sessions.redb"
    "$home/Library/Application Support/app.fieldwork/devices.redb"
  )
  local holders
  holders="$(
    for db_path in "${db_paths[@]}"; do
      [[ -e "$db_path" ]] && lsof -t "$db_path" 2>/dev/null || true
    done | sort -u
  )"
  if [[ -n "$holders" ]]; then
    while IFS= read -r holder; do
      [[ -n "$holder" ]] || continue
      echo "stopping lingering fieldworkd pid=$holder for restart smoke" >>"$tmp_dir/daemon-pids.log"
      kill "$holder" 2>/dev/null || true
    done <<<"$holders"
  fi

  for _ in {1..100}; do
    holders="$(
      for db_path in "${db_paths[@]}"; do
        [[ -e "$db_path" ]] && lsof -t "$db_path" 2>/dev/null || true
      done | sort -u
    )"
    [[ -z "$holders" ]] && return 0
    sleep 0.1
  done

  for db_path in "${db_paths[@]}"; do
    [[ -e "$db_path" ]] && lsof "$db_path" >&2 || true
  done
  return 1
}

start_daemon() {
  local log_file="$1"
  local socket="$run/fieldwork/control.sock"

  for attempt in {1..5}; do
    rm -f "$socket"
    desktop_env "$fieldworkd" >"$log_file" 2>&1 &
    daemon_pid=$!
    echo "started fieldworkd attempt=$attempt pid=$daemon_pid log=$log_file" >>"$tmp_dir/daemon-pids.log"

    for _ in {1..100}; do
      if [[ -S "$socket" ]]; then
        for _ in {1..100}; do
          if desktop_env "$fieldwork" daemon status >"$tmp_dir/daemon-status-${attempt}.log" 2>&1 &&
            grep -q '^socket: reachable ' "$tmp_dir/daemon-status-${attempt}.log"; then
            return 0
          fi
          sleep 0.1
        done
        break
      fi
      if ! kill -0 "$daemon_pid" 2>/dev/null; then
        wait "$daemon_pid" 2>/dev/null || true
        daemon_pid=""
        break
      fi
      sleep 0.1
    done

    if [[ -n "$daemon_pid" ]]; then
      kill "$daemon_pid" 2>/dev/null || true
      wait "$daemon_pid" 2>/dev/null || true
      daemon_pid=""
    fi
    sleep 0.5
  done

  echo "fieldworkd did not become reachable at $socket" >&2
  cat "$log_file" >&2 || true
  if [[ -d "$home/Library/Logs/app.fieldwork" ]]; then
    for daemon_log in "$home"/Library/Logs/app.fieldwork/daemon.log*; do
      [[ -f "$daemon_log" ]] && tail -80 "$daemon_log" >&2
    done
  fi
  if command -v lsof >/dev/null 2>&1; then
    lsof "$home/Library/Caches/app.fieldwork/sessions.redb" "$home/Library/Application Support/app.fieldwork/devices.redb" >&2 || true
  fi
  exit 1
}

start_daemon "$tmp_dir/daemon.log"

desktop_env "$fieldwork" new fw_restart_session >"$tmp_dir/new-session.log"

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
launch_app "$tmp_dir/launch.log"

ui_xml="$tmp_dir/ui-before-pair.xml"
for _ in {1..60}; do
  if ! dump_ui "$ui_xml"; then
    sleep 1
    continue
  fi
  if grep -q 'text="Pairing payload"' "$ui_xml"; then
    break
  fi
  if grep -Eq "isn't responding|Application Not Responding|Process system isn't responding" "$ui_xml"; then
    tap_text_node "$ui_xml" "Wait" || true
    sleep 2
    continue
  fi
  sleep 1
done
if ! grep -q 'text="Pairing payload"' "$ui_xml"; then
  echo "Android emulator restart smoke did not reach the pairing screen." >&2
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
if ! wait_for_dashboard_marker "fw_restart_session" "$paired_ui"; then
  echo "Android emulator restart smoke did not show the desktop-created session before restart." >&2
  cat "$tmp_dir/new-session.log" >&2 || true
  desktop_env "$fieldwork" ls >"$tmp_dir/local-sessions-before.log" 2>&1 || true
  cat "$tmp_dir/local-sessions-before.log" >&2 || true
  adb -s "$serial" logcat -d | grep -E "FieldworkRepository|FATAL EXCEPTION|ANR in $package|app.fieldwork.android" >&2 || true
  exit 1
fi

if ! wait_for_dashboard_marker "ANDROID_RESTART_SCROLLBACK" "$paired_ui"; then
  echo "Android emulator restart smoke did not show restart scrollback preview before daemon restart." >&2
  sed -n '1,160p' "$paired_ui" >&2 || true
  exit 1
fi
sleep 2
adb -s "$serial" shell am force-stop "$package"
sleep 1

echo "stopping fieldworkd pid=$daemon_pid for restart smoke" >>"$tmp_dir/daemon-pids.log"
kill "$daemon_pid"
wait "$daemon_pid" 2>/dev/null || true
daemon_pid=""
kill_state_holders
rm -f "$run/fieldwork/control.sock"
sleep 5

start_daemon "$tmp_dir/daemon-restart.log"

for _ in {1..80}; do
  desktop_env "$fieldwork" ls >"$tmp_dir/local-sessions-after.log" 2>&1 || true
  if grep -q 'fw_restart_session' "$tmp_dir/local-sessions-after.log"; then
    break
  fi
  sleep 0.25
done
if ! grep -q 'fw_restart_session' "$tmp_dir/local-sessions-after.log"; then
  echo "desktop restored session list did not include fw_restart_session after daemon restart." >&2
  cat "$tmp_dir/local-sessions-after.log" >&2 || true
  cat "$tmp_dir/daemon-restart.log" >&2 || true
  exit 1
fi

launch_app "$tmp_dir/relaunch.log"

restored_ui="$tmp_dir/ui-after-daemon-restart.xml"
if ! wait_for_dashboard_marker "fw_restart_session" "$restored_ui"; then
  echo "Android emulator restart smoke did not show restored session after daemon restart." >&2
  cat "$tmp_dir/local-sessions-after.log" >&2 || true
  adb -s "$serial" logcat -d | grep -E "FieldworkRepository|FATAL EXCEPTION|ANR in $package|app.fieldwork.android" >&2 || true
  sed -n '1,160p' "$restored_ui" >&2 || true
  exit 1
fi

tap_session_card "$restored_ui" "fw_restart_session"

terminal_ui="$tmp_dir/ui-terminal-after-restart.xml"
for _ in {1..60}; do
  if ! dump_ui "$terminal_ui"; then
    sleep 1
    continue
  fi
  if grep -Eq 'text="Attached"|text="Exited 0"' "$terminal_ui" && grep -q 'fw_restart_session' "$terminal_ui"; then
    break
  fi
  sleep 1
done
if ! grep -Eq 'text="Attached"|text="Exited 0"' "$terminal_ui" || ! grep -q 'fw_restart_session' "$terminal_ui"; then
  echo "Android emulator restart smoke did not attach to the restored terminal session." >&2
  sed -n '1,160p' "$terminal_ui" >&2 || true
  adb -s "$serial" logcat -d | grep -E "FieldworkRepository|FATAL EXCEPTION|ANR in $package|app.fieldwork.android" >&2 || true
  exit 1
fi

mkfifo "$tmp_dir/verifier-pair.in"
exec 4<>"$tmp_dir/verifier-pair.in"
desktop_env "$fieldwork" pair <"$tmp_dir/verifier-pair.in" >"$tmp_dir/verifier-pair.log" 2>&1 &
pair_pid=$!

verifier_payload=""
for _ in {1..100}; do
  verifier_payload="$(grep -m1 '^{' "$tmp_dir/verifier-pair.log" || true)"
  if [[ -n "$verifier_payload" ]]; then
    break
  fi
  sleep 0.1
done
if [[ -z "$verifier_payload" ]]; then
  echo "Android emulator restart smoke could not create verifier pairing payload." >&2
  cat "$tmp_dir/verifier-pair.log" >&2 || true
  exit 1
fi

desktop_env "$fieldwork" pair-test \
  --payload "$verifier_payload" \
  --name android-restart-verifier \
  --attach first \
  --expect-output "ANDROID_RESTART_SCROLLBACK" \
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
  echo "Android emulator restart smoke did not verify restored scrollback after daemon restart." >&2
  cat "$tmp_dir/verifier-pair.log" >&2 || true
  cat "$tmp_dir/verifier.log" >&2 || true
  adb -s "$serial" logcat -d | grep -E "FieldworkRepository|FATAL EXCEPTION|ANR in $package|app.fieldwork.android" >&2 || true
  exit 1
fi
verifier_pid=""

crash_log="$tmp_dir/crash.log"
adb -s "$serial" logcat -d -b crash >"$crash_log"
if grep -q "$package" "$crash_log"; then
  echo "Android emulator restart smoke found $package in the crash log." >&2
  tail -120 "$crash_log" >&2
  exit 1
fi

full_log="$tmp_dir/logcat.log"
adb -s "$serial" logcat -d >"$full_log"
if grep -Eq "FATAL EXCEPTION.*$package|ANR in $package|am_crash.*$package|am_anr.*$package" "$full_log"; then
  echo "Android emulator restart smoke found a Fieldwork crash or ANR in logcat." >&2
  grep -E "FATAL EXCEPTION.*$package|ANR in $package|am_crash.*$package|am_anr.*$package" "$full_log" >&2
  exit 1
fi

echo "android emulator restart restore smoke ok: serial=$serial"
