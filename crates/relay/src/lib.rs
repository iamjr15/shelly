#![warn(missing_docs)]
//! HTTP control plane, push gateway, and metrics surface for Shelly relay.

mod apns;
mod fcm;

use anyhow::Context;
use axum::{
    Router,
    body::Bytes,
    extract::{ConnectInfo, DefaultBodyLimit, Path as AxumPath, State},
    http::{HeaderMap, Method, StatusCode, header::CONTENT_TYPE},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use axum_server::tls_rustls::RustlsConfig;
use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use garde::Validate;
use moka::sync::Cache;
use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use shelly_protocol::{
    CODE_ALPHABET, CONTRACT_VERSION, PairingRendezvous, SignatureVersion, canonical_request,
    canonical_request_v2, normalize_code, split_signature_header,
};
use std::{
    collections::{HashMap, HashSet},
    net::SocketAddr,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicU32, AtomicU64, Ordering},
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tower::limit::ConcurrencyLimitLayer;
use tower_http::{catch_panic::CatchPanicLayer, timeout::TimeoutLayer};

const SIGNATURE_HEADER: &str = "x-shelly-signature";
const FORWARDED_FOR_HEADER: &str = "x-forwarded-for";
const CLOCK_SKEW_MS: i64 = 5 * 60 * 1000;
const RATE_LIMIT_PER_MINUTE: u32 = 50;
const RATE_LIMIT_CACHE_CAPACITY: u64 = 100_000;
const PUSH_TOKEN_TTL_MS: u64 = 90 * 24 * 60 * 60 * 1000;
const DEFAULT_DAEMON_RETENTION_MS: u64 = 365 * 24 * 60 * 60 * 1000;
const DEFAULT_REGISTRATION_AUDIENCE: &str = "https://relay.shelly.sh";
/// Per-IP cap on pairing-code resolution attempts inside one minute window.
const RESOLVE_ATTEMPTS_PER_MINUTE: u32 = 20;
/// Released raw-code rendezvous width. Keep this migration validator separate
/// from the v5 protocol's seven-character [`shelly_protocol::CODE_LEN`].
const LEGACY_CODE_LEN: usize = 5;
/// Per-client cap on daemon registration attempts inside one minute window.
const REGISTER_ATTEMPTS_PER_MINUTE: u32 = 10;
/// Per-daemon cap on push-token registration attempts inside one minute window.
const REGISTER_TOKEN_ATTEMPTS_PER_MINUTE: u32 = 10;
/// Upper bound on distinct daemon registrations retained by the relay.
const MAX_DAEMONS: usize = 1_000_000;
/// Upper bound on push-token bindings a single daemon may hold.
const MAX_TOKENS_PER_DAEMON: usize = 16;
/// Minimum spacing between amortized prunes of expired relay state.
const PRUNE_INTERVAL_MS: u64 = 60 * 1000;
/// Hard per-request deadline for provider (APNs/FCM) HTTP calls.
const PROVIDER_REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
/// Deadline for establishing a provider connection, TLS handshake included.
const PROVIDER_CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
/// End-to-end handler deadline after Axum has received the request headers.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const APP_CONCURRENCY_LIMIT: usize = 1_024;
const METRICS_CONCURRENCY_LIMIT: usize = 64;
const MAX_REQUEST_BODY_BYTES: usize = 16 * 1024;
const INTERNAL_ERROR_MESSAGE: &str = "internal server error";
static ERROR_CORRELATION_SEQUENCE: AtomicU64 = AtomicU64::new(1);

/// Shared relay application state.
#[derive(Clone)]
pub struct RelayState {
    inner: Arc<Mutex<RelayInner>>,
    metrics: Arc<RelayMetrics>,
    rate_limits: RateLimitCache,
    resolve_rate_limits: RateLimitCache,
    register_rate_limits: RateLimitCache,
    token_register_rate_limits: RateLimitCache,
    providers: PushProviders,
    store: Option<RelayStore>,
    trust_forwarded_for: bool,
    prune_stale_daemons: bool,
    daemon_retention_ms: u64,
    /// Canonical public relay audience configured independently of HTTP
    /// headers. Shared by registration proofs and v2 request signatures.
    registration_audience: Arc<str>,
}

#[derive(Default)]
struct RelayInner {
    daemons: HashMap<String, DaemonRegistration>,
    tokens: HashMap<String, TokenOwner>,
    /// Replay nonces keyed to their signed timestamp so expired ones can be pruned.
    seen_nonces: HashMap<(String, String), u64>,
    pairing_codes: HashMap<String, PairingCodeEntry>,
    /// Last amortized prune (unix ms); gates the PRUNE_INTERVAL_MS cadence.
    pruned_at_ms: u64,
    #[cfg(test)]
    delivered: Vec<DeliveredPush>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct DaemonRegistration {
    public_key: VerifyingKey,
    updated_at_ms: u64,
}

#[derive(Clone)]
struct PairingCodeEntry {
    daemon_node_id: String,
    record: PairingRecord,
    expires_at_ms: u64,
}

#[derive(Clone)]
enum PairingRecord {
    LegacyTicket(String),
    Reachability(PairingRendezvous),
}

#[derive(Default)]
struct RelayMetrics {
    daemon_registrations: AtomicU64,
    token_registrations: AtomicU64,
    token_unregistrations: AtomicU64,
    push_accepts: AtomicU64,
    pairing_code_publishes: AtomicU64,
    pairing_code_resolves: AtomicU64,
}

#[derive(Clone)]
struct RateLimitCache {
    counters: Cache<(String, u64), Arc<AtomicU32>>,
}

#[derive(Clone, Default)]
struct PushProviders {
    apns: Option<apns::ApnsClient>,
    fcm: Option<fcm::FcmClient>,
}

#[derive(Debug)]
pub(crate) enum ProviderDeliveryError {
    InvalidToken {
        provider: &'static str,
        reason: String,
    },
    Other {
        provider: &'static str,
        error: anyhow::Error,
    },
}

#[derive(Clone)]
struct RelayStore {
    conn: Arc<Mutex<Connection>>,
}

type LoadedRelayState = (
    HashMap<String, DaemonRegistration>,
    HashMap<String, TokenOwner>,
    HashMap<(String, String), u64>,
    HashMap<String, PairingCodeEntry>,
);

#[derive(Clone)]
struct TokenOwner {
    daemon_node_id: String,
    platform: PushPlatform,
    updated_at_ms: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, Validate)]
#[serde(rename_all = "snake_case")]
pub(crate) enum PushPlatform {
    #[garde(skip)]
    Apns,
    #[garde(skip)]
    Fcm,
}

impl PushPlatform {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Apns => "apns",
            Self::Fcm => "fcm",
        }
    }

    fn from_db(value: &str) -> anyhow::Result<Self> {
        match value {
            "apns" => Ok(Self::Apns),
            "fcm" => Ok(Self::Fcm),
            other => anyhow::bail!("unknown push platform in relay database: {other}"),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, Validate)]
#[serde(rename_all = "snake_case")]
pub(crate) enum PushEventType {
    #[garde(skip)]
    AwaitingInput,
    #[garde(skip)]
    SessionCrashed,
    #[garde(skip)]
    BuildFinished,
}

impl PushEventType {
    pub(crate) fn as_str(&self) -> &'static str {
        match self {
            Self::AwaitingInput => "awaiting_input",
            Self::SessionCrashed => "session_crashed",
            Self::BuildFinished => "build_finished",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, Validate)]
#[serde(deny_unknown_fields)]
struct RegisterDaemonRequest {
    #[garde(ascii, length(min = 16, max = 128))]
    daemon_node_id: String,
    #[garde(ascii, length(min = 40, max = 128))]
    public_key: String,
    // Present only on signed key-rotation requests; first registration and
    // same-key re-registration stay unsigned, matching the released daemon.
    #[garde(inner(ascii, length(min = 16, max = 128)))]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    nonce: Option<String>,
    #[garde(inner(range(min = 1)))]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    ts_ms: Option<u64>,
    #[garde(dive)]
    #[serde(default, skip_serializing_if = "Option::is_none")]
    proof: Option<RegistrationProof>,
}

#[derive(Clone, Debug, Deserialize, Serialize, Validate)]
#[serde(deny_unknown_fields)]
struct RegistrationProof {
    #[garde(ascii, length(min = 8, max = 512))]
    audience: String,
    #[garde(ascii, length(min = 16, max = 128))]
    nonce: String,
    #[garde(range(min = 1))]
    ts_ms: u64,
    #[garde(ascii, length(min = 80, max = 128))]
    signature: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, Validate)]
#[serde(deny_unknown_fields)]
struct RegisterTokenRequest {
    #[garde(ascii, length(min = 16, max = 128))]
    daemon_node_id: String,
    #[garde(dive)]
    platform: PushPlatform,
    #[garde(length(min = 16, max = 4096))]
    push_token: String,
    #[garde(ascii, length(min = 16, max = 128))]
    nonce: String,
    #[garde(range(min = 1))]
    ts_ms: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize, Validate)]
#[serde(deny_unknown_fields)]
struct UnregisterTokenRequest {
    #[garde(ascii, length(min = 16, max = 128))]
    daemon_node_id: String,
    #[garde(length(min = 16, max = 4096))]
    push_token: String,
    #[garde(ascii, length(min = 16, max = 128))]
    nonce: String,
    #[garde(range(min = 1))]
    ts_ms: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize, Validate)]
#[serde(deny_unknown_fields)]
struct PublishLegacyPairingCodeRequest {
    #[garde(ascii, length(min = 16, max = 128))]
    daemon_node_id: String,
    #[garde(ascii, length(min = 4, max = 8))]
    code: String,
    #[garde(length(min = 16, max = 1024))]
    ticket_blob: String,
    #[garde(range(min = 1))]
    expires_at_ms: u64,
    #[garde(ascii, length(min = 16, max = 128))]
    nonce: String,
    #[garde(range(min = 1))]
    ts_ms: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize, Validate)]
#[serde(deny_unknown_fields)]
struct PublishPairingRendezvousRequest {
    #[garde(ascii, length(min = 16, max = 128))]
    daemon_node_id: String,
    #[garde(pattern(r"^[0-9a-f]{64}$"))]
    locator: String,
    #[garde(skip)]
    rendezvous: PairingRendezvous,
    #[garde(ascii, length(min = 16, max = 128))]
    nonce: String,
    #[garde(range(min = 1))]
    ts_ms: u64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(untagged)]
enum PublishPairingRequest {
    Legacy(PublishLegacyPairingCodeRequest),
    Reachability(PublishPairingRendezvousRequest),
}

#[derive(Clone, Debug, Deserialize, Serialize, Validate)]
#[serde(deny_unknown_fields)]
struct PushRequest {
    #[garde(ascii, length(min = 16, max = 128))]
    daemon_node_id: String,
    #[garde(length(min = 16, max = 4096))]
    recipient_token: String,
    #[garde(dive)]
    platform: PushPlatform,
    #[garde(pattern(r"^[0-9a-f]{64}$"))]
    session_id_hash: String,
    #[garde(dive)]
    event_type: PushEventType,
    #[garde(ascii, length(min = 16, max = 128))]
    nonce: String,
    #[garde(range(min = 1))]
    ts_ms: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct DeliveredPush {
    pub(crate) platform: PushPlatform,
    pub(crate) recipient_token: String,
    pub(crate) title: String,
    pub(crate) body: String,
    pub(crate) thread_id: String,
    pub(crate) session_id_hash: String,
    pub(crate) event_type: PushEventType,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
struct VersionResponse {
    relay_version: String,
    contract_version: u32,
    min_desktop_version: String,
    min_mobile_version: String,
}

#[derive(Debug, Serialize)]
struct ApiOk {
    ok: bool,
}

#[derive(Debug, Serialize)]
struct ResolvePairingCodeResponse {
    ticket_blob: String,
}

#[derive(Debug, Serialize)]
struct ResolvePairingRendezvousResponse {
    rendezvous: PairingRendezvous,
}

#[derive(Debug, Serialize)]
struct ApiErrorBody {
    code: &'static str,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    correlation_id: Option<String>,
}

#[derive(Debug)]
struct ApiError {
    status: StatusCode,
    code: &'static str,
    message: String,
    correlation_id: Option<String>,
}

impl ApiError {
    fn bad_request(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            code: "bad_request",
            message: message.into(),
            correlation_id: None,
        }
    }

    fn unauthorized(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::UNAUTHORIZED,
            code: "unauthorized",
            message: message.into(),
            correlation_id: None,
        }
    }

    fn forbidden(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::FORBIDDEN,
            code: "forbidden",
            message: message.into(),
            correlation_id: None,
        }
    }

    fn replay() -> Self {
        Self {
            status: StatusCode::CONFLICT,
            code: "replay_detected",
            message: "nonce was already used".to_string(),
            correlation_id: None,
        }
    }

    fn registration_conflict() -> Self {
        Self {
            status: StatusCode::CONFLICT,
            code: "registration_conflict",
            message: "daemon registration changed; retry".to_string(),
            correlation_id: None,
        }
    }

    fn clock_skew() -> Self {
        Self {
            status: StatusCode::UNAUTHORIZED,
            code: "clock_skew",
            message: "timestamp is outside the accepted skew window".to_string(),
            correlation_id: None,
        }
    }

    fn rate_limited() -> Self {
        Self {
            status: StatusCode::TOO_MANY_REQUESTS,
            code: "rate_limited",
            message: "per-daemon push rate limit exceeded".to_string(),
            correlation_id: None,
        }
    }

    fn resolve_rate_limited() -> Self {
        Self {
            status: StatusCode::TOO_MANY_REQUESTS,
            code: "rate_limited",
            message: "per-client pairing-code resolve rate limit exceeded".to_string(),
            correlation_id: None,
        }
    }

    fn register_rate_limited() -> Self {
        Self {
            status: StatusCode::TOO_MANY_REQUESTS,
            code: "rate_limited",
            message: "per-client daemon registration rate limit exceeded".to_string(),
            correlation_id: None,
        }
    }

    fn token_register_rate_limited() -> Self {
        Self {
            status: StatusCode::TOO_MANY_REQUESTS,
            code: "rate_limited",
            message: "per-daemon push token registration rate limit exceeded".to_string(),
            correlation_id: None,
        }
    }

    fn daemon_capacity() -> Self {
        Self {
            status: StatusCode::SERVICE_UNAVAILABLE,
            code: "capacity_exhausted",
            message: "daemon registry is at capacity".to_string(),
            correlation_id: None,
        }
    }

    fn not_found(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::NOT_FOUND,
            code: "not_found",
            message: message.into(),
            correlation_id: None,
        }
    }

    fn internal(context: &'static str, error: impl std::fmt::Display) -> Self {
        let correlation_id = next_error_correlation_id();
        tracing::error!(%correlation_id, %error, "{context}");
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "internal",
            message: INTERNAL_ERROR_MESSAGE.to_string(),
            correlation_id: Some(correlation_id),
        }
    }

    fn provider_error(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_GATEWAY,
            code: "provider_error",
            message: message.into(),
            correlation_id: None,
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (
            self.status,
            axum::Json(ApiErrorBody {
                code: self.code,
                message: self.message,
                correlation_id: self.correlation_id,
            }),
        )
            .into_response()
    }
}

impl Default for RelayState {
    fn default() -> Self {
        Self {
            inner: Arc::new(Mutex::new(RelayInner::default())),
            metrics: Arc::default(),
            rate_limits: RateLimitCache::default(),
            resolve_rate_limits: RateLimitCache::default(),
            register_rate_limits: RateLimitCache::default(),
            token_register_rate_limits: RateLimitCache::default(),
            providers: PushProviders::default(),
            store: None,
            trust_forwarded_for: false,
            prune_stale_daemons: false,
            daemon_retention_ms: DEFAULT_DAEMON_RETENTION_MS,
            registration_audience: Arc::from(DEFAULT_REGISTRATION_AUDIENCE),
        }
    }
}

impl RelayState {
    /// Opens a persistent SQLite-backed relay state store.
    pub async fn open_sqlite(path: impl AsRef<Path>) -> anyhow::Result<Self> {
        Self::open_sqlite_with_policy(
            path.as_ref(),
            false,
            DEFAULT_DAEMON_RETENTION_MS,
            DEFAULT_REGISTRATION_AUDIENCE,
        )
        .await
    }

    async fn open_sqlite_with_policy(
        path: &Path,
        prune_stale_daemons: bool,
        daemon_retention_ms: u64,
        registration_audience: &str,
    ) -> anyhow::Result<Self> {
        let store = RelayStore::open(path).await?;
        let (daemons, tokens, seen_nonces, pairing_codes) = store
            .load_state(now_ms(), prune_stale_daemons, daemon_retention_ms)
            .await?;
        Ok(Self {
            inner: Arc::new(Mutex::new(RelayInner {
                daemons,
                tokens,
                seen_nonces,
                pairing_codes,
                pruned_at_ms: 0,
                #[cfg(test)]
                delivered: Vec::new(),
            })),
            metrics: Arc::default(),
            rate_limits: RateLimitCache::default(),
            resolve_rate_limits: RateLimitCache::default(),
            register_rate_limits: RateLimitCache::default(),
            token_register_rate_limits: RateLimitCache::default(),
            providers: PushProviders::from_env()?,
            store: Some(store),
            trust_forwarded_for: false,
            prune_stale_daemons,
            daemon_retention_ms,
            registration_audience: Arc::from(registration_audience),
        })
    }

