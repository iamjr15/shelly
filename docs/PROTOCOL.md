# Fieldwork Protocol (v1 product, contract v3)

`CONTRACT_VERSION` is `3`. Version 3 carries a compact `PairingTicket` with a daemon-issued expiry deadline and a short 5-character pairing code; the daemon rejects `Hello` with a mismatched version.

The implemented local IPC path uses length-prefixed bincode frames over the daemon Unix socket. The protocol crate owns the bincode helpers and uses bincode 2 with its legacy configuration so v1 keeps the original fixed-int/little-endian bincode wire layout while rejecting trailing payload bytes. The implemented iroh path is mobile-only and uses the same length prefix with MessagePack payloads. Each frame is:

1. 4-byte big-endian payload length.
2. Bincode-serialized protocol message on the Unix socket, or MessagePack-serialized protocol message on iroh streams.

Protocol enums are externally tagged because bincode does not support internally tagged Serde enums. The daemon-side MessagePack transport is active, and `mobile-core` now wraps it behind a UniFFI API for Swift/Kotlin. `ClientKind::LocalCli` is accepted only on the Unix socket; an iroh `Hello` claiming `LocalCli` receives `Error { Forbidden }` before `Welcome`.

Implemented messages include `Hello`, `Welcome`, `CreateSession`, `ListSessions`, `SubscribeSessions`, `AttachSession`, `Input`, `Resize`, `DetachSession`, `KillSession`, `Output`, `Attached`, `SessionExited`, `Lag`, `BeginPairing`, `ApprovePairing`, `PairWithCode`, `PairingStarted`, `PairingApprovalRequested`, `PairingComplete`, `ListDevices`, `RemoveDevice`, `DeviceList`, `RegisterPushToken`, `UnregisterPushToken`, `Pong`, and `Error`. `PairWithCode { code, device_name, device_node_id }` replaces v1's `PairWithToken`, and `PairingStarted { ticket: PairingTicket }` replaces the v1 `PairingStarted { payload: PairingPayload }`.

Local CLI hook adapters also use `AgentStateEvent` to report Claude/Codex state
transitions to the daemon. This message is accepted from `LocalCli` only. The
daemon replies with `AgentStateChanged` after a matching hook is applied, or
`Error` when the session is missing, exited, or the hook source does not match
the session's command kind; the CLI hook exits nonzero on those errors.

PTY output is streamed as raw bytes. Clients feed those bytes directly to a terminal renderer or, for the local CLI, write them directly to the user's terminal in raw mode.

For active sessions, `AttachSession.last_seen_seq` chooses the catch-up path. If the sequence is still inside the 256 KB PTY byte ring, `Attached.initial_bytes` is verbatim replay from that sequence. If it is absent or stale, `Attached.initial_bytes` is a synthetic ANSI snapshot rendered by the daemon's `wezterm-term` model. `Attached.seq` and `Output.seq` are the monotonic byte offset immediately after the bytes carried in that message, so clients can cache the received `seq` directly as their next `last_seen_seq`.

Session-scoped `AttachSession`, `Input`, `Resize`, and local `AgentStateEvent` requests return `Error { NotFound }` when their `session_id` no longer refers to a live or restored session. The daemon does not silently accept keystrokes or viewport updates for missing sessions.

`Lag` is terminal for the current output attachment. The daemon emits one `Lag` event when an attached client's broadcast receiver overflows, then stops forwarding output on that attachment. The v1 field is named `skipped_bytes`, but its value is the skipped broadcast-message count reported by Tokio. Clients must detach or open a fresh attach stream; mobile clients use their cached `last_seen_seq` first and fall back to the daemon's synthetic snapshot if the byte ring can no longer satisfy replay.

Mobile bindings expose both one-shot list and long-lived dashboard subscription. `list_sessions()` sends `ListSessions` and returns one snapshot. `subscribe_sessions(sink)` sends `SubscribeSessions`; the daemon replies with one immediate `SessionList` and then sends replacement `SessionList` snapshots whenever a session is created, removed, exits, or changes dashboard state. Attach APIs expose both cold attach and warm attach. `attach_session(id)` sends no offset; `attach_session_from(id, last_seen_seq)` sends the saved raw PTY byte offset. Native apps cache `AttachedSession.last_seen_seq()` per session while attached and reattach with that value after backgrounding, reconnecting, or receiving `Lag`.

