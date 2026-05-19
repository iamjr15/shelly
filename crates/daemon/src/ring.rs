use std::collections::VecDeque;

#[derive(Debug, Clone)]
struct Chunk {
    start: u64,
    bytes: Vec<u8>,
}

#[derive(Debug, Clone)]
pub struct PtyRingBuffer {
    capacity: usize,
    start_seq: u64,
    next_seq: u64,
    len: usize,
    chunks: VecDeque<Chunk>,
}

impl PtyRingBuffer {
    pub fn new(capacity: usize) -> Self {
        Self {
            capacity,
            start_seq: 0,
            next_seq: 0,
            len: 0,
            chunks: VecDeque::new(),
        }
    }

    pub fn push(&mut self, bytes: &[u8]) -> u64 {
        let original_start = self.next_seq;
        if bytes.is_empty() {
            return original_start;
        }

        let Some(next_seq) = self.next_seq.checked_add(bytes.len() as u64) else {
            self.next_seq = u64::MAX;
            self.start_seq = u64::MAX;
            self.len = 0;
            self.chunks.clear();
            return original_start;
        };
        self.next_seq = next_seq;

        let bytes = if bytes.len() > self.capacity {
            bytes[bytes.len() - self.capacity..].to_vec()
        } else {
            bytes.to_vec()
        };
        let start = self.next_seq.saturating_sub(bytes.len() as u64);

        if bytes.len() == self.capacity {
            self.chunks.clear();
            self.len = 0;
            self.start_seq = self.next_seq - self.capacity as u64;
        }

        self.len += bytes.len();
        self.chunks.push_back(Chunk { start, bytes });
        self.evict();
        original_start
    }

    pub fn replay_from(&self, seq: u64) -> Option<(u64, Vec<u8>)> {
        if seq < self.start_seq || seq > self.next_seq {
            return None;
        }

        let mut out = Vec::new();
        for chunk in &self.chunks {
            let chunk_end = chunk.start.saturating_add(chunk.bytes.len() as u64);
            if chunk_end <= seq {
                continue;
            }
            let offset = seq.saturating_sub(chunk.start) as usize;
            out.extend_from_slice(&chunk.bytes[offset..]);
        }

        Some((seq, out))
    }

    pub fn snapshot(&self) -> (u64, Vec<u8>) {
        let mut out = Vec::with_capacity(self.len);
        for chunk in &self.chunks {
            out.extend_from_slice(&chunk.bytes);
        }
        (self.start_seq, out)
    }

    #[cfg(test)]
    pub fn next_seq(&self) -> u64 {
        self.next_seq
    }

    pub fn end_seq(&self) -> u64 {
        self.next_seq
    }

    fn evict(&mut self) {
        while self.len > self.capacity {
            let Some(front) = self.chunks.front_mut() else {
                break;
            };

            let overflow = self.len - self.capacity;
            if overflow >= front.bytes.len() {
                let removed = self.chunks.pop_front().expect("front exists");
                self.len -= removed.bytes.len();
                self.start_seq = removed.start.saturating_add(removed.bytes.len() as u64);
            } else {
                front.bytes.drain(..overflow);
                front.start = front.start.saturating_add(overflow as u64);
                self.len -= overflow;
                self.start_seq = front.start;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::PtyRingBuffer;
    use proptest::prelude::*;

    #[test]
    fn replays_bytes_after_seen_seq() {
        let mut ring = PtyRingBuffer::new(16);
        ring.push(b"hello ");
        ring.push(b"world");

        let (_, bytes) = ring.replay_from(6).unwrap();
        assert_eq!(bytes, b"world");
    }

    #[test]
    fn rejects_stale_seq_outside_window() {
        let mut ring = PtyRingBuffer::new(5);
        ring.push(b"hello");
        ring.push(b" world");

        assert!(ring.replay_from(0).is_none());
        let (start, bytes) = ring.snapshot();
        assert_eq!(start, 6);
        assert_eq!(bytes, b"world");
    }

    #[test]
    fn accepts_next_seq_as_empty_replay() {
        let mut ring = PtyRingBuffer::new(8);
        ring.push(b"abc");

        let (_, bytes) = ring.replay_from(ring.next_seq()).unwrap();
        assert!(bytes.is_empty());
    }

    #[test]
    fn seq_overflow_forces_cold_resync_window() {
        let mut ring = PtyRingBuffer::new(8);
        ring.next_seq = u64::MAX - 1;
        ring.start_seq = u64::MAX - 1;

        let first_start = ring.push(b"abcd");

        assert_eq!(first_start, u64::MAX - 1);
        assert_eq!(ring.next_seq(), u64::MAX);
        assert!(ring.replay_from(u64::MAX - 1).is_none());
        assert_eq!(ring.snapshot(), (u64::MAX, Vec::new()));
    }

    proptest! {
        #[test]
        fn snapshot_and_replay_match_last_capacity_bytes(
            capacity in 1usize..128,
            chunks in prop::collection::vec(prop::collection::vec(any::<u8>(), 0..64), 0..64),
        ) {
            let mut ring = PtyRingBuffer::new(capacity);
            let mut all = Vec::new();
            for chunk in chunks {
                let expected_start = all.len() as u64;
                let actual_start = ring.push(&chunk);
                prop_assert_eq!(actual_start, expected_start);
                all.extend_from_slice(&chunk);
            }

            let retained_start = all.len().saturating_sub(capacity);
            let retained = all[retained_start..].to_vec();
            let (snapshot_start, snapshot) = ring.snapshot();
            prop_assert_eq!(snapshot_start, retained_start as u64);
            prop_assert_eq!(snapshot, retained);

            let end = all.len() as u64;
            let start = retained_start as u64;
            for seq in [start, start + (end - start) / 2, end] {
                let (_, replay) = ring.replay_from(seq).expect("seq inside ring window");
                let offset = (seq - start) as usize;
                prop_assert_eq!(replay, all[retained_start + offset..].to_vec());
            }

            if start > 0 {
                prop_assert!(ring.replay_from(start - 1).is_none());
            }
            prop_assert!(ring.replay_from(end + 1).is_none());
        }
    }
}
