mod ipc;
mod iroh_client;
mod service;
mod settings;
mod update_notice;

use anyhow::{Context, Result, bail};
use clap::{CommandFactory, Parser, Subcommand};
use clap_complete::Shell;
use crossterm::terminal::{disable_raw_mode, enable_raw_mode};
use fieldwork_protocol::{
    AgentSource, AgentState, ClientSize, ClientToServerMsg, ServerToClientMsg, SessionId,
    SessionSummary,
};
use qrcode::{QrCode, render::unicode};
use std::collections::HashMap;
use std::io::Read;
use std::path::PathBuf;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[derive(Parser)]
#[command(name = "fieldwork")]
#[command(about = "Continue terminal sessions from anywhere")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
#[allow(clippy::large_enum_variant)]
enum Command {
    Pair,
    #[command(hide = true)]
    PairTest {
        #[arg(long)]
        payload: Option<String>,
        #[arg(long, default_value = "Fieldwork Test Client")]
        name: String,
        #[arg(long)]
        attach: Option<String>,
        #[arg(long)]
        input: Vec<String>,
        #[arg(long)]
        expect_output: Vec<String>,
        #[arg(long)]
        reject_output: Vec<String>,
        #[arg(long)]
        reconnect_expect_output: Vec<String>,
        #[arg(long, default_value_t = 2_000)]
        reconnect_timeout_ms: u64,
        #[arg(long, default_value_t = 0)]
        reconnect_delay_ms: u64,
        #[arg(long)]
        subscribe_expect: Option<String>,
        #[arg(long)]
        secret_key_path: Option<PathBuf>,
        #[arg(long)]
        connect_only: bool,
        #[arg(long)]
        expect_unauthorized: bool,
        #[arg(long)]
        expect_protocol_mismatch: bool,
        #[arg(long)]
        expect_forbidden_create: bool,
        #[arg(long)]
        expect_forbidden_kill: Option<String>,
        #[arg(long)]
        expect_forbidden_agent_event: bool,
    },
    Ls,
    New {
        #[arg(long = "dir", default_value = ".")]
        dir: PathBuf,
        #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
        command: Vec<String>,
    },
    Attach {
        session: String,
    },
    Kill {
        session: String,
    },
    Devices {
        #[command(subcommand)]
        command: Option<DeviceCommand>,
    },
    Settings {
        #[command(subcommand)]
        command: SettingsCommand,
    },
    Daemon {
        #[command(subcommand)]
        command: Option<DaemonCommand>,
    },
    Hook {
        #[command(subcommand)]
        command: HookCommand,
    },
    Completion {
        shell: Shell,
    },
    Version,
}

#[derive(Subcommand)]
enum DeviceCommand {
    Remove { name: String },
}

#[derive(Subcommand)]
enum SettingsCommand {
    Telemetry {
        #[command(subcommand)]
        command: TelemetryCommand,
    },
    ScrollbackEncryption {
        #[command(subcommand)]
        command: EncryptionCommand,
    },
}

#[derive(Subcommand)]
enum TelemetryCommand {
    On {
        #[arg(long)]
        sentry_dsn: Option<String>,
    },
    Off,
    Status,
}

#[derive(Subcommand)]
enum EncryptionCommand {
    On,
    Off,
    Status,
}

#[derive(Subcommand)]
enum DaemonCommand {
    Install,
    Uninstall,
    Status,
    Start,
    Restart,
    Logs {
        #[arg(long, default_value_t = 80)]
        tail: usize,
    },
}

