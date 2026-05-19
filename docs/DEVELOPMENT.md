# Development

Required local tools:

- Rust 1.94.0 from `rust-toolchain.toml`
- `cargo`
- `cargo-nextest`
- `cargo-deny`
- `cargo-audit`
- `cargo-zigbuild`
- `cargo-ndk`
- Zig 0.16+ for Linux release cross-builds
- Android Studio with SDK 36 and NDK r27 for Android artifacts

15-minute source build path:

```sh
rustup show
cargo build --workspace
cargo nextest run --workspace
target/debug/fieldwork version
target/debug/fieldwork daemon start
target/debug/fieldwork new bash -lc 'echo fieldwork source build ok'
target/debug/fieldwork ls
```

That path builds the Rust workspace from source, verifies the behavior tests, starts a local daemon, creates an arbitrary PTY-backed session, and lists it. Mobile artifacts, release signing, relay deployment, and provider push are separate release gates below because they need platform SDKs, credentials, or physical devices.

Optional local pre-commit hooks are defined in `.pre-commit-config.yaml`:

```sh
pre-commit install
pre-commit run --all-files
```

The hooks run `cargo fmt --check`, `cargo clippy --workspace -- -D warnings`,
`cargo nextest run --workspace --no-fail-fast`, and
`node scripts/verify-secret-boundaries.mjs` through the local toolchain.

Common checks:

```sh
pnpm check:local-release
cargo fmt --check
cargo clippy --workspace -- -D warnings
cargo nextest run --workspace
cargo test --workspace
cargo test --workspace --doc
cargo deny check
cargo audit
node scripts/verify-npm-packages.mjs
node scripts/verify-changesets-config.mjs
node scripts/generate-oss-notices.mjs --check
node scripts/verify-secret-boundaries.mjs
node scripts/test-npm-dispatcher.mjs
pnpm check:release-artifacts
node scripts/test-release-artifacts.mjs
node scripts/test-npm-registry-state.mjs
node scripts/test-external-status-refresh.mjs
node scripts/test-ios-prereqs.mjs
node scripts/test-npm-publish-plan.mjs
node scripts/test-npm-artifact-pack.mjs
node scripts/test-bun-install.mjs
pnpm test:android-unit
pnpm test:android-emulator
node scripts/test-android-aab-verifier.mjs
pnpm check:site
```

The current release checklist, local evidence, and external blockers are
tracked in `docs/RELEASE_AUDIT.md`.

`pnpm check:local-release` runs the deterministic source-side release gate:
workspace/package metadata, docs, community/legal scaffolding, privacy/security
boundaries, release workflow contracts, UniFFI binding surface, npm registry and
publish-plan fixtures, Bun optional-dependency behavior, release-artifact
verifier fixtures, and Android AAB verifier fixtures. It deliberately excludes
network account checks, live publishing, iOS SDK builds, Android emulator
runtime tests, physical-device checks, and hosted relay deployment. When the
local platform binaries and Android AAB are staged, run
`pnpm check:local-release -- --with-artifacts` to also verify the preserved AAB,
staged npm binaries, publish readiness, and meta-package dry-run pack. When
release binaries, Terraform, ffmpeg/ffprobe, and site dependencies are available,
run `pnpm check:local-release -- --with-runtime` to also verify the local
handoff smoke, demo video, site typecheck/build, Terraform fmt/init/validate,
relay TLS/OTLP loopbacks, and desktop cold-start thresholds. The flags can be
combined. Unless `CARGO_TARGET_DIR` is already set, the aggregate runs the local
handoff smoke with `/tmp/fieldwork-target-checks` so it does not grow the
repo-local `target/debug` cache. CI syntax-checks the
aggregate wrapper and list-checks the combined artifact/runtime mode so wrapper
drift is caught without duplicating the full artifact/runtime gate in pull
requests.

`pnpm check:release-artifacts` is intentionally fail-closed unless
`artifacts/` or `FIELDWORK_ARTIFACT_DIR` contains the release-rust/GitHub
Release archives, `.sha256` files, and `.bundle` attestations. Use
`pnpm test:release-artifacts` for deterministic local verifier coverage when
no release artifacts are present.

`cargo audit` currently exits successfully and reports RustSec warnings rather than high/critical CVEs: `adler` and `lru` through the terminal-state stack, `paste` through transitive network/image dependencies, and `bincode` because v1 local IPC is contractually bincode. `deny.toml` documents the supply-chain policy and the advisory exceptions that cargo-deny treats as blocking for the current v1 dependency graph.

The protocol crate uses insta snapshots for every current client/server message variant. To intentionally update those snapshots after a wire-protocol change:

```sh
INSTA_UPDATE=always cargo test -p fieldwork-protocol
git diff crates/protocol/src/snapshots
```

The daemon ring buffer has proptest coverage for randomized append/replay windows:

```sh
cargo test -p fieldwork-daemon ring::tests::snapshot_and_replay_match_last_capacity_bytes
```

The cold/stale attach snapshot gate also starts a real `vim /etc/hosts` PTY
session, forces the stale attach path, feeds `Attached.initial_bytes` into a
fresh in-process `wezterm-term` model, and compares the resulting alt-screen
cell state with the daemon's model:

```sh
cargo test -p fieldwork-daemon snapshot_tests::stale_attach_snapshot_rehydrates_real_vim_session
```

The UniFFI mobile core exposes `attach_session_from(id, last_seen_seq)` for warm reconnects. `AttachedSession.last_seen_seq()` advances from replayed initial bytes and live `Output.seq` offsets, where `Output.seq` is already the byte offset after the carried chunk. Focused mobile-core tests verify raw output bytes are delivered without UTF-8 decoding, that the reconnect offset advances to the live `Output.seq`, that a `yes | head -10000`-scale stream is delivered without dropped bytes or offset drift, and that daemon lag emits one terminal `Lag` frame before mobile-core returns after notifying the native sink. The `Lag.skipped_bytes` wire field contains skipped broadcast-message count, not byte count. The iOS service and Android repository cache the latest offset per session, and both terminal controllers reattach from that tracked offset:

```sh
cargo test -p fieldwork-mobile-core
```

Desktop release build matrix:

```sh
rustup target add aarch64-apple-darwin x86_64-apple-darwin x86_64-unknown-linux-gnu aarch64-unknown-linux-gnu
cargo build --release --target aarch64-apple-darwin -p fieldwork-cli -p fieldwork-daemon -p fieldwork-relay
cargo build --release --target x86_64-apple-darwin -p fieldwork-cli -p fieldwork-daemon -p fieldwork-relay
cargo zigbuild --release --target x86_64-unknown-linux-gnu -p fieldwork-cli -p fieldwork-daemon -p fieldwork-relay
cargo zigbuild --release --target aarch64-unknown-linux-gnu -p fieldwork-cli -p fieldwork-daemon -p fieldwork-relay
```

The Linux builds use `keyring` with its vendored DBus feature so the persistent Secret Service backend does not require `libdbus-1-dev` in the cross sysroot.

Local smoke:

```sh
target/debug/fieldwork new bash
target/debug/fieldwork ls
target/debug/fieldwork attach <session-id>
```

Open a second terminal and attach to the same session to verify multi-client broadcast.

Desktop performance smoke:

```sh
cargo build --release -p fieldwork-cli -p fieldwork-daemon
node scripts/measure-desktop-performance.mjs
```

The script runs one explicit warm-up sample to avoid build-machine first-exec page-cache/code-signing noise, then measures `target/release/fieldwork version` and daemon ready-to-local-IPC-handshake time in isolated temp directories. It still fails if any measured release-build sample exceeds the v1 thresholds from `PLAN.md` (`50ms` CLI, `200ms` daemon).

Pairing smoke:

```sh
scripts/smoke-local-handoff.sh
```

