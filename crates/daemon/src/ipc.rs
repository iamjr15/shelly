use crate::authz::{
    may_create_or_kill_session, may_emit_agent_state_event, requires_shell_only_sessions,
};
use crate::config::Config;
use crate::forward::{ForwardedEvent, output_was_replayed, recv_attached_event};
use crate::pairing::PairingManager;
use crate::paths::{control_socket_path, prepare_control_socket, set_control_socket_permissions};
use crate::persistence::{MAX_STORED_SESSIONS, Persistence, StoredDevice, StoredSession};
use crate::push::PushDispatcher;
use crate::session::{AttachedClient, Session};
use crate::transport_iroh;
use anyhow::{Context, Result};
use dashmap::{DashMap, DashSet};
use interprocess::local_socket::traits::tokio::Listener as _;
use interprocess::local_socket::{
    GenericFilePath, ListenerOptions,
    prelude::*,
    tokio::{Listener, Stream},
};
use serde::{Serialize, de::DeserializeOwned};
use shelly_protocol::{
    BincodeFraming, CONTRACT_VERSION, Capabilities, ClientId, ClientKind, ClientToServerMsg,
    ErrorCode, PairingTicket, PushPlatform, ReadFrameError, ServerToClientMsg, SessionId,
    WriteFrameError, pairing_code_locator, read_framed, write_framed,
};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex, Weak};
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt};
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
const MAX_TERMINAL_DIMENSION: u16 = 1_000;
const ACCEPT_BACKOFF_MIN: Duration = Duration::from_millis(50);
const ACCEPT_BACKOFF_MAX: Duration = Duration::from_secs(2);
const SESSION_LIST_PUBLISH_DEBOUNCE: Duration = Duration::from_millis(25);

/// Human-readable computer name for this daemon's host (macOS ComputerName, etc.), sent in Welcome.
pub(crate) fn host_display_name() -> String {
    let name = whoami::devicename();
    if name.trim().is_empty() {
        "this computer".to_string()
    } else {
        name
    }
}

pub struct AppState {
    pub(crate) sessions: DashMap<SessionId, Arc<Session>>,
    pub(crate) restored: DashMap<SessionId, StoredSession>,
    session_names: DashSet<String>,
    pub(crate) devices: Arc<DashMap<String, StoredDevice>>,
    pub(crate) persistence: Option<Arc<Persistence>>,
    pub(crate) pairing: PairingManager,
    pub(crate) push: PushDispatcher,
    session_list_tx: watch::Sender<Vec<shelly_protocol::SessionSummary>>,
    session_list_publish_pending: AtomicBool,
    device_revocations: DashMap<String, watch::Sender<u64>>,
    iroh_endpoint: StdMutex<Option<IrohEndpointInfo>>,
}

pub(crate) struct DeviceRevocationWatcher {
    device_node_id: String,
    receiver: Option<watch::Receiver<u64>>,
    state: Weak<AppState>,
}

impl Clone for DeviceRevocationWatcher {
    fn clone(&self) -> Self {
        Self {
            device_node_id: self.device_node_id.clone(),
            receiver: Some(
                self.receiver
                    .as_ref()
                    .expect("revocation receiver available")
                    .clone(),
            ),
            state: self.state.clone(),
        }
    }
}

impl DeviceRevocationWatcher {
    pub(crate) async fn changed(&mut self) -> Result<(), watch::error::RecvError> {
        self.receiver
            .as_mut()
            .expect("revocation receiver available")
            .changed()
            .await
    }

    pub(crate) fn mark_current_seen(&mut self) {
        self.receiver
            .as_mut()
            .expect("revocation receiver available")
            .borrow_and_update();
    }
}

impl Drop for DeviceRevocationWatcher {
    fn drop(&mut self) {
        drop(self.receiver.take());
        if let Some(state) = self.state.upgrade() {
            state
                .device_revocations
                .remove_if(&self.device_node_id, |_, sender| {
                    sender.receiver_count() == 0
                });
        }
    }
}

#[derive(Clone, Debug)]
pub struct IrohEndpointInfo {
    pub node_id: String,
    pub relay_url: Option<String>,
    pub addrs: Vec<String>,
}

