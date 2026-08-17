use crate::SERVICE;
use crate::forward::{ForwardedEvent, output_was_replayed, recv_attached_event};
use crate::ipc::{
    AppState, DeviceRevocationWatcher, IrohEndpointInfo, create_session_for, invalid_client_size,
    kill_session_response,
};
use crate::persistence::StoredDevice;
use crate::session::AttachedClient;
use anyhow::{Context, Result, bail};
use base64::{Engine as _, engine::general_purpose::STANDARD_NO_PAD};
use iroh::endpoint::presets;
use iroh::{Endpoint, RelayMode, RelayUrl, SecretKey};
use serde::{Serialize, de::DeserializeOwned};
use shelly_protocol::{
    CONTRACT_VERSION, ClientId, ClientKind, ClientToServerMsg, ErrorCode,
    MIN_PAIRED_CONTRACT_VERSION, MessagePackDecodeError, MessagePackFraming, ReadFrameError,
    ServerToClientMsg, SessionId, WriteFrameError, normalize_code, pairing_sas, read_framed,
    write_framed,
};
use std::sync::Arc;
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt};
use tokio::sync::{Mutex, OwnedSemaphorePermit, Semaphore, broadcast, watch};
use tokio::time::{Duration, timeout};
use tracing::{debug, error, info, warn};

pub(crate) const SHELLY_ALPN: &[u8] = b"shelly/1";

