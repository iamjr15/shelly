use anyhow::{Context, Result, bail};
use service_manager::{
    RestartPolicy, ServiceInstallCtx, ServiceLabel, ServiceManager, ServiceStartCtx, ServiceStatus,
    ServiceStatusCtx, ServiceStopCtx, ServiceUninstallCtx,
};
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::str::FromStr;

const SERVICE_LABEL: &str = "app.shelly.daemon";

pub fn install() -> Result<()> {
    let manager = user_service_manager()?;
    install_with_manager(manager.as_ref(), install_ctx()?)
}

fn install_with_manager(manager: &dyn ServiceManager, ctx: ServiceInstallCtx) -> Result<()> {
    manager
        .install(ctx)
        .context("install shellyd user service")?;
    if let Err(error) = manager.start(start_ctx()) {
        let _ = manager.uninstall(uninstall_ctx());
        return Err(error).context("start shellyd user service");
    }
    Ok(())
}

pub fn uninstall() -> Result<()> {
    let manager = user_service_manager()?;
    let _ = manager.stop(stop_ctx());
    manager
        .uninstall(uninstall_ctx())
        .context("uninstall shellyd user service")?;
    Ok(())
}

pub fn restart() -> Result<()> {
    let manager = user_service_manager()?;
    let daemon = daemon_path()?;
    ensure_service_launch_allowed(&daemon)?;
    let _ = manager.stop(stop_ctx());
    manager
        .start(start_ctx())
        .context("start shellyd user service")?;
    Ok(())
}

pub fn status() -> Result<ServiceStatus> {
    user_service_manager()?
        .status(status_ctx())
        .context("query shellyd user service")
}

fn user_service_manager() -> Result<Box<dyn ServiceManager>> {
    #[cfg(target_os = "macos")]
    {
        Ok(Box::new(service_manager::LaunchdServiceManager::user()))
    }

    #[cfg(target_os = "linux")]
    {
        Ok(Box::new(service_manager::SystemdServiceManager::user()))
    }

    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        bail!("shellyd service install is supported on macOS and Linux only in v1")
    }
}

fn install_ctx() -> Result<ServiceInstallCtx> {
    let daemon = daemon_path()?;
    ensure_service_launch_allowed(&daemon)?;
    install_ctx_for(daemon)
}

fn install_ctx_for(program: PathBuf) -> Result<ServiceInstallCtx> {
    let restart_policy = RestartPolicy::OnFailure {
        delay_secs: Some(5),
        max_retries: None,
        reset_after_secs: None,
    };
    let environment = service_environment();
    #[cfg(target_os = "macos")]
    let contents = Some(launchd_plist(&program, environment.as_deref()));
    #[cfg(not(target_os = "macos"))]
    let contents = None;

    Ok(ServiceInstallCtx {
        label: label()?,
        program,
        args: Vec::<OsString>::new(),
        contents,
        username: None,
        working_directory: None,
        environment,
        autostart: true,
        restart_policy,
    })
}

/// Hosted Shelly iroh relay used as the daemon's default rendezvous when the
/// operator does not set `SHELLY_IROH_RELAY_URL`. Self-hosters override it by
/// exporting `SHELLY_IROH_RELAY_URL` before running `shelly daemon install`.
const DEFAULT_IROH_RELAY_URL: &str = "https://relay.shelly.sh";

fn service_environment() -> Option<Vec<(String, String)>> {
    const PASSTHROUGH: &[&str] = &[
        "HOME",
        "PATH",
        "SHELL",
        "XDG_RUNTIME_DIR",
        "XDG_CONFIG_HOME",
        "XDG_STATE_HOME",
        "SHELLY_LOG_DIR",
        "SHELLY_RELAY_CONTROL_URL",
        "SHELLY_IROH_RELAY_URL",
        "SHELLY_SCROLLBACK_ENCRYPTION_ENABLED",
        "SHELLY_TELEMETRY_OPT_IN",
    ];

    let mut values = PASSTHROUGH
        .iter()
        .filter_map(|key| {
            std::env::var(key)
                .ok()
                .filter(|value| !value.is_empty())
                .map(|value| ((*key).to_string(), value))
        })
        .collect::<Vec<_>>();

    // Bake in the hosted relay so installed daemons reconnect by NodeID out of the
    // box; an operator-provided SHELLY_IROH_RELAY_URL (already collected above) wins.
    if !values.iter().any(|(key, _)| key == "SHELLY_IROH_RELAY_URL") {
        values.push((
            "SHELLY_IROH_RELAY_URL".to_string(),
            DEFAULT_IROH_RELAY_URL.to_string(),
        ));
    }

    if values.is_empty() {
        None
    } else {
        Some(values)
    }
}

