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
`cargo nextest run --workspace --no-fail-fast`,
`node scripts/verify-secret-boundaries.mjs`, `node scripts/verify-no-ship-markers.mjs`,
`node scripts/verify-no-ship-markers.mjs --self-test`,
`node scripts/test-live-testing-evidence.mjs`, `node scripts/test-debug-instance.mjs`,
and `node scripts/verify-structured-assets.mjs` through the local toolchain.

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
pnpm check:no-ship
pnpm test:no-ship
node scripts/test-npm-dispatcher.mjs
pnpm check:release-artifacts
node scripts/test-release-artifacts.mjs
node scripts/test-release-artifacts-evidence.mjs
node scripts/test-release-artifacts-scaffold.mjs
pnpm test:macos-signing-evidence
pnpm test:macos-signing-scaffold
node scripts/test-npm-registry-state.mjs
node scripts/test-external-status-refresh.mjs
node scripts/test-ios-prereqs.mjs
pnpm test:cli-doctor
pnpm test:cli-no-args
node scripts/test-npm-publish-plan.mjs
node scripts/test-npm-artifact-pack.mjs
pnpm test:npm-release-evidence
pnpm test:npm-release-scaffold
node scripts/test-bun-install.mjs
pnpm test:live-testing-readiness
pnpm check:live-testing-readiness:local
pnpm check:android-release-readiness:local
pnpm test:android-unit
pnpm test:android-emulator
pnpm check:android-debug-apk
node scripts/test-android-aab-verifier.mjs
node scripts/test-android-debug-apk-verifier.mjs
node scripts/test-android-pair-button-picker.mjs
pnpm check:site
```

The current release checklist, local evidence, and external blockers are
tracked in `docs/RELEASE_AUDIT.md`.

`pnpm check:local-release` runs the deterministic source-side release gate:
workspace/package metadata, `cargo fmt --check`,
`cargo clippy --workspace -- -D warnings`, `cargo nextest run --workspace`,
`cargo deny check`, `cargo audit`, docs,
community/legal scaffolding, privacy/security boundaries, v1/FUTURE boundary
plus no-ship marker scans/self-tests, release audit checks, workflow YAML
syntax parsing, release workflow `run: |` bash syntax self-test and contracts,
UniFFI binding surface, npm
registry and publish-plan fixtures, Bun
optional-dependency behavior, release-artifact
verifier fixtures, live-test readiness/evidence verifier/scaffold fixtures, and
Android AAB/debug APK verifier fixtures. It deliberately excludes
network account checks, live publishing, iOS SDK builds, Android emulator
runtime tests, physical-device checks, and hosted relay deployment. When the
local platform binaries and Android artifacts are staged, run
`pnpm check:local-release -- --with-artifacts` to also verify the preserved AAB,
staged npm binaries, publish readiness, and meta-package dry-run pack. When
release binaries, Terraform, ffmpeg/ffprobe, and site dependencies are available,
run `pnpm check:local-release -- --with-runtime` to also verify the CLI doctor
smoke, CLI no-args raw-terminal smoke, local handoff smoke, demo video, site
typecheck/build, Terraform fmt/init/validate, relay TLS/OTLP loopbacks, and
desktop cold-start thresholds. The flags can be combined, and
`pnpm check:local-release:full` is
the packaged alias for the
artifact plus runtime release-candidate pass. Unless `CARGO_TARGET_DIR` is
already set, the aggregate runs the CLI doctor, CLI no-args, and local handoff
smokes with `/tmp/fieldwork-target-checks` so it does not grow the repo-local
`target/debug` cache. The smokes preserve the host `CARGO_HOME` and
`RUSTUP_HOME` while isolating Fieldwork's `HOME`, config, state, and runtime
directories, so Rustup does not redownload the pinned toolchain into each temp
run. On hosts with limited temp-volume space, run
`CARGO_HOME="$HOME/.cargo" CARGO_TARGET_DIR="$PWD/target" pnpm check:local-release:full`
to reuse the normal Cargo cache and repo-local target directory. CI
syntax-checks the aggregate wrapper and list-checks the combined
artifact/runtime mode so wrapper drift is caught without duplicating the full
artifact/runtime gate in pull requests. The local release gate also
syntax-checks every checked-in Node script under `scripts/*.mjs` with
`node --check`, and every checked-in shell script under `scripts/*.sh` and
`apps/ios/scripts/*.sh`, including the Android emulator smoke scripts, without
requiring an emulator. It also parses tracked repo JSON and TOML package/config
assets, using Python's standard `tomllib` for TOML, lints the iOS project
plist, Info.plist, and entitlements with `plutil -lint` when available, uses a
portable XML-plist parse plus Xcode project structural fallback on non-macOS
hosts, and validates Android XML resources plus docs SVG assets with
`xmllint --noout` when available or Python's standard XML parser on hosts
without `xmllint`.

For first-round Android live-test prep without a connected phone, run
`pnpm check:live-testing-readiness:local`. It verifies the local release
`fieldwork`/`fieldworkd` binaries, their command surfaces with
`target/release/fieldwork doctor --help` and
`target/release/fieldworkd --help`, Android debug APK, unsigned local AAB,
normal debug `BuildConfig`, live-test scaffold/verifier, and
`docs/LIVE_TESTING.md`, while treating a missing physical phone,
unauthorized/offline adb target, extra attached target, or emulator/AVD as
pending guidance only in local mode. In local mode, the readiness command also
creates an internal temporary `fw` shim against `target/release/fieldwork` when
no global `fw` is on `PATH`, proving the release binary still renders
`Usage: fw` and `Usage: fw doctor`; strict mode still requires the Desktop Setup
shim or installed npm package before capture. Source-checkout tests should use
the temporary shim from
`pnpm scaffold:live-testing-fw-shim`, which creates `fw`, `fieldwork`, and
`fieldworkd` symlinks plus an `activate.sh` pointing at the repo-local release
binaries without replacing the npm package/provenance gates; the
`pnpm test:live-testing-fw-shim` fixture keeps that helper covered without
requiring real release artifacts. For the least manual first-round setup, use
`pnpm scaffold:live-testing-pack -- --print-dir`: it creates the same shim under
`bin/`, creates the live-test evidence scaffold under `evidence/`, writes
`setup.sh` exporting `FW_LIVE_PACK`, `FW_LIVE_BIN`, `FW_LIVE_DIR`, and `PATH`,
and writes a top-level `preflight.sh` that runs local readiness, runs
`fw doctor` to prove the desktop CLI can start and handshake with `fieldworkd`,
then delegates to the direct-`adb` evidence preflight. The pack does not
fabricate evidence or replace npm, provenance, platform package, release
signing, or physical-device checks; `pnpm test:live-testing-pack` and
`pnpm check:local-release` keep it wired. With exactly one authorized physical Android phone connected,
`pnpm check:live-testing-readiness` is the strict direct-`adb` preflight before
capture: it proves `app.fieldwork.android` is installed on the connected device
and that `adb shell dumpsys package app.fieldwork.android` reports
`versionName=1.0` and `versionCode=1`.

For a local artifact-plus-runtime release-candidate pass on this Mac, first run
`pnpm build:local-npm-artifacts`. That helper builds host release
`fieldwork`/`fieldworkd`/`fieldwork-relay`, builds Darwin arm64/x64 platform
package binaries with Cargo, builds Linux x64/arm64 platform package binaries
with `cargo zigbuild`, stages the generated `packages/cli-*/bin/fieldwork` and
`fieldworkd` files, copies `LICENSE`/`NOTICE` into all five npm package dirs,
emits local platform-package tarballs under
`FIELDWORK_LOCAL_NPM_ARCHIVE_DIR` or `target/local-npm-artifacts`, verifies the
Darwin tarballs with `scripts/verify-macos-signing.mjs`, and then runs
`node scripts/verify-npm-packages.mjs --require-binaries` plus
`node scripts/publish-npm-packages.mjs --check-ready`. The staged platform bins
and `target/local-npm-artifacts` tarballs are generated local candidate
artifacts ignored by git; release CI still publishes from
downloaded GitHub Release archives and attestations, not this local helper.

For operator handoff, `pnpm check:release-audit:list` (equivalent to
`node scripts/verify-release-audit.mjs --list-unchecked`) prints the current
unchecked `PLAN.md` gates grouped by blocker class, and
`pnpm test:release-audit-list` pins that grouped output.

`pnpm check:release-artifacts` is intentionally fail-closed unless
`artifacts/` or `FIELDWORK_ARTIFACT_DIR` contains the release-rust/GitHub
Release archives, `.sha256` files, and `.bundle` attestations. Use
`pnpm test:release-artifacts` for deterministic local verifier coverage when
no release artifacts are present.

`cargo audit` currently exits successfully and reports RustSec warnings rather than high/critical CVEs: `adler` and `lru` through the terminal-state stack, `paste` through transitive network/image dependencies, `atomic-polyfill` through `postcard -> heapless` for compact pairing-ticket encoding and iroh's relay path, and `bincode` because v1 local IPC and persisted local payload wrappers are contractually bincode. The latest 2026-05-29 audit scanned 748 dependencies and reported five allowed warnings: `adler` `RUSTSEC-2025-0056`, `atomic-polyfill` `RUSTSEC-2023-0089`, `bincode` `RUSTSEC-2025-0141`, `paste` `RUSTSEC-2024-0436`, and `lru` `RUSTSEC-2026-0002`. The workspace uses bincode 2 through shared protocol helpers with the legacy v1 layout pinned by tests, but the RustSec advisory still applies and remains documented in `deny.toml`. `RUSTSEC-2026-0002` for `lru 0.12.5` is transitive through `tattoy-wezterm-term`; `cargo update -p lru@0.12.5 --dry-run` found no compatible lockfile move, Fieldwork does not use `lru::IterMut` directly, and `scripts/verify-rust-workspace.mjs` rejects direct `lru` dependencies plus `lru::` source paths while this advisory is allowlisted only as a transitive terminal-state dependency. `RUSTSEC-2023-0089` for `atomic-polyfill 1.0.3` is transitive through `postcard 1.1.3 -> heapless 0.7.17`; `cargo update -p postcard --dry-run` found no compatible lockfile move, Fieldwork does not use `atomic_polyfill::` directly, and `scripts/verify-rust-workspace.mjs` rejects direct `atomic-polyfill` dependencies plus `atomic_polyfill::` source paths while this advisory is allowlisted only as a transitive pairing-ticket dependency.

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
pnpm build:local-npm-artifacts
```

The helper above is the preferred local command when the goal is to stage npm
platform package binaries and then run `pnpm check:local-release:full`. The
underlying per-target release commands are:

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

Repeatable isolated debug daemon:

```sh
scripts/debug-instance.sh start
eval "$(scripts/debug-instance.sh env)"
fw ls
tmux attach -t fieldwork-debug
scripts/debug-instance.sh stop
```

The debug instance runs `target/debug/fieldworkd` in a tmux session with an
isolated `HOME`, XDG config/state/cache/runtime directories, and local `fw`,
`fieldwork`, and `fieldworkd` symlinks. It deliberately sets
`FIELDWORK_SCROLLBACK_ENCRYPTION_ENABLED=false` inside that isolated state root
to avoid Keychain prompts during local debugging; production-like and release
verification paths should leave the encryption override unset. Custom
`FIELDWORK_DEBUG_TMUX_SESSION` and `FIELDWORK_DEBUG_ROOT` values are preserved by
`scripts/debug-instance.sh env`, so copied CLI commands keep pointing at the
same isolated daemon. When a scripted tmux session is already running and the
caller has not supplied `FIELDWORK_DEBUG_ROOT`, `env` and `status` adopt the
session's stored root marker before printing environment variables or checking
the debug daemon socket.

Desktop performance smoke:

```sh
cargo build --release -p fieldwork-cli -p fieldwork-daemon
node scripts/measure-desktop-performance.mjs
```

The script runs one explicit warm-up sample to avoid build-machine first-exec page-cache/code-signing noise, then measures `target/release/fieldwork version` and daemon ready-to-local-IPC-handshake time in isolated temp directories. It still fails if any measured release-build sample exceeds the v1 thresholds from `PLAN.md` (`50ms` CLI, `200ms` daemon).

Pairing smoke:

```sh
scripts/smoke-cli-doctor.sh
scripts/smoke-cli-no-args.sh
scripts/smoke-local-handoff.sh
```

The doctor smoke builds the debug CLI/daemon in an isolated temp environment,
verifies `fieldwork doctor --no-start` fails before a daemon is running, starts
`fieldworkd`, creates a desktop `bash` session, then runs `fw doctor --no-start`
through a temp `fw` alias. It verifies the colocated daemon binary check,
socket parent/file hardening, socket/protocol handshake, contract v2 display,
push-disabled state, session count, telemetry setting, scrollback-encryption
setting, summary, and alias help for `fw doctor --help`.

The no-args smoke uses `expect` against the raw terminal attach path and proves
two bare invocations, one through `fieldwork` and one through a temp `fw` alias,
create two distinct auto-named default `claude` sessions before detaching with
the tmux-style `Ctrl-B` then `D` chord. It then lists the isolated daemon through
the same `fw` alias and verifies both generated one-word names are present as
`claude` sessions.