#[derive(Subcommand)]
enum HookCommand {
    ClaudeStop {
        #[arg(long)]
        session: Option<String>,
        #[arg(long)]
        last_line: Option<String>,
    },
    CodexEvent {
        #[arg(long)]
        session: Option<String>,
    },
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();
    if should_check_update_notice(&cli.command) {
        update_notice::maybe_print_update_notice().await;
    }
    match cli.command {
        Command::Pair => pair_device().await,
        Command::PairTest {
            payload,
            name,
            attach,
            input,
            expect_output,
            reject_output,
            reconnect_expect_output,
            reconnect_timeout_ms,
            reconnect_delay_ms,
            subscribe_expect,
            secret_key_path,
            connect_only,
            expect_unauthorized,
            expect_protocol_mismatch,
            expect_forbidden_create,
            expect_forbidden_kill,
            expect_forbidden_agent_event,
        } => {
            iroh_client::pair_test(iroh_client::PairTestOptions {
                payload,
                name,
                attach,
                input,
                expect_output,
                reject_output,
                reconnect_expect_output,
                reconnect_timeout_ms,
                reconnect_delay_ms,
                subscribe_expect,
                secret_key_path,
                connect_only,
                expect_unauthorized,
                expect_protocol_mismatch,
                expect_forbidden_create,
                expect_forbidden_kill,
                expect_forbidden_agent_event,
            })
            .await
        }
        Command::Ls => list_sessions().await,
        Command::New { dir, command } => create_session(dir, command).await,
        Command::Attach { session } => attach_session(session).await,
        Command::Kill { session } => kill_session(session).await,
        Command::Devices { command } => {
            match command {
                Some(DeviceCommand::Remove { name }) => {
                    remove_device(name).await?;
                }
                None => list_devices().await?,
            }
            Ok(())
        }
        Command::Settings { command } => run_settings(command),
        Command::Daemon { command } => {
            match command.unwrap_or(DaemonCommand::Status) {
                DaemonCommand::Install => {
                    service::install()?;
                    if let Err(error) = ipc::wait_for_existing_daemon().await {
                        let _ = service::uninstall();
                        return Err(error
                            .context("started fieldworkd user service but health check failed"));
                    }
                    println!("installed and started fieldworkd user service");
                }
                DaemonCommand::Uninstall => {
                    service::uninstall()?;
                    println!("uninstalled fieldworkd user service");
                }
                DaemonCommand::Status => daemon_status().await?,
                DaemonCommand::Start => {
                    let _ = ipc::connect_local().await?;
                    println!(
                        "fieldworkd is running at {}",
                        ipc::control_socket_path().display()
                    );
                }
                DaemonCommand::Restart => {
                    service::restart()?;
                    ipc::wait_for_existing_daemon()
                        .await
                        .context("restarted fieldworkd user service but health check failed")?;
                    println!("restarted fieldworkd user service");
                }
                DaemonCommand::Logs { tail } => print_daemon_logs(tail)?,
            }
            Ok(())
        }
        Command::Hook { command } => run_hook(command).await,
        Command::Completion { shell } => {
            print_completion(shell);
            Ok(())
        }
        Command::Version => {
            println!("fieldwork {}", env!("CARGO_PKG_VERSION"));
            Ok(())
        }
    }
}

fn should_check_update_notice(command: &Command) -> bool {
    matches!(
        command,
        Command::Ls
            | Command::New { .. }
            | Command::Kill { .. }
            | Command::Devices { .. }
            | Command::Settings { .. }
            | Command::Daemon { .. }
    )
}

fn print_completion(shell: Shell) {
    let mut command = Cli::command();
    let bin_name = command.get_name().to_string();
    clap_complete::generate(shell, &mut command, bin_name, &mut std::io::stdout());
}

fn run_settings(command: SettingsCommand) -> Result<()> {
    match command {
        SettingsCommand::Telemetry { command } => {
            let changed = !matches!(&command, TelemetryCommand::Status);
            let status = match command {
                TelemetryCommand::On { sentry_dsn } => settings::set_telemetry(true, sentry_dsn)?,
                TelemetryCommand::Off => settings::set_telemetry(false, None)?,
                TelemetryCommand::Status => settings::telemetry_status()?,
            };
            print_telemetry_status(&status);
            if changed {
                println!("restart fieldworkd for this setting to affect the running daemon");
            }
        }
        SettingsCommand::ScrollbackEncryption { command } => {
            let changed = !matches!(&command, EncryptionCommand::Status);
            let status = match command {
                EncryptionCommand::On => settings::set_scrollback_encryption(true)?,
                EncryptionCommand::Off => settings::set_scrollback_encryption(false)?,
                EncryptionCommand::Status => settings::scrollback_encryption_status()?,
            };
            print_scrollback_encryption_status(&status);
            if changed {
                println!("restart fieldworkd for this setting to affect the running daemon");
                if !status.enabled {
                    println!(
                        "warning: future local scrollback and device registry writes will be plaintext"
                    );
                }
            }
        }
    }
    Ok(())
}