    /// Builds relay state from production environment variables.
    pub async fn from_env() -> anyhow::Result<Self> {
        let trust_forwarded_for = trust_forwarded_for_from_env()?;
        // Relay-first H-9 adoption is intentionally staged: accept optional
        // iroh-key PoP now, release daemon PoP + heartbeat next, measure it,
        // then require PoP for new registrations, and only after that enable
        // stale-daemon pruning. The pruning flag therefore defaults OFF.
        let prune_stale_daemons = parse_bool_env(
            "SHELLY_RELAY_PRUNE_STALE_DAEMONS",
            std::env::var_os("SHELLY_RELAY_PRUNE_STALE_DAEMONS").as_deref(),
            false,
        )?;
        let daemon_retention_ms = parse_u64_env(
            "SHELLY_RELAY_DAEMON_RETENTION_MS",
            DEFAULT_DAEMON_RETENTION_MS,
        )?;
        let registration_audience = std::env::var("SHELLY_RELAY_REGISTRATION_AUDIENCE")
            .unwrap_or_else(|_| DEFAULT_REGISTRATION_AUDIENCE.to_string());
        if registration_audience.trim().is_empty() {
            anyhow::bail!("SHELLY_RELAY_REGISTRATION_AUDIENCE must not be empty");
        }
        let path = std::env::var("SHELLY_RELAY_DB_PATH")
            .unwrap_or_else(|_| "/var/lib/shelly/relay.db".to_string());
        if path.trim().is_empty() || path == "off" {
            return Ok(Self {
                trust_forwarded_for,
                prune_stale_daemons,
                daemon_retention_ms,
                registration_audience: Arc::from(registration_audience),
                ..Self::default()
            });
        }
        let mut state = Self::open_sqlite_with_policy(
            Path::new(&path),
            prune_stale_daemons,
            daemon_retention_ms,
            &registration_audience,
        )
        .await?;
        state.trust_forwarded_for = trust_forwarded_for;
        Ok(state)
    }
}

fn parse_u64_env(name: &str, default: u64) -> anyhow::Result<u64> {
    let Some(value) = std::env::var_os(name) else {
        return Ok(default);
    };
    let value = value.to_string_lossy();
    let value = value.trim();
    if value.is_empty() {
        return Ok(default);
    }
    value
        .parse::<u64>()
        .with_context(|| format!("{name} must be an unsigned integer"))
}

fn trust_forwarded_for_from_env() -> anyhow::Result<bool> {
    parse_bool_env(
        "SHELLY_RELAY_TRUST_FORWARDED_FOR",
        std::env::var_os("SHELLY_RELAY_TRUST_FORWARDED_FOR").as_deref(),
        false,
    )
}

/// Parses a boolean environment value shared by every `SHELLY_RELAY_*` flag.
/// Unset or empty values mean `default`; otherwise the value must be one of
/// `1/true/yes/on` or `0/false/no/off` (case-insensitive), and anything else
/// is an error naming `name`.
pub fn parse_bool_env(
    name: &str,
    value: Option<&std::ffi::OsStr>,
    default: bool,
) -> anyhow::Result<bool> {
    let Some(value) = value else {
        return Ok(default);
    };
    match value.to_string_lossy().trim().to_ascii_lowercase().as_str() {
        "" => Ok(default),
        "1" | "true" | "yes" | "on" => Ok(true),
        "0" | "false" | "no" | "off" => Ok(false),
        _ => anyhow::bail!("{name} must be true/false, yes/no, on/off, or 1/0"),
    }
}

impl PushProviders {
    fn from_env() -> anyhow::Result<Self> {
        Ok(Self {
            apns: apns::ApnsClient::from_env()?,
            fcm: fcm::FcmClient::from_env()?,
        })
    }

    async fn deliver(&self, delivery: &DeliveredPush) -> Result<(), ProviderDeliveryError> {
        match (&delivery.platform, &self.apns, &self.fcm) {
            (PushPlatform::Apns, Some(apns), _) => apns.send(delivery).await,
            (PushPlatform::Fcm, _, Some(fcm)) => fcm.send(delivery).await,
            _ => Ok(()),
        }
    }
}

impl ProviderDeliveryError {
    pub(crate) fn invalid_token(provider: &'static str, reason: impl Into<String>) -> Self {
        Self::InvalidToken {
            provider,
            reason: reason.into(),
        }
    }

    pub(crate) fn other(provider: &'static str, error: anyhow::Error) -> Self {
        Self::Other { provider, error }
    }

    fn is_invalid_token(&self) -> bool {
        matches!(self, Self::InvalidToken { .. })
    }

    fn provider(&self) -> &'static str {
        match self {
            Self::InvalidToken { provider, .. } | Self::Other { provider, .. } => provider,
        }
    }

    fn reason(&self) -> Option<&str> {
        match self {
            Self::InvalidToken { reason, .. } => Some(reason),
            Self::Other { .. } => None,
        }
    }
}

impl std::fmt::Display for ProviderDeliveryError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidToken { provider, .. } => {
                write!(formatter, "{provider} rejected stale push token")
            }
            Self::Other { provider, .. } => {
                write!(formatter, "{provider} delivery failed")
            }
        }
    }
}

impl std::error::Error for ProviderDeliveryError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::InvalidToken { .. } => None,
            Self::Other { error, .. } => Some(error.root_cause()),
        }
    }
}

impl Default for RateLimitCache {
    fn default() -> Self {
        Self::with_ttl(Duration::from_secs(60))
    }
}

impl RateLimitCache {
    fn with_ttl(ttl: Duration) -> Self {
        Self {
            counters: Cache::builder()
                .max_capacity(RATE_LIMIT_CACHE_CAPACITY)
                .time_to_live(ttl)
                .build(),
        }
    }

    fn increment(&self, daemon_node_id: &str, minute: u64) -> u32 {
        let counter = self
            .counters
            .get_with((daemon_node_id.to_string(), minute), || {
                Arc::new(AtomicU32::new(0))
            });
        counter.fetch_add(1, Ordering::Relaxed) + 1
    }
}

impl RelayStore {
    async fn open(path: &Path) -> anyhow::Result<Self> {
        let path = path.to_path_buf();
        tokio::task::spawn_blocking(move || {
            prepare_database_path(&path)?;
            let conn = Connection::open(&path)?;
            conn.pragma_update(None, "journal_mode", "WAL")?;
            conn.pragma_update(None, "foreign_keys", "ON")?;
            conn.execute_batch(
                r#"
                CREATE TABLE IF NOT EXISTS daemons (
                    daemon_node_id TEXT PRIMARY KEY NOT NULL,
                    public_key BLOB NOT NULL,
                    updated_at_ms INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS daemons_updated_at_ms_idx ON daemons(updated_at_ms);
                CREATE TABLE IF NOT EXISTS push_tokens (
                    push_token TEXT PRIMARY KEY NOT NULL,
                    daemon_node_id TEXT NOT NULL,
                    platform TEXT NOT NULL,
                    updated_at_ms INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS seen_nonces (
                    daemon_node_id TEXT NOT NULL,
                    nonce TEXT NOT NULL,
                    ts_ms INTEGER NOT NULL,
                    PRIMARY KEY (daemon_node_id, nonce)
                );
                CREATE INDEX IF NOT EXISTS seen_nonces_ts_ms_idx ON seen_nonces(ts_ms);
                CREATE TABLE IF NOT EXISTS pairing_codes (
                    code TEXT PRIMARY KEY NOT NULL,
                    daemon_node_id TEXT NOT NULL,
                    ticket_blob TEXT NOT NULL,
                    expires_at_ms INTEGER NOT NULL,
                    published_at_ms INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS pairing_codes_expires_at_ms_idx ON pairing_codes(expires_at_ms);
                "#,
            )?;
            // SQLite creates its WAL sidecars while configuring the connection;
            // set restrictive modes once here instead of doing filesystem work
            // after every write.
            set_private_database_permissions(&path)?;
            Ok(Self {
                conn: Arc::new(Mutex::new(conn)),
            })
        })
        .await
        .context("join relay sqlite open task")?
    }

    async fn run<T, F>(&self, operation: F) -> anyhow::Result<T>
    where
        T: Send + 'static,
        F: FnOnce(&mut Connection) -> anyhow::Result<T> + Send + 'static,
    {
        let conn = Arc::clone(&self.conn);
        tokio::task::spawn_blocking(move || {
            let mut conn = conn.lock().expect("relay sqlite lock poisoned");
            operation(&mut conn)
        })
        .await
        .context("join relay sqlite task")?
    }

    async fn load_state(
        &self,
        now_ms: u64,
        prune_stale_daemons: bool,
        daemon_retention_ms: u64,
    ) -> anyhow::Result<LoadedRelayState> {
        self.run(move |conn| {
            prune_expired_rows(conn, now_ms, prune_stale_daemons, daemon_retention_ms)?;

            let mut daemons = HashMap::new();
            let mut stmt =
                conn.prepare("SELECT daemon_node_id, public_key, updated_at_ms FROM daemons")?;
            let rows = stmt.query_map([], |row| {
                let daemon_node_id: String = row.get(0)?;
                let public_key: Vec<u8> = row.get(1)?;
                let updated_at_ms: i64 = row.get(2)?;
                Ok((daemon_node_id, public_key, updated_at_ms))
            })?;
            for row in rows {
                let (daemon_node_id, public_key, updated_at_ms) = row?;
                let public_key: [u8; 32] = public_key
                    .try_into()
                    .map_err(|_| anyhow::anyhow!("stored daemon public key is not 32 bytes"))?;
                daemons.insert(
                    daemon_node_id,
                    DaemonRegistration {
                        public_key: VerifyingKey::from_bytes(&public_key)?,
                        updated_at_ms: updated_at_ms
                            .try_into()
                            .map_err(|_| anyhow::anyhow!("stored daemon timestamp is negative"))?,
                    },
                );
            }

            let mut tokens = HashMap::new();
            let mut stmt = conn.prepare(
                "SELECT push_token, daemon_node_id, platform, updated_at_ms FROM push_tokens",
            )?;
            let rows = stmt.query_map([], |row| {
                let push_token: String = row.get(0)?;
                let daemon_node_id: String = row.get(1)?;
                let platform: String = row.get(2)?;
                let updated_at_ms: i64 = row.get(3)?;
                Ok((push_token, daemon_node_id, platform, updated_at_ms))
            })?;
            for row in rows {
                let (push_token, daemon_node_id, platform, updated_at_ms) = row?;
                tokens.insert(
                    push_token,
                    TokenOwner {
                        daemon_node_id,
                        platform: PushPlatform::from_db(&platform)?,
                        updated_at_ms: updated_at_ms.try_into().map_err(|_| {
                            anyhow::anyhow!("stored push token timestamp is negative")
                        })?,
                    },
                );
            }

            let mut seen_nonces = HashMap::new();
            let mut stmt = conn.prepare("SELECT daemon_node_id, nonce, ts_ms FROM seen_nonces")?;
            let rows = stmt.query_map([], |row| {
                let daemon_node_id: String = row.get(0)?;
                let nonce: String = row.get(1)?;
                let ts_ms: i64 = row.get(2)?;
                Ok((daemon_node_id, nonce, ts_ms))
            })?;
            for row in rows {
                let (daemon_node_id, nonce, ts_ms) = row?;
                let ts_ms: u64 = ts_ms
                    .try_into()
                    .map_err(|_| anyhow::anyhow!("stored nonce timestamp is negative"))?;
                seen_nonces.insert((daemon_node_id, nonce), ts_ms);
            }

            let mut pairing_codes = HashMap::new();
            let mut stmt = conn.prepare(
                "SELECT code, daemon_node_id, ticket_blob, expires_at_ms FROM pairing_codes",
            )?;
            let rows = stmt.query_map([], |row| {
                let code: String = row.get(0)?;
                let daemon_node_id: String = row.get(1)?;
                let ticket_blob: String = row.get(2)?;
                let expires_at_ms: i64 = row.get(3)?;
                Ok((code, daemon_node_id, ticket_blob, expires_at_ms))
            })?;
            for row in rows {
                let (code, daemon_node_id, ticket_blob, expires_at_ms) = row?;
                let record = if is_valid_pairing_locator(&code) {
                    PairingRecord::Reachability(
                        serde_json::from_str(&ticket_blob)
                            .context("decode stored pairing rendezvous")?,
                    )
                } else {
                    PairingRecord::LegacyTicket(ticket_blob)
                };
                pairing_codes.insert(
                    code,
                    PairingCodeEntry {
                        daemon_node_id,
                        record,
                        expires_at_ms: expires_at_ms.try_into().map_err(|_| {
                            anyhow::anyhow!("stored pairing code expiry is negative")
                        })?,
                    },
                );
            }

            Ok((daemons, tokens, seen_nonces, pairing_codes))
        })
        .await
    }

    async fn save_daemon(
        &self,
        daemon_node_id: &str,
        registration: DaemonRegistration,
    ) -> anyhow::Result<()> {
        let daemon_node_id = daemon_node_id.to_string();
        self.run(move |conn| {
            conn.execute(
                r#"
                INSERT INTO daemons (daemon_node_id, public_key, updated_at_ms)
                VALUES (?1, ?2, ?3)
                ON CONFLICT(daemon_node_id) DO UPDATE SET
                    public_key = excluded.public_key,
                    updated_at_ms = excluded.updated_at_ms
                "#,
                params![
                    daemon_node_id,
                    registration.public_key.to_bytes().as_slice(),
                    registration.updated_at_ms as i64
                ],
            )?;
            Ok(())
        })
        .await
    }

    async fn save_token(
        &self,
        push_token: &str,
        daemon_node_id: &str,
        platform: &PushPlatform,
        updated_at_ms: u64,
    ) -> anyhow::Result<()> {
        let push_token = push_token.to_string();
        let daemon_node_id = daemon_node_id.to_string();
        let platform = platform.as_str().to_string();
        self.run(move |conn| {
            conn.execute(
                r#"
                INSERT INTO push_tokens (push_token, daemon_node_id, platform, updated_at_ms)
                VALUES (?1, ?2, ?3, ?4)
                ON CONFLICT(push_token) DO UPDATE SET
                    daemon_node_id = excluded.daemon_node_id,
                    platform = excluded.platform,
                    updated_at_ms = excluded.updated_at_ms
                "#,
                params![push_token, daemon_node_id, platform, updated_at_ms as i64],
            )?;
            Ok(())
        })
        .await
    }

    async fn touch_token(&self, push_token: &str, updated_at_ms: u64) -> anyhow::Result<()> {
        let push_token = push_token.to_string();
        self.run(move |conn| {
            conn.execute(
                "UPDATE push_tokens SET updated_at_ms = ?2 WHERE push_token = ?1",
                params![push_token, updated_at_ms as i64],
            )?;
            Ok(())
        })
        .await
    }

    async fn remove_token(&self, push_token: &str) -> anyhow::Result<()> {
        let push_token = push_token.to_string();
        self.run(move |conn| {
            conn.execute(
                "DELETE FROM push_tokens WHERE push_token = ?1",
                [push_token],
            )?;
            Ok(())
        })
        .await
    }

    async fn insert_nonce(
        &self,
        daemon_node_id: &str,
        nonce: &str,
        ts_ms: u64,
    ) -> anyhow::Result<bool> {
        let daemon_node_id = daemon_node_id.to_string();
        let nonce = nonce.to_string();
        self.run(move |conn| {
            let inserted = conn.execute(
                r#"
                INSERT OR IGNORE INTO seen_nonces (daemon_node_id, nonce, ts_ms)
                VALUES (?1, ?2, ?3)
                "#,
                params![daemon_node_id, nonce, ts_ms as i64],
            )?;
            Ok(inserted == 1)
        })
        .await
    }

    async fn record_authenticated_activity(
        &self,
        daemon_node_id: &str,
        nonce: &str,
        signed_at_ms: u64,
        activity_at_ms: u64,
    ) -> anyhow::Result<bool> {
        let daemon_node_id = daemon_node_id.to_string();
        let nonce = nonce.to_string();
        self.run(move |conn| {
            let transaction = conn.transaction()?;
            let inserted = transaction.execute(
                r#"
                INSERT OR IGNORE INTO seen_nonces (daemon_node_id, nonce, ts_ms)
                VALUES (?1, ?2, ?3)
                "#,
                params![daemon_node_id, nonce, signed_at_ms as i64],
            )?;
            if inserted == 1 {
                transaction.execute(
                    "UPDATE daemons SET updated_at_ms = ?2 WHERE daemon_node_id = ?1",
                    params![daemon_node_id, activity_at_ms as i64],
                )?;
            }
            transaction.commit()?;
            Ok(inserted == 1)
        })
        .await
    }

    async fn prune_expired(
        &self,
        now_ms: u64,
        prune_stale_daemons: bool,
        daemon_retention_ms: u64,
    ) -> anyhow::Result<()> {
        self.run(move |conn| {
            prune_expired_rows(conn, now_ms, prune_stale_daemons, daemon_retention_ms)
        })
        .await
    }

    async fn save_pairing_code(
        &self,
        code: &str,
        daemon_node_id: &str,
        ticket_blob: &str,
        expires_at_ms: u64,
    ) -> anyhow::Result<()> {
        let code = code.to_string();
        let daemon_node_id = daemon_node_id.to_string();
        let ticket_blob = ticket_blob.to_string();
        let published_at_ms = now_ms();
        self.run(move |conn| {
            conn.execute(
                r#"
                INSERT INTO pairing_codes (code, daemon_node_id, ticket_blob, expires_at_ms, published_at_ms)
                VALUES (?1, ?2, ?3, ?4, ?5)
                ON CONFLICT(code) DO UPDATE SET
                    daemon_node_id = excluded.daemon_node_id,
                    ticket_blob = excluded.ticket_blob,
                    expires_at_ms = excluded.expires_at_ms,
                    published_at_ms = excluded.published_at_ms
                "#,
                params![
                    code,
                    daemon_node_id,
                    ticket_blob,
                    expires_at_ms as i64,
                    published_at_ms as i64
                ],
            )?;
            Ok(())
        })
        .await
    }

    async fn delete_pairing_code(&self, code: &str) -> anyhow::Result<()> {
        let code = code.to_string();
        self.run(move |conn| {
            conn.execute("DELETE FROM pairing_codes WHERE code = ?1", [code])?;
            Ok(())
        })
        .await
    }
}

fn prune_expired_rows(
    conn: &mut Connection,
    now_ms: u64,
    prune_stale_daemons: bool,
    daemon_retention_ms: u64,
) -> anyhow::Result<()> {
    let transaction = conn.transaction()?;
    let nonce_cutoff = now_ms.saturating_sub(CLOCK_SKEW_MS as u64);
    let token_cutoff = now_ms.saturating_sub(PUSH_TOKEN_TTL_MS);
    transaction.execute(
        "DELETE FROM seen_nonces WHERE ts_ms < ?1",
        [nonce_cutoff as i64],
    )?;
    transaction.execute(
        "DELETE FROM push_tokens WHERE updated_at_ms < ?1",
        [token_cutoff as i64],
    )?;
    transaction.execute(
        "DELETE FROM pairing_codes WHERE expires_at_ms <= ?1",
        [now_ms as i64],
    )?;
    if prune_stale_daemons {
        let daemon_cutoff = now_ms.saturating_sub(daemon_retention_ms) as i64;
        for table in ["push_tokens", "seen_nonces", "pairing_codes"] {
            transaction.execute(
                &format!(
                    "DELETE FROM {table} WHERE daemon_node_id IN (SELECT daemon_node_id FROM daemons WHERE updated_at_ms < ?1)"
                ),
                [daemon_cutoff],
            )?;
        }
        transaction.execute(
            "DELETE FROM daemons WHERE updated_at_ms < ?1",
            [daemon_cutoff],
        )?;
    }
    transaction.commit()?;
    Ok(())
}

fn prepare_database_path(path: &Path) -> anyhow::Result<()> {
    if let Some(parent) = path.parent()
        && !parent.as_os_str().is_empty()
    {
        std::fs::create_dir_all(parent)?;
        set_private_directory_permissions(parent)?;
    }
    Ok(())
}

#[cfg(unix)]
fn set_private_directory_permissions(path: &Path) -> anyhow::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))?;
    Ok(())
}

