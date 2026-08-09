use crate::service;
use anyhow::{Context, Result, bail};
use interprocess::local_socket::traits::tokio::Stream as _;
use interprocess::local_socket::{GenericFilePath, prelude::*, tokio::Stream};
use serde::{Serialize, de::DeserializeOwned};
use service_manager::ServiceStatus;
use shelly_protocol::{
    CONTRACT_VERSION, Capabilities, ClientKind, ClientToServerMsg, ServerToClientMsg,
    decode_bincode, encode_bincode, max_frame_len,
};
use std::io::{IsTerminal, Read};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::time::{Duration, Instant};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

const NON_INTERACTIVE_DAEMON_START_TIMEOUT: Duration = Duration::from_secs(15);
const DAEMON_POLL_INTERVAL: Duration = Duration::from_millis(50);
const DAEMON_START_PROGRESS_INTERVAL: Duration = Duration::from_secs(10);
const SERVICE_STATUS_POLL_INTERVAL: Duration = Duration::from_millis(500);
const SERVICE_UNHEALTHY_SAMPLE_LIMIT: usize = 3;

struct StartupWait {
    deadline: Option<Instant>,
    next_progress: Option<Instant>,
}

impl StartupWait {
    fn for_current_process() -> Self {
        Self::new(daemon_start_is_interactive(), Instant::now())
    }

    fn new(interactive: bool, now: Instant) -> Self {
        Self {
            deadline: (!interactive).then_some(now + NON_INTERACTIVE_DAEMON_START_TIMEOUT),
            next_progress: interactive.then_some(now + DAEMON_START_PROGRESS_INTERVAL),
        }
    }

    fn timed_out_at(&self, now: Instant) -> bool {
        self.deadline.is_some_and(|deadline| now >= deadline)
    }

    fn take_progress_due_at(&mut self, now: Instant) -> bool {
        let Some(next_progress) = self.next_progress else {
            return false;
        };
        if now < next_progress {
            return false;
        }
        self.next_progress = Some(now + DAEMON_START_PROGRESS_INTERVAL);
        true
    }
}

pub fn control_socket_path() -> PathBuf {
    if let Some(value) = std::env::var_os("XDG_RUNTIME_DIR") {
        return PathBuf::from(value).join("shelly").join("control.sock");
    }

    let uid = unsafe { libc::geteuid() };
    std::env::temp_dir()
        .join(format!("shelly-{uid}"))
        .join("control.sock")
}

pub async fn connect_local() -> Result<(Stream, Capabilities)> {
    match connect_once().await {
        Ok(conn) => handshake(conn).await,
        Err(_) => {
            print_daemon_starting();
            let mut daemon = spawn_daemon()?;
            handshake(wait_for_daemon(&mut daemon).await?).await
        }
    }
}

pub async fn connect_existing() -> Result<(Stream, Capabilities)> {
    handshake(connect_once().await?).await
}

pub async fn wait_for_existing_daemon() -> Result<()> {
    let mut wait = StartupWait::for_current_process();
    let mut next_status_check = Instant::now() + SERVICE_STATUS_POLL_INTERVAL;
    let mut unhealthy_samples = 0;
    let mut last_error;

    loop {
        match connect_existing().await {
            Ok(_) => return Ok(()),
            Err(error) => last_error = error,
        }

        let now = Instant::now();
        if now >= next_status_check {
            match service::status() {
                Ok(ServiceStatus::Running) => unhealthy_samples = 0,
                Ok(status) => {
                    unhealthy_samples += 1;
                    if unhealthy_samples >= SERVICE_UNHEALTHY_SAMPLE_LIMIT {
                        bail!(
                            "shellyd service became {} before its control socket was ready. Run `shelly doctor` for diagnostics.",
                            service::format_status(&status),
                        );
                    }
                }
                Err(_) => unhealthy_samples = 0,
            }
            next_status_check = now + SERVICE_STATUS_POLL_INTERVAL;
        }
        if wait.take_progress_due_at(now) {
            print_daemon_still_starting();
        }
        if wait.timed_out_at(now) {
            break;
        }
        tokio::time::sleep(DAEMON_POLL_INTERVAL).await;
    }

    let socket_path = control_socket_path();
    let detail = last_error.to_string();
    bail!(
        "shellyd service did not become reachable after {} seconds at {}. {} Last connection error: {detail}",
        NON_INTERACTIVE_DAEMON_START_TIMEOUT.as_secs(),
        socket_path.display(),
        non_interactive_timeout_guidance(),
    )
}

async fn connect_once() -> Result<Stream> {
    let socket_path = control_socket_path();
    let name = Path::new(&socket_path)
        .to_fs_name::<GenericFilePath>()
        .context("convert control socket path")?;
    Stream::connect(name)
        .await
        .with_context(|| format!("connect to {}", socket_path.display()))
}

