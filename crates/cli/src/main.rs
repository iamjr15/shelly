mod attach_ui;
mod clock;
mod ipc;
#[cfg(feature = "test-client")]
mod iroh_client;
mod service;
mod settings;
mod terminal;
mod update_notice;

use anyhow::{Context, Result, bail};
use clap::{CommandFactory, FromArgMatches, Parser, Subcommand};
use clap_complete::Shell;
use crossterm::terminal::enable_raw_mode;
use qrcode::{QrCode, render::unicode};
use shelly_cli::attach_loop::{
    AttachIo, AttachOutcome, DetachState, InputEvent, TerminalRenderer, run_attach_session,
};
use shelly_protocol::{
    AgentSource, AgentState, CONTRACT_VERSION, ClientSize, ClientToServerMsg, ServerToClientMsg,
    SessionId, SessionSummary,
};
use std::collections::HashMap;
use std::ffi::OsString;
use std::fs;
use std::io::{IsTerminal, Read, Write};
use std::os::unix::fs::{FileTypeExt, MetadataExt};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tokio::sync::mpsc;

#[derive(Parser)]
#[command(name = "shelly")]
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
    #[cfg(feature = "test-client")]
    PairTest {
        #[arg(long)]
        payload: Option<String>,
        #[arg(long)]
        code: Option<String>,
        #[arg(long)]
        relay_control_url: Option<String>,
        #[arg(long, default_value = "Shelly Test Client")]
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
        expect_local_cli_forbidden: bool,
        #[arg(long)]
        expect_create_and_kill: bool,
        #[arg(long)]
        expect_forbidden_agent_event: bool,
        #[arg(long)]
        print_ticket: bool,
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
    #[command(name = "kill-all")]
    KillAll,
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
    #[command(about = "Check local Shelly CLI and daemon health")]
    Doctor {
        #[arg(long, help = "Do not auto-start shellyd while checking the socket")]
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

/// Ensure a process-default rustls `CryptoProvider` is installed before any TLS
/// work. reqwest is built with `rustls-no-provider`, so constructing a client
/// panics with "No provider set" unless a default provider exists. Idempotent, so
/// it is safe to call from every client-construction site (including unit tests
/// that never run `main`).
pub(crate) fn ensure_crypto_provider() {
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    ensure_crypto_provider();
    terminal::install_panic_restore_hook();
    let cli = parse_cli_for_current_invocation();
    // Run the npm update check concurrently so a stale cache never delays
    // command output; awaited after the command so the cache write completes.
    let update_check = should_check_update_notice(cli.command.as_ref())
        .then(|| tokio::spawn(update_notice::maybe_print_update_notice()));
    let result = match cli.command {
        None => run_default().await,
        Some(Command::Pair) => pair_device().await,
        #[cfg(feature = "test-client")]
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
            expect_local_cli_forbidden,
            expect_create_and_kill,
            expect_forbidden_agent_event,
            print_ticket,
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
                expect_local_cli_forbidden,
                expect_create_and_kill,
                expect_forbidden_agent_event,
                print_ticket,
            })
            .await
        }
        Some(Command::Ls) => list_sessions().await,
        Some(Command::New { dir, name, command }) => create_session(dir, name, command).await,
        Some(Command::Attach { session }) => attach_session(session).await,
        Some(Command::Kill { session }) => kill_session(session).await,
        Some(Command::KillAll) => kill_all_sessions().await,
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
                    ipc::print_daemon_starting();
                    service::install()?;
                    if let Err(error) = ipc::wait_for_existing_daemon().await {
                        let _ = service::uninstall();
                        return Err(
                            error.context("started shellyd user service but health check failed")
                        );
                    }
                    println!("installed and started shellyd user service");
                }
                DaemonCommand::Uninstall => {
                    service::uninstall()?;
                    println!("uninstalled shellyd user service");
                }
                DaemonCommand::Status => daemon_status().await?,
                DaemonCommand::Start => {
                    let _ = ipc::connect_local().await?;
                    println!(
                        "shellyd is running at {}",
                        ipc::control_socket_path().display()
                    );
                }
                DaemonCommand::Restart => {
                    ipc::print_daemon_starting();
                    service::restart()?;
                    ipc::wait_for_existing_daemon()
                        .await
                        .context("restarted shellyd user service but health check failed")?;
                    println!("restarted shellyd user service");
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
            println!("shelly {}", env!("CARGO_PKG_VERSION"));
            Ok(())
        }
        Some(Command::Named(args)) => open_named_session(args).await,
    };
    if let Some(handle) = update_check {
        let _ = handle.await;
    }
    result
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
        "shelly" => "shelly",
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
            | Some(Command::KillAll)
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
        std::env::var_os("SHELLY_CLI_BIN_NAME"),
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
        .unwrap_or("shelly")
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
                println!("restart shellyd for this setting to affect the running daemon");
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
                println!("restart shellyd for this setting to affect the running daemon");
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
    let depth = color_depth();
    let use_ansi = depth != ColorDepth::Plain;
    let live = use_ansi && terminal_cursor_control_enabled();
    let mut termination =
        terminal::TerminationSignals::new().context("register terminal signals")?;

    if pairing_remaining_seconds(ticket.expires_at) == 0 {
        bail!("pairing code expired. Run `shelly pair` again.");
    }

    let mut screen_size = terminal_size();
    let mut alt_screen = None;
    let mut status_row = 0usize;
    if live {
        alt_screen = Some(LiveScreenGuard::enter()?);
        status_row = draw_pairing_ceremony(
            &ticket.code,
            &qr,
            screen_size,
            depth,
            pairing_remaining_seconds(ticket.expires_at),
        )?;
    } else {
        let qr_image = render_pairing_qr_for_terminal(&qr, screen_size, depth);
        draw_pairing_screen_plain(
            &ticket.code,
            qr_image.as_deref(),
            qr.width(),
            depth,
            use_ansi,
        );
        print_pairing_countdown(ticket.expires_at, use_ansi, true)?;
    }

    let tick = if live {
        Duration::from_millis(80)
    } else {
        Duration::from_secs(1)
    };
    let mut countdown = tokio::time::interval_at(tokio::time::Instant::now() + tick, tick);
    countdown.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut spinner_frame = 0usize;
    let ctrl_c = tokio::signal::ctrl_c();
    tokio::pin!(ctrl_c);

    loop {
        let message = {
            let read = ipc::read_msg::<_, ServerToClientMsg>(&mut conn);
            tokio::pin!(read);
            loop {
                tokio::select! {
                    message = &mut read => break message?,
                    _ = &mut ctrl_c => {
                        drop(alt_screen.take());
                        std::process::exit(130);
                    }
                    signal = termination.recv() => {
                        drop(alt_screen.take());
                        terminal::restore_and_reraise(signal);
                    }
                    _ = countdown.tick() => {
                        let remaining = pairing_remaining_seconds(ticket.expires_at);
                        if live {
                            if remaining == 0 {
                                drop(alt_screen.take());
                                println!("{} Code expired", style_ansi("✗", true, ANSI_RED));
                                println!("  {}", style_dim("shelly pair — open a new window", true));
                                std::process::exit(1);
                            }
                            let now = terminal_size();
                            if now.cols != screen_size.cols || now.rows != screen_size.rows {
                                screen_size = now;
                                status_row = draw_pairing_ceremony(
                                    &ticket.code,
                                    &qr,
                                    screen_size,
                                    depth,
                                    remaining,
                                )?;
                            }
                            spinner_frame = spinner_frame.wrapping_add(1);
                            redraw_pairing_status(
                                status_row,
                                spinner_frame,
                                remaining,
                                depth,
                                screen_size,
                            )?;
                        } else if !print_pairing_countdown(ticket.expires_at, use_ansi, false)? {
                            bail!("pairing code expired. Run `shelly pair` again.");
                        }
                    }
                }
            }
        };

        match message {
            ServerToClientMsg::PairingApprovalRequested {
                request_id,
                device_name,
                sas,
                ..
            } => {
                let name = sanitize_device_name(&device_name);
                drop(alt_screen.take());
                let approved = confirm_pairing_sas(&name, &sas).await?;
                ipc::write_msg(
                    &mut conn,
                    &ClientToServerMsg::ApprovePairing {
                        request_id,
                        approved,
                    },
                )
                .await?;
                if !approved {
                    bail!("pairing denied; the device was not saved");
                }
                if use_ansi {
                    println!(
                        "{} Approved pairing for {}",
                        style_ansi("✓", true, ANSI_GREEN),
                        style_bold(&name, true)
                    );
                    println!(
                        "  {}",
                        style_dim("shelly devices — list and manage paired devices", true)
                    );
                } else {
                    println!("Approved pairing for {name}.");
                }
                return Ok(());
            }
            ServerToClientMsg::Error { message, .. } => bail!("{message}"),
            _ => {}
        }
    }
}

