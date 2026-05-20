# Fieldwork v1 Release Audit

Last updated: 2026-05-20

This file is the current prompt-to-artifact audit for the v1 objective in
`PLAN.md`, with `FUTURE.md` as the boundary for deferred work. It is not a
release sign-off: several required production gates still need credentials,
hosted infrastructure, or physical devices.

## Current Verdict

Fieldwork v1 is locally implemented and locally verified for the desktop daemon,
CLI, protocol, relay control plane, npm package scaffold, mobile-core, native
mobile source, Android debug/release artifact build, and static site.

Fieldwork v1 is not yet releasable because the following gates are still blocked
outside this shell:

- Downloaded release-rust/GitHub Release archives, `.sha256` files, and
  `.bundle` attestations are required for `pnpm check:release-artifacts`; a
  local run without `artifacts/` or `FIELDWORK_ARTIFACT_DIR` fails closed as
  expected. `pnpm test:release-artifacts` remains the deterministic local
  verifier substitute until real release artifacts are available.
- npm platform child package publish rights and a release-scoped `NPM_TOKEN`.
  The unscoped `fieldwork` meta package is operator-owned, so no further npm
  name-availability checks are needed for it. The remaining npm gate is
  operator-controlled placeholder publishes or release publishes for the four
  platform children, followed by `--expect-platform-published` and
  `--expect-latest-version=1.0.0 --expect-provenance` registry-state checks for
  post-publish dist-tag and npm SLSA provenance verification.
- macOS signing and notarization credentials for release artifacts.
- Full local Xcode installation for iOS development builds, plus Apple
  Distribution, provisioning, App Store Connect API keys, and TestFlight/App
  Store account access for release builds.
- Android release keystore, Firebase `google-services.json`, and Play Console
  account access.
- APNs `.p8`, FCM service-account JSON, and physical iOS/Android devices for
  provider push verification.
- Honeycomb account/API key for hosted trace receipt verification.
- Oracle ARM relay hosts, DNS/domain ownership, SSH secrets, and Cloudflare
  Pages credentials for production deploys. The domain status script is reserved
  for an explicit operator-requested refresh; it is not an ownership check or a
  routine agent gate.
- Appendix B reservations that require account ownership or user action:
  GitHub org/repo creation, `@fieldworkdev` social handle reservation, and the
  calendar/time block for the launch plan. GitHub namespace checks are reserved
  for explicit operator-requested status refreshes; they are availability
  signals rather than reservations.
- Physical-device checks for biometric gating, QR scan timing, mobile cold
  start, terminal flood rendering, foreground/background reconnect, network
  change reconnect, notification taps, and 30-minute Android terminal dogfood.
- Real macOS launchd and sleep/wake survival checks for `fieldworkd` after the
  daemon is signed/notarized; local restart-restore smoke is not a substitute
  for the `pkill` service-restart or lid-close sleep/wake gates.
- Local completion-audit guard: `scripts/verify-release-audit.mjs` classifies
  every unchecked `PLAN.md` gate by blocker class (`ios-xcode`, `signing`,
  `publish`, `provider`, `physical-device`, `store-console`, or `operator`).
  Any new unchecked gate that is not added to that classified allowlist fails the
  audit instead of silently becoming release debt.
- Current unchecked `PLAN.md` gate inventory: 37 total (`ios-xcode`: 1,
  `signing`: 4, `publish`: 3, `provider`: 5, `physical-device`: 13,
  `store-console`: 2, `operator`: 9). The release-audit verifier recomputes
  this inventory from `PLAN.md` so count drift fails locally.
  `node scripts/verify-release-audit.mjs --list-unchecked` prints the same
  classified gate list for operator handoff, and `pnpm test:release-audit-list`
  pins the grouped list output.
- A local API 36.1 Android emulator is only a debug substitute for those
  runtime/performance gates, not release-device evidence. `pnpm test:android-emulator`
  is now the aggregate direct-adb substitute suite for the locked debug launch, pair,
  session-subscription, background-replay, restart-restore, flood,
  multisession, reconnect, and notification-tap smokes. Its `--list` mode
  prints the underlying adb scripts without requiring a device, and normal runs
  retry only a locked debug-launch timing outlier once with the same strict
  limit; every other script failure fails closed and preserves the captured
  wrapper output path. The aggregate fails closed unless exactly one
  boot-complete adb device is available or `FIELDWORK_ANDROID_SERIAL` selects
  one. The latest default aggregate run on 2026-05-19 passed on `emulator-5554`
  without the relaxed launch env: locked debug launch `TotalTime=7920ms`, pair
  `pair_flow_ms=2234`, session subscription `visible_ms=3318`, flood screenshot
  8440/14400 nonblack samples, and successful background replay, restart
  restore, multisession, reconnect, and notification tap routing. After wiping the
  unstable Play Store AVD data, `pnpm test:android-debug-smoke` installed the
  debug app, launched `app.fieldwork.android/.MainActivity` with `am start -W`
  `TotalTime=2467ms`, confirmed the locked `Unlock` surface through
  `uiautomator`, found no Fieldwork crash-buffer entry, and verified a nonblank
  1080x2400 `screencap` with 14391/14400 nonblack samples.
  `FIELDWORK_ANDROID_BIOMETRIC_BYPASS=true pnpm test:android-debug-smoke`
  exists only for debug emulator QA on AVDs without enrolled biometrics; the
  bypass is debug-build-only, requires `BuildConfig.DEBUG`, and release builds
  hardcode it off. `pnpm test:android-emulator-background-replay` backgrounds an
  attached terminal while the PTY emits `ANDROID_BACKGROUND_REPLAY_OUTPUT`,
  foregrounds back to `Attached`, sends `after_background_ok`, and confirms the
  background output plus post-foreground input through a separately approved
  verifier; latest local run on 2026-05-19 passed on `emulator-5554`.
  `pnpm test:android-emulator-flood` renders a
  `yes | head -10000`-scale stream in the actual Android terminal view, checks a
  flood screenshot nonblank, and confirms `ANDROID_EMULATOR_FLOOD` output through a
  separately approved replay verifier; latest default aggregate run reported
  8440/14400 nonblack screenshot samples.
  `pnpm test:android-emulator-multisession` opens
  three desktop-created sessions (`fwm_a`, `fwm_b`, `fwm_c`), switches among all
  three in the app, sends Android-originated input to each, and verifies
  host-side per-session logs so `multi_a_ok`, `multi_b_ok`, and `multi_c_ok`
  land only in their selected PTYs; latest local run on 2026-05-19 passed on
  `emulator-5554`.
  `pnpm test:android-emulator-session-subscription` pairs with no pre-existing
  sessions, observes the empty dashboard, creates `fw_subscribe_session` from
  the desktop CLI, verifies the subscribed dashboard receives it within the
  local 8-second emulator bound, opens it, sends `subscription_attach_ok`, and
  confirms the PTY receives that Android-originated input; latest default
  aggregate run passed on `emulator-5554` with `visible_ms=3318`.
  `pnpm test:android-emulator-restart-restore` pairs the debug app with an
  isolated release daemon, creates an intentionally completed
  `fw_restart_session`, persists `ANDROID_RESTART_SCROLLBACK` through the
  session-exit path, restarts the daemon with the same temp state and
  deterministic node identity, relaunches from saved pairing, and verifies the
  restored dashboard and replayed scrollback through a separately approved
  verifier; latest local run on 2026-05-19 passed on `emulator-5554`. Direct adb restart-restore evidence on 2026-05-19 captured emulator screenshots,
  `uiautomator` dumps, `dumpsys window` focus, and logcat. That
  direct run exposed `ANR in app.fieldwork.android` when refresh listed sessions
  on the main thread; after moving `FieldworkViewModel` repository calls to
  `Dispatchers.IO`, screenshots showed `fw_restart_session` before and after
  refresh, logcat showed `FieldworkRepository: listSessions returned 1
  sessions`, and no Fieldwork `FATAL EXCEPTION` or ANR remained.
  A separate direct adb pair/attach pass on 2026-05-19 installed the debug APK,
  launched `app.fieldwork.android/.MainActivity` with `am start -W`
  `TotalTime=861ms`, paired against an isolated release daemon through explicit
  desktop approval, verified the dashboard showed `bash · fieldwork` with
  `ANDROID_ADB_DIRECT_READY`, attached the terminal, sent
  `android_adb_direct_input` from the emulator keyboard, and captured a terminal
  screenshot showing the PTY response `android-adb-direct:
  android_adb_direct_input`; the app logcat showed `FieldworkRepository: pair
  completed` and `listSessions returned 1 sessions`, with an empty Fieldwork
  crash buffer. A later manual adb rerun on the same date restored the debug
  build output to default after test-only payload injection, confirmed
  `FIELDWORK_BIOMETRIC_BYPASS = false` and
  `FIELDWORK_DEBUG_PAIRING_PAYLOAD = ""`, launched in `TotalTime=1082ms`,
  paired through explicit desktop approval, listed `bash · fieldwork`, attached
  the terminal, and showed `echo android_adb_direct_input` plus the matching
  PTY output in the Android terminal screenshot. The latest direct adb pair
  refresh installed the default debug APK, launched the locked app in
  `TotalTime=5297ms`, captured
  `/tmp/fieldwork-adb-direct-20260519225027/default.png`,
  `/tmp/fieldwork-adb-direct-20260519225027/default-ui.xml`,
  `/tmp/fieldwork-adb-direct-20260519225027/default-logcat.log`, and an empty
  `/tmp/fieldwork-adb-direct-20260519225027/default-crash.log`, then rebuilt a
  debug-only `FIELDWORK_ANDROID_BIOMETRIC_BYPASS=true` APK with debug-only
  `FIELDWORK_ANDROID_PAIRING_PAYLOAD` injection. The pair build launched in
  `TotalTime=4589ms`, used the UI-tree-derived Pair tap center `540 1860`,
  paired through explicit desktop approval in `pair_flow_ms=1043`, showed
  `bash · fieldwork` plus `ANDROID_ADB_DIRECT_READY`, attached the terminal,
  sent `fw_android_direct_ok` from the emulator keyboard, captured
  `/tmp/fieldwork-adb-direct-pair-20260519225208/before-pair.png`,
  `/tmp/fieldwork-adb-direct-pair-20260519225208/sessions.png`,
  `/tmp/fieldwork-adb-direct-pair-20260519225208/terminal-before-input.png`,
  `/tmp/fieldwork-adb-direct-pair-20260519225208/terminal-after-input.png`, UI
  XML, logcat, and an empty crash buffer, and a separately approved verifier
  client saw `android-direct: fw_android_direct_ok` in replayed terminal bytes.
  The default debug APK was then rebuilt and reinstalled, `BuildConfig.java`
  again contained `FIELDWORK_BIOMETRIC_BYPASS = false` and
  `FIELDWORK_DEBUG_PAIRING_PAYLOAD = ""`, the restored default build launched in
  `TotalTime=5105ms`,
  `/tmp/fieldwork-adb-direct-restore-20260519225316/restored-locked.png` plus
  `/tmp/fieldwork-adb-direct-restore-20260519225316/restored-ui.xml` verified
  the locked `Unlock` surface, and the restored crash buffer was empty. A
  2026-05-20 follow-up direct adb pass paired through explicit desktop
  approval, attached `bash · fieldwork`, sent `android_adb_direct_ping`, and
  verified `android-direct: android_adb_direct_ping` in
  `/tmp/fieldwork-adb-direct-pair-20260519235638/terminal-after-input.png` and
  `/tmp/fieldwork-adb-direct-pair-20260519235638/pty-output-after-input.txt`.
  The paired-data relaunch initially exposed a nonfatal Camera2 scanner flicker;
  the Android restore placeholder fix now keeps `PairingScreen` hidden until
  saved pairing restore completes, and the rerun with empty
  `FIELDWORK_DEBUG_PAIRING_PAYLOAD` captured
  `/tmp/fieldwork-adb-direct-pair-20260519235638/relaunch-restore-fix-sessions.png`
  plus UI XML/logcat with `FieldworkRepository: listSessions returned 1
  sessions` and no `Camera`/`CAMERA`, Fieldwork `FATAL`, or ANR entries. A
  later 2026-05-20 raw adb pass installed the default debug APK, launched the
  locked app in `TotalTime=6766ms`, captured
  `/tmp/fieldwork-adb-direct-20260520001909/default-locked.png`, UI XML,
  app-scoped logcat, and an empty crash buffer, then rebuilt with
  `FIELDWORK_ANDROID_BIOMETRIC_BYPASS=true` plus debug-only
  `FIELDWORK_ANDROID_PAIRING_PAYLOAD`, paired through explicit desktop
  approval, accepted the runtime notification prompt, listed `bash · fieldwork`
  with `ANDROID_ADB_MANUAL_READY`, attached the terminal, sent
  `android_adb_manual_ok` through `adb shell input text`, and captured
  `/tmp/fieldwork-adb-direct-20260520001909/terminal-after-input.png` showing
  `android-direct: android_adb_manual_ok`. The app logcat showed
  `FieldworkRepository: pair completed` and `FieldworkRepository: listSessions
  returned 1 sessions`; crash buffers stayed empty. The default debug APK was
  then rebuilt/reinstalled, `BuildConfig.java` again contained
  `FIELDWORK_BIOMETRIC_BYPASS = false` and
  `FIELDWORK_DEBUG_PAIRING_PAYLOAD = ""`, the restored default build launched in
  `TotalTime=1371ms`, and
  `/tmp/fieldwork-adb-direct-20260520001909/default-restore-locked.png`
  verified the locked `Unlock` surface. A 2026-05-20 direct adb refresh
  installed the default debug APK, launched the locked app with `Status: ok`,
  `LaunchState: COLD`, and `TotalTime=2360ms`, captured
  `/tmp/fieldwork-adb-direct-20260520100608/default-locked.png`,
  `/tmp/fieldwork-adb-direct-20260520100608/default-ui.xml`,
  `/tmp/fieldwork-adb-direct-20260520100608/default-logcat.log`, and an empty
  `/tmp/fieldwork-adb-direct-20260520100608/default-crash.log`, then paired an
  isolated release daemon through the debug-only biometric-bypass/pair-payload
  APK in `/tmp/fieldwork-adb-direct-pair-20260520100742`. That run accepted the
  runtime camera and notification prompts, paired through explicit desktop
  approval, listed `bash · fieldwork` with `ANDROID_ADB_DIRECT_READY`, attached
  the terminal, sent `android_adb_direct_ping` through `adb shell input text`,
  and captured
  `/tmp/fieldwork-adb-direct-pair-20260520100742/terminal-after-input.png`
  showing `android-direct: android_adb_direct_ping`. `fieldwork devices` listed
  `sdk_gphone64_arm64`, the terminal crash buffer was empty, and the debug APK
  was rebuilt back to default with `FIELDWORK_BIOMETRIC_BYPASS = false`,
  `FIELDWORK_DEBUG_PAIRING_PAYLOAD = ""`, and the restored locked screen at
  `/tmp/fieldwork-adb-direct-pair-20260520100742/default-restored-locked.png`.
  A 2026-05-20 direct adb shortcut-dashboard refresh on `Medium_Phone_API_36.1`
  then used an isolated release daemon and direct `adb`/`uiautomator` evidence
  to verify the new `fw` workflow: bare `target/release/fieldwork` created and
  attached the auto-named default `claude` session `cupcake`,
  `target/release/fieldwork refactoringjob` created and attached the named
  shortcut session, `fieldwork new --name shell` created the explicit shell
  session, explicit desktop approval completed Android pairing, and
  `/tmp/fieldwork-shortcut-adb-clean-51uCRiNt/dashboard.png` plus
  `/tmp/fieldwork-shortcut-adb-clean-51uCRiNt/dashboard.xml` showed `cupcake`,
  `refactoringjob`, and `shell` with no `No sessions` state.
  A later direct adb source-build `fw` shim pass used the first-live-test
  command shape without wrapper smoke scripts: bare `fw` created the auto-named
  default `claude` session `kazoo`, `fw refactoringjob` created the named
  shortcut, `fw new --name shell` created the shell session, explicit desktop
  approval completed in `pair_flow_ms=423`, and
  `/tmp/fieldwork-fw-direct-pair-20260520152507/dashboard.png` plus
  `/tmp/fieldwork-fw-direct-pair-20260520152507/after-pair.xml` showed `kazoo`,
  `refactoringjob`, and `shell` with no `No sessions` state. App logcat showed
  `FieldworkRepository: pair completed` and `FieldworkRepository: listSessions returned 3 sessions`;
  `/tmp/fieldwork-fw-direct-pair-20260520152507/dashboard-crash.log` was empty;
  and the debug APK was restored to `FIELDWORK_BIOMETRIC_BYPASS = false` and
  `FIELDWORK_DEBUG_PAIRING_PAYLOAD = ""`.
  A
  follow-up raw adb
  locked-launch baseline on 2026-05-19 installed the default debug APK, launched
  `app.fieldwork.android/.MainActivity` with `am start -W` `TotalTime=2078ms`,
  captured `/tmp/fieldwork-adb-launch.png`, `/tmp/fieldwork-adb-ui.xml`,
  app-scoped logcat, and the crash buffer, and verified the `Unlock` surface
  with an empty Fieldwork crash buffer. This is debug emulator smoke evidence,
  not release-device cold-start threshold evidence.
  `pnpm test:android-emulator-reconnect` uses
  emulator airplane mode to cut network while a terminal is attached, verifies
  Android input still reaches the PTY after restore, and confirms gap output is
  replayable through a separately approved verifier; latest local run on
  2026-05-19 passed on `emulator-5554`.
  `pnpm test:android-emulator-notification-tap` computes a real desktop
  session's lowercase `session_id_hash`, verifies an uppercase invalid hash does
  not route, opens the target terminal through the same hash-only activity
  intent used by notification taps, and confirms `notify_tap_ok` lands only in
  the target PTY; latest local run on 2026-05-19 passed on `emulator-5554`. The
  Play Store image still emitted background Google-service
  ANRs, so this remains local debug evidence only.
