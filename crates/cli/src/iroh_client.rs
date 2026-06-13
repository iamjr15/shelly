use anyhow::{Context, Result, bail};
use iroh::endpoint::{RecvStream, SendStream, presets};
use iroh::{Endpoint, EndpointAddr, RelayMode, RelayUrl, SecretKey, TransportAddr};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use shelly_protocol::{
    AgentSource, AgentState, CONTRACT_VERSION, ClientKind, ClientSize, ClientToServerMsg,
    ErrorCode, PairingTicket, ServerToClientMsg, SessionId, SessionSummary, max_frame_len,
    normalize_code,
};
use std::fs;
use std::fs::OpenOptions;
use std::io::{Read, Write};
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

const SHELLY_ALPN: &[u8] = b"shelly/1";

pub(crate) struct PairTestOptions {
    pub(crate) payload: Option<String>,
    pub(crate) code: Option<String>,
    pub(crate) relay_control_url: Option<String>,
    pub(crate) name: String,
    pub(crate) attach: Option<String>,
    pub(crate) input: Vec<String>,
    pub(crate) expect_output: Vec<String>,
    pub(crate) reject_output: Vec<String>,
    pub(crate) reconnect_expect_output: Vec<String>,
    pub(crate) reconnect_timeout_ms: u64,
    pub(crate) reconnect_delay_ms: u64,
    pub(crate) subscribe_expect: Option<String>,
    pub(crate) secret_key_path: Option<PathBuf>,
    pub(crate) connect_only: bool,
    pub(crate) expect_unauthorized: bool,
    pub(crate) expect_protocol_mismatch: bool,
    pub(crate) expect_local_cli_forbidden: bool,
    pub(crate) expect_forbidden_create: bool,
    pub(crate) expect_forbidden_kill: Option<String>,
    pub(crate) expect_forbidden_agent_event: bool,
}

