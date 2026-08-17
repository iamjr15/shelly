use serde::{Serialize, de::DeserializeOwned};
use std::fmt::Debug;
use std::io::{self, Cursor, IoSlice};
use thiserror::Error;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

const MAX_FRAME_LEN: usize = 1024 * 1024;
const READ_CHUNK_LEN: usize = 8 * 1024;

/// Serialization strategy used inside a length-prefixed frame.
pub trait Framing {
    /// Error returned when serialization fails.
    type EncodeError: std::error::Error + Send + Sync + 'static;
    /// Error returned when deserialization fails.
    type DecodeError: std::error::Error + Send + Sync + 'static;

    /// Serializes one frame payload.
    fn encode<T: Serialize + ?Sized>(message: &T) -> Result<Vec<u8>, Self::EncodeError>;

    /// Deserializes one complete frame payload.
    fn decode<T: DeserializeOwned>(payload: &[u8]) -> Result<T, Self::DecodeError>;
}

/// Bincode payloads using the v1 legacy wire configuration used by local IPC.
#[derive(Debug)]
pub struct BincodeFraming;

impl Framing for BincodeFraming {
    type EncodeError = bincode::error::EncodeError;
    type DecodeError = bincode::error::DecodeError;

    fn encode<T: Serialize + ?Sized>(message: &T) -> Result<Vec<u8>, Self::EncodeError> {
        encode_bincode(message)
    }

    fn decode<T: DeserializeOwned>(payload: &[u8]) -> Result<T, Self::DecodeError> {
        decode_bincode(payload)
    }
}

/// Named-field MessagePack payloads used by iroh and mobile streams.
#[derive(Debug)]
pub struct MessagePackFraming;

impl Framing for MessagePackFraming {
    type EncodeError = rmp_serde::encode::Error;
    type DecodeError = MessagePackDecodeError;

    fn encode<T: Serialize + ?Sized>(message: &T) -> Result<Vec<u8>, Self::EncodeError> {
        encode_messagepack(message)
    }

    fn decode<T: DeserializeOwned>(payload: &[u8]) -> Result<T, Self::DecodeError> {
        decode_messagepack(payload)
    }
}