The script builds the debug CLI/daemon, creates an isolated temp `HOME` and `XDG_RUNTIME_DIR`, starts `fieldworkd`, creates a default `claude` session through a temp stub command, a `bash` session, and a `vim` TUI session, verifies the iroh transport rejects a mismatched protocol version before pairing, pairs the hidden iroh phone simulator through explicit desktop approval, verifies the simulated pair flow completes within 15 seconds, lists and attaches to the sessions over iroh, starts a mobile session-list subscription before creating an explicitly named desktop session and verifies the new session appears through that subscription, sends mobile-originated input into `bash`, the default `claude`, and the subscribed desktop-created session and waits for matching output, detaches a simulated phone while a separate explicitly named session emits missed output and verifies reconnect-with-replay over iroh within 2 seconds from `last_seen_seq`, verifies switched sessions do not receive each other's output markers, verifies that the paired simulated phone receives `Forbidden` when it tries to create sessions, kill sessions, or emit agent-state hook events, removes the simulated device, verifies that the same device identity is rejected with `Unauthorized`, kills and restarts the daemon, and verifies that all last-known sessions are restored. It honors `CARGO_TARGET_DIR` for debug binaries while preserving the host `CARGO_HOME` and `RUSTUP_HOME`, so local runs can use `/tmp/fieldwork-target-checks` without recreating repo-local `target/debug` or redownloading the Rust toolchain into the isolated Fieldwork `HOME`. It sets `FIELDWORK_IROH_SECRET_KEY_B64` and `FIELDWORK_SCROLLBACK_ENCRYPTION_ENABLED=false` only inside that temp environment so the smoke can run on headless machines without keychain prompts. Production-like runs should leave the iroh secret override unset, and release verification must still cover encrypted-at-rest persistence plus physical QR camera scan timing.

The same local handoff smoke verifies the acknowledged Claude hook path updates
the matching session and that a mismatched Codex hook exits nonzero with the
daemon error instead of silently dropping the event.

CI installs `vim` for the Rust matrix and installs `expect` plus `vim` for the `Local Handoff Smoke` job so the no-args raw-terminal attach path, real `vim /etc/hosts` stale-attach snapshot gate, default-command spawn, arbitrary shell/TUI handoff, session-list subscription, pairing, iroh attach/input, warm reconnect replay, no-leak switching, revocation, and restart-restore behavior cannot regress without failing pull requests.

Website:

```sh
pnpm --dir site install --ignore-workspace --frozen-lockfile
pnpm check:site
pnpm build:site
```

The `site/` package is a static Astro build for `fieldwork.dev`. It is intentionally kept outside the npm distribution workspace so `fieldwork` package metadata stays isolated from site dependencies. The site renders the product, install, protocol, architecture, and privacy surfaces and imports the repository's screenshot-style SVG captures from `docs/assets/`. CI runs `pnpm --dir site install --ignore-workspace --frozen-lockfile` plus `pnpm check:site`; `.github/workflows/deploy-site.yml` fails closed on missing Cloudflare credentials before site install/build, then builds the same output and deploys `site/dist` to Cloudflare Pages only when the external Cloudflare credentials exist. Domain ownership, DNS control, and Cloudflare project credentials remain operator-owned external gates. `node scripts/check-domain-status.mjs --operator-refresh --require-registered --require-dns` is reserved for explicit operator-requested status refreshes; it is not a routine local build check. For local visual smoke, start `pnpm --dir site dev --host 127.0.0.1 --port 4321`, then use `agent-browser --auto-connect` with fixed waits rather than `networkidle` because Astro keeps a Vite HMR websocket open. Latest browser smoke captured `/`, `/install`, `/architecture`, `/protocol`, and `/privacy` screenshots and saw no console output.

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

Current local blocker for the full Week 4 platform matrix in this shell: the iOS SDK cannot be located because full Xcode is not selected. Apple lists Xcode 16.3 as the newest compatible full Xcode for this macOS 15.2 host; Xcode 16.4 requires macOS 15.3+ and Xcode 26.x requires macOS 15.6+/26.x. Apple App Store Connect uploads now require Xcode 26+ with an iOS 26+ SDK, so local development and TestFlight release verification intentionally use different gates. `xcodes` 1.6.2 and `aria2` 1.37.0_2 are installed, `.xcode-version` pins local Xcode `16.3`, the Rust iOS targets are installed, and source checkouts for `SwiftTerm` v1.13.0 and `blink` are present under `references/`. The Xcode project and committed SwiftPM lockfile pin SwiftTerm exactly to 1.13.0, and `pnpm check:mobile-privacy` verifies that pin. `scripts/check-ios-prereqs.sh` records the local prerequisite audit and supports `--download-xcode` for the credentialed Xcode 16.3 download path. The deterministic iOS prereq test covers missing `.xcode-version`, exact selected-Xcode comparison, and floored 70 GiB download headroom so CI protects the actionable failure paths without Apple credentials. When local Xcode is missing, the script now prints explicit next steps to authenticate, run `scripts/check-ios-prereqs.sh --download-xcode`, expand or place `Xcode_16.3.xip`, select `/Applications/Xcode-16.3.app/Contents/Developer`, run `sudo xcodebuild -runFirstLaunch`, rerun `pnpm check:ios-prereqs`, and then run `apps/ios/scripts/build-rust.sh`. `apps/ios/scripts/build-rust.sh` runs that prereq check before Cargo/Xcode work so local failures stop at the actionable Xcode/SDK diagnostic instead of failing later inside a dependency build script; it automatically switches to `--release` mode when the release-runner Xcode/SDK floor environment is present. `scripts/check-ios-prereqs.sh --release` verifies Xcode 26+ and iOS SDK 26+ for CI release runners. `xcodes update --data-source xcodeReleases` confirms Xcode 16.3 build `16E140` and Xcode 26.x releases through `26.5 (17F42)`. Generated `target/debug` and Android build intermediates were cleaned while preserving the release AAB; the latest local audit reports at least 70 GiB free in `~/Downloads`, satisfying the repo script's Xcode download/expansion guard. No Xcode `.xip` is present in `~/Downloads`: `scripts/check-ios-prereqs.sh --download-xcode` and direct `xcodes download 16.3 --data-source xcodeReleases` both report a missing Apple ID/password or require an authenticated Apple Developer session, direct `curl` against Apple's Xcode 16.3 XIP redirects to the unauthorized page, and the existing Chrome session is not signed into an account with access. Direct `fieldwork-mobile-core` iOS target builds fail at the prereq check because `xcrun --sdk iphoneos`/`iphonesimulator` cannot locate the SDKs. The iOS script is wired for `arm64` device plus `arm64`/`x86_64` simulator by building `aarch64-apple-ios`, `aarch64-apple-ios-sim`, and `x86_64-apple-ios`, then combining the simulator libraries with `lipo` before `xcodebuild -create-xcframework`. The Android side builds `fieldwork-mobile-core` for `arm64-v8a`, `armeabi-v7a`, and `x86_64` and generates Kotlin bindings through `apps/android/scripts/build-rust.sh`. The platform build scripts are `apps/ios/scripts/build-rust.sh` and `apps/android/scripts/build-rust.sh`.

iOS app v0:

```sh
open apps/ios/Fieldwork.xcodeproj
```

The Xcode target runs `apps/ios/scripts/build-rust.sh`, compiles the generated `GeneratedRust/fieldwork_mobile_core.swift`, links `GeneratedRust/FieldworkCore.xcframework`, and uses the exact SwiftPM pins for SwiftTerm. The app currently implements QR pairing with explicit camera authorization handling, Keychain persistence, biometric-only Face ID/Touch ID gating, session list refresh plus `SubscribeSessions` streaming updates after unlock/pairing, SwiftTerm attach/input/resize/detach, a keyboard accessory bar, Settings, delayed diagnostics consent, and APNs token registration plumbing. The iOS terminal controller buffers raw `Data` chunks and publishes an output revision on every byte arrival before optional UTF-8 fallback decoding, so SwiftTerm delivery is not gated on text decoding. The SwiftTerm renderer drains raw `Data` chunks into `uiView.feed(data:)`, converts them to `[UInt8]`, calls SwiftTerm's `feed(byteArray:)`, sends terminal input back as raw `Data`, and keeps the text fallback behind `#else`. The iOS service caches per-session `lastSeenSeq` offsets, passes cached offsets into `attachSessionFrom`, and the terminal controller reattaches from the latest `lastSeenSeq` after a daemon `Lag` before restarting the byte-stream subscription. The paired daemon record uses the data-protection Keychain with `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`, so it is not iCloud-synchronizable and is available only after device unlock. APNs permission and token registration are requested only after a saved or newly approved pairing exists and biometric unlock has succeeded; token callbacks are retained and sent through mobile-core once pairing is available. `Fieldwork.entitlements` carries `aps-environment = $(APS_ENVIRONMENT)`, with Debug set to `development` and Release set to `production`, so signed builds can receive APNs device tokens once the provisioning profile has the Push Notifications capability. Foreground APNs notifications use the relay's fixed generic copy, and notification taps carry only lowercase 64-character hex `session_id_hash`; the app resolves that hash against locally fetched sessions after biometric unlock. While locked, the SwiftUI root renders only the lock surface rather than a dimmed terminal/session view; stale foreground resumes trigger LocalAuthentication with `.deviceOwnerAuthenticationWithBiometrics` before session UI, session fetch/subscription, APNs permission, or terminal input is allowed. `SwiftTermView.swift` uses `#if canImport(SwiftTerm)`, so local Swift static parsing can include every app/core/feature/UI Swift source even before full Xcode/SPM has resolved package modules. `FieldworkCoreStubs.swift` is syntax-only fallback code behind `#if FIELDWORK_STUBS`; `pnpm check:mobile-privacy` verifies the real generated UniFFI Swift binding and xcframework are wired into the Xcode target, that locked roots and stale input gates stay in place, that QR pairing requests camera access explicitly with pairing-only copy, that raw-byte output delivery is not text-decoding gated, that the SwiftTerm renderer uses raw byte-array rendering, that iOS `lastSeenSeq` lag reattach wiring stays in place, that the SwiftPM package pins stay exact, and that neither project build settings nor `release-ios.yml` enable `FIELDWORK_STUBS`.

Current local blocker for verifying the iOS target in this shell: `xcodebuild` is present only through Command Line Tools and reports that full Xcode is not selected, so the iOS SDK cannot be located. Run `pnpm check:ios-prereqs` for the local prerequisite audit and its concrete Xcode install/select recovery steps, then run the iOS build on a machine with Xcode 16.3 selected via `xcode-select`. TestFlight/App Store builds run through `release-ios.yml` on `macos-26`, where `pnpm check:ios-release-prereqs` verifies Xcode 26+/iOS 26+ before archiving. The release workflow also rejects provisioning profiles that do not match `app.fieldwork.ios` or do not include production `aps-environment`.

Store privacy submission prep lives in `docs/STORE_PRIVACY.md`. Keep it synchronized with `docs/PRIVACY.md`, the mobile manifests, mobile diagnostics settings, APNs/FCM payload tests, and the final release build before filling App Store Connect or Play Console. Run `pnpm check:store-privacy` after changing mobile privacy docs, notification payloads, mobile telemetry, or release workflows.

Android app v0:

```sh
cd apps/android
scripts/build-rust.sh
./gradlew assembleDebug
```

The Android active terminal selection is stored in `FieldworkViewModel` state,
not local Compose-only state, so resize/configuration changes preserve the
attached terminal instead of returning to the session dashboard. Focused
FieldworkViewModel JVM tests cover retaining the active session id across
session updates with the same id, clearing it when the session disappears, and
clearing it on lock. A 2026-05-30 direct `adb` emulator refresh under
`/tmp/fieldwork-direct-adb-resize-detach-20260530.fixed5.sCedcI/evidence`
paired through typed code `HJ0CQ`, attached `android-resize`, stayed `Attached`
after a `1080x2400` -> `720x1280` viewport resize, reported `stty size` as
`23 42`, sent `after_resize_ok`, detached, reattached, and sent
`after_detach_reattach_ok`. This remains debug-emulator substitute evidence;
physical signed-release resize/detach verification is still a release gate.

The Android app pins `org.connectbot:termlib:0.0.35` as the Week 5.5 renderer decision. It implements CameraX QR scanning, encrypted pairing persistence, biometric-only BiometricPrompt gating, sessions with `SubscribeSessions` streaming updates after unlock/pairing, termlib terminal attach/input/resize/detach, delayed diagnostics consent, and FCM token registration plumbing. Focused Android JVM tests verify that the biometric freshness gate requires unlock before first use, does not reprompt immediately after a successful unlock, does not lock on fresh foreground resumes, and locks at the 5-minute stale foreground boundary. The Android terminal controller feeds raw `ByteArray` chunks directly to termlib without string decoding, caches per-session reconnect offsets through the repository, and reattaches from `lastSeenSeq` after a daemon `Lag` or attached-stream error. Focused Android JVM tests verify that the terminal controller refuses locked input before it reaches mobile-core, reattaches from the latest `lastSeenSeq` after a daemon `Lag`, reattaches from the latest `lastSeenSeq` after an attached-stream error, and records the delayed diagnostics consent experience only after `AwaitingInput`, user input, and at least 10 output lines. The paired daemon record is stored in `EncryptedSharedPreferences` with an AES256-GCM master key, AES256-SIV preference-key encryption, AES256-GCM value encryption, and backup/transfer exclusions for `fieldwork_pairing.xml`; refreshed FCM tokens are queued in app-private `fieldwork_push_tokens.xml`, which is also excluded from full backup, cloud backup, and device transfer. The source manifest explicitly declares only `INTERNET`, `CAMERA`, `POST_NOTIFICATIONS`, and `USE_BIOMETRIC`; the merged manifest is verified after Android builds so dependency-added permissions stay auditable. Notification permission and FCM token sync are requested only after a saved or newly approved pairing exists and biometric unlock has succeeded. FCM token refresh callbacks only queue trimmed tokens; the service does not register tokens directly, and queued/current tokens are sent and cleared only by the paired-and-unlocked token sync path. Focused Android FcmTokenRegistrar JVM tests verify trimmed token storage, blank-token rejection, matching-token clear semantics, and clear-all unpair behavior. Focused Android FieldworkViewModel JVM tests verify paired-but-locked sync does not register FCM tokens, paired-and-unlocked sync registers queued/current tokens and clears queued tokens only after success, duplicate queued/current tokens are registered once, unpair clears queued FCM tokens, valid push taps remain pending while locked and resolve only after unlock plus session refresh, unlocked push taps resolve against the current session list, invalid uppercase hashes clear stale pending routes and never route after unlock, unlock starts the session subscription, pairing while unlocked loads sessions, starts the subscription, and syncs FCM tokens, pairing while unlocked keeps the loaded sessions if an initial stale empty subscription update arrives, pairing while locked does not load sessions, subscribe, or sync FCM tokens, locking stops subscription updates, subscription updates replace the dashboard list, and pending push taps can resolve from later subscription updates. Foreground FCM messages render the same fixed-copy generic notification as the relay payload, require a lowercase 64-character hex `session_id_hash`, and notification tap intents carry only that hash; the view model uses the same strict lowercase hash parser before resolving the tap against locally fetched sessions after biometric unlock. Focused JVM tests verify that the tap parser trims whitespace but never lowercases uppercase hashes, that foreground notifications use fixed generic copy and private lock-screen visibility even if extra terminal or command fields are present, and that invalid event types or invalid hashes do not post notifications. The Compose root renders only the lock surface while unauthenticated, listens for lifecycle stop/resume, prompts through `BIOMETRIC_STRONG` only on stale resume, and gates session fetch/subscription plus terminal input before bytes are sent. Debug emulator QA can opt into a debug-build-only unlock path with `FIELDWORK_ANDROID_BIOMETRIC_BYPASS=true`; runtime still requires `BuildConfig.DEBUG`, release builds hardcode the bypass off, and the default smoke still verifies the locked surface. Debug/source builds compile without `apps/android/app/google-services.json`; in that mode Firebase is not initialized and no FCM token is generated. Release CI writes `google-services.json` from the `ANDROID_GOOGLE_SERVICES_JSON` secret before building.

