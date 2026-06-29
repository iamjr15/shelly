use crate::persistence::StoredDevice;
use anyhow::{Context, Result, anyhow, bail};
use backon::{BackoffBuilder, ExponentialBuilder};
use base64::{
    Engine as _,
    engine::general_purpose::{STANDARD as BASE64, STANDARD_NO_PAD},
};
use chacha20poly1305::aead::{OsRng, rand_core::RngCore};
use dashmap::DashMap;
use ed25519_dalek::{Signer, SigningKey};
use reqwest::StatusCode;
use serde::Serialize;
use sha2::{Digest, Sha256};
use shelly_protocol::{PushPlatform, SessionId, now_ms};
use std::{error::Error as StdError, fmt, future::Future, sync::Arc, time::Duration};
use tokio::sync::mpsc;
use tokio::time::{Instant, sleep, timeout_at};
use tracing::{debug, warn};

const SERVICE: &str = "app.shelly";
const RELAY_SIGNING_ACCOUNT: &str = "relay-signing-key-v1";
const RELAY_CONTROL_URL_ENV: &str = "SHELLY_RELAY_CONTROL_URL";
/// Optional base64 (no-pad) override for the relay signing key, mirroring
/// `SHELLY_IROH_SECRET_KEY_B64`. Lets hermetic e2e harnesses without OS
/// keychain access (CI, isolated temp HOME) exercise the relay publish path.
const RELAY_SIGNING_KEY_ENV: &str = "SHELLY_RELAY_SIGNING_KEY_B64";
const RELAY_REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const RELAY_RETRY_MIN_DELAY: Duration = Duration::from_secs(1);
const RELAY_RETRY_MAX_DELAY: Duration = Duration::from_secs(8);
const RELAY_RETRY_TOTAL_DELAY: Duration = Duration::from_secs(60);

#[derive(Clone)]
pub(crate) struct PushDispatcher {
    tx: Option<mpsc::UnboundedSender<PushCommand>>,
}

impl PushDispatcher {
    pub(crate) fn from_env(devices: Arc<DashMap<String, StoredDevice>>) -> Self {
        let Some(relay_url) = std::env::var(RELAY_CONTROL_URL_ENV)
            .ok()
            .filter(|value| !value.trim().is_empty())
        else {
            return Self { tx: None };
        };

        let signing_key = match load_or_create_signing_key() {
            Ok(key) => key,
            Err(error) => {
                warn!(%error, "push relay signing key unavailable; push dispatch disabled");
                return Self { tx: None };
            }
        };

        let client = match relay_http_client() {
            Ok(client) => client,
            Err(error) => {
                warn!(%error, "push relay HTTP client unavailable; push dispatch disabled");
                return Self { tx: None };
            }
        };

        let (tx, rx) = mpsc::unbounded_channel();
        let worker = PushWorker {
            client,
            relay_url: relay_url.trim_end_matches('/').to_string(),
            signing_key,
            daemon_node_id: None,
            daemon_registered: false,
            retry: RelayRetry::production(),
            devices,
            rx,
        };
        tokio::spawn(worker.run());
        Self { tx: Some(tx) }
    }

    pub(crate) fn is_enabled(&self) -> bool {
        self.tx.is_some()
    }

    pub(crate) fn set_daemon_node_id(&self, daemon_node_id: String) {
        self.send(PushCommand::SetDaemonNodeId(daemon_node_id));
    }

    pub(crate) fn register_token(&self, platform: PushPlatform, token: String) {
        self.send(PushCommand::RegisterToken { platform, token });
    }

    /// Best-effort publish of a pairing code and its opaque reachability blob to
    /// the relay rendezvous endpoint so the typed-code path can resolve it.
    ///
    /// No-op (with a debug log) when the relay control URL is unset; any relay
    /// failure is logged as a warning and dropped so the QR path keeps working.
    pub(crate) fn publish_pairing_code(
        &self,
        code: String,
        ticket_blob: String,
        expires_at_ms: u64,
    ) {
        if self.tx.is_none() {
            debug!("relay control URL unset; skipping pairing-code publish");
            return;
        }
        self.send(PushCommand::PublishPairingCode {
            code,
            ticket_blob,
            expires_at_ms,
        });
    }

    pub(crate) fn unregister_token(&self, token: String) {
        self.send(PushCommand::UnregisterToken { token });
    }

    pub(crate) fn awaiting_input(&self, session_id: SessionId, session_name: String) {
        self.send(PushCommand::AwaitingInput {
            session_id,
            session_name,
        });
    }

