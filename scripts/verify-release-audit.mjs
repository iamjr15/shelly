#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const failures = [];

const audit = read("docs/RELEASE_AUDIT.md");
const plan = read("PLAN.md");
const install = read("docs/INSTALL.md");
const development = read("docs/DEVELOPMENT.md");
const ci = read(".github/workflows/ci.yml");
const localRelease = read("scripts/check-local-release.mjs");
const domainStatus = read("scripts/check-domain-status.mjs");
const githubNamespace = read("scripts/check-github-namespace.mjs");
const androidEmulatorAll = read("scripts/smoke-android-emulator-all.sh");
const packageJson = JSON.parse(read("package.json"));

verifyCurrentVerdict();
verifyPromptToArtifactChecklist();
verifyExternalBlockers();
verifyIosHeadroomEvidence();
verifyLatestRefresh();
verifyPlanUncheckedGatesAreReflected();
verifyPlanSectionNumbering();
verifyVerifierIsWired();
verifyOperatorRefreshScripts();

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log("release audit ok");

function verifyCurrentVerdict() {
  requireText(audit, "This file is the current prompt-to-artifact audit", "release audit must describe its prompt-to-artifact purpose");
  requirePattern(audit, /It is not a\s+release sign-off/, "release audit must not masquerade as a release sign-off");
  requireText(audit, "Fieldwork v1 is not yet releasable", "release audit must state that v1 is not yet releasable while Section 13 gates are open");
  requireText(audit, "Do not mark v1 complete until every unchecked gate", "release audit must include the final release sign-off rule");
  requireText(
    audit,
    "scripts/verify-release-audit.mjs` classifies\n  every unchecked `PLAN.md` gate by blocker class",
    "release audit must document the unchecked-gate classification guard",
  );
  for (const blockerClass of [
    "`ios-xcode`",
    "`signing`",
    "`publish`",
    "`provider`",
    "`physical-device`",
    "`store-console`",
    "`operator`",
  ]) {
    requireText(audit, blockerClass, `release audit must document unchecked-gate blocker class ${blockerClass}`);
  }
}

function verifyPromptToArtifactChecklist() {
  requireText(audit, "## Prompt-To-Artifact Checklist", "release audit must include the prompt-to-artifact checklist section");
  requireText(audit, "| Requirement | Evidence | Status |", "release audit checklist table header is missing");

  for (const requirement of [
    "`PLAN.md` is v1 contract and `FUTURE.md` is the boundary",
    "Section 14 build order followed before mobile/distribution work",
    "Rust workspace with `protocol`, `daemon`, `cli`, `relay`, `mobile-core`",
    "Binaries `fieldwork`, `fieldworkd`, `fieldwork-relay`",
    "Future-only product surfaces stay outside the v1 protocol and code",
    "Universal PTY handoff for arbitrary commands",
    "Raw PTY bytes, not cell-grid diffs",
    "`wezterm-term` in daemon for state and synthetic snapshots",
    "Length-prefixed framing everywhere",
    "Bincode for Unix IPC, MessagePack for mobile/iroh",
    "`CONTRACT_VERSION = 1` and version rejection",
    "UUIDv7 IDs and UTC millisecond timestamps",
    "256 KB per-session ring, monotonic `seq`, warm replay",
    "Cold/stale attach synthetic ANSI snapshot",
    "Multiple clients attach simultaneously; input writes to PTY",
    "Dashboard session subscriptions receive create/remove/state replacement lists",
    "Resize uses minimum attached viewport",
    "Subscriber overflow emits one terminal `Lag` and forces resync",
    "State inference dispatch for Claude, Codex, unknown commands",
    "Claude/Codex first-class push/state; unknown commands run with baseline state",
    "QR pairing, 32-byte base32 tokens, 10 minute TTL, single use, desktop approval",
    "Long-lived Ed25519 device auth and revocation",
    "Unix socket hardening",
    "Non-`LocalCli` clients cannot create/kill sessions",
    "Scrollback/device registry encrypted at rest by default, opt-out explicit",
    "Push payload privacy",
    "Mobile crash-reporting consent",
    "Relay verifies signatures, token ownership, replay, skew, validation",
    "Fieldwork-owned TLS clients use OS trust",
    "Security model doc",
    "Native iOS app: SwiftUI + SwiftTerm",
    "Native Android app: Compose + Section 7.6 renderer decision",
    "Mobile resume/input biometric gates",
    "Mobile can pair, list/subscribe, attach, send input, resize, detach, register push tokens",
    "Mobile cannot create sessions, kill sessions, or specify commands",
    "iroh P2P transport with relay fallback",
    "Generic push notifications",
    "Relay control-plane transport encryption",
    "npm-only desktop distribution",
    "CI/release workflows",
    "Local non-external release gate",
    "Daemon service install/restart scaffold",
    "Development doc",
    "Desktop cold-start performance thresholds",
    "Docs synchronized",
    "README screenshots and 60-second demo video",
    "App Store privacy nutrition labels / Play Data safety",
    "AGPL OSS posture",
    "Site for `fieldwork.dev`",
    "Appendix B external reservations",
  ]) {
    requireText(audit, requirement, `release audit checklist is missing requirement: ${requirement}`);
  }
  requireText(
    audit,
    "`scripts/check-local-release.mjs`",
    "release audit must record the local release aggregate script",
  );
  requireText(
    audit,
    "`check:local-release`",
    "release audit must record the local release aggregate package script",
  );
  requireText(
    audit,
    "optional `--with-artifacts` mode",
    "release audit must record artifact-aware local release aggregate mode",
  );
  requireText(
    audit,
    "optional `--with-runtime` mode",
    "release audit must record runtime local release aggregate mode",
  );
  requireText(
    audit,
    "local handoff smoke, demo-video, site typecheck/build",
    "release audit must record local handoff smoke in runtime aggregate mode",
  );
  requireText(
    audit,
    "defaults to `/tmp/fieldwork-target-checks` unless `CARGO_TARGET_DIR` is already set",
    "release audit must record the aggregate local handoff target-dir default",
  );
  requireText(
    audit,
    "CI syntax-checks the aggregate wrapper and list-checks artifact/runtime modes",
    "release audit must record CI coverage for the local release aggregate wrapper",
  );
  requireText(
    audit,
    "focused service context/path unit tests",
    "release audit must record daemon service install/path unit-test coverage",
  );
  requireText(
    audit,
    "colocated executable `fieldworkd` validation",
    "release audit must record executable daemon-path validation coverage",
  );
  requireText(
    audit,
    "macOS Gatekeeper rejection",
    "release audit must record macOS Gatekeeper service preflight coverage",
  );
  requireText(
    audit,
    "CLI auto-spawn reuse of validated colocated `fieldworkd` resolution",
    "release audit must record CLI auto-spawn daemon-path validation coverage",
  );
  requireText(
    audit,
    "npm meta-package exposes both command dispatchers",
    "release audit must record that npm exposes both desktop binaries",
  );
  requireText(
    audit,
    "scripts/verify-rust-workspace.mjs",
    "release audit must record the Rust workspace/binary verifier",
  );
  requireText(
    audit,
    "`fieldwork`, `fieldworkd`, and `fieldwork-relay` Rust bin declarations",
    "release audit must record exact Rust binary declaration coverage",
  );
  for (const boundary of [
    "image paste/media input",
    "cross-device handoff",
    "plugin/WASM extension protocol surface",
    "self-hostable relay Docker/container packaging",
  ]) {
    requireText(audit, boundary, `release audit must record v1 boundary coverage for ${boundary}`);
  }
  requireText(
    audit,
    "NOTICE section-7 App Store/TestFlight permission wording",
    "release audit must record focused NOTICE additional-permission verification",
  );
  requireText(
    audit,
    "npm package AGPL/repository metadata",
    "release audit must record focused npm legal metadata verification",
  );
  requireText(
    audit,
    "generated native OSS notice screens",
    "release audit must record generated mobile OSS notice verification",
  );
  requireText(
    audit,
    "scripts/verify-docs-sync.mjs",
    "release audit must record the docs-sync verifier",
  );
  requireText(
    audit,
    "run one explicit warm-up sample to remove build-machine first-exec noise",
    "release audit must record the desktop performance warm-up contract",
  );
  requireText(
    audit,
    "latest pass measured CLI max `3.45ms` and daemon max `47.78ms`",
    "release audit must record current desktop max performance evidence",
  );
  requireText(
    audit,
    "scripts/verify-community-scaffold.mjs",
    "release audit must record the community scaffold verifier",
  );
  requireText(
    audit,
    "privacy/security reminders, v1/FUTURE boundary checks, external-gate disclosure, and the AGPL/App-Store-permission docs",
    "release audit must record concrete community scaffold coverage",
  );
  requireText(
    audit,
    "current v1 install, protocol, privacy, architecture, iOS blocker, mobile-boundary, npm-only distribution, and deferred-scope facts",
    "release audit must record concrete docs-sync coverage",
  );
  requireText(
    audit,
    "AAB ABI, packaged uses-permission allowlist and manifest privacy verifier",
    "release audit must record Android AAB packaged manifest verification",
  );
  requireText(audit, "full-width Pair button is textless", "release audit must record Android pair-button locator coverage");
  requireText(audit, "first enabled full-width\n  clickable control below it", "release audit must record UI-tree pair-button selection coverage");
  requireText(audit, "forbidden location permission", "release audit must record Android AAB forbidden-permission self-test coverage");
  requireText(audit, "missing notification permission", "release audit must record Android AAB required-permission self-test coverage");
  requireText(audit, "terminal-content metadata such as `last_line`", "release audit must record Android AAB terminal-content metadata self-test coverage");
  requireText(
    audit,
    "focused TerminalController JVM tests for locked-input refusal",
    "release audit must record Android TerminalController JVM coverage",
  );
  requireText(
    audit,
    "latest-`lastSeenSeq` `Lag` reattach, attached-stream-error reattach, delayed telemetry trigger",
    "release audit must record Android TerminalController lag/stream-error/telemetry coverage",
  );
  requireText(
    audit,
    "lifecycle-scoped `FieldworkViewModel`",
    "release audit must record Android lifecycle-scoped ViewModel coverage",
  );
  requireText(
    audit,
    "nonblocking saved-pairing restore",
    "release audit must record Android nonblocking startup restore coverage",
  );
  requireText(
    audit,
    "stale startup-restore invalidation",
    "release audit must record Android stale startup-restore invalidation",
  );
  requireText(
    audit,
    "terminal input refusal while locked",
    "release audit must record Android locked-input unit coverage",
  );
  requireText(
    audit,
    "TerminalController coverage for locked-input refusal, latest-`lastSeenSeq`\n`Lag` reattach, attached-stream-error reattach, delayed telemetry-consent triggering",
    "release audit latest refresh must record TerminalController test coverage",
  );
  requireText(
    audit,
    "focused Android MobileTelemetry JVM tests",
    "release audit must record Android MobileTelemetry JVM coverage",
  );
  requireText(
    audit,
    "declined one-time consent resolution",
    "release audit must record mobile telemetry declined-consent coverage",
  );
  requireText(
    audit,
    "debug-without-DSN no-start behavior",
    "release audit must record debug-without-DSN Sentry no-start coverage",
  );
  requireText(
    audit,
    "MobileTelemetry\ncoverage for default-off crash reporting, declined one-time consent resolution,\nand debug-without-DSN no-start behavior",
    "release audit latest refresh must record MobileTelemetry test coverage",
  );
  requireText(
    audit,
    "packaged uses-permission allowlist",
    "release audit must record Android AAB packaged uses-permission allowlist verification",
  );
  requireText(
    audit,
    "Android queued FCM token registrar tests for trimmed-token storage, blank-token rejection, matching-token clear semantics, clear-all unpair behavior, FieldworkViewModel tests for paired/unlocked registration gating, duplicate-token dedupe, pairing-time session load/subscription/FCM sync, locked pairing no-op for session load/subscription/FCM sync, dashboard subscription updates, lock-time subscription stop, locked push-tap pending resolution after unlock or later subscription updates, unlocked push-tap resolution against the current session list, and invalid uppercase hash rejection after unlock",
    "release audit must record Android queued FCM token registrar coverage",
  );
  requireText(
    audit,
    "`fieldwork_push_tokens.xml` backup/transfer exclusion",
    "release audit must record queued FCM token backup/transfer exclusion",
  );
  requireText(
    audit,
    "local API 36.1 emulator debug launch, `uiautomator` locked-surface evidence, and nonblank emulator `screencap` check",
    "release audit must record the current Android emulator debug-launch evidence",
  );
  for (const evidence of [
    "default aggregate run on 2026-05-19 passed on `emulator-5554`",
    "`TotalTime=7920ms`",
    "`pair_flow_ms=2234`",
    "`visible_ms=3318`",
    "8440/14400 nonblack samples",
    "notification tap routing",
  ]) {
    requireText(audit, evidence, `release audit must record aggregate Android emulator evidence: ${evidence}`);
  }
  requireText(
    audit,
    "Direct adb restart-restore evidence on 2026-05-19",
    "release audit must record direct adb restart-restore evidence",
  );
  requireText(
    audit,
    "captured emulator screenshots,\n  `uiautomator` dumps, `dumpsys window` focus, and logcat",
    "release audit must record adb screenshot/UI/logcat evidence",
  );
  requireText(
    audit,
    "ANR in app.fieldwork.android",
    "release audit must record the Android ANR found by direct adb QA",
  );
  requireText(
    audit,
    "FieldworkRepository: listSessions returned 1\n  sessions",
    "release audit must record restored-session list logcat evidence",
  );
  requireText(
    audit,
    "A later manual adb rerun on the same date restored the debug",
    "release audit must record the manual adb rerun after test-only payload injection",
  );
  requireText(
    audit,
    "`FIELDWORK_BIOMETRIC_BYPASS = false`",
    "release audit must record restored Android biometric bypass default",
  );
  requireText(
    audit,
    '`FIELDWORK_DEBUG_PAIRING_PAYLOAD = ""`',
    "release audit must record restored empty Android debug pairing payload",
  );
  requireText(
    audit,
    "`TotalTime=1082ms`",
    "release audit must record the manual adb rerun launch timing",
  );
  requireText(
    audit,
    "`echo android_adb_direct_input` plus the matching\n  PTY output",
    "release audit must record manual adb terminal input/output screenshot evidence",
  );
  requireText(
    audit,
    "follow-up raw adb",
    "release audit must record the follow-up raw adb locked-launch baseline",
  );
  requireText(audit, "locked-launch baseline on 2026-05-19", "release audit must record the raw adb locked-launch baseline date");
  requireText(
    audit,
    "`TotalTime=2078ms`",
    "release audit must record the raw adb locked-launch timing",
  );
  requireText(
    audit,
    "`/tmp/fieldwork-adb-launch.png`, `/tmp/fieldwork-adb-ui.xml`,\n  app-scoped logcat, and the crash buffer",
    "release audit must record raw adb screenshot/UI/logcat/crash evidence",
  );
  requireText(
    audit,
    "latest raw adb emulator QA refresh installed the default debug APK",
    "release audit must record the latest raw adb emulator QA refresh",
  );
  requireText(
    audit,
    "`Status: ok` and `TotalTime=5297ms`",
    "release audit must record latest raw adb launch status and timing",
  );
  for (const evidence of [
    "`/tmp/fieldwork-adb-direct-20260519225027/default.png`",
    "`/tmp/fieldwork-adb-direct-20260519225027/default-ui.xml`",
    "`/tmp/fieldwork-adb-direct-20260519225027/default-logcat.log`",
    "`/tmp/fieldwork-adb-direct-20260519225027/default-crash.log`",
    "`FIELDWORK_ANDROID_BIOMETRIC_BYPASS=true`",
    "`FIELDWORK_ANDROID_PAIRING_PAYLOAD`",
    "`TotalTime=4589ms`",
    "UI-tree-derived Pair tap center `540 1860`",
    "`pair_flow_ms=1043`",
    "paired through explicit desktop approval",
    "`FIELDWORK_ANDROID_PAIRING_PAYLOAD` injection",
    "`ANDROID_ADB_DIRECT_READY`",
    "`fw_android_direct_ok`",
    "`/tmp/fieldwork-adb-direct-pair-20260519225208/before-pair.png`",
    "`/tmp/fieldwork-adb-direct-pair-20260519225208/sessions.png`",
    "`/tmp/fieldwork-adb-direct-pair-20260519225208/terminal-before-input.png`",
    "`/tmp/fieldwork-adb-direct-pair-20260519225208/terminal-after-input.png`",
    "`android-direct: fw_android_direct_ok`",
    "`FIELDWORK_BIOMETRIC_BYPASS = false`",
    '`FIELDWORK_DEBUG_PAIRING_PAYLOAD = ""`',
    "`TotalTime=5105ms`",
    "`/tmp/fieldwork-adb-direct-restore-20260519225316/restored-locked.png`",
    "`/tmp/fieldwork-adb-direct-restore-20260519225316/restored-ui.xml`",
  ]) {
    requireText(audit, evidence, `release audit latest raw adb QA evidence must include ${evidence}`);
  }
  requireText(
    audit,
    "not release-device cold-start threshold evidence",
    "release audit must distinguish debug adb smoke from release-device threshold evidence",
  );
  requireText(
    audit,
    "off-main repository-backed refresh coverage",
    "release audit must record off-main Android refresh coverage",
  );
  requireText(
    audit,
    "pair/attach/foreground-input evidence",
    "release audit latest refresh must record strengthened Android emulator pair evidence",
  );
  requireText(
    audit,
    "send mobile-originated input into\n  the PTY",
    "release audit must record Android emulator mobile-originated terminal input evidence",
  );
  requireText(
    audit,
    "replayed terminal bytes",
    "release audit must record verifier replay evidence for Android emulator input",
  );
  requireText(
    audit,
    "physical dogfood and release-device runtime gates remain blocked",
    "release audit must keep Android physical-device runtime gates explicit",
  );
  rejectText(
    audit,
    "emulator was not usable for runtime gates",
    "release audit must not retain stale Android emulator wording",
  );
  requireText(
    audit,
    "iOS Xcode build-phase `FIELDWORK_SKIP_RUST_BUILD` reuse wiring",
    "release audit must record iOS archive skip-build wiring coverage",
  );
  requireText(
    audit,
    "`fieldwork` and `fieldworkd` dispatcher fallback",
    "release audit must record dispatcher fallback coverage for both npm commands",
  );
  requireText(
    audit,
    "both executable dispatcher files",
    "release audit must record npm pack verification for both dispatchers",
  );
  requireText(
    audit,
    "lowercase 64-character hex strings",
    "release audit must record strict push-hash validation coverage",
  );
  requireText(
    audit,
    "test-only delivery-buffer retention",
    "release audit must record that accepted provider delivery records are not retained in production relay builds",
  );
  requireText(
    audit,
    "daemon-facing provider-error body redaction",
    "release audit must record daemon-facing provider error body redaction coverage",
  );
  requireText(
    audit,
    "attached_clients_share_pty_output_from_any_input_writer",
    "release audit must record focused multi-attach PTY input/output coverage",
  );
  requireText(
    audit,
    "stream_output_advances_mobile_reconnect_offset_without_decoding_bytes",
    "release audit must record focused mobile-core raw output/reconnect-offset coverage",
  );
  requireText(
    audit,
    "yes_head_10000_scale_stream_delivers_all_bytes_without_offset_drift",
    "release audit must record focused mobile-core high-volume output coverage",
  );
  requireText(
    audit,
    "high-volume `yes | head -10000`-scale byte delivery without dropped bytes or offset drift",
    "release audit must record local high-volume mobile output semantics",
  );
  requireText(
    audit,
    "pnpm test:android-emulator-flood",
    "release audit must record the Android emulator terminal-flood smoke command",
  );
  requireText(
    audit,
    "renders a\n  `yes | head -10000`-scale stream in the actual Android terminal view",
    "release audit must record Android renderer flood-smoke coverage",
  );
  requireText(
    audit,
    "ANDROID_EMULATOR_FLOOD",
    "release audit must record Android flood replay marker evidence",
  );
  requireText(
    audit,
    "pnpm test:android-emulator-multisession",
    "release audit must record the Android emulator multisession smoke command",
  );
  requireText(
    audit,
    "opens\n  three desktop-created sessions",
    "release audit must record Android multisession switching coverage",
  );
  requireText(
    audit,
    "multi_a_ok",
    "release audit must record Android multisession no-leakage marker evidence",
  );
  requireText(
    audit,
    "pnpm test:android-emulator-reconnect",
    "release audit must record the Android emulator reconnect smoke command",
  );
  requireText(
    audit,
    "emulator airplane mode to cut network",
    "release audit must record Android emulator network-cut coverage",
  );
  requireText(
    audit,
    "ANDROID_RECONNECT_OFFLINE_OUTPUT",
    "release audit must record Android reconnect replay marker evidence",
  );
  requireText(
    audit,
    "pnpm test:android-emulator-notification-tap",
    "release audit must record the Android emulator notification-tap smoke command",
  );
  requireText(
    audit,
    "uppercase invalid hash does not route",
    "release audit must record Android invalid notification-tap hash coverage",
  );
  requireText(
    audit,
    "notify_tap_ok",
    "release audit must record Android notification-tap target PTY evidence",
  );
  requireText(
    audit,
    "raw bytes are delivered without UTF-8 decoding",
    "release audit must record raw mobile byte delivery semantics",
  );
  requireText(
    audit,
    "matching LocalCli hook updates",
    "release audit must record matching local agent hook state-update coverage",
  );
  requireText(
    audit,
    "mismatched hook-source rejection",
    "release audit must record mismatched local agent hook rejection coverage",
  );
  requireText(
    audit,
    "session_list_subscription_receives_create_and_remove_replacements",
    "release audit must record focused session-list create/remove subscription coverage",
  );
  requireText(
    audit,
    "session_list_forwarder_publishes_dashboard_state_changes",
    "release audit must record focused session-list state-change subscription coverage",
  );
  requireText(
    audit,
    "pairing_peer_identity_mismatch_returns_unauthorized",
    "release audit must record focused iroh peer-identity pairing coverage",
  );
  requireText(
    audit,
    "deterministic phone `--secret-key-path`",
    "release audit must record deterministic iroh revocation smoke coverage",
  );
  requireText(
    audit,
    "removing_device_with_push_token_enqueues_relay_unregistration",
    "release audit must record device removal relay token-unregistration enqueue coverage",
  );
  requireText(
    audit,
    "worker_unregisters_token_from_relay",
    "release audit must record daemon push worker token-unregistration coverage",
  );
}

function verifyExternalBlockers() {
  for (const blocker of [
    "npm platform child package publish rights and a release-scoped `NPM_TOKEN`",
    "macOS signing and notarization credentials",
    "Full local Xcode installation",
    "Apple\n  Distribution",
    "provisioning",
    "App Store Connect API keys",
    "TestFlight/App\n  Store account access",
    "Apple Developer authentication/access",
    "missing Apple ID/password",
    "Android release keystore",
    "Firebase `google-services.json`",
    "Play Console\n  account access",
    "APNs `.p8`, FCM service-account JSON",
    "physical iOS/Android devices",
    "Honeycomb account/API key",
    "Oracle ARM relay hosts",
    "DNS/domain ownership",
    "domain status script is reserved",
    "routine agent gate",
    "SSH secrets",
    "Cloudflare\n  Pages credentials",
    "GitHub org/repo creation",
    "GitHub namespace checks are reserved",
    "`@fieldworkdev` social handle reservation",
    "calendar/time block for the launch plan",
    "Physical-device checks",
    "30-minute Android terminal dogfood",
    "A local API 36.1 Android emulator is only a debug substitute",
    "pnpm test:android-emulator",
    "aggregate direct-adb substitute suite",
    "Its `--list` mode",
    "retry only a locked debug-launch timing outlier once with the same strict\n  limit",
    "every other script failure fails closed and preserves the captured\n  wrapper output path",
    "fails closed unless exactly one\n  boot-complete adb device is available",
    "pnpm test:android-debug-smoke",
    "pnpm test:android-emulator-pair",
    "pnpm test:android-emulator-session-subscription",
    "pnpm test:android-emulator-background-replay",
    "pnpm test:android-emulator-restart-restore",
    "pnpm test:android-emulator-flood",
    "pnpm test:android-emulator-multisession",
    "pnpm test:android-emulator-reconnect",
    "pnpm test:android-emulator-notification-tap",
    "FIELDWORK_ANDROID_BIOMETRIC_BYPASS=true",
    "FIELDWORK_ANDROID_PAIRING_PAYLOAD",
    "debug-build-only",
    "BuildConfig.DEBUG",
    "measure the debug-app\n  Pair tap through explicit desktop approval completion",
    "local\n  15-second emulator bound",
    "pair_flow_ms=2234",
    "Physical QR camera pair-flow timing remains a release-device gate",
    "open the\n  terminal",
    "background and foreground the app",
    "send mobile-originated input into\n  the PTY",
    "separately approved verifier client",
    "replayed terminal bytes",
    "fw_subscribe_session",
    "local 8-second emulator bound",
    "subscription_attach_ok",
    "fw_restart_session",
    "ANDROID_RESTART_SCROLLBACK",
    "intentionally completed",
    "session-exit path",
    "same temp state\n  and deterministic node identity",
    "relaunches the app from saved pairing",
    "restored dashboard still lists",
    "ANDROID_BACKGROUND_REPLAY_OUTPUT",
    "after_background_ok",
    "renders a\n  `yes | head -10000`-scale stream in the actual Android terminal view",
    "ANDROID_EMULATOR_FLOOD",
    "opens\n  three desktop-created sessions",
    "multi_a_ok",
    "multi_b_ok",
    "multi_c_ok",
    "after_reconnect_ok",
    "ANDROID_RECONNECT_OFFLINE_OUTPUT",
    "notify_tap_ok",
    "TotalTime=2467ms",
    "14391/14400 nonblack samples",
    "background Google-service ANRs",
    "macOS launchd and sleep/wake survival checks",
    "at least 70 GiB free in `~/Downloads`",
    "failure output now prints concrete recovery\n  steps to authenticate",
    "select\n  `/Applications/Xcode-16.3.app/Contents/Developer`",
    "sudo xcodebuild -runFirstLaunch",
    "No\n  Xcode `.xip` is present locally",
  ]) {
    requireText(audit, blocker, `release audit current blocker list is missing: ${blocker}`);
  }

  for (const externalStatus of [
    "full build blocked by Xcode/signing/device gates",
    "provider delivery blocked",
    "publish blocked",
    "external secrets blocked",
    "macOS sleep/wake gates still need signed/notarized artifact",
    "physical-device biometric prompt check blocked",
    "console submission blocked",
    "Cloudflare/domain ownership blocked",
  ]) {
    requireText(audit, externalStatus, `release audit must preserve external-gate status: ${externalStatus}`);
  }
}

function verifyIosHeadroomEvidence() {
  const currentClaim = "at least 70 GiB free in `~/Downloads`";
  for (const [name, text] of [
    ["docs/RELEASE_AUDIT.md", audit],
    ["PLAN.md", plan],
    ["docs/INSTALL.md", install],
    ["docs/DEVELOPMENT.md", development],
  ]) {
    requireText(text, currentClaim, `${name} must document the current iOS download-headroom audit result`);
    rejectText(text, "69 GiB free", `${name} must not retain stale iOS download-headroom wording`);
    rejectText(text, "73 GiB free", `${name} must not pin volatile iOS download-headroom wording`);
    rejectText(text, "74 GiB free", `${name} must not pin volatile iOS download-headroom wording`);
    rejectText(text, "75 GiB free", `${name} must not pin volatile iOS download-headroom wording`);
    rejectText(text, "download-headroom warning", `${name} must not say the iOS download-headroom warning is still present`);
    rejectText(text, "repo still warns", `${name} must not say the repo still warns about iOS download headroom`);
    rejectText(text, "one more small cleanup", `${name} must not say more cleanup is needed for iOS download headroom`);
  }
}

