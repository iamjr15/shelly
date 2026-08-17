use std::time::{SystemTime, UNIX_EPOCH};

pub(crate) fn now_ms() -> u64 {
    millis_since_epoch(SystemTime::now())
}

fn millis_since_epoch(now: SystemTime) -> u64 {
    now.duration_since(UNIX_EPOCH).map_or(0, |duration| {
        duration.as_millis().try_into().unwrap_or(u64::MAX)
    })
}

#[cfg(test)]
mod tests {
    use super::{UNIX_EPOCH, millis_since_epoch};
    use std::time::Duration;

    #[test]
    fn time_before_unix_epoch_saturates_to_zero() {
        let before_epoch = UNIX_EPOCH.checked_sub(Duration::from_secs(1)).unwrap();
        assert_eq!(millis_since_epoch(before_epoch), 0);
    }
}
