#![warn(missing_docs)]
//! HTTP control plane, push gateway, and metrics surface for Fieldwork relay.

mod apns;
mod fcm;

use axum::{
    Router,
    body::Bytes,
    extract::{Path as AxumPath, State},
    http::{HeaderMap, Method, StatusCode, header::CONTENT_TYPE},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use axum_server::tls_rustls::RustlsConfig;
use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use fieldwork_protocol::{CONTRACT_VERSION, is_valid_code, normalize_code};
use garde::Validate;
use moka::sync::Cache;
use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
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

const SIGNATURE_HEADER: &str = "x-fieldwork-signature";
const FORWARDED_FOR_HEADER: &str = "x-forwarded-for";
const CLOCK_SKEW_MS: i64 = 5 * 60 * 1000;
const RATE_LIMIT_PER_MINUTE: u32 = 50;
const RATE_LIMIT_CACHE_CAPACITY: u64 = 100_000;
const PUSH_TOKEN_TTL_MS: u64 = 90 * 24 * 60 * 60 * 1000;
/// Per-IP cap on pairing-code resolution attempts inside one minute window.
const RESOLVE_ATTEMPTS_PER_MINUTE: u32 = 20;
/// Failed resolves a single code tolerates before it is locked and deleted.
const RESOLVE_MAX_FAILURES_PER_CODE: u32 = 5;

/// Shared relay application state.
#[derive(Clone, Default)]
pub struct RelayState {
    inner: Arc<Mutex<RelayInner>>,
    metrics: Arc<RelayMetrics>,
    rate_limits: RateLimitCache,
    resolve_rate_limits: RateLimitCache,
    version_cache: VersionCache,
    providers: PushProviders,
    store: Option<RelayStore>,
}

#[derive(Default)]
struct RelayInner {
    daemons: HashMap<String, VerifyingKey>,
    tokens: HashMap<String, TokenOwner>,
    seen_nonces: HashSet<(String, String)>,
    pairing_codes: HashMap<String, PairingCodeEntry>,
    #[cfg(test)]
    delivered: Vec<DeliveredPush>,
}

#[derive(Clone)]
struct PairingCodeEntry {
    daemon_node_id: String,
    ticket_blob: String,
    expires_at_ms: u64,
    failed_resolves: u32,
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

#[derive(Clone)]
struct VersionCache {
    responses: Cache<&'static str, VersionResponse>,
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
    db_path: Arc<PathBuf>,
}

type LoadedRelayState = (
    HashMap<String, VerifyingKey>,
    HashMap<String, TokenOwner>,
    HashSet<(String, String)>,
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
}

impl PushEventType {
    pub(crate) fn as_str(&self) -> &'static str {
        match self {
            Self::AwaitingInput => "awaiting_input",
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
struct PublishPairingCodeRequest {
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
struct PushRequest {
    #[garde(ascii, length(min = 16, max = 128))]
    daemon_node_id: String,
    #[garde(length(min = 16, max = 4096))]
    recipient_token: String,
    #[garde(dive)]
    platform: PushPlatform,
    #[garde(pattern(r"^[0-9a-f]{64}$"))]
    session_id_hash: String,
    #[garde(pattern(r"^[0-9a-f]{64}$"))]
    session_name_hash: String,
    #[garde(dive)]
    event_type: PushEventType,
    #[garde(ascii, length(min = 16, max = 128))]
    nonce: String,
    #[garde(range(min = 1))]
    ts_ms: u64,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub(crate) struct DeliveredPush {
    pub(crate) platform: PushPlatform,
    pub(crate) recipient_token: String,
    pub(crate) title: String,
    pub(crate) body: String,
    pub(crate) thread_id: String,
    pub(crate) session_id_hash: String,
    pub(crate) session_name_hash: String,
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
struct ApiErrorBody {
    code: &'static str,
    message: String,
}

#[derive(Debug)]
struct ApiError {
    status: StatusCode,
    code: &'static str,
    message: String,
}

impl ApiError {
    fn bad_request(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            code: "bad_request",
            message: message.into(),
        }
    }

    fn unauthorized(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::UNAUTHORIZED,
            code: "unauthorized",
            message: message.into(),
        }
    }

    fn forbidden(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::FORBIDDEN,
            code: "forbidden",
            message: message.into(),
        }
    }

    fn replay() -> Self {
        Self {
            status: StatusCode::CONFLICT,
            code: "replay_detected",
            message: "nonce was already used".to_string(),
        }
    }

    fn clock_skew() -> Self {
        Self {
            status: StatusCode::UNAUTHORIZED,
            code: "clock_skew",
            message: "timestamp is outside the accepted skew window".to_string(),
        }
    }

    fn rate_limited() -> Self {
        Self {
            status: StatusCode::TOO_MANY_REQUESTS,
            code: "rate_limited",
            message: "per-daemon push rate limit exceeded".to_string(),
        }
    }

    fn resolve_rate_limited() -> Self {
        Self {
            status: StatusCode::TOO_MANY_REQUESTS,
            code: "rate_limited",
            message: "per-client pairing-code resolve rate limit exceeded".to_string(),
        }
    }

    fn not_found(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::NOT_FOUND,
            code: "not_found",
            message: message.into(),
        }
    }

    fn internal(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            code: "internal",
            message: message.into(),
        }
    }

    fn provider_error(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_GATEWAY,
            code: "provider_error",
            message: message.into(),
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
            }),
        )
            .into_response()
    }
}

