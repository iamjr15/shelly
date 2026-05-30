use crate::forward::{ForwardedEvent, output_was_replayed, recv_attached_event};
use crate::ipc::{AppState, IrohEndpointInfo};
use crate::persistence::StoredDevice;
use anyhow::{Context, Result, bail};
use base64::{Engine as _, engine::general_purpose::STANDARD_NO_PAD};
use fieldwork_protocol::{
    CONTRACT_VERSION, ClientId, ClientKind, ClientToServerMsg, ErrorCode, ServerToClientMsg,
    max_frame_len, normalize_code,
};
use iroh::endpoint::{Connection, RecvStream, SendStream, presets};
use iroh::{Endpoint, RelayMode, RelayUrl, SecretKey};
use serde::{Serialize, de::DeserializeOwned};
use std::sync::Arc;
use tokio::sync::Mutex;
use tokio::time::{Duration, timeout};
use tracing::{debug, error, info, warn};

pub(crate) const FIELDWORK_ALPN: &[u8] = b"fieldwork/1";

const SERVICE: &str = "app.fieldwork";
const IROH_SECRET_ACCOUNT: &str = "iroh-secret-key-v1";
const IROH_SECRET_KEY_ENV: &str = "FIELDWORK_IROH_SECRET_KEY_B64";

pub(crate) async fn serve(state: Arc<AppState>) -> Result<()> {
    let secret_key = load_or_create_secret_key().context("load iroh endpoint secret")?;
    let mut builder = Endpoint::builder(presets::N0)
        .secret_key(secret_key)
        .alpns(vec![FIELDWORK_ALPN.to_vec()]);

    if let Some(relay_url) = configured_relay_url()? {
        builder = builder.relay_mode(RelayMode::custom([relay_url]));
    }

    let endpoint = builder.bind().await.context("bind iroh endpoint")?;
    let info = endpoint_info(&endpoint);
    state.set_iroh_endpoint(info.clone());
    info!(
        node_id = %info.node_id,
        relay_url = ?info.relay_url,
        addrs = ?info.addrs,
        "iroh transport listening"
    );

    let online = timeout(Duration::from_secs(5), endpoint.online()).await;
    if online.is_err() {
        warn!("iroh endpoint did not confirm relay connectivity within 5 seconds");
    }

    let info = endpoint_info(&endpoint);
    state.set_iroh_endpoint(info.clone());
    info!(
        node_id = %info.node_id,
        relay_url = ?info.relay_url,
        addrs = ?info.addrs,
        "iroh transport address refreshed"
    );

    while let Some(incoming) = endpoint.accept().await {
        let state = Arc::clone(&state);
        tokio::spawn(async move {
            let accepting = match incoming.accept() {
                Ok(accepting) => accepting,
                Err(error) => {
                    debug!(%error, "failed to accept incoming iroh handshake");
                    return;
                }
            };
            match accepting.await {
                Ok(conn) => {
                    if let Err(error) = handle_connection(state, conn).await {
                        error!(%error, "iroh client connection failed");
                    }
                }
                Err(error) => debug!(%error, "incoming iroh connection failed"),
            }
        });
    }

    Ok(())
}

fn endpoint_info(endpoint: &Endpoint) -> IrohEndpointInfo {
    let addr = endpoint.addr();
    IrohEndpointInfo {
        node_id: endpoint.id().to_string(),
        relay_url: addr.relay_urls().next().map(ToString::to_string),
        addrs: addr.ip_addrs().map(ToString::to_string).collect(),
    }
}