The script builds the debug CLI/daemon, creates an isolated temp `HOME` and `XDG_RUNTIME_DIR`, starts `fieldworkd`, creates a default `claude` session through a temp stub command, a `bash` session, and a `vim` TUI session, verifies the iroh transport rejects a mismatched protocol version before pairing, pairs the hidden iroh phone simulator through explicit desktop approval, verifies the simulated pair flow completes within 15 seconds, lists and attaches to the sessions over iroh, starts a mobile session-list subscription before creating another desktop session and verifies the new session appears through that subscription, sends mobile-originated input into `bash`, the default `claude`, and the subscribed desktop-created session and waits for matching output, detaches a simulated phone while a session emits missed output and verifies reconnect-with-replay over iroh within 2 seconds from `last_seen_seq`, verifies switched sessions do not receive each other's output markers, verifies that the paired simulated phone receives `Forbidden` when it tries to create sessions, kill sessions, or emit agent-state hook events, removes the simulated device, verifies that the same device identity is rejected with `Unauthorized`, kills and restarts the daemon, and verifies that all last-known sessions are restored. It honors `CARGO_TARGET_DIR` for debug binaries, so local runs can use `/tmp/fieldwork-target-checks` without recreating repo-local `target/debug`. It sets `FIELDWORK_IROH_SECRET_KEY_B64` and `FIELDWORK_SCROLLBACK_ENCRYPTION_ENABLED=false` only inside that temp environment so the smoke can run on headless machines without keychain prompts. Production-like runs should leave the iroh secret override unset, and release verification must still cover encrypted-at-rest persistence plus physical QR camera scan timing.

CI installs `vim` for the Rust matrix and for the `Local Handoff Smoke` job so the real `vim /etc/hosts` stale-attach snapshot gate, default-command spawn, arbitrary shell/TUI handoff, session-list subscription, pairing, iroh attach/input, warm reconnect replay, no-leak switching, revocation, and restart-restore behavior cannot regress without failing pull requests.

Website:

```sh
pnpm --dir site install --ignore-workspace --frozen-lockfile
pnpm check:site
pnpm build:site
```

The `site/` package is a static Astro build for `fieldwork.dev`. It is intentionally kept outside the npm distribution workspace so `fieldwork` package metadata stays isolated from site dependencies. The site renders the product, install, protocol, architecture, and privacy surfaces and imports the repository's screenshot-style SVG captures from `docs/assets/`. CI runs `pnpm --dir site install --ignore-workspace --frozen-lockfile` plus `pnpm check:site`; `.github/workflows/deploy-site.yml` builds the same output and deploys `site/dist` to Cloudflare Pages only when the external Cloudflare credentials exist. Domain ownership, DNS control, and Cloudflare project credentials remain operator-owned external gates. `node scripts/check-domain-status.mjs --operator-refresh --require-registered --require-dns` is reserved for explicit operator-requested status refreshes; it is not a routine local build check. For local visual smoke, start `pnpm --dir site dev --host 127.0.0.1 --port 4321`, then use `agent-browser --auto-connect` with fixed waits rather than `networkidle` because Astro keeps a Vite HMR websocket open. Latest browser smoke captured `/`, `/install`, `/architecture`, `/protocol`, and `/privacy` screenshots and saw no console output.

Demo video:

```sh
pnpm render:demo-video
pnpm check:demo-video
```

`scripts/render-demo-video.mjs` uses Quick Look plus `ffmpeg` to render the
repository's screenshot-style SVG captures and fixed v1 release-boundary slates
into `docs/assets/fieldwork-demo-v1.mp4`. `scripts/verify-demo-video.mjs`
checks the generated artifact is an H.264 1920x1080 video with an approximately
60-second duration, and also verifies the README/development/audit/plan docs
cite the regeneration and verification commands.

UniFFI bindgen smoke:

```sh
pnpm check:uniffi-bindings
cargo build -p fieldwork-mobile-core
cargo run -p fieldwork-mobile-core --bin uniffi-bindgen -- generate \
  --library target/debug/libfieldwork_mobile_core.dylib \
  --language swift \
  --out-dir target/uniffi-swift
cargo run -p fieldwork-mobile-core --bin uniffi-bindgen -- generate \
  --library target/debug/libfieldwork_mobile_core.dylib \
  --language kotlin \
  --out-dir target/uniffi-kotlin
```

`pnpm check:uniffi-bindings` is the focused local guard for the generated mobile API surface. It verifies `fieldwork-mobile-core` still builds as `lib`/`cdylib`/`staticlib`, keeps `uniffi-bindgen`, exports `FieldworkClient`, `AttachedSession`, `SessionListSink`, `ByteStreamSink`, `FieldworkError`, and the v1 pair/list/subscribe/attach/input/resize/detach/push-token methods, rejects generated mobile create/kill/session-command APIs, verifies the checked-in generated Kotlin binding under `apps/android/generated`, checks that Android Gradle compiles that generated source directory, and checks that the iOS build script and Xcode project generate/link `GeneratedRust/fieldwork_mobile_core.swift` plus `GeneratedRust/FieldworkCore.xcframework`.

Current local blocker for the full Week 4 platform matrix in this shell: the iOS SDK cannot be located because full Xcode is not selected. Apple lists Xcode 16.3 as the newest compatible full Xcode for this macOS 15.2 host; Xcode 16.4 requires macOS 15.3+ and Xcode 26.x requires macOS 15.6+/26.x. Apple App Store Connect uploads now require Xcode 26+ with an iOS 26+ SDK, so local development and TestFlight release verification intentionally use different gates. `xcodes` 1.6.2 and `aria2` 1.37.0_2 are installed, `.xcode-version` pins local Xcode `16.3`, the Rust iOS targets are installed, and `SwiftTerm` v1.13.0, `blink`, and `sentry-cocoa` 9.13.0 sources are present under `references/`. The Xcode project and committed SwiftPM lockfile pin SwiftTerm exactly to 1.13.0 and sentry-cocoa exactly to 9.13.0, and `pnpm check:mobile-privacy` verifies those pins. `scripts/check-ios-prereqs.sh` records the local prerequisite audit and supports `--download-xcode` for the credentialed Xcode 16.3 download path. The deterministic iOS prereq test covers missing `.xcode-version`, exact selected-Xcode comparison, and floored 70 GiB download headroom so CI protects the actionable failure paths without Apple credentials. When local Xcode is missing, the script now prints explicit next steps to authenticate, run `scripts/check-ios-prereqs.sh --download-xcode`, expand or place `Xcode_16.3.xip`, select `/Applications/Xcode-16.3.app/Contents/Developer`, run `sudo xcodebuild -runFirstLaunch`, rerun `pnpm check:ios-prereqs`, and then run `apps/ios/scripts/build-rust.sh`. `apps/ios/scripts/build-rust.sh` runs that prereq check before Cargo/Xcode work so local failures stop at the actionable Xcode/SDK diagnostic instead of failing later inside a dependency build script; it automatically switches to `--release` mode when the release-runner Xcode/SDK floor environment is present. `scripts/check-ios-prereqs.sh --release` verifies Xcode 26+ and iOS SDK 26+ for CI release runners. `xcodes update --data-source xcodeReleases` confirms Xcode 16.3 build `16E140` and Xcode 26.x releases through `26.5 (17F42)`. Generated `target/debug` and Android build intermediates were cleaned while preserving the release AAB; the latest local audit reports at least 70 GiB free in `~/Downloads`, satisfying the repo script's Xcode download/expansion guard. No Xcode `.xip` is present in `~/Downloads`: `scripts/check-ios-prereqs.sh --download-xcode` and direct `xcodes download 16.3 --data-source xcodeReleases` both report a missing Apple ID/password or require an authenticated Apple Developer session, direct `curl` against Apple's Xcode 16.3 XIP redirects to the unauthorized page, and the existing Chrome session is not signed into an account with access. Direct `fieldwork-mobile-core` iOS target builds fail at the prereq check because `xcrun --sdk iphoneos`/`iphonesimulator` cannot locate the SDKs. The iOS script is wired for `arm64` device plus `arm64`/`x86_64` simulator by building `aarch64-apple-ios`, `aarch64-apple-ios-sim`, and `x86_64-apple-ios`, then combining the simulator libraries with `lipo` before `xcodebuild -create-xcframework`. The Android side builds `fieldwork-mobile-core` for `arm64-v8a`, `armeabi-v7a`, and `x86_64` and generates Kotlin bindings through `apps/android/scripts/build-rust.sh`. The platform build scripts are `apps/ios/scripts/build-rust.sh` and `apps/android/scripts/build-rust.sh`.

