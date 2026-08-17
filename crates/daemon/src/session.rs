use crate::persistence::{Persistence, StoredSession};
use crate::push::PushDispatcher;
use crate::ring::PtyRingBuffer;
use crate::state_infer::{self, CommandKind};
use crate::terminal_model::{PtyResponseWriter, TerminalProjection, TerminalProjectionFailure};
use anyhow::{Context, Result, anyhow, bail};
use portable_pty::{Child, CommandBuilder, MasterPty, PtySize, native_pty_system};
use shelly_protocol::{
    AgentSource, AgentState, ClientId, ClientSize, ServerToClientMsg, SessionId, SessionSummary,
    now_ms,
};
use std::collections::HashMap;
use std::fmt;
use std::io;
use std::os::fd::RawFd;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, Weak, mpsc};
use std::time::Duration;
use tokio::sync::broadcast;

const RING_CAPACITY: usize = 256 * 1024;
const IDLE_AFTER_MS: u64 = 2_000;
const RESIZE_DEBOUNCE_MS: u64 = 100;
const PTY_WRITE_QUEUE_CAPACITY: usize = 64;
const PTY_POLL_TIMEOUT_MS: i32 = 100;
// Minimum continuous time in Working before a Working->Idle edge counts as a
// finished build worth a push; shorter bursts are trivial quick commands.
const BUILD_FINISHED_MIN_WORKING_MS: u64 = 5_000;

#[derive(Clone)]
pub(crate) struct PtyWriteSender {
    tx: mpsc::SyncSender<Vec<u8>>,
}

impl PtyWriteSender {
    fn new(tx: mpsc::SyncSender<Vec<u8>>) -> Self {
        Self { tx }
    }

    pub(crate) fn try_send(&self, bytes: &[u8]) -> std::result::Result<(), PtyWriteError> {
        if bytes.is_empty() {
            return Ok(());
        }
        self.tx
            .try_send(bytes.to_vec())
            .map_err(|error| match error {
                mpsc::TrySendError::Full(_) => PtyWriteError::Backpressure,
                mpsc::TrySendError::Disconnected(_) => PtyWriteError::Closed,
            })
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PtyWriteError {
    Backpressure,
    Closed,
}

impl fmt::Display for PtyWriteError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Backpressure => formatter.write_str("PTY input queue is full"),
            Self::Closed => formatter.write_str("PTY input channel is closed"),
        }
    }
}

impl std::error::Error for PtyWriteError {}

pub struct Session {
    id: SessionId,
    name: String,
    command: Vec<String>,
    command_kind: CommandKind,
    cwd: PathBuf,
    created_at: u64,
    last_activity: Mutex<u64>,
    state: Mutex<AgentState>,
    working_since: Mutex<Option<u64>>,
    exit_code: Mutex<Option<i32>>,
    last_line: Mutex<Option<String>>,
    ring: Mutex<PtyRingBuffer>,
    child: Mutex<Box<dyn Child + Send + Sync>>,
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: PtyWriteSender,
    io_shutdown: AtomicBool,
    io_thread_running: Arc<AtomicBool>,
    process_group: Option<libc::pid_t>,
    terminal: Mutex<TerminalProjection>,
    attached_sizes: Mutex<HashMap<ClientId, ClientSize>>,
    subscribers: broadcast::Sender<ServerToClientMsg>,
    summary_updates: broadcast::Sender<bool>,
    persistence: Option<Arc<Persistence>>,
    push: Option<PushDispatcher>,
    persist_dirty: AtomicBool,
    killed: AtomicBool,
    resize_tx: mpsc::Sender<()>,
}

impl Session {
    pub fn spawn(
        name: String,
        command: Vec<String>,
        cwd: PathBuf,
        env: HashMap<String, String>,
        size: ClientSize,
        persistence: Option<Arc<Persistence>>,
        push: Option<PushDispatcher>,
    ) -> Result<Arc<Self>> {
        if command.is_empty() {
            bail!("session command must not be empty");
        }

        let id = SessionId::new();
        let command_kind = state_infer::classify(&command);
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: size.rows,
                cols: size.cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .context("open PTY")?;

        let mut builder = CommandBuilder::new(&command[0]);
        for arg in &command[1..] {
            builder.arg(arg);
        }
        builder.cwd(&cwd);
        builder.env("TERM", "xterm-256color");
        builder.env("COLORTERM", "truecolor");
        builder.env("SHELLY_SESSION_ID", id.to_string());
        for (key, value) in env {
            builder.env(key, value);
        }

        let child = pair
            .slave
            .spawn_command(builder)
            .context("spawn PTY command")?;
        drop(pair.slave);

        let pty_fd = pair
            .master
            .as_raw_fd()
            .context("PTY master does not expose a file descriptor")?;
        set_nonblocking(pty_fd).context("set PTY master non-blocking")?;
        let process_group = pair.master.process_group_leader();
        let (writer_tx, writer_rx) = mpsc::sync_channel(PTY_WRITE_QUEUE_CAPACITY);
        let writer = PtyWriteSender::new(writer_tx);
        let (subscribers, _) = broadcast::channel(1024);
        let (summary_updates, _) = broadcast::channel(128);
        let (resize_tx, resize_rx) = mpsc::channel();
        let terminal =
            TerminalProjection::new(size, Box::new(PtyResponseWriter::new(writer.clone())));
        let session = Arc::new(Self {
            id,
            name,
            command,
            command_kind,
            cwd,
            created_at: now_ms(),
            last_activity: Mutex::new(now_ms()),
            state: Mutex::new(AgentState::Idle),
            working_since: Mutex::new(None),
            exit_code: Mutex::new(None),
            last_line: Mutex::new(None),
            ring: Mutex::new(PtyRingBuffer::new(RING_CAPACITY)),
            child: Mutex::new(child),
            master: Mutex::new(pair.master),
            writer,
            io_shutdown: AtomicBool::new(false),
            io_thread_running: Arc::new(AtomicBool::new(true)),
            process_group,
            terminal: Mutex::new(terminal),
            attached_sizes: Mutex::new(HashMap::new()),
            subscribers,
            summary_updates,
            persistence,
            push,
            persist_dirty: AtomicBool::new(false),
            killed: AtomicBool::new(false),
            resize_tx,
        });

        Self::start_pty_io(Arc::clone(&session), pty_fd, writer_rx)?;
        Self::start_idle_loop(Arc::downgrade(&session))?;
        Self::start_resize_loop(Arc::downgrade(&session), resize_rx)?;
        session.persist_dirty.store(true, Ordering::Release);
        Self::start_persistence_loop(Arc::downgrade(&session))?;
        Ok(session)
    }