function verifyLatestRefresh() {
  requireText(audit, "## Latest Focused Refresh", "release audit must summarize the latest focused verification refresh");
  for (const command of [
    "node --check scripts/verify-npm-registry-state.mjs",
    "node --check scripts/verify-telemetry-privacy.mjs",
    "node --check scripts/verify-mobile-privacy.mjs",
    "node --check scripts/verify-store-privacy.mjs",
    "pnpm check:telemetry-privacy",
    "pnpm check:store-privacy",
    "swiftc -parse -target arm64-apple-macosx15.0",
    "pnpm check:mobile-privacy",
    "pnpm check:v1-boundary",
    "pnpm check:release-audit",
    "pnpm check:local-release -- --with-artifacts --with-runtime",
    "pnpm check:release-workflows",
    "pnpm check:secret-boundaries",
    "pnpm test:secret-boundaries",
    "pnpm check:security-model",
    "pnpm check:android-aab",
    "node scripts/test-android-aab-verifier.mjs",
    "node scripts/test-android-pair-button-picker.mjs",
    "node scripts/test-external-status-refresh.mjs",
    "pnpm test:android-emulator",
    "pnpm check:npm-packages",
    "pnpm check:changesets",
    "pnpm check:oss-notices",
    "pnpm check:site",
    "pnpm check:rust-workspace",
    "pnpm check:docs-sync",
    "pnpm check:development-doc",
    "pnpm check:npm-registry -- --expect-meta-published --expect-platform-unpublished",
    "pnpm test:npm-registry-state",
    "pnpm test:ios-prereqs",
    "pnpm check:community-scaffold",
    "pnpm check:infra-scaffold",
    "pnpm check:infra-terraform",
    "terraform fmt -check -recursive infra/oracle/terraform",
    "terraform -chdir=infra/oracle/terraform init -backend=false",
    "terraform -chdir=infra/oracle/terraform validate",
    "pnpm check:site-content",
    "pnpm check:relay-provider-clients",
    "pnpm check:daemon-resize",
    "apps/android/gradlew --no-daemon :app:compileDebugKotlin",
    "pnpm test:android-unit",
    "pnpm check:ios-prereqs",
    "cargo deny check",
    "cargo audit",
    "cargo test -p fieldwork-daemon state_infer",
    "cargo test -p fieldwork-daemon local_agent_hook",
    "cargo test -p fieldwork-cli service",
    "pnpm check:daemon-service",
    "node scripts/verify-daemon-service.mjs",
    "node --check scripts/verify-daemon-resize.mjs",
    "pnpm test:local-handoff",
    "cargo test -p fieldwork-daemon ipc_handler_rejects_mobile_create_and_kill_session_requests",
    "cargo test -p fieldwork-daemon ipc_handler_rejects_mobile_agent_state_events",
    "cargo test -p fieldwork-daemon attached_clients_share_pty_output_from_any_input_writer",
    "cargo test -p fieldwork-daemon pairing_peer_identity_mismatch_returns_unauthorized",
    "cargo test -p fieldwork-daemon warm_attach_seq_points_after_replayed_bytes",
    "cargo test -p fieldwork-daemon persistence",
    "cargo test -p fieldwork-daemon push_hash_is_lowercase_sha256_hex_and_not_plaintext",
    "cargo test -p fieldwork-daemon worker_registers_token_and_pushes_awaiting_input_to_relay",
    "cargo test -p fieldwork-relay payload_contains_only_generic_text_and_hashes",
    "cargo test -p fieldwork-relay private_payload",
    "cargo test -p fieldwork-relay apns_bad_device_token_removes_token_binding_from_memory_and_sqlite",
    "cargo test -p fieldwork-relay push_token",
    "cargo test -p fieldwork-relay fcm_invalid_token_reason_detects_unregistered_fcm_error",
    "cargo test -p fieldwork-mobile-core",
    "cargo test -p fieldwork-protocol",
    "pnpm test:npm-dispatcher",
    "pnpm test:release-artifacts",
    "pnpm test:npm-publish-plan",
    "pnpm test:npm-artifacts",
    "pnpm test:bun-install",
    "pnpm test:relay-tls",
    "pnpm test:relay-otlp",
    "node scripts/measure-desktop-performance.mjs",
    "node scripts/verify-npm-packages.mjs --require-binaries",
    "node scripts/publish-npm-packages.mjs --check-ready",
    "npm pack ./packages/cli --dry-run --json",
    "cargo test -p fieldwork-relay rejects_cross_daemon_token_use",
    "node scripts/verify-mobile-privacy.mjs",
    "node scripts/verify-store-privacy.mjs",
    "node scripts/verify-telemetry-privacy.mjs",
    "node scripts/verify-v1-boundary.mjs",
    "node scripts/verify-release-workflows.mjs",
    "node scripts/verify-infra-scaffold.mjs",
    "node scripts/smoke-relay-otlp-loopback.mjs",
  ]) {
    requireText(audit, command, `release audit latest refresh is missing command: ${command}`);
  }
  requireText(audit, "Downloaded release-rust/GitHub Release archives, `.sha256` files, and\n  `.bundle` attestations are required for `pnpm check:release-artifacts`", "release audit must document real artifact requirement for release artifact checks");
  requireText(audit, "local run without `artifacts/` or `FIELDWORK_ARTIFACT_DIR` fails closed as\n  expected", "release audit must document fail-closed missing artifact directory behavior");
  requireText(audit, "`pnpm test:release-artifacts` remains the deterministic local\n  verifier substitute", "release audit must document local release artifact substitute");
  requireText(audit, "decoded Apple signing/notarization assets outside the repository workspace with chmod/cleanup", "release audit must document release-rust decoded signing asset hygiene");
  requireText(audit, "iOS App Store Connect upload JSON outside the repository workspace plus signing/upload cleanup", "release audit must document iOS release upload asset hygiene");
  requireText(audit, "Android generated Firebase/signing-file cleanup", "release audit must document Android release secret cleanup");
  requireText(audit, "relay SSH key chmod/cleanup", "release audit must document relay deploy SSH key cleanup");
  requireText(audit, "raw adb locked-launch evidence", "release audit latest refresh must record raw adb locked-launch evidence");
  requireText(audit, "tightening release-workflow secret cleanup", "release audit latest refresh must record release workflow secret cleanup refresh");
  requireText(audit, "adb -s emulator-5554 shell cmd package resolve-activity --brief app.fieldwork.android", "release audit latest refresh must list adb activity resolution");
  requireText(audit, "adb -s emulator-5554 exec-out uiautomator dump /dev/tty", "release audit latest refresh must list direct adb UI dump");
  requireText(audit, "adb -s emulator-5554 logcat -b crash -d", "release audit latest refresh must list direct adb crash-buffer capture");
  requireText(audit, "The raw adb locked-launch refresh installed the default debug APK", "release audit must summarize the raw adb locked-launch result");
  requireText(audit, "The default `pnpm test:android-emulator` aggregate passed on `emulator-5554`", "release audit must summarize the default Android emulator aggregate result");
  requireText(audit, "The release-workflow secret hygiene refresh also passed", "release audit must summarize release workflow secret hygiene verification");
  requireText(audit, "`release-rust.yml` decodes Apple signing/notarization assets under\n`RUNNER_TEMP`", "release audit must record release-rust temp signing cleanup");
  requireText(audit, "`release-ios.yml` keeps App\nStore Connect upload JSON outside the repository workspace", "release audit must record release-ios upload JSON hygiene");
  requireText(audit, "`release-android.yml` removes generated Firebase/signing\nfiles in an `always()` cleanup step", "release audit must record release-android generated secret cleanup");
  requireText(audit, "`deploy-relay.yml` removes the decoded\nrelay SSH key in an `always()` cleanup step", "release audit must record deploy-relay SSH cleanup");
  requireText(audit, "LC_ALL=C LANG=C shasum -a 256", "release audit must record macOS-safe release-rust checksum locale");
  requireText(audit, "unsupported inherited\n`C.UTF-8` locale settings", "release audit must record the checksum locale failure mode");
  requireText(audit, "all passed except `pnpm check:ios-prereqs`", "release audit must record the latest focused result summary");
  requireText(audit, "repo-owned Xcode download, install, `xcode-select`, first-launch, rerun", "release audit must record iOS prereq recovery output");
  requireText(audit, "Desktop performance passed after one explicit warm-up sample", "release audit must record latest desktop performance result");
  requireText(audit, "preserved AAB, staged npm binaries, npm publish readiness, meta-package dry-run\npack, local handoff smoke, demo video, site typecheck/build, Terraform\nfmt/init/validate, relay TLS/OTLP loopbacks, and desktop performance", "release audit must record latest aggregate local release gate coverage");
  requireText(audit, "`3.10ms`, p95 `3.36ms`, max `3.45ms`", "release audit must record latest CLI desktop performance values");
  requireText(audit, "`41.15ms`, p95 `43.23ms`, max `47.78ms`", "release audit must record latest daemon desktop performance values");
  requireText(audit, "npm binary readiness passed\nwith staged artifacts", "release audit must record staged npm binary readiness");
  requireText(audit, "Cross-target desktop release builds passed on 2026-05-19", "release audit must record the latest cross-target desktop release build date");
  requireText(audit, "Mach-O arm64/x86_64 and ELF x86-64/aarch64 binaries", "release audit must record cross-target binary format verification");
  requireText(audit, "fieldwork-darwin-arm64 -> fieldwork-darwin-x64 ->\nfieldwork-linux-arm64 -> fieldwork-linux-x64 -> fieldwork", "release audit must record current children-first npm readiness order");
  requireText(audit, "`fieldwork@1.0.0` meta\npackage with only `LICENSE`, `NOTICE`, `README.md`, `bin/fieldwork`,\n`bin/fieldworkd`, `install.js`, and `package.json`", "release audit must record meta package dry-run contents");
  requireText(audit, "found no `npm_...` auth-token strings", "release audit must record local npm token-pattern scan result");
  requireText(audit, "`tests::rejects_cross_daemon_token_use` is the explicit Section 7.3.1 gate", "release audit must cite the cross-daemon token ownership unit test");
  requireText(audit, "daemon B receives `403 Forbidden`", "release audit must record the forbidden cross-daemon push result");
  requireText(audit, "Section 7.3.1 cross-daemon token-use no-ship gate", "release audit must record the latest focused relay ownership smoke");
  requireText(audit, "Bun optional\ndependency install compatibility passed across four platform cases on Bun\n1.3.13", "release audit must record the latest focused Bun optional-dependency smoke");
  requireText(audit, "preserved release AAB", "release audit must record that the release AAB survived cleanup");
  requireText(audit, "rejected repository npm token strings and\n`.npmrc` files", "release audit must record npm token and .npmrc secret-boundary coverage");
  requireText(audit, "npm auth-token patterns", "release audit must record artifact npm auth-token pattern scanning");
  requireText(audit, "scanned 32 non-relay artifacts", "release audit must record the staged npm platform and Android secret-boundary artifact scan");
  requireText(audit, "latest\n`pnpm check:secret-boundaries` scan covered 24 retained non-relay artifacts and\nstill passed", "release audit must record the current post-cleanup secret-boundary scan");
  requireText(audit, "verifier now streams artifact scans instead of materializing\nlarge native binaries as one string", "release audit must record streaming artifact secret-boundary scans");
  requireText(plan, "latest local `pnpm check:secret-boundaries` run scanned 24 retained non-relay artifacts and still passed", "PLAN.md must record the current post-cleanup secret-boundary scan");
  requireText(plan, "verifier now streams artifact scans instead of materializing large native binaries as one string", "PLAN.md must record streaming artifact secret-boundary scans");
  requireText(plan, "has a Terraform Validate job that installs Terraform 1.5.7 and runs the shared cleanup-on-exit Terraform fmt/init/validate script against the Oracle scaffold", "PLAN.md must record the CI Terraform validation job");
  for (const artifact of [
    "`packages/cli-darwin-arm64/bin/fieldwork`",
    "`packages/cli-darwin-arm64/bin/fieldworkd`",
    "`packages/cli-darwin-x64/bin/fieldwork`",
    "`packages/cli-darwin-x64/bin/fieldworkd`",
    "`packages/cli-linux-arm64/bin/fieldwork`",
    "`packages/cli-linux-arm64/bin/fieldworkd`",
    "`packages/cli-linux-x64/bin/fieldwork`",
    "`packages/cli-linux-x64/bin/fieldworkd`",
    "`packages/cli/bin/fieldwork`",
    "`packages/cli/bin/fieldworkd`",
    "`target/aarch64-apple-darwin/release/fieldwork`",
    "`target/aarch64-apple-darwin/release/fieldworkd`",
    "`target/aarch64-linux-android/release/deps/libfieldwork_mobile_core.a`",
    "`target/aarch64-linux-android/release/deps/libfieldwork_mobile_core.so`",
    "`target/aarch64-linux-android/release/libfieldwork_mobile_core.a`",
    "`target/aarch64-linux-android/release/libfieldwork_mobile_core.so`",
    "`target/aarch64-unknown-linux-gnu/release/fieldwork`",
    "`target/aarch64-unknown-linux-gnu/release/fieldworkd`",
    "`target/armv7-linux-androideabi/release/deps/libfieldwork_mobile_core.a`",
    "`target/armv7-linux-androideabi/release/deps/libfieldwork_mobile_core.so`",
    "`target/armv7-linux-androideabi/release/libfieldwork_mobile_core.a`",
    "`target/armv7-linux-androideabi/release/libfieldwork_mobile_core.so`",
    "`target/release/fieldwork`",
    "`target/release/fieldworkd`",
    "`target/x86_64-apple-darwin/release/fieldwork`",
    "`target/x86_64-apple-darwin/release/fieldworkd`",
    "`target/x86_64-linux-android/release/deps/libfieldwork_mobile_core.a`",
    "`target/x86_64-linux-android/release/deps/libfieldwork_mobile_core.so`",
    "`target/x86_64-linux-android/release/libfieldwork_mobile_core.a`",
    "`target/x86_64-linux-android/release/libfieldwork_mobile_core.so`",
    "`target/x86_64-unknown-linux-gnu/release/fieldwork`",
    "`target/x86_64-unknown-linux-gnu/release/fieldworkd`",
  ]) {
    requireText(audit, artifact, `release audit staged secret-boundary artifact list must include ${artifact}`);
  }
  requireText(
    audit,
    "Sigstore media-type, transparency-log, DSSE\n  envelope/signature, in-toto payload, SLSA `predicateType`, subject-name,\n  subject-digest, official-repository `buildType`, package, target, requested\n  release-tag, and SHA-256 external-parameter validation",
    "release audit must record strict release artifact DSSE/SLSA field validation",
  );
  requireText(audit, "missing platform-root rejection", "release audit must record npm artifact missing platform-root rejection");
  requireText(
    audit,
    "non-native platform package publish rejection in both readiness and actual publish paths",
    "release audit must record npm readiness and real-publish native-binary rejection",
  );
  requireText(audit, "v1.0.0 package manifests", "release audit must record npm package version readiness");
  requireText(audit, "real staged desktop binary readiness", "release audit must record staged npm platform binary readiness");
  requireText(
    audit,
    ".gitignore` protection for generated platform native bins",
    "release audit must record source-control hygiene for generated npm native bins",
  );
  requireText(
    audit,
    "tracked generated-native-bin rejection in `scripts/verify-npm-packages.mjs`",
    "release audit must record the package verifier tracked-generated-binary guard",
  );
  requireText(
    audit,
    "real staged desktop binary readiness without committing generated native package artifacts",
    "release audit must distinguish staged package binaries from committed source",
  );
  requireText(audit, "real npm publish blocked by platform child publish rights plus a release-scoped npm token", "release audit must record the current npm publish blocker");
  requireText(audit, "The unscoped `fieldwork` meta package is operator-owned", "release audit must record the owned unscoped npm package name");
  requireText(audit, "no further npm\n  name-availability checks are needed for it", "release audit must avoid treating the owned npm name as an availability task");
  requireText(audit, "Live `verify-npm-registry-state` use is reserved for post-placeholder and\npost-release registry-state/provenance verification", "release audit must reserve live npm registry checks for release-state verification");
  requireText(audit, "Bare registry-state invocations now fail closed unless an explicit\nrelease-state expectation flag is provided", "release audit must record bare npm registry-state fail-closed behavior");
  requireText(audit, "post-placeholder platform-published state", "release audit must record post-placeholder npm registry-state checking");
  requireText(audit, "post-release latest-version/provenance state", "release audit must record post-release npm version/provenance checking");
  requireText(audit, "post-publish public registry verification", "release audit must record post-publish npm registry verification");
  requireText(audit, "post-publish npm registry/provenance verification with propagation retries", "release audit must record release-npm registry/provenance retry verification");
  requireText(audit, "`--expect-platform-published`", "release audit must document the post-placeholder npm package-family check");
  requireText(audit, "`--expect-latest-version=1.0.0 --expect-provenance`", "release audit must document the post-release npm dist-tag and provenance check");
  requireText(audit, "post-publish registry-state and\n  provenance verification", "release audit must record latest post-publish registry/provenance verifier coverage");
  requireText(audit, "This is not proof of platform child\npublish rights", "release audit must not treat npm registry state as platform-child publish proof");
  requireText(audit, "GitHub namespace availability refresh is no longer an agent-owned routine\nrelease activity", "release audit must keep GitHub namespace checks out of routine agent work");
  requireText(audit, "requires `--operator-refresh --expect-available`", "release audit must record GitHub namespace refresh opt-in flag");
  requireText(audit, "explicit operator-requested status refreshes", "release audit must reserve external status checks for operator requests");
  requireText(audit, "fails closed before network access\nwithout `--operator-refresh`", "release audit must record GitHub namespace fail-closed behavior");
  requireText(audit, "daemon service preflight refresh passed", "release audit must record the focused daemon service preflight refresh");
  requireText(audit, "`fieldwork daemon install`/`restart` only", "release audit must record that macOS Gatekeeper preflight is scoped to service operations");
  requireText(audit, "Direct daemon auto-spawn still uses\nthe colocated `fieldworkd` path without `spctl`", "release audit must record that direct daemon auto-spawn is not gated by spctl");
  requireText(audit, "`target/release/fieldworkd: rejected`", "release audit must record current read-only spctl evidence");
  requireText(audit, "current Codex CLI surface is preserved", "release audit must record the current Codex command-surface decision");
  requireText(audit, "unsupported `--remote-control` flag", "release audit must reject mutating the user's Codex PTY command into an unsupported flag");
  requireText(audit, "Rust workspace verifier passed", "release audit must record the focused Rust workspace verifier result");
  requireText(audit, "exact five-crate", "release audit must record exact workspace member coverage");
  requireText(audit, "`fieldwork`/`fieldworkd`/", "release audit must record all desktop/relay binary declarations");
  requireText(audit, "docs-sync verifier passed", "release audit must record the focused docs-sync verifier result");
  requireText(audit, "named v1 docs", "release audit must record named docs synchronization coverage");
  requireText(audit, "development doc verifier passed", "release audit must record the focused development doc verifier result");
  requireText(audit, "15-minute source-build path", "release audit must record development source-build coverage");
  requireText(audit, "focused protocol/PTY/mobile-core tests", "release audit must record development focused-test coverage");
  requireText(audit, "iOS prereq edge-case test passed", "release audit must record deterministic iOS prereq test coverage");
  requireText(audit, "missing `.xcode-version`, exact selected-Xcode comparison, and floored 70 GiB download headroom", "release audit must record exact iOS prereq test edges");
  requireText(audit, "desktop release/performance commands", "release audit must record development desktop release/performance coverage");
  requireText(audit, "UniFFI bindgen", "release audit must record development UniFFI coverage");
  requireText(audit, "iOS/Android development flows", "release audit must record development mobile-flow coverage");
  requireText(audit, "mobile privacy/telemetry facts", "release audit must record development mobile privacy/telemetry coverage");
  requireText(audit, "scripts/verify-development-doc.mjs", "release audit must cite the development doc verifier");
  requireText(audit, "community scaffold verifier passed", "release audit must record the focused community scaffold verifier result");
  requireText(audit, "PR/issue templates", "release audit must record community template coverage");
  requireText(audit, "pre-commit hooks", "release audit must record pre-commit hook coverage");
  requireText(audit, "always-run workspace/security gates", "release audit must record pre-commit secret-boundary coverage");
  requireText(audit, "security model verifier passed", "release audit must record the focused security model verifier result");
  requireText(audit, "v1 trust zones", "release audit must record security trust-zone coverage");
  requireText(audit, "local IPC hardening", "release audit must record security local IPC coverage");
  requireText(audit, "pairing/device auth", "release audit must record security pairing/device auth coverage");
  requireText(audit, "encrypted local storage", "release audit must record security at-rest storage coverage");
  requireText(audit, "raw-byte terminal privacy", "release audit must record security terminal privacy coverage");
  requireText(audit, "relay push controls", "release audit must record security relay push coverage");
  requireText(audit, "mobile biometric gates", "release audit must record security mobile biometric coverage");
  requireText(audit, "scripts/verify-security-model.mjs", "release audit must cite the security model verifier");
  requireText(audit, "infra scaffold verifier passed", "release audit must record the focused infra scaffold verifier result");
  requireText(audit, "operations runbook's", "release audit must record operations runbook coverage");
  requireText(audit, "relay prerequisites", "release audit must record operations prerequisite coverage");
  requireText(audit, "quarterly credential rotation steps", "release audit must record operations rotation coverage");
  requireText(audit, "token-deletion flow", "release audit must record operations token-deletion coverage");
  requireText(audit, "committed\nTerraform OCI provider lockfile", "release audit must record Terraform provider lockfile coverage");
  requireText(audit, "A follow-up\nTerraform validation pass ran", "release audit must record the focused Terraform validation pass");
  requireText(audit, "`pnpm check:infra-terraform`", "release audit must record the shared Terraform check script");
  requireText(audit, "initialization installed the signed OCI provider from the lockfile", "release audit must record Terraform OCI provider initialization evidence");
  requireText(audit, "`Success! The configuration is valid.`", "release audit must record Terraform validate success");
  requireText(audit, "shared script removed\nthe ignored `.terraform` provider cache afterward without producing `tfstate` or\n`tfvars` files", "release audit must record Terraform validation cleanup");
  requireText(audit, "site content verifier passed", "release audit must record the focused site content verifier result");
  requireText(audit, "screenshot SVG imports", "release audit must record site screenshot asset coverage");
  requireText(audit, "docs/assets/fieldwork-demo-v1.mp4", "release audit must record the demo video artifact");
  requireText(audit, "pnpm render:demo-video", "release audit must document demo video regeneration");
  requireText(audit, "pnpm check:demo-video", "release audit must document demo video verification");
  requireText(audit, "H.264 1920x1080", "release audit must record demo video media contract");
  requireText(audit, "approximately 60-second duration", "release audit must record demo video duration contract");
  requireText(audit, "future-scope exclusions", "release audit must record site future-scope exclusion coverage");
  requireText(audit, "operator-only external status refresh commands are deliberately not part of\nthe routine focused-check list", "release audit must keep operator-only refresh commands out of routine checks");
  requireText(audit, "pnpm refresh:domain-status -- --require-registered --require-dns", "release audit must document the operator-only domain refresh command");
  requireText(audit, "pnpm refresh:github-namespace -- --expect-available", "release audit must document the operator-only GitHub refresh command");
  requireText(audit, "Domain status refresh is no longer an agent-owned routine release activity", "release audit must keep domain status checks out of routine agent work");
  requireText(audit, "`scripts/check-domain-status.mjs --operator-refresh` remains available for explicit operator-requested refreshes only", "release audit must reserve domain status checks for operator requests");
  requireText(audit, "fails closed before network access without that flag", "release audit must record domain refresh fail-closed behavior");
  requireText(audit, "Cloudflare Pages deploy scaffold", "release audit must record focused site deploy verification");
  requireText(audit, "isolated site lockfile install", "release audit must record site lockfile install coverage");
  requireText(audit, "fail-closed Cloudflare credentials", "release audit must record site deploy credential-gate coverage");
  requireText(audit, "`fieldwork-dev` Pages project", "release audit must record Cloudflare Pages project coverage");
  requireText(audit, "weekly Dependabot matrix", "release audit must record focused Dependabot verification");
  requireText(audit, "Cargo, root npm package metadata, the isolated `site/` npm lockfile, Android Gradle, and GitHub Actions", "release audit must record exact Dependabot ecosystem coverage");
  requireText(audit, "state-inference fixture tests passed", "release audit must record focused state-inference verification");
  requireText(audit, "local-agent-hook tests passed", "release audit must record focused local agent hook verification");
  requireText(audit, "matching_local_agent_hook_updates_session_state", "release audit must record matching local hook test name");
  requireText(audit, "mismatched_local_agent_hook_is_ignored", "release audit must record mismatched local hook test name");
  requireText(audit, "matching LocalCli Claude/Codex hook events update only matching PTY sessions", "release audit must record local hook matching semantics");
  requireText(audit, "mismatched hook sources are ignored", "release audit must record local hook mismatch semantics");
  requireText(audit, "service scaffold verifier passed", "release audit must record focused daemon-service verification");
  requireText(audit, "fake-command `service-manager` rendering tests", "release audit must record service-manager rendering tests");
  requireText(audit, "LaunchAgent `KeepAlive`/`SuccessfulExit=false`", "release audit must record launchd restart rendering verification");
  requireText(audit, "systemd `Restart=on-failure`/`RestartSec=5`", "release audit must record systemd restart rendering verification");
  requireText(audit, "fake `launchctl`/`systemctl`", "release audit must record fake service commands");
  requireText(audit, "direct bincode IPC mobile create/kill rejection test passed", "release audit must record direct IPC mobile capability verification");
  requireText(audit, "direct bincode IPC mobile agent-state hook rejection test passed", "release audit must record direct IPC mobile hook-event verification");
  requireText(audit, "focused daemon multi-attach test", "release audit must record focused multi-attach PTY verification");
  requireText(audit, "two attached", "release audit must record both attached clients in focused multi-attach verification");
  requireText(audit, "focused iroh peer-identity test", "release audit must record focused iroh peer-identity verification");
  requireText(audit, "authenticated iroh peer identity", "release audit must record authenticated iroh identity semantics");
  requireText(audit, "local handoff smoke now also covers paired iroh mobile agent-state hook rejection", "release audit must record iroh mobile hook-event verification");
  requireText(audit, "warm reconnect replay over iroh within 2 seconds from `last_seen_seq`", "release audit must record local iroh reconnect replay timing coverage");
  requireText(audit, "direct bincode IPC protocol-mismatch tests", "release audit must record direct IPC protocol-mismatch verification");
  requireText(audit, "local iroh handoff smoke protocol-mismatch rejection", "release audit must record iroh protocol-mismatch verification");
  requireText(audit, "pnpm test:local-handoff", "release audit must record the local handoff smoke invocation");
  requireText(audit, "clearing\n  reproducible debug/mobile Rust build output to recover disk space", "release audit must record local handoff disk-space recovery");
  requireText(audit, "removing the regenerated repo-local `target/debug` after the run", "release audit must record local handoff target/debug cleanup");
  requireText(audit, "`IosApp` and `AndroidApp`", "release audit must record both mobile client kinds in capability verification");
  requirePattern(audit, /paired in\s+2 seconds/, "release audit must record the latest local handoff pair duration");
  requireText(audit, "17ms in the latest local run", "release audit must record the latest local iroh reconnect timing");
  requireText(audit, "`cargo nextest run --workspace`: 157 tests passed.", "release audit must record the current workspace nextest count");
  requireText(audit, "`cargo test --workspace`: 157 unit/integration tests passed, plus doctests.", "release audit must record the current workspace cargo test count");
  requireText(audit, "`cargo test -p fieldwork-daemon`: 68 daemon tests passed", "release audit must record the current daemon test count");
  requireText(audit, "`cargo deny check`: exited successfully with `advisories ok, bans ok,\n  licenses ok, sources ok`", "release audit must record the current cargo-deny category result");
  requireText(audit, "duplicate-crate findings were warnings only", "release audit must distinguish cargo-deny duplicate warnings from deny failures");
  requireText(audit, "`cargo audit`: exited successfully with allowed warnings only (`adler`,\n  `bincode`, `paste`, `lru`)", "release audit must record the current cargo-audit warning set");
  requireText(audit, "`cargo update -p lru@0.12.5 --dry-run` found no\n  compatible lockfile move", "release audit must record the lru advisory dry-run update check");
  requireText(audit, "Fieldwork does not call `lru::IterMut` directly", "release audit must record direct lru IterMut non-use");
  requireText(audit, "decode generated base32 tokens back to 32 bytes", "release audit must record 32-byte base32 pair-token coverage");
  requireText(audit, "10-minute expiry window", "release audit must record pair-token TTL coverage");
  requireText(audit, "pre-approval single-use consumption", "release audit must record pair-token single-use coverage");
  requireText(audit, "success only after explicit approval", "release audit must record explicit desktop approval coverage");
  requireText(audit, "Attached.seq", "release audit must record PTY reconnect seq semantics");
  requireText(audit, "Output.seq", "release audit must record PTY output seq semantics");
  requireText(audit, "byte offset immediately after the bytes", "release audit must record after-bytes seq meaning");
  requireText(audit, "lag_event_notifies_native_ui_and_stops_for_resync", "release audit must record focused mobile-core lag resync coverage");
  requireText(audit, "single `Lag` delivery before reattach/resync", "release audit must record mobile lag reattach semantics");
  requireText(audit, "SwiftTerm raw byte-array renderer guard", "release audit must record SwiftTerm raw byte-array renderer verification");
  requireText(audit, "iOS `lastSeenSeq` lag-reattach static checks", "release audit must record iOS lag reattach verification");
  requireText(audit, "iOS raw `Data` delivery plus SwiftTerm raw\nbyte-array rendering", "release audit must record iOS raw data renderer verification");
  requireText(audit, "service-backed `lastSeenSeq` lag reattach wiring", "release audit must record iOS service-backed lag reattach wiring");
  requireText(audit, "Android JVM tests cover first unlock, immediate post-unlock resume, fresh foreground resume, 5-minute stale foreground boundary, terminal input refusal while locked", "release audit must record Android biometric freshness coverage");
  requireText(audit, "`BIOMETRIC_STRONG`-only prompt", "release audit must record Android biometric-only prompt coverage");
  requireText(audit, "Android raw `ByteArray` to termlib", "release audit must record Android raw terminal byte delivery verification");
  requireText(audit, "`lastSeenSeq` lag-reattach static checks", "release audit must record Android lag reattach verification");
  requireText(audit, "rejects Android terminal-output string\ndecoding", "release audit must record Android string-decoding guard");
  requireText(audit, "repository-backed `lastSeenSeq` lag reattach wiring", "release audit must record Android repository-backed lag reattach wiring");
  requireText(audit, "attached-stream-error reattach", "release audit must record Android attached-stream-error reattach coverage");
  requireText(audit, "generated `SessionId`/`ClientId` UUIDv7 checks", "release audit must record focused UUIDv7 protocol coverage");
  requireText(audit, "`now_ms()` UTC Unix-millisecond window checks", "release audit must record focused UTC millisecond timestamp coverage");
  requireText(audit, "all-message MessagePack client/server frame round-trip tests", "release audit must record focused MessagePack protocol coverage");
  requireText(audit, "negative bincode frame tests", "release audit must record protocol framing error coverage");
  requireText(audit, "bincode 2 legacy-layout", "release audit must record the pinned bincode legacy-layout coverage");
  requireText(audit, "trailing-payload rejection tests", "release audit must record trailing bincode payload rejection coverage");
  requireText(audit, "symlinked existing socket rejection", "release audit must record existing socket symlink coverage");
  requireText(audit, "private `0700` persistence parents", "release audit must record local persistence parent-mode coverage");
  requireText(audit, "`0600` database files", "release audit must record local persistence file-mode coverage");
  requireText(audit, "symlink rejection for persistence directories and database files", "release audit must record local persistence symlink coverage");
  requireText(audit, "separate production-like `sessions.redb`/`devices.redb` layouts", "release audit must record production-like separate persistence store coverage");
  requireText(audit, "hashed device row keys", "release audit must record hashed at-rest device-registry keys");
  requireText(audit, "exact outbound JSON key sets", "release audit must record provider payload JSON-shape coverage");
  requireText(audit, "fixed alert copy", "release audit must record provider fixed-copy coverage");
  requireText(audit, "Android JVM tests prove tap parsing trims but never lowercases uppercase hashes", "release audit must record Android tap parser unit coverage");
  requireText(audit, "foreground notifications use fixed generic copy and private lock-screen visibility", "release audit must record Android fixed-copy notification unit coverage");
  requireText(audit, "invalid event types or invalid hashes do not post notifications", "release audit must record Android invalid notification rejection unit coverage");
  requireText(audit, "view model now routes push taps\nthrough the same strict lowercase `session_id_hash` parser", "release audit must record strict Android view model tap routing");
  requireText(audit, "keeps valid taps pending while locked", "release audit must record Android locked push-tap pending behavior");
  requireText(audit, "resolves them after unlock plus\nsession refresh or later subscription updates", "release audit must record Android push-tap unlock/session-refresh routing behavior");
  requireText(audit, "routes unlocked taps against the\ncurrent session list", "release audit must record Android unlocked push-tap routing behavior");
  requireText(audit, "clears stale pending routes before rejecting invalid\nuppercase hashes after unlock", "release audit must record Android invalid push-tap rejection after unlock");
  requireText(audit, "applies session subscription updates to the\ndashboard list", "release audit must record Android dashboard subscription update coverage");
  requireText(audit, "Pairing while already unlocked loads sessions, starts the same\nsubscription path, and syncs queued/current FCM tokens", "release audit must record Android pair-time ViewModel coverage");
  requireText(audit, "pairing while locked\ndoes not load sessions, subscribe, or sync FCM tokens", "release audit must record Android locked pair-time ViewModel coverage");
  requireText(audit, "Locking stops subscription\nupdates from changing the dashboard", "release audit must record Android lock-time subscription stop coverage");
  requireText(audit, "queues trimmed tokens in backup-excluded\n`fieldwork_push_tokens.xml`", "release audit must record Android queued FCM token privacy behavior");
  requireText(audit, "keeps the Firebase service from directly\nregistering tokens", "release audit must record Android FCM service no-direct-registration behavior");
  requireText(audit, "sends/clears queued tokens only through the\npaired-and-unlocked sync path", "release audit must record Android paired-and-unlocked token sync behavior");
  requireText(audit, "Focused FieldworkViewModel JVM tests now verify paired-but-locked FCM sync does\nnot register tokens", "release audit must record Android ViewModel locked token-sync coverage");
  requireText(audit, "duplicate queued/current tokens are\nregistered once", "release audit must record Android ViewModel duplicate-token dedupe coverage");
  requireText(audit, "FieldworkViewModel JVM coverage verifies construction does not block on\nsaved-pairing restore", "release audit must record Android ViewModel startup-restore JVM coverage");
  requireText(audit, "stale startup-restore results cannot override an\nexplicit pairing", "release audit must record Android stale restore JVM coverage");
  requireText(audit, "hash-only event data", "release audit must record provider hash-only data coverage");
  requireText(audit, "APNs BadDeviceToken stale-token pruning from memory and SQLite", "release audit must record provider stale-token pruning coverage");
  requireText(audit, "forbidden reuse after relay restart", "release audit must record stale-token restart verification");
  requireText(audit, "FCM UNREGISTERED stale-token signal parsing", "release audit must record FCM stale-token parser coverage");
  requireText(audit, "90-day no-use push-token pruning", "release audit must record relay token-retention pruning coverage");
  requireText(audit, "accepted-push last-used timestamp refresh", "release audit must record relay token-retention touch-on-use coverage");
  requireText(audit, "`session_id_hash` and `session_name_hash`", "release audit must record push hash-field validation coverage");
  requireText(audit, "rejects `last_line`, command, path, and session-name", "release audit must record free-text push-field rejection coverage");
  requireText(audit, "Mobile notification ingress now mirrors that contract", "release audit must record native notification hash-validation coverage");
  requireText(audit, "focused Android JVM unit coverage", "release audit must record Android notification hash unit-test coverage");
  requireText(audit, "`8fb83e440fc68b500e6f10a6fbc40ba43279d5992e1d8fa87a942e9e79657efd`", "release audit must record the current Android release AAB SHA-256");
  requireText(audit, "`--expect-unsigned`", "release audit must record local unsigned AAB verification");
  requireText(audit, "`jar is unsigned`", "release audit must record local jarsigner unsigned result");
  requireText(audit, "release workflow verifier rejects using\n  `node scripts/verify-android-aab.mjs --expect-unsigned`", "release audit must record release workflow unsigned-mode rejection");
  requireText(audit, "packaged manifest privacy surface", "release audit must record Android AAB packaged manifest privacy verification");
  requireText(audit, "Firebase/Sentry opt-out metadata", "release audit must record packaged manifest opt-out metadata verification");
  requireText(plan, "focused Android JVM tests now verify locked terminal input is refused before it reaches mobile-core plus latest-`lastSeenSeq` `Lag` and attached-stream-error reattach", "PLAN.md must record focused Android locked-input and lag/stream-error reattach coverage");
  requireText(plan, "latest direct adb emulator QA refresh installed the default debug APK", "PLAN.md must record the latest direct adb emulator QA refresh");
  requireText(plan, "`Status: ok` and `TotalTime=5297ms`", "PLAN.md must record the latest raw adb launch status and timing");
  for (const evidence of [
    "`/tmp/fieldwork-adb-direct-20260519225027/default.png`",
    "`/tmp/fieldwork-adb-direct-20260519225027/default-ui.xml`",
    "`/tmp/fieldwork-adb-direct-20260519225027/default-logcat.log`",
    "`/tmp/fieldwork-adb-direct-20260519225027/default-crash.log`",
    "debug-only `FIELDWORK_ANDROID_PAIRING_PAYLOAD`",
    "`TotalTime=4589ms`",
    "UI-tree-derived Pair center `540 1860`",
    "`pair_flow_ms=1043`",
    "paired through explicit desktop approval",
    "`ANDROID_ADB_DIRECT_READY`",
    "`fw_android_direct_ok`",
    "`/tmp/fieldwork-adb-direct-pair-20260519225208/before-pair.png`",
    "`/tmp/fieldwork-adb-direct-pair-20260519225208/sessions.png`",
    "`/tmp/fieldwork-adb-direct-pair-20260519225208/terminal-before-input.png`",
    "`/tmp/fieldwork-adb-direct-pair-20260519225208/terminal-after-input.png`",
    "`android-direct: fw_android_direct_ok`",
    "`FIELDWORK_BIOMETRIC_BYPASS = false`",
    '`FIELDWORK_DEBUG_PAIRING_PAYLOAD = ""`',
    "`TotalTime=5105ms`",
    "`/tmp/fieldwork-adb-direct-restore-20260519225316/restored-locked.png`",
    "`/tmp/fieldwork-adb-direct-restore-20260519225316/restored-ui.xml`",
  ]) {
    requireText(plan, evidence, `PLAN.md latest raw adb QA evidence must include ${evidence}`);
  }
  requireText(plan, "empty `FIELDWORK_DEBUG_PAIRING_PAYLOAD`", "PLAN.md must record restored empty Android debug pairing payload");
  for (const evidence of [
    "Android aggregate emulator QA note",
    "`pnpm test:android-emulator` aggregates the direct-adb emulator substitutes",
    "retries only a locked debug-launch timing outlier once with the same strict limit",
    "`TotalTime=7920ms`",
    "`pair_flow_ms=2234`",
    "`visible_ms=3318`",
    "8440/14400 nonblack samples",
    "successful background replay, restart restore, multisession, reconnect, and notification tap routing",
  ]) {
    requireText(plan, evidence, `PLAN.md aggregate Android emulator evidence must include ${evidence}`);
  }
  for (const evidence of [
    "Hosted Sentry receipt remains unchecked until a real Sentry project/DSN and signed daemon/mobile builds are available",
    "live Honeycomb receipt gate remains unchecked until a Honeycomb account/API key and hosted relay test traces are available",
    "real macOS sleep/wake survival remains unchecked until it can be run against the signed/notarized daemon artifact",
    "real APNs/FCM provider delivery is exercised 10/10 on physical devices",
    "relay validators and provider-client tests assert fixed alert copy, lowercase hash-only data fields",
    "actual APNs/FCM payload is inspected in transit with a test device",
    "`pnpm test:android-emulator-notification-tap` is the local Android substitute",
    "`notify_tap_ok` lands only in the target PTY",
    "`pnpm test:android-emulator-multisession` is the actual Android-app substitute",
    "`multi_a_ok`, `multi_b_ok`, and `multi_c_ok` land only in their selected PTYs",
  ]) {
    requireText(plan, evidence, `PLAN.md unchecked gate boundary must include ${evidence}`);
  }
  requireText(plan, "Android FCM token\nrefresh callbacks queue only trimmed pending tokens", "PLAN.md must record Android queued FCM token callbacks");
  requireText(plan, "paired-and-unlocked ViewModel sync path sends\nqueued/current tokens through mobile-core", "PLAN.md must record Android paired-and-unlocked token sync path");
  requireText(audit, "`hash_for_push` produces lowercase SHA-256 hex", "release audit must record daemon hash generation coverage");
  requireText(audit, "worker submits lowercase 64-character hex `session_id_hash` and", "release audit must record daemon push worker hash-field coverage");
  requireText(audit, "enqueues `UnregisterToken`", "release audit must record device-removal token unregister enqueue coverage");
  requireText(audit, "`/v1/push/unregister-token` without terminal-content leakage", "release audit must record push token unregister privacy coverage");
  requireText(plan, "daemon lowercase SHA-256 push-hash generation", "PLAN.md must record daemon hash generation coverage");
  requireText(plan, "daemon POST dispatch with lowercase 64-character hex `session_id_hash` and `session_name_hash`", "PLAN.md must record daemon push worker hash-field coverage");
  requireText(plan, "saved push token enqueues relay token unregistration", "PLAN.md must record device-removal token unregister enqueue coverage");
  requireText(plan, "signed `/v1/push/unregister-token` requests without terminal-content\nleakage", "PLAN.md must record push token unregister privacy coverage");
}

