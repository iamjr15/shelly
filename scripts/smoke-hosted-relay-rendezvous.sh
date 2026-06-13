#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ "${1:-}" == "--" ]]; then
  shift
fi
relay_control_url="${1:-${FIELDWORK_HOSTED_RELAY_CONTROL_URL:-${FIELDWORK_RELAY_CONTROL_URL:-}}}"

if [[ -z "$relay_control_url" ]]; then
  cat >&2 <<'MSG'
Set FIELDWORK_HOSTED_RELAY_CONTROL_URL, FIELDWORK_RELAY_CONTROL_URL, or pass the
relay control URL as the first argument.

Example:
  scripts/smoke-hosted-relay-rendezvous.sh https://relay.example.com
MSG
  exit 2
fi

tmp="$(mktemp -d)"
daemon_pid=""
pair_pid=""
pairtest_pid=""
host_cargo_home="${CARGO_HOME:-$HOME/.cargo}"
host_rustup_home="${RUSTUP_HOME:-$HOME/.rustup}"

dump_log() {
  local path="$1"
  if [[ -f "$path" ]]; then
    printf '\n== %s ==\n' "$(basename "$path")" >&2
    tail -200 "$path" >&2 || true
  fi
}

dump_smoke_logs() {
  dump_log "$tmp/relay-health.txt"
  dump_log "$tmp/relay-version.json"
  dump_log "$tmp/new-hosted.log"
  dump_log "$tmp/pair.log"
  dump_log "$tmp/pairtest.log"
  dump_log "$tmp/daemon.log"
}