    pub(crate) fn session_crashed(&self, session_id: SessionId, session_name: String) {
        self.send(PushCommand::SessionCrashed {
            session_id,
            session_name,
        });
    }

    pub(crate) fn build_finished(&self, session_id: SessionId, session_name: String) {
        self.send(PushCommand::BuildFinished {
            session_id,
            session_name,
        });
    }

    fn send(&self, command: PushCommand) {
        if let Some(tx) = &self.tx
            && tx.send(command).is_err()
        {
            warn!("push dispatcher worker is not running");
        }
    }

    #[cfg(test)]
    pub(crate) fn disabled_for_tests() -> Self {
        Self { tx: None }
    }

    #[cfg(test)]
    pub(crate) fn from_test_sender(tx: mpsc::UnboundedSender<PushCommand>) -> Self {
        Self { tx: Some(tx) }
    }
}

pub(crate) enum PushCommand {
    SetDaemonNodeId(String),
    RegisterToken {
        platform: PushPlatform,
        token: String,
    },
    UnregisterToken {
        token: String,
    },
    PublishPairingCode {
        code: String,
        ticket_blob: String,
        expires_at_ms: u64,
    },
    AwaitingInput {
        session_id: SessionId,
        session_name: String,
    },
    SessionCrashed {
        session_id: SessionId,
        session_name: String,
    },
    BuildFinished {
        session_id: SessionId,
        session_name: String,
    },
}

struct PushWorker {
    client: reqwest::Client,
    relay_url: String,
    signing_key: SigningKey,
    daemon_node_id: Option<String>,
    daemon_registered: bool,
    retry: RelayRetry,
    devices: Arc<DashMap<String, StoredDevice>>,
    rx: mpsc::UnboundedReceiver<PushCommand>,
}

#[derive(Clone, Copy)]
struct RelayRetry {
    min_delay: Duration,
    max_delay: Duration,
    total_delay: Duration,
    jitter: bool,
}

impl RelayRetry {
    fn production() -> Self {
        Self {
            min_delay: RELAY_RETRY_MIN_DELAY,
            max_delay: RELAY_RETRY_MAX_DELAY,
            total_delay: RELAY_RETRY_TOTAL_DELAY,
            jitter: true,
        }
    }

    #[cfg(test)]
    fn for_tests() -> Self {
        Self {
            min_delay: Duration::from_millis(5),
            max_delay: Duration::from_millis(20),
            total_delay: Duration::from_millis(500),
            jitter: false,
        }
    }

    fn backoff(self) -> ExponentialBuilder {
        let builder = ExponentialBuilder::default()
            .with_min_delay(self.min_delay)
            .with_max_delay(self.max_delay)
            .without_max_times()
            .with_total_delay(Some(self.total_delay));
        if self.jitter {
            builder.with_jitter()
        } else {
            builder
        }
    }
}

impl PushWorker {
    async fn run(mut self) {
        while let Some(command) = self.rx.recv().await {
            let result = match command {
                PushCommand::SetDaemonNodeId(daemon_node_id) => {
                    self.daemon_node_id = Some(daemon_node_id);
                    self.daemon_registered = false;
                    self.ensure_daemon_registered().await.map(|_| ())
                }
                PushCommand::RegisterToken { platform, token } => {
                    self.register_token(platform, token).await
                }
                PushCommand::UnregisterToken { token } => self.unregister_token(token).await,
                PushCommand::PublishPairingCode {
                    code,
                    ticket_blob,
                    expires_at_ms,
                } => {
                    self.publish_pairing_code(code, ticket_blob, expires_at_ms)
                        .await
                }
                PushCommand::AwaitingInput {
                    session_id,
                    session_name,
                } => {
                    self.dispatch_session_event(
                        session_id,
                        &session_name,
                        RelayPushEventType::AwaitingInput,
                    )
                    .await
                }
                PushCommand::SessionCrashed {
                    session_id,
                    session_name,
                } => {
                    self.dispatch_session_event(
                        session_id,
                        &session_name,
                        RelayPushEventType::SessionCrashed,
                    )
                    .await
                }
                PushCommand::BuildFinished {
                    session_id,
                    session_name,
                } => {
                    self.dispatch_session_event(
                        session_id,
                        &session_name,
                        RelayPushEventType::BuildFinished,
                    )
                    .await
                }
            };
            if let Err(error) = result {
                warn!(%error, "push relay operation failed");
            }
        }
    }

