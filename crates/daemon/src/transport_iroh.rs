use crate::SERVICE;
use crate::forward::{ForwardedEvent, output_was_replayed, recv_attached_event};
use crate::ipc::{AppState, IrohEndpointInfo, create_session_for, kill_session_response};
use crate::persistence::StoredDevice;
use anyhow::{Context, Result, bail};
use base64::{Engine as _, engine::general_purpose::STANDARD_NO_PAD};
use iroh::endpoint::{Connection, RecvStream, SendStream, presets};
use iroh::{Endpoint, RelayMode, RelayUrl, SecretKey};
use serde::{Serialize, de::DeserializeOwned};
use shelly_protocol::{
    CONTRACT_VERSION, ClientId, ClientKind, ClientToServerMsg, ErrorCode, ServerToClientMsg,
    SessionId, max_frame_len, normalize_code,
};
use std::sync::Arc;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::{Mutex, broadcast, watch};
use tokio::time::{Duration, timeout};
use tracing::{debug, error, info, warn};

pub(crate) const SHELLY_ALPN: &[u8] = b"shelly/1";

const IROH_SECRET_ACCOUNT: &str = "iroh-secret-key-v1";
const IROH_SECRET_KEY_ENV: &str = "SHELLY_IROH_SECRET_KEY_B64";