pub(crate) async fn pair_test(options: PairTestOptions) -> Result<()> {
    if options.expect_unauthorized && !options.connect_only {
        bail!("--expect-unauthorized requires --connect-only");
    }
    if (!options.input.is_empty()
        || !options.expect_output.is_empty()
        || !options.reject_output.is_empty())
        && options.attach.is_none()
    {
        bail!("--input, --expect-output, and --reject-output require --attach");
    }
    if !options.reconnect_expect_output.is_empty() && options.attach.is_none() {
        bail!("--reconnect-expect-output requires --attach");
    }
    if !options.reconnect_expect_output.is_empty() && options.reconnect_timeout_ms == 0 {
        bail!("--reconnect-timeout-ms must be greater than zero");
    }
    if !options.reconnect_expect_output.is_empty()
        && (options.expect_forbidden_create
            || options.expect_forbidden_kill.is_some()
            || options.expect_forbidden_agent_event
            || options.expect_local_cli_forbidden)
    {
        bail!("--reconnect-expect-output cannot be combined with forbidden-operation probes");
    }

    if options.payload.is_some() && options.code.is_some() {
        bail!("--payload and --code are mutually exclusive");
    }

    // Resolve the pairing inputs into a PairingTicket: --payload (or stdin)
    // carries the compact ticket string directly (the QR path), while --code
    // resolves the daemon's reachability through the relay rendezvous endpoint
    // (the typed-code path), mirroring mobile-core's pair_with_code.
    let ticket = match options.code {
        Some(code) => resolve_code_ticket(&code, options.relay_control_url.as_deref()).await?,
        None => {
            let ticket_string = match options.payload {
                Some(payload) => payload,
                None => {
                    let mut buffer = String::new();
                    std::io::stdin()
                        .read_to_string(&mut buffer)
                        .context("read pairing ticket from stdin")?;
                    buffer
                }
            };
            PairingTicket::decode(ticket_string.trim()).context("decode pairing ticket")?
        }
    };

    let secret_key = load_or_create_secret_key(options.secret_key_path.as_deref())?;
    let endpoint = Endpoint::builder(presets::N0)
        .secret_key(secret_key)
        // `pair-test` is a local simulated-phone harness. It connects through
        // the daemon's direct ticket addresses so local smokes do not depend on,
        // or tear down, the public n0 relay actor.
        .relay_mode(RelayMode::Disabled)
        .bind()
        .await
        .context("bind test iroh endpoint")?;

    let (mut send, mut recv) = open_stream(&endpoint, &ticket).await?;

    if options.expect_protocol_mismatch {
        write_msg(
            &mut send,
            &ClientToServerMsg::Hello {
                client_kind: ClientKind::IosApp,
                client_version: env!("CARGO_PKG_VERSION").to_string(),
                protocol_version: CONTRACT_VERSION + 1,
            },
        )
        .await?;
        expect_protocol_mismatch(&mut recv).await?;
        let _ = send.finish();
        return Ok(());
    }

    if options.expect_local_cli_forbidden {
        write_msg(
            &mut send,
            &ClientToServerMsg::Hello {
                client_kind: ClientKind::LocalCli,
                client_version: env!("CARGO_PKG_VERSION").to_string(),
                protocol_version: CONTRACT_VERSION,
            },
        )
        .await?;
        expect_forbidden(&mut recv, "LocalCli Hello").await?;
        let _ = send.finish();
        return Ok(());
    }

    write_msg(
        &mut send,
        &ClientToServerMsg::Hello {
            client_kind: ClientKind::IosApp,
            client_version: env!("CARGO_PKG_VERSION").to_string(),
            protocol_version: CONTRACT_VERSION,
        },
    )
    .await?;
    expect_welcome(&mut recv).await?;

    if !options.connect_only {
        write_msg(
            &mut send,
            &ClientToServerMsg::PairWithCode {
                code: normalize_code(&ticket.code),
                device_name: options.name,
                device_node_id: endpoint.id().to_string(),
            },
        )
        .await?;
        match read_msg::<ServerToClientMsg>(&mut recv).await? {
            ServerToClientMsg::PairingComplete { daemon_node_id } => {
                println!("paired with daemon {daemon_node_id}");
            }
            ServerToClientMsg::Error { message, .. } => bail!("{message}"),
            other => bail!("unexpected daemon response during pairing: {other:?}"),
        }
    }

    let Some(sessions) = list_sessions(&mut send, &mut recv, options.expect_unauthorized).await?
    else {
        let _ = send.finish();
        return Ok(());
    };

    if let Some(expected) = options.subscribe_expect.as_deref() {
        subscribe_until_session(&mut send, &mut recv, expected).await?;
    }

    if let Some(target) = options.attach.as_deref() {
        let session = resolve_session(&sessions, target)?;
        write_msg(
            &mut send,
            &ClientToServerMsg::AttachSession {
                session_id: session.id,
                size: ClientSize { cols: 80, rows: 24 },
                last_seen_seq: None,
            },
        )
        .await?;
        let (attached_session_id, attached_seq, initial_bytes) =
            match read_msg::<ServerToClientMsg>(&mut recv).await? {
                ServerToClientMsg::Attached {
                    session_id,
                    initial_bytes,
                    seq,
                } => {
                    println!(
                        "attached {session_id}\tseq={seq}\tinitial_bytes={}",
                        initial_bytes.len()
                    );
                    (session_id, seq, initial_bytes)
                }
                ServerToClientMsg::Error { message, .. } => bail!("{message}"),
                other => bail!("unexpected daemon response to AttachSession: {other:?}"),
            };
        let mut last_seen_seq = attached_seq;

        for input in &options.input {
            write_msg(
                &mut send,
                &ClientToServerMsg::Input {
                    session_id: attached_session_id,
                    bytes: input.as_bytes().to_vec(),
                },
            )
            .await?;
        }

        if !options.expect_output.is_empty() || !options.reject_output.is_empty() {
            let output_result = wait_for_output_contract(
                &mut recv,
                attached_session_id,
                &options.expect_output,
                &options.reject_output,
                attached_seq,
                initial_bytes,
            )
            .await?;
            last_seen_seq = output_result.last_seen_seq;
        }
        write_msg(&mut send, &ClientToServerMsg::DetachSession).await?;
        if !options.reconnect_expect_output.is_empty() {
            let _ = send.finish();
            if options.reconnect_delay_ms > 0 {
                tokio::time::sleep(Duration::from_millis(options.reconnect_delay_ms)).await;
            }
            reconnect_and_expect_replay(
                &endpoint,
                &ticket,
                attached_session_id,
                last_seen_seq,
                &options.reconnect_expect_output,
                Duration::from_millis(options.reconnect_timeout_ms),
            )
            .await?;
            return Ok(());
        }
    }

    if options.expect_forbidden_create {
        write_msg(
            &mut send,
            &ClientToServerMsg::CreateSession {
                name: "mobile-forbidden".to_string(),
                command: vec!["bash".to_string()],
                cwd: std::env::current_dir().context("resolve cwd for forbidden create smoke")?,
                env: std::collections::HashMap::new(),
                size: ClientSize { cols: 80, rows: 24 },
            },
        )
        .await?;
        expect_forbidden(&mut recv, "CreateSession").await?;
    }

    if let Some(target) = options.expect_forbidden_kill.as_deref() {
        let session = resolve_session(&sessions, target)?;
        write_msg(
            &mut send,
            &ClientToServerMsg::KillSession {
                session_id: session.id,
            },
        )
        .await?;
        expect_forbidden(&mut recv, "KillSession").await?;
    }

    if options.expect_forbidden_agent_event {
        let session = sessions
            .first()
            .context("no sessions available for forbidden AgentStateEvent smoke")?;
        write_msg(
            &mut send,
            &ClientToServerMsg::AgentStateEvent {
                session_id: session.id,
                source: AgentSource::Claude,
                state: AgentState::AwaitingInput,
                last_line: Some("mobile hook spoof".to_string()),
            },
        )
        .await?;
        expect_forbidden(&mut recv, "AgentStateEvent").await?;
    }

    let _ = send.finish();
    Ok(())
}