fn print_telemetry_status(status: &settings::TelemetryStatus) {
    println!("telemetry: {}", if status.opt_in { "on" } else { "off" });
    println!(
        "sentry dsn: {}",
        if status.sentry_dsn_configured {
            "configured"
        } else {
            "missing"
        }
    );
    println!("config: {}", status.path.display());
}

fn print_scrollback_encryption_status(status: &settings::ScrollbackEncryptionStatus) {
    println!(
        "scrollback encryption: {}",
        if status.enabled { "on" } else { "off" }
    );
    println!("config: {}", status.path.display());
}

async fn remove_device(name: String) -> Result<()> {
    let (mut conn, _) = ipc::connect_local().await?;
    ipc::write_msg(
        &mut conn,
        &ClientToServerMsg::RemoveDevice { name: name.clone() },
    )
    .await?;
    match ipc::read_msg::<_, ServerToClientMsg>(&mut conn).await? {
        ServerToClientMsg::DeviceList { .. } => {
            println!("removed device: {name}");
            Ok(())
        }
        ServerToClientMsg::Error { message, .. } => bail!("{message}"),
        other => bail!("unexpected daemon response: {other:?}"),
    }
}

async fn pair_device() -> Result<()> {
    let (mut conn, _) = ipc::connect_local().await?;
    ipc::write_msg(
        &mut conn,
        &ClientToServerMsg::BeginPairing { device_name: None },
    )
    .await?;

    let payload = match ipc::read_msg::<_, ServerToClientMsg>(&mut conn).await? {
        ServerToClientMsg::PairingStarted { payload } => payload,
        ServerToClientMsg::Error { message, .. } => bail!("{message}"),
        other => bail!("unexpected daemon response: {other:?}"),
    };
    let encoded = serde_json::to_string(&payload).context("encode pairing payload")?;
    let qr = QrCode::new(encoded.as_bytes()).context("build pairing QR")?;
    let image = qr.render::<unicode::Dense1x2>().quiet_zone(true).build();

    println!("{image}");
    println!("{encoded}");
    println!("Waiting for a device to scan. Pair token expires in 10 minutes.");

    loop {
        match ipc::read_msg::<_, ServerToClientMsg>(&mut conn).await? {
            ServerToClientMsg::PairingApprovalRequested {
                request_id,
                device_name,
                device_node_id,
            } => {
                println!(
                    "Pair request from device \"{device_name}\" ({}) — approve? [y/N]",
                    short_node_id(&device_node_id)
                );
                let mut answer = String::new();
                std::io::stdin()
                    .read_line(&mut answer)
                    .context("read pairing approval")?;
                let approved = matches!(answer.trim(), "y" | "Y" | "yes" | "YES");
                ipc::write_msg(
                    &mut conn,
                    &ClientToServerMsg::ApprovePairing {
                        request_id,
                        approved,
                    },
                )
                .await?;
                if approved {
                    println!("Approved. Device is paired.");
                } else {
                    println!("Denied. Pair token has been consumed.");
                }
                return Ok(());
            }
            ServerToClientMsg::Error { message, .. } => bail!("{message}"),
            _ => {}
        }
    }
}

async fn list_devices() -> Result<()> {
    let (mut conn, _) = ipc::connect_local().await?;
    ipc::write_msg(&mut conn, &ClientToServerMsg::ListDevices).await?;
    match ipc::read_msg::<_, ServerToClientMsg>(&mut conn).await? {
        ServerToClientMsg::DeviceList { devices } => {
            if devices.is_empty() {
                println!("no paired devices");
            } else {
                for device in devices {
                    println!(
                        "{}\t{}\tpaired_at={}",
                        device.name,
                        short_node_id(&device.device_node_id),
                        device.paired_at
                    );
                }
            }
        }
        ServerToClientMsg::Error { message, .. } => bail!("{message}"),
        other => bail!("unexpected daemon response: {other:?}"),
    }
    Ok(())
}

fn short_node_id(node_id: &str) -> &str {
    let end = node_id.len().min(12);
    &node_id[..end]
}

