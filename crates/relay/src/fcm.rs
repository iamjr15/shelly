use anyhow::{Context, Result};
use base64::Engine;
use base64::engine::general_purpose::{STANDARD as BASE64, URL_SAFE_NO_PAD};
use reqwest::StatusCode;
use ring::{
    rand::SystemRandom,
    signature::{self, RsaKeyPair},
};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

const FCM_SCOPE: &str = "https://www.googleapis.com/auth/firebase.messaging";
const DEFAULT_FCM_ENDPOINT: &str = "https://fcm.googleapis.com";
const ACCESS_TOKEN_REFRESH_SKEW_SECONDS: u64 = 5 * 60;

#[derive(Clone)]
pub(crate) struct FcmClient {
    endpoint: String,
    project_id: String,
    token_uri: String,
    token_cache: Arc<Mutex<FcmTokenCache>>,
    http: reqwest::Client,
}

pub(crate) struct FcmCredentials {
    pub(crate) project_id: String,
    pub(crate) client_email: String,
    pub(crate) private_key_id: Option<String>,
    pub(crate) private_key_pem: Vec<u8>,
    pub(crate) token_uri: String,
    pub(crate) endpoint: String,
}

struct FcmTokenCache {
    client_email: String,
    private_key_id: Option<String>,
    signing_key: RsaKeyPair,
    cached: Option<CachedAccessToken>,
}

struct CachedAccessToken {
    token: String,
    expires_at_secs: u64,
}

#[derive(Deserialize)]
struct FcmServiceAccountFile {
    project_id: String,
    client_email: String,
    private_key_id: Option<String>,
    private_key: String,
    token_uri: Option<String>,
}

#[derive(Serialize)]
struct GoogleJwtHeader<'a> {
    alg: &'static str,
    typ: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    kid: Option<&'a str>,
}

#[derive(Serialize, Deserialize)]
struct GoogleClaims<'a> {
    iss: &'a str,
    scope: &'static str,
    aud: &'a str,
    iat: u64,
    exp: u64,
}

#[derive(Deserialize)]
struct GoogleTokenResponse {
    access_token: String,
    expires_in: u64,
    token_type: String,
}

#[derive(Serialize)]
struct FcmSendPayload<'a> {
    message: FcmMessage<'a>,
}

#[derive(Serialize)]
struct FcmMessage<'a> {
    token: &'a str,
    notification: FcmNotification<'a>,
    data: FcmData<'a>,
    android: FcmAndroidConfig<'a>,
}

#[derive(Serialize)]
struct FcmNotification<'a> {
    title: &'a str,
    body: &'a str,
}

#[derive(Serialize)]
struct FcmData<'a> {
    session_id_hash: &'a str,
    session_name_hash: &'a str,
    event_type: &'a str,
}

#[derive(Serialize)]
struct FcmAndroidConfig<'a> {
    priority: &'a str,
    notification: FcmAndroidNotification<'a>,
}

#[derive(Serialize)]
struct FcmAndroidNotification<'a> {
    channel_id: &'a str,
    click_action: &'a str,
}

impl FcmCredentials {
    pub(crate) fn from_env() -> Result<Option<Self>> {
        let Some(path) = fcm_service_account_path() else {
            return Ok(None);
        };
        if !path.exists() {
            return Ok(None);
        }

        let bytes = std::fs::read(&path)
            .with_context(|| format!("read FCM service account from {}", path.display()))?;
        let file: FcmServiceAccountFile =
            serde_json::from_slice(&bytes).context("parse FCM service account JSON")?;
        let token_uri = file
            .token_uri
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| "https://oauth2.googleapis.com/token".to_string());
        let endpoint = std::env::var("SHELLY_FCM_ENDPOINT")
            .unwrap_or_else(|_| DEFAULT_FCM_ENDPOINT.to_string());