    async fn ensure_daemon_registered(&mut self) -> Result<String> {
        let daemon_node_id = self
            .daemon_node_id
            .clone()
            .context("daemon iroh node id is not ready")?;
        if self.daemon_registered {
            return Ok(daemon_node_id);
        }

        let body = RegisterDaemonRequest {
            daemon_node_id: daemon_node_id.clone(),
            public_key: BASE64.encode(self.signing_key.verifying_key().to_bytes()),
        };
        self.post_json("/v1/pair", &body).await?;
        self.daemon_registered = true;
        debug!("registered daemon relay signing key");
        Ok(daemon_node_id)
    }

    async fn register_token(&mut self, platform: PushPlatform, token: String) -> Result<()> {
        let daemon_node_id = self.ensure_daemon_registered().await?;
        let worker = &*self;
        retry_relay_operation(self.retry, "register push token", || {
            let daemon_node_id = daemon_node_id.clone();
            let token = token.clone();
            async move {
                let nonce = nonce();
                let ts_ms = now_ms();
                let body = RegisterTokenRequest {
                    daemon_node_id,
                    platform: platform.into(),
                    push_token: token,
                    nonce: nonce.clone(),
                    ts_ms,
                };
                worker
                    .post_signed_json_once("/v1/push/register-token", &body, &nonce, ts_ms)
                    .await
            }
        })
        .await
    }

    async fn unregister_token(&mut self, token: String) -> Result<()> {
        let daemon_node_id = self.ensure_daemon_registered().await?;
        let worker = &*self;
        retry_relay_operation(self.retry, "unregister push token", || {
            let daemon_node_id = daemon_node_id.clone();
            let token = token.clone();
            async move {
                let nonce = nonce();
                let ts_ms = now_ms();
                let body = UnregisterTokenRequest {
                    daemon_node_id,
                    push_token: token,
                    nonce: nonce.clone(),
                    ts_ms,
                };
                worker
                    .post_signed_json_once("/v1/push/unregister-token", &body, &nonce, ts_ms)
                    .await
            }
        })
        .await
    }

    async fn publish_pairing_code(
        &mut self,
        code: String,
        ticket_blob: String,
        expires_at_ms: u64,
    ) -> Result<()> {
        let daemon_node_id = self.ensure_daemon_registered().await?;
        let worker = &*self;
        retry_relay_operation(self.retry, "publish pairing code", || {
            let daemon_node_id = daemon_node_id.clone();
            let code = code.clone();
            let ticket_blob = ticket_blob.clone();
            async move {
                let nonce = nonce();
                let ts_ms = now_ms();
                let body = PublishPairingCodeRequest {
                    daemon_node_id,
                    code,
                    ticket_blob,
                    expires_at_ms,
                    nonce: nonce.clone(),
                    ts_ms,
                };
                worker
                    .post_signed_json_once("/v1/pair/publish", &body, &nonce, ts_ms)
                    .await
            }
        })
        .await
    }

    async fn dispatch_session_event(
        &mut self,
        session_id: SessionId,
        session_name: &str,
        event_type: RelayPushEventType,
    ) -> Result<()> {
        let daemon_node_id = self.ensure_daemon_registered().await?;
        let tokens: Vec<_> = self
            .devices
            .iter()
            .filter_map(|device| {
                Some((
                    device.push_platform?,
                    device.push_token.as_ref()?.to_string(),
                ))
            })
            .collect();

        for (platform, recipient_token) in tokens {
            let session_id_hash = hash_for_push(&session_id.to_string());
            let session_name_hash = hash_for_push(session_name);
            let worker = &*self;
            retry_relay_operation(self.retry, event_type.dispatch_operation(), || {
                let daemon_node_id = daemon_node_id.clone();
                let recipient_token = recipient_token.clone();
                let session_id_hash = session_id_hash.clone();
                let session_name_hash = session_name_hash.clone();
                async move {
                    let nonce = nonce();
                    let ts_ms = now_ms();
                    let body = PushRequest {
                        daemon_node_id,
                        recipient_token,
                        platform: platform.into(),
                        session_id_hash,
                        session_name_hash,
                        event_type,
                        nonce: nonce.clone(),
                        ts_ms,
                    };
                    worker
                        .post_signed_json_once("/v1/push", &body, &nonce, ts_ms)
                        .await
                }
            })
            .await?;
        }
        Ok(())
    }

