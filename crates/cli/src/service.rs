use anyhow::{Context, Result, bail};
use service_manager::{
    RestartPolicy, ServiceInstallCtx, ServiceLabel, ServiceManager, ServiceStartCtx, ServiceStatus,
    ServiceStatusCtx, ServiceStopCtx, ServiceUninstallCtx,
};
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::str::FromStr;

const SERVICE_LABEL: &str = "app.fieldwork.daemon";

pub fn install() -> Result<()> {
    let manager = user_service_manager()?;
    install_with_manager(manager.as_ref(), install_ctx()?)
}

fn install_with_manager(manager: &dyn ServiceManager, ctx: ServiceInstallCtx) -> Result<()> {
    manager
        .install(ctx)
        .context("install fieldworkd user service")?;
    if let Err(error) = manager.start(start_ctx()) {
        let _ = manager.uninstall(uninstall_ctx());
        return Err(error).context("start fieldworkd user service");
    }
    Ok(())
}

pub fn uninstall() -> Result<()> {
    let manager = user_service_manager()?;
    let _ = manager.stop(stop_ctx());
    manager
        .uninstall(uninstall_ctx())
        .context("uninstall fieldworkd user service")?;
    Ok(())
}

pub fn restart() -> Result<()> {
    let manager = user_service_manager()?;
    let daemon = daemon_path()?;
    ensure_service_launch_allowed(&daemon)?;
    let _ = manager.stop(stop_ctx());
    manager
        .start(start_ctx())
        .context("start fieldworkd user service")?;
    Ok(())
}

pub fn status() -> Result<ServiceStatus> {
    user_service_manager()?
        .status(status_ctx())
        .context("query fieldworkd user service")
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
        bail!("fieldworkd service install is supported on macOS and Linux only in v1")
    }
}

fn install_ctx() -> Result<ServiceInstallCtx> {
    let daemon = daemon_path()?;
    ensure_service_launch_allowed(&daemon)?;
    install_ctx_for(daemon)
}