        Ok(Some(Self {
            project_id: required_field("project_id", file.project_id)?,
            client_email: required_field("client_email", file.client_email)?,
            private_key_id: file.private_key_id.filter(|value| !value.trim().is_empty()),
            private_key_pem: required_field("private_key", file.private_key)?.into_bytes(),
            token_uri,
            endpoint,
        }))
    }
}

impl FcmClient {
    pub(crate) fn new(credentials: FcmCredentials) -> Result<Self> {
        Ok(Self {
            endpoint: credentials.endpoint.trim_end_matches('/').to_string(),
            project_id: credentials.project_id,
            token_uri: credentials.token_uri,
            token_cache: Arc::new(Mutex::new(FcmTokenCache::new(
                credentials.client_email,
                credentials.private_key_id,
                credentials.private_key_pem,
            )?)),
            http: reqwest::Client::builder()
                .http2_keep_alive_interval(Some(Duration::from_secs(60)))
                .http2_keep_alive_timeout(Duration::from_secs(10))
                .http2_keep_alive_while_idle(true)
                .build()
                .context("build FCM HTTP/2 client")?,
        })
    }

    pub(crate) fn from_env() -> Result<Option<Self>> {
        FcmCredentials::from_env()?.map(Self::new).transpose()
    }

    pub(crate) async fn send(
        &self,
        delivery: &crate::DeliveredPush,
    ) -> std::result::Result<(), crate::ProviderDeliveryError> {
        let token = self
            .access_token(now_secs())
            .await
            .map_err(provider_error)?;
        let body = self.payload_json(delivery).map_err(provider_error)?;
        let response = self
            .http
            .post(format!(
                "{}/v1/projects/{}/messages:send",
                self.endpoint, self.project_id
            ))
            .bearer_auth(token)
            .header("content-type", "application/json")
            .body(body)
            .send()
            .await
            .context("send FCM request")
            .map_err(provider_error)?;

        if response.status() != StatusCode::OK {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            if let Some(reason) = fcm_invalid_token_reason(&body) {
                return Err(crate::ProviderDeliveryError::invalid_token("FCM", reason));
            }
            return Err(provider_error(anyhow::anyhow!(
                "FCM rejected notification with {status}: {body}"
            )));
        }
        Ok(())
    }

    async fn access_token(&self, now_secs: u64) -> Result<String> {
        if let Some(token) = self
            .token_cache
            .lock()
            .expect("FCM token cache lock poisoned")
            .cached_token(now_secs)
        {
            return Ok(token);
        }

        let assertion = self
            .token_cache
            .lock()
            .expect("FCM token cache lock poisoned")
            .jwt(&self.token_uri, now_secs)?;
        let response = self.exchange_token(&assertion).await?;
        let expires_at_secs = now_secs
            + response
                .expires_in
                .saturating_sub(ACCESS_TOKEN_REFRESH_SKEW_SECONDS);
        let mut cache = self
            .token_cache
            .lock()
            .expect("FCM token cache lock poisoned");
        cache.cached = Some(CachedAccessToken {
            token: response.access_token.clone(),
            expires_at_secs,
        });
        Ok(response.access_token)
    }

    async fn exchange_token(&self, assertion: &str) -> Result<GoogleTokenResponse> {
        let body = format!(
            "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion={assertion}"
        );
        let response = self
            .http
            .post(&self.token_uri)
            .header("content-type", "application/x-www-form-urlencoded")
            .body(body)
            .send()
            .await
            .context("exchange FCM service-account JWT for OAuth token")?;
        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            anyhow::bail!("Google OAuth rejected FCM service-account JWT with {status}: {body}");
        }
        let token: GoogleTokenResponse = response
            .json()
            .await
            .context("decode FCM OAuth token response")?;
        if !token.token_type.eq_ignore_ascii_case("bearer") {
            anyhow::bail!("Google OAuth returned unsupported token_type");
        }
        Ok(token)
    }

    fn payload_json(&self, delivery: &crate::DeliveredPush) -> Result<String> {
        let payload = FcmSendPayload {
            message: FcmMessage {
                token: &delivery.recipient_token,
                notification: FcmNotification {
                    title: &delivery.title,
                    body: &delivery.body,
                },
                data: FcmData {
                    session_id_hash: &delivery.session_id_hash,
                    session_name_hash: &delivery.session_name_hash,
                    event_type: delivery.event_type.as_str(),
                },
                android: FcmAndroidConfig {
                    priority: "HIGH",
                    notification: FcmAndroidNotification {
                        channel_id: "shelly-agent-state",
                        click_action: "SHELLY_OPEN_SESSION",
                    },
                },
            },
        };
        serde_json::to_string(&payload).context("encode FCM payload")
    }
}

