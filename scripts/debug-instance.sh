#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
session="${FIELDWORK_DEBUG_TMUX_SESSION:-fieldwork-debug}"
state_root="${FIELDWORK_DEBUG_ROOT:-${TMPDIR:-/tmp}/fieldwork-debug-${USER:-$(id -u)}}"

configure_paths() {
  bin_dir="$state_root/bin"
  home_dir="$state_root/home"
  runtime_dir="$state_root/runtime"
  config_dir="$state_root/config"
  state_dir="$state_root/state"
  cache_dir="$state_root/cache"
  log_dir="$state_root/logs"
  runner="$state_root/run-daemon.sh"
}

configure_paths

usage() {
  cat <<USAGE
Usage: scripts/debug-instance.sh <start|status|env|shell|stop>

Starts an isolated tmux-backed fieldworkd debug instance. It does not install a
launchd/systemd service and does not use the normal Fieldwork runtime socket.

Environment overrides:
  FIELDWORK_DEBUG_TMUX_SESSION  tmux session name (default: fieldwork-debug)
  FIELDWORK_DEBUG_ROOT          isolated state root (default: \$TMPDIR/fieldwork-debug-\$USER)
USAGE
}

command="${1:-start}"

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "$1 is required" >&2
    exit 127
  fi
}

prepare_dirs() {
  mkdir -p "$bin_dir" "$home_dir" "$runtime_dir" "$config_dir" "$state_dir" "$cache_dir" "$log_dir"
  chmod 700 "$home_dir" "$runtime_dir" "$config_dir" "$state_dir" "$cache_dir" "$log_dir"
}

ensure_links() {
  if [[ -x "$repo_root/target/debug/fieldwork" ]]; then
    ln -sf "$repo_root/target/debug/fieldwork" "$bin_dir/fieldwork"
    ln -sf "$repo_root/target/debug/fieldwork" "$bin_dir/fw"
  fi
  if [[ -x "$repo_root/target/debug/fieldworkd" ]]; then
    ln -sf "$repo_root/target/debug/fieldworkd" "$bin_dir/fieldworkd"
  fi
}

write_runner() {
  ensure_links
  cat > "$runner" <<RUNNER
#!/usr/bin/env bash
set -euo pipefail
cd "$repo_root"
export HOME="$home_dir"
export XDG_RUNTIME_DIR="$runtime_dir"
export XDG_CONFIG_HOME="$config_dir"
export XDG_STATE_HOME="$state_dir"
export XDG_CACHE_HOME="$cache_dir"
export FIELDWORK_DISABLE_UPDATE_CHECK=1
export FIELDWORK_SCROLLBACK_ENCRYPTION_ENABLED=false
export PATH="$bin_dir:\$PATH"
export RUST_LOG="\${RUST_LOG:-fieldwork=debug}"
exec "$repo_root/target/debug/fieldworkd" 2>&1 | tee -a "$log_dir/fieldworkd.log"
RUNNER
  chmod 700 "$runner"
}

session_marker_root() {
  tmux show-environment -t "$session" FIELDWORK_DEBUG_ROOT 2>/dev/null \
    | sed 's/^FIELDWORK_DEBUG_ROOT=//'
}

adopt_existing_session_root() {
  if [[ -n "${FIELDWORK_DEBUG_ROOT+x}" ]]; then
    return
  fi
  if ! command -v tmux >/dev/null 2>&1; then
    return
  fi
  if tmux has-session -t "$session" 2>/dev/null; then
    local existing_root
    existing_root="$(session_marker_root || true)"
    if [[ -n "$existing_root" ]]; then
      state_root="$existing_root"
      configure_paths
    fi
  fi
}

wait_for_socket() {
  local last_output=""
  for _ in {1..80}; do
    if last_output="$(run_debug "$bin_dir/fw" daemon status 2>&1)" && grep -q "socket: reachable" <<<"$last_output"; then
      return 0
    fi
    sleep 0.1
  done
  echo "fieldwork debug daemon did not become reachable" >&2
  echo "$last_output" >&2
  exit 1
}

run_debug() {
  HOME="$home_dir" \
  XDG_RUNTIME_DIR="$runtime_dir" \
  XDG_CONFIG_HOME="$config_dir" \
  XDG_STATE_HOME="$state_dir" \
  XDG_CACHE_HOME="$cache_dir" \
  FIELDWORK_DISABLE_UPDATE_CHECK=1 \
  FIELDWORK_SCROLLBACK_ENCRYPTION_ENABLED=false \
  PATH="$bin_dir:$PATH" \
  "$@"
}

shell_quote() {
  printf "%q" "$1"
}