iOS app v0:

```sh
open apps/ios/Fieldwork.xcodeproj
```

The Xcode target runs `apps/ios/scripts/build-rust.sh`, compiles the generated `GeneratedRust/fieldwork_mobile_core.swift`, links `GeneratedRust/FieldworkCore.xcframework`, and uses the exact SwiftPM pins for SwiftTerm and Sentry. The app currently implements QR pairing with explicit camera authorization handling, Keychain persistence, biometric-only Face ID/Touch ID gating, session list refresh plus `SubscribeSessions` streaming updates after unlock/pairing, SwiftTerm attach/input/resize/detach, a keyboard accessory bar, Settings, delayed crash-reporting consent, and APNs token registration plumbing. The iOS terminal controller buffers raw `Data` chunks and publishes an output revision on every byte arrival before optional UTF-8 fallback decoding, so SwiftTerm delivery is not gated on text decoding. The SwiftTerm renderer drains raw `Data` chunks into `uiView.feed(data:)`, converts them to `[UInt8]`, calls SwiftTerm's `feed(byteArray:)`, sends terminal input back as raw `Data`, and keeps the text fallback behind `#else`. The iOS service caches per-session `lastSeenSeq` offsets, passes cached offsets into `attachSessionFrom`, and the terminal controller reattaches from the latest `lastSeenSeq` after a daemon `Lag` before restarting the byte-stream subscription. The paired daemon record uses the data-protection Keychain with `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`, so it is not iCloud-synchronizable and is available only after device unlock. APNs permission and token registration are requested only after a saved or newly approved pairing exists and biometric unlock has succeeded; token callbacks are retained and sent through mobile-core once pairing is available. `Fieldwork.entitlements` carries `aps-environment = $(APS_ENVIRONMENT)`, with Debug set to `development` and Release set to `production`, so signed builds can receive APNs device tokens once the provisioning profile has the Push Notifications capability. Foreground APNs notifications use the relay's fixed generic copy, and notification taps carry only lowercase 64-character hex `session_id_hash`; the app resolves that hash against locally fetched sessions after biometric unlock. While locked, the SwiftUI root renders only the lock surface rather than a dimmed terminal/session view; stale foreground resumes trigger LocalAuthentication with `.deviceOwnerAuthenticationWithBiometrics` before session UI, session fetch/subscription, APNs permission, or terminal input is allowed. `MobileTelemetry.swift` uses `#if canImport(Sentry)` and `SwiftTermView.swift` uses `#if canImport(SwiftTerm)`, so local Swift static parsing can include every app/core/feature/UI Swift source even before full Xcode/SPM has resolved package modules. `FieldworkCoreStubs.swift` is syntax-only fallback code behind `#if FIELDWORK_STUBS`; `pnpm check:mobile-privacy` verifies the real generated UniFFI Swift binding and xcframework are wired into the Xcode target, that locked roots and stale input gates stay in place, that QR pairing requests camera access explicitly with pairing-only copy, that raw-byte output delivery is not text-decoding gated, that the SwiftTerm renderer uses raw byte-array rendering, that iOS `lastSeenSeq` lag reattach wiring stays in place, that the SwiftPM package pins stay exact, and that neither project build settings nor `release-ios.yml` enable `FIELDWORK_STUBS`.

Current local blocker for verifying the iOS target in this shell: `xcodebuild` is present only through Command Line Tools and reports that full Xcode is not selected, so the iOS SDK cannot be located. Run `pnpm check:ios-prereqs` for the local prerequisite audit and its concrete Xcode install/select recovery steps, then run the iOS build on a machine with Xcode 16.3 selected via `xcode-select`. TestFlight/App Store builds run through `release-ios.yml` on `macos-26`, where `pnpm check:ios-release-prereqs` verifies Xcode 26+/iOS 26+ before archiving. The release workflow also rejects provisioning profiles that do not match `app.fieldwork.ios` or do not include production `aps-environment`.

Store privacy submission prep lives in `docs/STORE_PRIVACY.md`. Keep it synchronized with `docs/PRIVACY.md`, the mobile manifests, Sentry settings, APNs/FCM payload tests, and the final release build before filling App Store Connect or Play Console. Run `pnpm check:store-privacy` after changing mobile privacy docs, notification payloads, mobile telemetry, or release workflows.

Android app v0:

```sh
cd apps/android
scripts/build-rust.sh
./gradlew assembleDebug
```

The Android app pins `org.connectbot:termlib:0.0.35` as the Week 5.5 renderer decision. It implements CameraX QR scanning, encrypted pairing persistence, biometric-only BiometricPrompt gating, sessions with `SubscribeSessions` streaming updates after unlock/pairing, termlib terminal attach/input/resize/detach, delayed crash-reporting consent, and FCM token registration plumbing. Focused Android JVM tests verify that the biometric freshness gate requires unlock before first use, does not reprompt immediately after a successful unlock, does not lock on fresh foreground resumes, and locks at the 5-minute stale foreground boundary. The Android terminal controller feeds raw `ByteArray` chunks directly to termlib without string decoding, caches per-session reconnect offsets through the repository, and reattaches from `lastSeenSeq` after a daemon `Lag` or attached-stream error. Focused Android JVM tests verify that the terminal controller refuses locked input before it reaches mobile-core, reattaches from the latest `lastSeenSeq` after a daemon `Lag`, reattaches from the latest `lastSeenSeq` after an attached-stream error, and records the delayed crash-reporting consent experience only after `AwaitingInput`, user input, and at least 10 output lines. The paired daemon record is stored in `EncryptedSharedPreferences` with an AES256-GCM master key, AES256-SIV preference-key encryption, AES256-GCM value encryption, and backup/transfer exclusions for `fieldwork_pairing.xml`; refreshed FCM tokens are queued in app-private `fieldwork_push_tokens.xml`, which is also excluded from full backup, cloud backup, and device transfer. The source manifest explicitly declares only `INTERNET`, `CAMERA`, `POST_NOTIFICATIONS`, and `USE_BIOMETRIC`; the merged manifest is verified after Android builds so dependency-added permissions stay auditable. Notification permission and FCM token sync are requested only after a saved or newly approved pairing exists and biometric unlock has succeeded. FCM token refresh callbacks only queue trimmed tokens; the service does not register tokens directly, and queued/current tokens are sent and cleared only by the paired-and-unlocked token sync path. Focused Android FcmTokenRegistrar JVM tests verify trimmed token storage, blank-token rejection, matching-token clear semantics, and clear-all unpair behavior. Focused Android FieldworkViewModel JVM tests verify paired-but-locked sync does not register FCM tokens, paired-and-unlocked sync registers queued/current tokens and clears queued tokens only after success, duplicate queued/current tokens are registered once, unpair clears queued FCM tokens, valid push taps remain pending while locked and resolve only after unlock plus session refresh, unlocked push taps resolve against the current session list, invalid uppercase hashes clear stale pending routes and never route after unlock, unlock starts the session subscription, pairing while unlocked loads sessions, starts the subscription, and syncs FCM tokens, pairing while locked does not load sessions, subscribe, or sync FCM tokens, locking stops subscription updates, subscription updates replace the dashboard list, and pending push taps can resolve from later subscription updates. Foreground FCM messages render the same fixed-copy generic notification as the relay payload, require a lowercase 64-character hex `session_id_hash`, and notification tap intents carry only that hash; the view model uses the same strict lowercase hash parser before resolving the tap against locally fetched sessions after biometric unlock. Focused JVM tests verify that the tap parser trims whitespace but never lowercases uppercase hashes, that foreground notifications use fixed generic copy and private lock-screen visibility even if extra terminal or command fields are present, and that invalid event types or invalid hashes do not post notifications. The Compose root renders only the lock surface while unauthenticated, listens for lifecycle stop/resume, prompts through `BIOMETRIC_STRONG` only on stale resume, and gates session fetch/subscription plus terminal input before bytes are sent. Debug emulator QA can opt into a debug-build-only unlock path with `FIELDWORK_ANDROID_BIOMETRIC_BYPASS=true`; runtime still requires `BuildConfig.DEBUG`, release builds hardcode the bypass off, and the default smoke still verifies the locked surface. Debug/source builds compile without `apps/android/app/google-services.json`; in that mode Firebase is not initialized and no FCM token is generated. Release CI writes `google-services.json` from the `ANDROID_GOOGLE_SERVICES_JSON` secret before building.