impl FcmTokenCache {
    fn new(
        client_email: String,
        private_key_id: Option<String>,
        private_key_pem: Vec<u8>,
    ) -> Result<Self> {
        let private_key_pem =
            std::str::from_utf8(&private_key_pem).context("FCM private_key is not valid UTF-8")?;
        let der = pkcs8_der_from_pem(private_key_pem)?;
        let signing_key = RsaKeyPair::from_pkcs8(&der)
            .map_err(|_| anyhow::anyhow!("parse FCM service-account RSA private key"))?;
        Ok(Self {
            client_email,
            private_key_id,
            signing_key,
            cached: None,
        })
    }

    fn cached_token(&self, now_secs: u64) -> Option<String> {
        let cached = self.cached.as_ref()?;
        (now_secs < cached.expires_at_secs).then(|| cached.token.clone())
    }

    fn jwt(&self, token_uri: &str, now_secs: u64) -> Result<String> {
        let header = GoogleJwtHeader {
            alg: "RS256",
            typ: "JWT",
            kid: self.private_key_id.as_deref(),
        };
        let claims = GoogleClaims {
            iss: &self.client_email,
            scope: FCM_SCOPE,
            aud: token_uri,
            iat: now_secs,
            exp: now_secs + 60 * 60,
        };
        let signing_input = format!("{}.{}", b64_json(&header)?, b64_json(&claims)?);
        let rng = SystemRandom::new();
        let mut signature = vec![0; self.signing_key.public().modulus_len()];
        self.signing_key
            .sign(
                &signature::RSA_PKCS1_SHA256,
                &rng,
                signing_input.as_bytes(),
                &mut signature,
            )
            .map_err(|_| anyhow::anyhow!("sign FCM service-account JWT"))?;
        Ok(format!(
            "{signing_input}.{}",
            URL_SAFE_NO_PAD.encode(signature)
        ))
    }
}

fn b64_json<T: Serialize>(value: &T) -> Result<String> {
    let bytes = serde_json::to_vec(value).context("encode FCM JWT JSON segment")?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

fn pkcs8_der_from_pem(pem: &str) -> Result<Vec<u8>> {
    let mut body = String::new();
    let mut in_key = false;
    for line in pem.lines().map(str::trim) {
        match line {
            "-----BEGIN PRIVATE KEY-----" => in_key = true,
            "-----END PRIVATE KEY-----" => break,
            _ if in_key => body.push_str(line),
            _ => {}
        }
    }
    if body.is_empty() {
        anyhow::bail!("FCM private_key is not a PKCS#8 PRIVATE KEY PEM");
    }
    BASE64
        .decode(body)
        .context("decode FCM PKCS#8 private key PEM")
}

fn fcm_service_account_path() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("SHELLY_FCM_SERVICE_ACCOUNT_PATH") {
        return Some(path.into());
    }
    let credentials_dir = std::env::var_os("CREDENTIALS_DIRECTORY")?;
    Some(PathBuf::from(credentials_dir).join("fcm-service-account.json"))
}