impl RelayState {
    /// Opens a persistent SQLite-backed relay state store.
    pub fn open_sqlite(path: impl AsRef<Path>) -> anyhow::Result<Self> {
        let store = RelayStore::open(path.as_ref())?;
        let (daemons, tokens, seen_nonces, pairing_codes) = store.load_state(now_ms())?;
        Ok(Self {
            inner: Arc::new(Mutex::new(RelayInner {
                daemons,
                tokens,
                seen_nonces,
                pairing_codes,
                #[cfg(test)]
                delivered: Vec::new(),
            })),
            metrics: Arc::default(),
            rate_limits: RateLimitCache::default(),
            resolve_rate_limits: RateLimitCache::default(),
            version_cache: VersionCache::default(),
            providers: PushProviders::from_env()?,
            store: Some(store),
        })
    }

    /// Builds relay state from production environment variables.
    pub fn from_env() -> anyhow::Result<Self> {
        let path = std::env::var("FIELDWORK_RELAY_DB_PATH")
            .unwrap_or_else(|_| "/var/lib/fieldwork/relay.db".to_string());
        if path.trim().is_empty() || path == "off" {
            return Ok(Self::default());
        }
        Self::open_sqlite(path)
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

impl Default for VersionCache {
    fn default() -> Self {
        Self {
            responses: Cache::builder()
                .max_capacity(1)
                .time_to_live(Duration::from_secs(5 * 60))
                .build(),
        }
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

impl VersionCache {
    fn get(&self) -> VersionResponse {
        self.responses.get_with("default", build_version_response)
    }
}

impl RelayStore {
    fn open(path: &Path) -> anyhow::Result<Self> {
        prepare_database_path(path)?;
        let conn = Connection::open(path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS daemons (
                daemon_node_id TEXT PRIMARY KEY NOT NULL,
                public_key BLOB NOT NULL,
                updated_at_ms INTEGER NOT NULL
            );
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
        set_private_database_permissions(path)?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
            db_path: Arc::new(path.to_path_buf()),
        })
    }

    fn load_state(&self, now_ms: u64) -> anyhow::Result<LoadedRelayState> {
        self.prune_old_nonces(now_ms)?;
        self.prune_old_tokens(now_ms)?;
        self.prune_expired_codes(now_ms)?;
        let conn = self.conn.lock().expect("relay sqlite lock poisoned");

        let mut daemons = HashMap::new();
        let mut stmt = conn.prepare("SELECT daemon_node_id, public_key FROM daemons")?;
        let rows = stmt.query_map([], |row| {
            let daemon_node_id: String = row.get(0)?;
            let public_key: Vec<u8> = row.get(1)?;
            Ok((daemon_node_id, public_key))
        })?;
        for row in rows {
            let (daemon_node_id, public_key) = row?;
            let public_key: [u8; 32] = public_key
                .try_into()
                .map_err(|_| anyhow::anyhow!("stored daemon public key is not 32 bytes"))?;
            daemons.insert(daemon_node_id, VerifyingKey::from_bytes(&public_key)?);
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
                    updated_at_ms: updated_at_ms
                        .try_into()
                        .map_err(|_| anyhow::anyhow!("stored push token timestamp is negative"))?,
                },
            );
        }

        let mut seen_nonces = HashSet::new();
        let mut stmt = conn.prepare("SELECT daemon_node_id, nonce FROM seen_nonces")?;
        let rows = stmt.query_map([], |row| {
            let daemon_node_id: String = row.get(0)?;
            let nonce: String = row.get(1)?;
            Ok((daemon_node_id, nonce))
        })?;
        for row in rows {
            seen_nonces.insert(row?);
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
            pairing_codes.insert(
                code,
                PairingCodeEntry {
                    daemon_node_id,
                    ticket_blob,
                    expires_at_ms: expires_at_ms
                        .try_into()
                        .map_err(|_| anyhow::anyhow!("stored pairing code expiry is negative"))?,
                    failed_resolves: 0,
                },
            );
        }

        Ok((daemons, tokens, seen_nonces, pairing_codes))
    }

    fn save_daemon(&self, daemon_node_id: &str, public_key: &VerifyingKey) -> anyhow::Result<()> {
        {
            let conn = self.conn.lock().expect("relay sqlite lock poisoned");
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
                    public_key.to_bytes().as_slice(),
                    now_ms() as i64
                ],
            )?;
        }
        self.set_private_permissions()?;
        Ok(())
    }

    fn save_token(
        &self,
        push_token: &str,
        daemon_node_id: &str,
        platform: &PushPlatform,
    ) -> anyhow::Result<()> {
        {
            let conn = self.conn.lock().expect("relay sqlite lock poisoned");
            conn.execute(
                r#"
                INSERT INTO push_tokens (push_token, daemon_node_id, platform, updated_at_ms)
                VALUES (?1, ?2, ?3, ?4)
                ON CONFLICT(push_token) DO UPDATE SET
                    daemon_node_id = excluded.daemon_node_id,
                    platform = excluded.platform,
                    updated_at_ms = excluded.updated_at_ms
                "#,
                params![
                    push_token,
                    daemon_node_id,
                    platform.as_str(),
                    now_ms() as i64
                ],
            )?;
        }
        self.set_private_permissions()?;
        Ok(())
    }

    fn touch_token(&self, push_token: &str, updated_at_ms: u64) -> anyhow::Result<()> {
        {
            let conn = self.conn.lock().expect("relay sqlite lock poisoned");
            conn.execute(
                "UPDATE push_tokens SET updated_at_ms = ?2 WHERE push_token = ?1",
                params![push_token, updated_at_ms as i64],
            )?;
        }
        self.set_private_permissions()?;
        Ok(())
    }

    fn remove_token(&self, push_token: &str) -> anyhow::Result<()> {
        {
            let conn = self.conn.lock().expect("relay sqlite lock poisoned");
            conn.execute(
                "DELETE FROM push_tokens WHERE push_token = ?1",
                [push_token],
            )?;
        }
        self.set_private_permissions()?;
        Ok(())
    }

    fn prune_old_tokens(&self, now_ms: u64) -> anyhow::Result<()> {
        let cutoff = now_ms.saturating_sub(PUSH_TOKEN_TTL_MS);
        {
            let conn = self.conn.lock().expect("relay sqlite lock poisoned");
            conn.execute(
                "DELETE FROM push_tokens WHERE updated_at_ms < ?1",
                [cutoff as i64],
            )?;
        }
        self.set_private_permissions()?;
        Ok(())
    }

    fn insert_nonce(&self, daemon_node_id: &str, nonce: &str, ts_ms: u64) -> anyhow::Result<bool> {
        let inserted = {
            let conn = self.conn.lock().expect("relay sqlite lock poisoned");
            conn.execute(
                r#"
                INSERT OR IGNORE INTO seen_nonces (daemon_node_id, nonce, ts_ms)
                VALUES (?1, ?2, ?3)
                "#,
                params![daemon_node_id, nonce, ts_ms as i64],
            )?
        };
        self.set_private_permissions()?;
        Ok(inserted == 1)
    }

    fn prune_old_nonces(&self, now_ms: u64) -> anyhow::Result<()> {
        let cutoff = now_ms.saturating_sub(CLOCK_SKEW_MS as u64);
        {
            let conn = self.conn.lock().expect("relay sqlite lock poisoned");
            conn.execute("DELETE FROM seen_nonces WHERE ts_ms < ?1", [cutoff as i64])?;
        }
        self.set_private_permissions()?;
        Ok(())
    }

    fn save_pairing_code(
        &self,
        code: &str,
        daemon_node_id: &str,
        ticket_blob: &str,
        expires_at_ms: u64,
    ) -> anyhow::Result<()> {
        {
            let conn = self.conn.lock().expect("relay sqlite lock poisoned");
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
                    now_ms() as i64
                ],
            )?;
        }
        self.set_private_permissions()?;
        Ok(())
    }

    fn delete_pairing_code(&self, code: &str) -> anyhow::Result<()> {
        {
            let conn = self.conn.lock().expect("relay sqlite lock poisoned");
            conn.execute("DELETE FROM pairing_codes WHERE code = ?1", [code])?;
        }
        self.set_private_permissions()?;
        Ok(())
    }

    fn prune_expired_codes(&self, now_ms: u64) -> anyhow::Result<()> {
        {
            let conn = self.conn.lock().expect("relay sqlite lock poisoned");
            conn.execute(
                "DELETE FROM pairing_codes WHERE expires_at_ms <= ?1",
                [now_ms as i64],
            )?;
        }
        self.set_private_permissions()?;
        Ok(())
    }

    fn set_private_permissions(&self) -> anyhow::Result<()> {
        set_private_database_permissions(&self.db_path)
    }
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
}