env_command_prefix() {
  printf "FIELDWORK_DEBUG_TMUX_SESSION=%s FIELDWORK_DEBUG_ROOT=%s" \
    "$(shell_quote "$session")" \
    "$(shell_quote "$state_root")"
}

print_env() {
  printf "export FIELDWORK_DEBUG_TMUX_SESSION=%s\n" "$(shell_quote "$session")"
  printf "export FIELDWORK_DEBUG_ROOT=%s\n" "$(shell_quote "$state_root")"
  printf "export HOME=%s\n" "$(shell_quote "$home_dir")"
  printf "export XDG_RUNTIME_DIR=%s\n" "$(shell_quote "$runtime_dir")"
  printf "export XDG_CONFIG_HOME=%s\n" "$(shell_quote "$config_dir")"
  printf "export XDG_STATE_HOME=%s\n" "$(shell_quote "$state_dir")"
  printf "export XDG_CACHE_HOME=%s\n" "$(shell_quote "$cache_dir")"
  cat <<ENV
export FIELDWORK_DISABLE_UPDATE_CHECK=1
export FIELDWORK_SCROLLBACK_ENCRYPTION_ENABLED=false
ENV
  printf "export PATH=%s:\$PATH\n" "$(shell_quote "$bin_dir")"
}

print_next_steps() {
  local prefix
  prefix="$(env_command_prefix)"
  cat <<NEXT
Attach logs: tmux attach -t $(shell_quote "$session")
Use CLI:     eval "\$($prefix scripts/debug-instance.sh env)" && fw ls
Stop:        $prefix scripts/debug-instance.sh stop
State root:  $state_root
NEXT
}

print_existing_session_note() {
  local existing_root="$1"
  if [[ -z "$existing_root" ]]; then
    cat <<NOTE
The tmux session does not have a FIELDWORK_DEBUG_ROOT marker, so it was likely
created manually or by an older helper. Attach with:
  tmux attach -t "$session"

To create a fresh scripted instance, stop this session or set a different
FIELDWORK_DEBUG_TMUX_SESSION.
NOTE
  elif [[ "$existing_root" != "$state_root" ]]; then
    cat <<NOTE
The tmux session was created with FIELDWORK_DEBUG_ROOT=$existing_root.
Run with the same FIELDWORK_DEBUG_ROOT to inspect that instance, or choose a
different FIELDWORK_DEBUG_TMUX_SESSION for a second isolated daemon.
NOTE
  else
    print_next_steps
  fi
}

case "$command" in
  start)
    require_command tmux
    if tmux has-session -t "$session" 2>/dev/null; then
      existing_root="$(session_marker_root || true)"
      if [[ -n "$existing_root" && -z "${FIELDWORK_DEBUG_ROOT+x}" ]]; then
        state_root="$existing_root"
        configure_paths
      fi
      echo "fieldwork debug tmux session already exists: $session"
      print_existing_session_note "$existing_root"
      exit 0
    fi
    prepare_dirs
    require_command cargo
    cargo build -p fieldwork-cli -p fieldwork-daemon
    write_runner
    tmux new-session -d -s "$session" "$runner"
    tmux set-environment -t "$session" FIELDWORK_DEBUG_ROOT "$state_root"
    wait_for_socket
    echo "fieldwork debug instance started: $session"
    print_next_steps
    ;;
  status)
    skip_socket_check=0
    if tmux has-session -t "$session" 2>/dev/null; then
      echo "tmux: running ($session)"
      existing_root="$(session_marker_root || true)"
      if [[ -n "$existing_root" ]]; then
        state_root="$existing_root"
        configure_paths
        echo "tmux state root: $existing_root"
      else
        echo "tmux state root: unknown (no FIELDWORK_DEBUG_ROOT marker)"
        skip_socket_check=1
      fi
    else
      echo "tmux: not running ($session)"
    fi
    prepare_dirs
    ensure_links
    if [[ "$skip_socket_check" == "1" ]]; then
      echo "socket: not checked because this tmux session was not created by scripts/debug-instance.sh"
    else
      echo "socket path: $runtime_dir/fieldwork/control.sock"
      run_debug "$bin_dir/fw" daemon status || true
    fi
    ;;
  env)
    adopt_existing_session_root
    prepare_dirs
    ensure_links
    print_env
    ;;
  shell)
    require_command tmux
    exec tmux attach -t "$session"
    ;;
  stop)
    require_command tmux
    if tmux has-session -t "$session" 2>/dev/null; then
      tmux kill-session -t "$session"
      echo "stopped fieldwork debug tmux session: $session"
    else
      echo "fieldwork debug tmux session is not running: $session"
    fi
    ;;
  -h|--help|help)
    usage
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac
