use crate::authz::may_create_or_kill_session;
use crate::config::Config;
use crate::forward::{ForwardedEvent, recv_attached_event};
use crate::pairing::PairingManager;
use crate::paths::{control_socket_path, prepare_control_socket, set_control_socket_permissions};
use crate::persistence::{Persistence, StoredDevice, StoredSession};
use crate::push::PushDispatcher;
use crate::session::Session;
use crate::transport_iroh;
use anyhow::{Context, Result};
use dashmap::DashMap;
use fieldwork_protocol::{
    CONTRACT_VERSION, Capabilities, ClientId, ClientKind, ClientToServerMsg, ErrorCode,
    PairingPayload, PushPlatform, ServerToClientMsg, SessionId, decode_bincode, encode_bincode,
    max_frame_len,
};
use interprocess::local_socket::traits::tokio::Listener as _;
use interprocess::local_socket::{
    GenericFilePath, ListenerOptions,
    prelude::*,
    tokio::{Listener, Stream},
};
use serde::{Serialize, de::DeserializeOwned};
use std::path::Path;
use std::sync::{Arc, Mutex as StdMutex};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::{Mutex, watch};
use tokio::time::{Duration, sleep};
use tracing::{error, info, warn};

pub struct AppState {
    pub(crate) sessions: DashMap<SessionId, Arc<Session>>,
    pub(crate) restored: DashMap<SessionId, StoredSession>,
    pub(crate) devices: Arc<DashMap<String, StoredDevice>>,
    pub(crate) persistence: Option<Arc<Persistence>>,
    pub(crate) pairing: PairingManager,
    pub(crate) push: PushDispatcher,
    session_list_tx: watch::Sender<Vec<fieldwork_protocol::SessionSummary>>,
    iroh_endpoint: StdMutex<Option<IrohEndpointInfo>>,
}

#[derive(Clone, Debug)]
pub struct IrohEndpointInfo {
    pub node_id: String,
    pub relay_url: Option<String>,
    pub addrs: Vec<String>,
}

impl AppState {
    pub fn open(config: &Config) -> Result<Self> {
        let persistence = Arc::new(
            Persistence::open_default(config.scrollback_encryption.enabled).with_context(|| {
                if config.scrollback_encryption.enabled {
                    "open encrypted daemon persistence"
                } else {
                    "open plaintext daemon persistence"
                }
            })?,
        );

        let restored = DashMap::new();
        let devices = Arc::new(DashMap::new());
        for session in persistence
            .load_sessions()
            .context("load persisted sessions")?
        {
            restored.insert(session.summary.id, session);
        }
        for device in persistence
            .load_devices()
            .context("load persisted devices")?
        {
            devices.insert(device.device_node_id.clone(), device);
        }

        if !config.scrollback_encryption.enabled {
            warn!("plaintext local persistence enabled by user setting");
        }
        info!(
            restored_sessions = restored.len(),
            paired_devices = devices.len(),
            "loaded persisted daemon state"
        );

        let (session_list_tx, _) = watch::channel(Vec::new());
        Ok(Self {
            sessions: DashMap::new(),
            restored,
            devices: Arc::clone(&devices),
            persistence: Some(persistence),
            pairing: PairingManager::new(),
            push: PushDispatcher::from_env(devices),
            session_list_tx,
            iroh_endpoint: StdMutex::new(None),
        })
    }

    pub(crate) fn capabilities(&self) -> Capabilities {
        Capabilities::v1(self.push.is_enabled())
    }

    pub(crate) fn summaries(&self) -> Vec<fieldwork_protocol::SessionSummary> {
        let mut sessions: Vec<_> = self.sessions.iter().map(|entry| entry.summary()).collect();
        sessions.extend(
            self.restored
                .iter()
                .filter(|entry| !self.sessions.contains_key(&entry.summary.id))
                .map(|entry| entry.summary.clone()),
        );
        sessions.sort_by_key(|session| session.created_at);
        sessions
    }

    pub(crate) fn subscribe_session_list(
        &self,
    ) -> watch::Receiver<Vec<fieldwork_protocol::SessionSummary>> {
        self.session_list_tx.subscribe()
    }

    pub(crate) fn publish_session_list(&self) {
        self.session_list_tx.send_replace(self.summaries());
    }