async fn run_hook(command: HookCommand) -> Result<()> {
    match command {
        HookCommand::ClaudeStop { session, last_line } => {
            let session_id = hook_session_id(session)?;
            emit_agent_state_event(
                session_id,
                AgentSource::Claude,
                AgentState::AwaitingInput,
                last_line,
            )
            .await
        }
        HookCommand::CodexEvent { session } => {
            let session_id = hook_session_id(session)?;
            let mut payload = String::new();
            std::io::stdin()
                .read_to_string(&mut payload)
                .context("read Codex event JSON from stdin")?;
            let state = codex_state_from_json(&payload)
                .with_context(|| format!("unsupported Codex event payload: {payload}"))?;
            emit_agent_state_event(session_id, AgentSource::Codex, state, None).await
        }
    }
}

async fn emit_agent_state_event(
    session_id: SessionId,
    source: AgentSource,
    state: AgentState,
    last_line: Option<String>,
) -> Result<()> {
    let (mut conn, _) = ipc::connect_local().await?;
    ipc::write_msg(
        &mut conn,
        &ClientToServerMsg::AgentStateEvent {
            session_id,
            source,
            state,
            last_line,
        },
    )
    .await?;
    Ok(())
}

fn hook_session_id(session: Option<String>) -> Result<SessionId> {
    let value = session
        .or_else(|| std::env::var("FIELDWORK_SESSION_ID").ok())
        .context("hook requires --session or FIELDWORK_SESSION_ID")?;
    value
        .parse()
        .with_context(|| format!("parse session id {value}"))
}

fn codex_state_from_json(payload: &str) -> Option<AgentState> {
    let value: serde_json::Value = serde_json::from_str(payload).ok()?;
    ["type", "event", "status"]
        .into_iter()
        .filter_map(|key| value.get(key).and_then(|event| event.as_str()))
        .find_map(codex_state_from_name)
}

fn codex_state_from_name(event: &str) -> Option<AgentState> {
    match event.trim().to_ascii_lowercase().as_str() {
        "awaiting_input" | "approval_requested" | "turn_waiting" => Some(AgentState::AwaitingInput),
        "turn_started" | "working" => Some(AgentState::Working),
        "turn_finished" | "idle" => Some(AgentState::Idle),
        "crashed" | "error" => Some(AgentState::Crashed),
        _ => None,
    }
}

async fn list_sessions() -> Result<()> {
    let (mut conn, _) = ipc::connect_local().await?;
    ipc::write_msg(&mut conn, &ClientToServerMsg::ListSessions).await?;
    match ipc::read_msg::<_, ServerToClientMsg>(&mut conn).await? {
        ServerToClientMsg::SessionList { sessions } => {
            if sessions.is_empty() {
                println!("No sessions.");
            } else {
                for session in sessions {
                    println!(
                        "{}\t{}\t{:?}\t{}",
                        session.id,
                        session.name,
                        session.state,
                        session.command.join(" ")
                    );
                }
            }
        }
        ServerToClientMsg::Error { message, .. } => bail!("{message}"),
        other => bail!("unexpected daemon response: {other:?}"),
    }
    Ok(())
}

async fn create_session(dir: PathBuf, mut command: Vec<String>) -> Result<()> {
    if command.is_empty() {
        command.push("claude".to_string());
    }
    let cwd = dir
        .canonicalize()
        .with_context(|| format!("canonicalize {}", dir.display()))?;
    let name = session_name(&command, &cwd);
    let size = terminal_size();

    let (mut conn, _) = ipc::connect_local().await?;
    ipc::write_msg(
        &mut conn,
        &ClientToServerMsg::CreateSession {
            name,
            command,
            cwd,
            env: HashMap::new(),
            size,
        },
    )
    .await?;

    match ipc::read_msg::<_, ServerToClientMsg>(&mut conn).await? {
        ServerToClientMsg::SessionCreated { summary, .. } => {
            println!("created {}\t{}", summary.id, summary.name);
        }
        ServerToClientMsg::Error { message, .. } => bail!("{message}"),
        other => bail!("unexpected daemon response: {other:?}"),
    }
    Ok(())
}

