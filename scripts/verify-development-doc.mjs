#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const failures = [];

const files = {
  development: read("docs/DEVELOPMENT.md"),
  releaseAudit: read("docs/RELEASE_AUDIT.md"),
  packageJson: read("package.json"),
  ci: read(".github/workflows/ci.yml"),
  localRelease: read("scripts/check-local-release.mjs"),
  androidEmulatorAll: read("scripts/smoke-android-emulator-all.sh"),
  desktopPerf: read("scripts/measure-desktop-performance.mjs"),
  iosPrereqs: read("scripts/check-ios-prereqs.sh"),
  iosPrereqTests: read("scripts/test-ios-prereqs.mjs"),
};

verifyDevelopmentDoc(files.development);
verifyWiring(files);

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log("development doc contract ok");

function verifyDevelopmentDoc(text) {
  requireText(text, "# Development", "docs/DEVELOPMENT.md must be the source-development guide");

  for (const tool of [
    "Rust 1.94.0 from `rust-toolchain.toml`",
    "`cargo-nextest`",
    "`cargo-deny`",
    "`cargo-audit`",
    "`cargo-zigbuild`",
    "`cargo-ndk`",
    "Zig 0.16+",
    "Android Studio with SDK 36 and NDK r27",
  ]) {
    requireText(text, tool, `docs/DEVELOPMENT.md required tools must include ${tool}`);
  }

  for (const command of [
    "rustup show",
    "cargo build --workspace",
    "cargo nextest run --workspace",
    "target/debug/fieldwork version",
    "target/debug/fieldwork daemon start",
    "target/debug/fieldwork new bash -lc 'echo fieldwork source build ok'",
    "target/debug/fieldwork ls",
  ]) {
    requireText(text, command, `docs/DEVELOPMENT.md 15-minute path must include ${command}`);
  }
  requireText(text, "Mobile artifacts, release signing, relay deployment, and provider push are separate release gates", "docs/DEVELOPMENT.md must distinguish source build from external release gates");
  requireText(
    text,
    "`node scripts/verify-secret-boundaries.mjs`, `node scripts/verify-no-ship-markers.mjs`,\nand `node scripts/verify-no-ship-markers.mjs --self-test` through the local\ntoolchain",
    "docs/DEVELOPMENT.md must document the pre-commit no-ship hooks",
  );
  requireText(text, "one explicit warm-up sample", "docs/DEVELOPMENT.md must document the desktop performance warm-up contract");
  requireText(text, "build-machine first-exec page-cache/code-signing noise", "docs/DEVELOPMENT.md must explain why the desktop performance warm-up exists");
  requireText(text, "fails if any measured release-build sample exceeds the v1 thresholds", "docs/DEVELOPMENT.md must document max-sample desktop performance enforcement");
  requireText(text, "RUSTSEC-2026-0002", "docs/DEVELOPMENT.md must document the current lru RustSec advisory");
  requireText(text, "cargo update -p lru@0.12.5 --dry-run", "docs/DEVELOPMENT.md must document the lru dry-run update check");
  requireText(text, "does not use `lru::IterMut` directly", "docs/DEVELOPMENT.md must document direct lru IterMut non-use");

  for (const command of [
    "pnpm check:local-release",
    "cargo fmt --check",
    "cargo clippy --workspace -- -D warnings",
    "cargo nextest run --workspace",
    "cargo test --workspace",
    "cargo test --workspace --doc",
    "cargo deny check",
    "cargo audit",
    "node scripts/verify-npm-packages.mjs",
    "node scripts/verify-secret-boundaries.mjs",
    "pnpm check:no-ship",
    "pnpm test:no-ship",
    "pnpm check:release-artifacts",
    "pnpm check:uniffi-bindings",
    "node scripts/test-release-artifacts.mjs",
    "node scripts/test-npm-registry-state.mjs",
    "node scripts/test-external-status-refresh.mjs",
    "node scripts/test-ios-prereqs.mjs",
    "pnpm test:android-unit",
    "pnpm test:android-emulator",
    "node scripts/test-android-aab-verifier.mjs",
    "node scripts/test-android-pair-button-picker.mjs",
    "pnpm check:site",
    "pnpm render:demo-video",
    "pnpm check:demo-video",
  ]) {
    requireText(text, command, `docs/DEVELOPMENT.md common checks must include ${command}`);
  }
  requireText(
    text,
    "`pnpm check:local-release` runs the deterministic source-side release gate",
    "docs/DEVELOPMENT.md must describe the local release aggregate check",
  );
  requireText(
    text,
    "v1/FUTURE boundary plus no-ship marker scans/self-tests",
    "docs/DEVELOPMENT.md must document the local no-ship marker scan and self-test",
  );
  requireText(
    text,
    "deliberately excludes\nnetwork account checks, live publishing, iOS SDK builds, Android emulator\nruntime tests, physical-device checks, and hosted relay deployment",
    "docs/DEVELOPMENT.md must document what the local release aggregate check excludes",
  );
  requireText(
    text,
    "`pnpm check:local-release -- --with-artifacts`",
    "docs/DEVELOPMENT.md must document the artifact-aware local release aggregate mode",
  );
  requireText(
    text,
    "`pnpm check:local-release -- --with-runtime`",
    "docs/DEVELOPMENT.md must document the runtime local release aggregate mode",
  );
  requireText(
    text,
    "local\nhandoff smoke, demo video, site typecheck/build, Terraform fmt/init/validate,\nrelay TLS/OTLP loopbacks, and desktop cold-start thresholds",
    "docs/DEVELOPMENT.md must document what the runtime local release aggregate mode covers",
  );
  requireText(
    text,
    "runs the local\nhandoff smoke with `/tmp/fieldwork-target-checks`",
    "docs/DEVELOPMENT.md must document the aggregate local handoff target-dir default",
  );
  requireText(
    text,
    'CARGO_HOME="$HOME/.cargo" CARGO_TARGET_DIR="$PWD/target" pnpm check:local-release -- --with-artifacts --with-runtime',
    "docs/DEVELOPMENT.md must document the low-temp-space aggregate gate command",
  );
  requireText(
    text,
    "CI syntax-checks the\naggregate wrapper and list-checks the combined artifact/runtime mode",
    "docs/DEVELOPMENT.md must document CI coverage for the local release aggregate wrapper",
  );

  for (const section of [
    "The protocol crate uses insta snapshots",
    "The daemon ring buffer has proptest coverage",
    "The cold/stale attach snapshot gate also starts a real `vim /etc/hosts` PTY",
    "The UniFFI mobile core exposes `attach_session_from(id, last_seen_seq)`",
    "`Output.seq` is already the byte offset after the carried chunk",
    "raw output bytes are delivered without UTF-8 decoding",
    "reconnect offset advances to the live `Output.seq`",
    "`yes | head -10000`-scale stream is delivered without dropped bytes or offset drift",
    "one terminal `Lag` frame before mobile-core returns after notifying the native sink",
    "Desktop release build matrix",
    "Desktop performance smoke",
    "Pairing smoke",
    "Website:",
    "UniFFI bindgen smoke",
    "iOS app v0:",
    "Android app v0:",
    "Android release artifact smoke:",
    "Domain ownership, DNS control, and Cloudflare project credentials remain operator-owned external gates",
    "reserved for explicit operator-requested status refreshes",
    "committed `.terraform.lock.hcl` pins signed OCI provider checksums",
    "generated `.terraform/` caches stay ignored",
    "CI's Terraform Validate job installs Terraform 1.5.7",
    "shared `scripts/check-infra-terraform.sh` path",
    "exposed locally as `pnpm check:infra-terraform`",
    "removes generated `.terraform/` caches on exit",
    "also run `pnpm check:infra-terraform`",
    "Inspect daemon logs:",
    "User service lifecycle:",
  ]) {
    requireText(text, section, `docs/DEVELOPMENT.md must preserve section: ${section}`);
  }

  for (const phrase of [
    "creates a default `claude` session through a temp stub command, a `bash` session, and a `vim` TUI session",
    "verifies the iroh transport rejects a mismatched protocol version before pairing",
    "pairs the hidden iroh phone simulator through explicit desktop approval",
    "verifies the simulated pair flow completes within 15 seconds",
    "verifies reconnect-with-replay over iroh within 2 seconds from `last_seen_seq`",
    "verifies that the paired simulated phone receives `Forbidden` when it tries to create sessions, kill sessions, or emit agent-state hook events",
    "verifies that the same device identity is rejected with `Unauthorized`",
    "verifies that all last-known sessions are restored",
    "honors `CARGO_TARGET_DIR` for debug binaries",
    "without recreating repo-local `target/debug`",
  ]) {
    requireText(text, phrase, `docs/DEVELOPMENT.md pairing smoke coverage is missing: ${phrase}`);
  }

  for (const phrase of [
    "pnpm check:uniffi-bindings",
    "focused local guard for the generated mobile API surface",
    "exports `FieldworkClient`, `AttachedSession`, `SessionListSink`, `ByteStreamSink`, `FieldworkError`",
    "rejects generated mobile create/kill/session-command APIs",
    "checked-in generated Kotlin binding under `apps/android/generated`",
    "Android Gradle compiles that generated source directory",
    "iOS build script and Xcode project generate/link `GeneratedRust/fieldwork_mobile_core.swift` plus `GeneratedRust/FieldworkCore.xcframework`",
  ]) {
    requireText(text, phrase, `docs/DEVELOPMENT.md UniFFI binding verifier coverage must include ${phrase}`);
  }

  for (const phrase of [
    "Current local blocker for the full Week 4 platform matrix",
    "full Xcode is not selected",
    "Xcode 16.3 build `16E140`",
    "at least 70 GiB free in `~/Downloads`",
    "No Xcode `.xip` is present in `~/Downloads`",
    "Apple App Store Connect uploads now require Xcode 26+ with an iOS 26+ SDK",
    "prints explicit next steps to authenticate",
    "select `/Applications/Xcode-16.3.app/Contents/Developer`",
    "sudo xcodebuild -runFirstLaunch",
    "aarch64-apple-ios",
    "aarch64-apple-ios-sim",
    "x86_64-apple-ios",
    "SwiftTerm exactly to 1.13.0 and sentry-cocoa exactly to 9.13.0",
    "deterministic iOS prereq test covers missing `.xcode-version`, exact selected-Xcode comparison, and floored 70 GiB download headroom",
  ]) {
    requireText(text, phrase, `docs/DEVELOPMENT.md iOS blocker/build facts must include ${phrase}`);
  }

  for (const phrase of [
    "QR pairing with explicit camera authorization handling",
    "biometric-only Face ID/Touch ID gating",
    "SwiftTerm attach/input/resize/detach",
    "raw `Data` chunks and publishes an output revision",
    "SwiftTerm renderer drains raw `Data` chunks into `uiView.feed(data:)`",
    "calls SwiftTerm's `feed(byteArray:)`",
    "keeps the text fallback behind `#else`",
    "iOS service caches per-session `lastSeenSeq` offsets",
    "reattaches from the latest `lastSeenSeq` after a daemon `Lag`",
    "Foreground APNs notifications use the relay's fixed generic copy",
    "notification taps carry only lowercase 64-character hex `session_id_hash`",
    "SwiftTerm renderer uses raw byte-array rendering",
    "renders only the lock surface",
    "FIELDWORK_STUBS",
  ]) {
    requireText(text, phrase, `docs/DEVELOPMENT.md iOS app facts must include ${phrase}`);
  }

  for (const phrase of [
    "org.connectbot:termlib:0.0.35",
    "CameraX QR scanning",
    "EncryptedSharedPreferences",
    "BIOMETRIC_STRONG",
    "raw `ByteArray` chunks directly to termlib without string decoding",
    "reattaches from `lastSeenSeq` after a daemon `Lag` or attached-stream error",
    "Foreground FCM messages render the same fixed-copy generic notification",
    "Focused Android JVM tests verify that the biometric freshness gate requires unlock before first use",
    "locks at the 5-minute stale foreground boundary",
    "Focused Android JVM tests verify that the terminal controller refuses locked input before it reaches mobile-core",
    "reattaches from the latest `lastSeenSeq` after a daemon `Lag`",
    "reattaches from the latest `lastSeenSeq` after an attached-stream error",
    "records the delayed crash-reporting consent experience only after `AwaitingInput`, user input, and at least 10 output lines",
    "view model uses the same strict lowercase hash parser",
    "tap parser trims whitespace but never lowercases uppercase hashes",
    "foreground notifications use fixed generic copy and private lock-screen visibility even if extra terminal or command fields are present",
    "invalid event types or invalid hashes do not post notifications",
    "refreshed FCM tokens are queued in app-private `fieldwork_push_tokens.xml`",
    "excluded from full backup, cloud backup, and device transfer",
    "FCM token refresh callbacks only queue trimmed tokens",
    "the service does not register tokens directly",
    "sent and cleared only by the paired-and-unlocked token sync path",
    "Focused Android FcmTokenRegistrar JVM tests verify trimmed token storage, blank-token rejection, matching-token clear semantics, and clear-all unpair behavior",
    "Focused Android FieldworkViewModel JVM tests verify paired-but-locked sync does not register FCM tokens",
    "paired-and-unlocked sync registers queued/current tokens and clears queued tokens only after success",
    "duplicate queued/current tokens are registered once",
    "unpair clears queued FCM tokens",
    "valid push taps remain pending while locked and resolve only after unlock plus session refresh",
    "unlocked push taps resolve against the current session list",
    "invalid uppercase hashes clear stale pending routes and never route after unlock",
    "unlock starts the session subscription",
    "pairing while unlocked loads sessions, starts the subscription, and syncs FCM tokens",
    "pairing while locked does not load sessions, subscribe, or sync FCM tokens",
    "locking stops subscription updates",
    "subscription updates replace the dashboard list",
    "pending push taps can resolve from later subscription updates",
    "`FieldworkViewModel` from the lifecycle ViewModel store",
    "application-context factory",
    "Debug/source builds compile without `apps/android/app/google-services.json`",
    "app-release.aab` (`54M`, SHA-256 `8ab0548931a2a6a378d54646bc0d6932bfce941c499d07d1218306bd7e4a7365`)",
    "packaged protobuf manifest uses-permission allowlist",
    "packaged protobuf manifest privacy surface",
    "required Firebase/Sentry opt-out metadata",
    "local unsigned AAB state with `--expect-unsigned`",
    "synthetic unsigned and signed AABs",
    "failure when signature entries are present under `--expect-unsigned`",
    "current Compose tree exposes the Pair button itself without stable visible text",
    "forbidden location permission",
    "missing notification permission",
    "terminal-content metadata such as `last_line`",
    "Android Studio's bundled `jarsigner` also reports `jar is unsigned`",
    "node scripts/verify-android-aab.mjs` without the local-only `--expect-unsigned` flag",
    "pnpm test:android-debug-smoke",
    "pnpm test:android-emulator-pair",
    "pnpm test:android-emulator-session-subscription",
    "pnpm test:android-emulator-background-replay",
    "pnpm test:android-emulator-restart-restore",
    "pnpm test:android-emulator-flood",
    "pnpm test:android-emulator-multisession",
    "pnpm test:android-emulator-reconnect",
    "pnpm test:android-emulator-notification-tap",
    "`pnpm test:android-emulator` is the aggregate direct-adb substitute suite",
    "`pnpm test:android-emulator -- --list` prints the exact underlying adb scripts",
    "retries only a locked debug-launch\ntiming outlier once with the same strict limit",
    "every other script failure fails\nclosed and preserves the captured wrapper output path",
    "fails\nclosed unless exactly one boot-complete adb device is available",
    "latest default aggregate run on\n2026-05-19 passed on `emulator-5554`",
    "`TotalTime=7920ms`",
    "`pair_flow_ms=2234`",
    "`visible_ms=3318`",
    "8440/14400 nonblack samples",
    "checks that `TotalTime` stays below the debug-smoke limit",
    "rejects system ANR dialogs in the UI tree",
    "requires the locked `Unlock` surface",
    "FIELDWORK_ANDROID_BIOMETRIC_BYPASS=true",
    "FIELDWORK_ANDROID_PAIRING_PAYLOAD",
    "approves the Android pairing from the desktop CLI",
    "measures the debug-app Pair tap through explicit desktop approval completion",
    "first full-width enabled clickable control below it",
    "pins that accessibility-tree shape",
    "local 15-second emulator bound",
    "Latest aggregate-invoked run passed on `emulator-5554` with `pair_flow_ms=2234`",
    "physical QR camera pair-flow timing",
    "opens the terminal",
    "backgrounds and foregrounds the app",
    "sends mobile-originated input into the PTY",
    "separately approved verifier client",
    "replayed terminal bytes",
    "fw_subscribe_session",
    "local 8-second emulator bound",
    "subscription_attach_ok",
    "Latest aggregate-invoked run passed on `emulator-5554` with `visible_ms=3318`",
    "fw_restart_session",
    "ANDROID_RESTART_SCROLLBACK",
    "intentionally completed `fw_restart_session`",
    "session-exit path",
    "restarts the daemon with the same temp state and deterministic node identity",
    "relaunches the app from saved pairing",
    "restored dashboard still lists `fw_restart_session`",
    "Direct adb restart-restore evidence on 2026-05-19",
    "captured emulator screenshots, `uiautomator` dumps, `dumpsys window` focus, and logcat",
    "ANR in app.fieldwork.android",
    "FieldworkRepository: listSessions returned 1 sessions",
    "A later manual adb rerun on 2026-05-19 used direct `adb install`, `am start -W`, `uiautomator`, `screencap`, and logcat",
    "hiding the emulator IME before tapping Pair",
    "`TotalTime=1082ms`",
    "`echo android_adb_direct_input` plus the matching PTY output",
    "`FIELDWORK_BIOMETRIC_BYPASS = false`",
    "empty `FIELDWORK_DEBUG_PAIRING_PAYLOAD`",
    "A follow-up raw adb locked-launch baseline on 2026-05-19",
    "`TotalTime=2078ms`",
    "`/tmp/fieldwork-adb-launch.png`",
    "`/tmp/fieldwork-adb-ui.xml`",
    "empty Fieldwork crash buffer",
    "latest raw adb emulator QA refresh on 2026-05-19",
    "`TotalTime=5297ms`",
    "`/tmp/fieldwork-adb-direct-20260519225027/default.png`",
    "`/tmp/fieldwork-adb-direct-20260519225027/default-ui.xml`",
    "`/tmp/fieldwork-adb-direct-20260519225027/default-logcat.log`",
    "`/tmp/fieldwork-adb-direct-20260519225027/default-crash.log`",
    "`FIELDWORK_ANDROID_BIOMETRIC_BYPASS=true`",
    "`FIELDWORK_ANDROID_PAIRING_PAYLOAD`",
    "`TotalTime=4589ms`",
    "UI-tree-derived Pair center `540 1860`",
    "`pair_flow_ms=1043`",
    "`/tmp/fieldwork-adb-direct-pair-20260519225208/before-pair.png`",
    "`/tmp/fieldwork-adb-direct-pair-20260519225208/sessions.png`",
    "`/tmp/fieldwork-adb-direct-pair-20260519225208/terminal-before-input.png`",
    "`/tmp/fieldwork-adb-direct-pair-20260519225208/terminal-after-input.png`",
    "`android-direct: fw_android_direct_ok`",
    "`/tmp/fieldwork-adb-direct-20260520001909/default-locked.png`",
    "`TotalTime=6766ms`",
    "`ANDROID_ADB_MANUAL_READY`",
    "`android_adb_manual_ok`",
    "`/tmp/fieldwork-adb-direct-20260520001909/terminal-after-input.png`",
    "`android-direct: android_adb_manual_ok`",
    "`TotalTime=1371ms`",
    "`/tmp/fieldwork-adb-direct-20260520001909/default-restore-locked.png`",
    "`TotalTime=5105ms`",
    "`/tmp/fieldwork-adb-direct-restore-20260519225316/restored-locked.png`",
    "`/tmp/fieldwork-adb-direct-restore-20260519225316/restored-ui.xml`",
    "`FIELDWORK_DEBUG_PAIRING_PAYLOAD = \"\"`",
    "not release-device cold-start threshold evidence",
    "refreshSessionsRunsRepositoryWorkOffMainThread",
    "ANDROID_BACKGROUND_REPLAY_OUTPUT",
    "after_background_ok",
    "renders a `yes | head -10000`-scale stream in the actual Android terminal view",
    "flood screenshot nonblank",
    "ANDROID_EMULATOR_FLOOD",
    "opens three desktop-created sessions (`fwm_a`, `fwm_b`, `fwm_c`)",
    "switches among all three in the app",
    "multi_a_ok",
    "multi_b_ok",
    "multi_c_ok",
    "emulator airplane-mode network cut",
    "output emitted during the network gap remains replayable",
    "computes a real desktop session's lowercase `session_id_hash`",
    "uppercase invalid hash does not route",
    "notify_tap_ok",
    "debug-build-only",
    "BuildConfig.DEBUG",
    "rejects Fieldwork crash/ANR logcat entries",
    "nonblank 1080x2400 PNG",
    "TotalTime=2467ms",
    "14391/14400 nonblack screenshot samples",
    "Play Store image still emitted background Google-service ANRs",
    "encrypted pairing store lazy",
    "restores saved pairing on `Dispatchers.IO`",
    "construction does not block on saved-pairing restore",
    "stale startup-restore results cannot override an explicit pairing",
    "explicit Material color scheme and explicit lock-button colors",
    "separate `sessions.redb` and `devices.redb` stores in production",
    "encrypted device-registry rows and hashed device row keys in both shared-test and separate production-like DB layouts",
  ]) {
    requireText(text, phrase, `docs/DEVELOPMENT.md Android app facts must include ${phrase}`);
  }

  for (const phrase of [
    "Local debug builds can omit `FIELDWORK_SENTRY_DSN`",
    "Focused Android MobileTelemetry JVM tests verify crash reporting defaults off",
    "declined consent resolves the one-time prompt without enabling crash reporting",
    "accepted consent persists while a debug build without a DSN still does not start Sentry",
    "shown only after an attached session has reached `AwaitingInput`, the user has responded, and at least 10 later output lines arrive",
    "sendDefaultPii=false",
    "tracesSampleRate=0.0",
    "`pnpm check:telemetry-privacy`",
  ]) {
    requireText(text, phrase, `docs/DEVELOPMENT.md telemetry facts must include ${phrase}`);
  }
  requireText(
    text,
    "node scripts/verify-no-ship-markers.mjs",
    "docs/DEVELOPMENT.md must document the CI no-ship marker verifier",
  );
  requireText(
    text,
    "node scripts/verify-no-ship-markers.mjs` plus `--self-test`",
    "docs/DEVELOPMENT.md must document the CI no-ship marker self-test",
  );

  for (const phrase of [
    "cargo test -p fieldwork-daemon local_agent_hook",
    "Codex currently exposes `codex remote-control` and `codex app-server --listen/proxy` locally",
    "keeps the `codex` PTY command unchanged",
    "fieldwork hook codex-event",
    "matching LocalCli Claude/Codex hook events",
    "update only matching PTY",
    "mismatched hook sources are ignored",
  ]) {
    requireText(text, phrase, `docs/DEVELOPMENT.md local agent hook coverage must include ${phrase}`);
  }

  for (const phrase of [
    "fake `launchctl`/`systemctl`",
    "macOS Gatekeeper preflight before launchd install",
    "KeepAlive` with `SuccessfulExit=false",
    "Restart=on-failure",
    "RestartSec=5",
    "service-manager rendering tests for LaunchAgent `KeepAlive` and systemd `Restart=on-failure`",
  ]) {
    requireText(text, phrase, `docs/DEVELOPMENT.md daemon service coverage must include ${phrase}`);
  }

  for (const phrase of [
    "Sigstore media type",
    "transparency-log entries",
    "DSSE envelope/signatures",
    "in-toto payload",
    "SLSA provenance v1 `predicateType`",
    "subject name",
    "subject digest",
    "all five publishable npm manifests are set to `1.0.0`",
    "official-repository `buildType`, package, target, release tag, and SHA-256 external parameters",
    "checksum filename, tampered digest, subject-name, predicate-type, predicate `_type`, Sigstore media type, transparency-log, DSSE envelope/signature, invalid payload, missing external-parameters, release-tag, external SHA, package, target, and buildType cases",
    "FIELDWORK_RELEASE_REPOSITORY=${{ github.repository }}",
    "FIELDWORK_EXPECTED_RELEASE_TAG",
    "requires `artifacts/` or `FIELDWORK_ARTIFACT_DIR` to contain release-rust/GitHub Release archives",
    "intentionally fails closed when those real artifacts are absent",
    "`pnpm test:release-artifacts` is the deterministic local substitute for verifier coverage",
    "platform/target-matching extracted artifact directory",
    "missing platform-root rejection",
    "deterministic local registry fixture for current, post-placeholder, post-release, version-drift, missing-provenance, and bare-invocation failure states",
    "bare-invocation case also asserts the checker exits before any registry request",
    "The unscoped `fieldwork` meta package is operator-owned",
    "not a name-availability task for the meta package",
    "fails closed when run without explicit release-state expectation flags",
    "Use the live registry checker only for release-state verification after operator-controlled platform child publishes",
    "both `--check-ready` and actual publish-path rejection when platform children contain non-native files instead of Mach-O or ELF binaries",
    "a missing token fails before npm is invoked",
    "four platform packages first, meta package last, `--provenance`, and public access",
    "`--expect-platform-published`",
    "`--expect-latest-version=1.0.0 --expect-provenance`",
    'retries the public registry with `node scripts/verify-npm-registry-state.mjs --expect-meta-published --expect-platform-published --expect-latest-version="$version" --expect-provenance`',
    "The relay TLS and OTLP smoke scripts honor `FIELDWORK_RELAY_BINARY`",
    "prefer the existing `target/release/fieldwork-relay`",
    "macOS daemon signing and notarization fail closed before Darwin toolchain setup and release build",
    "keep decoded Apple signing/notarization assets outside the repository workspace with `0600` permissions and cleanup",
    "keeps App Store Connect upload JSON outside the repository workspace and cleans signing/upload assets",
    "Android release preflights Sentry/Firebase/signing/Play secrets before toolchain setup and mobile build",
    "removes generated Firebase/signing files in an `always()` cleanup step",
    "cleans the decoded relay SSH key",
    "the Xcode project honors `FIELDWORK_SKIP_RUST_BUILD` before running `apps/ios/scripts/build-rust.sh`",
  ]) {
    requireText(text, phrase, `docs/DEVELOPMENT.md release artifact verification must include ${phrase}`);
  }

  for (const phrase of [
    "domain ownership, DNS control, and social-handle reservation are operator-owned external gates",
    "reserved for explicit operator-requested status refreshes",
    "node scripts/check-github-namespace.mjs --operator-refresh --expect-available",
    "node scripts/check-domain-status.mjs --operator-refresh --require-registered --require-dns",
  ]) {
    requireText(text, phrase, `docs/DEVELOPMENT.md external reservation facts must include ${phrase}`);
  }

  rejectText(text, "Output.seq + bytes.len()", "docs/DEVELOPMENT.md must not double-count Output.seq offsets");
}