#[cfg(not(unix))]
fn set_private_directory_permissions(_path: &Path) -> anyhow::Result<()> {
    Ok(())
}

#[cfg(unix)]
fn set_private_database_permissions(path: &Path) -> anyhow::Result<()> {
    set_private_file_permissions_if_exists(path)?;
    set_private_file_permissions_if_exists(&sqlite_sidecar_path(path, "-wal"))?;
    set_private_file_permissions_if_exists(&sqlite_sidecar_path(path, "-shm"))?;
    Ok(())
}

#[cfg(not(unix))]
fn set_private_database_permissions(_path: &Path) -> anyhow::Result<()> {
    Ok(())
}

fn sqlite_sidecar_path(path: &Path, suffix: &str) -> PathBuf {
    let mut path = path.as_os_str().to_os_string();
    path.push(suffix);
    PathBuf::from(path)
}

#[cfg(unix)]
fn set_private_file_permissions_if_exists(path: &Path) -> anyhow::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    match std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

/// Builds the relay control-plane HTTP router.
pub fn app(state: RelayState) -> Router {
    Router::new()
        .route("/healthz", get(|| async { "ok" }))
        .route("/v1/version", get(version))
        .route("/v1/pair", post(register_daemon))
        .route("/v1/push/register-token", post(register_token))
        .route("/v1/push/unregister-token", post(unregister_token))
        .route("/v1/push", post(push))
        .route("/v1/pair/publish", post(publish_pairing_code))
        .route("/v1/pair/resolve/{code}", get(resolve_pairing_code))
        .with_state(state)
        .layer(DefaultBodyLimit::max(MAX_REQUEST_BODY_BYTES))
        .layer(ConcurrencyLimitLayer::new(APP_CONCURRENCY_LIMIT))
        .layer(TimeoutLayer::with_status_code(
            StatusCode::REQUEST_TIMEOUT,
            REQUEST_TIMEOUT,
        ))
        .layer(CatchPanicLayer::new())
}

/// Builds the aggregate Prometheus metrics router.
pub fn metrics_app(state: RelayState) -> Router {
    Router::new()
        .route("/metrics", get(metrics))
        .with_state(state)
        .layer(DefaultBodyLimit::max(MAX_REQUEST_BODY_BYTES))
        .layer(ConcurrencyLimitLayer::new(METRICS_CONCURRENCY_LIMIT))
        .layer(TimeoutLayer::with_status_code(
            StatusCode::REQUEST_TIMEOUT,
            REQUEST_TIMEOUT,
        ))
        .layer(CatchPanicLayer::new())
}

/// Serves the relay control plane and optionally serves aggregate metrics.
pub async fn serve_with_metrics(addr: &str, metrics_addr: Option<&str>) -> anyhow::Result<()> {
    let state = RelayState::from_env().await?;
    serve_metrics_if_configured(&state, metrics_addr).await?;

    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!(%addr, "shelly relay listening");
    axum::serve(
        listener,
        app(state).into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown_signal())
    .await?;
    Ok(())
}

/// Serves the relay control plane over Rustls TLS and optionally serves metrics.
pub async fn serve_tls_with_metrics(
    addr: &str,
    metrics_addr: Option<&str>,
    cert_path: impl AsRef<Path>,
    key_path: impl AsRef<Path>,
) -> anyhow::Result<()> {
    install_default_rustls_provider();
    let state = RelayState::from_env().await?;
    serve_metrics_if_configured(&state, metrics_addr).await?;

    let tls_config = RustlsConfig::from_pem_file(cert_path, key_path).await?;
    let addr: SocketAddr = addr.parse()?;
    tracing::info!(%addr, "shelly relay TLS control plane listening");
    let handle = axum_server::Handle::new();
    let shutdown_handle = handle.clone();
    tokio::spawn(async move {
        shutdown_signal().await;
        shutdown_handle.graceful_shutdown(Some(Duration::from_secs(30)));
    });
    axum_server::bind_rustls(addr, tls_config)
        .handle(handle)
        .serve(app(state).into_make_service_with_connect_info::<SocketAddr>())
        .await?;
    Ok(())
}

pub(crate) fn install_default_rustls_provider() {
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
}

pub(crate) fn provider_http_client() -> reqwest::Result<reqwest::Client> {
    provider_http_client_with_timeouts(PROVIDER_REQUEST_TIMEOUT, PROVIDER_CONNECT_TIMEOUT)
}

fn provider_http_client_with_timeouts(
    timeout: Duration,
    connect_timeout: Duration,
) -> reqwest::Result<reqwest::Client> {
    // reqwest is built with `rustls-no-provider`; ensure a default crypto
    // provider exists before constructing the client. The relay serve path
    // installs this, but unit tests build clients without it. Idempotent.
    install_default_rustls_provider();
    // Keep-alive tears down dead transports, but a provider that answers
    // pings while stalling the request stream (or a stalled TLS handshake)
    // would otherwise pin /v1/push handlers forever; the deadlines bound both.
    reqwest::Client::builder()
        .http2_keep_alive_interval(Some(Duration::from_secs(60)))
        .http2_keep_alive_timeout(Duration::from_secs(10))
        .http2_keep_alive_while_idle(true)
        .timeout(timeout)
        .connect_timeout(connect_timeout)
        .build()
}

async fn serve_metrics_if_configured(
    state: &RelayState,
    metrics_addr: Option<&str>,
) -> anyhow::Result<()> {
    let Some(metrics_addr) = metrics_addr else {
        return Ok(());
    };
    let metrics_listener = tokio::net::TcpListener::bind(metrics_addr).await?;
    let metrics_state = state.clone();
    tracing::info!(addr = %metrics_addr, "shelly relay metrics listening");
    tokio::spawn(async move {
        if let Err(error) = axum::serve(metrics_listener, metrics_app(metrics_state))
            .with_graceful_shutdown(shutdown_signal())
            .await
        {
            tracing::error!(%error, "shelly relay metrics listener stopped");
        }
    });
    Ok(())
}

async fn shutdown_signal() {
    #[cfg(unix)]
    {
        let mut terminate =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                .expect("install SIGTERM handler");
        tokio::select! {
            result = tokio::signal::ctrl_c() => {
                if let Err(error) = result {
                    tracing::error!(%error, "failed to receive Ctrl-C");
                }
            }
            _ = terminate.recv() => {}
        }
    }
    #[cfg(not(unix))]
    if let Err(error) = tokio::signal::ctrl_c().await {
        tracing::error!(%error, "failed to receive Ctrl-C");
    }
    tracing::info!("relay shutdown signal received; draining requests");
}

async fn metrics(State(state): State<RelayState>) -> impl IntoResponse {
    (
        [(CONTENT_TYPE, "text/plain; version=0.0.4; charset=utf-8")],
        state.metrics_text(),
    )
}

#[tracing::instrument(name = "relay.version", skip_all, fields(endpoint = "/v1/version"))]
async fn version() -> impl IntoResponse {
    axum::Json(build_version_response())
}

#[tracing::instrument(
    name = "relay.register_daemon",
    skip_all,
    fields(endpoint = "/v1/pair")
)]
async fn register_daemon(
    State(state): State<RelayState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    bytes: Bytes,
) -> Result<impl IntoResponse, ApiError> {
    let client = client_identifier(peer, &headers, state.trust_forwarded_for);
    let minute = now_ms() / 60_000;
    if state.register_rate_limits.increment(&client, minute) > REGISTER_ATTEMPTS_PER_MINUTE {
        return Err(ApiError::register_rate_limited());
    }

    let request: RegisterDaemonRequest = parse_validated(&bytes)?;
    let public_key = decode_public_key(&request.public_key)?;
    if let Some(proof) = &request.proof {
        verify_registration_proof(&state, &request.daemon_node_id, &public_key, proof).await?;
    }
    let existing_registration = {
        let inner = state.inner.lock().expect("relay state lock poisoned");
        if daemon_capacity_exceeded(&inner, &request.daemon_node_id, MAX_DAEMONS) {
            return Err(ApiError::daemon_capacity());
        }
        inner.daemons.get(&request.daemon_node_id).copied()
    };
    let existing_key = existing_registration.map(|registration| registration.public_key);
    // Re-keying a known daemon must be authorized by the currently registered
    // key; node ids travel inside pairing tickets, so an unsigned overwrite
    // would let anyone who saw a ticket hijack or brick that daemon. First
    // registration and idempotent same-key re-registration (daemon restart)
    // stay unsigned to match the released daemon protocol.
    if existing_key.is_some_and(|existing| existing != public_key) {
        let (Some(nonce), Some(ts_ms)) = (request.nonce.as_deref(), request.ts_ms) else {
            return Err(ApiError::forbidden(
                "daemon node id is already registered with a different key",
            ));
        };
        verify_signed_request(
            &state,
            SignedRequestContext {
                method: Method::POST.as_str(),
                path: "/v1/pair",
                body: &bytes,
                headers: &headers,
                daemon_node_id: &request.daemon_node_id,
                nonce,
                ts_ms,
            },
        )
        .await?;
    }
    let daemon_node_id = request.daemon_node_id;
    let registration = DaemonRegistration {
        public_key,
        updated_at_ms: now_ms(),
    };
    {
        let mut inner = state.inner.lock().expect("relay state lock poisoned");
        let current_key = inner
            .daemons
            .get(&daemon_node_id)
            .map(|registration| registration.public_key);
        if daemon_capacity_exceeded(&inner, &daemon_node_id, MAX_DAEMONS) {
            return Err(ApiError::daemon_capacity());
        }
        if registration_key_changed(existing_key, current_key, public_key) {
            return Err(ApiError::registration_conflict());
        }
        inner.daemons.insert(daemon_node_id.clone(), registration);
    }
    if let Some(store) = &state.store
        && let Err(error) = store.save_daemon(&daemon_node_id, registration).await
    {
        rollback_daemon_registration(&state, &daemon_node_id, existing_registration, registration);
        return Err(ApiError::internal("persist daemon registration", error));
    }
    state
        .metrics
        .daemon_registrations
        .fetch_add(1, Ordering::Relaxed);
    tracing::info!("relay daemon registration accepted");
    Ok((StatusCode::CREATED, axum::Json(ApiOk { ok: true })))
}

#[tracing::instrument(
    name = "relay.register_push_token",
    skip_all,
    fields(endpoint = "/v1/push/register-token")
)]
async fn register_token(
    State(state): State<RelayState>,
    headers: HeaderMap,
    bytes: Bytes,
) -> Result<impl IntoResponse, ApiError> {
    let request: RegisterTokenRequest = parse_validated(&bytes)?;
    let platform = request.platform.as_str();
    verify_signed_request_with_pre_nonce_check(
        &state,
        SignedRequestContext {
            method: Method::POST.as_str(),
            path: "/v1/push/register-token",
            body: &bytes,
            headers: &headers,
            daemon_node_id: &request.daemon_node_id,
            nonce: &request.nonce,
            ts_ms: request.ts_ms,
        },
        |daemon_node_id| check_register_token_rate_limit(&state, daemon_node_id),
    )
    .await?;
    // Cap the bindings one daemon can hold so a hostile or buggy daemon
    // cannot grow relay memory and disk without bound; evicting its oldest
    // binding keeps legitimate token rotation working.
    let evicted = {
        let inner = state.inner.lock().expect("relay state lock poisoned");
        token_evicted_by_cap(&inner, &request.daemon_node_id, &request.push_token)
    };
    if let Some(evicted) = evicted {
        remove_push_token_binding(&state, &evicted, "evict oldest push token").await?;
    }
    let updated_at_ms = now_ms();
    if let Some(store) = &state.store {
        store
            .save_token(
                &request.push_token,
                &request.daemon_node_id,
                &request.platform,
                updated_at_ms,
            )
            .await
            .map_err(|error| ApiError::internal("persist push token", error))?;
    }
    state
        .inner
        .lock()
        .expect("relay state lock poisoned")
        .tokens
        .insert(
            request.push_token,
            TokenOwner {
                daemon_node_id: request.daemon_node_id,
                platform: request.platform,
                updated_at_ms,
            },
        );
    state
        .metrics
        .token_registrations
        .fetch_add(1, Ordering::Relaxed);
    tracing::info!(platform, "relay push token registration accepted");
    Ok((StatusCode::CREATED, axum::Json(ApiOk { ok: true })))
}

#[tracing::instrument(
    name = "relay.unregister_push_token",
    skip_all,
    fields(endpoint = "/v1/push/unregister-token")
)]
async fn unregister_token(
    State(state): State<RelayState>,
    headers: HeaderMap,
    bytes: Bytes,
) -> Result<impl IntoResponse, ApiError> {
    let request: UnregisterTokenRequest = parse_validated(&bytes)?;
    verify_signed_request(
        &state,
        SignedRequestContext {
            method: Method::POST.as_str(),
            path: "/v1/push/unregister-token",
            body: &bytes,
            headers: &headers,
            daemon_node_id: &request.daemon_node_id,
            nonce: &request.nonce,
            ts_ms: request.ts_ms,
        },
    )
    .await?;
    remove_push_token_binding(&state, &request.push_token, "remove push token").await?;
    tracing::info!("relay push token unregistration accepted");
    Ok((StatusCode::OK, axum::Json(ApiOk { ok: true })))
}