async fn open_stream(
    endpoint: &Endpoint,
    ticket: &PairingTicket,
) -> Result<(SendStream, RecvStream)> {
    let addr = endpoint_addr(ticket)?;
    let conn = endpoint
        .connect(addr, SHELLY_ALPN)
        .await
        .context("connect to daemon iroh endpoint")?;
    conn.open_bi().await.context("open iroh stream")
}

async fn open_authenticated_stream(
    endpoint: &Endpoint,
    ticket: &PairingTicket,
) -> Result<(SendStream, RecvStream)> {
    let (mut send, mut recv) = open_stream(endpoint, ticket).await?;
    write_msg(
        &mut send,
        &ClientToServerMsg::Hello {
            client_kind: ClientKind::IosApp,
            client_version: env!("CARGO_PKG_VERSION").to_string(),
            protocol_version: CONTRACT_VERSION,
        },
    )
    .await?;
    expect_welcome(&mut recv).await?;
    Ok((send, recv))
}

async fn reconnect_and_expect_replay(
    endpoint: &Endpoint,
    ticket: &PairingTicket,
    session_id: SessionId,
    last_seen_seq: u64,
    expected: &[String],
    timeout: Duration,
) -> Result<()> {
    let start = Instant::now();
    let (mut send, mut recv) =
        tokio::time::timeout(timeout, open_authenticated_stream(endpoint, ticket))
            .await
            .context("timed out reconnecting to daemon iroh endpoint")??;
    write_msg(
        &mut send,
        &ClientToServerMsg::AttachSession {
            session_id,
            size: ClientSize { cols: 80, rows: 24 },
            last_seen_seq: Some(last_seen_seq),
        },
    )
    .await?;

    let remaining = timeout
        .checked_sub(start.elapsed())
        .context("timed out reconnecting before sending replay attach")?;
    let attached = tokio::time::timeout(remaining, async {
        read_msg::<ServerToClientMsg>(&mut recv).await
    })
    .await
    .context("timed out waiting for reconnect replay attach")??;

    match attached {
        ServerToClientMsg::Attached {
            session_id: replay_session_id,
            initial_bytes,
            seq,
        } if replay_session_id == session_id => {
            let elapsed = start.elapsed();
            if elapsed > timeout {
                bail!(
                    "reconnect replay took {}ms, expected <= {}ms",
                    elapsed.as_millis(),
                    timeout.as_millis()
                );
            }
            ensure_replay_contains_all(&initial_bytes, expected)?;
            if seq <= last_seen_seq {
                bail!(
                    "reconnect replay seq did not advance: last_seen_seq={last_seen_seq}, attached_seq={seq}"
                );
            }
            println!(
                "reconnected {session_id}\tseq={seq}\tinitial_bytes={}\telapsed_ms={}",
                initial_bytes.len(),
                elapsed.as_millis()
            );
            println!(
                "reconnect replay saw expected output: {}",
                expected.join(", ")
            );
            write_msg(&mut send, &ClientToServerMsg::DetachSession).await?;
            let _ = send.finish();
            Ok(())
        }
        ServerToClientMsg::Error { message, .. } => bail!("{message}"),
        other => bail!("unexpected daemon response to reconnect AttachSession: {other:?}"),
    }
}