- `pnpm check:ios-prereqs` currently exits with 3 failures because full Xcode
  is not selected and the `iphoneos`/`iphonesimulator` SDKs are unavailable; it
  now reports at least 70 GiB free in `~/Downloads`, satisfying the repo's
  download/expansion floor. Its failure output now prints concrete recovery
  steps to authenticate, run `scripts/check-ios-prereqs.sh --download-xcode`,
  expand or place `Xcode_16.3.xip`, select
  `/Applications/Xcode-16.3.app/Contents/Developer`, run
  `sudo xcodebuild -runFirstLaunch`, rerun the audit, and then run
  `apps/ios/scripts/build-rust.sh`.
  `scripts/check-ios-prereqs.sh --download-xcode`, direct `xcodes
  download 16.3 --data-source xcodeReleases` both report a missing Apple
  ID/password, direct `curl` to Apple's Xcode 16.3 XIP URL, and the existing
  Chrome session remains blocked by Apple Developer authentication/access. No
  Xcode `.xip` is present locally.

## Prompt-To-Artifact Checklist

| Requirement | Evidence | Status |
|---|---|---|
| `PLAN.md` is v1 contract and `FUTURE.md` is the boundary | `PLAN.md`, `FUTURE.md`, this audit, and `scripts/verify-v1-boundary.mjs` distinguish implemented local scope from external/deferred gates | Local evidence complete |
| Section 14 build order followed before mobile/distribution work | `PLAN.md` implementation notes and `scripts/smoke-local-handoff.sh` show daemon + CLI local attach with default `claude`, arbitrary `bash`, and `vim` TUI sessions before mobile, relay push, distribution, and launch scaffolding were treated as complete | Local evidence complete |
| Rust workspace with `protocol`, `daemon`, `cli`, `relay`, `mobile-core` | `scripts/verify-rust-workspace.mjs` requires exactly those five workspace members and shared AGPL/repository/package metadata | Complete |
| Binaries `fieldwork`, `fieldworkd`, `fieldwork-relay` | `scripts/verify-rust-workspace.mjs` requires the `fieldwork`, `fieldworkd`, and `fieldwork-relay` Rust bin declarations; release workflows and npm packages carry `fieldwork`/`fieldworkd`, and the npm meta-package exposes `fieldwork`, the shorter `fw` CLI alias, and `fieldworkd` | Locally verified |
| Future-only product surfaces stay outside the v1 protocol and code | `Capabilities` now advertises only v1 `push_notifications`; reserved `voice`/`watch` fields were removed from `fieldwork-protocol` and its snapshots; `scripts/verify-v1-boundary.mjs` rejects future mobile imports, image paste/media input, cross-device handoff, direct mobile `CreateSession`/`KillSession` protocol references, camelCase and snake_case mobile create/kill/session-command affordances, deferred target-version promises in the v1 contract, future-only OpenCode/Aider/ACP adapter code in v1 crates, plugin/WASM extension protocol surface, and self-hostable relay Docker/container packaging | Locally verified |
| Universal PTY handoff for arbitrary commands | `scripts/smoke-local-handoff.sh` creates default `claude`, `bash`, and `vim` sessions; mobile simulator attaches and sends input | Locally verified |
| Raw PTY bytes, not cell-grid diffs | `docs/PROTOCOL.md`, daemon session/ring implementation, smoke tests with shell and TUI | Locally verified |
| No v1 predictive local echo or model-checker gate drift | `PLAN.md` now keeps mobile-core scoped to exact raw-byte handoff, `FUTURE.md` owns predictive local echo/Kani harnesses, and `scripts/verify-v1-boundary.mjs` rejects those claims if they drift back into the v1 contract | Locally verified |
| `wezterm-term` in daemon for state and synthetic snapshots | `crates/daemon` terminal model tests plus `session::snapshot_tests::stale_attach_snapshot_rehydrates_real_vim_session` | Locally verified |
| Length-prefixed framing everywhere | Protocol docs, bincode round-trip snapshots in `crates/protocol/src/snapshots`, focused MessagePack length-prefix round-trip tests for every current client/server protocol message, and negative bincode frame tests for missing prefixes, incomplete payloads, oversized lengths, and trailing payload bytes | Locally verified |
| Bincode for Unix IPC, MessagePack for mobile/iroh | `crates/protocol` now round-trips every current `ClientToServerMsg` and `ServerToClientMsg` through both local bincode snapshots and iroh/mobile MessagePack frames; daemon IPC plus iroh/mobile-core transport code use those encodings; shared bincode helpers pin bincode 2's legacy v1 layout | Locally verified |
| `CONTRACT_VERSION = 1` and version rejection | Protocol constant/tests, direct bincode IPC protocol-mismatch tests for `LocalCli`/`IosApp`/`AndroidApp`, and local iroh handoff smoke protocol-mismatch rejection before pairing | Locally verified |
| UUIDv7 IDs and UTC millisecond timestamps | Protocol/session records and focused `fieldwork-protocol` tests verify generated `SessionId`/`ClientId` values are UUIDv7 and `now_ms()` returns UTC Unix epoch milliseconds within the current system-time window | Locally verified |
| 256 KB per-session ring, monotonic `seq`, warm replay | Daemon ring proptests, explicit no-wrap saturation test, warm-attach `seq` regression test, protocol docs, and mobile-core `last_seen_seq` tracking; `stream_output_advances_mobile_reconnect_offset_without_decoding_bytes` verifies raw bytes are delivered without UTF-8 decoding while advancing the reconnect offset to live `Output.seq`, and `yes_head_10000_scale_stream_delivers_all_bytes_without_offset_drift` verifies local high-volume mobile-core delivery without dropped bytes or offset drift | Locally verified |
| Cold/stale attach synthetic ANSI snapshot | The daemon starts a real `vim /etc/hosts` PTY, forces stale attach, captures the returned snapshot and `seq` atomically, feeds `Attached.initial_bytes` into a fresh `wezterm-term` client model, and compares the alt-screen cell state | Locally verified |
| Multiple clients attach simultaneously; input writes to PTY | `session::handoff_tests::attached_clients_share_pty_output_from_any_input_writer` attaches two clients to one PTY, writes input through the session, and verifies both subscribers receive the child output; local handoff smoke covers the end-to-end iroh path | Locally verified |
| Dashboard session subscriptions receive create/remove/state replacement lists | `ipc::tests::session_list_subscription_receives_create_and_remove_replacements` and `ipc::tests::session_list_forwarder_publishes_dashboard_state_changes` cover replacement list updates for create/remove/state changes; local handoff smoke covers the end-to-end iroh subscribed dashboard path | Locally verified |
| Resize uses minimum attached viewport | Daemon session viewport tests plus `scripts/verify-daemon-resize.mjs` for attach/update/detach debounce wiring | Locally verified |
| Subscriber overflow emits one terminal `Lag` and forces resync | Daemon forwarder tests, mobile-core lag handling, native reattach controllers, and docs; `lag_event_notifies_native_ui_and_stops_for_resync` verifies the native sink receives the skipped count before mobile-core stops for reattach, and `skipped_bytes` is the v1 wire name for skipped broadcast-message count | Locally verified |
| State inference dispatch for Claude, Codex, unknown commands | `crates/daemon/src/state_infer/{mod,claude,codex,unknown}.rs`, `crates/daemon/tests/fixtures/`, and daemon session tests cover command-kind dispatch, Claude prompt/Stop-hook event ingestion, Codex structured event shapes, matching LocalCli hook updates, mismatched hook-source rejection, and byte-rate-only unknown command inference | Locally verified; authenticated live Claude/Codex captures remain account/workspace-gated |
| Claude/Codex first-class push/state; unknown commands run with baseline state | State inference tests and relay push tests verify `AwaitingInput` dispatch for Claude/Codex while unknown commands remain `Idle`/`Working` only; current Codex CLI surface is preserved by spawning the requested `codex` PTY command unchanged and accepting structured Codex events through the local agent-event adapter instead of appending an unsupported `--remote-control` flag | Locally verified |
| QR pairing, 32-byte base32 tokens, 10 minute TTL, single use, desktop approval | Pairing tests decode generated base32 tokens back to 32 bytes, assert the 10-minute expiry window, verify pre-approval single-use consumption, and verify success only after explicit approval; local handoff smoke covers the CLI QR/approval path | Locally verified |
| Long-lived Ed25519 device auth and revocation | `transport_iroh::peer_identity_tests::pairing_peer_identity_mismatch_returns_unauthorized` verifies pairing claims must match the authenticated iroh peer identity; daemon device registry tests cover removal from the paired-device registry; `ipc::tests::removing_device_with_push_token_enqueues_relay_unregistration` and `push::tests::worker_unregisters_token_from_relay` verify `fieldwork devices remove` also unregisters any relay-bound push token without terminal-content leakage; local handoff smoke reuses a deterministic phone `--secret-key-path` after `fieldwork devices remove` to verify the revoked identity receives `Error{Unauthorized}` | Locally verified |
| Unix socket hardening | Daemon path/socket tests cover private parent mode, socket `0600`, symlinked parent rejection, and symlinked existing socket rejection without replacing the target | Locally verified |
| Non-`LocalCli` clients cannot create/kill sessions | Authz tests, direct bincode IPC handler tests for `IosApp`/`AndroidApp` `CreateSession`, `KillSession`, and `AgentStateEvent` forbidden responses, plus local handoff smoke for paired iroh mobile rejection of `CreateSession`, `KillSession`, and `AgentStateEvent` | Locally verified |
| Scrollback/device registry encrypted at rest by default, opt-out explicit | Persistence tests cover encrypted session/device payloads, encrypted device-registry rows and hashed device row keys in both shared-test and separate production-like `sessions.redb`/`devices.redb` layouts, explicit plaintext opt-out, re-enable reads of previous plaintext rows, private `0700` persistence parents, `0600` database files, and symlink rejection for persistence directories and database files. README, npm package README, public site pages, and security docs now state that Keychain prompts are only for local key material and that terminal output, keystrokes, commands, paths, session names, and push tokens are not stored there | Locally verified |
| Push payload privacy | Relay request validation rejects unknown/free-text fields and validates session hashes as lowercase 64-character hex strings; APNs/FCM provider tests parse outbound provider JSON and assert exact key sets, fixed alert copy, hash-only data fields, and no `last_line`/command/path strings; secret-boundary and mobile privacy verifiers cover fixed-copy notifications, no lock-screen session-name toggle, strict lowercase `session_id_hash`-only tap routing, Android queued FCM token registrar tests for trimmed-token storage, blank-token rejection, matching-token clear semantics, clear-all unpair behavior, FieldworkViewModel tests for paired/unlocked registration gating, duplicate-token dedupe, pairing-time session load/subscription/FCM sync, locked pairing no-op for session load/subscription/FCM sync, dashboard subscription updates, lock-time subscription stop, locked push-tap pending resolution after unlock or later subscription updates, unlocked push-tap resolution against the current session list, and invalid uppercase hash rejection after unlock, `fieldwork_push_tokens.xml` backup/transfer exclusion, and Android JVM tests prove tap parsing trims but never lowercases uppercase hashes, foreground notifications use fixed generic copy and private lock-screen visibility even when extra terminal/command fields are present, and invalid event types or invalid hashes do not post notifications | Local contract verified; real APNs/FCM in-transit inspection blocked |
| Mobile crash-reporting consent | `scripts/verify-telemetry-privacy.mjs`, native mobile telemetry helpers, focused Android MobileTelemetry JVM tests, and terminal controllers verify off-by-default Sentry, Settings opt-in, declined one-time consent resolution, debug-without-DSN no-start behavior, delayed one-time prompt after `AwaitingInput` response plus 10 output lines, no default PII, and trace sampling off | Local static/JVM contract verified; real Sentry receipt blocked |
| Relay verifies signatures, token ownership, replay, skew, validation | Relay tests cover signature, ownership, replay, clock skew, validation, rate limiting, APNs BadDeviceToken stale-token pruning from memory and SQLite, and 90-day no-use push-token pruning with touch-on-use refresh; `tests::rejects_cross_daemon_token_use` is the explicit Section 7.3.1 gate that registers a token for daemon A and verifies daemon B receives `403 Forbidden` when trying to push to it | Locally verified |
| Fieldwork-owned TLS clients use OS trust | iroh uses `platform-verifier`; relay OTLP uses OpenTelemetry's `reqwest-rustls` native-root path; `pnpm check:telemetry-privacy` rejects `reqwest-rustls-webpki-roots` on the OTLP exporter | Locally verified |
| Security model doc | `docs/SECURITY.md` summarizes the v1 trust zones, local IPC hardening, pairing/device auth, encrypted local storage, Keychain-held key boundaries, raw-byte terminal privacy, relay push controls, mobile biometric gates, remaining external gates, and the local verification set; `scripts/verify-security-model.mjs` pins those claims and CI wiring | Locally verified |
| Native iOS app: SwiftUI + SwiftTerm | `apps/ios` source, project files, committed SwiftPM package pins, Swift parse check, APNs entitlement verifier, generated mobile-core linkage verifier, no-stub-build guard, explicit QR camera authorization handling, raw-byte output revision guard, SwiftTerm raw byte-array renderer guard, iOS `lastSeenSeq` lag-reattach static checks | Source verified; full build blocked by Xcode/signing/device gates |
| Native Android app: Compose + Section 7.6 renderer decision | `apps/android`, `docs/ANDROID_RENDERER.md`, termlib dependency, mobile privacy verifier, Android raw `ByteArray` to termlib and `lastSeenSeq` lag-reattach static checks, lifecycle-scoped `FieldworkViewModel`, Android JNI context initialization failure-to-Java-exception guard, focused TerminalController JVM tests for locked-input refusal, latest-`lastSeenSeq` `Lag` reattach, attached-stream-error reattach, delayed telemetry trigger, nonblocking saved-pairing restore, off-main repository-backed refresh coverage, off-main terminal attach/lag-reattach coverage, and stale startup-restore invalidation, AAB ABI, packaged uses-permission allowlist and manifest privacy verifier, local API 36.1 emulator debug launch, `uiautomator` locked-surface evidence, and nonblank emulator `screencap` check, plus direct adb restart-restore evidence and direct adb pair/attach/input evidence | Debug Kotlin compile, release AAB contents/manifest, debug launch, locked surface, restored restart dashboard, direct adb terminal input/output, and nonblank debug screenshot verified; physical dogfood and release-device runtime gates remain blocked |
| Generated UniFFI mobile-core binding surface | `crates/mobile-core`, `apps/android/generated/uniffi/fieldwork_mobile_core/fieldwork_mobile_core.kt`, Android/iOS Rust build scripts, Android Gradle generated-source wiring, iOS Xcode generated Swift/xcframework wiring, `.github/workflows/ci.yml`, and `scripts/verify-uniffi-bindings.mjs` verify the generated Kotlin binding exposes `FieldworkClient`, `AttachedSession`, `SessionListSink`, `ByteStreamSink`, `FieldworkError`, pair/list/subscribe/attach/input/resize/detach/register-push-token methods, rejects generated mobile create/kill/session-command APIs, and verifies Android/iOS build-script binding generation plus Xcode/Gradle consumption | Kotlin generated binding and build wiring locally verified; full Swift generated-binding execution remains blocked by Xcode |
| Mobile resume/input biometric gates | iOS uses biometric-only `LocalAuthentication`; Android uses biometric-only `BiometricPrompt`; `scripts/verify-mobile-privacy.mjs` statically verifies both policies, locked app roots, unlock-gated session/push activation, stale input gates, and Android JVM tests cover first unlock, immediate post-unlock resume, fresh foreground resume, 5-minute stale foreground boundary, terminal input refusal while locked, and that the `FIELDWORK_ANDROID_BIOMETRIC_BYPASS=true` emulator path remains debug-build-only behind `BuildConfig.DEBUG` with release builds hardcoded off | Static/source verified; physical-device biometric prompt check blocked |
| Mobile pairing key storage | iOS Keychain uses the data-protection keychain with `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`; Android pairing prefs use `EncryptedSharedPreferences` plus AES256 master/key/value encryption, and Android pairing plus queued FCM-token prefs are excluded from full backup, cloud backup, and device transfer by `scripts/verify-mobile-privacy.mjs` | Static/source verified; physical restore/transfer check blocked |
| Mobile can pair, list/subscribe, attach, send input, resize, detach, register push tokens | iOS/Android app source, mobile-core APIs, Android paired-and-unlocked FCM token sync with queued-token and ViewModel registration-gating tests, `scripts/verify-v1-boundary.mjs` required-surface checks, and local pair-test simulator | Locally verified except physical push token/provider path |
| Mobile cannot create sessions, kill sessions, or specify commands | Mobile-core API surface, `scripts/verify-v1-boundary.mjs` forbidden-surface checks, authz tests, and local handoff smoke | Locally verified |
| First Android live-test runbook | `docs/LIVE_TESTING.md` defines the first operator-assisted Android physical-device terminal handoff pass: Android-only, not v1 release sign-off, same daemon-owned PTY session, not screen mirroring, no takeover of arbitrary already-open Terminal.app or iTerm tabs, no iOS/npm publish/store/production relay/APNs/FCM/domain/signing scope, USB debugging only for QA evidence and not an end-user requirement, direct `adb` screenshot/UI/log/crash capture, a temporary source-build `fw` shim for the same short command users get after npm install, desktop-created `bash`, `claude`, and `vim`/`htop` sessions, the bare `fw` auto-named default `claude` shortcut, and the `fw refactoringjob` named shortcut appearing in the Android dashboard | Runbook synchronized; physical-device execution remains blocked until operator-provided device/evidence |
| iroh P2P transport with relay fallback | Daemon iroh transport, Oracle Terraform host scaffold, relay iroh mode/Ansible scaffold, deploy artifact checksum plus DSSE/SLSA bundle verifier | Locally verified; hosted relay deploy blocked |
| Generic push notifications | Relay APNs/FCM code, APNs provider-client connection reuse test, APNs BadDeviceToken stale-token pruning test, daemon-facing provider-error body redaction, relay provider-client static verifier, daemon push worker with bounded exponential retry, mobile notification handlers, and test-only delivery-buffer retention so production relay builds do not retain accepted provider delivery records after dispatch | Local code/tests verified; provider delivery blocked |
| Relay control-plane transport encryption | `fieldwork-relay` supports Rustls control-plane serving from relay-only cert/key files, installs an explicit Rustls crypto provider, production systemd sets `FIELDWORK_RELAY_REQUIRE_TLS=true`, and `scripts/verify-infra-scaffold.mjs` checks the fail-closed TLS credential wiring | Locally verified with `scripts/smoke-relay-tls-loopback.sh`, `cargo test -p fieldwork-relay`, `cargo clippy -p fieldwork-relay -- -D warnings`, and infra/v1/release static gates; real certificate provisioning and hosted TLS smoke blocked |
| npm-only desktop distribution | `packages/cli` plus `packages/cli-{darwin-arm64,darwin-x64,linux-arm64,linux-x64}`, optional dependencies, `preferUnplugged`, `install.js` native binary swap, `fieldwork`/`fw` CLI dispatcher alias and `fieldworkd` daemon dispatcher fallback, legal-file staging, `.gitignore` protection for generated platform native bins, tracked generated-native-bin rejection in `scripts/verify-npm-packages.mjs`, meta-package README contract checks in `scripts/verify-npm-packages.mjs`, `scripts/prepare-npm-artifacts.mjs`, `scripts/publish-npm-packages.mjs`, `scripts/verify-npm-registry-state.mjs`, Changesets fixed group, `scripts/test-bun-install.mjs`, `scripts/test-npm-dispatcher.mjs`, `scripts/test-npm-registry-state.mjs`, `scripts/test-npm-artifact-pack.mjs`, `scripts/test-npm-publish-plan.mjs`, and `scripts/verify-release-workflows.mjs` cover npm metadata, v1.0.0 package manifests, the owned unscoped `fieldwork` meta package, package-page install/use commands, mobile capability boundary, four v1 platform package names, dispatcher fallback, WSL2 host scope, encrypted local persistence, push-payload privacy copy, fail-before-network bare registry invocation so the checker cannot act as a name-availability probe, missing-token publish rejection before npm is invoked, post-placeholder platform-published state, post-release latest-version/provenance state, missing platform-root rejection, non-native platform package publish rejection in both readiness and actual publish paths, real staged desktop binary readiness without committing generated native package artifacts, Bun optional dependency behavior, children-first `npm publish --provenance --access public`, post-publish public registry verification, GitHub Release audit artifacts, and cargo-dist archive-only config with `installers = []`, `publish-jobs = []`, and `install-updater = false` | Local package, staged binary readiness, source-control artifact hygiene, and Bun optional-dependency checks verified; real npm publish blocked by platform child publish rights plus a release-scoped npm token |
| CI/release workflows | `.github/workflows/ci.yml`, `version-packages.yml`, `release-rust.yml`, `release-npm.yml`, `release-ios.yml`, `release-android.yml`, `deploy-relay.yml`, `deploy-site.yml`, `.github/dependabot.yml`, `apps/ios/Fieldwork.xcodeproj/project.pbxproj`, `scripts/verify-release-workflows.mjs` | Local syntax, CI Rust/supply-chain/Terraform Validate/local-handoff/relay/npm/site/mobile-static/Android debug jobs, release-audit list-mode test coverage, dynamic repository-derived cosign identity, release fail-closed/provenance contracts, early Darwin signing/notarization preflight before toolchain setup/build, early `NPM_TOKEN` preflight before npm artifact download, early relay SSH-key/inventory preflight before relay artifact download, early Cloudflare credential preflight before site install/build, early Android release credential preflight before toolchain setup/mobile build, decoded Apple signing/notarization assets outside the repository workspace with chmod/cleanup, iOS App Store Connect upload JSON outside the repository workspace plus signing/upload cleanup, Android generated Firebase/signing-file cleanup, relay SSH key chmod/cleanup, post-publish npm registry/provenance verification with propagation retries, iOS Xcode build-phase `FIELDWORK_SKIP_RUST_BUILD` reuse wiring, Cloudflare site deploy scaffold, and the exact weekly Dependabot coverage for Cargo, root npm, `site/` npm, Android Gradle, and GitHub Actions are checked; external secrets blocked |
| Local non-external release gate | `scripts/check-local-release.mjs` and `package.json` `check:local-release` aggregate the deterministic source-side verifiers, workflow YAML syntax parsing, release-audit list-mode test, and fixture tests that do not require credentials, live publishing, iOS SDK builds, Android emulator runtime, physical devices, or hosted relay deployment. The optional `--with-artifacts` mode adds preserved AAB, staged npm binary, publish-readiness, and npm dry-run pack checks when local artifacts are present. The optional `--with-runtime` mode adds local handoff smoke, demo-video, site typecheck/build, Terraform fmt/init/validate, relay TLS/OTLP loopback, and desktop cold-start checks when the local tools and release binaries are present; its local handoff smoke defaults to `/tmp/fieldwork-target-checks` unless `CARGO_TARGET_DIR` is already set, preserves host `CARGO_HOME`/`RUSTUP_HOME` while isolating Fieldwork `HOME`, and Terraform validation uses `TF_PLUGIN_CACHE_DIR` outside the generated working directory while still removing `.terraform/` on exit. CI syntax-checks the aggregate wrapper and list-checks artifact/runtime modes without re-running the heavyweight local artifact/runtime gate in pull requests. | Locally verified |
| No-ship marker guard | `scripts/verify-no-ship-markers.mjs`, `package.json` `check:no-ship`/`test:no-ship`, and `scripts/check-local-release.mjs` scan production Rust, Android, iOS, and npm dispatcher/install sources for `todo!`, `unimplemented!`, `TODO`, `FIXME`, `HACK`, `XXX`, and "not implemented" markers while excluding generated Android bindings and the compile-guarded iOS stub shim; `--self-test` injects synthetic blocked markers and verifies the exclusions | Locally verified |
| Pre-commit developer gate | `.pre-commit-config.yaml` runs `cargo fmt --check`, `cargo clippy --workspace -- -D warnings`, `cargo nextest run --workspace --no-fail-fast`, `node scripts/verify-secret-boundaries.mjs`, `node scripts/verify-no-ship-markers.mjs`, and `node scripts/verify-no-ship-markers.mjs --self-test` through local system hooks; `scripts/verify-community-scaffold.mjs` pins those hooks as always-run workspace/security gates | Locally verified |
| Daemon service install/restart scaffold | `crates/cli/src/service.rs`, CLI daemon commands, IPC health wait, CLI auto-spawn reuse of validated colocated `fieldworkd` resolution, focused service context/path unit tests including colocated executable `fieldworkd` validation, macOS Gatekeeper rejection, and install rollback when service start fails, fake-command `service-manager` rendering tests for LaunchAgent `KeepAlive`/`SuccessfulExit=false` and systemd `Restart=on-failure`/`RestartSec=5`, local handoff restart-restore smoke, and `scripts/verify-daemon-service.mjs` | Static/source verified; launchd/systemd survival and macOS sleep/wake gates still need signed/notarized artifact, real sleep/wake cycle, or Linux user-service host |
| Daemon log retention | `crates/daemon/src/logging.rs`, `logging::tests::prune_old_log_files_removes_only_expired_daemon_logs`, and `scripts/verify-daemon-service.mjs` verify seven-day startup pruning for `daemon.log*` files only | Locally verified |
| Desktop cold-start performance thresholds | `scripts/measure-desktop-performance.mjs` and `pnpm measure:desktop-performance` build on release binaries, run one explicit warm-up sample to remove build-machine first-exec noise, then fail if any measured `fieldwork version` sample exceeds 50 ms or any measured daemon ready-to-handshake sample exceeds 200 ms; latest pass measured CLI max `4.18ms` and daemon max `47.59ms` over 25 measured samples | Locally verified |
| Development doc | `docs/DEVELOPMENT.md` documents the 15-minute source-build path, common local checks, protocol/ring/snapshot/mobile-core focused tests, local handoff smoke, desktop release/performance commands, website checks, UniFFI bindgen, iOS/Android development flows, mobile privacy/telemetry facts, daemon logs, and user-service lifecycle; `scripts/verify-development-doc.mjs` pins those claims and CI wiring | Locally verified |
| Docs synchronized | `scripts/verify-docs-sync.mjs` requires `README.md`, `PLAN.md`, `FUTURE.md`, `docs/PROTOCOL.md`, `docs/PRIVACY.md`, `docs/ARCHITECTURE.md`, `docs/INSTALL.md`, `docs/ANDROID_RENDERER.md`, `docs/LIVE_TESTING.md`, and `docs/RELEASE_AUDIT.md` to exist and carry the current v1 install, protocol, privacy, architecture, Android renderer, first live-test, iOS blocker, mobile-boundary, npm-only distribution, and deferred-scope facts; `docs/DEVELOPMENT.md`, `docs/OPERATIONS.md`, and `docs/SECURITY.md` remain covered by the focused release, infra, security-model, telemetry, and privacy verifiers | Current |
| README screenshots and 60-second demo video | README embeds the three screenshot-style SVG captures and links `docs/assets/fieldwork-demo-v1.mp4`; `scripts/render-demo-video.mjs` regenerates the MP4 from those assets plus fixed release-boundary slates, and `pnpm check:demo-video` verifies an H.264 1920x1080 artifact with approximately 60-second duration | Locally verified |
| GitHub contribution templates | `.github/ISSUE_TEMPLATE/bug.yml`, `feature.yml`, `question.yml`, `.github/PULL_REQUEST_TEMPLATE.md`, `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, `LICENSE`, and `NOTICE`; `scripts/verify-community-scaffold.mjs` verifies the templates require actionable repro/scope/context fields, privacy/security reminders, v1/FUTURE boundary checks, external-gate disclosure, and the AGPL/App-Store-permission docs | Locally verified |
| Relay operations and key rotation | `docs/OPERATIONS.md` documents deploy verification, the `fieldwork-app/fieldwork` release-rust cosign identity, the operator-owned release-gate handoff, quarterly APNs/FCM/Honeycomb/SSH rotation, incident response, and relay-side token deletion; `scripts/verify-infra-scaffold.mjs` now pins those runbook prerequisites, release-gate handoff steps, rotation steps, incident response steps, data-deletion flow, and local verification commands | Local runbook verified; hosted execution blocked |
| App Store privacy nutrition labels / Play Data safety | `docs/STORE_PRIVACY.md`, `scripts/verify-store-privacy.mjs`, and `scripts/verify-mobile-privacy.mjs` | Answer sheets prepared and synchronized with local manifest/default notification/Sentry checks; console submission blocked |
| AGPL OSS posture | `scripts/verify-rust-workspace.mjs` checks Cargo AGPL/repository metadata, `scripts/verify-npm-packages.mjs` checks root AGPL text, NOTICE section-7 App Store/TestFlight permission wording, and npm package AGPL/repository metadata, and `scripts/generate-oss-notices.mjs --check` verifies generated native OSS notice screens | Locally verified |
| Site for `fieldwork.dev` | `site/` Astro project, `site/astro.config.mjs`, `deploy-site.yml`, `scripts/verify-site-content.mjs`, `scripts/verify-release-workflows.mjs`, and agent-browser screenshot smoke for all five pages; the verifiers pin the Cloudflare Pages deploy workflow contract, isolated `site/pnpm-lock.yaml` install, root `pnpm build:site`, fail-closed Cloudflare credentials before site install/build, `fieldwork-dev` Pages project, canonical `https://fieldwork.dev` site URL, v1 install/protocol/privacy claims, screenshot SVG imports, and out-of-scope surface exclusions. `scripts/check-domain-status.mjs --operator-refresh` remains available only for operator-requested status refreshes and fails closed without that flag | Local build, browser smoke, content, and deploy scaffold verified; Cloudflare/domain ownership blocked |
| Appendix B external reservations | `PLAN.md` Appendix B tracks platform child package publish rights, domain, GitHub org/repo, social handle, Oracle, Apple Developer, Sentry, Honeycomb account setup, and the launch-plan calendar block. Live npm/domain/GitHub status scripts are not routine local checks; they remain available only for operator-requested post-state or status refreshes, and `scripts/test-external-status-refresh.mjs` verifies domain/GitHub refreshes fail closed before network access without `--operator-refresh` | Not locally completable from this shell without account ownership/payment credentials or the user's calendar commitments |

