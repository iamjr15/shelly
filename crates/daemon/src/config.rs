use anyhow::{Context, Result, bail};
use figment::{Figment, providers::Env};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct Config {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub log_dir: Option<PathBuf>,
    #[serde(default)]
    pub scrollback_encryption: ScrollbackEncryptionConfig,
    #[serde(default)]
    pub telemetry: TelemetryConfig,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ScrollbackEncryptionConfig {
    #[serde(default = "default_true")]
    pub enabled: bool,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct TelemetryConfig {
    #[serde(default)]
    pub opt_in: bool,
}

#[derive(Debug, Clone, Default, Deserialize)]
struct EnvConfig {
    log_dir: Option<PathBuf>,
}

impl Default for ScrollbackEncryptionConfig {
    fn default() -> Self {
        Self { enabled: true }
    }
}

impl Config {
    pub fn load() -> Result<Self> {
        Self::load_from_path(&default_config_path())
    }

    pub(crate) fn load_from_path(path: &Path) -> Result<Self> {
        let mut config = read_config_file(path)?;
        apply_env_overrides(&mut config)?;
        Ok(config)
    }
}

fn apply_env_overrides(config: &mut Config) -> Result<()> {
    let env_config: EnvConfig = Figment::new()
        .merge(Env::prefixed("FIELDWORK_"))
        .extract()
        .context("load daemon config from environment")?;
    if let Some(log_dir) = env_config.log_dir {
        config.log_dir = Some(log_dir);
    }

    if let Some(value) = env_var("FIELDWORK_TELEMETRY_OPT_IN") {
        config.telemetry.opt_in = parse_bool(&value)?;
    }

    if let Some(value) = env_var("FIELDWORK_SCROLLBACK_ENCRYPTION_ENABLED") {
        config.scrollback_encryption.enabled =
            parse_bool_with_name(&value, "FIELDWORK_SCROLLBACK_ENCRYPTION_ENABLED")?;
    }

    Ok(())
}

fn read_config_file(path: &Path) -> Result<Config> {
    if !path.exists() {
        return Ok(Config::default());
    }

    let contents = std::fs::read_to_string(path)
        .with_context(|| format!("read daemon config {}", path.display()))?;
    toml::from_str(&contents).with_context(|| format!("parse daemon config {}", path.display()))
}

fn env_var(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .filter(|value| !value.trim().is_empty())
}

fn parse_bool(value: &str) -> Result<bool> {
    parse_bool_with_name(value, "FIELDWORK_TELEMETRY_OPT_IN")
}

fn parse_bool_with_name(value: &str, name: &str) -> Result<bool> {
    match value.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => Ok(true),
        "0" | "false" | "no" | "off" => Ok(false),
        other => bail!("invalid boolean value for {name}: {other}"),
    }
}

fn default_true() -> bool {
    true
}

fn default_config_path() -> PathBuf {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);

    if cfg!(target_os = "macos") {
        return home
            .join("Library")
            .join("Application Support")
            .join("app.fieldwork")
            .join("config.toml");
    }

    if let Some(config_home) = std::env::var_os("XDG_CONFIG_HOME") {
        return PathBuf::from(config_home)
            .join("fieldwork")
            .join("config.toml");
    }

    home.join(".config").join("fieldwork").join("config.toml")
}

#[cfg(test)]
mod tests {
    use super::{env_var, parse_bool_with_name, read_config_file};

    #[test]
    fn env_var_treats_empty_and_whitespace_values_as_unset() {
        let name = "FIELDWORK_DAEMON_TEST_EMPTY_ENV";
        unsafe {
            std::env::set_var(name, "");
        }
        assert_eq!(env_var(name), None);

        unsafe {
            std::env::set_var(name, "   ");
        }
        assert_eq!(env_var(name), None);

        unsafe {
            std::env::set_var(name, "false");
        }
        assert_eq!(env_var(name).as_deref(), Some("false"));

        unsafe {
            std::env::remove_var(name);
        }
    }

    #[test]
    fn env_override_bool_parser_accepts_expected_values() {
        for value in ["1", "true", "TRUE", "yes", "on", " On "] {
            assert!(parse_bool_with_name(value, "TEST").unwrap());
        }

        for value in ["0", "false", "FALSE", "no", "off", " Off "] {
            assert!(!parse_bool_with_name(value, "TEST").unwrap());
        }

        let error = parse_bool_with_name("maybe", "FIELDWORK_SCROLLBACK_ENCRYPTION_ENABLED")
            .unwrap_err()
            .to_string();
        assert!(error.contains("FIELDWORK_SCROLLBACK_ENCRYPTION_ENABLED"));
        assert!(error.contains("maybe"));
    }

    #[test]
    fn loads_toml_config_file() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("config.toml");
        std::fs::write(
            &path,
            r#"
log_dir = "/tmp/fieldwork-logs"

[telemetry]
opt_in = true

[scrollback_encryption]
enabled = false
"#,
        )
        .unwrap();

        let config = read_config_file(&path).unwrap();

        assert_eq!(
            config.log_dir.unwrap(),
            std::path::PathBuf::from("/tmp/fieldwork-logs")
        );
        assert!(config.telemetry.opt_in);
        assert!(!config.scrollback_encryption.enabled);
    }
}
