#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp="$(mktemp -d)"
daemon_pid=""
daemon_pid2=""
subscribe_pid=""
relay_pid=""
host_cargo_home="${CARGO_HOME:-$HOME/.cargo}"
host_rustup_home="${RUSTUP_HOME:-$HOME/.rustup}"
runtime_panic_pattern='thread .+ panicked|panicked at|task [0-9]+ was cancelled'

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
  if [[ -n "$relay_pid" ]]; then
    kill "$relay_pid" 2>/dev/null || true
    wait "$relay_pid" 2>/dev/null || true
  fi
  rm -rf "$tmp"
}
trap cleanup EXIT

check_runtime_panic_logs() {
  local log_dir="$1"
  local panic_log="$2"
  local logs=("$log_dir"/*.log)

  if [[ ! -e "${logs[0]}" ]]; then
    return 0
  fi

  if grep -R -n -E "$runtime_panic_pattern" "${logs[@]}" >"$panic_log"; then
    echo "local handoff smoke logs contain a runtime panic" >&2
    cat "$panic_log" >&2
    return 1
  fi
}

self_test_panic_guard() {
  local clean_dir="$tmp/clean-logs"
  local panic_dir="$tmp/panic-logs"

  mkdir -p "$clean_dir" "$panic_dir"
  printf 'normal daemon shutdown\n' >"$clean_dir/daemon.log"
  check_runtime_panic_logs "$clean_dir" "$tmp/clean-panic.log"

  printf "thread 'tokio-rt-worker' panicked at tokio/src/task/join_set.rs:453:29: task 51 was cancelled\n" >"$panic_dir/pair-test.log"
  if check_runtime_panic_logs "$panic_dir" "$tmp/panic-panic.log" 2>"$tmp/panic-stderr.log"; then
    echo "panic guard self-test did not reject a runtime panic log" >&2
    exit 1
  fi
  grep -Fq "local handoff smoke logs contain a runtime panic" "$tmp/panic-stderr.log"
  grep -Fq "pair-test.log" "$tmp/panic-stderr.log"
  printf 'local handoff panic guard self-test ok\n'
}

if [[ "${1:-}" == "--self-test-panic-guard" ]]; then
  self_test_panic_guard
  exit 0
elif [[ $# -gt 0 ]]; then
  echo "unknown argument: $1" >&2
  exit 2
fi

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

# Local relay rendezvous for the typed-code pairing path. The daemon publishes
# code -> reachability blob here on `fieldwork pair`, and the phone simulator
# resolves it back via `pair-test --code`. Loopback HTTP, no TLS, temp sqlite.
relay_port=18443
relay_metrics_port=19090
relay_control_url="http://127.0.0.1:$relay_port"
relay_metrics_url="http://127.0.0.1:$relay_metrics_port"
export FIELDWORK_RELAY_CONTROL_URL="$relay_control_url"

# The daemon's relay signing key normally lives in the OS keychain, which is
# unavailable in this isolated temp HOME (and in headless CI). Provide a fixed
# test key via the same env override path the iroh secret key uses so the
# daemon can sign its relay publish and the typed-code path is exercisable.
export FIELDWORK_RELAY_SIGNING_KEY_B64="BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc"

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

cargo build -q -p fieldwork-cli -p fieldwork-daemon -p fieldwork-relay --features fieldwork-cli/test-client

fieldwork="$cargo_target_dir/debug/fieldwork"
fieldworkd="$cargo_target_dir/debug/fieldworkd"
relay_bin="$cargo_target_dir/debug/fieldwork-relay"

start_relay() {
  FIELDWORK_RELAY_ADDR="127.0.0.1:$relay_port" \
  FIELDWORK_RELAY_METRICS_ADDR="127.0.0.1:$relay_metrics_port" \
  FIELDWORK_RELAY_DB_PATH="$tmp/relay.db" \
    "$relay_bin" >"$tmp/relay.log" 2>&1 &
  relay_pid=$!
  for _ in $(seq 1 100); do
    if curl -fsS "$relay_control_url/healthz" >/dev/null 2>&1; then
      return 0
    fi
    if ! kill -0 "$relay_pid" 2>/dev/null; then
      echo "fieldwork-relay exited before becoming healthy" >&2
      cat "$tmp/relay.log" >&2 || true
      exit 1
    fi
    sleep 0.1
  done
  echo "fieldwork-relay did not become healthy at $relay_control_url" >&2
  cat "$tmp/relay.log" >&2 || true
  exit 1
}

# Resolves a published pairing code through the relay rendezvous endpoint,
# returning the opaque "fw1..." ticket blob. The hit is single-use, so each code
# may be resolved at most once.
resolve_ticket_blob() {
  local code="$1"
  curl -fsS "$relay_control_url/v1/pair/resolve/$code" \
    | sed -n 's/.*"ticket_blob"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p'
}

# Reads the aggregate count of pairing codes the relay has accepted via publish.
# This is a non-consuming readiness signal (resolve is single-use), letting the
# typed-code path wait for the daemon's async publish to land before resolving.
relay_publish_count() {
  curl -fsS "$relay_metrics_url/metrics" 2>/dev/null \
    | awk '/^fieldwork_relay_pairing_code_publishes_total /{print $2; found=1} END{if(!found) print 0}'
}

# Blocks until the relay publish counter advances past a recorded baseline.
wait_for_publish_after() {
  local baseline="$1"
  for _ in $(seq 1 100); do
    if (( "$(relay_publish_count)" > baseline )); then
      return 0
    fi
    sleep 0.1
  done
  return 1
}

# Captures the human pairing code printed by `fieldwork pair`. The command emits
# a QR (unparseable unicode blocks) plus a grouped code line ("    AB C12"); we
# squeeze it back to the 5-char Crockford code the daemon generated.
capture_pair_code() {
  local log_path="$1"
  local code=""
  for _ in $(seq 1 100); do
    code="$(
      awk '
        prev ~ /enter this code:/ { gsub(/[[:space:]]/, "", $0); print; exit }
        { prev = $0 }
      ' "$log_path"
    )"
    if [[ -n "$code" ]]; then
      printf '%s' "$code"
      return 0
    fi
    sleep 0.1
  done
  return 1
}

start_relay

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

run_fieldwork_new "$tmp/new-claude.log" --dir "$tmp/home" claude
claude_created="$(cat "$tmp/new-claude.log")"
claude_id="$(awk 'NR == 1 { print $2 }' "$tmp/new-claude.log")"

run_fieldwork_new "$tmp/new-bash.log" bash
bash_created="$(cat "$tmp/new-bash.log")"
bash_id="$(awk 'NR == 1 { print $2 }' "$tmp/new-bash.log")"

run_fieldwork_new "$tmp/new-tui.log" "${tui_command[@]}"
tui_created="$(cat "$tmp/new-tui.log")"
tui_id="$(awk 'NR == 1 { print $2 }' "$tmp/new-tui.log")"

"$fieldwork" hook claude-stop \
  --session "$claude_id" \
  --last-line "smoke approval requested" \
  >"$tmp/hook-claude.log" 2>&1
"$fieldwork" ls >"$tmp/hook-list.log"
if ! awk -F '\t' -v id="$claude_id" '$1 == id && $3 == "AwaitingInput" { found = 1 } END { exit(found ? 0 : 1) }' "$tmp/hook-list.log"; then
  echo "Claude hook did not update the matching session state" >&2
  cat "$tmp/hook-claude.log" "$tmp/hook-list.log" >&2 || true
  exit 1
fi
if printf '{"type":"approval_requested"}\n' | "$fieldwork" hook codex-event --session "$claude_id" >"$tmp/hook-mismatch.log" 2>&1; then
  echo "mismatched Codex hook unexpectedly succeeded for Claude session" >&2
  cat "$tmp/hook-mismatch.log" >&2 || true
  exit 1
fi
if ! grep -q 'does not match' "$tmp/hook-mismatch.log"; then
  echo "mismatched hook failure did not surface the daemon error" >&2
  cat "$tmp/hook-mismatch.log" >&2 || true
  exit 1
fi

pair_start_s="$(date +%s)"
publish_baseline_qr="$(relay_publish_count)"
mkfifo "$tmp/pair.in"
exec 3<>"$tmp/pair.in"
"$fieldwork" pair <"$tmp/pair.in" >"$tmp/pair.log" 2>&1 &
pair_pid=$!

# The v2 `fieldwork pair` prints a compact QR plus a human pairing CODE; the raw
# "fw1..." ticket never appears in plaintext. Capture the code, then resolve it
# once through the relay rendezvous to recover the exact ticket the QR encodes.
# The relay resolve is single-use AND per-client rate limited, so wait for the
# daemon's async publish to land via the non-consuming publish counter, then
# resolve exactly once.
pair_code="$(capture_pair_code "$tmp/pair.log" || true)"
if [[ -z "$pair_code" ]]; then
  echo "fieldwork pair did not print a pairing code" >&2
  cat "$tmp/pair.log" >&2 || true
  exit 1
fi

if ! wait_for_publish_after "$publish_baseline_qr"; then
  echo "daemon did not publish the QR pairing code to the relay" >&2
  cat "$tmp/pair.log" "$tmp/relay.log" >&2 || true
  exit 1
fi

payload="$(resolve_ticket_blob "$pair_code" || true)"
if [[ -z "$payload" ]]; then
  echo "relay did not resolve a pairing ticket for the published code" >&2
  cat "$tmp/pair.log" "$tmp/relay.log" >&2 || true
  exit 1
fi
if [[ "$payload" != fw1* ]]; then
  echo "resolved pairing ticket is not a compact fw1 ticket: $payload" >&2
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

if ! "$fieldwork" pair-test \
  --payload "$payload" \
  --expect-local-cli-forbidden \
  >"$tmp/local-cli-forbidden.log" 2>&1; then
  echo "iroh LocalCli handshake probe failed" >&2
  cat "$tmp/local-cli-forbidden.log" >&2 || true
  exit 1
fi

if ! grep -q '^LocalCli Hello forbidden as expected:' "$tmp/local-cli-forbidden.log"; then
  echo "iroh transport did not reject a LocalCli client kind before Welcome" >&2
  cat "$tmp/local-cli-forbidden.log" >&2 || true
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

# Typed-code path: a second `fieldwork pair` mints a fresh code (the daemon keeps
# multiple active codes), the daemon publishes it to the relay, and the phone
# simulator resolves reachability purely from the typed code via the relay
# rendezvous — never touching the QR/ticket. This exercises the relay-hosted leg
# end to end while desktop approval stays the final gate.
publish_baseline="$(relay_publish_count)"
mkfifo "$tmp/pair-code.in"
exec 4<>"$tmp/pair-code.in"
"$fieldwork" pair <"$tmp/pair-code.in" >"$tmp/pair-code.log" 2>&1 &
pair_code_pid=$!

typed_code="$(capture_pair_code "$tmp/pair-code.log" || true)"
if [[ -z "$typed_code" ]]; then
  echo "second fieldwork pair did not print a pairing code for the typed-code path" >&2
  cat "$tmp/pair-code.log" >&2 || true
  exit 1
fi

# The daemon publishes the code to the relay asynchronously; `pair-test --code`
# resolves with a single GET (no retry), so wait for the publish to land first.
if ! wait_for_publish_after "$publish_baseline"; then
  echo "daemon did not publish the typed pairing code to the relay" >&2
  cat "$tmp/pair-code.log" "$tmp/relay.log" >&2 || true
  exit 1
fi

"$fieldwork" pair-test \
  --code "$typed_code" \
  --relay-control-url "$relay_control_url" \
  --name "Smoke Typed Phone" \
  --secret-key-path "$tmp/phone-typed.key" \
  --attach "$bash_id" \
  --input $'printf "FW_TYPED_RESULT_%s\\n" OK\n' \
  --expect-output "FW_TYPED_RESULT_OK" \
  >"$tmp/pairtest-code.log" 2>&1 &
pairtest_code_pid=$!

for _ in $(seq 1 100); do
  if grep -q 'approve?' "$tmp/pair-code.log"; then
    break
  fi
  sleep 0.1
done
if ! grep -q 'approve?' "$tmp/pair-code.log"; then
  echo "typed-code fieldwork pair did not request desktop approval" >&2
  cat "$tmp/pair-code.log" >&2 || true
  cat "$tmp/pairtest-code.log" >&2 || true
  exit 1
fi

printf 'y\n' >&4
wait "$pair_code_pid"
wait "$pairtest_code_pid"

if ! grep -q '^paired with daemon ' "$tmp/pairtest-code.log"; then
  echo "typed-code pair-test did not pair through the relay rendezvous" >&2
  cat "$tmp/pairtest-code.log" "$tmp/relay.log" >&2 || true
  exit 1
fi
if ! grep -q '^attached ' "$tmp/pairtest-code.log"; then
  echo "typed-code pair-test did not attach to bash" >&2
  cat "$tmp/pairtest-code.log" >&2 || true
  exit 1
fi

# Remove the typed-code device so the later revoke probe stays unambiguous about
# which simulated identity it expects to be rejected.
"$fieldwork" devices remove "Smoke Typed Phone" >"$tmp/remove-typed.log" 2>&1

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
  echo "paired simulated phone did not attach to explicit claude session" >&2
  cat "$tmp/attach-claude.log" >&2 || true
  exit 1
fi
if ! grep -q '^saw expected output: stub: hello from mobile' "$tmp/attach-claude.log"; then
  echo "paired simulated phone did not send input to explicit claude session" >&2
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
  echo "restored session list did not include the explicit claude session" >&2
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

check_runtime_panic_logs "$tmp" "$tmp/panic.log"

printf 'PASS create/claude: %s\n' "$claude_created"
printf 'PASS create/bash: %s\n' "$bash_created"
printf 'PASS create/tui: %s\n' "$tui_created"
printf 'PASS create/subscribed: %s\n' "$subscribe_created"
printf 'PASS create/reconnect: %s\n' "$reconnect_created"
printf 'PASS protocol mismatch: %s\n' "$(tr '\n' ' ' <"$tmp/protocol-mismatch.log")"
printf 'PASS iroh LocalCli rejected: %s\n' "$(tr '\n' ' ' <"$tmp/local-cli-forbidden.log")"
printf 'PASS pair duration s: %s\n' "$pair_duration_s"
printf 'PASS pair/list/attach bash (QR ticket path): %s\n' "$(tr '\n' ' ' <"$tmp/pairtest.log")"
printf 'PASS pair/attach bash (typed-code relay path): %s\n' "$(tr '\n' ' ' <"$tmp/pairtest-code.log")"
printf 'PASS subscribed session appeared: %s\n' "$(tr '\n' ' ' <"$tmp/subscribe.log")"
printf 'PASS attach explicit claude: %s\n' "$(tr '\n' ' ' <"$tmp/attach-claude.log")"
printf 'PASS attach subscribed session: %s\n' "$(tr '\n' ' ' <"$tmp/attach-subscribe.log")"
printf 'PASS reconnect replay: %s\n' "$(tr '\n' ' ' <"$tmp/reconnect.log")"
printf 'PASS attach tui: %s\n' "$(tr '\n' ' ' <"$tmp/attach-tui.log")"
printf 'PASS mobile forbidden ops: %s\n' "$(tr '\n' ' ' <"$tmp/mobile-forbidden.log")"
printf 'PASS revoke: %s\n' "$(tr '\n' ' ' <"$tmp/unauth.log")"
printf 'PASS restart restore: %s\n' "$after_restart"