Mobile diagnostics sharing is opt-in, but v1 does not bundle a mobile crash-reporting SDK. Focused Android MobileTelemetry JVM tests verify diagnostics sharing defaults off, declined consent resolves the one-time prompt without enabling diagnostics, and accepted consent persists as a local diagnostics preference without starting a crash-reporting SDK. The prompt is shown only after an attached session has reached `AwaitingInput`, the user has responded, and at least 10 later output lines arrive. Release workflows no longer inject a mobile crash-reporting credential. `pnpm check:telemetry-privacy` enforces the daemon, mobile delayed consent, iOS, Android, and relay telemetry privacy wiring, and when Android APK/AAB outputs exist it scans the packaged ZIP entries and inflated contents for removed crash SDK markers before passing.

The repo-local `./gradlew` script pins Gradle 8.14.3, verifies the Gradle distribution SHA-256 before extraction, uses Android Studio's bundled JBR when `JAVA_HOME` is unset or points to a pre-21 JDK, and auto-discovers the default macOS/Linux Android SDK directories. JDK 21+ is required because Robolectric runs the Android SDK 36 unit tests in that runtime. `scripts/build-rust.sh` auto-discovers the newest NDK under the SDK and builds `fieldwork-mobile-core` for `arm64-v8a`, `armeabi-v7a`, and `x86_64`, then generates Kotlin bindings.

CI's `Android Debug Build` job runs `apps/android/scripts/build-rust.sh`, `node scripts/verify-uniffi-bindings.mjs`, `apps/android/gradlew --no-daemon :app:compileDebugKotlin`, `apps/android/gradlew --no-daemon :app:testDebugUnitTest`, `node scripts/verify-mobile-privacy.mjs`, and `node scripts/verify-store-privacy.mjs`, so generated UniFFI bindings, the v1-only generated mobile API surface, JNI library packaging, Kotlin/Compose compilation, focused Android JVM unit tests, the merged Android permission surface, mobile privacy defaults, and the store answer sheet are checked without requiring release signing or Firebase credentials. The npm/static CI job also runs `node scripts/verify-telemetry-privacy.mjs` so local diagnostics consent, daemon export absence, and Honeycomb credential boundaries remain mechanically checked, `node scripts/verify-v1-boundary.mjs` so future-only protocol flags, mobile create/kill/session-command affordances, and voice/watch/live-activity imports cannot drift into v1, `node scripts/verify-no-ship-markers.mjs` plus `--self-test` so production source cannot retain no-ship markers and the verifier's fail-closed behavior stays covered, and `node scripts/verify-daemon-resize.mjs` so attached-client resize changes keep minimum-viewport selection plus 100 ms debounced attach/update/detach scheduling.

Android release artifact smoke:

```sh
cd apps/android
scripts/build-rust.sh
./gradlew --no-daemon bundleRelease
pnpm check:android-aab
pnpm check:android-release-readiness:local
```

A 2026-05-30 local Android release refresh reran
`apps/android/gradlew --no-daemon :app:bundleRelease`, `pnpm check:android-aab`,
and the local release-install evidence verifier against the rebuilt bundle. The
preceding 2026-05-29 release readiness pass ran `pnpm test:android-unit`, which
compiled debug Kotlin and ran `:app:testDebugUnitTest`, plus
`pnpm check:live-testing-readiness:local` and
`pnpm check:android-release-readiness:local`. The current
`apps/android/app/build/outputs/bundle/release/app-release.aab` is `57M`,
SHA-256
`af38adfb7541caf31c45afa216c61c4fa2dbce9ab1168ce91181f91a1f0ccca8`; strict
Android release readiness still waits on release signing secrets, Play secrets,
and one authorized physical Android phone with the signed release app installed.
Firebase project `fieldwork-oss` has an active Android app for
`app.fieldwork.android`; the ignored local `apps/android/app/google-services.json`
is populated for source-checkout builds, and the `ANDROID_GOOGLE_SERVICES_JSON`
GitHub Actions secret is set on `fieldwork-app/fieldwork`.

A 2026-05-25 direct-adb debug APK hygiene refresh found a retained
`app-debug.apk` from an earlier debug-pairing run that still embedded a one-time
legacy JSON pairing payload even though generated debug `BuildConfig.java` had
`FIELDWORK_BIOMETRIC_BYPASS = false` and
`FIELDWORK_DEBUG_PAIRING_CODE = ""`. `pnpm check:android-debug-apk` now
rejects stale legacy JSON pairing payload in `classes*.dex`, verifies the
default debug `BuildConfig`, app identity/version, manifest privacy surface, and
all three Fieldwork core ABI slices. `node scripts/test-android-debug-apk-verifier.mjs`
covers stale legacy payload, explicit legacy-payload mode, missing-ABI,
forbidden-permission, and non-empty BuildConfig cases, and
`pnpm check:local-release -- --with-artifacts` runs the current debug APK
artifact check alongside the AAB checks.

The latest completed local release bundle validation rebuilt the bundle against current Android source with `apps/android/gradlew --no-daemon :app:bundleRelease` and produced `apps/android/app/build/outputs/bundle/release/app-release.aab` (`57M`, SHA-256 `af38adfb7541caf31c45afa216c61c4fa2dbce9ab1168ce91181f91a1f0ccca8`). Earlier 2026-05-18 validation rebuilt `apps/android/scripts/build-rust.sh` and regenerated UniFFI Kotlin bindings for all three v1 ABIs. `pnpm check:android-aab` verifies that a present bundle includes `libfieldwork_mobile_core.so` for `arm64-v8a`, `armeabi-v7a`, and `x86_64`, does not accidentally include a 32-bit x86 Fieldwork core, keeps the packaged protobuf manifest identity, version, uses-permission allowlist plus packaged protobuf manifest privacy surface free of location, microphone, contacts, media, storage, debuggable state, session-name, command, and terminal-content fields while preserving the required Firebase opt-out metadata, enforces release `BuildConfig` values for `app.fieldwork.android`, `versionCode=1`, `versionName=1.0`, `BUILD_TYPE=release`, `DEBUG=false`, biometric bypass off, and empty debug pairing code, and enforces the local unsigned AAB state with `--expect-unsigned`. Signed mode requires `META-INF` signature entries, successful `jarsigner -verify -certs`, a `jar verified` marker, and no Android Debug certificate subject. `node scripts/test-android-aab-verifier.mjs` covers that verifier with synthetic unsigned and signed AABs, including failure when signature entries are present under `--expect-unsigned`, forbidden location permission, missing notification permission, terminal-content metadata such as `last_line`, wrong release version, debug `BuildConfig`, a debuggable manifest, a signed-looking bundle whose `jarsigner` verification fails, zero-exit `jarsigner` output without `jar verified`, and Android Debug certificate output. `pnpm test:android-aab-signing-smoke` signs a temporary copy of the current real AAB with an ephemeral non-debug certificate, verifies that copy through `node scripts/verify-android-aab.mjs --expect-signed`, and deletes the temporary keystore and signed bundle afterward. Android Studio's bundled `jarsigner` also reports `jar is unsigned` for the local bundle. Release signing with the Play keystore remains blocked until the release keystore and GitHub Secrets exist. The GitHub release workflow fails closed before toolchain setup and Rust/mobile build if Firebase, signing, or Play upload secrets are missing, uses this pinned `gradlew`, chmods decoded Firebase/signing files to `0600`, verifies the AAB contents and signed-bundle `jarsigner` result with `node scripts/verify-android-aab.mjs --expect-signed`, runs `jarsigner -verify -certs` again before upload, and removes the generated Firebase/signing files in an `always()` cleanup step. `scripts/verify-android-release-signing-evidence.mjs` defines the real signed-AAB evidence contract: `artifact-signing.txt`, `jarsigner.txt`, `sha256.txt`, `buildconfig.txt`, and `workflow-run.txt` must come from `release-android.yml` and an operator-owned release keystore, not a debug or local smoke signer. `scripts/test-android-release-signing-evidence.mjs` keeps that verifier covered, while `scripts/create-android-release-signing-evidence-dir.mjs` and `scripts/test-android-release-signing-scaffold.mjs` create and test a capture scaffold without fabricating verifier evidence. `pnpm test:android-debug-smoke` is the repeatable local emulator substitute when exactly one booted adb device is available: it installs the debug app, clears main logcat and the crash buffer before launch, launches `app.fieldwork.android/.MainActivity`, requires `Status: ok`, checks that `TotalTime` stays below the debug-smoke limit, rejects system ANR dialogs in the UI tree, requires the locked `Unlock` surface by default, rejects Fieldwork crash/ANR logcat entries, and verifies that `screencap` is a nonblank 1080x2400 PNG. On AVDs without enrolled biometrics, `FIELDWORK_ANDROID_BIOMETRIC_BYPASS=true pnpm test:android-debug-smoke` compiles a debug-build-only bypass guarded by `BuildConfig.DEBUG` and verifies the unlocked pairing/bottom-navigation UI instead; release builds hardcode that bypass off. `pnpm test:android-emulator-pair` goes one step deeper: it starts an isolated local release daemon, creates a desktop `bash` session, injects the typed pairing code through debug-only `FIELDWORK_ANDROID_PAIRING_CODE`, approves the Android pairing from the desktop CLI, verifies the app shows the desktop-created session, opens the terminal, backgrounds and foregrounds the app, sends mobile-originated input into the PTY, and attaches a separately approved verifier client to confirm the Android-sent output appears in replayed terminal bytes. Direct adb QA on 2026-05-19 also installed and launched the debug APK, captured `am start -W` `TotalTime=861ms`, paired against an isolated release daemon through explicit desktop approval, listed `bash · fieldwork` with `ANDROID_ADB_DIRECT_READY`, attached the terminal, sent `android_adb_direct_input` through `adb shell input`, and captured a screenshot showing the PTY response. `pnpm test:android-emulator-flood` renders a `yes | head -10000`-scale stream in the actual Android terminal view, checks a flood screenshot nonblank, rejects Fieldwork crash/ANR logcat entries, and confirms replayed terminal bytes contain `ANDROID_EMULATOR_FLOOD` output through a separately approved verifier client; latest hosted-relay aggregate execution on 2026-05-29 reported 8437/14400 nonblack screenshot samples. Every focused emulator smoke clears main logcat and the crash buffer before collecting current-run crash evidence, while still scoping the final crash/ANR logcat rejection to Fieldwork because Play Store AVD images can emit unrelated Google-service ANRs. `pnpm test:android-emulator-multisession` pairs the actual Android app, opens three desktop-created sessions (`fwm_a`, `fwm_b`, `fwm_c`), switches among all three in the app, sends Android-originated input to each, and verifies host-side per-session logs so `multi_a_ok`, `multi_b_ok`, and `multi_c_ok` land only in their selected PTYs; latest focused run on 2026-05-29 passed on `emulator-5554` after hosted-relay typed-code hardening. `pnpm test:android-emulator-reconnect` pairs the actual Android app, opens a desktop-created terminal, sends input before and after an emulator airplane-mode network cut, verifies the desktop PTY receives post-restore Android input, and uses a separately approved verifier to confirm output emitted during the network gap remains replayable. `pnpm test:android-emulator-notification-tap` pairs the actual Android app, computes a real desktop session's lowercase `session_id_hash`, verifies an uppercase invalid hash does not route, launches the same hash-only activity intent that notification taps use, opens the target terminal through the debug-only biometric bypass, and verifies `notify_tap_ok` lands only in the target PTY. Latest wiped API 36.1 AVD debug-launch run passed with `TotalTime=2467ms` and 14391/14400 nonblack screenshot samples. The Play Store image still emitted background Google-service ANRs, so this is only debug substitute evidence. The Android startup path now keeps the encrypted pairing store lazy, restores saved pairing on `Dispatchers.IO`, and has focused FieldworkViewModel JVM coverage proving construction does not block on saved-pairing restore. The Android root uses an explicit Material color scheme and explicit lock-button colors so that surface does not depend on system dark-mode defaults. Treat Android release cold-start, terminal flood, real provider notification delivery/tap, biometric, background/foreground, and network-change checks as physical release-device gates.