#[tracing::instrument(name = "relay.push", skip_all, fields(endpoint = "/v1/push"))]
async fn push(
    State(state): State<RelayState>,
    headers: HeaderMap,
    bytes: Bytes,
) -> Result<impl IntoResponse, ApiError> {
    let request: PushRequest = parse_validated(&bytes)?;
    let platform = request.platform.as_str();
    let event_type = request.event_type.as_str();
    verify_signed_request(
        &state,
        SignedRequestContext {
            method: Method::POST.as_str(),
            path: "/v1/push",
            body: &bytes,
            headers: &headers,
            daemon_node_id: &request.daemon_node_id,
            nonce: &request.nonce,
            ts_ms: request.ts_ms,
        },
    )
    .await?;

    let token_is_stale = {
        let inner = state.inner.lock().expect("relay state lock poisoned");
        let owner = inner
            .tokens
            .get(&request.recipient_token)
            .ok_or_else(|| ApiError::forbidden("push token is not registered"))?;
        if push_token_is_stale(owner.updated_at_ms, now_ms()) {
            true
        } else if owner.daemon_node_id != request.daemon_node_id
            || owner.platform != request.platform
        {
            return Err(ApiError::forbidden(
                "push token is not owned by the signing daemon",
            ));
        } else {
            false
        }
    };

    if token_is_stale {
        remove_push_token_binding(&state, &request.recipient_token, "remove stale push token")
            .await?;
        return Err(ApiError::forbidden("push token is not registered"));
    }

    // Server time, not the signed client timestamp: every ts_ms inside the
    // skew window would otherwise mint its own fresh rate-limit bucket.
    let minute = now_ms() / 60_000;
    if state.rate_limits.increment(&request.daemon_node_id, minute) > RATE_LIMIT_PER_MINUTE {
        return Err(ApiError::rate_limited());
    }

    let delivery = DeliveredPush {
        platform: request.platform,
        recipient_token: request.recipient_token,
        title: "Shelly".to_string(),
        body: "A session is waiting for you.".to_string(),
        thread_id: format!("session.{}", request.session_id_hash),
        session_id_hash: request.session_id_hash,
        event_type: request.event_type,
    };
    if let Err(error) = state.providers.deliver(&delivery).await {
        if error.is_invalid_token() {
            remove_push_token_binding(
                &state,
                &delivery.recipient_token,
                "remove invalid push token",
            )
            .await?;
            tracing::warn!(
                provider = error.provider(),
                reason = error.reason().unwrap_or("invalid_token"),
                "relay provider rejected stale push token; binding removed"
            );
        }
        return Err(ApiError::provider_error(error.to_string()));
    }
    touch_push_token_binding(&state, &delivery.recipient_token, now_ms()).await?;

    #[cfg(test)]
    {
        let mut inner = state.inner.lock().expect("relay state lock poisoned");
        inner.delivered.push(delivery);
    }
    state.metrics.push_accepts.fetch_add(1, Ordering::Relaxed);
    tracing::info!(platform, event_type, "relay push accepted");

    Ok((StatusCode::ACCEPTED, axum::Json(ApiOk { ok: true })))
}

#[tracing::instrument(
    name = "relay.publish_pairing_code",
    skip_all,
    fields(endpoint = "/v1/pair/publish")
)]
async fn publish_pairing_code(
    State(state): State<RelayState>,
    headers: HeaderMap,
    bytes: Bytes,
) -> Result<impl IntoResponse, ApiError> {
    let request = parse_pairing_publish(&bytes)?;
    let (daemon_node_id, nonce, ts_ms) = match &request {
        PublishPairingRequest::Legacy(request) => (
            request.daemon_node_id.as_str(),
            request.nonce.as_str(),
            request.ts_ms,
        ),
        PublishPairingRequest::Reachability(request) => (
            request.daemon_node_id.as_str(),
            request.nonce.as_str(),
            request.ts_ms,
        ),
    };
    verify_signed_request(
        &state,
        SignedRequestContext {
            method: Method::POST.as_str(),
            path: "/v1/pair/publish",
            body: &bytes,
            headers: &headers,
            daemon_node_id,
            nonce,
            ts_ms,
        },
    )
    .await?;

    let (daemon_node_id, key, record, expires_at_ms) = match request {
        PublishPairingRequest::Legacy(request) => {
            let code = normalize_code(&request.code);
            if !is_valid_legacy_code(&code) {
                return Err(ApiError::bad_request(
                    "legacy pairing code format is invalid",
                ));
            }
            (
                request.daemon_node_id,
                code,
                PairingRecord::LegacyTicket(request.ticket_blob),
                request.expires_at_ms,
            )
        }
        PublishPairingRequest::Reachability(request) => {
            validate_rendezvous(&request.daemon_node_id, &request.rendezvous)?;
            let expires_at_ms = request.rendezvous.expires_at;
            (
                request.daemon_node_id,
                request.locator,
                PairingRecord::Reachability(request.rendezvous),
                expires_at_ms,
            )
        }
    };

    if expires_at_ms <= now_ms() {
        return Err(ApiError::bad_request(
            "pairing rendezvous is already expired at publish time",
        ));
    }

    // A daemon advertises a single active code at a time; supersede any prior
    // code it published so stale entries cannot linger in the resolve lookup.
    let superseded = evict_codes_for_daemon(&state, &daemon_node_id, &key);

    // The existing columns intentionally remain generic storage during the
    // dual-stack window so the schema stays downgrade-readable.
    let stored_payload = match &record {
        PairingRecord::LegacyTicket(ticket_blob) => ticket_blob.clone(),
        PairingRecord::Reachability(rendezvous) => serde_json::to_string(rendezvous)
            .map_err(|error| ApiError::internal("encode pairing rendezvous", error))?,
    };

    if let Some(store) = &state.store {
        for stale in &superseded {
            if let Err(error) = store.delete_pairing_code(stale).await {
                tracing::warn!(%error, "failed to delete superseded pairing code");
            }
        }
        store
            .save_pairing_code(&key, &daemon_node_id, &stored_payload, expires_at_ms)
            .await
            .map_err(|error| ApiError::internal("persist pairing code", error))?;
    }
    state
        .inner
        .lock()
        .expect("relay state lock poisoned")
        .pairing_codes
        .insert(
            key,
            PairingCodeEntry {
                daemon_node_id,
                record,
                expires_at_ms,
            },
        );
    state
        .metrics
        .pairing_code_publishes
        .fetch_add(1, Ordering::Relaxed);
    tracing::info!("relay pairing code publish accepted");
    Ok((StatusCode::CREATED, axum::Json(ApiOk { ok: true })))
}

#[tracing::instrument(
    name = "relay.resolve_pairing_code",
    skip_all,
    fields(endpoint = "/v1/pair/resolve/{code}")
)]
async fn resolve_pairing_code(
    State(state): State<RelayState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    AxumPath(code): AxumPath<String>,
) -> Result<impl IntoResponse, ApiError> {
    // Brute force on this lookup path is mitigated in layers: per-client throttling
    // here, 5-minute single-use codes, a uniform 404 for format and lookup
    // misses, the daemon-side 5-wrong-attempt cap, and the transcript SAS
    // ceremony. A per-code lockout was rejected because it would let an
    // attacker invalidate a victim's active code in 5 guesses (DoS).
    let client = client_identifier(peer, &headers, state.trust_forwarded_for);
    let minute = now_ms() / 60_000;
    if state.resolve_rate_limits.increment(&client, minute) > RESOLVE_ATTEMPTS_PER_MINUTE {
        return Err(ApiError::resolve_rate_limited());
    }

    let key = if is_valid_pairing_locator(&code) {
        code
    } else {
        let legacy_code = normalize_code(&code);
        if !is_valid_legacy_code(&legacy_code) {
            // Uniform 404: never reveal whether the format or the lookup failed.
            return Err(ApiError::not_found("pairing code not found"));
        }
        legacy_code
    };
    let resolution = {
        let mut inner = state.inner.lock().expect("relay state lock poisoned");
        match inner.pairing_codes.get_mut(&key) {
            Some(entry) if entry.expires_at_ms <= now_ms() => {
                inner.pairing_codes.remove(&key);
                CodeResolution::Miss { delete: true }
            }
            Some(entry) => CodeResolution::Hit {
                record: entry.record.clone(),
            },
            None => CodeResolution::Miss { delete: false },
        }
    };

    match resolution {
        CodeResolution::Hit { record } => {
            // A correct guess consumes the code so it cannot be replayed.
            forget_pairing_code(&state, &key).await;
            state
                .metrics
                .pairing_code_resolves
                .fetch_add(1, Ordering::Relaxed);
            tracing::info!("relay pairing code resolve hit");
            let response = match record {
                PairingRecord::LegacyTicket(ticket_blob) => {
                    serde_json::to_value(ResolvePairingCodeResponse { ticket_blob })
                }
                PairingRecord::Reachability(rendezvous) => {
                    serde_json::to_value(ResolvePairingRendezvousResponse { rendezvous })
                }
            }
            .map_err(|error| ApiError::internal("encode pairing resolution", error))?;
            Ok((StatusCode::OK, axum::Json(response)))
        }
        CodeResolution::Miss { delete } => {
            if delete {
                // Expired entry already dropped from memory; clear sqlite too.
                if let Some(store) = &state.store
                    && let Err(error) = store.delete_pairing_code(&key).await
                {
                    tracing::warn!(%error, "failed to delete expired pairing code");
                }
            } else {
                tracing::debug!("relay pairing code resolve miss");
            }
            Err(ApiError::not_found("pairing code not found"))
        }
    }
}

enum CodeResolution {
    Hit { record: PairingRecord },
    Miss { delete: bool },
}

/// Drops every in-memory code owned by `daemon_node_id` except `keep`,
/// returning the evicted codes so the caller can mirror the deletion to sqlite.
fn evict_codes_for_daemon(state: &RelayState, daemon_node_id: &str, keep: &str) -> Vec<String> {
    let mut inner = state.inner.lock().expect("relay state lock poisoned");
    let stale: Vec<String> = inner
        .pairing_codes
        .iter()
        .filter(|(code, entry)| entry.daemon_node_id == daemon_node_id && code.as_str() != keep)
        .map(|(code, _)| code.clone())
        .collect();
    for code in &stale {
        inner.pairing_codes.remove(code);
    }
    stale
}

/// Removes a resolved code from both memory and the durable store.
async fn forget_pairing_code(state: &RelayState, code: &str) {
    state
        .inner
        .lock()
        .expect("relay state lock poisoned")
        .pairing_codes
        .remove(code);
    if let Some(store) = &state.store
        && let Err(error) = store.delete_pairing_code(code).await
    {
        tracing::warn!(%error, "failed to delete resolved pairing code");
    }
}

/// Derives the rate-limit bucket for an unauthenticated caller. The connecting
/// socket address is authoritative; the rightmost `x-forwarded-for` hop is honored
/// only when `SHELLY_RELAY_TRUST_FORWARDED_FOR` marks the deployment as
/// sitting behind a trusted reverse proxy. The proxy overwrites that hop, so
/// attacker-prepended values to its left cannot select a fresh rate-limit key.
fn client_identifier(peer: SocketAddr, headers: &HeaderMap, trust_forwarded_for: bool) -> String {
    if trust_forwarded_for
        && let Some(forwarded) = headers
            .get(FORWARDED_FOR_HEADER)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.split(',').next_back())
            .map(str::trim)
            .filter(|value| !value.is_empty())
    {
        return forwarded.to_string();
    }
    peer.ip().to_string()
}

fn check_register_token_rate_limit(
    state: &RelayState,
    daemon_node_id: &str,
) -> Result<(), ApiError> {
    let minute = now_ms() / 60_000;
    if state
        .token_register_rate_limits
        .increment(daemon_node_id, minute)
        > REGISTER_TOKEN_ATTEMPTS_PER_MINUTE
    {
        return Err(ApiError::token_register_rate_limited());
    }
    Ok(())
}

/// True when registering `daemon_node_id` would grow the registry past
/// `max_daemons`; re-registering an existing id is always allowed.
fn daemon_capacity_exceeded(inner: &RelayInner, daemon_node_id: &str, max_daemons: usize) -> bool {
    inner.daemons.len() >= max_daemons && !inner.daemons.contains_key(daemon_node_id)
}

fn registration_key_changed(
    observed_key: Option<VerifyingKey>,
    current_key: Option<VerifyingKey>,
    requested_key: VerifyingKey,
) -> bool {
    match (observed_key, current_key) {
        (None, None) => false,
        (None, Some(current)) => current != requested_key,
        (Some(observed), Some(current)) => current != observed,
        (Some(_), None) => true,
    }
}

fn rollback_daemon_registration(
    state: &RelayState,
    daemon_node_id: &str,
    previous_registration: Option<DaemonRegistration>,
    attempted_registration: DaemonRegistration,
) {
    let mut inner = state.inner.lock().expect("relay state lock poisoned");
    if inner.daemons.get(daemon_node_id).copied() != Some(attempted_registration) {
        return;
    }
    match previous_registration {
        Some(previous_registration) => {
            inner
                .daemons
                .insert(daemon_node_id.to_string(), previous_registration);
        }
        None => {
            inner.daemons.remove(daemon_node_id);
        }
    }
}

/// Push token to evict so `daemon_node_id` stays within MAX_TOKENS_PER_DAEMON
/// once `push_token` registers. Upserting an already-known token never evicts.
/// Oldest binding first, ties broken by token value so eviction stays
/// deterministic within one millisecond.
fn token_evicted_by_cap(
    inner: &RelayInner,
    daemon_node_id: &str,
    push_token: &str,
) -> Option<String> {
    if inner.tokens.contains_key(push_token) {
        return None;
    }
    let owned: Vec<(&String, u64)> = inner
        .tokens
        .iter()
        .filter(|(_, owner)| owner.daemon_node_id == daemon_node_id)
        .map(|(token, owner)| (token, owner.updated_at_ms))
        .collect();
    if owned.len() < MAX_TOKENS_PER_DAEMON {
        return None;
    }
    owned
        .into_iter()
        .min_by(|left, right| left.1.cmp(&right.1).then_with(|| left.0.cmp(right.0)))
        .map(|(token, _)| token.clone())
}

/// Drops replay nonces, pairing codes, and push tokens whose windows have
/// lapsed, from memory and sqlite alike, so a long-running relay does not
/// grow without bound between restarts. Store failures are logged rather
/// than surfaced: pruning piggybacks on unrelated requests.
async fn prune_expired_relay_state(state: &RelayState, now: u64) {
    {
        let mut inner = state.inner.lock().expect("relay state lock poisoned");
        let nonce_cutoff = now.saturating_sub(CLOCK_SKEW_MS as u64);
        inner.seen_nonces.retain(|_, ts_ms| *ts_ms >= nonce_cutoff);
        inner
            .pairing_codes
            .retain(|_, entry| entry.expires_at_ms > now);
        inner
            .tokens
            .retain(|_, owner| !push_token_is_stale(owner.updated_at_ms, now));
        if state.prune_stale_daemons {
            let daemon_cutoff = now.saturating_sub(state.daemon_retention_ms);
            inner
                .daemons
                .retain(|_, registration| registration.updated_at_ms >= daemon_cutoff);
            let active_daemons = inner.daemons.keys().cloned().collect::<HashSet<_>>();
            inner
                .tokens
                .retain(|_, owner| active_daemons.contains(&owner.daemon_node_id));
            inner
                .seen_nonces
                .retain(|(daemon_node_id, _), _| active_daemons.contains(daemon_node_id));
            inner
                .pairing_codes
                .retain(|_, entry| active_daemons.contains(&entry.daemon_node_id));
        }
    }
    let Some(store) = &state.store else {
        return;
    };
    if let Err(error) = store
        .prune_expired(now, state.prune_stale_daemons, state.daemon_retention_ms)
        .await
    {
        tracing::warn!(%error, "failed to prune expired relay state");
    }
}

async fn maybe_prune_expired_relay_state(state: &RelayState, now: u64) {
    let should_prune = {
        let mut inner = state.inner.lock().expect("relay state lock poisoned");
        if now.saturating_sub(inner.pruned_at_ms) < PRUNE_INTERVAL_MS {
            false
        } else {
            inner.pruned_at_ms = now;
            true
        }
    };
    if should_prune {
        prune_expired_relay_state(state, now).await;
    }
}

async fn remove_push_token_binding(
    state: &RelayState,
    push_token: &str,
    context: &'static str,
) -> Result<(), ApiError> {
    if let Some(store) = &state.store {
        store
            .remove_token(push_token)
            .await
            .map_err(|error| ApiError::internal(context, error))?;
    }
    state
        .inner
        .lock()
        .expect("relay state lock poisoned")
        .tokens
        .remove(push_token);
    state
        .metrics
        .token_unregistrations
        .fetch_add(1, Ordering::Relaxed);
    Ok(())
}

async fn touch_push_token_binding(
    state: &RelayState,
    push_token: &str,
    updated_at_ms: u64,
) -> Result<(), ApiError> {
    if let Some(store) = &state.store {
        store
            .touch_token(push_token, updated_at_ms)
            .await
            .map_err(|error| ApiError::internal("touch push token", error))?;
    }
    if let Some(owner) = state
        .inner
        .lock()
        .expect("relay state lock poisoned")
        .tokens
        .get_mut(push_token)
    {
        owner.updated_at_ms = updated_at_ms;
    }
    Ok(())
}

fn push_token_is_stale(updated_at_ms: u64, now_ms: u64) -> bool {
    now_ms.saturating_sub(updated_at_ms) > PUSH_TOKEN_TTL_MS
}

fn parse_pairing_publish(bytes: &[u8]) -> Result<PublishPairingRequest, ApiError> {
    let request: PublishPairingRequest = serde_json::from_slice(bytes)
        .map_err(|_| ApiError::bad_request("request body is not valid relay JSON"))?;
    let validation = match &request {
        PublishPairingRequest::Legacy(request) => request.validate(),
        PublishPairingRequest::Reachability(request) => request.validate(),
    };
    validation
        .map_err(|error| ApiError::bad_request(format!("request validation failed: {error}")))?;
    Ok(request)
}

fn validate_rendezvous(
    daemon_node_id: &str,
    rendezvous: &PairingRendezvous,
) -> Result<(), ApiError> {
    if rendezvous.node_id != daemon_node_id {
        return Err(ApiError::bad_request(
            "rendezvous node id does not match publishing daemon",
        ));
    }
    if !rendezvous.node_id.is_ascii() || !(16..=128).contains(&rendezvous.node_id.len()) {
        return Err(ApiError::bad_request("rendezvous node id is invalid"));
    }
    if rendezvous
        .relay_url
        .as_ref()
        .is_some_and(|url| url.is_empty() || url.len() > 2_048)
    {
        return Err(ApiError::bad_request("rendezvous relay URL is invalid"));
    }
    if rendezvous.addrs.len() > 32
        || rendezvous
            .addrs
            .iter()
            .any(|addr| !addr.is_ascii() || addr.is_empty() || addr.len() > 256)
    {
        return Err(ApiError::bad_request(
            "rendezvous direct addresses are invalid",
        ));
    }
    Ok(())
}