pub(crate) async fn serve(state: Arc<AppState>) -> Result<()> {
    let secret_key = load_or_create_secret_key().context("load iroh endpoint secret")?;
    // Build from the minimal preset (crypto only) rather than presets::N0 so the
    // endpoint contacts no n0 server: no n0 DNS/pkarr publish or resolve, and n0's
    // public relays are not used. The self-hosted relay is the sole rendezvous.
    let mut builder = Endpoint::builder(presets::Minimal)
        .secret_key(secret_key)
        .alpns(vec![SHELLY_ALPN.to_vec()]);

    match configured_relay_url()? {
        Some(relay_url) => {
            builder = builder.relay_mode(RelayMode::custom([relay_url]));
        }
        None => {
            warn!(
                "SHELLY_IROH_RELAY_URL is not set; the iroh endpoint runs direct-only \
                 (no relay, no n0 fallback). Same-host and same-network reconnects work \
                 over direct addresses, but cross-network reconnect needs a self-hosted \
                 iroh relay."
            );
        }
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
    let mut attach_task: Option<ForwarderTask> = None;
    let mut session_list_task: Option<ForwarderTask> = None;

    let hello: ClientToServerMsg = read_msg(&mut recv).await?;
    let (client_id, client_kind) = match hello {
        ClientToServerMsg::Hello {
            client_kind,
            protocol_version,
            ..
        } if protocol_version == CONTRACT_VERSION => {
            if let Some(error) = iroh_client_kind_error(client_kind) {
                write_msg(&writer, &error).await?;
                finish_writer(&writer).await?;
                return Ok(());
            }

            let client_id = ClientId::new();
            write_msg(
                &writer,
                &ServerToClientMsg::Welcome {
                    client_id,
                    daemon_version: env!("CARGO_PKG_VERSION").to_string(),
                    capabilities: state.capabilities(),
                    host_name: crate::ipc::host_display_name(),
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
    let mut revocation_rx = state.subscribe_device_revocation(&remote_node_id);
    if paired && let Err(error) = state.mark_device_seen(&remote_node_id) {
        warn!(%error, %remote_node_id, "failed to persist device last_seen");
    }

    loop {
        let message = tokio::select! {
            message = read_msg::<ClientToServerMsg>(&mut recv) => match message {
                Ok(message) => message,
                Err(_) => break,
            },
            _ = revocation_rx.changed(), if paired => break,
        };
        if paired && !state.is_device_paired(&remote_node_id) {
            break;
        }
        match message {
            ClientToServerMsg::Hello { .. } => {
                // Retrying clients may replay Hello after the handshake, so keep it idempotent.
            }
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
                        revocation_rx.borrow_and_update();
                        let daemon_node_id = state.iroh_node_id().unwrap_or_default();
                        write_msg(
                            &writer,
                            &ServerToClientMsg::PairingComplete { daemon_node_id },
                        )
                        .await?;
                    }
                    Ok(false) => write_forbidden(&writer, "pairing denied on laptop").await?,
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
                    task.shutdown();
                }
                let (sessions, rx) = state.subscribe_session_list_with_initial();
                write_msg(&writer, &ServerToClientMsg::SessionList { sessions }).await?;

                let writer = Arc::clone(&writer);
                let revocation = revocation_rx.clone();
                session_list_task = Some(ForwarderTask::spawn(move |shutdown| async move {
                    forward_session_list_updates(writer, rx, shutdown, revocation).await;
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
                    task.shutdown();
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
                let rx = session.subscribe();
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
                let revocation = revocation_rx.clone();
                attach_task = Some(ForwarderTask::spawn(move |shutdown| async move {
                    let _attachment = attachment;
                    forward_attached_events(writer, rx, session_id, seq, shutdown, revocation)
                        .await;
                }));
            }
            ClientToServerMsg::Input { session_id, bytes } => {
                if !require_paired(&writer, paired).await? {
                    continue;
                }
                let Some(session) = state
                    .sessions
                    .get(&session_id)
                    .map(|entry| Arc::clone(&entry))
                else {
                    write_session_not_found(&writer, session_id).await?;
                    continue;
                };
                let error = session.write_input(&bytes).err();
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
                let Some(session) = state
                    .sessions
                    .get(&session_id)
                    .map(|entry| Arc::clone(&entry))
                else {
                    write_session_not_found(&writer, session_id).await?;
                    continue;
                };
                let error = session.update_client_size(client_id, size).err();
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
            ClientToServerMsg::UnregisterPushToken { platform, token } => {
                if !require_paired(&writer, paired).await? {
                    continue;
                }
                match state.clear_device_push(&remote_node_id, platform, token) {
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
            ClientToServerMsg::CreateSession {
                name,
                command,
                cwd,
                env,
                size,
            } => {
                if !require_paired(&writer, paired).await? {
                    continue;
                }
                // Mobile create is shell-only: `create_session_for` ignores the
                // client-supplied command/cwd/env and forces a default shell.
                let response =
                    create_session_for(&state, client_kind, name, command, cwd, env, size);
                write_msg(&writer, &response).await?;
            }
            ClientToServerMsg::KillSession { session_id } => {
                if !require_paired(&writer, paired).await? {
                    continue;
                }
                let response = kill_session_response(&state, session_id);
                write_msg(&writer, &response).await?;
            }
            ClientToServerMsg::BeginPairing { .. }
            | ClientToServerMsg::ApprovePairing { .. }
            | ClientToServerMsg::ListDevices
            | ClientToServerMsg::RemoveDevice { .. }
            | ClientToServerMsg::AgentStateEvent { .. } => {
                write_forbidden(&writer, forbidden_iroh_operation_message(client_kind)).await?;
            }
        }
    }

    if let Some(task) = attach_task {
        task.shutdown();
    }
    if let Some(task) = session_list_task {
        task.shutdown();
    }

    Ok(())
}

struct ForwarderTask {
    shutdown: watch::Sender<bool>,
    handle: tokio::task::JoinHandle<()>,
}

impl ForwarderTask {
    fn spawn<F>(build: impl FnOnce(watch::Receiver<bool>) -> F) -> Self
    where
        F: std::future::Future<Output = ()> + Send + 'static,
    {
        let (shutdown, shutdown_rx) = watch::channel(false);
        let handle = tokio::spawn(build(shutdown_rx));
        Self { shutdown, handle }
    }

    fn shutdown(self) {
        let _ = self.shutdown.send(true);
        drop(self.handle);
    }
}

async fn forward_session_list_updates<W>(
    writer: Arc<Mutex<W>>,
    mut rx: watch::Receiver<Vec<shelly_protocol::SessionSummary>>,
    mut shutdown: watch::Receiver<bool>,
    mut revocation: watch::Receiver<u64>,
) where
    W: AsyncWrite + Unpin,
{
    loop {
        let changed = tokio::select! {
            changed = rx.changed() => changed,
            _ = shutdown.changed() => break,
            _ = revocation.changed() => break,
        };
        if changed.is_err() {
            break;
        }
        let sessions = rx.borrow_and_update().clone();
        if write_msg(&writer, &ServerToClientMsg::SessionList { sessions })
            .await
            .is_err()
        {
            break;
        }
    }
}

async fn forward_attached_events<W>(
    writer: Arc<Mutex<W>>,
    mut rx: broadcast::Receiver<ServerToClientMsg>,
    session_id: SessionId,
    attached_seq: u64,
    mut shutdown: watch::Receiver<bool>,
    mut revocation: watch::Receiver<u64>,
) where
    W: AsyncWrite + Unpin,
{
    loop {
        let event = tokio::select! {
            event = recv_attached_event(&mut rx, session_id) => event,
            _ = shutdown.changed() => break,
            _ = revocation.changed() => break,
        };
        match event {
            ForwardedEvent::Message(event) => {
                if output_was_replayed(&event, attached_seq) {
                    continue;
                }
                if write_msg(&writer, &event).await.is_err() {
                    break;
                }
            }
            ForwardedEvent::TerminalMessage(event) => {
                let _ = write_msg(&writer, &event).await;
                break;
            }
            ForwardedEvent::Closed => break,
        }
    }
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

fn forbidden_iroh_operation_message(client_kind: ClientKind) -> &'static str {
    match client_kind {
        ClientKind::IosApp | ClientKind::AndroidApp => {
            "mobile clients cannot perform this operation"
        }
        ClientKind::LocalCli => "iroh transport accepts mobile clients only",
    }
}

fn iroh_client_kind_error(client_kind: ClientKind) -> Option<ServerToClientMsg> {
    if matches!(client_kind, ClientKind::IosApp | ClientKind::AndroidApp) {
        return None;
    }

    Some(ServerToClientMsg::Error {
        code: ErrorCode::Forbidden,
        message: "iroh transport accepts mobile clients only".to_string(),
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

async fn write_session_not_found(
    writer: &Arc<Mutex<SendStream>>,
    session_id: SessionId,
) -> Result<()> {
    write_msg(
        writer,
        &ServerToClientMsg::Error {
            code: ErrorCode::NotFound,
            message: format!("session not found: {session_id}"),
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
    use super::{
        forbidden_iroh_operation_message, iroh_client_kind_error, pairing_peer_identity_error,
    };
    use shelly_protocol::{ClientKind, ErrorCode, ServerToClientMsg};

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

    #[test]
    fn forbidden_operation_messages_preserve_iroh_mobile_boundary() {
        assert_eq!(
            forbidden_iroh_operation_message(ClientKind::IosApp),
            "mobile clients cannot perform this operation"
        );
        assert_eq!(
            forbidden_iroh_operation_message(ClientKind::AndroidApp),
            "mobile clients cannot perform this operation"
        );
        assert_eq!(
            forbidden_iroh_operation_message(ClientKind::LocalCli),
            "iroh transport accepts mobile clients only"
        );
    }

    #[test]
    fn iroh_handshake_accepts_only_mobile_client_kinds() {
        assert!(iroh_client_kind_error(ClientKind::IosApp).is_none());
        assert!(iroh_client_kind_error(ClientKind::AndroidApp).is_none());
        assert_eq!(
            iroh_client_kind_error(ClientKind::LocalCli),
            Some(ServerToClientMsg::Error {
                code: ErrorCode::Forbidden,
                message: "iroh transport accepts mobile clients only".to_string(),
            })
        );
    }
}

async fn read_msg<T>(reader: &mut RecvStream) -> Result<T>
where
    T: DeserializeOwned,
{
    read_msg_from(reader).await
}

async fn read_msg_from<T, R>(reader: &mut R) -> Result<T>
where
    T: DeserializeOwned,
    R: AsyncRead + Unpin,
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

async fn write_msg<T, W>(writer: &Arc<Mutex<W>>, message: &T) -> Result<()>
where
    T: Serialize,
    W: AsyncWrite + Unpin,
{
    let mut writer = writer.lock().await;
    write_msg_to(&mut *writer, message).await
}

async fn write_msg_to<T, W>(writer: &mut W, message: &T) -> Result<()>
where
    T: Serialize,
    W: AsyncWrite + Unpin,
{
    let payload = rmp_serde::to_vec_named(message).context("encode messagepack frame")?;
    if payload.len() > max_frame_len() {
        bail!("frame too large: {}", payload.len());
    }
    let mut frame = Vec::with_capacity(4 + payload.len());
    frame.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    frame.extend_from_slice(&payload);
    writer.write_all(&frame).await.context("write iroh frame")?;
    writer.flush().await.context("flush iroh frame")?;
    Ok(())
}

fn configured_relay_url() -> Result<Option<RelayUrl>> {
    let Some(value) = std::env::var_os("SHELLY_IROH_RELAY_URL") else {
        return Ok(None);
    };
    let value = value.to_string_lossy();
    if value.trim().is_empty() {
        return Ok(None);
    }
    Ok(Some(value.parse().context("parse SHELLY_IROH_RELAY_URL")?))
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
    use super::{
        IROH_SECRET_KEY_ENV, forward_attached_events, read_msg_from, secret_key_from_env,
        write_msg_to,
    };
    use base64::{Engine as _, engine::general_purpose::STANDARD_NO_PAD};
    use shelly_protocol::{ServerToClientMsg, SessionId, max_frame_len};
    use std::ffi::OsString;
    use std::sync::{Arc, Mutex};
    use tokio::io::{AsyncWriteExt as _, duplex};
    use tokio::sync::{Mutex as TokioMutex, broadcast, watch};
    use tokio::time::{Duration, timeout};

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
                .contains("SHELLY_IROH_SECRET_KEY_B64 must decode to 32 bytes")
        );
    }

    #[tokio::test]
    async fn messagepack_frame_helpers_round_trip_length_prefixed_transport() {
        let (mut writer, mut reader) = duplex(1024);

        write_msg_to(&mut writer, &ServerToClientMsg::Pong { seq: 7 })
            .await
            .unwrap();
        drop(writer);

        let decoded: ServerToClientMsg = read_msg_from(&mut reader).await.unwrap();

        assert_eq!(decoded, ServerToClientMsg::Pong { seq: 7 });
    }

    #[tokio::test]
    async fn revoked_device_stops_attached_forwarder_without_another_request() {
        let session_id = SessionId::new();
        let (events, rx) = broadcast::channel(8);
        let (_shutdown_tx, shutdown_rx) = watch::channel(false);
        let (revocation_tx, revocation_rx) = watch::channel(0_u64);
        let (mut reader, writer) = duplex(4096);
        let writer = Arc::new(TokioMutex::new(writer));
        let forwarder = tokio::spawn(forward_attached_events(
            Arc::clone(&writer),
            rx,
            session_id,
            0,
            shutdown_rx,
            revocation_rx,
        ));

        events
            .send(ServerToClientMsg::Output {
                session_id,
                seq: 1,
                bytes: b"before revoke".to_vec(),
            })
            .unwrap();
        let before: ServerToClientMsg = read_msg_from(&mut reader).await.unwrap();
        assert!(matches!(before, ServerToClientMsg::Output { seq: 1, .. }));

        revocation_tx.send(1).unwrap();
        timeout(Duration::from_secs(1), forwarder)
            .await
            .expect("revocation should stop the iroh attach forwarder")
            .expect("forwarder should not panic");
        let _ = events.send(ServerToClientMsg::Output {
            session_id,
            seq: 2,
            bytes: b"after revoke".to_vec(),
        });

        let read_after = timeout(
            Duration::from_millis(100),
            read_msg_from::<ServerToClientMsg, _>(&mut reader),
        )
        .await;
        assert!(!matches!(
            read_after,
            Ok(Ok(ServerToClientMsg::Output { seq: 2, .. }))
        ));
    }

    #[tokio::test]
    async fn messagepack_frame_reader_rejects_oversized_length_before_allocating() {
        let (mut writer, mut reader) = duplex(16);
        writer
            .write_all(&((max_frame_len() as u32 + 1).to_be_bytes()))
            .await
            .unwrap();
        drop(writer);

        let error = read_msg_from::<ServerToClientMsg, _>(&mut reader)
            .await
            .unwrap_err();

        assert!(error.to_string().contains("frame too large"));
    }

    #[tokio::test]
    async fn messagepack_frame_reader_rejects_incomplete_payload() {
        let (mut writer, mut reader) = duplex(16);
        writer.write_all(&8_u32.to_be_bytes()).await.unwrap();
        writer.write_all(&[0]).await.unwrap();
        drop(writer);

        let error = read_msg_from::<ServerToClientMsg, _>(&mut reader)
            .await
            .unwrap_err();

        assert!(format!("{error:#}").contains("read iroh frame payload"));
    }
}
