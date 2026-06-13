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
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TelemetryStatus {
    pub path: PathBuf,
    pub opt_in: bool,
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

pub fn set_telemetry(enabled: bool) -> Result<TelemetryStatus> {
    let path = default_config_path();
    set_telemetry_at_path(&path, enabled)
}

pub fn scrollback_encryption_status() -> Result<ScrollbackEncryptionStatus> {
    let path = default_config_path();
    scrollback_encryption_status_at_path(&path)
}

pub fn scrollback_encryption_env_override() -> Result<Option<bool>> {
    env_var("FIELDWORK_SCROLLBACK_ENCRYPTION_ENABLED")
        .map(|value| parse_bool_with_name(&value, "FIELDWORK_SCROLLBACK_ENCRYPTION_ENABLED"))
        .transpose()
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

fn set_telemetry_at_path(path: &Path, enabled: bool) -> Result<TelemetryStatus> {
    let mut config = read_config(path)?;
    config.telemetry.opt_in = enabled;

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

fn env_var(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .filter(|value| !value.trim().is_empty())
}

fn parse_bool_with_name(value: &str, name: &str) -> Result<bool> {
    match value.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => Ok(true),
        "0" | "false" | "no" | "off" => Ok(false),
        other => bail!("invalid boolean value for {name}: {other}"),
    }
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
        env_var, parse_bool_with_name, scrollback_encryption_status_at_path,
        set_scrollback_encryption_at_path, set_telemetry_at_path, telemetry_status_at_path,
    };
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn env_var_treats_empty_and_whitespace_values_as_unset() {
        let name = "FIELDWORK_TEST_EMPTY_ENV";
        unsafe {
            std::env::set_var(name, "");
        }
        assert_eq!(env_var(name), None);

        unsafe {
            std::env::set_var(name, "   ");
        }
        assert_eq!(env_var(name), None);

        unsafe {
            std::env::set_var(name, "true");
        }
        assert_eq!(env_var(name).as_deref(), Some("true"));

        unsafe {
            std::env::remove_var(name);
        }
    }

    #[test]
    fn scrollback_env_override_bool_parser_accepts_expected_values() {
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
    fn telemetry_on_writes_private_config() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("fieldwork").join("config.toml");

        let status = set_telemetry_at_path(&path, true).unwrap();

        assert!(status.opt_in);
        assert_eq!(status.path, path);
        let contents = std::fs::read_to_string(&path).unwrap();
        assert!(contents.contains("opt_in = true"));

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
    fn telemetry_off_preserves_existing_config_sections() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("config.toml");
        std::fs::write(
            &path,
            r#"
[telemetry]
opt_in = true

[scrollback_encryption]
enabled = false
"#,
        )
        .unwrap();

        let status = set_telemetry_at_path(&path, false).unwrap();

        assert!(!status.opt_in);
        let read_back = telemetry_status_at_path(&path).unwrap();
        assert_eq!(read_back, status);
        assert!(
            std::fs::read_to_string(&path)
                .unwrap()
                .contains("enabled = false")
        );
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