async fn handle_connection(state: Arc<AppState>, conn: Connection) -> Result<()> {
    let remote_node_id = conn.remote_id().to_string();
    let (send, mut recv) = conn.accept_bi().await.context("accept iroh stream")?;
    let writer = Arc::new(Mutex::new(send));
    let mut attach_task: Option<tokio::task::JoinHandle<()>> = None;
    let mut session_list_task: Option<tokio::task::JoinHandle<()>> = None;

    let hello: ClientToServerMsg = read_msg(&mut recv).await?;
    let (client_id, client_kind) = match hello {
        ClientToServerMsg::Hello {
            client_kind,
            protocol_version,
            ..
        } if protocol_version == CONTRACT_VERSION => {
            let client_id = ClientId::new();
            write_msg(
                &writer,
                &ServerToClientMsg::Welcome {
                    client_id,
                    daemon_version: env!("CARGO_PKG_VERSION").to_string(),
                    capabilities: state.capabilities(),
                },
            )
            .await?;
            (client_id, client_kind)
        }
        ClientToServerMsg::Hello {
            protocol_version, ..
        } => {
            write_msg(
                &writer,
                &ServerToClientMsg::Error {
                    code: ErrorCode::ProtocolMismatch,
                    message: format!(
                        "protocol version mismatch: client={protocol_version}, daemon={CONTRACT_VERSION}"
                    ),
                },
            )
            .await?;
            finish_writer(&writer).await?;
            return Ok(());
        }
        _ => {
            write_msg(
                &writer,
                &ServerToClientMsg::Error {
                    code: ErrorCode::InvalidRequest,
                    message: "first message must be Hello".to_string(),
                },
            )
            .await?;
            finish_writer(&writer).await?;
            return Ok(());
        }
    };

    let mut paired = state.is_device_paired(&remote_node_id);
    if paired && let Err(error) = state.mark_device_seen(&remote_node_id) {
        warn!(%error, %remote_node_id, "failed to persist device last_seen");
    }

    while let Ok(message) = read_msg::<_>(&mut recv).await {
        match message {
            ClientToServerMsg::Hello { .. } => {}
            ClientToServerMsg::PairWithCode {
                code,
                device_name,
                device_node_id,
            } => {
                if let Some(error) = pairing_peer_identity_error(&remote_node_id, &device_node_id) {
                    write_msg(&writer, &error).await?;
                    continue;
                }

                let code = normalize_code(&code);
                match state
                    .pairing
                    .request_approval(&code, device_name.clone(), remote_node_id.clone())
                    .await
                {
                    Ok(true) => {
                        state
                            .save_device(StoredDevice::new(device_name, remote_node_id.clone()))?;
                        paired = true;
                        let daemon_node_id = state.iroh_node_id().unwrap_or_default();
                        write_msg(
                            &writer,
                            &ServerToClientMsg::PairingComplete { daemon_node_id },
                        )
                        .await?;
                    }
                    Ok(false) => write_forbidden(&writer, "pairing denied").await?,
                    Err(error) => {
                        write_msg(
                            &writer,
                            &ServerToClientMsg::Error {
                                code: ErrorCode::Forbidden,
                                message: error.to_string(),
                            },
                        )
                        .await?;
                    }
                }
            }
            ClientToServerMsg::ListSessions => {
                if !require_paired(&writer, paired).await? {
                    continue;
                }
                write_msg(
                    &writer,
                    &ServerToClientMsg::SessionList {
                        sessions: state.summaries(),
                    },
                )
                .await?;
            }
            ClientToServerMsg::SubscribeSessions => {
                if !require_paired(&writer, paired).await? {
                    continue;
                }
                if let Some(task) = session_list_task.take() {
                    task.abort();
                }
                let (sessions, mut rx) = state.subscribe_session_list_with_initial();
                write_msg(&writer, &ServerToClientMsg::SessionList { sessions }).await?;

                let writer = Arc::clone(&writer);
                session_list_task = Some(tokio::spawn(async move {
                    while rx.changed().await.is_ok() {
                        let sessions = rx.borrow().clone();
                        if write_msg(&writer, &ServerToClientMsg::SessionList { sessions })
                            .await
                            .is_err()
                        {
                            break;
                        }
                    }
                }));
            }
            ClientToServerMsg::AttachSession {
                session_id,
                size,
                last_seen_seq,
            } => {
                if !require_paired(&writer, paired).await? {
                    continue;
                }

                let session = if let Some(session) = state
                    .sessions
                    .get(&session_id)
                    .map(|entry| Arc::clone(&entry))
                {
                    session
                } else if let Some(restored) = state.restored.get(&session_id) {
                    write_msg(
                        &writer,
                        &ServerToClientMsg::Attached {
                            session_id,
                            initial_bytes: restored.scrollback.clone(),
                            seq: restored
                                .scrollback_start_seq
                                .saturating_add(restored.scrollback.len() as u64),
                        },
                    )
                    .await?;
                    write_msg(
                        &writer,
                        &ServerToClientMsg::SessionExited {
                            session_id,
                            exit_code: restored.exit_code.unwrap_or(0),
                        },
                    )
                    .await?;
                    continue;
                } else {
                    write_msg(
                        &writer,
                        &ServerToClientMsg::Error {
                            code: ErrorCode::NotFound,
                            message: format!("session not found: {session_id}"),
                        },
                    )
                    .await?;
                    continue;
                };

                if let Some(task) = attach_task.take() {
                    task.abort();
                }
                let attachment = match session.attach_client(client_id, size) {
                    Ok(attachment) => attachment,
                    Err(error) => {
                        write_msg(
                            &writer,
                            &ServerToClientMsg::Error {
                                code: ErrorCode::Internal,
                                message: error.to_string(),
                            },
                        )
                        .await?;
                        continue;
                    }
                };
                let mut rx = session.subscribe();
                let (seq, initial_bytes) = session.attach_bytes(last_seen_seq);
                write_msg(
                    &writer,
                    &ServerToClientMsg::Attached {
                        session_id,
                        initial_bytes,
                        seq,
                    },
                )
                .await?;

                if let Some(exit_code) = session.exit_code() {
                    write_msg(
                        &writer,
                        &ServerToClientMsg::SessionExited {
                            session_id,
                            exit_code,
                        },
                    )
                    .await?;
                    continue;
                }

                let writer = Arc::clone(&writer);
                attach_task = Some(tokio::spawn(async move {
                    let _attachment = attachment;
                    loop {
                        match recv_attached_event(&mut rx, session_id).await {
                            ForwardedEvent::Message(event) => {
                                if output_was_replayed(&event, seq) {
                                    continue;
                                }
                                if write_msg(&writer, &event).await.is_err() {
                                    break;
                                }
                            }
                            ForwardedEvent::TerminalMessage(event) => {
                                if write_msg(&writer, &event).await.is_err() {
                                    break;
                                }
                                break;
                            }
                            ForwardedEvent::Closed => break,
                        }
                    }
                }));
            }
            ClientToServerMsg::Input { session_id, bytes } => {
                if !require_paired(&writer, paired).await? {
                    continue;
                }
                let error = state
                    .sessions
                    .get(&session_id)
                    .and_then(|session| session.write_input(&bytes).err());
                if let Some(error) = error {
                    write_msg(
                        &writer,
                        &ServerToClientMsg::Error {
                            code: ErrorCode::Internal,
                            message: error.to_string(),
                        },
                    )
                    .await?;
                }
            }
            ClientToServerMsg::Resize { session_id, size } => {
                if !require_paired(&writer, paired).await? {
                    continue;
                }
                let error = state
                    .sessions
                    .get(&session_id)
                    .and_then(|session| session.update_client_size(client_id, size).err());
                if let Some(error) = error {
                    write_msg(
                        &writer,
                        &ServerToClientMsg::Error {
                            code: ErrorCode::Internal,
                            message: error.to_string(),
                        },
                    )
                    .await?;
                }
            }
            ClientToServerMsg::RegisterPushToken { platform, token } => {
                if !require_paired(&writer, paired).await? {
                    continue;
                }
                match state.update_device_push(&remote_node_id, platform, token) {
                    Ok(true) => write_msg(&writer, &ServerToClientMsg::Pong { seq: 0 }).await?,
                    Ok(false) => write_unauthorized(&writer).await?,
                    Err(error) => {
                        write_msg(
                            &writer,
                            &ServerToClientMsg::Error {
                                code: ErrorCode::Internal,
                                message: error.to_string(),
                            },
                        )
                        .await?;
                    }
                }
            }
            ClientToServerMsg::Ping { seq } => {
                if !require_paired(&writer, paired).await? {
                    continue;
                }
                write_msg(&writer, &ServerToClientMsg::Pong { seq }).await?;
            }
            ClientToServerMsg::DetachSession => break,
            ClientToServerMsg::CreateSession { .. }
            | ClientToServerMsg::KillSession { .. }
            | ClientToServerMsg::BeginPairing { .. }
            | ClientToServerMsg::ApprovePairing { .. }
            | ClientToServerMsg::ListDevices
            | ClientToServerMsg::RemoveDevice { .. }
            | ClientToServerMsg::AgentStateEvent { .. } => {
                if matches!(client_kind, ClientKind::IosApp | ClientKind::AndroidApp) {
                    write_forbidden(&writer, "mobile clients cannot perform this operation")
                        .await?;
                } else {
                    write_forbidden(&writer, "iroh transport accepts mobile clients only").await?;
                }
            }
        }
    }

    if let Some(task) = attach_task {
        task.abort();
    }
    if let Some(task) = session_list_task {
        task.abort();
    }

    Ok(())
}

