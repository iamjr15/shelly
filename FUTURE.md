# Shelly — Future Roadmap

**Companion to**: `PLAN.md` (the v1 build plan)
**Last updated**: 2026-05-17

This document captures everything that is **not** in v1. Anything in `PLAN.md` is currently being built; anything in this file is queued for after v1 ships or explicitly out of scope.

The split exists so `PLAN.md` stays focused on what's actually being implemented and the v1 success criteria don't blur into "what we might do someday." When a future item gets picked up for active work, move it from here into `PLAN.md` (and bump version targets accordingly).

---

## 1. v1.1 (target: +4 weeks post-v1)

- **OpenCode state inference** (`AwaitingInput` detection + push) — ~150-250 LOC inference module under `crates/daemon/src/state_infer/`. OpenCode runs fine on v1 (universal handoff); v1.1 adds the push integration. Same dispatch pattern as the Claude Code and Codex modules already shipped in v1.
- **Pin sessions** ("watch this") with priority push. Pinned sessions sort to the top of the mobile list and get push at higher priority (per-thread sound, no Do Not Disturb bypass).
- **Tap-to-correct voice input** on iOS via `SFSpeechRecognizer` — native, on-device, no API cost. User dictates, taps any misrecognized word to correct before submitting. Solves the "Whisper said `for loop` and I meant `4 loop`" problem.
- **Android terminal renderer hardening** — v1 ships with `connectbot/termlib`, so there is no v1.1 migration from xterm.js/WebView. Post-v1 work here is limited to physical-device dogfood findings, upstream termlib upgrades, and renderer polish that does not change the v1 raw-byte protocol.
- **Android foreground-service hardening** — only if physical-device dogfood shows background execution gaps that cannot be solved by the current reconnect/replay path and FCM wake behavior.
- **Predictive local echo** — evaluate RoSE/mosh SSP only if physical mobile dogfood shows unacceptable typing latency after v1. Any adoption must preserve the v1 raw-byte terminal contract and remain transparent to arbitrary shells and TUIs.
- **Negotiated transport compression for PTY byte streams** — only if physical mobile/network dogfood shows raw-byte streaming stutter that cannot be fixed with batching/backpressure. This must preserve the v1 terminal contract: raw PTY bytes into native terminal renderers, never cell-grid diffs.
- **`keyring` v3 → v4 migration** when 4.0 stable lands (likely Q3 2026). Small API change (`set_default_store` instead of `set_default_credential_builder`).
- **Native Windows host support** — proper named-pipe IPC, Windows service install design, Windows code signing. Cut from v1 to keep solo timeline realistic; promoted to v1.1's primary deliverable.

## 2. v1.2 (target: +8 weeks post-v1)

- **Aider state-inference module**. Four agents with first-class push total (Claude Code + Codex from v1; OpenCode from v1.1; Aider added here). All four were *runnable* since v1 — these later versions just add the push integration per agent.
- **Generic ACP (Agent Client Protocol) adapter** — instead of writing a state-inference module per agent, support the open ACP protocol so any ACP-compliant agent gets push for free (Goose, Pi, Droid, future agents).
- **Live Activities (iOS)** for active sessions — visible in Dynamic Island. Glanceable session state without unlocking the phone.
- **Self-hostable relay Docker image** — one-line `docker run shelly/relay` for users who don't want their NodeID/IP touching our infrastructure. Includes a provider-neutral Terraform module and quickstart for low-cost VPS hosts.

## 3. v1.3 (target: +12 weeks post-v1)

- **Apple Watch app** — session status complication on the watch face. Approve incoming `AwaitingInput` prompts from the wrist with `y/n`. Crown for scrubbing through recent agent output.
- **Image paste / drag** — phone camera roll image becomes input to Claude Code (multimodal). Tap-and-hold in terminal view → "paste image". Image bytes sent over iroh as a special `Input { kind: Image, bytes }` variant.
- **Multi-host** — connect to multiple daemons from one phone (e.g., personal Mac + work Mac + Hetzner vibe-server). Sessions list shows host badge per card; switching hosts is a top-level swipe.

## 4. v2.0 (target: 6 months post-v1)

- **Voice mode** — full-duplex via Whisper Realtime. Push-to-talk + ambient listening modes. Direct voice → agent input, streamed back as TTS with the option to read agent responses aloud.
- **Teams** — shared session inboxes (whole team sees what the agent is doing), RBAC (who can attach to which agent), audit logs (every input + state change), SSO via OAuth providers.
- **Cloud-sandbox option** — E2B integration. Users without their own host machine spin up an ephemeral Firecracker microVM with Claude Code pre-installed. Pay-per-minute compute charged through the Pro tier.
- **Hosted sandbox option** — user-facing packaging for the cloud-sandbox path above. v1 stays laptop-hosted; no hosted execution environment ships in the initial release.
- **Plugin protocol** — formal extension API for third-party agents, custom UI panels, integrations. Probably WASM-based for cross-platform safety.
- **Billing and paid Pro tier** ($5–10/mo): cloud sandbox credits, longer history retention (30 days vs 7), multi-device sync of pins/settings, priority push, organization workspace.

## 5. Long-term (12+ months out)