#[cfg(target_os = "macos")]
fn launchd_plist(program: &Path, environment: Option<&[(String, String)]>) -> String {
    let mut plist = String::from(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>app.shelly.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>"#,
    );
    plist.push_str(&xml_escape(&program.display().to_string()));
    plist.push_str(
        r#"</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>Disabled</key>
  <true/>
  <key>LimitLoadToSessionType</key>
  <string>Aqua</string>
"#,
    );
    if let Some(environment) = environment {
        plist.push_str("  <key>EnvironmentVariables</key>\n  <dict>\n");
        for (key, value) in environment {
            plist.push_str("    <key>");
            plist.push_str(&xml_escape(key));
            plist.push_str("</key>\n    <string>");
            plist.push_str(&xml_escape(value));
            plist.push_str("</string>\n");
        }
        plist.push_str("  </dict>\n");
    }
    plist.push_str("</dict>\n</plist>\n");
    plist
}

#[cfg(target_os = "macos")]
fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn uninstall_ctx() -> ServiceUninstallCtx {
    ServiceUninstallCtx {
        label: label().expect("static service label is valid"),
    }
}

fn start_ctx() -> ServiceStartCtx {
    ServiceStartCtx {
        label: label().expect("static service label is valid"),
    }
}

fn stop_ctx() -> ServiceStopCtx {
    ServiceStopCtx {
        label: label().expect("static service label is valid"),
    }
}

fn status_ctx() -> ServiceStatusCtx {
    ServiceStatusCtx {
        label: label().expect("static service label is valid"),
    }
}

fn label() -> Result<ServiceLabel> {
    ServiceLabel::from_str(SERVICE_LABEL).context("parse service label")
}

pub fn daemon_path() -> Result<PathBuf> {
    let cli_path = std::env::current_exe().context("resolve current executable")?;
    daemon_path_from_cli_path(&cli_path)
}

fn daemon_path_from_cli_path(cli_path: &Path) -> Result<PathBuf> {
    let daemon = cli_path
        .parent()
        .context("shelly binary has no parent directory")?
        .join("shellyd");
    if !daemon.exists() {
        bail!("shellyd not found next to shelly at {}", daemon.display());
    }
    if !daemon.is_file() {
        bail!(
            "shellyd path next to shelly is not a file: {}",
            daemon.display()
        );
    }
    ensure_executable(&daemon)?;
    Ok(daemon)
}

#[cfg(unix)]
fn ensure_executable(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;

    let mode = std::fs::metadata(path)
        .with_context(|| format!("stat shellyd at {}", path.display()))?
        .permissions()
        .mode();
    if mode & 0o111 == 0 {
        bail!(
            "shellyd next to shelly is not executable: {}",
            path.display()
        );
    }
    Ok(())
}

#[cfg(not(unix))]
fn ensure_executable(_path: &Path) -> Result<()> {
    Ok(())
}