fn required_field(name: &str, value: String) -> Result<String> {
    let value = value.trim();
    if value.is_empty() {
        anyhow::bail!("FCM service account {name} is required");
    }
    Ok(value.to_string())
}

fn fcm_invalid_token_reason(body: &str) -> Option<String> {
    let value = serde_json::from_str::<serde_json::Value>(body).ok()?;
    let details = value.get("error")?.get("details")?.as_array()?;
    for detail in details {
        let fcm_error_type = detail
            .get("@type")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|value| value == "type.googleapis.com/google.firebase.fcm.v1.FcmError");
        let error_code = detail.get("errorCode").and_then(serde_json::Value::as_str);
        if fcm_error_type && error_code == Some("UNREGISTERED") {
            return Some("UNREGISTERED".to_string());
        }
    }
    None
}

fn provider_error(error: anyhow::Error) -> crate::ProviderDeliveryError {
    crate::ProviderDeliveryError::other("FCM", error)
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
        extract::State,
        http::{HeaderMap, StatusCode},
        response::IntoResponse,
        routing::post,
    };
    use base64::Engine;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use serde_json::json;
    use std::sync::atomic::{AtomicUsize, Ordering};

    const TEST_RSA_KEY: &str = r#"-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCcJPiZGauoV7SA
dpgDPBmc7XDr3s8tx2DxdcJ+tmPPByOU+cvvqeul1i9F19reMo7W+7L60mDO6xT2
/b5lAH8+JEZXuBKPP8ZQN0sWbxwfgIH8Z6xNlWQPP4GnWgiUAW/Td3NJkvDI3Ush
OeB3tZSTjFNWE4vc7v6uKw6zBjhcPdMP7XfyPGOLrOZ95fNbJdhHM4fcP7LQiv6Z
WP6DtmfzcctMxaEfsZ0YJU6jSAbOLefNuKRRSPaRVmgqcxVyayzQNRhWhkHEyiXm
g4Z1HxbFIo/sjbULzeir0eo/MYRxi09xpdSxFsrUKbx8vK+FX3oK4NGgr67cm/p4
k/5B/RdZAgMBAAECggEAAPmDGr42sdeQTx/5DXDIg9AAnTGixJlNa9xtZnSVgBM+
P926TeiXNGMMoFM7W26LMTYuKmjPRWNhb17rRhP1d19rF/zpvWlWFSXvNaM5FKJC
TXTJNiJurDYG2r2nYY3LvfvC0AysgkMisaumkMtk83HUCwIWuf486pHmvCvXr2MJ
6Dfa9WzCcGVuYQDxwy6B7lIZGxVulbb0FUe38FdVWlE3h9IA9i7lVQ7UTPfRhGc2
obooyWxo3PV8GnN73LxBHKvpihvYenLL8x8E9SHX7xmbxoRsVH7M4exsTJ1JYrXQ
PC5Fp4ggLwlB2F5U7zmMYjfls/D5C5BpGycrFS1coQKBgQDUJOt8Mr1u/mF5qgN2
ZrwO0dMwDso556e9q+bESmR+w1Pp0sVUcOgkaFWbB/IEYHpnl2OryYUsWMLcK3xr
AzbqQob7MvSv6oS5f8u5F7AE1peCpS5GzJ4RQIdi+EVgaMjUkzNDd/NZY6Iw8R53
OEiGuic2IR8rm51Lai8z/bMncQKBgQC8bG8gBmLunR/4G0h7T7a9n7QJQaz1MY9D
fjtiz4wyT5+RChFVEOqg7DQFS3kqz0jIKbz/4jmSZj/3C8ox7+MoyTgf8Ruogopt
pu7SiYUjzVmJNe9aey5afHcvYeHDWgo4Hyj71Z58B2G0+jhJlEivWsU72oHDUnC7
UtmqSq+KaQKBgEXa0l/XJWGDCf3R6cn3Ej2fAfd1J0nh6e4eyKIiDO1gzCTWbnvb
odU7NdUSzLJ8QlISG5PZi6yKnb954kIqkM6akW/t23yBsKqUVjTgg+lT8Bfo5FAT
2Ii9wtboAZA5cMfuoJa6zLrGgAW1n96J/fe/HGJKjcUCPM00bc6k33VBAoGBAJlh
G0RSbo4WUUPB0cqvJO5O5lrynzwoz5n9U5InqNP7hMSoEVvRnWzJWb9FpKh4e6KU
d0lEeeD2YvNTIZBs2dkFky5NMlqFiPGhhZ7UWxC9xDixMtnQk/cMgmiLoR9IWDE/
DDmTtqL3z01mshMTJee4V/1U7XR101ZpJs48ZZChAoGAfSBVnmLZ8mx9QE8O2RVJ
r/rnpzeRgbIajLpGG6AoULvJiq0Z/2SynhaKlAO//21TSRtVZydgAC5rttuWPEb1
w6+ablwd6Mx5EvLBvOWtTR07CqYuhep1x2n1CdFdnl9xwoiOK4zcmMTXpGZ17VkJ
QuQiDPxvGAbQ1yXAK5PsWzA=
-----END PRIVATE KEY-----"#;

    #[derive(Clone, Default)]
    struct MockState {
        token_requests: Arc<AtomicUsize>,
        fcm_requests: Arc<Mutex<Vec<ObservedFcmRequest>>>,
    }

    #[derive(Clone)]
    struct ObservedFcmRequest {
        authorization: Option<String>,
        body: String,
    }

    fn delivery() -> crate::DeliveredPush {
        crate::DeliveredPush {
            platform: crate::PushPlatform::Fcm,
            recipient_token: "fcm-token-for-device".to_string(),
            title: "Shelly".to_string(),
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
    fn fcm_service_account_jwt_contains_expected_claims() {
        let cache = FcmTokenCache::new(
            "shelly@example.iam.gserviceaccount.com".to_string(),
            Some("private-key-id".to_string()),
            TEST_RSA_KEY.as_bytes().to_vec(),
        )
        .unwrap();

        let jwt = cache
            .jwt("https://oauth2.googleapis.com/token", 1_700_000_000)
            .unwrap();
        let header = decode_segment::<serde_json::Value>(&jwt, 0);
        assert_eq!(header["alg"], "RS256");
        assert_eq!(header["kid"], "private-key-id");
        let claims = decode_segment::<serde_json::Value>(&jwt, 1);
        assert_eq!(claims["iss"], "shelly@example.iam.gserviceaccount.com");
        assert_eq!(claims["scope"], FCM_SCOPE);
        assert_eq!(claims["aud"], "https://oauth2.googleapis.com/token");
        assert_eq!(claims["iat"], 1_700_000_000);
        assert_eq!(claims["exp"], 1_700_003_600);
    }

    #[test]
    fn fcm_payload_contains_only_generic_text_and_hashes() {
        let client = fcm_client("http://127.0.0.1:1", "http://127.0.0.1:1/token");
        let payload: serde_json::Value =
            serde_json::from_str(&client.payload_json(&delivery()).unwrap()).unwrap();
        assert_fcm_payload_shape(&payload);
    }

    #[test]
    fn fcm_invalid_token_reason_detects_unregistered_fcm_error() {
        let body = json!({
            "error": {
                "code": 404,
                "message": "Requested entity was not found.",
                "status": "NOT_FOUND",
                "details": [{
                    "@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError",
                    "errorCode": "UNREGISTERED"
                }]
            }
        })
        .to_string();

        assert_eq!(
            fcm_invalid_token_reason(&body).as_deref(),
            Some("UNREGISTERED")
        );
    }

    fn assert_fcm_payload_shape(payload: &serde_json::Value) {
        assert_eq!(object_keys(payload), vec!["message"]);
        let message = &payload["message"];
        assert_eq!(
            object_keys(message),
            vec!["android", "data", "notification", "token"]
        );
        assert_eq!(message["token"], "fcm-token-for-device");
        assert_eq!(object_keys(&message["notification"]), vec!["body", "title"]);
        assert_eq!(message["notification"]["title"], "Shelly");
        assert_eq!(
            message["notification"]["body"],
            "A session is waiting for you."
        );
        assert_eq!(
            message["data"],
            json!({
                "session_id_hash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "session_name_hash": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                "event_type": "awaiting_input"
            })
        );
        assert_eq!(
            object_keys(&message["android"]),
            vec!["notification", "priority"]
        );
        assert_eq!(message["android"]["priority"], "HIGH");
        assert_eq!(
            object_keys(&message["android"]["notification"]),
            vec!["channel_id", "click_action"]
        );
        assert_eq!(
            message["android"]["notification"]["channel_id"],
            "shelly-agent-state"
        );
        assert_eq!(
            message["android"]["notification"]["click_action"],
            "SHELLY_OPEN_SESSION"
        );

        let serialized = serde_json::to_string(payload).unwrap();
        assert!(!serialized.contains("claude"));
        assert!(!serialized.contains("/Users/"));
        assert!(!serialized.contains("last_line"));
    }

    #[tokio::test]
    async fn fcm_send_uses_cached_oauth_token_and_private_payload() {
        let state = MockState::default();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let app = Router::new()
            .route("/token", post(token_handler))
            .route("/v1/projects/test-project/messages:send", post(fcm_handler))
            .with_state(state.clone());
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        let endpoint = format!("http://{addr}");
        let client = fcm_client(&endpoint, &format!("{endpoint}/token"));
        client.send(&delivery()).await.unwrap();
        client.send(&delivery()).await.unwrap();

        assert_eq!(state.token_requests.load(Ordering::Relaxed), 1);
        let requests = state.fcm_requests.lock().unwrap();
        assert_eq!(requests.len(), 2);
        assert_eq!(
            requests[0].authorization.as_deref(),
            Some("Bearer mock-access-token")
        );
        let payload: serde_json::Value = serde_json::from_str(&requests[0].body).unwrap();
        assert_fcm_payload_shape(&payload);
        assert!(!requests[0].body.contains("claude"));
        assert!(!requests[0].body.contains("/Users/"));
        assert!(!requests[0].body.contains("last_line"));
    }

    fn fcm_client(endpoint: &str, token_uri: &str) -> FcmClient {
        FcmClient::new(FcmCredentials {
            project_id: "test-project".to_string(),
            client_email: "shelly@example.iam.gserviceaccount.com".to_string(),
            private_key_id: Some("private-key-id".to_string()),
            private_key_pem: TEST_RSA_KEY.as_bytes().to_vec(),
            token_uri: token_uri.to_string(),
            endpoint: endpoint.to_string(),
        })
        .unwrap()
    }

    async fn token_handler(State(state): State<MockState>, body: Bytes) -> impl IntoResponse {
        state.token_requests.fetch_add(1, Ordering::Relaxed);
        let body = std::str::from_utf8(&body).unwrap();
        assert!(body.contains("grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer"));
        assert!(body.contains("assertion="));
        (
            StatusCode::OK,
            axum::Json(json!({
                "access_token": "mock-access-token",
                "expires_in": 3600,
                "token_type": "Bearer"
            })),
        )
    }

    async fn fcm_handler(
        State(state): State<MockState>,
        headers: HeaderMap,
        body: Bytes,
    ) -> impl IntoResponse {
        state.fcm_requests.lock().unwrap().push(ObservedFcmRequest {
            authorization: headers
                .get("authorization")
                .and_then(|value| value.to_str().ok())
                .map(str::to_string),
            body: String::from_utf8(body.to_vec()).unwrap(),
        });
        (StatusCode::OK, axum::Json(json!({"name": "mock-message"})))
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
}
