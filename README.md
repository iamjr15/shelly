# Shelly

[![CI](https://github.com/shelly-app/shelly/actions/workflows/ci.yml/badge.svg)](https://github.com/shelly-app/shelly/actions/workflows/ci.yml)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](LICENSE)

Your terminal sessions, from anywhere.

Start a real PTY session on your laptop — a shell, `vim`, `htop`, Claude Code,
Codex, any terminal program — then attach to the same live session from your
Android phone. Send input, resize, detach, and come back to your laptop without
losing process state. When an AI agent in a session is waiting on you, your
phone gets a push notification that never contains terminal content.

![Shelly CLI install and session list](docs/assets/shelly-cli-flow.svg)

![Shelly QR pairing with explicit desktop approval](docs/assets/shelly-pairing.svg)

![Shelly mobile sessions and terminal attach](docs/assets/shelly-mobile-session.svg)

Demo video: [`docs/assets/shelly-demo-v1.mp4`](docs/assets/shelly-demo-v1.mp4)

## Install

```sh
npm i -g shellykit
shelly daemon install
shelly pair
```

The `shellykit` npm package installs the `shelly` CLI and `shellyd` daemon
together, with native binaries for macOS (Apple Silicon and Intel) and Linux
(x64 and arm64). Desktop distribution is npm-only by design — no Homebrew,
`curl | sh`, or `cargo install`.

Until the first npm release is published you can build from source:

```sh
cargo build --release --workspace
target/release/shelly daemon install
```

The Android app lives in [`apps/android`](apps/android) and builds with the
bundled Gradle wrapper while Play Store submission is pending.

## Quick start

1. **Pair your phone.** Run `shelly pair` on your laptop. Scan the QR code with the
   Shelly Android app (or type the 5-character code), then approve the
   device on your laptop. Pairing codes are single-use, expire after 5
   minutes, and always require explicit desktop approval.
2. **Start a session.** Run `shelly` with no arguments to create and attach an
   auto-named shell session, or `shelly new claude`, `shelly new bash`, `shelly new vim` to
   run a specific command. `shelly refactoringjob` is the named-session fast path:
   attach if that session exists, otherwise create it.
3. **Attach from your phone.** The session appears on the phone dashboard with
   its live state (`Idle`, `Working`, `Awaiting input`). Tap to attach, type,
   resize, detach.
4. **Come back.** Detach on the desktop with `Ctrl-B` then `D`. Reattach any
   time with `shelly attach <session>` — the process never stopped.

A Shelly session is agent-agnostic: inside one session you can start Claude
Code, exit it, start Codex, drop back to a shell, or run any other TUI without
re-pairing or recreating anything.

## Everyday commands

```sh
shelly                      # create + attach an auto-named shell session
shelly new [--name x] CMD   # create a session running CMD
shelly ls                   # list sessions
shelly attach <id-or-name>  # attach (Ctrl-B then D to detach)
shelly kill <id-or-name>    # kill one session
shelly kill-all             # kill everything
shelly pair                 # pair a phone (QR + 5-char code)
shelly devices remove <dev> # revoke a paired phone
shelly doctor [--no-start]  # preflight: daemon, socket hardening, handshake
shelly daemon start|status|logs|install|restart|uninstall
shelly settings telemetry on|off|status
shelly settings scrollback-encryption on|off|status
shelly completion bash|zsh|fish|powershell|elvish
```

The CLI checks the npm registry at most once a day and prints a non-fatal
update notice to stderr; set `SHELLY_DISABLE_UPDATE_CHECK=1` to silence it.

## How it works

`shellyd` owns the PTY sessions and persists session summaries and
scrollback locally in encrypted `redb` storage keyed from your OS keychain.
The desktop CLI talks to it over a hardened Unix socket (`0700` parent, `0600`
socket, symlink rejection). Phones connect peer-to-peer over
[iroh](https://github.com/n0-computer/iroh) QUIC, authenticated by device keys
that are exchanged at pairing time — there is no account and no password. An
optional relay provides the typed-code pairing rendezvous and forwards hashed
push events; terminal bytes never traverse it in readable form, and push
payloads carry only opaque hashes and fixed event enums.

Live sessions keep a daemon-side WezTerm terminal model: warm reconnects
replay raw bytes from a 256 KB ring, and stale attaches get a synthetic ANSI
snapshot so full-screen TUIs render a correct viewport immediately.

Claude Code and Codex are first-class for state inference (`Idle`, `Working`,
`Awaiting input`); hooks (`shelly hook claude-stop`, `shelly hook codex-event`) make
the inference exact. Output from unknown commands only ever drives byte-rate
`Idle`/`Working` inference — content is never parsed into notifications.

Details: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) ·
[`docs/PROTOCOL.md`](docs/PROTOCOL.md)

## Security and privacy

- Mobile clients can list, attach, stream, send input, resize, detach, and
  manage push tokens — they **cannot** create sessions, kill sessions, or
  choose commands. That boundary is enforced in the daemon, not the app.
- Pairing: single active 5-character code, 5-minute TTL, invalidated after 5
  wrong attempts, single-use, explicit desktop approval, no password fallback.
  Lost devices are revoked with `shelly devices remove`.
- At rest: session scrollback and paired-device records are encrypted with
  XChaCha20-Poly1305 using an OS-keychain-held key. On Android, the pairing
  record is encrypted with a non-exportable Android Keystore key and excluded
  from backups and device transfers.
- Telemetry is opt-in and off by default; no crash-reporting SDK ships in v1.

The product security model is documented in
[`docs/SECURITY.md`](docs/SECURITY.md) and the privacy posture in
[`docs/PRIVACY.md`](docs/PRIVACY.md). Report vulnerabilities via
[`SECURITY.md`](SECURITY.md).

## Compatibility

The wire protocol uses strict version equality (currently contract version 3):
the daemon, CLI, and mobile app must be upgraded together. A version mismatch
fails closed with a `ProtocolMismatch` error rather than degrading silently.
Because the CLI and daemon install from one npm package, this matters mainly
when updating the Android app and desktop at different times.

## Project status

Shelly is approaching its v1.0 release. The Android client is active; the
iOS client is parked source, deferred until after v1 ([`FUTURE.md`](FUTURE.md)
tracks what comes later). Publishing to npm and the Play Store, production
relay infrastructure, and physical-device release testing are tracked in
[`PLAN.md`](PLAN.md) and [`docs/OPERATIONS.md`](docs/OPERATIONS.md).

## Development

```sh
cargo fmt --check
cargo clippy --workspace -- -D warnings
cargo nextest run --workspace
scripts/smoke-local-handoff.sh      # end-to-end pairing/attach smoke
pnpm test:android-unit              # Android unit tests
```

See [`CONTRIBUTING.md`](CONTRIBUTING.md) and
[`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) for the full setup, and
[`PLAN.md`](PLAN.md) for the v1 scope contract.

## License

[AGPL-3.0-or-later](LICENSE). [`NOTICE`](NOTICE) includes an additional
permission for app-store distribution; bundled third-party notices are listed
in [`docs/open-source-notices.json`](docs/open-source-notices.json) and in the
app's licenses screen.
