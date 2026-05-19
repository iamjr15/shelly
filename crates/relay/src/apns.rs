use anyhow::{Context, Result};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use p256::ecdsa::{Signature, SigningKey, signature::Signer};
use p256::pkcs8::DecodePrivateKey;
use reqwest::StatusCode;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

const APNS_JWT_TTL_SECONDS: u64 = 50 * 60;
const DEFAULT_APNS_ENDPOINT: &str = "https://api.push.apple.com";

#[derive(Clone)]
pub(crate) struct ApnsClient {
    endpoint: String,
    topic: String,
    jwt_cache: Arc<Mutex<ApnsJwtCache>>,
    http: reqwest::Client,
}

pub(crate) struct ApnsCredentials {
    pub(crate) team_id: String,
    pub(crate) key_id: String,
    pub(crate) topic: String,
    pub(crate) private_key_pem: Vec<u8>,
    pub(crate) endpoint: String,
}

struct ApnsJwtCache {
    team_id: String,
    key_id: String,
    signing_key: SigningKey,
    cached: Option<CachedJwt>,
}

#[derive(Serialize)]
struct ApnsJwtHeader {
    alg: &'static str,
    kid: String,
    typ: &'static str,
}

struct CachedJwt {
    token: String,
    generated_at_secs: u64,
}

#[derive(Serialize, Deserialize)]
struct ApnsClaims {
    iss: String,
    iat: u64,
}

#[derive(Deserialize)]
struct ApnsErrorResponse {
    reason: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct ApnsPushPayload<'a> {
    aps: Aps<'a>,
    session_id_hash: &'a str,
    session_name_hash: &'a str,
    event_type: &'a str,
}

#[derive(Serialize, Deserialize)]
struct Aps<'a> {
    alert: Alert<'a>,
    #[serde(rename = "thread-id")]
    thread_id: &'a str,
}

#[derive(Serialize, Deserialize)]
struct Alert<'a> {
    title: &'a str,
    body: &'a str,
}

impl ApnsCredentials {
    pub(crate) fn from_env() -> Result<Option<Self>> {
        let Some(key_path) = apns_key_path() else {
            return Ok(None);
        };
        if !key_path.exists() {
            return Ok(None);
        }

        let team_id = required_env("FIELDWORK_APNS_TEAM_ID")?;
        let key_id = required_env("FIELDWORK_APNS_KEY_ID")?;
        let topic = required_env("FIELDWORK_APNS_TOPIC")?;
        let endpoint = std::env::var("FIELDWORK_APNS_ENDPOINT")
            .unwrap_or_else(|_| DEFAULT_APNS_ENDPOINT.to_string());
        let private_key_pem = std::fs::read(&key_path)
            .with_context(|| format!("read APNs .p8 key from {}", key_path.display()))?;

        Ok(Some(Self {
            team_id,
            key_id,
            topic,
            private_key_pem,
            endpoint,
        }))
    }
}

impl ApnsClient {
    pub(crate) fn new(credentials: ApnsCredentials) -> Result<Self> {
        let jwt_cache = ApnsJwtCache::new(
            credentials.team_id,
            credentials.key_id,
            credentials.private_key_pem,
        )?;
        Ok(Self {
            endpoint: credentials.endpoint.trim_end_matches('/').to_string(),
            topic: credentials.topic,
            jwt_cache: Arc::new(Mutex::new(jwt_cache)),
            http: reqwest::Client::builder()
                .http2_keep_alive_interval(Some(Duration::from_secs(60)))
                .http2_keep_alive_timeout(Duration::from_secs(10))
                .http2_keep_alive_while_idle(true)
                .build()
                .context("build APNs HTTP/2 client")?,
        })
    }

    pub(crate) fn from_env() -> Result<Option<Self>> {
        ApnsCredentials::from_env()?.map(Self::new).transpose()
    }