#[cfg(target_os = "macos")]
fn ensure_service_launch_allowed(path: &Path) -> Result<()> {
    use std::process::Command;

    let signature = Command::new("codesign")
        .args(["--verify", "--verbose=2"])
        .arg(path)
        .output()
        .with_context(|| format!("verify macOS code signature for {}", path.display()))?;

    if !signature.status.success() {
        let detail = command_output_detail(&signature, "codesign");
        bail!(
            "macOS launchd preflight rejected shellyd: code signature verification failed for {}\n\
             Install the npm Shelly package or repair the local binary with `codesign --force --sign - {}` \
             after verifying its origin, then rerun `shelly daemon install`.\n\
             codesign output: {detail}",
            path.display(),
            path.display(),
        );
    }

    let quarantine = Command::new("xattr")
        .args(["-p", "com.apple.quarantine"])
        .arg(path)
        .output()
        .with_context(|| format!("read macOS quarantine xattr for {}", path.display()))?;

    if quarantine.status.success() {
        let value = String::from_utf8_lossy(&quarantine.stdout)
            .trim()
            .to_string();
        if !value.is_empty() {
            bail!(
                "macOS launchd preflight rejected shellyd: {} has com.apple.quarantine set.\n\
                 Install through npm or remove quarantine only from this verified Shelly binary with \
                 `xattr -d com.apple.quarantine {}`.\n\
                 quarantine xattr: {value}",
                path.display(),
                path.display(),
            );
        }
    }

    Ok(())
}

#[cfg(target_os = "macos")]
fn command_output_detail(output: &std::process::Output, command: &str) -> String {
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    match (stdout.is_empty(), stderr.is_empty()) {
        (true, true) => format!("{command} exited with {}", output.status),
        (false, true) => stdout,
        (true, false) => stderr,
        (false, false) => format!("{stdout}\n{stderr}"),
    }
}

#[cfg(not(target_os = "macos"))]
fn ensure_service_launch_allowed(_path: &Path) -> Result<()> {
    Ok(())
}

pub fn format_status(status: &ServiceStatus) -> String {
    match status {
        ServiceStatus::NotInstalled => "not installed".to_string(),
        ServiceStatus::Running => "running".to_string(),
        ServiceStatus::Stopped(Some(reason)) => format!("stopped ({reason})"),
        ServiceStatus::Stopped(None) => "stopped".to_string(),
    }
}

#[cfg(test)]
mod tests {
    #[cfg(target_os = "macos")]
    use super::ensure_service_launch_allowed;
    use super::{
        SERVICE_LABEL, daemon_path_from_cli_path, format_status, install_ctx_for, start_ctx,
        status_ctx, stop_ctx, uninstall_ctx,
    };
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    use service_manager::ServiceManager;
    use service_manager::{
        RestartPolicy, ServiceInstallCtx, ServiceLevel, ServiceStartCtx, ServiceStatus,
        ServiceStatusCtx, ServiceStopCtx, ServiceUninstallCtx,
    };
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    use std::env;
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    use std::ffi::OsString;
    use std::fs;
    use std::io;
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;
    use std::path::Path;
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    use std::sync::{Mutex, OnceLock};

    #[test]
    fn formats_service_status() {
        assert_eq!(format_status(&ServiceStatus::NotInstalled), "not installed");
        assert_eq!(format_status(&ServiceStatus::Running), "running");
        assert_eq!(format_status(&ServiceStatus::Stopped(None)), "stopped");
    }

