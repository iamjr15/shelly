use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use std::fs;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
struct UserConfig {
    #[serde(skip_serializing_if = "Option::is_none")]
    log_dir: Option<PathBuf>,
    #[serde(default)]
    scrollback_encryption: ScrollbackEncryptionConfig,
    #[serde(default)]
    telemetry: TelemetryConfig,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
struct ScrollbackEncryptionConfig {
    #[serde(default = "default_true")]
    enabled: bool,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
struct TelemetryConfig {
    #[serde(default)]
    opt_in: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    sentry_dsn: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TelemetryStatus {
    pub path: PathBuf,
    pub opt_in: bool,
    pub sentry_dsn_configured: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScrollbackEncryptionStatus {
    pub path: PathBuf,
    pub enabled: bool,
}

impl Default for ScrollbackEncryptionConfig {
    fn default() -> Self {
        Self { enabled: true }
    }
}

pub fn telemetry_status() -> Result<TelemetryStatus> {
    let path = default_config_path();
    telemetry_status_at_path(&path)
}

pub fn set_telemetry(enabled: bool, sentry_dsn: Option<String>) -> Result<TelemetryStatus> {
    let path = default_config_path();
    set_telemetry_at_path(&path, enabled, sentry_dsn)
}

pub fn scrollback_encryption_status() -> Result<ScrollbackEncryptionStatus> {
    let path = default_config_path();
    scrollback_encryption_status_at_path(&path)
}

pub fn set_scrollback_encryption(enabled: bool) -> Result<ScrollbackEncryptionStatus> {
    let path = default_config_path();
    set_scrollback_encryption_at_path(&path, enabled)
}

fn telemetry_status_at_path(path: &Path) -> Result<TelemetryStatus> {
    let config = read_config(path)?;
    Ok(status_from_config(path, &config))
}

fn scrollback_encryption_status_at_path(path: &Path) -> Result<ScrollbackEncryptionStatus> {
    let config = read_config(path)?;
    Ok(scrollback_encryption_status_from_config(path, &config))
}

fn set_telemetry_at_path(
    path: &Path,
    enabled: bool,
    sentry_dsn: Option<String>,
) -> Result<TelemetryStatus> {
    let mut config = read_config(path)?;
    config.telemetry.opt_in = enabled;

    if let Some(sentry_dsn) = sentry_dsn {
        let sentry_dsn = sentry_dsn.trim().to_string();
        if sentry_dsn.is_empty() {
            bail!("--sentry-dsn cannot be empty");
        }
        config.telemetry.sentry_dsn = Some(sentry_dsn);
    }

    write_config(path, &config)?;
    Ok(status_from_config(path, &config))
}

fn set_scrollback_encryption_at_path(
    path: &Path,
    enabled: bool,
) -> Result<ScrollbackEncryptionStatus> {
    let mut config = read_config(path)?;
    config.scrollback_encryption.enabled = enabled;
    write_config(path, &config)?;
    Ok(scrollback_encryption_status_from_config(path, &config))
}

fn status_from_config(path: &Path, config: &UserConfig) -> TelemetryStatus {
    TelemetryStatus {
        path: path.to_path_buf(),
        opt_in: config.telemetry.opt_in,
        sentry_dsn_configured: config
            .telemetry
            .sentry_dsn
            .as_deref()
            .is_some_and(|value| !value.trim().is_empty()),
    }
}

fn scrollback_encryption_status_from_config(
    path: &Path,
    config: &UserConfig,
) -> ScrollbackEncryptionStatus {
    ScrollbackEncryptionStatus {
        path: path.to_path_buf(),
        enabled: config.scrollback_encryption.enabled,
    }
}

fn read_config(path: &Path) -> Result<UserConfig> {
    if !path.exists() {
        return Ok(UserConfig::default());
    }

    let contents = fs::read_to_string(path)
        .with_context(|| format!("read settings file {}", path.display()))?;
    toml::from_str(&contents).with_context(|| format!("parse settings file {}", path.display()))
}

fn write_config(path: &Path, config: &UserConfig) -> Result<()> {
    let parent = path
        .parent()
        .with_context(|| format!("settings path has no parent: {}", path.display()))?;
    prepare_config_dir(parent)?;

    let encoded = toml::to_string_pretty(config).context("encode settings as TOML")?;
    let tmp = path.with_extension("toml.tmp");
    fs::write(&tmp, encoded).with_context(|| format!("write {}", tmp.display()))?;
    set_private_file_permissions(&tmp)?;
    fs::rename(&tmp, path).with_context(|| format!("replace settings file {}", path.display()))?;
    Ok(())
}

pub(crate) fn prepare_config_dir(path: &Path) -> Result<()> {
    if path.exists() {
        let meta = fs::symlink_metadata(path).context("stat settings directory")?;
        if meta.file_type().is_symlink() {
            bail!(
                "refusing to use symlinked settings directory: {}",
                path.display()
            );
        }
    }

    fs::create_dir_all(path).with_context(|| format!("create {}", path.display()))?;

    #[cfg(unix)]
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
        .with_context(|| format!("chmod {}", path.display()))?;

    Ok(())
}

#[cfg(unix)]
pub(crate) fn set_private_file_permissions(path: &Path) -> Result<()> {
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .with_context(|| format!("chmod {}", path.display()))
}

#[cfg(not(unix))]
pub(crate) fn set_private_file_permissions(_path: &Path) -> Result<()> {
    Ok(())
}

pub(crate) fn default_config_dir() -> PathBuf {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);

    if cfg!(target_os = "macos") {
        return home
            .join("Library")
            .join("Application Support")
            .join("app.fieldwork");
    }

    if let Some(config_home) = std::env::var_os("XDG_CONFIG_HOME") {
        return PathBuf::from(config_home).join("fieldwork");
    }

    home.join(".config").join("fieldwork")
}

fn default_config_path() -> PathBuf {
    default_config_dir().join("config.toml")
}

fn default_true() -> bool {
    true
}

#[cfg(test)]
mod tests {
    use super::{
        scrollback_encryption_status_at_path, set_scrollback_encryption_at_path,
        set_telemetry_at_path, telemetry_status_at_path,
    };
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn telemetry_on_writes_private_config_with_optional_sentry_dsn() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("fieldwork").join("config.toml");