/// Builds the aggregate Prometheus metrics router.
pub fn metrics_app(state: RelayState) -> Router {
    Router::new()
        .route("/metrics", get(metrics))
        .with_state(state)
}

/// Serves the relay control plane with the default local metrics listener.
pub async fn serve(addr: &str) -> anyhow::Result<()> {
    serve_with_metrics(addr, Some("127.0.0.1:9090")).await
}

/// Serves the relay control plane and optionally serves aggregate metrics.
pub async fn serve_with_metrics(addr: &str, metrics_addr: Option<&str>) -> anyhow::Result<()> {
    let state = RelayState::from_env()?;
    serve_metrics_if_configured(&state, metrics_addr).await?;

    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!(%addr, "fieldwork relay listening");
    axum::serve(listener, app(state)).await?;
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
    let state = RelayState::from_env()?;
    serve_metrics_if_configured(&state, metrics_addr).await?;

    let tls_config = RustlsConfig::from_pem_file(cert_path, key_path).await?;
    let addr: SocketAddr = addr.parse()?;
    tracing::info!(%addr, "fieldwork relay TLS control plane listening");
    axum_server::bind_rustls(addr, tls_config)
        .serve(app(state).into_make_service())
        .await?;
    Ok(())
}

fn install_default_rustls_provider() {
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
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
    tracing::info!(addr = %metrics_addr, "fieldwork relay metrics listening");
    tokio::spawn(async move {
        if let Err(error) = axum::serve(metrics_listener, metrics_app(metrics_state)).await {
            tracing::error!(%error, "fieldwork relay metrics listener stopped");
        }
    });
    Ok(())
}

async fn metrics(State(state): State<RelayState>) -> impl IntoResponse {
    (
        [(CONTENT_TYPE, "text/plain; version=0.0.4; charset=utf-8")],
        state.metrics_text(),
    )
}

#[tracing::instrument(name = "relay.version", skip_all, fields(endpoint = "/v1/version"))]
async fn version(State(state): State<RelayState>) -> impl IntoResponse {
    axum::Json(state.version_cache.get())
}

