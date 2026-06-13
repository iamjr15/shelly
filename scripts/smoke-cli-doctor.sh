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
    echo "kept doctor smoke temp dir: $tmp" >&2
  else
    rm -rf "$tmp"
  fi
}
trap cleanup EXIT

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

cargo_target_dir="${CARGO_TARGET_DIR:-$repo_root/target}"
cargo build -q -p shelly-cli -p shelly-daemon

shelly="$cargo_target_dir/debug/shelly"
shellyd="$cargo_target_dir/debug/shellyd"

if [[ "$(uname -s)" == "Darwin" ]]; then
  codesign --force --sign - "$shelly" >/dev/null
  codesign --force --sign - "$shellyd" >/dev/null
  xattr -d com.apple.quarantine "$shelly" "$shellyd" 2>/dev/null || true
fi

ln -sf "$shellyd" "$tmp/bin/shellyd"

if "$shelly" doctor --no-start >"$tmp/doctor-before.log" 2>&1; then
  echo "doctor --no-start unexpectedly passed before shellyd was running" >&2
  cat "$tmp/doctor-before.log" >&2
  exit 1
fi
grep -Fq "daemon connection: fail" "$tmp/doctor-before.log"

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

"$shelly" new --name doctor_shell bash -lc 'printf "doctor_ready\n"; sleep 1' >"$tmp/new.log"
grep -Fq "created " "$tmp/new.log"

"$shelly" doctor --no-start >"$tmp/doctor.log"
grep -Fq "Shelly doctor" "$tmp/doctor.log"
grep -Fq "cli: ok" "$tmp/doctor.log"
grep -Fq "daemon binary: ok" "$tmp/doctor.log"
if [[ "$(uname -s)" == "Darwin" ]]; then
  grep -Fq "macOS trust: ok (npm/ad-hoc/not-notarized" "$tmp/doctor.log"
else
  grep -Fq "macOS trust: n/a (macOS-only)" "$tmp/doctor.log"
fi
grep -Fq "socket path: $XDG_RUNTIME_DIR/shelly/control.sock" "$tmp/doctor.log"
grep -Fq "daemon connection: ok (reachable ($XDG_RUNTIME_DIR/shelly/control.sock))" "$tmp/doctor.log"
grep -Fq "socket parent: ok (owned by current user, mode 0700, not symlink ($XDG_RUNTIME_DIR/shelly))" "$tmp/doctor.log"
grep -Fq "socket file: ok (socket, mode 0600, not symlink ($XDG_RUNTIME_DIR/shelly/control.sock))" "$tmp/doctor.log"
grep -Fq "protocol: ok (contract v3)" "$tmp/doctor.log"
grep -Fq "push notifications: off" "$tmp/doctor.log"
grep -Fq "session list: ok (1 session(s))" "$tmp/doctor.log"
grep -Fq "telemetry: off" "$tmp/doctor.log"
grep -Fq "scrollback encryption: off (env override; config: on)" "$tmp/doctor.log"
grep -Fq "summary: ok" "$tmp/doctor.log"

"$shelly" doctor --help >"$tmp/doctor-help.log"
grep -Fq "Usage: shelly doctor" "$tmp/doctor-help.log"
grep -Fq -- "--no-start" "$tmp/doctor-help.log"

printf 'PASS shelly doctor smoke checked no-start failure, daemon handshake, socket hardening, and session list\n'