fn is_valid_legacy_code(code: &str) -> bool {
    code.chars().count() == LEGACY_CODE_LEN
        && code
            .chars()
            .all(|character| CODE_ALPHABET.contains(character))
}

fn is_valid_pairing_locator(locator: &str) -> bool {
    locator.len() == 64
        && locator
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn parse_validated<T>(bytes: &[u8]) -> Result<T, ApiError>
where
    T: DeserializeOwned + Validate,
    T::Context: Default,
{
    let value: T = serde_json::from_slice(bytes)
        .map_err(|_| ApiError::bad_request("request body is not valid relay JSON"))?;
    value
        .validate()
        .map_err(|error| ApiError::bad_request(format!("request validation failed: {error}")))?;
    Ok(value)
}

struct SignedRequestContext<'a> {
    method: &'a str,
    path: &'a str,
    body: &'a [u8],
    headers: &'a HeaderMap,
    daemon_node_id: &'a str,
    nonce: &'a str,
    ts_ms: u64,
}

async fn verify_signed_request(
    state: &RelayState,
    request: SignedRequestContext<'_>,
) -> Result<(), ApiError> {
    verify_signed_request_with_pre_nonce_check(state, request, |_| Ok(())).await
}

async fn verify_signed_request_with_pre_nonce_check(
    state: &RelayState,
    request: SignedRequestContext<'_>,
    pre_nonce_check: impl FnOnce(&str) -> Result<(), ApiError>,
) -> Result<(), ApiError> {
    let now = now_ms();
    if now.abs_diff(request.ts_ms) > CLOCK_SKEW_MS as u64 {
        return Err(ApiError::clock_skew());
    }
    maybe_prune_expired_relay_state(state, now).await;

    let signature_header = request
        .headers
        .get(SIGNATURE_HEADER)
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| ApiError::unauthorized("missing shelly signature"))?;
    let (signature_version, encoded_signature) = split_signature_header(signature_header)
        .ok_or_else(|| ApiError::unauthorized("unsupported shelly signature version"))?;
    let signature = decode_signature(encoded_signature)?;

    let key = {
        let inner = state.inner.lock().expect("relay state lock poisoned");
        inner
            .daemons
            .get(request.daemon_node_id)
            .map(|registration| registration.public_key)
            .ok_or_else(|| ApiError::unauthorized("unknown daemon"))?
    };

    // Relay-first migration: accept released bare/explicit v1 signatures and
    // new v2 signatures now. Daemons emit only v2; retire this v1 branch after
    // client adoption. There is deliberately no daemon-side v1 fallback.
    let verification = match signature_version {
        SignatureVersion::V1 => {
            let canonical = canonical_request(
                request.method,
                request.path,
                request.body,
                request.nonce,
                request.ts_ms,
            );
            key.verify(canonical.as_bytes(), &signature)
        }
        SignatureVersion::V2 => {
            let canonical = canonical_request_v2(
                state.registration_audience.as_ref(),
                request.method,
                request.path,
                request.body,
                request.nonce,
                request.ts_ms,
            );
            key.verify(&canonical, &signature)
        }
    };
    verification.map_err(|_| ApiError::unauthorized("invalid shelly signature"))?;

    let seen_key = (
        request.daemon_node_id.to_string(),
        request.nonce.to_string(),
    );
    {
        let mut inner = state.inner.lock().expect("relay state lock poisoned");
        if inner
            .daemons
            .get(request.daemon_node_id)
            .map(|registration| registration.public_key)
            != Some(key)
        {
            return Err(ApiError::unauthorized("daemon key changed; retry"));
        }
        pre_nonce_check(request.daemon_node_id)?;
        if inner.seen_nonces.insert(seen_key, request.ts_ms).is_some() {
            return Err(ApiError::replay());
        }
    }
    if let Some(store) = &state.store {
        let inserted = store
            .record_authenticated_activity(
                request.daemon_node_id,
                request.nonce,
                request.ts_ms,
                now,
            )
            .await
            .map_err(|error| ApiError::internal("persist authenticated activity", error))?;
        if !inserted {
            return Err(ApiError::replay());
        }
    }

    if let Some(registration) = state
        .inner
        .lock()
        .expect("relay state lock poisoned")
        .daemons
        .get_mut(request.daemon_node_id)
        && registration.public_key == key
    {
        registration.updated_at_ms = now;
    }

    Ok(())
}

async fn verify_registration_proof(
    state: &RelayState,
    daemon_node_id: &str,
    relay_signing_key: &VerifyingKey,
    proof: &RegistrationProof,
) -> Result<(), ApiError> {
    let now = now_ms();
    if now.abs_diff(proof.ts_ms) > CLOCK_SKEW_MS as u64 {
        return Err(ApiError::clock_skew());
    }
    maybe_prune_expired_relay_state(state, now).await;
    if proof.audience != state.registration_audience.as_ref() {
        return Err(ApiError::unauthorized(
            "registration proof audience does not match this relay",
        ));
    }

    let daemon_key: iroh::PublicKey = daemon_node_id
        .parse()
        .map_err(|_| ApiError::unauthorized("daemon_node_id is not a valid iroh public key"))?;
    let signature = BASE64
        .decode(&proof.signature)
        .map_err(|_| ApiError::unauthorized("registration proof signature must be base64"))?;
    let signature = iroh::Signature::try_from(signature.as_slice()).map_err(|_| {
        ApiError::unauthorized("registration proof signature must be an Ed25519 signature")
    })?;
    let binding = registration_proof_binding(
        daemon_node_id,
        relay_signing_key,
        &proof.audience,
        &proof.nonce,
        proof.ts_ms,
    );
    daemon_key
        .verify(binding.as_bytes(), &signature)
        .map_err(|_| ApiError::unauthorized("invalid registration proof"))?;

    let seen_key = (daemon_node_id.to_string(), proof.nonce.clone());
    if state
        .inner
        .lock()
        .expect("relay state lock poisoned")
        .seen_nonces
        .insert(seen_key, proof.ts_ms)
        .is_some()
    {
        return Err(ApiError::replay());
    }
    if let Some(store) = &state.store {
        let inserted = store
            .insert_nonce(daemon_node_id, &proof.nonce, proof.ts_ms)
            .await
            .map_err(|error| ApiError::internal("persist registration proof nonce", error))?;
        if !inserted {
            return Err(ApiError::replay());
        }
    }
    Ok(())
}

fn registration_proof_binding(
    daemon_node_id: &str,
    relay_signing_key: &VerifyingKey,
    audience: &str,
    nonce: &str,
    ts_ms: u64,
) -> String {
    format!(
        "shelly-registration-proof-v1\0{daemon_node_id}\0{}\0{audience}\0{nonce}\0{ts_ms}",
        BASE64.encode(relay_signing_key.to_bytes())
    )
}

fn decode_public_key(value: &str) -> Result<VerifyingKey, ApiError> {
    let bytes = BASE64
        .decode(value)
        .map_err(|_| ApiError::bad_request("public_key must be base64"))?;
    let bytes: [u8; 32] = bytes
        .try_into()
        .map_err(|_| ApiError::bad_request("public_key must decode to 32 bytes"))?;
    VerifyingKey::from_bytes(&bytes)
        .map_err(|_| ApiError::bad_request("public_key is not a valid Ed25519 key"))
}

fn decode_signature(value: &str) -> Result<Signature, ApiError> {
    let bytes = BASE64
        .decode(value)
        .map_err(|_| ApiError::unauthorized("signature must be base64"))?;
    Signature::from_slice(&bytes)
        .map_err(|_| ApiError::unauthorized("signature must be an Ed25519 signature"))
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system time is before unix epoch")
        .as_millis() as u64
}

fn next_error_correlation_id() -> String {
    let sequence = ERROR_CORRELATION_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    format!("relay-{sequence:016x}")
}

fn build_version_response() -> VersionResponse {
    let version = env!("CARGO_PKG_VERSION").to_string();
    VersionResponse {
        relay_version: version.clone(),
        contract_version: CONTRACT_VERSION,
        min_desktop_version: version.clone(),
        min_mobile_version: version,
    }
}

