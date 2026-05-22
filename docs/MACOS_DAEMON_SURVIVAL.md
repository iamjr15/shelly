# macOS Daemon Survival

This runbook verifies the Section 13 macOS daemon survival gates after a real
signed and notarized Darwin artifact exists. It covers:

- `fieldworkd` is Developer ID signed, hardened-runtime enabled, and
  Gatekeeper-notarized.
- `fieldwork daemon install` installs a user-level launchd service and reaches a
  protocol handshake.
- The daemon survives a 30-second macOS sleep/wake cycle.
- launchd restarts `fieldworkd` after `pkill -KILL fieldworkd`.

Do not use this runbook with an unsigned source-build daemon. The current local
source build is expected to fail the Gatekeeper preflight.

## Evidence Directory

```sh
export FW_MACOS_DIR="/tmp/fieldwork-macos-survival-$(date +%Y%m%d%H%M%S)"
mkdir -p "$FW_MACOS_DIR"
```

## Signed Artifact

Run the existing signing verifier against the exact `fieldworkd` binary or
Darwin archive that will be installed:

```sh
node scripts/verify-macos-signing.mjs /path/to/fieldworkd \
  | tee "$FW_MACOS_DIR/macos-signing.txt"
```

The transcript must contain `macOS signing ok:`.

## Install Service

Install and check the daemon through the release candidate CLI:

```sh
fieldwork daemon install | tee "$FW_MACOS_DIR/service-install.txt"
fieldwork daemon status | tee "$FW_MACOS_DIR/daemon-status-before.txt"
```

Append `socket: reachable` to `service-install.txt` only after the install
command reports a real local protocol handshake.

## Sleep/Wake

Create scrollback before sleeping:

```sh
fieldwork new --name macos_sleep -- bash -lc 'echo MACOS_SLEEP_SCROLLBACK_BEFORE; sleep 600'
```

Put the Mac to sleep for at least 30 seconds, wake it, then type
`echo after_sleep_wake_ok` into the same session:

```sh
sleep_started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
sleep_start_ms="$(node -e 'console.log(Date.now())')"
pmset sleepnow
# Wake manually after at least 30 seconds.
wake_finished_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
sleep_end_ms="$(node -e 'console.log(Date.now())')"
{
  printf 'sleep_started_at=%s\n' "$sleep_started_at"
  printf 'wake_finished_at=%s\n' "$wake_finished_at"
  printf 'sleep_duration_ms=%s\n' "$((sleep_end_ms - sleep_start_ms))"
  printf 'after_sleep_wake_ok\n'
} | tee "$FW_MACOS_DIR/sleep-wake.txt"

script -q "$FW_MACOS_DIR/sleep-replay.txt" fieldwork attach macos_sleep
# Confirm MACOS_SLEEP_SCROLLBACK_BEFORE and after_sleep_wake_ok are visible, then detach.
```

## Kill/Restart

Create another session before killing the daemon:

```sh
fieldwork new --name macos_kill -- bash -lc 'echo MACOS_KILL_SCROLLBACK_BEFORE; sleep 600'
kill_start_ms="$(node -e 'console.log(Date.now())')"
pkill -KILL fieldworkd
until fieldwork daemon status | grep -q 'socket: reachable'; do sleep 0.2; done
kill_end_ms="$(node -e 'console.log(Date.now())')"
{
  printf 'pkill -KILL fieldworkd\n'
  printf 'restart_ms=%s\n' "$((kill_end_ms - kill_start_ms))"
  fieldwork daemon status
  printf 'after_kill_restart_ok\n'
} | tee "$FW_MACOS_DIR/kill-restart.txt"

script -q "$FW_MACOS_DIR/kill-replay.txt" fieldwork attach macos_kill
# Confirm MACOS_KILL_SCROLLBACK_BEFORE and after_kill_restart_ok are visible, then detach.
```

Capture final daemon status and logs:

```sh
fieldwork daemon status | tee "$FW_MACOS_DIR/daemon-status-after.txt"
cp ~/Library/Logs/Fieldwork/daemon.log "$FW_MACOS_DIR/daemon-log.txt"
```

Verify the evidence:

```sh
pnpm check:macos-daemon-survival-evidence -- "$FW_MACOS_DIR"
```

Only check the `PLAN.md` daemon survival gates after this verifier passes
against the signed/notarized artifact and the operator has confirmed the
terminal sessions remained usable after sleep/wake and launchd restart.