async fn attach_session(session_ref: String) -> Result<()> {
    let (mut conn, _) = ipc::connect_local().await?;
    let session = resolve_session(&mut conn, &session_ref).await?;
    let session_id = session.id;
    let size = terminal_size();

    ipc::write_msg(
        &mut conn,
        &ClientToServerMsg::AttachSession {
            session_id,
            size,
            last_seen_seq: None,
        },
    )
    .await?;

    let attached = ipc::read_msg::<_, ServerToClientMsg>(&mut conn).await?;
    let ServerToClientMsg::Attached { initial_bytes, .. } = attached else {
        bail!("expected attach response, got {attached:?}");
    };

    let _raw = RawMode::enter()?;
    let mut stdout = tokio::io::stdout();
    stdout.write_all(&initial_bytes).await?;
    stdout.flush().await?;

    let (mut reader, mut writer) = tokio::io::split(conn);
    let output_task = tokio::spawn(async move {
        let mut stdout = tokio::io::stdout();
        while let Ok(message) = ipc::read_msg::<_, ServerToClientMsg>(&mut reader).await {
            match message {
                ServerToClientMsg::Output { bytes, .. } => {
                    stdout.write_all(&bytes).await?;
                    stdout.flush().await?;
                }
                ServerToClientMsg::Lag { skipped_bytes, .. } => {
                    let note = format!(
                        "\r\n[fieldwork: lagged {skipped_bytes} messages; re-run attach to resync]\r\n"
                    );
                    stdout.write_all(note.as_bytes()).await?;
                    stdout.flush().await?;
                    let _ = disable_raw_mode();
                    std::process::exit(2);
                }
                ServerToClientMsg::SessionExited { exit_code, .. } => {
                    let note = format!("\r\n[fieldwork: session exited {exit_code}]\r\n");
                    stdout.write_all(note.as_bytes()).await?;
                    stdout.flush().await?;
                    let _ = disable_raw_mode();
                    std::process::exit(exit_code);
                }
                ServerToClientMsg::Error { message, .. } => {
                    let note = format!("\r\n[fieldwork error: {message}]\r\n");
                    stdout.write_all(note.as_bytes()).await?;
                    stdout.flush().await?;
                    let _ = disable_raw_mode();
                    std::process::exit(1);
                }
                _ => {}
            }
        }
        anyhow::Ok(())
    });

    let input_task = tokio::spawn(async move {
        let mut stdin = tokio::io::stdin();
        let mut buf = [0_u8; 1024];
        let mut prefix = false;
        loop {
            let n = stdin.read(&mut buf).await?;
            if n == 0 {
                break;
            }

            let mut outgoing = Vec::with_capacity(n);
            for &byte in &buf[..n] {
                if prefix {
                    prefix = false;
                    if byte == b'd' || byte == b'D' {
                        ipc::write_msg(&mut writer, &ClientToServerMsg::DetachSession).await?;
                        return anyhow::Ok(());
                    }
                    outgoing.push(0x02);
                    outgoing.push(byte);
                } else if byte == 0x02 {
                    prefix = true;
                } else {
                    outgoing.push(byte);
                }
            }

            if !outgoing.is_empty() {
                ipc::write_msg(
                    &mut writer,
                    &ClientToServerMsg::Input {
                        session_id,
                        bytes: outgoing,
                    },
                )
                .await?;
            }
        }
        anyhow::Ok(())
    });

    tokio::pin!(output_task);
    tokio::pin!(input_task);
    tokio::select! {
        result = &mut output_task => {
            input_task.abort();
            result??
        },
        result = &mut input_task => {
            output_task.abort();
            result??
        },
    }
    Ok(())
}

async fn kill_session(session_ref: String) -> Result<()> {
    let (mut conn, _) = ipc::connect_local().await?;
    let session = resolve_session(&mut conn, &session_ref).await?;
    ipc::write_msg(
        &mut conn,
        &ClientToServerMsg::KillSession {
            session_id: session.id,
        },
    )
    .await?;
    println!("removed {}", session.id);
    Ok(())
}

async fn daemon_status() -> Result<()> {
    match service::status() {
        Ok(status) => println!("service: {}", service::format_status(&status)),
        Err(error) => println!("service: unavailable ({error})"),
    }

    match ipc::connect_existing().await {
        Ok(_) => println!(
            "socket: reachable ({})",
            ipc::control_socket_path().display()
        ),
        Err(error) => println!("socket: not reachable ({error})"),
    }
    Ok(())
}

