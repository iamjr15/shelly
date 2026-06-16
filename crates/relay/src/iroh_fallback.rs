use anyhow::{Context, Result, bail};
use iroh_relay::server::{
    self, AcmeConfig, CertConfig, QuicConfig, RelayConfig, ServerConfig, TlsConfig,
};
use std::net::{Ipv6Addr, SocketAddr};
use std::path::PathBuf;
use std::sync::Arc;
use tracing::info;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct IrohRelayConfig {
    pub(crate) http_addr: SocketAddr,
    pub(crate) https_addr: SocketAddr,
    pub(crate) quic_addr: SocketAddr,
    pub(crate) metrics_addr: Option<SocketAddr>,
    pub(crate) hostname: Option<String>,
    pub(crate) contact_email: Option<String>,
    pub(crate) cert_dir: PathBuf,
    pub(crate) use_staging_acme: bool,
    pub(crate) http_only: bool,
}

impl IrohRelayConfig {
    pub(crate) fn from_env() -> Result<Self> {
        let http_addr = socket_env(
            "SHELLY_IROH_RELAY_HTTP_ADDR",
            (Ipv6Addr::UNSPECIFIED, 80).into(),
        )?;
        let https_addr = socket_env(
            "SHELLY_IROH_RELAY_HTTPS_ADDR",
            (Ipv6Addr::UNSPECIFIED, 443).into(),
        )?;
        let quic_addr = socket_env(
            "SHELLY_IROH_RELAY_QUIC_ADDR",
            (Ipv6Addr::UNSPECIFIED, 7842).into(),
        )?;
        let metrics_addr = optional_socket_env(
            "SHELLY_IROH_RELAY_METRICS_ADDR",
            Some(SocketAddr::from(([127, 0, 0, 1], 9091))),
        )?;
        let cert_dir = std::env::var("SHELLY_IROH_RELAY_CERT_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("/var/lib/shelly/acme"));
        Ok(Self {
            http_addr,
            https_addr,
            quic_addr,
            metrics_addr,
            hostname: non_empty_env("SHELLY_IROH_RELAY_HOSTNAME"),
            contact_email: non_empty_env("SHELLY_IROH_RELAY_CONTACT_EMAIL"),
            cert_dir,
            use_staging_acme: bool_env("SHELLY_IROH_RELAY_STAGING", false)?,
            http_only: bool_env("SHELLY_IROH_RELAY_HTTP_ONLY", false)?,
        })
    }
}

pub(crate) async fn serve_from_env() -> Result<()> {
    let config = IrohRelayConfig::from_env()?;
    let server_config = build_server_config(&config)?;
    let mut relay = server::Server::spawn(server_config)
        .await
        .context("spawn iroh relay fallback server")?;
    info!(
        http_addr = ?relay.http_addr(),
        https_addr = ?relay.https_addr(),
        quic_addr = ?relay.quic_addr(),
        "iroh relay fallback listening"
    );
    tokio::select! {
        biased;
        _ = tokio::signal::ctrl_c() => (),
        result = relay.join() => {
            result
                .context("join iroh relay fallback supervisor")?
                .context("iroh relay fallback supervisor failed")?;
            return Ok(());
        }
    }
    relay
        .shutdown()
        .await
        .context("shutdown iroh relay fallback server")?;
    Ok(())
}

pub(crate) fn build_server_config(config: &IrohRelayConfig) -> Result<ServerConfig> {
    let mut relay = RelayConfig::new(config.http_addr);
    let mut server_config = ServerConfig::default();

    if config.http_only {
        relay.tls = None;
        server_config.quic = None;
    } else {
        relay.tls = Some(TlsConfig::new(
            config.https_addr,
            lets_encrypt_cert_config(config)?,
        ));
        server_config.quic = Some(QuicConfig::new(config.quic_addr));
    }

    relay.key_cache_capacity = Some(100_000);
    server_config.relay = Some(relay);
    server_config.metrics_addr = config.metrics_addr;
    Ok(server_config)
}

fn lets_encrypt_cert_config(config: &IrohRelayConfig) -> Result<CertConfig> {
    let hostname = config
        .hostname
        .clone()
        .context("SHELLY_IROH_RELAY_HOSTNAME is required unless HTTP-only mode is enabled")?;
    let contact_email = config
        .contact_email
        .clone()
        .context("SHELLY_IROH_RELAY_CONTACT_EMAIL is required unless HTTP-only mode is enabled")?;

    let _ = rustls::crypto::ring::default_provider().install_default();
    let server_config_builder = rustls::ServerConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .context("configure iroh relay TLS protocol versions")?
    .with_no_client_auth();

    let acme_config = AcmeConfig::letsencrypt(!config.use_staging_acme)
        .domains(vec![hostname])
        .contact(vec![format!("mailto:{contact_email}")])
        .cache_path(config.cert_dir.clone());

    Ok(CertConfig::LetsEncrypt {
        acme_config,
        server_config_builder,
    })
}

fn socket_env(name: &str, default: SocketAddr) -> Result<SocketAddr> {
    match std::env::var(name) {
        Ok(value) if !value.trim().is_empty() => value
            .parse()
            .with_context(|| format!("parse {name} socket address")),
        _ => Ok(default),
    }
}

fn optional_socket_env(name: &str, default: Option<SocketAddr>) -> Result<Option<SocketAddr>> {
    match std::env::var(name) {
        Ok(value) if value.trim().eq_ignore_ascii_case("off") => Ok(None),
        Ok(value) if !value.trim().is_empty() => value
            .parse()
            .map(Some)
            .with_context(|| format!("parse {name} socket address")),
        _ => Ok(default),
    }
}

fn bool_env(name: &str, default: bool) -> Result<bool> {
    let Ok(value) = std::env::var(name) else {
        return Ok(default);
    };
    parse_bool_env(name, &value, default)
}

fn parse_bool_env(name: &str, value: &str, default: bool) -> Result<bool> {
    match value.trim().to_ascii_lowercase().as_str() {
        "" => Ok(default),
        "1" | "true" | "yes" | "on" => Ok(true),
        "0" | "false" | "no" | "off" => Ok(false),
        _ => bail!("{name} must be true/false, yes/no, on/off, or 1/0"),
    }
}

fn non_empty_env(name: &str) -> Option<String> {
    std::env::var(name).ok().and_then(|value| {
        let value = value.trim();
        (!value.is_empty()).then(|| value.to_string())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn http_only_config_does_not_require_acme_identity() {
        let config = IrohRelayConfig {
            http_addr: SocketAddr::from(([127, 0, 0, 1], 3340)),
            https_addr: SocketAddr::from(([127, 0, 0, 1], 443)),
            quic_addr: SocketAddr::from(([127, 0, 0, 1], 7842)),
            metrics_addr: None,
            hostname: None,
            contact_email: None,
            cert_dir: PathBuf::from("/tmp/acme"),
            use_staging_acme: true,
            http_only: true,
        };

        let server_config = build_server_config(&config).unwrap();
        assert!(server_config.relay.unwrap().tls.is_none());
        assert!(server_config.quic.is_none());
    }

    #[test]
    fn production_config_requires_hostname_and_contact_email() {
        let config = IrohRelayConfig {
            http_addr: SocketAddr::from(([127, 0, 0, 1], 80)),
            https_addr: SocketAddr::from(([127, 0, 0, 1], 443)),
            quic_addr: SocketAddr::from(([127, 0, 0, 1], 7842)),
            metrics_addr: None,
            hostname: None,
            contact_email: None,
            cert_dir: PathBuf::from("/tmp/acme"),
            use_staging_acme: false,
            http_only: false,
        };

        let error = build_server_config(&config).unwrap_err().to_string();
        assert!(error.contains("SHELLY_IROH_RELAY_HOSTNAME"));
    }

    #[test]
    fn production_config_enables_tls_and_quic() {
        let config = IrohRelayConfig {
            http_addr: SocketAddr::from(([127, 0, 0, 1], 80)),
            https_addr: SocketAddr::from(([127, 0, 0, 1], 443)),
            quic_addr: SocketAddr::from(([127, 0, 0, 1], 7842)),
            metrics_addr: Some(SocketAddr::from(([127, 0, 0, 1], 9091))),
            hostname: Some("relay.shelly.sh".to_string()),
            contact_email: Some("ops@shelly.sh".to_string()),
            cert_dir: PathBuf::from("/tmp/acme"),
            use_staging_acme: true,
            http_only: false,
        };

        let server_config = build_server_config(&config).unwrap();
        assert!(server_config.relay.unwrap().tls.is_some());
        assert!(server_config.quic.is_some());
    }

    #[test]
    fn bool_env_rejects_ambiguous_values() {
        let name = "SHELLY_TEST_BAD_BOOL";
        let error = parse_bool_env(name, "maybe", false)
            .unwrap_err()
            .to_string();
        assert!(error.contains(name));
    }
}