## Latest Focused Refresh

After tightening npm registry-state wording, adding the npm publish missing-token
guard, adding default aggregate Android emulator substitute-suite evidence,
refreshing Android emulator debug-launch plus pair/attach/foreground-input
evidence, direct adb pair/attach/terminal-input evidence, and raw adb
locked-launch evidence, tightening release-workflow secret cleanup, tightening
the OSS community scaffold verifier, adding the delayed mobile telemetry consent
prompt, updating the iOS toolchain blocker wording, and clearing reproducible
build output to restore Xcode download headroom while preserving the release
AAB, the following focused checks were rerun:

```sh
node --check scripts/verify-npm-registry-state.mjs
pnpm check:npm-registry -- --expect-meta-published --expect-platform-unpublished
pnpm test:npm-registry-state
node --check scripts/verify-telemetry-privacy.mjs
pnpm check:telemetry-privacy
pnpm check:store-privacy
swiftc -parse -target arm64-apple-macosx15.0 $(find apps/ios/Sources/App apps/ios/Sources/Core apps/ios/Sources/Features apps/ios/Sources/UI -name '*.swift')
pnpm check:mobile-privacy
pnpm check:v1-boundary
pnpm check:release-audit
pnpm check:local-release -- --with-artifacts --with-runtime
pnpm test:npm-publish-plan
pnpm check:npm-packages
pnpm check:development-doc
pnpm check:release-audit
pnpm check:docs-sync
pnpm check:local-release
pnpm check:release-workflows
pnpm check:secret-boundaries
pnpm test:secret-boundaries
pnpm check:security-model
pnpm check:android-aab
node scripts/test-android-aab-verifier.mjs
node scripts/test-android-pair-button-picker.mjs
pnpm test:android-debug-smoke
pnpm test:android-emulator
pnpm test:android-emulator-pair
pnpm test:android-emulator-flood
pnpm test:android-emulator-multisession
pnpm test:android-emulator-reconnect
pnpm test:android-emulator-notification-tap
pnpm test:android-emulator-restart-restore
adb -s emulator-5554 exec-out screencap -p
adb -s emulator-5554 logcat -d
adb -s emulator-5554 shell am start -W -n app.fieldwork.android/.MainActivity
adb -s emulator-5554 shell input tap 540 1972
adb -s emulator-5554 shell input text fw_android_direct_ok
adb -s emulator-5554 shell input keyevent ENTER
target/aarch64-apple-darwin/release/fieldwork pair-test --attach first --expect-output "android-direct: fw_android_direct_ok"
adb -s emulator-5554 shell cmd package resolve-activity --brief app.fieldwork.android
adb -s emulator-5554 exec-out uiautomator dump /dev/tty
adb -s emulator-5554 logcat -b crash -d
pnpm check:demo-video
pnpm check:site
pnpm check:rust-workspace
pnpm check:docs-sync
pnpm check:development-doc
pnpm check:community-scaffold
pnpm check:infra-scaffold
pnpm check:infra-terraform
terraform fmt -check -recursive infra/oracle/terraform
terraform -chdir=infra/oracle/terraform init -backend=false
terraform -chdir=infra/oracle/terraform validate
pnpm check:site-content
node scripts/test-external-status-refresh.mjs
apps/android/gradlew --no-daemon :app:compileDebugKotlin
apps/android/gradlew --no-daemon :app:testDebugUnitTest --tests 'app.fieldwork.android.core.FieldworkViewModelTest'
pnpm test:android-unit
pnpm check:ios-prereqs
cargo deny check
cargo audit
cargo test -p fieldwork-daemon state_infer
cargo test -p fieldwork-daemon local_agent_hook
cargo test -p fieldwork-cli service
node scripts/verify-daemon-service.mjs
pnpm test:bun-install
pnpm test:relay-tls
pnpm test:relay-otlp
pnpm test:local-handoff
cargo test -p fieldwork-daemon ipc_handler_rejects_mobile_create_and_kill_session_requests
cargo test -p fieldwork-daemon ipc_handler_rejects_mobile_agent_state_events
cargo test -p fieldwork-daemon attached_clients_share_pty_output_from_any_input_writer
cargo test -p fieldwork-daemon pairing_peer_identity_mismatch_returns_unauthorized
cargo test -p fieldwork-daemon warm_attach_seq_points_after_replayed_bytes
cargo test -p fieldwork-daemon persistence
cargo test -p fieldwork-daemon push_hash_is_lowercase_sha256_hex_and_not_plaintext
cargo test -p fieldwork-daemon worker_registers_token_and_pushes_awaiting_input_to_relay
cargo test -p fieldwork-relay payload_contains_only_generic_text_and_hashes
cargo test -p fieldwork-relay private_payload
cargo test -p fieldwork-relay apns_bad_device_token_removes_token_binding_from_memory_and_sqlite
cargo test -p fieldwork-relay push_token
cargo test -p fieldwork-relay fcm_invalid_token_reason_detects_unregistered_fcm_error
cargo test -p fieldwork-mobile-core
cargo test -p fieldwork-protocol
```

