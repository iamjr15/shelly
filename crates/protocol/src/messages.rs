use crate::types::{
    AgentSource, AgentState, Capabilities, ClientId, ClientKind, ClientSize, DeviceSummary,
    PairingTicket, PushPlatform, SessionId, SessionSummary,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
/// Messages sent by CLI or mobile clients to the daemon.
pub enum ClientToServerMsg {
    /// First frame on every connection; establishes client kind and contract version.
    Hello {
        /// Authorization class requested by the client.
        client_kind: ClientKind,
        /// Client package version for diagnostics.
        client_version: String,
        /// Protocol contract version; must match [`crate::CONTRACT_VERSION`].
        protocol_version: u32,
    },
    /// Requests the current dashboard session list.
    ListSessions,
    /// Creates a new PTY session; accepted only from [`ClientKind::LocalCli`].
    CreateSession {
        /// User-facing session label.
        name: String,
        /// Command and arguments to spawn in the PTY.
        command: Vec<String>,
        /// Working directory for the spawned command.
        cwd: PathBuf,
        /// Extra environment variables to add to the PTY child.
        env: HashMap<String, String>,
        /// Initial PTY viewport.
        size: ClientSize,
    },
    /// Attaches to an existing session and selects replay or snapshot catch-up.
    AttachSession {
        /// Session to attach.
        session_id: SessionId,
        /// Client viewport for minimum-size resize arbitration.
        size: ClientSize,
        /// Last byte offset seen by the client for warm reconnect replay.
        last_seen_seq: Option<u64>,
    },
    /// Detaches the current connection without terminating the PTY session.
    DetachSession,
    /// Terminates a PTY session; accepted only from [`ClientKind::LocalCli`].
    KillSession {
        /// Session to terminate.
        session_id: SessionId,
    },
    /// Writes raw input bytes to the PTY.
    Input {
        /// Target session.
        session_id: SessionId,
        /// Raw bytes to write to the child process.
        bytes: Vec<u8>,
    },
    /// Updates the attached client's viewport.
    Resize {
        /// Target session.
        session_id: SessionId,
        /// New viewport size.
        size: ClientSize,
    },
    /// Lightweight liveness check.
    Ping {
        /// Opaque sequence echoed in [`ServerToClientMsg::Pong`].
        seq: u64,
    },
    /// Starts QR pairing; accepted only from [`ClientKind::LocalCli`].
    BeginPairing {
        /// Optional desktop-provided label hint for the device.
        device_name: Option<String>,
    },
    /// Answers a pending desktop pairing approval prompt.
    ApprovePairing {
        /// Request id from [`ServerToClientMsg::PairingApprovalRequested`].
        request_id: ClientId,
        /// Whether the user approved the pairing.
        approved: bool,
    },
    /// Presents a short pairing code from a remote device.
    PairWithCode {
        /// Normalized short pairing code; verified attempt-capped by the daemon.
        code: String,
        /// User-facing mobile device name.
        device_name: String,
        /// Remote iroh node id; must match the authenticated connection peer.
        device_node_id: String,
    },
    /// Lists paired devices; accepted only from [`ClientKind::LocalCli`].
    ListDevices,
    /// Removes a paired device by name or node id; accepted only from [`ClientKind::LocalCli`].
    RemoveDevice {
        /// Stored device name or device node id.
        name: String,
    },
    /// Registers a mobile push token for the authenticated paired device.
    RegisterPushToken {
        /// Provider that issued the token.
        platform: PushPlatform,
        /// Opaque provider token; stored encrypted locally and registered with relay when enabled.
        token: String,
    },
    /// Local agent hook event used by supported Claude/Codex integrations.
    AgentStateEvent {
        /// Session whose state should be updated.
        session_id: SessionId,
        /// Agent integration that produced the event.
        source: AgentSource,
        /// New inferred state.
        state: AgentState,
        /// Optional sanitized line preview supplied by the hook.
        last_line: Option<String>,
    },
    /// Subscribes to complete dashboard session-list snapshots.
    ///
    /// The daemon sends one immediate [`ServerToClientMsg::SessionList`] and
    /// then sends a replacement list whenever sessions are created, removed, or
    /// their dashboard state changes.
    SubscribeSessions,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
/// Messages sent by the daemon to CLI or mobile clients.
pub enum ServerToClientMsg {
    /// Successful handshake response.
    Welcome {
        /// Server-assigned id for this connection.
        client_id: ClientId,
        /// Daemon package version.
        daemon_version: String,
        /// Feature flags active for this daemon.
        capabilities: Capabilities,
    },
    /// Current dashboard session list.
    SessionList {
        /// Summaries sorted by creation time.
        sessions: Vec<SessionSummary>,
    },
    /// A desktop-created session has been spawned.
    SessionCreated {
        /// New session id.
        session_id: SessionId,
        /// Initial dashboard summary.
        summary: SessionSummary,
    },
    /// Attach response containing initial replay or synthetic snapshot bytes.
    Attached {
        /// Attached session id.
        session_id: SessionId,
        /// Initial terminal byte stream for client renderer hydration.
        initial_bytes: Vec<u8>,
        /// Monotonic byte offset after `initial_bytes`.
        seq: u64,
    },
    /// Raw PTY output broadcast to attached clients.
    Output {
        /// Session that produced the bytes.
        session_id: SessionId,
        /// Monotonic byte offset after this output chunk.
        seq: u64,
        /// Raw PTY bytes.
        bytes: Vec<u8>,
    },
    /// Inferred agent state changed.
    AgentStateChanged {
        /// Session whose state changed.
        session_id: SessionId,
        /// New state.
        state: AgentState,
        /// Sanitized dashboard preview; never used in push payloads.
        last_line: Option<String>,
    },
    /// The PTY child process exited.
    SessionExited {
        /// Exited session id.
        session_id: SessionId,
        /// Process exit code normalized by the daemon.
        exit_code: i32,
    },
    /// The subscriber overflowed and must resync by reattaching.
    Lag {
        /// Session whose output was skipped.
        session_id: SessionId,
        /// Number of broadcast messages skipped by the receiver.
        skipped_bytes: u64,
    },
    /// Pairing ticket is ready for QR display and relay publication.
    PairingStarted {
        /// Compact pairing ticket carrying reachability and the short code.
        ticket: PairingTicket,
    },
    /// A remote device is waiting for explicit desktop approval.
    PairingApprovalRequested {
        /// Request id to pass to [`ClientToServerMsg::ApprovePairing`].
        request_id: ClientId,
        /// Device name supplied by the remote client.
        device_name: String,
        /// Authenticated iroh node id of the remote client.
        device_node_id: String,
    },
    /// Pairing succeeded and the daemon id is confirmed.
    PairingComplete {
        /// Paired daemon iroh node id.
        daemon_node_id: String,
    },
    /// Current paired-device list.
    DeviceList {
        /// Stored paired devices.
        devices: Vec<DeviceSummary>,
    },
    /// Echo response for [`ClientToServerMsg::Ping`].
    Pong {
        /// Opaque sequence from the ping.
        seq: u64,
    },
    /// Protocol-level error that keeps the transport frame valid.
    Error {
        /// Machine-readable error class.
        code: ErrorCode,
        /// Human-readable diagnostic.
        message: String,
    },
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, Eq, PartialEq)]
/// Stable error classes used in [`ServerToClientMsg::Error`].
pub enum ErrorCode {
    /// Client and daemon contract versions differ.
    ProtocolMismatch,
    /// Client identity is not paired or no longer authorized.
    Unauthorized,
    /// Client kind is authenticated but lacks the requested capability.
    Forbidden,
    /// Referenced session, device, or pairing request does not exist.
    NotFound,
    /// Request was syntactically valid but semantically invalid.
    InvalidRequest,
    /// Daemon failed while handling an otherwise valid request.
    Internal,
}