`pnpm check:android-release-readiness:local` is the consolidated local Android release preflight. It checks the desktop command surfaces used during capture, falling back to an internal temporary `fw`/`fieldwork`/`fieldworkd` shim backed by repo-local `target/release/fieldwork` and `target/release/fieldworkd` when the npm-installed `fw` alias is not on `PATH`; that fallback must prove `Usage: fw`, `Usage: fw doctor`, and `Usage: fieldworkd`. It also checks the release AAB and release `BuildConfig`, runs the AAB, mobile privacy, store privacy, and release workflow verifiers, confirms the release-signing/install evidence contracts exist, and reports release-only blockers as pending rather than pretending they are done. Strict `pnpm check:android-release-readiness` requires current `fw` and `fieldworkd` commands on `PATH`, the real release secrets, a signed AAB, exactly one authorized physical Android phone, and a non-debuggable installed `app.fieldwork.android` package before release-device evidence capture.

`pnpm scaffold:android-release-evidence-pack -- --print-dir` creates one top-level Android signed-release evidence workspace with a source-checkout `fw`/`fieldwork`/`fieldworkd` command shim plus focused subdirectories for release signing, release install, pair flow, session subscription, terminal attach, resize/detach, biometric, dogfood, cold start, renderer flood, background/foreground, network reconnect, restart restore, multisession, and FCM push. The pack writes `setup.sh`, `capture-order.md`, `manifest.json`, `readiness.sh`, and `verify.sh`; `readiness.sh` prepends the generated command shim to `PATH`, runs `pnpm check:android-release-readiness:local`, then runs `fw doctor` to prove the desktop CLI can auto-start and handshake with `fieldworkd` before physical evidence capture. After capture, `verify.sh` runs every focused Android release evidence verifier in capture order, including the strict release-install physical-device check. It does not create or fabricate verifier evidence. `pnpm test:android-release-evidence-pack` and `pnpm check:local-release` keep the pack scaffold wired to the focused evidence scaffolds so the physical-phone pass starts from one command instead of a manually remembered list.

`pnpm test:android-emulator` is the aggregate direct-adb substitute suite for a
booted emulator. It runs the locked debug launch smoke and then the pair,
session-subscription, background-replay, restart-restore, flood, multisession,
reconnect, and notification-tap smokes in order.
`pnpm test:android-emulator -- --list` prints the exact underlying adb scripts
without requiring a device. The aggregate retries only locked debug-launch and
session-subscription timing outliers once with the same strict limits; every
other script failure fails closed and preserves the captured wrapper output path.
The aggregate still fails closed unless exactly one boot-complete adb device is
available, or
`FIELDWORK_ANDROID_SERIAL` names the target. The latest hosted-relay aggregate
run on 2026-05-29 passed on `emulator-5554`: locked debug launch
`TotalTime=6448ms` (below the default 8000ms limit), pair
`pair_flow_ms=1420`, session subscription `visible_ms=5493`, flood screenshot
8437/14400 nonblack samples, and successful background replay, restart restore,
multisession, reconnect, and notification tap routing.

A later manual adb rerun on 2026-05-19 used direct `adb install`, `am start -W`, `uiautomator`, `screencap`, and logcat. After hiding the emulator IME before tapping Pair, it launched in `TotalTime=1082ms`, paired through explicit desktop approval, listed `bash · fieldwork`, attached the terminal, and showed `echo android_adb_direct_input` plus the matching PTY output. The debug build output was then rebuilt without test-only environment flags and checked to contain `FIELDWORK_BIOMETRIC_BYPASS = false` and an empty `FIELDWORK_DEBUG_PAIRING_CODE`. A later 2026-05-22 direct adb manual pass under `/tmp/fieldwork-adb-direct-20260522225023` paired a debug-only biometric-bypass/pair-payload Android build to an isolated release daemon, opened the desktop-created `adb_direct` session, sent `direct_adb_ok` from Android, and verified `android-direct: direct_adb_ok` through a separately approved desktop attach; after the emulator `uiautomator` process hung, evidence was captured with direct adb screenshots, logcat, an empty terminal crash buffer, and restored-default `FIELDWORK_BIOMETRIC_BYPASS = false` plus empty `FIELDWORK_DEBUG_PAIRING_CODE` proof. A 2026-05-22 resume pass under `/tmp/fieldwork-adb-direct-20260522-resume.mtHG9a` reproduced and fixed a post-pair dashboard race where an initial empty session subscription update could blank the loaded list until manual refresh; the fixed debug APK paired through desktop approval and showed the desktop-created `shell` session immediately after dismissing the `Paired` dialog, then displayed a later desktop-created `livebash` session through subscription and attached it as `Attached`.

A follow-up raw adb locked-launch baseline on 2026-05-19 installed the default debug APK, launched `app.fieldwork.android/.MainActivity` with `am start -W` `TotalTime=2078ms`, captured `/tmp/fieldwork-adb-launch.png`, `/tmp/fieldwork-adb-ui.xml`, app-scoped logcat, and the crash buffer, and verified the `Unlock` surface with an empty Fieldwork crash buffer. This remains a debug emulator smoke result, not release-device cold-start threshold evidence.

A 2026-05-19 raw adb emulator QA refresh installed the default debug APK, launched with `Status: ok` and `TotalTime=5297ms`, captured `/tmp/fieldwork-adb-direct-20260519225027/default.png`, `/tmp/fieldwork-adb-direct-20260519225027/default-ui.xml`, `/tmp/fieldwork-adb-direct-20260519225027/default-logcat.log`, and an empty `/tmp/fieldwork-adb-direct-20260519225027/default-crash.log`, and verified the locked `Unlock` surface. The same direct adb run rebuilt the debug APK with `FIELDWORK_ANDROID_BIOMETRIC_BYPASS=true` plus debug-only `FIELDWORK_ANDROID_PAIRING_CODE`, launched the pair build in `TotalTime=4589ms`, tapped the UI-tree-derived Pair center `540 1860`, paired through explicit desktop approval in `pair_flow_ms=1043`, captured `/tmp/fieldwork-adb-direct-pair-20260519225208/before-pair.png`, `/tmp/fieldwork-adb-direct-pair-20260519225208/sessions.png`, `/tmp/fieldwork-adb-direct-pair-20260519225208/terminal-before-input.png`, `/tmp/fieldwork-adb-direct-pair-20260519225208/terminal-after-input.png`, UI XML, logcat, and an empty crash buffer, and confirmed a separately approved verifier client saw `android-direct: fw_android_direct_ok` in replayed terminal bytes. Afterward the default debug APK was rebuilt and reinstalled, `BuildConfig.java` was checked to contain `FIELDWORK_BIOMETRIC_BYPASS = false` and `FIELDWORK_DEBUG_PAIRING_CODE = ""`, the restored default build launched in `TotalTime=5105ms`, `/tmp/fieldwork-adb-direct-restore-20260519225316/restored-locked.png` plus `/tmp/fieldwork-adb-direct-restore-20260519225316/restored-ui.xml` verified the locked `Unlock` surface again, and the restored crash buffer remained empty. A 2026-05-20 direct adb restore-fix pass paired through explicit desktop approval, attached `bash · fieldwork`, sent `android_adb_direct_ping`, verified `android-direct: android_adb_direct_ping` in `/tmp/fieldwork-adb-direct-pair-20260519235638/terminal-after-input.png` and `/tmp/fieldwork-adb-direct-pair-20260519235638/pty-output-after-input.txt`, then rebuilt a biometric-bypass debug APK with empty `FIELDWORK_DEBUG_PAIRING_CODE`. A paired-data relaunch completed with `Status: ok` and `TotalTime=6225ms`, captured `/tmp/fieldwork-adb-direct-pair-20260519235638/relaunch-restore-fix-sessions.png` plus UI XML/logcat, and filtered logcat showed `FieldworkRepository: listSessions returned 1 sessions` with no `Camera`/`CAMERA`, Fieldwork `FATAL`, or ANR entries after the saved-pairing restore placeholder fix. A later 2026-05-20 raw adb pass installed the default debug APK, launched the locked app in `TotalTime=6766ms`, captured `/tmp/fieldwork-adb-direct-20260520001909/default-locked.png`, UI XML, app logcat, and an empty crash buffer, then rebuilt with `FIELDWORK_ANDROID_BIOMETRIC_BYPASS=true` plus debug-only `FIELDWORK_ANDROID_PAIRING_CODE`, paired through explicit desktop approval, accepted the runtime notification prompt, listed `bash · fieldwork` with `ANDROID_ADB_MANUAL_READY`, attached the terminal, sent `android_adb_manual_ok` through `adb shell input text`, and captured `/tmp/fieldwork-adb-direct-20260520001909/terminal-after-input.png` showing `android-direct: android_adb_manual_ok`. App logcat showed `FieldworkRepository: pair completed` and `FieldworkRepository: listSessions returned 1 sessions`, crash buffers remained empty, and the restored default build had `FIELDWORK_BIOMETRIC_BYPASS = false`, `FIELDWORK_DEBUG_PAIRING_CODE = ""`, `TotalTime=1371ms`, and the locked `Unlock` surface at `/tmp/fieldwork-adb-direct-20260520001909/default-restore-locked.png`. This is direct adb emulator evidence only, not release-device cold-start threshold evidence.

A 2026-05-20 direct locked-launch refresh on a freshly booted `Medium_Phone_API_36.1` emulator installed the default debug APK, launched with `Status: ok`, `LaunchState: COLD`, and `TotalTime=1919ms`, captured `/tmp/fieldwork-adb-direct-20260520092447/default-locked.png`, `/tmp/fieldwork-adb-direct-20260520092447/default-ui.xml`, `/tmp/fieldwork-adb-direct-20260520092447/default-logcat.log`, `/tmp/fieldwork-adb-direct-20260520092447/default-app-pid-logcat.log`, and an empty `/tmp/fieldwork-adb-direct-20260520092447/default-crash.log`, verified a 1080x2400 screenshot plus `text="Unlock"` in the UI dump, and found no Fieldwork `FATAL EXCEPTION` or ANR log entries. This is still debug-emulator evidence, not release-device cold-start threshold evidence.

A 2026-05-20 direct adb refresh installed the default debug APK, launched the locked app with `Status: ok`, `LaunchState: COLD`, and `TotalTime=2360ms`, captured `/tmp/fieldwork-adb-direct-20260520100608/default-locked.png`, `/tmp/fieldwork-adb-direct-20260520100608/default-ui.xml`, `/tmp/fieldwork-adb-direct-20260520100608/default-logcat.log`, and an empty `/tmp/fieldwork-adb-direct-20260520100608/default-crash.log`, then paired an isolated release daemon through the debug-only biometric-bypass/pair-payload APK in `/tmp/fieldwork-adb-direct-pair-20260520100742`. The run accepted the runtime camera and notification prompts, paired through explicit desktop approval, listed `bash · fieldwork` with `ANDROID_ADB_DIRECT_READY`, attached the terminal, sent `android_adb_direct_ping` through `adb shell input text`, and captured `/tmp/fieldwork-adb-direct-pair-20260520100742/terminal-after-input.png` showing `android-direct: android_adb_direct_ping`. `fieldwork devices` listed `sdk_gphone64_arm64`, the terminal crash buffer was empty, and the debug APK was rebuilt back to default with `FIELDWORK_BIOMETRIC_BYPASS = false`, `FIELDWORK_DEBUG_PAIRING_CODE = ""`, and the restored locked screen at `/tmp/fieldwork-adb-direct-pair-20260520100742/default-restored-locked.png`. This is direct adb emulator evidence only, not release-device cold-start or physical biometric evidence.

A 2026-05-20 direct adb shortcut-dashboard refresh on `Medium_Phone_API_36.1` used only `adb`, `expect`, `uiautomator`, `screencap`, and logcat. It started an isolated release daemon, ran bare `target/release/fieldwork` to create and attach the auto-named default `claude` session `cupcake`, ran `target/release/fieldwork refactoringjob` to create and attach the named-session shortcut, created `shell` with `fieldwork new --name shell`, paired the debug Android app through explicit desktop approval, dismissed the post-pair `OK` dialog, and captured `/tmp/fieldwork-shortcut-adb-clean-51uCRiNt/dashboard.png` plus `/tmp/fieldwork-shortcut-adb-clean-51uCRiNt/dashboard.xml`. The dashboard XML listed `cupcake`, `refactoringjob`, and `shell` with no `No sessions` state; the debug APK was later restored to `FIELDWORK_BIOMETRIC_BYPASS = false` and `FIELDWORK_DEBUG_PAIRING_CODE = ""`. This is direct adb emulator shortcut evidence only, not physical release-device evidence.

