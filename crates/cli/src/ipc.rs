use crate::service;
use anyhow::{Context, Result, bail};
use interprocess::local_socket::traits::tokio::Stream as _;
use interprocess::local_socket::{GenericFilePath, prelude::*, tokio::Stream};
use serde::{Serialize, de::DeserializeOwned};
use shelly_protocol::{
    CONTRACT_VERSION, Capabilities, ClientKind, ClientToServerMsg, ServerToClientMsg,
    decode_bincode, encode_bincode, max_frame_len,
};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

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
            spawn_daemon()?;
            handshake(wait_for_daemon().await?).await
        }
    }
}

pub async fn connect_existing() -> Result<(Stream, Capabilities)> {
    handshake(connect_once().await?).await
}

pub async fn wait_for_existing_daemon() -> Result<()> {
    let mut last_error = None;
    for _ in 0..200 {
        match connect_existing().await {
            Ok(_) => return Ok(()),
            Err(error) => last_error = Some(error),
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    let socket_path = control_socket_path();
    let detail = last_error
        .map(|error| error.to_string())
        .unwrap_or_else(|| "no connection attempt made".to_string());
    bail!(
        "shellyd service did not become reachable at {}: {detail}",
        socket_path.display()
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

async fn wait_for_daemon() -> Result<Stream> {
    for _ in 0..40 {
        if let Ok(conn) = connect_once().await {
            return Ok(conn);
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    bail!("shellyd did not create its control socket in time");
}

fn spawn_daemon() -> Result<()> {
    let daemon_path = service::daemon_path()?;

    let mut command = std::process::Command::new(&daemon_path);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .current_dir("/")
        .process_group(0);
    command
        .spawn()
        .with_context(|| format!("spawn {}", daemon_path.display()))?;
    Ok(())
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