        let status = set_telemetry_at_path(
            &path,
            true,
            Some("https://public@example.invalid/1".to_string()),
        )
        .unwrap();

        assert!(status.opt_in);
        assert!(status.sentry_dsn_configured);
        assert_eq!(status.path, path);
        let contents = std::fs::read_to_string(&path).unwrap();
        assert!(contents.contains("opt_in = true"));
        assert!(contents.contains("sentry_dsn = \"https://public@example.invalid/1\""));

        #[cfg(unix)]
        {
            let file_mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            let dir_mode = std::fs::metadata(path.parent().unwrap())
                .unwrap()
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(file_mode, 0o600);
            assert_eq!(dir_mode, 0o700);
        }
    }

    #[test]
    fn telemetry_off_preserves_existing_sentry_dsn() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("config.toml");
        std::fs::write(
            &path,
            r#"
[telemetry]
opt_in = true
sentry_dsn = "https://public@example.invalid/1"
"#,
        )
        .unwrap();

        let status = set_telemetry_at_path(&path, false, None).unwrap();

        assert!(!status.opt_in);
        assert!(status.sentry_dsn_configured);
        let read_back = telemetry_status_at_path(&path).unwrap();
        assert_eq!(read_back, status);
    }

    #[test]
    fn scrollback_encryption_defaults_on_and_can_be_disabled() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("config.toml");

        let default_status = scrollback_encryption_status_at_path(&path).unwrap();
        assert!(default_status.enabled);

        let disabled = set_scrollback_encryption_at_path(&path, false).unwrap();

        assert!(!disabled.enabled);
        let contents = std::fs::read_to_string(&path).unwrap();
        assert!(contents.contains("[scrollback_encryption]"));
        assert!(contents.contains("enabled = false"));
    }
}
