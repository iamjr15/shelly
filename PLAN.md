# Fieldwork — v1 Build Plan

**Date**: 2026-05-17
**Status**: Local v1 implementation verified; production release gates blocked by external credentials/devices/infrastructure
**Target**: Production-ready v1.0
**Timeline**: 10 weeks build + 2 weeks store launch buffer (12 weeks calendar, solo full-time)
**Total infra cost**: $0/mo
**Total upfront cost**: $99 Apple Developer Program (mandatory for iOS)

---

## 0. Naming and identity

- **Product name**: `fieldwork`
- **CLI binary**: `fieldwork`
- **Daemon binary**: `fieldworkd`
- **npm meta-package**: `fieldwork` (with per-platform: `fieldwork-darwin-arm64`, etc.)
- **Cargo crates**: workspace `fieldwork`, members `protocol`, `daemon`, `cli`, `relay`, `mobile-core`
- **iOS bundle id**: `app.fieldwork.ios`
- **Android package**: `app.fieldwork.android`
- **GitHub org**: `fieldwork-app`
- **Domain**: `fieldwork.dev`
- **Tagline**: *"Your terminal sessions, from anywhere."* (Tagline emphasis: universal terminal handoff. AI-agent-aware push is the differentiator on top, not the whole pitch.)

---

## 1. Executive summary

Fieldwork is a free, open-source product that gives a developer running **any CLI** on their laptop — a shell, a TUI, a REPL, an AI coding agent like Claude Code, anything — the ability to **continue the exact same session on their phone**, with a single QR-pair install and zero ongoing configuration. AI-coding-agent users get one extra feature: push notifications when an agent is waiting for input.

It replaces the current power-user stack of **Termius + mosh + Tailscale + tmux + ssh-keys + multiple-apps** with one daemon + one CLI + one mobile app. The shared state lives in the daemon, and every connected client (Mac terminal, iOS app, Android app) is a view into the same live PTY.

