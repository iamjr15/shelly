use data_encoding::BASE32_NOPAD;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};
use thiserror::Error;
use uuid::Uuid;

#[derive(Serialize, Deserialize, Clone, Copy, Debug, Eq, PartialEq, Hash, Ord, PartialOrd)]
/// Stable UUIDv7 identifier for a daemon-owned PTY session.
pub struct SessionId(pub Uuid);

impl SessionId {
    /// Creates a new time-ordered UUIDv7 session identifier.
    pub fn new() -> Self {
        Self(Uuid::now_v7())
    }
}

impl Default for SessionId {
    fn default() -> Self {
        Self::new()
    }
}

impl std::fmt::Display for SessionId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.fmt(f)
    }
}

impl std::str::FromStr for SessionId {
    type Err = uuid::Error;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Ok(Self(Uuid::parse_str(value)?))
    }
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, Eq, PartialEq, Hash, Ord, PartialOrd)]
/// Per-connection UUIDv7 assigned by the daemon after a successful `Hello`.
pub struct ClientId(pub Uuid);

impl ClientId {
    /// Creates a new time-ordered UUIDv7 client identifier.
    pub fn new() -> Self {
        Self(Uuid::now_v7())
    }
}

impl Default for ClientId {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, Eq, PartialEq)]
/// Declares the trust boundary and capabilities for a connecting client.
pub enum ClientKind {
    /// The desktop CLI connected over the local Unix socket.
    LocalCli,
    /// The native iOS app connected over iroh.
    IosApp,
    /// The native Android app connected over iroh.
    AndroidApp,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, Eq, PartialEq)]
/// Mobile push provider associated with a registered device token.
pub enum PushPlatform {
    /// Apple Push Notification service.
    Apns,
    /// Firebase Cloud Messaging.
    Fcm,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, Eq, PartialEq)]
/// Source of a structured agent-state event accepted from local CLI hooks.
pub enum AgentSource {
    /// Claude Code prompt/Stop-hook inference.
    Claude,
    /// Codex structured event inference.
    Codex,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, Eq, PartialEq)]
/// Coarse execution state shown in session dashboards and used for push triggers.
pub enum AgentState {
    /// No recent output and no known pending user action.
    Idle,
    /// Recent PTY output or local input indicates ongoing work.
    Working,
    /// A supported agent is waiting for approval or user input.
    AwaitingInput,
    /// The session process exited abnormally.
    Crashed,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, Eq, PartialEq)]
/// Terminal viewport size in character cells.
pub struct ClientSize {
    /// Number of columns visible to the client.
    pub cols: u16,
    /// Number of rows visible to the client.
    pub rows: u16,
}

impl Default for ClientSize {
    fn default() -> Self {
        Self { cols: 80, rows: 24 }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, Eq, PartialEq)]
/// Dashboard metadata for a session without terminal byte content.
pub struct SessionSummary {
    /// Stable session id.
    pub id: SessionId,
    /// User-facing session label chosen at desktop creation time.
    pub name: String,
    /// Command and arguments running in the PTY.
    pub command: Vec<String>,
    /// Working directory used when the session was spawned.
    pub cwd: PathBuf,
    /// UTC creation time in milliseconds since the Unix epoch.
    pub created_at: u64,
    /// UTC timestamp of the most recent PTY output or input activity.
    pub last_activity: u64,
    /// Current inferred state.
    pub state: AgentState,
    /// Sanitized, truncated preview of the last visible terminal line.
    pub last_line: Option<String>,
    /// Optional model label for supported AI agents.
    pub model: Option<String>,
}

/// Human-readable prefix on every encoded [`PairingTicket`] string.
const TICKET_PREFIX: &str = "fw1";

#[derive(Serialize, Deserialize, Clone, Debug, Eq, PartialEq)]
/// Compact pairing target carrying both the daemon's reachability and the
/// short pairing code that must still be approved on the desktop.
///
/// The QR path encodes the whole ticket so a scan yields reachability *and*
/// the code with no typing. The typed-code path resolves the code to this same
/// ticket via the relay rendezvous endpoint. Serialize with [`Self::encode`]
/// for transport and recover with [`Self::decode`].
pub struct PairingTicket {
    /// Short pairing code; the only credential, still gated by desktop approval.
    pub code: String,
    /// Daemon iroh node id.
    pub node_id: String,
    /// Relay URL advertised by the daemon's iroh endpoint, when available.
    pub relay_url: Option<String>,
    /// Direct socket addresses advertised for local-network connection attempts.
    pub addrs: Vec<String>,
    /// UTC expiry time in milliseconds since the Unix epoch.
    pub expires_at: u64,
}

impl PairingTicket {
    /// Encodes the ticket as `fw1<base32>`: postcard bytes wrapped in
    /// unpadded base32 behind the human-readable [`TICKET_PREFIX`].
    pub fn encode(&self) -> Result<String, TicketError> {
        let bytes = postcard::to_stdvec(self)?;
        Ok(format!("{TICKET_PREFIX}{}", BASE32_NOPAD.encode(&bytes)))
    }

    /// Decodes a `fw1<base32>` ticket string produced by [`Self::encode`].
    ///
    /// The base32 body is accepted case-insensitively; surrounding whitespace
    /// is ignored. The exact `fw1` prefix is required.
    pub fn decode(s: &str) -> Result<Self, TicketError> {
        let body = s
            .trim()
            .strip_prefix(TICKET_PREFIX)
            .ok_or(TicketError::MissingPrefix)?;
        let bytes = BASE32_NOPAD.decode(body.to_ascii_uppercase().as_bytes())?;
        Ok(postcard::from_bytes(&bytes)?)
    }
}

#[derive(Debug, Error)]
/// Errors returned while encoding or decoding a [`PairingTicket`] string.
pub enum TicketError {
    /// The ticket string did not begin with the expected `fw1` prefix.
    #[error("ticket string is missing the \"fw1\" prefix")]
    MissingPrefix,
    /// The base32 body could not be decoded.
    #[error(transparent)]
    Base32(#[from] data_encoding::DecodeError),
    /// Postcard failed to serialize or deserialize the ticket payload.
    #[error(transparent)]
    Postcard(#[from] postcard::Error),
}

#[derive(Serialize, Deserialize, Clone, Debug, Eq, PartialEq)]
/// Locally stored paired-device metadata safe to show in the desktop CLI.
pub struct DeviceSummary {
    /// User-facing name submitted by the mobile app during pairing.
    pub name: String,
    /// Long-lived iroh node id used as the device identity.
    pub device_node_id: String,
    /// UTC pairing time in milliseconds since the Unix epoch.
    pub paired_at: u64,
    /// UTC timestamp of the most recent authenticated device connection.
    pub last_seen: Option<u64>,
    /// Push provider for the currently registered token, if any.
    pub push_platform: Option<PushPlatform>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Eq, PartialEq)]
/// Feature flags advertised by the daemon during handshake.
pub struct Capabilities {
    /// Whether relay-mediated push token registration is active.
    pub push_notifications: bool,
}

impl Capabilities {
    /// Returns the v1 capability set with configurable push support.
    pub fn v1(push_notifications: bool) -> Self {
        Self { push_notifications }
    }

    /// Returns the v1 capability set used when relay push is disabled.
    pub fn v1_local() -> Self {
        Self::v1(false)
    }
}

/// Returns the current UTC timestamp in milliseconds.
pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock is before Unix epoch")
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}
