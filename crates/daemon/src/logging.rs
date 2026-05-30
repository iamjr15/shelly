use crate::{config::Config, privacy_tracing::PrivacySanitizerLayer};
use anyhow::{Context, Result};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};
use tracing_appender::non_blocking::WorkerGuard;
use tracing_subscriber::{EnvFilter, layer::SubscriberExt, util::SubscriberInitExt};

const LOG_RETENTION: Duration = Duration::from_secs(7 * 24 * 60 * 60);

pub struct LoggingGuard {
    _guard: WorkerGuard,
}

pub fn init(config: &Config) -> Result<LoggingGuard> {
    let log_dir = config.log_dir.clone().unwrap_or_else(default_log_dir);
    std::fs::create_dir_all(&log_dir).context("create daemon log directory")?;
    prune_old_log_files(&log_dir, SystemTime::now()).context("prune old daemon logs")?;

    let file_appender = tracing_appender::rolling::daily(log_dir, "daemon.log");
    let (writer, guard) = tracing_appender::non_blocking(file_appender);
    let fmt_layer = tracing_subscriber::fmt::layer()
        .with_writer(writer)
        .with_ansi(false);
    let env_filter = EnvFilter::from_default_env().add_directive("fieldwork_daemon=info".parse()?);
    tracing_subscriber::registry()
        .with(env_filter)
        .with(fmt_layer)
        .with(PrivacySanitizerLayer)
        .init();

    Ok(LoggingGuard { _guard: guard })
}

fn default_log_dir() -> PathBuf {
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

fn prune_old_log_files(log_dir: &Path, now: SystemTime) -> Result<()> {
    let cutoff = now
        .checked_sub(LOG_RETENTION)
        .unwrap_or(SystemTime::UNIX_EPOCH);
    for entry in
        std::fs::read_dir(log_dir).with_context(|| format!("read {}", log_dir.display()))?
    {
        let entry = entry?;
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if !name.starts_with("daemon.log") {
            continue;
        }
        let metadata = entry.metadata()?;
        if !metadata.is_file() {
            continue;
        }
        if metadata.modified()? < cutoff {
            std::fs::remove_file(&path).with_context(|| format!("remove {}", path.display()))?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::CString;
    use std::fs;
    use std::os::unix::ffi::OsStrExt;
    use std::time::{Duration, SystemTime};

    #[test]
    fn prune_old_log_files_removes_only_expired_daemon_logs() {
        let dir = tempfile::tempdir().unwrap();
        let now = SystemTime::UNIX_EPOCH + Duration::from_secs(20 * 24 * 60 * 60);
        let expired = dir.path().join("daemon.log.1970-01-12");
        let retained = dir.path().join("daemon.log.1970-01-15");
        let exact_boundary = dir.path().join("daemon.log.1970-01-13");
        let other = dir.path().join("other.log.1970-01-12");
        let nested = dir.path().join("daemon.log.directory");

        for path in [&expired, &retained, &exact_boundary, &other] {
            fs::write(path, b"log").unwrap();
        }
        fs::create_dir(&nested).unwrap();

        set_modified(&expired, now - Duration::from_secs(8 * 24 * 60 * 60));
        set_modified(&retained, now - Duration::from_secs(6 * 24 * 60 * 60));
        set_modified(&exact_boundary, now - LOG_RETENTION);
        set_modified(&other, now - Duration::from_secs(8 * 24 * 60 * 60));

        prune_old_log_files(dir.path(), now).unwrap();

        assert!(!expired.exists());
        assert!(retained.exists());
        assert!(exact_boundary.exists());
        assert!(other.exists());
        assert!(nested.exists());
    }

    fn set_modified(path: &Path, time: SystemTime) {
        let duration = time.duration_since(SystemTime::UNIX_EPOCH).unwrap();
        let timeval = libc::timeval {
            tv_sec: duration.as_secs() as libc::time_t,
            tv_usec: duration.subsec_micros() as libc::suseconds_t,
        };
        let times = [timeval, timeval];
        let c_path = CString::new(path.as_os_str().as_bytes()).unwrap();
        let result = unsafe { libc::utimes(c_path.as_ptr(), times.as_ptr()) };
        assert_eq!(result, 0);
    }
}