cleanup() {
  local status=$?
  if [[ -n "$daemon_pid" ]]; then
    kill "$daemon_pid" 2>/dev/null || true
    wait "$daemon_pid" 2>/dev/null || true
  fi
  if [[ "$status" -ne 0 || "${FIELDWORK_PRESERVE_HOSTED_RELAY_SMOKE:-0}" == "1" ]]; then
    printf 'hosted relay smoke artifacts preserved: %s\n' "$tmp" >&2
    if [[ "$status" -ne 0 ]]; then
      dump_smoke_logs
    fi
  else
    rm -rf "$tmp"
  fi
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
export FIELDWORK_RELAY_CONTROL_URL="$relay_control_url"
export FIELDWORK_IROH_SECRET_KEY_B64="${FIELDWORK_IROH_SECRET_KEY_B64:-BQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQU}"
export FIELDWORK_RELAY_SIGNING_KEY_B64="${FIELDWORK_RELAY_SIGNING_KEY_B64:-BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc}"
export FIELDWORK_SCROLLBACK_ENCRYPTION_ENABLED=false
export PATH="$tmp/bin:$PATH"

cat >"$tmp/bin/claude" <<'EOF'
#!/usr/bin/env bash
printf 'Claude Code hosted relay smoke stub\n'
while IFS= read -r line; do
  printf 'hosted-relay-stub: %s\n' "$line"
done
EOF
chmod +x "$tmp/bin/claude"

cargo_target_dir="${CARGO_TARGET_DIR:-$repo_root/target}"
fieldwork_bin_overridden=0
if [[ -n "${FIELDWORK_BIN:-}" ]]; then
  fieldwork="$FIELDWORK_BIN"
  fieldwork_bin_overridden=1
else
  fieldwork="$cargo_target_dir/release/fieldwork"
fi
fieldworkd="${FIELDWORK_DAEMON_BIN:-$cargo_target_dir/release/fieldworkd}"

if [[ ! -x "$fieldwork" || ! -x "$fieldworkd" ]]; then
  cargo build -q -p fieldwork-cli -p fieldwork-daemon --features fieldwork-cli/test-client
  fieldwork="${FIELDWORK_BIN:-$cargo_target_dir/debug/fieldwork}"
  fieldworkd="${FIELDWORK_DAEMON_BIN:-$cargo_target_dir/debug/fieldworkd}"
fi

if [[ ! -x "$fieldwork" || ! -x "$fieldworkd" ]]; then
  echo "fieldwork and fieldworkd binaries are required" >&2
  exit 1
fi

if ! "$fieldwork" pair-test --help >/dev/null 2>&1; then
  if [[ "$fieldwork_bin_overridden" -eq 1 ]]; then
    echo "FIELDWORK_BIN must point to a fieldwork binary built with --features fieldwork-cli/test-client for hosted relay smoke" >&2
    exit 1
  fi

  cargo build -q -p fieldwork-cli --features fieldwork-cli/test-client
  fieldwork="$cargo_target_dir/debug/fieldwork"
  if ! "$fieldwork" pair-test --help >/dev/null 2>&1; then
    echo "debug fieldwork binary does not expose pair-test after building with fieldwork-cli/test-client" >&2
    exit 1
  fi
fi

curl -fsS --max-time 10 "$relay_control_url/healthz" >"$tmp/relay-health.txt"
curl -fsS --max-time 10 "$relay_control_url/v1/version" >"$tmp/relay-version.json"
node -e '
const fs = require("fs");
const version = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (version.contract_version !== 2) {
  throw new Error(`expected relay contract_version=2, got ${version.contract_version}`);
}
' "$tmp/relay-version.json"

wait_for_socket() {
  for _ in $(seq 1 100); do
    if [[ -S "$XDG_RUNTIME_DIR/fieldwork/control.sock" ]]; then
      return 0
    fi
    sleep 0.1
  done
  return 1
}

"$fieldworkd" >"$tmp/daemon.log" 2>&1 &
daemon_pid=$!
if ! wait_for_socket; then
  echo "fieldworkd did not create its control socket" >&2
  tail -100 "$tmp/daemon.log" >&2 || true
  exit 1
fi

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

"$fieldwork" new --name hosted_relay bash -lc 'printf "HOSTED_RELAY_READY\n"; exec env PS1="$ " bash --noprofile --norc -i' >"$tmp/new-hosted.log" 2>&1
session_id="$(awk 'NR == 1 { print $2 }' "$tmp/new-hosted.log")"
if [[ -z "$session_id" ]]; then
  echo "could not read hosted_relay session id" >&2
  cat "$tmp/new-hosted.log" >&2 || true
  exit 1
fi

mkfifo "$tmp/pair.in"
exec 3<>"$tmp/pair.in"
"$fieldwork" pair <"$tmp/pair.in" >"$tmp/pair.log" 2>&1 &
pair_pid=$!

pair_code="$(capture_pair_code "$tmp/pair.log" || true)"
if [[ -z "$pair_code" ]]; then
  echo "fieldwork pair did not print a pairing code" >&2
  cat "$tmp/pair.log" >&2 || true
  exit 1
fi

# Relay publish is asynchronous; give the hosted control plane a short window
# before the one-shot pair-test resolve.
sleep "${FIELDWORK_HOSTED_RELAY_PUBLISH_WAIT_SECONDS:-5}"

"$fieldwork" pair-test \
  --code "$pair_code" \
  --relay-control-url "$relay_control_url" \
  --name "Hosted Relay Smoke Phone" \
  --secret-key-path "$tmp/hosted-phone.key" \
  --attach "$session_id" \
  --input $'printf "HOSTED_RELAY_RESULT_%s\\n" OK\n' \
  --expect-output "HOSTED_RELAY_RESULT_OK" \
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
  cat "$tmp/pair.log" "$tmp/pairtest.log" "$tmp/daemon.log" >&2 || true
  exit 1
fi

printf 'y\n' >&3
pair_status=0
pairtest_status=0
wait "$pair_pid" || pair_status=$?
wait "$pairtest_pid" || pairtest_status=$?
if [[ "$pair_status" -ne 0 || "$pairtest_status" -ne 0 ]]; then
  echo "hosted relay pair flow failed: pair_status=$pair_status pairtest_status=$pairtest_status" >&2
  dump_smoke_logs
  exit 1
fi

if ! grep -q '^paired with daemon ' "$tmp/pairtest.log"; then
  echo "pair-test did not pair through hosted relay rendezvous" >&2
  cat "$tmp/pairtest.log" "$tmp/daemon.log" >&2 || true
  exit 1
fi
if ! grep -q '^attached ' "$tmp/pairtest.log"; then
  echo "pair-test did not attach to the hosted_relay session" >&2
  cat "$tmp/pairtest.log" >&2 || true
  exit 1
fi
if ! grep -q '^saw expected output: HOSTED_RELAY_RESULT_OK' "$tmp/pairtest.log"; then
  echo "pair-test did not observe hosted relay PTY output" >&2
  cat "$tmp/pairtest.log" >&2 || true
  exit 1
fi

printf 'hosted relay rendezvous smoke ok: %s\n' "$relay_control_url"