async fn list_sessions(
    send: &mut SendStream,
    recv: &mut RecvStream,
    expect_unauthorized: bool,
) -> Result<Option<Vec<SessionSummary>>> {
    write_msg(send, &ClientToServerMsg::ListSessions).await?;
    match read_msg::<ServerToClientMsg>(recv).await? {
        ServerToClientMsg::SessionList { sessions } => {
            if expect_unauthorized {
                bail!("expected Unauthorized, but daemon returned a session list");
            }
            if sessions.is_empty() {
                println!("no sessions");
            } else {
                for session in &sessions {
                    println!("{}\t{}\t{:?}", session.id, session.name, session.state);
                }
            }
            Ok(Some(sessions))
        }
        ServerToClientMsg::Error {
            code: ErrorCode::Unauthorized,
            message,
        } if expect_unauthorized => {
            println!("unauthorized as expected: {message}");
            Ok(None)
        }
        ServerToClientMsg::Error { message, .. } => bail!("{message}"),
        other => bail!("unexpected daemon response to ListSessions: {other:?}"),
    }
}

fn load_or_create_secret_key(path: Option<&Path>) -> Result<SecretKey> {
    match path {
        Some(path) => load_or_create_secret_key_at(path),
        None => Ok(SecretKey::generate()),
    }
}

fn load_or_create_secret_key_at(path: &Path) -> Result<SecretKey> {
    if path.exists() {
        return read_secret_key(path);
    }

    if let Some(parent) = path.parent()
        && !parent.as_os_str().is_empty()
    {
        fs::create_dir_all(parent).with_context(|| {
            format!(
                "create parent directory for pair-test secret key {}",
                parent.display()
            )
        })?;
    }

    let secret_key = SecretKey::generate();
    let bytes = secret_key.to_bytes();
    let create_result = create_secret_key_file(path, &bytes);
    match create_result {
        Ok(()) => Ok(secret_key),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => read_secret_key(path),
        Err(error) => Err(error)
            .with_context(|| format!("create pair-test secret key file {}", path.display())),
    }
}

fn read_secret_key(path: &Path) -> Result<SecretKey> {
    let bytes =
        fs::read(path).with_context(|| format!("read pair-test secret key {}", path.display()))?;
    let key: [u8; 32] = bytes
        .try_into()
        .map_err(|_| anyhow::anyhow!("pair-test secret key must be 32 bytes"))?;
    Ok(SecretKey::from_bytes(&key))
}

fn create_secret_key_file(path: &Path, bytes: &[u8; 32]) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;

        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(path)?;
        file.write_all(bytes)?;
        Ok(())
    }

    #[cfg(not(unix))]
    {
        let mut file = OpenOptions::new().write(true).create_new(true).open(path)?;
        file.write_all(bytes)?;
        Ok(())
    }
}

fn resolve_session<'a>(sessions: &'a [SessionSummary], target: &str) -> Result<&'a SessionSummary> {
    if target == "first" {
        return sessions.first().context("no sessions available to attach");
    }
    sessions
        .iter()
        .find(|session| session.id.to_string() == target || session.name == target)
        .with_context(|| format!("session not found: {target}"))
}

fn endpoint_addr(ticket: &PairingTicket) -> Result<EndpointAddr> {
    let endpoint_id = ticket
        .node_id
        .parse()
        .context("parse daemon iroh node id")?;
    let mut addrs = Vec::new();
    if let Some(relay_url) = &ticket.relay_url {
        let relay_url: RelayUrl = relay_url.parse().context("parse daemon relay URL")?;
        addrs.push(TransportAddr::Relay(relay_url));
    }
    for addr in &ticket.addrs {
        let addr: SocketAddr = addr.parse().context("parse daemon direct address")?;
        addrs.push(TransportAddr::Ip(addr));
    }
    Ok(EndpointAddr::from_parts(endpoint_id, addrs))
}

async fn expect_welcome(recv: &mut RecvStream) -> Result<()> {
    match read_msg::<ServerToClientMsg>(recv).await? {
        ServerToClientMsg::Welcome { .. } => Ok(()),
        ServerToClientMsg::Error { message, .. } => bail!("{message}"),
        other => bail!("unexpected daemon response during handshake: {other:?}"),
    }
}

async fn expect_forbidden(recv: &mut RecvStream, operation: &str) -> Result<()> {
    match read_msg::<ServerToClientMsg>(recv).await? {
        ServerToClientMsg::Error {
            code: ErrorCode::Forbidden,
            message,
        } => {
            println!("{operation} forbidden as expected: {message}");
            Ok(())
        }
        ServerToClientMsg::Error { code, message } => {
            bail!("{operation} returned {code:?}, expected Forbidden: {message}")
        }
        other => bail!("{operation} unexpectedly succeeded: {other:?}"),
    }
}

