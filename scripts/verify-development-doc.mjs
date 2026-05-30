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
  doctorSmoke: read("scripts/smoke-cli-doctor.sh"),
  noArgsSmoke: read("scripts/smoke-cli-no-args.sh"),
  localNpmArtifacts: read("scripts/build-local-npm-artifacts.sh"),
  structuredAssets: read("scripts/verify-structured-assets.mjs"),
  androidEmulatorAll: read("scripts/smoke-android-emulator-all.sh"),
  androidGradlew: read("apps/android/gradlew"),
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
    "`node scripts/verify-no-ship-markers.mjs --self-test`,\n`node scripts/test-live-testing-evidence.mjs`, `node scripts/test-debug-instance.mjs`,\nand `node scripts/verify-structured-assets.mjs` through the local toolchain",
    "docs/DEVELOPMENT.md must document the pre-commit lightweight release hooks",
  );
  requireText(text, "one explicit warm-up sample", "docs/DEVELOPMENT.md must document the desktop performance warm-up contract");
  requireText(text, "build-machine first-exec page-cache/code-signing noise", "docs/DEVELOPMENT.md must explain why the desktop performance warm-up exists");
  requireText(text, "fails if any measured release-build sample exceeds the v1 thresholds", "docs/DEVELOPMENT.md must document max-sample desktop performance enforcement");
  requireText(text, "pnpm build:local-npm-artifacts", "docs/DEVELOPMENT.md must document local npm artifact staging");
  requireText(text, "release CI still publishes from\ndownloaded GitHub Release archives and attestations", "docs/DEVELOPMENT.md must keep local npm artifact staging separate from release CI artifacts");
  requireText(text, "RUSTSEC-2026-0002", "docs/DEVELOPMENT.md must document the current lru RustSec advisory");
  requireText(text, "RUSTSEC-2025-0056", "docs/DEVELOPMENT.md must document the current adler RustSec advisory");
  requireText(text, "RUSTSEC-2023-0089", "docs/DEVELOPMENT.md must document the current atomic-polyfill RustSec advisory");
  requireText(text, "RUSTSEC-2025-0141", "docs/DEVELOPMENT.md must document the current bincode RustSec advisory");
  requireText(text, "RUSTSEC-2024-0436", "docs/DEVELOPMENT.md must document the current paste RustSec advisory");
  requireText(text, "scanned 748 dependencies", "docs/DEVELOPMENT.md must document the latest cargo-audit dependency count");
  requireText(text, "cargo update -p lru@0.12.5 --dry-run", "docs/DEVELOPMENT.md must document the lru dry-run update check");
  requireText(text, "cargo update -p postcard --dry-run", "docs/DEVELOPMENT.md must document the postcard dry-run update check");
  requireText(text, "does not use `lru::IterMut` directly", "docs/DEVELOPMENT.md must document direct lru IterMut non-use");
  requireText(text, "rejects direct `lru` dependencies plus `lru::` source paths", "docs/DEVELOPMENT.md must document direct lru source/dependency guard");
  requireText(text, "does not use `atomic_polyfill::` directly", "docs/DEVELOPMENT.md must document direct atomic-polyfill non-use");
  requireText(text, "rejects direct `atomic-polyfill` dependencies plus `atomic_polyfill::` source paths", "docs/DEVELOPMENT.md must document direct atomic-polyfill source/dependency guard");

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
    "node scripts/test-release-artifacts-evidence.mjs",
    "node scripts/test-release-artifacts-scaffold.mjs",
    "pnpm test:macos-signing-evidence",
    "pnpm test:macos-signing-scaffold",
    "node scripts/test-npm-registry-state.mjs",
    "node scripts/test-external-status-refresh.mjs",
    "node scripts/test-ios-prereqs.mjs",
    "pnpm test:npm-release-evidence",
    "pnpm test:npm-release-scaffold",
    "pnpm test:cli-no-args",
    "pnpm test:live-testing-readiness",
    "pnpm check:live-testing-readiness:local",
    "pnpm test:android-unit",
    "pnpm test:android-emulator",
    "pnpm check:android-debug-apk",
    "node scripts/test-android-aab-verifier.mjs",
    "node scripts/test-android-debug-apk-verifier.mjs",
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
    "workspace/package metadata, `cargo fmt --check`,",
    "docs/DEVELOPMENT.md must document cargo fmt in the local release aggregate",
  );
  requireText(
    text,
    "`cargo clippy --workspace -- -D warnings`, `cargo nextest run --workspace`,",
    "docs/DEVELOPMENT.md must document clippy and nextest in the local release aggregate",
  );
  requireText(
    text,
    "`cargo deny check`, `cargo audit`, docs",
    "docs/DEVELOPMENT.md must document supply-chain checks in the local release aggregate",
  );
  requireText(
    text,
    "release workflow `run: |` bash syntax self-test and contracts",
    "docs/DEVELOPMENT.md must document release workflow run-block bash syntax coverage in the local release aggregate",
  );
  requireText(
    text,
    "v1/FUTURE boundary\nplus no-ship marker scans/self-tests",
    "docs/DEVELOPMENT.md must document the local no-ship marker scan and self-test",
  );
  requireText(
    text,
    "deliberately excludes\nnetwork account checks, live publishing, iOS SDK builds, Android emulator\nruntime tests, physical-device checks, and hosted relay deployment",
    "docs/DEVELOPMENT.md must document what the local release aggregate check excludes",
  );
  requireText(
    text,
    "`pnpm check:live-testing-readiness:local`",
    "docs/DEVELOPMENT.md must document the local live-testing readiness check",
  );
  requireText(
    text,
    "their command surfaces with\n`target/release/fieldwork doctor --help` and\n`target/release/fieldworkd --help`, Android debug APK, unsigned local AAB,\nnormal debug `BuildConfig`, live-test scaffold/verifier, and\n`docs/LIVE_TESTING.md`, while treating a missing physical phone,\nunauthorized/offline adb target, extra attached target, or emulator/AVD as\npending guidance only in local mode",
    "docs/DEVELOPMENT.md must document local-only live-testing readiness semantics",
  );
  requireText(
    text,
    "In local mode, the readiness command also\ncreates an internal temporary `fw` shim against `target/release/fieldwork` when\nno global `fw` is on `PATH`, proving the release binary still renders\n`Usage: fw` and `Usage: fw doctor`; strict mode still requires the Desktop Setup\nshim or installed npm package before capture. Source-checkout tests should use\nthe temporary shim from\n`pnpm scaffold:live-testing-fw-shim`, which creates `fw`, `fieldwork`, and\n`fieldworkd` symlinks plus an `activate.sh` pointing at the repo-local release\nbinaries without replacing the npm package/provenance gates",
    "docs/DEVELOPMENT.md must document strict live-testing readiness semantics",
  );
  requireText(
    text,
    "`pnpm scaffold:live-testing-pack -- --print-dir`: it creates the same shim under\n`bin/`, creates the live-test evidence scaffold under `evidence/`, writes\n`setup.sh` exporting `FW_LIVE_PACK`, `FW_LIVE_BIN`, `FW_LIVE_DIR`, and `PATH`,\nand writes a top-level `preflight.sh` that runs local readiness, runs\n`fw doctor` to prove the desktop CLI can start and handshake with `fieldworkd`,\nthen delegates to the direct-`adb` evidence preflight",
    "docs/DEVELOPMENT.md must document the combined live-testing pack scaffold",
  );
  requireText(
    text,
    "`pnpm test:live-testing-pack` and\n`pnpm check:local-release` keep it wired. With exactly one authorized physical Android phone connected,\n`pnpm check:live-testing-readiness` is the strict direct-`adb` preflight before\ncapture: it proves `app.fieldwork.android` is installed on the connected device\nand that `adb shell dumpsys package app.fieldwork.android` reports\n`versionName=1.0` and `versionCode=1`",
    "docs/DEVELOPMENT.md must document live-testing pack verification and strict readiness",
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
    "CLI doctor\nsmoke, CLI no-args raw-terminal smoke, local handoff smoke, demo video, site\ntypecheck/build, Terraform fmt/init/validate, relay TLS/OTLP loopbacks, and\ndesktop cold-start thresholds",
    "docs/DEVELOPMENT.md must document what the runtime local release aggregate mode covers",
  );
  requireText(
    text,
    "runs the CLI doctor, CLI no-args, and local handoff\nsmokes with `/tmp/fieldwork-target-checks`",
    "docs/DEVELOPMENT.md must document the aggregate CLI doctor/no-args/local handoff target-dir default",
  );
  requireText(
    text,
    "smokes preserve the host `CARGO_HOME` and\n`RUSTUP_HOME` while isolating Fieldwork's `HOME`",
    "docs/DEVELOPMENT.md must document CLI no-args/local handoff Cargo/Rustup cache preservation",
  );
  requireText(
    text,
    'CARGO_HOME="$HOME/.cargo" CARGO_TARGET_DIR="$PWD/target" pnpm check:local-release:full',
    "docs/DEVELOPMENT.md must document the low-temp-space aggregate gate command",
  );
  requireText(
    text,
    "CI\nsyntax-checks the aggregate wrapper and list-checks the combined\nartifact/runtime mode",
    "docs/DEVELOPMENT.md must document CI coverage for the local release aggregate wrapper",
  );
  requireText(
    text,
    "`pnpm check:release-audit:list`",
    "docs/DEVELOPMENT.md must document the package release-audit list command",
  );
  requireText(
    text,
    "node scripts/verify-release-audit.mjs --list-unchecked",
    "docs/DEVELOPMENT.md must document the unchecked gate list command",
  );
  requireText(
    text,
    "`pnpm test:release-audit-list` pins that grouped output",
    "docs/DEVELOPMENT.md must document the unchecked gate list test",
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
    "Repeatable isolated debug daemon",
    "scripts/debug-instance.sh start",
    "eval \"$(scripts/debug-instance.sh env)\"",
    "isolated `HOME`, XDG config/state/cache/runtime directories",
    "`FIELDWORK_SCROLLBACK_ENCRYPTION_ENABLED=false` inside that isolated state root",
    "Custom\n`FIELDWORK_DEBUG_TMUX_SESSION` and `FIELDWORK_DEBUG_ROOT` values are preserved by\n`scripts/debug-instance.sh env`",
    "`env` and `status` adopt the\nsession's stored root marker",
    "Desktop performance smoke",
    "Pairing smoke",
    "Website:",
    "UniFFI bindgen smoke",
    "iOS app v0:",
    "Android app v0:",
    "Android release artifact smoke:",
    "pnpm check:android-release-readiness:local",
    "It exposes `fieldwork`, the short `fw` alias that points at the same CLI dispatcher, and `fieldworkd`",
    "`fw` with no subcommand uses the same no-args fast path as `fieldwork`",
    "always creates an auto-named default `claude` session before attaching",
    "`fw pair` starts the same QR-pairing flow as `fieldwork pair`",
    "`fw <name>` is the named-session fast path after npm install",
    "the npm dispatcher test covers no-args, pair, named-session, and `fw completion bash` alias shapes against the platform-package fallback path",
    "forwards the invoked alias through `FIELDWORK_CLI_BIN_NAME` and `argv0`",
    "native help and completion generation still follow `fw` versus `fieldwork`",
    "`fw --help` renders `Usage: fw`",
    "the daemon dispatcher falls back to the matching platform package too",
    "Domain ownership, DNS control, and Cloudflare project credentials remain operator-owned external gates",
    "reserved for explicit operator-requested status refreshes",
    "committed `.terraform.lock.hcl` pins signed OCI provider checksums",
    "generated `.terraform/` caches stay ignored",
    "CI's Terraform Validate job installs Terraform 1.5.7",
    "shared `scripts/check-infra-terraform.sh` path",
    "exposed locally as `pnpm check:infra-terraform`",
    "uses `TF_PLUGIN_CACHE_DIR` outside the generated working directory",
    "removes generated `.terraform/` caches on exit",
    "also run `pnpm check:infra-terraform`",
    "Inspect daemon logs:",
    "User service lifecycle:",
  ]) {
    requireText(text, section, `docs/DEVELOPMENT.md must preserve section: ${section}`);
  }
  requireText(
    text,
    "uses Android Studio's bundled JBR when `JAVA_HOME` is unset or points to a pre-21 JDK",
    "docs/DEVELOPMENT.md must document the Android Gradle JDK 21 fallback",
  );
  requireText(
    text,
    "JDK 21+ is required because Robolectric runs the Android SDK 36 unit tests in that runtime",
    "docs/DEVELOPMENT.md must document the Android unit-test Java floor",
  );

  for (const phrase of [
    "creates a default `claude` session through a temp stub command, a `bash` session, and a `vim` TUI session",
    "verifies the iroh transport rejects a mismatched protocol version before pairing",
    "pairs the hidden iroh phone simulator through explicit desktop approval",
    "verifies the simulated pair flow completes within 15 seconds",
    "acknowledged Claude hook path updates\nthe matching session",
    "mismatched Codex hook exits nonzero with the\ndaemon error",
    "verifies reconnect-with-replay over iroh within 2 seconds from `last_seen_seq`",
    "creating an explicitly named desktop session",
    "a separate explicitly named session emits missed output",
    "verifies that the paired simulated phone receives `Forbidden` when it tries to create sessions, kill sessions, or emit agent-state hook events",
    "verifies that the same device identity is rejected with `Unauthorized`",
    "verifies that all last-known sessions are restored",
    "honors `CARGO_TARGET_DIR` for debug binaries",
    "preserving the host `CARGO_HOME` and `RUSTUP_HOME`",
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
    "SwiftTerm exactly to 1.13.0",
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
    "records the delayed diagnostics consent experience only after `AwaitingInput`, user input, and at least 10 output lines",
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
    "A 2026-05-30 local Android release refresh reran",
    "`apps/android/gradlew --no-daemon :app:bundleRelease`",
    "`apps/android/app/build/outputs/bundle/release/app-release.aab` is `57M`",
    "`af38adfb7541caf31c45afa216c61c4fa2dbce9ab1168ce91181f91a1f0ccca8`",
    "packaged protobuf manifest identity, version, uses-permission allowlist",
    "packaged protobuf manifest privacy surface",
    "required Firebase opt-out metadata",
    "release `BuildConfig` values for `app.fieldwork.android`, `versionCode=1`, `versionName=1.0`, `BUILD_TYPE=release`, `DEBUG=false`, biometric bypass off, and empty debug pairing code",
    "local unsigned AAB state with `--expect-unsigned`",
    "synthetic unsigned and signed AABs",
    "failure when signature entries are present under `--expect-unsigned`",
    "current Compose tree exposes the Pair button itself without stable visible text",
    "forbidden location permission",
    "missing notification permission",
    "terminal-content metadata such as `last_line`",
    "debug `BuildConfig`",
    "debuggable manifest",
    "Signed mode requires `META-INF` signature entries, successful `jarsigner -verify -certs`, a `jar verified` marker, and no Android Debug certificate subject",
    "signed-looking bundle whose `jarsigner` verification fails",
    "zero-exit `jarsigner` output without `jar verified`",
    "Android Debug certificate output",
    "`pnpm test:android-aab-signing-smoke` signs a temporary copy of the current real AAB",
    "deletes the temporary keystore and signed bundle afterward",
    "Android Studio's bundled `jarsigner` also reports `jar is unsigned`",
    "A 2026-05-25 direct-adb debug APK hygiene refresh found a retained",
    "`pnpm check:android-debug-apk` now\nrejects stale legacy JSON pairing payload in `classes*.dex`",
    "`node scripts/test-android-debug-apk-verifier.mjs`\ncovers stale legacy payload, explicit legacy-payload mode, missing-ABI",
    "`pnpm check:local-release -- --with-artifacts` runs the current debug APK\nartifact check alongside the AAB checks",
    "`pnpm check:android-release-readiness:local` is the consolidated local Android release preflight",
    "falling back to an internal temporary `fw`/`fieldwork`/`fieldworkd` shim backed by repo-local `target/release/fieldwork` and `target/release/fieldworkd`",
    "that fallback must prove `Usage: fw`, `Usage: fw doctor`, and `Usage: fieldworkd`",
    "Strict `pnpm check:android-release-readiness` requires current `fw` and `fieldworkd` commands on `PATH`",
    "node scripts/verify-android-aab.mjs --expect-signed",
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
    "retries only locked debug-launch and\nsession-subscription timing outliers once with the same strict limits",
    "every\nother script failure fails closed and preserves the captured wrapper output path",
    "fails closed unless exactly one boot-complete adb device is\navailable",
    "latest hosted-relay aggregate\nrun on 2026-05-29 passed on `emulator-5554`",
    "`TotalTime=6448ms`",
    "`pair_flow_ms=1420`",
    "`visible_ms=5493`",
    "8437/14400 nonblack samples",
    "checks that `TotalTime` stays below the debug-smoke limit",
    "rejects system ANR dialogs in the UI tree",
    "requires the locked `Unlock` surface",
    "FIELDWORK_ANDROID_BIOMETRIC_BYPASS=true",
    "FIELDWORK_ANDROID_PAIRING_CODE",
    "approves the Android pairing from the desktop CLI",
    "measures the debug-app Pair tap through explicit desktop approval completion",
    "first full-width enabled clickable control below it",
    "pins that accessibility-tree shape",
    "local 15-second emulator bound",
    "Latest focused run passed on `emulator-5554` with `pair_flow_ms=2206`",
    "physical QR camera pair-flow timing",
    "opens the terminal",
    "backgrounds and foregrounds the app",
    "sends mobile-originated input into the PTY",
    "separately approved verifier client",
    "replayed terminal bytes",
    "fw_subscribe_session",
    "local 8-second emulator bound",
    "subscription_attach_ok",
    "falls back to file-backed `uiautomator` dumps when direct streaming hangs",
    "Latest focused run passed on `emulator-5554` with `visible_ms=2904`",
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
    "empty `FIELDWORK_DEBUG_PAIRING_CODE`",
    "A follow-up raw adb locked-launch baseline on 2026-05-19",
    "`TotalTime=2078ms`",
    "`/tmp/fieldwork-adb-launch.png`",
    "`/tmp/fieldwork-adb-ui.xml`",
    "empty Fieldwork crash buffer",
    "A 2026-05-19 raw adb emulator QA refresh",
    "`TotalTime=5297ms`",
    "`/tmp/fieldwork-adb-direct-20260519225027/default.png`",
    "`/tmp/fieldwork-adb-direct-20260519225027/default-ui.xml`",
    "`/tmp/fieldwork-adb-direct-20260519225027/default-logcat.log`",
    "`/tmp/fieldwork-adb-direct-20260519225027/default-crash.log`",
    "`FIELDWORK_ANDROID_BIOMETRIC_BYPASS=true`",
    "`FIELDWORK_ANDROID_PAIRING_CODE`",
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
    "direct locked-launch refresh on a freshly booted `Medium_Phone_API_36.1` emulator",
    "`LaunchState: COLD`",
    "`TotalTime=1919ms`",
    "`/tmp/fieldwork-adb-direct-20260520092447/default-locked.png`",
    "`/tmp/fieldwork-adb-direct-20260520092447/default-ui.xml`",
    "`/tmp/fieldwork-adb-direct-20260520092447/default-logcat.log`",
    "`/tmp/fieldwork-adb-direct-20260520092447/default-app-pid-logcat.log`",
    "`/tmp/fieldwork-adb-direct-20260520092447/default-crash.log`",
    "1080x2400 screenshot plus `text=\"Unlock\"`",
    "A later 2026-05-21 direct adb locked-launch refresh reinstalled the default",
    "`TotalTime=976ms`",
    "`/tmp/fieldwork-adb-direct-20260521-locked-refresh/locked.png`",
    "`locked-ui.xml`, `logcat.log`, and an empty `crash.log`",
    "targeted logcat scanning\nfound no Fieldwork `FATAL EXCEPTION` or ANR entries",
    "A 2026-05-22 follow-up direct adb locked-launch refresh",
    "`/tmp/fieldwork-adb-refresh-20260522`",
    "`TotalTime=4572ms`",
    "`locked-logcat.log`, empty `locked-crash.log`, and `buildconfig.txt`",
    "`APPLICATION_ID = \"app.fieldwork.android\"`",
    "`BUILD_TYPE = \"debug\"`",
    "`DEBUG = Boolean.parseBoolean(\"true\")`",
    "app process remained focused",
    "`TotalTime=2360ms`",
    "`/tmp/fieldwork-adb-direct-20260520100608/default-locked.png`",
    "`/tmp/fieldwork-adb-direct-20260520100608/default-ui.xml`",
    "`/tmp/fieldwork-adb-direct-20260520100608/default-logcat.log`",
    "`/tmp/fieldwork-adb-direct-20260520100608/default-crash.log`",
    "`/tmp/fieldwork-adb-direct-pair-20260520100742`",
    "`ANDROID_ADB_DIRECT_READY`",
    "`android_adb_direct_ping`",
    "`/tmp/fieldwork-adb-direct-pair-20260520100742/terminal-after-input.png`",
    "`android-direct: android_adb_direct_ping`",
    "`sdk_gphone64_arm64`",
    "`/tmp/fieldwork-fw-direct-pair-20260520152507/dashboard.png`",
    "`/tmp/fieldwork-fw-direct-pair-20260520152507/after-pair.xml`",
    "`pair_flow_ms=423`",
    "`kazoo`",
    "`FieldworkRepository: listSessions returned 3 sessions`",
    "`/tmp/fieldwork-fw-direct-pair-20260520152507/dashboard-crash.log`",
    "`/tmp/fieldwork-empty-direct-20260520162209/empty-dashboard.xml`",
    "`/tmp/fieldwork-empty-direct-20260520162209/empty-dashboard.png`",
    "`Create one on your laptop with fw new.`",
    "returned 0 sessions",
    "`/tmp/fieldwork-empty-direct-20260520162209/default-locked.png`",
    "`/tmp/fieldwork-adb-pair-20260524205522`",
    "raw `adb` plus desktop CLI",
    "`bash · fieldwork` session",
    "`ANDROID_DIRECT_PAIR_READY`",
    "`Status: ok` and `TotalTime=1554ms`",
    "`pair_flow_ms=525`",
    "`fw_android_direct_pair_ok`",
    "`android-direct: fw_android_direct_pair_ok`",
    "`dashboard.png`, `dashboard-ui.xml`",
    "`terminal-before-input.png`, `terminal-after-input.png`",
    "`restored-buildconfig.txt`",
    "`restored-locked.png`, and `restored-locked-ui.xml`",
    "`FIELDWORK_BIOMETRIC_BYPASS = false`",
    "`FIELDWORK_DEBUG_PAIRING_CODE = \"\"`",
    "physical QR-camera, biometric, Play-signed release build",
    "`/tmp/fieldwork-adb-direct-20260525105201`",
    "`/tmp/fieldwork-adb-direct-pair-20260525105508`",
    "`TotalTime=3117ms`",
    "`pair_flow_ms=549`",
    "`directbash`",
    "`echo fw_android_direct_interactive_ok`",
    "`fieldwork pair-test --attach directbash`",
    "`fw_android_direct_interactive_ok`",
    "`FieldworkRepository: listSessions returned 2 sessions`",
    "`FIELDWORK_ANDROID_UI_DUMP_TIMEOUT_SECONDS`",
    "physical\nsigned-release phone gates remain unchecked",
    "`/tmp/fieldwork-android-release-install-20260530045350/apks/fieldwork-release-universal.apks`",
    "`universal.apk`",
    "`CN=Fieldwork Release Smoke`",
    "APK Signature Scheme v3",
    "`apksigner-universal.txt`",
    "`aapt-badging.txt`, `aapt-permissions.txt`, `aapt-manifest-tree.txt`",
    "`versionCode='1'`",
    "`versionName='1.0'`",
    "no `debuggable` marker",
    "`/tmp/fieldwork-android-release-install-20260530045350`",
    "`Status: ok`, `LaunchState: COLD`",
    "`TotalTime=1169ms`",
    "`launch-attempts.txt`",
    "`run-as: package not debuggable: app.fieldwork.android`",
    "installed-package `DEBUGGABLE` flag",
    "`scripts/verify-android-release-install-evidence.mjs`",
    "`--strict-release-device`",
    "rejects emulator\nevidence and the local `Fieldwork Release Smoke` certificate",
    "`scripts/test-android-release-install-evidence.mjs`",
    "`scripts/create-android-release-install-evidence-dir.mjs`",
    "`scripts/test-android-release-install-scaffold.mjs`",
    "`scripts/verify-android-release-signing-evidence.mjs`",
    "`scripts/test-android-release-signing-evidence.mjs`",
    "`scripts/create-android-release-signing-evidence-dir.mjs`",
    "`scripts/test-android-release-signing-scaffold.mjs`",
    "`pnpm scaffold:android-release-evidence-pack -- --print-dir`",
    "source-checkout `fw`/`fieldwork`/`fieldworkd` command shim",
    "`setup.sh`, `capture-order.md`, `manifest.json`, `readiness.sh`, and `verify.sh`",
    "`readiness.sh` prepends the generated command shim to `PATH`",
    "then runs `fw doctor` to prove the desktop CLI can auto-start and handshake with `fieldworkd`",
    "`verify.sh` runs every focused Android release evidence verifier in capture order",
    "strict release-install physical-device check",
    "`pnpm test:android-release-evidence-pack`",
    "`artifact-signing.txt`",
    "`jarsigner.txt`",
    "`workflow-run.txt`",
    "operator-owned release keystore",
    "`/tmp/fieldwork-direct-adb-20260524220022`",
    "`TotalTime=2571ms`",
    "`WaitTime=2606ms`",
    "`after-unlock-tap.png`",
    "`after-unlock-ui.xml`",
    "`after-unlock-logcat.log`",
    "`after-unlock-crash.log`",
    "`text=\"Unlock\"`",
    "`BiometricService`",
    "`Status: 7`",
    "`hasEnrollments: false`",
    "`FieldworkRepository: listSessions`",
    "`registerPushToken`",
    "`Attached`",
    "terminal-content exposure before unlock",
    "without fabricating verifier evidence",
    "not Play signing",
    "The first-round live-test evidence verifier now requires `package-info.txt`",
    "adb shell pm path app.fieldwork.android",
    "adb shell dumpsys package app.fieldwork.android",
    "`versionName=1.0` and `versionCode=1`",
    "requires `buildconfig.txt`",
    "`APPLICATION_ID = \"app.fieldwork.android\"`",
    "`BUILD_TYPE = \"debug\"`",
    "`DEBUG = Boolean.parseBoolean(\"true\")`",
    "`FIELDWORK_BIOMETRIC_BYPASS = false`",
    "`FIELDWORK_DEBUG_PAIRING_CODE = \"\"`",
    "`capture-checklist.md`",
    "stage-by-stage direct `adb` capture checklist",
    "dedicated active-dashboard\ncapture (`dashboard.png`, `dashboard-ui.xml`, `dashboard-logcat.log`, and\n`dashboard-crash.log`)",
    "the generated one-word bare-`fw` session, `refactoringjob`, and the\ndesktop-created shell/bash session",
    "`sessions.txt` must bind both the\ngenerated session and `refactoringjob` to `claude` rows",
    "`TotalTime=5105ms`",
    "`/tmp/fieldwork-adb-direct-restore-20260519225316/restored-locked.png`",
    "`/tmp/fieldwork-adb-direct-restore-20260519225316/restored-ui.xml`",
    "`FIELDWORK_DEBUG_PAIRING_CODE = \"\"`",
    "not release-device cold-start threshold evidence",
    "refreshSessionsRunsRepositoryWorkOffMainThread",
    "ANDROID_BACKGROUND_REPLAY_OUTPUT",
    "after_background_ok",
    "reconnect_ms=<elapsed-ms>",
    "ANDROID_RESTART_SCROLLBACK",
    "state-preservation\nrequirements were added",
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
    "Focused Android MobileTelemetry JVM tests verify diagnostics sharing defaults off",
    "declined consent resolves the one-time prompt without enabling diagnostics",
    "accepted consent persists as a local diagnostics preference without starting a crash-reporting SDK",
    "shown only after an attached session has reached `AwaitingInput`, the user has responded, and at least 10 later output lines arrive",
    "`pnpm check:telemetry-privacy`",
    "scans the packaged ZIP entries and inflated contents for removed crash SDK markers",
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
    "Codex `codex-cli 0.133.0` currently exposes `codex remote-control start`, `codex app-server --listen/proxy`, and `codex app-server daemon {start,enable-remote-control,...}` locally",
    "keeps the `codex` PTY command unchanged",
    "fieldwork hook codex-event",
    "JSONL event streams",
    "matching LocalCli Claude/Codex hook events",
    "update only matching PTY",
    "mismatched hook sources are rejected with an IPC error",
    "CLI hook adapter waits for the daemon acknowledgement",
    "missing session or\nmismatched agent source exits nonzero",
  ]) {
    requireText(text, phrase, `docs/DEVELOPMENT.md local agent hook coverage must include ${phrase}`);
  }

  for (const phrase of [
    "fake `launchctl`/`systemctl`",
    "macOS Gatekeeper preflight before launchd install",
    "KeepAlive` with `SuccessfulExit=false",
    "Restart=on-failure",
    "RestartSec=5",
    "service-manager rendering tests for LaunchAgent `KeepAlive`/`EnvironmentVariables` and systemd `Restart=on-failure`/`Environment=\"PATH=...\"`",
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
    "offline release-rust evidence contract",
    "GitHub Release asset metadata for all twelve archive/checksum/bundle files",
    "without creating release artifacts or running GitHub workflows",
    "`pnpm test:release-artifacts-evidence` and `pnpm test:release-artifacts-scaffold`",
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
    "offline post-publish npm release evidence contract",
    "exactly the five unscoped `1.0.0` packages",
    "rejects legacy scoped `@fieldwork/*` package names",
    "extra unscoped Fieldwork package names",
    "sanitized `release-npm.yml` workflow evidence",
    "public registry-state/provenance output",
    "without publishing packages or querying package-name availability",
    "`pnpm test:npm-release-evidence` and `pnpm test:npm-release-scaffold`",
    "`--expect-platform-published`",
    "`--expect-latest-version=1.0.0 --expect-provenance`",
    'retries the public registry with `node scripts/verify-npm-registry-state.mjs --expect-meta-published --expect-platform-published --expect-latest-version="$version" --expect-provenance`',
    "The relay TLS and OTLP smoke scripts honor `FIELDWORK_RELAY_BINARY`",
    "prefer the existing `target/release/fieldwork-relay`",
    "Darwin desktop artifacts build without Apple credentials",
    "use `codesign --force --sign -` on `fieldwork` and `fieldworkd`",
    "run the macOS npm trust verifier before archive staging",
    "desktop npm path does not require Developer ID notarization",
    "offline macOS npm trust\nevidence contract",
    "installed unscoped npm package identity",
    "per-Darwin-package checksum or npm integrity verification plus npm/Sigstore\nprovenance verification for `fieldwork-darwin-arm64` and\n`fieldwork-darwin-x64`",
    "separate release-artifacts evidence gate",
    "legacy scoped `@fieldwork/*` package names",
    "FIELDWORK_PACKAGE_IDENTITY_FILE",
    "FIELDWORK_RELEASE_INTEGRITY_FILE",
    "FIELDWORK_VERIFY_COSIGN_SIGNATURE=1",
    "FIELDWORK_RELEASE_PLATFORMS=darwin-arm64,darwin-x64",
    "rejecting raw Apple\ncredentials, npm/GitHub tokens, legacy scoped `@fieldwork/*` package names, and\nterminal content",
    "codesign --display --verbose=4",
    "an ad-hoc or Developer ID\nsignature and absence of `com.apple.quarantine`",
    "Gatekeeper notarization is optional/deferred",
    "without signing binaries or running GitHub\nworkflows",
    "`pnpm test:macos-signing-evidence` and\n`pnpm test:macos-signing-scaffold`",
    "keeps App Store Connect upload JSON outside the repository workspace and cleans signing/upload assets",
    "Android release preflights Firebase/signing/Play secrets before toolchain setup and mobile build",
    "removes generated Firebase/signing files in an `always()` cleanup step",
    "cleans the decoded relay SSH key",
    "the Xcode project honors `FIELDWORK_SKIP_RUST_BUILD` before running `apps/ios/scripts/build-rust.sh`",
  ]) {
    requireText(text, phrase, `docs/DEVELOPMENT.md release artifact verification must include ${phrase}`);
  }

  for (const phrase of [
    "domain ownership, DNS control, and social-handle reservation are operator-owned external gates",
    "reserved for explicit operator-requested status refreshes",
    "GitHub org/repo creation is complete",
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
  if (packageJson.scripts?.["check:release-artifacts-evidence"] !== "node scripts/verify-release-artifacts-evidence.mjs") {
    failures.push("package.json must expose pnpm check:release-artifacts-evidence");
  }
  if (packageJson.scripts?.["scaffold:release-artifacts-evidence"] !== "node scripts/create-release-artifacts-evidence-dir.mjs") {
    failures.push("package.json must expose pnpm scaffold:release-artifacts-evidence");
  }
  if (packageJson.scripts?.["check:local-release"] !== "node scripts/check-local-release.mjs") {
    failures.push("package.json must expose pnpm check:local-release");
  }
  if (packageJson.scripts?.["check:local-release:full"] !== "node scripts/check-local-release.mjs --with-artifacts --with-runtime") {
    failures.push("package.json must expose pnpm check:local-release:full");
  }
  if (packageJson.scripts?.["check:live-testing-readiness"] !== "node scripts/check-live-testing-readiness.mjs") {
    failures.push("package.json must expose pnpm check:live-testing-readiness");
  }
  if (packageJson.scripts?.["check:live-testing-readiness:local"] !== "node scripts/check-live-testing-readiness.mjs --local-only") {
    failures.push("package.json must expose pnpm check:live-testing-readiness:local");
  }
  if (packageJson.scripts?.["test:live-testing-readiness"] !== "node scripts/check-live-testing-readiness.mjs --self-test") {
    failures.push("package.json must expose pnpm test:live-testing-readiness");
  }
  if (packageJson.scripts?.["scaffold:live-testing-fw-shim"] !== "node scripts/create-live-testing-fw-shim.mjs") {
    failures.push("package.json must expose pnpm scaffold:live-testing-fw-shim");
  }
  if (packageJson.scripts?.["test:live-testing-fw-shim"] !== "node scripts/test-live-testing-fw-shim.mjs") {
    failures.push("package.json must expose pnpm test:live-testing-fw-shim");
  }
  if (packageJson.scripts?.["scaffold:live-testing-pack"] !== "node scripts/create-live-testing-pack.mjs") {
    failures.push("package.json must expose pnpm scaffold:live-testing-pack");
  }
  if (packageJson.scripts?.["test:live-testing-pack"] !== "node scripts/test-live-testing-pack.mjs") {
    failures.push("package.json must expose pnpm test:live-testing-pack");
  }
  if (packageJson.scripts?.["check:android-release-readiness"] !== "node scripts/check-android-release-readiness.mjs") {
    failures.push("package.json must expose pnpm check:android-release-readiness");
  }
  if (packageJson.scripts?.["check:android-release-readiness:local"] !== "node scripts/check-android-release-readiness.mjs --local-only") {
    failures.push("package.json must expose pnpm check:android-release-readiness:local");
  }
  if (packageJson.scripts?.["test:android-release-readiness"] !== "node scripts/check-android-release-readiness.mjs --self-test") {
    failures.push("package.json must expose pnpm test:android-release-readiness");
  }
  if (packageJson.scripts?.["scaffold:android-release-evidence-pack"] !== "node scripts/create-android-release-evidence-pack.mjs") {
    failures.push("package.json must expose pnpm scaffold:android-release-evidence-pack");
  }
  if (packageJson.scripts?.["test:android-release-evidence-pack"] !== "node scripts/test-android-release-evidence-pack.mjs") {
    failures.push("package.json must expose pnpm test:android-release-evidence-pack");
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
  if (packageJson.scripts?.["check:npm-release-evidence"] !== "node scripts/verify-npm-release-evidence.mjs") {
    failures.push("package.json must expose pnpm check:npm-release-evidence");
  }
  if (packageJson.scripts?.["scaffold:npm-release-evidence"] !== "node scripts/create-npm-release-evidence-dir.mjs") {
    failures.push("package.json must expose pnpm scaffold:npm-release-evidence");
  }
  if (packageJson.scripts?.["test:npm-registry-state"] !== "node scripts/test-npm-registry-state.mjs") {
    failures.push("package.json must expose pnpm test:npm-registry-state");
  }
  if (packageJson.scripts?.["test:npm-release-evidence"] !== "node scripts/test-npm-release-evidence.mjs") {
    failures.push("package.json must expose pnpm test:npm-release-evidence");
  }
  if (packageJson.scripts?.["test:npm-release-scaffold"] !== "node scripts/test-npm-release-scaffold.mjs") {
    failures.push("package.json must expose pnpm test:npm-release-scaffold");
  }
  if (packageJson.scripts?.["check:macos-signing-evidence"] !== "node scripts/verify-macos-signing-evidence.mjs") {
    failures.push("package.json must expose pnpm check:macos-signing-evidence");
  }
  if (packageJson.scripts?.["scaffold:macos-signing-evidence"] !== "node scripts/create-macos-signing-evidence-dir.mjs") {
    failures.push("package.json must expose pnpm scaffold:macos-signing-evidence");
  }
  if (packageJson.scripts?.["test:macos-signing-evidence"] !== "node scripts/test-macos-signing-evidence.mjs") {
    failures.push("package.json must expose pnpm test:macos-signing-evidence");
  }
  if (packageJson.scripts?.["test:macos-signing-scaffold"] !== "node scripts/test-macos-signing-scaffold.mjs") {
    failures.push("package.json must expose pnpm test:macos-signing-scaffold");
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
  if (packageJson.scripts?.["test:cli-doctor"] !== "scripts/smoke-cli-doctor.sh") {
    failures.push("package.json must expose pnpm test:cli-doctor");
  }
  if (packageJson.scripts?.["test:cli-no-args"] !== "scripts/smoke-cli-no-args.sh") {
    failures.push("package.json must expose pnpm test:cli-no-args");
  }
  if (packageJson.scripts?.["test:android-aab-verifier"] !== "node scripts/test-android-aab-verifier.mjs") {
    failures.push("package.json must expose pnpm test:android-aab-verifier");
  }
  if (packageJson.scripts?.["check:android-debug-apk"] !== "node scripts/verify-android-debug-apk.mjs") {
    failures.push("package.json must expose pnpm check:android-debug-apk");
  }
  if (packageJson.scripts?.["test:android-debug-apk-verifier"] !== "node scripts/test-android-debug-apk-verifier.mjs") {
    failures.push("package.json must expose pnpm test:android-debug-apk-verifier");
  }
  if (packageJson.scripts?.["test:android-aab-signing-smoke"] !== "node scripts/test-android-aab-signing-smoke.mjs") {
    failures.push("package.json must expose pnpm test:android-aab-signing-smoke");
  }
  if (packageJson.scripts?.["check:android-release-signing-evidence"] !== "node scripts/verify-android-release-signing-evidence.mjs") {
    failures.push("package.json must expose pnpm check:android-release-signing-evidence");
  }
  if (packageJson.scripts?.["scaffold:android-release-signing-evidence"] !== "node scripts/create-android-release-signing-evidence-dir.mjs") {
    failures.push("package.json must expose pnpm scaffold:android-release-signing-evidence");
  }
  if (packageJson.scripts?.["test:android-release-signing-evidence"] !== "node scripts/test-android-release-signing-evidence.mjs") {
    failures.push("package.json must expose pnpm test:android-release-signing-evidence");
  }
  if (packageJson.scripts?.["test:android-release-signing-scaffold"] !== "node scripts/test-android-release-signing-scaffold.mjs") {
    failures.push("package.json must expose pnpm test:android-release-signing-scaffold");
  }
  if (packageJson.scripts?.["test:android-pair-button-picker"] !== "node scripts/test-android-pair-button-picker.mjs") {
    failures.push("package.json must expose pnpm test:android-pair-button-picker");
  }
  if (packageJson.scripts?.["test:release-artifacts-evidence"] !== "node scripts/test-release-artifacts-evidence.mjs") {
    failures.push("package.json must expose pnpm test:release-artifacts-evidence");
  }
  if (packageJson.scripts?.["test:release-artifacts-scaffold"] !== "node scripts/test-release-artifacts-scaffold.mjs") {
    failures.push("package.json must expose pnpm test:release-artifacts-scaffold");
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
  if (packageJson.scripts?.["build:local-npm-artifacts"] !== "scripts/build-local-npm-artifacts.sh") {
    failures.push("package.json must expose pnpm build:local-npm-artifacts");
  }
  requireText(
    allFiles.localNpmArtifacts,
    "prepare_darwin_trust darwin-arm64",
    "local npm artifact staging must ad-hoc sign and verify darwin-arm64 package binaries",
  );
  requireText(
    allFiles.localNpmArtifacts,
    "prepare_darwin_trust darwin-x64",
    "local npm artifact staging must ad-hoc sign and verify darwin-x64 package binaries",
  );
  requireText(
    allFiles.localNpmArtifacts,
    "node scripts/verify-macos-signing.mjs \"$out\"",
    "local npm artifact staging must run the macOS npm trust verifier on staged Darwin package bins",
  );
  requireText(
    allFiles.localNpmArtifacts,
    "FIELDWORK_LOCAL_NPM_ARCHIVE_DIR",
    "local npm artifact staging must allow overriding the local package archive output directory",
  );
  requireText(
    allFiles.localNpmArtifacts,
    "target_root_abs/local-npm-artifacts",
    "local npm artifact staging must keep local tarballs under target/ by default",
  );
  requireText(
    allFiles.localNpmArtifacts,
    "archive_platform_package darwin-arm64",
    "local npm artifact staging must archive the darwin-arm64 package candidate",
  );
  requireText(
    allFiles.localNpmArtifacts,
    "node scripts/verify-macos-signing.mjs \"$archive\"",
    "local npm artifact staging must run the macOS npm trust verifier on local Darwin tarballs",
  );
  requireText(allFiles.ci, "node scripts/verify-development-doc.mjs", "CI must run the development doc verifier");
  requireText(allFiles.ci, "node --check scripts/check-local-release.mjs", "CI must syntax-check the local release aggregate verifier");
  requireText(
    allFiles.ci,
    "node scripts/check-local-release.mjs --list --with-artifacts --with-runtime",
    "CI must list-check all local release aggregate modes",
  );
  requireText(allFiles.ci, "node scripts/verify-no-ship-markers.mjs", "CI must run the no-ship marker verifier");
  requireText(allFiles.ci, "node scripts/verify-no-ship-markers.mjs --self-test", "CI must run the no-ship marker self-test");
  requireText(allFiles.ci, "sudo apt-get update && sudo apt-get install -y expect vim", "CI must install expect and vim before local CLI/handoff smokes");
  requireText(allFiles.ci, "scripts/smoke-cli-no-args.sh", "CI must run the CLI no-args raw-terminal smoke");
  requireText(allFiles.localRelease, "scripts/verify-release-audit.mjs", "local release gate must include the release audit verifier");
  requireText(allFiles.localRelease, "\"workflow YAML syntax\"", "local release gate must include workflow YAML syntax parsing");
  requireText(allFiles.localRelease, "Dir[\".github/workflows/*.yml\"].sort.each", "local release gate must parse all workflow YAML files");
  requireText(allFiles.localRelease, "\"release workflow run-block syntax self-test\"", "local release gate must include release workflow run-block syntax self-test");
  requireText(allFiles.localRelease, "scripts/verify-release-workflows.mjs\", \"--self-test\"", "local release gate must run the release workflow self-test");
  requireText(allFiles.localRelease, "\"Node script syntax\"", "local release gate must include Node script syntax parsing");
  requireText(allFiles.localRelease, "for script in scripts/*.mjs", "local release gate must syntax-check every checked-in Node script");
  requireText(allFiles.localRelease, "node --check \"$script\"", "local release gate must use node --check for Node script syntax checks");
  requireText(allFiles.localRelease, "\"shell script syntax\"", "local release gate must include shell script syntax parsing");
  requireText(allFiles.localRelease, "for script in scripts/*.sh apps/ios/scripts/*.sh", "local release gate must syntax-check every checked-in shell script");
  requireText(allFiles.localRelease, "bash -n \"$script\"", "local release gate must use bash -n for shell script syntax checks");
  requireText(allFiles.localRelease, "\"structured asset syntax\"", "local release gate must include structured asset syntax checks");
  requireText(allFiles.localRelease, "scripts/verify-structured-assets.mjs", "local release gate must run the structured asset verifier");
  requireText(allFiles.structuredAssets, "*.json", "structured asset verifier must parse tracked JSON assets");
  requireText(allFiles.structuredAssets, "*.toml", "structured asset verifier must parse tracked TOML assets");
  requireText(allFiles.structuredAssets, "tomllib", "structured asset verifier must use a real TOML parser");
  requireText(allFiles.structuredAssets, "plutil", "structured asset verifier must lint iOS plist/project metadata");
  requireText(allFiles.structuredAssets, "xmllint", "structured asset verifier must lint Android XML and docs SVG assets");
  requireText(allFiles.structuredAssets, "apps/android/app/src/main/AndroidManifest.xml", "structured asset verifier must include the Android manifest");
  requireText(allFiles.structuredAssets, "docs/assets/*.svg", "structured asset verifier must include docs SVG assets");
  requireText(allFiles.localRelease, "scripts/verify-no-ship-markers.mjs", "local release gate must include the no-ship marker verifier");
  requireText(allFiles.localRelease, "scripts/verify-no-ship-markers.mjs\", \"--self-test", "local release gate must include the no-ship marker self-test");
  requireText(allFiles.localRelease, "scripts/test-release-artifacts.mjs", "local release gate must include deterministic release-artifact verifier coverage");
  requireText(allFiles.localRelease, "scripts/check-live-testing-readiness.mjs\", \"--self-test", "local release gate must include deterministic live-testing readiness coverage");
  requireText(allFiles.localRelease, "scripts/test-live-testing-fw-shim.mjs", "local release gate must include deterministic live-testing fw shim coverage");
  requireText(allFiles.localRelease, "scripts/test-live-testing-pack.mjs", "local release gate must include deterministic live-testing pack scaffold coverage");
  requireText(allFiles.localRelease, "scripts/check-android-release-readiness.mjs\", \"--self-test", "local release gate must include deterministic Android release readiness coverage");
  requireText(allFiles.localRelease, "scripts/test-android-release-evidence-pack.mjs", "local release gate must include deterministic Android release evidence pack scaffold coverage");
  requireText(allFiles.localRelease, "scripts/test-android-release-install-scaffold.mjs", "local release gate must include deterministic Android release-install scaffold coverage");
  requireText(allFiles.localRelease, "scripts/test-android-release-signing-evidence.mjs", "local release gate must include deterministic Android release-signing verifier coverage");
  requireText(allFiles.localRelease, "scripts/test-android-release-signing-scaffold.mjs", "local release gate must include deterministic Android release-signing scaffold coverage");
  requireText(allFiles.localRelease, "scripts/test-npm-artifact-pack.mjs", "local release gate must include deterministic npm artifact packaging coverage");
  requireText(allFiles.localRelease, "scripts/test-android-pair-button-picker.mjs", "local release gate must include deterministic Android pair-button picker coverage");
  requireText(allFiles.localRelease, "scripts/verify-uniffi-bindings.mjs", "local release gate must include UniFFI binding verification");
  requireText(allFiles.localRelease, "scripts/publish-npm-packages.mjs\", \"--check-ready", "artifact-aware local release gate must include publish-readiness verification");
  requireText(allFiles.localRelease, "scripts/verify-npm-packages.mjs\", \"--require-binaries", "artifact-aware local release gate must include staged npm binary verification");
  requireText(allFiles.localRelease, "\"npm meta dry-run pack\", npm, [\"pack\", \"./packages/cli\", \"--dry-run\", \"--json\"]", "artifact-aware local release gate must include npm meta dry-run pack");
  requireText(allFiles.localRelease, "cleanNpmEnv()", "local release gate must sanitize inherited npm config for dry-run pack");
  requireText(allFiles.localRelease, "\"Android AAB artifact\", node, [\"scripts/verify-android-aab.mjs\", \"--expect-unsigned\"]", "artifact-aware local release gate must call the Android AAB verifier directly");
  requireText(allFiles.localRelease, "scripts/test-android-debug-apk-verifier.mjs", "local release gate must include Android debug APK verifier coverage");
  requireText(allFiles.localRelease, "\"Android debug APK artifact\", node, [\"scripts/verify-android-debug-apk.mjs\"]", "artifact-aware local release gate must call the Android debug APK verifier directly");
  requireText(allFiles.localRelease, "\"Android AAB local signing smoke\", node, [\"scripts/test-android-aab-signing-smoke.mjs\"]", "artifact-aware local release gate must sign a temporary copy of the current Android AAB");
  requireText(allFiles.localNpmArtifacts, "cargo build --release -p fieldwork-cli -p fieldwork-daemon -p fieldwork-relay", "local npm artifact builder must build host release binaries");
  requireText(allFiles.localNpmArtifacts, "cargo zigbuild --release --target x86_64-unknown-linux-gnu -p fieldwork-cli -p fieldwork-daemon", "local npm artifact builder must build Linux x64 package binaries");
  requireText(allFiles.localNpmArtifacts, "cargo zigbuild --release --target aarch64-unknown-linux-gnu -p fieldwork-cli -p fieldwork-daemon", "local npm artifact builder must build Linux arm64 package binaries");
  requireText(allFiles.localNpmArtifacts, "node scripts/verify-npm-packages.mjs --require-binaries", "local npm artifact builder must verify staged package binaries");
  requireText(allFiles.localNpmArtifacts, "node scripts/publish-npm-packages.mjs --check-ready", "local npm artifact builder must verify publish readiness");
  requireText(allFiles.localRelease, "\"CLI doctor smoke\", bash, [\"scripts/smoke-cli-doctor.sh\"]", "runtime local release gate must include CLI doctor smoke");
  requireText(allFiles.localRelease, "\"CLI no-args smoke\", bash, [\"scripts/smoke-cli-no-args.sh\"]", "runtime local release gate must include CLI no-args smoke");
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
  requireText(
    allFiles.development,
    "The doctor smoke builds the debug CLI/daemon in an isolated temp environment,\nverifies `fieldwork doctor --no-start` fails before a daemon is running",
    "docs/DEVELOPMENT.md must document the CLI doctor smoke coverage",
  );
  requireText(allFiles.doctorSmoke, '"$fieldwork" doctor --no-start >"$tmp/doctor-before.log"', "CLI doctor smoke must prove --no-start fails before daemon startup");
  requireText(allFiles.doctorSmoke, '"$fieldworkd" >"$tmp/daemon.log" 2>&1 &', "CLI doctor smoke must start an isolated daemon");
  requireText(allFiles.doctorSmoke, '"$fieldwork" new --name doctor_shell bash -lc', "CLI doctor smoke must create a desktop session for session-list verification");
  requireText(allFiles.doctorSmoke, '"$fw" doctor --no-start >"$tmp/doctor.log"', "CLI doctor smoke must run doctor through the fw alias");
  requireText(allFiles.doctorSmoke, 'grep -Fq "socket parent: ok', "CLI doctor smoke must verify socket parent hardening display");
  requireText(allFiles.doctorSmoke, 'grep -Fq "socket file: ok', "CLI doctor smoke must verify socket file hardening display");
  requireText(allFiles.doctorSmoke, 'grep -Fq "protocol: ok (contract v2)"', "CLI doctor smoke must verify the protocol contract display");
  requireText(allFiles.doctorSmoke, 'grep -Fq "session list: ok (1 session(s))"', "CLI doctor smoke must verify daemon-backed session count");
  requireText(allFiles.doctorSmoke, '"$fw" doctor --help >"$tmp/doctor-help.log"', "CLI doctor smoke must verify fw doctor help");
  requireText(
    allFiles.development,
    "two bare invocations, one through `fieldwork` and one through a temp `fw` alias,\ncreate two distinct auto-named default `claude` sessions",
    "docs/DEVELOPMENT.md must document the CLI no-args smoke coverage",
  );
  requireText(
    allFiles.development,
    "lists the isolated daemon through\nthe same `fw` alias",
    "docs/DEVELOPMENT.md must document that the CLI no-args smoke verifies the fw alias list path",
  );
  requireText(allFiles.noArgsSmoke, 'ln -sf "$fieldwork" "$fw"', "CLI no-args smoke must create a real fw alias to the debug CLI");
  requireText(allFiles.noArgsSmoke, 'run_no_args_and_detach fw "$fw"', "CLI no-args smoke must invoke the fw alias");
  requireText(allFiles.noArgsSmoke, '"$fw" ls >"$tmp/sessions.log"', "CLI no-args smoke must list sessions through the fw alias");
  requireText(
    allFiles.development,
    "before detaching with\nthe tmux-style `Ctrl-B` then `D` chord",
    "docs/DEVELOPMENT.md must document CLI no-args raw-terminal detach coverage",
  );
  requireText(allFiles.ci, "node scripts/test-ios-prereqs.mjs", "CI must run the deterministic iOS prereq tests");
  requireText(allFiles.ci, "node scripts/test-android-aab-verifier.mjs", "CI must run the deterministic Android AAB verifier tests");
  requireText(allFiles.ci, "node scripts/test-android-debug-apk-verifier.mjs", "CI must run the deterministic Android debug APK verifier tests");
  requireText(allFiles.ci, "node scripts/test-android-pair-button-picker.mjs", "CI must run the deterministic Android pair-button picker test");
  requireText(allFiles.ci, "node scripts/test-external-status-refresh.mjs", "CI must run the deterministic external status refresh guard test");
  requireText(
    allFiles.development,
    "syntax-checks every checked-in Node script under `scripts/*.mjs` with\n`node --check`",
    "docs/DEVELOPMENT.md must document Node script syntax coverage in local release",
  );
  requireText(
    allFiles.development,
    "every checked-in shell script under `scripts/*.sh` and\n`apps/ios/scripts/*.sh`",
    "docs/DEVELOPMENT.md must document shell script syntax coverage in local release",
  );
  requireText(
    allFiles.development,
    "parses tracked repo JSON and TOML package/config\nassets",
    "docs/DEVELOPMENT.md must document JSON/TOML asset syntax coverage in local release",
  );
  requireText(
    allFiles.development,
    "Python's standard `tomllib` for TOML",
    "docs/DEVELOPMENT.md must document TOML parser coverage in local release",
  );
  requireText(
    allFiles.development,
    "lints the iOS project\nplist, Info.plist, and entitlements with `plutil -lint` when available, uses a\nportable XML-plist parse plus Xcode project structural fallback on non-macOS\nhosts",
    "docs/DEVELOPMENT.md must document plist/project syntax coverage in local release",
  );
  requireText(
    allFiles.development,
    "Android XML resources plus docs SVG assets with\n`xmllint --noout`",
    "docs/DEVELOPMENT.md must document Android XML and SVG syntax coverage in local release",
  );
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
    const scriptText = read(script);
    requireText(
      scriptText,
      'adb -s "$serial" logcat -b crash -c',
      `${script} must clear the Android crash log before collecting smoke evidence`,
    );
    if (script !== "scripts/smoke-android-debug.sh") {
      requireText(
        scriptText,
        'FIELDWORK_RELAY_SIGNING_KEY_B64="$relay_signing_key"',
        `${script} must set a deterministic test relay signing key for isolated typed-code pairing`,
      );
      rejectText(
        scriptText,
        "aps1-1.relay.n0.iroh-canary.iroh.link",
        `${script} must not hardcode a public iroh relay for local emulator smokes`,
      );
    }
  }
  requireText(allFiles.androidEmulatorAll, "--list", "Android emulator aggregate must expose a list mode");
  requireText(allFiles.androidEmulatorAll, "boot-complete", "Android emulator aggregate must require a boot-complete device");
  requireText(allFiles.androidEmulatorAll, "above debug smoke limit", "Android emulator aggregate must only retry debug-smoke timing outliers");
  requireText(allFiles.androidEmulatorAll, "retrying once with the same strict limit", "Android emulator aggregate must document strict retry behavior");
  requireText(allFiles.androidEmulatorAll, "captured output", "Android emulator aggregate must preserve failing smoke output");
  requireText(allFiles.androidGradlew, "java_major_version()", "Android Gradle launcher must inspect JAVA_HOME major version");
  requireText(allFiles.androidGradlew, "current_java_major", "Android Gradle launcher must detect old JAVA_HOME values");
  requireText(allFiles.androidGradlew, '"$current_java_major" -lt 21', "Android Gradle launcher must fall back to Android Studio JBR for pre-21 JAVA_HOME");
  requireText(allFiles.androidGradlew, '"$java_major" -lt 21', "Android Gradle launcher must reject pre-21 Java after fallback");
  requireText(allFiles.androidGradlew, "JDK 21+ for Android SDK 36 Robolectric tests", "Android Gradle launcher must explain the Robolectric Java 21 requirement");
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