A later 2026-05-20 direct adb source-build `fw` shim pass used the first-live-test command shape without the wrapper smoke scripts: a temporary `fw` symlink pointed at `target/release/fieldwork`, bare `fw` created and attached the auto-named default `claude` session `kazoo`, `fw refactoringjob` created and attached the named shortcut, and `fw new --name shell` created the explicit shell session. The Android debug app was rebuilt with only the debug-only biometric bypass and pairing code, paired through explicit desktop approval in `pair_flow_ms=423`, and captured `/tmp/fieldwork-fw-direct-pair-20260520152507/before-pair.png`, `/tmp/fieldwork-fw-direct-pair-20260520152507/dashboard.png`, `/tmp/fieldwork-fw-direct-pair-20260520152507/after-pair.xml`, `/tmp/fieldwork-fw-direct-pair-20260520152507/dashboard-logcat.log`, and an empty `/tmp/fieldwork-fw-direct-pair-20260520152507/dashboard-crash.log`. `fw ls` listed `kazoo`, `refactoringjob`, and `shell`; the dashboard XML showed all three sessions with no `No sessions` state; app logcat showed `FieldworkRepository: pair completed` and `FieldworkRepository: listSessions returned 3 sessions`; and the debug APK was restored to `FIELDWORK_BIOMETRIC_BYPASS = false` and `FIELDWORK_DEBUG_PAIRING_CODE = ""`. This is direct adb emulator evidence only, not physical release-device evidence.

A 2026-05-23 direct adb refresh under `/tmp/fieldwork-adb-direct-20260523103948` repeated the first-live-test shape against the current tree with no app wrapper smoke script. The default debug APK launched locked in `TotalTime=1922ms`; a temp npm-layout `fw` shim plus sibling `fieldworkd` symlink created auto-named `widget`, `fw refactoringjob` created the named Claude shortcut, and `fieldwork new --name shell` created a desktop-owned shell. Android paired through the actual Pair UI and explicit desktop approval, the dashboard showed `widget`, `refactoringjob`, and `shell`, logcat showed `FieldworkRepository: pair completed` plus `FieldworkRepository: listSessions returned 3 sessions`, Android attached to `shell`, sent `fw_android_live_ok`, and a desktop attach replay in `terminal-replay-clean.txt` contained `android-direct: fw_android_live_ok`. Force-stop/relaunch restored the paired dashboard in `TotalTime=1266ms` with that scrollback. The default debug APK was rebuilt/reinstalled afterward; `BuildConfig.java` contained `FIELDWORK_BIOMETRIC_BYPASS = false` and `FIELDWORK_DEBUG_PAIRING_CODE = ""`, the restored launch showed the locked `Unlock` surface in `TotalTime=1321ms`, and crash/ANR scans were empty. This is direct adb emulator evidence only, not physical release-device evidence.

A 2026-05-30 direct adb refresh under `/tmp/fieldwork-adb-direct-20260530042105` paired the current debug app to an isolated release daemon through the hosted relay typed-code path and explicit desktop approval. The dashboard showed the desktop-created `adbpair` session with `ANDROID_ADB_DIRECT_READY`, Android attached to the live terminal, sent `android_adb_direct_ok` through `adb shell input text` plus Enter, and `desktop-replay.txt` confirmed the same daemon-owned PTY replay contained `android-direct: android_adb_direct_ok`. Captured evidence includes locked, pair, dashboard, terminal-before-input, terminal-after-input, UI dump, logcat, device-listing, and empty crash-buffer files; the final Fieldwork crash/ANR scan was empty. The default debug APK was rebuilt/reinstalled afterward with `FIELDWORK_BIOMETRIC_BYPASS = false`, `FIELDWORK_DEBUG_PAIRING_CODE = ""`, and `FIELDWORK_RELAY_CONTROL_URL = ""`. This remains direct adb emulator evidence only, not a replacement for signed physical release-device gates.

A 2026-05-20 direct adb empty-dashboard refresh used an isolated release daemon with no pre-existing sessions, a debug-only injected pair payload, direct `adb install`, `adb shell input tap`, `uiautomator` dumps, screenshots, logcat, and crash-buffer capture. The app paired through explicit desktop approval and captured `/tmp/fieldwork-empty-direct-20260520162209/empty-dashboard.png` plus `/tmp/fieldwork-empty-direct-20260520162209/empty-dashboard.xml`; the UI dump showed `No sessions` and `Create one on your laptop with fw new.`. App logcat showed `FieldworkRepository: pair completed` and `FieldworkRepository: listSessions returned 0 sessions`, crash buffers were empty, and the default debug APK was restored to `FIELDWORK_BIOMETRIC_BYPASS = false`, `FIELDWORK_DEBUG_PAIRING_CODE = ""`, and the locked `Unlock` surface at `/tmp/fieldwork-empty-direct-20260520162209/default-locked.png`.

A 2026-05-21 direct adb terminal-focus refresh moved the Android terminal attach
surface to the app root while attached, hid the global Sessions/Settings bottom
navigation, explicitly focused termlib's IME target, and verified
`adb shell input text android_terminal_fix_ok` reached the daemon-owned PTY.
Evidence under `/tmp/fieldwork-adb-terminalfix-live-20260521155139` captured
the attached `androidfix` terminal, app logcat, an empty crash buffer, and
restored default debug APK state. A same-day TUI attach pass then opened a
daemon-owned `htop` session named `tui` from the Android dashboard; evidence
under `/tmp/fieldwork-adb-tui-live-20260521160229` shows `tui` as `Working`,
`Attached` terminal state, `htop` function-key chrome (`F1Help`, `F2Setup`,
`F10Quit`), the accessory bar, focused termlib IME target, empty crash buffers,
and a final restored locked default build with `FIELDWORK_BIOMETRIC_BYPASS =
false` and `FIELDWORK_DEBUG_PAIRING_CODE = ""`. This is direct adb emulator
evidence only; the physical Android dogfood gate remains unchecked.

The first-round live-test evidence verifier now requires `package-info.txt`
from `adb shell pm path app.fieldwork.android` plus
`adb shell dumpsys package app.fieldwork.android`, proving the installed app is
`app.fieldwork.android` with `versionName=1.0` and `versionCode=1`. It also
requires `buildconfig.txt` showing `APPLICATION_ID = "app.fieldwork.android"`,
`BUILD_TYPE = "debug"`, `DEBUG = Boolean.parseBoolean("true")`,
`FIELDWORK_BIOMETRIC_BYPASS = false`, and
`FIELDWORK_DEBUG_PAIRING_CODE = ""` so physical-device evidence cannot be
captured from the wrong app, a release variant, or a bypass build. It also uses
`scripts/create-live-testing-evidence-dir.mjs` to generate
`capture-checklist.md`, a stage-by-stage direct `adb` capture checklist derived
from the verifier's required files, while still fabricating no screenshots, UI
dumps, logs, crash buffers, or transcripts. It also requires a dedicated active-dashboard
capture (`dashboard.png`, `dashboard-ui.xml`, `dashboard-logcat.log`, and
`dashboard-crash.log`) before terminal attach; the dashboard UI dump must show
the generated one-word bare-`fw` session, `refactoringjob`, and the
desktop-created shell/bash session, and `sessions.txt` must bind both the
generated session and `refactoringjob` to `claude` rows. The verifier also
requires a post-pair subscription evidence set: desktop-created `fw_live_sub`
must appear in `subscription-ui.xml`, `subscription-visible.txt` must record
`created_by_desktop_cli` plus `visible_ms=<elapsed-ms>` at or below 2000, and
`subscription-replay.txt` must contain Android-originated `subscription_attach_ok`
after attaching that subscribed session. The verifier also
requires a dedicated TUI attach capture (`tui.png`, `tui-ui.xml`,
`tui-logcat.log`, and `tui-crash.log`) in addition to the locked and normal
session captures, and it fails unless the UI dump shows `Attached` plus visible
`vim`/`htop` terminal content.
It also requires `terminal-replay.txt`, captured by reattaching from the desktop
to the same daemon-owned `shell`/`bash` session after Android sends
`echo android_live_ok`; that transcript must contain `android_live_ok` so the
round proves phone and laptop are looking at the same PTY rather than a mirrored
screen or disconnected view.
The high-volume terminal renderer gate has its own physical Android evidence:
`flood.png`, `flood-ui.xml`, `flood-logcat.log`, `flood-crash.log`, and
`flood-replay.txt`. The UI dump must show `ANDROID_LIVE_FLOOD` in the attached
terminal view, and the desktop replay must prove the Android-originated
`yes ANDROID_LIVE_FLOOD | head -10000` stream completed with
`flood_lines=10000` plus at least 10000 replayed marker lines.
The same verifier now requires dedicated background/foreground, network
reconnect, daemon restart restore, and multi-session switching evidence:
`background-replay.txt` must include `ANDROID_BACKGROUND_REPLAY_OUTPUT` and
`after_background_ok`, `reconnect-replay.txt` must include
`NETWORK_REPLAY_OUTPUT`, `after_reconnect_ok`, and `reconnect_ms=<elapsed-ms>`
at or below 2000, `restart-replay.txt` must include `fw_restart_session` and
`ANDROID_RESTART_SCROLLBACK`, and the three multisession replay files must prove
`multi_a_ok`, `multi_b_ok`, and `multi_c_ok` stay isolated to `fwm_a`, `fwm_b`,
and `fwm_c`.

A later direct adb live-test-shaped emulator bundle on 2026-05-21 captured the
then-current evidence layout under `/tmp/fieldwork-live-emulator-8UZh53hL` and
passed the verifier before the stricter desktop replay and state-preservation
requirements were added.
It launched the default locked APK, paired a debug-only payload build through
explicit desktop approval, showed desktop-created `refactoringjob`, `shell`,
`editor`, and `extra` sessions on the dashboard, opened the dedicated `editor`
`htop` session with `Attached` status and visible function-key chrome, and then
rebuilt/reinstalled the default APK with `FIELDWORK_BIOMETRIC_BYPASS = false`,
`FIELDWORK_DEBUG_PAIRING_CODE = ""`, the locked `Unlock` surface, and an
empty restored crash buffer. This is still emulator substitute evidence only.

A 2026-05-21 direct adb pair/attach refresh used a freshly rebooted
`Medium_Phone_API_36.1` emulator after Android system services timed out during
an abandoned stale-token attempt. The passing run installed a debug-only
pairing-code build, launched in `TotalTime=1717ms`, paired through explicit
desktop approval, listed the desktop-created `android-direct` session, attached
the terminal, sent `fw_direct_20260521_ok` through `adb shell input text`, and
captured screenshots/UI dumps/logcat under `/tmp/fieldwork-adb-direct-20260521165654`.
The desktop replay file
`/tmp/fieldwork-adb-direct-20260521165654/pair-runtime/pty-replay-after-input.txt`
contains `android-direct: fw_direct_20260521_ok`; app logcat showed
`FieldworkRepository: pair completed` and `FieldworkRepository: listSessions
returned 1 sessions`; crash buffers were empty. The APK was rebuilt and
reinstalled back to `FIELDWORK_BIOMETRIC_BYPASS = false` and
`FIELDWORK_DEBUG_PAIRING_CODE = ""`, then relaunched with `Status: ok`,
`TotalTime=1862ms`, and the locked `Unlock` surface. This is direct adb emulator
evidence only, not physical release-device evidence.

A later 2026-05-21 direct adb locked-launch refresh reinstalled the default
debug APK on `Medium_Phone_API_36.1`, verified the generated debug BuildConfig
kept `FIELDWORK_BIOMETRIC_BYPASS = false` and
`FIELDWORK_DEBUG_PAIRING_CODE = ""`, cleared app data/logcat, launched with
`Status: ok`, `LaunchState: COLD`, and `TotalTime=976ms`, and captured
`/tmp/fieldwork-adb-direct-20260521-locked-refresh/locked.png`,
`locked-ui.xml`, `logcat.log`, and an empty `crash.log`. The UI dump contained
`text="Unlock"`, the screenshot was 1080x2400, and targeted logcat scanning
found no Fieldwork `FATAL EXCEPTION` or ANR entries. This is debug-emulator
evidence only, not physical release-device evidence.

A 2026-05-22 follow-up direct adb locked-launch refresh started
`Medium_Phone_API_36.1`, installed the existing default debug APK, resolved
`app.fieldwork.android/.MainActivity`, and launched it with `Status: ok`,
`LaunchState: COLD`, and `TotalTime=4572ms`. Evidence under
`/tmp/fieldwork-adb-refresh-20260522` includes `locked.png`, `locked-ui.xml`,
`locked-logcat.log`, empty `locked-crash.log`, and `buildconfig.txt` proving
`APPLICATION_ID = "app.fieldwork.android"`, `BUILD_TYPE = "debug"`,
`DEBUG = Boolean.parseBoolean("true")`, `FIELDWORK_BIOMETRIC_BYPASS = false`,
and `FIELDWORK_DEBUG_PAIRING_CODE = ""`. The screenshot was 1080x2400, the
UI dump contained the locked `Unlock` surface, the app process remained focused,
and targeted logcat scanning found no Fieldwork `FATAL EXCEPTION` or ANR
entries. This is debug-emulator evidence only, not physical release-device
evidence.

A 2026-05-23 direct adb pre-unlock biometric refresh under
`/tmp/fieldwork-adb-direct-20260523120245` booted `Medium_Phone_API_36.1` as
`emulator-5554`, installed the current normal debug APK, verified
`FIELDWORK_BIOMETRIC_BYPASS = false` and
`FIELDWORK_DEBUG_PAIRING_CODE = ""`, cleared app data/logcat, launched
`app.fieldwork.android/.MainActivity` with `Status: ok`, `LaunchState: COLD`,
and `TotalTime=5888ms`, then captured locked and post-Unlock-tap screenshots,
UI dumps, logcat, and empty crash buffers. Both UI dumps still showed only the
`Unlock` surface; logcat showed `BiometricService` refusing authentication
because the emulator has no enrolled biometric and did not show Fieldwork
`listSessions`, `registerPushToken`, terminal attach, input, `FATAL EXCEPTION`,
or ANR entries. This is debug-emulator evidence only, not physical
BiometricPrompt or release-device evidence.