Direct adb restart-restore evidence was also refreshed on 2026-05-19. The
pre-fix run captured a restored dashboard that still showed `No sessions` and
then logged `ANR in app.fieldwork.android` after tapping refresh. After the
Android source fix, emulator screenshots showed `fw_restart_session` before and
after refresh, logcat showed `FieldworkRepository: listSessions returned 1
sessions`, and there were no Fieldwork `FATAL EXCEPTION` or ANR entries in the
captured logcat tail.

The operator-only external status refresh commands are deliberately not part of
the routine focused-check list. They fail closed without `--operator-refresh`:

```sh
pnpm refresh:domain-status -- --require-registered --require-dns
pnpm refresh:github-namespace -- --expect-available
```

Observed results: all passed except `pnpm check:ios-prereqs`, which failed with
the expected full-Xcode/iOS-SDK blocker and reported at least 70 GiB free in
`~/Downloads`. A later npm publish-token guard refresh passed
`pnpm test:npm-publish-plan`, `pnpm check:npm-packages`,
`pnpm check:development-doc`, `pnpm check:release-audit`,
`pnpm check:docs-sync`, and `pnpm check:local-release`; the publish-plan test
now verifies missing `NODE_AUTH_TOKEN` fails before `npm` is invoked while
keeping the children-first provenance publish plan available without a token.
The Android Kotlin compile and Android unit tests completed successfully after tightening native notification hash handling and adding
TerminalController coverage for locked-input refusal, latest-`lastSeenSeq`
`Lag` reattach, attached-stream-error reattach, delayed telemetry-consent triggering, FieldworkViewModel
coverage proving terminal attach and lag reattach run repository work off the main thread, and MobileTelemetry
coverage for default-off crash reporting, declined one-time consent resolution,
and debug-without-DSN no-start behavior. `pnpm test:android-debug-smoke` passed
on a wiped API 36.1 AVD with debug launch, locked-surface, crash-log, and
nonblank-screenshot evidence while preserving physical release-device gates.
The default `pnpm test:android-emulator` aggregate passed on `emulator-5554`
with locked debug launch `TotalTime=7920ms`, pair `pair_flow_ms=2234`, session
subscription `visible_ms=3318`, flood screenshot 8440/14400 nonblack samples,
and successful background replay, restart restore, multisession, reconnect, and
notification tap routing.
`pnpm check:android-aab` verified the preserved release AAB ABI slices,
packaged uses-permission allowlist, and packaged manifest privacy surface; the
Android AAB verifier self-test now covers forbidden location permission,
missing notification permission, terminal-content metadata such as `last_line`,
and signed-bundle rejection under the local unsigned policy. After
staging local desktop release binaries into the npm platform packages plus Android mobile-core release artifacts,
`pnpm check:secret-boundaries` rejected repository npm token strings and
`.npmrc` files, then scanned 32 non-relay artifacts for relay-only credentials
and npm auth-token patterns:
`packages/cli-darwin-arm64/bin/fieldwork`,
`packages/cli-darwin-arm64/bin/fieldworkd`,
`packages/cli-darwin-x64/bin/fieldwork`,
`packages/cli-darwin-x64/bin/fieldworkd`,
`packages/cli-linux-arm64/bin/fieldwork`,
`packages/cli-linux-arm64/bin/fieldworkd`,
`packages/cli-linux-x64/bin/fieldwork`,
`packages/cli-linux-x64/bin/fieldworkd`, `packages/cli/bin/fieldwork`,
`packages/cli/bin/fieldworkd`, `target/aarch64-apple-darwin/release/fieldwork`,
`target/aarch64-apple-darwin/release/fieldworkd`,
`target/aarch64-linux-android/release/deps/libfieldwork_mobile_core.a`,
`target/aarch64-linux-android/release/deps/libfieldwork_mobile_core.so`,
`target/aarch64-linux-android/release/libfieldwork_mobile_core.a`,
`target/aarch64-linux-android/release/libfieldwork_mobile_core.so`,
`target/aarch64-unknown-linux-gnu/release/fieldwork`,
`target/aarch64-unknown-linux-gnu/release/fieldworkd`,
`target/armv7-linux-androideabi/release/deps/libfieldwork_mobile_core.a`,
`target/armv7-linux-androideabi/release/deps/libfieldwork_mobile_core.so`,
`target/armv7-linux-androideabi/release/libfieldwork_mobile_core.a`,
`target/armv7-linux-androideabi/release/libfieldwork_mobile_core.so`,
`target/release/fieldwork`, `target/release/fieldworkd`,
`target/x86_64-apple-darwin/release/fieldwork`,
`target/x86_64-apple-darwin/release/fieldworkd`,
`target/x86_64-linux-android/release/deps/libfieldwork_mobile_core.a`,
`target/x86_64-linux-android/release/deps/libfieldwork_mobile_core.so`,
`target/x86_64-linux-android/release/libfieldwork_mobile_core.a`,
`target/x86_64-linux-android/release/libfieldwork_mobile_core.so`,
`target/x86_64-unknown-linux-gnu/release/fieldwork`, and
`target/x86_64-unknown-linux-gnu/release/fieldworkd`. The Rust workspace verifier passed, pinning the exact five-crate
workspace, shared package metadata, required `fieldwork`/`fieldworkd`/
`fieldwork-relay` bin declarations, and mobile-core library crate types. The
docs-sync verifier passed, pinning the named v1 docs to the current install,
protocol, privacy, architecture, iOS blocker, mobile-boundary, npm-only
distribution, and deferred-scope facts, including the README pointer to the
operator-facing release-gate handoff and `PLAN.md` completion-checkbox source
of truth. The development doc verifier passed, pinning `docs/DEVELOPMENT.md` to the 15-minute source-build path, common checks, focused protocol/PTY/mobile-core tests, local handoff smoke, desktop release/performance commands, website checks, UniFFI bindgen, iOS/Android development flows, mobile privacy/telemetry facts, daemon logs, and user-service lifecycle. The community scaffold verifier passed,
pinning the PR/issue templates, root OSS/security docs, and pre-commit hooks to
the v1 privacy, security, verification, and external-gate contract. The security model verifier passed, pinning `docs/SECURITY.md` to the v1 trust zones, local IPC hardening, pairing/device auth, encrypted local storage, raw-byte terminal privacy, relay push controls, mobile biometric gates, remaining external gates, and CI wiring. The infra scaffold verifier passed, including focused coverage for the operations runbook's
operator-owned release-gate handoff, `PLAN.md` checkbox source of truth for
external gates, operator-reservation evidence handling, Appendix B operator reservations,
relay prerequisites,
quarterly credential rotation steps, incident response procedure,
token-deletion flow, local verification list, and committed
Terraform OCI provider lockfile. A follow-up
Terraform validation pass ran `pnpm check:infra-terraform`, which wraps
`terraform fmt -check -recursive infra/oracle/terraform`,
`terraform -chdir=infra/oracle/terraform init -backend=false`, and
`terraform -chdir=infra/oracle/terraform validate`;
initialization installed the signed OCI provider from the lockfile, validation
reported `Success! The configuration is valid.`, and the shared script removed
the ignored `.terraform` provider cache afterward without producing `tfstate` or
`tfvars` files. The site content verifier passed, pinning the `fieldwork.dev` pages to v1 install, protocol, architecture, privacy, screenshot SVG imports, and future-scope exclusions. Domain status refresh is no longer an agent-owned routine release activity; `scripts/check-domain-status.mjs --operator-refresh` remains available for explicit operator-requested refreshes only, and the script fails closed before network access without that flag. The release-workflow verifier now also pins the Cloudflare Pages deploy scaffold for `fieldwork.dev`, including the isolated site lockfile install, root `pnpm build:site`, fail-closed Cloudflare credentials, and the `fieldwork-dev` Pages project. The release-workflow verifier now also pins the weekly Dependabot matrix for Cargo, root npm package metadata, the isolated `site/` npm lockfile, Android Gradle, and GitHub Actions. The focused daemon state-inference fixture tests passed, and the focused daemon local-agent-hook tests passed for `matching_local_agent_hook_updates_session_state` and `mismatched_local_agent_hook_is_ignored`, verifying that matching LocalCli Claude/Codex hook events update only matching PTY sessions while mismatched hook sources are ignored. The daemon
service scaffold verifier passed, the direct bincode IPC mobile create/kill rejection test passed for `IosApp` and `AndroidApp`, the direct bincode IPC mobile agent-state hook rejection test passed for `IosApp` and `AndroidApp`, the local handoff smoke now also covers paired iroh mobile agent-state hook rejection, and the latest local handoff smoke paired in 3 seconds before exercising `claude`, `bash`, `vim`, subscribed session updates,
mobile input, warm reconnect replay over iroh within 2 seconds from `last_seen_seq` (12ms in the latest local run), protocol-mismatch rejection, mobile create/kill/agent-state-event rejection, revocation, and restart restore.
The Android biometric gate refresh added focused JVM tests for first unlock,
immediate post-unlock resume, fresh foreground resume, 5-minute stale foreground
boundary, and terminal input refusal while locked, while preserving the
`BIOMETRIC_STRONG`-only prompt. The debug emulator bypass is pinned to
`FIELDWORK_ANDROID_BIOMETRIC_BYPASS=true`, `BuildConfig.DEBUG`, and release
builds hardcoding it off. The
Android notification tap parser refresh added focused JVM coverage proving tap
hashes are trimmed but never lowercased; the view model now routes push taps
through the same strict lowercase `session_id_hash` parser used by notification
ingress, keeps valid taps pending while locked, resolves them after unlock plus
session refresh or later subscription updates, routes unlocked taps against the
current session list, clears stale pending routes before rejecting invalid
uppercase hashes after unlock, and applies session subscription updates to the
dashboard list. Pairing while already unlocked loads sessions, starts the same
subscription path, and syncs queued/current FCM tokens; pairing while locked
does not load sessions, subscribe, or sync FCM tokens. Locking stops subscription
updates from changing the dashboard.
The Android FCM token refresh path now queues trimmed tokens in backup-excluded
`fieldwork_push_tokens.xml`, keeps the Firebase service from directly
registering tokens, and sends/clears queued tokens only through the
paired-and-unlocked sync path; focused FcmTokenRegistrar JVM tests cover
trimmed-token storage, blank-token rejection, matching-token clear semantics,
and clear-all unpair behavior.
Focused FieldworkViewModel JVM tests now verify paired-but-locked FCM sync does
not register tokens, paired-and-unlocked sync registers queued/current tokens
and clears queued tokens only after success, duplicate queued/current tokens are
registered once, and unpair clears queued FCM tokens.
The Android startup restore path now keeps the encrypted pairing store lazy,
runs saved-pairing restore on `Dispatchers.IO`, and obtains
`FieldworkViewModel` from the lifecycle ViewModel store; focused
FieldworkViewModel JVM coverage verifies construction does not block on
saved-pairing restore and stale startup-restore results cannot override an
explicit pairing.
The npm package-name refresh records that the unscoped `fieldwork` meta package
is operator-owned and no further name-availability checks are needed for it.
Live `verify-npm-registry-state` use is reserved for post-placeholder and
post-release registry-state/provenance verification; the deterministic local
registry fixture still covers current, post-placeholder, post-release,
version-drift, and missing-provenance modes without depending on npm's changing
public state. Bare registry-state invocations now fail closed unless an explicit
release-state expectation flag is provided. This is not proof of platform child
publish rights.
The npm meta-package README is now guarded as a package-page contract:
`scripts/verify-npm-packages.mjs` rejects placeholder availability-check copy and
pins the unscoped `fieldwork` install path, both shipped commands, first-run
commands, mobile capability boundary, four platform package names, dispatcher
fallback, WSL2 host scope, encrypted local persistence, and push-payload privacy
copy.
A follow-up local package/relay/performance refresh also passed:
`pnpm test:bun-install`, `pnpm test:relay-tls`, `pnpm test:relay-otlp`,
`node scripts/measure-desktop-performance.mjs`,
`node scripts/verify-npm-packages.mjs --require-binaries`,
`node scripts/publish-npm-packages.mjs --check-ready`, and
`npm pack ./packages/cli --dry-run --json`. The focused relay ownership test
`cargo test -p fieldwork-relay rejects_cross_daemon_token_use` also passed,
verifying the Section 7.3.1 cross-daemon token-use no-ship gate. Bun optional
dependency install compatibility passed across four platform cases on Bun
1.3.13. Relay TLS and OTLP loopback smokes passed; the latest 2026-05-20 aggregate
`pnpm check:local-release -- --with-artifacts --with-runtime`
pass verified the preserved AAB, staged npm binaries, npm publish readiness,
meta-package dry-run pack, local handoff smoke, demo video, site typecheck/build,
Terraform fmt/init/validate, relay TLS/OTLP loopbacks, and desktop performance.
An earlier rerun hit local temp-volume exhaustion while unpacking Cargo registry
files under an isolated temp `HOME`; after removing the generated
`/tmp/fieldwork-target-checks` directory and using the normal Cargo
cache/target paths, the same gate passed without product-code changes. A
follow-up 2026-05-20 `pnpm check:local-release -- --with-runtime` pass verified
the current source tree after the local handoff smoke preserved host
`CARGO_HOME`/`RUSTUP_HOME` and named its subscription/reconnect sessions
explicitly under the daemon duplicate-name rule. The latest performance run
reported CLI median `3.05ms`, p95 `4.10ms`, max `4.12ms`, and daemon
ready-to-handshake median `39.73ms`, p95 `42.70ms`, max `43.84ms` over 25
measured release-build samples; npm binary readiness passed
with staged artifacts; `publish-npm-packages.mjs --check-ready` confirmed the
children-first order `fieldwork-darwin-arm64 -> fieldwork-darwin-x64 ->
fieldwork-linux-arm64 -> fieldwork-linux-x64 -> fieldwork`; and
`npm pack ./packages/cli --dry-run --json` produced the `fieldwork@1.0.0` meta
package with only `LICENSE`, `NOTICE`, `README.md`, `bin/fieldwork`,
`bin/fieldworkd`, `install.js`, and `package.json`. A local token-pattern scan
found no `npm_...` auth-token strings in repository files outside ignored
build/dependency output.
GitHub namespace availability refresh is no longer an agent-owned routine
release activity. The `scripts/check-github-namespace.mjs` refresh path now
requires `--operator-refresh --expect-available`, remains available only for
explicit operator-requested status refreshes, fails closed before network access
without `--operator-refresh`, and is an availability signal rather than a
reservation.
The focused daemon multi-attach test also passed, verifying that two attached
clients on the same PTY both receive the output produced after input is written
through the shared session.
The focused iroh peer-identity test also passed, verifying that pairing rejects
a claimed device node id that differs from the authenticated iroh peer identity.
The raw adb locked-launch refresh installed the default debug APK, launched
`app.fieldwork.android/.MainActivity` in `TotalTime=2078ms`, captured
`/tmp/fieldwork-adb-launch.png`, `/tmp/fieldwork-adb-ui.xml`, app-scoped logcat,
and an empty crash buffer, and verified the locked `Unlock` surface. This is a
debug emulator smoke result only; physical release-device cold-start evidence is
still required for the Section 13 threshold.
A 2026-05-19 raw adb emulator QA refresh installed the default debug APK, launched
with `Status: ok` and `TotalTime=5297ms`, captured
`/tmp/fieldwork-adb-direct-20260519225027/default.png`,
`/tmp/fieldwork-adb-direct-20260519225027/default-ui.xml`,
`/tmp/fieldwork-adb-direct-20260519225027/default-logcat.log`, and an empty
`/tmp/fieldwork-adb-direct-20260519225027/default-crash.log`, and verified the
locked `Unlock` surface. The same direct adb run rebuilt the debug APK with
`FIELDWORK_ANDROID_BIOMETRIC_BYPASS=true` plus debug-only
`FIELDWORK_ANDROID_PAIRING_PAYLOAD`, launched the pair build in
`TotalTime=4589ms`, tapped the UI-tree-derived Pair center `540 1860`, paired
through explicit desktop approval in `pair_flow_ms=1043`, verified the
dashboard showed `bash · fieldwork` and `ANDROID_ADB_DIRECT_READY`, attached the
terminal, sent `fw_android_direct_ok` from the emulator keyboard, captured
`/tmp/fieldwork-adb-direct-pair-20260519225208/before-pair.png`,
`/tmp/fieldwork-adb-direct-pair-20260519225208/sessions.png`,
`/tmp/fieldwork-adb-direct-pair-20260519225208/terminal-before-input.png`,
`/tmp/fieldwork-adb-direct-pair-20260519225208/terminal-after-input.png`, UI
XML, logcat, and an empty crash buffer, and confirmed a separately approved
verifier client saw `android-direct: fw_android_direct_ok` in replayed terminal
bytes. Afterward the default debug APK was rebuilt and reinstalled,
`BuildConfig.java` was checked to contain `FIELDWORK_BIOMETRIC_BYPASS = false`
and `FIELDWORK_DEBUG_PAIRING_PAYLOAD = ""`, the restored default build launched
in `TotalTime=5105ms`,
`/tmp/fieldwork-adb-direct-restore-20260519225316/restored-locked.png` plus
`/tmp/fieldwork-adb-direct-restore-20260519225316/restored-ui.xml` verified the
locked `Unlock` surface again, and the restored crash buffer remained empty.
The 2026-05-20 direct adb restore-fix pass paired through explicit desktop
approval, attached `bash · fieldwork`, sent `android_adb_direct_ping`, verified
`android-direct: android_adb_direct_ping` in
`/tmp/fieldwork-adb-direct-pair-20260519235638/terminal-after-input.png` and
`/tmp/fieldwork-adb-direct-pair-20260519235638/pty-output-after-input.txt`,
then rebuilt a biometric-bypass debug APK with empty
`FIELDWORK_DEBUG_PAIRING_PAYLOAD`. A paired-data force-stop/relaunch completed
with `Status: ok` and `TotalTime=6225ms`, captured
`/tmp/fieldwork-adb-direct-pair-20260519235638/relaunch-restore-fix-sessions.png`
plus UI XML/logcat, and filtered logcat contained
`FieldworkRepository: listSessions returned 1 sessions` with no
`Camera`/`CAMERA`, Fieldwork `FATAL`, or ANR entries after the saved-pairing
restore placeholder fix.
A later 2026-05-20 raw adb pass installed the default debug APK, launched the
locked app in `TotalTime=6766ms`, captured
`/tmp/fieldwork-adb-direct-20260520001909/default-locked.png`, UI XML, app
logcat, and an empty crash buffer, then rebuilt with
`FIELDWORK_ANDROID_BIOMETRIC_BYPASS=true` plus debug-only
`FIELDWORK_ANDROID_PAIRING_PAYLOAD`, paired through explicit desktop approval,
accepted the runtime notification prompt, listed `bash · fieldwork` with
`ANDROID_ADB_MANUAL_READY`, attached the terminal, sent
`android_adb_manual_ok` through `adb shell input text`, and captured
`/tmp/fieldwork-adb-direct-20260520001909/terminal-after-input.png` showing
`ANDROID_ADB_MANUAL_READY`, `android_adb_manual_ok`, and
`android-direct: android_adb_manual_ok`. The app logcat showed
`FieldworkRepository: pair completed` and `FieldworkRepository: listSessions
returned 1 sessions`; crash buffers stayed empty. The default debug APK was
rebuilt/reinstalled afterward, `BuildConfig.java` again contained
`FIELDWORK_BIOMETRIC_BYPASS = false` and
`FIELDWORK_DEBUG_PAIRING_PAYLOAD = ""`, the restored default build launched in
`TotalTime=1371ms`, and
`/tmp/fieldwork-adb-direct-20260520001909/default-restore-locked.png` verified
the locked `Unlock` surface.
A 2026-05-20 direct adb shortcut-dashboard refresh on `Medium_Phone_API_36.1`
used only direct `adb` interaction plus desktop `expect` to verify the new
shortcut workflow. Bare `target/release/fieldwork` created and attached the
auto-named default `claude` session `cupcake`,
`target/release/fieldwork refactoringjob` created and attached the named
shortcut session, `fieldwork new --name shell` created an explicit shell
session, explicit desktop approval completed Android pairing, and
`/tmp/fieldwork-shortcut-adb-clean-51uCRiNt/dashboard.png` plus
`/tmp/fieldwork-shortcut-adb-clean-51uCRiNt/dashboard.xml` showed `cupcake`,
`refactoringjob`, and `shell` with no `No sessions` state. The debug APK was
then restored to `FIELDWORK_BIOMETRIC_BYPASS = false` and
`FIELDWORK_DEBUG_PAIRING_PAYLOAD = ""`.
A later direct adb source-build `fw` shim pass used the first-live-test command
shape without wrapper smoke scripts: bare `fw` created the auto-named default
`claude` session `kazoo`, `fw refactoringjob` created the named shortcut, `fw
new --name shell` created the shell session, explicit desktop approval completed
in `pair_flow_ms=423`, and
`/tmp/fieldwork-fw-direct-pair-20260520152507/dashboard.png` plus
`/tmp/fieldwork-fw-direct-pair-20260520152507/after-pair.xml` showed `kazoo`,
`refactoringjob`, and `shell` with no `No sessions` state. App logcat showed
`FieldworkRepository: pair completed` and `FieldworkRepository: listSessions returned 3 sessions`;
`/tmp/fieldwork-fw-direct-pair-20260520152507/dashboard-crash.log` was empty;
and the debug APK was restored to `FIELDWORK_BIOMETRIC_BYPASS = false` and
`FIELDWORK_DEBUG_PAIRING_PAYLOAD = ""`.
A 2026-05-20 direct locked-launch refresh on a freshly booted `Medium_Phone_API_36.1` emulator
installed the default debug APK, launched with `Status: ok`,
`LaunchState: COLD`, and `TotalTime=1919ms`, captured
`/tmp/fieldwork-adb-direct-20260520092447/default-locked.png`,
`/tmp/fieldwork-adb-direct-20260520092447/default-ui.xml`,
`/tmp/fieldwork-adb-direct-20260520092447/default-logcat.log`,
`/tmp/fieldwork-adb-direct-20260520092447/default-app-pid-logcat.log`, and an
empty `/tmp/fieldwork-adb-direct-20260520092447/default-crash.log`, verified a
1080x2400 screenshot plus `text="Unlock"` in the UI dump, and found no Fieldwork `FATAL EXCEPTION` or ANR log entries.
The generated UniFFI binding refresh passed after verifying the Android Kotlin
binding exposes the v1 pair/list/subscribe/attach/input/resize/detach and
push-token API, rejects generated mobile create/kill/session-command APIs, and
verifies Android Gradle, Android Rust build-script, iOS build-script, Xcode
generated Swift, and xcframework wiring.
The release-workflow secret hygiene refresh also passed after verifying
`release-rust.yml` preflights Apple signing/notarization secrets before Darwin
toolchain setup and release build. `release-rust.yml` decodes Apple signing/notarization assets under
`RUNNER_TEMP` with `0600` permissions and cleanup, `release-ios.yml` keeps App
Store Connect upload JSON outside the repository workspace and removes signing
and upload assets. `release-android.yml` preflights Sentry/Firebase/signing/Play
secrets before toolchain setup and mobile build. `release-android.yml` removes generated Firebase/signing
files in an `always()` cleanup step. `deploy-relay.yml` removes the decoded
relay SSH key in an `always()` cleanup step.
The release-rust archive checksum step now runs `LC_ALL=C LANG=C shasum -a 256`
so macOS Perl-backed `shasum` is not sensitive to unsupported inherited
`C.UTF-8` locale settings.
The daemon service preflight refresh passed focused `fieldwork-cli` service
tests and targeted clippy after narrowing the macOS Gatekeeper assessment to
`fieldwork daemon install`/`restart` only. Direct daemon auto-spawn still uses
the colocated `fieldworkd` path without `spctl`, preserving source-build and
dispatcher fallback behavior. A read-only local check,
`spctl --assess --type execute target/release/fieldworkd`, currently reports
`target/release/fieldworkd: rejected`, matching the signed/notarized artifact
blocker.
The PTY reconnect protocol refresh also passed focused daemon, mobile-core, and
protocol tests after making `Attached.seq` and `Output.seq` consistently mean
the byte offset immediately after the bytes carried in that frame. The focused
mobile-core stream tests now cover
`stream_output_advances_mobile_reconnect_offset_without_decoding_bytes`,
`yes_head_10000_scale_stream_delivers_all_bytes_without_offset_drift`, and
`lag_event_notifies_native_ui_and_stops_for_resync`, verifying raw PTY byte
delivery without UTF-8 decoding, high-volume `yes | head -10000`-scale byte delivery without dropped bytes or offset drift, reconnect offset advancement to
live `Output.seq`, and single `Lag` delivery before reattach/resync. The mobile
privacy verifier now also pins iOS raw `Data` delivery plus SwiftTerm raw
byte-array rendering, service-backed `lastSeenSeq` lag reattach wiring, Android
raw `ByteArray` delivery to termlib, rejects Android terminal-output string
decoding, and checks repository-backed `lastSeenSeq` lag reattach wiring. The daemon
persistence refresh passed after pinning local `redb` storage to private `0700`
parent directories, `0600` database files, symlink rejection for persistence
directories and database files, and encrypted device-registry rows plus hashed device row keys in separate
production-like `sessions.redb`/`devices.redb` layouts. The relay provider-payload refresh passed after
making APNs/FCM tests assert exact outbound JSON key sets, fixed alert copy, and
hash-only event data. The relay stale-token refresh passed after verifying APNs
BadDeviceToken stale-token pruning from memory and SQLite, forbidden reuse after relay restart, and FCM UNREGISTERED stale-token signal parsing. The relay
token-retention refresh passed after verifying 90-day no-use push-token pruning
from memory and SQLite, restart-time pruning, and accepted-push last-used timestamp refresh. The daemon-service hardening refresh now rejects service
installation when the colocated `fieldworkd` path is absent, a directory, or a
non-executable file, and it exercises the actual `service-manager` rendering
path with fake `launchctl`/`systemctl` so LaunchAgent `KeepAlive` and systemd
`Restart=on-failure` output stay pinned without installing a real service; the focused CLI service tests, CLI clippy, daemon-service
verifier, and release-audit verifier passed after that change. The npm
distribution refresh now exposes `fieldwork`, the shorter `fw` alias, and
`fieldworkd` from the meta package, covers dispatcher fallback for the CLI alias
and daemon commands, verifies the packed meta tarball includes both executable dispatcher files, and covers the no-subcommand smart default parser path for
`fieldwork`/`fw`, the `fw <name>` named-session fast path, and `fieldwork new
--name <name> [cmd...]` for explicitly named arbitrary-command PTYs. The no-name
default create path now generates short one-word names and stores them in the
daemon session summary that mobile dashboards already render; daemon IPC rejects
duplicate session names so shortcut resolution stays unambiguous. The relay push privacy
refresh now validates `session_id_hash` and `session_name_hash` as lowercase
64-character hex strings and rejects `last_line`, command, path, and session-name
free-text payload fields. Mobile notification ingress now mirrors that contract
by rejecting uppercase or non-hex `session_id_hash` values before routing a tap,
with focused Android JVM unit coverage for the hash validator. The daemon push
refresh also verifies `hash_for_push` produces lowercase SHA-256 hex and that
the worker submits lowercase 64-character hex `session_id_hash` and
`session_name_hash` values before the relay boundary.

