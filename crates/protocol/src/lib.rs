#![deny(missing_docs)]
//! Versioned wire protocol shared by the Shelly daemon, CLI, relay-adjacent
//! clients, and native mobile bindings.
//!
//! Local Unix-socket IPC uses bincode frames. Remote iroh/mobile streams use the
//! same message model with MessagePack encoding so mobile bindings do not need
//! to understand Rust-specific bincode details.

/// Shared short pairing-code alphabet and normalization helpers.
pub mod code;
/// Length-prefixed bincode framing helpers for local IPC.
pub mod framing;
/// Client/server protocol messages.
pub mod messages;
/// Shared protocol data types.
pub mod types;
/// Protocol contract version.
pub mod version;

pub use code::{CODE_ALPHABET, CODE_LEN, is_valid_code, normalize_code};
pub use framing::{
    FrameError, decode_bincode, decode_frame, encode_bincode, encode_frame, max_frame_len,
};
pub use messages::{ClientToServerMsg, ErrorCode, ServerToClientMsg};
pub use types::{
    AgentSource, AgentState, Capabilities, ClientId, ClientKind, ClientSize, DeviceSummary,
    PairingTicket, PushPlatform, SessionId, SessionSummary, TicketError, now_ms,
};
pub use version::CONTRACT_VERSION;