impl RelayState {
    fn metrics_text(&self) -> String {
        let (active_daemons, registered_tokens) = {
            let inner = self.inner.lock().expect("relay state lock poisoned");
            (inner.daemons.len(), inner.tokens.len())
        };

        let daemon_registrations = self.metrics.daemon_registrations.load(Ordering::Relaxed);
        let token_registrations = self.metrics.token_registrations.load(Ordering::Relaxed);
        let token_unregistrations = self.metrics.token_unregistrations.load(Ordering::Relaxed);
        let push_accepts = self.metrics.push_accepts.load(Ordering::Relaxed);
        let pairing_code_publishes = self.metrics.pairing_code_publishes.load(Ordering::Relaxed);
        let pairing_code_resolves = self.metrics.pairing_code_resolves.load(Ordering::Relaxed);

        let base_metrics = format!(
            concat!(
                "# HELP shelly_relay_daemon_registrations_total Daemon public-key registrations accepted by the relay.\n",
                "# TYPE shelly_relay_daemon_registrations_total counter\n",
                "shelly_relay_daemon_registrations_total {}\n",
                "# HELP shelly_relay_push_token_registrations_total Push tokens registered by paired daemons.\n",
                "# TYPE shelly_relay_push_token_registrations_total counter\n",
                "shelly_relay_push_token_registrations_total {}\n",
                "# HELP shelly_relay_push_token_unregistrations_total Push tokens removed by paired daemons.\n",
                "# TYPE shelly_relay_push_token_unregistrations_total counter\n",
                "shelly_relay_push_token_unregistrations_total {}\n",
                "# HELP shelly_relay_push_accepts_total Privacy-preserving push requests accepted for provider delivery.\n",
                "# TYPE shelly_relay_push_accepts_total counter\n",
                "shelly_relay_push_accepts_total {}\n",
                "# HELP shelly_relay_pairing_code_publishes_total Pairing rendezvous records published by paired daemons.\n",
                "# TYPE shelly_relay_pairing_code_publishes_total counter\n",
                "shelly_relay_pairing_code_publishes_total {}\n",
                "# HELP shelly_relay_pairing_code_resolves_total Pairing locators successfully resolved to reachability records.\n",
                "# TYPE shelly_relay_pairing_code_resolves_total counter\n",
                "shelly_relay_pairing_code_resolves_total {}\n",
                "# HELP shelly_relay_active_daemons Active daemon public keys retained in relay memory.\n",
                "# TYPE shelly_relay_active_daemons gauge\n",
                "shelly_relay_active_daemons {}\n",
                "# HELP shelly_relay_registered_push_tokens Active push tokens retained in relay memory.\n",
                "# TYPE shelly_relay_registered_push_tokens gauge\n",
                "shelly_relay_registered_push_tokens {}\n",
            ),
            daemon_registrations,
            token_registrations,
            token_unregistrations,
            push_accepts,
            pairing_code_publishes,
            pairing_code_resolves,
            active_daemons,
            registered_tokens,
        );
        #[cfg(test)]
        {
            let mut metrics = base_metrics;
            let buffered_deliveries = {
                let inner = self.inner.lock().expect("relay state lock poisoned");
                inner.delivered.len()
            };
            metrics.push_str(&format!(
                concat!(
                    "# HELP shelly_relay_buffered_deliveries Generic local delivery records retained only in test builds.\n",
                    "# TYPE shelly_relay_buffered_deliveries gauge\n",
                    "shelly_relay_buffered_deliveries {}\n",
                ),
                buffered_deliveries,
            ));
            metrics
        }
        #[cfg(not(test))]
        {
            base_metrics
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        Router,
        body::{Body, to_bytes},
        extract::connect_info::MockConnectInfo,
        http::Request,
        routing::post,
    };
    use ed25519_dalek::{Signer, SigningKey};
    use shelly_protocol::signature_header;
    use tower::ServiceExt;

    fn test_app(state: RelayState) -> Router {
        app(state).layer(MockConnectInfo(SocketAddr::from(([127, 0, 0, 1], 4321))))
    }

    const DAEMON_A: &str = "daemon-node-a-1234567890";
    const DAEMON_B: &str = "daemon-node-b-1234567890";
    const TOKEN: &str = "apns-token-for-device-a";
    const HASH_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const TEST_P8: &str = r#"-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgYvZMv7/BK9KKJoOw
rcuFYPPvxJYM9Jk51DF+fa+pCUmhRANCAASR6ia5ROe+c+mX/PFvnKubuo/sPS9h
Qs2AKHh1jTVeSS4oFAe+TdkeM/D3FuooTy4WMMf6s8BjtKjlBVHwauFo
-----END PRIVATE KEY-----"#;

    #[tokio::test]
    async fn accepts_registered_owned_token_and_emits_generic_payload() {
        let state = RelayState::default();
        let key = SigningKey::from_bytes(&[7; 32]);
        register_daemon_key(&state, DAEMON_A, &key).await;
        register_token_for(&state, DAEMON_A, &key, "nonce-register-1").await;

        let body = serde_json::to_vec(&PushRequest {
            daemon_node_id: DAEMON_A.to_string(),
            recipient_token: TOKEN.to_string(),
            platform: PushPlatform::Apns,
            session_id_hash: HASH_A.to_string(),
            event_type: PushEventType::AwaitingInput,
            nonce: "nonce-push-00001".to_string(),
            ts_ms: now_ms(),
        })
        .unwrap();
        let response = signed_post(&state, &key, "/v1/push", body, "nonce-push-00001").await;
        assert_eq!(response.status(), StatusCode::ACCEPTED);

        let delivered = state.delivered();
        assert_eq!(delivered.len(), 1);
        assert_eq!(delivered[0].title, "Shelly");
        assert_eq!(delivered[0].body, "A session is waiting for you.");
        assert!(!delivered[0].body.contains("secret"));
        assert_eq!(delivered[0].thread_id, format!("session.{HASH_A}"));
    }

    #[tokio::test]
    async fn accepts_session_crashed_and_build_finished_event_types() {
        let state = RelayState::default();
        let key = SigningKey::from_bytes(&[7; 32]);
        register_daemon_key(&state, DAEMON_A, &key).await;
        register_token_for(&state, DAEMON_A, &key, "nonce-register-events").await;

        for (index, event_type) in [PushEventType::SessionCrashed, PushEventType::BuildFinished]
            .into_iter()
            .enumerate()
        {
            let nonce = format!("nonce-event-{index:06}");
            let body = serde_json::to_vec(&PushRequest {
                daemon_node_id: DAEMON_A.to_string(),
                recipient_token: TOKEN.to_string(),
                platform: PushPlatform::Apns,
                session_id_hash: HASH_A.to_string(),
                event_type,
                nonce: nonce.clone(),
                ts_ms: now_ms(),
            })
            .unwrap();
            let response = signed_post(&state, &key, "/v1/push", body, &nonce).await;
            assert_eq!(response.status(), StatusCode::ACCEPTED);
        }

        // The new types are delivered through the same generic, content-free path:
        // only the event_type discriminator changes; title/body stay generic.
        let delivered = state.delivered();
        assert_eq!(delivered.len(), 2);
        assert_eq!(delivered[0].event_type.as_str(), "session_crashed");
        assert_eq!(delivered[1].event_type.as_str(), "build_finished");
        assert!(delivered.iter().all(|push| push.title == "Shelly"));
    }

    #[tokio::test]
    async fn rejects_cross_daemon_token_use() {
        let state = RelayState::default();
        let key_a = SigningKey::from_bytes(&[7; 32]);
        let key_b = SigningKey::from_bytes(&[8; 32]);
        register_daemon_key(&state, DAEMON_A, &key_a).await;
        register_daemon_key(&state, DAEMON_B, &key_b).await;
        register_token_for(&state, DAEMON_A, &key_a, "nonce-register-2").await;

        let body = serde_json::to_vec(&PushRequest {
            daemon_node_id: DAEMON_B.to_string(),
            recipient_token: TOKEN.to_string(),
            platform: PushPlatform::Apns,
            session_id_hash: HASH_A.to_string(),
            event_type: PushEventType::AwaitingInput,
            nonce: "nonce-push-00002".to_string(),
            ts_ms: now_ms(),
        })
        .unwrap();
        let response = signed_post(&state, &key_b, "/v1/push", body, "nonce-push-00002").await;
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        assert!(state.delivered().is_empty());
    }

    #[tokio::test]
    async fn rate_limits_pushes_per_daemon_per_minute() {
        let state = RelayState::default();
        let key = SigningKey::from_bytes(&[7; 32]);
        register_daemon_key(&state, DAEMON_A, &key).await;
        register_token_for(&state, DAEMON_A, &key, "nonce-register-rate1").await;
        let ts_ms = now_ms();

        for index in 0..RATE_LIMIT_PER_MINUTE {
            let nonce = format!("nonce-rate-{index:06}");
            let response =
                signed_post(&state, &key, "/v1/push", push_body(&nonce, ts_ms), &nonce).await;
            assert_eq!(response.status(), StatusCode::ACCEPTED);
        }

        let nonce = "nonce-rate-over-limit".to_string();
        let response =
            signed_post(&state, &key, "/v1/push", push_body(&nonce, ts_ms), &nonce).await;

        assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(state.delivered().len(), RATE_LIMIT_PER_MINUTE as usize);
    }

    #[tokio::test]
    async fn rate_limits_push_token_registrations_per_daemon_per_minute() {
        let tmp = tempfile::tempdir().unwrap();
        let db_path = tmp.path().join("relay.db");
        let state = RelayState::open_sqlite(&db_path).await.unwrap();
        let key = SigningKey::from_bytes(&[7; 32]);
        register_daemon_key(&state, DAEMON_A, &key).await;
        let minute = now_ms() / 60_000;
        for bucket in [minute, minute + 1] {
            for _ in 0..REGISTER_TOKEN_ATTEMPTS_PER_MINUTE {
                state.token_register_rate_limits.increment(DAEMON_A, bucket);
            }
        }

        let response =
            register_token_response(&state, DAEMON_A, &key, "nonce-register-token-rate").await;

        assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(stored_nonce_count(&state).await, 0);
        assert_eq!(stored_token_count(&state).await, 0);
    }

    #[test]
    fn rate_limit_cache_expires_window_counters() {
        let cache = RateLimitCache::with_ttl(Duration::from_millis(10));
        assert_eq!(cache.increment(DAEMON_A, 1), 1);

        std::thread::sleep(Duration::from_millis(50));
        cache.counters.run_pending_tasks();

        assert_eq!(cache.increment(DAEMON_A, 1), 1);
    }

    #[test]
    fn relay_uses_protocol_canonical_request_byte_layout() {
        let canonical = canonical_request(
            "POST",
            "/v1/push",
            br#"{"nonce":"nonce-1","ts_ms":42}"#,
            "nonce-1",
            42,
        );

        assert_eq!(
            canonical,
            "POST\n/v1/push\n{\"nonce\":\"nonce-1\",\"ts_ms\":42}\nnonce-1\n42"
        );
    }

    #[tokio::test]
    async fn migration_relay_accepts_old_v1_and_new_v2_signatures() {
        let state = RelayState::default();
        let key = SigningKey::from_bytes(&[7; 32]);
        register_daemon_key(&state, DAEMON_A, &key).await;

        let v1_nonce = "nonce-signature-v1-compat";
        let v1_body = serde_json::to_vec(&RegisterTokenRequest {
            daemon_node_id: DAEMON_A.to_string(),
            platform: PushPlatform::Apns,
            push_token: TOKEN.to_string(),
            nonce: v1_nonce.to_string(),
            ts_ms: now_ms(),
        })
        .unwrap();
        let v1_response =
            signed_post(&state, &key, "/v1/push/register-token", v1_body, v1_nonce).await;

        let explicit_v1_nonce = "nonce-signature-v1-explicit";
        let explicit_v1_body = serde_json::to_vec(&RegisterTokenRequest {
            daemon_node_id: DAEMON_A.to_string(),
            platform: PushPlatform::Apns,
            push_token: TOKEN.to_string(),
            nonce: explicit_v1_nonce.to_string(),
            ts_ms: now_ms(),
        })
        .unwrap();
        let explicit_v1_ts = serde_json::from_slice::<serde_json::Value>(&explicit_v1_body)
            .unwrap()["ts_ms"]
            .as_u64()
            .unwrap();
        let explicit_v1_signature = signature_header(
            SignatureVersion::V1,
            &sign(
                &key,
                "/v1/push/register-token",
                &explicit_v1_body,
                explicit_v1_nonce,
                explicit_v1_ts,
            ),
        );
        let explicit_v1_response = test_app(state.clone())
            .oneshot(
                Request::post("/v1/push/register-token")
                    .header(SIGNATURE_HEADER, explicit_v1_signature)
                    .body(Body::from(explicit_v1_body))
                    .unwrap(),
            )
            .await
            .unwrap();

        let v2_nonce = "nonce-signature-v2-current";
        let v2_body = serde_json::to_vec(&RegisterTokenRequest {
            daemon_node_id: DAEMON_A.to_string(),
            platform: PushPlatform::Apns,
            push_token: TOKEN.to_string(),
            nonce: v2_nonce.to_string(),
            ts_ms: now_ms(),
        })
        .unwrap();
        let v2_response = signed_post_v2(
            &state,
            &key,
            "/v1/push/register-token",
            v2_body,
            v2_nonce,
            DEFAULT_REGISTRATION_AUDIENCE,
        )
        .await;

        assert_eq!(v1_response.status(), StatusCode::CREATED);
        assert_eq!(explicit_v1_response.status(), StatusCode::CREATED);
        assert_eq!(v2_response.status(), StatusCode::CREATED);
    }

    #[tokio::test]
    async fn v2_signature_with_mismatched_origin_is_rejected() {
        let state = RelayState::default();
        let key = SigningKey::from_bytes(&[7; 32]);
        register_daemon_key(&state, DAEMON_A, &key).await;
        let nonce = "nonce-v2-origin-mismatch";
        let body = serde_json::to_vec(&RegisterTokenRequest {
            daemon_node_id: DAEMON_A.to_string(),
            platform: PushPlatform::Apns,
            push_token: TOKEN.to_string(),
            nonce: nonce.to_string(),
            ts_ms: now_ms(),
        })
        .unwrap();
        let ts_ms = serde_json::from_slice::<serde_json::Value>(&body).unwrap()["ts_ms"]
            .as_u64()
            .unwrap();
        let signature = sign_v2(
            &key,
            "https://attacker.invalid",
            "/v1/push/register-token",
            &body,
            nonce,
            ts_ms,
        );
        let response = test_app(state)
            .oneshot(
                Request::post("/v1/push/register-token")
                    .header(SIGNATURE_HEADER, signature)
                    // Even matching attacker-controlled routing headers cannot
                    // override the relay's configured canonical audience.
                    .header("host", "attacker.invalid")
                    .header(FORWARDED_FOR_HEADER, "203.0.113.9")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn rejects_replayed_nonce() {
        let state = RelayState::default();
        let key = SigningKey::from_bytes(&[7; 32]);
        register_daemon_key(&state, DAEMON_A, &key).await;
        let request = RegisterTokenRequest {
            daemon_node_id: DAEMON_A.to_string(),
            platform: PushPlatform::Apns,
            push_token: TOKEN.to_string(),
            nonce: "nonce-replay-0001".to_string(),
            ts_ms: now_ms(),
        };
        let body = serde_json::to_vec(&request).unwrap();

        let first = signed_post(
            &state,
            &key,
            "/v1/push/register-token",
            body.clone(),
            "nonce-replay-0001",
        )
        .await;
        let second = signed_post(
            &state,
            &key,
            "/v1/push/register-token",
            body,
            "nonce-replay-0001",
        )
        .await;

        assert_eq!(first.status(), StatusCode::CREATED);
        assert_eq!(second.status(), StatusCode::CONFLICT);
    }

    #[tokio::test]
    async fn signed_request_prunes_expired_nonces_from_memory_and_sqlite() {
        let tmp = tempfile::tempdir().unwrap();
        let db_path = tmp.path().join("relay.db");
        let state = RelayState::open_sqlite(&db_path).await.unwrap();
        let key = SigningKey::from_bytes(&[7; 32]);
        register_daemon_key(&state, DAEMON_A, &key).await;

        let old_ts = now_ms().saturating_sub(CLOCK_SKEW_MS as u64 + 1_000);
        state
            .store
            .as_ref()
            .unwrap()
            .insert_nonce(DAEMON_A, "nonce-expired-prune", old_ts)
            .await
            .unwrap();
        state
            .inner
            .lock()
            .expect("relay state lock poisoned")
            .seen_nonces
            .insert(
                (DAEMON_A.to_string(), "nonce-expired-prune".to_string()),
                old_ts,
            );

        let response =
            register_token_response(&state, DAEMON_A, &key, "nonce-prune-trigger1").await;

        assert_eq!(response.status(), StatusCode::CREATED);
        assert!(
            !state
                .inner
                .lock()
                .expect("relay state lock poisoned")
                .seen_nonces
                .contains_key(&(DAEMON_A.to_string(), "nonce-expired-prune".to_string()))
        );
        assert_eq!(stored_nonce_count(&state).await, 1);
    }

    #[tokio::test]
    async fn rejects_clock_skew() {
        let state = RelayState::default();
        let key = SigningKey::from_bytes(&[7; 32]);
        register_daemon_key(&state, DAEMON_A, &key).await;
        let old_ts = now_ms() - 10 * 60 * 1000;
        let body = serde_json::to_vec(&RegisterTokenRequest {
            daemon_node_id: DAEMON_A.to_string(),
            platform: PushPlatform::Apns,
            push_token: TOKEN.to_string(),
            nonce: "nonce-old-0000001".to_string(),
            ts_ms: old_ts,
        })
        .unwrap();
        let signature = sign(
            &key,
            "/v1/push/register-token",
            &body,
            "nonce-old-0000001",
            old_ts,
        );
        let response = test_app(state)
            .oneshot(
                Request::post("/v1/push/register-token")
                    .header(SIGNATURE_HEADER, signature)
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn rejects_push_payload_with_non_hex_hashes() {
        let state = RelayState::default();
        let key = SigningKey::from_bytes(&[7; 32]);
        register_daemon_key(&state, DAEMON_A, &key).await;

        for (field, value, nonce) in [
            (
                "session_id_hash",
                "not-a-hex-session-id-hash-value-that-is-sixty-four-bytes!!",
                "nonce-hash-bad001",
            ),
            (
                "session_id_hash",
                "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
                "nonce-hash-bad002",
            ),
        ] {
            let mut body = serde_json::json!({
                "daemon_node_id": DAEMON_A,
                "recipient_token": TOKEN,
                "platform": "apns",
                "session_id_hash": HASH_A,
                "event_type": "awaiting_input",
                "nonce": nonce,
                "ts_ms": now_ms(),
            });
            body[field] = serde_json::Value::String(value.to_string());

            let response = signed_post(
                &state,
                &key,
                "/v1/push",
                serde_json::to_vec(&body).unwrap(),
                nonce,
            )
            .await;
            assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        }
    }

    #[tokio::test]
    async fn rejects_push_payload_with_forbidden_free_text_fields() {
        let state = RelayState::default();
        let key = SigningKey::from_bytes(&[7; 32]);
        register_daemon_key(&state, DAEMON_A, &key).await;

        for (field, value, nonce) in [
            ("last_line", "do not leak this", "nonce-privacy-01"),
            ("command", "claude --dangerously-skip", "nonce-privacy-02"),
            ("path", "/Users/example/secret-project", "nonce-privacy-03"),
            ("session_name", "production incident", "nonce-privacy-04"),
        ] {
            let mut body = serde_json::json!({
                "daemon_node_id": DAEMON_A,
                "recipient_token": TOKEN,
                "platform": "apns",
                "session_id_hash": HASH_A,
                "event_type": "awaiting_input",
                "nonce": nonce,
                "ts_ms": now_ms(),
            });
            body[field] = serde_json::Value::String(value.to_string());

            let response = signed_post(
                &state,
                &key,
                "/v1/push",
                serde_json::to_vec(&body).unwrap(),
                nonce,
            )
            .await;
            assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        }
    }

    #[tokio::test]
    async fn rejects_request_bodies_larger_than_sixteen_kibibytes() {
        let response = test_app(RelayState::default())
            .oneshot(
                Request::post("/v1/pair")
                    .body(Body::from(vec![b'x'; MAX_REQUEST_BODY_BYTES + 1]))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
    }

    #[tokio::test]
    async fn internal_errors_expose_only_fixed_message_and_correlation_id() {
        let response = ApiError::internal(
            "persist relay state",
            anyhow::anyhow!("secret sqlite and serde details"),
        )
        .into_response();
        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
        let body = response_text(response).await;
        let value: serde_json::Value = serde_json::from_str(&body).unwrap();

        assert_eq!(value["code"], "internal");
        assert_eq!(value["message"], INTERNAL_ERROR_MESSAGE);
        assert!(
            value["correlation_id"]
                .as_str()
                .is_some_and(|id| id.starts_with("relay-"))
        );
        assert!(!body.contains("sqlite"));
        assert!(!body.contains("serde"));
    }

    #[tokio::test]
    async fn metrics_are_aggregate_and_do_not_expose_private_identifiers() {
        let state = RelayState::default();
        let key = SigningKey::from_bytes(&[7; 32]);
        register_daemon_key(&state, DAEMON_A, &key).await;
        register_token_for(&state, DAEMON_A, &key, "nonce-register-metrics").await;

        let body = serde_json::to_vec(&PushRequest {
            daemon_node_id: DAEMON_A.to_string(),
            recipient_token: TOKEN.to_string(),
            platform: PushPlatform::Apns,
            session_id_hash: HASH_A.to_string(),
            event_type: PushEventType::AwaitingInput,
            nonce: "nonce-push-metrics1".to_string(),
            ts_ms: now_ms(),
        })
        .unwrap();
        let response = signed_post(&state, &key, "/v1/push", body, "nonce-push-metrics1").await;
        assert_eq!(response.status(), StatusCode::ACCEPTED);

        let response = metrics_app(state)
            .oneshot(Request::get("/metrics").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = response_text(response).await;
        assert!(body.contains("shelly_relay_daemon_registrations_total 1"));
        assert!(body.contains("shelly_relay_push_token_registrations_total 1"));
        assert!(body.contains("shelly_relay_push_accepts_total 1"));
        assert!(!body.contains(DAEMON_A));
        assert!(!body.contains(TOKEN));
        assert!(!body.contains(HASH_A));
    }

    #[tokio::test]
    async fn version_endpoint_reports_contract_without_private_identifiers() {
        let state = RelayState::default();
        let key = SigningKey::from_bytes(&[7; 32]);
        register_daemon_key(&state, DAEMON_A, &key).await;
        register_token_for(&state, DAEMON_A, &key, "nonce-register-version").await;

        let response = test_app(state)
            .oneshot(Request::get("/v1/version").body(Body::empty()).unwrap())
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        let body = response_text(response).await;
        let value: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(value["relay_version"], env!("CARGO_PKG_VERSION"));
        assert_eq!(value["contract_version"], CONTRACT_VERSION);
        assert_eq!(value["min_desktop_version"], env!("CARGO_PKG_VERSION"));
        assert_eq!(value["min_mobile_version"], env!("CARGO_PKG_VERSION"));
        assert!(!body.contains(DAEMON_A));
        assert!(!body.contains(TOKEN));
    }

    #[tokio::test]
    async fn sqlite_persists_daemon_key_and_token_ownership_after_restart() {
        let tmp = tempfile::tempdir().unwrap();
        let db_path = tmp.path().join("relay.db");
        let key = SigningKey::from_bytes(&[7; 32]);
        let state = RelayState::open_sqlite(&db_path).await.unwrap();
        register_daemon_key(&state, DAEMON_A, &key).await;
        register_token_for(&state, DAEMON_A, &key, "nonce-register-sqlite1").await;
        drop(state);

        let restored = RelayState::open_sqlite(&db_path).await.unwrap();
        let body = serde_json::to_vec(&PushRequest {
            daemon_node_id: DAEMON_A.to_string(),
            recipient_token: TOKEN.to_string(),
            platform: PushPlatform::Apns,
            session_id_hash: HASH_A.to_string(),
            event_type: PushEventType::AwaitingInput,
            nonce: "nonce-push-sqlite001".to_string(),
            ts_ms: now_ms(),
        })
        .unwrap();

        let response = signed_post(&restored, &key, "/v1/push", body, "nonce-push-sqlite001").await;

        assert_eq!(response.status(), StatusCode::ACCEPTED);
        assert_eq!(restored.delivered().len(), 1);
    }

    #[tokio::test]
    async fn sqlite_rejects_replayed_nonce_after_restart() {
        let tmp = tempfile::tempdir().unwrap();
        let db_path = tmp.path().join("relay.db");
        let key = SigningKey::from_bytes(&[7; 32]);
        let state = RelayState::open_sqlite(&db_path).await.unwrap();
        register_daemon_key(&state, DAEMON_A, &key).await;
        register_token_for(&state, DAEMON_A, &key, "nonce-replay-sqlite1").await;
        drop(state);

        let restored = RelayState::open_sqlite(&db_path).await.unwrap();
        let body = serde_json::to_vec(&RegisterTokenRequest {
            daemon_node_id: DAEMON_A.to_string(),
            platform: PushPlatform::Apns,
            push_token: TOKEN.to_string(),
            nonce: "nonce-replay-sqlite1".to_string(),
            ts_ms: now_ms(),
        })
        .unwrap();

        let response = signed_post(
            &restored,
            &key,
            "/v1/push/register-token",
            body,
            "nonce-replay-sqlite1",
        )
        .await;

        assert_eq!(response.status(), StatusCode::CONFLICT);
    }

    #[tokio::test]
    async fn stale_push_token_is_rejected_and_pruned_from_memory_and_sqlite() {
        let tmp = tempfile::tempdir().unwrap();
        let db_path = tmp.path().join("relay.db");
        let key = SigningKey::from_bytes(&[7; 32]);
        let state = RelayState::open_sqlite(&db_path).await.unwrap();
        register_daemon_key(&state, DAEMON_A, &key).await;
        register_token_for(&state, DAEMON_A, &key, "nonce-register-stale1").await;
        let old_timestamp = now_ms().saturating_sub(PUSH_TOKEN_TTL_MS + 1);
        set_token_updated_at(&state, TOKEN, old_timestamp).await;

        let response = signed_post(
            &state,
            &key,
            "/v1/push",
            push_body("nonce-push-stale001", now_ms()),
            "nonce-push-stale001",
        )
        .await;

        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        assert_eq!(state.registered_token_count(), 0);
        assert_eq!(stored_token_count(&state).await, 0);
        assert!(
            state
                .metrics_text()
                .contains("shelly_relay_push_token_unregistrations_total 1")
        );
    }

    #[tokio::test]
    async fn sqlite_prunes_push_tokens_after_ninety_days_without_use_on_restart() {
        let tmp = tempfile::tempdir().unwrap();
        let db_path = tmp.path().join("relay.db");
        let key = SigningKey::from_bytes(&[7; 32]);
        let state = RelayState::open_sqlite(&db_path).await.unwrap();
        register_daemon_key(&state, DAEMON_A, &key).await;
        register_token_for(&state, DAEMON_A, &key, "nonce-register-prune1").await;
        let old_timestamp = now_ms().saturating_sub(PUSH_TOKEN_TTL_MS + 1);
        set_stored_token_updated_at(&state, TOKEN, old_timestamp).await;
        drop(state);

        let restored = RelayState::open_sqlite(&db_path).await.unwrap();

        assert_eq!(restored.registered_token_count(), 0);
        assert_eq!(stored_token_count(&restored).await, 0);
    }

    #[tokio::test]
    async fn accepted_push_refreshes_push_token_last_used_timestamp() {
        let tmp = tempfile::tempdir().unwrap();
        let db_path = tmp.path().join("relay.db");
        let key = SigningKey::from_bytes(&[7; 32]);
        let state = RelayState::open_sqlite(&db_path).await.unwrap();
        register_daemon_key(&state, DAEMON_A, &key).await;
        register_token_for(&state, DAEMON_A, &key, "nonce-register-touch1").await;
        let old_timestamp = now_ms().saturating_sub(PUSH_TOKEN_TTL_MS - 1_000);
        set_stored_token_updated_at(&state, TOKEN, old_timestamp).await;
        drop(state);

        let restored = RelayState::open_sqlite(&db_path).await.unwrap();
        assert_eq!(restored.registered_token_count(), 1);
        assert_eq!(
            stored_token_updated_at(&restored, TOKEN).await,
            old_timestamp
        );

        let response = signed_post(
            &restored,
            &key,
            "/v1/push",
            push_body("nonce-push-touch001", now_ms()),
            "nonce-push-touch001",
        )
        .await;

        assert_eq!(response.status(), StatusCode::ACCEPTED);
        assert!(stored_token_updated_at(&restored, TOKEN).await > old_timestamp);
    }

    #[tokio::test]
    async fn apns_bad_device_token_removes_token_binding_from_memory_and_sqlite() {
        let Some(listener) = bind_loopback_for_test().await else {
            return;
        };
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let app = Router::new().route(
                "/3/device/apns-token-for-device-a",
                post(|| async {
                    (
                        StatusCode::BAD_REQUEST,
                        axum::Json(serde_json::json!({"reason": "BadDeviceToken"})),
                    )
                }),
            );
            axum::serve(listener, app).await.unwrap();
        });

        let tmp = tempfile::tempdir().unwrap();
        let db_path = tmp.path().join("relay.db");
        let mut state = RelayState::open_sqlite(&db_path).await.unwrap();
        state.providers = PushProviders {
            apns: Some(
                apns::ApnsClient::new(apns::ApnsCredentials {
                    team_id: "TEAMID1234".to_string(),
                    key_id: "KEYID1234".to_string(),
                    topic: "app.shelly.ios".to_string(),
                    private_key_pem: TEST_P8.as_bytes().to_vec(),
                    endpoint: format!("http://{addr}"),
                })
                .unwrap(),
            ),
            ..Default::default()
        };
        let key = SigningKey::from_bytes(&[7; 32]);
        register_daemon_key(&state, DAEMON_A, &key).await;
        register_token_for(&state, DAEMON_A, &key, "nonce-register-bad-apns").await;

        let response = signed_post(
            &state,
            &key,
            "/v1/push",
            push_body("nonce-push-bad-apns1", now_ms()),
            "nonce-push-bad-apns1",
        )
        .await;
        assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
        let body = response_text(response).await;
        assert!(body.contains("provider_error"));
        assert!(body.contains("rejected stale push token"));
        assert!(!body.contains("BadDeviceToken"));
        assert!(state.delivered().is_empty());
        assert_eq!(state.registered_token_count(), 0);
        assert!(
            state
                .metrics_text()
                .contains("shelly_relay_push_token_unregistrations_total 1")
        );

        drop(state);
        let restored = RelayState::open_sqlite(&db_path).await.unwrap();
        let response = signed_post(
            &restored,
            &key,
            "/v1/push",
            push_body("nonce-push-bad-apns2", now_ms()),
            "nonce-push-bad-apns2",
        )
        .await;
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        assert!(restored.delivered().is_empty());
        assert_eq!(restored.registered_token_count(), 0);
    }

    #[tokio::test]
    async fn provider_error_response_does_not_reflect_provider_body() {
        let Some(listener) = bind_loopback_for_test().await else {
            return;
        };
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let app = Router::new().route(
                "/3/device/apns-token-for-device-a",
                post(|| async {
                    (
                        StatusCode::SERVICE_UNAVAILABLE,
                        "temporary outage for /Users/example/secret-project last_line=leak",
                    )
                }),
            );
            axum::serve(listener, app).await.unwrap();
        });

        let state = RelayState {
            providers: PushProviders {
                apns: Some(
                    apns::ApnsClient::new(apns::ApnsCredentials {
                        team_id: "TEAMID1234".to_string(),
                        key_id: "KEYID1234".to_string(),
                        topic: "app.shelly.ios".to_string(),
                        private_key_pem: TEST_P8.as_bytes().to_vec(),
                        endpoint: format!("http://{addr}"),
                    })
                    .unwrap(),
                ),
                ..Default::default()
            },
            ..Default::default()
        };
        let key = SigningKey::from_bytes(&[7; 32]);
        register_daemon_key(&state, DAEMON_A, &key).await;
        register_token_for(&state, DAEMON_A, &key, "nonce-register-provider-body").await;

        let response = signed_post(
            &state,
            &key,
            "/v1/push",
            push_body("nonce-provider-body1", now_ms()),
            "nonce-provider-body1",
        )
        .await;

        assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
        let body = response_text(response).await;
        assert!(body.contains("provider_error"));
        assert!(body.contains("APNs delivery failed"));
        assert!(!body.contains("/Users/example"));
        assert!(!body.contains("last_line"));
        assert!(!body.contains("secret-project"));
        assert_eq!(state.registered_token_count(), 1);
        assert!(state.delivered().is_empty());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn sqlite_database_and_sidecars_are_private() {
        let tmp = tempfile::tempdir().unwrap();
        let db_path = tmp.path().join("relay.db");
        let key = SigningKey::from_bytes(&[7; 32]);
        let state = RelayState::open_sqlite(&db_path).await.unwrap();
        register_daemon_key(&state, DAEMON_A, &key).await;
        register_token_for(&state, DAEMON_A, &key, "nonce-register-mode1").await;

        assert_private_dir(tmp.path());
        assert_private_file(&db_path);
        assert_private_file(&sqlite_sidecar_path(&db_path, "-wal"));
        assert_private_file(&sqlite_sidecar_path(&db_path, "-shm"));
    }

    #[tokio::test]
    async fn rejects_invalid_signature() {
        let state = RelayState::default();
        let key = SigningKey::from_bytes(&[7; 32]);
        register_daemon_key(&state, DAEMON_A, &key).await;
        let body = serde_json::to_vec(&RegisterTokenRequest {
            daemon_node_id: DAEMON_A.to_string(),
            platform: PushPlatform::Apns,
            push_token: TOKEN.to_string(),
            nonce: "nonce-bad-sig-01".to_string(),
            ts_ms: now_ms(),
        })
        .unwrap();
        let response = test_app(state)
            .oneshot(
                Request::post("/v1/push/register-token")
                    .header(SIGNATURE_HEADER, "not-base64")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    const CODE: &str = "A1B2C";
    const TICKET_BLOB: &str = "sh1abcdefghijklmnopqrstuvwxyz234567";

    fn publish_body(code: &str, expires_at_ms: u64, nonce: &str, ts_ms: u64) -> Vec<u8> {
        serde_json::to_vec(&PublishLegacyPairingCodeRequest {
            daemon_node_id: DAEMON_A.to_string(),
            code: code.to_string(),
            ticket_blob: TICKET_BLOB.to_string(),
            expires_at_ms,
            nonce: nonce.to_string(),
            ts_ms,
        })
        .unwrap()
    }

    fn publish_rendezvous_body(code: &str, expires_at: u64, nonce: &str, ts_ms: u64) -> Vec<u8> {
        serde_json::to_vec(&PublishPairingRendezvousRequest {
            daemon_node_id: DAEMON_A.to_string(),
            locator: shelly_protocol::pairing_code_locator(code),
            rendezvous: PairingRendezvous {
                node_id: DAEMON_A.to_string(),
                relay_url: Some("https://iroh-relay.example".to_string()),
                addrs: vec!["127.0.0.1:7777".to_string()],
                expires_at,
            },
            nonce: nonce.to_string(),
            ts_ms,
        })
        .unwrap()
    }

    async fn resolve(state: &RelayState, code: &str) -> axum::response::Response {
        test_app(state.clone())
            .oneshot(
                Request::get(format!("/v1/pair/resolve/{code}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap()
    }

    async fn resolve_from_ip(
        state: &RelayState,
        code: &str,
        client_ip: &str,
    ) -> axum::response::Response {
        test_app(state.clone())
            .oneshot(
                Request::get(format!("/v1/pair/resolve/{code}"))
                    .header(FORWARDED_FOR_HEADER, client_ip)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn publishes_then_resolves_pairing_code() {
        let state = RelayState::default();
        let key = SigningKey::from_bytes(&[7; 32]);
        register_daemon_key(&state, DAEMON_A, &key).await;

        let expires = now_ms() + 5 * 60 * 1000;
        let body = publish_body(CODE, expires, "nonce-pair-publish1", now_ms());
        let response = signed_post(
            &state,
            &key,
            "/v1/pair/publish",
            body,
            "nonce-pair-publish1",
        )
        .await;
        assert_eq!(response.status(), StatusCode::CREATED);

        // Case-insensitive: lowercase input normalizes to the published code.
        let response = resolve(&state, "a1b2c").await;
        assert_eq!(response.status(), StatusCode::OK);
        let value: serde_json::Value =
            serde_json::from_str(&response_text(response).await).unwrap();
        assert_eq!(value["ticket_blob"], TICKET_BLOB);

        // A successful resolve consumes the code (single-use).
        assert_eq!(resolve(&state, CODE).await.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn v5_rendezvous_uses_hashed_locator_and_never_returns_the_code() {
        const V5_CODE: &str = "A1B2C3D";
        let state = RelayState::default();
        let key = SigningKey::from_bytes(&[7; 32]);
        register_daemon_key(&state, DAEMON_A, &key).await;
        let locator = shelly_protocol::pairing_code_locator(V5_CODE);
        let nonce = "nonce-pair-v5-publish";
        let body = publish_rendezvous_body(V5_CODE, now_ms() + 5 * 60 * 1000, nonce, now_ms());
        assert!(!String::from_utf8_lossy(&body).contains(V5_CODE));

        let response = signed_post(&state, &key, "/v1/pair/publish", body, nonce).await;
        assert_eq!(response.status(), StatusCode::CREATED);
        assert!(
            !state
                .inner
                .lock()
                .unwrap()
                .pairing_codes
                .contains_key(V5_CODE)
        );
        assert!(
            state
                .inner
                .lock()
                .unwrap()
                .pairing_codes
                .contains_key(&locator)
        );

        // Sending the v5 raw code to the relay is deliberately unsupported;
        // only the locally-computed locator resolves the code-free record.
        assert_eq!(
            resolve(&state, V5_CODE).await.status(),
            StatusCode::NOT_FOUND
        );
        let response = resolve(&state, &locator).await;
        assert_eq!(response.status(), StatusCode::OK);
        let text = response_text(response).await;
        assert!(!text.contains(V5_CODE));
        let value: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(value["rendezvous"]["node_id"], DAEMON_A);
        assert!(value.get("ticket_blob").is_none());
    }

    #[test]
    fn legacy_code_validator_stays_fixed_at_five_characters() {
        assert!(is_valid_legacy_code("A1B2C"));
        assert!(!is_valid_legacy_code("A1B2C3D"));
        assert_eq!(shelly_protocol::CODE_LEN, 7);
    }

    #[tokio::test]
    async fn unsigned_publish_is_rejected() {
        let state = RelayState::default();
        let key = SigningKey::from_bytes(&[7; 32]);
        register_daemon_key(&state, DAEMON_A, &key).await;

        let body = publish_body(
            CODE,
            now_ms() + 5 * 60 * 1000,
            "nonce-pair-unsigned",
            now_ms(),
        );
        let response = test_app(state.clone())
            .oneshot(
                Request::post("/v1/pair/publish")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(resolve(&state, CODE).await.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn publish_rejects_already_expired_code() {
        let state = RelayState::default();
        let key = SigningKey::from_bytes(&[7; 32]);
        register_daemon_key(&state, DAEMON_A, &key).await;

        let expired = now_ms().saturating_sub(1);
        let body = publish_body(CODE, expired, "nonce-pair-expired1", now_ms());
        let response = signed_post(
            &state,
            &key,
            "/v1/pair/publish",
            body,
            "nonce-pair-expired1",
        )
        .await;
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert_eq!(resolve(&state, CODE).await.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn expired_code_is_not_resolvable() {
        let state = RelayState::default();
        let key = SigningKey::from_bytes(&[7; 32]);
        register_daemon_key(&state, DAEMON_A, &key).await;

        // Publish a valid code, then age it out directly in state.
        let body = publish_body(CODE, now_ms() + 5 * 60 * 1000, "nonce-pair-aged1", now_ms());
        let response =
            signed_post(&state, &key, "/v1/pair/publish", body, "nonce-pair-aged1").await;
        assert_eq!(response.status(), StatusCode::CREATED);
        {
            let mut inner = state.inner.lock().expect("relay state lock poisoned");
            inner
                .pairing_codes
                .get_mut(CODE)
                .expect("published code")
                .expires_at_ms = now_ms().saturating_sub(1);
        }

        assert_eq!(resolve(&state, CODE).await.status(), StatusCode::NOT_FOUND);
        // Expired entry is evicted on the resolve miss.
        assert!(
            !state
                .inner
                .lock()
                .expect("relay state lock poisoned")
                .pairing_codes
                .contains_key(CODE)
        );
    }

    #[tokio::test]
    async fn resolve_rate_limits_per_client_ip() {
        // Caddy overwrites the rightmost hop with the real client. Any
        // attacker-supplied values to its left must not mint fresh budgets.
        let state = RelayState {
            trust_forwarded_for: true,
            ..RelayState::default()
        };

        for index in 0..RESOLVE_ATTEMPTS_PER_MINUTE {
            let forwarded = format!("198.51.100.{index}, 203.0.113.7");
            let response = resolve_from_ip(&state, "ABCDE", &forwarded).await;
            assert_eq!(
                response.status(),
                StatusCode::NOT_FOUND,
                "attempt {index} should miss, not throttle yet"
            );
        }
        // The next request from the same IP within the window is throttled.
        let response = resolve_from_ip(&state, "ABCDE", "192.0.2.99, 203.0.113.7").await;
        assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);

        // A different client IP still gets a fresh budget.
        let response = resolve_from_ip(&state, "ABCDE", "192.0.2.99, 203.0.113.8").await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn resolve_rate_limit_ignores_forwarded_for_without_trusted_proxy() {
        let state = RelayState::default();

        for index in 0..RESOLVE_ATTEMPTS_PER_MINUTE {
            let response = resolve_from_ip(&state, "ABCDE", &format!("203.0.113.{index}")).await;
            assert_eq!(
                response.status(),
                StatusCode::NOT_FOUND,
                "attempt {index} should miss, not throttle yet"
            );
        }
        // Spoofing a fresh x-forwarded-for value must not mint a fresh budget:
        // without the trusted-proxy flag the bucket keys on the socket address.
        let response = resolve_from_ip(&state, "ABCDE", "198.51.100.99").await;
        assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
    }

    #[tokio::test]
    async fn resolve_rejects_malformed_code_format() {
        let state = RelayState::default();
        // 'U' is not in the Crockford alphabet, and length is wrong: uniform 404.
        let response = resolve(&state, "UU").await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn sqlite_persists_pairing_code_across_restart() {
        let tmp = tempfile::tempdir().unwrap();
        let db_path = tmp.path().join("relay.db");
        let key = SigningKey::from_bytes(&[7; 32]);
        let state = RelayState::open_sqlite(&db_path).await.unwrap();
        register_daemon_key(&state, DAEMON_A, &key).await;

        let body = publish_body(
            CODE,
            now_ms() + 5 * 60 * 1000,
            "nonce-pair-sqlite1",
            now_ms(),
        );
        let response =
            signed_post(&state, &key, "/v1/pair/publish", body, "nonce-pair-sqlite1").await;
        assert_eq!(response.status(), StatusCode::CREATED);
        drop(state);

        let restored = RelayState::open_sqlite(&db_path).await.unwrap();
        let response = resolve(&restored, CODE).await;
        assert_eq!(response.status(), StatusCode::OK);
        let value: serde_json::Value =
            serde_json::from_str(&response_text(response).await).unwrap();
        assert_eq!(value["ticket_blob"], TICKET_BLOB);
    }

    #[tokio::test]
    async fn pairing_code_metrics_are_aggregate() {
        let state = RelayState::default();
        let key = SigningKey::from_bytes(&[7; 32]);
        register_daemon_key(&state, DAEMON_A, &key).await;

        let body = publish_body(
            CODE,
            now_ms() + 5 * 60 * 1000,
            "nonce-pair-metric1",
            now_ms(),
        );
        let response =
            signed_post(&state, &key, "/v1/pair/publish", body, "nonce-pair-metric1").await;
        assert_eq!(response.status(), StatusCode::CREATED);
        assert_eq!(resolve(&state, CODE).await.status(), StatusCode::OK);

        let metrics = state.metrics_text();
        assert!(metrics.contains("shelly_relay_pairing_code_publishes_total 1"));
        assert!(metrics.contains("shelly_relay_pairing_code_resolves_total 1"));
        assert!(!metrics.contains(CODE));
        assert!(!metrics.contains(TICKET_BLOB));
    }

    #[tokio::test]
    async fn register_daemon_rate_limits_per_client() {
        let state = RelayState::default();
        let key = SigningKey::from_bytes(&[7; 32]);

        for index in 0..REGISTER_ATTEMPTS_PER_MINUTE {
            let response =
                register_daemon_response(&state, &format!("daemon-node-rate-{index:04}"), &key)
                    .await;
            assert_eq!(
                response.status(),
                StatusCode::CREATED,
                "attempt {index} should register, not throttle yet"
            );
        }
        // The next registration from the same client is throttled.
        let response = register_daemon_response(&state, "daemon-node-rate-over", &key).await;
        assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
    }

    #[tokio::test]
    async fn register_daemon_accepts_same_key_idempotent_restart() {
        let state = RelayState::default();
        let key = SigningKey::from_bytes(&[7; 32]);

        register_daemon_key(&state, DAEMON_A, &key).await;
        register_daemon_key(&state, DAEMON_A, &key).await;

        assert_eq!(
            state
                .inner
                .lock()
                .expect("relay state lock poisoned")
                .daemons
                .len(),
            1
        );
    }

    #[tokio::test]
    async fn stage_one_registration_accepts_valid_optional_iroh_proof() {
        let state = RelayState::default();
        let relay_key = SigningKey::from_bytes(&[7; 32]);
        let daemon_key = iroh::SecretKey::from_bytes(&[9; 32]);
        let daemon_node_id = daemon_key.public().to_string();
        let ts_ms = now_ms();
        let nonce = "registration-proof-nonce-0001";
        let binding = registration_proof_binding(
            &daemon_node_id,
            &relay_key.verifying_key(),
            DEFAULT_REGISTRATION_AUDIENCE,
            nonce,
            ts_ms,
        );
        let proof = RegistrationProof {
            audience: DEFAULT_REGISTRATION_AUDIENCE.to_string(),
            nonce: nonce.to_string(),
            ts_ms,
            signature: BASE64.encode(daemon_key.sign(binding.as_bytes()).to_bytes()),
        };
        let body = serde_json::to_vec(&RegisterDaemonRequest {
            daemon_node_id: daemon_node_id.clone(),
            public_key: BASE64.encode(relay_key.verifying_key().to_bytes()),
            nonce: None,
            ts_ms: None,
            proof: Some(proof),
        })
        .unwrap();

        let response = test_app(state.clone())
            .oneshot(Request::post("/v1/pair").body(Body::from(body)).unwrap())
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::CREATED);
        assert!(
            state
                .inner
                .lock()
                .unwrap()
                .daemons
                .contains_key(&daemon_node_id)
        );
    }

    #[tokio::test]
    async fn stage_one_registration_still_accepts_no_proof() {
        let state = RelayState::default();
        let key = SigningKey::from_bytes(&[7; 32]);

        let response = register_daemon_response(&state, DAEMON_A, &key).await;

        assert_eq!(response.status(), StatusCode::CREATED);
    }

    #[tokio::test]
    async fn authenticated_activity_refreshes_registration_before_pruning() {
        let state = RelayState {
            prune_stale_daemons: true,
            daemon_retention_ms: 1_000,
            ..RelayState::default()
        };
        let key_a = SigningKey::from_bytes(&[7; 32]);
        let key_b = SigningKey::from_bytes(&[8; 32]);
        register_daemon_key(&state, DAEMON_A, &key_a).await;
        register_daemon_key(&state, DAEMON_B, &key_b).await;

        let current = now_ms();
        {
            let mut inner = state.inner.lock().unwrap();
            inner.daemons.get_mut(DAEMON_A).unwrap().updated_at_ms = current.saturating_sub(2_000);
            inner.daemons.get_mut(DAEMON_B).unwrap().updated_at_ms = current.saturating_sub(2_000);
            // Isolate the activity refresh from the amortized prune that runs
            // before signature verification.
            inner.pruned_at_ms = current;
        }
        register_token_for(&state, DAEMON_A, &key_a, "nonce-refresh-daemon-a").await;
        prune_expired_relay_state(&state, now_ms()).await;

        let inner = state.inner.lock().unwrap();
        assert!(inner.daemons.contains_key(DAEMON_A));
        assert!(!inner.daemons.contains_key(DAEMON_B));
    }

    #[tokio::test]
    async fn stale_daemon_pruning_defaults_off_but_can_be_enabled() {
        let tmp = tempfile::tempdir().unwrap();
        let db_path = tmp.path().join("relay.db");
        let key = SigningKey::from_bytes(&[7; 32]);
        let state = RelayState::open_sqlite(&db_path).await.unwrap();
        assert!(!state.prune_stale_daemons);
        register_daemon_key(&state, DAEMON_A, &key).await;
        let stale_at = now_ms().saturating_sub(DEFAULT_DAEMON_RETENTION_MS + 1);
        set_daemon_updated_at(&state, DAEMON_A, stale_at).await;

        prune_expired_relay_state(&state, now_ms()).await;
        assert!(state.inner.lock().unwrap().daemons.contains_key(DAEMON_A));
        drop(state);

        let pruned = RelayState::open_sqlite_with_policy(
            &db_path,
            true,
            DEFAULT_DAEMON_RETENTION_MS,
            DEFAULT_REGISTRATION_AUDIENCE,
        )
        .await
        .unwrap();
        assert!(!pruned.inner.lock().unwrap().daemons.contains_key(DAEMON_A));
    }

    #[tokio::test]
    async fn concurrent_first_registration_same_key_is_idempotent() {
        let state = RelayState::default();
        let key = SigningKey::from_bytes(&[7; 32]);

        let (first, second) = tokio::join!(
            register_daemon_response(&state, DAEMON_A, &key),
            register_daemon_response(&state, DAEMON_A, &key),
        );

        assert_eq!(first.status(), StatusCode::CREATED);
        assert_eq!(second.status(), StatusCode::CREATED);
        assert_eq!(
            state
                .inner
                .lock()
                .expect("relay state lock poisoned")
                .daemons
                .get(DAEMON_A)
                .map(|registration| registration.public_key),
            Some(key.verifying_key())
        );
    }

    #[tokio::test]
    async fn signed_rekey_updates_registered_daemon_key() {
        let state = RelayState::default();
        let old_key = SigningKey::from_bytes(&[7; 32]);
        let new_key = SigningKey::from_bytes(&[8; 32]);
        register_daemon_key(&state, DAEMON_A, &old_key).await;

        let response = signed_register_daemon_response(
            &state,
            DAEMON_A,
            &new_key,
            &old_key,
            "nonce-register-rekey1",
        )
        .await;

        assert_eq!(response.status(), StatusCode::CREATED);
        assert_eq!(
            state
                .inner
                .lock()
                .expect("relay state lock poisoned")
                .daemons
                .get(DAEMON_A)
                .map(|registration| registration.public_key),
            Some(new_key.verifying_key())
        );
    }

    #[tokio::test]
    async fn changed_key_registration_without_signature_is_rejected() {
        let state = RelayState::default();
        let old_key = SigningKey::from_bytes(&[7; 32]);
        let new_key = SigningKey::from_bytes(&[8; 32]);
        register_daemon_key(&state, DAEMON_A, &old_key).await;

        let response = register_daemon_response(&state, DAEMON_A, &new_key).await;

        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        assert_eq!(
            state
                .inner
                .lock()
                .expect("relay state lock poisoned")
                .daemons
                .get(DAEMON_A)
                .map(|registration| registration.public_key),
            Some(old_key.verifying_key())
        );
    }

    #[test]
    fn daemon_capacity_allows_same_id_overwrite_but_blocks_new_ids() {
        let mut inner = RelayInner::default();
        let key = SigningKey::from_bytes(&[7; 32]).verifying_key();
        let registration = DaemonRegistration {
            public_key: key,
            updated_at_ms: now_ms(),
        };
        inner.daemons.insert(DAEMON_A.to_string(), registration);
        inner.daemons.insert(DAEMON_B.to_string(), registration);

        assert!(!daemon_capacity_exceeded(&inner, DAEMON_A, 2));
        assert!(daemon_capacity_exceeded(
            &inner,
            "daemon-node-c-1234567890",
            2
        ));
        assert!(!daemon_capacity_exceeded(
            &inner,
            "daemon-node-c-1234567890",
            3
        ));
    }

    async fn register_daemon_key(state: &RelayState, daemon: &str, key: &SigningKey) {
        let response = register_daemon_response(state, daemon, key).await;
        assert_eq!(response.status(), StatusCode::CREATED);
    }

    async fn register_daemon_response(
        state: &RelayState,
        daemon: &str,
        key: &SigningKey,
    ) -> axum::response::Response {
        let body = serde_json::to_vec(&RegisterDaemonRequest {
            daemon_node_id: daemon.to_string(),
            public_key: BASE64.encode(key.verifying_key().to_bytes()),
            nonce: None,
            ts_ms: None,
            proof: None,
        })
        .unwrap();
        test_app(state.clone())
            .oneshot(Request::post("/v1/pair").body(Body::from(body)).unwrap())
            .await
            .unwrap()
    }

    async fn signed_register_daemon_response(
        state: &RelayState,
        daemon: &str,
        new_key: &SigningKey,
        signing_key: &SigningKey,
        nonce: &str,
    ) -> axum::response::Response {
        let ts_ms = now_ms();
        let body = serde_json::to_vec(&RegisterDaemonRequest {
            daemon_node_id: daemon.to_string(),
            public_key: BASE64.encode(new_key.verifying_key().to_bytes()),
            nonce: Some(nonce.to_string()),
            ts_ms: Some(ts_ms),
            proof: None,
        })
        .unwrap();
        signed_post(state, signing_key, "/v1/pair", body, nonce).await
    }

    async fn register_token_for(state: &RelayState, daemon: &str, key: &SigningKey, nonce: &str) {
        let response = register_token_response(state, daemon, key, nonce).await;
        assert_eq!(response.status(), StatusCode::CREATED);
    }

    async fn register_token_response(
        state: &RelayState,
        daemon: &str,
        key: &SigningKey,
        nonce: &str,
    ) -> axum::response::Response {
        let body = serde_json::to_vec(&RegisterTokenRequest {
            daemon_node_id: daemon.to_string(),
            platform: PushPlatform::Apns,
            push_token: TOKEN.to_string(),
            nonce: nonce.to_string(),
            ts_ms: now_ms(),
        })
        .unwrap();
        signed_post(state, key, "/v1/push/register-token", body, nonce).await
    }

    fn push_body(nonce: &str, ts_ms: u64) -> Vec<u8> {
        serde_json::to_vec(&PushRequest {
            daemon_node_id: DAEMON_A.to_string(),
            recipient_token: TOKEN.to_string(),
            platform: PushPlatform::Apns,
            session_id_hash: HASH_A.to_string(),
            event_type: PushEventType::AwaitingInput,
            nonce: nonce.to_string(),
            ts_ms,
        })
        .unwrap()
    }

    async fn signed_post(
        state: &RelayState,
        key: &SigningKey,
        path: &str,
        body: Vec<u8>,
        nonce: &str,
    ) -> axum::response::Response {
        let ts_ms = serde_json::from_slice::<serde_json::Value>(&body).unwrap()["ts_ms"]
            .as_u64()
            .unwrap();
        let signature = sign(key, path, &body, nonce, ts_ms);
        test_app(state.clone())
            .oneshot(
                Request::post(path)
                    .header(SIGNATURE_HEADER, signature)
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap()
    }

    async fn signed_post_v2(
        state: &RelayState,
        key: &SigningKey,
        path: &str,
        body: Vec<u8>,
        nonce: &str,
        relay_audience: &str,
    ) -> axum::response::Response {
        let ts_ms = serde_json::from_slice::<serde_json::Value>(&body).unwrap()["ts_ms"]
            .as_u64()
            .unwrap();
        let signature = sign_v2(key, relay_audience, path, &body, nonce, ts_ms);
        test_app(state.clone())
            .oneshot(
                Request::post(path)
                    .header(SIGNATURE_HEADER, signature)
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap()
    }

    fn sign(key: &SigningKey, path: &str, body: &[u8], nonce: &str, ts_ms: u64) -> String {
        let canonical = canonical_request("POST", path, body, nonce, ts_ms);
        BASE64.encode(key.sign(canonical.as_bytes()).to_bytes())
    }

    fn sign_v2(
        key: &SigningKey,
        relay_audience: &str,
        path: &str,
        body: &[u8],
        nonce: &str,
        ts_ms: u64,
    ) -> String {
        let canonical = canonical_request_v2(relay_audience, "POST", path, body, nonce, ts_ms);
        signature_header(
            SignatureVersion::V2,
            &BASE64.encode(key.sign(&canonical).to_bytes()),
        )
    }

    impl RelayState {
        fn delivered(&self) -> Vec<DeliveredPush> {
            self.inner
                .lock()
                .expect("relay state lock poisoned")
                .delivered
                .clone()
        }

        fn registered_token_count(&self) -> usize {
            self.inner
                .lock()
                .expect("relay state lock poisoned")
                .tokens
                .len()
        }
    }

    async fn set_daemon_updated_at(state: &RelayState, daemon_node_id: &str, updated_at_ms: u64) {
        state
            .inner
            .lock()
            .unwrap()
            .daemons
            .get_mut(daemon_node_id)
            .unwrap()
            .updated_at_ms = updated_at_ms;
        let store = state.store.as_ref().expect("sqlite store");
        let daemon_node_id = daemon_node_id.to_string();
        store
            .run(move |conn| {
                conn.execute(
                    "UPDATE daemons SET updated_at_ms = ?2 WHERE daemon_node_id = ?1",
                    params![daemon_node_id, updated_at_ms as i64],
                )?;
                Ok(())
            })
            .await
            .unwrap();
    }

    async fn set_token_updated_at(state: &RelayState, push_token: &str, updated_at_ms: u64) {
        set_stored_token_updated_at(state, push_token, updated_at_ms).await;
        state
            .inner
            .lock()
            .expect("relay state lock poisoned")
            .tokens
            .get_mut(push_token)
            .expect("registered token")
            .updated_at_ms = updated_at_ms;
    }

    async fn set_stored_token_updated_at(state: &RelayState, push_token: &str, updated_at_ms: u64) {
        let store = state.store.as_ref().expect("sqlite store");
        let push_token = push_token.to_string();
        store
            .run(move |conn| {
                conn.execute(
                    "UPDATE push_tokens SET updated_at_ms = ?2 WHERE push_token = ?1",
                    params![push_token, updated_at_ms as i64],
                )?;
                Ok(())
            })
            .await
            .unwrap();
    }

    async fn stored_token_count(state: &RelayState) -> usize {
        let store = state.store.as_ref().expect("sqlite store");
        store
            .run(|conn| {
                Ok(
                    conn.query_row("SELECT COUNT(*) FROM push_tokens", [], |row| {
                        row.get::<_, i64>(0)
                    })? as usize,
                )
            })
            .await
            .unwrap()
    }

    async fn stored_nonce_count(state: &RelayState) -> usize {
        let store = state.store.as_ref().expect("sqlite store");
        store
            .run(|conn| {
                Ok(
                    conn.query_row("SELECT COUNT(*) FROM seen_nonces", [], |row| {
                        row.get::<_, i64>(0)
                    })? as usize,
                )
            })
            .await
            .unwrap()
    }

    async fn stored_token_updated_at(state: &RelayState, push_token: &str) -> u64 {
        let store = state.store.as_ref().expect("sqlite store");
        let push_token = push_token.to_string();
        store
            .run(move |conn| {
                let updated_at_ms = conn.query_row(
                    "SELECT updated_at_ms FROM push_tokens WHERE push_token = ?1",
                    [push_token],
                    |row| row.get::<_, i64>(0),
                )?;
                Ok(u64::try_from(updated_at_ms)?)
            })
            .await
            .unwrap()
    }

    async fn response_text(response: Response) -> String {
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        String::from_utf8(bytes.to_vec()).unwrap()
    }

    async fn bind_loopback_for_test() -> Option<tokio::net::TcpListener> {
        match tokio::net::TcpListener::bind("127.0.0.1:0").await {
            Ok(listener) => Some(listener),
            Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => None,
            Err(error) => panic!("bind loopback test listener: {error}"),
        }
    }

    #[cfg(unix)]
    fn assert_private_file(path: &Path) {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "{} should be mode 0600", path.display());
    }

    #[cfg(unix)]
    fn assert_private_dir(path: &Path) {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o700, "{} should be mode 0700", path.display());
    }
}