A 2026-05-23 direct adb locked-launch follow-up under
`/tmp/fieldwork-emulator-direct-20260523` installed the current normal debug APK
on `Medium_Phone_API_36.1`, resolved `app.fieldwork.android/.MainActivity`, and
launched it with `Status: ok`, `LaunchState: COLD`, `TotalTime=4388ms`, and
`WaitTime=4395ms`. Evidence includes `adb-devices.txt`, `buildconfig.txt`,
`install.txt`, `launch.txt`, `locked.png`, `locked-ui.xml`,
`locked-logcat.log`, and `locked-crash.log`; `buildconfig.txt` proves
`APPLICATION_ID = "app.fieldwork.android"`, `BUILD_TYPE = "debug"`,
`DEBUG = Boolean.parseBoolean("true")`, `FIELDWORK_BIOMETRIC_BYPASS = false`,
and `FIELDWORK_DEBUG_PAIRING_CODE = ""`. The screenshot was a 1080x2400 PNG
with SHA-256
`22d6a9638bcc5fc0edc0d771d9b4434844b2d372e0799c4630d828cd376f3e84`, and the
UI dump contained only the locked `Unlock` app surface. The crash buffer
contained an emulator system `com.google.android.bluetooth` crash, but targeted
scanning found no Fieldwork `FATAL EXCEPTION`, ANR, session sync, push-token
registration, terminal attach, or input before unlock. This is debug-emulator
evidence only, not physical release-device evidence.

A 2026-05-24 direct adb locked-launch refresh under
`/tmp/fieldwork-adb-direct-20260524172604` started `Medium_Phone_API_36.1` as
`emulator-5554`, installed the current normal debug APK, cleared app data and
logs, resolved `app.fieldwork.android/.MainActivity`, and launched it with
`Status: ok`, `LaunchState: COLD`, `TotalTime=1852ms`, `WaitTime=1854ms`, and
`wall_launch_ms=1905`. Evidence includes `adb-devices.txt`, `install.txt`,
`launch.txt`, `resolve-activity.txt`, `package-info.txt`, `buildconfig.txt`,
`locked.png`, `locked-ui.xml`, `logcat.log`, empty `crash.log`, and
`screenshot-check.txt`. `package-info.txt` shows `versionCode=1`,
`versionName=1.0`, and the expected debug-only `DEBUGGABLE` flag;
`buildconfig.txt` proves `APPLICATION_ID = "app.fieldwork.android"`,
`BUILD_TYPE = "debug"`, `DEBUG = Boolean.parseBoolean("true")`,
`FIELDWORK_BIOMETRIC_BYPASS = false`, and
`FIELDWORK_DEBUG_PAIRING_CODE = ""`. The screenshot was a 1080x2400 PNG with
`nonblack=14379/14400`, the UI dump contained only the locked `Unlock` surface,
and targeted logcat/crash-buffer scanning found no Fieldwork `FATAL EXCEPTION`
or ANR entries. This is debug-emulator evidence only, not physical release-device
evidence.

A later 2026-05-24 direct adb locked biometric fallback refresh under
`/tmp/fieldwork-direct-adb-20260524220022` started the same AVD, installed
`apps/android/app/build/outputs/apk/debug/app-debug.apk`, cleared logcat and
the crash buffer, and launched `app.fieldwork.android/.MainActivity` with
`Status: ok`, `LaunchState: COLD`, `TotalTime=2571ms`, and `WaitTime=2606ms`.
Evidence includes `install.txt`, `launch.txt`, `locked.png`, `locked-ui.xml`,
`logcat.log`, empty `crash.log`, `after-unlock-tap.png`,
`after-unlock-ui.xml`, `after-unlock-logcat.log`, and empty
`after-unlock-crash.log`. The locked and post-Unlock-tap UI dumps both
contained only `text="Unlock"`; post-tap logcat showed `BiometricService` for
`app.fieldwork.android` with `Status: 7` and `hasEnrollments: false`; and
targeted scans found no Fieldwork `FATAL EXCEPTION`, ANR,
`FieldworkRepository: listSessions`, `registerPushToken`, `Attached`, or
terminal-content exposure before unlock. This is debug-emulator evidence only,
not physical release-device biometric evidence.

A 2026-05-24 direct adb pair/input refresh under
`/tmp/fieldwork-adb-pair-20260524205522` used raw `adb` plus desktop CLI
approval, not wrapper smoke scripts, to exercise the current Android app against
an isolated daemon. The run created a desktop-owned `bash · fieldwork` session
with `ANDROID_DIRECT_PAIR_READY`, installed a debug-only biometric-bypass
pair-payload APK, launched `app.fieldwork.android/.MainActivity` with
`Status: ok` and `TotalTime=1554ms`, paired through the actual Android Pair UI
plus explicit desktop approval in `pair_flow_ms=525`, listed the session on the
dashboard, opened the terminal in `Attached` state, sent
`fw_android_direct_pair_ok` from Android, and verified
`android-direct: fw_android_direct_pair_ok` through a separately approved CLI
client. Evidence includes `dashboard.png`, `dashboard-ui.xml`,
`terminal-before-input.png`, `terminal-after-input.png`, `logcat.log`, empty
`crash.log`, `pair-buildconfig.txt`, `restored-buildconfig.txt`,
`restored-locked.png`, and `restored-locked-ui.xml`; the restored build proves
`FIELDWORK_BIOMETRIC_BYPASS = false` and
`FIELDWORK_DEBUG_PAIRING_CODE = ""`, and `adb devices -l` showed no attached
devices after emulator shutdown. This is debug-emulator evidence only, not
physical QR-camera, biometric, Play-signed release build, or release-device
runtime evidence.

A 2026-05-25 direct adb pair/input rerun under
`/tmp/fieldwork-adb-pair-20260524234442` first exposed a stale
`target/release/fieldwork` binary that lacked `fieldwork doctor`; rebuilding
the release CLI/daemon fixed the local CLI surface before the app flow
continued. The rerun proved `target/release/fieldwork doctor --no-start` with
socket hardening, created the desktop-owned `android_direct` bash PTY, paired
Android through the actual Pair UI plus explicit desktop approval in
`pair_flow_ms=841`, listed the desktop session, attached the terminal, sent
`fw_android_direct_manual_ok` from Android, and verified
`android-direct: fw_android_direct_manual_ok` through a separately approved CLI
client. Captured screenshots, UI dumps, logcat, empty crash buffers, and
restored default `FIELDWORK_BIOMETRIC_BYPASS = false` plus empty
`FIELDWORK_DEBUG_PAIRING_CODE = ""` proof remain debug-emulator substitute
evidence only; the stale release binary failure mode is now covered by
`pnpm check:live-testing-readiness:local`.

A later 2026-05-25 direct adb interactive-shell refresh under
`/tmp/fieldwork-adb-direct-20260525105201` and
`/tmp/fieldwork-adb-direct-pair-20260525105508` installed the default debug APK,
launched the locked app with `Status: ok` and `TotalTime=3117ms`, captured the
locked `Unlock` screenshot/UI/logcat plus an empty crash buffer, then installed
a debug-only biometric-bypass/pair-payload build and paired through the actual
Android Pair UI plus explicit desktop approval in `pair_flow_ms=549`. The
paired dashboard showed the desktop-created `directbash` interactive shell,
Android attached to it, sent `echo fw_android_direct_interactive_ok` through
direct `adb shell input text` plus Enter, and a separately approved
`fieldwork pair-test --attach directbash` verifier saw
`fw_android_direct_interactive_ok` in replayed PTY bytes. App logcat showed
`FieldworkRepository: listSessions returned 2 sessions`, no Fieldwork
`FATAL EXCEPTION` or ANR entries, and an empty crash buffer. The same pass
exposed that raw `uiautomator dump` can wedge during terminal capture, so the
Android terminal-attach evidence scaffold now captures screenshots first and
wraps UI dumps with `FIELDWORK_ANDROID_UI_DUMP_TIMEOUT_SECONDS`-bounded
direct-adb capture. This remains debug-emulator evidence only; physical
signed-release phone gates remain unchecked.

A 2026-05-30 local release APK install smoke converted the current release AAB
with `bundletool-all-1.18.3` into
`/tmp/fieldwork-android-release-install-20260530045350/apks/fieldwork-release-universal.apks`
and `universal.apk`, signed it with an ephemeral non-debug
`CN=Fieldwork Release Smoke` key, and verified APK Signature Scheme v3 with
`apksigner`. Static evidence includes `apksigner-universal.txt`,
`aapt-badging.txt`, `aapt-permissions.txt`, `aapt-manifest-tree.txt`, and
`sha256.txt`, showing `app.fieldwork.android`, `versionCode='1'`,
`versionName='1.0'`, expected permissions, and no `debuggable` marker. Direct
adb evidence under `/tmp/fieldwork-android-release-install-20260530045350`
installed that release `universal.apk`, launched
`app.fieldwork.android/.MainActivity` with `Status: ok`, `LaunchState: COLD`,
and retained passing launch attempt `TotalTime=1169ms` after recording
`launch-attempts.txt` for earlier cold-start variance, captured the locked
`Unlock` UI/screenshot, proved
`run-as: package not debuggable: app.fieldwork.android`, showed no
installed-package `DEBUGGABLE` flag, and captured an empty `crash.log`.
`scripts/verify-android-release-install-evidence.mjs` validates this captured
APKS/static metadata and direct-adb install/locked-launch evidence; its fixture
coverage now also exercises `--strict-release-device`, which rejects emulator
evidence and the local `Fieldwork Release Smoke` certificate for production
Android release evidence. The fixture coverage lives in
`scripts/test-android-release-install-evidence.mjs`, and
`scripts/create-android-release-install-evidence-dir.mjs` plus
`scripts/test-android-release-install-scaffold.mjs` make the bundletool,
ephemeral-signing, direct-`adb` install, locked-launch capture path repeatable
without fabricating verifier evidence. The local release gate runs both the
verifier fixture test and scaffold self-test.
This is local ephemeral-signing/emulator evidence only, not Play signing,
physical biometric, QR-camera, or physical release-device runtime evidence.

The Android pair smoke now also measures the debug-app Pair tap through explicit desktop approval completion and fails above the local 15-second emulator bound. The adb scripts pick the Pair action from the dumped UI tree by locating the `Pairing code` field and the first full-width enabled clickable control below it, because the current Compose tree exposes the Pair button itself without stable visible text. `node scripts/test-android-pair-button-picker.mjs` pins that accessibility-tree shape so the emulator smokes fail deterministically if the locator drifts. The hosted-relay typed-code emulator smokes set a deterministic test-only `FIELDWORK_RELAY_SIGNING_KEY_B64` in their isolated temp daemon environments, require an explicit relay control URL, and leave `FIELDWORK_ANDROID_IROH_RELAY_URL` unset unless the operator asks for an override, so local evidence does not depend on macOS Keychain access or a hardcoded public iroh relay. The UI wrapper dismisses only blocking emulator/system or unrelated-app ANR overlays while still failing on Fieldwork ANRs. Latest focused run passed on `emulator-5554` with `pair_flow_ms=2206`. This is app-side timing substitute evidence only; physical QR camera pair-flow timing still needs a release-device run.

`pnpm test:android-emulator-background-replay` is the focused local background/foreground substitute: it pairs the actual Android app, opens a desktop-created terminal, sends input before backgrounding, backgrounds the app while the PTY emits `ANDROID_BACKGROUND_REPLAY_OUTPUT`, foregrounds back to the attached terminal, sends `after_background_ok`, and uses a separately approved verifier client to confirm the background-emitted output and post-foreground input remain replayable. Latest local run on 2026-05-19 passed on `emulator-5554`.

`pnpm test:android-emulator-session-subscription` is the focused local Android dashboard subscription substitute: it pairs the actual Android app with no pre-existing sessions, waits for the empty dashboard, creates `fw_subscribe_session` from the desktop CLI, verifies the subscribed dashboard receives the new session within the local 8-second emulator bound, opens it, sends `subscription_attach_ok`, and confirms the desktop PTY receives that Android-originated input. The smoke now recovers Fieldwork foreground before UI dumps and falls back to file-backed `uiautomator` dumps when direct streaming hangs, so unrelated foreground apps on a shared emulator do not corrupt evidence. Latest focused run passed on `emulator-5554` with `visible_ms=2904`.

`pnpm test:android-emulator-restart-restore` is the focused local daemon-restart substitute: it pairs the actual Android app with an isolated release daemon, creates an intentionally completed `fw_restart_session`, waits for `ANDROID_RESTART_SCROLLBACK` to persist through the session-exit path, restarts the daemon with the same temp state and deterministic node identity, relaunches the app from saved pairing, verifies the restored dashboard still lists `fw_restart_session`, opens the restored terminal, and confirms `ANDROID_RESTART_SCROLLBACK` is replayed through a separately approved verifier. Latest local run on 2026-05-19 passed on `emulator-5554`. Direct adb restart-restore evidence on 2026-05-19 captured emulator screenshots, `uiautomator` dumps, `dumpsys window` focus, and logcat before and after the daemon restart. The first direct adb run exposed `ANR in app.fieldwork.android` after tapping refresh from a restored dashboard, and the patched run showed `fw_restart_session` before and after refresh, `FieldworkRepository: listSessions returned 1 sessions` in logcat, and no Fieldwork `FATAL EXCEPTION` or ANR. This is Android emulator substitute evidence; launchd/systemd restart policy, macOS sleep/wake, and physical-device app restore remain release gates.

The Android startup source response now obtains `FieldworkViewModel` from the lifecycle ViewModel store through an application-context factory. It keeps the encrypted pairing store lazy, restores saved pairing on `Dispatchers.IO`, and has focused FieldworkViewModel JVM coverage proving construction does not block on saved-pairing restore, stale startup-restore results cannot override an explicit pairing, repository-backed refresh work does not run on the main thread
(`refreshSessionsRunsRepositoryWorkOffMainThread`), terminal attach and lag
reattach work do not run on the main thread
(`terminalAttachAndLagReattachRunRepositoryWorkOffMainThread`).