async fn confirm_pairing_sas(device_name: &str, sas: &str) -> Result<bool> {
    println!();
    println!("Pairing request from {device_name}");
    println!("Compare this security fingerprint with the phone:");
    println!();
    println!("    {sas}");
    println!();
    print!("Press Y to approve; any other key denies: ");
    std::io::stdout()
        .flush()
        .context("flush pairing approval prompt")?;

    let terminal_input = std::io::stdin().is_terminal();
    let _raw = terminal_input.then(RawMode::enter).transpose()?;
    let key = tokio::task::spawn_blocking(|| {
        let mut byte = [0_u8; 1];
        match std::io::stdin().read(&mut byte) {
            Ok(1) => Ok(Some(byte[0])),
            Ok(_) => Ok(None),
            Err(error) => Err(error),
        }
    })
    .await
    .context("join pairing approval input reader")?
    .context("read pairing approval key")?;
    if terminal_input {
        println!();
    }
    Ok(key.is_some_and(|key| matches!(key, b'y' | b'Y')))
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

fn short_node_id(node_id: &str) -> String {
    node_id.chars().take(12).collect()
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

const ANSI_RESET: &str = "\x1b[0m";
const ANSI_BOLD: &str = "\x1b[1m";
const ANSI_DIM: &str = "\x1b[2m";
const ANSI_AMBER: &str = "\x1b[33m";
const ANSI_RED: &str = "\x1b[31m";
const ANSI_GREEN: &str = "\x1b[32m";
const ANSI_QR_LIGHT_PANEL: &str = "\x1b[30;107m";
const QR_QUIET_ZONE_MODULES: usize = 4;
/// Rows the pairing screen needs besides the QR panel itself.
const PAIRING_TEXT_ROWS: usize = 10;
/// Brand accent; must stay in sync with ShellyOrange in the Android app theme.
const SHELLY_ORANGE_RGB: (u8, u8, u8) = (232, 93, 41);
/// Nearest xterm-256 index to ShellyOrange for terminals without truecolor.
const SHELLY_ORANGE_ANSI256: u8 = 166;
/// Keycap ink: explicit near-black so terminal palettes cannot wash it out.
const SHELLY_CHIP_INK_RGB: (u8, u8, u8) = (21, 10, 5);
const PAIRING_COUNTDOWN_AMBER_SECS: u64 = 120;
const PAIRING_COUNTDOWN_RED_SECS: u64 = 30;
const PAIRING_SPINNER_FRAMES: [&str; 10] = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const PAIRING_STATUS_LABEL: &str = "waiting for device";
/// Slanted ASCII wordmark shown when the pane can spare the rows; ASCII-only
/// so it renders wherever a shell does.
const PAIRING_WORDMARK: [&str; 6] = [
    "         __         ____",
    "   _____/ /_  ___  / / /_  __",
    "  / ___/ __ \\/ _ \\/ / / / / /",
    " (__  ) / / /  __/ / / /_/ /",
    "/____/_/ /_/\\___/_/_/\\__, /",
    "                    /____/",
];
const PAIRING_WORDMARK_COLS: usize = 29;

fn ansi_output_enabled() -> bool {
    if std::env::var_os("NO_COLOR").is_some() {
        return false;
    }
    if std::env::var_os("FORCE_COLOR").is_some() {
        return true;
    }

    std::io::stdout().is_terminal()
        && std::env::var("TERM")
            .map(|term| term != "dumb")
            .unwrap_or(true)
}

fn terminal_cursor_control_enabled() -> bool {
    std::io::stdout().is_terminal()
        && std::env::var("TERM")
            .map(|term| term != "dumb")
            .unwrap_or(true)
}

fn style_bold(text: &str, use_ansi: bool) -> String {
    style_ansi(text, use_ansi, ANSI_BOLD)
}

fn style_dim(text: &str, use_ansi: bool) -> String {
    style_ansi(text, use_ansi, ANSI_DIM)
}

fn style_ansi(text: &str, use_ansi: bool, code: &str) -> String {
    if use_ansi {
        format!("{code}{text}{ANSI_RESET}")
    } else {
        text.to_string()
    }
}

/// Terminal color capability for the pairing screen's brand accent.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum ColorDepth {
    Plain,
    Ansi16,
    Ansi256,
    TrueColor,
}

fn color_depth() -> ColorDepth {
    if !ansi_output_enabled() {
        return ColorDepth::Plain;
    }
    color_depth_from_env(
        std::env::var("TERM").ok().as_deref(),
        std::env::var("COLORTERM").ok().as_deref(),
    )
}

/// Picks the deepest color support advertised by TERM/COLORTERM; callers gate
/// on [`ansi_output_enabled`] first.
fn color_depth_from_env(term: Option<&str>, colorterm: Option<&str>) -> ColorDepth {
    if colorterm
        .is_some_and(|ct| ct.eq_ignore_ascii_case("truecolor") || ct.eq_ignore_ascii_case("24bit"))
    {
        return ColorDepth::TrueColor;
    }
    if term.is_some_and(|t| t.contains("256color")) {
        return ColorDepth::Ansi256;
    }
    ColorDepth::Ansi16
}

fn style_brand(text: &str, depth: ColorDepth) -> String {
    let (r, g, b) = SHELLY_ORANGE_RGB;
    let code = match depth {
        ColorDepth::Plain => return text.to_string(),
        ColorDepth::Ansi16 => ANSI_AMBER.to_string(),
        ColorDepth::Ansi256 => format!("\x1b[38;5;{SHELLY_ORANGE_ANSI256}m"),
        ColorDepth::TrueColor => format!("\x1b[38;2;{r};{g};{b}m"),
    };
    format!("{code}{text}{ANSI_RESET}")
}

/// Near-black ink on orange for the code keycaps, one step per color depth.
/// Above ANSI-16 the ink is explicit so themes cannot repaint it.
fn keycap_style_code(depth: ColorDepth) -> Option<String> {
    let (r, g, b) = SHELLY_ORANGE_RGB;
    let (ir, ig, ib) = SHELLY_CHIP_INK_RGB;
    match depth {
        ColorDepth::Plain => None,
        ColorDepth::Ansi16 => Some("\x1b[30;43m".to_string()),
        ColorDepth::Ansi256 => Some(format!("\x1b[38;5;16;48;5;{SHELLY_ORANGE_ANSI256}m")),
        ColorDepth::TrueColor => Some(format!("\x1b[38;2;{ir};{ig};{ib};48;2;{r};{g};{b}m")),
    }
}

/// Renders the pairing code as two groups of keycap chips; returns the styled
/// row and its visible width in columns.
fn keycap_row(code: &str, depth: ColorDepth) -> (String, usize) {
    let grouped = group_code(code);
    let Some(chip) = keycap_style_code(depth) else {
        let cols = grouped.chars().count();
        return (grouped, cols);
    };
    let mut styled = String::new();
    let mut visible = 0usize;
    let mut group_gap = false;
    for ch in grouped.chars() {
        if ch == ' ' {
            group_gap = true;
            continue;
        }
        if visible > 0 {
            let gap = if group_gap { "   " } else { " " };
            styled.push_str(gap);
            visible += gap.len();
            group_gap = false;
        }
        styled.push_str(&chip);
        styled.push(' ');
        styled.push(ch);
        styled.push(' ');
        styled.push_str(ANSI_RESET);
        visible += 3;
    }
    (styled, visible)
}

/// One line of live status: spinner, label, and a countdown that escalates
/// dim → amber (≤2:00) → red (≤0:30).
fn render_pairing_status(frame: usize, remaining_secs: u64, depth: ColorDepth) -> (String, usize) {
    let spinner = PAIRING_SPINNER_FRAMES[frame % PAIRING_SPINNER_FRAMES.len()];
    let countdown = format!("expires in {}", format_pairing_countdown(remaining_secs));
    let visible = 2 + PAIRING_STATUS_LABEL.chars().count() + 5 + countdown.chars().count();
    let urgency = if remaining_secs <= PAIRING_COUNTDOWN_RED_SECS {
        ANSI_RED
    } else if remaining_secs <= PAIRING_COUNTDOWN_AMBER_SECS {
        ANSI_AMBER
    } else {
        ANSI_DIM
    };
    let styled = format!(
        "{} {PAIRING_STATUS_LABEL}  {}  {}",
        style_brand(spinner, depth),
        style_dim("·", true),
        style_ansi(&countdown, true, urgency)
    );
    (styled, visible)
}

fn centered_line(styled: &str, visible_cols: usize, terminal_cols: u16) -> String {
    let pad = " ".repeat(centered_padding(visible_cols, terminal_cols));
    format!("{pad}{styled}")
}

/// Redraws the live status line in place via absolute addressing inside the
/// alternate screen; immune to line rewrapping, unlike relative cursor moves.
fn redraw_pairing_status(
    status_row: usize,
    frame: usize,
    remaining_secs: u64,
    depth: ColorDepth,
    terminal: ClientSize,
) -> Result<()> {
    let (status, visible) = render_pairing_status(frame, remaining_secs, depth);
    let line = centered_line(&status, visible, terminal.cols);
    print!("\x1b[{status_row};1H\x1b[2K{line}");
    std::io::stdout().flush().context("redraw pairing status")
}

/// Switches to the alternate screen with the cursor hidden; restores the
/// primary screen and cursor when dropped, including on error returns.
struct LiveScreenGuard;

impl LiveScreenGuard {
    fn enter() -> Result<Self> {
        let mut stdout = std::io::stdout();
        write!(stdout, "\x1b[?1049h\x1b[H\x1b[2J\x1b[?25l")
            .and_then(|_| stdout.flush())
            .context("enter pairing screen")?;
        terminal::mark_alt_screen_active();
        Ok(Self)
    }
}

impl Drop for LiveScreenGuard {
    fn drop(&mut self) {
        terminal::restore_alt_screen();
    }
}

/// Untrusted remote device names: strip control characters (ANSI injection),
/// trim, and cap length so the prompt stays one line.
fn sanitize_device_name(name: &str) -> String {
    let cleaned: String = name.chars().filter(|c| !c.is_control()).collect();
    let trimmed: String = cleaned.trim().chars().take(48).collect();
    if trimmed.is_empty() {
        "device".to_string()
    } else {
        trimmed
    }
}

/// The wordmark costs its rows minus the one-line header it replaces, and is
/// the first thing dropped when the pane is tight.
fn pairing_wordmark_fits(qr_modules: usize, terminal: ClientSize) -> bool {
    let (_, qr_rows) = pairing_qr_terminal_dimensions(qr_modules);
    usize::from(terminal.cols) >= PAIRING_WORDMARK_COLS
        && usize::from(terminal.rows) >= qr_rows + PAIRING_TEXT_ROWS + (PAIRING_WORDMARK.len() - 1)
}

/// Builds every centered line of the pairing ceremony for the given pane
/// size. The tail is always status, blank, hint, so the live status line
/// sits third from the end.
fn pairing_screen_lines(
    code: &str,
    qr_image: Option<&str>,
    qr_modules: usize,
    terminal: ClientSize,
    depth: ColorDepth,
    remaining_secs: u64,
) -> Vec<String> {
    let cols = terminal.cols;
    let mut lines = Vec::new();
    if qr_image.is_some() && pairing_wordmark_fits(qr_modules, terminal) {
        for line in PAIRING_WORDMARK {
            lines.push(centered_line(
                &style_brand(line, depth),
                PAIRING_WORDMARK_COLS,
                cols,
            ));
        }
    } else {
        let header = format!(
            "{} {}",
            style_brand("▸", depth),
            style_bold("shelly pair", true)
        );
        lines.push(centered_line(
            &header,
            "▸ shelly pair".chars().count(),
            cols,
        ));
    }
    lines.push(String::new());
    match qr_image {
        Some(image) => {
            lines.extend(image.lines().map(str::to_string));
            lines.push(String::new());
            let scan = "Scan with the Shelly app — or enter this code:";
            lines.push(centered_line(
                &style_dim(scan, true),
                scan.chars().count(),
                cols,
            ));
        }
        None => {
            let enter = "Enter this code in the Shelly app:";
            lines.push(centered_line(
                &style_dim(enter, true),
                enter.chars().count(),
                cols,
            ));
        }
    }
    lines.push(String::new());
    let (keys, keys_cols) = keycap_row(code, depth);
    lines.push(centered_line(&keys, keys_cols, cols));
    lines.push(String::new());
    if qr_image.is_none() {
        let (need_cols, need_rows) = pairing_qr_terminal_dimensions(qr_modules);
        let note = format!(
            "Pane is too small for the QR (needs {need_cols}×{})",
            need_rows + PAIRING_TEXT_ROWS
        );
        lines.push(centered_line(
            &style_dim(&note, true),
            note.chars().count(),
            cols,
        ));
        lines.push(String::new());
    }
    let (status, status_cols) = render_pairing_status(0, remaining_secs, depth);
    lines.push(centered_line(&status, status_cols, cols));
    lines.push(String::new());
    let hint = "ctrl+c cancel";
    lines.push(centered_line(
        &style_dim(hint, true),
        hint.chars().count(),
        cols,
    ));
    lines
}

/// Clears the alternate screen and draws the ceremony for the current pane
/// size; returns the 1-based row of the live status line. Safe to call again
/// after a resize.
fn draw_pairing_ceremony(
    code: &str,
    qr: &QrCode,
    terminal: ClientSize,
    depth: ColorDepth,
    remaining_secs: u64,
) -> Result<usize> {
    let qr_image = render_pairing_qr_for_terminal(qr, terminal, depth);
    let lines = pairing_screen_lines(
        code,
        qr_image.as_deref(),
        qr.width(),
        terminal,
        depth,
        remaining_secs,
    );
    let status_row = lines.len() - 2;
    print!("\x1b[H\x1b[2J{}", lines.join("\n"));
    std::io::stdout().flush().context("draw pairing screen")?;
    Ok(status_row)
}

/// Plain fallback (NO_COLOR, dumb terminals, pipes): stable left-aligned text.
fn draw_pairing_screen_plain(
    code: &str,
    qr_image: Option<&str>,
    qr_modules: usize,
    depth: ColorDepth,
    use_ansi: bool,
) {
    println!("{}", style_bold("Shelly pairing", use_ansi));
    println!();
    match qr_image {
        Some(image) => {
            println!("{image}");
            println!();
        }
        None => {
            let (need_cols, need_rows) = pairing_qr_terminal_dimensions(qr_modules);
            println!(
                "{}",
                style_dim(
                    &format!(
                        "QR hidden for this pane. It needs {need_cols}x{}; widen the terminal and run `shelly pair` again.",
                        need_rows + PAIRING_TEXT_ROWS
                    ),
                    use_ansi
                )
            );
            println!();
        }
    }
    println!(
        "{}",
        style_dim(
            "Scan the QR with the Shelly app — or enter this code:",
            use_ansi
        )
    );
    println!("    {}", style_brand(&group_code(code), depth));
}

fn print_pairing_countdown(expires_at: u64, use_ansi: bool, force: bool) -> Result<bool> {
    let remaining_secs = pairing_remaining_seconds(expires_at);
    let active = remaining_secs > 0;
    let text = if active {
        format!("Expires in {}.", format_pairing_countdown(remaining_secs))
    } else {
        "Expired. Run `shelly pair` again.".to_string()
    };
    if force || !active {
        println!("{}", style_dim(&text, use_ansi));
    }
    Ok(active)
}

fn pairing_remaining_seconds(expires_at: u64) -> u64 {
    let remaining_ms = expires_at.saturating_sub(clock::now_ms());
    remaining_ms.div_ceil(1000)
}

fn format_pairing_countdown(seconds: u64) -> String {
    format!("{}:{:02}", seconds / 60, seconds % 60)
}

fn render_pairing_qr_for_terminal(
    qr: &QrCode,
    terminal: ClientSize,
    depth: ColorDepth,
) -> Option<String> {
    if pairing_qr_fits_terminal(qr.width(), terminal) {
        let image = qr.render::<unicode::Dense1x2>().quiet_zone(true).build();
        Some(format_pairing_qr_image(&image, terminal, depth))
    } else {
        None
    }
}

/// QR panel per depth: explicit black-on-white above ANSI-16 so terminal
/// themes cannot tint the panel away from scannable contrast.
fn qr_panel_style_code(depth: ColorDepth) -> Option<String> {
    match depth {
        ColorDepth::Plain => None,
        ColorDepth::Ansi16 => Some(ANSI_QR_LIGHT_PANEL.to_string()),
        ColorDepth::Ansi256 => Some("\x1b[38;5;16;48;5;231m".to_string()),
        ColorDepth::TrueColor => Some("\x1b[38;2;11;11;11;48;2;255;255;255m".to_string()),
    }
}

fn format_pairing_qr_image(image: &str, terminal: ClientSize, depth: ColorDepth) -> String {
    let qr_cols = image
        .lines()
        .map(|line| line.chars().count())
        .max()
        .unwrap_or(0);
    let padding = centered_padding(qr_cols, terminal.cols);
    let prefix = " ".repeat(padding);
    let panel = qr_panel_style_code(depth);

    image
        .lines()
        .map(|line| match &panel {
            Some(code) => format!("{prefix}{code}{line}{ANSI_RESET}"),
            None => format!("{prefix}{line}"),
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn centered_padding(content_cols: usize, terminal_cols: u16) -> usize {
    usize::from(terminal_cols).saturating_sub(content_cols) / 2
}

fn pairing_qr_fits_terminal(qr_modules: usize, terminal: ClientSize) -> bool {
    let (cols, rows) = pairing_qr_terminal_dimensions(qr_modules);
    usize::from(terminal.cols) >= cols && usize::from(terminal.rows) >= rows + PAIRING_TEXT_ROWS
}

fn pairing_qr_terminal_dimensions(qr_modules: usize) -> (usize, usize) {
    let cols = qr_modules + (QR_QUIET_ZONE_MODULES * 2);
    (cols, cols.div_ceil(2))
}

async fn run_hook(command: HookCommand) -> Result<()> {
    match command {
        HookCommand::ClaudeStop { session, last_line } => {
            let session_id = hook_session_id(session)?;
            let (mut conn, _) = ipc::connect_local().await?;
            emit_agent_state_event(
                &mut conn,
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
            let (mut conn, _) = ipc::connect_local().await?;
            for state in states {
                emit_agent_state_event(&mut conn, session_id, AgentSource::Codex, state, None)
                    .await?;
            }
            Ok(())
        }
    }
}

async fn emit_agent_state_event(
    conn: &mut interprocess::local_socket::tokio::Stream,
    session_id: SessionId,
    source: AgentSource,
    state: AgentState,
    last_line: Option<String>,
) -> Result<()> {
    ipc::write_msg(
        &mut *conn,
        &ClientToServerMsg::AgentStateEvent {
            session_id,
            source,
            state,
            last_line,
        },
    )
    .await?;
    match ipc::read_msg::<_, ServerToClientMsg>(&mut *conn).await? {
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
        .or_else(|| std::env::var("SHELLY_SESSION_ID").ok())
        .context("hook requires --session or SHELLY_SESSION_ID")?;
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
    let summary = create_session_summary(PathBuf::from("."), None, Vec::new()).await?;
    eprintln!("shelly session started {}\t{}", summary.id, summary.name);
    attach_session(summary.id.to_string()).await
}

async fn open_named_session(args: Vec<OsString>) -> Result<()> {
    let bin_name = invoked_cli_bin_name();
    let name = parse_named_shortcut_args(args, &bin_name)?;
    let sessions = fetch_sessions().await?;
    if let Some(session) = sessions.iter().find(|session| session.name == name) {
        return attach_session(session.id.to_string()).await;
    }

    let summary = create_session_summary(PathBuf::from("."), Some(name), Vec::new()).await?;
    eprintln!("shelly session started {}\t{}", summary.id, summary.name);
    attach_session(summary.id.to_string()).await
}

fn parse_named_shortcut_args(args: Vec<OsString>, bin_name: &str) -> Result<String> {
    let mut args = args.into_iter();
    let Some(name) = args.next() else {
        bail!("named session shortcut requires a session name");
    };
    if args.next().is_some() {
        bail!(
            "named session shortcut accepts one session name; use `{bin_name} new --name <name> -- <cmd...>` to choose a command"
        );
    }
    let name = name
        .into_string()
        .map_err(|_| anyhow::anyhow!("named session shortcut requires a UTF-8 session name"))?;
    normalize_session_name(name)
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
        command = default_session_command();
    }
    let cwd = dir
        .canonicalize()
        .with_context(|| format!("canonicalize {}", dir.display()))?;
    let size = terminal_size();

    let (mut conn, _) = ipc::connect_local().await?;
    let name = requested_session_name(name)?;

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

fn default_session_command() -> Vec<String> {
    vec![default_shell()]
}

fn default_shell() -> String {
    default_shell_from_env(std::env::var_os("SHELL"))
}

fn default_shell_from_env(shell: Option<OsString>) -> String {
    shell
        .and_then(|value| value.into_string().ok())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "/bin/sh".to_string())
}

async fn attach_session(session_ref: String) -> Result<()> {
    let (mut conn, _) = ipc::connect_local().await?;
    let session = resolve_session(&mut conn, &session_ref).await?;
    let session_id = session.id;
    let physical_size = terminal_size();
    let status_bar =
        terminal_cursor_control_enabled() && attach_ui::status_bar_supported(physical_size);
    let initial_size = if status_bar {
        attach_ui::content_size(physical_size)
    } else {
        physical_size
    };
    let detach_prefix = settings::detach_prefix()?;
    let mut detach_state = DetachState::new(detach_prefix);
    let mut input = spawn_stdin_reader()?;
    let (resize_tx, mut resize) = mpsc::channel(8);
    let mut winch = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::window_change())?;
    let mut termination =
        terminal::TerminationSignals::new().context("register terminal signals")?;

    let outcome = {
        let _raw = RawMode::enter()?;
        let _screen = status_bar
            .then(attach_ui::AttachScreenGuard::enter)
            .transpose()?;
        let resize_task = tokio::spawn(async move {
            while winch.recv().await.is_some() {
                if resize_tx.send(terminal_size()).await.is_err() {
                    break;
                }
            }
        });
        let mut renderer = CliTerminalRenderer::new(&session.name, physical_size, status_bar);
        let mut stdout = tokio::io::stdout();
        let attach = run_attach_session(
            conn,
            session_id,
            initial_size,
            AttachIo::new(
                &mut input,
                &mut resize,
                &mut stdout,
                &mut renderer,
                &mut detach_state,
            ),
        );
        tokio::pin!(attach);
        let result = tokio::select! {
            result = &mut attach => result,
            signal = termination.recv() => {
                terminal::restore_and_reraise(signal);
            }
        };
        resize_task.abort();
        result
    }?;

    match outcome {
        AttachOutcome::Detached => Ok(()),
        AttachOutcome::SessionExited(exit_code) => {
            eprintln!("[shelly: session exited {exit_code}]");
            if exit_code == 0 {
                Ok(())
            } else {
                std::process::exit(exit_code);
            }
        }
        AttachOutcome::DaemonError(message) => bail!("terminal session error: {message}"),
        AttachOutcome::ConnectionLost(message) => {
            bail!("terminal connection closed: {message}")
        }
    }
}

struct CliTerminalRenderer {
    renderer: Option<attach_ui::AttachRenderer>,
}

impl CliTerminalRenderer {
    fn new(session_name: &str, physical_size: ClientSize, status_bar: bool) -> Self {
        Self {
            renderer: status_bar
                .then(|| attach_ui::AttachRenderer::new(session_name, physical_size)),
        }
    }
}

impl TerminalRenderer for CliTerminalRenderer {
    fn initial_frame(&mut self, bytes: &[u8]) -> Vec<u8> {
        self.renderer
            .as_mut()
            .map_or_else(|| bytes.to_vec(), |renderer| renderer.initial_frame(bytes))
    }

    fn output_frame(&mut self, bytes: &[u8]) -> Vec<u8> {
        self.renderer
            .as_mut()
            .map_or_else(|| bytes.to_vec(), |renderer| renderer.output_frame(bytes))
    }

    fn resize_frame(&mut self, physical_size: ClientSize) -> (ClientSize, Vec<u8>) {
        match self.renderer.as_mut() {
            Some(renderer) => {
                let frame = renderer.resize(physical_size);
                (renderer.content_size(), frame)
            }
            None => (physical_size, Vec::new()),
        }
    }
}

fn spawn_stdin_reader() -> Result<mpsc::Receiver<InputEvent>> {
    let (sender, receiver) = mpsc::channel(16);
    std::thread::Builder::new()
        .name("shelly-stdin".to_string())
        .spawn(move || {
            let stdin = std::io::stdin();
            let mut stdin = stdin.lock();
            let mut buffer = [0_u8; 1024];
            loop {
                match stdin.read(&mut buffer) {
                    Ok(0) => {
                        let _ = sender.blocking_send(InputEvent::Eof);
                        break;
                    }
                    Ok(read) => {
                        if sender
                            .blocking_send(InputEvent::Bytes(buffer[..read].to_vec()))
                            .is_err()
                        {
                            break;
                        }
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
                    Err(error) => {
                        let _ = sender.blocking_send(InputEvent::Error(error.to_string()));
                        break;
                    }
                }
            }
        })
        .context("spawn terminal input reader")?;
    Ok(receiver)
}

async fn kill_session(session_ref: String) -> Result<()> {
    let (mut conn, _) = ipc::connect_local().await?;
    let session = resolve_session(&mut conn, &session_ref).await?;
    kill_session_by_id(&mut conn, session.id).await?;
    println!("removed {}\t{}", session.id, session.name);
    Ok(())
}

async fn kill_all_sessions() -> Result<()> {
    let sessions = fetch_sessions().await?;
    if sessions.is_empty() {
        println!("No sessions.");
        return Ok(());
    }

    let (mut conn, _) = ipc::connect_local().await?;
    for session in &sessions {
        kill_session_by_id(&mut conn, session.id).await?;
    }

    for session in &sessions {
        println!("removed {}\t{}", session.id, session.name);
    }
    println!(
        "removed {} session{}",
        sessions.len(),
        if sessions.len() == 1 { "" } else { "s" }
    );
    Ok(())
}

async fn kill_session_by_id(
    conn: &mut interprocess::local_socket::tokio::Stream,
    id: SessionId,
) -> Result<()> {
    ipc::write_msg(conn, &ClientToServerMsg::KillSession { session_id: id }).await?;
    let response: ServerToClientMsg = ipc::read_msg(conn).await?;
    match response {
        ServerToClientMsg::SessionKilled { session_id } if session_id == id => Ok(()),
        ServerToClientMsg::SessionKilled { session_id } => {
            bail!("KillSession acknowledgement id mismatch: requested {id}, got {session_id}")
        }
        ServerToClientMsg::Error { message, .. } => bail!("{message}"),
        other => bail!("unexpected daemon response to KillSession: {other:?}"),
    }
}

async fn run_doctor(no_start: bool) -> Result<()> {
    let mut ok = true;

    println!("Shelly doctor");
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
            "requires colocated shelly and shellyd paths",
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
        Ok(status) => match settings::scrollback_encryption_env_override() {
            Ok(Some(enabled)) => println!(
                "scrollback encryption: {} (env override; config: {})",
                if enabled { "on" } else { "off" },
                if status.enabled { "on" } else { "off" },
            ),
            Ok(None) => println!(
                "scrollback encryption: {}",
                if status.enabled { "on" } else { "off" }
            ),
            Err(error) => println!("scrollback encryption: unavailable ({error})"),
        },
        Err(error) => println!("scrollback encryption: unavailable ({error})"),
    }

    if ok {
        println!("summary: ok");
        Ok(())
    } else {
        bail!("shelly doctor found issues")
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
    let cli_signature = doctor_macos_binary_trust(cli_path, "shelly")?;
    let daemon_signature = doctor_macos_binary_trust(daemon_path, "shellyd")?;
    if cli_signature == MacosSignatureKind::DeveloperId {
        doctor_macos_notarization_status(cli_path, "shelly")?;
        doctor_macos_notarization_status(daemon_path, "shellyd")?;
    }
    let mode = macos_trust_mode_from_signature_kinds(cli_signature, daemon_signature)?;
    Ok(format!(
        "{mode} (shelly and shellyd signed, executable, no quarantine)"
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
            "shelly and shellyd must use the same macOS trust mode, got {cli_signature:?} and {daemon_signature:?}"
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

fn requested_session_name(name: Option<String>) -> Result<String> {
    match name {
        Some(name) => normalize_session_name(name),
        None => Ok(String::new()),
    }
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
        return home.join("Library").join("Logs").join("app.shelly");
    }

    if let Some(state_home) = std::env::var_os("XDG_STATE_HOME") {
        return PathBuf::from(state_home).join("shelly");
    }

    home.join(".local").join("state").join("shelly")
}

struct RawMode;

impl RawMode {
    fn enter() -> Result<Self> {
        enable_raw_mode().context("enable raw mode")?;
        terminal::mark_raw_mode_active();
        Ok(Self)
    }
}

impl Drop for RawMode {
    fn drop(&mut self) {
        terminal::restore_raw_mode();
    }
}

#[cfg(test)]
mod tests {
    use super::{
        ANSI_AMBER, ANSI_DIM, ANSI_QR_LIGHT_PANEL, ANSI_RED, ANSI_RESET, Cli, ClientSize,
        ColorDepth, Command, HookCommand, MacosSignatureKind, PAIRING_TEXT_ROWS, PAIRING_WORDMARK,
        PAIRING_WORDMARK_COLS, centered_padding, cli_command_with_bin_name, codex_state_from_json,
        codex_states_from_payload, color_depth_from_env, completion_bin_name_with_override,
        default_shell_from_env, doctor_socket_file_status, doctor_socket_parent_status,
        format_pairing_countdown, format_pairing_qr_image, keycap_row,
        macos_trust_mode_from_signature_kinds, normalize_session_name, pairing_qr_fits_terminal,
        pairing_qr_terminal_dimensions, pairing_screen_lines, parse_macos_signature_kind,
        parse_named_shortcut_args, render_pairing_status, requested_session_name,
        sanitize_device_name, short_node_id, should_check_update_notice,
    };
    use clap::Parser;
    use clap_complete::Shell;
    use shelly_protocol::AgentState;
    use std::ffi::OsString;
    use std::fs;
    use std::os::unix::fs::{PermissionsExt, symlink};
    use std::os::unix::net::UnixListener;
    use std::path::{Path, PathBuf};

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
        assert!(should_check_update_notice(Some(&Command::KillAll)));
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
        let cli = Cli::try_parse_from(["shelly"]).expect("no-arg CLI parses");
        assert!(cli.command.is_none());
    }

    #[test]
    fn default_session_command_uses_user_shell() {
        assert_eq!(
            default_shell_from_env(Some(OsString::from("/bin/zsh"))),
            "/bin/zsh"
        );
        assert_eq!(
            default_shell_from_env(Some(OsString::from("  "))),
            "/bin/sh"
        );
        assert_eq!(default_shell_from_env(None), "/bin/sh");
    }

    #[test]
    fn completion_bin_name_follows_invoked_binary() {
        assert_eq!(
            completion_bin_name_with_override(None, Some(OsString::from("shelly"))),
            "shelly"
        );
        assert_eq!(completion_bin_name_with_override(None, None), "shelly");
    }

    #[test]
    fn completion_bin_name_prefers_npm_dispatcher_override() {
        assert_eq!(
            completion_bin_name_with_override(
                Some(OsString::from("shelly")),
                Some(OsString::from("/package/bin/shelly"))
            ),
            "shelly"
        );
    }

    #[test]
    fn help_usage_uses_shelly_binary() {
        let mut shelly_command = cli_command_with_bin_name("shelly".to_string());
        let shelly_help = shelly_command.render_help().to_string();
        assert!(shelly_help.contains("Usage: shelly [COMMAND]"));
    }

    #[test]
    fn version_flag_uses_shelly_binary() {
        let shelly_command = cli_command_with_bin_name("shelly".to_string());
        assert_eq!(
            shelly_command.render_version().to_string(),
            format!("shelly {}\n", env!("CARGO_PKG_VERSION"))
        );
    }

    #[test]
    fn unknown_subcommand_parses_to_named_shortcut() {
        let cli = Cli::try_parse_from(["shelly", "refactoringjob"]).expect("named shortcut parses");
        let Some(Command::Named(args)) = cli.command else {
            panic!("expected named shortcut command");
        };
        assert_eq!(args, vec![OsString::from("refactoringjob")]);
    }

    #[test]
    fn named_shortcut_command_error_follows_invoked_alias() {
        let error = parse_named_shortcut_args(
            vec![OsString::from("refactoringjob"), OsString::from("bash")],
            "shelly",
        )
        .expect_err("extra named-shortcut argument should fail");
        let message = error.to_string();
        assert!(message.contains("use `shelly new --name <name> -- <cmd...>`"));
    }

    #[test]
    fn doctor_parses_with_no_start_flag() {
        let cli = Cli::try_parse_from(["shelly", "doctor", "--no-start"]).expect("doctor parses");
        let Some(Command::Doctor { no_start }) = cli.command else {
            panic!("expected doctor command");
        };
        assert!(no_start);
    }

    #[test]
    fn kill_all_parses_as_top_level_command() {
        let cli = Cli::try_parse_from(["shelly", "kill-all"]).expect("kill-all parses");
        assert!(matches!(cli.command, Some(Command::KillAll)));
    }

    #[test]
    fn doctor_parses_macos_trust_signature_modes() {
        assert_eq!(
            parse_macos_signature_kind(
                "Executable=/tmp/shelly\nIdentifier=shelly\nSignature=adhoc"
            )
            .unwrap(),
            MacosSignatureKind::AdHoc
        );
        assert_eq!(
            parse_macos_signature_kind(
                "Authority=Developer ID Application: Shelly Project (ABCDE12345)\nTeamIdentifier=ABCDE12345"
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
        let Some(_listener) = bind_unix_socket_for_test(&socket) else {
            return;
        };
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
        let Some(_listener) = bind_unix_socket_for_test(&socket) else {
            return;
        };
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
        let cli = Cli::try_parse_from(["shelly", "new", "--name", "refactoringjob", "bash"])
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
            parse_named_shortcut_args(vec![OsString::from("  refactoringjob  ")], "shelly")
                .expect("valid shortcut"),
            "refactoringjob"
        );
        assert!(parse_named_shortcut_args(Vec::new(), "shelly").is_err());
        assert!(
            parse_named_shortcut_args(
                vec![OsString::from("refactoringjob"), OsString::from("bash")],
                "shelly"
            )
            .is_err()
        );
        assert!(normalize_session_name("line\nbreak".to_string()).is_err());
    }

    #[test]
    fn missing_new_name_is_left_for_daemon_generation() {
        assert_eq!(requested_session_name(None).unwrap(), "");
    }

    #[test]
    fn explicit_new_name_is_normalized_before_create() {
        assert_eq!(
            requested_session_name(Some("  refactoringjob  ".to_string())).unwrap(),
            "refactoringjob"
        );
        assert!(requested_session_name(Some("line\nbreak".to_string())).is_err());
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

    #[test]
    fn pairing_qr_fits_only_when_terminal_can_show_whole_code() {
        let qr_modules = 85;
        let (cols, rows) = pairing_qr_terminal_dimensions(qr_modules);
        assert_eq!(cols, 93);
        assert_eq!(rows, 47);

        assert!(pairing_qr_fits_terminal(
            qr_modules,
            ClientSize {
                cols: cols as u16,
                rows: (rows + PAIRING_TEXT_ROWS) as u16,
            }
        ));
        assert!(!pairing_qr_fits_terminal(
            qr_modules,
            ClientSize {
                cols: (cols - 1) as u16,
                rows: (rows + PAIRING_TEXT_ROWS) as u16,
            }
        ));
        assert!(!pairing_qr_fits_terminal(
            qr_modules,
            ClientSize {
                cols: cols as u16,
                rows: (rows + PAIRING_TEXT_ROWS - 1) as u16,
            }
        ));
    }

    #[test]
    fn pairing_qr_image_is_centered_when_terminal_is_wider() {
        assert_eq!(centered_padding(4, 10), 3);
        let rendered = format_pairing_qr_image(
            "abcd\nefgh",
            ClientSize { cols: 10, rows: 24 },
            ColorDepth::Plain,
        );

        assert_eq!(rendered, "   abcd\n   efgh");
    }

    #[test]
    fn pairing_qr_image_uses_light_panel_when_ansi_is_enabled() {
        let rendered = format_pairing_qr_image(
            "  \n██",
            ClientSize { cols: 2, rows: 24 },
            ColorDepth::Ansi16,
        );

        assert_eq!(
            rendered,
            format!("{ANSI_QR_LIGHT_PANEL}  {ANSI_RESET}\n{ANSI_QR_LIGHT_PANEL}██{ANSI_RESET}")
        );
    }

    #[test]
    fn pairing_countdown_formats_minutes_and_seconds() {
        assert_eq!(format_pairing_countdown(300), "5:00");
        assert_eq!(format_pairing_countdown(65), "1:05");
        assert_eq!(format_pairing_countdown(4), "0:04");
    }

    #[test]
    fn color_depth_prefers_colorterm_then_term() {
        assert_eq!(
            color_depth_from_env(Some("xterm-256color"), Some("truecolor")),
            ColorDepth::TrueColor
        );
        assert_eq!(
            color_depth_from_env(None, Some("24bit")),
            ColorDepth::TrueColor
        );
        assert_eq!(
            color_depth_from_env(Some("xterm-256color"), None),
            ColorDepth::Ansi256
        );
        assert_eq!(
            color_depth_from_env(Some("xterm"), None),
            ColorDepth::Ansi16
        );
        assert_eq!(color_depth_from_env(None, None), ColorDepth::Ansi16);
    }

    #[test]
    fn keycap_row_falls_back_to_grouped_text_when_plain() {
        assert_eq!(
            keycap_row("KW7F4AB", ColorDepth::Plain),
            ("KW7 F4AB".to_string(), 8)
        );
    }

    #[test]
    fn keycap_row_renders_chips_with_wider_group_gap() {
        let (styled, cols) = keycap_row("KW7F4AB", ColorDepth::Ansi16);
        assert_eq!(cols, 29);
        assert_eq!(styled.matches("\x1b[30;43m").count(), 7);
        assert_eq!(styled.matches(ANSI_RESET).count(), 7);
        assert!(styled.contains("   "));
    }

    #[test]
    fn keycap_row_uses_explicit_ink_above_ansi16() {
        let (truecolor, _) = keycap_row("KW7F4AB", ColorDepth::TrueColor);
        assert!(truecolor.contains("\x1b[38;2;21;10;5;48;2;232;93;41m"));
        let (ansi256, _) = keycap_row("KW7F4AB", ColorDepth::Ansi256);
        assert!(ansi256.contains("\x1b[38;5;16;48;5;166m"));
    }

    #[test]
    fn pairing_screen_keeps_status_third_from_end_in_both_layouts() {
        let narrow = pairing_screen_lines(
            "KW7F4AB",
            None,
            49,
            ClientSize { cols: 46, rows: 14 },
            ColorDepth::Ansi16,
            900,
        );
        assert!(narrow[narrow.len() - 3].contains("waiting for device"));
        assert!(narrow[narrow.len() - 1].contains("ctrl+c cancel"));
        assert!(narrow.iter().any(|line| line.contains("Pane is too small")));

        let full = pairing_screen_lines(
            "KW7F4AB",
            Some("ab\ncd"),
            49,
            ClientSize { cols: 80, rows: 60 },
            ColorDepth::Ansi16,
            900,
        );
        assert!(full[full.len() - 3].contains("waiting for device"));
        assert!(
            full.iter()
                .any(|line| line.contains("Scan with the Shelly app"))
        );
        assert!(full.iter().any(|line| line.contains("/____/")));
    }

    #[test]
    fn pairing_wordmark_is_ascii_and_sized() {
        assert_eq!(PAIRING_WORDMARK.len(), 6);
        assert!(PAIRING_WORDMARK.iter().all(|line| line.is_ascii()));
        assert_eq!(
            PAIRING_WORDMARK
                .iter()
                .map(|line| line.chars().count())
                .max(),
            Some(PAIRING_WORDMARK_COLS)
        );
    }

    #[test]
    fn pairing_status_countdown_escalates_with_urgency() {
        let (calm, cols) = render_pairing_status(0, 872, ColorDepth::TrueColor);
        assert!(calm.contains("\x1b[38;2;232;93;41m"));
        assert!(calm.contains("expires in 14:32"));
        assert!(calm.contains(ANSI_DIM));
        assert!(!calm.contains(ANSI_AMBER));
        assert_eq!(
            cols,
            "⠋ waiting for device  ·  expires in 14:32".chars().count()
        );

        let (amber, _) = render_pairing_status(0, 120, ColorDepth::TrueColor);
        assert!(amber.contains(ANSI_AMBER));
        let (red, _) = render_pairing_status(0, 30, ColorDepth::TrueColor);
        assert!(red.contains(ANSI_RED));
    }

    #[test]
    fn sanitize_device_name_strips_control_and_caps_length() {
        assert_eq!(sanitize_device_name("  Pixel 9 Pro \n"), "Pixel 9 Pro");
        assert_eq!(sanitize_device_name("\x1b[31mPixel\x07"), "[31mPixel");
        assert_eq!(sanitize_device_name("\x1b\x07 \n"), "device");
        assert_eq!(sanitize_device_name(&"n".repeat(64)).chars().count(), 48);
    }

    #[test]
    fn short_node_id_truncates_on_character_boundaries() {
        assert_eq!(short_node_id("éééééééééééésuffix"), "éééééééééééé");
    }

    fn bind_unix_socket_for_test(path: &Path) -> Option<UnixListener> {
        match UnixListener::bind(path) {
            Ok(listener) => Some(listener),
            Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => None,
            Err(error) => panic!("bind unix socket test listener: {error}"),
        }
    }
}
