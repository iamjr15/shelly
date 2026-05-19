#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const failures = [];

const service = read("crates/cli/src/service.rs");
const main = read("crates/cli/src/main.rs");
const ipc = read("crates/cli/src/ipc.rs");
const logging = read("crates/daemon/src/logging.rs");
const smoke = read("scripts/smoke-local-handoff.sh");
const ci = read(".github/workflows/ci.yml");

verifyServiceInstallScaffold();
verifyCliHealthChecks();
verifyIpcHandshakeWait();
verifyDaemonLogRetention();
verifySmokeRestartRestore();
verifySmokeReconnectReplay();
verifySmokeMobileBoundaries();
verifyCiWiresVerifier();

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log("daemon service scaffold ok");

function verifyServiceInstallScaffold() {
  requireText(service, "const SERVICE_LABEL: &str = \"app.fieldwork.daemon\"", "daemon service label must stay stable");
  requireText(service, "LaunchdServiceManager::user()", "macOS service install must be user-level launchd");
  requireText(service, "SystemdServiceManager::user()", "Linux service install must be user-level systemd");
  requireText(service, "fn install_with_manager(manager: &dyn ServiceManager, ctx: ServiceInstallCtx) -> Result<()>", "daemon service install must be testable with an injected service manager");
  requireText(service, "if let Err(error) = manager.start(start_ctx())", "daemon service install must handle start failures explicitly");
  requireText(service, "let _ = manager.uninstall(uninstall_ctx());", "daemon service install must roll back the user service when start fails");
  requireText(service, "autostart: true", "daemon service must autostart after login/session start");
  requireText(service, "RestartPolicy::OnFailure", "daemon service must restart on failure");
  requireText(service, "delay_secs: Some(5)", "daemon restart policy must debounce failures");
  requireText(service, "max_retries: None", "daemon restart policy must not stop after a fixed retry count");
  requireText(service, "bail!(\"fieldworkd service install is supported on macOS and Linux only in v1\")", "service install must reject unsupported native hosts");
  requireText(service, "std::env::current_exe()", "daemon path must be resolved relative to the installed CLI");
  requireText(service, ".join(\"fieldworkd\")", "daemon service must launch the colocated fieldworkd binary");
  requireText(service, "fieldworkd not found next to fieldwork", "daemon service install must fail if fieldworkd is missing");
  requireText(service, "fieldworkd path next to fieldwork is not a file", "daemon service install must fail if colocated fieldworkd is not a file");
  requireText(service, "fieldworkd next to fieldwork is not executable", "daemon service install must fail if colocated fieldworkd is not executable");
  requireText(service, "spctl", "macOS service install must run a Gatekeeper assessment before launchd install");
  requireText(service, "let daemon = daemon_path()?;\n    ensure_service_launch_allowed(&daemon)?;", "service install/restart must preflight launchd acceptance without changing direct daemon path resolution");
  requireText(service, "macOS Gatekeeper rejected fieldworkd for launchd execution", "macOS service install must fail early when launchd would reject the daemon");
  requireText(service, "signed/notarized Fieldwork npm package", "macOS service install rejection must tell users to use a signed/notarized artifact");
  requireText(service, "builds_hardened_user_service_install_context", "daemon service install context must have focused unit coverage");
  requireText(service, "service_lifecycle_contexts_share_stable_label", "daemon service lifecycle contexts must have stable-label unit coverage");
  requireText(service, "resolves_daemon_path_next_to_cli_binary", "daemon service daemon-path resolution must have focused unit coverage");
  requireText(service, "rejects_service_install_when_colocated_daemon_is_absent", "daemon service missing-daemon path must have focused unit coverage");
  requireText(service, "rejects_service_install_when_colocated_daemon_is_not_a_file", "daemon service non-file daemon path must have focused unit coverage");
  requireText(service, "rejects_service_install_when_colocated_daemon_is_not_executable", "daemon service non-executable daemon path must have focused unit coverage");
  requireText(service, "rejects_service_install_when_colocated_daemon_fails_macos_assessment", "daemon service macOS Gatekeeper rejection must have focused unit coverage");
  requireText(service, "rolls_back_service_install_when_start_fails", "daemon service install start-failure rollback must have focused unit coverage");
  requireText(service, "launchd_user_install_writes_keepalive_plist", "daemon service must test launchd plist rendering with KeepAlive");
  requireText(service, "systemd_user_install_writes_restart_unit", "daemon service must test systemd unit rendering with Restart=on-failure");
  requireText(service, "write_fake_command(&fake_bin.join(\"launchctl\"))", "launchd rendering test must avoid real launchctl side effects");
  requireText(service, "write_fake_command(&fake_bin.join(\"systemctl\"))", "systemd rendering test must avoid real systemctl side effects");
  requireText(service, "KeepAlive", "launchd rendering test must verify KeepAlive");
  requireText(service, "SuccessfulExit", "launchd rendering test must verify failure-only restart");
  requireText(service, "Restart=on-failure", "systemd rendering test must verify failure restart");
  requireText(service, "RestartSec=5", "systemd rendering test must verify restart delay");
}