async fn wait_for_daemon(daemon: &mut Child) -> Result<Stream> {
    let mut wait = StartupWait::for_current_process();
    let mut last_error;

    loop {
        match connect_once().await {
            Ok(conn) => return Ok(conn),
            Err(error) => last_error = error,
        }

        if let Some(status) = daemon.try_wait().context("check shellyd startup status")? {
            let detail = read_daemon_stderr(daemon);
            bail!(
                "shellyd exited before its control socket was ready ({status}){}",
                if detail.is_empty() {
                    String::new()
                } else {
                    format!(": {detail}")
                }
            );
        }

        let now = Instant::now();
        if wait.take_progress_due_at(now) {
            print_daemon_still_starting();
        }
        if wait.timed_out_at(now) {
            break;
        }
        tokio::time::sleep(DAEMON_POLL_INTERVAL).await;
    }

    let socket_path = control_socket_path();
    let detail = last_error.to_string();
    bail!(
        "shellyd is still starting after {} seconds at {}. {} Last connection error: {detail}",
        NON_INTERACTIVE_DAEMON_START_TIMEOUT.as_secs(),
        socket_path.display(),
        non_interactive_timeout_guidance(),
    );
}

fn spawn_daemon() -> Result<Child> {
    let daemon_path = service::daemon_path()?;

    let mut command = std::process::Command::new(&daemon_path);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .current_dir("/")
        .process_group(0);
    command
        .spawn()
        .with_context(|| format!("spawn {}", daemon_path.display()))
}

fn read_daemon_stderr(daemon: &mut Child) -> String {
    let Some(mut stderr) = daemon.stderr.take() else {
        return String::new();
    };
    let mut detail = String::new();
    let _ = stderr.read_to_string(&mut detail);
    detail.trim().to_string()
}

#[cfg(target_os = "macos")]
pub fn print_daemon_starting() {
    eprintln!("Starting Shelly. Approve any macOS Keychain prompts to continue...");
}

#[cfg(not(target_os = "macos"))]
pub fn print_daemon_starting() {
    eprintln!("Starting Shelly...");
}

#[cfg(target_os = "macos")]
fn print_daemon_still_starting() {
    eprintln!("Still waiting for macOS Keychain approval. Press Ctrl+C to cancel...");
}

#[cfg(not(target_os = "macos"))]
fn print_daemon_still_starting() {
    eprintln!("Still waiting for shellyd. Press Ctrl+C to cancel...");
}

fn daemon_start_is_interactive() -> bool {
    std::io::stderr().is_terminal() && std::env::var_os("CI").is_none()
}

#[cfg(target_os = "macos")]
fn non_interactive_timeout_guidance() -> &'static str {
    "Approve any macOS Keychain prompts, then retry. Run `shelly doctor` for diagnostics."
}

#[cfg(not(target_os = "macos"))]
fn non_interactive_timeout_guidance() -> &'static str {
    "Retry the command, or run `shelly doctor` for diagnostics."
}

async fn handshake(mut conn: Stream) -> Result<(Stream, Capabilities)> {
    write_msg(
        &mut conn,
        &ClientToServerMsg::Hello {
            client_kind: ClientKind::LocalCli,
            client_version: env!("CARGO_PKG_VERSION").to_string(),
            protocol_version: CONTRACT_VERSION,
        },
    )
    .await?;

    match read_msg::<_, ServerToClientMsg>(&mut conn).await? {
        ServerToClientMsg::Welcome { capabilities, .. } => Ok((conn, capabilities)),
        ServerToClientMsg::Error { message, .. } => bail!("{message}"),
        other => bail!("unexpected daemon response during handshake: {other:?}"),
    }
}

pub async fn read_msg<R, T>(reader: &mut R) -> Result<T>
where
    R: AsyncRead + Unpin,
    T: DeserializeOwned,
{
    let len = reader.read_u32().await.context("read frame length")? as usize;
    if len > max_frame_len() {
        bail!("frame too large: {len}");
    }
    let mut payload = vec![0; len];
    reader
        .read_exact(&mut payload)
        .await
        .context("read frame payload")?;
    decode_bincode(&payload).context("decode frame")
}

pub async fn write_msg<W, T>(writer: &mut W, message: &T) -> Result<()>
where
    W: AsyncWrite + Unpin,
    T: Serialize,
{
    let payload = encode_bincode(message).context("encode frame")?;
    if payload.len() > max_frame_len() {
        bail!("frame too large: {}", payload.len());
    }
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
mod startup_wait_tests {
    use super::*;

    #[test]
    fn interactive_startup_has_no_deadline_and_reports_progress() {
        let now = Instant::now();
        let mut wait = StartupWait::new(true, now);

        assert!(!wait.timed_out_at(now + Duration::from_secs(24 * 60 * 60)));
        assert!(!wait.take_progress_due_at(now));
        assert!(wait.take_progress_due_at(now + DAEMON_START_PROGRESS_INTERVAL));
        assert!(!wait.take_progress_due_at(now + DAEMON_START_PROGRESS_INTERVAL));
    }

    #[test]
    fn non_interactive_startup_keeps_a_bounded_timeout() {
        let now = Instant::now();
        let mut wait = StartupWait::new(false, now);

        assert!(
            !wait.timed_out_at(
                now + NON_INTERACTIVE_DAEMON_START_TIMEOUT - Duration::from_millis(1)
            )
        );
        assert!(wait.timed_out_at(now + NON_INTERACTIVE_DAEMON_START_TIMEOUT));
        assert!(!wait.take_progress_due_at(now + NON_INTERACTIVE_DAEMON_START_TIMEOUT));
    }
}
