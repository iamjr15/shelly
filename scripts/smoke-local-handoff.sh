#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp="$(mktemp -d)"
daemon_pid=""
daemon_pid2=""
subscribe_pid=""
host_cargo_home="${CARGO_HOME:-$HOME/.cargo}"
host_rustup_home="${RUSTUP_HOME:-$HOME/.rustup}"

cleanup() {
  if [[ -n "$daemon_pid" ]]; then
    kill "$daemon_pid" 2>/dev/null || true
    wait "$daemon_pid" 2>/dev/null || true
  fi
  if [[ -n "$daemon_pid2" ]]; then
    kill "$daemon_pid2" 2>/dev/null || true
    wait "$daemon_pid2" 2>/dev/null || true
  fi
  if [[ -n "$subscribe_pid" ]]; then
    kill "$subscribe_pid" 2>/dev/null || true
    wait "$subscribe_pid" 2>/dev/null || true
  fi
  rm -rf "$tmp"
}
trap cleanup EXIT

mkdir -p "$tmp/home" "$tmp/runtime" "$tmp/config" "$tmp/state" "$tmp/bin"
chmod 700 "$tmp/runtime"

export HOME="$tmp/home"
export XDG_RUNTIME_DIR="$tmp/runtime"
export XDG_CONFIG_HOME="$tmp/config"
export XDG_STATE_HOME="$tmp/state"
export CARGO_HOME="$host_cargo_home"
export RUSTUP_HOME="$host_rustup_home"
export FIELDWORK_IROH_SECRET_KEY_B64="BQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQU"
export PATH="$tmp/bin:$PATH"

# This is a local smoke substitute for machines without keychain access in an
# isolated temp HOME. Release verification must still cover encrypted-at-rest.
export FIELDWORK_SCROLLBACK_ENCRYPTION_ENABLED=false

cargo_target_dir="${CARGO_TARGET_DIR:-$repo_root/target}"

cat >"$tmp/bin/claude" <<'EOF'
#!/usr/bin/env bash
printf 'Claude Code smoke stub\n'
while IFS= read -r line; do
  printf 'stub: %s\n' "$line"
done
EOF
chmod +x "$tmp/bin/claude"

cargo build -q -p fieldwork-cli -p fieldwork-daemon

fieldwork="$cargo_target_dir/debug/fieldwork"
fieldworkd="$cargo_target_dir/debug/fieldworkd"

run_fieldwork_new() {
  local log_path="$1"
  shift
  if ! "$fieldwork" new "$@" >"$log_path" 2>&1; then
    echo "fieldwork new failed: $*" >&2
    cat "$log_path" >&2 || true
    exit 1
  fi
}

wait_for_socket() {
  for _ in $(seq 1 80); do
    if [[ -S "$XDG_RUNTIME_DIR/fieldwork/control.sock" ]]; then
      return 0
    fi
    sleep 0.1
  done
  return 1
}

start_daemon() {
  local log_path="$1"
  "$fieldworkd" >"$log_path" 2>&1 &
  if [[ -z "$daemon_pid" ]]; then
    daemon_pid=$!
  else
    daemon_pid2=$!
  fi
  if ! wait_for_socket; then
    echo "fieldworkd did not create its control socket" >&2
    tail -100 "$log_path" >&2 || true
    exit 1
  fi
}

start_daemon "$tmp/daemon1.log"

if command -v vim >/dev/null 2>&1; then
  tui_command=(vim -Nu NONE -n -i NONE "$tmp/tui.txt")
elif command -v vi >/dev/null 2>&1; then
  tui_command=(vi "$tmp/tui.txt")
else
  echo "no vim/vi executable available for TUI smoke" >&2
  exit 1
fi

run_fieldwork_new "$tmp/new-claude.log" --dir "$tmp/home"
claude_created="$(cat "$tmp/new-claude.log")"
claude_id="$(awk 'NR == 1 { print $2 }' "$tmp/new-claude.log")"

run_fieldwork_new "$tmp/new-bash.log" bash
bash_created="$(cat "$tmp/new-bash.log")"
bash_id="$(awk 'NR == 1 { print $2 }' "$tmp/new-bash.log")"

run_fieldwork_new "$tmp/new-tui.log" "${tui_command[@]}"
tui_created="$(cat "$tmp/new-tui.log")"
tui_id="$(awk 'NR == 1 { print $2 }' "$tmp/new-tui.log")"

