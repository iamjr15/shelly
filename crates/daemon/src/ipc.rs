use crate::authz::{
    may_create_or_kill_session, may_emit_agent_state_event, requires_shell_only_sessions,
};
use crate::config::Config;
use crate::forward::{ForwardedEvent, output_was_replayed, recv_attached_event};
use crate::pairing::PairingManager;
use crate::paths::{control_socket_path, prepare_control_socket, set_control_socket_permissions};
use crate::persistence::{Persistence, StoredDevice, StoredSession};
use crate::push::PushDispatcher;
use crate::session::Session;
use crate::transport_iroh;
use anyhow::{Context, Result};
use dashmap::DashMap;
use interprocess::local_socket::traits::tokio::Listener as _;
use interprocess::local_socket::{
    GenericFilePath, ListenerOptions,
    prelude::*,
    tokio::{Listener, Stream},
};
use serde::{Serialize, de::DeserializeOwned};
use shelly_protocol::{
    CONTRACT_VERSION, Capabilities, ClientId, ClientKind, ClientToServerMsg, ErrorCode,
    PairingTicket, PushPlatform, ServerToClientMsg, SessionId, decode_bincode, encode_bincode,
    max_frame_len, normalize_code,
};
use std::path::Path;
use std::sync::{Arc, Mutex as StdMutex};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::{Mutex, broadcast, watch};
use tokio::time::{Duration, sleep};
use tracing::{error, info, warn};

const AUTO_SESSION_NAMES: &[&str] = &[
    "waffle",
    "pickle",
    "noodle",
    "bagel",
    "nacho",
    "spatula",
    "kazoo",
    "widget",
    "pancake",
    "sprocket",
    "marble",
    "boomerang",
    "muffin",
    "donut",
    "toaster",
    "sprinkle",
    "gizmo",
    "jellybean",
];

pub struct AppState {
    pub(crate) sessions: DashMap<SessionId, Arc<Session>>,
    pub(crate) restored: DashMap<SessionId, StoredSession>,
    pub(crate) devices: Arc<DashMap<String, StoredDevice>>,
    pub(crate) persistence: Option<Arc<Persistence>>,
    pub(crate) pairing: PairingManager,
    pub(crate) push: PushDispatcher,
    session_list_tx: watch::Sender<Vec<shelly_protocol::SessionSummary>>,
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

    pub(crate) fn summaries(&self) -> Vec<shelly_protocol::SessionSummary> {
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
    ) -> watch::Receiver<Vec<shelly_protocol::SessionSummary>> {
        self.session_list_tx.subscribe()
    }

