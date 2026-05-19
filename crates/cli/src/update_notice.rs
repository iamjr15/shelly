use crate::settings;
use anyhow::{Context, Result};
use semver::Version;
use serde::{Deserialize, Serialize};
use std::{
    future::Future,
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

const NPM_LATEST_URL: &str = "https://registry.npmjs.org/fieldwork/latest";
const CHECK_INTERVAL_MS: u64 = 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT: Duration = Duration::from_millis(750);

#[derive(Debug, Deserialize)]
struct NpmLatestResponse {
    version: String,
}

#[derive(Debug, Deserialize, Serialize)]
struct UpdateCache {
    checked_at_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    latest_version: Option<String>,
}

pub async fn maybe_print_update_notice() {
    if update_check_disabled() {
        return;
    }

    let path = default_cache_path();
    if let Ok(Some(notice)) = check_for_update(&path, env!("CARGO_PKG_VERSION"), now_ms()).await {
        eprintln!("{notice}");
    }
}

async fn check_for_update(
    path: &Path,
    current_version: &str,
    now_ms: u64,
) -> Result<Option<String>> {
    check_for_update_with(path, current_version, now_ms, fetch_latest_version).await
}

async fn check_for_update_with<F, Fut>(
    path: &Path,
    current_version: &str,
    now_ms: u64,
    fetch_latest: F,
) -> Result<Option<String>>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = Result<String>>,
{
    if let Some(cache) = read_cache(path)?
        && cache_is_fresh(&cache, now_ms)
    {
        return Ok(cache
            .latest_version
            .as_deref()
            .and_then(|latest| notice_for_latest(current_version, latest)));
    }

    let latest_version = fetch_latest().await.ok();
    write_cache(
        path,
        &UpdateCache {
            checked_at_ms: now_ms,
            latest_version: latest_version.clone(),
        },
    )?;

    Ok(latest_version
        .as_deref()
        .and_then(|latest| notice_for_latest(current_version, latest)))
}

async fn fetch_latest_version() -> Result<String> {
    let client = reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .user_agent(concat!("fieldwork/", env!("CARGO_PKG_VERSION")))
        .build()
        .context("build npm update-check client")?;
    let response = client
        .get(NPM_LATEST_URL)
        .send()
        .await
        .context("query npm registry")?
        .error_for_status()
        .context("npm registry returned an error")?
        .json::<NpmLatestResponse>()
        .await
        .context("decode npm latest metadata")?;
    Ok(response.version)
}

fn notice_for_latest(current_version: &str, latest_version: &str) -> Option<String> {
    let current = Version::parse(current_version).ok()?;
    let latest = Version::parse(latest_version).ok()?;
    if latest > current {
        Some(format!(
            "fieldwork {latest} available - run `npm update -g fieldwork`"
        ))
    } else {
        None
    }
}

fn cache_is_fresh(cache: &UpdateCache, now_ms: u64) -> bool {
    now_ms.saturating_sub(cache.checked_at_ms) < CHECK_INTERVAL_MS
}

fn read_cache(path: &Path) -> Result<Option<UpdateCache>> {
    let contents = match std::fs::read_to_string(path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error).with_context(|| format!("read {}", path.display())),
    };
    Ok(serde_json::from_str(&contents).ok())
}

fn write_cache(path: &Path, cache: &UpdateCache) -> Result<()> {
    let parent = path
        .parent()
        .with_context(|| format!("update cache path has no parent: {}", path.display()))?;
    settings::prepare_config_dir(parent)?;
    let encoded = serde_json::to_vec_pretty(cache).context("encode update-check cache")?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, encoded).with_context(|| format!("write {}", tmp.display()))?;
    settings::set_private_file_permissions(&tmp)?;
    std::fs::rename(&tmp, path)
        .with_context(|| format!("replace update-check cache {}", path.display()))?;
    Ok(())
}

fn default_cache_path() -> PathBuf {
    settings::default_config_dir().join("update-check.json")
}

fn update_check_disabled() -> bool {
    std::env::var("FIELDWORK_DISABLE_UPDATE_CHECK")
        .ok()
        .is_some_and(|value| matches!(value.as_str(), "1" | "true" | "TRUE" | "yes" | "YES"))
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;
    use std::sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    };

    #[test]
    fn newer_version_formats_notice() {
        assert_eq!(
            notice_for_latest("0.1.0", "0.2.0").as_deref(),
            Some("fieldwork 0.2.0 available - run `npm update -g fieldwork`")
        );
    }

    #[test]
    fn equal_older_or_invalid_versions_do_not_notice() {
        assert_eq!(notice_for_latest("0.2.0", "0.2.0"), None);
        assert_eq!(notice_for_latest("0.2.0", "0.1.9"), None);
        assert_eq!(notice_for_latest("0.2.0", "not-semver"), None);
    }

    #[tokio::test]
    async fn fresh_cache_uses_cached_latest_without_fetching() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("fieldwork").join("update-check.json");
        write_cache(
            &path,
            &UpdateCache {
                checked_at_ms: 10_000,
                latest_version: Some("0.3.0".to_string()),
            },
        )
        .unwrap();
        let fetched = Arc::new(AtomicBool::new(false));
        let fetched_for_closure = fetched.clone();

        let notice = check_for_update_with(&path, "0.2.0", 10_001, move || async move {
            fetched_for_closure.store(true, Ordering::Relaxed);
            Ok("0.4.0".to_string())
        })
        .await
        .unwrap();

        assert_eq!(
            notice.as_deref(),
            Some("fieldwork 0.3.0 available - run `npm update -g fieldwork`")
        );
        assert!(!fetched.load(Ordering::Relaxed));
    }

    #[tokio::test]
    async fn stale_cache_fetches_and_writes_private_cache() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("fieldwork").join("update-check.json");
        let notice = check_for_update_with(&path, "0.2.0", CHECK_INTERVAL_MS + 1, || async {
            Ok("0.4.0".to_string())
        })
        .await
        .unwrap();

        assert_eq!(
            notice.as_deref(),
            Some("fieldwork 0.4.0 available - run `npm update -g fieldwork`")
        );
        let cache = read_cache(&path).unwrap().unwrap();
        assert_eq!(cache.checked_at_ms, CHECK_INTERVAL_MS + 1);
        assert_eq!(cache.latest_version.as_deref(), Some("0.4.0"));

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

    #[tokio::test]
    async fn fetch_failure_is_cached_without_notice() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("fieldwork").join("update-check.json");
        let notice =
            check_for_update_with(&path, "0.2.0", 42, || async { anyhow::bail!("offline") })
                .await
                .unwrap();

        assert_eq!(notice, None);
        let cache = read_cache(&path).unwrap().unwrap();
        assert_eq!(cache.checked_at_ms, 42);
        assert_eq!(cache.latest_version, None);
    }
}