    #[test]
    fn builds_hardened_user_service_install_context() {
        let temp = tempfile::tempdir().unwrap();
        let daemon = temp.path().join("shellyd");
        fs::write(&daemon, b"daemon").unwrap();
        make_executable(&daemon);

        let ctx = install_ctx_for(daemon.clone()).unwrap();

        assert_eq!(ctx.label.to_string(), SERVICE_LABEL);
        assert_eq!(ctx.program, daemon);
        assert!(ctx.args.is_empty());
        #[cfg(target_os = "macos")]
        assert!(ctx.contents.is_some());
        #[cfg(not(target_os = "macos"))]
        assert!(ctx.contents.is_none());
        assert!(ctx.username.is_none());
        assert!(ctx.working_directory.is_none());
        assert!(ctx.environment.is_some());
        assert!(ctx.autostart);
        match ctx.restart_policy {
            RestartPolicy::OnFailure {
                delay_secs,
                max_retries,
                reset_after_secs,
            } => {
                assert_eq!(delay_secs, Some(5));
                assert_eq!(max_retries, None);
                assert_eq!(reset_after_secs, None);
            }
            other => panic!("unexpected restart policy: {other:?}"),
        }
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn service_install_environment_persists_non_secret_runtime_context() {
        let _guard = env_lock();
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("home");
        let runtime = temp.path().join("runtime");
        let config = temp.path().join("config");
        let state = temp.path().join("state");
        fs::create_dir(&home).unwrap();
        fs::create_dir(&runtime).unwrap();
        fs::create_dir(&config).unwrap();
        fs::create_dir(&state).unwrap();
        let _env = EnvOverride::new(&[
            ("HOME", home.as_os_str().to_os_string()),
            ("PATH", OsString::from("/opt/shelly-test/bin:/usr/bin")),
            ("XDG_RUNTIME_DIR", runtime.as_os_str().to_os_string()),
            ("XDG_CONFIG_HOME", config.as_os_str().to_os_string()),
            ("XDG_STATE_HOME", state.as_os_str().to_os_string()),
            (
                "SHELLY_SCROLLBACK_ENCRYPTION_ENABLED",
                OsString::from("false"),
            ),
            (
                "SHELLY_IROH_SECRET_KEY_B64",
                OsString::from("secret-must-not-be-persisted"),
            ),
            (
                "SHELLY_RELAY_SIGNING_KEY_B64",
                OsString::from("secret-must-not-be-persisted"),
            ),
        ]);

        let ctx = install_ctx_for(temp.path().join("shellyd")).unwrap();
        let environment = ctx.environment.expect("service env should be captured");

        assert!(environment.contains(&("HOME".to_string(), home.display().to_string())));
        assert!(environment.contains(&(
            "PATH".to_string(),
            "/opt/shelly-test/bin:/usr/bin".to_string()
        )));
        assert!(
            environment.contains(&("XDG_RUNTIME_DIR".to_string(), runtime.display().to_string()))
        );
        assert!(
            environment.contains(&("XDG_CONFIG_HOME".to_string(), config.display().to_string()))
        );
        assert!(environment.contains(&("XDG_STATE_HOME".to_string(), state.display().to_string())));
        assert!(environment.contains(&(
            "SHELLY_SCROLLBACK_ENCRYPTION_ENABLED".to_string(),
            "false".to_string()
        )));
        assert!(
            environment
                .iter()
                .all(|(key, _)| !key.contains("SECRET") && !key.contains("SIGNING_KEY"))
        );
    }

    #[test]
    fn service_lifecycle_contexts_share_stable_label() {
        assert_eq!(start_ctx().label.to_string(), SERVICE_LABEL);
        assert_eq!(stop_ctx().label.to_string(), SERVICE_LABEL);
        assert_eq!(status_ctx().label.to_string(), SERVICE_LABEL);
        assert_eq!(uninstall_ctx().label.to_string(), SERVICE_LABEL);
    }

    #[test]
    fn rolls_back_service_install_when_start_fails() {
        let temp = tempfile::tempdir().unwrap();
        let daemon = temp.path().join("shellyd");
        fs::write(&daemon, b"daemon").unwrap();
        make_executable(&daemon);
        let manager = FakeServiceManager::fail_start();

        let error = super::install_with_manager(&manager, install_ctx_for(daemon).unwrap())
            .expect_err("start failure should fail install");

        assert!(error.to_string().contains("start shellyd user service"));
        assert_eq!(
            manager.calls(),
            [
                "install:app.shelly.daemon",
                "start:app.shelly.daemon",
                "uninstall:app.shelly.daemon"
            ]
        );
    }

    #[test]
    fn resolves_daemon_path_next_to_cli_binary() {
        let temp = tempfile::tempdir().unwrap();
        let bin = temp.path().join("bin");
        fs::create_dir(&bin).unwrap();
        let daemon = bin.join("shellyd");
        fs::write(&daemon, b"daemon").unwrap();
        make_executable(&daemon);

        let resolved = daemon_path_from_cli_path(&bin.join("shelly")).unwrap();

        assert_eq!(resolved, daemon);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn rejects_service_install_when_colocated_daemon_fails_macos_signature_check() {
        let _tools = FakeMacTrustTools::new(false, false);
        let temp = tempfile::tempdir().unwrap();
        let daemon = temp.path().join("shellyd");
        fs::write(&daemon, b"daemon").unwrap();
        make_executable(&daemon);

        let error = ensure_service_launch_allowed(&daemon).unwrap_err();

        let message = error.to_string();
        assert!(message.contains("macOS launchd preflight rejected shellyd"));
        assert!(message.contains("codesign --force --sign -"));
        assert!(message.contains("codesign output: shellyd: code object is not signed"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn rejects_service_install_when_colocated_daemon_is_quarantined() {
        let _tools = FakeMacTrustTools::new(true, true);
        let temp = tempfile::tempdir().unwrap();
        let daemon = temp.path().join("shellyd");
        fs::write(&daemon, b"daemon").unwrap();
        make_executable(&daemon);

        let error = ensure_service_launch_allowed(&daemon).unwrap_err();

        let message = error.to_string();
        assert!(message.contains("has com.apple.quarantine set"));
        assert!(message.contains("xattr -d com.apple.quarantine"));
    }

    #[test]
    fn rejects_service_install_when_colocated_daemon_is_absent() {
        let temp = tempfile::tempdir().unwrap();
        let cli = temp.path().join("shelly");

        let error = daemon_path_from_cli_path(&cli).unwrap_err();

        assert!(
            error
                .to_string()
                .contains("shellyd not found next to shelly")
        );
    }

    #[test]
    fn rejects_service_install_when_colocated_daemon_is_not_a_file() {
        let temp = tempfile::tempdir().unwrap();
        let bin = temp.path().join("bin");
        fs::create_dir(&bin).unwrap();
        fs::create_dir(bin.join("shellyd")).unwrap();

        let error = daemon_path_from_cli_path(&bin.join("shelly")).unwrap_err();

        assert!(
            error
                .to_string()
                .contains("shellyd path next to shelly is not a file")
        );
    }

    #[cfg(unix)]
    #[test]
    fn rejects_service_install_when_colocated_daemon_is_not_executable() {
        let temp = tempfile::tempdir().unwrap();
        let bin = temp.path().join("bin");
        fs::create_dir(&bin).unwrap();
        let daemon = bin.join("shellyd");
        fs::write(&daemon, b"daemon").unwrap();
        fs::set_permissions(&daemon, fs::Permissions::from_mode(0o600)).unwrap();

        let error = daemon_path_from_cli_path(&bin.join("shelly")).unwrap_err();

        assert!(
            error
                .to_string()
                .contains("shellyd next to shelly is not executable")
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn launchd_user_install_writes_keepalive_plist() {
        let _guard = env_lock();
        let temp = tempfile::tempdir().unwrap();
        let fake_bin = temp.path().join("bin");
        let home = temp.path().join("home");
        let runtime = temp.path().join("runtime");
        fs::create_dir(&fake_bin).unwrap();
        fs::create_dir(&home).unwrap();
        fs::create_dir(&runtime).unwrap();
        write_fake_command(&fake_bin.join("launchctl"));
        let _env = EnvOverride::new(&[
            ("HOME", home.as_os_str().to_os_string()),
            ("PATH", path_with_prefix(&fake_bin)),
            ("XDG_RUNTIME_DIR", runtime.as_os_str().to_os_string()),
        ]);
        let daemon = temp.path().join("shellyd");
        fs::write(&daemon, b"daemon").unwrap();
        make_executable(&daemon);

        service_manager::LaunchdServiceManager::user()
            .install(install_ctx_for(daemon.clone()).unwrap())
            .unwrap();

        let plist_path = home
            .join("Library")
            .join("LaunchAgents")
            .join("app.shelly.daemon.plist");
        let plist = fs::read_to_string(&plist_path).unwrap();
        assert!(plist.contains("<key>Label</key>"));
        assert!(plist.contains("<string>app.shelly.daemon</string>"));
        assert!(plist.contains(&format!("<string>{}</string>", daemon.display())));
        assert!(plist.contains("<key>RunAtLoad</key>"));
        assert!(plist.contains("<true/>"));
        assert!(plist.contains("<key>KeepAlive</key>"));
        assert!(plist.contains("<key>SuccessfulExit</key>"));
        assert!(plist.contains("<false/>"));
        assert!(plist.contains("<key>Disabled</key>"));
        assert!(plist.contains("<key>LimitLoadToSessionType</key>"));
        assert!(plist.contains("<string>Aqua</string>"));
        assert!(plist.contains("<key>EnvironmentVariables</key>"));
        assert!(plist.contains("<key>HOME</key>"));
        assert!(plist.contains(&format!("<string>{}</string>", home.display())));
        assert!(plist.contains("<key>PATH</key>"));
        assert!(plist.contains("<key>XDG_RUNTIME_DIR</key>"));
        assert!(plist.contains(&format!("<string>{}</string>", runtime.display())));

        let calls = fs::read_to_string(fake_bin.join("calls.log")).unwrap();
        assert!(calls.contains(&format!("load {}", plist_path.display())));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn systemd_user_install_writes_restart_unit() {
        let _guard = env_lock();
        let temp = tempfile::tempdir().unwrap();
        let fake_bin = temp.path().join("bin");
        let config = temp.path().join("config");
        let home = temp.path().join("home");
        let runtime = temp.path().join("runtime");
        fs::create_dir(&fake_bin).unwrap();
        fs::create_dir(&config).unwrap();
        fs::create_dir(&home).unwrap();
        fs::create_dir(&runtime).unwrap();
        write_fake_command(&fake_bin.join("systemctl"));
        let _env = EnvOverride::new(&[
            ("HOME", home.as_os_str().to_os_string()),
            ("XDG_RUNTIME_DIR", runtime.as_os_str().to_os_string()),
            ("XDG_CONFIG_HOME", config.as_os_str().to_os_string()),
            ("PATH", path_with_prefix(&fake_bin)),
        ]);
        let daemon = temp.path().join("shellyd");
        fs::write(&daemon, b"daemon").unwrap();
        make_executable(&daemon);

        service_manager::SystemdServiceManager::user()
            .install(install_ctx_for(daemon.clone()).unwrap())
            .unwrap();

        let unit_path = config
            .join("systemd")
            .join("user")
            .join("shelly-daemon.service");
        let unit = fs::read_to_string(&unit_path).unwrap();
        assert!(unit.contains("[Service]"));
        assert!(unit.contains(&format!("ExecStart={} ", daemon.display())));
        assert!(unit.contains("Restart=on-failure"));
        assert!(unit.contains("RestartSec=5"));
        assert!(unit.contains("[Install]"));
        assert!(unit.contains("WantedBy=default.target"));
        assert!(!unit.contains("\nUser="));
        assert!(unit.contains(&format!("Environment=\"HOME={}\"", home.display())));
        assert!(unit.contains("Environment=\"PATH="));
        assert!(unit.contains(&format!(
            "Environment=\"XDG_RUNTIME_DIR={}\"",
            runtime.display()
        )));
        assert!(unit.contains(&format!(
            "Environment=\"XDG_CONFIG_HOME={}\"",
            config.display()
        )));

        let calls = fs::read_to_string(fake_bin.join("calls.log")).unwrap();
        assert!(calls.contains(&format!("--user enable {}", unit_path.display())));
    }

    fn make_executable(path: &Path) {
        #[cfg(unix)]
        {
            fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
        }
    }

    struct FakeServiceManager {
        fail_start: bool,
        calls: Mutex<Vec<String>>,
    }

    impl FakeServiceManager {
        fn fail_start() -> Self {
            Self {
                fail_start: true,
                calls: Mutex::new(Vec::new()),
            }
        }

        fn calls(&self) -> Vec<String> {
            self.calls.lock().unwrap().clone()
        }

        fn record(&self, call: impl Into<String>) {
            self.calls.lock().unwrap().push(call.into());
        }
    }

    impl ServiceManager for FakeServiceManager {
        fn available(&self) -> io::Result<bool> {
            Ok(true)
        }

        fn install(&self, ctx: ServiceInstallCtx) -> io::Result<()> {
            self.record(format!("install:{}", ctx.label));
            Ok(())
        }

        fn uninstall(&self, ctx: ServiceUninstallCtx) -> io::Result<()> {
            self.record(format!("uninstall:{}", ctx.label));
            Ok(())
        }

        fn start(&self, ctx: ServiceStartCtx) -> io::Result<()> {
            self.record(format!("start:{}", ctx.label));
            if self.fail_start {
                Err(io::Error::other("start failed"))
            } else {
                Ok(())
            }
        }

        fn stop(&self, ctx: ServiceStopCtx) -> io::Result<()> {
            self.record(format!("stop:{}", ctx.label));
            Ok(())
        }

        fn level(&self) -> ServiceLevel {
            ServiceLevel::User
        }

        fn set_level(&mut self, _level: ServiceLevel) -> io::Result<()> {
            Ok(())
        }

        fn status(&self, ctx: ServiceStatusCtx) -> io::Result<ServiceStatus> {
            self.record(format!("status:{}", ctx.label));
            Ok(ServiceStatus::NotInstalled)
        }
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    fn env_lock() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(())).lock().unwrap()
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    fn write_fake_command(path: &Path) {
        fs::write(
            path,
            "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$(dirname \"$0\")/calls.log\"\nexit 0\n",
        )
        .unwrap();
        make_executable(path);
    }

    #[cfg(target_os = "macos")]
    fn write_fake_codesign(path: &Path, signed: bool) {
        let exit_code = if signed { 0 } else { 1 };
        fs::write(
            path,
            format!(
                "#!/bin/sh\n\
                 printf 'codesign %s\\n' \"$*\" >> \"$(dirname \"$0\")/calls.log\"\n\
                 if [ {exit_code} -ne 0 ]; then\n\
                 printf 'shellyd: code object is not signed\\n' >&2\n\
                 fi\n\
                 exit {exit_code}\n",
                exit_code = exit_code
            ),
        )
        .unwrap();
        make_executable(path);
    }

    #[cfg(target_os = "macos")]
    fn write_fake_xattr(path: &Path, quarantined: bool) {
        let exit_code = if quarantined { 0 } else { 1 };
        fs::write(
            path,
            format!(
                "#!/bin/sh\n\
                 printf 'xattr %s\\n' \"$*\" >> \"$(dirname \"$0\")/calls.log\"\n\
                 if [ {exit_code} -eq 0 ]; then\n\
                 printf '0081;shelly quarantine\\n'\n\
                 fi\n\
                 exit {exit_code}\n",
                exit_code = exit_code
            ),
        )
        .unwrap();
        make_executable(path);
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    fn path_with_prefix(prefix: &Path) -> OsString {
        let old_path = env::var_os("PATH").unwrap_or_default();
        let mut path = OsString::from(prefix.as_os_str());
        path.push(":");
        path.push(old_path);
        path
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    struct EnvOverride {
        previous: Vec<(&'static str, Option<OsString>)>,
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    impl EnvOverride {
        fn new(vars: &[(&'static str, OsString)]) -> Self {
            let previous = vars
                .iter()
                .map(|(key, _)| (*key, env::var_os(key)))
                .collect::<Vec<_>>();
            for (key, value) in vars {
                // SAFETY: service-manager reads process environment while rendering platform
                // service files. These tests serialize environment mutation with env_lock().
                unsafe {
                    env::set_var(key, value);
                }
            }
            Self { previous }
        }
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    impl Drop for EnvOverride {
        fn drop(&mut self) {
            for (key, value) in self.previous.drain(..) {
                // SAFETY: see EnvOverride::new; the same test-held lock serializes restore.
                unsafe {
                    match value {
                        Some(value) => env::set_var(key, value),
                        None => env::remove_var(key),
                    }
                }
            }
        }
    }

    #[cfg(target_os = "macos")]
    struct FakeMacTrustTools {
        _guard: std::sync::MutexGuard<'static, ()>,
        _env: EnvOverride,
        _temp: tempfile::TempDir,
    }

    #[cfg(target_os = "macos")]
    impl FakeMacTrustTools {
        fn new(signed: bool, quarantined: bool) -> Self {
            let guard = env_lock();
            let temp = tempfile::tempdir().unwrap();
            let fake_bin = temp.path().join("bin");
            fs::create_dir(&fake_bin).unwrap();
            write_fake_codesign(&fake_bin.join("codesign"), signed);
            write_fake_xattr(&fake_bin.join("xattr"), quarantined);
            let env = EnvOverride::new(&[("PATH", path_with_prefix(&fake_bin))]);
            Self {
                _guard: guard,
                _env: env,
                _temp: temp,
            }
        }
    }
}