    pub(crate) fn set_iroh_endpoint(&self, info: IrohEndpointInfo) {
        self.push.set_daemon_node_id(info.node_id.clone());
        *self
            .iroh_endpoint
            .lock()
            .expect("iroh endpoint lock poisoned") = Some(info);
    }

    pub(crate) fn pairing_payload(
        &self,
        pair_token: String,
        expires_at: u64,
    ) -> Result<PairingPayload> {
        let info = self
            .iroh_endpoint
            .lock()
            .map_err(|_| anyhow::anyhow!("iroh endpoint lock poisoned"))?
            .clone()
            .context("iroh endpoint is not ready yet")?;

        Ok(PairingPayload {
            relay_url: info.relay_url,
            node_id: info.node_id,
            addrs: info.addrs,
            pair_token,
            expires_at,
        })
    }

    pub(crate) async fn wait_pairing_payload(
        &self,
        pair_token: String,
        expires_at: u64,
    ) -> Result<PairingPayload> {
        for _ in 0..100 {
            if let Ok(payload) = self.pairing_payload(pair_token.clone(), expires_at) {
                return Ok(payload);
            }
            sleep(Duration::from_millis(100)).await;
        }
        self.pairing_payload(pair_token, expires_at)
    }

    pub(crate) fn iroh_node_id(&self) -> Option<String> {
        self.iroh_endpoint
            .lock()
            .ok()
            .and_then(|info| info.as_ref().map(|info| info.node_id.clone()))
    }

    pub(crate) fn device_summaries(&self) -> Vec<fieldwork_protocol::DeviceSummary> {
        let mut devices: Vec<_> = self.devices.iter().map(|entry| entry.summary()).collect();
        devices.sort_by_key(|device| device.paired_at);
        devices
    }

    pub(crate) fn save_device(&self, device: StoredDevice) -> Result<()> {
        if let Some(persistence) = &self.persistence {
            persistence.save_device(&device)?;
        }
        self.devices.insert(device.device_node_id.clone(), device);
        Ok(())
    }

    pub(crate) fn is_device_paired(&self, device_node_id: &str) -> bool {
        self.devices.contains_key(device_node_id)
    }

    pub(crate) fn remove_device(&self, name: &str) -> Result<Option<StoredDevice>> {
        let device_node_id = self
            .devices
            .iter()
            .find(|entry| entry.name == name || entry.device_node_id == name)
            .map(|entry| entry.device_node_id.clone());
        let Some(device_node_id) = device_node_id else {
            return Ok(None);
        };

        if let Some(persistence) = &self.persistence {
            persistence.remove_device(&device_node_id)?;
        }
        let removed = self
            .devices
            .remove(&device_node_id)
            .map(|(_, device)| device);
        if let Some(device) = &removed
            && let Some(token) = &device.push_token
        {
            self.push.unregister_token(token.clone());
        }
        Ok(removed)
    }

    pub(crate) fn update_device_push(
        &self,
        device_node_id: &str,
        platform: PushPlatform,
        token: String,
    ) -> Result<bool> {
        let Some(mut device) = self.devices.get_mut(device_node_id) else {
            return Ok(false);
        };
        device.set_push_token(platform, token);
        if let Some(persistence) = &self.persistence {
            persistence.save_device(&device)?;
        }
        if let Some(token) = &device.push_token {
            self.push.register_token(platform, token.clone());
        }
        Ok(true)
    }

    pub(crate) fn mark_device_seen(&self, device_node_id: &str) -> Result<bool> {
        let Some(mut device) = self.devices.get_mut(device_node_id) else {
            return Ok(false);
        };
        device.mark_seen();
        if let Some(persistence) = &self.persistence {
            persistence.save_device(&device)?;
        }
        Ok(true)
    }
}

pub async fn serve(config: Config) -> Result<()> {
    let state = Arc::new(AppState::open(&config).context("open daemon state")?);
    let socket_path = control_socket_path();
    prepare_control_socket(&socket_path)?;

    let name = Path::new(&socket_path).to_fs_name::<GenericFilePath>()?;
    let listener: Listener = ListenerOptions::new()
        .name(name)
        .create_tokio()
        .context("bind fieldwork control socket")?;
    set_control_socket_permissions(&socket_path)?;

    {
        let state = Arc::clone(&state);
        tokio::spawn(async move {
            if let Err(error) = transport_iroh::serve(state).await {
                error!(%error, "iroh transport failed");
            }
        });
    }
    info!(path = %socket_path.display(), "fieldworkd listening");

    loop {
        let conn = listener
            .accept()
            .await
            .context("accept local IPC connection")?;
        let state = Arc::clone(&state);
        tokio::spawn(async move {
            if let Err(error) = handle_connection(state, conn).await {
                error!(%error, "client connection failed");
            }
        });
    }
}

