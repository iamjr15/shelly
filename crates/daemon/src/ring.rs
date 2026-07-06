use std::collections::VecDeque;

// A flat byte deque rather than a deque of per-push chunks: interactive PTY
// reads are often 1-3 bytes, so per-push allocations would cost ~32 bytes of
// overhead per payload byte and make snapshot/replay O(#pushes).
#[derive(Debug)]
pub struct PtyRingBuffer {
    capacity: usize,
    start_seq: u64,
    next_seq: u64,
    data: VecDeque<u8>,
}

impl PtyRingBuffer {
    pub fn new(capacity: usize) -> Self {
        Self {
            capacity,
            start_seq: 0,
            next_seq: 0,
            data: VecDeque::new(),
        }
    }

    pub fn push(&mut self, bytes: &[u8]) -> u64 {
        let original_start = self.next_seq;
        if bytes.is_empty() {
            return original_start;
        }

        let Some(next_seq) = self.next_seq.checked_add(bytes.len() as u64) else {
            // Seq counter exhausted: poison the window so every replay_from()
            // misses and clients fall back to a cold snapshot resync.
            self.next_seq = u64::MAX;
            self.start_seq = u64::MAX;
            self.data.clear();
            return original_start;
        };
        self.next_seq = next_seq;

        let bytes = if bytes.len() > self.capacity {
            &bytes[bytes.len() - self.capacity..]
        } else {
            bytes
        };
        let overflow = (self.data.len() + bytes.len()).saturating_sub(self.capacity);
        if overflow > 0 {
            self.data.drain(..overflow);
        }
        self.data.extend(bytes);
        self.start_seq = self.next_seq - self.data.len() as u64;
        original_start
    }

    pub fn replay_from(&self, seq: u64) -> Option<(u64, Vec<u8>)> {
        if seq < self.start_seq || seq > self.next_seq {
            return None;
        }

        let offset = (seq - self.start_seq) as usize;
        let (first, second) = self.data.as_slices();
        let mut out = Vec::with_capacity(self.data.len() - offset);
        if offset < first.len() {
            out.extend_from_slice(&first[offset..]);
            out.extend_from_slice(second);
        } else {
            out.extend_from_slice(&second[offset - first.len()..]);
        }
        Some((seq, out))
    }

    pub fn snapshot(&self) -> (u64, Vec<u8>) {
        let (first, second) = self.data.as_slices();
        let mut out = Vec::with_capacity(self.data.len());
        out.extend_from_slice(first);
        out.extend_from_slice(second);
        (self.start_seq, out)
    }

    pub fn end_seq(&self) -> u64 {
        self.next_seq
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

        let (_, bytes) = ring.replay_from(ring.end_seq()).unwrap();
        assert!(bytes.is_empty());
    }

    #[test]
    fn replays_after_eviction_wraps_storage() {
        let mut ring = PtyRingBuffer::new(8);
        ring.push(b"01234567");
        ring.push(b"abcd");

        let (start, bytes) = ring.snapshot();
        assert_eq!(start, 4);
        assert_eq!(bytes, b"4567abcd");
        let (_, bytes) = ring.replay_from(6).unwrap();
        assert_eq!(bytes, b"67abcd");
        let (_, bytes) = ring.replay_from(9).unwrap();
        assert_eq!(bytes, b"bcd");
    }

    #[test]
    fn seq_overflow_forces_cold_resync_window() {
        let mut ring = PtyRingBuffer::new(8);
        ring.next_seq = u64::MAX - 1;
        ring.start_seq = u64::MAX - 1;

        let first_start = ring.push(b"abcd");

        assert_eq!(first_start, u64::MAX - 1);
        assert_eq!(ring.end_seq(), u64::MAX);
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