    async fn post_json<T: Serialize>(&self, path: &str, body: &T) -> Result<()> {
        let body = serde_json::to_vec(body).context("encode push relay request")?;
        retry_relay_operation(self.retry, "post relay JSON", || {
            let body = body.clone();
            async move { self.post_json_once(path, body).await }
        })
        .await
    }

    async fn post_json_once(&self, path: &str, body: Vec<u8>) -> Result<()> {
        let response = self
            .client
            .post(self.url(path))
            .header("content-type", "application/json")
            .body(body)
            .send()
            .await?;
        ensure_success(response, path).await
    }

    async fn post_signed_json_once<T: Serialize>(
        &self,
        path: &str,
        body: &T,
        nonce: &str,
        ts_ms: u64,
    ) -> Result<()> {
        let body = serde_json::to_vec(body).context("encode push relay request")?;
        let signature = sign(&self.signing_key, path, &body, nonce, ts_ms);
        let response = self
            .client
            .post(self.url(path))
            .header("content-type", "application/json")
            .header("x-shelly-signature", signature)
            .body(body)
            .send()
            .await?;
        ensure_success(response, path).await
    }

    fn url(&self, path: &str) -> String {
        format!("{}{}", self.relay_url, path)
    }
}

async fn retry_relay_operation<F, Fut>(
    retry: RelayRetry,
    operation: &'static str,
    mut op: F,
) -> Result<()>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<()>>,
{
    let deadline = Instant::now() + retry.total_delay;
    let mut delays = retry.backoff().build();
    loop {
        let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
            bail!("push relay {operation} exceeded retry budget");
        };
        let result = timeout_at(deadline, op())
            .await
            .unwrap_or_else(|_| Err(anyhow!("push relay {operation} exceeded retry budget")));
        match result {
            Ok(()) => return Ok(()),
            Err(error) if !is_retryable_relay_error(&error) => return Err(error),
            Err(error) => {
                let Some(delay) = delays.next() else {
                    return Err(error)
                        .with_context(|| format!("push relay {operation} retry budget spent"));
                };
                if delay >= remaining {
                    return Err(error)
                        .with_context(|| format!("push relay {operation} retry budget spent"));
                }
                warn!(
                    operation,
                    retry_in_ms = delay.as_millis(),
                    "temporary push relay operation failure; retrying"
                );
                sleep(delay).await;
            }
        }
    }
}

async fn ensure_success(response: reqwest::Response, path: &str) -> Result<()> {
    if response.status().is_success() {
        return Ok(());
    }

    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    Err(RelayHttpError {
        path: path.to_string(),
        status,
        body,
    }
    .into())
}

#[derive(Debug)]
struct RelayHttpError {
    path: String,
    status: StatusCode,
    body: String,
}

impl RelayHttpError {
    fn is_retryable(&self) -> bool {
        self.status.is_server_error()
            || self.status == StatusCode::REQUEST_TIMEOUT
            || self.status == StatusCode::TOO_MANY_REQUESTS
    }
}

impl fmt::Display for RelayHttpError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "relay {} rejected request with {}: {}",
            self.path, self.status, self.body
        )
    }
}

impl StdError for RelayHttpError {}

fn is_retryable_relay_error(error: &anyhow::Error) -> bool {
    if let Some(http) = error.downcast_ref::<RelayHttpError>() {
        return http.is_retryable();
    }
    if let Some(reqwest) = error.downcast_ref::<reqwest::Error>() {
        return reqwest.is_connect() || reqwest.is_timeout();
    }
    false
}

fn relay_http_client() -> Result<reqwest::Client> {
    // reqwest is built with `rustls-no-provider`; ensure a default crypto provider
    // is installed before constructing the client. The daemon binary installs this
    // in `main`, but unit tests build clients without running `main`. Idempotent.
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
    reqwest::Client::builder()
        .timeout(RELAY_REQUEST_TIMEOUT)
        .build()
        .context("build push relay HTTP client")
}

#[derive(Serialize)]
struct RegisterDaemonRequest {
    daemon_node_id: String,
    public_key: String,
}

#[derive(Serialize)]
struct RegisterTokenRequest {
    daemon_node_id: String,
    platform: RelayPushPlatform,
    push_token: String,
    nonce: String,
    ts_ms: u64,
}

#[derive(Serialize)]
struct UnregisterTokenRequest {
    daemon_node_id: String,
    push_token: String,
    nonce: String,
    ts_ms: u64,
}

#[derive(Serialize)]
struct PublishPairingCodeRequest {
    daemon_node_id: String,
    code: String,
    ticket_blob: String,
    expires_at_ms: u64,
    nonce: String,
    ts_ms: u64,
}