Mobile crash reporting is opt-in. Local debug builds can omit `FIELDWORK_SENTRY_DSN`; Settings and the delayed one-time consent prompt then persist consent but do not start Sentry. Focused Android MobileTelemetry JVM tests verify crash reporting defaults off, declined consent resolves the one-time prompt without enabling crash reporting, and accepted consent persists while a debug build without a DSN still does not start Sentry. The prompt is shown only after an attached session has reached `AwaitingInput`, the user has responded, and at least 10 later output lines arrive. Release workflows fail closed unless `SENTRY_DSN` is present, inject it into iOS `Info.plist` and Android `BuildConfig.FIELDWORK_SENTRY_DSN`, and both apps configure Sentry with `sendDefaultPii=false` and `tracesSampleRate=0.0`. `pnpm check:telemetry-privacy` enforces the daemon, mobile delayed consent, iOS, Android, and relay telemetry privacy wiring.

The repo-local `./gradlew` script pins Gradle 8.14.3, verifies the Gradle distribution SHA-256 before extraction, uses Android Studio's bundled JBR when `JAVA_HOME` is unset, and auto-discovers the default macOS/Linux Android SDK directories. `scripts/build-rust.sh` auto-discovers the newest NDK under the SDK and builds `fieldwork-mobile-core` for `arm64-v8a`, `armeabi-v7a`, and `x86_64`, then generates Kotlin bindings.

CI's `Android Debug Build` job runs `apps/android/scripts/build-rust.sh`, `node scripts/verify-uniffi-bindings.mjs`, `apps/android/gradlew --no-daemon :app:compileDebugKotlin`, `apps/android/gradlew --no-daemon :app:testDebugUnitTest`, `node scripts/verify-mobile-privacy.mjs`, and `node scripts/verify-store-privacy.mjs`, so generated UniFFI bindings, the v1-only generated mobile API surface, JNI library packaging, Kotlin/Compose compilation, focused Android JVM unit tests, the merged Android permission surface, mobile privacy defaults, and the store answer sheet are checked without requiring release signing or Firebase credentials. The npm/static CI job also runs `node scripts/verify-telemetry-privacy.mjs` so telemetry opt-in, PII, trace-sampling, and Honeycomb credential boundaries remain mechanically checked, `node scripts/verify-v1-boundary.mjs` so future-only protocol flags, mobile create/kill/session-command affordances, and voice/watch/live-activity imports cannot drift into v1, and `node scripts/verify-daemon-resize.mjs` so attached-client resize changes keep minimum-viewport selection plus 100 ms debounced attach/update/detach scheduling.

Android release artifact smoke:

```sh
cd apps/android
scripts/build-rust.sh
./gradlew --no-daemon bundleRelease
pnpm check:android-aab
```

The latest completed local release bundle validation rebuilt the bundle against current Android source with `apps/android/gradlew --no-daemon bundleRelease` and produced `apps/android/app/build/outputs/bundle/release/app-release.aab` (`54M`, SHA-256 `8fb83e440fc68b500e6f10a6fbc40ba43279d5992e1d8fa87a942e9e79657efd`). Earlier 2026-05-18 validation rebuilt `apps/android/scripts/build-rust.sh` and regenerated UniFFI Kotlin bindings for all three v1 ABIs. `pnpm check:android-aab` verifies that a present bundle includes `libfieldwork_mobile_core.so` for `arm64-v8a`, `armeabi-v7a`, and `x86_64`, does not accidentally include a 32-bit x86 Fieldwork core, keeps the packaged protobuf manifest uses-permission allowlist plus packaged protobuf manifest privacy surface free of location, microphone, contacts, media, storage, session-name, command, and terminal-content fields while preserving the required Firebase/Sentry opt-out metadata, and enforces the local unsigned AAB state with `--expect-unsigned`. `node scripts/test-android-aab-verifier.mjs` covers that verifier with synthetic unsigned and signed AABs, including failure when signature entries are present under `--expect-unsigned`, forbidden location permission, missing notification permission, and terminal-content metadata such as `last_line`. Android Studio's bundled `jarsigner` also reports `jar is unsigned` for the local bundle. Release signing with the Play keystore remains blocked until the release keystore and GitHub Secrets exist. The GitHub release workflow fails closed if signing, Play upload, or `ANDROID_GOOGLE_SERVICES_JSON` secrets are missing, uses this pinned `gradlew`, chmods decoded Firebase/signing files to `0600`, verifies the AAB contents with `node scripts/verify-android-aab.mjs` without the local-only `--expect-unsigned` flag, verifies the signed AAB with `jarsigner` before upload, and removes the generated Firebase/signing files in an `always()` cleanup step. `pnpm test:android-debug-smoke` is the repeatable local emulator substitute when exactly one booted adb device is available: it installs the debug app, launches `app.fieldwork.android/.MainActivity`, requires `Status: ok`, checks that `TotalTime` stays below the debug-smoke limit, rejects system ANR dialogs in the UI tree, requires the locked `Unlock` surface by default, rejects Fieldwork crash/ANR logcat entries, and verifies that `screencap` is a nonblank 1080x2400 PNG. On AVDs without enrolled biometrics, `FIELDWORK_ANDROID_BIOMETRIC_BYPASS=true pnpm test:android-debug-smoke` compiles a debug-build-only bypass guarded by `BuildConfig.DEBUG` and verifies the unlocked pairing/bottom-navigation UI instead; release builds hardcode that bypass off. `pnpm test:android-emulator-pair` goes one step deeper: it starts an isolated local release daemon, creates a desktop `bash` session, injects the pair payload only through debug-only `FIELDWORK_ANDROID_PAIRING_PAYLOAD`, approves the Android pairing from the desktop CLI, verifies the app shows the desktop-created session, opens the terminal, backgrounds and foregrounds the app, sends mobile-originated input into the PTY, and attaches a separately approved verifier client to confirm the Android-sent output appears in replayed terminal bytes. Direct adb QA on 2026-05-19 also installed and launched the debug APK, captured `am start -W` `TotalTime=861ms`, paired against an isolated release daemon through explicit desktop approval, listed `bash · fieldwork` with `ANDROID_ADB_DIRECT_READY`, attached the terminal, sent `android_adb_direct_input` through `adb shell input`, and captured a screenshot showing the PTY response. `pnpm test:android-emulator-flood` renders a `yes | head -10000`-scale stream in the actual Android terminal view, checks a flood screenshot nonblank, rejects Fieldwork crash/ANR logcat entries, and confirms replayed terminal bytes contain `ANDROID_EMULATOR_FLOOD` output through a separately approved verifier client; latest local run reported 8438/14400 nonblack screenshot samples. `pnpm test:android-emulator-multisession` pairs the actual Android app, opens three desktop-created sessions (`fwm_a`, `fwm_b`, `fwm_c`), switches among all three in the app, sends Android-originated input to each, and verifies host-side per-session logs so `multi_a_ok`, `multi_b_ok`, and `multi_c_ok` land only in their selected PTYs. `pnpm test:android-emulator-reconnect` pairs the actual Android app, opens a desktop-created terminal, sends input before and after an emulator airplane-mode network cut, verifies the desktop PTY receives post-restore Android input, and uses a separately approved verifier to confirm output emitted during the network gap remains replayable. `pnpm test:android-emulator-notification-tap` pairs the actual Android app, computes a real desktop session's lowercase `session_id_hash`, verifies an uppercase invalid hash does not route, launches the same hash-only activity intent that notification taps use, opens the target terminal through the debug-only biometric bypass, and verifies `notify_tap_ok` lands only in the target PTY. Latest wiped API 36.1 AVD debug-launch run passed with `TotalTime=2467ms` and 14391/14400 nonblack screenshot samples. The Play Store image still emitted background Google-service ANRs, so this is only debug substitute evidence. The Android startup path now keeps the encrypted pairing store lazy, restores saved pairing on `Dispatchers.IO`, and has focused FieldworkViewModel JVM coverage proving construction does not block on saved-pairing restore. The Android root uses an explicit Material color scheme and explicit lock-button colors so that surface does not depend on system dark-mode defaults. Treat Android release cold-start, terminal flood, real provider notification delivery/tap, biometric, background/foreground, and network-change checks as physical release-device gates.

`pnpm test:android-emulator` is the aggregate direct-adb substitute suite for a
booted emulator. It runs the locked debug launch smoke and then the pair,
session-subscription, background-replay, restart-restore, flood, multisession,
reconnect, and notification-tap smokes in order.
`pnpm test:android-emulator -- --list` prints the exact underlying adb scripts
without requiring a device. The aggregate retries only a locked debug-launch
timing outlier once with the same strict limit; every other script failure fails
closed and preserves the captured wrapper output path. The aggregate still fails
closed unless exactly one boot-complete adb device is available, or
`FIELDWORK_ANDROID_SERIAL` names the target. The latest default aggregate run on
2026-05-19 passed on `emulator-5554` without the relaxed launch env: locked
debug launch `TotalTime=7920ms`, pair `pair_flow_ms=2234`, session subscription
`visible_ms=3318`, flood screenshot 8440/14400 nonblack samples, and successful
background replay, restart restore, multisession, reconnect, and notification
tap routing.

A later manual adb rerun on 2026-05-19 used direct `adb install`, `am start -W`, `uiautomator`, `screencap`, and logcat. After hiding the emulator IME before tapping Pair, it launched in `TotalTime=1082ms`, paired through explicit desktop approval, listed `bash · fieldwork`, attached the terminal, and showed `echo android_adb_direct_input` plus the matching PTY output. The debug build output was then rebuilt without test-only environment flags and checked to contain `FIELDWORK_BIOMETRIC_BYPASS = false` and an empty `FIELDWORK_DEBUG_PAIRING_PAYLOAD`.

A follow-up raw adb locked-launch baseline on 2026-05-19 installed the default debug APK, launched `app.fieldwork.android/.MainActivity` with `am start -W` `TotalTime=2078ms`, captured `/tmp/fieldwork-adb-launch.png`, `/tmp/fieldwork-adb-ui.xml`, app-scoped logcat, and the crash buffer, and verified the `Unlock` surface with an empty Fieldwork crash buffer. This remains a debug emulator smoke result, not release-device cold-start threshold evidence.

The latest raw adb emulator QA refresh on 2026-05-19 installed the default debug APK, launched with `Status: ok` and `TotalTime=3479ms`, captured `/tmp/fieldwork-adb-current.png`, `/tmp/fieldwork-adb-current-ui.xml`, `/tmp/fieldwork-adb-current-app.log`, and an empty `/tmp/fieldwork-adb-current-crash.log`, and verified the locked `Unlock` surface. The same run rebuilt the debug APK with `FIELDWORK_ANDROID_BIOMETRIC_BYPASS=true` for emulator-only no-biometric inspection, launched in `TotalTime=2013ms`, accepted the Android camera permission with adb input, and captured the unlocked pairing UI (`Pairing payload`, `Pair`, `Sessions`, `Settings`), Settings UI (`No paired daemon`, `Share crash reports`, `Open Source Licenses`), and Open Source license screen screenshots/UI XML/logcat under `/tmp/fieldwork-adb-bypass-*` with empty crash buffers. After the bypass inspection, the default debug APK was rebuilt and `BuildConfig.java` was checked to contain `FIELDWORK_BIOMETRIC_BYPASS = false` and `FIELDWORK_DEBUG_PAIRING_PAYLOAD = ""`; `adb devices` was empty and the Gradle daemon was stopped before leaving the run.

The Android pair smoke now also measures the debug-app Pair tap through explicit desktop approval completion and fails above the local 15-second emulator bound. Latest local run passed on `emulator-5554` with `pair_flow_ms=297`. This is app-side timing substitute evidence only; physical QR camera pair-flow timing still needs a release-device run.

`pnpm test:android-emulator-background-replay` is the focused local background/foreground substitute: it pairs the actual Android app, opens a desktop-created terminal, sends input before backgrounding, backgrounds the app while the PTY emits `ANDROID_BACKGROUND_REPLAY_OUTPUT`, foregrounds back to the attached terminal, sends `after_background_ok`, and uses a separately approved verifier client to confirm the background-emitted output and post-foreground input remain replayable. Latest local run on 2026-05-19 passed on `emulator-5554`.

`pnpm test:android-emulator-session-subscription` is the focused local Android dashboard subscription substitute: it pairs the actual Android app with no pre-existing sessions, waits for the empty dashboard, creates `fw_subscribe_session` from the desktop CLI, verifies the subscribed dashboard receives the new session within the local 8-second emulator bound, opens it, sends `subscription_attach_ok`, and confirms the desktop PTY receives that Android-originated input. Latest local run passed on `emulator-5554` with `visible_ms=2396`.

`pnpm test:android-emulator-restart-restore` is the focused local daemon-restart substitute: it pairs the actual Android app with an isolated release daemon, creates an intentionally completed `fw_restart_session`, waits for `ANDROID_RESTART_SCROLLBACK` to persist through the session-exit path, restarts the daemon with the same temp state and deterministic node identity, relaunches the app from saved pairing, verifies the restored dashboard still lists `fw_restart_session`, opens the restored terminal, and confirms `ANDROID_RESTART_SCROLLBACK` is replayed through a separately approved verifier. Latest local run on 2026-05-19 passed on `emulator-5554`. Direct adb restart-restore evidence on 2026-05-19 captured emulator screenshots, `uiautomator` dumps, `dumpsys window` focus, and logcat before and after the daemon restart. The first direct adb run exposed `ANR in app.fieldwork.android` after tapping refresh from a restored dashboard, and the patched run showed `fw_restart_session` before and after refresh, `FieldworkRepository: listSessions returned 1 sessions` in logcat, and no Fieldwork `FATAL EXCEPTION` or ANR. This is Android emulator substitute evidence; launchd/systemd restart policy, macOS sleep/wake, and physical-device app restore remain release gates.

The Android startup source response now obtains `FieldworkViewModel` from the lifecycle ViewModel store through an application-context factory. It keeps the encrypted pairing store lazy, restores saved pairing on `Dispatchers.IO`, and has focused FieldworkViewModel JVM coverage proving construction does not block on saved-pairing restore, stale startup-restore results cannot override an explicit pairing, repository-backed refresh work does not run on the main thread
(`refreshSessionsRunsRepositoryWorkOffMainThread`), terminal attach and lag
reattach work do not run on the main thread
(`terminalAttachAndLagReattachRunRepositoryWorkOffMainThread`).

Inspect daemon logs:

```sh
target/debug/fieldwork daemon status
target/debug/fieldwork daemon logs --tail 80
```

The daemon writes daily `daemon.log*` files and prunes only daemon log files older
than seven days when logging starts. The focused logging test covers expired,
fresh, exact-boundary, non-daemon, and directory entries.

User service lifecycle:

```sh
target/debug/fieldwork daemon install
target/debug/fieldwork daemon restart
target/debug/fieldwork daemon uninstall
```

The install path uses `service-manager` with a user-level LaunchAgent on macOS and a systemd user unit on Linux. It does not install a root/system daemon. Focused CLI tests now run the actual `service-manager` install rendering path with fake `launchctl`/`systemctl`: on macOS the generated LaunchAgent is checked for `KeepAlive` with `SuccessfulExit=false`, and on Linux the generated user unit is checked for `Restart=on-failure`, `RestartSec=5`, and `WantedBy=default.target`. `install` and `restart` now wait for a successful local protocol handshake before reporting success; a fresh install automatically uninstalls itself if the service fails to start or starts but never reaches the control socket.

Current local blocker for the launchd restart gate in this shell: the unsigned/ad-hoc release `fieldworkd` is rejected by `spctl --assess --type execute`. `fieldwork daemon install` now preflights that same Gatekeeper assessment and fails before writing/starting the LaunchAgent with guidance to use the signed/notarized npm package or notarized release artifact. This is the closest local substitute for the production gate until the rcodesign/notarized macOS daemon artifact exists.

Daemon crash reporting is disabled by default. The user-facing opt-in path writes the daemon config file:

```sh
target/debug/fieldwork settings telemetry status
target/debug/fieldwork settings telemetry on --sentry-dsn https://examplePublicKey@example.invalid/1
target/debug/fieldwork daemon restart
target/debug/fieldwork settings telemetry off
target/debug/fieldwork daemon restart
```

The config file is `~/Library/Application Support/app.fieldwork/config.toml` on macOS and `$XDG_CONFIG_HOME/fieldwork/config.toml` or `~/.config/fieldwork/config.toml` on Linux. The daemon reads it on startup. For local Sentry smoke testing without touching the config file, set both variables before starting `fieldworkd`:

```sh
FIELDWORK_TELEMETRY_OPT_IN=true FIELDWORK_SENTRY_DSN=https://examplePublicKey@example.invalid/1 target/debug/fieldworkd
```

The daemon keeps `send_default_pii=false` and `traces_sample_rate=0.0`; `pnpm check:telemetry-privacy` rejects accidental daemon OTLP/Honeycomb wiring. `cargo test -p fieldwork-daemon logging` uses Sentry's test transport to verify the daemon Sentry options require explicit opt-in, keep PII/tracing disabled, and capture a Rust panic without contacting Sentry. Daemon OTLP/Honeycomb export is intentionally absent from v1; do not add it without first updating the v1 boundary and telemetry privacy verifier.

Daemon and relay logging both install a privacy sanitizer layer. Tests under `privacy_tracing` verify that events marked `privacy.level = "user_content"` are dropped before downstream logging layers receive them.

Local persistence encryption is on by default. The daemon uses separate `sessions.redb` and `devices.redb` stores in production, forces local persistence parents to `0700`, database files to `0600`, and rejects symlinked persistence directories or database files before opening either store. Focused persistence tests verify encrypted session rows, encrypted device-registry rows and hashed device row keys in both shared-test and separate production-like DB layouts, explicit plaintext opt-out, and re-enable reads of previous plaintext rows. The explicit opt-out path is:

```sh
target/debug/fieldwork settings scrollback-encryption off
target/debug/fieldwork daemon restart
```

With that setting off, future session scrollback and paired-device registry writes are plaintext in local `redb` files. `target/debug/fieldwork settings scrollback-encryption on` re-enables encrypted writes after daemon restart; encrypted mode can still read rows produced while plaintext mode was enabled.

Restart persistence smoke:

```sh
target/debug/fieldwork new bash -lc 'echo persisted-smoke'
target/debug/fieldwork attach <session-id>
pkill -f 'target/debug/fieldworkd'
target/debug/fieldwork ls
target/debug/fieldwork attach <session-id>
```

Agent hook smoke:

```sh
target/debug/fieldwork new claude --version
target/debug/fieldwork hook claude-stop --session <session-id>
target/debug/fieldwork ls
printf '{"type":"approval_requested"}' | target/debug/fieldwork hook codex-event --session <codex-session-id>
```

Claude Code Stop hook wiring uses the injected `FIELDWORK_SESSION_ID`. A project or user Claude settings hook can run:

```sh
fieldwork hook claude-stop --session "$FIELDWORK_SESSION_ID"
```

Codex currently exposes `codex remote-control` and `codex app-server --listen/proxy` locally, not the older `codex app-server daemon --remote-control` form in the original plan. Fieldwork therefore keeps the `codex` PTY command unchanged and ingests structured Codex JSON through `fieldwork hook codex-event`.

State inference fixture tests:

```sh
cargo test -p fieldwork-daemon state_infer
cargo test -p fieldwork-daemon local_agent_hook
cargo test -p fieldwork-cli codex
```

The committed fixtures under `crates/daemon/tests/fixtures/` are redacted before
commit. They exercise Claude approval/permission prompts, reject generic
question-mark false positives, and cover Codex `type`/`event`/`status` JSON
event shapes including `Crashed`. The focused daemon local-agent-hook tests
verify that matching LocalCli Claude/Codex hook events update only matching PTY
sessions and that mismatched hook sources are ignored.

Relay push gateway smoke:

```sh
FIELDWORK_RELAY_DB_PATH="$(mktemp -d)/relay.db" target/debug/fieldwork-relay
# In the daemon environment:
FIELDWORK_RELAY_CONTROL_URL=http://127.0.0.1:8443 target/debug/fieldworkd
```

With the control URL set, the daemon stores a relay-signing key in the OS keychain, registers its public key through `/v1/pair`, signs push token registration, and posts hashed `AwaitingInput` events to `/v1/push`. Relay HTTP operations retry transport failures and temporary relay failures with `backon` exponential backoff for a bounded 60-second budget; signed retries rebuild the request with a fresh nonce and timestamp so relay replay defense stays intact. `FIELDWORK_RELAY_DB_PATH` defaults to `/var/lib/fieldwork/relay.db`; set it to a writable local path for development or to `off` for an in-memory relay. Automated tests cover relay SQLite persistence, private SQLite file/sidecar modes, version endpoint privacy, signature verification, token ownership, replay defense, timestamp skew, payload privacy, daemon-facing provider-error body redaction, lowercase 64-character hex session-hash validation, `moka` TTL rate limiting, daemon-to-relay POSTs, and transient push retry behavior.

The relay serves aggregate Prometheus metrics on `FIELDWORK_RELAY_METRICS_ADDR`, defaulting to `127.0.0.1:9090`. Set `FIELDWORK_RELAY_METRICS_ADDR=off` to disable the listener locally. The metrics test verifies that the output contains only aggregate counters/gauges and does not expose daemon node IDs, push tokens, or session hashes.

Relay OTLP/Honeycomb tracing is relay-operator telemetry, not user daemon telemetry. It is off unless `FIELDWORK_RELAY_OTLP_ENDPOINT` or a Honeycomb credential is present. Production uses `FIELDWORK_RELAY_OTLP_ENDPOINT=https://api.honeycomb.io/v1/traces`, `FIELDWORK_RELAY_OTLP_SAMPLE_RATE=0.01`, optional `FIELDWORK_RELAY_HONEYCOMB_DATASET`, and a relay-only API key from systemd `LoadCredential=honeycomb-api-key` or `FIELDWORK_RELAY_HONEYCOMB_API_KEY_PATH`. The relay emits only static endpoint names, service metadata, platform enums, and event-type enums. It does not attach daemon node IDs, push tokens, session hashes, commands, paths, terminal bytes, IP addresses, or user-facing names to spans. Local tests cover sample-rate validation and redaction of OTLP header values from debug output, and `pnpm check:telemetry-privacy` enforces the main privacy wiring statically, including that relay OTLP uses OpenTelemetry's `reqwest-rustls` native-root feature instead of the WebPKI-only feature; a live Honeycomb receipt test still requires a Honeycomb account/API key.

Relay OTLP loopback smoke:

```sh
pnpm test:relay-otlp
```

The smoke starts a local OTLP HTTP collector, runs `fieldwork-relay` with `FIELDWORK_RELAY_OTLP_SAMPLE_RATE=1.0`, requests `/v1/version`, verifies an `application/x-protobuf` POST to `/v1/traces`, and checks that sentinel terminal/session/token strings injected into request metadata do not appear in the exported protobuf body. This is the local substitute for hosted Honeycomb receipt; the Section 13 gate still requires observing a real trace in Honeycomb with production credentials.

The relay TLS and OTLP smoke scripts honor `FIELDWORK_RELAY_BINARY` and otherwise prefer the existing `target/release/fieldwork-relay` before falling back to `target/debug/fieldwork-relay` or a local debug build. That keeps local release-artifact verification from recreating `target/debug` when a release relay binary is already available.

Current local blocker for the full Week 7 phone push demo: this shell has no APNs `.p8`, FCM service-account JSON, Apple/Play push entitlements, or physical phones attached. The closest local substitute is `cargo test --workspace`, which exercises the relay gateway and daemon dispatch path without contacting Apple or Google.

Relay deployment scaffold:

```sh
infra/oracle/provision-region.sh infra/oracle/terraform/mumbai.tfvars
ansible-playbook \
  -i infra/relay/ansible/inventory.ini \
  infra/relay/ansible/playbook.yml \
  -e fieldwork_relay_binary=/path/to/fieldwork-relay
```