const IROH_SECRET_ACCOUNT: &str = "iroh-secret-key-v1";
const IROH_SECRET_KEY_ENV: &str = "SHELLY_IROH_SECRET_KEY_B64";
const HELLO_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_UNAUTHENTICATED_CONNECTIONS: usize = 32;

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

    let unauthenticated_connections = Arc::new(Semaphore::new(MAX_UNAUTHENTICATED_CONNECTIONS));
    while let Some(incoming) = endpoint.accept().await {
        let permit = match Arc::clone(&unauthenticated_connections).try_acquire_owned() {
            Ok(permit) => permit,
            Err(_) => {
                warn!(
                    limit = MAX_UNAUTHENTICATED_CONNECTIONS,
                    "dropping iroh connection because the unauthenticated connection limit is full"
                );
                continue;
            }
        };
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
                    let remote_node_id = conn.remote_id().to_string();
                    let (send, recv) = match conn.accept_bi().await {
                        Ok(streams) => streams,
                        Err(error) => {
                            debug!(%error, "failed to accept iroh bidirectional stream");
                            return;
                        }
                    };
                    if let Err(error) =
                        handle_connection(state, remote_node_id, recv, send, Some(permit)).await
                    {
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

async fn handle_connection<R, W>(
    state: Arc<AppState>,
    remote_node_id: String,
    mut recv: R,
    send: W,
    mut unauthenticated_permit: Option<OwnedSemaphorePermit>,
) -> Result<()>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin + Send + 'static,
{
    let writer = Arc::new(Mutex::new(send));
    let mut attach_task: Option<ForwarderTask> = None;
    let mut attached_client: Option<AttachedClient> = None;
    let mut session_list_task: Option<ForwarderTask> = None;

    let hello: ClientToServerMsg = timeout(HELLO_TIMEOUT, read_msg_from(&mut recv))
        .await
        .context("timed out waiting for iroh Hello")??;
    let initially_paired = state.is_device_paired(&remote_node_id);
    let (client_id, client_kind, protocol_version) = match hello {
        ClientToServerMsg::Hello {
            client_kind,
            protocol_version,
            ..
        } if iroh_version_is_accepted(protocol_version, initially_paired) => {
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
            (client_id, client_kind, protocol_version)
        }
        ClientToServerMsg::Hello {
            protocol_version, ..
        } => {
            write_msg(
                &writer,
                &ServerToClientMsg::Error {
                    code: ErrorCode::VersionMismatch,
                    message: format!(
                        "protocol version {protocol_version} cannot start this connection; update required (daemon={CONTRACT_VERSION})"
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

    let mut paired = initially_paired;
    let mut revocation = paired.then(|| state.subscribe_device_revocation(&remote_node_id));
    if paired {
        drop(unauthenticated_permit.take());
    }
    if paired && let Err(error) = state.mark_device_seen(&remote_node_id) {
        warn!(%error, %remote_node_id, "failed to persist device last_seen");
    }
    if paired && !state.is_device_paired(&remote_node_id) {
        return Ok(());
    }

    let result: Result<()> = async {
        loop {
            let message = tokio::select! {
                message = read_msg_from::<ClientToServerMsg, _>(&mut recv) => match message {
                    Ok(message) => message,
                    Err(_) => break,
                },
                _ = wait_for_revocation(&mut revocation), if paired => break,
            };
            if paired && !state.is_device_paired(&remote_node_id) {
                break;
            }
            match message {
                ClientToServerMsg::Hello { .. } => {
                    // Retrying clients may replay Hello after the handshake, so keep it idempotent.
                    if !require_paired(&writer, paired).await? {
                        continue;
                    }
                }
                ClientToServerMsg::PairWithCode {
                    code,
                    device_name,
                    device_node_id,
                } => {
                    if protocol_version < CONTRACT_VERSION {
                        write_update_required(&writer, "new pairing requires protocol v5").await?;
                        continue;
                    }
                    if let Some(error) =
                        pairing_peer_identity_error(&remote_node_id, &device_node_id)
                    {
                        write_msg(&writer, &error).await?;
                        continue;
                    }

                    let code = normalize_code(&code);
                    let sas = match authenticated_pairing_sas(&state, &code, &remote_node_id) {
                        Ok(sas) => sas,
                        Err(error) => {
                            write_msg(
                                &writer,
                                &ServerToClientMsg::Error {
                                    code: ErrorCode::InvalidRequest,
                                    message: error.to_string(),
                                },
                            )
                            .await?;
                            continue;
                        }
                    };
                    match state.pairing.begin_approval(
                        &code,
                        device_name.clone(),
                        remote_node_id.clone(),
                        sas.clone(),
                    ) {
                        Ok(approval) => {
                            write_msg(&writer, &ServerToClientMsg::PairingPending { sas }).await?;
                            if !approval.wait().await {
                                write_forbidden(&writer, "pairing denied on laptop").await?;
                                continue;
                            }
                            state.save_device(StoredDevice::new(
                                device_name,
                                remote_node_id.clone(),
                            ))?;
                            paired = true;
                            revocation = Some(state.subscribe_device_revocation(&remote_node_id));
                            revocation
                                .as_mut()
                                .expect("paired device revocation watcher")
                                .mark_current_seen();
                            drop(unauthenticated_permit.take());
                            let daemon_node_id = state.iroh_node_id().unwrap_or_default();
                            write_msg(
                                &writer,
                                &ServerToClientMsg::PairingComplete { daemon_node_id },
                            )
                            .await?;
                        }
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
                ClientToServerMsg::UnpairSelf => {
                    if protocol_version < CONTRACT_VERSION {
                        write_update_required(&writer, "UnpairSelf requires protocol v5").await?;
                        continue;
                    }
                    match state.unpair_self(&remote_node_id) {
                        Ok(_) => {
                            paired = false;
                            revocation = None;
                            write_msg(&writer, &ServerToClientMsg::Pong { seq: 0 }).await?;
                        }
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
                        task.shutdown().await;
                    }
                    let (sessions, rx) = state.subscribe_session_list_with_initial();
                    write_msg(&writer, &ServerToClientMsg::SessionList { sessions }).await?;

                    let writer = Arc::clone(&writer);
                    let revocation = revocation_watcher(&revocation);
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
                    if let Some(error) = invalid_client_size(size) {
                        write_msg(&writer, &error).await?;
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
                        task.shutdown().await;
                    }
                    drop(attached_client.take());
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
                    let revocation = revocation_watcher(&revocation);
                    attached_client = Some(attachment);
                    attach_task = Some(ForwarderTask::spawn(move |shutdown| async move {
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
                    if let Some(error) = invalid_client_size(size) {
                        write_msg(&writer, &error).await?;
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
                ClientToServerMsg::DetachSession => {
                    if !require_paired(&writer, paired).await? {
                        continue;
                    }
                    break;
                }
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
                    if let Some(error) = invalid_client_size(size) {
                        write_msg(&writer, &error).await?;
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
                    if !require_paired(&writer, paired).await? {
                        continue;
                    }
                    write_forbidden(&writer, forbidden_iroh_operation_message(client_kind)).await?;
                }
            }
        }
        Ok(())
    }
    .await;

    if let Some(task) = attach_task {
        task.shutdown().await;
    }
    drop(attached_client);
    if let Some(task) = session_list_task {
        task.shutdown().await;
    }

    result
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

    async fn shutdown(mut self) {
        let _ = self.shutdown.send(true);
        if timeout(Duration::from_secs(1), &mut self.handle)
            .await
            .is_err()
        {
            self.handle.abort();
            let _ = (&mut self.handle).await;
        }
    }
}

impl Drop for ForwarderTask {
    fn drop(&mut self) {
        self.handle.abort();
    }
}

async fn forward_session_list_updates<W>(
    writer: Arc<Mutex<W>>,
    mut rx: watch::Receiver<Vec<shelly_protocol::SessionSummary>>,
    mut shutdown: watch::Receiver<bool>,
    mut revocation: DeviceRevocationWatcher,
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
    mut revocation: DeviceRevocationWatcher,
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

async fn wait_for_revocation(revocation: &mut Option<DeviceRevocationWatcher>) {
    if let Some(revocation) = revocation {
        let _ = revocation.changed().await;
    } else {
        std::future::pending::<()>().await;
    }
}

fn revocation_watcher(revocation: &Option<DeviceRevocationWatcher>) -> DeviceRevocationWatcher {
    revocation
        .as_ref()
        .expect("paired connection has a revocation watcher")
        .clone()
}

fn iroh_version_is_accepted(protocol_version: u32, already_paired: bool) -> bool {
    protocol_version == CONTRACT_VERSION
        || (already_paired && protocol_version == MIN_PAIRED_CONTRACT_VERSION)
}

fn authenticated_pairing_sas(
    state: &AppState,
    normalized_code: &str,
    remote_node_id: &str,
) -> Result<String> {
    let daemon_node_id = state
        .iroh_node_id()
        .context("daemon iroh endpoint is not ready")?;
    let daemon_key: iroh::PublicKey = daemon_node_id
        .parse()
        .context("daemon iroh node id is invalid")?;
    let phone_key: iroh::PublicKey = remote_node_id
        .parse()
        .context("authenticated phone iroh node id is invalid")?;
    Ok(pairing_sas(
        normalized_code,
        daemon_key.as_bytes(),
        phone_key.as_bytes(),
    ))
}

async fn require_paired<W>(writer: &Arc<Mutex<W>>, paired: bool) -> Result<bool>
where
    W: AsyncWrite + Unpin,
{
    if paired {
        return Ok(true);
    }

    write_unauthorized(writer).await?;
    Ok(false)
}

async fn write_unauthorized<W>(writer: &Arc<Mutex<W>>) -> Result<()>
where
    W: AsyncWrite + Unpin,
{
    write_msg(
        writer,
        &ServerToClientMsg::Error {
            code: ErrorCode::Unauthorized,
            message: "device is not paired".to_string(),
        },
    )
    .await
}

async fn write_update_required<W>(writer: &Arc<Mutex<W>>, message: &str) -> Result<()>
where
    W: AsyncWrite + Unpin,
{
    write_msg(
        writer,
        &ServerToClientMsg::Error {
            code: ErrorCode::VersionMismatch,
            message: format!("{message}; update Shelly"),
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

async fn write_forbidden<W>(writer: &Arc<Mutex<W>>, message: &str) -> Result<()>
where
    W: AsyncWrite + Unpin,
{
    write_msg(
        writer,
        &ServerToClientMsg::Error {
            code: ErrorCode::Forbidden,
            message: message.to_string(),
        },
    )
    .await
}

async fn write_session_not_found<W>(writer: &Arc<Mutex<W>>, session_id: SessionId) -> Result<()>
where
    W: AsyncWrite + Unpin,
{
    write_msg(
        writer,
        &ServerToClientMsg::Error {
            code: ErrorCode::NotFound,
            message: format!("session not found: {session_id}"),
        },
    )
    .await
}

async fn finish_writer<W>(writer: &Arc<Mutex<W>>) -> Result<()>
where
    W: AsyncWrite + Unpin,
{
    let mut writer = writer.lock().await;
    timeout(Duration::from_secs(1), writer.shutdown())
        .await
        .context("time out finishing iroh stream")??;
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

async fn read_msg_from<T, R>(reader: &mut R) -> Result<T>
where
    T: DeserializeOwned,
    R: AsyncRead + Unpin,
{
    match read_framed::<MessagePackFraming, _, _>(reader).await {
        Ok(message) => Ok(message),
        Err(ReadFrameError::ReadLength(error)) => Err(error).context("read iroh frame length"),
        Err(ReadFrameError::TooLarge(len)) => bail!("frame too large: {len}"),
        Err(ReadFrameError::ReadPayload(error)) => Err(error).context("read iroh frame payload"),
        Err(ReadFrameError::Decode(MessagePackDecodeError::Decode(error))) => {
            Err(error).context("decode messagepack frame")
        }
        Err(ReadFrameError::Decode(MessagePackDecodeError::TrailingBytes(len))) => {
            bail!("trailing bytes after messagepack payload: {len}")
        }
    }
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
    match write_framed::<MessagePackFraming, _, _>(writer, message).await {
        Ok(()) => {}
        Err(WriteFrameError::Encode(error)) => {
            return Err(error).context("encode messagepack frame");
        }
        Err(WriteFrameError::TooLarge(len)) => bail!("frame too large: {len}"),
        Err(WriteFrameError::WriteLength(error)) => {
            return Err(error).context("write iroh frame length");
        }
        Err(WriteFrameError::WritePayload(error)) => {
            return Err(error).context("write iroh frame payload");
        }
    }
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
        IROH_SECRET_KEY_ENV, forward_attached_events, handle_connection, read_msg_from,
        secret_key_from_env, write_msg_to,
    };
    use crate::ipc::{AppState, IrohEndpointInfo};
    use crate::persistence::StoredDevice;
    use base64::{Engine as _, engine::general_purpose::STANDARD_NO_PAD};
    use shelly_protocol::{
        AgentSource, AgentState, CONTRACT_VERSION, ClientId, ClientKind, ClientSize,
        ClientToServerMsg, ErrorCode, PushPlatform, ServerToClientMsg, SessionId,
        encode_messagepack, max_frame_len, pairing_sas,
    };
    use std::collections::HashMap;
    use std::ffi::OsString;
    use std::path::PathBuf;
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
        let state = AppState::for_tests();
        state
            .save_device(StoredDevice::new(
                "phone".to_string(),
                "revoked-node".to_string(),
            ))
            .unwrap();
        let revocation = state.subscribe_device_revocation("revoked-node");
        let (mut reader, writer) = duplex(4096);
        let writer = Arc::new(TokioMutex::new(writer));
        let forwarder = tokio::spawn(forward_attached_events(
            Arc::clone(&writer),
            rx,
            session_id,
            0,
            shutdown_rx,
            revocation,
        ));

        events
            .send(ServerToClientMsg::Output {
                session_id,
                seq: 1,
                bytes: b"before revoke".as_slice().into(),
            })
            .unwrap();
        let before: ServerToClientMsg = read_msg_from(&mut reader).await.unwrap();
        assert!(matches!(before, ServerToClientMsg::Output { seq: 1, .. }));

        state.remove_device("revoked-node").unwrap();
        timeout(Duration::from_secs(1), forwarder)
            .await
            .expect("revocation should stop the iroh attach forwarder")
            .expect("forwarder should not panic");
        let _ = events.send(ServerToClientMsg::Output {
            session_id,
            seq: 2,
            bytes: b"after revoke".as_slice().into(),
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

    #[tokio::test]
    async fn messagepack_frame_reader_rejects_trailing_payload_bytes() {
        let mut payload = encode_messagepack(&ServerToClientMsg::Pong { seq: 7 }).unwrap();
        payload.push(0xc0);
        let (mut writer, mut reader) = duplex(1024);
        writer
            .write_all(&(payload.len() as u32).to_be_bytes())
            .await
            .unwrap();
        writer.write_all(&payload).await.unwrap();
        drop(writer);

        let error = read_msg_from::<ServerToClientMsg, _>(&mut reader)
            .await
            .unwrap_err();

        assert!(
            error
                .to_string()
                .contains("trailing bytes after messagepack payload")
        );
    }

    #[tokio::test]
    async fn every_unpaired_message_variant_is_unauthorized() {
        let session_id = SessionId::new();
        let request_id = ClientId::new();
        let size = ClientSize { rows: 24, cols: 80 };
        let messages = vec![
            (
                "Hello",
                ClientToServerMsg::Hello {
                    client_kind: ClientKind::AndroidApp,
                    client_version: "retry".to_string(),
                    protocol_version: CONTRACT_VERSION,
                },
            ),
            ("ListSessions", ClientToServerMsg::ListSessions),
            (
                "CreateSession",
                ClientToServerMsg::CreateSession {
                    name: "blocked".to_string(),
                    command: vec!["/bin/false".to_string()],
                    cwd: PathBuf::from("/tmp"),
                    env: HashMap::new(),
                    size,
                },
            ),
            (
                "AttachSession",
                ClientToServerMsg::AttachSession {
                    session_id,
                    size,
                    last_seen_seq: None,
                },
            ),
            ("DetachSession", ClientToServerMsg::DetachSession),
            ("KillSession", ClientToServerMsg::KillSession { session_id }),
            (
                "Input",
                ClientToServerMsg::Input {
                    session_id,
                    bytes: b"blocked".to_vec(),
                },
            ),
            ("Resize", ClientToServerMsg::Resize { session_id, size }),
            ("Ping", ClientToServerMsg::Ping { seq: 7 }),
            (
                "BeginPairing",
                ClientToServerMsg::BeginPairing { device_name: None },
            ),
            (
                "ApprovePairing",
                ClientToServerMsg::ApprovePairing {
                    request_id,
                    approved: true,
                },
            ),
            (
                "PairWithCode",
                ClientToServerMsg::PairWithCode {
                    code: "WRONG".to_string(),
                    device_name: "phone".to_string(),
                    // A matching identity is the sole bootstrap exception; this mismatched
                    // claim proves the variant cannot bypass authenticated peer identity.
                    device_node_id: "claimed-other-node".to_string(),
                },
            ),
            ("ListDevices", ClientToServerMsg::ListDevices),
            (
                "RemoveDevice",
                ClientToServerMsg::RemoveDevice {
                    name: "blocked".to_string(),
                },
            ),
            (
                "RegisterPushToken",
                ClientToServerMsg::RegisterPushToken {
                    platform: PushPlatform::Fcm,
                    token: "blocked".to_string(),
                },
            ),
            (
                "AgentStateEvent",
                ClientToServerMsg::AgentStateEvent {
                    session_id,
                    source: AgentSource::Codex,
                    state: AgentState::Working,
                    last_line: None,
                },
            ),
            ("SubscribeSessions", ClientToServerMsg::SubscribeSessions),
            (
                "UnregisterPushToken",
                ClientToServerMsg::UnregisterPushToken {
                    platform: PushPlatform::Fcm,
                    token: "blocked".to_string(),
                },
            ),
        ];

        for (variant, message) in messages {
            let response = send_request(AppState::for_tests(), "unpaired-node", message).await;
            assert_error_code(response, ErrorCode::Unauthorized, variant);
        }
    }

    #[tokio::test]
    async fn paired_mobile_forbidden_variants_remain_forbidden() {
        let session_id = SessionId::new();
        let messages = vec![
            (
                "BeginPairing",
                ClientToServerMsg::BeginPairing { device_name: None },
            ),
            (
                "ApprovePairing",
                ClientToServerMsg::ApprovePairing {
                    request_id: ClientId::new(),
                    approved: true,
                },
            ),
            ("ListDevices", ClientToServerMsg::ListDevices),
            (
                "RemoveDevice",
                ClientToServerMsg::RemoveDevice {
                    name: "phone".to_string(),
                },
            ),
            (
                "AgentStateEvent",
                ClientToServerMsg::AgentStateEvent {
                    session_id,
                    source: AgentSource::Claude,
                    state: AgentState::Idle,
                    last_line: None,
                },
            ),
        ];

        for (variant, message) in messages {
            let state = AppState::for_tests();
            state
                .save_device(StoredDevice::new(
                    "phone".to_string(),
                    "paired-node".to_string(),
                ))
                .unwrap();
            let response = send_request(state, "paired-node", message).await;
            assert_error_code(response, ErrorCode::Forbidden, variant);
        }
    }

    #[tokio::test]
    async fn paired_iroh_rejects_invalid_size_for_every_size_bearing_message() {
        let session_id = SessionId::new();
        let messages = vec![
            (
                "CreateSession",
                ClientToServerMsg::CreateSession {
                    name: "invalid".to_string(),
                    command: Vec::new(),
                    cwd: PathBuf::from("/tmp"),
                    env: HashMap::new(),
                    size: ClientSize { rows: 0, cols: 80 },
                },
            ),
            (
                "AttachSession",
                ClientToServerMsg::AttachSession {
                    session_id,
                    size: ClientSize {
                        rows: 24,
                        cols: 1_001,
                    },
                    last_seen_seq: None,
                },
            ),
            (
                "Resize",
                ClientToServerMsg::Resize {
                    session_id,
                    size: ClientSize {
                        rows: 1_001,
                        cols: 80,
                    },
                },
            ),
        ];

        for (variant, message) in messages {
            let state = AppState::for_tests();
            state
                .save_device(StoredDevice::new(
                    "phone".to_string(),
                    "paired-node".to_string(),
                ))
                .unwrap();
            let response = send_request(state, "paired-node", message).await;
            assert_error_code(response, ErrorCode::InvalidRequest, variant);
        }
    }

    #[tokio::test]
    async fn rogue_relay_self_pairing_exposes_a_different_sas_and_cannot_complete() {
        let daemon_key = iroh::SecretKey::from_bytes(&[3; 32]);
        let real_phone_key = iroh::SecretKey::from_bytes(&[4; 32]);
        let rogue_key = iroh::SecretKey::from_bytes(&[5; 32]);
        let state = AppState::for_tests();
        state.set_iroh_endpoint(IrohEndpointInfo {
            node_id: daemon_key.public().to_string(),
            relay_url: None,
            addrs: Vec::new(),
        });
        let (code, _, mut desktop_events) = state.pairing.begin_pairing().unwrap();

        let (client, server) = duplex(64 * 1024);
        let (server_reader, server_writer) = tokio::io::split(server);
        let remote_node_id = rogue_key.public().to_string();
        let server_task = tokio::spawn(handle_connection(
            Arc::clone(&state),
            remote_node_id.clone(),
            server_reader,
            server_writer,
            None,
        ));
        let (mut client_reader, mut client_writer) = tokio::io::split(client);
        write_msg_to(
            &mut client_writer,
            &ClientToServerMsg::Hello {
                client_kind: ClientKind::AndroidApp,
                client_version: "rogue-relay".to_string(),
                protocol_version: CONTRACT_VERSION,
            },
        )
        .await
        .unwrap();
        assert!(matches!(
            read_msg_from::<ServerToClientMsg, _>(&mut client_reader)
                .await
                .unwrap(),
            ServerToClientMsg::Welcome { .. }
        ));
        write_msg_to(
            &mut client_writer,
            &ClientToServerMsg::PairWithCode {
                code: code.clone(),
                device_name: "relay impostor".to_string(),
                device_node_id: remote_node_id.clone(),
            },
        )
        .await
        .unwrap();

        let desktop_event = desktop_events.recv().await.expect("desktop SAS event");
        let phone_pending: ServerToClientMsg = read_msg_from(&mut client_reader).await.unwrap();
        let ServerToClientMsg::PairingPending { sas: phone_sas } = phone_pending else {
            panic!("expected PairingPending, got {phone_pending:?}");
        };
        let expected_real_phone_sas = pairing_sas(
            &code,
            daemon_key.public().as_bytes(),
            real_phone_key.public().as_bytes(),
        );
        assert_eq!(desktop_event.sas, phone_sas);
        assert_ne!(desktop_event.sas, expected_real_phone_sas);

        // The real desktop has no matching phone display, so it rejects. The
        // daemon must not persist the relay's authenticated identity or finish.
        state
            .pairing
            .approve(desktop_event.request_id, false)
            .unwrap();
        let denied: ServerToClientMsg = read_msg_from(&mut client_reader).await.unwrap();
        assert_error_code(denied, ErrorCode::Forbidden, "rogue pairing");
        assert!(!state.is_device_paired(&remote_node_id));

        drop(client_writer);
        drop(client_reader);
        timeout(Duration::from_secs(2), server_task)
            .await
            .expect("iroh handler did not stop")
            .expect("iroh handler panicked")
            .expect("iroh handler failed");
    }

    #[tokio::test]
    async fn version_negotiation_keeps_v4_paired_sessions_but_requires_v5_for_pairing() {
        let paired_key = iroh::SecretKey::from_bytes(&[6; 32]);
        let paired_node_id = paired_key.public().to_string();
        let state = AppState::for_tests();
        state
            .save_device(StoredDevice::new(
                "existing phone".to_string(),
                paired_node_id.clone(),
            ))
            .unwrap();
        let session_id = match crate::ipc::create_session_for(
            &state,
            ClientKind::LocalCli,
            "v4-existing-session".to_string(),
            vec!["/bin/cat".to_string()],
            std::env::current_dir().unwrap(),
            HashMap::new(),
            ClientSize { rows: 24, cols: 80 },
        ) {
            ServerToClientMsg::SessionCreated { session_id, .. } => session_id,
            other => panic!("failed to create v4 fixture session: {other:?}"),
        };

        let (client, server) = duplex(64 * 1024);
        let (server_reader, server_writer) = tokio::io::split(server);
        let server_task = tokio::spawn(handle_connection(
            Arc::clone(&state),
            paired_node_id.clone(),
            server_reader,
            server_writer,
            None,
        ));
        let (mut client_reader, mut client_writer) = tokio::io::split(client);
        write_msg_to(
            &mut client_writer,
            &ClientToServerMsg::Hello {
                client_kind: ClientKind::AndroidApp,
                client_version: "released-v4".to_string(),
                protocol_version: 4,
            },
        )
        .await
        .unwrap();
        assert!(matches!(
            read_msg_from::<ServerToClientMsg, _>(&mut client_reader)
                .await
                .unwrap(),
            ServerToClientMsg::Welcome { .. }
        ));
        write_msg_to(&mut client_writer, &ClientToServerMsg::ListSessions)
            .await
            .unwrap();
        assert!(matches!(
            read_msg_from::<ServerToClientMsg, _>(&mut client_reader)
                .await
                .unwrap(),
            ServerToClientMsg::SessionList { .. }
        ));
        write_msg_to(
            &mut client_writer,
            &ClientToServerMsg::AttachSession {
                session_id,
                size: ClientSize { rows: 24, cols: 80 },
                last_seen_seq: None,
            },
        )
        .await
        .unwrap();
        assert!(matches!(
            read_msg_from::<ServerToClientMsg, _>(&mut client_reader)
                .await
                .unwrap(),
            ServerToClientMsg::Attached {
                session_id: attached,
                ..
            } if attached == session_id
        ));
        write_msg_to(
            &mut client_writer,
            &ClientToServerMsg::Resize {
                session_id,
                size: ClientSize {
                    rows: 30,
                    cols: 100,
                },
            },
        )
        .await
        .unwrap();
        write_msg_to(
            &mut client_writer,
            &ClientToServerMsg::Input {
                session_id,
                bytes: b"v4-input\n".to_vec(),
            },
        )
        .await
        .unwrap();
        timeout(Duration::from_secs(2), async {
            loop {
                if let ServerToClientMsg::Output {
                    session_id: output_session,
                    bytes,
                    ..
                } = read_msg_from::<ServerToClientMsg, _>(&mut client_reader)
                    .await
                    .unwrap()
                    && output_session == session_id
                    && bytes
                        .windows(b"v4-input".len())
                        .any(|window| window == b"v4-input")
                {
                    break;
                }
            }
        })
        .await
        .expect("v4 input should reach the existing attached session");
        write_msg_to(
            &mut client_writer,
            &ClientToServerMsg::PairWithCode {
                code: "A1B2C3D".to_string(),
                device_name: "replacement".to_string(),
                device_node_id: paired_node_id,
            },
        )
        .await
        .unwrap();
        let pairing_rejected = timeout(Duration::from_secs(2), async {
            loop {
                let message: ServerToClientMsg = read_msg_from(&mut client_reader).await.unwrap();
                if matches!(message, ServerToClientMsg::Error { .. }) {
                    break message;
                }
            }
        })
        .await
        .expect("v4 pairing rejection should not be hidden by session output");
        assert_error_code(
            pairing_rejected,
            ErrorCode::VersionMismatch,
            "v4 new pairing",
        );
        write_msg_to(&mut client_writer, &ClientToServerMsg::UnpairSelf)
            .await
            .unwrap();
        let unpair_rejected = timeout(Duration::from_secs(2), async {
            loop {
                let message: ServerToClientMsg = read_msg_from(&mut client_reader).await.unwrap();
                if matches!(message, ServerToClientMsg::Error { .. }) {
                    break message;
                }
            }
        })
        .await
        .expect("v4 UnpairSelf rejection should arrive");
        assert_error_code(unpair_rejected, ErrorCode::VersionMismatch, "v4 UnpairSelf");
        assert!(state.is_device_paired(&paired_key.public().to_string()));
        write_msg_to(&mut client_writer, &ClientToServerMsg::DetachSession)
            .await
            .unwrap();
        drop(client_writer);
        drop(client_reader);
        timeout(Duration::from_secs(2), server_task)
            .await
            .expect("v4 paired handler did not stop")
            .expect("v4 paired handler panicked")
            .expect("v4 paired handler failed");
        assert!(matches!(
            crate::ipc::kill_session_response(&state, session_id),
            ServerToClientMsg::SessionKilled { .. }
        ));

        let unpaired_key = iroh::SecretKey::from_bytes(&[7; 32]);
        let response =
            send_hello(AppState::for_tests(), &unpaired_key.public().to_string(), 4).await;
        assert_error_code(response, ErrorCode::VersionMismatch, "v4 unpaired Hello");
        let response = send_hello(
            AppState::for_tests(),
            &unpaired_key.public().to_string(),
            CONTRACT_VERSION,
        )
        .await;
        assert!(matches!(response, ServerToClientMsg::Welcome { .. }));
    }

    #[tokio::test]
    async fn unpair_self_is_exact_and_idempotent() {
        let caller_key = iroh::SecretKey::from_bytes(&[8; 32]);
        let other_key = iroh::SecretKey::from_bytes(&[9; 32]);
        let caller_node_id = caller_key.public().to_string();
        let other_node_id = other_key.public().to_string();
        let state = AppState::for_tests();
        state
            .save_device(StoredDevice::new(
                other_node_id.clone(),
                other_node_id.clone(),
            ))
            .unwrap();
        state
            .save_device(StoredDevice::new(
                "calling phone".to_string(),
                caller_node_id.clone(),
            ))
            .unwrap();

        let (client, server) = duplex(64 * 1024);
        let (server_reader, server_writer) = tokio::io::split(server);
        let server_task = tokio::spawn(handle_connection(
            Arc::clone(&state),
            caller_node_id.clone(),
            server_reader,
            server_writer,
            None,
        ));
        let (mut client_reader, mut client_writer) = tokio::io::split(client);
        write_msg_to(
            &mut client_writer,
            &ClientToServerMsg::Hello {
                client_kind: ClientKind::AndroidApp,
                client_version: "v5".to_string(),
                protocol_version: CONTRACT_VERSION,
            },
        )
        .await
        .unwrap();
        assert!(matches!(
            read_msg_from::<ServerToClientMsg, _>(&mut client_reader)
                .await
                .unwrap(),
            ServerToClientMsg::Welcome { .. }
        ));

        for _ in 0..2 {
            write_msg_to(&mut client_writer, &ClientToServerMsg::UnpairSelf)
                .await
                .unwrap();
            assert_eq!(
                read_msg_from::<ServerToClientMsg, _>(&mut client_reader)
                    .await
                    .unwrap(),
                ServerToClientMsg::Pong { seq: 0 }
            );
        }
        assert!(!state.is_device_paired(&caller_node_id));
        assert!(state.is_device_paired(&other_node_id));

        drop(client_writer);
        drop(client_reader);
        timeout(Duration::from_secs(2), server_task)
            .await
            .expect("unpair handler did not stop")
            .expect("unpair handler panicked")
            .expect("unpair handler failed");
    }

    async fn send_hello(
        state: Arc<AppState>,
        remote_node_id: &str,
        protocol_version: u32,
    ) -> ServerToClientMsg {
        let (client, server) = duplex(64 * 1024);
        let (server_reader, server_writer) = tokio::io::split(server);
        let server_task = tokio::spawn(handle_connection(
            state,
            remote_node_id.to_string(),
            server_reader,
            server_writer,
            None,
        ));
        let (mut client_reader, mut client_writer) = tokio::io::split(client);
        write_msg_to(
            &mut client_writer,
            &ClientToServerMsg::Hello {
                client_kind: ClientKind::AndroidApp,
                client_version: "test".to_string(),
                protocol_version,
            },
        )
        .await
        .unwrap();
        let response = read_msg_from(&mut client_reader).await.unwrap();
        drop(client_writer);
        drop(client_reader);
        timeout(Duration::from_secs(2), server_task)
            .await
            .expect("iroh Hello handler did not stop")
            .expect("iroh Hello handler panicked")
            .expect("iroh Hello handler failed");
        response
    }

    async fn send_request(
        state: Arc<AppState>,
        remote_node_id: &str,
        message: ClientToServerMsg,
    ) -> ServerToClientMsg {
        let (client, server) = duplex(64 * 1024);
        let (server_reader, server_writer) = tokio::io::split(server);
        let server_task = tokio::spawn(handle_connection(
            state,
            remote_node_id.to_string(),
            server_reader,
            server_writer,
            None,
        ));
        let (mut client_reader, mut client_writer) = tokio::io::split(client);

        write_msg_to(
            &mut client_writer,
            &ClientToServerMsg::Hello {
                client_kind: ClientKind::AndroidApp,
                client_version: "test".to_string(),
                protocol_version: CONTRACT_VERSION,
            },
        )
        .await
        .unwrap();
        let welcome: ServerToClientMsg = read_msg_from(&mut client_reader).await.unwrap();
        assert!(matches!(welcome, ServerToClientMsg::Welcome { .. }));

        write_msg_to(&mut client_writer, &message).await.unwrap();
        let response = timeout(
            Duration::from_secs(2),
            read_msg_from::<ServerToClientMsg, _>(&mut client_reader),
        )
        .await
        .expect("iroh handler response timed out")
        .expect("read iroh handler response");

        drop(client_writer);
        drop(client_reader);
        timeout(Duration::from_secs(2), server_task)
            .await
            .expect("iroh handler did not stop")
            .expect("iroh handler panicked")
            .expect("iroh handler failed");
        response
    }

    fn assert_error_code(response: ServerToClientMsg, expected: ErrorCode, variant: &str) {
        match response {
            ServerToClientMsg::Error { code, .. } => assert_eq!(code, expected, "{variant}"),
            other => panic!("{variant}: expected {expected:?}, got {other:?}"),
        }
    }
}