#[derive(Serialize)]
struct PushRequest {
    daemon_node_id: String,
    recipient_token: String,
    platform: RelayPushPlatform,
    session_id_hash: String,
    session_name_hash: String,
    event_type: RelayPushEventType,
    nonce: String,
    ts_ms: u64,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum RelayPushPlatform {
    Apns,
    Fcm,
}

impl From<PushPlatform> for RelayPushPlatform {
    fn from(platform: PushPlatform) -> Self {
        match platform {
            PushPlatform::Apns => Self::Apns,
            PushPlatform::Fcm => Self::Fcm,
        }
    }
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum RelayPushEventType {
    AwaitingInput,
    SessionCrashed,
    BuildFinished,
}

impl RelayPushEventType {
    /// Operation label used for retry/diagnostic logging on the dispatch path.
    fn dispatch_operation(self) -> &'static str {
        match self {
            Self::AwaitingInput => "dispatch awaiting-input push",
            Self::SessionCrashed => "dispatch session-crashed push",
            Self::BuildFinished => "dispatch build-finished push",
        }
    }
}

fn sign(key: &SigningKey, path: &str, body: &[u8], nonce: &str, ts_ms: u64) -> String {
    let canonical = canonical_request("POST", path, body, nonce, ts_ms);
    BASE64.encode(key.sign(canonical.as_bytes()).to_bytes())
}

fn canonical_request(method: &str, path: &str, body: &[u8], nonce: &str, ts_ms: u64) -> String {
    format!(
        "{method}\n{path}\n{}\n{nonce}\n{ts_ms}",
        String::from_utf8_lossy(body)
    )
}

fn hash_for_push(value: &str) -> String {
    let hash = Sha256::digest(value.as_bytes());
    let mut out = String::with_capacity(64);
    for byte in hash {
        use std::fmt::Write as _;
        let _ = write!(&mut out, "{byte:02x}");
    }
    out
}

fn nonce() -> String {
    let mut bytes = [0_u8; 16];
    OsRng.fill_bytes(&mut bytes);
    BASE64.encode(bytes)
}

fn load_or_create_signing_key() -> Result<SigningKey> {
    if let Some(key) = signing_key_from_env()? {
        return Ok(key);
    }
    let entry =
        keyring::Entry::new(SERVICE, RELAY_SIGNING_ACCOUNT).context("open OS keychain entry")?;
    match entry.get_password() {
        Ok(encoded) => decode_signing_key(&encoded),
        Err(keyring::Error::NoEntry) => {
            let mut key = [0_u8; 32];
            OsRng.fill_bytes(&mut key);
            entry
                .set_password(&STANDARD_NO_PAD.encode(key))
                .context("store relay signing key in OS keychain")?;
            Ok(SigningKey::from_bytes(&key))
        }
        Err(error) => Err(error).context("read relay signing key from OS keychain"),
    }
}

fn decode_signing_key(encoded: &str) -> Result<SigningKey> {
    let bytes = STANDARD_NO_PAD
        .decode(encoded)
        .context("decode relay signing key")?;
    let key: [u8; 32] = bytes
        .try_into()
        .map_err(|_| anyhow::anyhow!("relay signing key must be 32 bytes"))?;
    Ok(SigningKey::from_bytes(&key))
}

/// Reads the relay signing key from [`RELAY_SIGNING_KEY_ENV`] when set, so test
/// harnesses without OS keychain access can sign relay requests. Mirrors the
/// iroh secret-key env override; empty/unset falls back to the keychain.
fn signing_key_from_env() -> Result<Option<SigningKey>> {
    let Some(value) = std::env::var_os(RELAY_SIGNING_KEY_ENV) else {
        return Ok(None);
    };
    let value = value.to_string_lossy();
    if value.trim().is_empty() {
        return Ok(None);
    }
    decode_signing_key(value.trim())
        .with_context(|| format!("decode {RELAY_SIGNING_KEY_ENV}"))
        .map(Some)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        Router,
        body::Bytes,
        extract::State,
        http::{HeaderMap, StatusCode, Uri},
        response::IntoResponse,
        routing::post,
    };
    use ed25519_dalek::{Signature, Verifier};
    use std::sync::Mutex;
    use tokio::time::{Duration, sleep, timeout};

    #[test]
    fn push_hash_is_lowercase_sha256_hex_and_not_plaintext() {
        let hash = hash_for_push("secret session name");

        assert_lowercase_hex_hash(&hash);
        assert!(!hash.contains("secret"));
    }