async fn require_paired(writer: &Arc<Mutex<SendStream>>, paired: bool) -> Result<bool> {
    if paired {
        return Ok(true);
    }

    write_unauthorized(writer).await?;
    Ok(false)
}

async fn write_unauthorized(writer: &Arc<Mutex<SendStream>>) -> Result<()> {
    write_msg(
        writer,
        &ServerToClientMsg::Error {
            code: ErrorCode::Unauthorized,
            message: "device is not paired".to_string(),
        },
    )
    .await
}

fn pairing_peer_identity_error(
    remote_node_id: &str,
    claimed_device_node_id: &str,
) -> Option<ServerToClientMsg> {
    if claimed_device_node_id == remote_node_id {
        return None;
    }

    Some(ServerToClientMsg::Error {
        code: ErrorCode::Unauthorized,
        message: "device node id does not match iroh peer identity".to_string(),
    })
}

async fn write_forbidden(writer: &Arc<Mutex<SendStream>>, message: &str) -> Result<()> {
    write_msg(
        writer,
        &ServerToClientMsg::Error {
            code: ErrorCode::Forbidden,
            message: message.to_string(),
        },
    )
    .await
}

async fn finish_writer(writer: &Arc<Mutex<SendStream>>) -> Result<()> {
    let mut writer = writer.lock().await;
    let stopped = writer.stopped();
    writer.finish().context("finish iroh stream")?;
    drop(writer);
    let _ = timeout(Duration::from_secs(1), stopped).await;
    Ok(())
}

