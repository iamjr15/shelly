#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "macOS launchd smoke is Darwin-only" >&2
  exit 1
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp="$(mktemp -d /tmp/fwld.XXXXXX)"
service_installed=0
launchd_env_set=0

cleanup() {
  local status=$?
  set +e
  if [[ "$service_installed" == "1" && -n "${shelly:-}" && -x "${shelly:-}" ]]; then
    "$shelly" daemon uninstall >"$tmp/daemon-uninstall.log" 2>&1
  fi
  if [[ -n "${shellyd:-}" ]]; then
    pkill -KILL -x shellyd >/dev/null 2>&1
  fi
  if launchctl print "gui/$(id -u)/app.shelly.daemon" >/dev/null 2>&1; then
    launchctl bootout "gui/$(id -u)/app.shelly.daemon" >/dev/null 2>&1
  fi
  if [[ "$launchd_env_set" == "1" ]]; then
    launchctl unsetenv SHELLY_IROH_SECRET_KEY_B64 >/dev/null 2>&1
  fi
  if [[ "${SHELLY_SMOKE_KEEP_TMP:-}" == "1" || "$status" != "0" ]]; then
    echo "kept macOS launchd smoke temp dir: $tmp" >&2
  else
    rm -rf "$tmp"
  fi
  exit "$status"
}
trap cleanup EXIT

if launchctl print "gui/$(id -u)/app.shelly.daemon" >/dev/null 2>&1; then
  echo "app.shelly.daemon is already loaded; refusing to disturb an existing user service" >&2
  exit 1
fi

if pgrep -x shellyd >/dev/null 2>&1; then
  echo "shellyd is already running; stop it before running the launchd smoke" >&2
  pgrep -fl shellyd >&2 || true
  exit 1
fi

mkdir -p "$tmp/home" "$tmp/runtime" "$tmp/config" "$tmp/state" "$tmp/cache" "$tmp/logs" "$tmp/packs" "$tmp/project" "$tmp/bin" "$tmp/artifacts"
chmod 700 "$tmp/home" "$tmp/runtime" "$tmp/config" "$tmp/state" "$tmp/cache" "$tmp/logs"
printf '{ "private": true }\n' >"$tmp/project/package.json"

export HOME="$tmp/home"
export XDG_RUNTIME_DIR="$tmp/runtime"
export XDG_CONFIG_HOME="$tmp/config"
export XDG_STATE_HOME="$tmp/state"
export XDG_CACHE_HOME="$tmp/cache"
export SHELLY_LOG_DIR="$tmp/logs"
export SHELLY_SCROLLBACK_ENCRYPTION_ENABLED=false
export SHELLY_DISABLE_UPDATE_CHECK=1
export NO_UPDATE_NOTIFIER=1
export npm_config_update_notifier=false

host_arch="$(uname -m)"
case "$host_arch" in
  arm64) host_key="darwin-arm64" ;;
  x86_64) host_key="darwin-x64" ;;
  *)
    echo "unsupported Darwin arch for v1 npm packages: $host_arch" >&2
    exit 1
    ;;
esac

platform_dir="$repo_root/packages/cli-$host_key"
meta_dir="$repo_root/packages/cli"

if [[ ! -x "$platform_dir/bin/shelly" || ! -x "$platform_dir/bin/shellyd" ]]; then
  echo "staged npm binaries are missing for $host_key; run pnpm build:local-npm-artifacts first" >&2
  exit 1
fi

unset npm_config_supported_architectures npm_config_npm_globalconfig npm_config_verify_deps_before_run npm_config__jsr_registry

pack_package() {
  local package_dir="$1"
  local output filename
  output="$(npm pack "$package_dir" --pack-destination "$tmp/packs" --json)"
  filename="$(
    printf '%s' "$output" | node -e '
      const fs = require("node:fs");
      const packs = JSON.parse(fs.readFileSync(0, "utf8"));
      process.stdout.write(packs[0].filename);
    '
  )"
  printf '%s/%s\n' "$tmp/packs" "$filename"
}

platform_pack="$(pack_package "$platform_dir")"
meta_pack="$(pack_package "$meta_dir")"
npm install --prefix "$tmp/project" --package-lock=false --no-audit --no-fund "$platform_pack" "$meta_pack" >"$tmp/artifacts/npm-install.txt" 2>&1

shelly="$tmp/project/node_modules/shellykit/bin/shelly"
shellyd="$tmp/project/node_modules/shellykit/bin/shellyd"

for binary in "$shelly" "$shellyd"; do
  if [[ ! -x "$binary" ]]; then
    echo "expected installed executable is missing: $binary" >&2
    exit 1
  fi
done

{
  codesign --verify --verbose=2 "$shelly"
  codesign --verify --verbose=2 "$shellyd"
  if xattr -p com.apple.quarantine "$shelly" >/dev/null 2>&1; then
    echo "shelly still has com.apple.quarantine metadata" >&2
    exit 1
  fi
  if xattr -p com.apple.quarantine "$shellyd" >/dev/null 2>&1; then
    echo "shellyd still has com.apple.quarantine metadata" >&2
    exit 1
  fi
  echo "macOS npm trust smoke ok"
} >"$tmp/artifacts/macos-signing.txt" 2>&1

# The production service uses the OS keychain. This deterministic key is a
# launchd-session-only smoke substitute so the test can run without an
# interactive Keychain prompt, and it is intentionally not written to the plist.
launchctl setenv SHELLY_IROH_SECRET_KEY_B64 "BQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQU"
launchd_env_set=1

{
  echo "$shelly daemon install"
  echo "LaunchAgent: $HOME/Library/LaunchAgents/app.shelly.daemon.plist"
  "$shelly" daemon install
  echo "socket: reachable"
} >"$tmp/artifacts/service-install.txt" 2>&1
service_installed=1