    #[test]
    fn signed_request_matches_relay_canonical_form() {
        let key = SigningKey::from_bytes(&[9; 32]);
        let body = br#"{"nonce":"nonce-for-signature","ts_ms":42}"#;
        let signature = sign(&key, "/v1/push", body, "nonce-for-signature", 42);
        let signature = Signature::from_slice(&BASE64.decode(signature).unwrap()).unwrap();
        let canonical = canonical_request("POST", "/v1/push", body, "nonce-for-signature", 42);

        key.verifying_key()
            .verify(canonical.as_bytes(), &signature)
            .unwrap();
    }

    #[test]
    fn relay_platform_serializes_as_snake_case() {
        assert_eq!(
            serde_json::to_string(&RelayPushPlatform::Apns).unwrap(),
            r#""apns""#
        );
        assert_eq!(
            serde_json::to_string(&RelayPushPlatform::Fcm).unwrap(),
            r#""fcm""#
        );
    }

    #[test]
    fn relay_event_type_serializes_as_snake_case() {
        assert_eq!(
            serde_json::to_string(&RelayPushEventType::AwaitingInput).unwrap(),
            r#""awaiting_input""#
        );
        assert_eq!(
            serde_json::to_string(&RelayPushEventType::SessionCrashed).unwrap(),
            r#""session_crashed""#
        );
        assert_eq!(
            serde_json::to_string(&RelayPushEventType::BuildFinished).unwrap(),
            r#""build_finished""#
        );
    }

    static SIGNING_ENV_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn signing_key_env_override_loads_without_keychain() {
        let _guard = SIGNING_ENV_LOCK.lock().unwrap();
        let previous = std::env::var_os(RELAY_SIGNING_KEY_ENV);
        // Same fixed test key the local handoff smoke uses (32 bytes of 0x07).
        let encoded = STANDARD_NO_PAD.encode([7_u8; 32]);
        unsafe {
            std::env::set_var(RELAY_SIGNING_KEY_ENV, &encoded);
        }

        let key = signing_key_from_env()
            .expect("env signing key decodes")
            .expect("env signing key present");
        assert_eq!(key.to_bytes(), [7_u8; 32]);

        unsafe {
            match previous {
                Some(value) => std::env::set_var(RELAY_SIGNING_KEY_ENV, value),
                None => std::env::remove_var(RELAY_SIGNING_KEY_ENV),
            }
        }
    }

    #[test]
    fn signing_key_env_is_ignored_when_unset_or_blank() {
        let _guard = SIGNING_ENV_LOCK.lock().unwrap();
        let previous = std::env::var_os(RELAY_SIGNING_KEY_ENV);
        unsafe {
            std::env::set_var(RELAY_SIGNING_KEY_ENV, "   ");
        }

        assert!(
            signing_key_from_env()
                .expect("blank env is not an error")
                .is_none()
        );

        unsafe {
            match previous {
                Some(value) => std::env::set_var(RELAY_SIGNING_KEY_ENV, value),
                None => std::env::remove_var(RELAY_SIGNING_KEY_ENV),
            }
        }
    }