    pub(crate) fn subscribe_session_list_with_initial(
        &self,
    ) -> (
        Vec<shelly_protocol::SessionSummary>,
        watch::Receiver<Vec<shelly_protocol::SessionSummary>>,
    ) {
        let mut rx = self.subscribe_session_list();
        let initial = rx.borrow_and_update().clone();
        (initial, rx)
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

    pub(crate) fn pairing_ticket(&self, code: String, expires_at: u64) -> Result<PairingTicket> {
        let info = self
            .iroh_endpoint
            .lock()
            .map_err(|_| anyhow::anyhow!("iroh endpoint lock poisoned"))?
            .clone()
            .context("iroh endpoint is not ready yet")?;

        Ok(PairingTicket {
            code,
            node_id: info.node_id,
            relay_url: info.relay_url,
            addrs: info.addrs,
            expires_at,
        })
    }

    pub(crate) async fn wait_pairing_ticket(
        &self,
        code: String,
        expires_at: u64,
    ) -> Result<PairingTicket> {
        for _ in 0..100 {
            if let Ok(ticket) = self.pairing_ticket(code.clone(), expires_at) {
                return Ok(ticket);
            }
            sleep(Duration::from_millis(100)).await;
        }
        self.pairing_ticket(code, expires_at)
    }

    pub(crate) fn iroh_node_id(&self) -> Option<String> {
        self.iroh_endpoint
            .lock()
            .ok()
            .and_then(|info| info.as_ref().map(|info| info.node_id.clone()))
    }

    pub(crate) fn device_summaries(&self) -> Vec<shelly_protocol::DeviceSummary> {
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

    pub(crate) fn clear_device_push(
        &self,
        device_node_id: &str,
        platform: PushPlatform,
        token: String,
    ) -> Result<bool> {
        let Some(mut device) = self.devices.get_mut(device_node_id) else {
            return Ok(false);
        };
        let token_matches = device.push_platform == Some(platform)
            && device.push_token.as_deref() == Some(token.as_str());
        if token_matches {
            device.clear_push_token();
            if let Some(persistence) = &self.persistence {
                persistence.save_device(&device)?;
            }
            self.push.unregister_token(token);
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
        .context("bind shelly control socket")?;
    set_control_socket_permissions(&socket_path)?;

    {
        let state = Arc::clone(&state);
        tokio::spawn(async move {
            if let Err(error) = transport_iroh::serve(state).await {
                error!(%error, "iroh transport failed");
            }
        });
    }
    info!(path = %socket_path.display(), "shellyd listening");

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
            ClientToServerMsg::CreateSession {
                name,
                command,
                cwd,
                env,
                size,
            } => {
                if !may_create_or_kill_session(client_kind) {
                    write_forbidden(&writer, "client cannot create sessions").await?;
                    continue;
                }
                let response =
                    create_session_for(&state, client_kind, name, command, cwd, env, size);
                write_msg(&writer, &response).await?;
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
            ClientToServerMsg::DetachSession => break,
            ClientToServerMsg::KillSession { session_id } => {
                if !may_create_or_kill_session(client_kind) {
                    write_forbidden(&writer, "client cannot kill sessions").await?;
                    continue;
                }
                kill_session_for(&state, session_id);
            }
            ClientToServerMsg::Input { session_id, bytes } => {
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
            ClientToServerMsg::Ping { seq } => {
                write_msg(&writer, &ServerToClientMsg::Pong { seq }).await?;
            }
            ClientToServerMsg::BeginPairing { .. } => {
                if client_kind != ClientKind::LocalCli {
                    write_forbidden(&writer, "mobile clients cannot create pairing codes").await?;
                    continue;
                }

                let (code, expires_at, mut request_rx) = match state.pairing.begin_pairing() {
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
                let ticket = match state.wait_pairing_ticket(code, expires_at).await {
                    Ok(ticket) => ticket,
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

                // Best-effort: publish the code -> reachability blob to the relay
                // so the typed-code path can resolve it. Skipped silently when the
                // relay is unset; failures never break the QR path below.
                match ticket.encode() {
                    Ok(ticket_blob) => state.push.publish_pairing_code(
                        ticket.code.clone(),
                        ticket_blob,
                        ticket.expires_at,
                    ),
                    Err(error) => {
                        warn!(%error, "failed to encode pairing ticket for relay publish")
                    }
                }

                write_msg(&writer, &ServerToClientMsg::PairingStarted { ticket }).await?;

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
            ClientToServerMsg::PairWithCode {
                code,
                device_name,
                device_node_id,
            } => {
                let code = normalize_code(&code);
                match state
                    .pairing
                    .request_approval(&code, device_name.clone(), device_node_id.clone())
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
            ClientToServerMsg::RegisterPushToken { .. }
            | ClientToServerMsg::UnregisterPushToken { .. } => {
                write_msg(
                    &writer,
                    &ServerToClientMsg::Error {
                        code: ErrorCode::InvalidRequest,
                        message: "push token updates are accepted from paired iroh devices only"
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
                if !may_emit_agent_state_event(client_kind) {
                    write_forbidden(&writer, "mobile clients cannot emit agent state events")
                        .await?;
                    continue;
                }
                if let Some(session) = state.sessions.get(&session_id) {
                    match session.apply_agent_state_event(source, agent_state, last_line) {
                        Ok(last_line) => {
                            state.publish_session_list();
                            write_msg(
                                &writer,
                                &ServerToClientMsg::AgentStateChanged {
                                    session_id,
                                    state: agent_state,
                                    last_line,
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
                } else {
                    write_session_not_found(&writer, session_id).await?;
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

/// Creates a session on behalf of `client_kind` and returns the message to send
/// back to the client.
///
/// Mobile clients are restricted to a default shell: their requested command,
/// working directory, and environment are ignored and replaced with the daemon's
/// default shell, the user's home directory, and an empty environment. This is
/// the server-side half of the "shell only" mobile boundary and is enforced even
/// if a modified client sends a different command. Shared by the local IPC and
/// iroh transports so both behave identically.
pub(crate) fn create_session_for(
    state: &Arc<AppState>,
    client_kind: ClientKind,
    name: String,
    command: Vec<String>,
    cwd: std::path::PathBuf,
    env: std::collections::HashMap<String, String>,
    size: shelly_protocol::ClientSize,
) -> ServerToClientMsg {
    let (command, cwd, env) = if requires_shell_only_sessions(client_kind) {
        (
            default_session_command(),
            default_home_dir(),
            std::collections::HashMap::new(),
        )
    } else {
        (command, cwd, env)
    };

    let summaries = state.summaries();
    let name = match resolve_new_session_name(name, &summaries) {
        Ok(name) => name,
        Err(error) => {
            return ServerToClientMsg::Error {
                code: ErrorCode::InvalidRequest,
                message: error.to_string(),
            };
        }
    };

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
            spawn_session_list_forwarder(Arc::clone(state), session);
            state.publish_session_list();
            ServerToClientMsg::SessionCreated {
                session_id,
                summary,
            }
        }
        Err(error) => ServerToClientMsg::Error {
            code: ErrorCode::InvalidRequest,
            message: error.to_string(),
        },
    }
}

/// Kills a session and removes any persisted copy. Missing sessions are treated
/// as already-killed (idempotent), matching the local-CLI behavior. Shared by the
/// local IPC and iroh transports.
pub(crate) fn kill_session_for(state: &Arc<AppState>, session_id: SessionId) {
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

/// The default session command for daemon-created sessions: the user's login
/// shell, falling back to `/bin/sh`. Used for mobile "shell only" creates.
fn default_session_command() -> Vec<String> {
    vec![default_shell_from_env(std::env::var_os("SHELL"))]
}

fn default_shell_from_env(shell: Option<std::ffi::OsString>) -> String {
    shell
        .and_then(|value| value.into_string().ok())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "/bin/sh".to_string())
}

/// The working directory for daemon-created (mobile) sessions: the user's home
/// directory, falling back to `/`.
fn default_home_dir() -> std::path::PathBuf {
    std::env::var_os("HOME")
        .map(std::path::PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or_else(|| std::path::PathBuf::from("/"))
}

fn spawn_session_list_forwarder(state: Arc<AppState>, session: Arc<Session>) {
    let mut rx = session.subscribe();
    drop(session);
    tokio::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(ServerToClientMsg::AgentStateChanged { .. }) => state.publish_session_list(),
                Ok(ServerToClientMsg::SessionExited { .. }) => {
                    state.publish_session_list();
                    break;
                }
                Ok(_) => {}
                Err(broadcast::error::RecvError::Lagged(_)) => state.publish_session_list(),
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    });
}

fn resolve_new_session_name(
    requested: String,
    existing: &[shelly_protocol::SessionSummary],
) -> Result<String> {
    let name = requested.trim().to_string();
    if name.chars().any(char::is_control) {
        anyhow::bail!("session name cannot contain control characters");
    }

    let name = if name.is_empty() {
        auto_session_name(existing)
    } else {
        name
    };

    if existing.iter().any(|session| session.name == name) {
        anyhow::bail!("session name already exists: {name}");
    }

    Ok(name)
}

fn auto_session_name(existing: &[shelly_protocol::SessionSummary]) -> String {
    let start = auto_name_start_index();
    for offset in 0..AUTO_SESSION_NAMES.len() {
        let name = AUTO_SESSION_NAMES[(start + offset) % AUTO_SESSION_NAMES.len()];
        if existing.iter().all(|session| session.name != name) {
            return name.to_string();
        }
    }

    let base = AUTO_SESSION_NAMES[start % AUTO_SESSION_NAMES.len()];
    for suffix in 2.. {
        let candidate = format!("{base}{suffix}");
        if existing.iter().all(|session| session.name != candidate) {
            return candidate;
        }
    }
    unreachable!("unbounded suffix search always returns")
}

fn auto_name_start_index() -> usize {
    (SessionId::new().0.as_u128() as usize) % AUTO_SESSION_NAMES.len()
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
    use shelly_protocol::{AgentSource, AgentState, ClientSize, SessionSummary};
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

    fn test_summary(name: &str) -> SessionSummary {
        SessionSummary {
            id: SessionId::new(),
            name: name.to_string(),
            command: vec!["bash".to_string()],
            cwd: std::env::current_dir().expect("current dir"),
            created_at: 1,
            last_activity: 1,
            state: AgentState::Idle,
            last_line: None,
            model: None,
        }
    }

    fn write_sleeping_agent_stub(dir: &Path, name: &str) -> std::path::PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, "#!/bin/sh\nsleep 30\n").expect("write agent stub");
        make_executable(&path);
        path
    }

    #[cfg(unix)]
    fn make_executable(path: &Path) {
        use std::os::unix::fs::PermissionsExt;

        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755))
            .expect("mark agent stub executable");
    }

    #[cfg(not(unix))]
    fn make_executable(_path: &Path) {}

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

    async fn assert_ipc_allows_shell_only_create_and_kill(client_kind: ClientKind) {
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

        // A mobile client may create a session, but the daemon forces a default
        // shell and ignores the requested command, cwd, and env.
        write_msg(
            &client_writer,
            &ClientToServerMsg::CreateSession {
                name: "from-phone".to_string(),
                command: vec!["/bin/false".to_string()],
                cwd: std::env::current_dir().expect("current dir"),
                env: HashMap::from([("SECRET".to_string(), "value".to_string())]),
                size: ClientSize { rows: 24, cols: 80 },
            },
        )
        .await
        .unwrap();
        let created: ServerToClientMsg = read_msg(&mut client_reader).await.unwrap();
        let session_id = match created {
            ServerToClientMsg::SessionCreated {
                session_id,
                summary,
            } => {
                assert_eq!(summary.command, default_session_command());
                assert_ne!(summary.command, vec!["/bin/false".to_string()]);
                session_id
            }
            other => panic!("expected SessionCreated, got {other:?}"),
        };

        // Kill is fire-and-forget (no response). Verify removal via ListSessions;
        // the handler processes messages in order, so the kill lands first.
        write_msg(
            &client_writer,
            &ClientToServerMsg::KillSession { session_id },
        )
        .await
        .unwrap();
        write_msg(&client_writer, &ClientToServerMsg::ListSessions)
            .await
            .unwrap();
        let listed: ServerToClientMsg = read_msg(&mut client_reader).await.unwrap();
        match listed {
            ServerToClientMsg::SessionList { sessions } => {
                assert!(
                    !sessions.iter().any(|session| session.id == session_id),
                    "killed session should be gone"
                );
            }
            other => panic!("expected SessionList, got {other:?}"),
        }

        drop(client_writer);
        drop(client_reader);
        timeout(Duration::from_secs(1), server_task)
            .await
            .expect("IPC handler did not exit")
            .expect("IPC handler panicked")
            .expect("IPC handler failed");
    }

    #[tokio::test]
    async fn ipc_handler_allows_mobile_shell_only_create_and_kill() {
        assert_ipc_allows_shell_only_create_and_kill(ClientKind::IosApp).await;
        assert_ipc_allows_shell_only_create_and_kill(ClientKind::AndroidApp).await;
    }

    #[tokio::test]
    async fn create_session_for_forces_shell_only_for_mobile() {
        let state = test_state();
        let response = create_session_for(
            &state,
            ClientKind::AndroidApp,
            "phone".to_string(),
            vec!["/bin/false".to_string()],
            std::path::PathBuf::from("/tmp"),
            HashMap::from([("SECRET".to_string(), "value".to_string())]),
            ClientSize { rows: 24, cols: 80 },
        );
        match response {
            ServerToClientMsg::SessionCreated {
                session_id,
                summary,
            } => {
                assert_eq!(summary.command, default_session_command());
                kill_session_for(&state, session_id);
            }
            other => panic!("expected SessionCreated, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn create_session_for_preserves_command_for_local_cli() {
        let state = test_state();
        let command = vec!["/bin/echo".to_string(), "hi".to_string()];
        let response = create_session_for(
            &state,
            ClientKind::LocalCli,
            "cli".to_string(),
            command.clone(),
            std::env::current_dir().expect("current dir"),
            HashMap::new(),
            ClientSize { rows: 24, cols: 80 },
        );
        match response {
            ServerToClientMsg::SessionCreated {
                session_id,
                summary,
            } => {
                assert_eq!(summary.command, command);
                kill_session_for(&state, session_id);
            }
            other => panic!("expected SessionCreated, got {other:?}"),
        }
    }

    async fn assert_ipc_reports_missing_session_for_input_and_resize(client_kind: ClientKind) {
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

        let input_session_id = SessionId::new();
        write_msg(
            &client_writer,
            &ClientToServerMsg::Input {
                session_id: input_session_id,
                bytes: b"lost input\r".to_vec(),
            },
        )
        .await
        .unwrap();
        assert_eq!(
            read_msg::<_, ServerToClientMsg>(&mut client_reader)
                .await
                .unwrap(),
            ServerToClientMsg::Error {
                code: ErrorCode::NotFound,
                message: format!("session not found: {input_session_id}"),
            }
        );

        let resize_session_id = SessionId::new();
        write_msg(
            &client_writer,
            &ClientToServerMsg::Resize {
                session_id: resize_session_id,
                size: ClientSize { rows: 24, cols: 80 },
            },
        )
        .await
        .unwrap();
        assert_eq!(
            read_msg::<_, ServerToClientMsg>(&mut client_reader)
                .await
                .unwrap(),
            ServerToClientMsg::Error {
                code: ErrorCode::NotFound,
                message: format!("session not found: {resize_session_id}"),
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
    async fn ipc_handler_reports_missing_session_for_input_and_resize() {
        assert_ipc_reports_missing_session_for_input_and_resize(ClientKind::LocalCli).await;
        assert_ipc_reports_missing_session_for_input_and_resize(ClientKind::IosApp).await;
        assert_ipc_reports_missing_session_for_input_and_resize(ClientKind::AndroidApp).await;
    }

    #[tokio::test]
    async fn ipc_handler_rejects_duplicate_session_names() {
        let (client, server) = tokio::io::duplex(8192);
        let (server_reader, server_writer) = tokio::io::split(server);
        let server_task =
            tokio::spawn(handle_client_io(test_state(), server_reader, server_writer));
        let (mut client_reader, client_writer) = tokio::io::split(client);
        let client_writer = Arc::new(Mutex::new(client_writer));

        write_msg(
            &client_writer,
            &ClientToServerMsg::Hello {
                client_kind: ClientKind::LocalCli,
                client_version: "test".to_string(),
                protocol_version: CONTRACT_VERSION,
            },
        )
        .await
        .unwrap();
        let welcome: ServerToClientMsg = read_msg(&mut client_reader).await.unwrap();
        assert!(matches!(welcome, ServerToClientMsg::Welcome { .. }));

        for expected in ["created", "duplicate"] {
            write_msg(
                &client_writer,
                &ClientToServerMsg::CreateSession {
                    name: "refactoringjob".to_string(),
                    command: vec![
                        "/bin/sh".to_string(),
                        "-c".to_string(),
                        "while IFS= read -r _line; do sleep 1; done".to_string(),
                    ],
                    cwd: std::env::current_dir().expect("current dir"),
                    env: HashMap::new(),
                    size: ClientSize { rows: 24, cols: 80 },
                },
            )
            .await
            .unwrap();

            let response: ServerToClientMsg = read_msg(&mut client_reader).await.unwrap();
            match expected {
                "created" => {
                    let ServerToClientMsg::SessionCreated { summary, .. } = response else {
                        panic!("expected session creation, got {response:?}");
                    };
                    assert_eq!(summary.name, "refactoringjob");
                }
                "duplicate" => assert_eq!(
                    response,
                    ServerToClientMsg::Error {
                        code: ErrorCode::InvalidRequest,
                        message: "session name already exists: refactoringjob".to_string(),
                    }
                ),
                _ => unreachable!(),
            }
        }

        drop(client_writer);
        drop(client_reader);
        timeout(Duration::from_secs(1), server_task)
            .await
            .expect("IPC handler did not exit")
            .expect("IPC handler panicked")
            .expect("IPC handler failed");
    }

    #[test]
    fn daemon_session_name_resolution_generates_trims_and_validates() {
        let generated = resolve_new_session_name(" \t ".to_string(), &[]).unwrap();
        assert!(AUTO_SESSION_NAMES.contains(&generated.as_str()));
        assert!(
            generated
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
        );

        assert_eq!(
            resolve_new_session_name(" refactoringjob ".to_string(), &[]).unwrap(),
            "refactoringjob"
        );

        let existing = vec![test_summary("refactoringjob")];
        let duplicate = resolve_new_session_name("refactoringjob".to_string(), &existing)
            .expect_err("duplicate names should be rejected");
        assert!(
            duplicate
                .to_string()
                .contains("session name already exists: refactoringjob")
        );

        let control = resolve_new_session_name("line\nbreak".to_string(), &[])
            .expect_err("control characters should be rejected");
        assert!(
            control
                .to_string()
                .contains("session name cannot contain control characters")
        );
    }

    #[tokio::test]
    async fn ipc_handler_generates_daemon_session_name_for_empty_local_create() {
        let state = test_state();
        let (client, server) = tokio::io::duplex(8192);
        let (server_reader, server_writer) = tokio::io::split(server);
        let server_task = tokio::spawn(handle_client_io(
            Arc::clone(&state),
            server_reader,
            server_writer,
        ));
        let (mut client_reader, client_writer) = tokio::io::split(client);
        let client_writer = Arc::new(Mutex::new(client_writer));

        write_msg(
            &client_writer,
            &ClientToServerMsg::Hello {
                client_kind: ClientKind::LocalCli,
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
                name: " \t ".to_string(),
                command: vec![
                    "/bin/sh".to_string(),
                    "-c".to_string(),
                    "while IFS= read -r _line; do sleep 1; done".to_string(),
                ],
                cwd: std::env::current_dir().expect("current dir"),
                env: HashMap::new(),
                size: ClientSize { rows: 24, cols: 80 },
            },
        )
        .await
        .unwrap();

        let response: ServerToClientMsg = read_msg(&mut client_reader).await.unwrap();
        let ServerToClientMsg::SessionCreated {
            session_id,
            summary,
        } = response
        else {
            panic!("expected session creation, got {response:?}");
        };
        assert!(AUTO_SESSION_NAMES.contains(&summary.name.as_str()));
        assert_eq!(
            summary.command,
            vec![
                "/bin/sh",
                "-c",
                "while IFS= read -r _line; do sleep 1; done"
            ]
        );

        if let Some((_, session)) = state.sessions.remove(&session_id) {
            let _ = session.kill();
        }
        drop(client_writer);
        drop(client_reader);
        timeout(Duration::from_secs(1), server_task)
            .await
            .expect("IPC handler did not exit")
            .expect("IPC handler panicked")
            .expect("IPC handler failed");
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

    #[tokio::test]
    async fn ipc_handler_acknowledges_local_agent_hook_and_reports_errors() {
        let state = test_state();
        let cwd = tempfile::tempdir().expect("tempdir");
        let claude = write_sleeping_agent_stub(cwd.path(), "claude");
        let session = Session::spawn(
            "claude-hook".to_string(),
            vec![claude.to_string_lossy().into_owned()],
            cwd.path().to_path_buf(),
            HashMap::new(),
            ClientSize { rows: 24, cols: 80 },
            None,
            None,
        )
        .expect("spawn claude session");
        let session_id = session.id();
        state.sessions.insert(session_id, Arc::clone(&session));

        let (client, server) = tokio::io::duplex(8192);
        let (server_reader, server_writer) = tokio::io::split(server);
        let server_task = tokio::spawn(handle_client_io(state, server_reader, server_writer));
        let (mut client_reader, client_writer) = tokio::io::split(client);
        let client_writer = Arc::new(Mutex::new(client_writer));

        write_msg(
            &client_writer,
            &ClientToServerMsg::Hello {
                client_kind: ClientKind::LocalCli,
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
                session_id,
                source: AgentSource::Claude,
                state: AgentState::AwaitingInput,
                last_line: Some("approval requested".to_string()),
            },
        )
        .await
        .unwrap();
        let ack: ServerToClientMsg = read_msg(&mut client_reader).await.unwrap();
        assert_eq!(
            ack,
            ServerToClientMsg::AgentStateChanged {
                session_id,
                state: AgentState::AwaitingInput,
                last_line: Some("approval requested".to_string()),
            }
        );

        write_msg(
            &client_writer,
            &ClientToServerMsg::AgentStateEvent {
                session_id,
                source: AgentSource::Codex,
                state: AgentState::AwaitingInput,
                last_line: Some("wrong source".to_string()),
            },
        )
        .await
        .unwrap();
        let mismatch: ServerToClientMsg = read_msg(&mut client_reader).await.unwrap();
        let ServerToClientMsg::Error { code, message } = mismatch else {
            panic!("expected mismatched hook error");
        };
        assert_eq!(code, ErrorCode::InvalidRequest);
        assert!(message.contains("does not match"));

        let missing_id = SessionId::new();
        write_msg(
            &client_writer,
            &ClientToServerMsg::AgentStateEvent {
                session_id: missing_id,
                source: AgentSource::Claude,
                state: AgentState::AwaitingInput,
                last_line: None,
            },
        )
        .await
        .unwrap();
        assert_eq!(
            read_msg::<_, ServerToClientMsg>(&mut client_reader)
                .await
                .unwrap(),
            ServerToClientMsg::Error {
                code: ErrorCode::NotFound,
                message: format!("session not found: {missing_id}"),
            }
        );

        drop(client_writer);
        drop(client_reader);
        let _ = session.kill();
        timeout(Duration::from_secs(1), server_task)
            .await
            .expect("IPC handler did not exit")
            .expect("IPC handler panicked")
            .expect("IPC handler failed");
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
    async fn session_list_subscription_initial_snapshot_is_current() {
        let state = test_state();
        let session = spawn_stdin_session("already-created");
        let session_id = session.id();
        state.sessions.insert(session_id, Arc::clone(&session));
        spawn_session_list_forwarder(Arc::clone(&state), Arc::clone(&session));
        state.publish_session_list();

        let (initial, rx) = state.subscribe_session_list_with_initial();

        assert_eq!(initial.len(), 1);
        assert_eq!(initial[0].id, session_id);
        assert!(!rx.has_changed().expect("session list sender alive"));

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

    #[tokio::test]
    async fn clearing_matching_device_push_token_enqueues_relay_unregistration() {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let state = test_state_with_push(PushDispatcher::from_test_sender(tx));
        let mut device = StoredDevice::new("Smoke Phone".to_string(), "device-node-a".to_string());
        device.set_push_token(PushPlatform::Fcm, "fcm-token".to_string());
        state.save_device(device).unwrap();

        assert!(
            state
                .clear_device_push("device-node-a", PushPlatform::Fcm, "fcm-token".to_string())
                .unwrap()
        );

        {
            let device = state
                .devices
                .get("device-node-a")
                .expect("device still paired");
            assert_eq!(device.push_platform, None);
            assert_eq!(device.push_token, None);
        }
        let command = timeout(Duration::from_secs(1), rx.recv())
            .await
            .expect("matching token clear should enqueue relay unregistration")
            .expect("push command");
        match command {
            PushCommand::UnregisterToken { token } => assert_eq!(token, "fcm-token"),
            _ => panic!("expected unregister token command"),
        }
    }

    #[tokio::test]
    async fn clearing_stale_device_push_token_is_idempotent_without_relay_unregistration() {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let state = test_state_with_push(PushDispatcher::from_test_sender(tx));
        let mut device = StoredDevice::new("Smoke Phone".to_string(), "device-node-a".to_string());
        device.set_push_token(PushPlatform::Fcm, "current-token".to_string());
        state.save_device(device).unwrap();

        assert!(
            state
                .clear_device_push("device-node-a", PushPlatform::Fcm, "old-token".to_string())
                .unwrap()
        );

        {
            let device = state
                .devices
                .get("device-node-a")
                .expect("device still paired");
            assert_eq!(device.push_platform, Some(PushPlatform::Fcm));
            assert_eq!(device.push_token.as_deref(), Some("current-token"));
        }
        assert!(
            timeout(Duration::from_millis(100), rx.recv())
                .await
                .is_err(),
            "stale token clear must not enqueue relay unregistration"
        );
    }

    #[test]
    fn clearing_missing_device_push_token_is_unauthorized() {
        let state = test_state();

        assert!(
            !state
                .clear_device_push("missing-device", PushPlatform::Fcm, "fcm-token".to_string())
                .unwrap()
        );
    }
}