async fn resolve_session(
    conn: &mut interprocess::local_socket::tokio::Stream,
    value: &str,
) -> Result<SessionSummary> {
    ipc::write_msg(conn, &ClientToServerMsg::ListSessions).await?;
    let sessions = match ipc::read_msg::<_, ServerToClientMsg>(conn).await? {
        ServerToClientMsg::SessionList { sessions } => sessions,
        ServerToClientMsg::Error { message, .. } => bail!("{message}"),
        other => bail!("unexpected daemon response: {other:?}"),
    };

    if let Ok(id) = value.parse::<SessionId>() {
        if let Some(session) = sessions.into_iter().find(|session| session.id == id) {
            return Ok(session);
        }
    } else if let Some(session) = sessions.iter().find(|session| session.name == value) {
        return Ok(session.clone());
    } else if let Some(session) = sessions
        .iter()
        .find(|session| session.id.to_string().starts_with(value))
    {
        return Ok(session.clone());
    }

    bail!("session not found: {value}");
}

fn terminal_size() -> ClientSize {
    let (cols, rows) = crossterm::terminal::size().unwrap_or((80, 24));
    ClientSize { cols, rows }
}

fn session_name(command: &[String], cwd: &std::path::Path) -> String {
    let dir = cwd
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("work");
    format!("{} · {dir}", command[0])
}

fn print_daemon_logs(tail: usize) -> Result<()> {
    let path = latest_daemon_log_file()?;
    let contents =
        std::fs::read_to_string(&path).with_context(|| format!("read {}", path.display()))?;
    let lines: Vec<_> = contents.lines().collect();
    let start = lines.len().saturating_sub(tail);
    for line in &lines[start..] {
        println!("{line}");
    }
    Ok(())
}

fn latest_daemon_log_file() -> Result<PathBuf> {
    let dir = default_daemon_log_dir();
    let mut candidates = Vec::new();
    for entry in std::fs::read_dir(&dir).with_context(|| format!("read {}", dir.display()))? {
        let entry = entry?;
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if name.starts_with("daemon.log") {
            let modified = entry.metadata()?.modified()?;
            candidates.push((modified, path));
        }
    }
    candidates.sort_by_key(|(modified, _)| *modified);
    candidates
        .pop()
        .map(|(_, path)| path)
        .with_context(|| format!("no daemon logs found in {}", dir.display()))
}

fn default_daemon_log_dir() -> PathBuf {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);

    if cfg!(target_os = "macos") {
        return home.join("Library").join("Logs").join("app.fieldwork");
    }

    if let Some(state_home) = std::env::var_os("XDG_STATE_HOME") {
        return PathBuf::from(state_home).join("fieldwork");
    }

    home.join(".local").join("state").join("fieldwork")
}

struct RawMode;

impl RawMode {
    fn enter() -> Result<Self> {
        enable_raw_mode().context("enable raw mode")?;
        Ok(Self)
    }
}

impl Drop for RawMode {
    fn drop(&mut self) {
        let _ = disable_raw_mode();
    }
}

#[cfg(test)]
mod tests {
    use super::{Command, HookCommand, codex_state_from_json, should_check_update_notice};
    use clap_complete::Shell;
    use fieldwork_protocol::AgentState;
    use std::path::PathBuf;

    #[test]
    fn parses_codex_approval_event() {
        assert_eq!(
            codex_state_from_json(r#"{"type":"approval_requested"}"#),
            Some(AgentState::AwaitingInput)
        );
    }

    #[test]
    fn parses_codex_status_fallback_when_type_is_wrapper() {
        assert_eq!(
            codex_state_from_json(r#"{"type":"event","status":"turn_waiting"}"#),
            Some(AgentState::AwaitingInput)
        );
    }

    #[test]
    fn rejects_unknown_codex_event() {
        assert_eq!(codex_state_from_json(r#"{"type":"noise"}"#), None);
    }

    #[test]
    fn update_notice_skips_machine_and_terminal_streaming_commands() {
        assert!(should_check_update_notice(&Command::Ls));
        assert!(should_check_update_notice(&Command::New {
            dir: PathBuf::from("."),
            command: vec!["bash".to_string()],
        }));

        assert!(!should_check_update_notice(&Command::Pair));
        assert!(!should_check_update_notice(&Command::Attach {
            session: "first".to_string(),
        }));
        assert!(!should_check_update_notice(&Command::Hook {
            command: HookCommand::CodexEvent { session: None },
        }));
        assert!(!should_check_update_notice(&Command::Completion {
            shell: Shell::Bash,
        }));
        assert!(!should_check_update_notice(&Command::Version));
    }
}