    pub(crate) async fn send(
        &self,
        delivery: &crate::DeliveredPush,
    ) -> std::result::Result<(), crate::ProviderDeliveryError> {
        let jwt = self.jwt(now_secs()).map_err(provider_error)?;
        let body = self.payload_json(delivery).map_err(provider_error)?;
        let response = self
            .http
            .post(format!(
                "{}/3/device/{}",
                self.endpoint, delivery.recipient_token
            ))
            .header("authorization", format!("bearer {jwt}"))
            .header("apns-topic", &self.topic)
            .header("apns-push-type", "alert")
            .header("apns-priority", "10")
            .body(body)
            .send()
            .await
            .context("send APNs request")
            .map_err(provider_error)?;

        if response.status() != StatusCode::OK {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            if status == StatusCode::BAD_REQUEST
                && apns_error_reason(&body).as_deref() == Some("BadDeviceToken")
            {
                return Err(crate::ProviderDeliveryError::invalid_token(
                    "APNs",
                    "BadDeviceToken",
                ));
            }
            return Err(provider_error(anyhow::anyhow!(
                "APNs rejected notification with {status}: {body}"
            )));
        }
        Ok(())
    }

    fn jwt(&self, now_secs: u64) -> Result<String> {
        self.jwt_cache
            .lock()
            .expect("APNs JWT cache lock poisoned")
            .token(now_secs)
    }

    fn payload_json(&self, delivery: &crate::DeliveredPush) -> Result<String> {
        let payload = ApnsPushPayload {
            aps: Aps {
                alert: Alert {
                    title: &delivery.title,
                    body: &delivery.body,
                },
                thread_id: &delivery.thread_id,
            },
            session_id_hash: &delivery.session_id_hash,
            session_name_hash: &delivery.session_name_hash,
            event_type: delivery.event_type.as_str(),
        };
        serde_json::to_string(&payload).context("encode APNs payload")
    }
}

impl ApnsJwtCache {
    fn new(team_id: String, key_id: String, private_key_pem: Vec<u8>) -> Result<Self> {
        let private_key_pem =
            std::str::from_utf8(&private_key_pem).context("APNs .p8 key is not valid UTF-8 PEM")?;
        let signing_key =
            SigningKey::from_pkcs8_pem(private_key_pem).context("parse APNs ES256 .p8 key")?;
        Ok(Self {
            team_id,
            key_id,
            signing_key,
            cached: None,
        })
    }

    fn token(&mut self, now_secs: u64) -> Result<String> {
        if let Some(cached) = &self.cached
            && now_secs.saturating_sub(cached.generated_at_secs) < APNS_JWT_TTL_SECONDS
        {
            return Ok(cached.token.clone());
        }

        let header = ApnsJwtHeader {
            alg: "ES256",
            kid: self.key_id.clone(),
            typ: "JWT",
        };
        let claims = ApnsClaims {
            iss: self.team_id.clone(),
            iat: now_secs,
        };
        let signing_input = format!("{}.{}", b64_json(&header)?, b64_json(&claims)?);
        let signature: Signature = self.signing_key.sign(signing_input.as_bytes());
        let token = format!(
            "{signing_input}.{}",
            URL_SAFE_NO_PAD.encode(signature.to_bytes())
        );
        self.cached = Some(CachedJwt {
            token: token.clone(),
            generated_at_secs: now_secs,
        });
        Ok(token)
    }
}

fn b64_json<T: Serialize>(value: &T) -> Result<String> {
    let bytes = serde_json::to_vec(value).context("encode APNs JWT JSON segment")?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

fn apns_key_path() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("FIELDWORK_APNS_P8_PATH") {
        return Some(path.into());
    }
    let credentials_dir = std::env::var_os("CREDENTIALS_DIRECTORY")?;
    Some(PathBuf::from(credentials_dir).join("apns.p8"))
}

fn required_env(name: &str) -> Result<String> {
    let value = std::env::var(name).with_context(|| format!("{name} is required"))?;
    let value = value.trim();
    if value.is_empty() {
        anyhow::bail!("{name} is required");
    }
    Ok(value.to_string())
}

fn apns_error_reason(body: &str) -> Option<String> {
    serde_json::from_str::<ApnsErrorResponse>(body).ok()?.reason
}

fn provider_error(error: anyhow::Error) -> crate::ProviderDeliveryError {
    crate::ProviderDeliveryError::other("APNs", error)
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("system time is before unix epoch")
        .as_secs()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        Router,
        body::Bytes,
        extract::{ConnectInfo, State},
        http::{HeaderMap, StatusCode},
        response::IntoResponse,
        routing::post,
    };
    use base64::Engine;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use std::net::SocketAddr;
    use std::sync::atomic::{AtomicUsize, Ordering};

    const TEST_P8: &str = r#"-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgYvZMv7/BK9KKJoOw