Inspect daemon logs:

```sh
target/debug/fieldwork doctor
target/debug/fieldwork daemon status
target/debug/fieldwork daemon logs --tail 80
```

The daemon writes daily `daemon.log*` files and prunes only daemon log files older
than seven days when logging starts. The focused logging test covers expired,
fresh, exact-boundary, non-daemon, and directory entries.
Use `target/debug/fieldwork doctor --no-start` when you want a non-mutating
preflight that reports the existing daemon/socket state, including Unix-socket
parent/file hardening, without auto-starting `fieldworkd`.

User service lifecycle:

```sh
target/debug/fieldwork daemon install
target/debug/fieldwork daemon restart
target/debug/fieldwork daemon uninstall
```

The install path uses `service-manager` with a user-level LaunchAgent on macOS and a systemd user unit on Linux. It does not install a root/system daemon. Focused CLI tests now run the actual `service-manager` install rendering path with fake `launchctl`/`systemctl`: on macOS the generated LaunchAgent is checked for `KeepAlive` with `SuccessfulExit=false`, `LimitLoadToSessionType=Aqua`, and non-secret `EnvironmentVariables`, and on Linux the generated user unit is checked for `Restart=on-failure`, `RestartSec=5`, `WantedBy=default.target`, `Environment="PATH=..."`, and `Environment="XDG_RUNTIME_DIR=..."`. These are service-manager rendering tests for LaunchAgent `KeepAlive`/`EnvironmentVariables` and systemd `Restart=on-failure`/`Environment="PATH=..."`. `install` and `restart` now wait for a successful local protocol handshake before reporting success; a fresh install automatically uninstalls itself if the service fails to start or starts but never reaches the control socket.

`pnpm test:macos-daemon-launchd` is the local launchd restart smoke for the
zero-dollar npm path. It packs and installs the staged host Darwin platform
package plus the unscoped `fieldwork` meta package into a clean temp project,
verifies npm trust, installs the installed `fieldworkd` as a temporary user
LaunchAgent, proves `fw doctor --no-start` and the daemon agree on a temp
`XDG_RUNTIME_DIR` control socket, kills the test `fieldworkd`, verifies launchd
restores socket reachability within 10 seconds, confirms the restored session
list remains available, verifies restored scrollback replay from a temp project
directory outside macOS Desktop/Documents TCC-protected locations, then
uninstalls the service. The LaunchAgent plist is generated with
`LimitLoadToSessionType=Aqua`, and `fieldworkd` reserves stdio with `/dev/null`
before opening PTYs so launchd cannot hand `openpty()` a standard fd. It uses a
launchd-session-only deterministic iroh key so the smoke does not trigger an
interactive Keychain prompt, and it verifies that key is not written to the
LaunchAgent plist. Full Section 13 survival evidence still needs a retained
npm-installed/ad-hoc-signed Darwin artifact or an actual Linux user-service host,
plus the explicit sleep/wake and restored-scrollback transcripts.
Latest local smoke on 2026-05-30 retained `/tmp/fwld.j1RYYW/evidence`: npm trust
and `fw doctor --no-start` passed for the temp npm install, launchd restored the
daemon socket after `pkill -KILL fieldworkd` in `restart_ms=388`, the restored
session list was available, `kill-live-replay.txt` and `kill-replay.txt` both
contained `MACOS_KILL_SCROLLBACK_BEFORE`, the restored attach reported
`[fieldwork: session exited 0]`, and the daemon log had no crash markers. The
formal survival verifier still fails for that evidence because `sleep-wake.txt`
and `sleep-replay.txt` were not captured, so the sleep/wake gate remains open.

Daemon and mobile crash-reporting SDKs are not bundled in v1. The user-facing diagnostics preference writes the daemon config file:

```sh
target/debug/fieldwork settings telemetry status
target/debug/fieldwork settings telemetry on
target/debug/fieldwork daemon restart
target/debug/fieldwork settings telemetry off
target/debug/fieldwork daemon restart
```

The config file is `~/Library/Application Support/app.fieldwork/config.toml` on macOS and `$XDG_CONFIG_HOME/fieldwork/config.toml` or `~/.config/fieldwork/config.toml` on Linux. The daemon reads it on startup. `pnpm check:telemetry-privacy` rejects accidental daemon OTLP/Honeycomb wiring and mobile crash SDK wiring. Daemon OTLP/Honeycomb export is intentionally absent from v1; do not add it without first updating the v1 boundary and telemetry privacy verifier.

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
printf '{"type":"turn_started"}\n{"type":"approval_requested"}\n' | target/debug/fieldwork hook codex-event --session <codex-session-id>
```

Claude Code Stop hook wiring uses the injected `FIELDWORK_SESSION_ID`. A project or user Claude settings hook can run:

```sh
fieldwork hook claude-stop --session "$FIELDWORK_SESSION_ID"
```

Codex `codex-cli 0.133.0` currently exposes `codex remote-control start`, `codex app-server --listen/proxy`, and `codex app-server daemon {start,enable-remote-control,...}` locally, but not a `codex --remote-control` flag or the older `codex app-server daemon --remote-control` form in the original plan. Fieldwork therefore keeps the `codex` PTY command unchanged and ingests structured Codex JSON or JSONL event streams through `fieldwork hook codex-event`.

State inference fixture tests:

```sh
cargo test -p fieldwork-daemon state_infer
cargo test -p fieldwork-daemon local_agent_hook
cargo test -p fieldwork-cli codex
```

The committed fixtures under `crates/daemon/tests/fixtures/` are redacted before
commit. They exercise Claude approval/permission prompts, reject generic
question-mark false positives, and cover Codex `type`/`event`/`status` JSON
event shapes including `Crashed`. CLI tests verify that `fieldwork hook
codex-event` accepts both single JSON objects and JSONL event streams while
ignoring unrelated Codex stream events. The focused daemon local-agent-hook tests
verify that matching LocalCli Claude/Codex hook events update only matching PTY
sessions and that mismatched hook sources are rejected with an IPC error. The
CLI hook adapter waits for the daemon acknowledgement, so a missing session or
mismatched agent source exits nonzero instead of silently dropping the hook.

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

Current local blocker for the full Week 7 phone push demo: this shell has no APNs `.p8`, Apple/Play push entitlements, or physical phones attached. Firebase project `fieldwork-oss` and the Android app config are provisioned, and the AWS live-test bridge has the relay-only FCM service-account JSON installed for Android/FCM provider testing. The closest local substitute is `cargo test --workspace`, which exercises the relay gateway and daemon dispatch path without contacting Apple or Google.

Relay deployment scaffold:

```sh
infra/oracle/provision-region.sh infra/oracle/terraform/mumbai.tfvars
ansible-playbook \
  -i infra/relay/ansible/inventory.ini \
  infra/relay/ansible/playbook.yml \
  -e fieldwork_relay_binary=/path/to/fieldwork-relay
```

`infra/oracle/terraform` provisions the credential-free Oracle ARM A1 host and network scaffold: VCN, public subnet, internet gateway, route table, security list, IMDSv1-disabled `VM.Standard.A1.Flex` instance, and an Ansible inventory output. Terraform state and tfvars are ignored by git; provider credentials come only from the operator's local OCI config or environment. The committed `.terraform.lock.hcl` pins signed OCI provider checksums while generated `.terraform/` caches stay ignored. `availability_domain` and `fault_domain` can be set explicitly for scarce-capacity placement; leaving them empty preserves the default AD lookup and OCI-selected fault domain. `infra/oracle/provision-region.sh` wraps `terraform init` and `terraform apply` with retry controls for scarce Always Free A1 capacity. `infra/oracle/watch-a1-capacity.sh` is the tighter Oracle-only watcher: it polls Oracle's compute-capacity-report API for all three fault domains at the configured interval, runs Terraform only after a fault domain reports `AVAILABLE`, passes that domain through `fault_domain`, and keeps watching when a launch races capacity and fails with another capacity error. `infra/relay/ansible/group_vars/all/main.yml` is the deployment contract for the current scaffold. `fieldwork_relay_data_dir` is created as `0700` for the `fieldwork-relay` user. `fieldwork_relay_db_path` becomes `FIELDWORK_RELAY_DB_PATH` in `fieldwork-control-plane.service` and defaults to `/var/lib/fieldwork/relay.db`; push-token ownership rows in that database are refreshed on accepted push dispatch and pruned after 90 days with no use. `fieldwork_relay_metrics_addr` becomes `FIELDWORK_RELAY_METRICS_ADDR` and defaults to `127.0.0.1:9090`; set it to `off` only for local/non-production smoke tests. `fieldwork_relay_control_addr` becomes `FIELDWORK_RELAY_ADDR`, and production control-plane TLS is required by `FIELDWORK_RELAY_REQUIRE_TLS=true` with `control-plane.crt`/`control-plane.key` supplied through systemd credentials. `scripts/smoke-relay-tls-loopback.sh` uses the same relay-binary resolution as the OTLP smoke, starts the control plane with a throwaway self-signed cert/key, and verifies `/healthz` over HTTPS. `fieldwork_relay_otlp_endpoint`, `fieldwork_relay_otlp_sample_rate`, and `fieldwork_relay_honeycomb_dataset` become the relay OTLP environment. Control-plane TLS, APNs, FCM, and Honeycomb paths are passed through systemd `LoadCredential` from `fieldwork_relay_control_tls_cert`, `fieldwork_relay_control_tls_key`, `fieldwork_relay_apns_credential`, `fieldwork_relay_fcm_credential`, and `fieldwork_relay_honeycomb_credential`; those credential files are relay-only secrets and are not copied by the playbook. `fieldwork_relay_fcm_endpoint` becomes `FIELDWORK_FCM_ENDPOINT` and normally stays at `https://fcm.googleapis.com`. `deploy-relay.yml` now fails closed before artifact download when `RELAY_SSH_KEY` is absent or the inventory has no relay hosts, then downloads the `linux-arm64` release archive plus its SHA-256 and cosign bundle, verifies the archive checksum plus DSSE/SLSA bundle digest, runs cosign blob-attestation verification against the GitHub OIDC issuer and release-rust workflow identity, checks that `fieldwork-relay` is executable after extraction, writes the relay SSH key with `0600`, removes it in an `always()` cleanup step, and refuses to run Ansible against the placeholder inventory.

APNs delivery activates only when the relay host provides `apns.p8` through systemd `LoadCredential` or `FIELDWORK_APNS_P8_PATH`, plus `FIELDWORK_APNS_TEAM_ID`, `FIELDWORK_APNS_KEY_ID`, and `FIELDWORK_APNS_TOPIC`. The relay signs an ES256 APNs provider JWT from that relay-only key, caches it for 50 minutes, and sends only fixed-copy alert text plus opaque session hashes through a persistent provider client with 60-second HTTP/2 keepalive pings. The provider client is built during relay state initialization; the network connection is established lazily on first APNs dispatch and then reused. APNs `BadDeviceToken` responses remove the relay token binding from memory and SQLite before the relay reports a provider error to the daemon. Local tests cover JWT caching, payload privacy, mock delivery, provider-client connection reuse, and BadDeviceToken stale-token pruning without contacting Apple.

FCM delivery activates only when the relay host provides `fcm-service-account.json` through systemd `LoadCredential` or `FIELDWORK_FCM_SERVICE_ACCOUNT_PATH`. The relay signs an RS256 Google service-account JWT, exchanges it for a cached OAuth token, sends the fixed-copy notification plus hash-only data payload through FCM HTTP v1, and prunes FCM `UNREGISTERED` tokens as stale bindings. Local tests cover JWT claims, token caching, mock HTTP delivery, payload privacy, and the `UNREGISTERED` stale-token parser without contacting Google.

Run `node scripts/verify-secret-boundaries.mjs` before release changes that touch push, mobile, packaging, telemetry, or deploy files. It enforces that APNs `.p8`, Firebase service-account, and Honeycomb API-key wiring stays out of daemon, CLI, mobile, app, and npm package code, while requiring the relay and relay systemd unit to keep the provider/telemetry credential hooks. It rejects committed `.npmrc` files, npm token strings, and npm auth-token environment or config assignments. When built non-relay artifacts are present under `target/`, `dist/`, or `packages/`, it also scans the `fieldwork`, `fieldworkd`, and `fieldwork_mobile_core` binaries for those relay-only credential strings and npm auth-token patterns.

Run `pnpm check:release-workflows` before editing release or deploy workflows. It verifies the local CI release contracts: Darwin desktop artifacts build without Apple credentials, use `codesign --force --sign -` on `fieldwork` and `fieldworkd`, run the macOS npm trust verifier before archive staging, and produce cosign/SLSA bundles; npm publish fails closed before artifact work when `NPM_TOKEN` is absent and verifies cosign attestations before provenance publishing; CI's Terraform Validate job installs Terraform 1.5.7 and runs the shared `scripts/check-infra-terraform.sh` path, exposed locally as `pnpm check:infra-terraform`; it performs Terraform fmt/init/validate, uses `TF_PLUGIN_CACHE_DIR` outside the generated working directory so repeat runs can reuse provider downloads, and removes generated `.terraform/` caches on exit, iOS release uses Xcode/iOS SDK 26+ with manual Apple Distribution signing and production APNs entitlement checks, keeps App Store Connect upload JSON outside the repository workspace and cleans signing/upload assets, the Xcode project honors `FIELDWORK_SKIP_RUST_BUILD` before running `apps/ios/scripts/build-rust.sh`, iOS/Android releases run the mobile and store privacy verifiers, Android release preflights Firebase/signing/Play secrets before toolchain setup and mobile build, verifies the signed AAB, and removes generated Firebase/signing files in an `always()` cleanup step, and relay deploy fails closed on SSH-key/inventory prerequisites before artifact download, verifies the signed linux-arm64 release artifact before Ansible runs, and cleans the decoded relay SSH key. Run `pnpm check:release-audit` before editing `docs/RELEASE_AUDIT.md`, Section 13 gate wording, or Appendix B external reservations; it keeps the prompt-to-artifact checklist, current blockers, latest verification commands, and incomplete-gate sign-off rule explicit. Run `pnpm check:infra-scaffold` after editing `infra/oracle` or `infra/relay`; when Terraform is installed, also run `pnpm check:infra-terraform`.

