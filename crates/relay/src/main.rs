mod iroh_fallback;
mod privacy_tracing;
mod telemetry;

use anyhow::{Context, Result, bail};
use privacy_tracing::PrivacySanitizerLayer;
use std::path::PathBuf;
use tracing_subscriber::{EnvFilter, layer::SubscriberExt, util::SubscriberInitExt};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RelayMode {
    ControlPlane,
    IrohRelay,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let _telemetry = init_tracing()?;

    match relay_mode()? {
        RelayMode::ControlPlane => serve_control_plane().await,
        RelayMode::IrohRelay => iroh_fallback::serve_from_env().await,
    }
}

fn init_tracing() -> Result<telemetry::TelemetryGuard> {
    let telemetry = telemetry::TelemetryGuard::from_env()?;
    let filter = EnvFilter::from_default_env().add_directive("fieldwork_relay=info".parse()?);

    if let Some(telemetry_layer) = telemetry.layer() {
        tracing_subscriber::registry()
            .with(telemetry_layer)
            .with(filter)
            .with(tracing_subscriber::fmt::layer())
            .with(PrivacySanitizerLayer)
            .init();
        tracing::info!(
            sample_rate = telemetry.sample_rate(),
            endpoint = %telemetry.endpoint().unwrap_or(""),
            "fieldwork relay OTLP tracing enabled"
        );
    } else {
        tracing_subscriber::registry()
            .with(filter)
            .with(tracing_subscriber::fmt::layer())
            .with(PrivacySanitizerLayer)
            .init();
    }

    Ok(telemetry)
}

async fn serve_control_plane() -> Result<()> {
    let addr = std::env::var("FIELDWORK_RELAY_ADDR").unwrap_or_else(|_| "127.0.0.1:8443".into());
    let metrics_addr =
        std::env::var("FIELDWORK_RELAY_METRICS_ADDR").unwrap_or_else(|_| "127.0.0.1:9090".into());
    let metrics_addr = if metrics_addr.trim().is_empty() || metrics_addr == "off" {
        None
    } else {
        Some(metrics_addr.as_str())
    };
    match relay_tls_files()? {
        Some(tls) => {
            fieldwork_relay::serve_tls_with_metrics(
                &addr,
                metrics_addr,
                tls.cert_path,
                tls.key_path,
            )
            .await
        }
        None => fieldwork_relay::serve_with_metrics(&addr, metrics_addr).await,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RelayTlsFiles {
    cert_path: PathBuf,
    key_path: PathBuf,
}

fn relay_tls_files() -> Result<Option<RelayTlsFiles>> {
    let require_tls = parse_bool_env("FIELDWORK_RELAY_REQUIRE_TLS")?;
    let cert_path = std::env::var_os("FIELDWORK_RELAY_TLS_CERT_PATH")
        .map(PathBuf::from)
        .or_else(|| credential_path("control-plane.crt"));
    let key_path = std::env::var_os("FIELDWORK_RELAY_TLS_KEY_PATH")
        .map(PathBuf::from)
        .or_else(|| credential_path("control-plane.key"));
    relay_tls_files_from_paths(require_tls, cert_path, key_path)
}

fn relay_tls_files_from_paths(
    require_tls: bool,
    cert_path: Option<PathBuf>,
    key_path: Option<PathBuf>,
) -> Result<Option<RelayTlsFiles>> {
    match (cert_path, key_path) {
        (Some(cert_path), Some(key_path)) => Ok(Some(RelayTlsFiles {
            cert_path,
            key_path,
        })),
        (None, None) if require_tls => {
            bail!("FIELDWORK_RELAY_REQUIRE_TLS is set but control-plane TLS cert/key are missing")
        }
        (None, None) => Ok(None),
        _ => bail!("set both FIELDWORK_RELAY_TLS_CERT_PATH and FIELDWORK_RELAY_TLS_KEY_PATH"),
    }
}

fn credential_path(name: &str) -> Option<PathBuf> {
    let dir = std::env::var_os("CREDENTIALS_DIRECTORY")?;
    let path = PathBuf::from(dir).join(name);
    path.exists().then_some(path)
}

fn parse_bool_env(name: &str) -> Result<bool> {
    parse_bool_value(name, std::env::var_os(name))
}

fn parse_bool_value(name: &str, value: Option<std::ffi::OsString>) -> Result<bool> {
    let Some(value) = value else {
        return Ok(false);
    };
    match value.to_string_lossy().trim().to_ascii_lowercase().as_str() {
        "" | "0" | "false" | "no" | "off" => Ok(false),
        "1" | "true" | "yes" | "on" => Ok(true),
        _ => bail!("{name} must be true or false"),
    }
}

fn relay_mode() -> Result<RelayMode> {
    let value = std::env::var("FIELDWORK_RELAY_MODE").unwrap_or_else(|_| "control-plane".into());
    parse_relay_mode(&value).with_context(|| format!("parse FIELDWORK_RELAY_MODE={value:?}"))
}

fn parse_relay_mode(value: &str) -> Result<RelayMode> {
    match value.trim().to_ascii_lowercase().as_str() {
        "" | "control" | "control-plane" | "push" => Ok(RelayMode::ControlPlane),
        "iroh" | "iroh-relay" | "fallback" => Ok(RelayMode::IrohRelay),
        _ => bail!("FIELDWORK_RELAY_MODE must be control-plane or iroh-relay"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relay_mode_defaults_to_control_plane() {
        assert_eq!(parse_relay_mode("").unwrap(), RelayMode::ControlPlane);
        assert_eq!(
            parse_relay_mode("control-plane").unwrap(),
            RelayMode::ControlPlane
        );
    }

    #[test]
    fn relay_mode_accepts_iroh_alias() {
        assert_eq!(
            parse_relay_mode("iroh-relay").unwrap(),
            RelayMode::IrohRelay
        );
    }

    #[test]
    fn parse_bool_value_accepts_common_values() {
        assert!(parse_bool_value("FIELDWORK_TEST_BOOL", Some("yes".into())).unwrap());
        assert!(parse_bool_value("FIELDWORK_TEST_BOOL", Some("1".into())).unwrap());
        assert!(!parse_bool_value("FIELDWORK_TEST_BOOL", Some("off".into())).unwrap());
        assert!(!parse_bool_value("FIELDWORK_TEST_BOOL", Some("0".into())).unwrap());
        assert!(!parse_bool_value("FIELDWORK_TEST_BOOL", None).unwrap());
        assert!(parse_bool_value("FIELDWORK_TEST_BOOL", Some("maybe".into())).is_err());
    }

    #[test]
    fn relay_tls_files_require_pair_when_tls_is_required() {
        assert!(
            relay_tls_files_from_paths(false, None, None)
                .unwrap()
                .is_none()
        );
        assert!(relay_tls_files_from_paths(true, None, None).is_err());
        assert!(
            relay_tls_files_from_paths(true, Some(PathBuf::from("control-plane.crt")), None)
                .is_err()
        );

        let tls = relay_tls_files_from_paths(
            true,
            Some(PathBuf::from("control-plane.crt")),
            Some(PathBuf::from("control-plane.key")),
        )
        .unwrap()
        .unwrap();
        assert_eq!(tls.cert_path, PathBuf::from("control-plane.crt"));
        assert_eq!(tls.key_path, PathBuf::from("control-plane.key"));
    }
}