rcuFYPPvxJYM9Jk51DF+fa+pCUmhRANCAASR6ia5ROe+c+mX/PFvnKubuo/sPS9h
Qs2AKHh1jTVeSS4oFAe+TdkeM/D3FuooTy4WMMf6s8BjtKjlBVHwauFo
-----END PRIVATE KEY-----"#;

    #[derive(Clone, Default)]
    struct MockState {
        requests: Arc<Mutex<Vec<ObservedApnsRequest>>>,
        peer_addrs: Arc<Mutex<Vec<SocketAddr>>>,
        request_count: Arc<AtomicUsize>,
    }

    #[derive(Clone)]
    struct ObservedApnsRequest {
        authorization: Option<String>,
        topic: Option<String>,
        push_type: Option<String>,
        priority: Option<String>,
        body: String,
    }

    fn delivery() -> crate::DeliveredPush {
        crate::DeliveredPush {
            platform: crate::PushPlatform::Apns,
            recipient_token: "device-token".to_string(),
            title: "Fieldwork".to_string(),
            body: "A session is waiting for you.".to_string(),
            thread_id: "session.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
                .to_string(),
            session_id_hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
                .to_string(),
            session_name_hash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
                .to_string(),
            event_type: crate::PushEventType::AwaitingInput,
        }
    }

    #[test]
    fn apns_jwt_is_cached_for_fifty_minutes() {
        let mut cache = ApnsJwtCache::new(
            "TEAMID1234".to_string(),
            "KEYID1234".to_string(),
            TEST_P8.as_bytes().to_vec(),
        )
        .unwrap();

        let first = cache.token(1_700_000_000).unwrap();
        let second = cache
            .token(1_700_000_000 + APNS_JWT_TTL_SECONDS - 1)
            .unwrap();
        let third = cache
            .token(1_700_000_000 + APNS_JWT_TTL_SECONDS + 1)
            .unwrap();

        assert_eq!(first, second);
        assert_ne!(first, third);

        let header = decode_segment::<serde_json::Value>(&first, 0);
        assert_eq!(header["alg"], "ES256");
        assert_eq!(header["kid"], "KEYID1234");
        let claims = decode_segment::<serde_json::Value>(&first, 1);
        assert_eq!(claims["iss"], "TEAMID1234");
        assert_eq!(claims["iat"], 1_700_000_000);
    }

    #[test]
    fn apns_payload_contains_only_generic_text_and_hashes() {
        let client = ApnsClient::new(ApnsCredentials {
            team_id: "TEAMID1234".to_string(),
            key_id: "KEYID1234".to_string(),
            topic: "app.fieldwork.ios".to_string(),
            private_key_pem: TEST_P8.as_bytes().to_vec(),
            endpoint: DEFAULT_APNS_ENDPOINT.to_string(),
        })
        .unwrap();

        let payload: serde_json::Value =
            serde_json::from_str(&client.payload_json(&delivery()).unwrap()).unwrap();
        assert_apns_payload_shape(&payload);
    }

    fn assert_apns_payload_shape(payload: &serde_json::Value) {
        assert_eq!(
            object_keys(payload),
            vec!["aps", "event_type", "session_id_hash", "session_name_hash"]
        );
        assert_eq!(object_keys(&payload["aps"]), vec!["alert", "thread-id"]);
        assert_eq!(object_keys(&payload["aps"]["alert"]), vec!["body", "title"]);
        assert_eq!(payload["aps"]["alert"]["title"], "Fieldwork");
        assert_eq!(
            payload["aps"]["alert"]["body"],
            "A session is waiting for you."
        );
        assert_eq!(
            payload["aps"]["thread-id"],
            "session.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        );
        assert_eq!(
            payload["session_id_hash"],
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        );
        assert_eq!(
            payload["session_name_hash"],
            "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
        );
        assert_eq!(payload["event_type"], "awaiting_input");

        let serialized = serde_json::to_string(payload).unwrap();
        assert!(!serialized.contains("claude"));
        assert!(!serialized.contains("/Users/"));
        assert!(!serialized.contains("last_line"));
    }

    #[tokio::test]
    async fn apns_send_uses_provider_jwt_and_private_payload() {
        let state = MockState::default();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let app = Router::new()
            .route("/3/device/device-token", post(apns_handler))
            .with_state(state.clone());
        tokio::spawn(async move {
            axum::serve(
                listener,
                app.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .await
            .unwrap();
        });

        let client = ApnsClient::new(ApnsCredentials {
            team_id: "TEAMID1234".to_string(),
            key_id: "KEYID1234".to_string(),
            topic: "app.fieldwork.ios".to_string(),
            private_key_pem: TEST_P8.as_bytes().to_vec(),
            endpoint: format!("http://{addr}"),
        })
        .unwrap();
        client.send(&delivery()).await.unwrap();

        assert_eq!(state.request_count.load(Ordering::Relaxed), 1);
        let requests = state.requests.lock().unwrap();
        assert_eq!(requests.len(), 1);
        assert!(
            requests[0]
                .authorization
                .as_deref()
                .is_some_and(|value| value.starts_with("bearer "))
        );
        assert_eq!(requests[0].topic.as_deref(), Some("app.fieldwork.ios"));
        assert_eq!(requests[0].push_type.as_deref(), Some("alert"));
        assert_eq!(requests[0].priority.as_deref(), Some("10"));
        let payload: serde_json::Value = serde_json::from_str(&requests[0].body).unwrap();
        assert_apns_payload_shape(&payload);
        assert!(!requests[0].body.contains("claude"));
        assert!(!requests[0].body.contains("/Users/"));
        assert!(!requests[0].body.contains("last_line"));
    }

    #[tokio::test]
    async fn apns_send_reuses_persistent_provider_connection() {
        let state = MockState::default();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let app = Router::new()
            .route("/3/device/device-token", post(apns_handler))
            .with_state(state.clone());
        tokio::spawn(async move {
            axum::serve(
                listener,
                app.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .await
            .unwrap();
        });

        let client = ApnsClient::new(ApnsCredentials {
            team_id: "TEAMID1234".to_string(),
            key_id: "KEYID1234".to_string(),
            topic: "app.fieldwork.ios".to_string(),
            private_key_pem: TEST_P8.as_bytes().to_vec(),
            endpoint: format!("http://{addr}"),
        })
        .unwrap();

        client.send(&delivery()).await.unwrap();
        client.send(&delivery()).await.unwrap();

        assert_eq!(state.request_count.load(Ordering::Relaxed), 2);
        let peer_addrs = state.peer_addrs.lock().unwrap();
        assert_eq!(peer_addrs.len(), 2);
        assert_eq!(
            peer_addrs[0], peer_addrs[1],
            "APNs dispatch should reuse the provider client connection"
        );
    }

    fn decode_segment<T: serde::de::DeserializeOwned>(jwt: &str, index: usize) -> T {
        let segment = jwt.split('.').nth(index).unwrap();
        let bytes = URL_SAFE_NO_PAD.decode(segment).unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    fn object_keys(value: &serde_json::Value) -> Vec<String> {
        let mut keys = value
            .as_object()
            .expect("JSON object")
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        keys.sort();
        keys
    }

    async fn apns_handler(
        State(state): State<MockState>,
        ConnectInfo(peer_addr): ConnectInfo<SocketAddr>,
        headers: HeaderMap,
        body: Bytes,
    ) -> impl IntoResponse {
        state.request_count.fetch_add(1, Ordering::Relaxed);
        state.peer_addrs.lock().unwrap().push(peer_addr);
        state.requests.lock().unwrap().push(ObservedApnsRequest {
            authorization: headers
                .get("authorization")
                .and_then(|value| value.to_str().ok())
                .map(str::to_string),
            topic: headers
                .get("apns-topic")
                .and_then(|value| value.to_str().ok())
                .map(str::to_string),
            push_type: headers
                .get("apns-push-type")
                .and_then(|value| value.to_str().ok())
                .map(str::to_string),
            priority: headers
                .get("apns-priority")
                .and_then(|value| value.to_str().ok())
                .map(str::to_string),
            body: String::from_utf8(body.to_vec()).unwrap(),
        });
        StatusCode::OK
    }
}