`fieldwork pair` is local-CLI-only. It generates a single active 5-character Crockford pairing code (5-minute TTL, `OsRng`) and builds a `PairingTicket { code, node_id, relay_url, addrs, expires_at }`. Starting a new desktop pairing prompt supersedes any previous active code. The ticket encodes to `fw1<base32>` (postcard bytes wrapped in unpadded, case-insensitive base32 behind the `fw1` prefix); the daemon sends it in `PairingStarted { ticket }`, and the CLI prints it as a QR plus the bare code for manual entry with a live countdown to the expiry deadline. A remote iroh client obtains the ticket — by scanning the QR (which carries reachability and the code directly) or by resolving the typed code to the same ticket through the relay rendezvous — then connects with its own iroh node identity, sends `PairWithCode { code, device_name, device_node_id }`, and waits for the desktop CLI to approve through `ApprovePairing`. The daemon normalizes the submitted code (uppercasing, Crockford `I`/`L`→`1` and `O`→`0`), verifies it against the active code attempt-capped, invalidates the active code after 5 wrong attempts, and stores the remote iroh node id as the long-lived device identity.

The typed-code path uses an optional relay rendezvous, exercised only when `FIELDWORK_RELAY_CONTROL_URL` is configured. The daemon best-effort signs and posts `code → ticket_blob` (the opaque encoded `fw1…` ticket) to `POST /v1/pair/publish` with the same 5-minute expiry; if the URL is unset it logs a warning and skips publish so the QR path is unaffected. A phone resolves a typed code with `GET /v1/pair/resolve/{code}`, which is unauthenticated (the code is the credential) but throttled at 20 attempts/min per client, returns a uniform `404` on any miss, and consumes the code on a correct guess. The daemon still enforces the 5-wrong-attempt cap when the device presents the code over iroh; the relay resolver cannot attribute arbitrary wrong guesses to a specific valid code without creating a denial-of-service vector. The publish request is daemon-signed with the same `x-fieldwork-signature` scheme as push; the resolve response carries only the opaque reachability blob.

Remote iroh clients with `ClientKind::IosApp` or `ClientKind::AndroidApp` may list sessions, subscribe to session-list snapshots, attach, send input, resize, detach, ping, and register/unregister push tokens. They are rejected with `Error { Forbidden }` for `CreateSession`, `KillSession`, local pairing administration, device listing/removal, and agent hook events. `ClientKind::LocalCli` is rejected at the iroh handshake boundary; desktop CLI flows must use the local Unix socket.

`RegisterPushToken { platform, token }` and `UnregisterPushToken { platform, token }` are accepted only from a paired iroh device. The daemon stores registered tokens in encrypted `devices.redb` under a hashed row key for that device identity. Unregistration clears only the exact currently stored `(platform, token)` pair for the authenticated device, so a stale mobile token-refresh callback cannot delete a newer token. When `FIELDWORK_RELAY_CONTROL_URL` is configured, the daemon also signs and posts token ownership changes to the relay control plane:

1. `POST /v1/pair` registers the daemon node id and relay-signing Ed25519 public key.
2. `POST /v1/push/register-token` binds `(daemon_node_id, push_token, platform)` at the relay.
3. `POST /v1/push/unregister-token` removes that relay binding when mobile unpairs or the desktop device record is removed.
4. `POST /v1/push` sends `recipient_token`, `platform`, lowercase 64-character hex `session_id_hash`, lowercase 64-character hex `session_name_hash`, fixed `event_type`, `nonce`, and `ts_ms`.

`GET /v1/version` returns the relay version, minimum desktop/mobile versions, and protocol `CONTRACT_VERSION`; it does not include daemon node IDs, tokens, session hashes, or terminal metadata.

Relay signed requests carry `x-fieldwork-signature`, an Ed25519 signature over `method + "\n" + path + "\n" + body + "\n" + nonce + "\n" + ts_ms`. The relay rejects unknown JSON fields and non-hex session hashes, contractually keeping terminal content, command lines, paths, plaintext session names, and `last_line` out of push-provider payloads.