/// Errors returned while reading a framed payload.
#[derive(Debug, Error)]
pub enum ReadFrameError<E>
where
    E: std::error::Error + 'static,
{
    /// The stream ended or failed while reading the length prefix.
    #[error("failed to read frame length")]
    ReadLength(#[source] io::Error),
    /// The declared payload length exceeded the protocol maximum.
    #[error("frame too large: {0}")]
    TooLarge(usize),
    /// The stream ended or failed while reading the payload.
    #[error("failed to read frame payload")]
    ReadPayload(#[source] io::Error),
    /// The selected framing codec rejected the payload.
    #[error("failed to decode frame")]
    Decode(#[source] E),
}

/// Errors returned while writing a framed payload.
#[derive(Debug, Error)]
pub enum WriteFrameError<E>
where
    E: std::error::Error + 'static,
{
    /// The selected framing codec could not serialize the message.
    #[error("failed to encode frame")]
    Encode(#[source] E),
    /// The serialized payload length exceeded the protocol maximum.
    #[error("frame too large: {0}")]
    TooLarge(usize),
    /// The stream failed before the complete length prefix was written.
    #[error("failed to write frame length")]
    WriteLength(#[source] io::Error),
    /// The stream failed after the complete length prefix was written.
    #[error("failed to write frame payload")]
    WritePayload(#[source] io::Error),
}

/// MessagePack decoding failures, including bytes after the decoded value.
#[derive(Debug, Error)]
pub enum MessagePackDecodeError {
    /// The payload was not valid MessagePack for the requested message type.
    #[error(transparent)]
    Decode(#[from] rmp_serde::decode::Error),
    /// The payload contained bytes after the decoded message.
    #[error("trailing bytes after messagepack payload: {0}")]
    TrailingBytes(usize),
}

#[derive(Debug, Error)]
/// Errors returned while decoding or encoding length-prefixed bincode frames.
pub enum FrameError {
    /// Payload length exceeded the protocol maximum.
    #[error("frame length {0} exceeds maximum")]
    TooLarge(usize),
    /// The buffer ended before a full length prefix or payload was available.
    #[error("incomplete frame")]
    Incomplete,
    /// Bincode failed to serialize the payload.
    #[error(transparent)]
    Encode(#[from] bincode::error::EncodeError),
    /// Bincode failed to deserialize the payload.
    #[error(transparent)]
    Decode(#[from] bincode::error::DecodeError),
}

/// Encodes a serializable value using the v1 bincode configuration.
pub fn encode_bincode<T: Serialize + ?Sized>(
    message: &T,
) -> Result<Vec<u8>, bincode::error::EncodeError> {
    bincode::serde::encode_to_vec(message, bincode::config::legacy())
}

/// Decodes a value using the v1 bincode configuration and rejects trailing bytes.
pub fn decode_bincode<T: DeserializeOwned>(
    payload: &[u8],
) -> Result<T, bincode::error::DecodeError> {
    let (value, bytes_read) =
        bincode::serde::decode_from_slice(payload, bincode::config::legacy())?;
    if bytes_read != payload.len() {
        return Err(bincode::error::DecodeError::OtherString(format!(
            "trailing bytes after bincode payload: {}",
            payload.len() - bytes_read
        )));
    }
    Ok(value)
}

/// Encodes a serializable value using named-field MessagePack.
pub fn encode_messagepack<T: Serialize + ?Sized>(
    message: &T,
) -> Result<Vec<u8>, rmp_serde::encode::Error> {
    rmp_serde::to_vec_named(message)
}

/// Decodes one named-field MessagePack value and rejects trailing bytes.
pub fn decode_messagepack<T: DeserializeOwned>(
    payload: &[u8],
) -> Result<T, MessagePackDecodeError> {
    let mut deserializer = rmp_serde::Deserializer::new(Cursor::new(payload));
    let message = serde::Deserialize::deserialize(&mut deserializer)?;
    let consumed = deserializer.position() as usize;
    if consumed != payload.len() {
        return Err(MessagePackDecodeError::TrailingBytes(
            payload.len() - consumed,
        ));
    }
    Ok(message)
}

/// Reads and decodes one capped, length-prefixed frame from an async stream.
///
/// The declared length is checked before allocation, then the payload buffer
/// grows in small increments to avoid a large pre-authentication allocation.
pub async fn read_framed<F, R, T>(reader: &mut R) -> Result<T, ReadFrameError<F::DecodeError>>
where
    F: Framing,
    R: AsyncRead + Unpin,
    T: DeserializeOwned,
{
    let mut length = [0_u8; 4];
    reader
        .read_exact(&mut length)
        .await
        .map_err(ReadFrameError::ReadLength)?;
    let len = u32::from_be_bytes(length) as usize;
    if len > MAX_FRAME_LEN {
        return Err(ReadFrameError::TooLarge(len));
    }

    let mut payload = Vec::with_capacity(len.min(READ_CHUNK_LEN));
    while payload.len() < len {
        let start = payload.len();
        let chunk_len = (len - start).min(READ_CHUNK_LEN);
        payload.resize(start + chunk_len, 0);
        reader
            .read_exact(&mut payload[start..])
            .await
            .map_err(ReadFrameError::ReadPayload)?;
    }

    F::decode(&payload).map_err(ReadFrameError::Decode)
}

/// Encodes and writes one capped, length-prefixed frame to an async stream.
///
/// The prefix and payload are passed to vectored I/O without copying them into
/// a second combined frame buffer. The caller controls whether to flush.
pub async fn write_framed<F, W, T>(
    writer: &mut W,
    message: &T,
) -> Result<(), WriteFrameError<F::EncodeError>>
where
    F: Framing,
    W: AsyncWrite + Unpin,
    T: Serialize + ?Sized,
{
    let payload = F::encode(message).map_err(WriteFrameError::Encode)?;
    if payload.len() > MAX_FRAME_LEN {
        return Err(WriteFrameError::TooLarge(payload.len()));
    }

    let length = (payload.len() as u32).to_be_bytes();
    let frame_len = length.len() + payload.len();
    let mut written = 0;
    while written < frame_len {
        let result = if written < length.len() {
            let buffers = [IoSlice::new(&length[written..]), IoSlice::new(&payload)];
            writer.write_vectored(&buffers).await
        } else {
            let buffers = [IoSlice::new(&payload[written - length.len()..])];
            writer.write_vectored(&buffers).await
        };
        let count = result.map_err(|error| {
            if written < length.len() {
                WriteFrameError::WriteLength(error)
            } else {
                WriteFrameError::WritePayload(error)
            }
        })?;

        if count == 0 {
            let error = io::Error::new(
                io::ErrorKind::WriteZero,
                "failed to write the complete frame",
            );
            return Err(if written < length.len() {
                WriteFrameError::WriteLength(error)
            } else {
                WriteFrameError::WritePayload(error)
            });
        }
        written += count;
    }
    Ok(())
}

/// Encodes a serializable protocol message with a 4-byte big-endian length prefix.
pub fn encode_frame<T: Serialize>(message: &T) -> Result<Vec<u8>, FrameError> {
    let payload = encode_bincode(message)?;
    if payload.len() > MAX_FRAME_LEN {
        return Err(FrameError::TooLarge(payload.len()));
    }

    let mut frame = Vec::with_capacity(4 + payload.len());
    frame.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    frame.extend_from_slice(&payload);
    Ok(frame)
}

/// Decodes a complete length-prefixed bincode frame.
pub fn decode_frame<T: DeserializeOwned>(frame: &[u8]) -> Result<T, FrameError> {
    if frame.len() < 4 {
        return Err(FrameError::Incomplete);
    }

    let len = u32::from_be_bytes(frame[0..4].try_into().expect("slice has 4 bytes")) as usize;
    if len > MAX_FRAME_LEN {
        return Err(FrameError::TooLarge(len));
    }
    if frame.len() < 4 + len {
        return Err(FrameError::Incomplete);
    }

    Ok(decode_bincode(&frame[4..4 + len])?)
}

/// Returns the maximum allowed serialized payload length in bytes.
pub fn max_frame_len() -> usize {
    MAX_FRAME_LEN
}

#[cfg(test)]
mod tests {
    use super::{
        BincodeFraming, FrameError, MessagePackDecodeError, MessagePackFraming, ReadFrameError,
        decode_bincode, decode_frame, decode_messagepack, encode_bincode, encode_frame,
        encode_messagepack, max_frame_len, read_framed, write_framed,
    };
    use crate::ClientToServerMsg;
    use std::io::IoSlice;
    use std::pin::Pin;
    use std::task::{Context, Poll};
    use tokio::io::AsyncWrite;
    use tokio::io::{AsyncWriteExt, duplex};

    #[derive(Default)]
    struct PartialVectoredWriter {
        bytes: Vec<u8>,
        first_buffer_count: Option<usize>,
        scalar_writes: usize,
    }

    impl AsyncWrite for PartialVectoredWriter {
        fn poll_write(
            mut self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
            buffer: &[u8],
        ) -> Poll<std::io::Result<usize>> {
            self.scalar_writes += 1;
            let count = buffer.len().min(3);
            self.bytes.extend_from_slice(&buffer[..count]);
            Poll::Ready(Ok(count))
        }

        fn poll_flush(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
            Poll::Ready(Ok(()))
        }

        fn poll_shutdown(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
            Poll::Ready(Ok(()))
        }

        fn poll_write_vectored(
            mut self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
            buffers: &[IoSlice<'_>],
        ) -> Poll<std::io::Result<usize>> {
            self.first_buffer_count.get_or_insert(buffers.len());
            let mut remaining = 3;
            let mut written = 0;
            for buffer in buffers {
                let count = buffer.len().min(remaining);
                self.bytes.extend_from_slice(&buffer[..count]);
                remaining -= count;
                written += count;
                if remaining == 0 {
                    break;
                }
            }
            Poll::Ready(Ok(written))
        }

        fn is_write_vectored(&self) -> bool {
            true
        }
    }

    #[test]
    fn bincode_uses_v1_legacy_wire_layout() {
        let frame = encode_frame(&ClientToServerMsg::ListSessions).unwrap();

        assert_eq!(frame, [0, 0, 0, 4, 1, 0, 0, 0]);
    }

    #[test]
    fn bincode_decoder_rejects_trailing_payload_bytes() {
        let mut payload = encode_bincode(&ClientToServerMsg::ListSessions).unwrap();
        payload.push(0xff);
        let error = decode_bincode::<ClientToServerMsg>(&payload).unwrap_err();

        assert!(matches!(
            error,
            bincode::error::DecodeError::OtherString(message)
                if message.starts_with("trailing bytes after bincode payload")
        ));
    }

    #[test]
    fn decode_rejects_missing_length_prefix() {
        let error = decode_frame::<ClientToServerMsg>(&[0, 1, 2]).unwrap_err();

        assert!(matches!(error, FrameError::Incomplete));
    }

    #[test]
    fn decode_rejects_incomplete_payload() {
        let frame = [0, 0, 0, 4, 1, 2, 3];
        let error = decode_frame::<ClientToServerMsg>(&frame).unwrap_err();

        assert!(matches!(error, FrameError::Incomplete));
    }

    #[test]
    fn decode_rejects_oversized_payload_length_before_allocating() {
        let len = (max_frame_len() as u32 + 1).to_be_bytes();
        let error = decode_frame::<ClientToServerMsg>(&len).unwrap_err();

        assert!(matches!(error, FrameError::TooLarge(size) if size == max_frame_len() + 1));
    }

    #[test]
    fn frame_cap_is_one_mibibyte() {
        assert_eq!(max_frame_len(), 1024 * 1024);
    }

    #[tokio::test]
    async fn async_bincode_framing_keeps_the_legacy_wire_bytes() {
        let (mut writer, mut reader) = duplex(64);
        write_framed::<BincodeFraming, _, _>(&mut writer, &ClientToServerMsg::ListSessions)
            .await
            .unwrap();

        let mut frame = [0_u8; 8];
        tokio::io::AsyncReadExt::read_exact(&mut reader, &mut frame)
            .await
            .unwrap();
        assert_eq!(frame, [0, 0, 0, 4, 1, 0, 0, 0]);
    }

    #[tokio::test]
    async fn async_messagepack_framing_matches_named_field_encoding() {
        let message = ClientToServerMsg::Ping { seq: 9 };
        let payload = rmp_serde::to_vec_named(&message).unwrap();
        let (mut writer, mut reader) = duplex(128);

        write_framed::<MessagePackFraming, _, _>(&mut writer, &message)
            .await
            .unwrap();

        let mut frame = vec![0_u8; 4 + payload.len()];
        tokio::io::AsyncReadExt::read_exact(&mut reader, &mut frame)
            .await
            .unwrap();
        assert_eq!(&frame[..4], &(payload.len() as u32).to_be_bytes());
        assert_eq!(&frame[4..], payload);

        let decoded = decode_messagepack::<ClientToServerMsg>(&frame[4..]).unwrap();
        assert_eq!(decoded, message);
    }

    #[tokio::test]
    async fn async_writer_uses_vectored_io_without_a_combined_buffer() {
        let message = ClientToServerMsg::ListSessions;
        let expected = encode_frame(&message).unwrap();
        let mut writer = PartialVectoredWriter::default();

        write_framed::<BincodeFraming, _, _>(&mut writer, &message)
            .await
            .unwrap();

        assert_eq!(writer.first_buffer_count, Some(2));
        assert_eq!(writer.scalar_writes, 0);
        assert_eq!(writer.bytes, expected);
    }

    #[tokio::test]
    async fn async_reader_rejects_oversized_length_before_payload_read() {
        let (mut writer, mut reader) = duplex(16);
        writer
            .write_all(&((max_frame_len() as u32 + 1).to_be_bytes()))
            .await
            .unwrap();

        let error = read_framed::<MessagePackFraming, _, ClientToServerMsg>(&mut reader)
            .await
            .unwrap_err();

        assert!(matches!(error, ReadFrameError::TooLarge(len) if len == max_frame_len() + 1));
    }

    #[test]
    fn messagepack_decoder_rejects_trailing_payload_bytes() {
        let mut payload = encode_messagepack(&ClientToServerMsg::Ping { seq: 9 }).unwrap();
        payload.push(0xc0);

        let error = decode_messagepack::<ClientToServerMsg>(&payload).unwrap_err();

        assert!(matches!(error, MessagePackDecodeError::TrailingBytes(1)));
    }
}