#[cfg(test)]
mod peer_identity_tests {
    use super::pairing_peer_identity_error;
    use fieldwork_protocol::{ErrorCode, ServerToClientMsg};

    #[test]
    fn pairing_peer_identity_match_is_allowed() {
        assert!(pairing_peer_identity_error("node-a", "node-a").is_none());
    }

    #[test]
    fn pairing_peer_identity_mismatch_returns_unauthorized() {
        assert_eq!(
            pairing_peer_identity_error("node-a", "node-b"),
            Some(ServerToClientMsg::Error {
                code: ErrorCode::Unauthorized,
                message: "device node id does not match iroh peer identity".to_string(),
            })
        );
    }
}

async fn read_msg<T>(reader: &mut RecvStream) -> Result<T>
where
    T: DeserializeOwned,
{
    let mut len_bytes = [0_u8; 4];
    reader
        .read_exact(&mut len_bytes)
        .await
        .context("read iroh frame length")?;
    let len = u32::from_be_bytes(len_bytes) as usize;
    if len > max_frame_len() {
        bail!("frame too large: {len}");
    }
    let mut payload = vec![0; len];
    reader
        .read_exact(&mut payload)
        .await
        .context("read iroh frame payload")?;
    rmp_serde::from_slice(&payload).context("decode messagepack frame")
}

async fn write_msg<T>(writer: &Arc<Mutex<SendStream>>, message: &T) -> Result<()>
where
    T: Serialize,
{
    let payload = rmp_serde::to_vec_named(message).context("encode messagepack frame")?;
    if payload.len() > max_frame_len() {
        bail!("frame too large: {}", payload.len());
    }
    let mut writer = writer.lock().await;
    writer
        .write_all(&(payload.len() as u32).to_be_bytes())
        .await
        .context("write iroh frame length")?;
    writer
        .write_all(&payload)
        .await
        .context("write iroh frame payload")?;
    Ok(())
}