function verifyCliHealthChecks() {
  requireText(main, "DaemonCommand::Install", "CLI must expose daemon install");
  requireText(main, "service::install()?", "daemon install command must call the service installer");
  requireText(main, "ipc::wait_for_existing_daemon().await", "daemon install/restart must wait for a real daemon handshake");
  requireText(main, "let _ = service::uninstall();", "failed daemon install health check must uninstall the broken service");
  requireText(main, "started fieldworkd user service but health check failed", "daemon install failure must report health-check failure");
  requireText(main, "DaemonCommand::Restart", "CLI must expose daemon restart");
  requireText(main, "service::restart()?", "daemon restart command must call service restart");
  requireText(main, "restarted fieldworkd user service but health check failed", "daemon restart failure must report health-check failure");
}

function verifyIpcHandshakeWait() {
  requireText(ipc, "for _ in 0..200", "service health wait must allow enough retries for launchd/systemd startup");
  requireText(ipc, "Duration::from_millis(50)", "service health wait must be bounded and fast");
  requireText(ipc, "connect_existing().await", "service health wait must connect to the existing service, not spawn another daemon");
  requireText(ipc, "service::daemon_path()?", "CLI daemon auto-spawn must reuse validated colocated fieldworkd resolution");
  requireText(ipc, "ClientKind::LocalCli", "CLI health handshake must identify as LocalCli");
  requireText(ipc, "protocol_version: CONTRACT_VERSION", "CLI health handshake must enforce protocol contract version");
  requireText(ipc, "ServerToClientMsg::Welcome", "CLI health handshake must wait for Welcome");
  requireText(ipc, "fieldworkd service did not become reachable", "service health wait must produce actionable timeout errors");
}

function verifyDaemonLogRetention() {
  requireText(logging, "const LOG_RETENTION: Duration = Duration::from_secs(7 * 24 * 60 * 60);", "daemon logs must retain only 7 days by default");
  requireText(logging, "prune_old_log_files(&log_dir, SystemTime::now())", "daemon logging init must prune old log files before writing");
  requireText(logging, "name.starts_with(\"daemon.log\")", "daemon log pruning must only target daemon log files");
  requireText(logging, "metadata.modified()? < cutoff", "daemon log pruning must delete only files older than the retention cutoff");
  requireText(logging, "prune_old_log_files_removes_only_expired_daemon_logs", "daemon log retention must have focused test coverage");
}

function verifySmokeRestartRestore() {
  requireText(smoke, "before_restart=", "local handoff smoke must capture sessions before daemon restart");
  requireText(smoke, "start_daemon \"$tmp/daemon2.log\"", "local handoff smoke must restart a fresh daemon process");
  for (const marker of ["bash", "claude", "vim|vi", "FW_SUBSCRIBE_SESSION_READY", "FW_RECONNECT_READY"]) {
    requireText(smoke, marker, `local handoff smoke must verify restored session marker ${marker}`);
  }
  requireText(smoke, "PASS restart restore", "local handoff smoke must report restart-restore success");
}

function verifySmokeReconnectReplay() {
  requireText(smoke, "--reconnect-expect-output", "local handoff smoke must verify warm reconnect replay over iroh");
  requireText(smoke, "--reconnect-timeout-ms 2000", "local handoff smoke must keep the reconnect replay timing threshold at 2 seconds");
  requireText(smoke, "FW_RECONNECT_LINE_50", "local handoff smoke must replay missed output after reconnect");
  requireText(smoke, "PASS reconnect replay", "local handoff smoke must report reconnect replay success");
}

function verifySmokeMobileBoundaries() {
  requireText(smoke, "--expect-protocol-mismatch", "local handoff smoke must verify iroh protocol-version mismatch rejection");
  requireText(smoke, "protocol mismatch as expected", "local handoff smoke must fail if iroh protocol mismatch is accepted");
  requireText(smoke, "--expect-forbidden-create", "local handoff smoke must verify mobile CreateSession rejection");
  requireText(smoke, "--expect-forbidden-kill", "local handoff smoke must verify mobile KillSession rejection");
  requireText(smoke, "--expect-forbidden-agent-event", "local handoff smoke must verify mobile AgentStateEvent rejection");
  requireText(smoke, "AgentStateEvent forbidden as expected", "local handoff smoke must fail if mobile AgentStateEvent is accepted");
}

function verifyCiWiresVerifier() {
  requireText(ci, "node scripts/verify-daemon-service.mjs", "CI must run the daemon service scaffold verifier");
}

function read(rel) {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

function requireText(text, needle, message) {
  if (!text.includes(needle)) {
    failures.push(message);
  }
}
