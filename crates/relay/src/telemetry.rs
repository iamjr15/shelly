use anyhow::{Context, Result, bail};
use opentelemetry::{KeyValue, global, trace::TracerProvider as _};
use opentelemetry_otlp::{Protocol, WithExportConfig, WithHttpConfig};
use opentelemetry_sdk::{
    Resource,
    trace::{Sampler, SdkTracerProvider},
};
use std::{
    collections::HashMap,
    fmt,
    path::{Path, PathBuf},
    time::Duration,
};
use tracing_opentelemetry::OpenTelemetryLayer;
use tracing_subscriber::Registry;

const DEFAULT_HONEYCOMB_TRACES_ENDPOINT: &str = "https://api.honeycomb.io/v1/traces";
const DEFAULT_SAMPLE_RATE: f64 = 0.01;
const HONEYCOMB_CREDENTIAL_NAME: &str = "honeycomb-api-key";

pub(crate) struct TelemetryGuard {
    provider: Option<SdkTracerProvider>,
    config: Option<TelemetryConfig>,
}

impl TelemetryGuard {
    pub(crate) fn from_env() -> Result<Self> {
        let Some(config) = TelemetryConfig::from_env()? else {
            return Ok(Self {
                provider: None,
                config: None,
            });
        };

        let exporter = opentelemetry_otlp::SpanExporter::builder()
            .with_http()
            .with_protocol(Protocol::HttpBinary)
            .with_endpoint(config.endpoint.clone())
            .with_timeout(Duration::from_secs(5))
            .with_headers(config.headers.clone())
            .build()
            .context("build relay OTLP HTTP span exporter")?;

        let resource = Resource::builder()
            .with_service_name("fieldwork-relay")
            .with_attribute(KeyValue::new("service.version", env!("CARGO_PKG_VERSION")))
            .build();
        let provider = SdkTracerProvider::builder()
            .with_batch_exporter(exporter)
            .with_sampler(Sampler::TraceIdRatioBased(config.sample_rate))
            .with_resource(resource)
            .build();
        global::set_tracer_provider(provider.clone());

        Ok(Self {
            provider: Some(provider),
            config: Some(config),
        })
    }

    pub(crate) fn layer(
        &self,
    ) -> Option<OpenTelemetryLayer<Registry, opentelemetry_sdk::trace::SdkTracer>> {
        let provider = self.provider.as_ref()?;
        Some(tracing_opentelemetry::layer().with_tracer(provider.tracer("fieldwork-relay")))
    }

    pub(crate) fn sample_rate(&self) -> f64 {
        self.config
            .as_ref()
            .map(|config| config.sample_rate)
            .unwrap_or(0.0)
    }

    pub(crate) fn endpoint(&self) -> Option<&str> {
        self.config.as_ref().map(|config| config.endpoint.as_str())
    }
}

impl Drop for TelemetryGuard {
    fn drop(&mut self) {
        if let Some(provider) = self.provider.take() {
            let _ = provider.shutdown();
        }
    }
}

struct TelemetryConfig {
    endpoint: String,
    sample_rate: f64,
    headers: HashMap<String, String>,
}

impl TelemetryConfig {
    fn from_env() -> Result<Option<Self>> {
        let endpoint = trimmed_env("FIELDWORK_RELAY_OTLP_ENDPOINT");
        let honeycomb_api_key = honeycomb_api_key()?;

        if endpoint.is_none() && honeycomb_api_key.is_none() {
            return Ok(None);
        }

        let mut headers = HashMap::new();
        if let Some(api_key) = honeycomb_api_key {
            headers.insert("x-honeycomb-team".to_string(), api_key);
        }
        if let Some(dataset) = trimmed_env("FIELDWORK_RELAY_HONEYCOMB_DATASET") {
            headers.insert("x-honeycomb-dataset".to_string(), dataset);
        }

        Ok(Some(Self {
            endpoint: endpoint.unwrap_or_else(|| DEFAULT_HONEYCOMB_TRACES_ENDPOINT.to_string()),
            sample_rate: parse_sample_rate(trimmed_env("FIELDWORK_RELAY_OTLP_SAMPLE_RATE"))?,
            headers,
        }))
    }

    #[cfg(test)]
    fn for_test(
        endpoint: impl Into<String>,
        sample_rate: f64,
        headers: HashMap<String, String>,
    ) -> Self {
        Self {
            endpoint: endpoint.into(),
            sample_rate,
            headers,
        }
    }
}

impl fmt::Debug for TelemetryConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let mut header_names = self.headers.keys().collect::<Vec<_>>();
        header_names.sort();
        formatter
            .debug_struct("TelemetryConfig")
            .field("endpoint", &self.endpoint)
            .field("sample_rate", &self.sample_rate)
            .field("header_names", &header_names)
            .finish()
    }
}

fn parse_sample_rate(value: Option<String>) -> Result<f64> {
    let Some(value) = value else {
        return Ok(DEFAULT_SAMPLE_RATE);
    };
    let parsed = value
        .parse::<f64>()
        .with_context(|| format!("parse FIELDWORK_RELAY_OTLP_SAMPLE_RATE={value:?}"))?;
    if !parsed.is_finite() || !(0.0..=1.0).contains(&parsed) {
        bail!("FIELDWORK_RELAY_OTLP_SAMPLE_RATE must be between 0.0 and 1.0");
    }
    Ok(parsed)
}

fn honeycomb_api_key() -> Result<Option<String>> {
    if let Some(path) = trimmed_env("FIELDWORK_RELAY_HONEYCOMB_API_KEY_PATH") {
        return read_secret(Path::new(&path)).map(Some);
    }
    if let Some(path) = systemd_credential_path(HONEYCOMB_CREDENTIAL_NAME)
        && path.exists()
    {
        return read_secret(&path).map(Some);
    }
    Ok(None)
}

fn read_secret(path: &Path) -> Result<String> {
    let secret = std::fs::read_to_string(path)
        .with_context(|| format!("read Honeycomb API key from {}", path.display()))?;
    let secret = secret.trim().to_string();
    if secret.is_empty() {
        bail!("Honeycomb API key file {} is empty", path.display());
    }
    Ok(secret)
}

fn trimmed_env(name: &str) -> Option<String> {
    let value = std::env::var(name).ok()?;
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_string())
}

fn systemd_credential_path(name: &str) -> Option<PathBuf> {
    let mut path = PathBuf::from(std::env::var_os("CREDENTIALS_DIRECTORY")?);
    path.push(name);
    Some(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_sample_rate_matches_plan() {
        assert_eq!(parse_sample_rate(None).unwrap(), 0.01);
    }

    #[test]
    fn sample_rate_rejects_out_of_range_values() {
        assert!(parse_sample_rate(Some("-0.1".to_string())).is_err());
        assert!(parse_sample_rate(Some("1.1".to_string())).is_err());
        assert!(parse_sample_rate(Some("nan".to_string())).is_err());
    }

    #[test]
    fn telemetry_config_debug_redacts_header_values() {
        let config = TelemetryConfig::for_test(
            DEFAULT_HONEYCOMB_TRACES_ENDPOINT,
            0.01,
            HashMap::from([(
                "x-honeycomb-team".to_string(),
                "hcaik_live_secret".to_string(),
            )]),
        );

        let debug = format!("{config:?}");
        assert!(debug.contains("x-honeycomb-team"));
        assert!(!debug.contains("hcaik_live_secret"));
    }

    #[test]
    fn systemd_honeycomb_credential_name_is_stable() {
        assert_eq!(HONEYCOMB_CREDENTIAL_NAME, "honeycomb-api-key");
    }
}