function verifyPlanUncheckedGatesAreReflected() {
  const uncheckedPlanLineList = plan
    .split("\n")
    .filter((line) => line.startsWith("- [ ] "));
  const uncheckedPlanLines = uncheckedPlanLineList.join("\n");

  const expectedUncheckedGates = [
    ["iOS xcframework", "ios-xcode"],
    ["Daemon signed and notarized", "signing"],
    ["iOS app signed", "signing"],
    ["Android AAB signed", "signing"],
    ["All 5 npm packages publish", "publish"],
    ["`npm publish --provenance` enabled", "publish"],
    ["`cosign attest`", "publish"],
    ["Sentry receives test crashes", "provider"],
    ["Honeycomb receives test traces", "provider"],
    ["Daemon survives `pkill -KILL fieldworkd`", "signing"],
    ["Daemon survives `sleep 30 && wake`", "physical-device"],
    ["iOS app survives `Background", "physical-device"],
    ["Android app survives same", "physical-device"],
    ["Push notifications fire reliably", "provider"],
    ["Terminal renders `yes | head -10000`", "physical-device"],
    ["iOS app cold start", "physical-device"],
    ["Android app cold start", "physical-device"],
    ["Reconnect after network change", "physical-device"],
    ["Pair flow end-to-end", "physical-device"],
    ["Face ID / BiometricPrompt required", "physical-device"],
    ["Push notification payload contains no terminal content", "provider"],
    ["App Store privacy nutrition labels filled out", "store-console"],
    ["Play Console data safety form filled out", "store-console"],
    ["Pair a fresh phone", "physical-device"],
    ["Create session from desktop CLI", "physical-device"],
    ["Tap notification", "provider"],
    ["Kill daemon, restart, sessions list shows last-known sessions", "physical-device"],
    ["Run 3 sessions in parallel", "physical-device"],
    ["Operator: confirm npm publish rights for the platform child package family", "operator"],
    ["Operator: reserve/verify control of domain `fieldwork.dev`", "operator"],
    ["Operator: create GitHub org `fieldwork-app`", "operator"],
    ["Operator: reserve `@fieldworkdev`", "operator"],
    ["Open an Oracle Cloud account", "operator"],
    ["Apply for Apple Developer Program", "operator"],
    ["Set up Sentry account", "operator"],
    ["Set up Honeycomb account", "operator"],
    ["Block out the next 10 weeks", "operator"],
  ];
  const expectedUncheckedGateNeedles = expectedUncheckedGates.map(([needle]) => needle);

  for (const line of uncheckedPlanLineList) {
    if (!expectedUncheckedGateNeedles.some((gate) => line.includes(gate))) {
      failures.push(`unchecked PLAN.md gate is not classified in release audit verifier: ${line}`);
    }
  }

  for (const [gate, blockerClass] of expectedUncheckedGates) {
    requireText(uncheckedPlanLines, gate, `PLAN.md no longer exposes unchecked gate expected by audit verifier: ${gate}`);
    requireText(
      audit,
      `\`${blockerClass}\``,
      `release audit must document blocker class ${blockerClass} for unchecked gate: ${gate}`,
    );
  }
  requireText(
    plan,
    "### 13.9 Smoke tests (run before every tag)",
    "PLAN.md must keep smoke-test gates under a distinct Section 13.9 heading",
  );
  requireText(
    uncheckedPlanLines,
    "Pair a fresh phone to a fresh daemon, see sessions list — local substitutes cover the app-side path",
    "PLAN.md fresh-phone smoke gate must distinguish local app-side pair coverage from physical-phone release evidence",
  );
  requireText(
    uncheckedPlanLines,
    "`pnpm test:android-emulator-pair` pairs the Android debug app to an isolated release daemon",
    "PLAN.md fresh-phone smoke gate must record Android emulator pair coverage",
  );
  requireText(
    uncheckedPlanLines,
    "latest direct adb pair/attach pass paired the actual Android app through explicit desktop approval",
    "PLAN.md fresh-phone smoke gate must record direct adb pair/attach evidence",
  );
  requireText(
    uncheckedPlanLines,
    "Physical-phone QR scan evidence remains required before checking this gate",
    "PLAN.md fresh-phone smoke gate must remain an unchecked physical-device release gate",
  );
  rejectText(
    plan,
    "### 13.8 Smoke tests (run before every tag)",
    "PLAN.md must not duplicate the Section 13.8 heading for smoke tests",
  );
  requireText(
    uncheckedPlanLines,
    "local publish-plan verification and `release-npm.yml` enforce this ordering",
    "PLAN.md npm publish gate must distinguish local ordering automation from real publish completion",
  );
  requireText(
    uncheckedPlanLines,
    "--expect-latest-version=\"$version\" --expect-provenance",
    "PLAN.md npm provenance gate must record the public registry provenance verifier",
  );
  requireText(
    uncheckedPlanLines,
    "this gate remains unchecked until the published registry metadata for all five packages shows SLSA provenance",
    "PLAN.md npm provenance gate must remain external until real registry metadata exists",
  );

  for (const auditPhrase of [
    "physical-device",
    "provider",
    "signing",
    "publish",
    "hosted infrastructure",
    "Appendix B external reservations",
  ]) {
    requireText(audit, auditPhrase, `release audit must reflect unchecked gates around: ${auditPhrase}`);
  }
}