`scripts/verify-macos-signing-evidence.mjs` is the offline macOS npm trust
evidence contract: it requires installed unscoped npm package identity,
per-Darwin-package checksum or npm integrity verification plus npm/Sigstore
provenance verification for `fieldwork-darwin-arm64` and
`fieldwork-darwin-x64`, `verify-macos-signing`,
`codesign --display --verbose=4`, and
`xattr -p com.apple.quarantine` output for both `darwin-arm64` and
`darwin-x64` CLI and daemon artifacts. It requires an ad-hoc or Developer ID
signature and absence of `com.apple.quarantine` while rejecting raw Apple
credentials, npm/GitHub tokens, legacy scoped `@fieldwork/*` package names, and
terminal content. Sanitized `release-rust.yml` workflow evidence remains in the
separate release-artifacts evidence gate, not this desktop npm trust gate.
`pnpm scaffold:macos-signing-evidence -- --print-dir` creates the capture
directory and macOS-only preflight without signing binaries or running GitHub
workflows; the preflight can either copy `FIELDWORK_PACKAGE_IDENTITY_FILE` and
`FIELDWORK_RELEASE_INTEGRITY_FILE` from operator-captured evidence or derive
package identity from the installed `fieldwork` package and run
`scripts/verify-release-artifacts.mjs` with `FIELDWORK_VERIFY_COSIGN_SIGNATURE=1`
and `FIELDWORK_RELEASE_PLATFORMS=darwin-arm64,darwin-x64`.
The desktop npm path does not require Developer ID notarization.
Gatekeeper notarization is optional/deferred for desktop npm and is not required
for the v1 npm CLI/daemon live-test path. `pnpm test:macos-signing-evidence` and
`pnpm test:macos-signing-scaffold` keep the evidence guard wired into
`pnpm check:local-release`.

Run `pnpm check:daemon-service` before editing daemon service installation, IPC health checks, or the local handoff smoke. It verifies the CLI still installs only user-level launchd/systemd services, uses a colocated regular executable `fieldworkd`, keeps the macOS Gatekeeper preflight before launchd install, persists only non-secret service environment such as `PATH`, `HOME`, `XDG_RUNTIME_DIR`, XDG config/state paths, and Fieldwork runtime flags, keeps key material out of service files, keeps `RestartPolicy::OnFailure`, keeps the fake-command service-manager rendering tests for LaunchAgent `KeepAlive`/`SuccessfulExit=false`/`LimitLoadToSessionType=Aqua`/`EnvironmentVariables` and systemd `Restart=on-failure`/`Environment="PATH=..."` plus `Environment="XDG_RUNTIME_DIR=..."`, verifies `fieldworkd` reserves stdio before PTY creation under launchd, waits for a real `CONTRACT_VERSION` handshake after install/restart, uninstalls a broken fresh service when start fails or the health check fails, and keeps the local restart-restore smoke markers. This is static/source coverage; Section 13 still requires rerunning the real launchd/systemd survival gate against an npm-trust-prepared macOS artifact or an actual Linux user-service host.

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

`packages/cli` is the `fieldwork` meta package. It exposes `fieldwork`, the short `fw` alias that points at the same CLI dispatcher, and `fieldworkd`; all five publishable npm manifests are set to `1.0.0`, and the meta package pins the four platform optional dependencies to the same version. `fw` with no subcommand uses the same no-args fast path as `fieldwork` and always creates an auto-named default `claude` session before attaching, `fw pair` starts the same QR-pairing flow as `fieldwork pair`, and `fw <name>` is the named-session fast path after npm install; the npm dispatcher test covers no-args, pair, named-session, and `fw completion bash` alias shapes against the platform-package fallback path. When postinstall is skipped, the CLI dispatcher (`fieldwork`/`fw`) forwards the invoked alias through `FIELDWORK_CLI_BIN_NAME` and `argv0` before falling back to the matching platform package, so native help and completion generation still follow `fw` versus `fieldwork`; `fw --help` renders `Usage: fw`, and the daemon dispatcher falls back to the matching platform package too. The four platform packages under `packages/cli-*` receive `fieldwork` and `fieldworkd` from `scripts/prepare-npm-artifacts.mjs` after release artifacts are downloaded; the preparation script requires a platform/target-matching extracted artifact directory for each package and fails on a missing platform root instead of falling back to another platform's binaries. The generated native `packages/cli-*/bin/fieldwork` and `packages/cli-*/bin/fieldworkd` outputs are release artifacts, not source files, so `.gitignore` keeps them out of git, `node scripts/verify-npm-packages.mjs` rejects tracked generated native bins, and `node scripts/verify-npm-packages.mjs --require-binaries` still verifies them when they are present. The same preparation step copies root `LICENSE` and `NOTICE` into all five npm package directories so binary packages carry the AGPL text and App Store distribution notice. The unscoped `fieldwork` meta package is operator-owned; `node scripts/verify-npm-registry-state.mjs` is not a name-availability task for the meta package. The registry-state checker fails closed when run without explicit release-state expectation flags. Use the live registry checker only for release-state verification after operator-controlled platform child publishes: `--expect-platform-published` for the post-placeholder or post-release package family, and `--expect-latest-version=1.0.0 --expect-provenance` after v1 release. `node scripts/test-npm-registry-state.mjs` uses a deterministic local registry fixture for current, post-placeholder, post-release, version-drift, missing-provenance, and bare-invocation failure states; the bare-invocation case also asserts the checker exits before any registry request, so it cannot act as a name-availability probe. `node scripts/test-external-status-refresh.mjs` verifies domain/GitHub status refresh scripts fail closed before network access unless `--operator-refresh` is present. `node scripts/verify-changesets-config.mjs` expands the Changesets fixed group against the actual workspace package names and verifies exactly those five packages stay in lockstep. `version-packages.yml` runs that verifier and then `changesets/action@v1` with pinned `pnpm dlx` Changesets packages so it can open version PRs without creating a mutable root install. Automatic npm publishes triggered by `release-rust.yml` download artifacts from the completed workflow run id; manual `release-npm.yml` dispatch downloads from the requested GitHub Release tag. `pnpm check:release-artifacts` requires `artifacts/` or `FIELDWORK_ARTIFACT_DIR` to contain release-rust/GitHub Release archives, `.sha256` files, and `.bundle` attestations, then verifies that each platform archive has a matching SHA-256 file plus a Sigstore DSSE/SLSA bundle whose Sigstore media type, transparency-log entries, DSSE envelope/signatures, in-toto payload, SLSA provenance v1 `predicateType`, subject name, subject digest, official-repository `buildType`, package, target, release tag, and SHA-256 external parameters match the archive and requested release tag before any extraction. It intentionally fails closed when those real artifacts are absent; `pnpm test:release-artifacts` is the deterministic local substitute for verifier coverage. `node scripts/test-release-artifacts.mjs` covers that verifier with synthetic valid artifacts plus checksum filename, tampered digest, subject-name, predicate-type, predicate `_type`, Sigstore media type, transparency-log, DSSE envelope/signature, invalid payload, missing external-parameters, release-tag, external SHA, package, target, and buildType cases. In release publish/deploy workflows, the same verifier runs with `FIELDWORK_VERIFY_COSIGN_SIGNATURE=1`, `FIELDWORK_RELEASE_REPOSITORY=${{ github.repository }}`, and `FIELDWORK_EXPECTED_RELEASE_TAG` for manual artifact consumers, so `cosign verify-blob-attestation` also checks the bundle signature, GitHub OIDC issuer, release-rust workflow identity, and `slsaprovenance1` type. `scripts/verify-release-artifacts-evidence.mjs` is the offline release-rust evidence contract: it requires sanitized `release-rust.yml` workflow success evidence, GitHub Release asset metadata for all twelve archive/checksum/bundle files, downloaded artifact digests, and cosign-backed `pnpm check:release-artifacts` output with `FIELDWORK_VERIFY_COSIGN_SIGNATURE=1`. `pnpm scaffold:release-artifacts-evidence -- --print-dir` creates the capture directory and preflight without creating release artifacts or running GitHub workflows; `pnpm test:release-artifacts-evidence` and `pnpm test:release-artifacts-scaffold` keep the release-artifact evidence guard wired into `pnpm check:local-release`. `node scripts/test-npm-artifact-pack.mjs` uses synthetic extracted artifacts to verify the package preparation path, missing platform-root rejection, native package dry-runs, legal-file staging, executable `fieldwork`/`fieldworkd` entries, explicit children-first publish order, and both `--check-ready` and actual publish-path rejection when platform children contain non-native files instead of Mach-O or ELF binaries. `node scripts/test-npm-publish-plan.mjs` verifies the real publish command plan without an npm token: a missing token fails before npm is invoked, and the plan remains four platform packages first, meta package last, `--provenance`, and public access. `scripts/verify-npm-release-evidence.mjs` is the offline post-publish npm release evidence contract: it requires the deterministic publish plan, local publish-readiness output, sanitized `release-npm.yml` workflow evidence, children-first npm publish logs, public registry-state/provenance output, and package metadata for exactly the five unscoped `1.0.0` packages. It rejects legacy scoped `@fieldwork/*` package names and extra unscoped Fieldwork package names in captured logs and metadata so release evidence cannot mix the old scoped package model or out-of-scope v1 packages with the v1 unscoped publish. `pnpm scaffold:npm-release-evidence -- --print-dir` creates the capture directory and preflight without publishing packages or querying package-name availability; `pnpm test:npm-release-evidence` and `pnpm test:npm-release-scaffold` keep the privacy and scaffold guards wired into `pnpm check:local-release`. `node scripts/test-bun-install.mjs` smoke-tests Bun's platform optional-dependency selection against pinned `esbuild@0.25.12` registry packages, matching Fieldwork's meta-package plus platform-child publish pattern while Fieldwork platform packages are still unpublished. `release-npm.yml` now fails closed before artifact downloads when `NPM_TOKEN` is absent; with the token present it verifies release artifacts, prepares platform binaries and legal files, verifies real binaries with `node scripts/verify-npm-packages.mjs --require-binaries`, publishes the same plan to npm through `node scripts/publish-npm-packages.mjs`, then retries the public registry with `node scripts/verify-npm-registry-state.mjs --expect-meta-published --expect-platform-published --expect-latest-version="$version" --expect-provenance`.

On Darwin, `packages/cli/install.js` now performs the zero-dollar npm trust prep
after the postinstall binary swap: it runs `codesign --force --sign -` for the
copied `fieldwork` and `fieldworkd` files and removes
`com.apple.quarantine` only from those two paths. `fieldwork doctor` reports the
resulting trust mode as `npm/ad-hoc/not-notarized` when both colocated binaries
are executable, ad-hoc signed, and not quarantined; Developer ID notarized
artifacts remain optional additive evidence.

`pnpm build:local-npm-artifacts` applies the same Darwin trust prep to staged
local platform-package binaries before package readiness checks: after copying
`packages/cli-darwin-arm64/bin/*` and `packages/cli-darwin-x64/bin/*`, it
ad-hoc signs both `fieldwork` and `fieldworkd`, removes quarantine only from
those staged files, and runs `scripts/verify-macos-signing.mjs` on each Darwin
package `bin` directory.

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

Current local blockers for full release verification: npm provenance publish still needs the real `1.0.0` release run even though `NPM_TOKEN` and placeholder platform package publishes are in place; GitHub org/repo creation is complete; domain ownership, DNS control, and social-handle reservation are operator-owned external gates, and `node scripts/check-domain-status.mjs --operator-refresh --require-registered --require-dns` is reserved for explicit operator-requested status refreshes; Oracle account access is unblocked and the relay compartment/network plus `RELAY_SSH_KEY` are prepared, but production relay deploy still requires a successful ARM A1 instance launch and Ansible inventory; the latest Mumbai capacity report returns `OUT_OF_HOST_CAPACITY` for `VM.Standard.A1.Flex` across all three fault domains, and attempting to subscribe `ap-hyderabad-1` returned `TenantCapacityExceeded` because this tenancy is limited to one subscribed region; an AWS Lightsail `relay` live-test bridge is running at `http://3.7.208.153:8443` with a $10/month Lightsail budget, FCM service-account JSON installed for Android provider testing, and the 2026-05-29 hosted rendezvous smoke passed code publish, relay resolve, desktop approval, simulated-phone attach, and PTY input/output through that bridge, but it is not production HTTPS/APNs/Honeycomb/provider-delivery/fallback evidence; TestFlight upload requires `IOS_DISTRIBUTION_CERTIFICATE_BASE64`, `IOS_DISTRIBUTION_CERTIFICATE_PASSWORD`, `IOS_PROVISIONING_PROFILE_BASE64`, `IOS_DEVELOPMENT_TEAM`, `IOS_EXPORT_OPTIONS_PLIST`, and an `APP_STORE_KEY_JSON` containing `key_id`, `issuer_id`, and `private_key`; Play upload requires the Android release keystore and Play service-account secrets.
