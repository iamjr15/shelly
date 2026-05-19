use serde::{Serialize, de::DeserializeOwned};
use thiserror::Error;

const MAX_FRAME_LEN: usize = 16 * 1024 * 1024;

#[derive(Debug, Error)]
/// Errors returned while decoding or encoding length-prefixed bincode frames.
pub enum FrameError {
    /// Payload length exceeded the protocol maximum.
    #[error("frame length {0} exceeds maximum")]
    TooLarge(usize),
    /// The buffer ended before a full length prefix or payload was available.
    #[error("incomplete frame")]
    Incomplete,
    /// Bincode failed to serialize or deserialize the payload.
    #[error(transparent)]
    Bincode(#[from] Box<bincode::ErrorKind>),
}

/// Encodes a serializable protocol message with a 4-byte big-endian length prefix.
pub fn encode_frame<T: Serialize>(message: &T) -> Result<Vec<u8>, FrameError> {
    let payload = bincode::serialize(message)?;
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

    Ok(bincode::deserialize(&frame[4..4 + len])?)
}

/// Returns the maximum allowed serialized payload length in bytes.
pub fn max_frame_len() -> usize {
    MAX_FRAME_LEN
}

#[cfg(test)]
mod tests {
    use super::{FrameError, decode_frame, max_frame_len};
    use crate::ClientToServerMsg;

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
}
