# Fieldwork Protocol v1

`CONTRACT_VERSION` is `1`.

The implemented local IPC path uses length-prefixed bincode frames over the daemon Unix socket. The implemented iroh path uses the same length prefix with MessagePack payloads. Each frame is:

1. 4-byte big-endian payload length.
2. Bincode-serialized protocol message on the Unix socket, or MessagePack-serialized protocol message on iroh streams.

Protocol enums are externally tagged because bincode does not support internally tagged Serde enums. The daemon-side MessagePack transport is active, and `mobile-core` now wraps it behind a UniFFI API for Swift/Kotlin.

Implemented messages include `Hello`, `Welcome`, `CreateSession`, `ListSessions`, `SubscribeSessions`, `AttachSession`, `Input`, `Resize`, `DetachSession`, `KillSession`, `Output`, `Attached`, `SessionExited`, `Lag`, `BeginPairing`, `ApprovePairing`, `PairWithToken`, `PairingStarted`, `PairingApprovalRequested`, `PairingComplete`, `ListDevices`, `RemoveDevice`, `DeviceList`, `RegisterPushToken`, `Pong`, and `Error`.

Local CLI hook adapters also use `AgentStateEvent` to report Claude/Codex state transitions to the daemon. This message is accepted from `LocalCli` only.

PTY output is streamed as raw bytes. Clients feed those bytes directly to a terminal renderer or, for the local CLI, write them directly to the user's terminal in raw mode.

For active sessions, `AttachSession.last_seen_seq` chooses the catch-up path. If the sequence is still inside the 256 KB PTY byte ring, `Attached.initial_bytes` is verbatim replay from that sequence. If it is absent or stale, `Attached.initial_bytes` is a synthetic ANSI snapshot rendered by the daemon's `wezterm-term` model. `Attached.seq` and `Output.seq` are the monotonic byte offset immediately after the bytes carried in that message, so clients can cache the received `seq` directly as their next `last_seen_seq`.

`Lag` is terminal for the current output attachment. The daemon emits one `Lag` event when an attached client's broadcast receiver overflows, then stops forwarding output on that attachment. The v1 field is named `skipped_bytes`, but its value is the skipped broadcast-message count reported by Tokio. Clients must detach or open a fresh attach stream; mobile clients use their cached `last_seen_seq` first and fall back to the daemon's synthetic snapshot if the byte ring can no longer satisfy replay.

Mobile bindings expose both one-shot list and long-lived dashboard subscription. `list_sessions()` sends `ListSessions` and returns one snapshot. `subscribe_sessions(sink)` sends `SubscribeSessions`; the daemon replies with one immediate `SessionList` and then sends replacement `SessionList` snapshots whenever a session is created, removed, exits, or changes dashboard state. Attach APIs expose both cold attach and warm attach. `attach_session(id)` sends no offset; `attach_session_from(id, last_seen_seq)` sends the saved raw PTY byte offset. Native apps cache `AttachedSession.last_seen_seq()` per session while attached and reattach with that value after backgrounding, reconnecting, or receiving `Lag`.

`fieldwork pair` is local-CLI-only. It creates a single-use 10-minute pair token and prints a QR payload containing the daemon node id, relay URL, direct addresses, token, and expiry. A remote iroh client must connect with its own iroh node identity, send `PairWithToken`, and wait for the desktop CLI to approve through `ApprovePairing`. The daemon stores the remote iroh node id as the long-lived device identity.

Remote iroh clients with `ClientKind::IosApp` or `ClientKind::AndroidApp` may list sessions, subscribe to session-list snapshots, attach, send input, resize, detach, ping, and register push tokens. They are rejected with `Error { Forbidden }` for `CreateSession`, `KillSession`, local pairing administration, device listing/removal, and agent hook events.

`RegisterPushToken { platform, token }` is accepted only from a paired iroh device. The daemon stores the token in encrypted `devices.redb` under a hashed row key for that device identity. When `FIELDWORK_RELAY_CONTROL_URL` is configured, the daemon also signs and posts token ownership to the relay control plane:

1. `POST /v1/pair` registers the daemon node id and relay-signing Ed25519 public key.
2. `POST /v1/push/register-token` binds `(daemon_node_id, push_token, platform)` at the relay.
3. `POST /v1/push/unregister-token` removes that relay binding when the desktop device record is removed.
4. `POST /v1/push` sends `recipient_token`, `platform`, lowercase 64-character hex `session_id_hash`, lowercase 64-character hex `session_name_hash`, fixed `event_type`, `nonce`, and `ts_ms`.

`GET /v1/version` returns the relay version, minimum desktop/mobile versions, and protocol `CONTRACT_VERSION`; it does not include daemon node IDs, tokens, session hashes, or terminal metadata.

Relay signed requests carry `x-fieldwork-signature`, an Ed25519 signature over `method + "\n" + path + "\n" + body + "\n" + nonce + "\n" + ts_ms`. The relay rejects unknown JSON fields and non-hex session hashes, contractually keeping terminal content, command lines, paths, plaintext session names, and `last_line` out of push-provider payloads.