#[tracing::instrument(
    name = "relay.register_daemon",
    skip_all,
    fields(endpoint = "/v1/pair")
)]
async fn register_daemon(
    State(state): State<RelayState>,
    bytes: Bytes,
) -> Result<impl IntoResponse, ApiError> {
    let request: RegisterDaemonRequest = parse_validated(&bytes)?;
    let public_key = decode_public_key(&request.public_key)?;
    if let Some(store) = &state.store {
        store
            .save_daemon(&request.daemon_node_id, &public_key)
            .map_err(|error| ApiError::internal(format!("persist daemon registration: {error}")))?;
    }
    state
        .inner
        .lock()
        .expect("relay state lock poisoned")
        .daemons
        .insert(request.daemon_node_id, public_key);
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
    verify_signed_request(
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
    )?;
    if let Some(store) = &state.store {
        store
            .save_token(
                &request.push_token,
                &request.daemon_node_id,
                &request.platform,
            )
            .map_err(|error| ApiError::internal(format!("persist push token: {error}")))?;
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
                updated_at_ms: now_ms(),
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
    )?;
    remove_push_token_binding(&state, &request.push_token, "remove push token")?;
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
    )?;

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
        remove_push_token_binding(&state, &request.recipient_token, "remove stale push token")?;
        return Err(ApiError::forbidden("push token is not registered"));
    }

    let minute = request.ts_ms / 60_000;
    if state.rate_limits.increment(&request.daemon_node_id, minute) > RATE_LIMIT_PER_MINUTE {
        return Err(ApiError::rate_limited());
    }

    let delivery = DeliveredPush {
        platform: request.platform,
        recipient_token: request.recipient_token,
        title: "Fieldwork".to_string(),
        body: "A session is waiting for you.".to_string(),
        thread_id: format!("session.{}", request.session_id_hash),
        session_id_hash: request.session_id_hash,
        session_name_hash: request.session_name_hash,
        event_type: request.event_type,
    };
    if let Err(error) = state.providers.deliver(&delivery).await {
        if error.is_invalid_token() {
            remove_push_token_binding(
                &state,
                &delivery.recipient_token,
                "remove invalid push token",
            )?;
            tracing::warn!(
                provider = error.provider(),
                reason = error.reason().unwrap_or("invalid_token"),
                "relay provider rejected stale push token; binding removed"
            );
        }
        return Err(ApiError::provider_error(error.to_string()));
    }
    touch_push_token_binding(&state, &delivery.recipient_token, now_ms())?;

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
    let request: PublishPairingCodeRequest = parse_validated(&bytes)?;
    verify_signed_request(
        &state,
        SignedRequestContext {
            method: Method::POST.as_str(),
            path: "/v1/pair/publish",
            body: &bytes,
            headers: &headers,
            daemon_node_id: &request.daemon_node_id,
            nonce: &request.nonce,
            ts_ms: request.ts_ms,
        },
    )?;

    if request.expires_at_ms <= now_ms() {
        return Err(ApiError::bad_request(
            "pairing code is already expired at publish time",
        ));
    }

    let code = normalize_code(&request.code);

    // A daemon advertises a single active code at a time; supersede any prior
    // code it published so stale entries cannot linger in the resolve oracle.
    let superseded = evict_codes_for_daemon(&state, &request.daemon_node_id, &code);

    if let Some(store) = &state.store {
        for stale in &superseded {
            if let Err(error) = store.delete_pairing_code(stale) {
                tracing::warn!(%error, "failed to delete superseded pairing code");
            }
        }
        store
            .save_pairing_code(
                &code,
                &request.daemon_node_id,
                &request.ticket_blob,
                request.expires_at_ms,
            )
            .map_err(|error| ApiError::internal(format!("persist pairing code: {error}")))?;
    }
    state
        .inner
        .lock()
        .expect("relay state lock poisoned")
        .pairing_codes
        .insert(
            code,
            PairingCodeEntry {
                daemon_node_id: request.daemon_node_id,
                ticket_blob: request.ticket_blob,
                expires_at_ms: request.expires_at_ms,
                failed_resolves: 0,
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
    headers: HeaderMap,
    AxumPath(code): AxumPath<String>,
) -> Result<impl IntoResponse, ApiError> {
    // Defend the internet-facing oracle before touching the code store: a
    // weak short code only stays secret behind per-client throttling.
    let client = client_identifier(&headers);
    let minute = now_ms() / 60_000;
    if state.resolve_rate_limits.increment(&client, minute) > RESOLVE_ATTEMPTS_PER_MINUTE {
        return Err(ApiError::resolve_rate_limited());
    }

    let code = normalize_code(&code);
    if !is_valid_code(&code) {
        // Uniform 404: never reveal whether the format or the lookup failed.
        return Err(ApiError::not_found("pairing code not found"));
    }

    let resolution = {
        let mut inner = state.inner.lock().expect("relay state lock poisoned");
        match inner.pairing_codes.get_mut(&code) {
            Some(entry) if entry.expires_at_ms <= now_ms() => {
                inner.pairing_codes.remove(&code);
                CodeResolution::Miss { delete: true }
            }
            Some(entry) => CodeResolution::Hit {
                ticket_blob: entry.ticket_blob.clone(),
            },
            None => CodeResolution::Miss { delete: false },
        }
    };

    match resolution {
        CodeResolution::Hit { ticket_blob } => {
            // A correct guess consumes the code so it cannot be replayed.
            forget_pairing_code(&state, &code);
            state
                .metrics
                .pairing_code_resolves
                .fetch_add(1, Ordering::Relaxed);
            tracing::info!("relay pairing code resolve hit");
            Ok((
                StatusCode::OK,
                axum::Json(ResolvePairingCodeResponse { ticket_blob }),
            ))
        }
        CodeResolution::Miss { delete } => {
            if delete {
                // Expired entry already dropped from memory; clear sqlite too.
                if let Some(store) = &state.store
                    && let Err(error) = store.delete_pairing_code(&code)
                {
                    tracing::warn!(%error, "failed to delete expired pairing code");
                }
            } else {
                register_failed_resolve(&state, &code);
            }
            Err(ApiError::not_found("pairing code not found"))
        }
    }
}

enum CodeResolution {
    Hit { ticket_blob: String },
    Miss { delete: bool },
}

/// Records a wrong guess against a present code and locks it after the cap so a
/// brute-force walk over the short keyspace cannot outlast a single code.
fn register_failed_resolve(state: &RelayState, code: &str) {
    let lock_out = {
        let mut inner = state.inner.lock().expect("relay state lock poisoned");
        match inner.pairing_codes.get_mut(code) {
            Some(entry) => {
                entry.failed_resolves += 1;
                if entry.failed_resolves >= RESOLVE_MAX_FAILURES_PER_CODE {
                    inner.pairing_codes.remove(code);
                    true
                } else {
                    false
                }
            }
            None => false,
        }
    };
    if lock_out
        && let Some(store) = &state.store
        && let Err(error) = store.delete_pairing_code(code)
    {
        tracing::warn!(%error, "failed to delete locked-out pairing code");
    }
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
fn forget_pairing_code(state: &RelayState, code: &str) {
    state
        .inner
        .lock()
        .expect("relay state lock poisoned")
        .pairing_codes
        .remove(code);
    if let Some(store) = &state.store
        && let Err(error) = store.delete_pairing_code(code)
    {
        tracing::warn!(%error, "failed to delete resolved pairing code");
    }
}

/// Derives the rate-limit bucket for a resolve caller. Behind the hosted
/// reverse proxy the real client is the first `x-forwarded-for` hop; absent
/// that header (e.g. direct/local callers) every request shares one bucket.
fn client_identifier(headers: &HeaderMap) -> String {
    headers
        .get(FORWARDED_FOR_HEADER)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(',').next())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "unknown".to_string())
}