    pub fn id(&self) -> SessionId {
        self.id
    }

    pub(crate) fn name(&self) -> &str {
        &self.name
    }

    pub fn summary(&self) -> SessionSummary {
        if let Some(line) = self.materialize_terminal_last_line() {
            *self.last_line.lock().expect("last_line lock poisoned") = Some(line);
        }
        self.cached_summary()
    }

    fn cached_summary(&self) -> SessionSummary {
        SessionSummary {
            id: self.id,
            name: self.name.clone(),
            command: self.command.clone(),
            cwd: self.cwd.clone(),
            created_at: self.created_at,
            last_activity: *self
                .last_activity
                .lock()
                .expect("last_activity lock poisoned"),
            state: *self.state.lock().expect("state lock poisoned"),
            last_line: self
                .last_line
                .lock()
                .expect("last_line lock poisoned")
                .clone(),
            model: None,
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<ServerToClientMsg> {
        self.subscribers.subscribe()
    }

    pub fn subscribe_summary_updates(&self) -> broadcast::Receiver<bool> {
        self.summary_updates.subscribe()
    }

    pub fn attach_bytes(&self, last_seen_seq: Option<u64>) -> (u64, Vec<u8>) {
        let (end_seq, raw_scrollback, snapshot) = {
            let ring = self.ring.lock().expect("ring lock poisoned");
            if let Some(seq) = last_seen_seq
                && let Some((start_seq, replay)) = ring.replay_from(seq)
            {
                return (start_seq.saturating_add(replay.len() as u64), replay);
            }
            let (_, raw_scrollback) = ring.snapshot();
            let mut terminal = self
                .terminal
                .lock()
                .expect("terminal projection lock poisoned");
            let snapshot = terminal.snapshot();
            let end_seq = ring.end_seq();
            (end_seq, raw_scrollback, snapshot)
        };

        match snapshot {
            Ok(snapshot) => (end_seq, snapshot),
            Err(failure) => {
                self.log_projection_failure(failure, "render attach snapshot");
                if failure.invalidated_model() {
                    self.rebuild_terminal_projection(&raw_scrollback);
                    let rebuilt = self
                        .terminal
                        .lock()
                        .expect("terminal projection lock poisoned")
                        .snapshot()
                        .unwrap_or(raw_scrollback);
                    (end_seq, rebuilt)
                } else {
                    (end_seq, raw_scrollback)
                }
            }
        }
    }

    pub fn attach_client(
        self: &Arc<Self>,
        client_id: ClientId,
        size: ClientSize,
    ) -> Result<AttachedClient> {
        self.attached_sizes
            .lock()
            .map_err(|_| anyhow!("attached size lock poisoned"))?
            .insert(client_id, size);
        self.apply_min_attached_resize()?;
        Ok(AttachedClient {
            session: Arc::clone(self),
            client_id,
        })
    }

    pub fn update_client_size(
        self: &Arc<Self>,
        client_id: ClientId,
        size: ClientSize,
    ) -> Result<()> {
        let mut sizes = self
            .attached_sizes
            .lock()
            .map_err(|_| anyhow!("attached size lock poisoned"))?;
        if let Some(current) = sizes.get_mut(&client_id) {
            *current = size;
        }
        drop(sizes);
        self.schedule_min_attached_resize();
        Ok(())
    }

    pub fn exit_code(&self) -> Option<i32> {
        *self.exit_code.lock().expect("exit_code lock poisoned")
    }

    pub fn write_input(&self, bytes: &[u8]) -> std::result::Result<(), PtyWriteError> {
        self.writer.try_send(bytes)?;
        if self.exit_code().is_none() {
            self.set_state(AgentState::Working, None);
        }
        Ok(())
    }

    pub fn resize(&self, size: ClientSize) -> Result<()> {
        let master = self
            .master
            .lock()
            .map_err(|_| anyhow!("PTY master lock poisoned"))?;
        master
            .resize(PtySize {
                rows: size.rows,
                cols: size.cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .context("resize PTY")?;
        let projection_resize = self
            .terminal
            .lock()
            .map_err(|_| anyhow!("terminal projection lock poisoned"))?
            .resize(size);
        if let Err(failure) = projection_resize {
            self.log_projection_failure(failure, "resize terminal projection");
            self.rebuild_terminal_projection_from_ring();
        }
        Ok(())
    }

    pub fn kill(&self) -> Result<()> {
        self.killed.store(true, Ordering::Release);
        let primary_result = match self.child.lock() {
            Ok(mut child) => match child.try_wait().context("check PTY child status") {
                Ok(Some(_)) => Ok(()),
                Ok(None) => child.kill().context("kill PTY child"),
                Err(error) => Err(error),
            },
            Err(_) => Err(anyhow!("PTY child lock poisoned")),
        };
        // portable-pty creates the child as a new session/process-group leader.
        // Signal the whole group after the primary child kill so grandchildren
        // cannot keep the PTY open and strand the I/O thread.
        self.signal_process_group();
        self.io_shutdown.store(true, Ordering::Release);
        primary_result
    }

    pub fn apply_agent_state_event(
        &self,
        source: AgentSource,
        state: AgentState,
        last_line: Option<String>,
    ) -> Result<Option<String>> {
        if self.exit_code().is_some() {
            tracing::warn!(
                session_id = %self.id,
                ?source,
                "ignoring agent state event for exited session"
            );
            bail!("session has exited: {}", self.id);
        }

        let source_matches_command = matches!(
            (source, self.command_kind),
            (AgentSource::Claude, CommandKind::Claude) | (AgentSource::Codex, CommandKind::Codex)
        ) || self.command_kind == CommandKind::Unknown;
        if !source_matches_command {
            tracing::warn!(
                session_id = %self.id,
                ?source,
                ?self.command_kind,
                "ignoring mismatched agent state event"
            );
            bail!(
                "agent hook source {source:?} does not match session command {:?}",
                self.command_kind
            );
        }

        let last_line = last_line.map(|line| line.chars().take(80).collect::<String>());
        if let Some(line) = last_line.clone() {
            *self.last_line.lock().expect("last_line lock poisoned") = Some(line.clone());
            self.terminal
                .lock()
                .expect("terminal projection lock poisoned")
                .cache_last_non_empty_line(line, 80);
        }
        self.set_state(state, last_line);
        self.persist_dirty.store(true, Ordering::Release);
        Ok(self
            .last_line
            .lock()
            .expect("last_line lock poisoned")
            .clone())
    }

    fn start_pty_io(
        session: Arc<Self>,
        pty_fd: RawFd,
        writer_rx: mpsc::Receiver<Vec<u8>>,
    ) -> Result<()> {
        let running = Arc::clone(&session.io_thread_running);
        let running_on_spawn_failure = Arc::clone(&running);
        if let Err(error) = std::thread::Builder::new()
            .name(format!("shelly-pty-{}", session.id))
            .spawn(move || run_pty_io(session, pty_fd, writer_rx, running))
        {
            // The flag is set before spawning so tests cannot race a very short-lived child.
            // Clear it if the OS rejected the thread creation.
            //
            // The receiver is dropped with the failed closure, causing subsequent writes to
            // report a typed Closed error rather than blocking.
            running_on_spawn_failure.store(false, Ordering::Release);
            return Err(error).context("spawn PTY I/O thread");
        }
        Ok(())
    }

    fn reap_exit_code(&self, fallback: i32) -> i32 {
        for attempt in 0..40 {
            if attempt > 0 {
                std::thread::sleep(Duration::from_millis(50));
            }
            let status = self
                .child
                .lock()
                .expect("PTY child lock poisoned")
                .try_wait();
            match status {
                Ok(Some(status)) => return status.exit_code() as i32,
                Ok(None) => {}
                Err(_) => return fallback,
            }
        }
        fallback
    }

    fn start_idle_loop(session: Weak<Self>) -> Result<()> {
        let session_id = session
            .upgrade()
            .context("session dropped before idle loop")?
            .id;
        std::thread::Builder::new()
            .name(format!("shelly-idle-{session_id}"))
            .spawn(move || {
                loop {
                    std::thread::sleep(Duration::from_millis(500));
                    let Some(session) = session.upgrade() else {
                        break;
                    };
                    if session.exit_code().is_some() {
                        break;
                    }

                    let last_activity = *session
                        .last_activity
                        .lock()
                        .expect("last_activity lock poisoned");
                    let idle_for = now_ms().saturating_sub(last_activity);
                    let current = *session.state.lock().expect("state lock poisoned");
                    if idle_for >= IDLE_AFTER_MS
                        && current != AgentState::Idle
                        && current != AgentState::AwaitingInput
                    {
                        session.set_state(AgentState::Idle, None);
                    }
                }
            })
            .context("spawn idle inference thread")?;
        Ok(())
    }

    fn start_persistence_loop(session: Weak<Self>) -> Result<()> {
        let Some(initial) = session.upgrade() else {
            return Ok(());
        };
        if initial.persistence.is_none() {
            return Ok(());
        }
        let session_id = initial.id;
        drop(initial);

        std::thread::Builder::new()
            .name(format!("shelly-persist-{session_id}"))
            .spawn(move || {
                loop {
                    let Some(session) = session.upgrade() else {
                        break;
                    };
                    session.flush_dirty_persistence();
                    if session.exit_code().is_some() {
                        break;
                    }
                    drop(session);
                    std::thread::sleep(Duration::from_secs(30));
                }
            })
            .context("spawn persistence thread")?;
        Ok(())
    }

    fn start_resize_loop(session: Weak<Self>, rx: mpsc::Receiver<()>) -> Result<()> {
        let session_id = session
            .upgrade()
            .context("session dropped before resize loop")?
            .id;
        std::thread::Builder::new()
            .name(format!("shelly-resize-{session_id}"))
            .spawn(move || {
                loop {
                    match rx.recv_timeout(Duration::from_millis(500)) {
                        Ok(()) => {}
                        Err(mpsc::RecvTimeoutError::Timeout) => {
                            let Some(session) = session.upgrade() else {
                                break;
                            };
                            if session.exit_code().is_some() {
                                break;
                            }
                            continue;
                        }
                        Err(mpsc::RecvTimeoutError::Disconnected) => break,
                    }
                    while rx
                        .recv_timeout(Duration::from_millis(RESIZE_DEBOUNCE_MS))
                        .is_ok()
                    {}
                    let Some(session) = session.upgrade() else {
                        break;
                    };
                    if session.exit_code().is_some() {
                        break;
                    }
                    if let Err(error) = session.apply_min_attached_resize() {
                        tracing::warn!(
                            %error,
                            session_id = %session.id,
                            "failed to apply debounced resize"
                        );
                    }
                }
            })
            .context("spawn resize debounce thread")?;
        Ok(())
    }

    fn record_output(&self, bytes: &[u8]) {
        let (seq, projection_update) = {
            let mut ring = self.ring.lock().expect("ring lock poisoned");
            let mut terminal = self
                .terminal
                .lock()
                .expect("terminal projection lock poisoned");
            let seq = ring.push(bytes).saturating_add(bytes.len() as u64);
            (seq, terminal.ingest(bytes))
        };
        // The terminal model is a derived projection. Raw capture and fan-out must
        // continue even if a TUI exposes a parser bug in that projection.
        match projection_update {
            Ok(()) => {}
            Err(failure) => {
                self.log_projection_failure(failure, "ingest PTY output");
                if failure.invalidated_model() {
                    self.rebuild_terminal_projection_from_ring();
                }
            }
        }
        *self
            .last_activity
            .lock()
            .expect("last_activity lock poisoned") = now_ms();

        // Any PTY output means the child produced bytes, so default to Working.
        let mut inferred_state = AgentState::Working;
        let last_line = (self.command_kind != CommandKind::Unknown)
            .then(|| self.materialize_terminal_last_line())
            .flatten();
        if let Some(line) = &last_line {
            *self.last_line.lock().expect("last_line lock poisoned") = Some(line.clone());
            match self.command_kind {
                CommandKind::Claude => {
                    if let Some(state) = state_infer::claude::infer_from_line(line) {
                        inferred_state = state;
                    }
                }
                CommandKind::Codex => {
                    if let Some(state) = state_infer::codex::infer_from_json_line(line) {
                        inferred_state = state;
                    }
                }
                CommandKind::Unknown => {}
            }
        }

        if inferred_state != AgentState::Idle {
            self.set_state(inferred_state, last_line);
        }

        let _ = self.subscribers.send(ServerToClientMsg::Output {
            session_id: self.id,
            seq,
            bytes: Arc::from(bytes),
        });
        self.persist_dirty.store(true, Ordering::Release);
    }

    fn materialize_terminal_last_line(&self) -> Option<String> {
        match self
            .terminal
            .lock()
            .expect("terminal projection lock poisoned")
            .last_non_empty_line(80)
        {
            Ok(last_line) => last_line,
            Err(failure) => {
                self.log_projection_failure(failure, "inspect terminal last line");
                None
            }
        }
    }

    fn rebuild_terminal_projection_from_ring(&self) {
        let (_, scrollback) = self.ring.lock().expect("ring lock poisoned").snapshot();
        self.rebuild_terminal_projection(&scrollback);
    }

    fn rebuild_terminal_projection(&self, scrollback: &[u8]) {
        let writer = Box::new(PtyResponseWriter::new(self.writer.clone()));
        match self
            .terminal
            .lock()
            .expect("terminal projection lock poisoned")
            .rebuild(scrollback, writer)
        {
            Ok(()) => {
                tracing::info!(session_id = %self.id, "rebuilt terminal projection from raw scrollback");
            }
            Err(failure) => {
                self.log_projection_failure(failure, "rebuild terminal projection");
            }
        }
    }

    fn log_projection_failure(&self, failure: TerminalProjectionFailure, operation: &'static str) {
        tracing::warn!(
            session_id = %self.id,
            ?failure,
            operation,
            "terminal projection failed; raw PTY transport remains active"
        );
    }

    fn set_state(&self, state: AgentState, last_line: Option<String>) {
        let mut current = self.state.lock().expect("state lock poisoned");
        let previous = *current;
        if previous == state {
            return;
        }
        *current = state;

        // Track how long the session has been continuously Working so a
        // Working->Idle edge can tell a real build from a trivial quick command.
        let build_finished = {
            let mut working_since = self
                .working_since
                .lock()
                .expect("working_since lock poisoned");
            let finished = previous == AgentState::Working
                && state == AgentState::Idle
                && working_since.is_some_and(|since| {
                    now_ms().saturating_sub(since) >= BUILD_FINISHED_MIN_WORKING_MS
                });
            *working_since = (state == AgentState::Working).then(now_ms);
            finished
        };

        let _ = self.subscribers.send(ServerToClientMsg::AgentStateChanged {
            session_id: self.id,
            state,
            last_line,
        });
        let _ = self.summary_updates.send(false);
        if let Some(push) = &self.push {
            if state == AgentState::AwaitingInput {
                push.awaiting_input(self.id, self.name.clone());
            } else if build_finished {
                push.build_finished(self.id, self.name.clone());
            }
        }
    }

    fn mark_exited(&self, exit_code: i32) {
        let mut stored_exit_code = self.exit_code.lock().expect("exit_code lock poisoned");
        if stored_exit_code.is_some() {
            return;
        }
        *stored_exit_code = Some(exit_code);
        drop(stored_exit_code);
        *self.state.lock().expect("state lock poisoned") = if exit_code == 0 {
            AgentState::Idle
        } else {
            AgentState::Crashed
        };
        let _ = self.subscribers.send(ServerToClientMsg::SessionExited {
            session_id: self.id,
            exit_code,
        });
        // A non-zero exit is a crash/failure worth a push; a clean exit (code 0) is
        // a normal logout, and an explicit kill must not masquerade as a crash.
        if exit_code != 0
            && !self.killed.load(Ordering::Acquire)
            && let Some(push) = &self.push
        {
            push.session_crashed(self.id, self.name.clone());
        }
        self.persist_dirty.store(false, Ordering::Release);
        if !self.persist() {
            self.persist_dirty.store(true, Ordering::Release);
        }
        // Persistence and the final StoredSession snapshot must be complete before
        // the registry observer evicts the live ring and terminal projection.
        let _ = self.summary_updates.send(true);
    }

    fn persist(&self) -> bool {
        if self.killed.load(Ordering::Acquire) {
            return true;
        }
        let Some(persistence) = &self.persistence else {
            return true;
        };
        let snapshot = self.stored_snapshot();
        if let Err(error) = persistence.save_session(&snapshot) {
            tracing::warn!(%error, session_id = %self.id, "failed to persist session");
            return false;
        }
        true
    }

    pub(crate) fn flush_dirty_persistence(&self) {
        if self.persist_dirty.swap(false, Ordering::AcqRel) && !self.persist() {
            self.persist_dirty.store(true, Ordering::Release);
        }
    }

    fn stored_snapshot(&self) -> StoredSession {
        let (scrollback_start_seq, scrollback) =
            self.ring.lock().expect("ring lock poisoned").snapshot();
        StoredSession {
            summary: self.cached_summary(),
            scrollback_start_seq,
            scrollback,
            exit_code: self.exit_code(),
        }
    }

    pub(crate) fn capture_stored(&self) -> StoredSession {
        self.stored_snapshot()
    }

    pub(crate) fn was_killed(&self) -> bool {
        self.killed.load(Ordering::Acquire)
    }

    fn signal_process_group(&self) {
        let Some(process_group) = self.process_group.filter(|pid| *pid > 0) else {
            return;
        };
        let result = unsafe { libc::kill(-process_group, libc::SIGKILL) };
        if result == -1 {
            let error = io::Error::last_os_error();
            if error.raw_os_error() != Some(libc::ESRCH) {
                tracing::warn!(%error, process_group, session_id = %self.id, "failed to signal PTY process group");
            }
        }
    }

    #[cfg(test)]
    pub(crate) fn pty_fd_for_test(&self) -> RawFd {
        self.master
            .lock()
            .expect("PTY master lock poisoned")
            .as_raw_fd()
            .expect("test PTY master fd")
    }

    #[cfg(test)]
    pub(crate) fn io_thread_running_for_test(&self) -> bool {
        self.io_thread_running.load(Ordering::Acquire)
    }

    fn detach_client(self: &Arc<Self>, client_id: ClientId) {
        match self.attached_sizes.lock() {
            Ok(mut sizes) => {
                sizes.remove(&client_id);
            }
            Err(_) => {
                tracing::warn!(client_id = %client_id.0, "attached size lock poisoned during detach");
                return;
            }
        }
        self.schedule_min_attached_resize();
    }

    fn apply_min_attached_resize(&self) -> Result<()> {
        let size = {
            let sizes = self
                .attached_sizes
                .lock()
                .map_err(|_| anyhow!("attached size lock poisoned"))?;
            min_client_size(sizes.values().copied())
        };

        if let Some(size) = size {
            self.resize(size)?;
        }
        Ok(())
    }

    fn schedule_min_attached_resize(&self) {
        let _ = self.resize_tx.send(());
    }
}

fn set_nonblocking(fd: RawFd) -> io::Result<()> {
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags == -1 {
        return Err(io::Error::last_os_error());
    }
    if unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } == -1 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

struct IoThreadRunningGuard(Arc<AtomicBool>);

impl Drop for IoThreadRunningGuard {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

fn run_pty_io(
    session: Arc<Session>,
    pty_fd: RawFd,
    writer_rx: mpsc::Receiver<Vec<u8>>,
    running: Arc<AtomicBool>,
) {
    let _running_guard = IoThreadRunningGuard(running);
    let mut pending_write: Option<(Vec<u8>, usize)> = None;

    loop {
        if session.io_shutdown.load(Ordering::Acquire) {
            session.mark_exited(session.reap_exit_code(0));
            break;
        }

        if pending_write.is_none()
            && let Ok(bytes) = writer_rx.try_recv()
        {
            pending_write = Some((bytes, 0));
        }

        if let Some(exit_code) = try_child_exit_code(&session) {
            let _ = drain_pty_output(&session, pty_fd);
            session.mark_exited(exit_code);
            break;
        }

        let mut poll_fd = libc::pollfd {
            fd: pty_fd,
            events: libc::POLLIN
                | if pending_write.is_some() {
                    libc::POLLOUT
                } else {
                    0
                },
            revents: 0,
        };
        let poll_result = unsafe { libc::poll(&mut poll_fd, 1, PTY_POLL_TIMEOUT_MS) };
        if poll_result == -1 {
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            tracing::warn!(%error, session_id = %session.id, "PTY poll failed");
            session.mark_exited(session.reap_exit_code(1));
            break;
        }
        if poll_result == 0 {
            continue;
        }

        let read_events = libc::POLLIN | libc::POLLHUP | libc::POLLERR | libc::POLLNVAL;
        if poll_fd.revents & read_events != 0
            && drain_pty_output(&session, pty_fd) == PtyReadState::Closed
        {
            session.mark_exited(session.reap_exit_code(0));
            break;
        }

        if poll_fd.revents & libc::POLLOUT != 0
            && let Some((bytes, offset)) = pending_write.as_mut()
        {
            let remaining = &bytes[*offset..];
            let written = unsafe {
                libc::write(
                    pty_fd,
                    remaining.as_ptr().cast::<libc::c_void>(),
                    remaining.len(),
                )
            };
            if written > 0 {
                *offset += written as usize;
                if *offset == bytes.len() {
                    pending_write = None;
                }
            } else if written == -1 {
                let error = io::Error::last_os_error();
                if !matches!(
                    error.kind(),
                    io::ErrorKind::Interrupted | io::ErrorKind::WouldBlock
                ) {
                    tracing::debug!(%error, session_id = %session.id, "PTY write failed");
                    session.mark_exited(session.reap_exit_code(1));
                    break;
                }
            }
        }
    }
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum PtyReadState {
    Open,
    Closed,
}

fn drain_pty_output(session: &Session, pty_fd: RawFd) -> PtyReadState {
    let mut buffer = [0_u8; 8192];
    // Bound each readiness turn so a continuously-chatty child cannot starve queued input.
    for _ in 0..64 {
        let read = unsafe {
            libc::read(
                pty_fd,
                buffer.as_mut_ptr().cast::<libc::c_void>(),
                buffer.len(),
            )
        };
        if read > 0 {
            session.record_output(&buffer[..read as usize]);
            continue;
        }
        if read == 0 {
            return PtyReadState::Closed;
        }

        let error = io::Error::last_os_error();
        match error.kind() {
            io::ErrorKind::Interrupted => continue,
            io::ErrorKind::WouldBlock => return PtyReadState::Open,
            _ => return PtyReadState::Closed,
        }
    }
    PtyReadState::Open
}

fn try_child_exit_code(session: &Session) -> Option<i32> {
    match session
        .child
        .lock()
        .expect("PTY child lock poisoned")
        .try_wait()
    {
        Ok(Some(status)) => Some(status.exit_code() as i32),
        Ok(None) => None,
        Err(error) => {
            tracing::warn!(%error, session_id = %session.id, "failed to query PTY child status");
            Some(1)
        }
    }
}

pub struct AttachedClient {
    session: Arc<Session>,
    client_id: ClientId,
}

impl Drop for AttachedClient {
    fn drop(&mut self) {
        self.session.detach_client(self.client_id);
    }
}

fn min_client_size(sizes: impl IntoIterator<Item = ClientSize>) -> Option<ClientSize> {
    sizes.into_iter().reduce(|min, size| ClientSize {
        cols: min.cols.min(size.cols),
        rows: min.rows.min(size.rows),
    })
}

#[cfg(test)]
mod handoff_tests {
    use super::{BUILD_FINISHED_MIN_WORKING_MS, PtyWriteError, Session};
    use shelly_protocol::{
        AgentSource, AgentState, ClientId, ClientSize, ServerToClientMsg, now_ms,
    };
    use std::collections::HashMap;
    use std::path::{Path, PathBuf};
    use std::sync::Arc;
    use std::time::{Duration, Instant};
    use tokio::sync::broadcast;
    use tokio::time::timeout;

    #[tokio::test]
    async fn attached_clients_share_pty_output_from_any_input_writer() {
        let cwd = tempfile::tempdir().expect("tempdir");
        let size = ClientSize { cols: 80, rows: 24 };
        let session = Session::spawn(
            "multi-client".to_string(),
            vec![
                "sh".to_string(),
                "-c".to_string(),
                "while IFS= read -r line; do printf 'shelly:%s\\n' \"$line\"; done".to_string(),
            ],
            cwd.path().to_path_buf(),
            HashMap::new(),
            size,
            None,
            None,
        )
        .expect("spawn shell session");
        let _kill_on_drop = KillOnDrop(Arc::clone(&session));

        let _first = session
            .attach_client(
                ClientId::new(),
                ClientSize {
                    cols: 100,
                    rows: 30,
                },
            )
            .expect("attach first client");
        let _second = session
            .attach_client(ClientId::new(), ClientSize { cols: 80, rows: 24 })
            .expect("attach second client");
        let mut first_rx = session.subscribe();
        let mut second_rx = session.subscribe();

        session
            .write_input(b"shared-input\n")
            .expect("write input through attached session");

        let first_output = collect_until_marker(&mut first_rx, b"shelly:shared-input").await;
        let second_output = collect_until_marker(&mut second_rx, b"shelly:shared-input").await;
        assert!(
            first_output
                .windows(b"shared-input".len())
                .any(|window| window == b"shared-input")
        );
        assert!(
            second_output
                .windows(b"shared-input".len())
                .any(|window| window == b"shared-input")
        );
    }

    #[tokio::test]
    async fn stuck_child_backpressures_without_blocking_or_false_exit_and_releases_pty() {
        let cwd = tempfile::tempdir().expect("tempdir");
        let size = ClientSize { cols: 80, rows: 24 };
        let stuck = Session::spawn(
            "stuck-reader".to_string(),
            vec![
                "/bin/sh".to_string(),
                "-c".to_string(),
                "trap '' HUP TERM; while :; do sleep 60; done".to_string(),
            ],
            cwd.path().to_path_buf(),
            HashMap::new(),
            size,
            None,
            None,
        )
        .expect("spawn child that never reads PTY input");
        let responsive = Session::spawn(
            "responsive-reader".to_string(),
            vec![
                "/bin/sh".to_string(),
                "-c".to_string(),
                "while IFS= read -r line; do printf 'responsive:%s\\n' \"$line\"; done".to_string(),
            ],
            cwd.path().to_path_buf(),
            HashMap::new(),
            size,
            None,
            None,
        )
        .expect("spawn responsive session");
        let _responsive_kill = KillOnDrop(Arc::clone(&responsive));

        let payload = vec![b'x'; 32 * 1024];
        let mut saw_backpressure = false;
        for _ in 0..10_000 {
            match stuck.write_input(&payload) {
                Ok(()) => {}
                Err(PtyWriteError::Backpressure) => {
                    saw_backpressure = true;
                    break;
                }
                Err(error) => panic!("unexpected stuck-child write error: {error}"),
            }
        }
        assert!(
            saw_backpressure,
            "bounded PTY queue never reported backpressure"
        );

        tokio::time::sleep(Duration::from_millis(250)).await;
        assert_eq!(
            stuck.exit_code(),
            None,
            "EWOULDBLOCK must not be mistaken for PTY exit"
        );
        assert!(stuck.io_thread_running_for_test());

        let mut responsive_rx = responsive.subscribe();
        responsive
            .write_input(b"still-live\n")
            .expect("another session remains writable");
        let output = collect_until_marker(&mut responsive_rx, b"responsive:still-live").await;
        assert!(
            output
                .windows(b"responsive:still-live".len())
                .any(|window| window == b"responsive:still-live")
        );

        let pty_fd = stuck.pty_fd_for_test();
        let weak_stuck = Arc::downgrade(&stuck);
        stuck.kill().expect("kill stuck PTY process group");
        timeout(Duration::from_secs(5), async {
            while stuck.io_thread_running_for_test() {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("PTY I/O thread should stop after kill");
        drop(stuck);
        timeout(Duration::from_secs(2), async {
            while weak_stuck.upgrade().is_some() {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("stuck session should release its PTY owner");

        assert_eq!(unsafe { libc::fcntl(pty_fd, libc::F_GETFD) }, -1);
        assert_eq!(
            std::io::Error::last_os_error().raw_os_error(),
            Some(libc::EBADF)
        );
    }

    #[tokio::test]
    async fn matching_local_agent_hook_updates_session_state() {
        let cwd = tempfile::tempdir().expect("tempdir");
        let command = write_sleeping_stub(cwd.path(), "claude");
        let size = ClientSize { cols: 80, rows: 24 };
        let session = Session::spawn(
            "claude-hook".to_string(),
            vec![command.to_string_lossy().into_owned()],
            cwd.path().to_path_buf(),
            HashMap::new(),
            size,
            None,
            None,
        )
        .expect("spawn claude stub session");
        let _kill_on_drop = KillOnDrop(Arc::clone(&session));
        let mut rx = session.subscribe();

        let long_line = "x".repeat(120);
        session
            .apply_agent_state_event(
                AgentSource::Claude,
                AgentState::AwaitingInput,
                Some(long_line),
            )
            .expect("matching local agent hook applies");

        let summary = session.summary();
        assert_eq!(summary.state, AgentState::AwaitingInput);
        assert_eq!(
            summary
                .last_line
                .expect("last line captured")
                .chars()
                .count(),
            80
        );
        assert_agent_state_changed(&mut rx, AgentState::AwaitingInput).await;
    }

    #[tokio::test]
    async fn generic_shelly_session_accepts_local_agent_hook_state() {
        let cwd = tempfile::tempdir().expect("tempdir");
        let command = write_sleeping_stub(cwd.path(), "bash");
        let size = ClientSize { cols: 80, rows: 24 };
        let session = Session::spawn(
            "agent-agnostic".to_string(),
            vec![command.to_string_lossy().into_owned()],
            cwd.path().to_path_buf(),
            HashMap::new(),
            size,
            None,
            None,
        )
        .expect("spawn generic shell session");
        let _kill_on_drop = KillOnDrop(Arc::clone(&session));
        let mut rx = session.subscribe();

        session
            .apply_agent_state_event(
                AgentSource::Claude,
                AgentState::AwaitingInput,
                Some("Continue?".to_string()),
            )
            .expect("agent hook applies inside generic session");

        let summary = session.summary();
        assert_eq!(summary.state, AgentState::AwaitingInput);
        assert_eq!(summary.last_line.as_deref(), Some("Continue?"));
        assert_agent_state_changed(&mut rx, AgentState::AwaitingInput).await;
    }

    #[tokio::test]
    async fn mismatched_local_agent_hook_is_rejected() {
        let cwd = tempfile::tempdir().expect("tempdir");
        let command = write_sleeping_stub(cwd.path(), "codex");
        let size = ClientSize { cols: 80, rows: 24 };
        let session = Session::spawn(
            "codex-hook".to_string(),
            vec![command.to_string_lossy().into_owned()],
            cwd.path().to_path_buf(),
            HashMap::new(),
            size,
            None,
            None,
        )
        .expect("spawn codex stub session");
        let _kill_on_drop = KillOnDrop(Arc::clone(&session));

        let error = session
            .apply_agent_state_event(
                AgentSource::Claude,
                AgentState::AwaitingInput,
                Some("wrong agent".to_string()),
            )
            .expect_err("mismatched local agent hook is rejected");
        assert!(error.to_string().contains("does not match"));

        let summary = session.summary();
        assert_eq!(summary.state, AgentState::Idle);
        assert_eq!(summary.last_line, None);
    }

    #[tokio::test]
    async fn unknown_command_prompt_shaped_output_never_becomes_awaiting_input() {
        let cwd = tempfile::tempdir().expect("tempdir");
        let command = write_sleeping_stub(cwd.path(), "bash");
        let size = ClientSize { cols: 80, rows: 24 };
        let session = Session::spawn(
            "unknown-command".to_string(),
            vec![command.to_string_lossy().into_owned()],
            cwd.path().to_path_buf(),
            HashMap::new(),
            size,
            None,
            None,
        )
        .expect("spawn unknown command session");
        let _kill_on_drop = KillOnDrop(Arc::clone(&session));
        let mut rx = session.subscribe();

        session.record_output(b"Do you want to continue? [y/n]\n{\"type\":\"awaiting_input\"}\n");

        let mut saw_working = false;
        loop {
            match rx.try_recv() {
                Ok(ServerToClientMsg::AgentStateChanged { state, .. }) => {
                    assert_ne!(state, AgentState::AwaitingInput);
                    if state == AgentState::Working {
                        saw_working = true;
                    }
                }
                Ok(ServerToClientMsg::Output { .. }) => {}
                Ok(message) => panic!("unexpected message: {message:?}"),
                Err(broadcast::error::TryRecvError::Empty) => break,
                Err(error) => panic!("unexpected broadcast receive error: {error}"),
            }
        }

        assert!(saw_working);
        assert_eq!(session.summary().state, AgentState::Working);
    }

    #[test]
    fn session_exit_reports_real_child_exit_code() {
        let cwd = tempfile::tempdir().expect("tempdir");
        let size = ClientSize { cols: 80, rows: 24 };
        let session = Session::spawn(
            "exit-code".to_string(),
            vec!["sh".to_string(), "-c".to_string(), "exit 3".to_string()],
            cwd.path().to_path_buf(),
            HashMap::new(),
            size,
            None,
            None,
        )
        .expect("spawn exiting session");

        let deadline = Instant::now() + Duration::from_secs(5);
        let exit_code = loop {
            if let Some(code) = session.exit_code() {
                break code;
            }
            assert!(
                Instant::now() < deadline,
                "session did not exit before timeout"
            );
            std::thread::sleep(Duration::from_millis(25));
        };
        assert_eq!(exit_code, 3);

        let deadline = Instant::now() + Duration::from_secs(1);
        loop {
            if session.summary().state == AgentState::Crashed {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "non-zero exit did not mark session crashed"
            );
            std::thread::sleep(Duration::from_millis(25));
        }
    }

    #[tokio::test]
    async fn non_zero_exit_dispatches_session_crashed_push() {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let push = crate::push::PushDispatcher::from_test_sender(tx);
        let cwd = tempfile::tempdir().expect("tempdir");
        let session = Session::spawn(
            "crashy-shell".to_string(),
            vec!["sh".to_string(), "-c".to_string(), "exit 7".to_string()],
            cwd.path().to_path_buf(),
            HashMap::new(),
            ClientSize { cols: 80, rows: 24 },
            None,
            Some(push),
        )
        .expect("spawn exiting session");

        let command = timeout(Duration::from_secs(5), rx.recv())
            .await
            .expect("session-crashed push dispatched before timeout")
            .expect("push command channel stays open");
        match command {
            crate::push::PushCommand::SessionCrashed {
                session_id,
                session_name,
            } => {
                assert_eq!(session_id, session.id());
                assert_eq!(session_name, "crashy-shell");
            }
            _ => panic!("expected a SessionCrashed push command"),
        }
    }

    #[tokio::test]
    async fn clean_exit_does_not_dispatch_session_crashed_push() {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let push = crate::push::PushDispatcher::from_test_sender(tx);
        let cwd = tempfile::tempdir().expect("tempdir");
        let session = Session::spawn(
            "clean-shell".to_string(),
            vec!["sh".to_string(), "-c".to_string(), "exit 0".to_string()],
            cwd.path().to_path_buf(),
            HashMap::new(),
            ClientSize { cols: 80, rows: 24 },
            None,
            Some(push),
        )
        .expect("spawn clean-exit session");

        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if session.exit_code() == Some(0) {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "session did not exit cleanly in time"
            );
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        // A clean exit must never enqueue a crash push.
        assert!(
            rx.try_recv().is_err(),
            "clean exit must not dispatch a push"
        );
    }

    #[tokio::test]
    async fn sustained_working_then_idle_dispatches_build_finished_push() {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let push = crate::push::PushDispatcher::from_test_sender(tx);
        let cwd = tempfile::tempdir().expect("tempdir");
        let session = Session::spawn(
            "builder-shell".to_string(),
            vec!["sleep".to_string(), "30".to_string()],
            cwd.path().to_path_buf(),
            HashMap::new(),
            ClientSize { cols: 80, rows: 24 },
            None,
            Some(push),
        )
        .expect("spawn long-running session");
        let _kill_on_drop = KillOnDrop(Arc::clone(&session));

        // Drive a long build: enter Working, backdate its start past the threshold,
        // then settle to Idle, which must fire exactly one build-finished push.
        session.set_state(AgentState::Working, None);
        *session
            .working_since
            .lock()
            .expect("working_since lock poisoned") =
            Some(now_ms().saturating_sub(BUILD_FINISHED_MIN_WORKING_MS + 1_000));
        session.set_state(AgentState::Idle, None);

        let command = timeout(Duration::from_secs(2), rx.recv())
            .await
            .expect("build-finished push dispatched before timeout")
            .expect("push command channel stays open");
        match command {
            crate::push::PushCommand::BuildFinished {
                session_id,
                session_name,
            } => {
                assert_eq!(session_id, session.id());
                assert_eq!(session_name, "builder-shell");
            }
            _ => panic!("expected a BuildFinished push command"),
        }
    }

    struct KillOnDrop(Arc<Session>);

    impl Drop for KillOnDrop {
        fn drop(&mut self) {
            let _ = self.0.kill();
        }
    }

    fn write_sleeping_stub(dir: &Path, name: &str) -> PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, "#!/bin/sh\nsleep 30\n").expect("write stub command");
        make_executable(&path);
        path
    }

    #[cfg(unix)]
    fn make_executable(path: &Path) {
        use std::os::unix::fs::PermissionsExt;

        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755))
            .expect("mark stub executable");
    }

    #[cfg(not(unix))]
    fn make_executable(_path: &Path) {}

    async fn assert_agent_state_changed(
        rx: &mut broadcast::Receiver<ServerToClientMsg>,
        expected: AgentState,
    ) {
        timeout(Duration::from_secs(5), async {
            loop {
                match rx.recv().await.expect("session subscriber alive") {
                    ServerToClientMsg::AgentStateChanged { state, .. } if state == expected => {
                        return;
                    }
                    ServerToClientMsg::SessionExited { exit_code, .. } => {
                        panic!("session exited before agent state event with code {exit_code}");
                    }
                    _ => {}
                }
            }
        })
        .await
        .expect("timed out waiting for agent state change");
    }

    async fn collect_until_marker(
        rx: &mut broadcast::Receiver<ServerToClientMsg>,
        marker: &[u8],
    ) -> Vec<u8> {
        timeout(Duration::from_secs(5), async {
            let mut output = Vec::new();
            loop {
                match rx.recv().await.expect("session subscriber alive") {
                    ServerToClientMsg::Output { bytes, .. } => output.extend_from_slice(&bytes),
                    ServerToClientMsg::SessionExited { exit_code, .. } => {
                        panic!("session exited before marker with code {exit_code}");
                    }
                    _ => {}
                }
                if output.windows(marker.len()).any(|window| window == marker) {
                    return output;
                }
            }
        })
        .await
        .expect("timed out waiting for shared PTY output")
    }
}

#[cfg(test)]
mod viewport_tests {
    use super::min_client_size;
    use shelly_protocol::ClientSize;

    #[test]
    fn chooses_smallest_attached_viewport() {
        assert_eq!(
            min_client_size([
                ClientSize {
                    cols: 120,
                    rows: 40,
                },
                ClientSize { cols: 80, rows: 50 },
                ClientSize {
                    cols: 100,
                    rows: 24,
                },
            ]),
            Some(ClientSize { cols: 80, rows: 24 })
        );
    }

    #[test]
    fn empty_attached_viewport_set_has_no_resize_target() {
        assert_eq!(min_client_size([]), None);
    }

    #[test]
    fn single_attached_viewport_is_resize_target() {
        assert_eq!(
            min_client_size([ClientSize {
                cols: 132,
                rows: 43,
            }]),
            Some(ClientSize {
                cols: 132,
                rows: 43,
            })
        );
    }
}

#[cfg(test)]
mod snapshot_tests {
    use super::Session;
    use crate::terminal_model::TerminalModel;
    use shelly_protocol::ClientSize;
    use std::collections::HashMap;
    use std::process::{Command, Stdio};
    use std::sync::{Arc, Mutex, MutexGuard};
    use std::time::{Duration, Instant};

    static SESSION_SNAPSHOT_TEST_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn stale_attach_snapshot_rehydrates_real_vim_session() {
        let _guard = snapshot_test_guard();
        assert!(
            Command::new("vim")
                .arg("--version")
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .map(|status| status.success())
                .unwrap_or(false),
            "vim is required for the v1 stale-attach snapshot gate"
        );

        let cwd = tempfile::tempdir().expect("tempdir");
        let size = ClientSize { cols: 80, rows: 24 };
        let session = Session::spawn(
            "vim-hosts".to_string(),
            vec![
                "vim".to_string(),
                "-Nu".to_string(),
                "NONE".to_string(),
                "-n".to_string(),
                "-i".to_string(),
                "NONE".to_string(),
                "/etc/hosts".to_string(),
            ],
            cwd.path().to_path_buf(),
            HashMap::new(),
            size,
            None,
            None,
        )
        .expect("spawn vim session");
        let _kill_on_drop = KillOnDrop(Arc::clone(&session));

        wait_for_vim_alt_screen(&session);
        let (source_state, direct_snapshot) = snapshot_state_and_bytes(&session);
        let direct_client_state = TerminalModel::test_state_after_snapshot(size, &direct_snapshot);
        assert!(direct_snapshot.starts_with(b"\x1b[?1049h"));
        assert!(direct_client_state.alt_screen);
        assert_eq!(direct_client_state.cursor, source_state.cursor);
        assert_eq!(
            direct_client_state.visible_text(),
            source_state.visible_text()
        );

        let (seq, attach_snapshot) = session.attach_bytes(Some(u64::MAX));
        let attach_state = TerminalModel::test_state_after_snapshot(size, &attach_snapshot);
        let end_seq = session.ring.lock().expect("ring lock poisoned").end_seq();

        assert!(seq <= end_seq);
        assert!(attach_snapshot.starts_with(b"\x1b[?1049h"));
        assert!(attach_state.alt_screen);
        assert!(attach_state.contains_text("localhost"));
    }

    #[test]
    fn warm_attach_seq_points_after_replayed_bytes() {
        let _guard = snapshot_test_guard();
        let cwd = tempfile::tempdir().expect("tempdir");
        let size = ClientSize { cols: 80, rows: 24 };
        let session = Session::spawn(
            "warm-replay".to_string(),
            vec![
                "sh".to_string(),
                "-c".to_string(),
                "printf abc; sleep 1".to_string(),
            ],
            cwd.path().to_path_buf(),
            HashMap::new(),
            size,
            None,
            None,
        )
        .expect("spawn shell session");
        let _kill_on_drop = KillOnDrop(Arc::clone(&session));

        wait_for_ring_end(&session, 3);

        let (seq, replay) = session.attach_bytes(Some(1));
        assert_eq!(seq, 3);
        assert_eq!(replay, b"bc");

        let (seq, replay) = session.attach_bytes(Some(3));
        assert_eq!(seq, 3);
        assert!(replay.is_empty());
    }

    struct KillOnDrop(Arc<Session>);

    impl Drop for KillOnDrop {
        fn drop(&mut self) {
            let _ = self.0.kill();
        }
    }

    fn snapshot_test_guard() -> MutexGuard<'static, ()> {
        SESSION_SNAPSHOT_TEST_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn snapshot_state_and_bytes(
        session: &Session,
    ) -> (crate::terminal_model::TerminalTestState, Vec<u8>) {
        let terminal = session.terminal.lock().expect("terminal lock poisoned");
        (terminal.test_state(), terminal.render_snapshot())
    }

    fn wait_for_vim_alt_screen(session: &Session) {
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut last_ready_state = None;
        let mut stable_samples = 0;
        loop {
            let state = session
                .terminal
                .lock()
                .expect("terminal lock poisoned")
                .test_state();
            if state.alt_screen && state.contains_text("localhost") {
                if last_ready_state.as_ref() == Some(&state) {
                    stable_samples += 1;
                    if stable_samples >= 3 {
                        return;
                    }
                } else {
                    last_ready_state = Some(state);
                    stable_samples = 1;
                }
            } else {
                last_ready_state = None;
                stable_samples = 0;
            }
            if let Some(exit_code) = session.exit_code() {
                panic!("vim exited before rendering fixture with status {exit_code}");
            }
            assert!(
                Instant::now() < deadline,
                "vim did not render the expected alt-screen fixture before timeout"
            );
            std::thread::sleep(Duration::from_millis(25));
        }
    }

    fn wait_for_ring_end(session: &Session, expected: u64) {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let end_seq = session.ring.lock().expect("ring lock poisoned").end_seq();
            if end_seq >= expected {
                return;
            }
            assert!(
                Instant::now() < deadline,
                "session did not produce {expected} bytes before timeout"
            );
            std::thread::sleep(Duration::from_millis(25));
        }
    }
}