async fn handle_connection(state: Arc<AppState>, conn: Stream) -> Result<()> {
    let (reader, writer) = tokio::io::split(conn);
    handle_client_io(state, reader, writer).await
}

async fn handle_client_io<R, W>(state: Arc<AppState>, mut reader: R, writer: W) -> Result<()>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin + Send + 'static,
{
    let writer = Arc::new(Mutex::new(writer));
    let mut attach_task: Option<tokio::task::JoinHandle<()>> = None;
    let mut session_list_task: Option<tokio::task::JoinHandle<()>> = None;

    let hello: ClientToServerMsg = read_msg(&mut reader).await?;
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
            return Ok(());
        }
    };

    while let Ok(message) = read_msg::<_, ClientToServerMsg>(&mut reader).await {
        match message {
            ClientToServerMsg::Hello { .. } => {}
            ClientToServerMsg::ListSessions => {
                write_msg(
                    &writer,
                    &ServerToClientMsg::SessionList {
                        sessions: state.summaries(),
                    },
                )
                .await?;
            }
            ClientToServerMsg::SubscribeSessions => {
                if let Some(task) = session_list_task.take() {
                    task.abort();
                }
                write_msg(
                    &writer,
                    &ServerToClientMsg::SessionList {
                        sessions: state.summaries(),
                    },
                )
                .await?;

                let mut rx = state.subscribe_session_list();
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
            ClientToServerMsg::CreateSession {
                name,
                command,
                cwd,
                env,
                size,
            } => {
                if !may_create_or_kill_session(client_kind) {
                    write_forbidden(&writer, "mobile clients cannot create sessions").await?;
                    continue;
                }

                match Session::spawn(
                    name,
                    command,
                    cwd,
                    env,
                    size,
                    state.persistence.as_ref().map(Arc::clone),
                    Some(state.push.clone()),
                ) {
                    Ok(session) => {
                        let session_id = session.id();
                        let summary = session.summary();
                        state.restored.remove(&session_id);
                        state.sessions.insert(session_id, Arc::clone(&session));
                        spawn_session_list_forwarder(Arc::clone(&state), session);
                        state.publish_session_list();
                        write_msg(
                            &writer,
                            &ServerToClientMsg::SessionCreated {
                                session_id,
                                summary,
                            },
                        )
                        .await?;
                    }
                    Err(error) => {
                        write_msg(
                            &writer,
                            &ServerToClientMsg::Error {
                                code: ErrorCode::InvalidRequest,
                                message: error.to_string(),
                            },
                        )
                        .await?;
                    }
                }
            }
            ClientToServerMsg::AttachSession {
                session_id,
                size,
                last_seen_seq,
                ..
            } => {
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

                let mut rx = session.subscribe();
                let writer = Arc::clone(&writer);
                attach_task = Some(tokio::spawn(async move {
                    let _attachment = attachment;
                    loop {
                        match recv_attached_event(&mut rx, session_id).await {
                            ForwardedEvent::Message(event) => {
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
            ClientToServerMsg::DetachSession => break,
            ClientToServerMsg::KillSession { session_id } => {
                if !may_create_or_kill_session(client_kind) {
                    write_forbidden(&writer, "mobile clients cannot kill sessions").await?;
                    continue;
                }
                if let Some((_, session)) = state.sessions.remove(&session_id) {
                    let _ = session.kill();
                }
                state.restored.remove(&session_id);
                if let Some(persistence) = &state.persistence
                    && let Err(error) = persistence.remove_session(session_id)
                {
                    warn!(%error, %session_id, "failed to remove persisted session");
                }
                state.publish_session_list();
            }
            ClientToServerMsg::Input { session_id, bytes } => {
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
            ClientToServerMsg::Ping { seq } => {
                write_msg(&writer, &ServerToClientMsg::Pong { seq }).await?;
            }
            ClientToServerMsg::BeginPairing { .. } => {
                if client_kind != ClientKind::LocalCli {
                    write_forbidden(&writer, "mobile clients cannot create pair tokens").await?;
                    continue;
                }

                let (pair_token, expires_at, mut request_rx) = match state.pairing.begin_pairing() {
                    Ok(pairing) => pairing,
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
                let payload = match state.wait_pairing_payload(pair_token, expires_at).await {
                    Ok(payload) => payload,
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
                write_msg(&writer, &ServerToClientMsg::PairingStarted { payload }).await?;

                let writer = Arc::clone(&writer);
                tokio::spawn(async move {
                    while let Some(event) = request_rx.recv().await {
                        let message = ServerToClientMsg::PairingApprovalRequested {
                            request_id: event.request_id,
                            device_name: event.device_name,
                            device_node_id: event.device_node_id,
                        };
                        if write_msg(&writer, &message).await.is_err() {
                            break;
                        }
                    }
                });
            }
            ClientToServerMsg::ApprovePairing {
                request_id,
                approved,
            } => {
                if client_kind != ClientKind::LocalCli {
                    write_forbidden(&writer, "mobile clients cannot approve pairing").await?;
                    continue;
                }
                if let Err(error) = state.pairing.approve(request_id, approved) {
                    write_msg(
                        &writer,
                        &ServerToClientMsg::Error {
                            code: ErrorCode::NotFound,
                            message: error.to_string(),
                        },
                    )
                    .await?;
                }
            }
            ClientToServerMsg::PairWithToken {
                pair_token,
                device_name,
                device_node_id,
            } => {
                match state
                    .pairing
                    .request_approval(&pair_token, device_name.clone(), device_node_id.clone())
                    .await
                {
                    Ok(true) => {
                        let device = StoredDevice::new(device_name, device_node_id);
                        if let Err(error) = state.save_device(device) {
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
                        let daemon_node_id = state.iroh_node_id().unwrap_or_default();
                        write_msg(
                            &writer,
                            &ServerToClientMsg::PairingComplete { daemon_node_id },
                        )
                        .await?;
                    }
                    Ok(false) => {
                        write_forbidden(&writer, "pairing denied").await?;
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
            ClientToServerMsg::ListDevices => {
                if client_kind != ClientKind::LocalCli {
                    write_forbidden(&writer, "mobile clients cannot list devices").await?;
                    continue;
                }
                write_msg(
                    &writer,
                    &ServerToClientMsg::DeviceList {
                        devices: state.device_summaries(),
                    },
                )
                .await?;
            }
            ClientToServerMsg::RemoveDevice { name } => {
                if client_kind != ClientKind::LocalCli {
                    write_forbidden(&writer, "mobile clients cannot remove devices").await?;
                    continue;
                }
                match state.remove_device(&name) {
                    Ok(Some(_)) => {
                        write_msg(
                            &writer,
                            &ServerToClientMsg::DeviceList {
                                devices: state.device_summaries(),
                            },
                        )
                        .await?;
                    }
                    Ok(None) => {
                        write_msg(
                            &writer,
                            &ServerToClientMsg::Error {
                                code: ErrorCode::NotFound,
                                message: format!("device not found: {name}"),
                            },
                        )
                        .await?;
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
            ClientToServerMsg::RegisterPushToken { .. } => {
                write_msg(
                    &writer,
                    &ServerToClientMsg::Error {
                        code: ErrorCode::InvalidRequest,
                        message: "push registration is accepted from paired iroh devices only"
                            .to_string(),
                    },
                )
                .await?;
            }
            ClientToServerMsg::AgentStateEvent {
                session_id,
                source,
                state: agent_state,
                last_line,
            } => {
                if !may_create_or_kill_session(client_kind) {
                    write_forbidden(&writer, "mobile clients cannot emit agent state events")
                        .await?;
                    continue;
                }
                if let Some(session) = state.sessions.get(&session_id) {
                    session.apply_agent_state_event(source, agent_state, last_line);
                    state.publish_session_list();
                } else {
                    write_msg(
                        &writer,
                        &ServerToClientMsg::Error {
                            code: ErrorCode::NotFound,
                            message: format!("session not found: {session_id}"),
                        },
                    )
                    .await?;
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

fn spawn_session_list_forwarder(state: Arc<AppState>, session: Arc<Session>) {
    tokio::spawn(async move {
        let mut rx = session.subscribe();
        while let Ok(event) = rx.recv().await {
            match event {
                ServerToClientMsg::AgentStateChanged { .. }
                | ServerToClientMsg::SessionExited { .. } => state.publish_session_list(),
                _ => {}
            }
        }
    });
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

async fn read_msg<R, T>(reader: &mut R) -> Result<T>
where
    R: AsyncRead + Unpin,
    T: DeserializeOwned,
{
    let len = reader.read_u32().await.context("read frame length")? as usize;
    if len > max_frame_len() {
        anyhow::bail!("frame too large: {len}");
    }
    let mut payload = vec![0; len];
    reader
        .read_exact(&mut payload)
        .await
        .context("read frame payload")?;
    decode_bincode(&payload).context("decode frame")
}

async fn write_msg<W, T>(writer: &Arc<Mutex<W>>, message: &T) -> Result<()>
where
    W: AsyncWrite + Unpin,
    T: Serialize,
{
    let payload = encode_bincode(message).context("encode frame")?;
    if payload.len() > max_frame_len() {
        anyhow::bail!("frame too large: {}", payload.len());
    }
    let mut writer = writer.lock().await;
    writer
        .write_u32(payload.len() as u32)
        .await
        .context("write frame length")?;
    writer
        .write_all(&payload)
        .await
        .context("write frame payload")?;
    writer.flush().await.context("flush frame")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::push::PushCommand;
    use fieldwork_protocol::{AgentSource, AgentState, ClientSize, SessionSummary};
    use std::collections::HashMap;
    use tokio::time::timeout;

    fn test_state() -> Arc<AppState> {
        let devices = Arc::new(DashMap::new());
        let (session_list_tx, _) = watch::channel(Vec::new());
        Arc::new(AppState {
            sessions: DashMap::new(),
            restored: DashMap::new(),
            devices: Arc::clone(&devices),
            persistence: None,
            pairing: PairingManager::new(),
            push: PushDispatcher::disabled_for_tests(),
            session_list_tx,
            iroh_endpoint: StdMutex::new(None),
        })
    }

    fn test_state_with_push(push: PushDispatcher) -> Arc<AppState> {
        let devices = Arc::new(DashMap::new());
        let (session_list_tx, _) = watch::channel(Vec::new());
        Arc::new(AppState {
            sessions: DashMap::new(),
            restored: DashMap::new(),
            devices: Arc::clone(&devices),
            persistence: None,
            pairing: PairingManager::new(),
            push,
            session_list_tx,
            iroh_endpoint: StdMutex::new(None),
        })
    }

    fn spawn_stdin_session(name: &str) -> Arc<Session> {
        Session::spawn(
            name.to_string(),
            vec![
                "/bin/sh".to_string(),
                "-c".to_string(),
                "while IFS= read -r _line; do sleep 1; done".to_string(),
            ],
            std::env::current_dir().expect("current dir"),
            HashMap::new(),
            ClientSize { rows: 24, cols: 80 },
            None,
            None,
        )
        .expect("spawn stdin session")
    }

    async fn assert_ipc_rejects_protocol_mismatch(client_kind: ClientKind) {
        let (client, server) = tokio::io::duplex(8192);
        let (server_reader, server_writer) = tokio::io::split(server);
        let server_task =
            tokio::spawn(handle_client_io(test_state(), server_reader, server_writer));
        let (mut client_reader, client_writer) = tokio::io::split(client);
        let client_writer = Arc::new(Mutex::new(client_writer));

        write_msg(
            &client_writer,
            &ClientToServerMsg::Hello {
                client_kind,
                client_version: "test".to_string(),
                protocol_version: CONTRACT_VERSION + 1,
            },
        )
        .await
        .unwrap();
        let mismatch: ServerToClientMsg = read_msg(&mut client_reader).await.unwrap();
        assert_eq!(
            mismatch,
            ServerToClientMsg::Error {
                code: ErrorCode::ProtocolMismatch,
                message: format!(
                    "protocol version mismatch: client={}, daemon={CONTRACT_VERSION}",
                    CONTRACT_VERSION + 1
                ),
            }
        );

        drop(client_writer);
        drop(client_reader);
        timeout(Duration::from_secs(1), server_task)
            .await
            .expect("IPC handler did not exit")
            .expect("IPC handler panicked")
            .expect("IPC handler failed");
    }

    #[tokio::test]
    async fn ipc_handler_rejects_protocol_version_mismatch() {
        assert_ipc_rejects_protocol_mismatch(ClientKind::LocalCli).await;
        assert_ipc_rejects_protocol_mismatch(ClientKind::IosApp).await;
        assert_ipc_rejects_protocol_mismatch(ClientKind::AndroidApp).await;
    }

    async fn assert_ipc_forbids_create_and_kill(client_kind: ClientKind) {
        let (client, server) = tokio::io::duplex(8192);
        let (server_reader, server_writer) = tokio::io::split(server);
        let server_task =
            tokio::spawn(handle_client_io(test_state(), server_reader, server_writer));
        let (mut client_reader, client_writer) = tokio::io::split(client);
        let client_writer = Arc::new(Mutex::new(client_writer));

        write_msg(
            &client_writer,
            &ClientToServerMsg::Hello {
                client_kind,
                client_version: "test".to_string(),
                protocol_version: CONTRACT_VERSION,
            },
        )
        .await
        .unwrap();
        let welcome: ServerToClientMsg = read_msg(&mut client_reader).await.unwrap();
        assert!(matches!(welcome, ServerToClientMsg::Welcome { .. }));

        write_msg(
            &client_writer,
            &ClientToServerMsg::CreateSession {
                name: "forbidden".to_string(),
                command: vec!["/bin/false".to_string()],
                cwd: std::env::current_dir().expect("current dir"),
                env: HashMap::new(),
                size: ClientSize { rows: 24, cols: 80 },
            },
        )
        .await
        .unwrap();
        let create_error: ServerToClientMsg = read_msg(&mut client_reader).await.unwrap();
        assert_eq!(
            create_error,
            ServerToClientMsg::Error {
                code: ErrorCode::Forbidden,
                message: "mobile clients cannot create sessions".to_string(),
            }
        );

        write_msg(
            &client_writer,
            &ClientToServerMsg::KillSession {
                session_id: SessionId::new(),
            },
        )
        .await
        .unwrap();
        let kill_error: ServerToClientMsg = read_msg(&mut client_reader).await.unwrap();
        assert_eq!(
            kill_error,
            ServerToClientMsg::Error {
                code: ErrorCode::Forbidden,
                message: "mobile clients cannot kill sessions".to_string(),
            }
        );

        drop(client_writer);
        drop(client_reader);
        timeout(Duration::from_secs(1), server_task)
            .await
            .expect("IPC handler did not exit")
            .expect("IPC handler panicked")
            .expect("IPC handler failed");
    }

    #[tokio::test]
    async fn ipc_handler_rejects_mobile_create_and_kill_session_requests() {
        assert_ipc_forbids_create_and_kill(ClientKind::IosApp).await;
        assert_ipc_forbids_create_and_kill(ClientKind::AndroidApp).await;
    }

    async fn assert_ipc_forbids_agent_state_events(client_kind: ClientKind) {
        let (client, server) = tokio::io::duplex(8192);
        let (server_reader, server_writer) = tokio::io::split(server);
        let server_task =
            tokio::spawn(handle_client_io(test_state(), server_reader, server_writer));
        let (mut client_reader, client_writer) = tokio::io::split(client);
        let client_writer = Arc::new(Mutex::new(client_writer));

        write_msg(
            &client_writer,
            &ClientToServerMsg::Hello {
                client_kind,
                client_version: "test".to_string(),
                protocol_version: CONTRACT_VERSION,
            },
        )
        .await
        .unwrap();
        let welcome: ServerToClientMsg = read_msg(&mut client_reader).await.unwrap();
        assert!(matches!(welcome, ServerToClientMsg::Welcome { .. }));

        write_msg(
            &client_writer,
            &ClientToServerMsg::AgentStateEvent {
                session_id: SessionId::new(),
                source: AgentSource::Codex,
                state: AgentState::AwaitingInput,
                last_line: Some("approval requested".to_string()),
            },
        )
        .await
        .unwrap();
        let hook_error: ServerToClientMsg = read_msg(&mut client_reader).await.unwrap();
        assert_eq!(
            hook_error,
            ServerToClientMsg::Error {
                code: ErrorCode::Forbidden,
                message: "mobile clients cannot emit agent state events".to_string(),
            }
        );

        drop(client_writer);
        drop(client_reader);
        timeout(Duration::from_secs(1), server_task)
            .await
            .expect("IPC handler did not exit")
            .expect("IPC handler panicked")
            .expect("IPC handler failed");
    }

    #[tokio::test]
    async fn ipc_handler_rejects_mobile_agent_state_events() {
        assert_ipc_forbids_agent_state_events(ClientKind::IosApp).await;
        assert_ipc_forbids_agent_state_events(ClientKind::AndroidApp).await;
    }

    async fn wait_for_summary<F>(
        rx: &mut watch::Receiver<Vec<SessionSummary>>,
        predicate: F,
    ) -> SessionSummary
    where
        F: Fn(&SessionSummary) -> bool,
    {
        timeout(Duration::from_secs(2), async {
            loop {
                rx.changed().await.expect("session list sender alive");
                let sessions = rx.borrow_and_update().clone();
                if let Some(summary) = sessions.into_iter().find(|summary| predicate(summary)) {
                    return summary;
                }
            }
        })
        .await
        .expect("timed out waiting for session summary")
    }

    #[tokio::test]
    async fn session_list_subscription_receives_create_and_remove_replacements() {
        let state = test_state();
        let mut rx = state.subscribe_session_list();
        assert!(rx.borrow_and_update().is_empty());

        let session = spawn_stdin_session("subscribed");
        let session_id = session.id();
        state.sessions.insert(session_id, Arc::clone(&session));
        spawn_session_list_forwarder(Arc::clone(&state), Arc::clone(&session));
        state.publish_session_list();

        let created = wait_for_summary(&mut rx, |summary| summary.id == session_id).await;
        assert_eq!(created.name, "subscribed");

        state.sessions.remove(&session_id);
        state.publish_session_list();
        timeout(Duration::from_secs(2), async {
            loop {
                rx.changed().await.expect("session list sender alive");
                if rx.borrow_and_update().is_empty() {
                    break;
                }
            }
        })
        .await
        .expect("timed out waiting for empty session list");

        let _ = session.kill();
    }

    #[tokio::test]
    async fn session_list_forwarder_publishes_dashboard_state_changes() {
        let state = test_state();
        let mut rx = state.subscribe_session_list();
        let session = spawn_stdin_session("stateful");
        let session_id = session.id();
        state.sessions.insert(session_id, Arc::clone(&session));
        spawn_session_list_forwarder(Arc::clone(&state), Arc::clone(&session));
        state.publish_session_list();
        let _ = wait_for_summary(&mut rx, |summary| summary.id == session_id).await;

        tokio::task::yield_now().await;
        session
            .write_input(b"hello from subscriber test\n")
            .expect("write input");

        let changed = wait_for_summary(&mut rx, |summary| {
            summary.id == session_id && summary.state == AgentState::Working
        })
        .await;
        assert_eq!(changed.name, "stateful");

        let _ = session.kill();
    }

    #[test]
    fn removing_device_revokes_next_iroh_pair_check() {
        let state = test_state();
        state
            .save_device(StoredDevice::new(
                "Smoke Phone".to_string(),
                "device-node-a".to_string(),
            ))
            .unwrap();

        assert!(state.is_device_paired("device-node-a"));
        assert!(state.remove_device("Smoke Phone").unwrap().is_some());
        assert!(!state.is_device_paired("device-node-a"));
    }

    #[tokio::test]
    async fn removing_device_with_push_token_enqueues_relay_unregistration() {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let state = test_state_with_push(PushDispatcher::from_test_sender(tx));
        let mut device = StoredDevice::new("Smoke Phone".to_string(), "device-node-a".to_string());
        device.set_push_token(
            PushPlatform::Apns,
            "apns-token-for-removed-device".to_string(),
        );
        state.save_device(device).unwrap();

        assert!(state.remove_device("Smoke Phone").unwrap().is_some());

        let command = timeout(Duration::from_secs(1), rx.recv())
            .await
            .expect("device removal should enqueue token unregistration")
            .expect("push command");
        match command {
            PushCommand::UnregisterToken { token } => {
                assert_eq!(token, "apns-token-for-removed-device");
            }
            _ => panic!("expected unregister token command"),
        }
    }
}