fn install_ctx_for(program: PathBuf) -> Result<ServiceInstallCtx> {
    Ok(ServiceInstallCtx {
        label: label()?,
        program,
        args: Vec::<OsString>::new(),
        contents: None,
        username: None,
        working_directory: None,
        environment: None,
        autostart: true,
        restart_policy: RestartPolicy::OnFailure {
            delay_secs: Some(5),
            max_retries: None,
            reset_after_secs: None,
        },
    })
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
        .context("fieldwork binary has no parent directory")?
        .join("fieldworkd");
    if !daemon.exists() {
        bail!(
            "fieldworkd not found next to fieldwork at {}",
            daemon.display()
        );
    }
    if !daemon.is_file() {
        bail!(
            "fieldworkd path next to fieldwork is not a file: {}",
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
        .with_context(|| format!("stat fieldworkd at {}", path.display()))?
        .permissions()
        .mode();
    if mode & 0o111 == 0 {
        bail!(
            "fieldworkd next to fieldwork is not executable: {}",
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

    let output = Command::new("spctl")
        .args(["--assess", "--type", "execute"])
        .arg(path)
        .output()
        .with_context(|| format!("run macOS Gatekeeper assessment for {}", path.display()))?;

    if output.status.success() {
        return Ok(());
    }

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let detail = match (stdout.is_empty(), stderr.is_empty()) {
        (true, true) => format!("spctl exited with {}", output.status),
        (false, true) => stdout,
        (true, false) => stderr,
        (false, false) => format!("{stdout}\n{stderr}"),
    };

    bail!(
        "macOS Gatekeeper rejected fieldworkd for launchd execution: {}\n\
         Install the signed/notarized Fieldwork npm package or use a notarized release artifact, \
         then rerun `fieldwork daemon install`.\n\
         spctl output: {detail}",
        path.display()
    );
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
        let daemon = temp.path().join("fieldworkd");
        fs::write(&daemon, b"daemon").unwrap();
        make_executable(&daemon);

        let ctx = install_ctx_for(daemon.clone()).unwrap();

        assert_eq!(ctx.label.to_string(), SERVICE_LABEL);
        assert_eq!(ctx.program, daemon);
        assert!(ctx.args.is_empty());
        assert!(ctx.contents.is_none());
        assert!(ctx.username.is_none());
        assert!(ctx.working_directory.is_none());
        assert!(ctx.environment.is_none());
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
        let daemon = temp.path().join("fieldworkd");
        fs::write(&daemon, b"daemon").unwrap();
        make_executable(&daemon);
        let manager = FakeServiceManager::fail_start();

        let error = super::install_with_manager(&manager, install_ctx_for(daemon).unwrap())
            .expect_err("start failure should fail install");

        assert!(error.to_string().contains("start fieldworkd user service"));
        assert_eq!(
            manager.calls(),
            [
                "install:app.fieldwork.daemon",
                "start:app.fieldwork.daemon",
                "uninstall:app.fieldwork.daemon"
            ]
        );
    }

    #[test]
    fn resolves_daemon_path_next_to_cli_binary() {
        let temp = tempfile::tempdir().unwrap();
        let bin = temp.path().join("bin");
        fs::create_dir(&bin).unwrap();
        let daemon = bin.join("fieldworkd");
        fs::write(&daemon, b"daemon").unwrap();
        make_executable(&daemon);

        let resolved = daemon_path_from_cli_path(&bin.join("fieldwork")).unwrap();

        assert_eq!(resolved, daemon);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn rejects_service_install_when_colocated_daemon_fails_macos_assessment() {
        let _spctl = FakeSpctl::new(1);
        let temp = tempfile::tempdir().unwrap();
        let daemon = temp.path().join("fieldworkd");
        fs::write(&daemon, b"daemon").unwrap();
        make_executable(&daemon);

        let error = ensure_service_launch_allowed(&daemon).unwrap_err();

        let message = error.to_string();
        assert!(message.contains("macOS Gatekeeper rejected fieldworkd for launchd execution"));
        assert!(message.contains("signed/notarized Fieldwork npm package"));
        assert!(message.contains("spctl output: fieldworkd: rejected"));
    }

    #[test]
    fn rejects_service_install_when_colocated_daemon_is_absent() {
        let temp = tempfile::tempdir().unwrap();
        let cli = temp.path().join("fieldwork");

        let error = daemon_path_from_cli_path(&cli).unwrap_err();

        assert!(
            error
                .to_string()
                .contains("fieldworkd not found next to fieldwork")
        );
    }

    #[test]
    fn rejects_service_install_when_colocated_daemon_is_not_a_file() {
        let temp = tempfile::tempdir().unwrap();
        let bin = temp.path().join("bin");
        fs::create_dir(&bin).unwrap();
        fs::create_dir(bin.join("fieldworkd")).unwrap();

        let error = daemon_path_from_cli_path(&bin.join("fieldwork")).unwrap_err();

        assert!(
            error
                .to_string()
                .contains("fieldworkd path next to fieldwork is not a file")
        );
    }

    #[cfg(unix)]
    #[test]
    fn rejects_service_install_when_colocated_daemon_is_not_executable() {
        let temp = tempfile::tempdir().unwrap();
        let bin = temp.path().join("bin");
        fs::create_dir(&bin).unwrap();
        let daemon = bin.join("fieldworkd");
        fs::write(&daemon, b"daemon").unwrap();
        fs::set_permissions(&daemon, fs::Permissions::from_mode(0o600)).unwrap();

        let error = daemon_path_from_cli_path(&bin.join("fieldwork")).unwrap_err();

        assert!(
            error
                .to_string()
                .contains("fieldworkd next to fieldwork is not executable")
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn launchd_user_install_writes_keepalive_plist() {
        let _guard = env_lock();
        let temp = tempfile::tempdir().unwrap();
        let fake_bin = temp.path().join("bin");
        let home = temp.path().join("home");
        fs::create_dir(&fake_bin).unwrap();
        fs::create_dir(&home).unwrap();
        write_fake_command(&fake_bin.join("launchctl"));
        let _env = EnvOverride::new(&[
            ("HOME", home.as_os_str().to_os_string()),
            ("PATH", path_with_prefix(&fake_bin)),
        ]);
        let daemon = temp.path().join("fieldworkd");
        fs::write(&daemon, b"daemon").unwrap();
        make_executable(&daemon);

        service_manager::LaunchdServiceManager::user()
            .install(install_ctx_for(daemon.clone()).unwrap())
            .unwrap();

        let plist_path = home
            .join("Library")
            .join("LaunchAgents")
            .join("app.fieldwork.daemon.plist");
        let plist = fs::read_to_string(&plist_path).unwrap();
        assert!(plist.contains("<key>Label</key>"));
        assert!(plist.contains("<string>app.fieldwork.daemon</string>"));
        assert!(plist.contains(&format!("<string>{}</string>", daemon.display())));
        assert!(plist.contains("<key>RunAtLoad</key>"));
        assert!(plist.contains("<true/>"));
        assert!(plist.contains("<key>KeepAlive</key>"));
        assert!(plist.contains("<key>SuccessfulExit</key>"));
        assert!(plist.contains("<false/>"));
        assert!(plist.contains("<key>Disabled</key>"));

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
        fs::create_dir(&fake_bin).unwrap();
        fs::create_dir(&config).unwrap();
        fs::create_dir(&home).unwrap();
        write_fake_command(&fake_bin.join("systemctl"));
        let _env = EnvOverride::new(&[
            ("HOME", home.as_os_str().to_os_string()),
            ("XDG_CONFIG_HOME", config.as_os_str().to_os_string()),
            ("PATH", path_with_prefix(&fake_bin)),
        ]);
        let daemon = temp.path().join("fieldworkd");
        fs::write(&daemon, b"daemon").unwrap();
        make_executable(&daemon);

        service_manager::SystemdServiceManager::user()
            .install(install_ctx_for(daemon.clone()).unwrap())
            .unwrap();

        let unit_path = config
            .join("systemd")
            .join("user")
            .join("fieldwork-daemon.service");
        let unit = fs::read_to_string(&unit_path).unwrap();
        assert!(unit.contains("[Service]"));
        assert!(unit.contains(&format!("ExecStart={} ", daemon.display())));
        assert!(unit.contains("Restart=on-failure"));
        assert!(unit.contains("RestartSec=5"));
        assert!(unit.contains("[Install]"));
        assert!(unit.contains("WantedBy=default.target"));
        assert!(!unit.contains("\nUser="));

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
    fn write_fake_spctl(path: &Path, exit_code: i32) {
        fs::write(
            path,
            format!(
                "#!/bin/sh\n\
                 printf '%s\\n' \"$*\" >> \"$(dirname \"$0\")/calls.log\"\n\
                 if [ {exit_code} -ne 0 ]; then\n\
                 printf 'fieldworkd: rejected\\n' >&2\n\
                 fi\n\
                 exit {exit_code}\n"
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
    struct FakeSpctl {
        _guard: std::sync::MutexGuard<'static, ()>,
        _env: EnvOverride,
        _temp: tempfile::TempDir,
    }

    #[cfg(target_os = "macos")]
    impl FakeSpctl {
        fn new(exit_code: i32) -> Self {
            let guard = env_lock();
            let temp = tempfile::tempdir().unwrap();
            let fake_bin = temp.path().join("bin");
            fs::create_dir(&fake_bin).unwrap();
            write_fake_spctl(&fake_bin.join("spctl"), exit_code);
            let env = EnvOverride::new(&[("PATH", path_with_prefix(&fake_bin))]);
            Self {
                _guard: guard,
                _env: env,
                _temp: temp,
            }
        }
    }
}