**v1 ships**:
- **Universal mobile terminal handoff** — laptop ↔ phone session handoff for **any CLI**: shells (bash, zsh, fish), TUIs (vim, htop, lazygit, tig, k9s), REPLs (python, node, irb), AI coding agents (Claude Code, Codex, OpenCode, anything that runs in a terminal). The daemon spawns a PTY with whatever command you give it (`fieldwork new bash`, `fieldwork new claude`, `fieldwork new "python repl"`) and streams raw bytes to the phone. Termius + mosh + Tailscale + tmux replacement is complete — every workflow those tools support, this supports.
- **Multi-session dashboard** with auto-naming, status states (idle/working/awaiting), and per-session previews.
- **Native iOS and Android apps**.
- **AI-coding-agent-aware push notifications for Claude Code AND Codex** — the differentiating feature on top of the universal handoff. v1 ships two state-inference modules: Claude Code (prompt-pattern detection + Stop-hook integration) and Codex (structured JSON events accepted through the local `fieldwork hook codex-event` adapter, matching the current Codex remote-control/app-server surface without mutating the user's PTY command). When either agent flips to "awaiting your approval," your phone buzzes. Other CLIs run perfectly fine but don't get this push (they're interactive shells, not autonomous agents — the question doesn't apply).

**Desktop host**: macOS + Linux (Windows users use the Linux build via WSL2 for v1).

**v1 does not ship** voice input, Live Activities, Apple Watch app, hosted sandbox option, state inference for OpenCode/Aider (they still *run* fine, they just don't get v1 push), Lunel-style IDE surfaces, team features, billing, or native Windows host. **All deferred items, their target versions, the watch list, and the "out of scope forever" decisions live in [`FUTURE.md`](./FUTURE.md).** This document covers only what's being built for v1.

**Architecture pillar**: iroh P2P (with self-hosted relay on Oracle ARM A1 Always Free) for zero-config NAT traversal, zero infrastructure cost, and zero ongoing operational burden.

---

## 2. Vision & positioning

### 2.1 The problem

You (and developers like you) run terminal-based tools on a laptop — Claude Code, vim, lazygit, kubectl, a long-running test suite, whatever the workflow needs. When you leave the house, you want to keep working: answer the Claude Code prompt, scroll back through what the agent did, kick off the next task, fix the failing test from your phone. The current solution is a stack of seven tools (Termius, mosh, Tailscale, tmux, ssh-agent, ssh-keys, a vibe-server on Hetzner) that takes a weekend to set up and breaks in subtle ways. Lunel and Litter aim at this gap but each falls short — Lunel doesn't unify laptop and phone into one session, Litter is a separate chat client per server and only handles AI agents (not your shell or TUI).

### 2.2 The product

Fieldwork is two binaries and one app:

1. **`fieldwork` CLI** — install once on your laptop, run `fieldwork pair`, scan the QR with your phone. Done. Forever.
2. **`fieldworkd` daemon** — the long-running process that owns your PTY sessions. Spawned by the CLI; survives terminal close, lid close, sleep, and app disconnects. (Does not survive logout/reboot — see Section 7.1 for the lifetime contract.)
3. **Fieldwork mobile app** — native iOS and Android. Shows a list of your active sessions, lets you tap any to drop into a live terminal view, pushes a notification when an agent is waiting.

When you walk back to your laptop, your terminal window is in the same session. Phone and laptop are both views into the daemon's PTY — typing in one shows up in the other instantly.

### 2.3 The wedge (vs Lunel, Litter, Claude Remote Control)

| Competitor | What they do | What we do better |
|---|---|---|
| **Anthropic Claude Code "Remote Control"** | Pairs Claude.ai mobile app to local Claude Code | **Ours is universal** — same handoff works for bash, vim, any TUI, any REPL, plus AI agents. Not vendor-locked to a single agent. Push notifications still work for Claude Code; everything else still works without push. |
| **OpenAI Codex Mobile (in ChatGPT app)** | Same, but for Codex | Same advantage |
| **Litter** | Mobile chat client for Codex/Claude/Pi/Droid | Ours is *shared sessions* — laptop and phone are simultaneous views, not alternate frontends |
| **Lunel** | Mobile IDE (file browser, git, devtools, ports) | We don't build a phone IDE. We build the *terminal handoff* that Lunel never quite built. Smaller surface, deeper polish. |
| **Termius + mosh + Tailscale + tmux** | Power-user manual setup | One install. One app. No SSH keys. No port forwards. |

### 2.4 The cultural moment

Long-running agents shipped in Q1/Q2 2026 (Claude Code 2.1 background agents, Codex remote-control/app-server surfaces, Cursor Cloud Agents). Karpathy publicly flipped from "80% manual" to "80% agent." When the agent works for 20 minutes, you need a way to oversee it from your phone — not because you're showing off, but because you put your phone in your pocket and left.

The first-party threats (Anthropic Remote Control, Codex Mobile) ship inside official apps people already have. **Our 12-month window** is to build something so much better-UX that a developer running multiple agents picks Fieldwork over the bundled vendor option. The wedge is multi-session dashboard + push + native polish.

---

## 3. System architecture

### 3.1 High-level diagram

```
                  ┌───────────────────────────────────────────────────────┐
                  │                  User's laptop (host)                 │
                  │                                                       │
   `fieldwork`    │  ┌──────────────┐         ┌─────────────────────┐    │
   CLI session  ──┼─▶│  fieldworkd  │◀────────│ Mac terminal client │    │
   (Unix sock)    │  │   daemon     │  unix   │  (TUI via ratatui)  │    │
                  │  │              │  socket │                     │    │
                  │  │  ┌────────┐  │         └─────────────────────┘    │
                  │  │  │  PTY:  │  │                                    │
                  │  │  │ Claude │  │         ┌─────────────────────┐    │
                  │  │  │  Code  │  │         │  iroh Endpoint      │    │
                  │  │  └────────┘  │◀────────│  QUIC over UDP      │    │
                  │  │              │         └──────────┬──────────┘    │
                  │  │  ┌────────┐  │                    │               │
                  │  │  │  PTY:  │  │                    │               │
                  │  │  │ Codex  │  │                    │               │
                  │  │  └────────┘  │                    │               │
                  │  │   (N PTYs)   │                    │               │
                  │  └──────────────┘                    │               │
                  └────────────────────────────────────┬──┘               │
                                                       │                  │
                              ┌────────────────────────┼──────────────────┘
                              │                        │
                              │ direct P2P (70%)       │ relay fallback (30%)
                              │                        │
                              ▼                        ▼
              ┌──────────────────────┐    ┌──────────────────────────────┐
              │   iPhone / iPad      │    │  Oracle ARM A1 Always Free   │
              │  (SwiftUI app)       │    │   fieldwork-relay binary     │
              │  ┌──────────────┐    │    │   (iroh-relay + axum)        │
              │  │ Sessions list│    │    │   Cost: $0/mo                │
              │  │ Terminal view│    │    │   Capacity: 60k connections  │
              │  │ Push (APNs)  │    │    │                              │
              │  └──────────────┘    │    │                              │
              └──────────────────────┘    └──────────────────────────────┘
                                                       │
              ┌──────────────────────┐                 │
              │  Android phone       │◀────────────────┘
              │  (Compose app)       │
              │  ┌──────────────┐    │
              │  │ Sessions list│    │
              │  │ Terminal view│    │
              │  │ Push (FCM)   │    │
              │  └──────────────┘    │
              └──────────────────────┘
```

### 3.2 Trust model

- **Pairing token**: 32 bytes of randomness, base32-encoded, embedded in QR. 10-minute TTL.
- **Long-lived auth**: after pairing, each device holds an Ed25519 keypair. Public key registered with the daemon; daemon's public key registered with the device. All subsequent iroh connections are mutually authenticated.
- **No password fallback**: lost device → unpair via desktop CLI (`fieldwork devices remove <name>`).
- **Relay's iroh-relay function sees ciphertext only** (encrypted QUIC packets). Its HTTP control plane / push gateway sees push tokens, daemon NodeIDs/public keys, hashed session metadata, and source IPs (scrubbed to /16). QR pair tokens stay daemon-local in v1. **No terminal content traverses the relay in either function.** See Section 7.3.2 for the full trust model split.
- **No daemon telemetry by default**: opt-in only. Span attributes containing user content are hashed. Relay operator telemetry is always on but aggregate-only (no per-NodeID dimensions, IPs scrubbed to /16) and documented in `docs/PRIVACY.md`. See Section 11 for the full split.
- **macOS Keychain / Android Keystore / iOS Keychain** for all private keys.

### 3.3 Data flow (typical session)

1. User runs `fieldwork pair` on their Mac. Daemon (if not running) auto-spawns via launchd.
2. CLI prints a QR encoding `{relay_url, pair_token, daemon_nodeid}`.
3. User opens Fieldwork on phone, scans QR.
4. Phone's iroh endpoint connects to daemon's iroh endpoint (direct or via relay).
5. Mutual auth via the pair token; both sides exchange long-lived Ed25519 pubkeys.
6. Phone disconnects. Pair complete. Pair token expires.
7. Later: user runs `fieldwork new --dir ~/projects/api claude` — daemon spawns a Claude Code PTY.
8. User leaves the house. Phone opens Fieldwork — already paired — iroh reconnects automatically.
9. Phone subscribes to the session list; daemon streams sessions (id, name, status, last-output-line).
10. User taps "claude · api" — phone enters terminal view, daemon streams raw PTY byte chunks over the encrypted iroh transport. SwiftTerm/libvterm renders.
11. User types `yes` — phone sends `Input { bytes: "yes\r" }` to daemon, which writes to PTY.
12. Claude Code emits ~200 lines. Daemon streams raw PTY byte chunks over the encrypted iroh transport. Phone's SwiftTerm/libvterm renders.
13. User puts phone away. iOS suspends the app shortly after backgrounding; iroh connection closes cleanly. Resume is handled by the reconnect-with-replay path (Section 6.3) on next foreground or push wake.
14. Claude Code finishes and prints a new prompt. Daemon's state-inference detects "awaiting input." Daemon POSTs to relay's `/v1/push`. Relay signs APNs JWT (ES256) and forwards. Apple delivers notification with title `"Fieldwork"`, body `"A session is waiting for you."` (fixed enum-derived; no terminal content traverses Apple/Google).
15. User taps notification; iOS app launches; Face ID prompt; app deep-links to the session; phone fetches actual `last_line` over iroh; user reads prompt; types answer.

---

## 4. The unified tech stack

(Full justification in the synthesis section earlier in our conversation — this table is the canonical reference.)

### 4.1 Rust workspace

| Concern | Pick | Version |
|---|---|---|
| P2P transport | `iroh` | `1.0.0-rc.0` (pin exact); migrate to `1.0` stable when released |
| Relay self-host | `iroh-relay` binary on Oracle ARM A1 | matches iroh version |
| PTY | `portable-pty` (WezTerm) | `0.9` |
| VT/ANSI parser | `wezterm-term` API via pinned `tattoy-wezterm-term` fork, aliased as `wezterm-term` in Cargo | `=0.1.0-fork.5` |
| Async runtime | `tokio` | `1` (full features) |
| Local IPC | `interprocess` | `2` (tokio feature) |
| WebSocket (iroh relay internals) | `iroh-relay` transitive stack | No product WebSocket API in v1 |
| HTTP server (relay control plane) | `axum` | `0.8` |
| CLI framework (client) | `clap` (derive) | `4.5` |
| Daemon configuration | `figment` + environment/config file | No daemon CLI flag parser in v1 |
| Config | `figment` | `0.10` |
| Secrets (Keychain etc.) | `keyring` | `3.6.2` (pin floor); migrate to `4.x` when stable (Q3 2026, currently 4.0.0-rc.3) |
| DB (relay control plane) | `rusqlite` + SQLite | `0.37` |
| DB (daemon local state) | `redb` | `2` (locked at 2.6.3) |
| In-process cache (relay) | `moka` | latest |
| HTTP request validation (relay) | `garde` | latest |
| Native TLS root store (daemon + mobile) | `rustls-platform-verifier` | latest |
| Tracing | `tracing` + `tracing-subscriber` + `tracing-opentelemetry` | `0.1`, `0.3`, `0.32` |
| Crash reporting (Rust) | `sentry` | `0.48` (note: current SDK uses reqwest 0.12 and `HubSwitchGuard` is `!Send`) |
| Errors (libs) | `thiserror` | `2` |
| Errors (bins) | `anyhow` | `1` |
| Retry/backoff | `backon` | `1` |
| Service install | `service-manager` | `0.11` |
| CLI distribution build | `cargo-dist` | `0.30+` |
| macOS sign+notarize | `apple-codesign` (rcodesign) | latest |
| Auto-update | **None.** Updates flow through npm exclusively (`npm update -g fieldwork`). Both `fieldwork` CLI and `fieldworkd` daemon ship in the same npm tarball; one update covers both. CLI prints a one-line stderr notice for human-facing commands when a newer version is available on the npm registry. | — |
| Test runner | `cargo-nextest` | latest |
| Snapshot tests | `insta` | `≥ 1.47.2` (1.47.0 had semver-breaking Send/Sync regression, fixed in 1.47.2) |
| Property tests | `proptest` | `1.11` |
| HTTP mocking | In-process `axum`/`tower` test services | Avoids a second mock-server dependency |
| TLS | `rustls` everywhere | `0.23` |
| Mobile FFI | `uniffi` (proc-macros, no UDL) | `0.31.1` |
| iOS build script | Hand-rolled, copying Litter's `apps/ios/scripts/build-rust.sh` | — |
| Android build | `cargo-ndk` + NDK r27 | `4.1` |
| iOS logging bridge | `tracing-oslog` | `0.3` |
| Android logging bridge | `tracing-android` | `0.2` |

### 4.2 Native mobile

| iOS | Android |
|---|---|
| SwiftUI | Jetpack Compose |
| **SwiftTerm v1.13+** (Miguel de Icaza) — now Metal-accelerated (PR #484, Mar 2026) | **`connectbot/termlib`** (Apache-2.0 Compose terminal backed by MIT libvterm) — primary. xterm.js+WebView as fallback if termlib not ready by week 6 |
| URLSession + APNs SDK | OkHttp + Firebase Messaging (FCM) |
| LocalAuthentication (Face/Touch ID) | BiometricPrompt |
| `sentry-cocoa` 9.13+ for crashes | `sentry-android` 8.41.0 for crashes |
| Local development: Xcode 16.3 for current macOS 15.2. Release/TestFlight: Xcode 26+ with iOS 26+ SDK on a macOS 26 runner. Swift 6 strict-warning mode. | Android Studio Iguana+, Kotlin 2.3.20 |

### 4.3 Distribution (npm-only for desktop)

| Channel | Component | Notes |
|---|---|---|
| **npm** (`fieldwork` + 4 platform packages = 5 total) | CLI + daemon (both shipped in same binary tarballs) | **Primary and only distribution channel.** esbuild/biome optionalDependencies pattern + postinstall binary-swap for zero Node startup overhead. |
| **GitHub Releases** | All binaries (audit artifact only) | Not a recommended install path. Kept for transparency, manual download by power users, supply-chain audit. |
| **iOS App Store + TestFlight** | iOS app | TestFlight from week 8; App Store submission week 9. |
| **Google Play + APK on GitHub** | Android app | Play Store internal track from week 8; production week 10. |

Explicitly **not** distributing via: Homebrew, `cargo install`, `curl \| sh`, `winget`, `scoop`, `apt`. All discovery, install, and updates happen through npm. Tradeoff: weaker discovery; mitigated by content marketing, integrations, and GitHub Stars momentum (see Risk #13 in Section 15).

### 4.4 Infrastructure

| Component | Where | Cost |
|---|---|---|
| iroh relay (primary) | Oracle ARM A1, region 1 (e.g., Mumbai) | $0 |
| iroh relay (failover) | Oracle ARM A1, region 2 (e.g., Frankfurt) | $0 |
| GitHub Actions | Linux runners (free for OSS) | $0 |
| Sentry | Free tier (5k errors/mo) | $0 |
| Honeycomb (relay traces) | Free tier (20M events/mo) | $0 |
| Apple Developer Program | Apple | $99/yr |
| Google Play Developer | Google | $25 one-time |
| Domain `fieldwork.dev` | Namecheap or Cloudflare | ~$12/yr |
| **Total ongoing** | — | **$0/mo infra, $99/yr Apple, $12/yr domain** |

---

## 5. Cargo workspace layout

```
fieldwork/
├── Cargo.toml                          # workspace manifest
├── Cargo.lock
├── rust-toolchain.toml                 # pin 1.89+
├── .gitignore
├── LICENSE                              # AGPL-3.0-or-later (single file)
├── README.md
├── CONTRIBUTING.md
├── SECURITY.md
├── CODE_OF_CONDUCT.md
├── .github/
│   ├── workflows/
│   │   ├── ci.yml                      # cargo nextest matrix
│   │   ├── release-rust.yml            # cargo-dist invocation
│   │   ├── release-npm.yml             # publish 5 npm packages
│   │   ├── release-ios.yml             # xcframework + TestFlight
│   │   ├── release-android.yml         # AAR + Play Store internal
│   │   └── deploy-relay.yml            # SSH deploy to Oracle
│   ├── ISSUE_TEMPLATE/
│   ├── PULL_REQUEST_TEMPLATE.md
│   └── dependabot.yml
├── crates/
│   ├── protocol/
│   │   ├── Cargo.toml                  # serde + thiserror only, no async
│   │   └── src/
│   │       ├── lib.rs
│   │       ├── messages.rs             # ClientToServerMsg, ServerToClientMsg
│   │       ├── types.rs                # SessionId, ClientId, AgentState, Capabilities
│   │       └── version.rs              # CONTRACT_VERSION = 1
│   ├── daemon/
│   │   ├── Cargo.toml
│   │   └── src/
│   │       ├── main.rs                 # bin: fieldworkd
│   │       ├── config.rs               # figment
│   │       ├── session.rs              # portable-pty spawning, Session struct, ring, render loop
│   │       ├── ipc.rs                  # Unix socket server, local CLI lifecycle, session registry
│   │       ├── transport_iroh.rs       # iroh endpoint, pairing
│   │       ├── pairing.rs              # pair-token generation and approval
│   │       ├── authz.rs                # local/mobile capability enforcement
│   │       ├── persistence.rs          # encrypted redb scrollback/device registry
│   │       ├── ring.rs                 # retained PTY byte window
│   │       ├── terminal_model.rs       # wezterm-term snapshots and state
│   │       ├── state_infer/            # idle / working / awaiting modules
│   │       ├── push.rs                 # daemon relay push registration/dispatch
│   │       ├── forward.rs              # PTY output forwarding helpers
│   │       ├── paths.rs                # runtime path resolution
│   │       ├── privacy_tracing.rs      # log sanitizer
│   │       └── logging.rs              # tracing init
│   ├── cli/
│   │   ├── Cargo.toml
│   │   └── src/
│   │       ├── main.rs                 # bin: fieldwork
│   │       ├── commands/
│   │       │   ├── pair.rs             # QR pairing
│   │       │   ├── ls.rs               # list sessions
│   │       │   ├── attach.rs           # ratatui-based terminal client
│   │       │   ├── new.rs              # create session
│   │       │   ├── kill.rs
│   │       │   ├── daemon.rs           # daemon install/start/stop
│   │       │   ├── devices.rs          # list/remove paired phones
│   │       │   ├── update_notice.rs    # npm-only cached update notice; no downloader
│   │       │   └── (no self-updater — npm remains the only update path)
│   │       └── tui.rs                  # ratatui rendering for attach
│   ├── relay/
│   │   ├── Cargo.toml
│   │   └── src/
│   │       ├── main.rs                 # bin: fieldwork-relay
│   │       ├── control_plane.rs        # axum: register node, get token
│   │       ├── auth.rs                 # NodeId allowlist (rate-limit-only)
│   │       └── metrics.rs              # Prometheus exporter
│   └── mobile-core/
│       ├── Cargo.toml                  # crate-type = ["lib", "cdylib", "staticlib"]
│       ├── build.rs                    # uniffi build helpers
│       └── src/
│           ├── lib.rs                  # uniffi::setup_scaffolding!()
│           ├── client.rs               # AppClient facade (public UniFFI)
│           ├── store.rs                # State, reducers
│           ├── events.rs               # EventSink callback interface
│           ├── transport.rs            # iroh client side
│           ├── logging.rs              # tracing-oslog / tracing-android
│           └── types_ffi.rs            # UniFFI-safe records + enums
├── apps/
│   ├── ios/
│   │   ├── Fieldwork.xcodeproj/
│   │   ├── Sources/
│   │   │   ├── App/                    # FieldworkApp.swift entry point
│   │   │   ├── Features/
│   │   │   │   ├── Sessions/           # list view
│   │   │   │   ├── Terminal/           # SwiftTerm-based detail view
│   │   │   │   ├── Pairing/            # QR scanner
│   │   │   │   └── Settings/
│   │   │   ├── Core/                   # UniFFI generated bindings
│   │   │   └── UI/                     # shared components, theme
│   │   ├── Tests/                      # XCTest
│   │   ├── GeneratedRust/              # cdylib + bindings (gitignored)
│   │   └── scripts/build-rust.sh       # ported from Litter
│   └── android/
│       ├── build.gradle.kts
│       ├── settings.gradle.kts
│       ├── app/
│       │   ├── build.gradle.kts
│       │   ├── src/main/
│       │   │   ├── kotlin/app/fieldwork/
│       │   │   │   ├── MainActivity.kt
│       │   │   │   ├── features/sessions/
│       │   │   │   ├── features/terminal/  # connectbot/termlib
│       │   │   │   ├── features/pairing/
│       │   │   │   └── di/             # Hilt or Koin
│       │   │   ├── assets/
│       │   │   └── jniLibs/<abi>/      # written by cargo-ndk
│       │   ├── src/test/               # JVM unit tests
│       │   └── src/androidTest/        # instrumentation
│       └── scripts/build-rust.sh
├── packages/                            # npm publish artifacts
│   ├── cli/                            # fieldwork meta-package
│   │   ├── package.json
│   │   └── bin/fieldwork.js            # JS launcher
│   ├── cli-darwin-arm64/
│   │   ├── package.json                # os:["darwin"], cpu:["arm64"]
│   │   └── bin/fieldwork               # binary copied here in CI
│   ├── cli-darwin-x64/
│   ├── cli-linux-x64/
│   ├── cli-linux-arm64/
│   # cli-win32-x64/ omitted from v1; see FUTURE.md
│   └── README.md
├── infra/
│   ├── oracle/
│   │   ├── terraform/
│   │   │   ├── main.tf                 # provision ARM A1 relay host/network
│   │   │   ├── variables.tf
│   │   │   └── outputs.tf              # emits Ansible inventory line
│   │   ├── provision-region.sh         # retry wrapper for scarce A1 capacity
│   │   └── README.md                   # provisioning + state/secrets rules
│   └── relay/
│       └── ansible/
│           ├── playbook.yml            # install relay systemd units
│           └── templates/
├── docs/
│   ├── ARCHITECTURE.md
│   ├── PROTOCOL.md                     # the wire-protocol RFC
│   ├── SECURITY.md                     # product security model
│   ├── PRIVACY.md
│   ├── INSTALL.md
│   ├── DEVELOPMENT.md                  # how to build from source
│   ├── OPERATIONS.md                   # relay operations and incident response
│   └── RELEASE_AUDIT.md
├── scripts/
│   ├── check-ios-prereqs.sh            # local Xcode/iOS SDK prerequisite audit
│   ├── publish-npm-packages.mjs        # explicit children-first npm publish
│   ├── pair-test.sh                    # smoke test for QR pairing
│   └── smoke-local-handoff.sh          # local pairing/attach/restart smoke
└── references/                          # cloned for study, gitignored
    ├── litter/
    ├── lunel/
    ├── zellij/
    └── rose/
```

---

## 6. Wire protocol (RFC v1)

### 6.1 Design principles

- **Length-prefixed framing** on every transport (Unix socket, iroh stream).
- **Bincode for local IPC** (Unix socket — smaller, faster, both sides are Rust).
- **MessagePack for mobile** (smaller than JSON, schema-flexible, multiple SDKs).
- **Serde enum representation is externally tagged** for v1 protocol messages. Internally tagged enums (`#[serde(tag = "type")]`) do not round-trip through bincode because bincode does not support `deserialize_any`; local IPC correctness takes precedence.
- **`CONTRACT_VERSION = 1` constant in `protocol` crate**. Server rejects `Hello` with mismatch; direct IPC tests cover `LocalCli`, `IosApp`, and `AndroidApp`, and the local iroh handoff smoke verifies mobile transport mismatch rejection before pairing.
- **All times in UTC milliseconds.** Avoid string timestamps.
- **All IDs are UUIDv7** (sortable by time, useful for debugging).

### 6.2 Message types

```rust
// crates/protocol/src/messages.rs

#[derive(Serialize, Deserialize, Clone, Debug)]
pub enum ClientToServerMsg {
    Hello {
        client_kind: ClientKind,
        client_version: String,
        protocol_version: u32,
    },
    ListSessions,
    // Long-lived dashboard subscription. Daemon sends one immediate
    // SessionList and replacement lists after create/remove/state changes.
    SubscribeSessions,
    // CreateSession is ONLY accepted from LocalCli clients. Daemon rejects
    // with Error{Forbidden} if sent by IosApp/AndroidApp. This is enforced
    // both at the daemon's protocol handler and in mobile-core (mobile-core
    // does not expose any API that constructs this variant).
    CreateSession {
        name: String,
        command: Vec<String>,
        cwd: PathBuf,
        env: HashMap<String, String>,
        size: ClientSize,
    },
    AttachSession {
        session_id: SessionId,
        size: ClientSize,
        last_seen_seq: Option<u64>,    // for reconnect-with-replay
    },
    DetachSession,
    // KillSession ONLY from LocalCli (same enforcement as CreateSession).
    // Mobile clients can detach but not terminate a session.
    KillSession { session_id: SessionId },
    Input {
        session_id: SessionId,
        bytes: Vec<u8>,
    },
    Resize {
        session_id: SessionId,
        size: ClientSize,
    },
    Ping { seq: u64 },
    // Pairing administration is LocalCli-only. Remote devices use PairWithToken
    // over iroh and still require explicit desktop approval before storage.
    BeginPairing { device_name: Option<String> },
    ApprovePairing { request_id: ClientId, approved: bool },
    PairWithToken {
        pair_token: String,
        device_name: String,
        device_node_id: String,
    },
    ListDevices,
    RemoveDevice { name: String },
    // Mobile registers its push token after pairing. Daemon stores it in
    // encrypted devices.redb under a hashed device row key; the raw device node id
    // lives only inside the encrypted row payload. When state inference flips a
    // session to AwaitingInput, daemon POSTs to relay's /v1/push (NOT directly to
    // APNs/FCM — the relay holds those provider credentials).
    RegisterPushToken { platform: PushPlatform, token: String },
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub enum ServerToClientMsg {
    Welcome {
        client_id: ClientId,
        daemon_version: String,
        capabilities: Capabilities,
    },
    SessionList {
        sessions: Vec<SessionSummary>,
    },
    SessionCreated { session_id: SessionId, summary: SessionSummary },
    // PTY byte-stream protocol. SwiftTerm, libvterm (termlib), and xterm.js
    // all natively consume `feed(bytes)` — we forward raw PTY bytes from
    // daemon to each subscribed client.
    // The daemon still parses bytes locally with wezterm-term for state
    // inference, but client streaming is byte-level, not cell-level.
    Attached {
        session_id: SessionId,
        initial_bytes: Vec<u8>,   // scrollback replay: last N kilobytes of PTY output
        seq: u64,
    },
    Output {
        session_id: SessionId,
        seq: u64,
        bytes: Vec<u8>,
    },
    AgentStateChanged {
        session_id: SessionId,
        state: AgentState,
        // last_line is SANITIZED (ANSI stripped, truncated to 80 chars)
        // and ONLY used for the AgentStateChanged event. It is NOT placed
        // in push notification payloads (those go to Apple/Google plaintext —
        // see Section 7.5 push privacy rules). Phones display this in the
        // session-list card preview.
        last_line: Option<String>,
    },
    SessionExited {
        session_id: SessionId,
        exit_code: i32,
    },
    // Sent when a subscriber's send buffer overflowed and the daemon had
    // to drop broadcast messages. Client resyncs by re-attaching.
    Lag {
        session_id: SessionId,
        skipped_bytes: u64, // historical wire name; value is skipped broadcast messages
    },
    PairingStarted { payload: PairingPayload },
    PairingApprovalRequested {
        request_id: ClientId,
        device_name: String,
        device_node_id: String,
    },
    PairingComplete { daemon_node_id: String },
    DeviceList { devices: Vec<DeviceSummary> },
    Pong { seq: u64 },
    Error { code: ErrorCode, message: String },
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
pub enum ClientKind { LocalCli, IosApp, AndroidApp }

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
pub enum PushPlatform { Apns, Fcm }

#[derive(Serialize, Deserialize, Clone, Copy, Debug)]
pub struct ClientSize { pub cols: u16, pub rows: u16 }

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SessionSummary {
    pub id: SessionId,
    pub name: String,                  // "claude · api"
    pub command: Vec<String>,
    pub cwd: PathBuf,
    pub created_at: u64,               // ms
    pub last_activity: u64,            // ms
    pub state: AgentState,
    pub last_line: Option<String>,     // for card preview
    pub model: Option<String>,         // e.g. "sonnet-4.6"
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct PairingPayload {
    pub relay_url: Option<String>,
    pub node_id: String,
    pub addrs: Vec<String>,
    pub pair_token: String,
    pub expires_at: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct DeviceSummary {
    pub name: String,
    pub device_node_id: String,
    pub paired_at: u64,
    pub last_seen: Option<u64>,
    pub push_platform: Option<PushPlatform>,
}

// No Frame/FrameDelta/Cell types — the protocol streams raw PTY bytes.
// Client-side terminal libs (SwiftTerm, libvterm via termlib, xterm.js) all
// natively consume `feed(bytes)` and maintain their own cell-grid state.
// This drops ~500 lines of cell-grid diff/encode/decode complexity.

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
pub enum AgentState { Idle, Working, AwaitingInput, Crashed }

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Capabilities {
    pub push_notifications: bool,
}
```

### 6.3 Reconnect-with-replay semantics

Two distinct catch-up paths — incremental (warm) and cold-attach/stale-resync.

**Incremental replay** (warm reconnect within ring-buffer window):
- Daemon keeps a per-session **ring buffer of the last 256 KB of PTY bytes** (≈ 30s of typical agent output).
- Each `Output` message carries a monotonic `seq: u64` (byte-offset counter).
- Client persists `last_seen_seq` per session locally.
- On reconnect, client sends `AttachSession { last_seen_seq }`.
- If `last_seen_seq` is within the ring buffer, daemon replays missed bytes verbatim and continues.

**Cold attach / stale resync — synthetic ANSI snapshot** (the tmux-attach approach):
- Just replaying the last 256 KB of bytes does **not** reliably reconstruct terminal state. If the agent entered vim's alt-screen 10 minutes ago, the `\x1b[?1049h` escape that did so is older than the ring buffer; replaying recent bytes alone leaves the client's terminal in the wrong mode. Same problem for cursor position, color attributes, scroll region, scrollback.
- Instead, the daemon uses its in-memory `wezterm-term::Terminal` (which has parsed every byte since session creation, so it holds the **current** terminal state) to **render a synthetic ANSI refresh stream**: emit cursor-home (`\x1b[H`) → clear (`\x1b[2J`) → set alt-screen if active (`\x1b[?1049h`) → set scrollback region → walk the current cell grid and emit per-cell color/attribute escapes + character → restore cursor position and visibility → set title.
- Daemon sends this synthetic ANSI as `Attached { initial_bytes }`. Client feeds it to its terminal lib (SwiftTerm/libvterm/xterm.js) which parses the escapes and arrives at the correct visual state — including alt-screen, cursor, colors — without seeing the original byte history.
- This is exactly what `tmux attach` does after detach. Reference: tmux's `screen_write_*` family of functions; the daemon implementation lives in `terminal_model::TerminalModel::render_snapshot()` and returns `Vec<u8>`.
- **Unit test gate** (in Section 13.7): start a daemon session with `vim /etc/hosts`, attach a fresh in-process test client (running its own wezterm-term), assert the client's resulting cell grid is byte-identical to the daemon's. Without this test passing, v1.0 does not ship.

### 6.4 Multi-client semantics

- Multiple clients can attach to the same session simultaneously. Daemon broadcasts byte chunks to all subscribers.
- Input from any client is forwarded to the PTY directly — no locking, no priority. Last-write-wins.
- Resize: daemon takes the **minimum size** across all attached clients (Zellij's "shrink to smallest viewport" model).
- Detach: client closes the connection. Daemon notes "client left" but session continues.
- **Mobile-vs-CLI capability split**: daemon enforces that `CreateSession` and `KillSession` are accepted only when `client_kind == ClientKind::LocalCli`. Mobile clients sending these get `Error{Forbidden}`. This is the single most important security boundary — it prevents the iOS/Android app from being abused as a remote-shell launcher (which would both be an App Store rejection risk and a stolen-phone-becomes-RCE risk).

### 6.5 Privacy — three concentric layers

**The protocol is honest about what carries user content. Earlier drafts conflated three different layers; this is the corrected model.**

| Layer | What flows | User content present? | Protection |
|---|---|---|---|
| **Wire protocol** (iroh streams between daemon and clients) | PTY byte stream (full terminal output and stdin), session metadata (`command`, `cwd`, sanitized `last_line`), push tokens | YES — extensively. Every cell of terminal output is user content. | E2E encrypted via iroh QUIC. Relay sees ciphertext only. No third party (including us) can decrypt. |
| **Push notification payloads** (daemon → relay → APNs/FCM → device) | `{session_id_hash, session_name_hash, event_type: "awaiting_input"}` only. **No `last_line`. No terminal content. No file paths. No command lines.** | NO. Strictly metadata. Phone fetches actual content over iroh after user taps the notification. | TLS in transit; Apple/Google can read the (intentionally content-free) payload. Lock-screen visibility hidden by default. |
| **Daemon telemetry / crash reporting** | Opt-in Sentry crash reports only. Sentry has default PII disabled and trace sampling set to `0.0`; daemon OTLP/Honeycomb export is intentionally absent from v1. | NO terminal/session content by design. | **Opt-in only; user defaults to off.** No daemon data leaves user's machine without consent. |
| **Relay operator telemetry** (server-side, fieldwork-operated) | Connection counts, push delivery success rates, error rates, latencies sampled at 1%. **No per-user data**: counters and percentiles only. Source IPs scrubbed to /16 prefix at ingestion. | NO. Aggregate counters; no per-NodeID dimensions. | Always on (this is our operational visibility into the public service). Documented in `docs/PRIVACY.md`. Self-hostable relay packaging is outside v1 and tracked in `FUTURE.md`. |

What the protocol carries (sensitive but E2E encrypted):
- `Input.bytes` — keystrokes, including passwords typed at prompts
- `Output.bytes` — full terminal output, including AI responses, command results, file contents shown by `cat`/`less`
- `CreateSession.{command, cwd, env}` — process names, paths, environment vars (may contain secrets like `OPENAI_API_KEY`)
- `SessionSummary.{name, command, cwd}` — same metadata as above
- `AgentStateChanged.last_line` — last visible line of agent output (sanitized: ANSI-stripped, ≤80 chars)

What the protocol does NOT carry to push providers:
- None of the above. Push payload contains only opaque IDs and event type.

---

## 7. Component specs

### 7.1 `fieldworkd` daemon

**Spawn model**: launched by `fieldwork pair` first run, or by `fieldwork daemon install` (which writes a launchd plist / systemd user unit via `service-manager`). Always runs as the logged-in user, never root.

**Responsibilities**:
- Maintain N PTY sessions (one per arbitrary command — `claude`, `bash`, `vim`, `python`, `htop`, anything). v1: macOS + Linux only.
- Run `wezterm-term::Terminal` per session for state inference and cold/stale attach snapshots — used to parse ANSI escape sequences for the prompt-pattern detector, capture a sanitized `last_line` for `AgentStateChanged`, and render synthetic ANSI snapshots when byte-ring replay cannot satisfy `last_seen_seq`. The daemon still streams raw PTY bytes for live output; it does not send cell-grid diffs.
- Detect session state (`Idle | Working | AwaitingInput | Crashed`) via per-agent inference modules. **v1 ships two**:
  - **`state_infer::claude`** — byte rate + explicit prompt regex for approval/permission phrases + Claude Code Stop hook (configured in `~/.claude/settings.json` to POST JSON to daemon's Unix socket on every turn end). It does not treat every arbitrary `?` as `AwaitingInput`; fixture coverage rejects that false-positive class. Matches commands `claude`, `claude-code`.
  - **`state_infer::codex`** — uses Codex structured state events when available, accepting `type`, `event`, and `status` event shapes. Implementation note from the local Codex CLI surface (2026-05-17): the installed command exposes `codex remote-control` and `codex app-server --listen/proxy`, not the older planned `codex app-server daemon --remote-control` form, and `codex` itself does not accept a `--remote-control` flag. v1 must not mutate a user's `codex` PTY command into an unsupported flag because universal terminal handoff takes priority. Instead, Fieldwork runs the requested `codex` PTY command unchanged and accepts structured Codex events through the local agent-event hook adapter; app-server/proxy integration can be layered onto that adapter once the command surface is stable. Matches commands `codex`, `codex-exec`.
  - **Dispatch logic**: when `CreateSession` arrives, daemon matches `command[0]` against a registry of known agents and selects the inference module. Unknown commands (`bash`, `vim`, `htop`, etc.) fall through to byte-rate-only inference: `Idle` / `Working` based on bytes/sec, never `AwaitingInput`, never push. Interactive shells don't have a meaningful "waiting on the user" state distinct from "idle."
  - Adding a new agent in v1.x = a new file under `crates/daemon/src/state_infer/`, ~150-250 LOC, registered in the dispatch table. No protocol or transport changes.
- Accept connections from:
  - Local Unix socket (`$XDG_RUNTIME_DIR/fieldwork/control.sock`, perms `0600`) — for the CLI `attach` command. Hardened: parent dir is owned by the user with `0700`, daemon refuses to bind if the parent is a symlink.
  - iroh endpoint — for the iOS/Android apps. Enforces `CreateSession`/`KillSession` only from `LocalCli` clients.
- Broadcast raw PTY byte chunks to all subscribed clients. v1 does not send cell-grid diffs and does not add an application-level compression layer.
- Persist session summaries and scrollback into encrypted `sessions.redb` every 30s when output changes (`~/Library/Caches/app.fieldwork/sessions.redb` on macOS, `$XDG_CACHE_HOME/fieldwork/sessions.redb` or `~/.cache/fieldwork/sessions.redb` on Linux). **Encrypted at rest** with a per-user key from the OS Keychain/Secret Service (XChaCha20-Poly1305); fall back to plaintext only if user explicitly opts in via `fieldwork settings scrollback-encryption off`.
- **Push dispatch via relay**, not directly to APNs/FCM. When state flips to `AwaitingInput`, daemon POSTs one request per target token to the relay's `/v1/push` endpoint with `{recipient_token, platform, session_id_hash, session_name_hash, event_type, nonce, ts_ms}`. The relay holds the APNs `.p8` key and FCM service account credentials and fans out the actual push. Daemon never sees or holds those provider credentials — they're held in exactly one place (the relay).
- Maintain device registry (paired phones' Ed25519 pubkeys + push tokens) in `redb` at `~/Library/Application Support/app.fieldwork/devices.redb`. Rows are stored under hashed device keys; raw device node IDs and push tokens live only inside the encrypted row payload. Encrypted at rest with the same Keychain-held key as scrollback.

**Key files**: `crates/daemon/src/{main,session,ipc,transport_iroh,persistence,state_infer,push,authz,pairing,ring,terminal_model}.rs`

**Critical correctness invariants**:
- Drop `pair.slave` after `spawn_command` (otherwise master read blocks forever).
- Set `TERM=xterm-256color`, `COLORTERM=truecolor` in spawned env.
- Forward `SIGWINCH` to child via `master.resize()`.
- DSR responses (`\x1b[6n` → `\x1b[<r>;<c>R`) written back into PTY via `PtyResponseWriter`.
- `broadcast::Sender` lag → drop the subscriber's pending broadcast messages, send a single `Lag { skipped_bytes }` event so the client can resync via re-attach. The v1 field name is `skipped_bytes` for wire stability, but the value is the skipped broadcast-message count reported by Tokio.
- Resize storm debounce: 100ms with latest min-size.
- **Implementation note (2026-05-18)**: daemon session state tracks attached viewports by `ClientId`, applies the minimum rows/columns to `master.resize()`, and debounces update/detach resize storms through a monotonically increasing `resize_epoch`. `pnpm check:daemon-resize` verifies the attach/update/detach scheduling contract, the 100ms debounce, and the Rust viewport helper tests.
- **Reject any `CreateSession` or `KillSession` from a `client_kind != LocalCli`** with `Error{Forbidden}` — single most important security check.

### 7.2 `fieldwork` CLI

**Subcommands**:

```
fieldwork pair                          # show QR for new device; prompts to approve incoming pair requests
fw pair                                 # npm-installed short alias for the same QR-pairing flow
fieldwork pair-test --payload <json> [--attach <session|first>]
                                        # hidden headless iroh transport smoke client
fieldwork                               # smart default: create+attach default claude, attach sole session, or list many
fw                                      # npm-installed short alias for the same CLI and smart default
fw <name>                               # named fast path: attach existing name or create+attach default claude
fieldwork ls                            # list sessions
fieldwork new --name <name> --dir <path> [cmd...]
                                        # create named session (default cmd: claude). CLI-only — phone cannot do this.
fieldwork attach <session-id|name>      # ratatui-based terminal client
fieldwork kill <session-id|name>        # SIGTERM to session. CLI-only.
fieldwork devices                       # list paired phones (last seen, push platform)
fieldwork devices remove <name>         # unpair (revokes device cert; daemon refuses subsequent connections)
fieldwork daemon                        # subcommand group
  fieldwork daemon install               # install as service (launchd on macOS, systemd user unit on Linux)
  fieldwork daemon uninstall
  fieldwork daemon status
  fieldwork daemon logs [--tail]
  fieldwork daemon restart
fieldwork settings telemetry status
fieldwork settings telemetry on [--sentry-dsn <dsn>]
fieldwork settings telemetry off
fieldwork settings scrollback-encryption status
fieldwork settings scrollback-encryption on
fieldwork settings scrollback-encryption off
fieldwork version
fieldwork completion <shell>            # generate completions
```

**No `fieldwork update` subcommand** — npm is the install channel, so updates route through `npm update -g fieldwork`. Having a separate self-updater would let the binary version diverge from the npm-registered version, breaking the user's mental model. The CLI prints a one-line `fieldwork X.Y.Z available - run npm update -g fieldwork` notice to stderr if the npm registry shows a newer version. The check is cached for 24 hours in the private Fieldwork config directory and skipped for QR pairing, shell completions, hooks, `version`, and raw terminal attach flows.

**No-args fast path**: `fieldwork` and npm's `fw` alias with no subcommand route
through the desktop-only CLI capability boundary. If no sessions exist, the CLI
creates the default `claude` session with a generated one-word display name such
as `waffle` or `kazoo` and immediately attaches; if exactly one session exists,
it attaches that session; if several sessions exist, it prints the session list
and asks the user to choose explicitly. The generated name is stored in
`SessionSummary.name`, so mobile apps show the same active session name in the
dashboard. Mobile clients still cannot create sessions, kill sessions, or choose
commands.

**Named-session fast path**: `fw <name>` is the product replacement for a
tmux/mosh/Tailscale alias like `mc refactoringjob`. It resolves an existing
session by exact display name and attaches to that live daemon-owned PTY. If no
session by that name exists, it creates a default `claude` PTY with that name and
immediately attaches. To name arbitrary commands explicitly, use `fieldwork new
--name <name> [cmd...]`; the phone sees the name as a tappable session but still
never creates sessions or chooses commands. The daemon rejects duplicate session
names with `ErrorCode::InvalidRequest`, keeping dashboard labels and `fw <name>`
resolution unambiguous. Reserved command names such as `pair`, `new`, `attach`,
and `daemon` remain CLI subcommands; use `fieldwork new --name <name>` if a
desired session name collides with a subcommand.

**`attach` UX**: local terminal pass-through client that connects to the daemon's Unix socket, sends `AttachSession`, receives the `Attached { initial_bytes }` payload, then writes streamed raw PTY bytes directly to the user's terminal in raw mode. This preserves full TUI fidelity for `vim`, `htop`, `lazygit`, shells, and agent UIs without trying to re-render a terminal inside ratatui. Keyboard input is forwarded as bytes (including Ctrl+B as escape prefix, Ctrl+B then D to detach — tmux-style for muscle memory). A ratatui status overlay can be revisited after v1 once it can be done without corrupting arbitrary TUI output.

### 7.3 `fieldwork-relay` (Oracle ARM)

**Three responsibilities** (Codex Round 1 expanded this from two — push gateway is now part of the relay because daemons cannot hold APNs/FCM provider credentials):

1. **iroh-relay** instance on `:443` for DERP-style fallback when direct P2P fails. As of Feb 2026, `iroh-relay::RelayService` is public, so we can run it standalone *or* embed in axum (we pick standalone for ops simplicity).

2. **axum HTTP control plane / push gateway** on `:8443`, served as HTTPS in production by the Rust process with a relay-only `control-plane.crt`/`control-plane.key` loaded through systemd credentials. Local development may run the same listener as loopback HTTP when `FIELDWORK_RELAY_REQUIRE_TLS` is unset.
   - `POST /v1/pair` — register the daemon's relay-signing public key for signed push requests. QR pair tokens remain daemon-local in v1 and are not stored by the relay.
   - `POST /v1/push` — **push gateway**. Authenticated and authorized — see Section 7.3.1 below. Daemons POST `{recipient_token, platform, session_id_hash, session_name_hash, event_type, nonce, ts_ms}` plus a signature header. Relay verifies signature, verifies token ownership, checks nonce hasn't been seen, then signs the APNs JWT (ES256) or generates the FCM OAuth2 token and forwards to Apple/Google. Rate-limited per NodeId (50/min). **The relay is the only place in the entire system that holds the APNs `.p8` key and FCM service-account JSON** — daemons never see them, so a compromised laptop cannot spoof push notifications for other users.
   - `GET /v1/version` — for client version checks.
   - `GET /metrics` — Prometheus scrape on a separate plaintext listener bound to `127.0.0.1:9090` (internal only, behind iptables; not on `:8443`).
   - All request bodies validated with **`garde`** at the extractor boundary.

3. **In-process cache** via **`moka`** for: NodeId rate-limit counters (TTL = 1min), version-check responses (TTL = 5min), APNs JWT (TTL = 50min, just under Apple's 60min limit). Async-aware, concurrent, Caffeine-equivalent perf.

**Push payload privacy invariant** (enforced by `garde` validation on `POST /v1/push`): the request body schema rejects any field that could contain user content. Only opaque lowercase 64-character hex hashes (`session_id_hash`, `session_name_hash`), `recipient_token`, `platform`, a fixed `event_type` enum, `nonce`, and `ts_ms` are accepted. **No `last_line`, no command line, no path, no free-text strings.** Even if a daemon's `push.rs` were buggy and tried to send terminal content, the relay would reject the request at the extractor boundary. Defense-in-depth.

### 7.3.1 Push gateway authentication, token ownership, replay defense

The relay's `/v1/push` is a privileged endpoint — without strict controls, daemon A could push to daemon B's tokens or replay an old push. Three controls, all required:

**1. Signed daemon requests.** Every signed push endpoint carries an `X-Fieldwork-Signature` header containing an Ed25519 signature of `(method, path, body, nonce, ts_ms)` made with the daemon's long-lived Ed25519 private key. Relay knows the daemon's pubkey because each daemon registers it through `/v1/pair` before token registration. Relay rejects requests with invalid or unknown signatures.

**2. Token ownership binding** — relay-side, not just daemon-side. When a phone calls `RegisterPushToken` (over iroh) to a daemon, the daemon:
   (a) Stores `(device_pubkey, push_token, platform)` inside an encrypted `devices.redb` row addressed by a hashed device key.
   (b) Makes a signed `POST /v1/push/register-token` to the relay with body `{daemon_node_id, push_token, platform, ts, nonce}` and `X-Fieldwork-Signature` header (Ed25519 over the canonical body). Relay verifies signature against the daemon's known pubkey, then persists `(daemon_node_id, push_token, platform)` in its SQLite at `/var/lib/fieldwork/relay.db`.
   When daemon later POSTs to `/v1/push` with `recipient_token`, the relay looks up `(token → daemon_node_id)` in SQLite and asserts it matches the request's signing-daemon NodeID. Cross-daemon push attempts get `Error{Forbidden}`. Token-binding rows are deleted when (a) the daemon issues `POST /v1/push/unregister-token` (called when user removes the device or APNs returns "BadDeviceToken") or (b) auto-pruned after 90 days of no use.

**3. Nonce + timestamp replay defense.** Each request includes a unique nonce (per daemon) and current Unix timestamp. Relay persists the recent `(daemon_node_id, nonce)` replay window in SQLite and loads it on restart; the production cache layer may add a `moka` front cache, but SQLite remains authoritative for restart safety. Replays within the window return `Error{ReplayDetected}`. Requests with `|now - ts| > 5min` return `Error{ClockSkew}` (forces NTP-correct daemons).

**Test gate** (in Section 13.8): automated integration test — provision two test daemons (A and B), pair both, register a push token from device X with daemon A, then have daemon B attempt to POST to `/v1/push` with X's token. Assert `Error{Forbidden}`. Without this test passing, v1.0 does not ship.

### 7.3.2 Trust model — what the relay actually sees (revised, honest)

The earlier draft said "relay sees ciphertext only" — that was true of *iroh-relay's QUIC forwarding role*, but not of the combined `fieldwork-relay` process which also runs the HTTP control plane and push gateway. Split the trust model into two functions:

| Relay function | What it sees | What it cannot see |
|---|---|---|
| **iroh-relay (QUIC DERP fallback)** | Encrypted QUIC packets between paired daemon and phone. IP addresses of both endpoints. Connection timing and byte counts (metadata). | Plaintext PTY content, plaintext keystrokes, session IDs, command lines — all encrypted end-to-end by iroh's QUIC TLS. |
| **HTTP control plane / push gateway** | Push tokens (registered by phones, sent to APNs/FCM by relay). Hashed session IDs/names. Daemon NodeIDs and relay-signing public keys. Source IP of every request. Operational logs at info level (TTL'd). | Terminal content. Command lines. File paths. Session names in plaintext (hashed). User identity beyond NodeID. QR pair tokens stay daemon-local in v1. |

The `fieldwork-relay` binary holds both functions but they are logically separate concerns. Self-hostable relay packaging is outside v1 and tracked in `FUTURE.md`; v1 ships the Fieldwork-operated relay deployment scaffold.

**Deploy** (revised — earlier draft had operational conflicts Codex flagged):
- SSH'd to from CI via the `deploy-relay` workflow.
- **`iroh-relay` binds `:443` directly** with its **own built-in ACME** (Let's Encrypt). `setcap CAP_NET_BIND_SERVICE` on the binary so the dedicated `fieldwork-relay` user can bind privileged ports. **No Caddy in front** — would be a redundant TLS hop and conflict with QUIC.
- **HTTP control plane (axum) binds `:8443`** with Rustls using relay-only certificate and private-key credentials (`control-plane.crt`, `control-plane.key`). It does not run ACME on `:8443`; production cert issuance is an operator credential step, while the iroh relay keeps its own ACME flow on `:443`. Local-only control-plane smoke tests can stay on loopback HTTP with `FIELDWORK_RELAY_REQUIRE_TLS` unset.
- Systemd unit `fieldwork-relay.service` with `User=fieldwork-relay`, `AmbientCapabilities=CAP_NET_BIND_SERVICE`.
- **Secrets via systemd `LoadCredential`** (the clean modern path): APNs `.p8` and FCM service-account JSON listed in the unit's `LoadCredential=apns.p8:/etc/fieldwork/secrets/apns.p8` directive; systemd makes them readable to the unit's UID only, no filesystem perms gymnastics. Fallback if not available: root-owned, group `fieldwork-relay`, mode `0440`.
- SQLite at `/var/lib/fieldwork/relay.db` for persistent daemon public keys, push-token ownership, and the replay-nonce window. The DB directory is owned by `fieldwork-relay` with mode `0700`; the main DB plus SQLite `-wal`/`-shm` sidecars are mode `0600`.

**Capacity**: one A1 instance handles ~60k concurrent iroh connections. Two A1 instances across two Oracle accounts (different regions) for redundancy.

**Push gateway operational requirement**: Apple's APNs has rate limits (~100k req/min per topic on a shared HTTP/2 connection) and connection-pooling requirements. Construct one persistent APNs provider HTTP/2 client at relay startup, keep idle connections alive with PING frames every 60s, and reuse the provider connection across dispatches. With the current `reqwest` provider client, the TCP/TLS/HTTP2 connection itself is established lazily on first APNs dispatch and then retained in the client pool.

### 7.4 `fieldwork-mobile-core` (Rust + UniFFI)

**Architecture (Litter's pattern, copied)**:
- Single crate, single UniFFI surface.
- `lib.rs` ends with `uniffi::setup_scaffolding!();`.
- All exports via `#[uniffi::export]` proc-macros (no UDL).
- Library-mode bindgen at build time.

**Public surface (handwritten, narrow)** — these are the only types Swift/Kotlin see:

```rust
// Top-level facade. Note: NO create_session or kill_session — those are
// CLI-only per the protocol's mobile-vs-CLI capability split (Section 6.4).
// Mobile clients can pair, list, attach, and send input. They cannot
// launch new shells/agents — that's deliberately the CLI's job.
pub struct FieldworkClient { /* internal: iroh endpoint + state */ }

#[uniffi::export(async_runtime = "tokio")]
impl FieldworkClient {
    #[uniffi::constructor]
    pub fn new(config: ClientConfig) -> Arc<Self>;

    pub async fn pair_with_qr(self: Arc<Self>, qr_payload: String) -> Result<DaemonInfo, FieldworkError>;
    pub async fn connect(self: Arc<Self>) -> Result<(), FieldworkError>;
    pub async fn disconnect(self: Arc<Self>) -> Result<(), FieldworkError>;

    pub async fn list_sessions(self: Arc<Self>) -> Result<Vec<SessionSummaryFfi>, FieldworkError>;
    pub async fn attach_session(self: Arc<Self>, id: String) -> Result<Arc<AttachedSession>, FieldworkError>;

    pub async fn subscribe_sessions(self: Arc<Self>, sink: Box<dyn SessionListSink>) -> Result<(), FieldworkError>;

    pub async fn register_push_token(self: Arc<Self>, platform: PushPlatform, token: String) -> Result<(), FieldworkError>;
}

#[derive(uniffi::Object)]
pub struct AttachedSession { /* internal: subscriber to session byte stream */ }

#[uniffi::export(async_runtime = "tokio")]
impl AttachedSession {
    pub async fn send_input(self: Arc<Self>, bytes: Vec<u8>) -> Result<(), FieldworkError>;
    pub async fn resize(self: Arc<Self>, cols: u16, rows: u16) -> Result<(), FieldworkError>;
    pub async fn subscribe(self: Arc<Self>, sink: Box<dyn ByteStreamSink>) -> Result<(), FieldworkError>;
    pub async fn detach(self: Arc<Self>) -> Result<(), FieldworkError>;
}

#[uniffi::export(callback_interface)]
pub trait SessionListSink: Send + Sync {
    fn on_update(&self, sessions: Vec<SessionSummaryFfi>);
}

// Byte-stream sink instead of cell-grid sink — Swift/Kotlin pass these
// bytes directly to SwiftTerm.feed(bytes:) / xterm.write(bytes) /
// libvterm's vterm_input_write(). The renderer libs maintain their own
// cell-grid state internally. mobile-core just routes bytes.
#[uniffi::export(callback_interface)]
pub trait ByteStreamSink: Send + Sync {
    fn on_initial_bytes(&self, bytes: Vec<u8>);     // scrollback replay on attach
    fn on_output(&self, bytes: Vec<u8>);            // streaming PTY output
    fn on_agent_state(&self, state: AgentStateFfi); // for status icon updates
    fn on_lag(&self, skipped_bytes: u64);           // tell user "missed N updates, reconnecting…"
    fn on_session_exited(&self, code: i32);
}
```

Internal state, reducers, iroh transport, persistence — all behind these types. Swift/Kotlin never see Rust internals.

**Hardened inside mobile-core**:
- **`rustls-platform-verifier`** for Fieldwork-owned Rust TLS paths such as iroh relay connections. APNs and FCM provider TLS is handled by the native Apple/Firebase stacks in the apps and by the relay provider clients on the server side.
- **Exact raw PTY byte handoff over prediction**: v1 mobile-core does not implement mosh SSP or any other predictive local echo. The native apps send input to the daemon and render daemon bytes from SwiftTerm/termlib so unknown commands, shells, and TUIs stay byte-faithful.
- **Security-sensitive parser/auth coverage**: v1 uses focused Rust unit tests, proptests, protocol snapshots, authz tests, and the local handoff smoke for pair-token parsing, QR payload deserialization, device auth, revocation, and mobile capability rejection. Bounded model-checker harnesses are not a v1 release gate.

### 7.5 iOS app

**Tech**: SwiftUI, Swift 6 (strict-concurrency warning mode for now), iOS 17+, no Catalyst.

**Three screens**:

1. **Sessions list** (`Features/Sessions/SessionsListView.swift`):
   - Pull-to-refresh (calls `fieldworkClient.listSessions()`).
   - List of session cards: name, status icon, model, last-line preview, elapsed.
   - Sort order: `AwaitingInput` first, then `Working`, then `Idle`, then `Ready`.
   - Swipe right: **hide locally** (just removes from this device's UI; doesn't affect the session on the desktop or other devices).
   - **No "+ New session" button. No swipe-left-to-kill.** Per Section 6.4, mobile clients cannot create or kill sessions — those happen via `fieldwork new` / `fieldwork kill` on the desktop. If no sessions exist, the list shows a help card: *"Create a session on your laptop with `fieldwork new` — it'll appear here automatically."*
   - Tap card → push `TerminalView(sessionId:)`.

2. **Terminal view** (`Features/Terminal/TerminalView.swift`):
   - SwiftTerm `TerminalView` wrapped in `UIViewRepresentable`.
   - Subscribes to `AttachedSession` via `ByteStreamSink` callback.
   - On `onInitialBytes` (scrollback replay) and `onOutput` (streaming), calls `swiftTermView.feed(byteArray: bytes)`.
   - Bottom: keyboard accessory bar (Esc / Ctrl / Tab / | / / / ↑↓←→ / function rows on swipe).
   - Hardware keyboard support via `keyboardShortcut` modifiers and `pressesBegan`.
   - Long-press cell: copy.

3. **Pairing** (`Features/Pairing/PairingView.swift`):
   - Camera QR scanner (`AVCaptureSession`).
   - On scan, calls `fieldworkClient.pairWithQr(qrPayload)`.
   - On success, navigates to sessions list.

**Push notifications**:
- Register for APNs only after a saved or newly approved pairing exists and biometric unlock succeeds; token callbacks are retained and sent through `RegisterPushToken` once the daemon pairing is available.
- Send token to daemon (via iroh) after pairing and unlock. Daemon then makes a signed `POST /v1/push/register-token` to the relay so the relay can later verify token ownership (per Section 7.3.1).
- Daemon POSTs to relay's `/v1/push` when an agent flips to `AwaitingInput`. Relay signs APNs JWT (ES256) and forwards to Apple.
- **Relay generates the user-facing alert text** from a fixed enum (event_type → copy). For `AwaitingInput`, the APNs payload contains:
  - `aps.alert.title`: `"Fieldwork"`
  - `aps.alert.body`: `"A session is waiting for you."`
  - `aps.thread-id`: `"session." + session_id_hash`
  - Custom data (consumed by app, not displayed): `{session_id_hash, session_name_hash, event_type: "awaiting_input"}`
- **All alert text is fixed enum-derived boilerplate** — no `last_line`, no session name, no path, no command line ever traverses Apple/Google. Apple/iOS sees only the generic strings + opaque hashes. The app does not modify alert text at delivery time (avoids the Notification Service Extension reliability caveats).
- **Lock-screen text stays generic.** v1 has no Notification Service Extension and no lock-screen session-name toggle. Native notification UI uses only the relay's fixed enum-derived copy and lowercase 64-character hex `session_id_hash` tap routing.
- **Tap → deep-link**: iOS app launches, requires Face ID (per Section 7.5 security below), then navigates to the session's terminal view. Phone fetches actual `last_line` over iroh on app open, not from the push payload.

**Settings screen** (minimal for v1):
- Paired daemon info (name, last-seen, NodeID prefix)
- Unpair button
- App version + Sentry opt-in toggle
- About / OSS licenses

**Security hardening (iOS app)**:
- **Face ID required after 5 minutes background**. Reopening the app, or tapping a push, prompts `LocalAuthentication` evaluation before any session view renders. Failure → return to a locked overlay; tapping the overlay re-prompts.
- **Face ID required before sending any keystroke** if last successful evaluation was more than 5 minutes ago — defense against shoulder-surfing + dropped phone.
- **Mobile terminal scrollback is not persisted to disk in v1**. Attached bytes live in the terminal renderer/controller memory; daemon-side persisted scrollback remains encrypted at rest as defined in Sections 6.3 and 7.1.
- **Pairing requires desktop confirmation**: when phone scans QR and POSTs the pair token, daemon does not auto-approve. Desktop CLI prints `Pair request from device "{name}" — approve? [y/N]` and waits for explicit `y`. Pair tokens are daemon-local in-memory pending tokens and are single-use: first use consumes the token regardless of approval outcome.

### 7.6 Android app

**Tech**: Jetpack Compose, Kotlin 2.3.20, min SDK 30 (Android 11+, covers 95%+ in 2026).

**Same three screens**, mirroring iOS:

1. **Sessions list**: `LazyColumn` of cards. Pull-refresh via built-in `pullRefresh`.
2. **Terminal view**: **`connectbot/termlib`** — an Apache-2.0 Jetpack Compose terminal component that wraps **libvterm** (Paul Evans, MIT, 10+ years mature) via JNI. Production-quality features: 256/truecolor, double-width chars, combining chars, magnifier touch selection, scroll, zoom. Native Compose owns the input → fixes the WebView IME composition issues at the source.
3. **Pairing**: `CameraX` for QR scanning.

**Push**: Firebase Cloud Messaging. Same payload contract as iOS.

**Why termlib (not xterm.js+WebView)**:
- The Android xterm.js IME issue (no `keydown` until commit, breaks shells on spacebar) is **structural to WebView**, not an xterm.js bug. A March 2026 xterm.js PR fixed one composition bug but not the root cause.
- libvterm is the same VT engine Vim's terminal uses — battle-tested for 10+ years.
- ConnectBot team has been doing Android terminals for 17 years; this is the credible heir to JediTerm-on-Android that never existed before.
- Same input contract as SwiftTerm on iOS (byte stream in, cell-grid state) → unified protocol from the Rust core.

**Risk and decision point**: termlib is young (created Nov 2025, 8 stars, 4 contributors, 20 open issues). **Hard gate at end of week 5**: spike termlib for 1 day, run a 30-minute exploratory dogfood test (start daemon, render `claude` session, type, scroll, resize, paste). Pass = ship with termlib. Fail = drop to Termux for v1. **Decision made by end-of-week-5, no later — no rolling reassessment.**

**Gate implementation note (2026-05-17)**: Android v0 now pins `org.connectbot:termlib:0.0.35` and wires termlib to `mobile-core` byte streams. The termlib artifact requires Kotlin 2.3 metadata support, so the Android project now pins Kotlin/Compose plugin `2.3.20` and uses the current `compilerOptions` DSL. Local Android release artifact validation passed: `apps/android/scripts/build-rust.sh` built `fieldwork-mobile-core` for `arm64-v8a`, `armeabi-v7a`, and `x86_64`, and `apps/android/gradlew --no-daemon bundleRelease` produced an AAB containing all three ABI slices. The required 30-minute physical Android device dogfood remains a release gate before Play internal distribution.

Fallback ladder if termlib fails the week-5 gate:
1. **`connectbot/termlib`** — primary (Apache-2.0, MIT libvterm + Compose-native, ConnectBot team).
2. **Termux `terminal-emulator`** — fallback (GPL-3.0, 17 years of Android-specific terminal expertise, runs on millions of devices). Compatible with our AGPL project license.
3. **xterm.js + WebView** — last resort only if both above fail; reserved for the "no other option" scenario.

---

## 8. npm distribution (the only desktop install path)

Pattern is the **esbuild / biome / turbo / swc** blueprint: one meta-package, N per-platform packages in `optionalDependencies`, JS launcher. **Plus** the esbuild postinstall binary-swap trick that eliminates Node startup overhead on every invocation.

### 8.1 Package structure

Both binaries (`fieldwork` CLI + `fieldworkd` daemon) ship in the **same** per-platform tarball — each platform package contains a `bin/` directory with both binaries. The meta-package's `bin` field exposes `fieldwork`, the shorter `fw` alias for the same CLI dispatcher, and `fieldworkd` to npm so user service managers and direct daemon invocations resolve the same native package family as the CLI.

```
fieldwork                          # meta-package (Node-side, tiny)
├── fieldwork-darwin-arm64         # ships fieldwork + fieldworkd
├── fieldwork-darwin-x64
├── fieldwork-linux-x64
└── fieldwork-linux-arm64
# 5 packages total (1 meta + 4 platform). Windows host is outside v1.
```

### 8.2 Meta-package `package.json`

```json
{
  "name": "fieldwork",
  "version": "1.0.0",
  "description": "Your terminal sessions, from anywhere.",
  "bin": {
    "fieldwork": "bin/fieldwork",
    "fw": "bin/fieldwork",
    "fieldworkd": "bin/fieldworkd"
  },
  "scripts": {
    "postinstall": "node install.js"
  },
  "optionalDependencies": {
    "fieldwork-darwin-arm64": "1.0.0",
    "fieldwork-darwin-x64": "1.0.0",
    "fieldwork-linux-arm64": "1.0.0",
    "fieldwork-linux-x64": "1.0.0"
  },
  "engines": { "node": ">=18" },
  "files": [
    "bin/fieldwork",
    "bin/fieldworkd",
    "install.js",
    "README.md",
    "LICENSE",
    "NOTICE"
  ],
  "license": "AGPL-3.0-or-later",
  "publishConfig": {
    "access": "public"
  },
  "repository": {
    "type": "git",
    "url": "git+https://github.com/fieldwork-app/fieldwork.git",
    "directory": "packages/cli"
  },
  "keywords": ["terminal", "mobile", "pty", "tmux", "mosh", "claude-code", "codex", "coding-agent"],
  "preferUnplugged": true
}
```

Note the `bin` fields point to `bin/fieldwork` and `bin/fieldworkd` (no `.js` suffix). On install, those files start as JS dispatchers and the postinstall script **replaces them on disk with the actual native binaries** — the npm-generated shims in `node_modules/.bin/` then point directly at native code.

### 8.3 The postinstall binary-swap (`install.js`) — the critical perf win

Lifted from esbuild's pattern. Cold-start data (AWS CDK PR #37380, March 2026):
- Without the swap: **+~400ms** per `npx fieldwork` invocation, +~150ms per `yarn run fieldwork`.
- With the swap: **negligible** (Node never spawned).

```js
#!/usr/bin/env node
// install.js — runs once after npm install completes
const fs = require('fs');
const path = require('path');

const PLATFORM = process.platform;
const ARCH = process.arch;
const PKG_NAME = `fieldwork-${PLATFORM}-${ARCH}`;

// v1 supports darwin (arm64, x64) and linux (x64, arm64). Windows users
// install the linux-x64 package via WSL2.
const SUPPORTED = new Set(['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64']);
const key = `${PLATFORM}-${ARCH}`;

if (!SUPPORTED.has(key)) {
  console.error(`fieldwork: no binary for ${key}`);
  if (PLATFORM === 'win32') {
    console.error(`Windows host is not supported in v1. Install WSL2 and run "npm i -g fieldwork" inside Ubuntu.`);
  } else {
    console.error(`Supported: darwin-arm64, darwin-x64, linux-x64, linux-arm64.`);
  }
  console.error(`Open an issue: https://github.com/fieldwork-app/fieldwork/issues`);
  process.exit(0); // don't fail npm install
}

function resolveBinary(name) {
  try {
    return require.resolve(`${PKG_NAME}/bin/${name}`);
  } catch (e) {
    return null;
  }
}

const fieldworkPath = resolveBinary('fieldwork');
const daemonPath = resolveBinary('fieldworkd');
if (!fieldworkPath || !daemonPath) process.exit(0); // dispatcher fallback handles it

const binDir = path.join(__dirname, 'bin');

try {
  fs.mkdirSync(binDir, { recursive: true });
  fs.copyFileSync(fieldworkPath, path.join(binDir, 'fieldwork'));
  fs.copyFileSync(daemonPath, path.join(binDir, 'fieldworkd'));
  fs.chmodSync(path.join(binDir, 'fieldwork'), 0o755);
  fs.chmodSync(path.join(binDir, 'fieldworkd'), 0o755);
} catch (err) {
  // Read-only fs or missing privileges — leave dispatcher as fallback
  console.warn(`fieldwork: postinstall optimization skipped (${err.code})`);
}
```

The corresponding **dispatchers** (`bin/fieldwork`/the `fw` alias and `bin/fieldworkd` as initially shipped — only run when postinstall couldn't swap) follow the Biome-minimal + Turbo-Ctrl-C pattern:

```js
#!/usr/bin/env node
// bin/fieldwork — dispatcher, replaced by postinstall in normal installs.
// v1 targets unix only (darwin + linux) so no .exe handling.
const { spawn } = require('child_process');

let binPath;
try {
  binPath = require.resolve(`fieldwork-${process.platform}-${process.arch}/bin/fieldwork`);
} catch {
  console.error(`fieldwork: no binary for ${process.platform}-${process.arch}`);
  console.error(`If you ran with --omit=optional, reinstall without that flag.`);
  console.error(`Windows host is not supported in v1. Use WSL2 + linux-x64 build.`);
  process.exit(1);
}

// Turbo-style signal propagation so Ctrl-C in `fieldwork attach` reaches the daemon cleanly
const child = spawn(binPath, process.argv.slice(2), { stdio: 'inherit' });
process.on('SIGINT', () => child.kill('SIGINT'));
process.on('SIGTERM', () => child.kill('SIGTERM'));
child.on('exit', code => process.exit(code ?? 1));
```

### 8.4 Per-platform package `package.json` template

```json
{
  "name": "fieldwork-darwin-arm64",
  "version": "1.0.0",
  "os": ["darwin"],
  "cpu": ["arm64"],
  "files": ["bin/fieldwork", "bin/fieldworkd"],
  "license": "AGPL-3.0-or-later",
  "preferUnplugged": true
}
```

**`preferUnplugged: true` is mandatory** on every platform package — yarn berry's Plug'n'Play (PnP) mode zips packages by default, which breaks binary execution. This flag tells yarn berry to leave the package unzipped on disk.

### 8.5 Cross-compile pipeline (GitHub Actions matrix)

Use each OS as its own builder. Don't try to cross-compile darwin or windows from Linux — too many edge cases. **Linux is the only one where cross-compilation pays off** (via cargo-zigbuild for glibc version pinning).

```yaml
# .github/workflows/release-rust.yml (excerpt)
strategy:
  fail-fast: false
  matrix:
    include:
      - { os: macos-14,      target: aarch64-apple-darwin,       build: cargo }
      - { os: macos-14,      target: x86_64-apple-darwin,        build: cargo }
      - { os: ubuntu-latest, target: aarch64-unknown-linux-gnu,  build: zigbuild }
      - { os: ubuntu-latest, target: x86_64-unknown-linux-gnu,   build: zigbuild }
      # Windows host target omitted from v1 (needs named-pipe IPC + Windows
      # service install design, neither of which exist for v1).
```

After the matrix, a single publish job:
1. Downloads all 4 host artifacts (darwin-arm64, darwin-x64, linux-x64, linux-arm64).
2. Copies each `fieldwork` + `fieldworkd` pair into the matching `packages/cli-<plat>-<arch>/bin/`.
3. Runs `node scripts/publish-npm-packages.mjs` — this verifies the package graph, then publishes all 5 packages with npm provenance in explicit dependency order (4 platform children first, then meta).

### 8.6 Version sync — Changesets with `fixed` groups

Use **[Changesets](https://github.com/changesets/changesets)** — the same tool that biome, rspack, rolldown, and swc all use. Configure with `fixed` package groups so the meta-package and all 4 platform packages bump together (5 total in lockstep):

```json
// .changeset/config.json
{
  "$schema": "https://unpkg.com/@changesets/config@2/schema.json",
  "changelog": ["@changesets/changelog-github", { "repo": "fieldwork-app/fieldwork" }],
  "commit": false,
  "fixed": [["fieldwork", "fieldwork-*"]],
  "linked": [],
  "access": "public",
  "baseBranch": "main",
  "ignore": []
}
```

Use `changesets/action@v1` GitHub Action to auto-PR version bumps. The release publish step is intentionally repo-owned through `scripts/publish-npm-packages.mjs` so platform packages publish before the meta package every time.

`scripts/verify-changesets-config.mjs` is the local guard for this contract: it expands the fixed group against the actual workspace package names, verifies exactly the meta package plus four v1 platform packages are covered, and checks the GitHub changelog, public access, `main` base branch, and root Changesets dependencies without needing a live GitHub token.

### 8.7 Compatibility matrix (verified patterns)

| Package manager | Works? | Notes |
|---|---|---|
| **npm 7+** | ✅ | The default. `--omit=optional` is the failure mode; dispatcher fallback handles it. |
| **pnpm 8+** | ✅ | Was broken pre-2022 (`pnpm/pnpm#5603`), fixed since. |
| **bun (v1+)** | ✅ | Standard npm semantics. |
| **yarn classic (v1)** | ⚠️ | May install all platforms unless user sets `supportedArchitectures` in `.yarnrc.yml`. Document this. |
| **yarn berry (PnP)** | ⚠️ | Requires `preferUnplugged: true` on every platform package (we set it). |

`scripts/test-bun-install.mjs` verifies the Bun row in CI by installing pinned `esbuild@0.25.12` registry packages across the four v1 desktop platform pairs with `bun install --os/--cpu`. This exercises the same npm optional-dependency shape Fieldwork publishes while the Fieldwork platform packages are still unpublished.

### 8.8 Anti-patterns — don't do these

- ❌ **napi-rs** — designed for `.node` native addons callable from JS, not standalone CLIs. Wrong abstraction.
- ❌ **cargo-dist's npm installer** — uses the **deprecated postinstall-download pattern** (single meta-package fetches the GitHub Release tarball at install time). esbuild abandoned this in 2021 (PR #1621) because it breaks for offline installs, custom registries, locked-down proxies, read-only filesystems, and `--ignore-scripts` users. Hand-roll the optionalDependencies flow instead.
- ❌ **Symlink the binary directly into `node_modules/.bin/`** — npm rewrites bin shims on Windows in a way that breaks symlinks, and you lose actionable error messages.
- ❌ **wasm-only fallback** — esbuild's wasm fallback is "10x slower" per their own docs. Useless for an interactive CLI.

### 8.9 Reference codebases to copy from

- **Biome** (`packages/@biomejs/biome/` + `packages/@biomejs/cli-*/`) — cleanest hand-rolled implementation.
- **Turbo** (`packages/turbo/bin/turbo`) — for signal-handling and JIT-fallback patterns.
- **esbuild** (`npm/esbuild/install.js`) — the postinstall binary-swap script.
- **rolldown** + **oxc** workflows — for the GitHub Actions matrix patterns.

---

## 9. Code signing strategy (revised, npm-first)

| Component | Sign? | Cost | Tool |
|---|---|---|---|
| **CLI on macOS via npm** | No (npm bypasses Gatekeeper) | $0 | — |
| **CLI on Linux via npm** | No (never needed) | $0 | — |
| **CLI on Windows** | N/A for v1 — document `WSL2 + linux-x64 build`; native Windows host is tracked in `FUTURE.md`. | — | — |
| **Daemon on macOS** | **Yes** | $0 (uses Apple Dev cert) | `apple-codesign` from Linux CI |
| **iOS app** | Mandatory | $99/yr Apple Developer | Xcode / Fastlane |
| **Android app** | Mandatory (self-signed) | $0 + $25 one-time Play | gradle signingConfig |
| **GitHub Release tarballs (any)** | Optional | $0 | `cosign` attest for supply-chain integrity (free, from CI) |

**Why daemon needs signing even on npm path:**
- macOS `launchd` is stricter than ad-hoc execution.
- Unsigned daemons trigger "X wants to accept incoming connections" firewall prompts on every restart.
- Once you have the Apple cert for iOS anyway, signing the daemon is a 30-second additional CI step.

**`apple-codesign` (rcodesign) example** (runs on Ubuntu CI):

```yaml
# .github/workflows/release-rust.yml (excerpt)
- name: Install rcodesign
  run: cargo install apple-codesign --locked

- name: Sign daemon
  env:
    P12_BASE64: ${{ secrets.APPLE_P12_BASE64 }}
    P12_PASSWORD: ${{ secrets.APPLE_P12_PASSWORD }}
  run: |
    echo "$P12_BASE64" | base64 -d > cert.p12
    rcodesign sign \
      --p12-file cert.p12 \
      --p12-password "$P12_PASSWORD" \
      --code-signature-flags runtime \
      target/aarch64-apple-darwin/release/fieldworkd

- name: Notarize daemon
  env:
    APP_STORE_KEY_JSON: ${{ secrets.APP_STORE_KEY_JSON }}
  run: |
    echo "$APP_STORE_KEY_JSON" > key.json
    cd target/aarch64-apple-darwin/release
    zip fieldworkd.zip fieldworkd
    rcodesign notary-submit \
      --api-key-path ../../../key.json \
      --wait --staple \
      fieldworkd.zip
```

---

## 10. CI/CD pipeline

### 10.1 GitHub Actions workflows

| Workflow | Trigger | Runs |
|---|---|---|
| `ci.yml` | Every PR + push to main | Rust matrix on macOS-14 + Ubuntu 24.04 (`cargo fmt --check`, `cargo clippy --workspace -- -D warnings`, `cargo nextest run --workspace`, doctests), supply-chain checks (`cargo deny check`, `cargo audit`), workflow YAML parsing, local handoff smoke with mandatory TUI attach, relay OTLP loopback smoke, npm metadata/publish-plan/release-artifact/package dry-runs, Bun optional-dependency install smoke, v1 boundary/static privacy verifiers, site build/check, mobile static lint/Swift parse, and Android debug Kotlin build after UniFFI/native library generation. Native Windows host support is outside v1 and tracked in `FUTURE.md`. |
| `version-packages.yml` | Push to main + manual dispatch | Verify the Changesets fixed group, then run `changesets/action@v1` with pinned `pnpm dlx` Changesets packages to open the version-packages PR without creating a mutable root install. Publishing is intentionally absent here; `release-npm.yml` owns npm provenance publish after signed Rust artifacts exist. |
| `release-rust.yml` | Tag `v*.*.*` (Changesets-managed) | Cross-compile matrix (4 host targets: darwin-arm64, darwin-x64, linux-x64, linux-arm64; native runners + cargo-zigbuild for Linux), fail closed before Darwin toolchain setup/build if macOS signing/notarization secrets are absent, verify provider secret boundaries and telemetry privacy wiring, sign+notarize macOS daemon via rcodesign, upload artifacts to GitHub Releases for audit. **cargo-dist is used only for the build/archive pipeline — its installer/brew-formula generators are explicitly disabled** (we ship via npm only). |
| `release-npm.yml` | After `release-rust.yml` succeeds | Fail closed before artifact download if `NPM_TOKEN` is absent, download artifacts from the completed Rust workflow run, verify archive SHA-256 files plus Sigstore DSSE/SLSA bundles with cosign signature verification, copy into `packages/cli-*/bin/`, verify native binaries, then run `scripts/publish-npm-packages.mjs` (publishes 5 npm packages: 4 platform packages first, meta package last, with npm provenance attestation). After publish, retry `scripts/verify-npm-registry-state.mjs --expect-meta-published --expect-platform-published --expect-latest-version="$version" --expect-provenance` against the public registry to verify all five latest dist-tags and npm SLSA provenance metadata. Manual dispatch can download the same artifact set from an explicit GitHub Release tag and pins the bundle SLSA `releaseTag` to that requested tag before extraction. |
| `release-ios.yml` | Tag `ios-v*.*.*` | macOS-26 runner with Xcode 26+ selected: build xcframework, verify device + simulator slices, verify mobile privacy defaults, store privacy answer sheet, and telemetry privacy wiring, reject provisioning profiles without `app.fieldwork.ios` + production `aps-environment`, archive with manual App Store signing assets from GitHub Secrets, export IPA, upload to TestFlight via altool. |
| `release-android.yml` | Tag `android-v*.*.*` | ubuntu-24 runner: fail closed before toolchain setup and Rust/mobile build when Sentry, Firebase, signing, or Play upload secrets are absent; cargo-ndk matrix per ABI, generate Kotlin bindings, verify telemetry privacy wiring, assembleRelease, verify mobile privacy defaults and store privacy answer sheet, verify AAB ABI contents plus packaged manifest privacy surface and signature, upload AAB to Play Console internal track. |
| `deploy-relay.yml` | Manual dispatch | Fail closed before artifact download if `RELAY_SSH_KEY` is absent or the inventory has no relay hosts; then verify the `linux-arm64` archive SHA-256, Sigstore DSSE/SLSA bundle, requested SLSA `releaseTag`, cosign signature, and extracted `fieldwork-relay` executable; SSH to Oracle A1 instances, deploy new `fieldwork-relay` binary, systemctl restart. |
| `dependabot.yml` | Weekly | Cargo, root npm package metadata, `site/` npm lockfile, Android Gradle, and GitHub Actions version updates. |

### 10.2 Caching strategy

- `Swatinem/rust-cache@v2` on Rust jobs — caches Cargo registry, git deps, and build outputs across macOS/Linux jobs.
- No separate `sccache` layer in v1 CI. The current Rust jobs keep the setup simpler and rely on `rust-cache`; add `sccache` only if CI wall time becomes a measured blocker.
- `actions/setup-node@v4` with `cache: pnpm` is used where dependencies are installed, currently the isolated `site/` package. The root npm/static jobs run repo-owned Node scripts without installing package dependencies.

### 10.3 Test matrix (CI)

```yaml
# ci.yml (excerpt)
strategy:
  fail-fast: false
  matrix:
    include:
      - { os: macos-14,     target: aarch64-apple-darwin,         features: "" }
      - { os: macos-14,     target: x86_64-apple-darwin,          features: "" }
      - { os: ubuntu-24.04, target: x86_64-unknown-linux-gnu,     features: "" }
      - { os: ubuntu-24.04, target: aarch64-unknown-linux-gnu,    features: "" }
      # windows-latest target omitted from v1 (needs named-pipe IPC + Windows service install)
```

### 10.4 Pre-commit

`pre-commit` config (or husky if you go npm-tooling) runs:
- `cargo fmt --check`
- `cargo clippy -- -D warnings`
- `cargo nextest run --workspace --no-fail-fast` (fast subset only locally)

---

## 11. Observability & error reporting

### 11.1 Daemon (privacy-first)

- **Logs**: `tracing-subscriber` writing to a rolling file at `~/Library/Logs/app.fieldwork/daemon.log` (macOS) / `~/.local/state/fieldwork/daemon.log` (Linux). 7-day retention.
- **Traces**: file-only by default. **No daemon remote trace export in v1.**
- **Crashes**: `sentry-rust` with `traces_sample_rate: 0.0` and `send_default_pii=false`. Crashes are de-identified — no session names, no command lines, no cwd in error context.
- **Opt-in toggle**: `fieldwork settings telemetry on` persists daemon telemetry consent in `config.toml`. v1 uses that consent for Sentry crash reporting only; daemon OTLP/Honeycomb export is intentionally absent and the telemetry privacy verifier rejects accidental daemon OTLP/Honeycomb wiring.
- **Consent flow on mobile**: **delayed opt-in**. No consent prompt on first launch (would block the wow-moment of pairing). After the user's first session crosses `AwaitingInput → user responds → agent emits 10+ lines of output` (i.e., they've experienced the value), surface a one-time bottom-sheet prompt: *"Help improve Fieldwork? Crash reports only. No code, prompts, terminal output, or file paths."* Two buttons: `Sure` / `No thanks`. Decline = silent and final; Settings remains available for later changes.

### 11.2 Relay operator observability (server-side, always-on by design)

This is **our operational telemetry on the relay we run** — distinct from the *user's daemon telemetry* (Section 11.1, which is opt-in and never leaves the user's machine without consent).

- **Traces sampled at 1%** to Honeycomb free tier (~20M events/mo headroom). The relay OTLP exporter is configured by `FIELDWORK_RELAY_OTLP_ENDPOINT`, `FIELDWORK_RELAY_OTLP_SAMPLE_RATE` (default `0.01`), optional `FIELDWORK_RELAY_HONEYCOMB_DATASET`, and a relay-only `honeycomb-api-key` systemd credential. Per-trace attrs are aggregate/static only (endpoint, service metadata, platform enum, event-type enum) — **no per-NodeID dimensions**, no per-token data. Source IPs are not attached by Fieldwork and must be scrubbed to /16 prefix at ingestion if a downstream collector/proxy adds them.
- **Metrics**: custom Prometheus text endpoint on `:9090`, scraped from localhost only (iptables).
- **Logs**: stderr → journalctl. Log level `info` and above ship to a free-tier log aggregator (Better Stack or Grafana Loki self-hosted on the same A1 instance). Push tokens, pair tokens, and NodeIDs are explicitly redacted via a `tracing::Layer` sanitizer.

Privacy posture documented in `docs/PRIVACY.md`; self-hostable relay packaging is outside v1 and tracked in `FUTURE.md`.

### 11.3 Mobile (Sentry-only, opt-in)

- `sentry-cocoa` (iOS) and `sentry-android` (Android) initialized in app shell.
- Same Sentry project as Rust crates. Sentry de-dupes by event hash.
- User-toggleable in app Settings and through the delayed one-time consent prompt; off by default. Release builds inject `SENTRY_DSN` at build time, keep `sendDefaultPii=false`, and keep trace sampling at `0.0`.

### 11.4 Privacy in tracing — concrete rules

1. **Span attributes never contain user content**. Use `session_id_hash = blake3(session_id)` not `session_name`.
2. **`tracing::Value` enums for everything user-facing** — easy to grep for, audit.
3. **A dedicated `tracing::Layer` sanitizer** that drops events with `privacy.level = "user_content"` attribute.
4. **No URLs, no paths, no command lines in error reports.** Generic identifiers only.
5. **Document everything collected in `docs/PRIVACY.md`.** Honest about every byte that leaves the device.

---

## 12. License, OSS posture, community

### 12.1 License

**AGPL-3.0-or-later** for the whole project.

```
LICENSE   # full AGPL-3.0 text
NOTICE    # App Store/TestFlight additional permission and project notices
```

In each `Cargo.toml`:
```toml
license = "AGPL-3.0-or-later"
```

In each npm `package.json`:
```json
"license": "AGPL-3.0-or-later"
```

**Why AGPL-3.0 (not Apache+MIT, not plain GPL)**:

- **Use the best code regardless of license when v1 actually adopts it.** AGPL keeps Fieldwork GPL-compatible if a shipped component needs GPL-family code. v1 keeps the terminal transport as raw PTY bytes and does not ship RoSE/mosh predictive echo.
- **Close the cloud-rehosting loophole.** Plain GPL-3.0 lets a cloud vendor fork fieldwork, host the relay as a paid SaaS, and contribute nothing back. AGPL's network-use clause requires anyone running modified fieldwork as a network service to release source. Same approach as Plausible, GlitchTip, Mastodon, Grafana.
- **Indie users self-hosting are unaffected.** AGPL only kicks in when you redistribute or expose-as-service-to-others. A user running their own `fieldworkd` on their Mac for personal use isn't distributing anything.
- **Compatibility**: Apache-2.0, MIT, BSD-3-Clause, and most permissive Rust crate licenses are AGPL-compatible (one-way: they can be combined into AGPL, the combined work is AGPL). Our entire Cargo dependency tree works.
- **App Store distribution**: `NOTICE` grants the Fieldwork maintainers a narrow AGPLv3 section-7 additional permission for unmodified iOS binaries distributed through TestFlight/App Store while preserving source-availability obligations.

**Tradeoff accepted**: some companies refuse AGPL deps in their products. We accept smaller corporate ecosystem reach in exchange for using the best code + protecting against cloud-vendor rehosting.

**Alternatives ruled out**:
- **Apache+MIT**: would forbid adopting GPL-family terminal components in a later compatible release if the project needs them.
- **GPL-3.0 only**: leaves cloud-rehosting loophole open. AGPL closes it for the same effort.
- **BUSL with conversion**: convoluted; designed for VC-backed companies, not indie OSS.

### 12.1.1 What this unlocks (concrete code we can now use)

| Component | License | What we get |
|---|---|---|
| **RoSE** (`nikhiljha/rose`) | GPL-3.0 | Reference only in v1; predictive local echo is not shipped. |
| **mosh** (`mobile-shell/mosh`) | GPL-3.0 | Reference only in v1; SSP adoption is outside the v1 raw-byte contract. |
| **Blink Shell** (`blinksh/blink`) | GPL-3.0 | `SmartKeysController.swift` and related keyboard files — copy directly, adapt naming. Gold-standard iOS terminal keyboard accessory bar that took years to refine. |
| **Termux `terminal-emulator`** | GPL-3.0 | Android fallback if `connectbot/termlib` (Apache-2.0, our primary) isn't ready by week 6. 17 years of Android-specific terminal expertise; runs on millions of devices. Third option after termlib and xterm.js+WebView. |

### 12.2 OSS hygiene

| File | Contents |
|---|---|
| `README.md` | What it is, install (one line: `npm i -g fieldwork`), pair flow, badges |
| `CONTRIBUTING.md` | Build instructions, PR guidelines, design philosophy ("narrow Rust core, native UI", "no telemetry by default") |
| `CODE_OF_CONDUCT.md` | Standard Contributor Covenant v2.1 |
| `SECURITY.md` | How to report security issues (private email + GPG key) |
| `docs/SECURITY.md` | Product security model: trust zones, pairing, storage, relay, push, and mobile biometric gates |
| `docs/PRIVACY.md` | What data is collected, where, why, opt-out instructions |
| `docs/ARCHITECTURE.md` | System diagram, component responsibilities (drawn from this plan) |
| `docs/PROTOCOL.md` | The wire-protocol RFC |
| `docs/RELEASE_AUDIT.md` | Prompt-to-artifact checklist, current local evidence, and remaining external release gates |
| `site/` | Astro source for `fieldwork.dev`: product, install, protocol, architecture, privacy |
| `.github/ISSUE_TEMPLATE/` | bug.yml, feature.yml, question.yml |
| `.github/PULL_REQUEST_TEMPLATE.md` | PR checklist for required local checks, v1 boundaries, and external gates |

### 12.3 Community channels (post-launch)

- **GitHub Discussions** for Q&A and feature requests
- **Discord** for synchronous chat (bigger indie-dev reach in 2026; Zulip considered and rejected — threading is nice but reach matters more at indie scale)
- **GitHub Sponsors** for any donations (single channel, no fragmentation; Open Collective and Patreon explicitly rejected)
- **`fieldwork.dev` website** with docs, install, blog — deploy with **Astro on Cloudflare Pages** (Oranda considered but Astro gives more flexibility for the eventual blog + docs site). Local scaffold exists in `site/`; Cloudflare deployment is blocked until the domain/project credentials exist.
- **Twitter/X account** `@fieldworkdev` for releases and engagement
- **Show HN on launch day** — practice the post 1 week earlier

---

## 13. Production-readiness gates for v1.0

Treat this as a release checklist. v1.0.0 cannot ship until every box is checked.

### 13.1 Code quality
- [x] `cargo clippy -- -D warnings` passes on every crate
- [x] `cargo fmt --check` passes
- [x] `cargo deny check` passes, including advisories, bans, licenses, and sources
- [x] `cargo audit` shows no high/critical CVEs
- [x] All public APIs in `protocol`, `mobile-core` have rustdoc comments — both crates deny `missing_docs`, and the focused `cargo clippy -p fieldwork-protocol -p fieldwork-mobile-core -- -D warnings` pass verifies the gate locally.
- [x] Snapshot tests (`insta`) for all wire-protocol message round-trips
- [x] MessagePack frame round-trip tests for every current client/server protocol message used by the iroh/mobile transport
- [x] Property tests (`proptest`) for the PTY byte-stream ring buffer (replay correctness across chunk boundaries, empty writes, retained-window eviction, and stale-window rejection). The v1 `seq` is a monotonic `u64` byte offset that never wraps; if the impossible-in-practice `u64::MAX` edge is reached, the ring forces cold resync instead of replaying ambiguous byte offsets. `ring::tests::seq_overflow_forces_cold_resync_window` verifies that behavior.

### 13.2 Cross-platform builds
- [x] CLI builds clean on macOS arm64, macOS x86_64, Linux x86_64, Linux arm64 (4 v1 targets; native Windows host is outside v1) — latest local release build pass on 2026-05-19 produced executable `fieldwork` binaries for all four targets.
- [x] Daemon builds clean on same 4 targets — latest local release build pass on 2026-05-19 produced executable `fieldworkd` binaries for all four targets.
- [x] Relay builds for Linux arm64 (Oracle ARM target) — latest local release build pass on 2026-05-19 also produced `fieldwork-relay` for both Linux targets and both Darwin targets.
- [ ] iOS xcframework includes arm64-device, arm64-sim, x86_64-sim — current local Mac has macOS 15.2 and only Command Line Tools selected. Apple's compatibility table makes Xcode 16.3 the newest viable full Xcode for this host; Xcode 16.4 requires macOS 15.3+ and Xcode 26.x requires macOS 15.6+/26.x. Apple App Store Connect uploads now require Xcode 26+ with an iOS 26+ SDK, so `release-ios.yml` uses a `macos-26` runner and `scripts/check-ios-prereqs.sh --release` verifies Xcode/iOS SDK major versions before TestFlight upload. Local prerequisites that do not require Apple credentials are installed/downloaded: `xcodes` 1.6.2, `aria2` 1.37.0_2, `.xcode-version` pins local Xcode `16.3`, the required Rust iOS targets are installed, and the local reference cache has `SwiftTerm` `v1.13.0`, `blink`, and `sentry-cocoa` `9.13.0`. `xcodes update --data-source xcodeReleases` confirms Xcode `16.3 (16E140)` and Xcode 26.x release availability. Generated `target/debug` and Android build intermediates were cleaned while preserving the release AAB, and the latest local audit reports at least 70 GiB free in `~/Downloads`, satisfying the repo script's Xcode download/expansion guard. `apps/ios/scripts/build-rust.sh` now runs `scripts/check-ios-prereqs.sh` before Cargo/Xcode work and switches to `--release` mode when the release-runner Xcode/SDK floor environment is present. When full Xcode is missing, `scripts/check-ios-prereqs.sh` prints concrete recovery steps to authenticate, run `scripts/check-ios-prereqs.sh --download-xcode`, expand or place `Xcode_16.3.xip`, select `/Applications/Xcode-16.3.app/Contents/Developer`, run `sudo xcodebuild -runFirstLaunch`, rerun `pnpm check:ios-prereqs`, and then run `apps/ios/scripts/build-rust.sh`. `scripts/check-ios-prereqs.sh --download-xcode` and direct `xcodes download 16.3 --data-source xcodeReleases` report a missing Apple ID/password or require an authenticated Apple Developer session, direct `curl` against Apple's XIP URL redirects to the unauthorized page, and the existing Chrome session remains blocked by Apple Developer authentication/access; no Xcode `.xip` is present in `~/Downloads`. Direct `fieldwork-mobile-core` iOS target builds now fail at that prereq check because `xcrun --sdk iphoneos`/`iphonesimulator` cannot locate the SDKs without full Xcode selected.
- [x] Android AAB includes arm64-v8a, armeabi-v7a, x86_64 — latest local validation on 2026-05-20 rebuilt the release bundle against current Android source with `apps/android/gradlew --no-daemon bundleRelease` and passed `pnpm check:android-aab` against `apps/android/app/build/outputs/bundle/release/app-release.aab` (`54M`, SHA-256 `8ab0548931a2a6a378d54646bc0d6932bfce941c499d07d1218306bd7e4a7365`). Earlier 2026-05-18 validation rebuilt `apps/android/scripts/build-rust.sh` and regenerated UniFFI Kotlin bindings for `arm64-v8a`, `armeabi-v7a`, and `x86_64`. The AAB verifier now also checks the packaged protobuf manifest uses-permission allowlist and privacy surface for required Firebase/Sentry opt-out metadata, rejects unwanted location, microphone, contacts, media, storage, session-name, command, and terminal-content fields, and enforces the local unsigned AAB state with `--expect-unsigned`; Android Studio's bundled `jarsigner` also reports `jar is unsigned`. Release bundle signing is still blocked by the separate release-keystore gate below.

### 13.3 Signing & distribution
- [ ] Daemon signed and notarized on macOS via rcodesign in CI
- [ ] iOS app signed with Apple Distribution cert, profiled with App Store profile
- [ ] Android AAB signed with release keystore (stored in GitHub Secrets, base64'd)
- [x] Changesets configured with `fixed` group covering all 5 npm packages (1 meta + 4 platform; native Windows host is outside v1)
- [ ] All 5 npm packages publish in correct order (children first, meta last) — local publish-plan verification and `release-npm.yml` enforce this ordering; the same local test verifies missing `NODE_AUTH_TOKEN` fails before `npm` is invoked. The gate remains unchecked until the real npm publish completes with the operator-owned token and platform child publish rights.
- [ ] `npm publish --provenance` enabled (SLSA Level 3 build attestation visible on registry) — `release-npm.yml` now retries `scripts/verify-npm-registry-state.mjs --expect-meta-published --expect-platform-published --expect-latest-version="$version" --expect-provenance` after publish, and `scripts/test-npm-registry-state.mjs` covers version/provenance success and failure locally; this gate remains unchecked until the published registry metadata for all five packages shows SLSA provenance.
- [x] `preferUnplugged: true` set on every per-platform package
- [x] `install.js` postinstall binary-swap verified working on macOS + Linux
- [x] Dispatcher fallback verified for `npm install --omit=optional` users
- [ ] `cosign attest` for supply-chain on GitHub Release artifacts — `release-rust.yml` now writes SHA-256 files and `cosign attest-blob --type slsaprovenance1` Sigstore bundles for every platform archive, while `scripts/verify-release-artifacts.mjs` plus `scripts/test-release-artifacts.mjs` locally verify checksum, Sigstore/DSSE structure, SLSA fields, requested release-tag binding, and release workflow cosign verification wiring. This gate remains unchecked until a real tagged GitHub Release produces bundles that pass `cosign verify-blob-attestation` against the GitHub OIDC issuer, release-rust workflow identity, and Rekor-backed transparency-log material.

### 13.4 Observability & reliability
- [ ] Sentry receives test crashes from daemon, iOS, Android — daemon Sentry is opt-in only and has local test-transport coverage for explicit opt-in, `send_default_pii=false`, `traces_sample_rate=0.0`, invalid DSN handling, and panic capture. Mobile telemetry is off by default, Settings-gated, release-DSN-only, and covered by static/JVM checks. Hosted Sentry receipt remains unchecked until a real Sentry project/DSN and signed daemon/mobile builds are available.
- [ ] Honeycomb receives test traces from relay — relay OTLP/Honeycomb export is wired with 1% default sampling, aggregate/static fields only, relay-only credential loading, and local loopback coverage via `pnpm test:relay-otlp`; the live Honeycomb receipt gate remains unchecked until a Honeycomb account/API key and hosted relay test traces are available.
- [ ] Daemon survives `pkill -KILL fieldworkd` and restarts via launchd/systemd — local unit coverage now verifies the actual `service-manager` rendered LaunchAgent uses `KeepAlive` with `SuccessfulExit=false`, the rendered systemd user unit uses `Restart=on-failure`/`RestartSec=5` through fake `launchctl`/`systemctl`, and a fresh service install is rolled back if service start fails; the real survival gate still requires a signed/notarized macOS daemon or an actual Linux user-service host.
- [ ] Daemon survives `sleep 30 && wake` on macOS (lid close) — daemon install/restart and service-manager contracts are locally verified, but real macOS sleep/wake survival remains unchecked until it can be run against the signed/notarized daemon artifact on a Mac with launchd managing the installed service.
- [ ] iOS app survives `Background → Foreground` with active session (reconnects)
- [ ] Android app survives same — `pnpm test:android-emulator-background-replay` is the local debug-app substitute: it pairs the actual Android app to an isolated release daemon, opens a desktop-created terminal, sends input before backgrounding, backgrounds the app while the PTY emits `ANDROID_BACKGROUND_REPLAY_OUTPUT`, foregrounds back to the attached terminal, sends `after_background_ok`, and uses a separately approved verifier to confirm the background-emitted output plus post-foreground input remain replayable. Latest local run on 2026-05-19 passed on `emulator-5554`. Physical release-device background/foreground evidence remains required before checking this gate.
- [ ] Push notifications fire reliably for `AwaitingInput` state changes (10/10 in manual test) — local daemon push worker, relay payload/privacy validation, APNs/FCM provider-client error handling, token ownership, stale-token pruning, Android token registration, and Android notification tap routing are covered by unit/JVM/emulator smokes. This remains unchecked until real APNs/FCM provider delivery is exercised 10/10 on physical devices with relay-held provider credentials.

### 13.5 Documentation
- [x] `README.md` has install + pair flow + screenshots (single install command: `npm i -g fieldwork`)
- [x] `docs/INSTALL.md` covers npm (primary), build-from-source (`cargo build --release`)
- [x] `docs/PROTOCOL.md` is current with v1 wire protocol
- [x] `docs/PRIVACY.md` lists every byte collected
- [x] `docs/DEVELOPMENT.md` lets a contributor build from source in <15 min
- [x] Inline Rust docs on all public types

### 13.6 Legal & meta
- [x] Single `LICENSE` file with AGPL-3.0-or-later text at root
- [x] All Cargo.toml have `license`, `repository`, `description`
- [x] CONTRIBUTING.md, CODE_OF_CONDUCT.md, SECURITY.md in place
- [ ] App Store privacy nutrition labels filled out — answer sheet is prepared in `docs/STORE_PRIVACY.md` and locally synchronized by `scripts/verify-store-privacy.mjs`; actual App Store Connect submission is still blocked by Apple account access and signed release-build verification.
- [ ] Play Console data safety form filled out — answer sheet is prepared in `docs/STORE_PRIVACY.md` and locally synchronized by `scripts/verify-store-privacy.mjs`; actual Play Console submission is still blocked by Play account access and signed release-build verification.
- [x] OSS license disclosure screen in both apps — generated from `docs/open-source-notices.json` by `scripts/generate-oss-notices.mjs`; iOS Settings and Android Settings both route to native notice screens.

### 13.7 Performance (must measure, not guess)
- [ ] Terminal renders `yes | head -10000` without dropped output on iOS + Android — local mobile-core stress coverage verifies delivery of a `yes | head -10000`-scale byte stream without dropped bytes or offset drift. `pnpm test:android-emulator-flood` is now a local Android renderer substitute: it pairs the actual Android app to an isolated release daemon, opens a desktop-created terminal, renders a `yes | head -10000`-scale stream in the actual Android terminal view, verifies a nonblank flood screenshot, and uses a separately approved verifier client to confirm replayed terminal bytes contain `ANDROID_EMULATOR_FLOOD` output; latest default aggregate run on the API 36.1 emulator reported 8440/14400 nonblack screenshot samples. This still needs physical iOS/Android renderer verification before the release gate can be checked.
- [x] Cold start of CLI: <50ms (after `install.js` binary-swap; ~80ms via dispatcher fallback acceptable)
- [x] Cold start of daemon: <200ms
- [ ] iOS app cold start: <800ms
- [ ] Android app cold start: <1200ms — current local API 36.1 emulator evidence is debug-only, not release-device evidence. A 2026-05-19 direct adb emulator QA refresh installed the default debug APK, launched with `Status: ok` and `TotalTime=5297ms`, captured `/tmp/fieldwork-adb-direct-20260519225027/default.png`, `/tmp/fieldwork-adb-direct-20260519225027/default-ui.xml`, `/tmp/fieldwork-adb-direct-20260519225027/default-logcat.log`, and an empty `/tmp/fieldwork-adb-direct-20260519225027/default-crash.log`, and verified the locked `Unlock` surface. The same direct adb run rebuilt the debug APK with `FIELDWORK_ANDROID_BIOMETRIC_BYPASS=true` plus debug-only `FIELDWORK_ANDROID_PAIRING_PAYLOAD`, launched the pair build in `TotalTime=4589ms`, tapped the UI-tree-derived Pair center `540 1860`, paired through explicit desktop approval in `pair_flow_ms=1043`, verified `bash · fieldwork`/`ANDROID_ADB_DIRECT_READY`, attached the terminal, sent `fw_android_direct_ok`, captured `/tmp/fieldwork-adb-direct-pair-20260519225208/before-pair.png`, `/tmp/fieldwork-adb-direct-pair-20260519225208/sessions.png`, `/tmp/fieldwork-adb-direct-pair-20260519225208/terminal-before-input.png`, `/tmp/fieldwork-adb-direct-pair-20260519225208/terminal-after-input.png`, UI XML, logcat, and an empty crash buffer, and confirmed a separately approved verifier client saw `android-direct: fw_android_direct_ok` in replayed terminal bytes. Afterward the default debug APK was rebuilt and reinstalled, `BuildConfig.java` restored `FIELDWORK_BIOMETRIC_BYPASS = false` plus `FIELDWORK_DEBUG_PAIRING_PAYLOAD = ""`, the restored default build launched in `TotalTime=5105ms`, `/tmp/fieldwork-adb-direct-restore-20260519225316/restored-locked.png` plus `/tmp/fieldwork-adb-direct-restore-20260519225316/restored-ui.xml` verified the locked `Unlock` surface again, and the restored crash buffer remained empty. A 2026-05-20 follow-up direct adb pass paired through explicit desktop approval, attached the session, sent `android_adb_direct_ping`, verified `android-direct: android_adb_direct_ping` in `/tmp/fieldwork-adb-direct-pair-20260519235638/terminal-after-input.png` and PTY output, then installed a biometric-bypass build with empty `FIELDWORK_DEBUG_PAIRING_PAYLOAD`; the paired-data relaunch restored the sessions dashboard in `TotalTime=6225ms`, captured `/tmp/fieldwork-adb-direct-pair-20260519235638/relaunch-restore-fix-sessions.png`, and filtered logcat showed `FieldworkRepository: listSessions returned 1 sessions` with no `Camera`/`CAMERA`, Fieldwork `FATAL`, or ANR entries after the saved-pairing restore placeholder fix. A later 2026-05-20 raw adb pass installed the default debug APK, launched the locked app in `TotalTime=6766ms`, captured `/tmp/fieldwork-adb-direct-20260520001909/default-locked.png` and UI/logcat/crash-buffer files, rebuilt with `FIELDWORK_ANDROID_BIOMETRIC_BYPASS=true` plus debug-only `FIELDWORK_ANDROID_PAIRING_PAYLOAD`, paired through explicit desktop approval, granted the runtime notification prompt, verified the dashboard listed `bash · fieldwork` with `ANDROID_ADB_MANUAL_READY`, attached the terminal, sent `android_adb_manual_ok` via `adb shell input text` plus Enter, and captured `/tmp/fieldwork-adb-direct-20260520001909/terminal-after-input.png` showing `android-direct: android_adb_manual_ok`. The app logcat showed `FieldworkRepository: pair completed` and `listSessions returned 1 sessions`, crash buffers were empty, and the final restored default debug build had `FIELDWORK_BIOMETRIC_BYPASS = false`, `FIELDWORK_DEBUG_PAIRING_PAYLOAD = ""`, launched in `TotalTime=1371ms`, and showed the locked `Unlock` surface at `/tmp/fieldwork-adb-direct-20260520001909/default-restore-locked.png`. AVDs without enrolled biometrics can use the debug-build-only biometric bypass guarded by `BuildConfig.DEBUG`; release builds hardcode the bypass off. Physical release-device cold-start evidence is still required before checking this gate; the Play Store emulator image still emits background Google-service ANRs, so it is not a substitute for the release-device threshold.
  A 2026-05-20 direct locked-launch refresh on a freshly booted `Medium_Phone_API_36.1` emulator installed the default debug APK, launched with `Status: ok`, `LaunchState: COLD`, and `TotalTime=1919ms`, captured `/tmp/fieldwork-adb-direct-20260520092447/default-locked.png`, `/tmp/fieldwork-adb-direct-20260520092447/default-ui.xml`, `/tmp/fieldwork-adb-direct-20260520092447/default-logcat.log`, `/tmp/fieldwork-adb-direct-20260520092447/default-app-pid-logcat.log`, and an empty `/tmp/fieldwork-adb-direct-20260520092447/default-crash.log`, verified a 1080x2400 screenshot plus `text="Unlock"` in the UI dump, and found no Fieldwork `FATAL EXCEPTION` or ANR log entries.
- [ ] Reconnect after network change: <2s — local handoff smoke now detaches the simulated iroh phone while a PTY emits missed output, reconnects with `last_seen_seq`, and verifies replay arrives through `Attached.initial_bytes` within 2 seconds. Android source now also records the latest mobile `lastSeenSeq`, destroys the broken attachment, and reattaches/restarts the byte subscription after an attached-stream error; focused Android JVM coverage verifies the reattach starts from the latest offset. `pnpm test:android-emulator-reconnect` is the local Android-app substitute: it pairs the actual Android app to an isolated release daemon, opens a desktop-created terminal, sends input before and after an emulator airplane-mode network cut, confirms the desktop PTY receives post-restore input, and uses a separately approved verifier client to confirm output emitted during the network gap remains replayable. Physical-device timing remains required before checking the gate.
- [ ] Pair flow end-to-end: <15s including QR scan and desktop confirmation prompt — the hidden local handoff simulator still covers QR payload → iroh pair-test → desktop approval within 15 seconds. `pnpm test:android-emulator-pair` now also measures the actual Android debug-app pairing path from tapping the debug-injected Pair button through explicit desktop approval completion and fails above the local 15-second emulator bound; latest default aggregate run passed on `emulator-5554` with `pair_flow_ms=2234`. A 2026-05-20 direct adb source-build `fw` shim pass, without wrapper smoke scripts, created desktop sessions through bare `fw`, `fw refactoringjob`, and `fw new --name shell`, then paired the Android debug app through explicit desktop approval in `pair_flow_ms=423`; evidence includes `/tmp/fieldwork-fw-direct-pair-20260520152507/dashboard.png`, `/tmp/fieldwork-fw-direct-pair-20260520152507/after-pair.xml`, `/tmp/fieldwork-fw-direct-pair-20260520152507/dashboard-logcat.log`, and an empty `/tmp/fieldwork-fw-direct-pair-20260520152507/dashboard-crash.log`. This substitutes for the app-side timing path until physical camera QR scan timing is available.

### 13.8 Security (must verify, not assume)
- [x] **Pairing requires explicit desktop confirmation** — phone-scanned QR alone doesn't grant access; desktop CLI prompts `y/N`
- [x] **Pair token single-use** — verified by attempting reuse and expecting `Error{Forbidden}`
- [ ] **Face ID / BiometricPrompt required** on mobile app launch and after 5min background — local code now renders only a locked surface while unauthenticated, prompts on stale foreground, activates paired session fetch/subscription/push registration only after successful unlock, and gates terminal input before sending bytes. iOS uses the biometric-only LocalAuthentication policy rather than passcode fallback; Android uses `BIOMETRIC_STRONG` BiometricPrompt rather than device-credential fallback. Android emulator QA has an explicit `FIELDWORK_ANDROID_BIOMETRIC_BYPASS=true` path only for debug builds without enrolled biometrics; the runtime check requires `BuildConfig.DEBUG`, release builds hardcode the bypass off, and unit/static checks pin those guards. Android Kotlin compilation passes, and focused Android JVM tests now verify locked terminal input is refused before it reaches mobile-core plus latest-`lastSeenSeq` `Lag` and attached-stream-error reattach; refreshed FCM tokens are queued in backup-excluded app-private storage and sent/cleared only by the paired-and-unlocked sync path. iOS Swift parse passes for every app/core/features/UI source file through package-import guarded fallbacks. Physical-device biometric verification remains required before checking this gate.
- [ ] **Push notification payload contains no terminal content** — relay validators and provider-client tests assert fixed alert copy, lowercase hash-only data fields, and rejection of `last_line`, command, path, session-name, and free-text payloads; mobile notification ingress mirrors the same hash-only contract. The gate remains unchecked until an actual APNs/FCM payload is inspected in transit with a test device.
- [x] **Lock-screen body is generic by default** ("A session is waiting for you", not the session name)
- [x] **Daemon rejects `CreateSession`/`KillSession` from non-CLI clients** — automated tests cover the bincode IPC handler with `IosApp` and `AndroidApp` clients sending `CreateSession`, `KillSession`, and `AgentStateEvent` and expecting `Error{Forbidden}`; the local handoff smoke also verifies the paired iroh mobile simulator is forbidden from those operations over the mobile transport.
- [x] **Unix socket has `0600` perms** — automated test verifies `stat` output
- [x] **Unix socket parent dir is not a symlink** at daemon startup — defensive check before bind
- [x] **Scrollback/device registry encrypted at rest** with XChaCha20-Poly1305 + Keychain/Secret-Service-held key (or user explicitly opted out via `fieldwork settings scrollback-encryption off`); device rows use hashed keys so raw device node IDs and push tokens live only inside encrypted payloads; the local persistence parent is forced to `0700`, database files are forced to `0600`, and symlinked persistence directories/database files are rejected.
- [x] **Device revocation works** — `fieldwork devices remove <name>` causes the named iroh device identity to receive `Error{Unauthorized}` on next connect attempt. Verified locally with the hidden phone simulator reusing `--secret-key-path`; physical-phone verification remains covered by the pre-tag smoke tests.
- [x] **APNs `.p8` + FCM service-account JSON live ONLY on relay** — `scripts/verify-secret-boundaries.mjs` rejects provider credential wiring in CLI, daemon, mobile-core, iOS, Android, and npm package sources/config templates, and scans built non-relay `fieldwork`, `fieldworkd`, and `fieldwork_mobile_core` artifacts when present. `release-rust.yml` runs it after release binaries are built.
- [x] **Relay `/v1/push` rejects payloads containing free-text strings** via `garde` extractor validation
- [x] **Daemon auto-update via npm only** — no `self_update` code path exists; CLI prints update notice but does not download
- [x] **All Fieldwork-owned TLS clients use OS trust** — verified by `cargo tree | grep rustls-platform-verifier` showing the verifier enabled for iroh/Reqwest paths, by `cargo tree -e features -i rustls-native-certs` showing relay OTLP on OpenTelemetry's `reqwest-rustls` native-root path, and by auditing that Fieldwork code does not construct webpki-only TLS clients. Note: `iroh 1.0.0-rc.0` and the relay ACME stack still declare `webpki-roots` internally, so `cargo tree | grep webpki-roots` is no longer a valid binary gate for this dependency version.

### 13.9 Smoke tests (run before every tag)
- [ ] Pair a fresh phone to a fresh daemon, see sessions list — local substitutes cover the app-side path: `pnpm test:android-emulator-pair` pairs the Android debug app to an isolated release daemon through the debug-only QR payload path, and the latest direct adb pair/attach pass paired the actual Android app through explicit desktop approval, listed `bash · fieldwork`, attached the terminal, sent `fw_android_direct_ok`/`android_adb_direct_ping`/`android_adb_manual_ok`, and verified the PTY replay through screenshots, logcat, and PTY-side output. A direct adb source-build `fw` shim pass also verified the first-live-test dashboard path: `fw ls` listed auto-named `kazoo`, `refactoringjob`, and `shell`; Android dashboard XML and screenshot at `/tmp/fieldwork-fw-direct-pair-20260520152507/after-pair.xml` and `/tmp/fieldwork-fw-direct-pair-20260520152507/dashboard.png` showed the same three sessions with no `No sessions` state; app logcat showed `FieldworkRepository: pair completed` and `FieldworkRepository: listSessions returned 3 sessions`; and `/tmp/fieldwork-fw-direct-pair-20260520152507/dashboard-crash.log` was empty. Physical-phone QR scan evidence remains required before checking this gate.
- [ ] **Create session from desktop CLI** (`fieldwork new --dir ~/projects claude`), watch it appear in the phone's session list within 2 seconds (over iroh subscription), tap in, type, see output. Mobile cannot create sessions per Section 6.4 — this smoke test exercises the desktop-creates / phone-attaches flow. The hidden local handoff simulator covers the 2-second subscription path; `pnpm test:android-emulator-session-subscription` is the actual Android-app local substitute that pairs with no pre-existing sessions, creates `fw_subscribe_session` from the desktop CLI, verifies the subscribed dashboard receives it within the local 8-second emulator bound, opens it, sends `subscription_attach_ok`, and confirms the PTY receives that Android-originated input. Latest default aggregate run passed on `emulator-5554` with `visible_ms=3318`. Physical-phone QR scan and 2-second release-device timing remain required before checking this gate.
- [ ] Tap notification → opens correct session — `pnpm test:android-emulator-notification-tap` is the local Android substitute: it computes a real desktop session's lowercase `session_id_hash`, rejects an uppercase invalid hash, launches the same hash-only activity intent used by notification taps, opens the target terminal through the debug-only biometric bypass, and verifies `notify_tap_ok` lands only in the target PTY. Real provider notification delivery, lock-screen tap-through, and physical-device routing remain required before checking this gate.
- [ ] Kill daemon, restart, sessions list shows last-known sessions (scrollback restored, processes died — documented) — the hidden local handoff simulator verifies desktop restore. `pnpm test:android-emulator-restart-restore` is the actual Android-app local substitute: it pairs the debug app with an isolated release daemon, creates an intentionally completed `fw_restart_session` so the daemon persists `ANDROID_RESTART_SCROLLBACK` through the session-exit path, restarts the daemon with the same persisted state and node identity, relaunches the app from saved pairing, verifies the restored dashboard still shows `fw_restart_session`, opens the restored terminal, and uses a separately approved verifier to confirm `ANDROID_RESTART_SCROLLBACK` is replayed from restored scrollback. The repeatable smoke passed on `emulator-5554` on 2026-05-19 after the ViewModel main-thread fix. Direct adb restart-restore evidence on 2026-05-19 captured the paired dashboard and logcat before/after a daemon restart, exposed an Android `ANR in app.fieldwork.android` when refresh performed mobile-core session listing on the main thread, then passed after `FieldworkViewModel` moved repository calls to `Dispatchers.IO`: screenshots showed `fw_restart_session` on the restored dashboard before and after refresh, logcat showed `FieldworkRepository: listSessions returned 1 sessions`, and no Fieldwork `FATAL EXCEPTION` or ANR remained.
- [ ] Run 3 sessions in parallel, switch between them on phone, no state leakage — the hidden local handoff smoke verifies switched simulated-phone sessions do not receive each other's output markers, and `pnpm test:android-emulator-multisession` is the actual Android-app substitute: it opens `fwm_a`, `fwm_b`, and `fwm_c`, switches among all three in the app, sends Android-originated input to each, and verifies `multi_a_ok`, `multi_b_ok`, and `multi_c_ok` land only in their selected PTYs. Physical-device switching remains required before checking this gate.

**Local substitute note (2026-05-20)**: `scripts/smoke-local-handoff.sh`
passes against the hidden iroh phone simulator on this machine and now preserves
host `CARGO_HOME`/`RUSTUP_HOME` while isolating Fieldwork's temp `HOME`, config,
state, and runtime directories. Latest `pnpm check:local-release --
--with-runtime` run paired in 3 seconds, created default `claude`, `bash`,
`vim`, explicitly named `FW_SUBSCRIBE_SESSION_READY` and `FW_RECONNECT_READY`
desktop sessions, observed the subscribed session from the simulated phone, sent
mobile-originated input to `bash`, `claude`, and the subscribed session,
replayed missed output after a simulated iroh reconnect within 2 seconds (13ms
in the latest local run), attached to the TUI session, verified no
cross-session output leakage, rejected mobile
`CreateSession`/`KillSession`/`AgentStateEvent`, rejected a revoked device
identity, and restored last-known sessions after daemon restart. The unchecked
boxes above remain release gates because they require real phone QR scanning,
native terminal rendering, push tap-through, and physical-device app behavior.
The smoke honors `CARGO_TARGET_DIR`, so local verification can run against
`/tmp/fieldwork-target-checks` without recreating repo-local `target/debug`.
`pnpm test:android-emulator-notification-tap` is the actual Android-app local
substitute for the notification tap-through routing gate: it pairs the debug app
through the debug-only QR payload path, computes a real desktop session's
lowercase `session_id_hash`, verifies an uppercase invalid hash does not route,
launches the same hash-only activity intent that notification taps use, opens
the target terminal through the debug-only biometric bypass, and verifies
`notify_tap_ok` lands only in the target PTY. Latest local run on 2026-05-19
passed on `emulator-5554`. Real APNs/FCM delivery and
physical lock-screen tap-through remain release gates.
`pnpm test:android-emulator-multisession` is the actual Android-app local
substitute for the three-session phone switching gate: it pairs the debug app
through the same debug-only QR payload path, opens three desktop-created
sessions (`fwm_a`, `fwm_b`, `fwm_c`), switches among all three in the app, sends
Android-originated input to each, and verifies host-side per-session logs so
`multi_a_ok`, `multi_b_ok`, and `multi_c_ok` land only in their selected PTYs.
Latest local run on 2026-05-19 passed on `emulator-5554`.

`pnpm test:android-emulator-session-subscription` is the actual Android-app
local substitute for the desktop-create/session-list subscription gate: it pairs
with no pre-existing sessions, observes the empty dashboard, creates
`fw_subscribe_session` from the desktop CLI, verifies the subscribed dashboard
receives it within the local 8-second emulator bound, opens it, sends
`subscription_attach_ok`, and confirms the PTY receives that Android-originated
input. Latest default aggregate run passed on `emulator-5554` with
`visible_ms=3318`.

`pnpm test:android-emulator-restart-restore` is the actual Android-app local
substitute for the daemon-restart restore gate: it pairs the debug app with an
isolated release daemon, creates `fw_restart_session`, waits for
`ANDROID_RESTART_SCROLLBACK` to persist through the session-exit path, restarts
the daemon with the same temp state and deterministic node identity, relaunches
the app from saved pairing, verifies the restored dashboard still lists
`fw_restart_session`, opens the restored terminal, and confirms
`ANDROID_RESTART_SCROLLBACK` is replayed through a separately approved verifier.
Latest local run on 2026-05-19 passed on `emulator-5554`.

---

## 14. The 10-week build plan (solo, full-time)

Each week ends with a demoable deliverable. Daily breakdown for the first 2 weeks; weekly thereafter.

### Week 1 — Daemon foundation
**Goal**: `fieldworkd` spawns an arbitrary PTY (defaults to `claude`, but `bash` and `vim` must work too for the smoke test) and one local terminal can attach via Unix socket.

- **Day 1**: `git init`, set up Cargo workspace, write `protocol` crate skeleton (message types, version constant), `cargo nextest` running.
- **Day 2**: `daemon::session` PTY spawning — wire up `portable-pty` + `wezterm-term`. `wezterm-term` is used for state inference and synthetic ANSI cold/stale attach snapshots (parse ANSI escape sequences to detect prompt patterns, extract sanitized `last_line`, and reconstruct visible terminal state when byte replay is stale). Raw PTY bytes are captured separately for streaming.
- **Day 3**: `daemon::session` — PTY byte ring buffer (256 KB), `seq` counter, per-subscriber broadcast channel of byte chunks. Unit tests for replay-by-seq correctness.
- **Day 4**: `daemon::ipc` — `interprocess` Unix socket server, length-prefixed bincode, `Hello` / `Welcome` round-trip working.
- **Day 5**: `cli::commands::attach` — local raw terminal pass-through client that connects to daemon over Unix socket, sends `AttachSession`, writes `initial_bytes` then streamed `Output { bytes }` directly to stdout in raw mode, and forwards stdin bytes back to the PTY. **End-of-week demo**: open two terminals on your Mac, both `fieldwork attach claude`, type in one, see it appear in the other.

### Week 2 — Multi-session + persistence + state inference
**Goal**: daemon manages N sessions, persists scrollback, infers agent state.

- **Day 1**: `daemon::ipc` session registry — `DashMap<SessionId, Arc<Session>>`. `ListSessions` and `CreateSession` working over Unix socket.
- **Day 2**: `cli::commands::{ls,new,kill}` — full session lifecycle from CLI.
- **Day 3**: `daemon::persistence` — dump scrollback to redb every 30s. Restore on `AttachSession` for dead sessions.
- **Day 4**: `daemon::state_infer` — dispatch table + byte-rate baseline (covers all non-agent commands), `state_infer::claude` module (prompt regex + Stop-hook listener on the Unix socket), `state_infer::codex` module (structured Codex event adapter; see Section 7.1 note about the current Codex CLI command surface). `AgentStateChanged` events flowing to clients. Unit tests with redacted Claude transcript and Codex event fixtures in `crates/daemon/tests/fixtures/`; authenticated live fixture capture remains a release verification task because real agent sessions require user accounts and may contain private workspace content.
- **Day 5**: `daemon::config` (figment) + `daemon::logging` (tracing → file). Service install via service-manager (`fieldwork daemon install` writes a `~/Library/LaunchAgents/app.fieldwork.daemon.plist` on macOS, `~/.config/systemd/user/fieldworkd.service` on Linux). **Daemon survives terminal close, lid close, and sleep — but NOT logout.** (Surviving logout requires a LaunchDaemon at the system level which contradicts "never root"; that is not a v1 requirement.) **Demo**: `fieldwork daemon install`, `fieldwork new claude`, close terminal, run errand for an hour, return, `fieldwork ls` still shows the session running.

### Week 3 — iroh transport + pairing
**Goal**: daemon accepts connections from an iroh endpoint; QR pairing flow works.

- iroh `Endpoint` set up on daemon side.
- Development or Fieldwork-hosted relay selection is configurable with `FIELDWORK_IROH_RELAY_URL`; when unset, the daemon uses iroh's default relay map. The Fieldwork relay scaffold is implemented locally; hosted DNS, Oracle hosts, and credentials remain release gates.
- `daemon::transport_iroh` — same protocol as Unix socket, just different transport.
- `cli::commands::pair` — generates a `PairingPayload { relay_url, node_id, pair_token }`, prints as QR via `qrcode` crate.
- A hidden Rust test client, `fieldwork pair-test`, takes the QR payload as `--payload` or stdin and round-trips `ListSessions` and optional `AttachSession` over iroh.
- Mutual auth: pair token + Ed25519 pubkey exchange; after desktop approval, the long-lived device identity is stored in encrypted `devices.redb` under a hashed device row key.
- **Demo**: run the test client on a Linux VM elsewhere on the internet, list and attach to sessions on your Mac.

### Week 4 — Rust mobile-core (UniFFI)
**Goal**: `mobile-core` crate exposes the public API to Swift and Kotlin.

- Set up `mobile-core` Cargo.toml: `crate-type = ["lib", "cdylib", "staticlib"]`, `uniffi 0.31.1`, `tokio` feature.
- Port the Litter `apps/ios/scripts/build-rust.sh` to your project. Verify xcframework builds for arm64-device + arm64-sim + x86_64-sim.
- `cargo-ndk` matrix build verifies Android `.so` for 3 ABIs.
- Public surface: `FieldworkClient`, `AttachedSession`, `SessionListSink`, `ByteStreamSink`, `FieldworkError`.
- Inside: thin wrapper around the same iroh client logic from week 3.
- Generate Swift + Kotlin bindings via library-mode bindgen.
- Run UniFFI's own foreign-language test suites against the generated bindings.
- **Demo**: in a Swift Playground / Kotlin REPL, import the generated bindings and call `listSessions()` against the daemon running on the Mac.

**Implementation note (2026-05-19)**: `scripts/verify-uniffi-bindings.mjs` now pins the generated mobile binding contract locally. It verifies `fieldwork-mobile-core` builds as `lib`/`cdylib`/`staticlib`, retains the `uniffi-bindgen` binary and `uniffi::setup_scaffolding!()`, checks the generated Android Kotlin binding for `FieldworkClient`, `AttachedSession`, `SessionListSink`, `ByteStreamSink`, `FieldworkError`, pair/list/subscribe/attach/input/resize/detach/register-push-token methods, rejects generated mobile create/kill/session-command APIs, verifies Android Gradle consumes `apps/android/generated`, and verifies the Android/iOS Rust build scripts plus Xcode generated Swift/xcframework references. CI runs it immediately after `apps/android/scripts/build-rust.sh`. Full Swift generated-binding execution is still blocked until full Xcode/iOS SDKs are available.

### Week 5 — iOS app v0 (SwiftUI)
**Goal**: iOS app pairs with daemon and renders the sessions list + terminal view.

- Xcode project, add the xcframework as a binary dependency.
- App skeleton: tabbed `SessionsListView` + `SettingsView`.
- Pairing flow: camera scanner (`AVCaptureSession`), QR decode, call `client.pairWithQr()`.
- Sessions list: subscribes via `SessionListSink`, renders cards with name/status/preview.
- Terminal view: SwiftTerm wrapped in `UIViewRepresentable`. Subscribe to `ByteStreamSink`; on each `on_output(bytes)`, call `swiftTermView.feed(byteArray: bytes)`. SwiftTerm maintains the cell-grid state internally. Send input via `attachedSession.sendInput()`.
- Face ID required after 5min background (per Section 7.5 security rules).
- Keyboard accessory bar v0: Esc / Ctrl / Tab / | / / / arrows.
- **Demo**: iPhone in your hand, pair with Mac daemon, scroll list, tap a session, type, watch Claude Code respond.

### Week 5.5 — Android termlib spike (hard gate)
**Goal**: decide Android terminal renderer before Week 6 implementation begins. Per Section 7.6 decision rules.

- 1-day spike of `connectbot/termlib` in a throwaway Compose project.
- 30-min dogfood: pair with daemon, attach to live `claude` session, type, scroll, resize, paste.
- **Gate**: pass = use termlib in Week 6. Fail (>2 blocking issues) = use Termux's `terminal-emulator` (GPL-3.0) in Week 6. xterm.js+WebView used **only** if both above fail.

### Week 6 — Android app v0 (Compose)
**Goal**: feature parity with iOS, on Android, using whichever renderer survived the Week-5.5 gate.

- Android Studio project, link the AAR.
- Compose skeleton: bottom-nav `SessionsList` + `Settings`.
- Pairing: CameraX QR scanner.
- Sessions list: `LazyColumn` of cards.
- Terminal view: based on Week-5.5 gate result — **default: connectbot/termlib** (Compose-native, libvterm-backed); fallback: Termux's `terminal-emulator` (port to Compose wrapper); last resort: WebView+xterm.js. All consume the same `ByteStreamSink` from mobile-core — `on_output(bytes)` → `vterm_input_write(bytes)` / `term.write(bytes)`.
- BiometricPrompt required after 5min background (Android equivalent of Face ID rule).
- Keyboard accessory bar v0 in Compose (intercepts keystrokes before WebView IME quirks bite, if WebView path is used).
- **Demo**: Android phone pairing + attaching + typing.

### Week 7 — Push gateway + reconnect-with-replay polish
**Goal**: push works on both platforms via the relay-mediated gateway; sessions survive backgrounding.

- APNs + FCM token registration. Tokens sent to daemon via `RegisterPushToken { platform, token }`.
- Daemon POSTs to relay's `/v1/push` endpoint on `AwaitingInput` state change. **Daemon never holds APNs `.p8` or FCM service-account credentials — only the relay does.**
- Relay signs APNs JWT with **ES256** (ECDSA P-256, per Apple's APNs provider auth spec). It constructs a persistent APNs HTTP/2 provider client at relay startup; the network connection is opened lazily on first dispatch, then retained and reused with keepalive pings. APNs `"BadDeviceToken"` responses and FCM `"UNREGISTERED"` errors are treated as stale-token signals: the relay deletes the token binding from memory and SQLite, then reports a provider error to the daemon. FCM uses HTTP v1 with cached OAuth2 access token (1-hour TTL).
- Provider push payload contains ONLY `{session_id_hash, session_name_hash, event_type}` with lowercase 64-character hex hashes. No terminal content. Native notification UI uses fixed generic copy, native tap routing exposes only `session_id_hash`, and the phone fetches `last_line` over iroh on open.
- iOS: tap notification → Face ID prompt → validate and resolve lowercase 64-character hex `session_id_hash` locally → deep link to that session (`UNNotificationCenter` delegate).
- Android: tap FCM notification → BiometricPrompt → validate and resolve the single lowercase 64-character hex `session_id_hash` intent extra locally → deep link to that session.
- Test the reconnect-with-replay path: kill iOS app, agent emits 50 lines, reopen app, sees the missed output via `Attached { initial_bytes }`.
- Test `broadcast::Sender` lag: flood with `yes | head -100000`, verify clients receive one terminal `Lag { skipped_bytes }` containing the skipped broadcast-message count and resync cleanly.
- Test device revocation: pair, then `fieldwork devices remove <name>` on desktop, verify phone gets `Error{Unauthorized}` on next connect attempt and prompts for re-pairing.
- **Demo**: pair, attach, background app, run a long-running Claude Code task, get a push when it's done (generic body), tap to see result (full content fetched over iroh after Face ID).

**Implementation note (2026-05-17)**: the local push gateway path is now implemented and tested through provider-specific request construction with mock provider endpoints. `fieldwork-relay` exposes `/v1/version`, `/v1/pair`, `/v1/push/register-token`, `/v1/push/unregister-token`, and `/v1/push`; it validates request schemas with `garde`, validates session hashes as lowercase 64-character hex strings, rejects unknown content fields, verifies Ed25519 daemon signatures, enforces token ownership, rejects nonce replay and timestamp skew, applies a per-daemon `moka` TTL rate limit, and emits only generic fixed-copy push deliveries. Production relay builds do not retain accepted delivery records after provider dispatch; the in-memory delivered-push list and its metric are compiled only for tests. `/v1/version` returns relay version, minimum client versions, and `CONTRACT_VERSION` from the protocol crate through a cached response. `fieldworkd` enables this path when `FIELDWORK_RELAY_CONTROL_URL` is set: it stores a relay-signing key in the OS keychain, registers the daemon public key, signs token registration/unregistration, and posts hashed `AwaitingInput` events. Daemon relay HTTP operations now retry transport failures and temporary relay responses with `backon` exponential backoff for a bounded 60-second budget; signed retries regenerate nonce and timestamp so relay replay defense remains strict. The relay persists daemon public keys, push-token ownership, and recent replay nonces in SQLite through `FIELDWORK_RELAY_DB_PATH` (default `/var/lib/fieldwork/relay.db`, `off` for in-memory local smoke tests); local tests verify restart persistence, replay rejection after restart, 90-day no-use token pruning, accepted-push last-used timestamp refresh, APNs `BadDeviceToken` stale-token pruning from memory and SQLite, and Unix `0700`/`0600` modes for the DB directory, main DB, and SQLite `-wal`/`-shm` sidecars. The relay also serves aggregate Prometheus metrics from a separate metrics app/listener (`FIELDWORK_RELAY_METRICS_ADDR`, default `127.0.0.1:9090`, `off` disables it locally); metrics intentionally expose only aggregate counters and gauges, never daemon node IDs, push tokens, session hashes, commands, paths, names, or terminal content. APNs provider support is wired when relay-only `.p8`, team ID, key ID, and topic are present: the relay signs ES256 provider JWTs, caches each JWT for 50 minutes, keeps an HTTP/2 client alive with pings, reuses the provider client connection across dispatches, sends only fixed alert copy plus opaque session hashes, and treats provider `BadDeviceToken` as a stale-token signal that deletes the relay token binding before reporting a provider error to the daemon. iOS requests APNs permission only after a saved or newly approved pairing exists and Face ID unlock succeeds, retains token callbacks until pairing is available, presents foreground APNs notifications with fixed generic copy, and resolves notification taps from lowercase `session_id_hash` against locally fetched sessions after Face ID unlock. `Fieldwork.entitlements` includes `aps-environment = $(APS_ENVIRONMENT)`, with Debug set to `development` and Release set to `production`, so signed builds can receive APNs device tokens once the provisioning profile carries the Push Notifications capability. FCM provider support is wired when relay-only Firebase service-account JSON is present: the relay signs an RS256 service-account JWT, exchanges it for a cached Google OAuth token, keeps the same HTTP/2 client behavior, sends the fixed-copy notification plus hash-only data payload through FCM HTTP v1, and prunes FCM `UNREGISTERED` tokens as stale bindings. Android now depends on Firebase Messaging through the current Firebase BoM, declares `FieldworkFirebaseMessagingService`, keeps Firebase Messaging auto-init disabled in the manifest, requests notification permission only after pairing and BiometricPrompt unlock, enables token generation only after pairing/unlock when `google-services.json` is present, sends FCM tokens through mobile-core's existing `RegisterPushToken` path, creates the `fieldwork-agent-state` notification channel, renders foreground FCM messages with fixed generic copy, rejects malformed or uppercase `session_id_hash` values, and resolves accepted notification taps against locally fetched sessions after BiometricPrompt unlock; release CI fails closed unless `ANDROID_GOOGLE_SERVICES_JSON` is present before the AAB is built. The hidden iroh phone simulator now supports `--secret-key-path`, `--connect-only`, and `--expect-unauthorized`, which verifies local device revocation by pairing a deterministic device identity, removing it with `fieldwork devices remove`, then reconnecting and receiving `Error{Unauthorized}`. `FIELDWORK_IROH_SECRET_KEY_B64` is available only as a deterministic daemon-identity override for headless CI/smoke environments where OS keychain access would block iroh startup; production runs should leave it unset. Daemon and relay logging both run through a `tracing::Layer` sanitizer that drops events marked `privacy.level = "user_content"` before downstream logging layers receive them. Local automated coverage includes Android notification hash JVM unit tests, daemon lowercase SHA-256 push-hash generation, daemon POST dispatch with lowercase 64-character hex `session_id_hash` and `session_name_hash`, daemon transient push retry with fresh signed nonces, relay SQLite persistence, relay version endpoint privacy, relay push validation, ownership, replay defense, skew defense, invalid signatures, payload privacy rejection, APNs JWT caching, APNs mock HTTP delivery, APNs provider-client connection reuse, APNs payload privacy, APNs BadDeviceToken stale-token pruning, relay 90-day push-token pruning and touch-on-use coverage, FCM JWT claims, FCM OAuth token caching, FCM mock HTTP delivery, FCM payload privacy, FCM UNREGISTERED stale-token parser coverage, relay-only provider secret-boundary checks, iroh device revocation reconnect denial, test-only delivery-buffer retention, `moka` TTL rate limiting, aggregate metrics privacy, and sanitizer drop behavior. Remaining relay gates are real APNs delivery against Apple infrastructure, real FCM delivery against Google infrastructure, provider credential deployment, physical-phone notification tap-through, and the background/reconnect phone demo.

**Relay privacy refresh (2026-05-18)**: daemon-facing APNs/FCM provider errors now use fixed provider/status copy instead of reflecting Apple/Google response bodies. `provider_error_response_does_not_reflect_provider_body` injects a provider response containing `/Users/example/secret-project` and `last_line` sentinels and verifies that the relay API response omits those strings while retaining the token binding for a non-stale provider outage. BadDeviceToken/UNREGISTERED stale-token handling still prunes bindings, but the daemon-facing copy is generic.

**Implementation note (2026-05-18)**: daemon push coverage now verifies
`hash_for_push` produces lowercase SHA-256 hex and that relay POST dispatch uses
lowercase 64-character hex `session_id_hash` and `session_name_hash` before the
relay validation boundary. It also verifies that removing a paired device with a
saved push token enqueues relay token unregistration, and that the daemon push
worker sends signed `/v1/push/unregister-token` requests without terminal-content
leakage.

**Implementation note (2026-05-18, Android FCM privacy)**: Android FCM token
refresh callbacks queue only trimmed pending tokens in backup-excluded
app-private `fieldwork_push_tokens.xml`; the Firebase service does not register
tokens directly, and the paired-and-unlocked ViewModel sync path sends
queued/current tokens through mobile-core and clears queued tokens only after
successful daemon registration. Focused Android JVM tests cover the token queue
helper plus the ViewModel registration gate, including paired-but-locked no-op,
paired-and-unlocked registration/clear, duplicate queued/current token dedupe,
and unpair clearing. Focused Android ViewModel tests also cover push-tap
routing: valid hashes stay pending while locked and resolve only after unlock
plus session refresh, unlocked taps resolve against the current session list,
invalid uppercase hashes clear stale pending routes and never route after
unlock, unlock starts the session subscription, subscription updates replace the
dashboard list, and pending push taps can resolve from later subscription
updates.

### Week 8 — Distribution pipeline + Oracle relay deploy
**Goal**: everything ships from CI; production relay is live on Oracle ARM.

- Configure `cargo-dist` for build/archive pipeline only — **installer + brew-formula generation explicitly disabled** in `dist-workspace.toml` via `installers = []`, `publish-jobs = []`, and `install-updater = false`. cargo-dist's role is reduced to cross-compile + GitHub Release artifact upload for audit.
- Write the `release-rust.yml` workflow: cross-compile **4 host targets** (darwin-arm64, darwin-x64, linux-x64, linux-arm64) via cargo-zigbuild for Linux + native runners for Darwin, sign+notarize macOS daemon via rcodesign, upload artifacts.
- Write the `release-npm.yml` workflow: download artifacts, copy into `packages/cli-*/bin/`, verify native binaries, then run `scripts/publish-npm-packages.mjs` (publishes **5 npm packages**: 4 platform packages first, then the meta package, all with npm provenance), then verify public registry dist-tags and SLSA provenance metadata.
- Provision Oracle ARM A1 in 2 regions (with retry-loop scripts). Deploy `fieldwork-relay` via Ansible. **No Caddy** — iroh-relay handles its own ACME on `:443`; the axum control plane serves HTTPS on `:8443` from relay-only certificate/key credentials. Two systemd units (`fieldwork-iroh-relay.service`, `fieldwork-control-plane.service`), both autorestart, both run as user `fieldwork-relay` with `setcap CAP_NET_BIND_SERVICE`.
- Update mobile clients to use production relay URLs.
- Write `release-ios.yml` and `release-android.yml`. TestFlight build uploaded; Play Console internal track.
- **Demo**: from a fresh laptop, `npm i -g fieldwork`, install daemon, pair with TestFlight build on phone, full flow works against production relay.

**Implementation note (2026-05-17)**: the npm distribution scaffold is implemented locally. `packages/cli` is the `fieldwork` meta package; the four v1 platform packages are `packages/cli-darwin-arm64`, `packages/cli-darwin-x64`, `packages/cli-linux-arm64`, and `packages/cli-linux-x64`. The meta package has optional dependencies, `preferUnplugged`, a postinstall native binary copy/swap for `fieldwork` and `fieldworkd`, a `fw` bin alias that points to the same CLI dispatcher as `fieldwork`, and JS dispatcher fallback for the CLI alias and daemon command tested for omitted optional dependencies, non-executable native binaries, and unsupported Windows hosts. Its npm README is guarded as a package-page contract covering the unscoped `fieldwork` install path, the `fw` short alias, shipped commands, first-run commands, mobile capability boundary, platform package names, dispatcher fallback, WSL2 scope, encrypted local persistence, and push-payload privacy copy. `scripts/prepare-npm-artifacts.mjs` also copies root `LICENSE` and `NOTICE` into every npm package directory before publish, and package dry-runs assert those legal files are present alongside executable `fieldwork` and `fieldworkd` entries. It now requires a platform/target-matching extracted artifact directory for each platform package and fails on a missing platform root instead of falling back to another platform's binaries. The Rust CLI has a cached npm-registry update notice that never downloads code, writes a private daily cache, and skips machine-readable/raw-terminal commands. Changesets fixed-group config plus local verifier, explicit children-first npm publish script, npm metadata verification, relay provider secret-boundary verification, artifact preparation, release archive checksum and Sigstore DSSE/SLSA bundle verification, release-workflow fail-closed verification, cargo-dist archive-only config, CI, release-rust, release-npm, release-ios, release-android, deploy-relay, and Dependabot workflows are present. CI now runs `cargo audit` in addition to `cargo deny`, runs the Changesets fixed-group verifier, runs the relay provider secret-boundary verifier, runs the release-workflow verifier, has a Terraform Validate job that installs Terraform 1.5.7 and runs the shared cleanup-on-exit Terraform fmt/init/validate script against the Oracle scaffold, and has an Android debug build job that generates UniFFI Kotlin bindings/native libraries before compiling app Kotlin. `release-rust.yml` now fails closed before Darwin toolchain setup/build if macOS signing/notarization secrets are absent, runs the relay-only provider secret-boundary verifier and telemetry privacy verifier after binaries are built, and produces cosign `attest-blob` bundles plus SHA-256 files for each GitHub Release archive. `release-npm.yml` now fails closed before artifact download when `NPM_TOKEN` is absent, downloads artifacts from the completed Rust workflow run for automatic publish, supports manual dispatch from an explicit GitHub Release tag, verifies every platform archive SHA-256, verifies the Sigstore bundle DSSE/SLSA provenance v1 `predicateType`, subject name, subject digest, and SLSA external parameters, runs `cosign verify-blob-attestation` against the GitHub OIDC issuer and release-rust workflow identity before extraction, verifies native binaries, runs the children-first npm provenance publish plan, and then retries `scripts/verify-npm-registry-state.mjs --expect-meta-published --expect-platform-published --expect-latest-version="$version" --expect-provenance` against the public registry. `release-ios.yml` now runs on `macos-26`, uses the runner's selected Xcode 26+ path, verifies Xcode and iOS SDK major versions with `scripts/check-ios-prereqs.sh --release`, verifies mobile privacy defaults and telemetry privacy wiring, builds `apps/ios/scripts/build-rust.sh`, verifies the generated xcframework contains an `arm64` iOS device library and an `arm64`/`x86_64` iOS simulator library, fails closed if Sentry/signing/export/App Store Connect secrets are absent, rejects provisioning profiles that do not match `app.fieldwork.ios` or do not include production `aps-environment`, imports the Apple Distribution `.p12` and provisioning profile into an ephemeral keychain/profile directory, archives with `FIELDWORK_SKIP_RUST_BUILD=1` to avoid a second Rust rebuild, exports the IPA from a validated export-options plist, writes the App Store Connect API `.p8` only to the standard private-key path with `0600`, uploads through `xcrun altool`, and deletes the signing keychain in an `always()` cleanup step. The secret-boundary verifier checks source/config templates and scans built non-relay Rust/mobile-core artifacts when present; after staging local desktop release binaries into the npm platform packages and building Android mobile-core release artifacts, the full staged local `pnpm check:secret-boundaries` run scanned 32 non-relay artifacts across package bins and release target outputs. The current retained-artifact set includes staged desktop/npm binaries plus debug/release CLI and mobile-core outputs; the latest local `pnpm check:secret-boundaries` run scanned 24 retained non-relay artifacts and still passed. The verifier now streams artifact scans instead of materializing large native binaries as one string, and its self-test covers npm token and relay credential literals split across chunk boundaries; `release-rust.yml` still runs the same verifier after release binaries are built. Cross-target Rust release builds now pass locally for `fieldwork`, `fieldworkd`, and `fieldwork-relay` on `aarch64-apple-darwin`, `x86_64-apple-darwin`, `x86_64-unknown-linux-gnu`, and `aarch64-unknown-linux-gnu` using `cargo build` for Darwin and `cargo zigbuild` for Linux. The Linux build initially failed because `keyring`'s persistent Secret Service backend pulled a host/sysroot DBus dependency; enabling the crate's `vendored` feature preserves the persistent Linux Secret Service path while removing the external `libdbus-1-dev` build dependency. Android release artifacts build locally from the repo with Android Studio's SDK/NDK, `cargo-ndk`, and the pinned `apps/android/gradlew` launcher: the latest completed validation on 2026-05-20 rebuilt the release bundle against current Android source with `apps/android/gradlew --no-daemon bundleRelease`, producing current `apps/android/app/build/outputs/bundle/release/app-release.aab` (`54M`, SHA-256 `8ab0548931a2a6a378d54646bc0d6932bfce941c499d07d1218306bd7e4a7365`) with all three Fieldwork core ABI slices; earlier 2026-05-18 validation ran `apps/android/scripts/build-rust.sh` for `arm64-v8a`, `armeabi-v7a`, and `x86_64` and regenerated UniFFI Kotlin bindings. Local `jarsigner -verify -certs` reports the bundle is unsigned until the Play release keystore external gate is satisfied. `release-android.yml` now uses the pinned Gradle launcher, fails closed before toolchain setup and Rust/mobile build when Sentry, Firebase, signing, or Play upload secrets are absent, chmods decoded signing files to `0600`, verifies telemetry privacy wiring, verifies mobile privacy defaults after the release manifest is generated, and verifies the signed AAB with `jarsigner` before upload. The Oracle Terraform scaffold under `infra/oracle/terraform` provisions the ARM A1 relay host, public subnet, internet gateway, route table, security list, IMDSv1-disabled instance, and Ansible inventory output without storing credentials or state in git; `infra/oracle/provision-region.sh` wraps `terraform init`/`apply` with retry controls for scarce Always Free A1 capacity. The relay Ansible scaffold now wires `FIELDWORK_RELAY_DB_PATH`, `FIELDWORK_RELAY_METRICS_ADDR`, `FIELDWORK_RELAY_ADDR`, and relay OTLP settings into `fieldwork-control-plane.service`, creates the relay data directory as `0700`, and passes APNs, FCM, and Honeycomb relay-only secrets only through systemd `LoadCredential` paths. The same `fieldwork-relay` binary now supports `FIELDWORK_RELAY_MODE=iroh-relay`; `fieldwork-iroh-relay.service` runs that mode with ACME-backed HTTPS on `:443`, HTTP probe/challenge handling on `:80`, QUIC address discovery on `:7842`, and separate aggregate metrics on `127.0.0.1:9091`. `deploy-relay.yml` now fails closed before artifact download when `RELAY_SSH_KEY` is absent or the inventory has no relay hosts, verifies the `linux-arm64` archive SHA-256, Sigstore bundle DSSE/SLSA predicate type, subject name, digest, cosign signature, and extracted relay executable, writes the SSH key with `0600`, deploys through Ansible, and removes the decoded key in an `always()` cleanup step. Local verification passed for workflow YAML parsing, release-workflow fail-closed checks, release workflow early Darwin signing preflight before toolchain setup/build, Terraform fmt/init/validate for the Oracle scaffold, YAML/Jinja rendering, npm metadata, dispatcher fallback, release archive checksum and DSSE/SLSA bundle verifier, all four simulated platform postinstall swaps (`darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-x64`), relay provider secret-boundary checks, synthetic native artifact preparation including missing platform-root rejection, platform package dry-runs, real staged desktop binary readiness for all four npm platform packages, exact publish-plan verification for children-first ordering plus `npm publish --provenance --access public`, missing-token publish rejection before `npm` is invoked, release workflow early `NPM_TOKEN` preflight before artifact download, release workflow early relay SSH/inventory preflight before artifact download, release workflow early Android credential preflight before toolchain setup/mobile build, CLI update-notice cache/version tests, Android ABI/AAB release artifact checks, iOS script syntax checks, and `npm pack ./packages/cli --dry-run --json`. The synthetic artifact tests caught and fixed real release-npm fragility: `prepare-npm-artifacts.mjs` path walking and unchecked archive checksums/bundles; they now also fail on missing platform artifact roots plus tampered DSSE/SLSA archive digest, subject-name, predicate-type, and external-parameter fields. End-to-end publish/deploy remains blocked by external requirements: operator-controlled placeholder publishes for the four npm platform child packages and a release-scoped `NPM_TOKEN`, Apple signing/notarization/TestFlight credentials, Play Console credentials, Oracle ARM A1 account/capacity/hosts/SSH secrets, APNs/FCM provider credentials, Honeycomb API key, Android release keystore, and physical-device release testing.

**Release-artifact verifier update (2026-05-18)**: `scripts/verify-release-artifacts.mjs` now pins each archive's checksum filename, Sigstore media type, transparency-log presence, DSSE envelope/signature, in-toto payload, DSSE/SLSA subject, predicate type, official-repository `buildType`, package, expected Rust target triple, SLSA `releaseTag`, and SHA-256 external parameter before extraction. `release-npm.yml` and `deploy-relay.yml` pass `FIELDWORK_RELEASE_REPOSITORY=${{ github.repository }}` so the verifier checks the same repository used by the release-rust OIDC identity; manual artifact consumers also pass `FIELDWORK_EXPECTED_RELEASE_TAG` so the bundle `releaseTag` must match the requested GitHub Release tag. `scripts/test-release-artifacts.mjs` covers checksum-name, malformed Sigstore/DSSE payloads, missing external parameters, release-tag, external SHA, package, target, and buildType drift with deterministic fixtures.

**Release workflow secret hygiene refresh (2026-05-19)**: `release-rust.yml`
now decodes `cert.p12` and `app-store-key.json` signing/notarization assets
under `RUNNER_TEMP`, chmods them to `0600`, and removes the temp signing
directory plus the temporary daemon notarization zip at the end of the Darwin
signing step. `release-ios.yml` writes the App Store Connect upload JSON under
`RUNNER_TEMP`, chmods it to `0600`, tracks the generated private-key path, and
cleans signing/upload assets in its `always()` cleanup step. `release-android.yml`
removes generated `google-services.json`, `release.keystore`, and
`keystore.properties` files in an `always()` cleanup step after upload.
`deploy-relay.yml` removes the decoded `~/.ssh/fieldwork-relay` key in an
`always()` cleanup step after deployment.
`scripts/verify-release-workflows.mjs` pins those behaviors so future release
workflow edits cannot silently leave decoded Apple, Firebase, or signing assets
or relay SSH keys in the repository workspace, world-readable, or persistent in
the runner workspace.

**Distribution note update (2026-05-18)**: the npm name model is now unscoped. `fieldwork` is the v1 meta package, and the four platform children are `fieldwork-darwin-arm64`, `fieldwork-darwin-x64`, `fieldwork-linux-arm64`, and `fieldwork-linux-x64`. The five publishable npm manifests and Rust workspace packages are set to `1.0.0`; rebuilt host and cross-target release binaries contain `fieldwork 1.0.0`. The unscoped `fieldwork` meta package is operator-owned, so no further npm name-availability checks are needed for it. `scripts/verify-npm-registry-state.mjs` is reserved for release-state checks and now fails closed without explicit expectation flags: `--expect-platform-published` after operator-controlled platform child publishes and `--expect-latest-version=1.0.0 --expect-provenance` for post-release dist-tag and npm SLSA provenance verification; `scripts/test-npm-registry-state.mjs` covers those modes plus bare-invocation failure with a deterministic local registry fixture. Local desktop release binaries have been staged into all four platform package directories, and `scripts/publish-npm-packages.mjs` rejects non-native platform children before publish in both `--check-ready` and actual publish paths. Those staged `packages/cli-*/bin/fieldwork` and `packages/cli-*/bin/fieldworkd` files are generated release artifacts; `.gitignore` keeps them out of source control while `scripts/verify-npm-packages.mjs --require-binaries` still verifies them when present. The full staged `pnpm check:secret-boundaries` scan covered 32 non-relay artifacts across package bins, desktop release targets, and Android mobile-core release target outputs for relay-only credentials and npm auth-token patterns. The current retained-artifact set includes staged desktop/npm binaries plus debug/release CLI and mobile-core outputs, and the latest `pnpm check:secret-boundaries` scan covered 24 retained non-relay artifacts while still rejecting committed npm token strings or `.npmrc` files.

**Relay TLS note (2026-05-18)**: production control-plane TLS is explicit in code and deploy scaffolding. `fieldwork-relay` installs the workspace's Rustls `ring` crypto provider before loading `control-plane.crt`/`control-plane.key`, because the full dependency graph enables more than one Rustls provider. `fieldwork-control-plane.service` sets `FIELDWORK_RELAY_REQUIRE_TLS=true` and loads the cert/key through systemd credentials. `scripts/smoke-relay-tls-loopback.sh` honors `FIELDWORK_RELAY_BINARY`, otherwise prefers an existing `target/release/fieldwork-relay`, starts the control plane with a throwaway self-signed cert/key, and verifies `/healthz` over HTTPS.

**iOS toolchain note (2026-05-18)**: Apple currently lists Xcode 16.3 as compatible with macOS Sequoia 15.2 and carrying iOS 18.4 SDK, which makes it the local development target for this Mac. Apple App Store Connect uploads now require Xcode 26+ with an iOS 26+ SDK, so release/TestFlight builds use GitHub's `macos-26` runner instead of this local host. This Mac is on macOS 15.2 with only `/Library/Developer/CommandLineTools` selected, so `xcodebuild`, `xcrun --sdk iphoneos`, and `xcrun --sdk iphonesimulator` cannot locate the iOS SDKs. Installed local prerequisites that do not require Apple credentials: Homebrew `xcodes` 1.6.2, `aria2` 1.37.0_2, `.xcode-version` pinned to `16.3`, Rust targets `aarch64-apple-ios`, `aarch64-apple-ios-sim`, and `x86_64-apple-ios`, and reference/source checkouts for `SwiftTerm` `v1.13.0`, `blink`, and `sentry-cocoa` `9.13.0`. The iOS Xcode project now requires exact SwiftPM versions for SwiftTerm 1.13.0 and sentry-cocoa 9.13.0, the committed `Package.resolved` pins their audited revisions, and `pnpm check:mobile-privacy` verifies those pins plus the raw SwiftTerm byte-array renderer guard. `xcodes update --data-source xcodeReleases` was refreshed and `xcodes list` confirms Xcode `16.3 (16E140)` and Xcode 26.x releases through `26.5 (17F42)`. `scripts/check-ios-prereqs.sh` captures this audit, `apps/ios/scripts/build-rust.sh` preflights that check before invoking Cargo/Xcode, and `scripts/check-ios-prereqs.sh --release` verifies the Xcode 26+/iOS 26+ release floor on CI. Generated `target/debug` and Android build intermediates were cleaned while preserving the release AAB, and the latest local audit reports at least 70 GiB free in `~/Downloads`, satisfying the repo script's Xcode download/expansion guard. The current attempted Xcode download is blocked by Apple Developer authentication/access instead: `scripts/check-ios-prereqs.sh --download-xcode` and direct `xcodes download 16.3 --data-source xcodeReleases` both report a missing Apple ID/password, direct `curl` against `https://download.developer.apple.com/Developer_Tools/Xcode_16.3/Xcode_16.3.xip` redirects to Apple's unauthorized page, and the existing Chrome session is not signed into an account with access. No Xcode `.xip` was written. Direct `fieldwork-mobile-core` builds for `aarch64-apple-ios` and `aarch64-apple-ios-sim` now fail at the prereq check because `xcrun` cannot locate the required SDKs. A full local iOS build remains blocked until Apple Developer authentication/access is supplied and full Xcode 16.3 is installed/selected.

**Release identity note (2026-05-18)**: `release-npm.yml` and `deploy-relay.yml` derive the cosign certificate identity and expected SLSA `buildType` repository from `${{ github.repository }}` before verifying release-rust attestations. `docs/OPERATIONS.md` pins the manual relay verification example to `fieldwork-app/fieldwork`, `scripts/verify-release-workflows.mjs` checks the dynamic workflow identity/buildType wiring, `scripts/verify-infra-scaffold.mjs` rejects the stale `fieldwork/fieldwork` runbook identity, and `scripts/test-release-artifacts.mjs` uses the current `fieldwork-app/fieldwork` SLSA fixture identity.

### Week 9 — Hardening, observability, docs
**Goal**: cross every box in section 13.

- Set up Sentry (free tier), wire up Rust + iOS + Android SDKs.
- Wire Honeycomb OTLP from relay (free tier).
- Write `docs/INSTALL.md`, `docs/PROTOCOL.md`, `docs/PRIVACY.md`, `docs/ARCHITECTURE.md`, `docs/SECURITY.md`, `CONTRIBUTING.md`, `SECURITY.md`.
- Run through every checkbox in section 13. Fix what's broken.
- Beta test with 5–10 friends (recruit from your network). Collect feedback, fix top issues.

**Implementation note (2026-05-17)**: local code-quality gates moved forward. `protocol` and `mobile-core` deny `missing_docs`; `relay` keeps `missing_docs` under the workspace `cargo clippy --workspace -- -D warnings` gate. `protocol` has insta snapshots that round-trip every current `ClientToServerMsg` and `ServerToClientMsg` variant through length-prefixed bincode. `daemon::ring` has a proptest property for retained-window snapshot/replay correctness across randomized capacities and chunk boundaries; this caught and fixed a bug where chunks larger than the ring capacity retained the wrong starting byte offset. `TerminalModel` now handles DSR cursor-position responses directly so PTY children get deterministic `ESC[row;colR` responses and the previously flaky device-status test is stable under parallel test runs. Daemon Sentry crash reporting is wired behind an explicit opt-in gate from either `fieldwork settings telemetry on --sentry-dsn <dsn>` persisted in the user config file or the `FIELDWORK_TELEMETRY_OPT_IN=true` plus `FIELDWORK_SENTRY_DSN` environment override path; it uses `send_default_pii=false` and `traces_sample_rate=0.0`. iOS uses biometric-only LocalAuthentication for resume and stale terminal input gating, stores pairing records as data-protection this-device-only Keychain items, activates paired session services only after successful unlock, and Android uses `BIOMETRIC_STRONG` BiometricPrompt without device-credential fallback while storing pairing records in encrypted, backup-excluded preferences. Native notification UI uses fixed generic copy; Android foreground FCM rendering now rejects missing/invalid `session_id_hash`, and native tap routing carries only `session_id_hash` before resolving against locally fetched sessions after biometric unlock. iOS and Android Sentry SDKs are now wired behind the in-app "Share crash reports" toggle and delayed one-time post-value consent prompt, disable default PII, keep trace sampling at `0.0`, close the SDK when the toggle is turned off, and receive DSNs only from release-time secrets (`Info.plist` substitution on iOS, Gradle `BuildConfig` on Android). The native terminal controllers surface the prompt only after an `AwaitingInput` state is observed, the user sends input, and at least 10 subsequent output lines arrive. iOS `MobileTelemetry.swift` is guarded with `#if canImport(Sentry)` and `SwiftTermView.swift` is guarded with `#if canImport(SwiftTerm)`, so local Swift static parsing can include every app/core/features/UI source before full Xcode/SPM has resolved package modules. The Xcode project and committed SwiftPM lockfile now pin SwiftTerm 1.13.0 and sentry-cocoa 9.13.0 to audited revisions. `scripts/verify-mobile-privacy.mjs` now also verifies that the iOS target compiles the generated UniFFI Swift binding, links the generated Rust xcframework, runs the Rust build script before compilation, renders only a lock surface while unauthenticated, activates paired session services only after unlock, gates terminal input behind biometric prompts, keeps those exact SwiftPM pins, and never enables `FIELDWORK_STUBS` in project build settings or the release workflow. `scripts/verify-telemetry-privacy.mjs` statically enforces the daemon, iOS, Android, and relay telemetry privacy invariants in CI: Sentry opt-in, mobile delayed consent trigger, no default PII, trace sampling off for daemon/mobile, no daemon OTLP/Honeycomb export, 1% relay OTLP sampling, Honeycomb credential redaction, and relay-only Honeycomb credential loading. `fieldwork settings scrollback-encryption off` is also implemented as an explicit user opt-out that makes subsequent local session and device-registry persistence plaintext after daemon restart; encrypted mode remains the default and can read rows written during a previous plaintext opt-out before re-encrypting subsequent writes. The trace-attribute sanitizer is installed for daemon and relay logs. Relay OTLP/Honeycomb export is now wired through OpenTelemetry HTTP/protobuf with `FIELDWORK_RELAY_OTLP_ENDPOINT`, 1% default sampling, static/aggregate span fields only, and a relay-only `honeycomb-api-key` systemd credential; local tests cover sample-rate validation, config redaction, secret-boundary enforcement, and the telemetry privacy verifier. `scripts/smoke-relay-otlp-loopback.mjs` now runs a repeatable loopback collector smoke: it starts `fieldwork-relay` with OTLP sample rate `1.0`, hits `/v1/version`, verifies an `application/x-protobuf` OTLP POST to `/v1/traces`, and asserts sentinel terminal/session/token strings are absent from the exported protobuf body. The live Honeycomb receipt gate remains blocked until a Honeycomb account/API key is available and test traces are observed in the hosted dashboard. The v1 contract intentionally excludes daemon OTLP export; `scripts/verify-telemetry-privacy.mjs` rejects accidental daemon OTLP/Honeycomb wiring. `fieldwork daemon install` and `fieldwork daemon restart` now wait for a real local protocol handshake before reporting success; a failed fresh install uninstalls the LaunchAgent/systemd user unit rather than leaving a broken service. On macOS, `fieldwork daemon install` now preflights `spctl --assess --type execute` for the colocated `fieldworkd` and fails before writing/starting launchd when Gatekeeper would reject the daemon, with guidance to use the signed/notarized npm package or notarized release artifact. `scripts/verify-daemon-service.mjs` keeps the user-level launchd/systemd service contract, restart policy, colocated `fieldworkd` path, macOS Gatekeeper preflight, health-check handshake, failed-install cleanup, fake-command `service-manager` rendering tests for LaunchAgent `KeepAlive`/`SuccessfulExit=false` and systemd `Restart=on-failure`/`RestartSec=5`, and restart-restore smoke markers under CI. Local launchd restart verification remains blocked in this shell because the unsigned/ad-hoc `fieldworkd` is rejected by `spctl --assess --type execute`; this gate must be rerun against the rcodesign/notarized macOS artifact. `README.md` now leads with the npm-only install command, pair flow, and three screenshot-style SVG captures for CLI install/session list, QR pairing approval, and mobile session attach; store-listing screenshots still require physical-device release capture. `docs/DEVELOPMENT.md` now starts with a 15-minute source-build path; the path was verified in an isolated temp `HOME`/`XDG_RUNTIME_DIR` with a cold Cargo home, including `cargo build --workspace`, `cargo nextest run --workspace`, daemon start, arbitrary `bash` session creation, and `fieldwork ls`. `scripts/smoke-local-handoff.sh` now provides a repeatable local substitute for the physical-phone pre-tag smoke and runs in CI's `Local Handoff Smoke` job: it builds the debug CLI/daemon, creates a default `claude` session through a temp stub command, a `bash` session, and a `vim` TUI session, pairs the hidden iroh phone simulator through explicit desktop approval, lists and attaches to the sessions over iroh, starts a mobile `SubscribeSessions` stream before creating another desktop session, verifies the subscribed session appears, sends mobile-originated input into `bash`, the default `claude`, and the subscribed desktop-created PTY and waits for matching output, verifies switched sessions do not receive each other's output markers, verifies that the paired simulated mobile client receives `Forbidden` for `CreateSession` and `KillSession`, removes the simulated device, verifies the reused identity receives `Unauthorized`, restarts the daemon, and verifies all last-known sessions are restored. CI installs `vim` for the Rust matrix and before that job so the TUI smoke is mandatory on pull requests. Mobile-core now exposes `subscribe_sessions` for long-lived dashboard updates and `attach_session_from(id, last_seen_seq)` for warm reconnects, tracks `AttachedSession.last_seen_seq()` from replayed initial bytes and live output offsets, and terminates the subscription after delivering `Lag` so native apps can reattach/resync cleanly. CI also checks generated OSS notice drift, parses every iOS App/Core/Features/UI Swift source file through package-import guarded fallbacks, verifies mobile privacy defaults, telemetry privacy wiring, APNs entitlement build settings, runs the relay OTLP loopback smoke, and runs an Android debug build job after generating UniFFI Kotlin bindings and native libraries. `cargo-nextest`, `cargo-deny`, and `cargo-audit` are installed in this shell. Local verification passes with `cargo fmt --check`, `cargo clippy --workspace -- -D warnings`, `cargo nextest run --workspace`, `cargo test --workspace`, `cargo test --workspace --doc`, `cargo deny check`, `cargo audit`, npm package checks, YAML/TOML parsing, plist lint, Android XML lint, SVG XML validation, Swift parse including `MobileTelemetry.swift` and `SwiftTermView.swift`, mobile privacy verifier, telemetry privacy verifier, relay OTLP loopback smoke, OSS notice check, Android debug Kotlin compile, and the local handoff smoke. `cargo audit` reports warnings only, not high/critical CVEs: `adler`, `lru`, and `paste` are transitive through the terminal/network/image dependency graph, and `bincode` is intentionally retained because v1 local IPC requires it and is covered by length-prefixed frame limits plus round-trip tests. Full iOS, release publish, provider push, Sentry/Honeycomb dashboard receipt, and physical-device release verification remain blocked by the external environment and credentials listed in the relevant sections.

**Implementation note refresh (2026-05-18)**: the local handoff smoke now also sends an `AgentStateEvent` from the paired iroh mobile simulator and expects `Error{Forbidden}`, matching the direct bincode IPC mobile hook-event rejection tests for `IosApp` and `AndroidApp`.

**Implementation note refresh (2026-05-19)**: bincode serialization is centralized in `fieldwork-protocol` through shared `encode_bincode`/`decode_bincode` helpers. The workspace uses bincode 2 with its legacy configuration so v1 local IPC and persisted payload wrappers keep the original fixed-int/little-endian layout; focused protocol tests pin the simple `ListSessions` frame bytes and reject trailing bincode payload bytes. `fieldwork` and `fieldworkd` now call those protocol helpers instead of owning their own bincode dependency/configuration.

**Reconnect smoke refresh (2026-05-19)**: the local handoff smoke now also creates a PTY that emits output while the simulated iroh phone is detached, reconnects with the previous `last_seen_seq`, and verifies that the missed output arrives through `Attached.initial_bytes` within the 2-second local threshold. The latest local run replayed `FW_RECONNECT_LINE_50` after a 20ms reconnect. Physical network-change timing remains a Section 13 release gate.

**Daemon Sentry test note (2026-05-17)**: daemon Sentry initialization now builds explicit `ClientOptions` instead of passing an unchecked DSN string into `sentry::init`; invalid configured DSNs fail daemon logging initialization with context instead of panicking. The daemon test target enables Sentry's `test` feature only as a dev-dependency and verifies three local invariants: crash reporting requires explicit opt-in plus DSN, `send_default_pii=false` and `traces_sample_rate=0.0` remain set, and a Rust panic is captured through Sentry's local test transport. Hosted Sentry receipt from daemon/iOS/Android remains a Section 13 external gate until a real Sentry project/DSN and signed mobile builds are available.

**Mobile reconnect note (2026-05-17)**: mobile-core now exposes `attach_session_from(id, last_seen_seq)` for warm reconnects, tracks `AttachedSession.last_seen_seq()` from replayed initial bytes and live `Output.seq` offsets, and terminates the subscription after delivering `Lag`. `stream_output_advances_mobile_reconnect_offset_without_decoding_bytes` verifies raw PTY bytes are delivered to native sinks without UTF-8 decoding while advancing the reconnect offset to the daemon-provided `Output.seq`; `lag_event_notifies_native_ui_and_stops_for_resync` verifies the native sink receives the skipped count before mobile-core returns for reattach/resync. The iOS service and Android repository cache the latest offset per session, and the iOS/Android terminal controllers reattach from that tracked offset on lag. The iOS terminal controller now publishes a raw-output revision for every received `Data` chunk before optional UTF-8 fallback decoding, so SwiftTerm rendering is driven by PTY byte arrival rather than text-decoding success. Full suspend/resume and network-change timings remain physical-device gates.

**Synthetic snapshot test note (2026-05-18)**: the Section 6.3/13.7 stale-attach gate is now covered by `session::snapshot_tests::stale_attach_snapshot_rehydrates_real_vim_session`. The test starts a real PTY-backed `vim /etc/hosts` session, waits for vim's alt-screen content in the daemon's `wezterm-term` model, forces the stale attach path with an out-of-window `last_seen_seq`, feeds `Attached.initial_bytes` into a fresh in-process `wezterm-term` client model, and asserts the resulting alt-screen cell state is identical to the daemon model. The Rust CI matrix installs `vim` on Ubuntu before `cargo nextest run --workspace`, so this gate is part of the normal workspace test suite.

**Performance note (2026-05-18)**: `scripts/measure-desktop-performance.mjs` measures release-build desktop cold starts without touching the user's real Fieldwork state. It runs one explicit warm-up sample to avoid build-machine first-exec page-cache/code-signing noise, then runs measured samples of `target/release/fieldwork version`, starts `target/release/fieldworkd` in isolated temp `HOME`/`XDG_RUNTIME_DIR` directories, and waits until `target/release/fieldwork daemon status` completes a real local IPC handshake with the daemon. Local release build command: `cargo build --release -p fieldwork-cli -p fieldwork-daemon`. The verifier fails on max measured sample, not p95. Latest passing run on this Mac measured CLI median `3.59ms`, p95 `4.07ms`, max `4.18ms` over 25 samples; daemon ready-to-handshake median `40.44ms`, p95 `44.31ms`, max `47.59ms` over 25 samples. `scripts/smoke-local-handoff.sh` now measures the simulated QR payload → iroh pair-test → desktop approval path in whole seconds and fails above 15 seconds; this remains the closest local substitute for physical QR camera timing. `scripts/smoke-android-debug.sh` is the repeatable local Android emulator substitute: latest wiped API 36.1 AVD run installed the debug app, launched `app.fieldwork.android/.MainActivity` with `am start -W` `TotalTime=2467ms`, confirmed the locked `Unlock` surface through `uiautomator`, found no Fieldwork crash-buffer entry, and verified a nonblank 1080x2400 `screencap` with 14391/14400 nonblack samples. A later raw `adb` QA refresh launched the default debug APK in `TotalTime=2297ms`, launched the emulator-only biometric-bypass build in `TotalTime=1460ms`, paired the app to an isolated release daemon in `TotalTime=1297ms`, verified `fw_android_direct_ok` round-tripped through the attached PTY, then rebuilt and relaunched the restored default locked build in `TotalTime=1097ms` with `FIELDWORK_BIOMETRIC_BYPASS = false` and an empty `FIELDWORK_DEBUG_PAIRING_PAYLOAD`. `FIELDWORK_ANDROID_BIOMETRIC_BYPASS=true pnpm test:android-debug-smoke` is available for AVDs with no enrolled biometrics and verifies the unlocked pairing/bottom-navigation UI through a debug-build-only bypass guarded by `BuildConfig.DEBUG`; release builds hardcode the bypass off. `pnpm test:android-emulator` now aggregates the direct-adb Android substitutes; the latest default aggregate run passed on `emulator-5554` with `pair_flow_ms=2234`, `visible_ms=3318`, and 8440/14400 flood screenshot nonblack samples while also covering background replay, restart restore, multisession, reconnect, and notification tap routing. The local Android startup path keeps the encrypted pairing store lazy and restores saved pairing on `Dispatchers.IO`, with focused JVM coverage proving ViewModel construction does not block on saved-pairing restore. The Android root uses an explicit Material color scheme plus explicit lock-button colors so the unauthenticated surface does not rely on system dark-mode defaults. The Play Store emulator image still emits background Google-service ANRs, so iOS/Android release cold start, terminal flood, network-change reconnect, physical QR camera scan timing, and physical pair-flow timing remain blocked on physical devices.

**Android aggregate emulator QA note (2026-05-19)**: `pnpm test:android-emulator` aggregates the direct-adb emulator substitutes and retries only a locked debug-launch timing outlier once with the same strict limit. The latest default aggregate run on `emulator-5554` passed with locked debug launch `TotalTime=7920ms`, pair `pair_flow_ms=2234`, session subscription `visible_ms=3318`, flood screenshot 8440/14400 nonblack samples, and successful background replay, restart restore, multisession, reconnect, and notification tap routing.

**Direct Android adb QA note (2026-05-19)**: direct adb validation installed the default debug APK, cold-launched the locked app with `Status: ok` and `TotalTime=5297ms`, captured `/tmp/fieldwork-adb-direct-20260519225027/default.png`, UI XML, logcat, and an empty crash buffer, then installed a debug-only biometric-bypass/pair-payload build, launched it with `TotalTime=4589ms`, paired through explicit desktop approval in `pair_flow_ms=1043`, attached a desktop-created `bash` session, sent `fw_android_direct_ok`, and verified `android-direct: fw_android_direct_ok` through a separately approved replay client with screenshots/UI XML/logcat under `/tmp/fieldwork-adb-direct-pair-20260519225208`. The default debug build was rebuilt and reinstalled afterward; `FIELDWORK_BIOMETRIC_BYPASS = false`, `FIELDWORK_DEBUG_PAIRING_PAYLOAD = ""`, the restored locked launch `TotalTime=5105ms`, and `/tmp/fieldwork-adb-direct-restore-20260519225316/restored-locked.png`/UI XML/crash log confirm the emulator was left on the non-bypass app.

**Direct Android adb restore-fix note (2026-05-20)**: a fresh manual `adb` pass paired the actual debug app through explicit desktop approval, attached `bash · fieldwork`, sent `android_adb_direct_ping`, confirmed `android-direct: android_adb_direct_ping` in `/tmp/fieldwork-adb-direct-pair-20260519235638/terminal-after-input.png` and `/tmp/fieldwork-adb-direct-pair-20260519235638/pty-output-after-input.txt`, detached back to the dashboard, and force-stopped/relaunched the paired app. Before the fix, relaunch restored the dashboard but logcat showed the pairing scanner briefly opening and emitting Camera2 stream errors. The Android ViewModel now exposes `restoringPairing`, the UI renders a spinner instead of `PairingScreen` until saved-pairing restore completes, and the rerun installed a biometric-bypass build with empty `FIELDWORK_DEBUG_PAIRING_PAYLOAD`, relaunched with `Status: ok`/`TotalTime=6225ms`, captured `/tmp/fieldwork-adb-direct-pair-20260519235638/relaunch-restore-fix-sessions.png` plus UI XML/logcat, and filtered logcat contained `FieldworkRepository: listSessions returned 1 sessions` with no `Camera`/`CAMERA`, Fieldwork `FATAL`, or ANR entries.

**Direct Android adb terminal pass (2026-05-20)**: another raw `adb` run started a fresh isolated daemon, installed the default debug APK, launched the locked app in `TotalTime=6766ms`, captured `/tmp/fieldwork-adb-direct-20260520001909/default-locked.png`, UI XML, app logcat, and an empty crash buffer, then rebuilt a debug-only biometric-bypass/pair-payload APK and paired through explicit desktop approval. After the notification permission prompt, `/tmp/fieldwork-adb-direct-20260520001909/pair2-sessions-after-ok.png` showed `bash · fieldwork` with `ANDROID_ADB_MANUAL_READY`; `/tmp/fieldwork-adb-direct-20260520001909/terminal-after-input.png` showed the Android keyboard input `android_adb_manual_ok` and PTY response `android-direct: android_adb_manual_ok`. App logcat recorded `FieldworkRepository: pair completed` and `FieldworkRepository: listSessions returned 1 sessions`, crash buffers stayed empty, and the APK was rebuilt/reinstalled back to default with `FIELDWORK_BIOMETRIC_BYPASS = false`, `FIELDWORK_DEBUG_PAIRING_PAYLOAD = ""`, `TotalTime=1371ms`, and the locked `Unlock` surface at `/tmp/fieldwork-adb-direct-20260520001909/default-restore-locked.png`.

**Direct Android adb refresh (2026-05-20)**: a fresh direct `adb` pass installed the default debug APK, launched the locked app with `Status: ok`, `LaunchState: COLD`, and `TotalTime=2360ms`, captured `/tmp/fieldwork-adb-direct-20260520100608/default-locked.png`, `/tmp/fieldwork-adb-direct-20260520100608/default-ui.xml`, `/tmp/fieldwork-adb-direct-20260520100608/default-logcat.log`, and an empty `/tmp/fieldwork-adb-direct-20260520100608/default-crash.log`, then used an isolated release daemon plus debug-only biometric-bypass/pair-payload APK under `/tmp/fieldwork-adb-direct-pair-20260520100742`. The emulator accepted the runtime camera and notification prompts, paired through explicit desktop approval, listed `bash · fieldwork` with `ANDROID_ADB_DIRECT_READY`, attached the terminal, sent `android_adb_direct_ping` through `adb shell input text`, and `/tmp/fieldwork-adb-direct-pair-20260520100742/terminal-after-input.png` showed `android-direct: android_adb_direct_ping`. `fieldwork devices` listed `sdk_gphone64_arm64`, the terminal crash buffer was empty, and the debug APK was rebuilt back to default with `FIELDWORK_BIOMETRIC_BYPASS = false`, `FIELDWORK_DEBUG_PAIRING_PAYLOAD = ""`, and the locked `Unlock` surface at `/tmp/fieldwork-adb-direct-pair-20260520100742/default-restored-locked.png`. This is direct emulator evidence only; physical-device biometric, QR-camera, and release cold-start gates remain unchecked.

**Android background/foreground replay note (2026-05-19)**: `pnpm test:android-emulator-background-replay` pairs the actual Android debug app with an isolated release daemon through the debug-only QR payload path, opens a desktop-created terminal, backgrounds the attached app while the PTY emits `ANDROID_BACKGROUND_REPLAY_OUTPUT`, foregrounds back to `Attached`, sends `after_background_ok`, and verifies the background-emitted output plus post-foreground input through a separately approved verifier. Latest local run passed on `emulator-5554`. This is still emulator substitute evidence; the release gate remains unchecked until the same behavior is observed on physical release devices.

**Android startup hardening note (2026-05-18)**: the Android root now obtains
`FieldworkViewModel` from the lifecycle ViewModel store through an
application-context factory. Startup restore still keeps the encrypted pairing
store lazy and runs saved-pairing restore on `Dispatchers.IO`; focused JVM
coverage now proves ViewModel construction does not block on saved-pairing
restore and stale startup-restore results cannot override an explicit pairing.

- Write the README, take screenshots, record a 60s demo video. Local v1 artifact:
  `docs/assets/fieldwork-demo-v1.mp4`, regenerated with
  `pnpm render:demo-video` and verified with `pnpm check:demo-video`.

### Week 10 — Launch
- iOS App Store submission (review takes 1–3 days in 2026).
- Android Play Store production track (review takes hours to 1 day).
- Tag v1.0.0; Changesets publishes all 5 npm packages; cargo-dist uploads GitHub Release artifacts (binaries only — no installers, no brew formula).
- Publish `fieldwork.dev` site (Oranda or Astro on Cloudflare Pages).
- **Launch day**: Show HN, tweet, post to r/programming + r/MachineLearning + r/ClaudeAI, email indie-hacker newsletters.
- Watch Sentry and Honeycomb dashboards. Respond to bugs in real-time for the first 48h.

**Website implementation note (2026-05-18)**: `site/` is now a static Astro package for `fieldwork.dev` with product, install, protocol, architecture, and privacy pages. It is intentionally outside the npm distribution workspace so the `fieldwork` package metadata stays isolated from site dependencies. It imports the repo's screenshot-style SVG captures from `docs/assets/`, uses the npm-only install path, and keeps mobile/store claims tied to the currently blocked signing and physical-device gates. Root scripts `pnpm check:site` and `pnpm build:site` are available, CI has a `Site` job that runs `pnpm --dir site install --ignore-workspace --frozen-lockfile` plus `pnpm check:site`, and `.github/workflows/deploy-site.yml` fails closed on missing Cloudflare credentials before site install/build, then builds `site/dist` and deploys it to Cloudflare Pages with `wrangler-action` only when `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` secrets are present. Local verification passes with `pnpm --dir site install --ignore-workspace --frozen-lockfile` and `pnpm check:site`. Browser screenshot smoke now passes with `agent-browser --auto-connect` against `pnpm --dir site dev --host 127.0.0.1 --port 4321`: screenshots were captured for `/`, `/install`, `/architecture`, `/protocol`, and `/privacy`, interactive snapshots exposed the expected headings/navigation, and console output was empty. `networkidle`/`open` waits can time out under Astro dev because the Vite HMR websocket stays open; use a fixed short wait for manual screenshot smoke.

### Weeks 11–12 — Buffer / post-launch
- iOS App Store approval almost always needs at least one resubmit.
- Inevitable launch-day bugs.
- Documentation gaps revealed by real users.
- First wave of issues triaged and fixed.

---

## 15. Risk register

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| 1 | Oracle ARM A1 capacity-grab fails for weeks | High | Medium | Multi-region retry-loop terraform. Fallback: rent one Hetzner CX22 ARM for €4/mo as bridge. |
| 2 | iroh 1.0 RC has regression breaking our use case | Medium | Medium | Pinned exact at `1.0.0-rc.0`; do not bump within 2 weeks of any release. If a blocking regression appears, drop to `0.98.x` and refile. |
| 3 | UniFFI 0.31 + Swift 6 strict concurrency surfaces blocker | Medium | High | Stay on Swift 5 strict-warning mode. Watch issues #2458, #2448. Worst case: post-process bindings to inject `@unchecked Sendable`. |
| 4 | Apple rejects iOS app citing "remote code execution" rules | Medium → **Low** | High | **Mobile clients cannot create sessions or specify commands** (Section 6.4 protocol invariant; mobile-core has no API for it). iOS app only attaches to sessions a user already created on their laptop. If still rejected: emphasize the app is a viewer/input-relay, not an executor; sessions exist before the phone connects. |
| 4a | Apple flags AGPL distribution conflict with App Store terms (VLC precedent) | Low | Medium | Element, Matrix iOS clients, several GPL/AGPL apps ship in the App Store. `NOTICE` grants the Fieldwork maintainers a narrow App Store/TestFlight additional permission while preserving AGPL source-availability obligations. |
| 5 | Push notification UX flakiness on Android (battery optimizers) | High | Medium | Document the Doze-mode caveats. Add in-app warning if FCM tokens aren't refreshing. Foreground-service work is outside v1 and tracked in `FUTURE.md`. |
| 6 | First-party Anthropic Remote Control sucks our oxygen | Medium | High | Differentiate on multi-session + UX polish. Ship faster than they iterate. Stay open-source as moat. |
| 7 | iroh public free relays get rate-limited during testing | Low | Low | Development builds can point `FIELDWORK_IROH_RELAY_URL` at a self-hosted/local relay. The Fieldwork relay scaffold is implemented; production use still depends on hosted Oracle capacity, DNS, credentials, and deploy verification. |
| 8 | Raw-byte terminal streaming over LTE has stutter | Medium | Medium | Profile on real bad-network conditions. v1 keeps the raw-byte protocol; broader negotiated compression is tracked in `FUTURE.md` and must not change the terminal rendering contract. |
| 9 | Solo timeline slips past 10 weeks | High (always) | Medium | Buffer weeks 11-12 already built in. Android is in v1; do not reduce scope without updating this contract and the release audit. |
| 10 | Sentry free tier exhausted in first month | Low | Low | Switch to self-hosted GlitchTip on Oracle A1 — same DSN format, no code change. |
| 11 | A user's machine has an exotic shell that breaks `wezterm-term` parsing | Low | Low | Comprehensive fixture corpus in tests (vim, htop, nano, less, byobu). |
| 12 | npm package squat on platform child names | Low | High | The unscoped `fieldwork` meta package is operator-owned, so agents must not perform live availability checks for it. **Operator action item: confirm publish rights for `fieldwork-darwin-arm64`, `fieldwork-darwin-x64`, `fieldwork-linux-arm64`, and `fieldwork-linux-x64`, then publish placeholders or the v1 release packages before announcing.** |
| 13 | Discovery is weak without Homebrew / cargo install / curl\|sh | Medium | Medium | Content marketing (blog posts, demo video, Show HN), GitHub Stars momentum, integrations (mentioning fieldwork in Claude Code ecosystem channels, docs). Plan for word-of-mouth, not registry SEO. |
| 14 | `connectbot/termlib` not ready for Android v1 | Medium | Medium | Three-tier fallback: termlib (primary) → Termux `terminal-emulator` (GPL-3.0, OK with AGPL project) → xterm.js+WebView. All consume same byte stream so swap is local. |
| 15 | esbuild postinstall binary-swap fails on read-only filesystems | Low | Low | Dispatcher fallback handles it — user just pays Node startup cost (~30ms warm). Document. |
| 16 | Push gateway compromise = mass push spam to all paired phones | Low | High | Relay is the only place APNs/FCM creds live. Hardening per Section 7.3 deploy: relay runs as dedicated low-privilege user `fieldwork-relay`; **secrets via systemd `LoadCredential`** (preferred; readable to unit UID only) with root-owned group-readable `0440` as fallback; `garde` validation rejects free-text in `/v1/push`; per-NodeID rate limit; nonce + 5min replay window; quarterly APNs/FCM/Honeycomb/SSH key rotation and incident response are documented in `docs/OPERATIONS.md`. |
| 17 | Relay availability outage breaks push for all users (single point of failure) | Medium | Medium | Two Oracle A1 instances in different regions, DNS round-robin. Daemons retry push delivery for up to 60s with backon-exponential. iroh P2P session connectivity is unaffected by relay outage (only push routes through it). |
| 18 | Windows users locked out of v1 | High | Low | Document explicitly: "Use WSL2 for v1"; native Windows host work is tracked in `FUTURE.md`. Most dev-tool early adopters on Windows already have WSL2. |

---

## 16. Decisions (formerly open questions)

All previously open questions have been resolved. Listed here for traceability; current state is reflected in the relevant sections above. **No open questions block v1.**

| # | Question | Decision | Where it lives |
|---|---|---|---|
| 1 | iOS bundle id format | `app.fieldwork.ios` (matches Android pattern; `app.X` is the 2026 standard) | Section 0 |
| 2 | Telemetry consent UX | Deferred opt-in — bottom sheet after first agent interaction, default-focus "Sure", decline is silent and final. No first-launch prompt. | Section 11.1 |
| 3 | Push notification copy | Fixed enum-derived strings generated by relay from `event_type`. `AwaitingInput` → title `"Fieldwork"`, body `"A session is waiting for you."`. No session name, no `last_line`, no terminal content in payload. Thread id collapses multi-pings. | Section 7.5 + 7.3 |
| 4 | Publish source to crates.io for `cargo install` | **No for v1.** npm is the canonical install channel; multiple install paths fragment support. Revisit after v1 ships once the npm path is proven; any adopted scope must be tracked in `FUTURE.md`. | (this decision) |
| 5 | OSS license | **AGPL-3.0-or-later.** Decided 2026-05-17 per "use the best regardless of license" directive. | Section 12.1 |
| 6 | Donations/sponsorship | **GitHub Sponsors only.** No Open Collective, no Patreon. Single channel. | Section 12.3 |
| 7 | Synchronous chat platform | **Discord.** Bigger indie-dev reach in 2026. | Section 12.3 |
| 8 | Bun install support | **Yes, officially supported.** Bun honors npm `optionalDependencies` semantics since v1.0; verified working in CI as part of the compatibility matrix gate. | Section 8.7 |
| 9 | iroh version pin | **`1.0.0-rc.0` exact.** Migrate to 1.0 stable when released; no bumps within 2 weeks of any iroh release. | Section 4.1 |
| 10 | Domain | **`fieldwork.dev`** | Section 0 |
| 11 | GitHub org | **`fieldwork-app`** (org, not personal account) | Section 0 |
| 12 | Mobile-core architecture scope | **Maximalist Rust** (Litter's pattern). State, reducers, transport, crypto, protocol parsing all in Rust. Native = pure rendering. | Section 7.4 |
| 13 | Documentation site stack | **Astro on Cloudflare Pages.** Oranda rejected (less flexible for blog). | Section 12.3 |
| 14 | Android terminal renderer decision point | **End of week 5, hard gate.** termlib spike + 30-min dogfood. Pass = ship. Fail = drop to Termux for v1. No rolling reassessment. | Section 7.6 |

---

## 17. Reference codebases to clone and study

Before writing any non-trivial code, clone these into `references/` and read the relevant files:

```bash
mkdir -p references && cd references

# Core stack references
git clone https://github.com/dnakov/litter           # mobile-core, UniFFI, build pipeline
git clone https://github.com/lunel-dev/lunel         # cell-grid protocol, render loop
git clone https://github.com/zellij-org/zellij       # multi-client session server
git clone https://github.com/nikhiljha/rose          # QUIC + wezterm-term, mosh-replacement
git clone https://github.com/n0-computer/iroh        # transport (read examples/)
git clone https://github.com/n0-computer/sendme      # production iroh app
git clone https://github.com/n0-computer/iroh-ffi    # iroh's UniFFI bindings (resumed Feb 2026)
git clone https://github.com/mobile-shell/mosh       # original C++ for SSP algorithm

# Mobile UI references
git clone https://github.com/migueldeicaza/SwiftTerm # iOS terminal renderer (now Metal-accelerated)
git clone https://github.com/blinksh/blink           # iOS keyboard accessory bar reference
git clone https://github.com/connectbot/termlib      # Android Compose terminal (libvterm + JNI) — primary
git clone https://github.com/termux/termux-app       # Android terminal-emulator fallback (GPL-3.0, OK with AGPL)
git clone https://github.com/wezterm/wezterm         # VT parsing patterns

# npm distribution references
git clone https://github.com/biomejs/biome           # canonical hand-rolled optionalDependencies pattern
git clone https://github.com/vercel/turborepo        # signal-handling + JIT-fallback in launcher
git clone https://github.com/evanw/esbuild           # postinstall binary-swap trick (npm/esbuild/install.js)
git clone https://github.com/changesets/changesets   # version sync tooling we'll adopt
```

Per-file reading list:
- Litter: `AGENTS.md`, `shared/rust-bridge/codex-mobile-client/src/lib.rs`, `apps/ios/scripts/build-rust.sh`, `shared/rust-bridge/generate-bindings.sh`
- Lunel: `pty/src/session.rs` (entire file), `cli/` directory structure
- Zellij: `zellij-server/src/lib.rs` (lines 200-400), `zellij-utils/src/consts.rs`
- RoSE: reference-only for v1; predictive local echo is deferred in `FUTURE.md`.
- Termux: `terminal-emulator/src/main/jni/` (the JNI bridge) + `terminal-emulator/src/main/java/com/termux/terminal/` (Java VT logic, port to Kotlin if used)
- Blink: `Blink/SmartKeys/SmartKeysController.swift` + related files — copy directly for iOS keyboard accessory bar
- iroh: `examples/connect/`, `examples/listen/`, `iroh-relay/README.md`
- Biome: `packages/@biomejs/biome/package.json` + `packages/@biomejs/biome/bin/biome` (launcher) + `packages/@biomejs/cli-darwin-arm64/package.json` (platform-package template)
- esbuild: `npm/esbuild/install.js` (the postinstall binary-swap — copy this nearly verbatim)
- Turbo: `packages/turbo/bin/turbo` — only the signal-handling section
- termlib: `vterm/` (JNI bindings to libvterm) + `compose/` (Compose terminal view)

---

## 18. Appendix A — Glossary

| Term | Definition |
|---|---|
| **ACP** | Agent Client Protocol — an open standard letting any agent (Claude Code, Codex, Gemini, OpenCode) be talked to via the same wire format. |
| **APNs** | Apple Push Notification Service. |
| **bincode** | Compact Rust-native binary serialization format. |
| **cargo-dist** | Tool by axodotdev that generates cross-platform installers and release artifacts. |
| **CGNAT** | Carrier-grade NAT — common on cellular networks, blocks inbound connections. |
| **dim-on-tap** | Predictive echo style: draw typed character immediately at half opacity, replace on server ack. |
| **FCM** | Firebase Cloud Messaging — Android push. |
| **FFI** | Foreign Function Interface — calling Rust from Swift/Kotlin. |
| **iroh** | Rust P2P library by n0-computer; QUIC-based, NAT-traversing. |
| **launchd** | macOS service manager. |
| **mosh** | Mobile Shell — UDP-based SSH replacement that survives network changes. |
| **PTY** | Pseudo-terminal — the kernel abstraction that lets one process control another's terminal I/O. |
| **rcodesign** | `apple-codesign` binary — pure-Rust code signer that runs on Linux. |
| **redb** | Pure-Rust embedded key-value store. |
| **SSP** | State Synchronization Protocol — mosh's predictive-echo algorithm. |
| **systemd** | Linux service manager. |
| **tokio** | The async runtime everything is built on. |
| **UniFFI** | Mozilla's Rust → Swift/Kotlin binding generator. |
| **xterm.js** | JavaScript terminal emulator, used by VS Code. |
| **Zellij** | Rust terminal multiplexer (like tmux). |

---

## 19. Appendix B — Day-1 actions checklist

Things to do **today**, before writing any code:

- [ ] **Operator: confirm npm publish rights for the platform child package family** (the unscoped `fieldwork` meta package is operator-owned; agents must not perform live availability checks for it). Platform children still need operator-controlled placeholder publishes or release publishes before announcement. This shell cannot prove platform child account ownership. After placeholder publishes or the actual v1 publish, run `node scripts/verify-npm-registry-state.mjs --expect-meta-published --expect-platform-published`; after the v1 release publish, add `--expect-latest-version=1.0.0 --expect-provenance`.
- [ ] Operator: reserve/verify control of domain `fieldwork.dev` (Namecheap or Cloudflare). `node scripts/check-domain-status.mjs --operator-refresh --require-registered --require-dns` is available only for explicit operator-requested status refreshes; it is not a routine agent check and cannot prove ownership, DNS control, or Cloudflare Pages credentials.
- [ ] Operator: create GitHub org `fieldwork-app`; create empty `fieldwork` repo inside it. `node scripts/check-github-namespace.mjs --operator-refresh --expect-available` is available only for explicit operator-requested status refreshes; it is an availability signal, not a reservation.
- [ ] Operator: reserve `@fieldworkdev` on Twitter/X.
- [ ] Open an Oracle Cloud account (slow approval, do early); add a credit card (won't be charged on Always Free).
- [ ] Apply for Apple Developer Program ($99/yr; approval takes 24-48h).
- [ ] Set up Sentry account (free tier).
- [ ] Set up Honeycomb account (free tier).
- [x] Clone the reference repos into `references/` — shallow local clones are present for the 17 repos listed in Section 17.
- [ ] Block out the next 10 weeks on calendar; communicate to anyone who depends on your time.

---

**End of plan.**

This document is the source of truth for v1 build decisions. Treat changes as a PR-able decision: update this file, link it in the PR description, get a thumbs-up (even if from yourself, after sleeping on it). The plan is not the code, but the code should always match the plan.