- **AI-assisted session summarization** — TL;DR for sessions that have been running 30+ minutes. "Here's what Claude did while you were gone: …"
- **Cross-device handoff between iOS and Android** — Continuity-style. "Resume on iPhone" toast appears on Android when an iOS-paired session is active, and vice versa.

## 6. Explicitly out of scope (now and forever, unless re-litigated)

- **Native desktop GUI apps on macOS, Linux, or Windows.** The CLI + TUI is the desktop story. Phone is the GUI story. Adding a Mac/Linux/Windows GUI app would triple the maintained surface area without addressing a real user pain — desktop users already have their terminal. (Note: the **CLI** itself runs on all three desktop platforms; this is specifically about a SwiftUI/GTK/libcosmic/WinUI **GUI** app.)
- **IDE or editor-overlay surfaces.** Shelly v1 is a universal terminal handoff product, not an IDE or editor overlay. Any IDE-specific surface would be a separate product decision after the terminal contract has real-device mileage.
- **Homebrew tap, `curl | sh`, `cargo install`, `winget`, `scoop`, `apt` distribution.** npm-only by design. Discovery is solved via content marketing and integrations, not registry SEO.
- **Mac Catalyst** for any future Mac surface. If a Mac GUI is ever built (which is out of scope per above), it would be fully native SwiftUI, not Catalyst.
- **Zulip community** — Discord has the bigger indie-dev reach.
- **Open Collective, Patreon** — GitHub Sponsors only.
- **`napi-rs` distribution** — wrong abstraction for non-addon CLIs.
- **cargo-dist's npm installer** — uses the deprecated postinstall-download pattern that esbuild abandoned in 2021.
- **wasm-only fallback** — 10x slower per esbuild's docs; useless for an interactive CLI.

## 7. Watch list — newer crates/tools to evaluate as they mature

Tracked but not adopted for v1. Revisit at each minor version cut.

| Item | Why interesting | When to revisit |
|---|---|---|
| **BoltFFI** (`boltffi/boltffi`) | Claims 1000× speedup over UniFFI via zero-copy. v0.24.1 Apr 2026 but only 4 contributors and <6 months in the wild. | When it hits 1.0 + has 2+ production deployments. Could meaningfully cut mobile FFI overhead. |
| **Pavex** (Luca Palmieri's compile-time DI framework) | Eliminates whole classes of axum extractor runtime errors via compile-time DI. Moved alpha → beta late 2025; ecosystem still thin. | When it goes 1.0 with stable middleware/OTel/OpenAPI story. |
| **libghostty-vt on iOS** | Ghostty's terminal engine, usable for embedding. Geistty and Spectty demonstrated it works on iOS Metal at 120fps. API still "in flux." | When Ghostty tags a stable `libghostty` release. Could replace SwiftTerm for unified Rust core. |
| **Native Compose+Skia terminal renderer on Android** | Would let us drop the libvterm JNI dependency. No one has shipped this yet — would need to build or adopt. | When someone ships one (or we do, post-v1). |
| **Turso libSQL** | Full SQLite rewrite in pure Rust by Turso. Enables embedded replicas (multi-region active-active relay). | If we ever need multi-region relay replication. SQLite is fine for v1 single-region. |
| **sockudo-ws** | Faster than tokio-websockets (~17%), only Rust WS lib with HTTP/3 WebSocket and io_uring transport. v1.7.4 Dec 2025, single company behind it. | When it has 12+ months of production use. |
| **release-hub** | Alternative to `self_update` with mandatory minisign verification of artifacts. v0.3.0 Apr 2026. | If supply-chain integrity becomes a documented requirement. (Note: v1 has no self-update path — updates flow through npm. This is only relevant if we ever add self-update.) |
| **keyring v4** | Redesigned API (`set_default_store` instead of `set_default_credential_builder`). Currently 4.0.0-rc.3 (Feb 2026). | When 4.0 stable lands (likely Q3 2026). Migration scheduled for v1.1. |
| **OpenTelemetry-rust OTLP stabilization** | Still pre-1.0 and churning (issue #3061). Budget for a breaking migration in next 6-12 months. | When 1.0 lands. Mandatory — no production-ready alternative. |
| **Anthropic Claude Code Stop hook `turn_status` field** | Would let agent state inference drop the regex-based prompt detection and rely on a structured signal. Open feature request (anthropics/claude-code#49574). | When Anthropic ships it. Replaces a fragile heuristic with a clean signal. |
| **Kani model-checker harnesses** | Could add bounded exhaustive checks for pure pair-token parsing, QR payload parsing, NodeId validation, and auth handshake state machines. v1 relies on focused Rust tests, proptests, protocol snapshots, authz tests, and local handoff smoke instead. | When the v1 protocol/auth code has stabilized after real-device dogfood, or before any high-risk auth refactor. |

## 8. How to use this document

- **When considering scope creep**: check if the proposed feature is already on this list. If yes, defer. If no, decide whether to add it here or reject.
- **When v1 ships**: promote v1.1 items into PLAN.md, bump the v1.x stack down by one. Update this file's targets.
- **When a watch-list item matures**: move it from Watch list into the relevant version section once committed.
- **When something on the "out of scope forever" list comes up again**: read this file before agreeing to it. The rationale is here for a reason.

---

**The plan stays clean by deferring to this file.** If it's not v1, it's here. PLAN.md should never list "future" or "post-v1" features — link here instead.