pair_start_s="$(date +%s)"
mkfifo "$tmp/pair.in"
exec 3<>"$tmp/pair.in"
"$fieldwork" pair <"$tmp/pair.in" >"$tmp/pair.log" 2>&1 &
pair_pid=$!

payload=""
for _ in $(seq 1 100); do
  payload="$(grep -m1 '^{' "$tmp/pair.log" || true)"
  if [[ -n "$payload" ]]; then
    break
  fi
  sleep 0.1
done
if [[ -z "$payload" ]]; then
  echo "fieldwork pair did not print a JSON payload" >&2
  cat "$tmp/pair.log" >&2 || true
  exit 1
fi

if ! "$fieldwork" pair-test \
  --payload "$payload" \
  --expect-protocol-mismatch \
  >"$tmp/protocol-mismatch.log" 2>&1; then
  echo "iroh protocol-mismatch probe failed" >&2
  cat "$tmp/protocol-mismatch.log" >&2 || true
  exit 1
fi

if ! grep -q '^protocol mismatch as expected:' "$tmp/protocol-mismatch.log"; then
  echo "iroh transport did not reject protocol-version mismatch" >&2
  cat "$tmp/protocol-mismatch.log" >&2 || true
  exit 1
fi

"$fieldwork" pair-test \
  --payload "$payload" \
  --name "Smoke Phone" \
  --secret-key-path "$tmp/phone.key" \
  --attach "$bash_id" \
  --input $'printf "FW_BASH_RESULT_%s\\n" OK\n' \
  --expect-output "FW_BASH_RESULT_OK" \
  >"$tmp/pairtest.log" 2>&1 &
pairtest_pid=$!

for _ in $(seq 1 100); do
  if grep -q 'approve?' "$tmp/pair.log"; then
    break
  fi
  sleep 0.1
done
if ! grep -q 'approve?' "$tmp/pair.log"; then
  echo "fieldwork pair did not request desktop approval" >&2
  cat "$tmp/pair.log" >&2 || true
  cat "$tmp/pairtest.log" >&2 || true
  exit 1
fi

printf 'y\n' >&3
wait "$pair_pid"
wait "$pairtest_pid"
pair_end_s="$(date +%s)"
pair_duration_s=$((pair_end_s - pair_start_s))
if (( pair_duration_s > 15 )); then
  echo "simulated pair flow took ${pair_duration_s}s, expected <= 15s" >&2
  cat "$tmp/pair.log" >&2 || true
  cat "$tmp/pairtest.log" >&2 || true
  exit 1
fi

if ! grep -q '^paired with daemon ' "$tmp/pairtest.log"; then
  echo "pair-test did not pair" >&2
  cat "$tmp/pairtest.log" >&2 || true
  exit 1
fi
if ! grep -q '^attached ' "$tmp/pairtest.log"; then
  echo "pair-test did not attach to bash" >&2
  cat "$tmp/pairtest.log" >&2 || true
  exit 1
fi

"$fieldwork" pair-test \
  --payload "$payload" \
  --secret-key-path "$tmp/phone.key" \
  --connect-only \
  --subscribe-expect "FW_SUBSCRIBE_SESSION_READY" \
  >"$tmp/subscribe.log" 2>&1 &
subscribe_pid=$!

sleep 0.2
run_fieldwork_new "$tmp/new-subscribe.log" --name FW_SUBSCRIBE_SESSION_READY -- bash -lc 'printf "FW_SUBSCRIBE_SESSION_READY\n"; while IFS= read -r line; do printf "late: %s\n" "$line"; done'
subscribe_created="$(cat "$tmp/new-subscribe.log")"
subscribe_id="$(awk 'NR == 1 { print $2 }' "$tmp/new-subscribe.log")"

run_fieldwork_new "$tmp/new-reconnect.log" --name FW_RECONNECT_READY -- bash -lc 'printf "FW_RECONNECT_READY\n"; sleep 5; for i in $(seq 1 50); do printf "FW_RECONNECT_LINE_%02d\n" "$i"; done; sleep 10'
reconnect_created="$(cat "$tmp/new-reconnect.log")"
reconnect_id="$(awk 'NR == 1 { print $2 }' "$tmp/new-reconnect.log")"