fn remove_push_token_binding(
    state: &RelayState,
    push_token: &str,
    context: &'static str,
) -> Result<(), ApiError> {
    if let Some(store) = &state.store {
        store
            .remove_token(push_token)
            .map_err(|error| ApiError::internal(format!("{context}: {error}")))?;
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

fn touch_push_token_binding(
    state: &RelayState,
    push_token: &str,
    updated_at_ms: u64,
) -> Result<(), ApiError> {
    if let Some(store) = &state.store {
        store
            .touch_token(push_token, updated_at_ms)
            .map_err(|error| ApiError::internal(format!("touch push token: {error}")))?;
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

fn parse_validated<T>(bytes: &[u8]) -> Result<T, ApiError>
where
    T: DeserializeOwned + Validate,
    T::Context: Default,
{
    let value: T = serde_json::from_slice(bytes).map_err(|error| {
        ApiError::bad_request(format!("request body is not valid relay JSON: {error}"))
    })?;
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

fn verify_signed_request(
    state: &RelayState,
    request: SignedRequestContext<'_>,
) -> Result<(), ApiError> {
    let now = now_ms();
    if (now as i64 - request.ts_ms as i64).abs() > CLOCK_SKEW_MS {
        return Err(ApiError::clock_skew());
    }

    let signature = request
        .headers
        .get(SIGNATURE_HEADER)
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| ApiError::unauthorized("missing fieldwork signature"))?;
    let signature = decode_signature(signature)?;

    let canonical = canonical_request(
        request.method,
        request.path,
        request.body,
        request.nonce,
        request.ts_ms,
    );
    let mut inner = state.inner.lock().expect("relay state lock poisoned");
    let key = inner
        .daemons
        .get(request.daemon_node_id)
        .ok_or_else(|| ApiError::unauthorized("unknown daemon"))?;
    key.verify(canonical.as_bytes(), &signature)
        .map_err(|_| ApiError::unauthorized("invalid fieldwork signature"))?;

    let seen_key = (
        request.daemon_node_id.to_string(),
        request.nonce.to_string(),
    );
    if !inner.seen_nonces.insert(seen_key) {
        return Err(ApiError::replay());
    }
    if let Some(store) = &state.store {
        let inserted = store
            .insert_nonce(request.daemon_node_id, request.nonce, request.ts_ms)
            .map_err(|error| ApiError::internal(format!("persist replay nonce: {error}")))?;
        if !inserted {
            return Err(ApiError::replay());
        }
    }

    Ok(())
}

fn canonical_request(method: &str, path: &str, body: &[u8], nonce: &str, ts_ms: u64) -> String {
    format!(
        "{method}\n{path}\n{}\n{nonce}\n{ts_ms}",
        String::from_utf8_lossy(body)
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
                "# HELP fieldwork_relay_daemon_registrations_total Daemon public-key registrations accepted by the relay.\n",
                "# TYPE fieldwork_relay_daemon_registrations_total counter\n",
                "fieldwork_relay_daemon_registrations_total {}\n",
                "# HELP fieldwork_relay_push_token_registrations_total Push tokens registered by paired daemons.\n",
                "# TYPE fieldwork_relay_push_token_registrations_total counter\n",
                "fieldwork_relay_push_token_registrations_total {}\n",
                "# HELP fieldwork_relay_push_token_unregistrations_total Push tokens removed by paired daemons.\n",
                "# TYPE fieldwork_relay_push_token_unregistrations_total counter\n",
                "fieldwork_relay_push_token_unregistrations_total {}\n",
                "# HELP fieldwork_relay_push_accepts_total Privacy-preserving push requests accepted for provider delivery.\n",
                "# TYPE fieldwork_relay_push_accepts_total counter\n",
                "fieldwork_relay_push_accepts_total {}\n",
                "# HELP fieldwork_relay_pairing_code_publishes_total Pairing codes published by paired daemons.\n",
                "# TYPE fieldwork_relay_pairing_code_publishes_total counter\n",
                "fieldwork_relay_pairing_code_publishes_total {}\n",
                "# HELP fieldwork_relay_pairing_code_resolves_total Pairing codes successfully resolved to reachability tickets.\n",
                "# TYPE fieldwork_relay_pairing_code_resolves_total counter\n",
                "fieldwork_relay_pairing_code_resolves_total {}\n",
                "# HELP fieldwork_relay_active_daemons Active daemon public keys retained in relay memory.\n",
                "# TYPE fieldwork_relay_active_daemons gauge\n",
                "fieldwork_relay_active_daemons {}\n",
                "# HELP fieldwork_relay_registered_push_tokens Active push tokens retained in relay memory.\n",
                "# TYPE fieldwork_relay_registered_push_tokens gauge\n",
                "fieldwork_relay_registered_push_tokens {}\n",
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
                    "# HELP fieldwork_relay_buffered_deliveries Generic local delivery records retained only in test builds.\n",
                    "# TYPE fieldwork_relay_buffered_deliveries gauge\n",
                    "fieldwork_relay_buffered_deliveries {}\n",
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
        http::Request,
        routing::post,
    };
    use ed25519_dalek::{Signer, SigningKey};
    use tower::ServiceExt;

    const DAEMON_A: &str = "daemon-node-a-1234567890";
    const DAEMON_B: &str = "daemon-node-b-1234567890";
    const TOKEN: &str = "apns-token-for-device-a";
    const HASH_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const HASH_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
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
            session_name_hash: HASH_B.to_string(),
            event_type: PushEventType::AwaitingInput,
            nonce: "nonce-push-00001".to_string(),
            ts_ms: now_ms(),
        })
        .unwrap();
        let response = signed_post(&state, &key, "/v1/push", body, "nonce-push-00001").await;
        assert_eq!(response.status(), StatusCode::ACCEPTED);

        let delivered = state.delivered();
        assert_eq!(delivered.len(), 1);
        assert_eq!(delivered[0].title, "Fieldwork");
        assert_eq!(delivered[0].body, "A session is waiting for you.");
        assert!(!delivered[0].body.contains("secret"));
        assert_eq!(delivered[0].thread_id, format!("session.{HASH_A}"));
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
            session_name_hash: HASH_B.to_string(),
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

    #[test]
    fn rate_limit_cache_expires_window_counters() {
        let cache = RateLimitCache::with_ttl(Duration::from_millis(10));
        assert_eq!(cache.increment(DAEMON_A, 1), 1);

        std::thread::sleep(Duration::from_millis(50));
        cache.counters.run_pending_tasks();

        assert_eq!(cache.increment(DAEMON_A, 1), 1);
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
        let response = app(state)
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
                "session_name_hash",
                "gggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggg",
                "nonce-hash-bad002",
            ),
            (
                "session_id_hash",
                "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
                "nonce-hash-bad003",
            ),
        ] {
            let mut body = serde_json::json!({
                "daemon_node_id": DAEMON_A,
                "recipient_token": TOKEN,
                "platform": "apns",
                "session_id_hash": HASH_A,
                "session_name_hash": HASH_B,
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
                "session_name_hash": HASH_B,
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
            session_name_hash: HASH_B.to_string(),
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
        assert!(body.contains("fieldwork_relay_daemon_registrations_total 1"));
        assert!(body.contains("fieldwork_relay_push_token_registrations_total 1"));
        assert!(body.contains("fieldwork_relay_push_accepts_total 1"));
        assert!(!body.contains(DAEMON_A));
        assert!(!body.contains(TOKEN));
        assert!(!body.contains(HASH_A));
        assert!(!body.contains(HASH_B));
    }

    #[tokio::test]
    async fn version_endpoint_reports_contract_without_private_identifiers() {
        let state = RelayState::default();
        let key = SigningKey::from_bytes(&[7; 32]);
        register_daemon_key(&state, DAEMON_A, &key).await;
        register_token_for(&state, DAEMON_A, &key, "nonce-register-version").await;

        let response = app(state)
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
        let state = RelayState::open_sqlite(&db_path).unwrap();
        register_daemon_key(&state, DAEMON_A, &key).await;
        register_token_for(&state, DAEMON_A, &key, "nonce-register-sqlite1").await;
        drop(state);

        let restored = RelayState::open_sqlite(&db_path).unwrap();
        let body = serde_json::to_vec(&PushRequest {
            daemon_node_id: DAEMON_A.to_string(),
            recipient_token: TOKEN.to_string(),
            platform: PushPlatform::Apns,
            session_id_hash: HASH_A.to_string(),
            session_name_hash: HASH_B.to_string(),
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
        let state = RelayState::open_sqlite(&db_path).unwrap();
        register_daemon_key(&state, DAEMON_A, &key).await;
        register_token_for(&state, DAEMON_A, &key, "nonce-replay-sqlite1").await;
        drop(state);

        let restored = RelayState::open_sqlite(&db_path).unwrap();
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
        let state = RelayState::open_sqlite(&db_path).unwrap();
        register_daemon_key(&state, DAEMON_A, &key).await;
        register_token_for(&state, DAEMON_A, &key, "nonce-register-stale1").await;
        let old_timestamp = now_ms().saturating_sub(PUSH_TOKEN_TTL_MS + 1);
        set_token_updated_at(&state, TOKEN, old_timestamp);

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
        assert_eq!(stored_token_count(&state), 0);
        assert!(
            state
                .metrics_text()
                .contains("fieldwork_relay_push_token_unregistrations_total 1")
        );
    }

    #[tokio::test]
    async fn sqlite_prunes_push_tokens_after_ninety_days_without_use_on_restart() {
        let tmp = tempfile::tempdir().unwrap();
        let db_path = tmp.path().join("relay.db");
        let key = SigningKey::from_bytes(&[7; 32]);
        let state = RelayState::open_sqlite(&db_path).unwrap();
        register_daemon_key(&state, DAEMON_A, &key).await;
        register_token_for(&state, DAEMON_A, &key, "nonce-register-prune1").await;
        let old_timestamp = now_ms().saturating_sub(PUSH_TOKEN_TTL_MS + 1);
        set_stored_token_updated_at(&state, TOKEN, old_timestamp);
        drop(state);

        let restored = RelayState::open_sqlite(&db_path).unwrap();

        assert_eq!(restored.registered_token_count(), 0);
        assert_eq!(stored_token_count(&restored), 0);
    }

    #[tokio::test]
    async fn accepted_push_refreshes_push_token_last_used_timestamp() {
        let tmp = tempfile::tempdir().unwrap();
        let db_path = tmp.path().join("relay.db");
        let key = SigningKey::from_bytes(&[7; 32]);
        let state = RelayState::open_sqlite(&db_path).unwrap();
        register_daemon_key(&state, DAEMON_A, &key).await;
        register_token_for(&state, DAEMON_A, &key, "nonce-register-touch1").await;
        let old_timestamp = now_ms().saturating_sub(PUSH_TOKEN_TTL_MS - 1_000);
        set_stored_token_updated_at(&state, TOKEN, old_timestamp);
        drop(state);

        let restored = RelayState::open_sqlite(&db_path).unwrap();
        assert_eq!(restored.registered_token_count(), 1);
        assert_eq!(stored_token_updated_at(&restored, TOKEN), old_timestamp);

        let response = signed_post(
            &restored,
            &key,
            "/v1/push",
            push_body("nonce-push-touch001", now_ms()),
            "nonce-push-touch001",
        )
        .await;

        assert_eq!(response.status(), StatusCode::ACCEPTED);
        assert!(stored_token_updated_at(&restored, TOKEN) > old_timestamp);
    }

    #[tokio::test]
    async fn apns_bad_device_token_removes_token_binding_from_memory_and_sqlite() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
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
        let mut state = RelayState::open_sqlite(&db_path).unwrap();
        state.providers = PushProviders {
            apns: Some(
                apns::ApnsClient::new(apns::ApnsCredentials {
                    team_id: "TEAMID1234".to_string(),
                    key_id: "KEYID1234".to_string(),
                    topic: "app.fieldwork.ios".to_string(),
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
                .contains("fieldwork_relay_push_token_unregistrations_total 1")
        );

        drop(state);
        let restored = RelayState::open_sqlite(&db_path).unwrap();
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
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
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
                        topic: "app.fieldwork.ios".to_string(),
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
        let state = RelayState::open_sqlite(&db_path).unwrap();
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
        let response = app(state)
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
    const TICKET_BLOB: &str = "fw1abcdefghijklmnopqrstuvwxyz234567";

    fn publish_body(code: &str, expires_at_ms: u64, nonce: &str, ts_ms: u64) -> Vec<u8> {
        serde_json::to_vec(&PublishPairingCodeRequest {
            daemon_node_id: DAEMON_A.to_string(),
            code: code.to_string(),
            ticket_blob: TICKET_BLOB.to_string(),
            expires_at_ms,
            nonce: nonce.to_string(),
            ts_ms,
        })
        .unwrap()
    }

    async fn resolve(state: &RelayState, code: &str) -> axum::response::Response {
        app(state.clone())
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
        app(state.clone())
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

        let expires = now_ms() + 10 * 60 * 1000;
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
    async fn unsigned_publish_is_rejected() {
        let state = RelayState::default();
        let key = SigningKey::from_bytes(&[7; 32]);
        register_daemon_key(&state, DAEMON_A, &key).await;

        let body = publish_body(
            CODE,
            now_ms() + 10 * 60 * 1000,
            "nonce-pair-unsigned",
            now_ms(),
        );
        let response = app(state.clone())
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
        let body = publish_body(
            CODE,
            now_ms() + 10 * 60 * 1000,
            "nonce-pair-aged1",
            now_ms(),
        );
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
    async fn resolve_locks_out_code_after_repeated_wrong_guesses() {
        // Per-code lockout fires on a code that EXISTS but is repeatedly missed.
        // Resolution only misses a present code when the supplied code does not
        // match it, so seed a present entry and drive failures against its key
        // through register_failed_resolve (the same path the handler invokes on
        // a non-matching present code) to exercise the cap deterministically.
        let state = RelayState::default();
        {
            let mut inner = state.inner.lock().expect("relay state lock poisoned");
            inner.pairing_codes.insert(
                CODE.to_string(),
                PairingCodeEntry {
                    daemon_node_id: DAEMON_A.to_string(),
                    ticket_blob: TICKET_BLOB.to_string(),
                    expires_at_ms: now_ms() + 10 * 60 * 1000,
                    failed_resolves: 0,
                },
            );
        }

        for _ in 0..(RESOLVE_MAX_FAILURES_PER_CODE - 1) {
            register_failed_resolve(&state, CODE);
            assert!(
                state
                    .inner
                    .lock()
                    .expect("relay state lock poisoned")
                    .pairing_codes
                    .contains_key(CODE),
                "code should survive until the failure cap"
            );
        }
        // The final failure trips the lockout and deletes the code.
        register_failed_resolve(&state, CODE);
        assert!(
            !state
                .inner
                .lock()
                .expect("relay state lock poisoned")
                .pairing_codes
                .contains_key(CODE)
        );
        // A locked-out code resolves as a uniform miss thereafter.
        assert_eq!(resolve(&state, CODE).await.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn resolve_rate_limits_per_client_ip() {
        let state = RelayState::default();

        for index in 0..RESOLVE_ATTEMPTS_PER_MINUTE {
            let response = resolve_from_ip(&state, "ABCDE", "203.0.113.7").await;
            assert_eq!(
                response.status(),
                StatusCode::NOT_FOUND,
                "attempt {index} should miss, not throttle yet"
            );
        }
        // The next request from the same IP within the window is throttled.
        let response = resolve_from_ip(&state, "ABCDE", "203.0.113.7").await;
        assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);

        // A different client IP still gets a fresh budget.
        let response = resolve_from_ip(&state, "ABCDE", "203.0.113.8").await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
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
        let state = RelayState::open_sqlite(&db_path).unwrap();
        register_daemon_key(&state, DAEMON_A, &key).await;

        let body = publish_body(
            CODE,
            now_ms() + 10 * 60 * 1000,
            "nonce-pair-sqlite1",
            now_ms(),
        );
        let response =
            signed_post(&state, &key, "/v1/pair/publish", body, "nonce-pair-sqlite1").await;
        assert_eq!(response.status(), StatusCode::CREATED);
        drop(state);

        let restored = RelayState::open_sqlite(&db_path).unwrap();
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
            now_ms() + 10 * 60 * 1000,
            "nonce-pair-metric1",
            now_ms(),
        );
        let response =
            signed_post(&state, &key, "/v1/pair/publish", body, "nonce-pair-metric1").await;
        assert_eq!(response.status(), StatusCode::CREATED);
        assert_eq!(resolve(&state, CODE).await.status(), StatusCode::OK);

        let metrics = state.metrics_text();
        assert!(metrics.contains("fieldwork_relay_pairing_code_publishes_total 1"));
        assert!(metrics.contains("fieldwork_relay_pairing_code_resolves_total 1"));
        assert!(!metrics.contains(CODE));
        assert!(!metrics.contains(TICKET_BLOB));
    }

    async fn register_daemon_key(state: &RelayState, daemon: &str, key: &SigningKey) {
        let body = serde_json::to_vec(&RegisterDaemonRequest {
            daemon_node_id: daemon.to_string(),
            public_key: BASE64.encode(key.verifying_key().to_bytes()),
        })
        .unwrap();
        let response = app(state.clone())
            .oneshot(Request::post("/v1/pair").body(Body::from(body)).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::CREATED);
    }

    async fn register_token_for(state: &RelayState, daemon: &str, key: &SigningKey, nonce: &str) {
        let body = serde_json::to_vec(&RegisterTokenRequest {
            daemon_node_id: daemon.to_string(),
            platform: PushPlatform::Apns,
            push_token: TOKEN.to_string(),
            nonce: nonce.to_string(),
            ts_ms: now_ms(),
        })
        .unwrap();
        let response = signed_post(state, key, "/v1/push/register-token", body, nonce).await;
        assert_eq!(response.status(), StatusCode::CREATED);
    }

    fn push_body(nonce: &str, ts_ms: u64) -> Vec<u8> {
        serde_json::to_vec(&PushRequest {
            daemon_node_id: DAEMON_A.to_string(),
            recipient_token: TOKEN.to_string(),
            platform: PushPlatform::Apns,
            session_id_hash: HASH_A.to_string(),
            session_name_hash: HASH_B.to_string(),
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
        app(state.clone())
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

    fn set_token_updated_at(state: &RelayState, push_token: &str, updated_at_ms: u64) {
        set_stored_token_updated_at(state, push_token, updated_at_ms);
        state
            .inner
            .lock()
            .expect("relay state lock poisoned")
            .tokens
            .get_mut(push_token)
            .expect("registered token")
            .updated_at_ms = updated_at_ms;
    }

    fn set_stored_token_updated_at(state: &RelayState, push_token: &str, updated_at_ms: u64) {
        let store = state.store.as_ref().expect("sqlite store");
        let conn = store.conn.lock().expect("relay sqlite lock poisoned");
        conn.execute(
            "UPDATE push_tokens SET updated_at_ms = ?2 WHERE push_token = ?1",
            params![push_token, updated_at_ms as i64],
        )
        .unwrap();
    }

    fn stored_token_count(state: &RelayState) -> usize {
        let store = state.store.as_ref().expect("sqlite store");
        let conn = store.conn.lock().expect("relay sqlite lock poisoned");
        conn.query_row("SELECT COUNT(*) FROM push_tokens", [], |row| {
            row.get::<_, i64>(0)
        })
        .unwrap() as usize
    }

    fn stored_token_updated_at(state: &RelayState, push_token: &str) -> u64 {
        let store = state.store.as_ref().expect("sqlite store");
        let conn = store.conn.lock().expect("relay sqlite lock poisoned");
        conn.query_row(
            "SELECT updated_at_ms FROM push_tokens WHERE push_token = ?1",
            [push_token],
            |row| row.get::<_, i64>(0),
        )
        .unwrap()
        .try_into()
        .unwrap()
    }

    async fn response_text(response: Response) -> String {
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        String::from_utf8(bytes.to_vec()).unwrap()
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
