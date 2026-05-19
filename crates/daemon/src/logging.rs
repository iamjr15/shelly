use crate::{config::Config, privacy_tracing::PrivacySanitizerLayer};
use anyhow::{Context, Result};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};
use tracing_appender::non_blocking::WorkerGuard;
use tracing_subscriber::{EnvFilter, layer::SubscriberExt, util::SubscriberInitExt};

const LOG_RETENTION: Duration = Duration::from_secs(7 * 24 * 60 * 60);

pub struct LoggingGuard {
    _guard: WorkerGuard,
    _sentry: Option<sentry::ClientInitGuard>,
}

pub fn init(config: &Config) -> Result<LoggingGuard> {
    let log_dir = config.log_dir.clone().unwrap_or_else(default_log_dir);
    std::fs::create_dir_all(&log_dir).context("create daemon log directory")?;
    prune_old_log_files(&log_dir, SystemTime::now()).context("prune old daemon logs")?;
    let sentry = init_sentry(config)?;

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

    Ok(LoggingGuard {
        _guard: guard,
        _sentry: sentry,
    })
}

fn init_sentry(config: &Config) -> Result<Option<sentry::ClientInitGuard>> {
    let Some(options) = sentry_options(config)? else {
        return Ok(None);
    };
    Ok(Some(sentry::init(options)))
}

fn sentry_options(config: &Config) -> Result<Option<sentry::ClientOptions>> {
    if !config.telemetry.sentry_enabled() {
        return Ok(None);
    }

    let dsn = config.telemetry.sentry_dsn.as_deref().unwrap_or("").trim();
    let dsn = dsn.parse().context("parse configured daemon Sentry DSN")?;
    Ok(Some(sentry::ClientOptions {
        dsn: Some(dsn),
        release: sentry::release_name!(),
        send_default_pii: false,
        traces_sample_rate: 0.0,
        ..Default::default()
    }))
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
    use crate::config::{Config, TelemetryConfig};
    use std::ffi::CString;
    use std::fs;
    use std::os::unix::ffi::OsStrExt;
    use std::panic;
    use std::time::{Duration, SystemTime};

    fn sentry_config() -> Config {
        Config {
            telemetry: TelemetryConfig {
                opt_in: true,
                sentry_dsn: Some("https://public@example.invalid/1".to_string()),
            },
            ..Default::default()
        }
    }

    #[test]
    fn sentry_options_require_explicit_opt_in() {
        let mut config = sentry_config();
        config.telemetry.opt_in = false;
        assert!(sentry_options(&config).unwrap().is_none());

        config.telemetry.opt_in = true;
        config.telemetry.sentry_dsn = None;
        assert!(sentry_options(&config).unwrap().is_none());
    }

    #[test]
    fn sentry_options_disable_pii_and_tracing() {
        let options = sentry_options(&sentry_config()).unwrap().unwrap();

        assert!(options.dsn.is_some());
        assert!(!options.send_default_pii);
        assert_eq!(options.traces_sample_rate, 0.0);
    }

    #[test]
    fn sentry_options_capture_panic_with_test_transport() {
        let options = sentry::apply_defaults(sentry_options(&sentry_config()).unwrap().unwrap());
        let events = sentry::test::with_captured_events_options(
            || {
                let _ = panic::catch_unwind(|| {
                    panic!("fieldwork daemon sentry smoke");
                });
            },
            options,
        );

        assert_eq!(events.len(), 1);
        let event = &events[0];
        assert_eq!(event.level, sentry::Level::Fatal);
        let exception = event.exception.values.first().expect("panic exception");
        assert_eq!(exception.ty, "panic");
        assert_eq!(
            exception.value.as_deref(),
            Some("fieldwork daemon sentry smoke")
        );
    }

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
