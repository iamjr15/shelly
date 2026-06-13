# Security Model

This document describes the v1 product security model. For vulnerability
reporting, use the root [`SECURITY.md`](../SECURITY.md).

## Trust Boundaries

Fieldwork v1 has four trust zones:

- **Local desktop CLI**: trusted to create and kill sessions because it runs as
  the same user as `fieldworkd` over the hardened Unix socket.
- **Daemon**: owns PTYs, device registry, scrollback, pairing approval, local
  state inference, relay-signing keys, and push-token registration dispatch.
- **Paired mobile devices**: authenticated by long-lived Ed25519/iroh identity
  after pairing (scanning the QR ticket or typing the 5-character code). They can
  list, subscribe, attach, send input, resize, detach, and register/unregister
  push tokens. They cannot create sessions, kill sessions, or specify commands.
- **Relay**: sees daemon node IDs, daemon relay public keys, push tokens, opaque
  session hashes, source IPs, aggregate metrics, provider delivery status, and —
  only on the typed-code pairing path — short pairing codes mapped to opaque
  reachability blobs (5-minute TTL, per-client resolve throttling, uniform
  misses, and single-use successful resolves). The QR pairing path stays
  daemon-local. The daemon still owns the in-band wrong-attempt cap before
  desktop approval. The relay must never receive terminal bytes, command lines,
  paths, plaintext session names, or local scrollback.

## Local IPC

The daemon control socket is local-only and user-owned:

- Parent directory is owned by the user, mode `0700`, and rejected if it is a
  symlink.
- Socket file mode is `0600`.
- IPC uses length-prefixed bincode and rejects `CONTRACT_VERSION` mismatches.
- `CreateSession` and `KillSession` are authorized only for `LocalCli`.

## Pairing And Device Auth

Pairing is intentionally two-step:

- The credential is a single active 5-character Crockford code (`OsRng`,
  confusable-free alphabet, ~25 bits, 5-minute TTL). Starting a new desktop
  pairing prompt supersedes any previous active code, and the daemon invalidates
  the active code after 5 wrong in-band attempts. A device gets the code either
  by scanning the QR ticket (which carries it inline) or by typing it; the typed
  code is resolved to the daemon's reachability through the rate-limited relay
  rendezvous.
- A QR scan or correct code is not enough: the desktop must explicitly approve
  the request.
- Approved devices authenticate with long-lived Ed25519/iroh keys.
- Lost devices are revoked through `fieldwork devices remove`; there is no
  password fallback.

## At-Rest Storage

By default, the daemon stores scrollback/session summaries and paired device
registry data encrypted in redb with OS-keychain-held keys. Device registry rows
use hashed row keys, so raw device node IDs and push tokens live only inside the
encrypted row payload. Keychain prompts are only for local key material;
terminal output, keystrokes, commands, paths, session names, and push tokens are
not stored there. The explicit opt-out is:

```sh
fieldwork settings scrollback-encryption off
```

The opt-out applies after daemon restart and makes future local persistence
plaintext until encryption is turned back on.

Android pairing records use encrypted, backup-excluded preferences. iOS pairing
storage is deferred with the parked iOS app source.

## Terminal Privacy

The daemon streams raw PTY bytes only to authenticated attached clients. It keeps
a local wezterm-term model for state inference and synthetic ANSI snapshots, but
does not send cell-grid diffs over the protocol.

Push payloads contain only fixed enum-derived copy and opaque hashes. The relay
schema rejects user-content fields such as terminal content, command lines,
paths, session names, or `last_line`.

## Relay Controls

Relay push endpoints require:

- Daemon public-key registration.
- Ed25519 request signatures.
- Nonce replay protection.
- Timestamp skew checks.
- Push-token ownership binding to the registering daemon.
- garde request validation.
- Per-daemon rate limiting.
- Relay-only FCM service-account JSON and Honeycomb credentials.

Relay telemetry is aggregate-only. Honeycomb credentials are loaded only by the
relay service through credential paths and are redacted from debug output. The
relay OTLP exporter uses OpenTelemetry's Reqwest rustls native-root feature so
Honeycomb TLS follows the host OS trust store; relay OTLP loopback coverage
guards the Fieldwork-owned telemetry path against leaking terminal, session, or
token sentinels.

NPM publish credentials (`NPM_TOKEN` / `NODE_AUTH_TOKEN`) live only in the
operator environment or GitHub Secrets. Do not commit repository `.npmrc` files,
literal npm token strings, npm auth-token environment assignments, FCM
service-account JSON, or Honeycomb API keys.

## Mobile Runtime Gates

Android gates app resume and stale terminal input with biometric-only policies.
Android emulator QA can compile a local bypass only with
`FIELDWORK_ANDROID_BIOMETRIC_BYPASS=true`; the runtime check still requires
`BuildConfig.DEBUG`, and release builds hardcode the bypass off. Release
verification still requires physical devices for biometric prompt behavior,
notification tap-through, foreground/background reconnect, network-change
reconnect, and terminal flood rendering.

## Verification

Local security coverage should include the core Rust tests plus the handoff and
relay smoke tests:

```sh
cargo fmt --check
cargo clippy --workspace -- -D warnings
cargo nextest run --workspace
cargo test --workspace --doc
scripts/smoke-local-handoff.sh
pnpm test:relay-tls
pnpm test:relay-otlp
```

The remaining release gates require real provider credentials, signed release
artifacts, hosted relay deployment, npm provenance visibility, and physical
Android devices. Notarized Mac app/pkg artifacts remain optional and deferred;
the npm desktop path uses ad-hoc-signed CLI/daemon artifacts.
