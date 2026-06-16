use crate::persistence::{Persistence, StoredSession};
use crate::push::PushDispatcher;
use crate::ring::PtyRingBuffer;
use crate::state_infer::{self, CommandKind};
use crate::terminal_model::{PtyResponseWriter, TerminalModel};
use anyhow::{Context, Result, anyhow, bail};
use portable_pty::{Child, CommandBuilder, MasterPty, PtySize, native_pty_system};
use shelly_protocol::{
    AgentSource, AgentState, ClientId, ClientSize, ServerToClientMsg, SessionId, SessionSummary,
    now_ms,
};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::time::Duration;
use tokio::sync::broadcast;

const RING_CAPACITY: usize = 256 * 1024;
const IDLE_AFTER_MS: u64 = 2_000;
const RESIZE_DEBOUNCE_MS: u64 = 100;

pub struct Session {
    id: SessionId,
    name: String,
    command: Vec<String>,
    command_kind: CommandKind,
    cwd: PathBuf,
    created_at: u64,
    last_activity: Mutex<u64>,
    state: Mutex<AgentState>,
    exit_code: Mutex<Option<i32>>,
    last_line: Mutex<Option<String>>,
    ring: Mutex<PtyRingBuffer>,
    child: Mutex<Box<dyn Child + Send + Sync>>,
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    terminal: Mutex<TerminalModel>,
    attached_sizes: Mutex<HashMap<ClientId, ClientSize>>,
    subscribers: broadcast::Sender<ServerToClientMsg>,
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
        let command = state_infer::command_for_spawn(command);
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

        let reader = pair.master.try_clone_reader().context("clone PTY reader")?;
        let writer = Arc::new(Mutex::new(
            pair.master.take_writer().context("take PTY writer")?,
        ));
        let (subscribers, _) = broadcast::channel(1024);
        let (resize_tx, resize_rx) = mpsc::channel();
        let terminal =
            TerminalModel::new(size, Box::new(PtyResponseWriter::new(Arc::clone(&writer))));
        let session = Arc::new(Self {
            id,
            name,
            command,
            command_kind,
            cwd,
            created_at: now_ms(),
            last_activity: Mutex::new(now_ms()),
            state: Mutex::new(AgentState::Idle),
            exit_code: Mutex::new(None),
            last_line: Mutex::new(None),
            ring: Mutex::new(PtyRingBuffer::new(RING_CAPACITY)),
            child: Mutex::new(child),
            master: Mutex::new(pair.master),
            writer,
            terminal: Mutex::new(terminal),
            attached_sizes: Mutex::new(HashMap::new()),
            subscribers,
            persistence,
            push,
            persist_dirty: AtomicBool::new(false),
            killed: AtomicBool::new(false),
            resize_tx,
        });