`infra/oracle/terraform` provisions the credential-free Oracle ARM A1 host and network scaffold: VCN, public subnet, internet gateway, route table, security list, IMDSv1-disabled `VM.Standard.A1.Flex` instance, and an Ansible inventory output. Terraform state and tfvars are ignored by git; provider credentials come only from the operator's local OCI config or environment. The committed `.terraform.lock.hcl` pins signed OCI provider checksums while generated `.terraform/` caches stay ignored. `infra/oracle/provision-region.sh` wraps `terraform init` and `terraform apply` with retry controls for scarce Always Free A1 capacity. `infra/relay/ansible/group_vars/all/main.yml` is the deployment contract for the current scaffold. `fieldwork_relay_data_dir` is created as `0700` for the `fieldwork-relay` user. `fieldwork_relay_db_path` becomes `FIELDWORK_RELAY_DB_PATH` in `fieldwork-control-plane.service` and defaults to `/var/lib/fieldwork/relay.db`; push-token ownership rows in that database are refreshed on accepted push dispatch and pruned after 90 days with no use. `fieldwork_relay_metrics_addr` becomes `FIELDWORK_RELAY_METRICS_ADDR` and defaults to `127.0.0.1:9090`; set it to `off` only for local/non-production smoke tests. `fieldwork_relay_control_addr` becomes `FIELDWORK_RELAY_ADDR`, and production control-plane TLS is required by `FIELDWORK_RELAY_REQUIRE_TLS=true` with `control-plane.crt`/`control-plane.key` supplied through systemd credentials. `scripts/smoke-relay-tls-loopback.sh` uses the same relay-binary resolution as the OTLP smoke, starts the control plane with a throwaway self-signed cert/key, and verifies `/healthz` over HTTPS. `fieldwork_relay_otlp_endpoint`, `fieldwork_relay_otlp_sample_rate`, and `fieldwork_relay_honeycomb_dataset` become the relay OTLP environment. Control-plane TLS, APNs, FCM, and Honeycomb paths are passed through systemd `LoadCredential` from `fieldwork_relay_control_tls_cert`, `fieldwork_relay_control_tls_key`, `fieldwork_relay_apns_credential`, `fieldwork_relay_fcm_credential`, and `fieldwork_relay_honeycomb_credential`; those credential files are relay-only secrets and are not copied by the playbook. `fieldwork_relay_fcm_endpoint` becomes `FIELDWORK_FCM_ENDPOINT` and normally stays at `https://fcm.googleapis.com`. `deploy-relay.yml` downloads the `linux-arm64` release archive plus its SHA-256 and cosign bundle, verifies the archive checksum plus DSSE/SLSA bundle digest, runs cosign blob-attestation verification against the GitHub OIDC issuer and release-rust workflow identity, checks that `fieldwork-relay` is executable after extraction, fails early when `RELAY_SSH_KEY` is absent, writes the relay SSH key with `0600`, removes it in an `always()` cleanup step, and refuses to run Ansible against the placeholder inventory.

APNs delivery activates only when the relay host provides `apns.p8` through systemd `LoadCredential` or `FIELDWORK_APNS_P8_PATH`, plus `FIELDWORK_APNS_TEAM_ID`, `FIELDWORK_APNS_KEY_ID`, and `FIELDWORK_APNS_TOPIC`. The relay signs an ES256 APNs provider JWT from that relay-only key, caches it for 50 minutes, and sends only fixed-copy alert text plus opaque session hashes through a persistent provider client with 60-second HTTP/2 keepalive pings. The provider client is built during relay state initialization; the network connection is established lazily on first APNs dispatch and then reused. APNs `BadDeviceToken` responses remove the relay token binding from memory and SQLite before the relay reports a provider error to the daemon. Local tests cover JWT caching, payload privacy, mock delivery, provider-client connection reuse, and BadDeviceToken stale-token pruning without contacting Apple.

FCM delivery activates only when the relay host provides `fcm-service-account.json` through systemd `LoadCredential` or `FIELDWORK_FCM_SERVICE_ACCOUNT_PATH`. The relay signs an RS256 Google service-account JWT, exchanges it for a cached OAuth token, sends the fixed-copy notification plus hash-only data payload through FCM HTTP v1, and prunes FCM `UNREGISTERED` tokens as stale bindings. Local tests cover JWT claims, token caching, mock HTTP delivery, payload privacy, and the `UNREGISTERED` stale-token parser without contacting Google.

Run `node scripts/verify-secret-boundaries.mjs` before release changes that touch push, mobile, packaging, telemetry, or deploy files. It enforces that APNs `.p8`, Firebase service-account, and Honeycomb API-key wiring stays out of daemon, CLI, mobile, app, and npm package code, while requiring the relay and relay systemd unit to keep the provider/telemetry credential hooks. It rejects committed `.npmrc` files, npm token strings, and npm auth-token environment or config assignments. When built non-relay artifacts are present under `target/`, `dist/`, or `packages/`, it also scans the `fieldwork`, `fieldworkd`, and `fieldwork_mobile_core` binaries for those relay-only credential strings and npm auth-token patterns.

Run `pnpm check:release-workflows` before editing release or deploy workflows. It verifies the local CI release contracts: macOS daemon signing and notarization fail closed, keep decoded Apple signing/notarization assets outside the repository workspace with `0600` permissions and cleanup, and produce cosign/SLSA bundles, npm publish verifies cosign attestations before provenance publishing, CI's Terraform Validate job installs Terraform 1.5.7 and runs the shared `scripts/check-infra-terraform.sh` path, exposed locally as `pnpm check:infra-terraform`; it performs Terraform fmt/init/validate and removes generated `.terraform/` caches on exit, iOS release uses Xcode/iOS SDK 26+ with manual Apple Distribution signing and production APNs entitlement checks, keeps App Store Connect upload JSON outside the repository workspace and cleans signing/upload assets, the Xcode project honors `FIELDWORK_SKIP_RUST_BUILD` before running `apps/ios/scripts/build-rust.sh`, iOS/Android releases run the mobile and store privacy verifiers, Android release requires Firebase/signing/Play secrets, verifies the signed AAB, and removes generated Firebase/signing files in an `always()` cleanup step, and relay deploy verifies the signed linux-arm64 release artifact before Ansible runs and cleans the decoded relay SSH key. Run `pnpm check:release-audit` before editing `docs/RELEASE_AUDIT.md`, Section 13 gate wording, or Appendix B external reservations; it keeps the prompt-to-artifact checklist, current blockers, latest verification commands, and incomplete-gate sign-off rule explicit. Run `pnpm check:infra-scaffold` after editing `infra/oracle` or `infra/relay`; when Terraform is installed, also run `pnpm check:infra-terraform`.

Run `pnpm check:daemon-service` before editing daemon service installation, IPC health checks, or the local handoff smoke. It verifies the CLI still installs only user-level launchd/systemd services, uses a colocated regular executable `fieldworkd`, keeps the macOS Gatekeeper preflight before launchd install, keeps `RestartPolicy::OnFailure`, keeps the fake-command service-manager rendering tests for LaunchAgent `KeepAlive` and systemd `Restart=on-failure`, waits for a real `CONTRACT_VERSION` handshake after install/restart, uninstalls a broken fresh service when start fails or the health check fails, and keeps the local restart-restore smoke markers. This is static/source coverage; Section 13 still requires rerunning the real launchd/systemd survival gate against a signed/notarized macOS artifact or an actual Linux user-service host.

The iroh fallback relay uses the same binary with `FIELDWORK_RELAY_MODE=iroh-relay`, deployed as `fieldwork-iroh-relay.service`. Its Ansible variables map directly to `FIELDWORK_IROH_RELAY_HTTP_ADDR`, `FIELDWORK_IROH_RELAY_HTTPS_ADDR`, `FIELDWORK_IROH_RELAY_QUIC_ADDR`, `FIELDWORK_IROH_RELAY_METRICS_ADDR`, `FIELDWORK_IROH_RELAY_CERT_DIR`, `FIELDWORK_IROH_RELAY_HOSTNAME`, `FIELDWORK_IROH_RELAY_CONTACT_EMAIL`, `FIELDWORK_IROH_RELAY_STAGING`, and `FIELDWORK_IROH_RELAY_HTTP_ONLY`. Production keeps `fieldwork_iroh_relay_http_only: "false"` so ACME-backed HTTPS and QUIC address discovery are enabled. Local-only relay experiments can use `FIELDWORK_RELAY_MODE=iroh-relay FIELDWORK_IROH_RELAY_HTTP_ONLY=true FIELDWORK_IROH_RELAY_HTTP_ADDR=127.0.0.1:3340 target/debug/fieldwork-relay`.