## Post-Cleanup iOS Verification

After generated Cargo build output was cleaned on 2026-05-18, while retaining
the current Android release AAB evidence, the local iOS/download pass completed
with:

```sh
bash -n scripts/check-ios-prereqs.sh
bash -n apps/ios/scripts/build-rust.sh
node scripts/test-ios-prereqs.mjs
node --check scripts/verify-mobile-privacy.mjs
node --check scripts/verify-store-privacy.mjs
plutil -lint apps/ios/Fieldwork.xcodeproj/project.pbxproj apps/ios/Resources/Info.plist apps/ios/Resources/Fieldwork.entitlements
swiftc -parse -target arm64-apple-macosx15.0 $(find apps/ios/Sources/App apps/ios/Sources/Core apps/ios/Sources/Features apps/ios/Sources/UI -name '*.swift')
pnpm check:mobile-privacy
pnpm check:store-privacy
pnpm check:ios-prereqs
apps/ios/scripts/build-rust.sh
scripts/check-ios-prereqs.sh --download-xcode
xcodes list --data-source xcodeReleases
```

Observed results:

- `bash -n scripts/check-ios-prereqs.sh`: passed.
- `bash -n apps/ios/scripts/build-rust.sh`: passed.
- `node scripts/test-ios-prereqs.mjs`: passed. The iOS prereq edge-case test passed for missing `.xcode-version`, exact selected-Xcode comparison, and floored 70 GiB download headroom.
- `node --check scripts/verify-mobile-privacy.mjs`: passed.
- `node --check scripts/verify-store-privacy.mjs`: passed.
- `plutil -lint` for the iOS project, Info.plist, and entitlements: passed.
- `swiftc -parse` for all iOS App/Core/Features/UI Swift sources: passed.
- `pnpm check:mobile-privacy`: passed, including static verification of the
  exact SwiftTerm 1.13.0 and sentry-cocoa 9.13.0 Xcode/SPM pins, the explicit
  iOS QR camera authorization path, the iOS raw-output revision guard that
  keeps SwiftTerm delivery independent of UTF-8 fallback decoding, and the
  SwiftTerm raw byte-array renderer guard.