        session.persist();
        Self::start_reader(Arc::clone(&session), reader)?;
        Self::start_idle_loop(Arc::clone(&session))?;
        Self::start_persistence_loop(Arc::clone(&session))?;
        Self::start_resize_loop(Arc::clone(&session), resize_rx)?;
        Ok(session)
    }

    pub fn id(&self) -> SessionId {
        self.id
    }

    pub fn summary(&self) -> SessionSummary {
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

    pub fn attach_bytes(&self, last_seen_seq: Option<u64>) -> (u64, Vec<u8>) {
        let ring = self.ring.lock().expect("ring lock poisoned");
        if let Some(seq) = last_seen_seq
            && let Some((start_seq, replay)) = ring.replay_from(seq)
        {
            return (start_seq.saturating_add(replay.len() as u64), replay);
        }
        let end_seq = ring.end_seq();

        let snapshot = self
            .terminal
            .lock()
            .expect("terminal lock poisoned")
            .render_snapshot();
        (end_seq, snapshot)
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

    pub fn write_input(&self, bytes: &[u8]) -> Result<()> {
        let mut writer = self
            .writer
            .lock()
            .map_err(|_| anyhow!("PTY writer lock poisoned"))?;
        writer.write_all(bytes).context("write input to PTY")?;
        writer.flush().context("flush input to PTY")?;
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
        self.terminal
            .lock()
            .map_err(|_| anyhow!("terminal lock poisoned"))?
            .resize(size);
        Ok(())
    }

    pub fn kill(&self) -> Result<()> {
        // Mark as explicitly killed so the post-exit reader thread and the periodic
        // persistence loop stop persisting it. KillSession removes the session from
        // storage, and it must not reappear as a crashed session after a restart.
        self.killed.store(true, Ordering::Release);
        let mut child = self
            .child
            .lock()
            .map_err(|_| anyhow!("PTY child lock poisoned"))?;
        child.kill().context("kill PTY child")
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
        }
        self.set_state(state, last_line);
        self.persist_dirty.store(true, Ordering::Release);
        Ok(self
            .last_line
            .lock()
            .expect("last_line lock poisoned")
            .clone())
    }

    fn start_reader(session: Arc<Self>, mut reader: Box<dyn Read + Send>) -> Result<()> {
        std::thread::Builder::new()
            .name(format!("shelly-pty-{}", session.id))
            .spawn(move || {
                let mut buf = [0_u8; 8192];
                loop {
                    match reader.read(&mut buf) {
                        Ok(0) => {
                            session.mark_exited(session.reap_exit_code(0));
                            break;
                        }
                        Ok(n) => session.record_output(&buf[..n]),
                        Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
                        Err(_) => {
                            session.mark_exited(session.reap_exit_code(1));
                            break;
                        }
                    }
                }
            })
            .context("spawn PTY reader thread")?;
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

    fn start_idle_loop(session: Arc<Self>) -> Result<()> {
        std::thread::Builder::new()
            .name(format!("shelly-idle-{}", session.id))
            .spawn(move || {
                loop {
                    std::thread::sleep(Duration::from_millis(500));
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

    fn start_persistence_loop(session: Arc<Self>) -> Result<()> {
        if session.persistence.is_none() {
            return Ok(());
        }

        std::thread::Builder::new()
            .name(format!("shelly-persist-{}", session.id))
            .spawn(move || {
                loop {
                    std::thread::sleep(Duration::from_secs(30));
                    if session.persist_dirty.swap(false, Ordering::AcqRel) {
                        session.persist();
                    }
                    if session.exit_code().is_some() {
                        break;
                    }
                }
            })
            .context("spawn persistence thread")?;
        Ok(())
    }

    fn start_resize_loop(session: Arc<Self>, rx: mpsc::Receiver<()>) -> Result<()> {
        std::thread::Builder::new()
            .name(format!("shelly-resize-{}", session.id))
            .spawn(move || {
                loop {
                    match rx.recv_timeout(Duration::from_millis(500)) {
                        Ok(()) => {}
                        Err(mpsc::RecvTimeoutError::Timeout) => {
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
        let (seq, last_line) = {
            let mut ring = self.ring.lock().expect("ring lock poisoned");
            let seq = ring.push(bytes).saturating_add(bytes.len() as u64);
            // Keep the ring offset and terminal model synchronized for stale attaches.
            let last_line = {
                let mut terminal = self.terminal.lock().expect("terminal lock poisoned");
                terminal.advance_bytes(bytes);
                terminal.last_non_empty_line(80)
            };
            (seq, last_line)
        };
        *self
            .last_activity
            .lock()
            .expect("last_activity lock poisoned") = now_ms();

        let mut inferred_state = state_infer::unknown::infer_from_byte_count(bytes.len());
        if let Some(line) = last_line.clone() {
            *self.last_line.lock().expect("last_line lock poisoned") = Some(line.clone());
            match self.command_kind {
                CommandKind::Claude => {
                    if let Some(state) = state_infer::claude::infer_from_line(&line) {
                        inferred_state = state;
                    }
                }
                CommandKind::Codex => {
                    if let Some(state) = state_infer::codex::infer_from_json_line(&line) {
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
            bytes: bytes.to_vec(),
        });
        self.persist_dirty.store(true, Ordering::Release);
    }

    fn set_state(&self, state: AgentState, last_line: Option<String>) {
        let mut current = self.state.lock().expect("state lock poisoned");
        if *current == state {
            return;
        }
        *current = state;
        let _ = self.subscribers.send(ServerToClientMsg::AgentStateChanged {
            session_id: self.id,
            state,
            last_line,
        });
        if state == AgentState::AwaitingInput
            && let Some(push) = &self.push
        {
            push.awaiting_input(self.id, self.name.clone());
        }
    }

    fn mark_exited(&self, exit_code: i32) {
        *self.exit_code.lock().expect("exit_code lock poisoned") = Some(exit_code);
        *self.state.lock().expect("state lock poisoned") = if exit_code == 0 {
            AgentState::Idle
        } else {
            AgentState::Crashed
        };
        let _ = self.subscribers.send(ServerToClientMsg::SessionExited {
            session_id: self.id,
            exit_code,
        });
        self.persist();
    }

    fn persist(&self) {
        if self.killed.load(Ordering::Acquire) {
            return;
        }
        let Some(persistence) = &self.persistence else {
            return;
        };
        let snapshot = self.stored_snapshot();
        if let Err(error) = persistence.save_session(&snapshot) {
            tracing::warn!(%error, session_id = %self.id, "failed to persist session");
        }
    }

    fn stored_snapshot(&self) -> StoredSession {
        let (scrollback_start_seq, scrollback) =
            self.ring.lock().expect("ring lock poisoned").snapshot();
        StoredSession {
            summary: self.summary(),
            scrollback_start_seq,
            scrollback,
            exit_code: self.exit_code(),
        }
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
    use super::Session;
    use shelly_protocol::{AgentSource, AgentState, ClientId, ClientSize, ServerToClientMsg};
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
                    ServerToClientMsg::Output { bytes, .. } => output.extend(bytes),
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