fn configured_relay_url() -> Result<Option<RelayUrl>> {
    let Some(value) = std::env::var_os("FIELDWORK_IROH_RELAY_URL") else {
        return Ok(None);
    };
    let value = value.to_string_lossy();
    if value.trim().is_empty() {
        return Ok(None);
    }
    Ok(Some(
        value.parse().context("parse FIELDWORK_IROH_RELAY_URL")?,
    ))
}

fn load_or_create_secret_key() -> Result<SecretKey> {
    if let Some(secret_key) = secret_key_from_env()? {
        return Ok(secret_key);
    }

    let entry =
        keyring::Entry::new(SERVICE, IROH_SECRET_ACCOUNT).context("open OS keychain entry")?;
    match entry.get_password() {
        Ok(encoded) => {
            let bytes = STANDARD_NO_PAD
                .decode(encoded)
                .context("decode iroh secret key")?;
            let key: [u8; 32] = bytes
                .try_into()
                .map_err(|_| anyhow::anyhow!("iroh secret key must be 32 bytes"))?;
            Ok(SecretKey::from_bytes(&key))
        }
        Err(keyring::Error::NoEntry) => {
            let secret_key = SecretKey::generate();
            entry
                .set_password(&STANDARD_NO_PAD.encode(secret_key.to_bytes()))
                .context("store iroh secret key in OS keychain")?;
            Ok(secret_key)
        }
        Err(error) => Err(error).context("read iroh secret key from OS keychain"),
    }
}

fn secret_key_from_env() -> Result<Option<SecretKey>> {
    let Some(value) = std::env::var_os(IROH_SECRET_KEY_ENV) else {
        return Ok(None);
    };
    let value = value.to_string_lossy();
    if value.trim().is_empty() {
        return Ok(None);
    }
    let bytes = STANDARD_NO_PAD
        .decode(value.trim())
        .with_context(|| format!("decode {IROH_SECRET_KEY_ENV}"))?;
    let key: [u8; 32] = bytes
        .try_into()
        .map_err(|_| anyhow::anyhow!("{IROH_SECRET_KEY_ENV} must decode to 32 bytes"))?;
    Ok(Some(SecretKey::from_bytes(&key)))
}

#[cfg(test)]
mod tests {
    use super::{IROH_SECRET_KEY_ENV, secret_key_from_env};
    use base64::{Engine as _, engine::general_purpose::STANDARD_NO_PAD};
    use std::ffi::OsString;
    use std::sync::Mutex;

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    struct EnvGuard {
        previous: Option<OsString>,
    }

    impl EnvGuard {
        fn set(value: String) -> Self {
            let previous = std::env::var_os(IROH_SECRET_KEY_ENV);
            unsafe {
                std::env::set_var(IROH_SECRET_KEY_ENV, value);
            }
            Self { previous }
        }
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            unsafe {
                match &self.previous {
                    Some(value) => std::env::set_var(IROH_SECRET_KEY_ENV, value),
                    None => std::env::remove_var(IROH_SECRET_KEY_ENV),
                }
            }
        }
    }

    #[test]
    fn loads_iroh_secret_key_from_env_for_smoke_tests() {
        let _guard = ENV_LOCK.lock().unwrap();
        let secret = [7_u8; 32];
        let _env = EnvGuard::set(STANDARD_NO_PAD.encode(secret));

        let key = secret_key_from_env().unwrap().unwrap();

        assert_eq!(key.to_bytes(), secret);
    }

    #[test]
    fn rejects_wrong_length_iroh_secret_key_env() {
        let _guard = ENV_LOCK.lock().unwrap();
        let _env = EnvGuard::set(STANDARD_NO_PAD.encode([1_u8; 31]));

        let error = secret_key_from_env().unwrap_err();

        assert!(
            error
                .to_string()
                .contains("FIELDWORK_IROH_SECRET_KEY_B64 must decode to 32 bytes")
        );
    }
}