wait "$subscribe_pid"
if ! grep -q '^subscription saw session: FW_SUBSCRIBE_SESSION_READY' "$tmp/subscribe.log"; then
  echo "paired simulated phone did not observe desktop-created session over subscription" >&2
  cat "$tmp/subscribe.log" >&2 || true
  exit 1
fi

"$fieldwork" pair-test \
  --payload "$payload" \
  --secret-key-path "$tmp/phone.key" \
  --connect-only \
  --attach "$claude_id" \
  --input $'hello from mobile\n' \
  --expect-output "stub: hello from mobile" \
  --reject-output "FW_BASH_RESULT_OK" \
  >"$tmp/attach-claude.log" 2>&1

if ! grep -q '^attached ' "$tmp/attach-claude.log"; then
  echo "paired simulated phone did not attach to default claude session" >&2
  cat "$tmp/attach-claude.log" >&2 || true
  exit 1
fi
if ! grep -q '^saw expected output: stub: hello from mobile' "$tmp/attach-claude.log"; then
  echo "paired simulated phone did not send input to default claude session" >&2
  cat "$tmp/attach-claude.log" >&2 || true
  exit 1
fi

"$fieldwork" pair-test \
  --payload "$payload" \
  --secret-key-path "$tmp/phone.key" \
  --connect-only \
  --attach "$subscribe_id" \
  --input $'phone late\n' \
  --expect-output "late: phone late" \
  --reject-output "FW_BASH_RESULT_OK" \
  --reject-output "stub: hello from mobile" \
  >"$tmp/attach-subscribe.log" 2>&1

if ! grep -q '^attached ' "$tmp/attach-subscribe.log"; then
  echo "paired simulated phone did not attach to desktop-created subscribed session" >&2
  cat "$tmp/attach-subscribe.log" >&2 || true
  exit 1
fi
if ! grep -q '^saw expected output: late: phone late' "$tmp/attach-subscribe.log"; then
  echo "paired simulated phone did not send input to subscribed desktop-created session" >&2
  cat "$tmp/attach-subscribe.log" >&2 || true
  exit 1
fi

"$fieldwork" pair-test \
  --payload "$payload" \
  --secret-key-path "$tmp/phone.key" \
  --connect-only \
  --attach "$reconnect_id" \
  --expect-output "FW_RECONNECT_READY" \
  --reconnect-delay-ms 6000 \
  --reconnect-timeout-ms 2000 \
  --reconnect-expect-output "FW_RECONNECT_LINE_50" \
  >"$tmp/reconnect.log" 2>&1

if ! grep -q '^reconnect replay saw expected output: FW_RECONNECT_LINE_50' "$tmp/reconnect.log"; then
  echo "paired simulated phone did not replay missed output after reconnect" >&2
  cat "$tmp/reconnect.log" >&2 || true
  exit 1
fi
if ! grep -q '^reconnected ' "$tmp/reconnect.log"; then
  echo "paired simulated phone did not complete timed reconnect attach" >&2
  cat "$tmp/reconnect.log" >&2 || true
  exit 1
fi

"$fieldwork" pair-test \
  --payload "$payload" \
  --secret-key-path "$tmp/phone.key" \
  --connect-only \
  --attach "$tui_id" \
  --reject-output "FW_BASH_RESULT_OK" \
  --reject-output "stub: hello from mobile" \
  --reject-output "late: phone late" \
  >"$tmp/attach-tui.log" 2>&1

if ! grep -q '^attached ' "$tmp/attach-tui.log"; then
  echo "paired simulated phone did not attach to TUI session" >&2
  cat "$tmp/attach-tui.log" >&2 || true
  exit 1
fi

"$fieldwork" pair-test \
  --payload "$payload" \
  --secret-key-path "$tmp/phone.key" \
  --connect-only \
  --expect-forbidden-create \
  --expect-forbidden-kill "$bash_id" \
  --expect-forbidden-agent-event \
  >"$tmp/mobile-forbidden.log" 2>&1

if ! grep -q '^CreateSession forbidden as expected:' "$tmp/mobile-forbidden.log"; then
  echo "paired simulated phone was not forbidden from creating a session" >&2
  cat "$tmp/mobile-forbidden.log" >&2 || true
  exit 1
fi
if ! grep -q '^KillSession forbidden as expected:' "$tmp/mobile-forbidden.log"; then
  echo "paired simulated phone was not forbidden from killing a session" >&2
  cat "$tmp/mobile-forbidden.log" >&2 || true
  exit 1