impl AppState {
    #[cfg(test)]
    pub(crate) fn for_tests() -> Arc<Self> {
        let devices = Arc::new(DashMap::new());
        let (session_list_tx, _) = watch::channel(Vec::new());
        Arc::new(Self {
            sessions: DashMap::new(),
            restored: DashMap::new(),
            session_names: DashSet::new(),
            devices: Arc::clone(&devices),
            persistence: None,
            pairing: PairingManager::new(),
            push: PushDispatcher::disabled_for_tests(),
            session_list_tx,
            session_list_publish_pending: AtomicBool::new(false),
            device_revocations: DashMap::new(),
            iroh_endpoint: StdMutex::new(None),
        })
    }

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

        let pruned_sessions = persistence
            .prune_sessions(shelly_protocol::now_ms())
            .context("prune persisted sessions")?;
        if pruned_sessions > 0 {
            info!(
                pruned_sessions,
                "pruned expired or excess persisted sessions"
            );
        }

        let restored = DashMap::new();
        let session_names = DashSet::new();
        let devices = Arc::new(DashMap::new());
        for session in persistence
            .load_sessions()
            .context("load persisted sessions")?
        {
            session_names.insert(session.summary.name.clone());
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
            session_names,
            devices: Arc::clone(&devices),
            persistence: Some(persistence),
            pairing: PairingManager::new(),
            push: PushDispatcher::from_env(devices),
            session_list_tx,
            session_list_publish_pending: AtomicBool::new(false),
            device_revocations: DashMap::new(),
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

    fn schedule_session_list_publish(self: &Arc<Self>) {
        if self
            .session_list_publish_pending
            .swap(true, Ordering::AcqRel)
        {
            return;
        }
        let state = Arc::clone(self);
        tokio::spawn(async move {
            sleep(SESSION_LIST_PUBLISH_DEBOUNCE).await;
            // Clear first: an update racing with summary materialization schedules a
            // second pass, while an earlier update is included in this snapshot.
            state
                .session_list_publish_pending
                .store(false, Ordering::Release);
            state.publish_session_list();
        });
    }

    pub(crate) async fn flush_dirty_sessions(&self) -> Result<()> {
        let sessions: Vec<_> = self
            .sessions
            .iter()
            .map(|entry| Arc::clone(&entry))
            .collect();
        tokio::task::spawn_blocking(move || {
            for session in sessions {
                session.flush_dirty_persistence();
            }
        })
        .await
        .context("join session persistence flush")
    }

    fn insert_restored_session(&self, session: StoredSession) {
        self.session_names.insert(session.summary.name.clone());
        self.restored.insert(session.summary.id, session);
        while self.restored.len() > MAX_STORED_SESSIONS {
            let Some(oldest_id) = self
                .restored
                .iter()
                .min_by_key(|entry| entry.summary.last_activity)
                .map(|entry| entry.summary.id)
            else {
                break;
            };
            let removed = self.restored.remove(&oldest_id).map(|(_, session)| session);
            if let Some(removed) = &removed
                && !self.sessions.contains_key(&oldest_id)
            {
                self.session_names.remove(&removed.summary.name);
            }
            if let Some(persistence) = &self.persistence
                && let Err(error) = persistence.remove_session(oldest_id)
            {
                warn!(%error, session_id = %oldest_id, "failed to remove capped restored session");
            }
        }
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

    pub(crate) fn subscribe_device_revocation(
        self: &Arc<Self>,
        device_node_id: &str,
    ) -> DeviceRevocationWatcher {
        let receiver = self
            .device_revocations
            .entry(device_node_id.to_string())
            .or_insert_with(|| {
                let (tx, _) = watch::channel(0);
                tx
            })
            .subscribe();
        DeviceRevocationWatcher {
            device_node_id: device_node_id.to_string(),
            receiver: Some(receiver),
            state: Arc::downgrade(self),
        }
    }

    fn revoke_device_connections(&self, device_node_id: &str) {
        if let Some(sender) = self.device_revocations.get(device_node_id) {
            let next = sender.borrow().wrapping_add(1);
            let _ = sender.send(next);
        }
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

        self.remove_device_by_node_id(&device_node_id)
    }

    /// Removes exactly the authenticated caller identity. Absence is a
    /// successful no-op so a lost response can be retried safely.
    pub(crate) fn unpair_self(&self, device_node_id: &str) -> Result<Option<StoredDevice>> {
        self.remove_device_by_node_id(device_node_id)
    }

    fn remove_device_by_node_id(&self, device_node_id: &str) -> Result<Option<StoredDevice>> {
        if !self.devices.contains_key(device_node_id) {
            return Ok(None);
        }
        if let Some(persistence) = &self.persistence {
            persistence.remove_device(device_node_id)?;
        }
        let removed = self
            .devices
            .remove(device_node_id)
            .map(|(_, device)| device);
        if removed.is_some() {
            self.revoke_device_connections(device_node_id);
        }
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

pub async fn serve(state: Arc<AppState>) -> Result<()> {
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

    let mut accept_backoff = ACCEPT_BACKOFF_MIN;
    loop {
        let conn = match listener.accept().await {
            Ok(conn) => {
                accept_backoff = ACCEPT_BACKOFF_MIN;
                conn
            }
            Err(error) => {
                warn!(%error, ?accept_backoff, "local IPC accept failed; retrying");
                sleep(accept_backoff).await;
                accept_backoff = accept_backoff.saturating_mul(2).min(ACCEPT_BACKOFF_MAX);
                continue;
            }
        };
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
        if tokio::time::timeout(Duration::from_secs(1), &mut self.handle)
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

async fn handle_client_io<R, W>(state: Arc<AppState>, mut reader: R, writer: W) -> Result<()>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin + Send + 'static,
{
    let writer = Arc::new(Mutex::new(writer));
    let mut attach_task: Option<ForwarderTask> = None;
    let mut attached_client: Option<AttachedClient> = None;
    let mut session_list_task: Option<ForwarderTask> = None;

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
                    host_name: host_display_name(),
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
                            code: ErrorCode::VersionMismatch,
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

    let result: Result<()> = async {
        while let Ok(message) = read_msg::<_, ClientToServerMsg>(&mut reader).await {
            match message {
                ClientToServerMsg::Hello { .. } => {
                    // Retrying clients may replay Hello after the handshake, so keep it idempotent.
                }
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
                        task.shutdown().await;
                    }
                    let (sessions, mut rx) = state.subscribe_session_list_with_initial();
                    write_msg(&writer, &ServerToClientMsg::SessionList { sessions }).await?;

                    let writer = Arc::clone(&writer);
                    session_list_task =
                        Some(ForwarderTask::spawn(move |mut shutdown| async move {
                            loop {
                                let changed = tokio::select! {
                                    changed = rx.changed() => changed,
                                    _ = shutdown.changed() => break,
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
                    if let Some(error) = invalid_client_size(size) {
                        write_msg(&writer, &error).await?;
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
                    attached_client = Some(attachment);
                    attach_task = Some(ForwarderTask::spawn(move |mut shutdown| async move {
                        loop {
                            let event = tokio::select! {
                                event = recv_attached_event(&mut rx, session_id) => event,
                                _ = shutdown.changed() => break,
                            };
                            match event {
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
                    let response = kill_session_response(&state, session_id);
                    write_msg(&writer, &response).await?;
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
                ClientToServerMsg::Ping { seq } => {
                    write_msg(&writer, &ServerToClientMsg::Pong { seq }).await?;
                }
                ClientToServerMsg::BeginPairing { .. } => {
                    if client_kind != ClientKind::LocalCli {
                        write_forbidden(&writer, "mobile clients cannot create pairing codes")
                            .await?;
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

                    // The QR keeps the code locally. The typed path publishes only
                    // reachability under an offline-enumerable SHA-256 locator.
                    state.push.publish_pairing_rendezvous(
                        pairing_code_locator(&ticket.code),
                        ticket.rendezvous(),
                    );

                    write_msg(&writer, &ServerToClientMsg::PairingStarted { ticket }).await?;

                    let writer = Arc::clone(&writer);
                    tokio::spawn(async move {
                        while let Some(event) = request_rx.recv().await {
                            let message = ServerToClientMsg::PairingApprovalRequested {
                                request_id: event.request_id,
                                device_name: event.device_name,
                                device_node_id: event.device_node_id,
                                sas: event.sas,
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
                ClientToServerMsg::PairWithCode { .. } => {
                    write_forbidden(
                        &writer,
                        "new pairing is accepted over authenticated iroh only",
                    )
                    .await?;
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
                | ClientToServerMsg::UnregisterPushToken { .. }
                | ClientToServerMsg::UnpairSelf => {
                    write_msg(
                        &writer,
                        &ServerToClientMsg::Error {
                            code: ErrorCode::InvalidRequest,
                            message:
                                "push token updates are accepted from paired iroh devices only"
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
                                state.schedule_session_list_publish();
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
    if let Some(error) = invalid_client_size(size) {
        return error;
    }
    let (command, cwd, env) = if requires_shell_only_sessions(client_kind) {
        (
            default_session_command(),
            default_home_dir(),
            std::collections::HashMap::new(),
        )
    } else {
        (command, cwd, env)
    };

    let name_reservation = match reserve_new_session_name(state, name) {
        Ok(reservation) => reservation,
        Err(error) => {
            return ServerToClientMsg::Error {
                code: ErrorCode::InvalidRequest,
                message: error.to_string(),
            };
        }
    };
    let name = name_reservation.name().to_string();

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
            name_reservation.commit();
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

pub(crate) fn invalid_client_size(size: shelly_protocol::ClientSize) -> Option<ServerToClientMsg> {
    if size.rows != 0
        && size.cols != 0
        && size.rows <= MAX_TERMINAL_DIMENSION
        && size.cols <= MAX_TERMINAL_DIMENSION
    {
        return None;
    }

    Some(ServerToClientMsg::Error {
        code: ErrorCode::InvalidRequest,
        message: format!(
            "terminal size must have rows and cols in 1..={MAX_TERMINAL_DIMENSION}; got rows={}, cols={}",
            size.rows, size.cols
        ),
    })
}

/// Commits session termination across the live registry and persistence. Missing
/// sessions are treated as already killed, making retries idempotent. Callers may
/// acknowledge the command only after this returns successfully.
pub(crate) fn kill_session_for(state: &Arc<AppState>, session_id: SessionId) -> Result<()> {
    let mut removed_name = None;
    if let Some(session) = state
        .sessions
        .get(&session_id)
        .map(|entry| Arc::clone(&entry))
    {
        removed_name = Some(session.name().to_string());
        session
            .kill()
            .with_context(|| format!("kill session {session_id}"))?;
        state.sessions.remove(&session_id);
    }
    if let Some((_, restored)) = state.restored.remove(&session_id) {
        removed_name.get_or_insert(restored.summary.name);
    }
    if let Some(name) = removed_name {
        state.session_names.remove(&name);
    }
    let persistence_result = state.persistence.as_ref().map_or(Ok(()), |persistence| {
        persistence
            .remove_session(session_id)
            .with_context(|| format!("remove persisted session {session_id}"))
    });
    // The live registry is authoritative even when durable cleanup fails, so
    // subscribers must receive the committed in-memory state before the error is
    // returned. The missing acknowledgement tells the caller not to claim full
    // success, and a retry can complete the idempotent persistence deletion.
    state.publish_session_list();
    persistence_result
}

/// Protocol adapter for the termination use case. Both local IPC and iroh use
/// this boundary so acknowledgement and error semantics cannot drift between
/// desktop and mobile clients.
pub(crate) fn kill_session_response(
    state: &Arc<AppState>,
    session_id: SessionId,
) -> ServerToClientMsg {
    match kill_session_for(state, session_id) {
        Ok(()) => ServerToClientMsg::SessionKilled { session_id },
        Err(error) => ServerToClientMsg::Error {
            code: ErrorCode::Internal,
            message: error.to_string(),
        },
    }
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
    let mut rx = session.subscribe_summary_updates();
    let session_id = session.id();
    let already_exited = session.exit_code().is_some();
    drop(session);
    tokio::spawn(async move {
        if already_exited {
            evict_naturally_exited_session(&state, session_id);
            return;
        }
        loop {
            match rx.recv().await {
                Ok(exited) => {
                    if exited {
                        evict_naturally_exited_session(&state, session_id);
                        break;
                    }
                    state.schedule_session_list_publish();
                }
                Err(broadcast::error::RecvError::Lagged(_)) => {
                    state.schedule_session_list_publish();
                }
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    });
}

fn evict_naturally_exited_session(state: &AppState, session_id: SessionId) {
    let Some(session) = state
        .sessions
        .get(&session_id)
        .map(|entry| Arc::clone(&entry))
    else {
        state.publish_session_list();
        return;
    };
    if session.was_killed() {
        state.publish_session_list();
        return;
    }

    let stored = session.capture_stored();
    let stored_name = stored.summary.name.clone();
    state.insert_restored_session(stored);
    state.sessions.remove(&session_id);
    if !state.restored.contains_key(&session_id) {
        state.session_names.remove(&stored_name);
    }
    drop(session);
    state.publish_session_list();
}

struct SessionNameReservation<'a> {
    names: &'a DashSet<String>,
    name: String,
    release_on_drop: bool,
}

impl SessionNameReservation<'_> {
    fn name(&self) -> &str {
        &self.name
    }

    fn commit(mut self) {
        self.release_on_drop = false;
    }
}

impl Drop for SessionNameReservation<'_> {
    fn drop(&mut self) {
        if self.release_on_drop {
            self.names.remove(&self.name);
        }
    }
}

fn reserve_new_session_name(
    state: &AppState,
    requested: String,
) -> Result<SessionNameReservation<'_>> {
    let requested = validate_requested_session_name(requested)?;
    if let Some(name) = requested {
        if !state.session_names.insert(name.clone()) {
            anyhow::bail!("session name already exists: {name}");
        }
        return Ok(SessionNameReservation {
            names: &state.session_names,
            name,
            release_on_drop: true,
        });
    }

    let start = auto_name_start_index();
    for offset in 0..AUTO_SESSION_NAMES.len() {
        let name = AUTO_SESSION_NAMES[(start + offset) % AUTO_SESSION_NAMES.len()].to_string();
        if state.session_names.insert(name.clone()) {
            return Ok(SessionNameReservation {
                names: &state.session_names,
                name,
                release_on_drop: true,
            });
        }
    }

    let base = AUTO_SESSION_NAMES[start % AUTO_SESSION_NAMES.len()];
    for suffix in 2.. {
        let name = format!("{base}{suffix}");
        if state.session_names.insert(name.clone()) {
            return Ok(SessionNameReservation {
                names: &state.session_names,
                name,
                release_on_drop: true,
            });
        }
    }
    unreachable!("unbounded suffix search always returns")
}

fn validate_requested_session_name(requested: String) -> Result<Option<String>> {
    let name = requested.trim().to_string();
    if name.chars().any(char::is_control) {
        anyhow::bail!("session name cannot contain control characters");
    }
    Ok((!name.is_empty()).then_some(name))
}

#[cfg(test)]
fn resolve_new_session_name(
    requested: String,
    existing: &[shelly_protocol::SessionSummary],
) -> Result<String> {
    let name = if let Some(name) = validate_requested_session_name(requested)? {
        name
    } else {
        auto_session_name(existing)
    };

    if existing.iter().any(|session| session.name == name) {
        anyhow::bail!("session name already exists: {name}");
    }

    Ok(name)
}

#[cfg(test)]
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
    match read_framed::<BincodeFraming, _, _>(reader).await {
        Ok(message) => Ok(message),
        Err(ReadFrameError::ReadLength(error)) => Err(error).context("read frame length"),
        Err(ReadFrameError::TooLarge(len)) => anyhow::bail!("frame too large: {len}"),
        Err(ReadFrameError::ReadPayload(error)) => Err(error).context("read frame payload"),
        Err(ReadFrameError::Decode(error)) => Err(error).context("decode frame"),
    }
}

async fn write_msg<W, T>(writer: &Arc<Mutex<W>>, message: &T) -> Result<()>
where
    W: AsyncWrite + Unpin,
    T: Serialize,
{
    let mut writer = writer.lock().await;
    match write_framed::<BincodeFraming, _, _>(&mut *writer, message).await {
        Ok(()) => {}
        Err(WriteFrameError::Encode(error)) => return Err(error).context("encode frame"),
        Err(WriteFrameError::TooLarge(len)) => anyhow::bail!("frame too large: {len}"),
        Err(WriteFrameError::WriteLength(error)) => {
            return Err(error).context("write frame length");
        }
        Err(WriteFrameError::WritePayload(error)) => {
            return Err(error).context("write frame payload");
        }
    }
    writer.flush().await.context("flush frame")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::push::PushCommand;
    use shelly_protocol::{AgentSource, AgentState, ClientSize, SessionSummary};
    use std::collections::HashMap;
    use std::pin::Pin;
    use std::sync::Barrier;
    use std::task::{Context as TaskContext, Poll};
    use tokio::time::timeout;

    fn test_state() -> Arc<AppState> {
        AppState::for_tests()
    }

    fn test_state_with_push(push: PushDispatcher) -> Arc<AppState> {
        let devices = Arc::new(DashMap::new());
        let (session_list_tx, _) = watch::channel(Vec::new());
        Arc::new(AppState {
            sessions: DashMap::new(),
            restored: DashMap::new(),
            session_names: DashSet::new(),
            devices: Arc::clone(&devices),
            persistence: None,
            pairing: PairingManager::new(),
            push,
            session_list_tx,
            session_list_publish_pending: AtomicBool::new(false),
            device_revocations: DashMap::new(),
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

    #[tokio::test]
    async fn local_ipc_rejects_invalid_size_for_every_size_bearing_message() {
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

        let session_id = SessionId::new();
        let messages = [
            ClientToServerMsg::CreateSession {
                name: "invalid".to_string(),
                command: vec!["/bin/false".to_string()],
                cwd: std::env::current_dir().unwrap(),
                env: HashMap::new(),
                size: ClientSize { rows: 0, cols: 80 },
            },
            ClientToServerMsg::AttachSession {
                session_id,
                size: ClientSize {
                    rows: 24,
                    cols: 1_001,
                },
                last_seen_seq: None,
            },
            ClientToServerMsg::Resize {
                session_id,
                size: ClientSize {
                    rows: 1_001,
                    cols: 80,
                },
            },
        ];

        for message in messages {
            write_msg(&client_writer, &message).await.unwrap();
            let response: ServerToClientMsg = read_msg(&mut client_reader).await.unwrap();
            assert!(matches!(
                response,
                ServerToClientMsg::Error {
                    code: ErrorCode::InvalidRequest,
                    ..
                }
            ));
        }

        drop(client_writer);
        drop(client_reader);
        timeout(Duration::from_secs(2), server_task)
            .await
            .expect("IPC handler did not stop")
            .expect("IPC handler panicked")
            .expect("IPC handler failed");
    }

    #[derive(Default)]
    struct RecordingWriter {
        writes: Vec<Vec<u8>>,
        flushes: usize,
    }

    impl AsyncWrite for RecordingWriter {
        fn poll_write(
            mut self: Pin<&mut Self>,
            _cx: &mut TaskContext<'_>,
            buf: &[u8],
        ) -> Poll<std::io::Result<usize>> {
            self.writes.push(buf.to_vec());
            Poll::Ready(Ok(buf.len()))
        }

        fn poll_flush(
            mut self: Pin<&mut Self>,
            _cx: &mut TaskContext<'_>,
        ) -> Poll<std::io::Result<()>> {
            self.flushes += 1;
            Poll::Ready(Ok(()))
        }

        fn poll_shutdown(
            self: Pin<&mut Self>,
            _cx: &mut TaskContext<'_>,
        ) -> Poll<std::io::Result<()>> {
            Poll::Ready(Ok(()))
        }
    }

    #[tokio::test]
    async fn write_msg_writes_length_and_payload_before_flush() {
        let writer = Arc::new(Mutex::new(RecordingWriter::default()));

        write_msg(&writer, &ServerToClientMsg::Pong { seq: 7 })
            .await
            .unwrap();

        let writer = writer.lock().await;
        assert_eq!(writer.writes.len(), 2);
        let len = u32::from_be_bytes(writer.writes[0].as_slice().try_into().unwrap()) as usize;
        assert_eq!(len, writer.writes[1].len());
        assert_eq!(writer.flushes, 1);
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

        // Kill is acknowledged only after the daemon has committed removal.
        write_msg(
            &client_writer,
            &ClientToServerMsg::KillSession { session_id },
        )
        .await
        .unwrap();
        let killed: ServerToClientMsg = read_msg(&mut client_reader).await.unwrap();
        assert_eq!(killed, ServerToClientMsg::SessionKilled { session_id });

        // The acknowledgement is the transaction boundary; an immediate list
        // on the same stream must already reflect the committed state.
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
                kill_session_for(&state, session_id).unwrap();
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
                kill_session_for(&state, session_id).unwrap();
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

    #[test]
    fn session_name_reservations_are_atomic_and_release_on_drop() {
        let state = test_state();
        let barrier = Arc::new(Barrier::new(8));
        let mut workers = Vec::new();
        for _ in 0..8 {
            let state = Arc::clone(&state);
            let barrier = Arc::clone(&barrier);
            workers.push(std::thread::spawn(move || {
                barrier.wait();
                match reserve_new_session_name(&state, "atomic-name".to_string()) {
                    Ok(reservation) => {
                        reservation.commit();
                        true
                    }
                    Err(_) => false,
                }
            }));
        }

        let winners = workers
            .into_iter()
            .map(|worker| worker.join().expect("reservation worker panicked"))
            .filter(|won| *won)
            .count();
        assert_eq!(winners, 1);

        state.session_names.remove("atomic-name");
        {
            let _reservation = reserve_new_session_name(&state, "atomic-name".to_string()).unwrap();
        }
        assert!(!state.session_names.contains("atomic-name"));
    }

    #[test]
    fn failed_session_spawn_releases_name_reservation() {
        let state = test_state();
        let response = create_session_for(
            &state,
            ClientKind::LocalCli,
            "retryable".to_string(),
            Vec::new(),
            std::env::current_dir().expect("current dir"),
            HashMap::new(),
            ClientSize { rows: 24, cols: 80 },
        );

        assert!(matches!(response, ServerToClientMsg::Error { .. }));
        assert!(!state.session_names.contains("retryable"));
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

    #[tokio::test]
    async fn session_list_publish_requests_are_coalesced() {
        let state = test_state();
        let mut rx = state.subscribe_session_list();

        for _ in 0..20 {
            state.schedule_session_list_publish();
        }
        timeout(Duration::from_secs(1), rx.changed())
            .await
            .expect("coalesced session list was not published")
            .expect("session list publisher closed");
        rx.borrow_and_update();

        assert!(
            timeout(SESSION_LIST_PUBLISH_DEBOUNCE * 3, rx.changed())
                .await
                .is_err(),
            "duplicate session-list publish escaped the debounce window"
        );
    }

    #[tokio::test]
    async fn removing_device_revokes_live_iroh_watchers() {
        let state = test_state();
        state
            .save_device(StoredDevice::new(
                "Smoke Phone".to_string(),
                "device-node-a".to_string(),
            ))
            .unwrap();
        let mut revocation = state.subscribe_device_revocation("device-node-a");

        assert!(state.is_device_paired("device-node-a"));
        assert!(state.remove_device("Smoke Phone").unwrap().is_some());
        assert!(!state.is_device_paired("device-node-a"));
        timeout(Duration::from_secs(1), revocation.changed())
            .await
            .expect("device removal should notify live iroh watchers")
            .expect("revocation sender should stay alive");
        drop(revocation);
        assert!(state.device_revocations.is_empty());
    }

    #[test]
    fn revocation_registry_entry_is_removed_by_the_last_watcher() {
        let state = test_state();
        let first = state.subscribe_device_revocation("device-node-a");
        let second = first.clone();
        assert_eq!(state.device_revocations.len(), 1);

        drop(first);
        assert_eq!(state.device_revocations.len(), 1);
        drop(second);
        assert!(state.device_revocations.is_empty());
    }

    #[tokio::test]
    async fn naturally_exited_session_moves_to_restored_and_releases_live_model() {
        let state = test_state();
        let session = Session::spawn(
            "natural-exit".to_string(),
            vec![
                "/bin/sh".to_string(),
                "-c".to_string(),
                "printf 'retained scrollback'; exit 0".to_string(),
            ],
            std::env::current_dir().expect("current dir"),
            HashMap::new(),
            ClientSize { rows: 24, cols: 80 },
            None,
            None,
        )
        .expect("spawn naturally exiting session");
        let session_id = session.id();
        let weak_session = Arc::downgrade(&session);
        state.sessions.insert(session_id, Arc::clone(&session));
        spawn_session_list_forwarder(Arc::clone(&state), Arc::clone(&session));

        timeout(Duration::from_secs(5), async {
            loop {
                if !state.sessions.contains_key(&session_id)
                    && state.restored.contains_key(&session_id)
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("natural exit should be evicted into restored state");

        let restored = state.restored.get(&session_id).expect("restored session");
        assert_eq!(restored.exit_code, Some(0));
        assert!(
            restored
                .scrollback
                .windows(b"retained scrollback".len())
                .any(|window| window == b"retained scrollback")
        );
        drop(restored);
        drop(session);

        timeout(Duration::from_secs(2), async {
            while weak_session.upgrade().is_some() {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("live Session, ring, and terminal projection should be dropped");
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
