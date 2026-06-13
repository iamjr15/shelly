#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp="$(mktemp -d)"
daemon_pid=""
host_cargo_home="${CARGO_HOME:-$HOME/.cargo}"
host_rustup_home="${RUSTUP_HOME:-$HOME/.rustup}"

cleanup() {
  if [[ -n "$daemon_pid" ]]; then
    kill "$daemon_pid" 2>/dev/null || true
    wait "$daemon_pid" 2>/dev/null || true
  fi
  if [[ "${SHELLY_SMOKE_KEEP_TMP:-}" == "1" ]]; then
    echo "kept smoke temp dir: $tmp" >&2
  else
    rm -rf "$tmp"
  fi
}
trap cleanup EXIT

if ! command -v expect >/dev/null 2>&1; then
  echo "expect is required for the no-args raw-terminal smoke" >&2
  exit 127
fi

mkdir -p "$tmp/home" "$tmp/runtime" "$tmp/config" "$tmp/state" "$tmp/cache" "$tmp/bin"
chmod 700 "$tmp/home" "$tmp/runtime" "$tmp/config" "$tmp/state" "$tmp/cache"

export HOME="$tmp/home"
export XDG_RUNTIME_DIR="$tmp/runtime"
export XDG_CONFIG_HOME="$tmp/config"
export XDG_STATE_HOME="$tmp/state"
export XDG_CACHE_HOME="$tmp/cache"
export CARGO_HOME="$host_cargo_home"
export RUSTUP_HOME="$host_rustup_home"
export SHELLY_IROH_SECRET_KEY_B64="BQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQU"
export SHELLY_SCROLLBACK_ENCRYPTION_ENABLED=false
export SHELLY_DISABLE_UPDATE_CHECK=1
export PATH="$tmp/bin:$PATH"

cat >"$tmp/bin/shelly-shell" <<'EOF'
#!/usr/bin/env bash
printf 'Shelly shell no-args smoke stub\n'
while IFS= read -r line; do
  printf 'shell: %s\n' "$line"
done
EOF
chmod +x "$tmp/bin/shelly-shell"
export SHELL="$tmp/bin/shelly-shell"

cargo_target_dir="${CARGO_TARGET_DIR:-$repo_root/target}"
cargo build -q -p shelly-cli -p shelly-daemon

shelly="$cargo_target_dir/debug/shelly"
shellyd="$cargo_target_dir/debug/shellyd"

"$shellyd" >"$tmp/daemon.log" 2>&1 &
daemon_pid=$!

for _ in $(seq 1 80); do
  if [[ -S "$XDG_RUNTIME_DIR/shelly/control.sock" ]]; then
    break
  fi
  sleep 0.1
done
if [[ ! -S "$XDG_RUNTIME_DIR/shelly/control.sock" ]]; then
  echo "shellyd did not create its control socket" >&2
  tail -100 "$tmp/daemon.log" >&2 || true
  exit 1
fi

run_no_args_and_detach() {
  local label="$1"
  local bin="$2"
  local log_path="$tmp/${label}.log"

  if ! SHELLY_BIN="$bin" EXPECT_LOG="$log_path" expect <<'EXPECT'
set timeout 10
stty rows 24 columns 80
log_file -noappend $env(EXPECT_LOG)
spawn -noecho $env(SHELLY_BIN)
expect {
  "Shelly shell no-args smoke stub" {}
  timeout {
    puts stderr "timed out waiting for no-args default session output"
    exit 124
  }
  eof {
    puts stderr "shelly exited before no-args attach produced output"
    exit 1
  }
}
send "\002d"
expect {
  eof {}
  timeout {
    puts stderr "timed out waiting for shelly detach"
    exit 124
  }
}
set wait_result [wait]
set exit_status [lindex $wait_result 3]
if {$exit_status != 0} {
  exit $exit_status
}
EXPECT
  then
    cat "$log_path" >&2 || true
    tail -100 "$tmp/daemon.log" >&2 || true
    exit 1
  fi
}

created_name() {
  local log_path="$1"
  awk '/shelly session started / { print $5; exit } /created / { print $3; exit }' "$log_path" | tr -d '\r'
}

run_no_args_and_detach shelly "$shelly"
"$shelly" new bash >"$tmp/shelly-new-bash.log" 2>&1

first_name="$(created_name "$tmp/shelly.log")"
new_bash_name="$(created_name "$tmp/shelly-new-bash.log")"

if [[ -z "$first_name" || -z "$new_bash_name" ]]; then
  echo "no-args run did not print created session names" >&2
  cat "$tmp/shelly.log" "$tmp/shelly-new-bash.log" >&2 || true
  exit 1
fi

if [[ "$new_bash_name" == "$first_name" ]]; then
  echo "shelly new bash reused an existing auto-generated session name $new_bash_name" >&2
  exit 1
fi

for name in "$first_name" "$new_bash_name"; do
  if [[ ! "$name" =~ ^[[:alnum:]_-]+$ ]]; then
    echo "auto-generated session name is not one word: $name" >&2
    exit 1
  fi
done

"$shelly" ls >"$tmp/sessions.log"

if ! awk -v name="$first_name" -v shell="$SHELL" '$2 == name && $NF == shell { found = 1 } END { exit(found ? 0 : 1) }' "$tmp/sessions.log"; then
  echo "session list does not contain auto-named shell session $first_name" >&2
  cat "$tmp/sessions.log" >&2
  exit 1
fi

if ! awk -v name="$new_bash_name" '$2 == name && $NF == "bash" { found = 1 } END { exit(found ? 0 : 1) }' "$tmp/sessions.log"; then
  echo "session list does not contain auto-named bash session $new_bash_name" >&2
  cat "$tmp/sessions.log" >&2
  exit 1
fi

"$shelly" kill "$first_name" >"$tmp/shelly-kill.log" 2>&1
if ! grep -Fq "$first_name" "$tmp/shelly-kill.log"; then
  echo "shelly kill did not report removed session $first_name" >&2
  cat "$tmp/shelly-kill.log" >&2
  exit 1
fi

"$shelly" kill-all >"$tmp/shelly-kill-all.log" 2>&1
if ! grep -Fq "removed 1 session" "$tmp/shelly-kill-all.log"; then
  echo "shelly kill-all did not report removing the remaining session" >&2
  cat "$tmp/shelly-kill-all.log" >&2
  exit 1
fi

"$shelly" ls >"$tmp/sessions-after-kill.log"
if ! grep -Fxq "No sessions." "$tmp/sessions-after-kill.log"; then
  echo "session list is not empty after shelly kill-all" >&2
  cat "$tmp/sessions-after-kill.log" >&2
  exit 1
fi

printf 'PASS shelly auto-named default, unnamed-new, kill, and kill-all sessions: %s %s\n' "$first_name" "$new_bash_name"