plist="$HOME/Library/LaunchAgents/app.shelly.daemon.plist"
if [[ ! -f "$plist" ]]; then
  echo "LaunchAgent plist was not created at $plist" >&2
  exit 1
fi
if ! grep -Fq "<key>XDG_RUNTIME_DIR</key>" "$plist"; then
  echo "LaunchAgent plist did not preserve XDG_RUNTIME_DIR" >&2
  exit 1
fi
if grep -Fq "SHELLY_IROH_SECRET_KEY_B64" "$plist"; then
  echo "LaunchAgent plist persisted the deterministic iroh secret override" >&2
  exit 1
fi

"$shelly" daemon status >"$tmp/artifacts/daemon-status-before.txt"
grep -Eiq "service: (running|installed)" "$tmp/artifacts/daemon-status-before.txt"
grep -Fq "socket: reachable" "$tmp/artifacts/daemon-status-before.txt"

"$shelly" doctor --no-start >"$tmp/artifacts/doctor-no-start.txt"
grep -Fq "macOS trust: ok (npm/ad-hoc/not-notarized" "$tmp/artifacts/doctor-no-start.txt"
grep -Fq "socket path: $XDG_RUNTIME_DIR/shelly/control.sock" "$tmp/artifacts/doctor-no-start.txt"
grep -Fq "summary: ok" "$tmp/artifacts/doctor-no-start.txt"

# Use the temp project outside macOS Desktop/Documents TCC-protected locations so
# this smoke verifies launchd PTY survival rather than operator privacy grants.
"$shelly" new --dir "$tmp/project" --name macos_kill -- /bin/sh -c "printf 'MACOS_KILL_SCROLLBACK_BEFORE\n'; sleep 600" >"$tmp/artifacts/new-kill-session.txt"
for attempt in $(seq 1 10); do
  (sleep 2; printf '\002d') | perl -e 'alarm 10; exec @ARGV' script -q "$tmp/artifacts/kill-live-replay.txt" "$shelly" attach macos_kill >/dev/null 2>&1 || true
  if grep -Fq "MACOS_KILL_SCROLLBACK_BEFORE" "$tmp/artifacts/kill-live-replay.txt"; then
    break
  fi
  sleep 0.5
done
grep -Fq "MACOS_KILL_SCROLLBACK_BEFORE" "$tmp/artifacts/kill-live-replay.txt"
# Session scrollback persists on the daemon's 30-second checkpoint loop. Wait
# for one checkpoint so the launchd restart check proves restored scrollback,
# not just restored session metadata.
sleep "${SHELLY_MACOS_LAUNCHD_PERSIST_WAIT_SECONDS:-35}"

kill_start_ms="$(node -e 'console.log(Date.now())')"
pkill -KILL -x shellyd

for _ in $(seq 1 80); do
  if "$shelly" daemon status >"$tmp/artifacts/daemon-status-after-kill.tmp" 2>&1 \
    && grep -Fq "socket: reachable" "$tmp/artifacts/daemon-status-after-kill.tmp"; then
    break
  fi
  sleep 0.25
done

if ! grep -Fq "socket: reachable" "$tmp/artifacts/daemon-status-after-kill.tmp"; then
  echo "launchd did not restore the daemon socket after pkill" >&2
  cat "$tmp/artifacts/daemon-status-after-kill.tmp" >&2 || true
  exit 1
fi

kill_end_ms="$(node -e 'console.log(Date.now())')"
{
  echo "pkill -KILL shellyd"
  echo "restart_ms=$((kill_end_ms - kill_start_ms))"
  cat "$tmp/artifacts/daemon-status-after-kill.tmp"
  echo "processes_died_documented=true"
} >"$tmp/artifacts/kill-restart.txt"

"$shelly" ls >"$tmp/artifacts/ls-after-kill.txt"
grep -Fq "macos_kill" "$tmp/artifacts/ls-after-kill.txt"

(printf '\002d'; sleep 1) | perl -e 'alarm 8; exec @ARGV' script -q "$tmp/artifacts/kill-replay.txt" "$shelly" attach macos_kill >/dev/null 2>&1 || true
grep -Fq "MACOS_KILL_SCROLLBACK_BEFORE" "$tmp/artifacts/kill-replay.txt"
grep -aiq "shelly: session exited" "$tmp/artifacts/kill-replay.txt"

"$shelly" daemon status >"$tmp/artifacts/daemon-status-after.txt"
grep -Eiq "service: (running|installed)" "$tmp/artifacts/daemon-status-after.txt"
grep -Fq "socket: reachable" "$tmp/artifacts/daemon-status-after.txt"

latest_log="$(find "$SHELLY_LOG_DIR" -type f -name 'daemon.log*' -print | sort | tail -n 1)"
if [[ -z "$latest_log" ]]; then
  echo "daemon log was not created under $SHELLY_LOG_DIR" >&2
  exit 1
fi
cp "$latest_log" "$tmp/artifacts/daemon-log.txt"
if grep -Eiq '\b(panic|panicked|FATAL|segmentation fault|crash|uncaught exception)\b' "$tmp/artifacts/daemon-log.txt"; then
  echo "daemon log contains a crash marker" >&2
  cat "$tmp/artifacts/daemon-log.txt" >&2
  exit 1
fi

if [[ "${SHELLY_SMOKE_KEEP_TMP:-}" == "1" ]]; then
  echo "macOS launchd daemon smoke ok: $tmp/artifacts"
else
  echo "macOS launchd daemon smoke ok (set SHELLY_SMOKE_KEEP_TMP=1 to retain artifacts)"
fi
