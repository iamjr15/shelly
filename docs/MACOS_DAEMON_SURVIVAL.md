# macOS Daemon Survival

This runbook verifies the Section 13 macOS daemon survival gates after a real
npm-installed/ad-hoc-signed Darwin artifact exists. It covers:

- `fieldworkd` is executable, code-signed through the npm trust path, and has no
  `com.apple.quarantine` xattr.
- `fieldwork daemon install` installs a user-level launchd service and reaches a
  protocol handshake.
- The daemon survives a 30-second macOS sleep/wake cycle.
- launchd restarts `fieldworkd` after `pkill -KILL fieldworkd`.
- Crash recovery restores persisted session metadata and scrollback. Live PTY
  child processes are not expected to survive daemon death, so the evidence must
  document `processes_died_documented`.

Do not use this runbook with an unverified source-build daemon. The production
path is the npm-installed Darwin artifact prepared with `codesign --force --sign -`
and targeted quarantine cleanup.

## Latest Local Launchd Smoke

On 2026-05-30, `FIELDWORK_SMOKE_KEEP_TMP=1 pnpm test:macos-daemon-launchd`
passed on macOS arm64 with retained evidence at `/tmp/fwld.i7Ckgt/evidence`.
The run packed and installed the staged Darwin platform package plus unscoped
`fieldwork` meta package into a temp npm project, verified the installed
`fieldwork`/`fw`/`fieldworkd` command surfaces, passed the macOS npm trust
verifier, installed a temporary user LaunchAgent, and confirmed `fw doctor
--no-start` reported `npm/ad-hoc/not-notarized`, the temp
`XDG_RUNTIME_DIR/fieldwork/control.sock`, socket parent mode `0700`, socket file
mode `0600`, and `summary: ok`.

The same run killed `fieldworkd` with `pkill -KILL fieldworkd`; launchd restored
socket reachability in `restart_ms=369`, `fieldwork ls` still listed the
daemon-owned `macos_kill` session, `kill-live-replay.txt` showed
`MACOS_KILL_SCROLLBACK_BEFORE` before the daemon kill, restored
`fieldwork attach macos_kill` replayed `MACOS_KILL_SCROLLBACK_BEFORE` and
returned `[fieldwork: session exited 0]`, and the captured daemon log contained
no crash markers. The launchd-session-only deterministic iroh key was not
persisted in the LaunchAgent plist.

This is local launchd restart smoke evidence only. The formal verifier still
fails against `/tmp/fwld.i7Ckgt/evidence` because `sleep-wake.txt` and
`sleep-replay.txt` are absent. Do not check the Section 13 macOS sleep/wake or
full daemon-survival gates from this run; the retained sleep/wake and restored
scrollback transcripts below are still required.

## Evidence Directory

```sh
export FW_MACOS_DIR="/tmp/fieldwork-macos-survival-$(date +%Y%m%d%H%M%S)"
export FW_MACOS_PROJECT_DIR="${FW_MACOS_PROJECT_DIR:-/tmp/fieldwork-macos-survival-project}"
mkdir -p "$FW_MACOS_PROJECT_DIR"
pnpm scaffold:macos-daemon-survival-evidence -- --dir "$FW_MACOS_DIR"
```

The scaffold writes `README.md`, `manifest.json`, `missing-files.txt`,
`capture-checklist.md`, and a non-destructive `preflight.sh`. It does not create
passing evidence, run `pmset sleepnow`, or kill `fieldworkd`.

Use a project directory outside macOS Desktop/Documents/Downloads privacy
protected locations for this launchd survival pass unless `fieldworkd` has been
granted the matching Full Disk Access permission. LaunchAgents do not inherit
Terminal's per-app TCC grants, so a protected cwd can block the child shell
before it emits terminal output.

## npm Trust Artifact

Run the existing npm trust verifier against the exact Darwin archive, directory,
or `fieldworkd` binary that will be installed:

```sh
node scripts/verify-macos-signing.mjs /path/to/fieldworkd \
  | tee "$FW_MACOS_DIR/macos-signing.txt"
```

The transcript must contain `macOS npm trust ok:`.

After installing the npm-trust-prepared daemon service, the generated preflight can
capture the signing proof plus initial service status without sleeping the Mac or
killing the daemon:

```sh
FIELDWORK_CLI=/path/to/fieldwork \
FIELDWORK_DAEMON=/path/to/fieldworkd \
"$FW_MACOS_DIR/preflight.sh"
```

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
fieldwork new --dir "$FW_MACOS_PROJECT_DIR" --name macos_sleep -- bash -lc 'echo MACOS_SLEEP_SCROLLBACK_BEFORE; sleep 600'
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
fieldwork new --dir "$FW_MACOS_PROJECT_DIR" --name macos_kill -- bash -lc 'echo MACOS_KILL_SCROLLBACK_BEFORE; sleep 600'
script -q "$FW_MACOS_DIR/kill-live-replay.txt" fieldwork attach macos_kill
# Confirm MACOS_KILL_SCROLLBACK_BEFORE is visible, then detach.
# Wait at least 35 seconds so the daemon's 30-second persistence checkpoint has
# stored the pre-kill scrollback.
kill_start_ms="$(node -e 'console.log(Date.now())')"
pkill -KILL fieldworkd
until fieldwork daemon status | grep -q 'socket: reachable'; do sleep 0.2; done
kill_end_ms="$(node -e 'console.log(Date.now())')"
{
  printf 'pkill -KILL fieldworkd\n'
  printf 'restart_ms=%s\n' "$((kill_end_ms - kill_start_ms))"
  fieldwork daemon status
  printf 'processes_died_documented=true\n'
} | tee "$FW_MACOS_DIR/kill-restart.txt"

script -q "$FW_MACOS_DIR/kill-replay.txt" fieldwork attach macos_kill
# Confirm MACOS_KILL_SCROLLBACK_BEFORE and [fieldwork: session exited ...] are visible, then detach.
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
against the npm-installed/ad-hoc-signed artifact and the operator has confirmed
the terminal session remained usable after sleep/wake and that launchd restart
restored persisted session metadata plus scrollback while documenting PTY child
process death.
