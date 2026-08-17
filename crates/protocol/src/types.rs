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
const TICKET_PREFIX: &str = "sh1";

#[derive(Serialize, Deserialize, Clone, Debug, Eq, PartialEq)]
/// Compact pairing target carrying both the daemon's reachability and the
/// short pairing code that must still be approved on the desktop.
///
/// The QR path encodes the whole ticket so a scan yields reachability *and*
/// the code with no typing. The typed-code path keeps its locally entered code
/// and resolves only [`PairingRendezvous`] through the relay. Serialize QR
/// tickets with [`Self::encode`] and recover them with [`Self::decode`].
pub struct PairingTicket {
    /// Short pairing code; the credential authorized by the active desktop pairing command.
    pub code: String,
    /// Daemon iroh node id.
    pub node_id: String,
    /// Relay URL advertised by the daemon's iroh endpoint, when available.
    pub relay_url: Option<String>,
    /// Direct socket addresses advertised for local-network connection attempts.
    pub addrs: Vec<String>,
    /// UTC deadline in milliseconds after which the code and QR are invalid.
    pub expires_at: u64,
}

impl PairingTicket {
    /// Returns the code-free reachability record safe to publish through the
    /// typed-code relay rendezvous.
    pub fn rendezvous(&self) -> PairingRendezvous {
        PairingRendezvous {
            node_id: self.node_id.clone(),
            relay_url: self.relay_url.clone(),
            addrs: self.addrs.clone(),
            expires_at: self.expires_at,
        }
    }

    /// Encodes the ticket as `sh1<base32>`: postcard bytes wrapped in
    /// unpadded base32 behind the human-readable [`TICKET_PREFIX`].
    pub fn encode(&self) -> Result<String, TicketError> {
        let bytes = postcard::to_stdvec(self)?;
        Ok(format!("{TICKET_PREFIX}{}", BASE32_NOPAD.encode(&bytes)))
    }

    /// Decodes a `sh1<base32>` ticket string produced by [`Self::encode`].
    ///
    /// The base32 body is accepted case-insensitively; surrounding whitespace
    /// is ignored. The exact `sh1` prefix is required.
    pub fn decode(s: &str) -> Result<Self, TicketError> {
        let body = s
            .trim()
            .strip_prefix(TICKET_PREFIX)
            .ok_or(TicketError::MissingPrefix)?;
        let bytes = BASE32_NOPAD.decode(body.to_ascii_uppercase().as_bytes())?;
        let (ticket, trailing) = postcard::take_from_bytes(&bytes)?;
        if !trailing.is_empty() {
            return Err(TicketError::TrailingBytes(trailing.len()));
        }
        Ok(ticket)
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, Eq, PartialEq)]
/// Code-free daemon reachability published for the typed-code pairing path.
///
/// The relay stores this record under `sha256(normalized_code)`. That digest is
/// only an offline-enumerable locator for a low-entropy code; it does not make
/// the code confidential and must never be treated as an authentication secret.
pub struct PairingRendezvous {
    /// Daemon iroh node id.
    pub node_id: String,
    /// Relay URL advertised by the daemon's iroh endpoint, when available.
    pub relay_url: Option<String>,
    /// Direct socket addresses advertised for local-network connection attempts.
    pub addrs: Vec<String>,
    /// UTC deadline in milliseconds after which the rendezvous is invalid.
    pub expires_at: u64,
}

impl PairingRendezvous {
    /// Combines this reachability record with the code retained by the typing
    /// client, reconstructing the same connection target carried by a QR ticket.
    pub fn into_ticket(self, code: String) -> PairingTicket {
        PairingTicket {
            code,
            node_id: self.node_id,
            relay_url: self.relay_url,
            addrs: self.addrs,
            expires_at: self.expires_at,
        }
    }
}

#[derive(Debug, Error)]
/// Errors returned while encoding or decoding a [`PairingTicket`] string.
pub enum TicketError {
    /// The ticket string did not begin with the expected `sh1` prefix.
    #[error("ticket string is missing the \"sh1\" prefix")]
    MissingPrefix,
    /// The base32 body could not be decoded.
    #[error(transparent)]
    Base32(#[from] data_encoding::DecodeError),
    /// Postcard failed to serialize or deserialize the ticket payload.
    #[error(transparent)]
    Postcard(#[from] postcard::Error),
    /// The postcard payload decoded successfully but did not consume the input.
    #[error("ticket postcard payload has {0} trailing byte(s)")]
    TrailingBytes(usize),
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pairing_ticket_decode_rejects_trailing_postcard_bytes() {
        let ticket = PairingTicket {
            code: "ABC1234".to_string(),
            node_id: "daemon-node-a-1234567890".to_string(),
            relay_url: Some("https://relay.shelly.sh".to_string()),
            addrs: vec!["127.0.0.1:7777".to_string()],
            expires_at: 42,
        };
        let mut bytes = postcard::to_stdvec(&ticket).unwrap();
        bytes.push(0);
        let encoded = format!("{TICKET_PREFIX}{}", BASE32_NOPAD.encode(&bytes));

        assert!(matches!(
            PairingTicket::decode(&encoded),
            Err(TicketError::TrailingBytes(1))
        ));
    }
}