#[cfg(test)]
mod tests {
    use super::*;
    use serde::{Serialize, de::DeserializeOwned};
    use std::collections::HashMap;
    use std::fmt::Debug;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};
    use uuid::{Uuid, Version};

    #[derive(Serialize)]
    struct RoundTripSnapshot {
        name: &'static str,
        frame_len: usize,
        decoded: String,
    }

    struct WireCase<T> {
        name: &'static str,
        message: T,
    }

    #[test]
    fn protocol_version_is_v3() {
        assert_eq!(CONTRACT_VERSION, 3);
    }

    #[test]
    fn generated_ids_are_uuidv7() {
        assert_eq!(SessionId::new().0.get_version(), Some(Version::SortRand));
        assert_eq!(ClientId::new().0.get_version(), Some(Version::SortRand));
    }

    #[test]
    fn now_ms_returns_utc_unix_epoch_milliseconds() {
        let before = current_unix_ms();
        let observed = now_ms();
        let after = current_unix_ms();

        assert!(observed >= before, "observed {observed} before {before}");
        assert!(observed <= after, "observed {observed} after {after}");
    }

    #[test]
    fn round_trips_local_hello() {
        let msg = ClientToServerMsg::Hello {
            client_kind: ClientKind::LocalCli,
            client_version: "0.1.0".to_string(),
            protocol_version: CONTRACT_VERSION,
        };

        let frame = encode_frame(&msg).unwrap();
        let decoded: ClientToServerMsg = decode_frame(&frame).unwrap();
        assert_eq!(decoded, msg);
    }

    #[test]
    fn round_trips_raw_output_bytes() {
        let msg = ServerToClientMsg::Output {
            session_id: SessionId::new(),
            seq: 42,
            bytes: b"\x1b[31mhello\x1b[0m\r\n".to_vec(),
        };

        let frame = encode_frame(&msg).unwrap();
        let decoded: ServerToClientMsg = decode_frame(&frame).unwrap();
        assert_eq!(decoded, msg);
    }

    #[test]
    fn round_trips_agent_state_event() {
        let msg = ClientToServerMsg::AgentStateEvent {
            session_id: SessionId::new(),
            source: AgentSource::Claude,
            state: AgentState::AwaitingInput,
            last_line: None,
        };

        let frame = encode_frame(&msg).unwrap();
        let decoded: ClientToServerMsg = decode_frame(&frame).unwrap();
        assert_eq!(decoded, msg);
    }

    #[test]
    fn round_trips_pairing_ticket() {
        let msg = ServerToClientMsg::PairingStarted {
            ticket: PairingTicket {
                code: "AB234".to_string(),
                node_id: "node".to_string(),
                relay_url: Some("https://relay.example".to_string()),
                addrs: vec!["127.0.0.1:1234".to_string()],
                expires_at: 1_700_000_300_000,
            },
        };

        let frame = encode_frame(&msg).unwrap();
        let decoded: ServerToClientMsg = decode_frame(&frame).unwrap();
        assert_eq!(decoded, msg);
    }

    #[test]
    fn pairing_ticket_string_round_trips_exactly() {
        let ticket = PairingTicket {
            code: "AB234".to_string(),
            node_id: "node-daemon".to_string(),
            relay_url: Some("https://relay.example".to_string()),
            addrs: vec!["127.0.0.1:1234".to_string()],
            expires_at: 1_700_000_300_000,
        };

        let encoded = ticket.encode().unwrap();
        assert!(encoded.starts_with("sh1"));
        assert_eq!(PairingTicket::decode(&encoded).unwrap(), ticket);
        // The base32 body decodes case-insensitively.
        assert_eq!(
            PairingTicket::decode(&encoded.to_lowercase()).unwrap(),
            ticket
        );
    }

    #[test]
    fn round_trips_device_admin_messages() {
        let remove = ClientToServerMsg::RemoveDevice {
            name: "Smoke Phone".to_string(),
        };
        let frame = encode_frame(&remove).unwrap();
        let decoded: ClientToServerMsg = decode_frame(&frame).unwrap();
        assert_eq!(decoded, remove);

        let list = ServerToClientMsg::DeviceList {
            devices: vec![DeviceSummary {
                name: "Smoke Phone".to_string(),
                device_node_id: "node".to_string(),
                paired_at: now_ms(),
                last_seen: Some(now_ms()),
                push_platform: Some(PushPlatform::Apns),
            }],
        };
        let frame = encode_frame(&list).unwrap();
        let decoded: ServerToClientMsg = decode_frame(&frame).unwrap();
        assert_eq!(decoded, list);
    }

    #[test]
    fn snapshot_round_trips_all_client_messages() {
        let cases: Vec<_> = client_message_cases()
            .into_iter()
            .map(snapshot_case)
            .collect();

        insta::assert_yaml_snapshot!("client_to_server_wire_round_trips", cases);
    }

    #[test]
    fn snapshot_round_trips_all_server_messages() {
        let cases: Vec<_> = server_message_cases()
            .into_iter()
            .map(snapshot_case)
            .collect();

        insta::assert_yaml_snapshot!("server_to_client_wire_round_trips", cases);
    }

    #[test]
    fn messagepack_round_trips_all_client_messages() {
        for case in client_message_cases() {
            messagepack_round_trip_case(case);
        }
    }

    #[test]
    fn messagepack_round_trips_all_server_messages() {
        for case in server_message_cases() {
            messagepack_round_trip_case(case);
        }
    }

    fn snapshot_case<T>(case: WireCase<T>) -> RoundTripSnapshot
    where
        T: Serialize + DeserializeOwned + Debug + PartialEq,
    {
        let frame = encode_frame(&case.message).unwrap();
        let decoded: T = decode_frame(&frame).unwrap();
        assert_eq!(decoded, case.message, "{}", case.name);
        RoundTripSnapshot {
            name: case.name,
            frame_len: frame.len(),
            decoded: format!("{decoded:?}"),
        }
    }

    fn messagepack_round_trip_case<T>(case: WireCase<T>)
    where
        T: Serialize + DeserializeOwned + Debug + PartialEq,
    {
        let frame = encode_messagepack_frame(&case.message);
        let decoded: T = decode_messagepack_frame(&frame);
        assert_eq!(decoded, case.message, "{}", case.name);
    }

    fn encode_messagepack_frame<T: Serialize>(message: &T) -> Vec<u8> {
        let payload = rmp_serde::to_vec_named(message).unwrap();
        assert!(payload.len() <= max_frame_len());

        let mut frame = Vec::with_capacity(4 + payload.len());
        frame.extend_from_slice(&(payload.len() as u32).to_be_bytes());
        frame.extend_from_slice(&payload);
        frame
    }

    fn decode_messagepack_frame<T: DeserializeOwned>(frame: &[u8]) -> T {
        assert!(frame.len() >= 4);
        let len = u32::from_be_bytes(frame[0..4].try_into().unwrap()) as usize;
        assert!(len <= max_frame_len());
        assert!(frame.len() >= 4 + len);
        rmp_serde::from_slice(&frame[4..4 + len]).unwrap()
    }

    fn client_message_cases() -> Vec<WireCase<ClientToServerMsg>> {
        let session_id = fixed_session_id();
        let client_id = fixed_client_id();
        let mut env = HashMap::new();
        env.insert("SHELLY_TEST".to_string(), "1".to_string());
        vec![
            wire_case(
                "hello",
                ClientToServerMsg::Hello {
                    client_kind: ClientKind::LocalCli,
                    client_version: "0.1.0".to_string(),
                    protocol_version: CONTRACT_VERSION,
                },
            ),
            wire_case("list_sessions", ClientToServerMsg::ListSessions),
            wire_case(
                "create_session",
                ClientToServerMsg::CreateSession {
                    name: "demo".to_string(),
                    command: vec!["bash".to_string(), "-lc".to_string(), "echo hi".to_string()],
                    cwd: PathBuf::from("/tmp/shelly"),
                    env,
                    size: ClientSize {
                        cols: 100,
                        rows: 30,
                    },
                },
            ),
            wire_case(
                "attach_session",
                ClientToServerMsg::AttachSession {
                    session_id,
                    size: ClientSize { cols: 80, rows: 24 },
                    last_seen_seq: Some(128),
                },
            ),
            wire_case("detach_session", ClientToServerMsg::DetachSession),
            wire_case(
                "kill_session",
                ClientToServerMsg::KillSession { session_id },
            ),
            wire_case(
                "input",
                ClientToServerMsg::Input {
                    session_id,
                    bytes: b"hello\n".to_vec(),
                },
            ),
            wire_case(
                "resize",
                ClientToServerMsg::Resize {
                    session_id,
                    size: ClientSize {
                        cols: 120,
                        rows: 40,
                    },
                },
            ),
            wire_case("ping", ClientToServerMsg::Ping { seq: 7 }),
            wire_case(
                "begin_pairing",
                ClientToServerMsg::BeginPairing {
                    device_name: Some("Phone".to_string()),
                },
            ),
            wire_case(
                "approve_pairing",
                ClientToServerMsg::ApprovePairing {
                    request_id: client_id,
                    approved: true,
                },
            ),
            wire_case(
                "pair_with_code",
                ClientToServerMsg::PairWithCode {
                    code: "AB234".to_string(),
                    device_name: "Phone".to_string(),
                    device_node_id: "node-phone".to_string(),
                },
            ),
            wire_case("list_devices", ClientToServerMsg::ListDevices),
            wire_case(
                "remove_device",
                ClientToServerMsg::RemoveDevice {
                    name: "Phone".to_string(),
                },
            ),
            wire_case(
                "register_push_token",
                ClientToServerMsg::RegisterPushToken {
                    platform: PushPlatform::Apns,
                    token: "opaque-token".to_string(),
                },
            ),
            wire_case(
                "agent_state_event",
                ClientToServerMsg::AgentStateEvent {
                    session_id,
                    source: AgentSource::Claude,
                    state: AgentState::AwaitingInput,
                    last_line: Some("Continue?".to_string()),
                },
            ),
            wire_case("subscribe_sessions", ClientToServerMsg::SubscribeSessions),
            wire_case(
                "unregister_push_token",
                ClientToServerMsg::UnregisterPushToken {
                    platform: PushPlatform::Apns,
                    token: "opaque-token".to_string(),
                },
            ),
        ]
    }

    fn server_message_cases() -> Vec<WireCase<ServerToClientMsg>> {
        let session_id = fixed_session_id();
        let client_id = fixed_client_id();
        let summary = fixed_summary(session_id);
        let device = DeviceSummary {
            name: "Phone".to_string(),
            device_node_id: "node-phone".to_string(),
            paired_at: 1_700_000_000_000,
            last_seen: Some(1_700_000_000_001),
            push_platform: Some(PushPlatform::Fcm),
        };
        vec![
            wire_case(
                "welcome",
                ServerToClientMsg::Welcome {
                    client_id,
                    daemon_version: "0.1.0".to_string(),
                    capabilities: Capabilities::v1(true),
                },
            ),
            wire_case(
                "session_list",
                ServerToClientMsg::SessionList {
                    sessions: vec![summary.clone()],
                },
            ),
            wire_case(
                "session_created",
                ServerToClientMsg::SessionCreated {
                    session_id,
                    summary: summary.clone(),
                },
            ),
            wire_case(
                "attached",
                ServerToClientMsg::Attached {
                    session_id,
                    initial_bytes: b"\x1b[Hready".to_vec(),
                    seq: 42,
                },
            ),
            wire_case(
                "output",
                ServerToClientMsg::Output {
                    session_id,
                    seq: 48,
                    bytes: b"output".to_vec(),
                },
            ),
            wire_case(
                "agent_state_changed",
                ServerToClientMsg::AgentStateChanged {
                    session_id,
                    state: AgentState::AwaitingInput,
                    last_line: Some("Approve?".to_string()),
                },
            ),
            wire_case(
                "session_exited",
                ServerToClientMsg::SessionExited {
                    session_id,
                    exit_code: 0,
                },
            ),
            wire_case(
                "lag",
                ServerToClientMsg::Lag {
                    session_id,
                    skipped_bytes: 3,
                },
            ),
            wire_case(
                "pairing_started",
                ServerToClientMsg::PairingStarted {
                    ticket: PairingTicket {
                        code: "AB234".to_string(),
                        node_id: "node-daemon".to_string(),
                        relay_url: Some("https://relay.example".to_string()),
                        addrs: vec!["127.0.0.1:1234".to_string()],
                        expires_at: 1_700_000_300_000,
                    },
                },
            ),
            wire_case(
                "pairing_approval_requested",
                ServerToClientMsg::PairingApprovalRequested {
                    request_id: client_id,
                    device_name: "Phone".to_string(),
                    device_node_id: "node-phone".to_string(),
                },
            ),
            wire_case(
                "pairing_complete",
                ServerToClientMsg::PairingComplete {
                    daemon_node_id: "node-daemon".to_string(),
                },
            ),
            wire_case(
                "device_list",
                ServerToClientMsg::DeviceList {
                    devices: vec![device],
                },
            ),
            wire_case("pong", ServerToClientMsg::Pong { seq: 7 }),
            wire_case(
                "error",
                ServerToClientMsg::Error {
                    code: ErrorCode::Forbidden,
                    message: "mobile clients cannot create sessions".to_string(),
                },
            ),
        ]
    }

    fn wire_case<T>(name: &'static str, message: T) -> WireCase<T> {
        WireCase { name, message }
    }

    fn fixed_session_id() -> SessionId {
        SessionId(Uuid::from_u128(0x018f_0000_0000_7000_8000_0000_0000_0001))
    }

    fn fixed_client_id() -> ClientId {
        ClientId(Uuid::from_u128(0x018f_0000_0000_7000_8000_0000_0000_0002))
    }

    fn current_unix_ms() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis()
            .try_into()
            .unwrap()
    }

    fn fixed_summary(id: SessionId) -> SessionSummary {
        SessionSummary {
            id,
            name: "demo".to_string(),
            command: vec!["bash".to_string()],
            cwd: PathBuf::from("/tmp/shelly"),
            created_at: 1_700_000_000_000,
            last_activity: 1_700_000_000_010,
            state: AgentState::Working,
            last_line: Some("ready".to_string()),
            model: None,
        }
    }
}
