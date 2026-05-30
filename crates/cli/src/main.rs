mod ipc;
mod iroh_client;
mod service;
mod settings;
mod update_notice;

use anyhow::{Context, Result, bail};
use clap::{CommandFactory, FromArgMatches, Parser, Subcommand};
use clap_complete::Shell;
use crossterm::terminal::{disable_raw_mode, enable_raw_mode};
use fieldwork_protocol::{
    AgentSource, AgentState, CONTRACT_VERSION, ClientSize, ClientToServerMsg, ServerToClientMsg,
    SessionId, SessionSummary,
};
use qrcode::{QrCode, render::unicode};
use std::collections::HashMap;
use std::ffi::OsString;
use std::fs;
use std::io::Read;
use std::os::unix::fs::{FileTypeExt, MetadataExt};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

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
    "pretzel",
    "cupcake",
    "lollipop",
    "confetti",
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

#[derive(Parser)]
#[command(name = "fieldwork")]
#[command(version = env!("CARGO_PKG_VERSION"))]
#[command(about = "Continue terminal sessions from anywhere")]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand)]
#[allow(clippy::large_enum_variant)]
enum Command {
    Pair,
    #[command(hide = true)]
    PairTest {
        #[arg(long)]
        payload: Option<String>,
        #[arg(long)]
        code: Option<String>,
        #[arg(long)]
        relay_control_url: Option<String>,
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
        #[arg(long)]
        name: Option<String>,
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
    #[command(about = "Check local Fieldwork CLI and daemon health")]
    Doctor {
        #[arg(long, help = "Do not auto-start fieldworkd while checking the socket")]
        no_start: bool,
    },
    Hook {
        #[command(subcommand)]
        command: HookCommand,
    },
    Completion {
        shell: Shell,
    },
    Version,
    #[command(external_subcommand)]
    Named(Vec<OsString>),
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
    On,
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
    let cli = parse_cli_for_current_invocation();
    if should_check_update_notice(cli.command.as_ref()) {
        update_notice::maybe_print_update_notice().await;
    }
    match cli.command {
        None => run_default().await,
        Some(Command::Pair) => pair_device().await,
        Some(Command::PairTest {
            payload,
            code,
            relay_control_url,
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
        }) => {
            iroh_client::pair_test(iroh_client::PairTestOptions {
                payload,
                code,
                relay_control_url,
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
        Some(Command::Ls) => list_sessions().await,
        Some(Command::New { dir, name, command }) => create_session(dir, name, command).await,
        Some(Command::Attach { session }) => attach_session(session).await,
        Some(Command::Kill { session }) => kill_session(session).await,
        Some(Command::Devices { command }) => {
            match command {
                Some(DeviceCommand::Remove { name }) => {
                    remove_device(name).await?;
                }
                None => list_devices().await?,
            }
            Ok(())
        }
        Some(Command::Settings { command }) => run_settings(command),
        Some(Command::Daemon { command }) => {
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
        Some(Command::Doctor { no_start }) => run_doctor(no_start).await,
        Some(Command::Hook { command }) => run_hook(command).await,
        Some(Command::Completion { shell }) => {
            print_completion(shell);
            Ok(())
        }
        Some(Command::Version) => {
            println!("fieldwork {}", env!("CARGO_PKG_VERSION"));
            Ok(())
        }
        Some(Command::Named(args)) => open_named_session(args).await,
    }
}

fn parse_cli_for_current_invocation() -> Cli {
    let command = cli_command_for_current_invocation();
    let matches = command.get_matches();
    Cli::from_arg_matches(&matches).unwrap_or_else(|err| err.exit())
}

fn cli_command_for_current_invocation() -> clap::Command {
    cli_command_with_bin_name(invoked_cli_bin_name())
}

fn cli_command_with_bin_name(bin_name: String) -> clap::Command {
    let bin_name = static_cli_bin_name(bin_name);
    Cli::command().name(bin_name).bin_name(bin_name)
}

fn static_cli_bin_name(bin_name: String) -> &'static str {
    match bin_name.as_str() {
        "fieldwork" => "fieldwork",
        "fw" => "fw",
        _ => {
            // clap stores command names as static strings; unusual symlink aliases are parsed once per process.
            let bin_name: &'static str = Box::leak(bin_name.into_boxed_str());
            bin_name
        }
    }
}

fn should_check_update_notice(command: Option<&Command>) -> bool {
    matches!(
        command,
        Some(Command::Ls)
            | Some(Command::New { .. })
            | Some(Command::Kill { .. })
            | Some(Command::Devices { .. })
            | Some(Command::Settings { .. })
            | Some(Command::Daemon { .. })
            | Some(Command::Doctor { .. })
    )
}

fn print_completion(shell: Shell) {
    let bin_name = invoked_cli_bin_name();
    let mut command = cli_command_with_bin_name(bin_name.clone());
    clap_complete::generate(shell, &mut command, bin_name, &mut std::io::stdout());
}

fn invoked_cli_bin_name() -> String {
    completion_bin_name_with_override(
        std::env::var_os("FIELDWORK_CLI_BIN_NAME"),
        std::env::args_os().next(),
    )
}

fn completion_bin_name_with_override(
    override_name: Option<OsString>,
    arg0: Option<OsString>,
) -> String {
    override_name
        .as_deref()
        .or(arg0.as_deref())
        .and_then(|arg0| std::path::Path::new(arg0).file_name())
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or("fieldwork")
        .to_string()
}

fn run_settings(command: SettingsCommand) -> Result<()> {
    match command {
        SettingsCommand::Telemetry { command } => {
            let changed = !matches!(&command, TelemetryCommand::Status);
            let status = match command {
                TelemetryCommand::On => settings::set_telemetry(true)?,
                TelemetryCommand::Off => settings::set_telemetry(false)?,
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
    println!("export: relay Honeycomb only; daemon/mobile crash reporting is unavailable in v1");
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

    let ticket = match ipc::read_msg::<_, ServerToClientMsg>(&mut conn).await? {
        ServerToClientMsg::PairingStarted { ticket } => ticket,
        ServerToClientMsg::Error { message, .. } => bail!("{message}"),
        other => bail!("unexpected daemon response: {other:?}"),
    };
    let encoded = ticket.encode().context("encode pairing ticket")?;
    let qr = QrCode::new(encoded.as_bytes()).context("build pairing QR")?;
    let image = qr.render::<unicode::Dense1x2>().quiet_zone(true).build();

    println!("{image}");
    println!("Scan the QR with the Fieldwork app — or enter this code:");
    println!("    {}", group_code(&ticket.code));
    println!("Expires in 10 minutes.");

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
                    println!("Denied. Pairing code has been consumed.");
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

/// Renders a short pairing code with a separating space for easier hand entry.
fn group_code(code: &str) -> String {
    let chars: Vec<char> = code.chars().collect();
    if chars.len() <= 3 {
        return code.to_string();
    }
    let (head, tail) = chars.split_at(chars.len() / 2);
    format!(
        "{} {}",
        head.iter().collect::<String>(),
        tail.iter().collect::<String>()
    )
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
            let states = codex_states_from_payload(&payload)
                .with_context(|| format!("unsupported Codex event payload: {payload}"))?;
            for state in states {
                emit_agent_state_event(session_id, AgentSource::Codex, state, None).await?;
            }
            Ok(())
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
    match ipc::read_msg::<_, ServerToClientMsg>(&mut conn).await? {
        ServerToClientMsg::AgentStateChanged {
            session_id: applied_session,
            state: applied_state,
            ..
        } if applied_session == session_id && applied_state == state => Ok(()),
        ServerToClientMsg::Error { message, .. } => bail!("{message}"),
        other => bail!("unexpected daemon response: {other:?}"),
    }
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

fn codex_states_from_payload(payload: &str) -> Option<Vec<AgentState>> {
    let trimmed = payload.trim();
    if trimmed.is_empty() {
        return None;
    }

    if let Some(state) = codex_state_from_json(trimmed) {
        return Some(vec![state]);
    }

    let states: Vec<_> = trimmed
        .lines()
        .filter_map(|line| codex_state_from_json(line.trim()))
        .collect();
    if states.is_empty() {
        None
    } else {
        Some(states)
    }
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
    let sessions = fetch_sessions().await?;
    print_sessions(&sessions);
    Ok(())
}

async fn run_default() -> Result<()> {
    let sessions = fetch_sessions().await?;
    let summary = create_session_summary(
        PathBuf::from("."),
        Some(auto_session_name(&sessions)),
        Vec::new(),
    )
    .await?;
    eprintln!("created {}\t{}", summary.id, summary.name);
    attach_session(summary.id.to_string()).await
}

async fn open_named_session(args: Vec<OsString>) -> Result<()> {
    let name = parse_named_shortcut_args(args)?;
    let sessions = fetch_sessions().await?;
    if let Some(session) = sessions.iter().find(|session| session.name == name) {
        return attach_session(session.id.to_string()).await;
    }

    let summary = create_session_summary(PathBuf::from("."), Some(name), Vec::new()).await?;
    eprintln!("created {}\t{}", summary.id, summary.name);
    attach_session(summary.id.to_string()).await
}

fn parse_named_shortcut_args(args: Vec<OsString>) -> Result<String> {
    let mut args = args.into_iter();
    let Some(name) = args.next() else {
        bail!("named session shortcut requires a session name");
    };
    if args.next().is_some() {
        bail!(
            "named session shortcut accepts one session name; use `fieldwork new --name <name> -- <cmd...>` to choose a command"
        );
    }
    let name = name
        .into_string()
        .map_err(|_| anyhow::anyhow!("named session shortcut requires a UTF-8 session name"))?;
    normalize_session_name(name)
}

fn auto_session_name(existing: &[SessionSummary]) -> String {
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
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    (nanos as usize ^ std::process::id() as usize) % AUTO_SESSION_NAMES.len()
}

async fn fetch_sessions() -> Result<Vec<SessionSummary>> {
    let (mut conn, _) = ipc::connect_local().await?;
    ipc::write_msg(&mut conn, &ClientToServerMsg::ListSessions).await?;
    match ipc::read_msg::<_, ServerToClientMsg>(&mut conn).await? {
        ServerToClientMsg::SessionList { sessions } => Ok(sessions),
        ServerToClientMsg::Error { message, .. } => bail!("{message}"),
        other => bail!("unexpected daemon response: {other:?}"),
    }
}

fn print_sessions(sessions: &[SessionSummary]) {
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

async fn create_session(dir: PathBuf, name: Option<String>, command: Vec<String>) -> Result<()> {
    let summary = create_session_summary(dir, name, command).await?;
    println!("created {}\t{}", summary.id, summary.name);
    Ok(())
}

async fn create_session_summary(
    dir: PathBuf,
    name: Option<String>,
    mut command: Vec<String>,
) -> Result<SessionSummary> {
    if command.is_empty() {
        command.push("claude".to_string());
    }
    let cwd = dir
        .canonicalize()
        .with_context(|| format!("canonicalize {}", dir.display()))?;
    let name = match name {
        Some(name) => normalize_session_name(name)?,
        None => session_name(&command, &cwd),
    };
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
        ServerToClientMsg::SessionCreated { summary, .. } => Ok(summary),
        ServerToClientMsg::Error { message, .. } => bail!("{message}"),
        other => bail!("unexpected daemon response: {other:?}"),
    }
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

async fn run_doctor(no_start: bool) -> Result<()> {
    let mut ok = true;

    println!("Fieldwork doctor");
    println!("version: {}", env!("CARGO_PKG_VERSION"));

    let cli_path = match std::env::current_exe() {
        Ok(path) => {
            print_doctor_check(&mut ok, "cli", true, path.display());
            Some(path)
        }
        Err(error) => {
            print_doctor_check(&mut ok, "cli", false, error);
            None
        }
    };

    let daemon_path = match service::daemon_path() {
        Ok(path) => {
            print_doctor_check(&mut ok, "daemon binary", true, path.display());
            Some(path)
        }
        Err(error) => {
            print_doctor_check(&mut ok, "daemon binary", false, error);
            None
        }
    };

    #[cfg(target_os = "macos")]
    match (cli_path.as_deref(), daemon_path.as_deref()) {
        (Some(cli_path), Some(daemon_path)) => {
            match doctor_macos_trust_status(cli_path, daemon_path) {
                Ok(detail) => print_doctor_check(&mut ok, "macOS trust", true, detail),
                Err(error) => print_doctor_check(&mut ok, "macOS trust", false, error),
            }
        }
        _ => print_doctor_check(
            &mut ok,
            "macOS trust",
            false,
            "requires colocated fieldwork and fieldworkd paths",
        ),
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = (cli_path.as_deref(), daemon_path.as_deref());
        println!("macOS trust: n/a (macOS-only)");
    }

    match service::status() {
        Ok(status) => println!("service: {}", service::format_status(&status)),
        Err(error) => println!("service: unavailable ({error})"),
    }

    let socket_path = ipc::control_socket_path();
    println!("socket path: {}", socket_path.display());

    let connection = if no_start {
        ipc::connect_existing()
            .await
            .map(|(conn, capabilities)| (conn, capabilities, "reachable".to_string()))
    } else {
        match ipc::connect_existing().await {
            Ok((conn, capabilities)) => Ok((conn, capabilities, "reachable".to_string())),
            Err(_) => ipc::connect_local()
                .await
                .map(|(conn, capabilities)| (conn, capabilities, "auto-started".to_string())),
        }
    };

    match connection {
        Ok((mut conn, capabilities, mode)) => {
            print_doctor_check(
                &mut ok,
                "daemon connection",
                true,
                format!("{mode} ({})", socket_path.display()),
            );
            match doctor_socket_parent_status(&socket_path) {
                Ok(detail) => print_doctor_check(&mut ok, "socket parent", true, detail),
                Err(error) => print_doctor_check(&mut ok, "socket parent", false, error),
            }
            match doctor_socket_file_status(&socket_path) {
                Ok(detail) => print_doctor_check(&mut ok, "socket file", true, detail),
                Err(error) => print_doctor_check(&mut ok, "socket file", false, error),
            }
            print_doctor_check(
                &mut ok,
                "protocol",
                true,
                format!("contract v{CONTRACT_VERSION}"),
            );
            println!(
                "push notifications: {}",
                if capabilities.push_notifications {
                    "configured"
                } else {
                    "off"
                }
            );

            if let Err(error) = ipc::write_msg(&mut conn, &ClientToServerMsg::ListSessions).await {
                print_doctor_check(&mut ok, "session list", false, error);
            } else {
                match ipc::read_msg::<_, ServerToClientMsg>(&mut conn).await {
                    Ok(ServerToClientMsg::SessionList { sessions }) => {
                        print_doctor_check(
                            &mut ok,
                            "session list",
                            true,
                            format!("{} session(s)", sessions.len()),
                        );
                    }
                    Ok(ServerToClientMsg::Error { message, .. }) => {
                        print_doctor_check(&mut ok, "session list", false, message);
                    }
                    Ok(other) => {
                        print_doctor_check(
                            &mut ok,
                            "session list",
                            false,
                            format!("unexpected daemon response: {other:?}"),
                        );
                    }
                    Err(error) => print_doctor_check(&mut ok, "session list", false, error),
                }
            }
        }
        Err(error) => print_doctor_check(
            &mut ok,
            "daemon connection",
            false,
            format!("{error} ({})", socket_path.display()),
        ),
    }

    match settings::telemetry_status() {
        Ok(status) => println!("telemetry: {}", if status.opt_in { "on" } else { "off" }),
        Err(error) => println!("telemetry: unavailable ({error})"),
    }

    match settings::scrollback_encryption_status() {
        Ok(status) => println!(
            "scrollback encryption: {}",
            if status.enabled { "on" } else { "off" }
        ),
        Err(error) => println!("scrollback encryption: unavailable ({error})"),
    }

    if ok {
        println!("summary: ok");
        Ok(())
    } else {
        bail!("fieldwork doctor found issues")
    }
}

fn doctor_socket_parent_status(socket_path: &Path) -> Result<String> {
    let parent = socket_path
        .parent()
        .context("control socket path has no parent directory")?;
    let metadata = fs::symlink_metadata(parent)
        .with_context(|| format!("stat control socket parent {}", parent.display()))?;
    if metadata.file_type().is_symlink() {
        bail!("parent is a symlink ({})", parent.display());
    }
    if !metadata.file_type().is_dir() {
        bail!("parent is not a directory ({})", parent.display());
    }

    let uid = metadata.uid();
    let euid = unsafe { libc::geteuid() };
    if uid != euid {
        bail!("owned by uid {uid}, expected current uid {euid}");
    }

    let mode = metadata.mode() & 0o777;
    if mode != 0o700 {
        bail!("mode is {mode:03o}, expected 0700 ({})", parent.display());
    }

    Ok(format!(
        "owned by current user, mode 0700, not symlink ({})",
        parent.display()
    ))
}

fn doctor_socket_file_status(socket_path: &Path) -> Result<String> {
    let metadata = fs::symlink_metadata(socket_path)
        .with_context(|| format!("stat control socket {}", socket_path.display()))?;
    if metadata.file_type().is_symlink() {
        bail!("socket is a symlink ({})", socket_path.display());
    }
    if !metadata.file_type().is_socket() {
        bail!("not a socket ({})", socket_path.display());
    }

    let mode = metadata.mode() & 0o777;
    if mode != 0o600 {
        bail!(
            "mode is {mode:03o}, expected 0600 ({})",
            socket_path.display()
        );
    }

    Ok(format!(
        "socket, mode 0600, not symlink ({})",
        socket_path.display()
    ))
}

#[cfg(any(target_os = "macos", test))]
#[derive(Debug, Clone, Copy, Eq, PartialEq)]
enum MacosSignatureKind {
    AdHoc,
    DeveloperId,
}

#[cfg(target_os = "macos")]
fn doctor_macos_trust_status(cli_path: &Path, daemon_path: &Path) -> Result<String> {
    let cli_signature = doctor_macos_binary_trust(cli_path, "fieldwork")?;
    let daemon_signature = doctor_macos_binary_trust(daemon_path, "fieldworkd")?;
    if cli_signature == MacosSignatureKind::DeveloperId {
        doctor_macos_notarization_status(cli_path, "fieldwork")?;
        doctor_macos_notarization_status(daemon_path, "fieldworkd")?;
    }
    let mode = macos_trust_mode_from_signature_kinds(cli_signature, daemon_signature)?;
    Ok(format!(
        "{mode} (fieldwork and fieldworkd signed, executable, no quarantine)"
    ))
}

#[cfg(target_os = "macos")]
fn doctor_macos_binary_trust(path: &Path, name: &str) -> Result<MacosSignatureKind> {
    use std::os::unix::fs::PermissionsExt;

    let mode = fs::metadata(path)
        .with_context(|| format!("stat {name} at {}", path.display()))?
        .permissions()
        .mode();
    if mode & 0o111 == 0 {
        bail!("{name} is not executable ({})", path.display());
    }

    let verify = std::process::Command::new("codesign")
        .args(["--verify", "--verbose=4"])
        .arg(path)
        .output()
        .with_context(|| {
            format!(
                "verify macOS code signature for {name} at {}",
                path.display()
            )
        })?;
    if !verify.status.success() {
        bail!(
            "{name} code signature verification failed for {}: {}",
            path.display(),
            doctor_command_output_detail(&verify, "codesign")
        );
    }

    let display = std::process::Command::new("codesign")
        .args(["--display", "--verbose=4"])
        .arg(path)
        .output()
        .with_context(|| format!("read macOS code signature for {name} at {}", path.display()))?;
    if !display.status.success() {
        bail!(
            "{name} code signature display failed for {}: {}",
            path.display(),
            doctor_command_output_detail(&display, "codesign")
        );
    }
    let signature = format!(
        "{}\n{}",
        String::from_utf8_lossy(&display.stdout),
        String::from_utf8_lossy(&display.stderr)
    );
    let signature_kind = parse_macos_signature_kind(&signature).with_context(|| {
        format!(
            "{name} has unsupported macOS signature at {}",
            path.display()
        )
    })?;

    let quarantine = std::process::Command::new("xattr")
        .args(["-p", "com.apple.quarantine"])
        .arg(path)
        .output()
        .with_context(|| {
            format!(
                "read macOS quarantine xattr for {name} at {}",
                path.display()
            )
        })?;
    let quarantine_value = format!(
        "{}{}",
        String::from_utf8_lossy(&quarantine.stdout),
        String::from_utf8_lossy(&quarantine.stderr)
    )
    .trim()
    .to_string();
    if quarantine.status.success() && !quarantine_value.is_empty() {
        bail!(
            "{name} has com.apple.quarantine set at {}: {quarantine_value}",
            path.display()
        );
    }

    Ok(signature_kind)
}

#[cfg(target_os = "macos")]
fn doctor_macos_notarization_status(path: &Path, name: &str) -> Result<()> {
    let assessment = std::process::Command::new("spctl")
        .args(["-a", "-vvv", "-t", "exec"])
        .arg(path)
        .output()
        .with_context(|| format!("assess macOS notarization for {name} at {}", path.display()))?;
    let detail = doctor_command_output_detail(&assessment, "spctl");
    if !assessment.status.success() || !detail.to_ascii_lowercase().contains("notarized") {
        bail!(
            "{name} has a Developer ID signature, but notarization was not confirmed for {}: {detail}",
            path.display()
        );
    }
    Ok(())
}

#[cfg(any(target_os = "macos", test))]
fn parse_macos_signature_kind(signature: &str) -> Result<MacosSignatureKind> {
    if signature.contains("Signature=adhoc") || signature.contains("Authority=Ad Hoc") {
        return Ok(MacosSignatureKind::AdHoc);
    }
    if signature.contains("Authority=Developer ID Application:") {
        return Ok(MacosSignatureKind::DeveloperId);
    }
    bail!("signature is neither ad-hoc nor Developer ID")
}

#[cfg(any(target_os = "macos", test))]
fn macos_trust_mode_from_signature_kinds(
    cli_signature: MacosSignatureKind,
    daemon_signature: MacosSignatureKind,
) -> Result<&'static str> {
    match (cli_signature, daemon_signature) {
        (MacosSignatureKind::AdHoc, MacosSignatureKind::AdHoc) => Ok("npm/ad-hoc/not-notarized"),
        (MacosSignatureKind::DeveloperId, MacosSignatureKind::DeveloperId) => {
            Ok("Developer ID/notarized")
        }
        (cli_signature, daemon_signature) => bail!(
            "fieldwork and fieldworkd must use the same macOS trust mode, got {cli_signature:?} and {daemon_signature:?}"
        ),
    }
}

#[cfg(target_os = "macos")]
fn doctor_command_output_detail(output: &std::process::Output, command: &str) -> String {
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    match (stdout.is_empty(), stderr.is_empty()) {
        (true, true) => format!("{command} exited with {}", output.status),
        (false, true) => stdout,
        (true, false) => stderr,
        (false, false) => format!("{stdout}\n{stderr}"),
    }
}

fn print_doctor_check(ok: &mut bool, label: &str, passed: bool, detail: impl std::fmt::Display) {
    if !passed {
        *ok = false;
    }
    println!("{label}: {} ({detail})", if passed { "ok" } else { "fail" });
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
    normalized_terminal_size(cols, rows)
}

fn normalized_terminal_size(cols: u16, rows: u16) -> ClientSize {
    ClientSize {
        cols: if cols == 0 { 80 } else { cols },
        rows: if rows == 0 { 24 } else { rows },
    }
}

fn session_name(command: &[String], cwd: &std::path::Path) -> String {
    let dir = cwd
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("work");
    format!("{} · {dir}", command[0])
}

fn normalize_session_name(name: String) -> Result<String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        bail!("session name cannot be empty");
    }
    if name.chars().any(char::is_control) {
        bail!("session name cannot contain control characters");
    }
    Ok(name)
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
    use super::{
        AUTO_SESSION_NAMES, Cli, Command, HookCommand, MacosSignatureKind, auto_session_name,
        cli_command_with_bin_name, codex_state_from_json, codex_states_from_payload,
        completion_bin_name_with_override, doctor_socket_file_status, doctor_socket_parent_status,
        macos_trust_mode_from_signature_kinds, normalize_session_name, parse_macos_signature_kind,
        parse_named_shortcut_args, should_check_update_notice,
    };
    use clap::Parser;
    use clap_complete::Shell;
    use fieldwork_protocol::{AgentState, SessionId};
    use std::ffi::OsString;
    use std::fs;
    use std::os::unix::fs::{PermissionsExt, symlink};
    use std::os::unix::net::UnixListener;
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
    fn parses_codex_jsonl_event_stream() {
        assert_eq!(
            codex_states_from_payload(
                r#"{"type":"turn_started"}
{"type":"event","status":"working"}
{"type":"approval_requested","request_id":"redacted"}
{"type":"turn_finished"}"#
            ),
            Some(vec![
                AgentState::Working,
                AgentState::Working,
                AgentState::AwaitingInput,
                AgentState::Idle,
            ])
        );
    }

    #[test]
    fn ignores_unrecognized_codex_stream_events() {
        assert_eq!(
            codex_states_from_payload(
                r#"{"type":"session_configured"}
{"type":"event","status":"turn_waiting"}
{"type":"noise"}"#
            ),
            Some(vec![AgentState::AwaitingInput])
        );
        assert_eq!(
            codex_states_from_payload(r#"{"type":"session_configured"}"#),
            None
        );
    }

    #[test]
    fn update_notice_skips_machine_and_terminal_streaming_commands() {
        assert!(!should_check_update_notice(None));
        assert!(should_check_update_notice(Some(&Command::Ls)));
        assert!(should_check_update_notice(Some(&Command::New {
            dir: PathBuf::from("."),
            name: None,
            command: vec!["bash".to_string()],
        })));
        assert!(should_check_update_notice(Some(&Command::Doctor {
            no_start: true,
        })));

        assert!(!should_check_update_notice(Some(&Command::Pair)));
        assert!(!should_check_update_notice(Some(&Command::Attach {
            session: "first".to_string(),
        })));
        assert!(!should_check_update_notice(Some(&Command::Hook {
            command: HookCommand::CodexEvent { session: None },
        })));
        assert!(!should_check_update_notice(Some(&Command::Completion {
            shell: Shell::Bash,
        })));
        assert!(!should_check_update_notice(Some(&Command::Version)));
        assert!(!should_check_update_notice(Some(&Command::Named(vec![
            OsString::from("refactoringjob"),
        ]))));
    }

    #[test]
    fn no_args_parse_to_no_args_fast_path() {
        let cli = Cli::try_parse_from(["fieldwork"]).expect("no-arg CLI parses");
        assert!(cli.command.is_none());
    }

    #[test]
    fn completion_bin_name_follows_invoked_alias() {
        assert_eq!(
            completion_bin_name_with_override(None, Some(OsString::from("/usr/local/bin/fw"))),
            "fw"
        );
        assert_eq!(
            completion_bin_name_with_override(None, Some(OsString::from("fieldwork"))),
            "fieldwork"
        );
        assert_eq!(completion_bin_name_with_override(None, None), "fieldwork");
    }

    #[test]
    fn completion_bin_name_prefers_npm_dispatcher_alias() {
        assert_eq!(
            completion_bin_name_with_override(
                Some(OsString::from("fw")),
                Some(OsString::from("/package/bin/fieldwork"))
            ),
            "fw"
        );
    }

    #[test]
    fn help_usage_follows_invoked_alias() {
        let mut fw_command = cli_command_with_bin_name("fw".to_string());
        let fw_help = fw_command.render_help().to_string();
        assert!(fw_help.contains("Usage: fw [COMMAND]"));
        assert!(!fw_help.contains("Usage: fieldwork [COMMAND]"));

        let mut fieldwork_command = cli_command_with_bin_name("fieldwork".to_string());
        let fieldwork_help = fieldwork_command.render_help().to_string();
        assert!(fieldwork_help.contains("Usage: fieldwork [COMMAND]"));
    }

    #[test]
    fn version_flag_follows_invoked_alias() {
        let fw_command = cli_command_with_bin_name("fw".to_string());
        assert_eq!(
            fw_command.render_version().to_string(),
            format!("fw {}\n", env!("CARGO_PKG_VERSION"))
        );

        let fieldwork_command = cli_command_with_bin_name("fieldwork".to_string());
        assert_eq!(
            fieldwork_command.render_version().to_string(),
            format!("fieldwork {}\n", env!("CARGO_PKG_VERSION"))
        );
    }

    #[test]
    fn unknown_subcommand_parses_to_named_shortcut() {
        let cli =
            Cli::try_parse_from(["fieldwork", "refactoringjob"]).expect("named shortcut parses");
        let Some(Command::Named(args)) = cli.command else {
            panic!("expected named shortcut command");
        };
        assert_eq!(args, vec![OsString::from("refactoringjob")]);
    }

    #[test]
    fn doctor_parses_with_no_start_flag() {
        let cli = Cli::try_parse_from(["fw", "doctor", "--no-start"]).expect("doctor parses");
        let Some(Command::Doctor { no_start }) = cli.command else {
            panic!("expected doctor command");
        };
        assert!(no_start);
    }

    #[test]
    fn doctor_parses_macos_trust_signature_modes() {
        assert_eq!(
            parse_macos_signature_kind(
                "Executable=/tmp/fieldwork\nIdentifier=fieldwork\nSignature=adhoc"
            )
            .unwrap(),
            MacosSignatureKind::AdHoc
        );
        assert_eq!(
            parse_macos_signature_kind(
                "Authority=Developer ID Application: Fieldwork Project (ABCDE12345)\nTeamIdentifier=ABCDE12345"
            )
            .unwrap(),
            MacosSignatureKind::DeveloperId
        );
        assert!(parse_macos_signature_kind("Signature size=0").is_err());
    }

    #[test]
    fn doctor_reports_only_consistent_macos_trust_modes() {
        assert_eq!(
            macos_trust_mode_from_signature_kinds(
                MacosSignatureKind::AdHoc,
                MacosSignatureKind::AdHoc
            )
            .unwrap(),
            "npm/ad-hoc/not-notarized"
        );
        assert_eq!(
            macos_trust_mode_from_signature_kinds(
                MacosSignatureKind::DeveloperId,
                MacosSignatureKind::DeveloperId
            )
            .unwrap(),
            "Developer ID/notarized"
        );
        assert!(
            macos_trust_mode_from_signature_kinds(
                MacosSignatureKind::AdHoc,
                MacosSignatureKind::DeveloperId
            )
            .is_err()
        );
    }

    #[test]
    fn doctor_accepts_hardened_socket_parent_and_socket() {
        let tmp = tempfile::tempdir().unwrap();
        let runtime = tmp.path().join("runtime");
        let socket = runtime.join("control.sock");
        fs::create_dir(&runtime).unwrap();
        fs::set_permissions(&runtime, fs::Permissions::from_mode(0o700)).unwrap();
        let _listener = UnixListener::bind(&socket).unwrap();
        fs::set_permissions(&socket, fs::Permissions::from_mode(0o600)).unwrap();

        let parent_status = doctor_socket_parent_status(&socket).unwrap();
        let socket_status = doctor_socket_file_status(&socket).unwrap();

        assert!(parent_status.contains("mode 0700"));
        assert!(parent_status.contains("not symlink"));
        assert!(socket_status.contains("mode 0600"));
        assert!(socket_status.contains("not symlink"));
    }

    #[test]
    fn doctor_rejects_world_readable_socket_parent() {
        let tmp = tempfile::tempdir().unwrap();
        let runtime = tmp.path().join("runtime");
        let socket = runtime.join("control.sock");
        fs::create_dir(&runtime).unwrap();
        fs::set_permissions(&runtime, fs::Permissions::from_mode(0o755)).unwrap();

        let error = doctor_socket_parent_status(&socket).unwrap_err();

        assert!(error.to_string().contains("expected 0700"));
    }

    #[test]
    fn doctor_rejects_symlinked_socket_parent() {
        let tmp = tempfile::tempdir().unwrap();
        let real = tmp.path().join("real");
        let linked = tmp.path().join("linked");
        fs::create_dir(&real).unwrap();
        symlink(&real, &linked).unwrap();

        let error = doctor_socket_parent_status(&linked.join("control.sock")).unwrap_err();

        assert!(error.to_string().contains("parent is a symlink"));
    }

    #[test]
    fn doctor_rejects_socket_with_loose_permissions() {
        let tmp = tempfile::tempdir().unwrap();
        let socket = tmp.path().join("control.sock");
        let _listener = UnixListener::bind(&socket).unwrap();
        fs::set_permissions(&socket, fs::Permissions::from_mode(0o666)).unwrap();

        let error = doctor_socket_file_status(&socket).unwrap_err();

        assert!(error.to_string().contains("expected 0600"));
    }

    #[test]
    fn doctor_rejects_non_socket_file() {
        let tmp = tempfile::tempdir().unwrap();
        let socket = tmp.path().join("control.sock");
        fs::write(&socket, b"not a socket").unwrap();
        fs::set_permissions(&socket, fs::Permissions::from_mode(0o600)).unwrap();

        let error = doctor_socket_file_status(&socket).unwrap_err();

        assert!(error.to_string().contains("not a socket"));
    }

    #[test]
    fn new_accepts_explicit_name() {
        let cli = Cli::try_parse_from(["fieldwork", "new", "--name", "refactoringjob", "bash"])
            .expect("named new parses");
        let Some(Command::New { name, command, .. }) = cli.command else {
            panic!("expected new command");
        };
        assert_eq!(name.as_deref(), Some("refactoringjob"));
        assert_eq!(command, vec!["bash".to_string()]);
    }

    #[test]
    fn named_shortcut_requires_exactly_one_valid_name() {
        assert_eq!(
            parse_named_shortcut_args(vec![OsString::from("  refactoringjob  ")])
                .expect("valid shortcut"),
            "refactoringjob"
        );
        assert!(parse_named_shortcut_args(Vec::new()).is_err());
        assert!(
            parse_named_shortcut_args(vec![
                OsString::from("refactoringjob"),
                OsString::from("bash")
            ])
            .is_err()
        );
        assert!(normalize_session_name("line\nbreak".to_string()).is_err());
    }

    #[test]
    fn auto_session_names_are_one_word_and_avoid_collisions() {
        let name = auto_session_name(&[]);
        assert!(AUTO_SESSION_NAMES.contains(&name.as_str()));
        assert!(
            name.chars()
                .all(|ch| !ch.is_whitespace() && !ch.is_control())
        );

        let existing: Vec<_> = AUTO_SESSION_NAMES
            .iter()
            .map(|name| test_summary(name))
            .collect();
        let fallback = auto_session_name(&existing);
        assert!(!existing.iter().any(|session| session.name == fallback));
        assert!(
            fallback
                .chars()
                .all(|ch| !ch.is_whitespace() && !ch.is_control())
        );
    }

    #[test]
    fn terminal_size_normalization_replaces_zero_dimensions() {
        let size = super::normalized_terminal_size(0, 0);
        assert_eq!(size.cols, 80);
        assert_eq!(size.rows, 24);

        let size = super::normalized_terminal_size(120, 0);
        assert_eq!(size.cols, 120);
        assert_eq!(size.rows, 24);
    }

    fn test_summary(name: &str) -> fieldwork_protocol::SessionSummary {
        fieldwork_protocol::SessionSummary {
            id: SessionId::new(),
            name: name.to_string(),
            command: vec!["claude".to_string()],
            cwd: PathBuf::from("."),
            created_at: 0,
            last_activity: 0,
            state: AgentState::Idle,
            last_line: None,
            model: None,
        }
    }
}