function verifyWiring(allFiles) {
  const packageJson = JSON.parse(allFiles.packageJson);
  if (packageJson.scripts?.["check:development-doc"] !== "node scripts/verify-development-doc.mjs") {
    failures.push("package.json must expose pnpm check:development-doc");
  }
  if (packageJson.scripts?.["measure:desktop-performance"] !== "node scripts/measure-desktop-performance.mjs") {
    failures.push("package.json must expose pnpm measure:desktop-performance");
  }
  if (packageJson.scripts?.["check:release-artifacts"] !== "node scripts/verify-release-artifacts.mjs") {
    failures.push("package.json must expose pnpm check:release-artifacts");
  }
  if (packageJson.scripts?.["check:local-release"] !== "node scripts/check-local-release.mjs") {
    failures.push("package.json must expose pnpm check:local-release");
  }
  if (packageJson.scripts?.["check:no-ship"] !== "node scripts/verify-no-ship-markers.mjs") {
    failures.push("package.json must expose pnpm check:no-ship");
  }
  if (packageJson.scripts?.["test:no-ship"] !== "node scripts/verify-no-ship-markers.mjs --self-test") {
    failures.push("package.json must expose pnpm test:no-ship");
  }
  if (packageJson.scripts?.["check:npm-registry"] !== "node scripts/verify-npm-registry-state.mjs") {
    failures.push("package.json must expose pnpm check:npm-registry");
  }
  if (packageJson.scripts?.["test:npm-registry-state"] !== "node scripts/test-npm-registry-state.mjs") {
    failures.push("package.json must expose pnpm test:npm-registry-state");
  }
  if (packageJson.scripts?.["refresh:domain-status"] !== "node scripts/check-domain-status.mjs --operator-refresh") {
    failures.push("package.json must expose pnpm refresh:domain-status");
  }
  if (packageJson.scripts?.["refresh:github-namespace"] !== "node scripts/check-github-namespace.mjs --operator-refresh") {
    failures.push("package.json must expose pnpm refresh:github-namespace");
  }
  if (packageJson.scripts?.["check:domain-status"] || packageJson.scripts?.["check:github-namespace"]) {
    failures.push("package.json must not expose external status refreshes as routine check:* scripts");
  }
  if (packageJson.scripts?.["test:ios-prereqs"] !== "node scripts/test-ios-prereqs.mjs") {
    failures.push("package.json must expose pnpm test:ios-prereqs");
  }
  if (packageJson.scripts?.["test:android-aab-verifier"] !== "node scripts/test-android-aab-verifier.mjs") {
    failures.push("package.json must expose pnpm test:android-aab-verifier");
  }
  if (packageJson.scripts?.["test:android-pair-button-picker"] !== "node scripts/test-android-pair-button-picker.mjs") {
    failures.push("package.json must expose pnpm test:android-pair-button-picker");
  }
  if (packageJson.scripts?.["test:external-status-refresh"] !== "node scripts/test-external-status-refresh.mjs") {
    failures.push("package.json must expose pnpm test:external-status-refresh");
  }
  if (packageJson.scripts?.["test:android-emulator"] !== "bash scripts/smoke-android-emulator-all.sh") {
    failures.push("package.json must expose pnpm test:android-emulator");
  }
  if (packageJson.scripts?.["test:android-debug-smoke"] !== "bash scripts/smoke-android-debug.sh") {
    failures.push("package.json must expose pnpm test:android-debug-smoke");
  }
  if (packageJson.scripts?.["test:android-emulator-pair"] !== "bash scripts/smoke-android-emulator-pair.sh") {
    failures.push("package.json must expose pnpm test:android-emulator-pair");
  }
  if (packageJson.scripts?.["test:android-emulator-session-subscription"] !== "bash scripts/smoke-android-emulator-session-subscription.sh") {
    failures.push("package.json must expose pnpm test:android-emulator-session-subscription");
  }
  if (packageJson.scripts?.["test:android-emulator-background-replay"] !== "bash scripts/smoke-android-emulator-background-replay.sh") {
    failures.push("package.json must expose pnpm test:android-emulator-background-replay");
  }
  if (packageJson.scripts?.["test:android-emulator-restart-restore"] !== "bash scripts/smoke-android-emulator-restart-restore.sh") {
    failures.push("package.json must expose pnpm test:android-emulator-restart-restore");
  }
  if (packageJson.scripts?.["test:android-emulator-flood"] !== "bash scripts/smoke-android-emulator-flood.sh") {
    failures.push("package.json must expose pnpm test:android-emulator-flood");
  }
  if (packageJson.scripts?.["test:android-emulator-multisession"] !== "bash scripts/smoke-android-emulator-multisession.sh") {
    failures.push("package.json must expose pnpm test:android-emulator-multisession");
  }
  if (packageJson.scripts?.["test:android-emulator-reconnect"] !== "bash scripts/smoke-android-emulator-reconnect.sh") {
    failures.push("package.json must expose pnpm test:android-emulator-reconnect");
  }
  if (packageJson.scripts?.["test:android-emulator-notification-tap"] !== "bash scripts/smoke-android-emulator-notification-tap.sh") {
    failures.push("package.json must expose pnpm test:android-emulator-notification-tap");
  }
  if (packageJson.scripts?.["render:demo-video"] !== "node scripts/render-demo-video.mjs") {
    failures.push("package.json must expose pnpm render:demo-video");
  }
  if (packageJson.scripts?.["check:demo-video"] !== "node scripts/verify-demo-video.mjs") {
    failures.push("package.json must expose pnpm check:demo-video");
  }
  requireText(allFiles.ci, "node scripts/verify-development-doc.mjs", "CI must run the development doc verifier");
  requireText(allFiles.ci, "node --check scripts/check-local-release.mjs", "CI must syntax-check the local release aggregate verifier");
  requireText(
    allFiles.ci,
    "node scripts/check-local-release.mjs --list --with-artifacts --with-runtime",
    "CI must list-check all local release aggregate modes",
  );
  requireText(allFiles.ci, "node scripts/verify-no-ship-markers.mjs", "CI must run the no-ship marker verifier");
  requireText(allFiles.ci, "node scripts/verify-no-ship-markers.mjs --self-test", "CI must run the no-ship marker self-test");
  requireText(allFiles.localRelease, "scripts/verify-release-audit.mjs", "local release gate must include the release audit verifier");
  requireText(allFiles.localRelease, "\"workflow YAML syntax\"", "local release gate must include workflow YAML syntax parsing");
  requireText(allFiles.localRelease, "Dir[\".github/workflows/*.yml\"].sort.each", "local release gate must parse all workflow YAML files");
  requireText(allFiles.localRelease, "scripts/verify-no-ship-markers.mjs", "local release gate must include the no-ship marker verifier");
  requireText(allFiles.localRelease, "scripts/verify-no-ship-markers.mjs\", \"--self-test", "local release gate must include the no-ship marker self-test");
  requireText(allFiles.localRelease, "scripts/test-release-artifacts.mjs", "local release gate must include deterministic release-artifact verifier coverage");
  requireText(allFiles.localRelease, "scripts/test-npm-artifact-pack.mjs", "local release gate must include deterministic npm artifact packaging coverage");
  requireText(allFiles.localRelease, "scripts/test-android-pair-button-picker.mjs", "local release gate must include deterministic Android pair-button picker coverage");
  requireText(allFiles.localRelease, "scripts/verify-uniffi-bindings.mjs", "local release gate must include UniFFI binding verification");
  requireText(allFiles.localRelease, "scripts/publish-npm-packages.mjs\", \"--check-ready", "artifact-aware local release gate must include publish-readiness verification");
  requireText(allFiles.localRelease, "scripts/verify-npm-packages.mjs\", \"--require-binaries", "artifact-aware local release gate must include staged npm binary verification");
  requireText(allFiles.localRelease, "\"npm meta dry-run pack\", npm, [\"pack\", \"./packages/cli\", \"--dry-run\", \"--json\"]", "artifact-aware local release gate must include npm meta dry-run pack");
  requireText(allFiles.localRelease, "cleanNpmEnv()", "local release gate must sanitize inherited npm config for dry-run pack");
  requireText(allFiles.localRelease, "\"Android AAB artifact\", node, [\"scripts/verify-android-aab.mjs\", \"--expect-unsigned\"]", "artifact-aware local release gate must call the Android AAB verifier directly");
  requireText(allFiles.localRelease, "\"local handoff smoke\", bash, [\"scripts/smoke-local-handoff.sh\"]", "runtime local release gate must include local handoff smoke");
  requireText(allFiles.localRelease, "localHandoffEnv()", "runtime local release gate must run local handoff with an explicit target-dir env");
  requireText(allFiles.localRelease, "env.CARGO_TARGET_DIR ??= \"/tmp/fieldwork-target-checks\"", "runtime local release gate must default handoff target-dir outside repo target");
  requireText(allFiles.localRelease, "\"demo video artifact\", node, [\"scripts/verify-demo-video.mjs\"]", "runtime local release gate must include demo video verification");
  requireText(allFiles.localRelease, "ASTRO_TELEMETRY_DISABLED=1 ./node_modules/.bin/astro check", "runtime local release gate must include site typecheck");
  requireText(allFiles.localRelease, "ASTRO_TELEMETRY_DISABLED=1 ./node_modules/.bin/astro build", "runtime local release gate must include site build");
  requireText(allFiles.localRelease, "\"Terraform validate\", bash, [\"scripts/check-infra-terraform.sh\"]", "runtime local release gate must include Terraform validation");
  requireText(allFiles.localRelease, "\"relay TLS loopback\", bash, [\"scripts/smoke-relay-tls-loopback.sh\"]", "runtime local release gate must include relay TLS smoke");
  requireText(allFiles.localRelease, "\"relay OTLP loopback\", node, [\"scripts/smoke-relay-otlp-loopback.mjs\"]", "runtime local release gate must include relay OTLP smoke");
  requireText(allFiles.localRelease, "\"desktop performance thresholds\", node, [\"scripts/measure-desktop-performance.mjs\"]", "runtime local release gate must include desktop performance thresholds");
  requireText(allFiles.ci, "node scripts/test-ios-prereqs.mjs", "CI must run the deterministic iOS prereq tests");
  requireText(allFiles.ci, "node scripts/test-android-aab-verifier.mjs", "CI must run the deterministic Android AAB verifier tests");
  requireText(allFiles.ci, "node scripts/test-android-pair-button-picker.mjs", "CI must run the deterministic Android pair-button picker test");
  requireText(allFiles.ci, "node scripts/test-external-status-refresh.mjs", "CI must run the deterministic external status refresh guard test");
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
    requireText(allFiles.androidEmulatorAll, script, `Android emulator aggregate must run ${script}`);
  }
  requireText(allFiles.androidEmulatorAll, "--list", "Android emulator aggregate must expose a list mode");
  requireText(allFiles.androidEmulatorAll, "boot-complete", "Android emulator aggregate must require a boot-complete device");
  requireText(allFiles.androidEmulatorAll, "above debug smoke limit", "Android emulator aggregate must only retry debug-smoke timing outliers");
  requireText(allFiles.androidEmulatorAll, "retrying once with the same strict limit", "Android emulator aggregate must document strict retry behavior");
  requireText(allFiles.androidEmulatorAll, "captured output", "Android emulator aggregate must preserve failing smoke output");
  requireText(allFiles.releaseAudit, "Development doc", "docs/RELEASE_AUDIT.md must include development doc evidence");
  requireText(allFiles.releaseAudit, "scripts/verify-development-doc.mjs", "docs/RELEASE_AUDIT.md must cite the development doc verifier");
  requireText(allFiles.desktopPerf, "FIELDWORK_PERF_WARMUP_SAMPLES", "desktop performance script must expose warm-up sample control");
  requireText(allFiles.desktopPerf, "warmup samples ignored", "desktop performance script must report ignored warm-up samples");
  requireText(allFiles.desktopPerf, "for (let i = 0; i < warmups; i += 1)", "desktop performance script must run warm-up loops before measured samples");
  requireText(allFiles.desktopPerf, "FIELDWORK_CLI_COLD_START_MS || 50", "desktop performance script must keep the v1 CLI threshold default");
  requireText(allFiles.desktopPerf, "FIELDWORK_DAEMON_COLD_START_MS || 200", "desktop performance script must keep the v1 daemon threshold default");
  requireText(allFiles.iosPrereqs, '[ -f "$repo_root/.xcode-version" ]', "iOS prereq script must not abort before reporting a missing .xcode-version pin");
  requireText(allFiles.iosPrereqs, '${required_xcode:-unknown}', "iOS prereq script must print an explicit unknown Xcode pin when .xcode-version is missing");
  requireText(allFiles.iosPrereqs, "no required Xcode version is configured", "iOS prereq download path must fail clearly when no Xcode pin is configured");
  requireText(allFiles.iosPrereqs, "cannot look for Xcode XIP", "iOS prereq script must avoid empty Xcode XIP names when no Xcode pin is configured");
  requireText(allFiles.iosPrereqs, "Restore .xcode-version or set FIELDWORK_XCODE_VERSION", "iOS prereq recovery output must explain how to restore a missing Xcode pin");
  requireText(allFiles.iosPrereqs, "selected_xcode_version", "iOS prereq script must parse the selected Xcode version before comparing the local pin");
  requireText(allFiles.iosPrereqs, '[ "$selected_xcode_version" = "$required_xcode" ]', "iOS prereq script must compare the selected Xcode version exactly");
  requireText(allFiles.iosPrereqs, 'int($4 / 1024 / 1024)', "iOS prereq script must floor free GiB before applying the 70 GiB Xcode headroom guard");
  requireText(allFiles.iosPrereqTests, "missing xcode pin stays actionable", "iOS prereq tests must cover missing .xcode-version recovery");
  requireText(allFiles.iosPrereqTests, "local xcode version match is exact", "iOS prereq tests must cover exact Xcode version comparison");
  requireText(allFiles.iosPrereqTests, "download headroom floors fractional gib", "iOS prereq tests must cover floored download headroom");
  requireText(allFiles.iosPrereqTests, "Xcode 16.30", "iOS prereq tests must guard against prefix version matches");
  requireText(allFiles.iosPrereqTests, "Math.floor(69.9 * 1024 * 1024)", "iOS prereq tests must simulate fractional free GiB below the floor");
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
