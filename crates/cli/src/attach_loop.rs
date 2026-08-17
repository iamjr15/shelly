use anyhow::{Context, Result, bail};
use serde::{Serialize, de::DeserializeOwned};
use shelly_protocol::{
    ClientSize, ClientToServerMsg, ServerToClientMsg, SessionId, decode_bincode, encode_bincode,
    max_frame_len,
};
use std::future::{Future, poll_fn};
use std::pin::Pin;
use std::task::Poll;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::mpsc;

/// Input produced by the dedicated blocking-stdin thread.
#[derive(Debug)]
pub enum InputEvent {
    Bytes(Vec<u8>),
    Eof,
    Error(String),
}

/// Terminal-specific rendering used by the transport-agnostic attach loop.
pub trait TerminalRenderer {
    fn initial_frame(&mut self, bytes: &[u8]) -> Vec<u8>;
    fn output_frame(&mut self, bytes: &[u8]) -> Vec<u8>;
    fn resize_frame(&mut self, physical_size: ClientSize) -> (ClientSize, Vec<u8>);
}

/// Why an attachment stopped.
#[derive(Debug, PartialEq, Eq)]
pub enum AttachOutcome {
    Detached,
    SessionExited(i32),
    DaemonError(String),
    ConnectionLost(String),
}

/// Stateful detach-prefix recognizer. The held prefix is replayed unless the
/// following byte is `d` or `D`.
pub struct DetachState {
    prefix_byte: u8,
    prefix_held: bool,
}

/// Mutable client-side resources used for one attachment.
pub struct AttachIo<'a, O, T> {
    input: &'a mut mpsc::Receiver<InputEvent>,
    resize: &'a mut mpsc::Receiver<ClientSize>,
    output: &'a mut O,
    renderer: &'a mut T,
    detach_state: &'a mut DetachState,
}

impl<'a, O, T> AttachIo<'a, O, T> {
    pub fn new(
        input: &'a mut mpsc::Receiver<InputEvent>,
        resize: &'a mut mpsc::Receiver<ClientSize>,
        output: &'a mut O,
        renderer: &'a mut T,
        detach_state: &'a mut DetachState,
    ) -> Self {
        Self {
            input,
            resize,
            output,
            renderer,
            detach_state,
        }
    }
}

impl DetachState {
    pub fn new(prefix_byte: u8) -> Self {
        Self {
            prefix_byte,
            prefix_held: false,
        }
    }

    fn consume(&mut self, input: &[u8]) -> DetachAction {
        let mut bytes = Vec::with_capacity(input.len());
        for &byte in input {
            if self.prefix_held {
                self.prefix_held = false;
                if byte == b'd' || byte == b'D' {
                    return DetachAction {
                        bytes,
                        should_detach: true,
                    };
                }
                bytes.push(self.prefix_byte);
                bytes.push(byte);
            } else if byte == self.prefix_byte {
                self.prefix_held = true;
            } else {
                bytes.push(byte);
            }
        }
        DetachAction {
            bytes,
            should_detach: false,
        }
    }
}

struct DetachAction {
    bytes: Vec<u8>,
    should_detach: bool,
}

enum AttachedOutcome {
    End(AttachOutcome),
    Lagged,
}