npm package and release scaffold:

```sh
node scripts/verify-npm-packages.mjs
node scripts/verify-changesets-config.mjs
node scripts/verify-release-audit.mjs
node scripts/test-npm-dispatcher.mjs
node scripts/test-npm-registry-state.mjs
node scripts/test-npm-publish-plan.mjs
node scripts/test-npm-artifact-pack.mjs
node scripts/publish-npm-packages.mjs --check-ready
npm pack ./packages/cli --dry-run --json
```

`packages/cli` is the `fieldwork` meta package. It exposes both `fieldwork` and `fieldworkd`; all five publishable npm manifests are set to `1.0.0`, and the meta package pins the four platform optional dependencies to the same version. When postinstall is skipped, both JS dispatchers fall back to the matching platform package. The four platform packages under `packages/cli-*` receive `fieldwork` and `fieldworkd` from `scripts/prepare-npm-artifacts.mjs` after release artifacts are downloaded; the preparation script requires a platform/target-matching extracted artifact directory for each package and fails on a missing platform root instead of falling back to another platform's binaries. The generated native `packages/cli-*/bin/fieldwork` and `packages/cli-*/bin/fieldworkd` outputs are release artifacts, not source files, so `.gitignore` keeps them out of git, `node scripts/verify-npm-packages.mjs` rejects tracked generated native bins, and `node scripts/verify-npm-packages.mjs --require-binaries` still verifies them when they are present. The same preparation step copies root `LICENSE` and `NOTICE` into all five npm package directories so binary packages carry the AGPL text and App Store distribution notice. The unscoped `fieldwork` meta package is operator-owned; `node scripts/verify-npm-registry-state.mjs` is not a name-availability task for the meta package. The registry-state checker fails closed when run without explicit release-state expectation flags. Use the live registry checker only for release-state verification after operator-controlled platform child publishes: `--expect-platform-published` for the post-placeholder or post-release package family, and `--expect-latest-version=1.0.0 --expect-provenance` after v1 release. `node scripts/test-npm-registry-state.mjs` uses a deterministic local registry fixture for current, post-placeholder, post-release, version-drift, missing-provenance, and bare-invocation failure states, so the live registry checker modes are covered without depending on npm's changing public state. `node scripts/test-external-status-refresh.mjs` verifies domain/GitHub status refresh scripts fail closed before network access unless `--operator-refresh` is present. `node scripts/verify-changesets-config.mjs` expands the Changesets fixed group against the actual workspace package names and verifies exactly those five packages stay in lockstep. `version-packages.yml` runs that verifier and then `changesets/action@v1` with pinned `pnpm dlx` Changesets packages so it can open version PRs without creating a mutable root install. Automatic npm publishes triggered by `release-rust.yml` download artifacts from the completed workflow run id; manual `release-npm.yml` dispatch downloads from the requested GitHub Release tag. `pnpm check:release-artifacts` requires `artifacts/` or `FIELDWORK_ARTIFACT_DIR` to contain release-rust/GitHub Release archives, `.sha256` files, and `.bundle` attestations, then verifies that each platform archive has a matching SHA-256 file plus a Sigstore DSSE/SLSA bundle whose Sigstore media type, transparency-log entries, DSSE envelope/signatures, in-toto payload, SLSA provenance v1 `predicateType`, subject name, subject digest, official-repository `buildType`, package, target, release tag, and SHA-256 external parameters match the archive and requested release tag before any extraction. It intentionally fails closed when those real artifacts are absent; `pnpm test:release-artifacts` is the deterministic local substitute for verifier coverage. `node scripts/test-release-artifacts.mjs` covers that verifier with synthetic valid artifacts plus checksum filename, tampered digest, subject-name, predicate-type, predicate `_type`, Sigstore media type, transparency-log, DSSE envelope/signature, invalid payload, missing external-parameters, release-tag, external SHA, package, target, and buildType cases. In release publish/deploy workflows, the same verifier runs with `FIELDWORK_VERIFY_COSIGN_SIGNATURE=1`, `FIELDWORK_RELEASE_REPOSITORY=${{ github.repository }}`, and `FIELDWORK_EXPECTED_RELEASE_TAG` for manual artifact consumers, so `cosign verify-blob-attestation` also checks the bundle signature, GitHub OIDC issuer, release-rust workflow identity, and `slsaprovenance1` type. `node scripts/test-npm-artifact-pack.mjs` uses synthetic extracted artifacts to verify the package preparation path, missing platform-root rejection, native package dry-runs, legal-file staging, executable `fieldwork`/`fieldworkd` entries, explicit children-first publish order, and both `--check-ready` and actual publish-path rejection when platform children contain non-native files instead of Mach-O or ELF binaries. `node scripts/test-npm-publish-plan.mjs` verifies the real publish command plan without an npm token: four platform packages first, meta package last, `--provenance`, and public access. `node scripts/test-bun-install.mjs` smoke-tests Bun's platform optional-dependency selection against pinned `esbuild@0.25.12` registry packages, matching Fieldwork's meta-package plus platform-child publish pattern while Fieldwork platform packages are still unpublished. `release-npm.yml` verifies release artifacts, prepares platform binaries and legal files, verifies real binaries with `node scripts/verify-npm-packages.mjs --require-binaries`, publishes the same plan to npm through `node scripts/publish-npm-packages.mjs`, then retries the public registry with `node scripts/verify-npm-registry-state.mjs --expect-meta-published --expect-platform-published --expect-latest-version="$version" --expect-provenance`.

When the four platform children are operator-controlled through placeholder
publishes or the actual v1 release publish, use
the `--expect-platform-published` mode:
`node scripts/verify-npm-registry-state.mjs --expect-meta-published --expect-platform-published`
to verify the package family no longer has 404 platform children. After a v1
publish, append `--expect-latest-version=1.0.0 --expect-provenance` to verify
npm's latest dist-tag and SLSA provenance metadata for every published package
in the family.

The CLI update notice is npm-only as well: `fieldwork` checks `https://registry.npmjs.org/fieldwork/latest` at most once per day, caches the result in the private Fieldwork config directory, and prints only a stderr notice telling users to run `npm update -g fieldwork`. Unit tests cover the cache, version comparison, offline cache writes, and skipped command classes so QR payloads, completions, hooks, and terminal attaches are not polluted.

Relay deployment, provider credential rotation, and incident response are documented in `docs/OPERATIONS.md`. It is the operational companion to this development guide: keep it synchronized when deploy workflows, relay secrets, APNs/FCM/Honeycomb handling, npm provenance, or store release credentials change.

Current local blockers for full release verification: npm provenance publish requires a release-scoped `NPM_TOKEN` plus publish rights for the four platform child packages; GitHub org/repo creation, domain ownership, DNS control, and social-handle reservation are operator-owned external gates, and `node scripts/check-github-namespace.mjs --operator-refresh --expect-available` / `node scripts/check-domain-status.mjs --operator-refresh --require-registered --require-dns` are reserved for explicit operator-requested status refreshes; macOS daemon notarization requires Apple certificates; Oracle relay deploy requires ARM A1 hosts and SSH secrets; TestFlight upload requires `IOS_DISTRIBUTION_CERTIFICATE_BASE64`, `IOS_DISTRIBUTION_CERTIFICATE_PASSWORD`, `IOS_PROVISIONING_PROFILE_BASE64`, `IOS_DEVELOPMENT_TEAM`, `IOS_EXPORT_OPTIONS_PLIST`, and an `APP_STORE_KEY_JSON` containing `key_id`, `issuer_id`, and `private_key`; Play upload requires `ANDROID_GOOGLE_SERVICES_JSON`, the Android release keystore, and Play service-account secrets.