async fn expect_protocol_mismatch(recv: &mut RecvStream) -> Result<()> {
    match read_msg::<ServerToClientMsg>(recv).await? {
        ServerToClientMsg::Error {
            code: ErrorCode::ProtocolMismatch,
            message,
        } => {
            println!("protocol mismatch as expected: {message}");
            Ok(())
        }
        ServerToClientMsg::Error { code, message } => {
            bail!("expected ProtocolMismatch, got {code:?}: {message}")
        }
        other => bail!("protocol mismatch unexpectedly succeeded: {other:?}"),
    }
}

struct OutputContractResult {
    last_seen_seq: u64,
}

async fn wait_for_output_contract(
    recv: &mut RecvStream,
    session_id: SessionId,
    expected: &[String],
    rejected: &[String],
    initial_seq: u64,
    mut observed: Vec<u8>,
) -> Result<OutputContractResult> {
    let mut last_seen_seq = initial_seq;
    ensure_rejected_absent(&observed, rejected)?;
    if expected.is_empty() {
        if !rejected.is_empty() {
            println!("rejected output absent: {}", rejected.join(", "));
        }
        return Ok(OutputContractResult { last_seen_seq });
    }

    if output_contains_all(&observed, expected) {
        println!("saw expected output: {}", expected.join(", "));
        return Ok(OutputContractResult { last_seen_seq });
    }

    loop {
        let message = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            read_msg::<ServerToClientMsg>(recv),
        )
        .await
        .with_context(|| {
            format!(
                "timed out waiting for expected output {:?}; observed {}",
                expected,
                preview_output(&observed)
            )
        })??;

        match message {
            ServerToClientMsg::Output {
                session_id: output_session_id,
                seq,
                bytes,
            } if output_session_id == session_id => {
                last_seen_seq = seq;
                observed.extend(bytes);
                ensure_rejected_absent(&observed, rejected)?;
                if output_contains_all(&observed, expected) {
                    println!("saw expected output: {}", expected.join(", "));
                    return Ok(OutputContractResult { last_seen_seq });
                }
            }
            ServerToClientMsg::Lag { skipped_bytes, .. } => {
                bail!("lag while waiting for expected output: skipped {skipped_bytes} messages")
            }
            ServerToClientMsg::SessionExited { exit_code, .. } => {
                bail!("session exited before expected output, exit_code={exit_code:?}")
            }
            ServerToClientMsg::Error { message, .. } => bail!("{message}"),
            _ => {}
        }
    }
}

async fn subscribe_until_session(
    send: &mut SendStream,
    recv: &mut RecvStream,
    expected: &str,
) -> Result<()> {
    write_msg(send, &ClientToServerMsg::SubscribeSessions).await?;
    loop {
        let message = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            read_msg::<ServerToClientMsg>(recv),
        )
        .await
        .with_context(|| format!("timed out waiting for subscribed session {expected:?}"))??;

        match message {
            ServerToClientMsg::SessionList { sessions } => {
                if sessions
                    .iter()
                    .any(|session| session_matches(session, expected))
                {
                    println!("subscription saw session: {expected}");
                    return Ok(());
                }
            }
            ServerToClientMsg::Error { message, .. } => bail!("{message}"),
            other => bail!("unexpected daemon response to SubscribeSessions: {other:?}"),
        }
    }
}

fn output_contains_all(observed: &[u8], expected: &[String]) -> bool {
    let text = String::from_utf8_lossy(observed);
    expected.iter().all(|needle| text.contains(needle))
}

fn ensure_replay_contains_all(observed: &[u8], expected: &[String]) -> Result<()> {
    if output_contains_all(observed, expected) {
        return Ok(());
    }
    bail!(
        "reconnect replay did not contain expected output {:?}; replayed {}",
        expected,
        preview_output(observed)
    )
}

fn ensure_rejected_absent(observed: &[u8], rejected: &[String]) -> Result<()> {
    let text = String::from_utf8_lossy(observed);
    for needle in rejected {
        if text.contains(needle) {
            bail!(
                "rejected output {needle:?} appeared in observed stream: {}",
                preview_output(observed)
            );
        }
    }
    Ok(())
}

fn session_matches(session: &SessionSummary, expected: &str) -> bool {
    session.name.contains(expected)
        || session.cwd.display().to_string().contains(expected)
        || session.command.iter().any(|part| part.contains(expected))
}