    #[tokio::test]
    async fn worker_registers_token_and_pushes_awaiting_input_to_relay() {
        let captured = Arc::new(Mutex::new(Vec::new()));
        let app = Router::new()
            .route("/v1/pair", post(capture_request))
            .route("/v1/push/register-token", post(capture_request))
            .route("/v1/push", post(capture_request))
            .with_state(Arc::clone(&captured));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        let devices = Arc::new(DashMap::new());
        let mut device = StoredDevice::new("phone".to_string(), "device-node-a".to_string());
        device.set_push_token(PushPlatform::Apns, "apns-token-for-device-a".to_string());
        devices.insert(device.device_node_id.clone(), device);

        let (tx, rx) = mpsc::unbounded_channel();
        let worker = PushWorker {
            client: relay_http_client().unwrap(),
            relay_url: format!("http://{addr}"),
            signing_key: SigningKey::from_bytes(&[9; 32]),
            daemon_node_id: None,
            daemon_registered: false,
            retry: RelayRetry::for_tests(),
            devices,
            rx,
        };
        tokio::spawn(worker.run());

        tx.send(PushCommand::SetDaemonNodeId(
            "daemon-node-a-1234567890".to_string(),
        ))
        .unwrap();
        tx.send(PushCommand::RegisterToken {
            platform: PushPlatform::Apns,
            token: "apns-token-for-device-a".to_string(),
        })
        .unwrap();
        tx.send(PushCommand::AwaitingInput {
            session_id: SessionId::new(),
            session_name: "secret project shell".to_string(),
        })
        .unwrap();

        let requests = timeout(Duration::from_secs(2), async {
            loop {
                let snapshot = captured.lock().expect("capture lock poisoned").clone();
                if snapshot.len() >= 3 {
                    return snapshot;
                }
                sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("push worker should POST relay requests");

        assert!(requests.iter().any(|request| request.path == "/v1/pair"));
        let token_registration = requests
            .iter()
            .find(|request| request.path == "/v1/push/register-token")
            .expect("token registration request");
        assert!(token_registration.signature.is_some());
        assert_eq!(token_registration.body["platform"], "apns");
        assert_eq!(
            token_registration.body["push_token"],
            "apns-token-for-device-a"
        );

        let push = requests
            .iter()
            .find(|request| request.path == "/v1/push")
            .expect("push request");
        assert!(push.signature.is_some());
        assert_eq!(push.body["event_type"], "awaiting_input");
        assert_eq!(push.body["recipient_token"], "apns-token-for-device-a");
        assert_lowercase_hex_hash(push.body["session_id_hash"].as_str().unwrap());
        assert_lowercase_hex_hash(push.body["session_name_hash"].as_str().unwrap());
        assert!(!push.body.to_string().contains("secret project shell"));
    }

    #[tokio::test]
    async fn worker_unregisters_token_from_relay() {
        let captured = Arc::new(Mutex::new(Vec::new()));
        let app = Router::new()
            .route("/v1/pair", post(capture_request))
            .route("/v1/push/unregister-token", post(capture_request))
            .with_state(Arc::clone(&captured));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        let (tx, rx) = mpsc::unbounded_channel();
        let worker = PushWorker {
            client: relay_http_client().unwrap(),
            relay_url: format!("http://{addr}"),
            signing_key: SigningKey::from_bytes(&[9; 32]),
            daemon_node_id: None,
            daemon_registered: false,
            retry: RelayRetry::for_tests(),
            devices: Arc::new(DashMap::new()),
            rx,
        };
        tokio::spawn(worker.run());

        tx.send(PushCommand::SetDaemonNodeId(
            "daemon-node-a-1234567890".to_string(),
        ))
        .unwrap();
        tx.send(PushCommand::UnregisterToken {
            token: "apns-token-for-removed-device".to_string(),
        })
        .unwrap();

        let requests = timeout(Duration::from_secs(2), async {
            loop {
                let snapshot = captured.lock().expect("capture lock poisoned").clone();
                if snapshot
                    .iter()
                    .any(|request| request.path == "/v1/push/unregister-token")
                {
                    return snapshot;
                }
                sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("push worker should POST token unregistration");

        let unregister = requests
            .iter()
            .find(|request| request.path == "/v1/push/unregister-token")
            .expect("token unregistration request");
        assert!(unregister.signature.is_some());
        assert_eq!(
            unregister.body["push_token"],
            "apns-token-for-removed-device"
        );
        assert_eq!(
            unregister.body["daemon_node_id"],
            "daemon-node-a-1234567890"
        );
        assert!(unregister.body["nonce"].as_str().unwrap().len() >= 16);
        assert!(!unregister.body.to_string().contains("secret project shell"));
    }

    #[tokio::test]
    async fn worker_retries_transient_push_failures_with_fresh_nonces() {
        let captured = Arc::new(FailingCapture {
            push_failures: std::sync::atomic::AtomicUsize::new(1),
            requests: Mutex::new(Vec::new()),
        });
        let app = Router::new()
            .route("/v1/pair", post(capture_request_with_push_failure))
            .route("/v1/push", post(capture_request_with_push_failure))
            .with_state(Arc::clone(&captured));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        let devices = Arc::new(DashMap::new());
        let mut device = StoredDevice::new("phone".to_string(), "device-node-a".to_string());
        device.set_push_token(PushPlatform::Fcm, "fcm-token-for-device-a".to_string());
        devices.insert(device.device_node_id.clone(), device);

        let (tx, rx) = mpsc::unbounded_channel();
        let worker = PushWorker {
            client: relay_http_client().unwrap(),
            relay_url: format!("http://{addr}"),
            signing_key: SigningKey::from_bytes(&[7; 32]),
            daemon_node_id: None,
            daemon_registered: false,
            retry: RelayRetry::for_tests(),
            devices,
            rx,
        };
        tokio::spawn(worker.run());

        tx.send(PushCommand::SetDaemonNodeId(
            "daemon-node-a-1234567890".to_string(),
        ))
        .unwrap();
        tx.send(PushCommand::AwaitingInput {
            session_id: SessionId::new(),
            session_name: "secret retry shell".to_string(),
        })
        .unwrap();

        let requests = timeout(Duration::from_secs(2), async {
            loop {
                let snapshot = captured
                    .requests
                    .lock()
                    .expect("capture lock poisoned")
                    .clone();
                if snapshot
                    .iter()
                    .filter(|request| request.path == "/v1/push")
                    .count()
                    >= 2
                {
                    return snapshot;
                }
                sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("push worker should retry transient relay push failure");

        let pushes: Vec<_> = requests
            .iter()
            .filter(|request| request.path == "/v1/push")
            .collect();
        assert_eq!(pushes.len(), 2);
        assert_ne!(pushes[0].body["nonce"], pushes[1].body["nonce"]);
        assert_eq!(pushes[1].body["event_type"], "awaiting_input");
        assert!(!pushes[1].body.to_string().contains("secret retry shell"));
    }

    #[test]
    fn retry_classification_skips_permanent_client_errors() {
        let forbidden = anyhow::Error::new(RelayHttpError {
            path: "/v1/push".to_string(),
            status: StatusCode::FORBIDDEN,
            body: "push token is not owned by the signing daemon".to_string(),
        });
        let unavailable = anyhow::Error::new(RelayHttpError {
            path: "/v1/push".to_string(),
            status: StatusCode::SERVICE_UNAVAILABLE,
            body: "provider unavailable".to_string(),
        });

        assert!(!is_retryable_relay_error(&forbidden));
        assert!(is_retryable_relay_error(&unavailable));
    }

    #[derive(Clone, Debug)]
    struct CapturedRequest {
        path: String,
        signature: Option<String>,
        body: serde_json::Value,
    }

    struct FailingCapture {
        push_failures: std::sync::atomic::AtomicUsize,
        requests: Mutex<Vec<CapturedRequest>>,
    }

    async fn capture_request(
        State(captured): State<Arc<Mutex<Vec<CapturedRequest>>>>,
        uri: Uri,
        headers: HeaderMap,
        body: Bytes,
    ) -> impl IntoResponse {
        let path = uri.path().to_string();
        let body = serde_json::from_slice(&body).unwrap();
        captured
            .lock()
            .expect("capture lock poisoned")
            .push(CapturedRequest {
                path: path.clone(),
                signature: headers
                    .get("x-shelly-signature")
                    .and_then(|value| value.to_str().ok())
                    .map(str::to_string),
                body,
            });

        let status = match path.as_str() {
            "/v1/pair" | "/v1/push/register-token" => StatusCode::CREATED,
            "/v1/push/unregister-token" => StatusCode::OK,
            "/v1/push" => StatusCode::ACCEPTED,
            _ => StatusCode::NOT_FOUND,
        };
        (status, axum::Json(serde_json::json!({ "ok": true })))
    }

    async fn capture_request_with_push_failure(
        State(captured): State<Arc<FailingCapture>>,
        uri: Uri,
        headers: HeaderMap,
        body: Bytes,
    ) -> impl IntoResponse {
        let path = uri.path().to_string();
        let body = serde_json::from_slice(&body).unwrap();
        captured
            .requests
            .lock()
            .expect("capture lock poisoned")
            .push(CapturedRequest {
                path: path.clone(),
                signature: headers
                    .get("x-shelly-signature")
                    .and_then(|value| value.to_str().ok())
                    .map(str::to_string),
                body,
            });

        if path == "/v1/push"
            && captured
                .push_failures
                .fetch_update(
                    std::sync::atomic::Ordering::SeqCst,
                    std::sync::atomic::Ordering::SeqCst,
                    |remaining| remaining.checked_sub(1),
                )
                .is_ok()
        {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                axum::Json(serde_json::json!({ "error": "transient" })),
            )
                .into_response();
        }

        let status = match path.as_str() {
            "/v1/pair" => StatusCode::CREATED,
            "/v1/push" => StatusCode::ACCEPTED,
            _ => StatusCode::NOT_FOUND,
        };
        (status, axum::Json(serde_json::json!({ "ok": true }))).into_response()
    }

    fn assert_lowercase_hex_hash(value: &str) {
        assert_eq!(value.len(), 64);
        assert!(
            value
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        );
    }
}