/// Runs an attachment over any asynchronous byte transport. A `Lag` response
/// is recovered on the same transport using the last fully observed sequence.
pub async fn run_attach_session<S, O, T>(
    transport: S,
    session_id: SessionId,
    initial_size: ClientSize,
    io: AttachIo<'_, O, T>,
) -> Result<AttachOutcome>
where
    S: AsyncRead + AsyncWrite + Unpin,
    O: AsyncWrite + Unpin,
    T: TerminalRenderer,
{
    let AttachIo {
        input,
        resize,
        output,
        renderer,
        detach_state,
    } = io;
    let (mut reader, mut writer) = tokio::io::split(transport);
    let mut size = initial_size;
    let mut last_seen_seq = None;
    let mut initial_attach = true;

    loop {
        write_message(
            &mut writer,
            &ClientToServerMsg::AttachSession {
                session_id,
                size,
                last_seen_seq,
            },
        )
        .await?;

        let attached = match read_message::<_, ServerToClientMsg>(&mut reader).await {
            Ok(message) => message,
            Err(error) => return Ok(AttachOutcome::ConnectionLost(error.to_string())),
        };
        let (initial_bytes, seq) = match attached {
            ServerToClientMsg::Attached {
                session_id: attached_session_id,
                initial_bytes,
                seq,
            } if attached_session_id == session_id => (initial_bytes, seq),
            ServerToClientMsg::Error { message, .. } => {
                return Ok(AttachOutcome::DaemonError(message));
            }
            other => bail!("expected attach response, got {other:?}"),
        };

        let frame = if initial_attach {
            initial_attach = false;
            renderer.initial_frame(&initial_bytes)
        } else {
            renderer.output_frame(&initial_bytes)
        };
        write_frame(output, &frame).await?;
        last_seen_seq = Some(seq);

        match run_attached_loop(
            &mut reader,
            &mut writer,
            session_id,
            input,
            resize,
            output,
            renderer,
            detach_state,
            &mut size,
            &mut last_seen_seq,
        )
        .await?
        {
            AttachedOutcome::End(outcome) => return Ok(outcome),
            AttachedOutcome::Lagged => {}
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn run_attached_loop<R, W, O, T>(
    reader: &mut R,
    writer: &mut W,
    session_id: SessionId,
    input: &mut mpsc::Receiver<InputEvent>,
    resize: &mut mpsc::Receiver<ClientSize>,
    output: &mut O,
    renderer: &mut T,
    detach_state: &mut DetachState,
    size: &mut ClientSize,
    last_seen_seq: &mut Option<u64>,
) -> Result<AttachedOutcome>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
    O: AsyncWrite + Unpin,
    T: TerminalRenderer,
{
    let mut pending_output = Vec::new();
    let mut output_batch_open = false;
    let mut resize_open = true;

    'next_message: loop {
        // This future owns any partially consumed length/payload bytes until it
        // completes. Input and resize branches only repoll it; they never drop it.
        let read = read_message::<_, ServerToClientMsg>(reader);
        tokio::pin!(read);

        if output_batch_open {
            if let Some(message) = poll_once(read.as_mut()).await {
                let message = match message {
                    Ok(message) => message,
                    Err(error) => {
                        flush_output(output, &mut pending_output).await?;
                        return Ok(AttachedOutcome::End(AttachOutcome::ConnectionLost(
                            error.to_string(),
                        )));
                    }
                };
                if let Some(outcome) = handle_server_message(
                    message,
                    session_id,
                    renderer,
                    &mut pending_output,
                    &mut output_batch_open,
                    last_seen_seq,
                ) {
                    flush_output(output, &mut pending_output).await?;
                    return Ok(outcome);
                }
                continue 'next_message;
            }

            flush_output(output, &mut pending_output).await?;
            output_batch_open = false;
        }

        loop {
            tokio::select! {
                message = &mut read => {
                    let message = match message {
                        Ok(message) => message,
                        Err(error) => {
                            return Ok(AttachedOutcome::End(AttachOutcome::ConnectionLost(
                                error.to_string(),
                            )));
                        }
                    };
                    if let Some(outcome) = handle_server_message(
                        message,
                        session_id,
                        renderer,
                        &mut pending_output,
                        &mut output_batch_open,
                        last_seen_seq,
                    ) {
                        flush_output(output, &mut pending_output).await?;
                        return Ok(outcome);
                    }
                    continue 'next_message;
                }
                event = input.recv() => {
                    match event.unwrap_or(InputEvent::Eof) {
                        InputEvent::Bytes(bytes) => {
                            let action = detach_state.consume(&bytes);
                            if !action.bytes.is_empty() {
                                write_message(
                                    writer,
                                    &ClientToServerMsg::Input {
                                        session_id,
                                        bytes: action.bytes,
                                    },
                                )
                                .await?;
                            }
                            if action.should_detach {
                                write_message(writer, &ClientToServerMsg::DetachSession).await?;
                                return Ok(AttachedOutcome::End(AttachOutcome::Detached));
                            }
                        }
                        InputEvent::Eof => {
                            let _ = write_message(writer, &ClientToServerMsg::DetachSession).await;
                            return Ok(AttachedOutcome::End(AttachOutcome::Detached));
                        }
                        InputEvent::Error(message) => bail!("read terminal input: {message}"),
                    }
                }
                physical_size = resize.recv(), if resize_open => {
                    let Some(physical_size) = physical_size else {
                        resize_open = false;
                        continue;
                    };
                    let (pty_size, frame) = renderer.resize_frame(physical_size);
                    *size = pty_size;
                    write_frame(output, &frame).await?;
                    write_message(
                        writer,
                        &ClientToServerMsg::Resize {
                            session_id,
                            size: pty_size,
                        },
                    )
                    .await?;
                }
            }
        }
    }
}

fn handle_server_message<T: TerminalRenderer>(
    message: ServerToClientMsg,
    session_id: SessionId,
    renderer: &mut T,
    pending_output: &mut Vec<u8>,
    output_batch_open: &mut bool,
    last_seen_seq: &mut Option<u64>,
) -> Option<AttachedOutcome> {
    match message {
        ServerToClientMsg::Output {
            session_id: output_session_id,
            seq,
            bytes,
        } if output_session_id == session_id => {
            *last_seen_seq = Some(seq);
            pending_output.extend(renderer.output_frame(&bytes));
            *output_batch_open = true;
            None
        }
        ServerToClientMsg::Lag {
            session_id: lagged_session_id,
            ..
        } if lagged_session_id == session_id => Some(AttachedOutcome::Lagged),
        ServerToClientMsg::SessionExited {
            session_id: exited_session_id,
            exit_code,
        } if exited_session_id == session_id => Some(AttachedOutcome::End(
            AttachOutcome::SessionExited(exit_code),
        )),
        ServerToClientMsg::Error { message, .. } => {
            Some(AttachedOutcome::End(AttachOutcome::DaemonError(message)))
        }
        _ => None,
    }
}

async fn poll_once<F: Future>(mut future: Pin<&mut F>) -> Option<F::Output> {
    poll_fn(|context| match future.as_mut().poll(context) {
        Poll::Ready(output) => Poll::Ready(Some(output)),
        Poll::Pending => Poll::Ready(None),
    })
    .await
}

async fn write_frame<W: AsyncWrite + Unpin>(writer: &mut W, frame: &[u8]) -> Result<()> {
    if !frame.is_empty() {
        writer
            .write_all(frame)
            .await
            .context("write terminal output")?;
    }
    writer.flush().await.context("flush terminal output")
}

async fn flush_output<W: AsyncWrite + Unpin>(writer: &mut W, pending: &mut Vec<u8>) -> Result<()> {
    write_frame(writer, pending).await?;
    pending.clear();
    Ok(())
}

#[doc(hidden)]
pub async fn read_message<R, T>(reader: &mut R) -> Result<T>
where
    R: AsyncRead + Unpin,
    T: DeserializeOwned,
{
    let len = reader.read_u32().await.context("read frame length")? as usize;
    if len > max_frame_len() {
        bail!("frame too large: {len}");
    }
    let mut payload = Vec::with_capacity(len.min(8 * 1024));
    while payload.len() < len {
        let start = payload.len();
        let chunk_len = (len - start).min(8 * 1024);
        payload.resize(start + chunk_len, 0);
        reader
            .read_exact(&mut payload[start..])
            .await
            .context("read frame payload")?;
    }
    decode_bincode(&payload).context("decode frame")
}

#[doc(hidden)]
pub async fn write_message<W, T>(writer: &mut W, message: &T) -> Result<()>
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