function verifyPlanSectionNumbering() {
  const seen = new Map();

  for (const line of plan.split("\n")) {
    const match = line.match(/^### (13\.\d+) /);
    if (!match) {
      continue;
    }

    const section = match[1];
    const previous = seen.get(section);
    if (previous) {
      failures.push(`PLAN.md duplicates Section ${section}: "${previous}" and "${line}"`);
    } else {
      seen.set(section, line);
    }
  }
}

function verifyVerifierIsWired() {
  if (packageJson.scripts?.["check:rust-workspace"] !== "node scripts/verify-rust-workspace.mjs") {
    failures.push("package.json must expose check:rust-workspace");
  }
  if (packageJson.scripts?.["check:docs-sync"] !== "node scripts/verify-docs-sync.mjs") {
    failures.push("package.json must expose check:docs-sync");
  }
  if (packageJson.scripts?.["check:development-doc"] !== "node scripts/verify-development-doc.mjs") {
    failures.push("package.json must expose check:development-doc");
  }
  if (packageJson.scripts?.["check:community-scaffold"] !== "node scripts/verify-community-scaffold.mjs") {
    failures.push("package.json must expose check:community-scaffold");
  }
  if (packageJson.scripts?.["check:security-model"] !== "node scripts/verify-security-model.mjs") {
    failures.push("package.json must expose check:security-model");
  }
  if (packageJson.scripts?.["check:mobile-privacy"] !== "node scripts/verify-mobile-privacy.mjs") {
    failures.push("package.json must expose check:mobile-privacy");
  }
  if (packageJson.scripts?.["check:store-privacy"] !== "node scripts/verify-store-privacy.mjs") {
    failures.push("package.json must expose check:store-privacy");
  }
  if (packageJson.scripts?.["check:telemetry-privacy"] !== "node scripts/verify-telemetry-privacy.mjs") {
    failures.push("package.json must expose check:telemetry-privacy");
  }
  if (packageJson.scripts?.["check:v1-boundary"] !== "node scripts/verify-v1-boundary.mjs") {
    failures.push("package.json must expose check:v1-boundary");
  }
  if (packageJson.scripts?.["check:release-audit"] !== "node scripts/verify-release-audit.mjs") {
    failures.push("package.json must expose check:release-audit");
  }
  if (packageJson.scripts?.["check:release-workflows"] !== "node scripts/verify-release-workflows.mjs") {
    failures.push("package.json must expose check:release-workflows");
  }
  if (packageJson.scripts?.["check:release-artifacts"] !== "node scripts/verify-release-artifacts.mjs") {
    failures.push("package.json must expose check:release-artifacts");
  }
  if (packageJson.scripts?.["check:local-release"] !== "node scripts/check-local-release.mjs") {
    failures.push("package.json must expose check:local-release");
  }
  if (packageJson.scripts?.["check:secret-boundaries"] !== "node scripts/verify-secret-boundaries.mjs") {
    failures.push("package.json must expose check:secret-boundaries");
  }
  if (packageJson.scripts?.["check:infra-scaffold"] !== "node scripts/verify-infra-scaffold.mjs") {
    failures.push("package.json must expose check:infra-scaffold");
  }
  if (packageJson.scripts?.["check:infra-terraform"] !== "scripts/check-infra-terraform.sh") {
    failures.push("package.json must expose check:infra-terraform");
  }
  if (packageJson.scripts?.["check:site-content"] !== "node scripts/verify-site-content.mjs") {
    failures.push("package.json must expose check:site-content");
  }
  if (packageJson.scripts?.["check:site"] !== "pnpm --dir site check") {
    failures.push("package.json must expose check:site");
  }
  if (packageJson.scripts?.["build:site"] !== "pnpm --dir site build") {
    failures.push("package.json must expose build:site");
  }
  if (packageJson.scripts?.["render:demo-video"] !== "node scripts/render-demo-video.mjs") {
    failures.push("package.json must expose render:demo-video");
  }
  if (packageJson.scripts?.["generate:oss-notices"] !== "node scripts/generate-oss-notices.mjs") {
    failures.push("package.json must expose generate:oss-notices");
  }
  if (packageJson.scripts?.["measure:desktop-performance"] !== "node scripts/measure-desktop-performance.mjs") {
    failures.push("package.json must expose measure:desktop-performance");
  }
  if (packageJson.scripts?.["check:demo-video"] !== "node scripts/verify-demo-video.mjs") {
    failures.push("package.json must expose check:demo-video");
  }
  if (packageJson.scripts?.["check:android-aab"] !== "node scripts/verify-android-aab.mjs --expect-unsigned") {
    failures.push("package.json must expose check:android-aab");
  }
  if (packageJson.scripts?.["check:daemon-service"] !== "node scripts/verify-daemon-service.mjs") {
    failures.push("package.json must expose check:daemon-service");
  }
  if (packageJson.scripts?.["check:npm-registry"] !== "node scripts/verify-npm-registry-state.mjs") {
    failures.push("package.json must expose check:npm-registry");
  }
  if (packageJson.scripts?.["check:npm-packages"] !== "node scripts/verify-npm-packages.mjs") {
    failures.push("package.json must expose check:npm-packages");
  }
  if (packageJson.scripts?.["check:changesets"] !== "node scripts/verify-changesets-config.mjs") {
    failures.push("package.json must expose check:changesets");
  }
  if (packageJson.scripts?.["check:oss-notices"] !== "node scripts/generate-oss-notices.mjs --check") {
    failures.push("package.json must expose check:oss-notices");
  }
  if (packageJson.scripts?.["check:relay-provider-clients"] !== "node scripts/verify-relay-provider-clients.mjs") {
    failures.push("package.json must expose check:relay-provider-clients");
  }
  if (packageJson.scripts?.["check:daemon-resize"] !== "node scripts/verify-daemon-resize.mjs") {
    failures.push("package.json must expose check:daemon-resize");
  }
  if (packageJson.scripts?.["test:npm-registry-state"] !== "node scripts/test-npm-registry-state.mjs") {
    failures.push("package.json must expose test:npm-registry-state");
  }
  if (packageJson.scripts?.["test:npm-dispatcher"] !== "node scripts/test-npm-dispatcher.mjs") {
    failures.push("package.json must expose test:npm-dispatcher");
  }
  if (packageJson.scripts?.["test:npm-artifacts"] !== "node scripts/test-npm-artifact-pack.mjs") {
    failures.push("package.json must expose test:npm-artifacts");
  }
  if (packageJson.scripts?.["test:npm-publish-plan"] !== "node scripts/test-npm-publish-plan.mjs") {
    failures.push("package.json must expose test:npm-publish-plan");
  }
  if (packageJson.scripts?.["test:bun-install"] !== "node scripts/test-bun-install.mjs") {
    failures.push("package.json must expose test:bun-install");
  }
  if (packageJson.scripts?.["test:release-artifacts"] !== "node scripts/test-release-artifacts.mjs") {
    failures.push("package.json must expose test:release-artifacts");
  }
  if (packageJson.scripts?.["publish:npm"] !== "node scripts/publish-npm-packages.mjs") {
    failures.push("package.json must expose publish:npm");
  }
  if (packageJson.scripts?.["test:secret-boundaries"] !== "node scripts/verify-secret-boundaries.mjs --self-test") {
    failures.push("package.json must expose test:secret-boundaries");
  }
  if (packageJson.scripts?.["refresh:domain-status"] !== "node scripts/check-domain-status.mjs --operator-refresh") {
    failures.push("package.json must expose refresh:domain-status");
  }
  if (packageJson.scripts?.["refresh:github-namespace"] !== "node scripts/check-github-namespace.mjs --operator-refresh") {
    failures.push("package.json must expose refresh:github-namespace");
  }
  if (packageJson.scripts?.["check:domain-status"] || packageJson.scripts?.["check:github-namespace"]) {
    failures.push("package.json must not expose external status refreshes as routine check:* scripts");
  }
  if (packageJson.scripts?.["test:ios-prereqs"] !== "node scripts/test-ios-prereqs.mjs") {
    failures.push("package.json must expose test:ios-prereqs");
  }
  if (packageJson.scripts?.["test:android-aab-verifier"] !== "node scripts/test-android-aab-verifier.mjs") {
    failures.push("package.json must expose test:android-aab-verifier");
  }
  if (packageJson.scripts?.["test:android-pair-button-picker"] !== "node scripts/test-android-pair-button-picker.mjs") {
    failures.push("package.json must expose test:android-pair-button-picker");
  }
  if (packageJson.scripts?.["test:external-status-refresh"] !== "node scripts/test-external-status-refresh.mjs") {
    failures.push("package.json must expose test:external-status-refresh");
  }
  if (packageJson.scripts?.["test:android-emulator"] !== "bash scripts/smoke-android-emulator-all.sh") {
    failures.push("package.json must expose test:android-emulator");
  }
  if (packageJson.scripts?.["test:android-debug-smoke"] !== "bash scripts/smoke-android-debug.sh") {
    failures.push("package.json must expose test:android-debug-smoke");
  }
  if (packageJson.scripts?.["test:android-emulator-pair"] !== "bash scripts/smoke-android-emulator-pair.sh") {
    failures.push("package.json must expose test:android-emulator-pair");
  }
  if (packageJson.scripts?.["test:android-emulator-session-subscription"] !== "bash scripts/smoke-android-emulator-session-subscription.sh") {
    failures.push("package.json must expose test:android-emulator-session-subscription");
  }
  if (packageJson.scripts?.["test:android-emulator-background-replay"] !== "bash scripts/smoke-android-emulator-background-replay.sh") {
    failures.push("package.json must expose test:android-emulator-background-replay");
  }
  if (packageJson.scripts?.["test:android-emulator-restart-restore"] !== "bash scripts/smoke-android-emulator-restart-restore.sh") {
    failures.push("package.json must expose test:android-emulator-restart-restore");
  }
  if (packageJson.scripts?.["test:android-emulator-flood"] !== "bash scripts/smoke-android-emulator-flood.sh") {
    failures.push("package.json must expose test:android-emulator-flood");
  }
  if (packageJson.scripts?.["test:android-emulator-multisession"] !== "bash scripts/smoke-android-emulator-multisession.sh") {
    failures.push("package.json must expose test:android-emulator-multisession");
  }
  if (packageJson.scripts?.["test:android-emulator-reconnect"] !== "bash scripts/smoke-android-emulator-reconnect.sh") {
    failures.push("package.json must expose test:android-emulator-reconnect");
  }
  if (packageJson.scripts?.["test:android-emulator-notification-tap"] !== "bash scripts/smoke-android-emulator-notification-tap.sh") {
    failures.push("package.json must expose test:android-emulator-notification-tap");
  }
  for (const script of [
    "scripts/smoke-android-debug.sh",
    "scripts/smoke-android-emulator-pair.sh",
    "scripts/smoke-android-emulator-session-subscription.sh",
    "scripts/smoke-android-emulator-background-replay.sh",
    "scripts/smoke-android-emulator-restart-restore.sh",
    "scripts/smoke-android-emulator-flood.sh",
    "scripts/smoke-android-emulator-multisession.sh",
    "scripts/smoke-android-emulator-reconnect.sh",
    "scripts/smoke-android-emulator-notification-tap.sh",
  ]) {
    requireText(androidEmulatorAll, script, `Android emulator aggregate must run ${script}`);
  }
  requireText(androidEmulatorAll, "--list", "Android emulator aggregate must expose a list mode");
  requireText(androidEmulatorAll, "boot-complete", "Android emulator aggregate must require a boot-complete device");
  requireText(androidEmulatorAll, "above debug smoke limit", "Android emulator aggregate must only retry debug-smoke timing outliers");
  requireText(androidEmulatorAll, "retrying once with the same strict limit", "Android emulator aggregate must document strict retry behavior");
  requireText(androidEmulatorAll, "captured output", "Android emulator aggregate must preserve failing smoke output");
  requireText(localRelease, "scripts/verify-rust-workspace.mjs", "local release gate must include Rust workspace verification");
  requireText(localRelease, "scripts/verify-release-audit.mjs", "local release gate must include release audit verification");
  requireText(localRelease, "scripts/verify-release-workflows.mjs", "local release gate must include release workflow verification");
  requireText(localRelease, "scripts/verify-secret-boundaries.mjs\", \"--self-test", "local release gate must include secret-boundary self-test coverage");
  requireText(localRelease, "scripts/test-npm-publish-plan.mjs", "local release gate must include npm publish-plan coverage");
  requireText(localRelease, "scripts/test-bun-install.mjs", "local release gate must include Bun optional-dependency coverage");
  requireText(localRelease, "scripts/test-release-artifacts.mjs", "local release gate must include release-artifact verifier coverage");
  requireText(localRelease, "scripts/test-npm-artifact-pack.mjs", "local release gate must include npm artifact-pack coverage");
  requireText(localRelease, "scripts/test-android-pair-button-picker.mjs", "local release gate must include Android pair-button picker coverage");
  requireText(localRelease, "scripts/verify-npm-packages.mjs\", \"--require-binaries", "artifact-aware local release gate must include staged npm binary verification");
  requireText(localRelease, "scripts/publish-npm-packages.mjs\", \"--check-ready", "artifact-aware local release gate must include publish-readiness verification");
  requireText(localRelease, "cleanNpmEnv()", "local release gate must clean noisy inherited npm config before dry-run pack");
  requireText(localRelease, "\"Android AAB artifact\", node, [\"scripts/verify-android-aab.mjs\", \"--expect-unsigned\"]", "artifact-aware local release gate must call the Android AAB verifier directly");
  requireText(localRelease, "\"local handoff smoke\", bash, [\"scripts/smoke-local-handoff.sh\"]", "runtime local release gate must include local handoff smoke");
  requireText(localRelease, "localHandoffEnv()", "runtime local release gate must run local handoff with an explicit target-dir env");
  requireText(localRelease, "env.CARGO_TARGET_DIR ??= \"/tmp/fieldwork-target-checks\"", "runtime local release gate must default handoff target-dir outside repo target");
  requireText(localRelease, "\"demo video artifact\", node, [\"scripts/verify-demo-video.mjs\"]", "runtime local release gate must include demo video verification");
  requireText(localRelease, "ASTRO_TELEMETRY_DISABLED=1 ./node_modules/.bin/astro check", "runtime local release gate must include site typecheck");
  requireText(localRelease, "ASTRO_TELEMETRY_DISABLED=1 ./node_modules/.bin/astro build", "runtime local release gate must include site build");
  requireText(localRelease, "\"Terraform validate\", bash, [\"scripts/check-infra-terraform.sh\"]", "runtime local release gate must include Terraform validation");
  requireText(localRelease, "\"relay TLS loopback\", bash, [\"scripts/smoke-relay-tls-loopback.sh\"]", "runtime local release gate must include relay TLS smoke");
  requireText(localRelease, "\"relay OTLP loopback\", node, [\"scripts/smoke-relay-otlp-loopback.mjs\"]", "runtime local release gate must include relay OTLP smoke");
  requireText(localRelease, "\"desktop performance thresholds\", node, [\"scripts/measure-desktop-performance.mjs\"]", "runtime local release gate must include desktop performance thresholds");
  requireText(ci, "node scripts/verify-rust-workspace.mjs", "CI must run the Rust workspace verifier");
  requireText(ci, "cargo fmt --check", "CI must run cargo fmt");
  requireText(ci, "cargo clippy --workspace -- -D warnings", "CI must run workspace clippy as a deny-warning gate");
  requireText(ci, "cargo nextest run --workspace", "CI must run workspace nextest");
  requireText(ci, "cargo test --workspace --doc", "CI must run workspace doctests");
  requireText(ci, "cargo deny check", "CI must run cargo-deny");
  requireText(ci, "cargo audit", "CI must run cargo-audit");
  requireText(ci, "scripts/smoke-local-handoff.sh", "CI must run the local handoff smoke");
  requireText(ci, "node scripts/smoke-relay-otlp-loopback.mjs", "CI must run the relay OTLP loopback smoke");
  requireText(ci, "scripts/smoke-relay-tls-loopback.sh", "CI must run the relay TLS loopback smoke");
  requireText(ci, "swiftc -parse -target arm64-apple-macosx15.0", "CI must parse iOS Swift sources");
  requireText(ci, "xmllint --noout", "CI must lint Android XML resources");
  requireText(ci, "node scripts/verify-npm-packages.mjs", "CI must run the npm package verifier");
  requireText(ci, "node scripts/verify-changesets-config.mjs", "CI must run the Changesets verifier");
  requireText(ci, "node scripts/generate-oss-notices.mjs --check", "CI must run the OSS notice drift check");
  requireText(ci, "node scripts/verify-docs-sync.mjs", "CI must run the docs-sync verifier");
  requireText(ci, "pnpm check:demo-video", "CI must run the demo video verifier");
  requireText(ci, "node scripts/verify-development-doc.mjs", "CI must run the development doc verifier");
  requireText(ci, "node scripts/verify-community-scaffold.mjs", "CI must run the community scaffold verifier");
  requireText(ci, "node scripts/verify-secret-boundaries.mjs", "CI must run the secret-boundary verifier");
  requireText(ci, "node scripts/verify-secret-boundaries.mjs --self-test", "CI must run the secret-boundary self-test");
  requireText(ci, "node scripts/verify-mobile-privacy.mjs", "CI must run the mobile privacy verifier");
  requireText(ci, "node scripts/verify-store-privacy.mjs", "CI must run the store privacy verifier");
  requireText(ci, "node scripts/verify-telemetry-privacy.mjs", "CI must run the telemetry privacy verifier");
  requireText(ci, "node scripts/verify-v1-boundary.mjs", "CI must run the v1 boundary verifier");
  requireText(ci, "node scripts/verify-security-model.mjs", "CI must run the security model verifier");
  requireText(ci, "node scripts/verify-release-audit.mjs", "CI must run the release audit verifier");
  requireText(ci, "node --check scripts/check-local-release.mjs", "CI must syntax-check the local release aggregate verifier");
  requireText(
    ci,
    "node scripts/check-local-release.mjs --list --with-artifacts --with-runtime",
    "CI must list-check all local release aggregate modes",
  );
  requireText(ci, "node scripts/verify-release-workflows.mjs", "CI must run the release workflow verifier");
  requireText(ci, "node scripts/verify-relay-provider-clients.mjs", "CI must run the relay provider-client verifier");
  requireText(ci, "node scripts/verify-daemon-service.mjs", "CI must run the daemon service verifier");
  requireText(ci, "node scripts/verify-daemon-resize.mjs", "CI must run the daemon resize verifier");
  requireText(ci, "node scripts/verify-infra-scaffold.mjs", "CI must run the infra scaffold verifier");
  requireText(ci, "name: Terraform Validate", "CI must run the Terraform validation job");
  requireText(ci, "hashicorp/setup-terraform@v3", "CI must install Terraform for validation");
  requireText(ci, "scripts/check-infra-terraform.sh", "CI must run the shared Terraform validation script");
  requireText(ci, "node scripts/verify-site-content.mjs", "CI must run the site content verifier");
  requireText(ci, "node scripts/test-ios-prereqs.mjs", "CI must run the deterministic iOS prereq tests");
  requireText(ci, "node scripts/test-npm-dispatcher.mjs", "CI must run the npm dispatcher test");
  requireText(ci, "node scripts/test-npm-registry-state.mjs", "CI must run the npm registry-state test");
  requireText(ci, "node scripts/test-npm-publish-plan.mjs", "CI must run the npm publish-plan test");
  requireText(ci, "node scripts/test-bun-install.mjs", "CI must run the Bun optional-dependency smoke");
  requireText(ci, "node scripts/test-android-aab-verifier.mjs", "CI must run the deterministic Android AAB verifier tests");
  requireText(ci, "node scripts/test-android-pair-button-picker.mjs", "CI must run the deterministic Android pair-button picker test");
  requireText(ci, "node scripts/test-release-artifacts.mjs", "CI must run the release artifact verifier tests");
  requireText(ci, "node scripts/test-npm-artifact-pack.mjs", "CI must run the npm artifact/package dry-run tests");
  requireText(ci, "node scripts/test-external-status-refresh.mjs", "CI must run the deterministic external status refresh guard test");
  requireText(ci, "pnpm --dir site install --ignore-workspace --frozen-lockfile", "CI must install the isolated site lockfile");
  requireText(ci, "pnpm check:site", "CI must run the site check");
  requireText(ci, "apps/android/scripts/build-rust.sh", "CI must build Android Rust mobile libraries");
  requireText(ci, "apps/android/gradlew --no-daemon :app:compileDebugKotlin", "CI must compile Android debug Kotlin");
  requireText(ci, "apps/android/gradlew --no-daemon :app:testDebugUnitTest", "CI must run Android unit tests");
}

function verifyOperatorRefreshScripts() {
  for (const [name, text] of [
    ["domain status", domainStatus],
    ["GitHub namespace", githubNamespace],
  ]) {
    requireText(text, 'const operatorRefresh = args.has("--operator-refresh")', `${name} refresh script must parse --operator-refresh`);
    requireText(text, "if (!operatorRefresh)", `${name} refresh script must fail closed without --operator-refresh`);
    requireText(text, "process.exit(2)", `${name} refresh script must exit before network access when not explicitly requested`);
  }
  requireText(domainStatus, "RDAP/DNS lookup is not a routine local check", "domain status script must explain that it is not a routine local check");
  requireText(githubNamespace, "GitHub API lookup is not a routine local check", "GitHub namespace script must explain that it is not a routine local check");
}

function read(rel) {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

function requireText(text, needle, message) {
  if (!text.includes(needle)) {
    failures.push(message);
  }
}

function rejectText(text, needle, message) {
  if (text.includes(needle)) {
    failures.push(message);
  }
}

function requirePattern(text, pattern, message) {
  if (!pattern.test(text)) {
    failures.push(message);
  }
}