- `pnpm check:store-privacy`: passed, verifying the App Store/Play answer sheet
  against the mobile manifests, native notification handlers, and Sentry
  defaults.
- `pnpm check:ios-prereqs`: failed with the expected 3 local Xcode failures:
  full Xcode is not selected, `iphoneos` SDK is unavailable, and
  `iphonesimulator` SDK is unavailable.
  The latest run reports that `~/Downloads` has at least 70 GiB free, satisfying
  the repo's Xcode download/expansion floor. The failure output now prints
  the repo-owned Xcode download, install, `xcode-select`, first-launch, rerun,
  and `apps/ios/scripts/build-rust.sh` recovery path.
- `apps/ios/scripts/build-rust.sh`: failed at the same prereq check before
  invoking Cargo, so missing Xcode/SDKs now produce the actionable repo-owned
  diagnostic instead of a later dependency build-script failure.
- `scripts/check-ios-prereqs.sh --download-xcode`: failed with the expected
  Apple Developer authentication/access blocker after invoking
  `xcodes download 16.3` with the `xcodeReleases` data source; the command
  reported a missing Apple ID/password and no Xcode `.xip` was written.
- `xcodes list --data-source xcodeReleases`: confirmed Xcode `16.3 (16E140)`
  and Xcode 26.x releases through `26.5 (17F42)`.