fi
if ! grep -q '^AgentStateEvent forbidden as expected:' "$tmp/mobile-forbidden.log"; then
  echo "paired simulated phone was not forbidden from emitting an agent state event" >&2
  cat "$tmp/mobile-forbidden.log" >&2 || true
  exit 1
fi

"$fieldwork" devices remove "Smoke Phone" >"$tmp/remove.log" 2>&1
"$fieldwork" pair-test \
  --payload "$payload" \
  --secret-key-path "$tmp/phone.key" \
  --connect-only \
  --expect-unauthorized \
  >"$tmp/unauth.log" 2>&1

if ! grep -q '^unauthorized as expected:' "$tmp/unauth.log"; then
  echo "revoked simulated phone identity was not rejected" >&2
  cat "$tmp/unauth.log" >&2 || true
  exit 1
fi

before_restart="$("$fieldwork" ls)"
kill "$daemon_pid"
wait "$daemon_pid" 2>/dev/null || true
daemon_pid=""
rm -f "$XDG_RUNTIME_DIR/fieldwork/control.sock"

start_daemon "$tmp/daemon2.log"
after_restart="$("$fieldwork" ls)"
if ! printf '%s' "$after_restart" | grep -q 'bash'; then
  echo "restored session list did not include the bash session" >&2
  printf 'before restart: %s\n' "$before_restart" >&2
  printf 'after restart: %s\n' "$after_restart" >&2
  exit 1
fi
if ! printf '%s' "$after_restart" | grep -q 'claude'; then
  echo "restored session list did not include the default claude session" >&2
  printf 'before restart: %s\n' "$before_restart" >&2
  printf 'after restart: %s\n' "$after_restart" >&2
  exit 1
fi
if ! printf '%s' "$after_restart" | grep -Eq 'vim|vi'; then
  echo "restored session list did not include the TUI session" >&2
  printf 'before restart: %s\n' "$before_restart" >&2
  printf 'after restart: %s\n' "$after_restart" >&2
  exit 1
fi
if ! printf '%s' "$after_restart" | grep -q 'FW_SUBSCRIBE_SESSION_READY'; then
  echo "restored session list did not include the subscribed desktop-created session" >&2
  printf 'before restart: %s\n' "$before_restart" >&2
  printf 'after restart: %s\n' "$after_restart" >&2
  exit 1
fi
if ! printf '%s' "$after_restart" | grep -q 'FW_RECONNECT_READY'; then
  echo "restored session list did not include the reconnect replay session" >&2
  printf 'before restart: %s\n' "$before_restart" >&2
  printf 'after restart: %s\n' "$after_restart" >&2
  exit 1
fi

printf 'PASS create/default: %s\n' "$claude_created"
printf 'PASS create/bash: %s\n' "$bash_created"
printf 'PASS create/tui: %s\n' "$tui_created"
printf 'PASS create/subscribed: %s\n' "$subscribe_created"
printf 'PASS create/reconnect: %s\n' "$reconnect_created"
printf 'PASS protocol mismatch: %s\n' "$(tr '\n' ' ' <"$tmp/protocol-mismatch.log")"
printf 'PASS pair duration s: %s\n' "$pair_duration_s"
printf 'PASS pair/list/attach bash: %s\n' "$(tr '\n' ' ' <"$tmp/pairtest.log")"
printf 'PASS subscribed session appeared: %s\n' "$(tr '\n' ' ' <"$tmp/subscribe.log")"
printf 'PASS attach default claude: %s\n' "$(tr '\n' ' ' <"$tmp/attach-claude.log")"
printf 'PASS attach subscribed session: %s\n' "$(tr '\n' ' ' <"$tmp/attach-subscribe.log")"
printf 'PASS reconnect replay: %s\n' "$(tr '\n' ' ' <"$tmp/reconnect.log")"
printf 'PASS attach tui: %s\n' "$(tr '\n' ' ' <"$tmp/attach-tui.log")"
printf 'PASS mobile forbidden ops: %s\n' "$(tr '\n' ' ' <"$tmp/mobile-forbidden.log")"
printf 'PASS revoke: %s\n' "$(tr '\n' ' ' <"$tmp/unauth.log")"
printf 'PASS restart restore: %s\n' "$after_restart"