fn preview_output(observed: &[u8]) -> String {
    String::from_utf8_lossy(observed)
        .chars()
        .flat_map(|character| character.escape_default())
        .take(500)
        .collect()
}

async fn read_msg<T>(reader: &mut RecvStream) -> Result<T>
where
    T: DeserializeOwned,
{
    let mut len_bytes = [0_u8; 4];
    reader
        .read_exact(&mut len_bytes)
        .await
        .context("read iroh frame length")?;
    let len = u32::from_be_bytes(len_bytes) as usize;
    if len > max_frame_len() {
        bail!("frame too large: {len}");
    }
    let mut payload = vec![0; len];
    reader
        .read_exact(&mut payload)
        .await
        .context("read iroh frame payload")?;
    rmp_serde::from_slice(&payload).context("decode messagepack frame")
}

async fn write_msg<T>(writer: &mut SendStream, message: &T) -> Result<()>
where
    T: Serialize,
{
    let payload = rmp_serde::to_vec_named(message).context("encode messagepack frame")?;
    if payload.len() > max_frame_len() {
        bail!("frame too large: {}", payload.len());
    }
    writer
        .write_all(&(payload.len() as u32).to_be_bytes())
        .await
        .context("write iroh frame length")?;
    writer
        .write_all(&payload)
        .await
        .context("write iroh frame payload")?;
    Ok(())
}

/// Relay rendezvous response carrying the opaque encoded [`PairingTicket`].
#[derive(Deserialize)]
struct ResolvePairingResponse {
    /// `sh1`-prefixed ticket string published by the daemon under the code.
    ticket_blob: String,
}

/// Resolves a typed pairing code into a [`PairingTicket`] via the relay.
///
/// Mirrors mobile-core's `pair_with_code`: normalize the code, then exchange it
/// for the daemon's ticket through the relay rendezvous endpoint. Requires a
/// relay control URL from `--relay-control-url` or `SHELLY_RELAY_CONTROL_URL`.
async fn resolve_code_ticket(code: &str, relay_control_url: Option<&str>) -> Result<PairingTicket> {
    let code = normalize_code(code);
    let relay_control_url = relay_control_url
        .map(str::to_string)
        .or_else(|| std::env::var("SHELLY_RELAY_CONTROL_URL").ok())
        .context(
            "--code requires a relay control URL via --relay-control-url or SHELLY_RELAY_CONTROL_URL",
        )?;
    let relay_control_url = relay_control_url.trim_end_matches('/');
    let url = format!("{relay_control_url}/v1/pair/resolve/{code}");

    let response = reqwest::Client::new()
        .get(&url)
        .send()
        .await
        .context("resolve pairing code via relay")?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        bail!("pairing code not found or expired");
    }
    if !response.status().is_success() {
        bail!("relay resolve returned {}", response.status());
    }
    let resolved: ResolvePairingResponse = response
        .json()
        .await
        .context("decode relay resolve response")?;
    PairingTicket::decode(resolved.ticket_blob.trim()).context("decode resolved pairing ticket")
}

#[cfg(test)]
mod tests {
    use super::load_or_create_secret_key_at;
    use shelly_protocol::PairingTicket;

    #[test]
    fn decodes_pair_ticket_string_with_surrounding_whitespace() {
        let ticket = PairingTicket {
            code: "ABC12".to_string(),
            node_id: "n".to_string(),
            relay_url: None,
            addrs: vec![],
            expires_at: 1,
        };
        let encoded = ticket.encode().unwrap();
        let padded = format!("\n  {encoded}\t\n");
        assert_eq!(PairingTicket::decode(padded.trim()).unwrap(), ticket);
    }

    #[test]
    fn persists_pair_test_secret_key() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("mobile.key");

        let first = load_or_create_secret_key_at(&path).unwrap();
        let second = load_or_create_secret_key_at(&path).unwrap();

        assert_eq!(first.to_bytes(), second.to_bytes());
    }

    #[test]
    fn rejects_malformed_pair_test_secret_key() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("mobile.key");
        std::fs::write(&path, [0_u8; 31]).unwrap();

        let error = load_or_create_secret_key_at(&path).unwrap_err();

        assert!(
            error
                .to_string()
                .contains("pair-test secret key must be 32 bytes")
        );
    }

    #[cfg(unix)]
    #[test]
    fn saves_pair_test_secret_key_with_0600_mode() {
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("mobile.key");

        load_or_create_secret_key_at(&path).unwrap();

        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }
}