The same post-clean refresh also reran the lightweight static/package gates:

```sh
pnpm check:npm-packages
pnpm check:changesets
pnpm check:oss-notices
pnpm check:telemetry-privacy
pnpm check:store-privacy
pnpm check:secret-boundaries
pnpm check:v1-boundary
pnpm check:release-audit
pnpm check:release-workflows
pnpm check:relay-provider-clients
pnpm check:daemon-service
pnpm check:daemon-resize
pnpm check:infra-scaffold
pnpm check:infra-terraform
pnpm test:ios-prereqs
pnpm test:relay-tls
pnpm check:android-aab
pnpm test:npm-dispatcher
pnpm test:release-artifacts
pnpm test:npm-publish-plan
pnpm test:npm-artifacts
pnpm test:bun-install
```

Observed results: all passed. `pnpm check:changesets` verifies the Changesets
fixed group against the actual five-package npm workspace without requiring a
live GitHub token. After staging local desktop release binaries into the npm
platform packages and building Android mobile-core release artifacts, the
secret-boundary verifier scanned 32 non-relay artifacts across package bins and
release target outputs for relay-only credentials and npm auth-token patterns,
while also rejecting committed npm token strings and `.npmrc` files;
`release-rust.yml` still runs the same verifier after real release binaries are
built. The current retained-artifact set includes staged desktop/npm binaries
plus debug/release CLI and mobile-core outputs; the latest
`pnpm check:secret-boundaries` scan covered 24 retained non-relay artifacts and
still passed. The verifier now streams artifact scans instead of materializing
large native binaries as one string, and its self-test covers npm token and
relay credential literals split across chunk boundaries.
`pnpm check:ios-prereqs` now reports at least 70 GiB free in `~/Downloads`.

The daemon resize invariant refresh after the iOS/download pass also completed
locally with:

```sh
node --check scripts/verify-daemon-resize.mjs
pnpm check:daemon-resize
cargo fmt --check
cargo test -p fieldwork-daemon viewport_tests
cargo clippy -p fieldwork-daemon -- -D warnings
pnpm check:release-workflows
pnpm check:daemon-service
pnpm check:v1-boundary
pnpm check:npm-packages
ruby -e 'require "yaml"; Dir[".github/workflows/*.yml"].sort.each { |path| YAML.load_file(path) }; YAML.load_file(".github/dependabot.yml"); YAML.load_file(".pre-commit-config.yaml"); puts "workflow yaml ok"'
```

Observed results: all passed. `viewport_tests` ran 3 focused daemon tests for
minimum attached viewport selection, empty detach state, and single-client resize
target selection. The public API rustdoc gate was also tightened so
`fieldwork-protocol` and `fieldwork-mobile-core` deny `missing_docs` directly;
`cargo clippy -p fieldwork-protocol -p fieldwork-mobile-core -- -D warnings`
passed after that change. `cargo test -p fieldwork-protocol` now passes 17
tests, including focused generated `SessionId`/`ClientId` UUIDv7 checks,
`now_ms()` UTC Unix-millisecond window checks, the two `insta` bincode wire
round-trip snapshot suites, focused all-message MessagePack client/server frame
round-trip tests, and negative bincode frame tests for incomplete and oversized
frames plus the bincode 2 legacy-layout and trailing-payload rejection tests.
This refresh preserves the all-message MessagePack client/server frame round-trip tests evidence. The PTY ring
buffer contract was corrected from "wraparound" to monotonic `u64` offsets that
force cold resync at the impossible-in-practice overflow edge, with
`cargo test -p fieldwork-daemon seq_overflow_forces_cold_resync_window` passing
the focused no-wrap regression test.

## Last Full Local Verification Before Target Cleanup

The last full local verification pass before `target/` cleanup completed with:

```sh
cargo fmt --check
cargo clippy --workspace -- -D warnings
cargo nextest run --workspace
cargo test --workspace
cargo test -p fieldwork-daemon
cargo test -p fieldwork-daemon logging::tests
cargo test --workspace --doc
cargo deny check
cargo audit
ruby -e 'require "yaml"; Dir[".github/workflows/*.yml"].sort.each { |path| YAML.load_file(path) }; YAML.load_file(".github/dependabot.yml"); YAML.load_file(".pre-commit-config.yaml"); puts "workflow yaml ok"'
swiftc -parse -target arm64-apple-macosx15.0 $(find apps/ios/Sources/App apps/ios/Sources/Core apps/ios/Sources/Features apps/ios/Sources/UI -name '*.swift')
apps/android/gradlew --no-daemon :app:compileDebugKotlin
node scripts/verify-npm-packages.mjs
node scripts/generate-oss-notices.mjs --check
node scripts/verify-secret-boundaries.mjs
node scripts/verify-mobile-privacy.mjs
node scripts/verify-store-privacy.mjs
pnpm check:mobile-privacy
pnpm check:store-privacy
pnpm check:android-aab
node scripts/verify-telemetry-privacy.mjs
node scripts/verify-v1-boundary.mjs
node scripts/verify-uniffi-bindings.mjs
node scripts/verify-release-workflows.mjs
node scripts/verify-relay-provider-clients.mjs
cargo test -p fieldwork-cli service
node scripts/verify-daemon-service.mjs
node scripts/verify-daemon-resize.mjs
node scripts/verify-infra-scaffold.mjs
scripts/smoke-relay-tls-loopback.sh
node scripts/test-npm-dispatcher.mjs
node scripts/test-release-artifacts.mjs
node scripts/test-npm-registry-state.mjs
node scripts/test-npm-publish-plan.mjs
node scripts/test-npm-artifact-pack.mjs
node scripts/test-bun-install.mjs
node scripts/smoke-relay-otlp-loopback.mjs
cargo build --release --target aarch64-apple-darwin -p fieldwork-cli -p fieldwork-daemon -p fieldwork-relay
cargo build --release --target x86_64-apple-darwin -p fieldwork-cli -p fieldwork-daemon -p fieldwork-relay
cargo zigbuild --release --target x86_64-unknown-linux-gnu -p fieldwork-cli -p fieldwork-daemon -p fieldwork-relay
cargo zigbuild --release --target aarch64-unknown-linux-gnu -p fieldwork-cli -p fieldwork-daemon -p fieldwork-relay
terraform fmt -check -recursive infra/oracle/terraform
terraform -chdir=infra/oracle/terraform init -backend=false
terraform -chdir=infra/oracle/terraform validate
node scripts/measure-desktop-performance.mjs
pnpm check:site
pnpm test:local-handoff
```

Observed results:

- `cargo nextest run --workspace`: 157 tests passed.
- `cargo test --workspace`: 157 unit/integration tests passed, plus doctests.
- `cargo test -p fieldwork-daemon`: 68 daemon tests passed, including the
  local Sentry panic-capture test transport smoke, seven-day daemon-log pruning,
  and the real `vim /etc/hosts` stale-attach snapshot rehydration gate.
- `cargo deny check`: exited successfully with `advisories ok, bans ok,
  licenses ok, sources ok`; duplicate-crate findings were warnings only.
- `cargo audit`: exited successfully with allowed warnings only (`adler`,
  `bincode`, `paste`, `lru`), as documented in `docs/DEVELOPMENT.md`.
  Follow-up dependency inspection confirmed `lru 0.12.5` is pulled only through
  `tattoy-wezterm-term`, `cargo update -p lru@0.12.5 --dry-run` found no
  compatible lockfile move, Fieldwork does not call `lru::IterMut` directly, and
  `scripts/verify-rust-workspace.mjs` rejects direct `lru` dependencies plus
  `lru::` source paths while the advisory is allowlisted only as a transitive
  terminal-state dependency.
- Workflow YAML parsing passed locally and is enforced by the CI workflow-static
  job.
- Npm package checks passed for metadata, OSS notices, secret boundaries,
  mobile privacy defaults, telemetry privacy wiring, release workflow fail-closed
  checks, daemon service scaffold checks, dispatcher fallback, release archive
  checksum plus Sigstore media-type, transparency-log, DSSE
  envelope/signature, in-toto payload, SLSA `predicateType`, subject-name,
  subject-digest, official-repository `buildType`, package, target, requested
  release-tag, and SHA-256 external-parameter validation, cosign release-rust
  identity pinning,
  children-first provenance publish plan, post-publish registry-state and
  provenance verification, artifact preparation, and dry-run package packing.
- Cross-target desktop release builds passed on 2026-05-19 for `fieldwork`, `fieldworkd`, and
  `fieldwork-relay` on `aarch64-apple-darwin`, `x86_64-apple-darwin`,
  `x86_64-unknown-linux-gnu`, and `aarch64-unknown-linux-gnu`; `file`
  identified the expected Mach-O arm64/x86_64 and ELF x86-64/aarch64 binaries.
- Oracle relay provisioning scaffold is present under `infra/oracle`: Terraform
  fmt/init/validate passed against the OCI provider, `provision-region.sh`
  supplies the A1-capacity retry wrapper, and `pnpm check:infra-scaffold`
  verifies the Terraform/Ansible/deploy handoff contract.
- Relay OTLP loopback smoke passed: local collector received an
  `application/x-protobuf` `/v1/traces` POST for `/v1/version`, and the exported
  protobuf body did not contain injected terminal/session/token sentinel strings.
- Desktop performance passed after one explicit warm-up sample, with CLI median
  `3.05ms`, p95 `4.10ms`, max `4.12ms`, and daemon ready-to-handshake median
  `39.73ms`, p95 `42.70ms`, max `43.84ms` over 25 measured release-build
  samples.
- Site check/build produced 5 static pages with no Astro diagnostics.
- Agent-browser screenshot smoke captured `/`, `/install`, `/architecture`,
  `/protocol`, and `/privacy`, with expected headings/navigation in snapshots
  and empty console output.
- Demo video generation passed locally with `pnpm render:demo-video`, producing
  `docs/assets/fieldwork-demo-v1.mp4`; `pnpm check:demo-video` verified the
  H.264 1920x1080 artifact and approximately 60-second duration.
- Local handoff smoke passed with `pnpm test:local-handoff` after clearing
  reproducible debug/mobile Rust build output to recover disk space, then
  removing the regenerated repo-local `target/debug` after the run. Simulated
  pair duration was `3s`: default
  `claude`, `bash`, `vim`, and desktop-created subscribed `bash` sessions were
  created; the simulated phone first verified protocol-mismatch rejection on the
  iroh transport, observed the subscribed session, attached, sent input, avoided
  cross-session output leakage, rejected mobile create/kill and agent-state-event
  attempts, rejected a revoked device identity, and saw last-known sessions
  restored after daemon restart.
- Focused daemon tests now verify removing a device with a saved APNs token
  enqueues `UnregisterToken`, and the push worker sends signed
  `/v1/push/unregister-token` without terminal-content leakage.
- Android release bundle was regenerated locally with
  `apps/android/scripts/build-rust.sh` and
  `apps/android/gradlew --no-daemon bundleRelease`; `pnpm check:android-aab`
  passed for `arm64-v8a`, `armeabi-v7a`, and `x86_64`
  `libfieldwork_mobile_core.so`, with no accidental 32-bit x86 Fieldwork core
  and with the packaged protobuf manifest privacy surface checked for required
  Firebase/Sentry opt-out metadata plus forbidden content/permission strings.
  Current AAB: `54M`, SHA-256
  `8ab0548931a2a6a378d54646bc0d6932bfce941c499d07d1218306bd7e4a7365`.
  `pnpm check:android-aab` now runs the verifier with `--expect-unsigned`, and
  `node scripts/test-android-aab-verifier.mjs` covers synthetic unsigned and
  signed AABs, including rejection of signature entries under
  `--expect-unsigned`.
  `node scripts/test-android-pair-button-picker.mjs` pins the current Compose
  accessibility tree where the full-width Pair button is textless, so adb smokes
  locate it from the `Pairing payload` field and the first enabled full-width
  clickable control below it rather than a brittle visible-text match.
  Android Studio's bundled `jarsigner` reports `jar is unsigned` for the local
  bundle. The release workflow verifier rejects using
  `node scripts/verify-android-aab.mjs --expect-unsigned` in
  `release-android.yml`; signed release verification remains the separate
  external Play-keystore gate.
- Android terminal controller source now records the latest mobile `lastSeenSeq`,
  destroys a broken attachment, and reattaches/restarts the byte subscription
  after an attached-stream error. Focused JVM coverage verifies the replacement
  attachment starts from the latest offset, which is a local source-level
  substitute for the network-change reconnect path until a physical-device
  timing run is available.
- Android emulator substitute still does not close the physical runtime gates,
  but the local debug evidence is now repeatable. After wiping the unstable API
  36.1 Play Store AVD data, `pnpm test:android-debug-smoke` installed the debug
  app, launched `app.fieldwork.android/.MainActivity` with `TotalTime=2467ms`,
  confirmed the locked `Unlock` surface through `uiautomator`, found no
  Fieldwork crash-buffer entry, and verified a nonblank 1080x2400 `screencap`
  with 14391/14400 nonblack samples.
  `FIELDWORK_ANDROID_BIOMETRIC_BYPASS=true pnpm test:android-debug-smoke`
  compiles a debug-build-only bypass guarded by `BuildConfig.DEBUG` so emulator
  QA can reach the unlocked pairing/bottom-navigation UI when no biometric is
  enrolled; release builds hardcode it off. `pnpm test:android-emulator-pair`
  uses that guard plus debug-only `FIELDWORK_ANDROID_PAIRING_PAYLOAD` to pair the
  real Android app with an isolated local release daemon, measure the debug-app
  Pair tap through explicit desktop approval completion, fail above the local
  15-second emulator bound, verify a desktop-created session appears, open the
  terminal, background and foreground the app, send mobile-originated input into
  the PTY, and attach a separately approved verifier client to confirm the
  Android-sent output appears in replayed terminal bytes.
  Latest default aggregate run passed on `emulator-5554` with
  `pair_flow_ms=2234`.
  Physical QR camera pair-flow timing remains a release-device gate.
  `pnpm test:android-emulator-background-replay`
  backgrounds an attached terminal while the PTY emits
  `ANDROID_BACKGROUND_REPLAY_OUTPUT`, foregrounds back to `Attached`, sends
  `after_background_ok`, and confirms the background output plus
  post-foreground input through a separately approved verifier; latest local run
  on 2026-05-19 passed on `emulator-5554`.
  `pnpm test:android-emulator-flood` renders a
  `yes | head -10000`-scale stream in the actual Android terminal view, checks a
  flood screenshot nonblank, and confirms `ANDROID_EMULATOR_FLOOD` output through a
  separately approved replay verifier; latest default aggregate run reported
  8440/14400 nonblack screenshot samples.
  `pnpm test:android-emulator-multisession` opens
  three desktop-created sessions (`fwm_a`, `fwm_b`, `fwm_c`), switches among all
  three in the app, sends Android-originated input to each, and verifies
  host-side per-session logs so `multi_a_ok`, `multi_b_ok`, and `multi_c_ok`
  land only in their selected PTYs; latest local run on 2026-05-19 passed on
  `emulator-5554`.
  `pnpm test:android-emulator-session-subscription` pairs with no pre-existing
  sessions, observes the empty dashboard, creates `fw_subscribe_session` from
  the desktop CLI, verifies the subscribed dashboard receives it within the
  local 8-second emulator bound, opens it, sends `subscription_attach_ok`, and
  confirms the PTY receives that Android-originated input; latest default
  aggregate run passed on `emulator-5554` with `visible_ms=3318`.
  `pnpm test:android-emulator-restart-restore` pairs the actual Android app
  with an isolated release daemon, creates an intentionally completed
  `fw_restart_session`, waits for `ANDROID_RESTART_SCROLLBACK` to persist
  through the session-exit path, restarts the daemon with the same temp state
  and deterministic node identity, relaunches the app from saved pairing,
  verifies the restored dashboard still lists `fw_restart_session`, opens the
  restored terminal, and confirms `ANDROID_RESTART_SCROLLBACK` is replayed
  through a separately approved verifier; latest local run on 2026-05-19 passed
  on `emulator-5554`.
  `pnpm test:android-emulator-reconnect` uses
  emulator airplane mode to cut network while the Android app is attached,
  verifies `after_reconnect_ok` reaches the desktop PTY after restore, and
  confirms `ANDROID_RECONNECT_OFFLINE_OUTPUT` remains replayable through a
  separately approved verifier; latest local run on 2026-05-19 passed on
  `emulator-5554`. `pnpm test:android-emulator-notification-tap`
  computes a real desktop session's lowercase `session_id_hash`, verifies an
  uppercase invalid hash does not route, opens the target terminal through the
  same hash-only activity intent used by notification taps, and confirms
  `notify_tap_ok` lands only in the target PTY; latest local run on 2026-05-19
  passed on `emulator-5554`. The same Play Store image still emits
  background Google-service ANRs, so physical release-device evidence
  remains required for cold start, terminal flood rendering, real provider notification delivery/taps,
  biometric prompt behavior, foreground/background reconnect, network-change
  reconnect, and 30-minute Android terminal dogfood.

## Release Sign-Off Rule

Do not mark v1 complete until every unchecked gate in `PLAN.md`, including
Section 13 and Appendix B gates, has real evidence. Local substitutes are
acceptable for development confidence, but they do not close physical-device,
provider, signing, publish, operator-reservation, or hosted infrastructure
gates.
