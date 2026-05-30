# Fieldwork v1 Release Audit

Last updated: 2026-05-30

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
  `scripts/create-release-artifacts-evidence-dir.mjs` now scaffolds sanitized
  capture for the real `release-rust.yml` run, GitHub Release asset metadata,
  downloaded artifact digests, and cosign-backed verifier output, while
  `scripts/verify-release-artifacts-evidence.mjs` verifies that evidence without
  creating artifacts or running GitHub workflows.
- The npm namespace bootstrap is complete: the unscoped `fieldwork` meta package
  is operator-owned, placeholder `0.0.0` publishes reserve all four platform
  children, and `NPM_TOKEN` is set on `fieldwork-app/fieldwork`. The remaining
  npm gate is the real Changesets-managed `1.0.0` release publish, followed by
  `--expect-platform-published` and
  `--expect-latest-version=1.0.0 --expect-provenance` registry-state checks for
  post-publish dist-tag and npm SLSA provenance verification. The npm release
  evidence contract is now local: `scripts/create-npm-release-evidence-dir.mjs`
  scaffolds sanitized capture, `scripts/verify-npm-release-evidence.mjs`
  verifies the deterministic publish plan, release-npm workflow success,
  children-first publish log, registry-state/provenance output, and package
  metadata for exactly the five unscoped v1 packages, rejects legacy scoped
  `@fieldwork/*` package names and extra unscoped Fieldwork package names in
  release evidence, and the self-tests run in local release/CI without querying
  package availability or publishing packages.
- macOS desktop npm trust for release artifacts; the local verifier now fails
  closed until Darwin `fieldwork` and `fieldworkd` are executable, carry an
  ad-hoc or Developer ID signature, and have no `com.apple.quarantine` xattr.
  The npm postinstall path now performs the Darwin-only ad-hoc signing and
  targeted quarantine cleanup after copying platform binaries, and `fw doctor`
  reports `npm/ad-hoc/not-notarized` when the colocated CLI/daemon satisfy that
  trust mode. The local npm artifact staging helper applies the same ad-hoc
  signing/quarantine cleanup to staged Darwin platform-package bins before
  running `scripts/verify-macos-signing.mjs`, then emits local platform
  tarballs under `target/local-npm-artifacts` or
  `FIELDWORK_LOCAL_NPM_ARCHIVE_DIR` without placing candidate files in the real
  `artifacts/` release-evidence tree.
  `scripts/create-macos-signing-evidence-dir.mjs` now scaffolds the
  Darwin-specific npm-trust capture directory, while
  `scripts/verify-macos-signing-evidence.mjs` verifies installed unscoped npm
  package identity, per-Darwin-package checksum or npm integrity verification
  plus npm/Sigstore provenance verification for `fieldwork-darwin-arm64` and
  `fieldwork-darwin-x64`, `verify-macos-signing`, `codesign`, and `xattr`
  output for both Darwin CLI and daemon artifacts without signing anything
  locally, running GitHub workflows, or fabricating passing evidence.
  Optional Developer ID/notarization evidence is additive only and not required
  for desktop npm live testing or release.
- Full local Xcode installation for iOS development builds, plus Apple
  Distribution, provisioning, App Store Connect API keys, and TestFlight/App
  Store account access for release builds.
- Android release keystore and Play Console account access. Firebase project/app
  config exists and `ANDROID_GOOGLE_SERVICES_JSON` is already set as a GitHub
  Actions secret.
- APNs `.p8` and physical iOS/Android devices for provider push verification.
  The Android Firebase project/app and GitHub `ANDROID_GOOGLE_SERVICES_JSON`
  secret are set, and the AWS live-test bridge has the relay-only FCM service
  account installed, but 10/10 physical-device delivery evidence is still
  required before any provider-push box can be checked.
- Honeycomb account/API key for hosted trace receipt verification; the local
  `docs/RELAY_HONEYCOMB.md` runbook and verifier fixtures define the required
  evidence shape before that gate can be checked.
- Oracle ARM relay hosts, DNS/domain ownership, SSH secrets, and Cloudflare
  Pages credentials for production deploys. Oracle account access is unblocked,
  the `fieldwork` compartment exists, the relay deploy SSH key is prepared, and
  `RELAY_SSH_KEY` is set. Terraform has created the Mumbai relay network
  resources, but the `VM.Standard.A1.Flex` instance launch is currently blocked
  by OCI `Out of host capacity` in all three fault domains of the only
  available Mumbai AD. Subscribing `ap-hyderabad-1` returned
  `TenantCapacityExceeded`, so this tenancy remains limited to Mumbai until
  Oracle raises the region-subscription limit. The domain
  status script remains operator-owned: domain status script is reserved for
  explicit operator-requested refreshes only; it is not an ownership check or a
  routine agent gate.
- AWS Lightsail live-test bridge exists but does not close the production relay
  gate: instance `relay` is running in `ap-south-1a` on bundle `nano_3_1`,
  static IP `3.7.208.153`, SSH restricted to the current operator IP, and
  `80/tcp`, `443/tcp`, `8443/tcp`, and `7842/udp` open. The cross-built
  `fieldwork-relay` binary is installed as `fieldwork-control-plane.service`
  and `http://3.7.208.153:8443/healthz` plus `/v1/version` are reachable. AWS
  budget `fieldwork-relay-lightsail` is filtered to Amazon Lightsail with a
  `$10/month` limit and 80%, 100%, and forecasted 100% email alerts. Final
  production sign-off still requires operator DNS/TLS, iroh fallback verification,
  APNs/Honeycomb credentials, physical-device provider evidence, and Oracle or
  chosen production relay hosts. The bridge now has
  `FIELDWORK_FCM_SERVICE_ACCOUNT_PATH` pointing at a relay-only
  `/etc/fieldwork/secrets/fcm-service-account.json` file with
  `0440 root:fieldwork-relay` permissions for Android/FCM live testing. A hosted
  rendezvous smoke on 2026-05-29 passed against
  `http://3.7.208.153:8443`: `pnpm test:hosted-relay` started an isolated local
  daemon, published a pairing code to the AWS relay, resolved the code through
  `fieldwork pair-test --code`, required desktop approval, attached the simulated
  phone to a daemon-owned PTY session, sent input, and observed
  `HOSTED_RELAY_RESULT_OK`.
- Appendix B reservations that require account ownership or user action:
  `@fieldworkdev` social handle reservation and the calendar/time block for the
  launch plan. GitHub org/repo creation is complete.
- Physical-device checks for biometric gating, QR scan timing, mobile cold
  start, terminal flood rendering, foreground/background reconnect, network
  change reconnect, notification taps, and 30-minute Android terminal dogfood.
- Real macOS launchd and sleep/wake survival checks for `fieldworkd` after the
  daemon is installed from the verified npm/ad-hoc Darwin artifact. macOS sleep/wake gates still need an npm-trust-prepared artifact. The 2026-05-30
  local launchd smoke retained `/tmp/fwld.i7Ckgt/evidence`, restored socket
  reachability after `pkill -KILL fieldworkd` in `restart_ms=369`, and replayed
  `MACOS_KILL_SCROLLBACK_BEFORE` after restart, but it is not a substitute for
  the formal sleep/wake evidence contract because `sleep-wake.txt` and
  `sleep-replay.txt` were not captured.
- Local completion-audit guard: `scripts/verify-release-audit.mjs` classifies
  every unchecked `PLAN.md` gate by blocker class (`ios-xcode`, `signing`,
  `publish`, `provider`, `physical-device`, `store-console`, or `operator`).
  Any new unchecked gate that is not added to that classified allowlist fails the
  audit instead of silently becoming release debt.
- Current unchecked `PLAN.md` gate inventory: 33 total (`ios-xcode`: 1,
  `signing`: 4, `publish`: 3, `provider`: 4, `physical-device`: 14,
  `store-console`: 2, `operator`: 5). The release-audit verifier recomputes
  this inventory from `PLAN.md` so count drift fails locally.
  `pnpm check:release-audit:list` (or
  `node scripts/verify-release-audit.mjs --list-unchecked`) prints the same
  classified gate list for operator handoff, and `pnpm test:release-audit-list`
  pins the grouped list output.
- A local API 36.1 Android emulator is only a debug substitute for those
  runtime/performance gates, not release-device evidence. `pnpm test:android-emulator`
  is now the aggregate direct-adb substitute suite for the locked debug launch, pair,
  session-subscription, background-replay, restart-restore, flood,
  multisession, reconnect, and notification-tap smokes. Its `--list` mode
  prints the underlying adb scripts without requiring a device, and normal runs
  retry only locked debug-launch and session-subscription timing outliers once
  with the same strict limits; every other script failure fails closed and
  preserves the captured wrapper output path. The aggregate fails closed unless
  exactly one boot-complete adb device is available or `FIELDWORK_ANDROID_SERIAL`
  selects one. The latest hosted-relay aggregate run on 2026-05-29 passed on
  `emulator-5554`: locked debug launch `TotalTime=6448ms` (below the default
  8000ms limit), pair `pair_flow_ms=1420`, session subscription
  `visible_ms=5493`, flood screenshot 8437/14400 nonblack samples, and
  successful background replay, restart restore, multisession, reconnect, and
  notification tap routing. After wiping the
  unstable Play Store AVD data, `pnpm test:android-debug-smoke` installed the
  debug app, launched `app.fieldwork.android/.MainActivity` with `am start -W`
  `TotalTime=2467ms`, confirmed the locked `Unlock` surface through
  `uiautomator`, found no Fieldwork crash-buffer entry, and verified a nonblank
  1080x2400 `screencap` with 14391/14400 nonblack samples.
  Each focused smoke clears main logcat plus the crash buffer before collecting
  current-run crash evidence; the final crash/ANR logcat rejection stays
  Fieldwork-scoped because Play Store AVDs can emit unrelated Google-service
  ANRs.
  `FIELDWORK_ANDROID_BIOMETRIC_BYPASS=true pnpm test:android-debug-smoke`
  exists only for debug emulator QA on AVDs without enrolled biometrics; the
  bypass is debug-build-only, requires `BuildConfig.DEBUG`, and release builds
  hardcode it off. `pnpm test:android-emulator-background-replay` backgrounds an
  attached terminal while the PTY emits `ANDROID_BACKGROUND_REPLAY_OUTPUT`,
  foregrounds back to `Attached`, sends `after_background_ok`, and confirms the
  background output plus post-foreground input through a separately approved
  verifier; latest local run on 2026-05-19 passed on `emulator-5554`.
  A raw direct adb refresh on 2026-05-29 under
  `/tmp/fieldwork-direct-adb-bg-fix-20260529.Om7Krm/evidence` paired the debug
  app through typed code `R8X09` and explicit desktop approval, attached
  `bg_replay_fix`, sent `before_background_ok`, backgrounded Fieldwork with
  `KEYCODE_HOME`, emitted `ANDROID_BACKGROUND_REPLAY_OUTPUT` from a desktop
  attach while Android was backgrounded, foregrounded the same terminal with HOT
  launch `TotalTime=485ms`, and sent `after_background_ok`. The pre-fix attempt
  exposed a user-visible `transport error: connection lost` dialog from the
  dashboard session-list subscription; Android now retries that background
  subscription quietly and focused `FieldworkViewModel` JVM coverage pins the
  no-alert retry behavior. The patched direct adb run showed `Attached` after
  foreground, no transport dialog in UI dumps, no Fieldwork fatal/ANR logcat
  entries, and an empty crash buffer; the default debug APK was restored and app
  data was cleared afterward.
  `scripts/create-android-background-foreground-evidence-dir.mjs` and the
  Android background/foreground evidence scaffold self-test now cover the
  release-device scaffold for signed release-device replay after app
  backgrounding without fabricating the required PTY replay transcripts or
  timing review.
  `pnpm test:android-emulator-flood` renders a
  `yes | head -10000`-scale stream in the actual Android terminal view, checks a
  flood screenshot nonblank, and confirms `ANDROID_EMULATOR_FLOOD` output through a
  separately approved replay verifier; latest hosted-relay aggregate run
  reported 8437/14400 nonblack screenshot samples.
  `pnpm test:android-emulator-multisession` opens
  three desktop-created sessions (`fwm_a`, `fwm_b`, `fwm_c`), switches among all
  three in the app, sends Android-originated input to each, and verifies
  host-side per-session logs so `multi_a_ok`, `multi_b_ok`, and `multi_c_ok`
  land only in their selected PTYs; latest focused run on 2026-05-29 passed on
  `emulator-5554` after hosted-relay typed-code hardening.
  `scripts/create-android-multisession-evidence-dir.mjs` and the Android multisession evidence scaffold self-test now cover the release-device scaffold for three-session switching with no cross-session marker leakage without fabricating the required per-session replay transcripts.
  `pnpm test:android-emulator-session-subscription` pairs with no pre-existing
  sessions, observes the empty dashboard, creates `fw_subscribe_session` from
  the desktop CLI, verifies the subscribed dashboard receives it within the
  local 8-second emulator bound, opens it, sends `subscription_attach_ok`, and
  confirms the PTY receives that Android-originated input; the smoke now
  recovers Fieldwork foreground before UI dumps and falls back to file-backed
  `uiautomator` dumps when direct streaming hangs. Latest focused run passed on
  `emulator-5554` with `visible_ms=2904`.
  `pnpm test:android-emulator-restart-restore` pairs the debug app with an
  isolated release daemon, creates an intentionally completed
  `fw_restart_session`, persists `ANDROID_RESTART_SCROLLBACK` through the
  session-exit path, restarts the daemon with the same temp state and
  deterministic node identity, relaunches from saved pairing, and verifies the
  restored dashboard and replayed scrollback through a separately approved
  verifier; latest local run on 2026-05-19 passed on `emulator-5554`.
  `scripts/create-android-restart-restore-evidence-dir.mjs` and the Android restart-restore evidence scaffold self-test now cover the release-device scaffold for saved-pairing restore and `ANDROID_RESTART_SCROLLBACK` replay after daemon restart without fabricating the required restored PTY replay transcript. Direct adb restart-restore evidence on 2026-05-19 captured emulator screenshots,
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
  `FIELDWORK_DEBUG_PAIRING_CODE = ""`, launched in `TotalTime=1082ms`,
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
  `FIELDWORK_ANDROID_PAIRING_CODE` injection. The pair build launched in
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
  `FIELDWORK_DEBUG_PAIRING_CODE = ""`, the restored default build launched in
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
  `FIELDWORK_DEBUG_PAIRING_CODE` captured
  `/tmp/fieldwork-adb-direct-pair-20260519235638/relaunch-restore-fix-sessions.png`
  plus UI XML/logcat with `FieldworkRepository: listSessions returned 1
  sessions` and no `Camera`/`CAMERA`, Fieldwork `FATAL`, or ANR entries. A
  later 2026-05-20 raw adb pass installed the default debug APK, launched the
  locked app in `TotalTime=6766ms`, captured
  `/tmp/fieldwork-adb-direct-20260520001909/default-locked.png`, UI XML,
  app-scoped logcat, and an empty crash buffer, then rebuilt with
  `FIELDWORK_ANDROID_BIOMETRIC_BYPASS=true` plus debug-only
  `FIELDWORK_ANDROID_PAIRING_CODE`, paired through explicit desktop
  approval, accepted the runtime notification prompt, listed `bash · fieldwork`
  with `ANDROID_ADB_MANUAL_READY`, attached the terminal, sent
  `android_adb_manual_ok` through `adb shell input text`, and captured
  `/tmp/fieldwork-adb-direct-20260520001909/terminal-after-input.png` showing
  `android-direct: android_adb_manual_ok`. The app logcat showed
  `FieldworkRepository: pair completed` and `FieldworkRepository: listSessions
  returned 1 sessions`; crash buffers stayed empty. The default debug APK was
  then rebuilt/reinstalled, `BuildConfig.java` again contained
  `FIELDWORK_BIOMETRIC_BYPASS = false` and
  `FIELDWORK_DEBUG_PAIRING_CODE = ""`, the restored default build launched in
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
  `FIELDWORK_DEBUG_PAIRING_CODE = ""`, and the restored locked screen at
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
  `FIELDWORK_DEBUG_PAIRING_CODE = ""`.
  A direct adb empty-dashboard refresh then paired an isolated release daemon
  with no pre-existing sessions through explicit desktop approval and captured
  `/tmp/fieldwork-empty-direct-20260520162209/empty-dashboard.png` plus
  `/tmp/fieldwork-empty-direct-20260520162209/empty-dashboard.xml`; the UI dump
  showed `No sessions` and `Create one on your laptop with fw new.`, app logcat
  showed `FieldworkRepository: pair completed` and `FieldworkRepository:
  listSessions returned 0 sessions`, crash buffers were empty, and the restored
  default APK had `FIELDWORK_BIOMETRIC_BYPASS = false`,
  `FIELDWORK_DEBUG_PAIRING_CODE = ""`, and the locked `Unlock` surface at
  `/tmp/fieldwork-empty-direct-20260520162209/default-locked.png`.
  A 2026-05-21 direct adb terminal attach/input fix pass on
  `Medium_Phone_API_36.1` then verified the actual terminal path after moving
  the attached terminal to the app root, hiding the global Sessions/Settings
  bottom navigation while attached, and explicitly focusing termlib's IME target.
  Evidence under `/tmp/fieldwork-adb-terminalfix-live-20260521155139` includes
  `dashboard.png`/XML with `androidfix` and `debug`, `terminal-open.png`/XML
  with the `androidfix` title, `Attached` status, and accessory keys `Esc`,
  `Ctrl`, `Alt`, `Tab`, `|`, `/`, `terminal-after-input.png`/XML after
  `adb shell input text android_terminal_fix_ok`, app logcat, and an empty
  crash buffer. A separately approved verifier client attached to `androidfix`
  and saw `android-direct: android_terminal_fix_ok` in replayed terminal bytes,
  proving emulator keyboard input reached the live PTY. This remains emulator
  substitute evidence only; physical-device biometric, QR-camera, renderer
  dogfood, and release-device runtime gates remain unchecked. The default debug
  APK was then rebuilt/reinstalled, `BuildConfig.java` again contained
  `FIELDWORK_BIOMETRIC_BYPASS = false` and
  `FIELDWORK_DEBUG_PAIRING_CODE = ""`, the restored locked build launched in
  `TotalTime=966ms`, `/tmp/fieldwork-adb-terminalfix-live-20260521155139/default-restore-155738/locked.png`
  plus UI XML verified the locked surface, and the restored crash buffer was
  empty.
  A same-day direct adb TUI attach pass created a daemon-owned `htop` session
  named `tui`, paired the Android app through explicit desktop approval, and
  opened the session from the dashboard. Evidence under
  `/tmp/fieldwork-adb-tui-live-20260521160229` includes `back-dashboard.png`/XML
  showing `tui` as `Working`, `tui-terminal.png`/XML showing `Attached` status,
  termlib-rendered `htop` function-key chrome (`F1Help`, `F2Setup`, `F10Quit`),
  the terminal accessory bar, no global bottom navigation, and the focused
  termlib IME target, plus app logcat and an empty terminal crash buffer. The
  default debug APK was rebuilt/reinstalled afterward with
  `FIELDWORK_BIOMETRIC_BYPASS = false` and
  `FIELDWORK_DEBUG_PAIRING_CODE = ""`; the restored launch landed on the
  locked `Unlock` surface in `TotalTime=3967ms` with screenshot/UI XML/logcat
  under `/tmp/fieldwork-adb-tui-live-20260521160229/default-restore-160932` and
  an empty restored crash buffer.
  A later 2026-05-21 direct adb pair/attach refresh on a freshly rebooted
  `Medium_Phone_API_36.1` emulator installed a debug-only pairing-code build,
  launched it in `TotalTime=1717ms`, paired through explicit desktop approval,
  listed the desktop-created `android-direct` session, attached it, sent
  `fw_direct_20260521_ok` through `adb shell input text`, and captured
  `/tmp/fieldwork-adb-direct-20260521165654/pair4-dashboard.png`,
  `/tmp/fieldwork-adb-direct-20260521165654/pair4-terminal-before-input.png`,
  `/tmp/fieldwork-adb-direct-20260521165654/pair4-terminal-after-input.png`, UI
  XML, logcat, and empty crash buffers. The desktop replay file
  `/tmp/fieldwork-adb-direct-20260521165654/pair-runtime/pty-replay-after-input.txt`
  contains `android-direct: fw_direct_20260521_ok`; app logcat showed
  `FieldworkRepository: pair completed` and `FieldworkRepository: listSessions
  returned 1 sessions`. The debug APK was then rebuilt/reinstalled back to
  `FIELDWORK_BIOMETRIC_BYPASS = false` and
  `FIELDWORK_DEBUG_PAIRING_CODE = ""`, relaunched with `Status: ok`,
  `TotalTime=1862ms`, and the locked
  `Unlock` surface at `/tmp/fieldwork-adb-direct-20260521165654/restore-default-locked.png`.
  A later 2026-05-21 direct adb locked-launch refresh under
  `/tmp/fieldwork-adb-direct-20260521-locked-refresh` reinstalled the default
  debug APK, confirmed `FIELDWORK_BIOMETRIC_BYPASS = false` and
  `FIELDWORK_DEBUG_PAIRING_CODE = ""`, cleared app data/logcat, launched with
  `Status: ok`, `LaunchState: COLD`, and `TotalTime=976ms`, captured
  `locked.png`, `locked-ui.xml`, `logcat.log`, and an empty `crash.log`,
  verified a 1080x2400 screenshot plus `text="Unlock"` in the UI dump, and
  found no Fieldwork `FATAL EXCEPTION` or ANR log entries. This remains
  debug-emulator evidence only.
  A later direct adb live-test-shaped emulator bundle under
  `/tmp/fieldwork-live-emulator-8UZh53hL` passed the then-current
  `pnpm check:live-testing-evidence` verifier before the stricter desktop
  `terminal-replay.txt` and `claude-replay.txt` proof requirements were added.
  It captured the required locked, paired dashboard, normal attach, and TUI
  attach evidence files; the dashboard listed desktop-created `refactoringjob`,
  `shell`, `editor`, and `extra` sessions, and `tui-ui.xml` showed the
  daemon-owned `editor` `htop` session as `Attached` with visible function-key
  chrome. The default debug APK was restored afterward with
  `FIELDWORK_BIOMETRIC_BYPASS = false`,
  `FIELDWORK_DEBUG_PAIRING_CODE = ""`, a locked `Unlock` surface, and an
  empty restored crash buffer. This remains emulator substitute evidence; it
  does not close the physical Android live-test gate.
  A 2026-05-22 direct adb pair/input refresh under
  `/tmp/fieldwork-adb-direct-20260522093624` installed the default debug APK,
  launched the locked app with `Status: ok`, `LaunchState: COLD`, and
  `TotalTime=6396ms`, and verified `FIELDWORK_BIOMETRIC_BYPASS = false` plus an
  empty `FIELDWORK_DEBUG_PAIRING_CODE`. The paired run used an isolated
  release daemon with a throwaway `FIELDWORK_IROH_SECRET_KEY_B64`, rebuilt a
  debug-only biometric-bypass/pair-payload APK, accepted camera and notification
  runtime prompts, paired through explicit desktop approval, listed the
  desktop-created `shell` session with `ANDROID_ADB_20260522_READY`, attached
  it, and sent `android_adb_20260522_ok` through `adb shell input text` plus
  Enter. A separate desktop attach replayed
  `android-direct-20260522: android_adb_20260522_ok`, proving emulator-originated
  input reached the daemon-owned PTY. Evidence includes locked, pair, dashboard,
  attached-terminal, post-input, logcat, and empty crash-buffer files. The debug
  APK was rebuilt and reinstalled back to default afterward:
  `FIELDWORK_BIOMETRIC_BYPASS = false`,
  `FIELDWORK_DEBUG_PAIRING_CODE = ""`, restored launch `TotalTime=8625ms`,
  `default-restored-locked.png`/UI XML verified the locked `Unlock` surface, and
  the restored crash buffer was empty. This remains debug-emulator substitute
  evidence only; physical Android biometric, QR-camera, renderer dogfood, and
  release-device runtime gates remain unchecked.
  A follow-up 2026-05-22 direct adb locked-launch refresh under
  `/tmp/fieldwork-adb-refresh-20260522` started `Medium_Phone_API_36.1`,
  installed the existing default debug APK, resolved
  `app.fieldwork.android/.MainActivity`, and launched it with `Status: ok`,
  `LaunchState: COLD`, and `TotalTime=4572ms`. Evidence includes `locked.png`,
  `locked-ui.xml`, `locked-logcat.log`, empty `locked-crash.log`, and
  `buildconfig.txt` proving `APPLICATION_ID = "app.fieldwork.android"`,
  `BUILD_TYPE = "debug"`, `DEBUG = Boolean.parseBoolean("true")`,
  `FIELDWORK_BIOMETRIC_BYPASS = false`, and
  `FIELDWORK_DEBUG_PAIRING_CODE = ""`. The screenshot was 1080x2400, the UI
  dump contained the locked `Unlock` surface, the app process remained focused,
  and targeted logcat scanning found no Fieldwork `FATAL EXCEPTION` or ANR
  entries. This remains debug-emulator substitute evidence only.
  A 2026-05-23 direct headless adb locked-launch refresh under
  `/tmp/fieldwork-adb-direct-20260523-locked` started
  `Medium_Phone_API_36.1`, installed the existing normal debug APK, resolved
  `app.fieldwork.android/.MainActivity`, and launched it with `Status: ok`,
  `LaunchState: COLD`, and `TotalTime=1847ms`. Evidence includes `locked.png`,
  `locked-ui.xml`, `locked-logcat.log`, empty `locked-crash.log`, `focus.txt`,
  and `buildconfig.txt` proving `APPLICATION_ID = "app.fieldwork.android"`,
  `BUILD_TYPE = "debug"`, `DEBUG = Boolean.parseBoolean("true")`,
  `FIELDWORK_BIOMETRIC_BYPASS = false`, and
  `FIELDWORK_DEBUG_PAIRING_CODE = ""`. The screenshot was 1080x2400, the UI
  dump contained the locked `Unlock` surface, the app process remained focused,
  and targeted logcat scanning found no Fieldwork `FATAL EXCEPTION` or ANR
  entries. This remains debug-emulator substitute evidence only.
  A 2026-05-23 direct adb locked-launch follow-up under
  `/tmp/fieldwork-emulator-direct-20260523` installed the current normal debug
  APK on `Medium_Phone_API_36.1`, resolved
  `app.fieldwork.android/.MainActivity`, and launched it with `Status: ok`,
  `LaunchState: COLD`, `TotalTime=4388ms`, and `WaitTime=4395ms`. Evidence
  includes `adb-devices.txt`, `buildconfig.txt`, `install.txt`, `launch.txt`,
  `locked.png`, `locked-ui.xml`, `locked-logcat.log`, and `locked-crash.log`.
  `buildconfig.txt` proves `APPLICATION_ID = "app.fieldwork.android"`,
  `BUILD_TYPE = "debug"`, `DEBUG = Boolean.parseBoolean("true")`,
  `FIELDWORK_BIOMETRIC_BYPASS = false`, and
  `FIELDWORK_DEBUG_PAIRING_CODE = ""`; `locked.png` is a 1080x2400 PNG with
  SHA-256 `22d6a9638bcc5fc0edc0d771d9b4434844b2d372e0799c4630d828cd376f3e84`.
  The UI dump contained only the locked `Unlock` app surface. The crash buffer
  captured an emulator system `com.google.android.bluetooth` crash, but targeted
  scanning found no Fieldwork `FATAL EXCEPTION`, ANR, session sync, push-token
  registration, terminal attach, or input before unlock. This remains
  debug-emulator substitute evidence only.
  A 2026-05-24 direct adb locked-launch refresh under
  `/tmp/fieldwork-adb-direct-20260524172604` started
  `Medium_Phone_API_36.1` as `emulator-5554`, installed the current normal
  debug APK, cleared app data/logcat/crash buffers, resolved
  `app.fieldwork.android/.MainActivity`, and launched it with `Status: ok`,
  `LaunchState: COLD`, `TotalTime=1852ms`, `WaitTime=1854ms`, and
  `wall_launch_ms=1905`. Evidence includes `adb-devices.txt`, `install.txt`,
  `launch.txt`, `resolve-activity.txt`, `package-info.txt`,
  `buildconfig.txt`, `locked.png`, `locked-ui.xml`, `logcat.log`, empty
  `crash.log`, and `screenshot-check.txt`. `package-info.txt` shows
  `versionCode=1`, `versionName=1.0`, and the expected debug-only
  `DEBUGGABLE` flag; `buildconfig.txt` proves
  `APPLICATION_ID = "app.fieldwork.android"`, `BUILD_TYPE = "debug"`,
  `DEBUG = Boolean.parseBoolean("true")`, `FIELDWORK_BIOMETRIC_BYPASS = false`,
  and `FIELDWORK_DEBUG_PAIRING_CODE = ""`. The screenshot was a 1080x2400
  PNG with `nonblack=14379/14400`, the UI dump contained only the locked
  `Unlock` surface, and targeted logcat/crash-buffer scanning found no
  Fieldwork `FATAL EXCEPTION` or ANR entries. This remains debug-emulator
  substitute evidence only.
  A later 2026-05-24 direct adb locked biometric fallback refresh under
  `/tmp/fieldwork-direct-adb-20260524220022` started the same AVD, installed
  `apps/android/app/build/outputs/apk/debug/app-debug.apk`, cleared logcat and
  the crash buffer, and launched `app.fieldwork.android/.MainActivity` with
  `Status: ok`, `LaunchState: COLD`, `TotalTime=2571ms`, and
  `WaitTime=2606ms`. Evidence includes `install.txt`, `launch.txt`,
  `locked.png`, `locked-ui.xml`, `logcat.log`, empty `crash.log`,
  `after-unlock-tap.png`, `after-unlock-ui.xml`, `after-unlock-logcat.log`,
  and empty `after-unlock-crash.log`. The locked and post-Unlock-tap UI dumps
  both contained only `text="Unlock"`; post-tap logcat showed
  `BiometricService` for `app.fieldwork.android` with `Status: 7` and
  `hasEnrollments: false`; and targeted scans found no Fieldwork
  `FATAL EXCEPTION`, ANR, `FieldworkRepository: listSessions`,
  `registerPushToken`, `Attached`, or terminal-content exposure before unlock.
  This remains debug-emulator substitute evidence only.
  A 2026-05-24 direct adb pair/input refresh under
  `/tmp/fieldwork-adb-pair-20260524205522` started
  `Medium_Phone_API_36.1` as `emulator-5554`, created a desktop-owned
  `bash · fieldwork` PTY with `ANDROID_DIRECT_PAIR_READY`, installed a
  debug-only biometric-bypass/pair-payload APK, launched
  `app.fieldwork.android/.MainActivity` with `Status: ok` and
  `TotalTime=1554ms`, and paired through the actual Android Pair surface plus
  explicit desktop approval in `pair_flow_ms=525`. Evidence includes
  `before-pair.png`, `before-pair-ui.xml`, `dashboard.png`, `dashboard-ui.xml`,
  `terminal-before-input.png`, `terminal-before-input-ui.xml`,
  `terminal-after-input.png`, `terminal-after-input-ui.xml`, `logcat.log`,
  empty `crash.log`, `pair-buildconfig.txt`, `restored-buildconfig.txt`,
  `restored-locked.png`, and `restored-locked-ui.xml`. The dashboard UI dump
  showed `bash · fieldwork` and `ANDROID_DIRECT_PAIR_READY`; the attached
  terminal UI dump showed `Attached`; Android sent `fw_android_direct_pair_ok`
  into the PTY, and a separately approved verifier client confirmed
  `android-direct: fw_android_direct_pair_ok`. `pair-buildconfig.txt` proves
  the temporary debug-only build had `FIELDWORK_BIOMETRIC_BYPASS = true` and an
  injected pairing code; `restored-buildconfig.txt` proves the APK was
  rebuilt and reinstalled back to `FIELDWORK_BIOMETRIC_BYPASS = false` and
  `FIELDWORK_DEBUG_PAIRING_CODE = ""`, with the restored locked `Unlock`
  surface. The emulator was shut down afterward and `adb devices -l` showed no
  attached devices. This remains debug-emulator substitute evidence only;
  physical Android biometric, QR-camera, Play-signed release build, and
  release-device runtime gates remain unchecked.
  A 2026-05-25 direct adb pair/input rerun under
  `/tmp/fieldwork-adb-pair-20260524234442` first exposed a stale
  `target/release/fieldwork` binary that lacked `fieldwork doctor`; rebuilding
  the release CLI/daemon fixed the local CLI surface before the app flow
  continued. The rerun proved `target/release/fieldwork doctor --no-start` with
  socket hardening, created the desktop-owned `android_direct` bash PTY, paired
  Android through the actual Pair UI plus explicit desktop approval in
  `pair_flow_ms=841`, listed the desktop session, attached the terminal, sent
  `fw_android_direct_manual_ok` from Android, and verified
  `android-direct: fw_android_direct_manual_ok` through a separately approved
  CLI client. Captured screenshots, UI dumps, logcat, empty crash buffers, and
  restored default `FIELDWORK_BIOMETRIC_BYPASS = false` plus empty
  `FIELDWORK_DEBUG_PAIRING_CODE = ""` proof remain debug-emulator
  substitute evidence only; `pnpm check:live-testing-readiness:local` now
  catches stale release `fieldwork`/`fieldworkd` command surfaces and verifies
  the repo-local release binary can render `Usage: fw` plus `Usage: fw doctor`
  through a temporary shim before the physical-device preflight.
  A later 2026-05-25 direct adb interactive-shell refresh under
  `/tmp/fieldwork-adb-direct-20260525105201` and
  `/tmp/fieldwork-adb-direct-pair-20260525105508` installed the default debug
  APK, launched the locked app with `Status: ok` and `TotalTime=3117ms`,
  captured the locked `Unlock` screenshot/UI/logcat plus an empty crash buffer,
  then installed a debug-only biometric-bypass/pair-payload build and paired
  through the actual Android Pair UI plus explicit desktop approval in
  `pair_flow_ms=549`. The paired dashboard showed the desktop-created
  `directbash` interactive shell, Android attached to it, sent
  `echo fw_android_direct_interactive_ok` through direct `adb shell input text`
  plus Enter, and a separately approved `fieldwork pair-test --attach
  directbash` verifier saw `fw_android_direct_interactive_ok` in replayed PTY
  bytes. App logcat showed `FieldworkRepository: listSessions returned 2
  sessions`, no Fieldwork `FATAL EXCEPTION` or ANR entries, and an empty crash
  buffer. The same pass exposed that raw `uiautomator dump` can wedge during
  terminal capture, so the Android terminal-attach evidence scaffold now
  captures screenshots first and wraps UI dumps with
  `FIELDWORK_ANDROID_UI_DUMP_TIMEOUT_SECONDS`-bounded direct-adb capture. This
  remains debug-emulator evidence only; physical signed-release phone gates
  remain unchecked.
  A 2026-05-30 direct adb current-app refresh under
  `/tmp/fieldwork-adb-direct-20260530042105` installed the default debug APK,
  launched the locked `Unlock` surface with `Status: ok`, then rebuilt a
  temporary debug-only biometric-bypass APK with the hosted relay control URL
  and debug pairing code. The Android Pair UI completed through the hosted relay
  typed-code path after explicit desktop approval, the dashboard showed the
  desktop-created `adbpair` session with `ANDROID_ADB_DIRECT_READY`, Android
  attached the live terminal, sent `android_adb_direct_ok`, and
  `desktop-replay.txt` proved the same daemon-owned PTY replay contained
  `android-direct: android_adb_direct_ok`. The run captured locked, pair,
  dashboard, terminal-before-input, terminal-after-input, UI dump, logcat,
  device listing, and crash-buffer evidence; crash buffers were empty and
  targeted scans found no Fieldwork fatal/ANR entries. The default debug APK was
  rebuilt/reinstalled afterward with `FIELDWORK_BIOMETRIC_BYPASS = false`,
  `FIELDWORK_DEBUG_PAIRING_CODE = ""`, and `FIELDWORK_RELAY_CONTROL_URL = ""`.
  This remains debug-emulator substitute evidence only; physical signed-release
  phone gates remain unchecked.
  A later 2026-05-30 direct adb hosted-relay refresh under
  `/tmp/fieldwork-adb-hosted-tmux-LmQhEo` kept the isolated release daemon and
  desktop pairing prompt alive in tmux while raw `adb` drove the emulator. The
  temporary debug-only APK was rebuilt with the hosted relay control URL,
  `FIELDWORK_ANDROID_BIOMETRIC_BYPASS=true`, and debug pairing code `60TTF`.
  Android paired through the real Enter-code Pair UI plus explicit desktop
  approval in `pair_flow_ms=1343`, showed the desktop-created `hosted_direct`
  session with `ANDROID_HOSTED_DIRECT_READY`, attached to the terminal, and sent
  `android_hosted_direct_ok`. A separately approved verifier client attached
  through the same hosted relay and proved replay contained
  `android-hosted: android_hosted_direct_ok`; relay version evidence reported
  `contract_version=2`. The pass captured launch transcripts, screenshots,
  UI XML, targeted app logcat, empty Fieldwork crash buffers, and desktop replay
  proof. The normal debug APK was rebuilt/reinstalled afterward with
  `FIELDWORK_BIOMETRIC_BYPASS = false` and `FIELDWORK_DEBUG_PAIRING_CODE = ""`,
  then relaunched to the locked `Unlock` surface. This remains debug-emulator
  substitute evidence only; physical signed-release phone gates remain
  unchecked.
  Android release readiness also now checks the desktop `fw`, `fw doctor`, and
  `fieldworkd` command surfaces used during signed release-device capture. Local
  mode falls back to an internal temporary `fw`/`fieldwork`/`fieldworkd` shim
  backed by repo-local `target/release/fieldwork` and
  `target/release/fieldworkd` when the npm-installed `fw` alias is absent; that
  fallback must prove `Usage: fw`, `Usage: fw doctor`, and `Usage: fieldworkd`,
  while strict mode still requires current `fw` and `fieldworkd` commands on
  `PATH`.
  `pnpm scaffold:android-release-evidence-pack -- --print-dir` creates a
  source-checkout `fw`/`fieldwork`/`fieldworkd` shim plus `setup.sh` so the
  physical evidence pack can run the same short command names, local release
  readiness, and `fw doctor` before strict release-device capture; its
  `verify.sh` runs every focused Android release evidence verifier in capture
  order, including the strict release-install physical-device check.
  A 2026-05-30 local release APK install smoke used `bundletool-all-1.18.3` to
  convert the current release AAB into
  `/tmp/fieldwork-android-release-install-20260530045350/apks/fieldwork-release-universal.apks`
  and `universal.apk`, signed it with an ephemeral non-debug
  `CN=Fieldwork Release Smoke` key, and verified APK Signature Scheme v3 with
  `apksigner`. Static evidence under that directory includes
  `apksigner-universal.txt`, `aapt-badging.txt`, `aapt-permissions.txt`,
  `aapt-manifest-tree.txt`, and `sha256.txt`; the manifest/badging evidence
  shows `app.fieldwork.android`, `versionCode='1'`, `versionName='1.0'`, and no
  `debuggable` marker. Direct adb evidence under
  `/tmp/fieldwork-android-release-install-20260530045350` installed the release
  `universal.apk` on `Medium_Phone_API_36.1`, launched
  `app.fieldwork.android/.MainActivity` with `Status: ok`,
  `LaunchState: COLD`, and retained passing launch attempt `TotalTime=1169ms`
  after recording `launch-attempts.txt` for earlier cold-start variance,
  captured the locked `Unlock` UI/screenshot, proved
  `run-as: package not debuggable: app.fieldwork.android`, showed no
  installed-package `DEBUGGABLE` flag, and captured an empty
  `crash.log`. `scripts/verify-android-release-install-evidence.mjs` validates
  this captured APKS/static metadata and direct-adb install/locked-launch
  evidence; its `--strict-release-device` mode rejects emulator evidence and
  the local `Fieldwork Release Smoke` certificate for production Android
  release evidence. `scripts/test-android-release-install-evidence.mjs` keeps
  both verifier paths in the local release gate.
  `scripts/create-android-release-install-evidence-dir.mjs`
  now creates the repeatable release-install scaffold with separate `apks/` and
  `install/` evidence directories, and
  `scripts/test-android-release-install-scaffold.mjs` verifies the scaffold
  mirrors the verifier without fabricating evidence. This remains local
  ephemeral-signing/emulator evidence only; the Play-signed release build and
  physical release-device runtime gates remain unchecked.
  A later 2026-05-22 direct adb manual terminal refresh under
  `/tmp/fieldwork-adb-direct-20260522225023` installed a debug-only
  biometric-bypass/pair-payload build, granted the emulator camera permission,
  paired the actual Android app to an isolated release daemon through explicit
  desktop approval, opened the desktop-created `adb_direct` session, and sent
  `direct_adb_ok` from Android into the daemon-owned PTY. `uiautomator` hung
  after pairing, so the pass continued with direct `adb` coordinates,
  screenshots, logcat, and a separately approved desktop verifier;
  `manual-verifier-success.txt` contains `android-direct: direct_adb_ok`.
  Evidence includes paired-dashboard and terminal screenshots, app logcat, an
  empty terminal crash buffer, and restored-default proof. The default debug APK
  was rebuilt and reinstalled afterward with
  `FIELDWORK_BIOMETRIC_BYPASS = false`,
  `FIELDWORK_DEBUG_PAIRING_CODE = ""`, restored `Unlock` UI, and an empty
  restored crash buffer. This remains debug-emulator substitute evidence only;
  physical Android biometric, QR-camera, renderer dogfood, and release-device
  runtime gates remain unchecked.
  A 2026-05-29 raw adb hosted-relay refresh under
  `/tmp/fieldwork-direct-adb-pair-20260529.CCfUdt/evidence` used the AWS
  live-test relay control plane, an isolated release daemon, and a
  desktop-created `directshell` PTY. The debug app was temporarily rebuilt with
  `FIELDWORK_ANDROID_BIOMETRIC_BYPASS=true` plus typed pairing code `KPDMT`,
  paired through explicit desktop approval, accepted the notification
  permission prompt, listed `directshell` with `ANDROID_DIRECT_READY`, attached
  the terminal, sent `android_direct_ok` via direct `adb shell input text`, and
  a desktop attach replay captured `android-direct: android_direct_ok`.
  Screenshots, UI dumps, logcat, empty crash buffers, `terminal-replay.txt`, and
  `SUMMARY.txt` were captured; the default debug APK was rebuilt/reinstalled
  afterward, `pnpm check:android-debug-apk` proved no stale debug pairing
  payload remained, `pnpm test:android-unit` passed, and the emulator app data
  was cleared. This remains debug-emulator hosted-relay substitute evidence;
  physical Android biometric, QR-camera, Play-signed release build, renderer
  dogfood, and release-device runtime gates remain unchecked.
  A later 2026-05-29 raw adb notification-tap routing refresh under
  `/tmp/fieldwork-direct-adb-notify-20260529.OliIrI/evidence` paired a
  temporary biometric-bypass debug app with an isolated release daemon and two
  desktop-created sessions, `fw_notify_target` and `fw_notify_other`. A direct
  uppercase `FIELDWORK_OPEN_SESSION` intent stayed on the dashboard, proving
  invalid uppercase hashes do not route. A direct lowercase intent opened
  `fw_notify_target`, and Android-originated `notify_tap_ok` reached only the
  target PTY input log; the other session input log stayed empty. Screenshots,
  UI dumps, intent transcripts, logcat, an empty crash buffer, and `SUMMARY.txt`
  were captured; the default debug APK was rebuilt/reinstalled afterward and
  emulator app data was cleared. This remains debug-emulator notification-tap
  substitute evidence; real provider delivery, physical lock-screen tap-through,
  APNs/FCM payload inspection, and physical release-device routing remain
  unchecked.
  A 2026-05-29 direct adb background/foreground retry refresh under
  `/tmp/fieldwork-direct-adb-bg-fix-20260529.Om7Krm/evidence` paired through
  typed code `R8X09`, attached `bg_replay_fix`, sent `before_background_ok`,
  backgrounded Fieldwork with `KEYCODE_HOME`, emitted
  `ANDROID_BACKGROUND_REPLAY_OUTPUT` while Android was backgrounded,
  foregrounded back to `Attached` with HOT launch `TotalTime=485ms`, and sent
  `after_background_ok`. The first pre-fix run exposed a user-visible
  `transport error: connection lost` dialog from the dashboard session-list
  stream; Android now retries that background subscription quietly, with focused
  ViewModel JVM coverage. The patched run captured screenshots, UI dumps,
  logcat, an empty crash buffer, and `SUMMARY.txt`, then restored the default
  debug APK and cleared app data. This remains debug-emulator lifecycle
  substitute evidence; signed physical-device background/foreground evidence
  remains unchecked.
  A 2026-05-29 direct adb network-reconnect refresh under
  `/tmp/fieldwork-direct-adb-reconnect-20260529.hkFQik/evidence` paired a
  temporary biometric-bypass debug app through typed code `T9K4B` plus explicit
  desktop approval, attached the desktop-created `fw_reconnect_session`, sent
  `before_reconnect_ok`, sent `trigger_offline_output`, cut emulator networking
  with `adb shell cmd connectivity airplane-mode enable`, and restored it with
  `adb shell cmd connectivity airplane-mode disable`. Android stayed on the
  `Attached` terminal after network restoration and sent `after_reconnect_ok`;
  a separately approved desktop verifier replayed
  `android-reconnect: before_reconnect_ok`,
  `ANDROID_RECONNECT_OFFLINE_OUTPUT`, and
  `android-reconnect: after_reconnect_ok`. Screenshots, UI dumps, ping
  transcripts, app logcat, an empty crash buffer, and `SUMMARY.txt` were
  captured; the default debug APK was rebuilt/reinstalled afterward, app data
  was cleared, the isolated daemon was stopped, and debug `BuildConfig` returned
  to no biometric bypass, no debug pairing code, and no relay-control URL. This
  remains debug-emulator network-reconnect substitute evidence:
  `network_restore_ms=10340`, so physical release-device `reconnect_ms<=2000`
  evidence remains unchecked.
  A 2026-05-30 direct adb resize/detach refresh under
  `/tmp/fieldwork-direct-adb-resize-detach-20260530.fixed5.sCedcI/evidence`
  paired a temporary biometric-bypass debug app through hosted relay typed code
  `HJ0CQ` plus explicit desktop approval, attached the desktop-created
  `android-resize` PTY, sent `before_resize_ok`, resized the emulator viewport
  from `1080x2400` to `720x1280`, and stayed on the `Attached` terminal. Android
  then ran `stty size`, which reported `23 42`, sent `after_resize_ok`, detached
  back to the Sessions dashboard, reattached to the same PTY, and sent
  `after_detach_reattach_ok`. Screenshots, UI dumps, app logcat, an empty crash
  buffer, session listings, and install/restore transcripts were captured; the
  default debug APK was rebuilt/reinstalled afterward, app data was cleared, the
  emulator viewport was reset, the isolated daemon was stopped, and debug
  `BuildConfig` returned to no biometric bypass, no debug pairing code, and no
  relay-control URL. This remains debug-emulator resize/detach substitute
  evidence; signed physical-device release evidence remains unchecked.
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
  replayable through a separately approved verifier; latest direct local
  substitute evidence on 2026-05-29 passed on `emulator-5554` with the raw `adb`
  evidence bundle above, while the physical-device timing gate remains open.
  `scripts/create-android-network-reconnect-evidence-dir.mjs` and the Android network reconnect evidence scaffold self-test now cover the release-device scaffold for `reconnect_ms<=2000` after direct adb network restore without fabricating the required PTY replay transcripts or reconnect timing.
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
| `CONTRACT_VERSION = 2` and version rejection | Protocol constant/tests, direct bincode IPC protocol-mismatch tests for `LocalCli`/`IosApp`/`AndroidApp`, and local iroh handoff smoke protocol-mismatch rejection before pairing | Locally verified |
| UUIDv7 IDs and UTC millisecond timestamps | Protocol/session records and focused `fieldwork-protocol` tests verify generated `SessionId`/`ClientId` values are UUIDv7 and `now_ms()` returns UTC Unix epoch milliseconds within the current system-time window | Locally verified |
| 256 KB per-session ring, monotonic `seq`, warm replay | Daemon ring proptests, explicit no-wrap saturation test, warm-attach `seq` regression test, protocol docs, and mobile-core `last_seen_seq` tracking; `stream_output_advances_mobile_reconnect_offset_without_decoding_bytes` verifies raw bytes are delivered without UTF-8 decoding while advancing the reconnect offset to live `Output.seq`, and `yes_head_10000_scale_stream_delivers_all_bytes_without_offset_drift` verifies local high-volume mobile-core delivery without dropped bytes or offset drift | Locally verified |
| Cold/stale attach synthetic ANSI snapshot | Deterministic terminal-model tests assert exact visible-cell attribute and cursor rehydration. The real-PTY gate starts `vim /etc/hosts`, forces stale attach, captures the returned snapshot and `seq`, feeds `Attached.initial_bytes` into a fresh `wezterm-term` client model, and compares alt-screen mode, cursor position, and rendered visible text with the daemon model | Locally verified |
| Multiple clients attach simultaneously; input writes to PTY | `session::handoff_tests::attached_clients_share_pty_output_from_any_input_writer` attaches two clients to one PTY, writes input through the session, and verifies both subscribers receive the child output; local handoff smoke covers the end-to-end iroh path | Locally verified |
| Dashboard session subscriptions receive create/remove/state replacement lists | `ipc::tests::session_list_subscription_receives_create_and_remove_replacements` and `ipc::tests::session_list_forwarder_publishes_dashboard_state_changes` cover replacement list updates for create/remove/state changes; local handoff smoke covers the end-to-end iroh subscribed dashboard path | Locally verified |
| Resize uses minimum attached viewport | Daemon session viewport tests plus `scripts/verify-daemon-resize.mjs` for attach/update/detach debounce wiring | Locally verified |
| Subscriber overflow emits one terminal `Lag` and forces resync | Daemon forwarder tests, mobile-core lag handling, native reattach controllers, and docs; `lag_event_notifies_native_ui_and_stops_for_resync` verifies the native sink receives the skipped count before mobile-core stops for reattach, and `skipped_bytes` is the v1 wire name for skipped broadcast-message count | Locally verified |
| State inference dispatch for Claude, Codex, unknown commands | `crates/daemon/src/state_infer/{mod,claude,codex,unknown}.rs`, `crates/daemon/tests/fixtures/`, CLI Codex hook tests, and daemon session tests cover command-kind dispatch, Claude prompt/Stop-hook event ingestion, Codex structured event shapes, Codex JSONL event streams, matching LocalCli hook updates, mismatched hook-source rejection, and byte-rate-only unknown command inference | Locally verified; authenticated live Claude/Codex captures remain account/workspace-gated |
| Claude/Codex first-class push/state; unknown commands run with baseline state | State inference tests and relay push tests verify `AwaitingInput` dispatch for Claude/Codex while unknown commands remain `Idle`/`Working` only; current Codex CLI surface is preserved by spawning the requested `codex` PTY command unchanged and accepting structured Codex JSON/JSONL events through the local agent-event adapter instead of appending an unsupported `--remote-control` flag | Locally verified |
| QR pairing, 5-character Crockford codes, compact `fw1` tickets, 10 minute TTL, single active code, wrong-attempt lockout, desktop approval | Protocol code tests verify the confusable-free alphabet plus normalization/validation; `PairingTicket` tests round-trip the compact `fw1` ticket; daemon pairing tests verify generated codes are fixed length and alphabet-bound, expire after 10 minutes, are single-use before approval, invalidate after 5 wrong attempts, stay usable below the attempt cap, and succeed only after explicit desktop approval; local handoff smoke covers both the QR ticket path and typed-code relay rendezvous path | Locally verified |
| Long-lived Ed25519 device auth and revocation | `transport_iroh::peer_identity_tests::pairing_peer_identity_mismatch_returns_unauthorized` verifies pairing claims must match the authenticated iroh peer identity; daemon device registry tests cover removal from the paired-device registry; `ipc::tests::removing_device_with_push_token_enqueues_relay_unregistration` and `push::tests::worker_unregisters_token_from_relay` verify `fieldwork devices remove` also unregisters any relay-bound push token without terminal-content leakage; local handoff smoke reuses a deterministic phone `--secret-key-path` after `fieldwork devices remove` to verify the revoked identity receives `Error{Unauthorized}` | Locally verified |
| Unix socket hardening | Daemon path/socket tests cover private parent mode, socket `0600`, symlinked parent rejection, and symlinked existing socket rejection without replacing the target; `fw doctor` now reports the socket parent ownership/mode/symlink state and socket file type/mode/symlink state in the runtime smoke | Locally verified |
| Non-`LocalCli` clients cannot create/kill sessions | Authz tests, direct bincode IPC handler tests for `IosApp`/`AndroidApp` `CreateSession`, `KillSession`, and `AgentStateEvent` forbidden responses, plus local handoff smoke for paired iroh mobile rejection of `CreateSession`, `KillSession`, and `AgentStateEvent` | Locally verified |
| Scrollback/device registry encrypted at rest by default, opt-out explicit | Persistence tests cover encrypted session/device payloads, encrypted device-registry rows and hashed device row keys in both shared-test and separate production-like `sessions.redb`/`devices.redb` layouts, explicit plaintext opt-out, re-enable reads of previous plaintext rows, private `0700` persistence parents, `0600` database files, and symlink rejection for persistence directories and database files. README, npm package README, public site pages, and security docs now state that Keychain prompts are only for local key material and that terminal output, keystrokes, commands, paths, session names, and push tokens are not stored there | Locally verified |
| Push payload privacy | Relay request validation rejects unknown/free-text fields and validates session hashes as lowercase 64-character hex strings; APNs/FCM provider tests parse outbound provider JSON and assert exact key sets, fixed alert copy, hash-only data fields, and no `last_line`/command/path strings; secret-boundary and mobile privacy verifiers cover fixed-copy notifications, no lock-screen session-name toggle, strict lowercase `session_id_hash`-only tap routing, Android queued FCM token registrar tests for trimmed-token storage, blank-token rejection, matching-token clear semantics, clear-all unpair behavior, FieldworkViewModel tests for paired/unlocked registration gating, duplicate-token dedupe, pairing-time session load/subscription/FCM sync, locked pairing no-op for session load/subscription/FCM sync, dashboard subscription updates, lock-time subscription stop, locked push-tap pending resolution after unlock or later subscription updates, unlocked push-tap resolution against the current session list, and invalid uppercase hash rejection after unlock, `fieldwork_push_tokens.xml` backup/transfer exclusion, Android JVM tests prove tap parsing trims but never lowercases uppercase hashes, foreground notifications use fixed generic copy and private lock-screen visibility even when extra terminal/command fields are present, and invalid event types or invalid hashes do not post notifications, `scripts/verify-android-fcm-push-evidence.mjs` fixture coverage pins inspected FCM HTTP v1 payloads to exact hash-only keys, and `scripts/create-android-fcm-push-evidence-dir.mjs` plus the Android FCM push evidence scaffold self-test prepare the direct-adb evidence capture without fabricating provider payloads before the Android FCM provider path can be accepted | Local contract verified; real APNs/FCM in-transit inspection blocked |
| Mobile diagnostics consent | `scripts/verify-telemetry-privacy.mjs`, native mobile telemetry helpers, focused Android MobileTelemetry JVM tests, and terminal controllers verify default-off local diagnostics, Settings opt-in, declined one-time consent resolution, local diagnostics preference without starting a crash-reporting SDK, delayed one-time prompt after `AwaitingInput` response plus 10 output lines, no daemon/mobile crash SDK wiring, no daemon OTLP/Honeycomb export, and no removed crash SDK markers in existing Android APK/AAB outputs | Local static/JVM/artifact contract verified |
| Relay verifies signatures, token ownership, replay, skew, validation | Relay tests cover signature, ownership, replay, clock skew, validation, rate limiting, APNs BadDeviceToken stale-token pruning from memory and SQLite, and 90-day no-use push-token pruning with touch-on-use refresh; `tests::rejects_cross_daemon_token_use` is the explicit Section 7.3.1 gate that registers a token for daemon A and verifies daemon B receives `403 Forbidden` when trying to push to it | Locally verified |
| Fieldwork-owned TLS clients use OS trust | iroh uses `platform-verifier`; relay OTLP uses OpenTelemetry's `reqwest-rustls` native-root path; `pnpm check:telemetry-privacy` rejects `reqwest-rustls-webpki-roots` on the OTLP exporter | Locally verified |
| Relay Honeycomb trace receipt | `docs/RELAY_HONEYCOMB.md`, `scripts/verify-relay-honeycomb-evidence.mjs` fixture coverage, `scripts/create-relay-honeycomb-evidence-dir.mjs`, and the relay Honeycomb evidence scaffold self-test define the hosted Honeycomb receipt evidence contract: relay OTLP endpoint is `https://api.honeycomb.io/v1/traces`, production default sampling is `0.01`, temporary receipt-test sampling above `0.01` must record `receipt_test_window=true` and `restored_sample_rate=0.01`, `honeycomb-api-key` is relay-only systemd credential evidence, the test request is `/v1/version`, the hosted Honeycomb query export contains `fieldwork-relay`, `relay.version`, `/v1/version`, and `service.version`, and the verifier rejects Honeycomb keys, header values, terminal/session fields, command/path/session-name values, daemon node IDs, and push tokens. The scaffold writes helper files plus a non-secret `preflight.sh` that captures relay version output, `/v1/version` request proof, redacted relay OTLP config, and systemd credential wiring without exporting hosted Honeycomb query rows or fabricating passing evidence | Local contract verified; hosted Honeycomb receipt blocked by account/API key and relay-host query evidence |
| Security model doc | `docs/SECURITY.md` summarizes the v1 trust zones, local IPC hardening, pairing/device auth, encrypted local storage, Keychain-held key boundaries, raw-byte terminal privacy, relay push controls, mobile biometric gates, remaining external gates, and the local verification set; `scripts/verify-security-model.mjs` pins those claims and CI wiring | Locally verified |
| Native iOS app: SwiftUI + SwiftTerm | `apps/ios` source, project files, committed SwiftPM package pins, Swift parse check, APNs entitlement verifier, generated mobile-core linkage verifier, no-stub-build guard, explicit QR camera authorization handling, raw-byte output revision guard, SwiftTerm raw byte-array renderer guard, iOS `lastSeenSeq` lag-reattach static checks, and a paused `fw new` empty-state copy refresh for `SessionsListView.swift` when iOS work resumes | Source/static wiring verified except the paused `fw new` empty-state copy refresh; full build blocked by Xcode/signing/device gates |
| Native Android app: Compose + Section 7.6 renderer decision | `apps/android`, `docs/ANDROID_RENDERER.md`, `docs/ANDROID_PAIR_FLOW.md`, `docs/ANDROID_SESSION_SUBSCRIPTION.md`, `docs/ANDROID_TERMINAL_ATTACH.md`, `docs/ANDROID_RESIZE_DETACH.md`, `docs/ANDROID_BIOMETRIC.md`, `docs/ANDROID_DOGFOOD.md`, `docs/ANDROID_COLD_START.md`, `docs/ANDROID_RENDERER_FLOOD.md`, `docs/ANDROID_BACKGROUND_FOREGROUND.md`, `docs/ANDROID_NETWORK_RECONNECT.md`, `docs/ANDROID_RESTART_RESTORE.md`, `docs/ANDROID_MULTISESSION.md`, `docs/ANDROID_FCM_PUSH.md`, termlib dependency, mobile privacy verifier, Android raw `ByteArray` to termlib and `lastSeenSeq` lag-reattach static checks, lifecycle-scoped `FieldworkViewModel`, Android JNI context initialization failure-to-Java-exception guard, focused TerminalController JVM tests for locked-input refusal, latest-`lastSeenSeq` `Lag` reattach, attached-stream-error reattach, delayed telemetry trigger, nonblocking saved-pairing restore, off-main repository-backed refresh coverage, off-main terminal attach/lag-reattach coverage, and stale startup-restore invalidation, AAB ABI, packaged manifest identity/version, release `BuildConfig`, packaged uses-permission allowlist, and manifest privacy verifier, local API 36.1 emulator debug launch, `uiautomator` locked-surface evidence, and nonblank emulator `screencap` check, plus direct adb restart-restore evidence, direct adb pair/attach/input evidence, live-test-shaped direct adb TUI attach evidence, `scripts/verify-android-pair-flow-evidence.mjs` fixture coverage, `scripts/create-android-pair-flow-evidence-dir.mjs`, and the Android pair-flow evidence scaffold self-test for `pair_flow_ms<=15000` real-QR release-device dashboard evidence, `scripts/verify-android-session-subscription-evidence.mjs` fixture coverage, `scripts/create-android-session-subscription-evidence-dir.mjs`, and the Android session-subscription evidence scaffold self-test for `visible_ms<=2000` desktop-created session dashboard subscription evidence, `scripts/verify-android-terminal-attach-evidence.mjs` fixture coverage, `scripts/create-android-terminal-attach-evidence-dir.mjs`, and the Android terminal attach evidence scaffold self-test for release-device shell input, Claude input, and TUI rendering evidence, `scripts/verify-android-resize-detach-evidence.mjs` fixture coverage for release-device resize and detach/reattach replay evidence, `scripts/verify-android-biometric-evidence.mjs` fixture coverage for release-device BiometricPrompt and stale-input evidence, `scripts/verify-android-dogfood-evidence.mjs` fixture coverage for the 30-minute physical dogfood evidence contract, `scripts/verify-android-cold-start-evidence.mjs` fixture coverage, `scripts/create-android-cold-start-evidence-dir.mjs`, and the Android cold-start evidence scaffold self-test for five physical release-device cold launches with `TotalTime<=1200ms`, `scripts/verify-android-renderer-flood-evidence.mjs` fixture coverage for 10000 `ANDROID_LIVE_FLOOD` replay markers from a signed release device, `scripts/verify-android-background-foreground-evidence.mjs` fixture coverage for signed release-device replay after app backgrounding, `scripts/verify-android-network-reconnect-evidence.mjs` fixture coverage for `reconnect_ms<=2000` after direct adb network restore, `scripts/verify-android-restart-restore-evidence.mjs` fixture coverage for saved-pairing restore and `ANDROID_RESTART_SCROLLBACK` replay after daemon restart, `scripts/verify-android-multisession-evidence.mjs` fixture coverage for three-session switching with no cross-session marker leakage, and Android FCM push evidence verifier fixtures | Debug Kotlin compile, release AAB contents/manifest, debug launch, locked surface, restored restart dashboard, direct adb terminal input/output, TUI attach screenshot/UI/log/crash evidence, nonblank debug screenshot, Android pair-flow evidence verifier fixtures/scaffold, Android session-subscription evidence verifier fixtures/scaffold, Android terminal attach evidence verifier fixtures/scaffold, Android resize/detach evidence verifier fixtures, Android biometric evidence verifier fixtures, Android dogfood evidence verifier fixtures, Android cold-start evidence verifier fixtures/scaffold, Android renderer flood evidence verifier fixtures, Android background/foreground evidence verifier fixtures, Android network reconnect evidence verifier fixtures, Android restart-restore evidence verifier fixtures, Android multisession evidence verifier fixtures, and Android FCM push evidence verifier fixtures verified; physical dogfood and release-device runtime gates remain blocked |
| Android resize/detach evidence scaffold | `scripts/create-android-resize-detach-evidence-dir.mjs` creates the direct-adb release-device evidence directory from the verifier required-file list, and the Android resize/detach evidence scaffold self-test verifies the scaffold captures release/device proof plus resize/detach screenshots, UI dumps, logcat, crash buffers, and sessions without fabricating desktop sessions or PTY replay transcripts | Local scaffold verified; physical release-device resize and detach/reattach replay evidence remains blocked |
| Android biometric evidence scaffold | `scripts/create-android-biometric-evidence-dir.mjs` creates the direct-adb release-device evidence directory from the verifier required-file list, and the Android biometric evidence scaffold self-test verifies the scaffold captures release/device proof plus locked launch, BiometricPrompt, stale prompt screenshots, UI dumps, logcat, crash buffers, sessions, and paired-device listing without fabricating stale-input proof | Local scaffold verified; physical release-device BiometricPrompt and stale-input evidence remains blocked |
| Android dogfood evidence scaffold | `scripts/create-android-dogfood-evidence-dir.mjs` creates the direct-adb release-device evidence directory from the verifier required-file list, and the Android dogfood evidence scaffold self-test verifies the scaffold captures physical device, release BuildConfig, package identity, staged renderer screenshots, UI dumps, logcat, and crash buffers without fabricating the 30-minute dogfood duration, operator scroll review, or PTY replay transcripts | Local scaffold verified; physical 30-minute renderer dogfood remains blocked |
| Android renderer flood evidence scaffold | `scripts/create-android-renderer-flood-evidence-dir.mjs` creates the direct-adb signed release-device evidence directory from the verifier required-file list, and the Android renderer flood evidence scaffold self-test verifies the scaffold captures signed artifact proof, physical device proof, package identity, release BuildConfig, flood screenshot/UI, logcat, and crash buffers without fabricating the `yes ANDROID_LIVE_FLOOD | head -10000` PTY replay transcript | Local scaffold verified; physical renderer flood evidence remains blocked |
| Generated UniFFI mobile-core binding surface | `crates/mobile-core`, `apps/android/generated/uniffi/fieldwork_mobile_core/fieldwork_mobile_core.kt`, Android/iOS Rust build scripts, Android Gradle generated-source wiring, iOS Xcode generated Swift/xcframework wiring, `.github/workflows/ci.yml`, and `scripts/verify-uniffi-bindings.mjs` verify the generated Kotlin binding exposes `FieldworkClient`, `AttachedSession`, `SessionListSink`, `ByteStreamSink`, `FieldworkError`, pair/list/subscribe/attach/input/resize/detach/register-push-token methods, rejects generated mobile create/kill/session-command APIs, and verifies Android/iOS build-script binding generation plus Xcode/Gradle consumption | Kotlin generated binding and build wiring locally verified; full Swift generated-binding execution remains blocked by Xcode |
| Mobile resume/input biometric gates | iOS uses biometric-only `LocalAuthentication`; Android uses biometric-only `BiometricPrompt`; `scripts/verify-mobile-privacy.mjs` statically verifies both policies, locked app roots, unlock-gated session/push activation, stale input gates, and Android JVM tests cover first unlock, immediate post-unlock resume, fresh foreground resume, 5-minute stale foreground boundary, terminal input refusal while locked, and that the `FIELDWORK_ANDROID_BIOMETRIC_BYPASS=true` emulator path remains debug-build-only behind `BuildConfig.DEBUG` with release builds hardcoded off | Static/source verified; physical-device biometric prompt check blocked |
| Mobile pairing key storage | iOS Keychain uses the data-protection keychain with `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`; Android pairing prefs use `EncryptedSharedPreferences` plus AES256 master/key/value encryption, and Android pairing plus queued FCM-token prefs are excluded from full backup, cloud backup, and device transfer by `scripts/verify-mobile-privacy.mjs` | Static/source verified; physical restore/transfer check blocked |
| Mobile can pair, list/subscribe, attach, send input, resize, detach, register push tokens | iOS/Android app source, mobile-core APIs, Android paired-and-unlocked FCM token sync with queued-token and ViewModel registration-gating tests, `scripts/verify-v1-boundary.mjs` required-surface checks, and local pair-test simulator | Locally verified except physical push token/provider path |
| Mobile cannot create sessions, kill sessions, or specify commands | Mobile-core API surface, `scripts/verify-v1-boundary.mjs` forbidden-surface checks, authz tests, and local handoff smoke | Locally verified |
| First Android live-test runbook | `docs/LIVE_TESTING.md` defines the first operator-assisted Android physical-device terminal handoff pass: Android-only, not v1 release sign-off, same daemon-owned PTY session, not screen mirroring, no takeover of arbitrary already-open Terminal.app or iTerm tabs, no iOS/npm publish/store/production relay/APNs/FCM/domain/signing scope, USB debugging only for QA evidence and not an end-user requirement, direct `adb` screenshot/UI/log/crash capture, `scripts/create-live-testing-evidence-dir.mjs` scaffold for the README/manifest/missing-file checklist plus `capture-checklist.md` stage-by-stage direct `adb` capture order and generated `preflight.sh` physical-device/BuildConfig/fw-alias helper without fake evidence, `scripts/create-live-testing-fw-shim.mjs` plus `scripts/test-live-testing-fw-shim.mjs` for a source-checkout `fw`/`fieldwork`/`fieldworkd` command shim that mirrors the npm command names without replacing npm package/provenance gates, `pnpm check:live-testing-evidence -- "$FW_LIVE_DIR"` validation for required evidence files, `adb-devices.txt` proof that exactly one authorized physical Android device was connected for QA with no unauthorized/offline/emulator/AVD/ambiguous multi-device state, `buildconfig.txt` proof that `APPLICATION_ID = "app.fieldwork.android"`, `BUILD_TYPE = "debug"`, `DEBUG = Boolean.parseBoolean("true")`, `FIELDWORK_BIOMETRIC_BYPASS = false`, `FIELDWORK_DEBUG_PAIRING_CODE = ""`, and `FIELDWORK_RELAY_CONTROL_URL = ""`, nontrivial full-size Android PNG screenshots, locked-surface privacy, freshly cleared locked-launch logcat that does not show session sync, terminal attach, push-token registration, or input before unlock, `biometric-ui.xml` proof that Android BiometricPrompt appears before session access with no session or terminal content behind it, `stale-biometric-ui.xml` and `stale-biometric.txt` proof that Android BiometricPrompt appears again after at least five minutes in background and stale terminal input is blocked before unlock, UI dumps that do not expose mobile session creation, session kill, or command-selection controls, `pairing.txt` desktop transcript proof that `fw pair` printed the QR payload, waited for device scan, showed the explicit approval prompt, completed only after approval, and recorded `pair_flow_ms=<elapsed-ms>` at or below 15000, dedicated active-dashboard screenshot/UI/log/crash evidence that must show the generated one-word bare-`fw` session, `refactoringjob`, and a desktop-created shell/bash session before terminal attach, post-pair subscription screenshot/UI/log/crash evidence proving `fw new --name fw_live_sub bash` appears on Android with `visible_ms=<elapsed-ms>` at or below 2000 plus `subscription-replay.txt` containing `subscription_attach_ok` from Android-originated input, `sessions.txt` rows binding both the generated session and `refactoringjob` to default `claude` commands, expected desktop-created session listing, desktop reattach transcript `terminal-replay.txt` containing `android_live_ok` from Android-originated shell input, dedicated high-volume flood screenshot/UI/log/crash evidence plus `flood-replay.txt` proving `yes ANDROID_LIVE_FLOOD | head -10000` completed with `flood_lines=10000` and at least 10000 replayed marker lines, dedicated Claude screenshot/UI/log/crash evidence plus `claude-replay.txt` containing `claude_live_ok` from Android-originated input in the `refactoringjob` or generated default `claude` session, resize screenshot/UI/log/crash evidence plus `resize-replay.txt` with plausible `resize_size=<rows>x<cols>` or `resize_size=<rows> <cols>` and `after_resize_ok`, detach dashboard screenshot/UI/log/crash evidence plus `detach-replay.txt` with `after_detach_reattach_ok`, dedicated TUI attach screenshot/UI/log/crash evidence that must show `Attached` plus visible `vim`/`htop` terminal content, background/foreground, network reconnect, daemon restart restore, and multi-session transcript markers including `reconnect_ms=<elapsed-ms>` at or below 2000 plus per-session no-leakage replay files, and rejection of Android system not-responding overlays, any Android fatal/ANR logcat entries, and non-empty crash buffers, a temporary source-build `fw` shim for the same short command users get after npm install, desktop-created `bash`, `claude`, and `vim`/`htop` sessions, the bare `fw` auto-named default `claude` shortcut, and the `fw refactoringjob` named shortcut appearing in the Android dashboard | Runbook, evidence scaffold, fw shim helper, and evidence verifier synchronized; physical-device execution remains blocked until operator-provided device/evidence |
| iroh P2P transport with relay fallback | Daemon iroh transport, Oracle Terraform host scaffold, relay iroh mode/Ansible scaffold, deploy artifact checksum plus DSSE/SLSA bundle verifier; AWS bridge `/healthz` and `/v1/version` are reachable at `http://3.7.208.153:8443`, and `pnpm test:hosted-relay` verified hosted typed-code rendezvous, desktop approval, daemon-owned PTY attach, mobile-originated input, and `HOSTED_RELAY_RESULT_OK` on 2026-05-29 | Local transport verified and hosted control-plane bridge smoke verified; production DNS/TLS, Oracle capacity, and hosted iroh fallback proof remain blocked |
| Generic push notifications | Relay APNs/FCM code, APNs provider-client connection reuse test, APNs BadDeviceToken stale-token pruning test, daemon-facing provider-error body redaction, relay provider-client static verifier, daemon push worker with bounded exponential retry, mobile notification handlers, test-only delivery-buffer retention so production relay builds do not retain accepted provider delivery records after dispatch, `docs/ANDROID_FCM_PUSH.md`, `scripts/verify-android-fcm-push-evidence.mjs` fixture coverage, `scripts/create-android-fcm-push-evidence-dir.mjs`, and the Android FCM push evidence scaffold self-test for 10/10 physical Android FCM `AwaitingInput` deliveries, inspected hash-only FCM HTTP v1 payloads, generic notification copy, and tap-through to the target daemon-owned session | Local code/tests verified; real FCM/APNs provider delivery blocked |
| Relay control-plane transport encryption | `fieldwork-relay` supports Rustls control-plane serving from relay-only cert/key files, installs an explicit Rustls crypto provider, production systemd sets `FIELDWORK_RELAY_REQUIRE_TLS=true`, and `scripts/verify-infra-scaffold.mjs` checks the fail-closed TLS credential wiring | Locally verified with `scripts/smoke-relay-tls-loopback.sh`, `cargo test -p fieldwork-relay`, `cargo clippy -p fieldwork-relay -- -D warnings`, and infra/v1/release static gates; real certificate provisioning and hosted TLS smoke blocked |
| npm-only desktop distribution | `packages/cli` plus `packages/cli-{darwin-arm64,darwin-x64,linux-arm64,linux-x64}`, optional dependencies, `preferUnplugged`, `install.js` native binary swap, `fieldwork`/`fw` CLI dispatcher alias and `fieldworkd` daemon dispatcher fallback, alias-aware native help and shell completion generation, JS fallback preservation of the invoked alias through `FIELDWORK_CLI_BIN_NAME` and `argv0`, legal-file staging, `.gitignore` protection for generated platform native bins, tracked generated-native-bin rejection in `scripts/verify-npm-packages.mjs`, meta-package README contract checks in `scripts/verify-npm-packages.mjs`, `scripts/prepare-npm-artifacts.mjs`, local `scripts/build-local-npm-artifacts.sh` staging helper, `scripts/publish-npm-packages.mjs`, `scripts/verify-npm-registry-state.mjs`, Changesets fixed group, `scripts/test-bun-install.mjs`, `scripts/test-npm-dispatcher.mjs`, `scripts/smoke-npm-local-install.mjs`, `scripts/test-npm-registry-state.mjs`, `scripts/test-npm-artifact-pack.mjs`, `scripts/test-npm-publish-plan.mjs`, `scripts/verify-binary-entrypoints.mjs`, and `scripts/verify-release-workflows.mjs` cover npm metadata, v1.0.0 package manifests, the owned unscoped `fieldwork` meta package, package-page install/use commands, mobile capability boundary, four v1 platform package names, dispatcher fallback, WSL2 host scope, encrypted local persistence, push-payload privacy copy, clean temp npm install from local meta plus platform tarballs, installed `fieldwork`/`fw`/`fieldworkd` command surfaces, postinstall native binary replacement, Darwin installed-binary npm trust verification, fail-before-network bare registry invocation so the checker cannot act as a name-availability probe, missing-token publish rejection before npm is invoked, post-placeholder platform-published state, post-release latest-version/provenance state, missing platform-root rejection, non-native platform package publish rejection in both readiness and actual publish paths, repeatable local platform-binary staging, local platform-package tarball emission outside the real release-artifact tree, real staged desktop binary readiness without committing generated native package artifacts, Bun optional dependency behavior, children-first `npm publish --provenance --access public`, post-publish public registry verification, GitHub Release audit artifacts, and cargo-dist archive-only config with `installers = []`, `publish-jobs = []`, and `install-updater = false` | Local package, staged binary readiness, clean temp npm install, source-control artifact hygiene, native `fieldwork`/`fw` help and completion output, Darwin npm trust verification, and Bun optional-dependency checks verified; real npm publish blocked by platform child publish rights plus a release-scoped npm token |
| CI/release workflows | `.github/workflows/ci.yml`, `version-packages.yml`, `release-rust.yml`, `release-npm.yml`, `release-ios.yml`, `release-android.yml`, `deploy-relay.yml`, `deploy-site.yml`, `.github/dependabot.yml`, `apps/ios/Fieldwork.xcodeproj/project.pbxproj`, `scripts/verify-release-workflows.mjs` | Local syntax, CI Rust/supply-chain/Terraform Validate/CLI no-args/local-handoff/relay/npm/site/mobile-static/Android debug jobs, release-audit list-mode test coverage, live-testing evidence, debug-instance, Android AAB signing-policy, macOS npm trust verifier fixture tests, and macOS npm trust evidence verifier/scaffold self-tests, structured asset syntax checks, Node/shell script syntax checks, GitHub workflow `run: |` block `bash -n` self-test and current-workflow validation, dynamic repository-derived cosign identity, release fail-closed/provenance contracts, Darwin ad-hoc codesign plus npm-trust verifier before archive staging, signed AAB signature-entry verifier plus `jarsigner -verify -certs` before Play upload, early `NPM_TOKEN` preflight before npm artifact download, early relay SSH-key/inventory preflight before relay artifact download, Cloudflare credential preflight before site install/build with clean push skip and manual-dispatch fail-closed behavior, early Android release credential preflight before toolchain setup/mobile build, iOS App Store Connect upload JSON outside the repository workspace plus signing/upload cleanup, Android generated Firebase/signing-file cleanup, relay SSH key chmod/cleanup, post-publish npm registry/provenance verification with propagation retries, iOS Xcode build-phase `FIELDWORK_SKIP_RUST_BUILD` reuse wiring, Cloudflare site deploy scaffold, and the exact weekly Dependabot coverage for Cargo, root npm, `site/` npm, Android Gradle, and GitHub Actions are checked; external secrets blocked |
| Local non-external release gate | `scripts/check-local-release.mjs` and `package.json` `check:local-release` aggregate the deterministic source-side verifiers, `cargo fmt --check`, `cargo clippy --workspace -- -D warnings`, `cargo nextest run --workspace`, `cargo deny check`, `cargo audit`, workflow YAML syntax parsing, release workflow `run: |` bash syntax self-test and current-workflow validation, release-audit list-mode test, live-testing evidence verifier fixture test, live-testing evidence scaffold self-test, live-testing fw shim scaffold self-test, live-testing pack scaffold self-test, Android release readiness self-test, Android release evidence pack scaffold self-test, Android pair-flow evidence verifier fixture test, Android pair-flow evidence scaffold self-test, Android session-subscription evidence verifier fixture test, Android session-subscription evidence scaffold self-test, Android terminal attach evidence verifier fixture test, Android terminal attach evidence scaffold self-test, Android resize/detach evidence verifier fixture test, Android biometric evidence verifier fixture test, Android dogfood evidence verifier fixture test, Android cold-start evidence verifier fixture test, Android cold-start evidence scaffold self-test, Android release-install evidence verifier fixture test, Android release-install evidence scaffold self-test, Android release-signing evidence verifier fixture test, Android release-signing evidence scaffold self-test, Android renderer flood evidence verifier fixture test, Android background/foreground evidence verifier fixture test, Android network reconnect evidence verifier fixture test, Android restart-restore evidence verifier fixture test, Android multisession evidence verifier fixture test, Android FCM push evidence verifier fixture test, Android FCM push evidence scaffold self-test, shared `scripts/android-evidence-common.mjs` physical-phone adb guard, shared Android clean log/crash guard, shared Android system not-responding overlay guard, relay Honeycomb evidence verifier fixture test, relay Honeycomb evidence scaffold self-test, macOS daemon survival evidence verifier fixture test, macOS daemon survival evidence scaffold self-test, debug-instance env contract test, macOS npm trust verifier fixture test, macOS npm trust evidence verifier fixture test, macOS npm trust evidence scaffold self-test, Node script syntax checks for `scripts/*.mjs` with `node --check`, shell-script syntax checks for `scripts/*.sh` and `apps/ios/scripts/*.sh` including the Android emulator smoke scripts, structured asset syntax checks for tracked JSON and TOML package/config assets, iOS plist/project metadata with `plutil -lint` when available plus a portable plist/project fallback on non-macOS hosts, Android XML resources and docs SVG assets with `xmllint --noout` when available plus a portable Python XML fallback on hosts without `xmllint`, and fixture tests that do not require credentials, live publishing, iOS SDK builds, Android emulator runtime, physical devices, or hosted relay deployment. `pnpm scaffold:live-testing-pack -- --print-dir` creates one first-round Android live-test workspace with a source-checkout `fw` shim, evidence scaffold, `setup.sh`, and top-level preflight that runs local readiness plus `fw doctor` before the direct-`adb` evidence preflight, without fabricating physical evidence. `pnpm check:android-release-readiness:local` now consolidates the Android release AAB, release BuildConfig, mobile/store privacy, release workflow, release-signing/install evidence contracts, release secrets, signing state, and physical release-phone install preflight into one local pending-status command; strict `pnpm check:android-release-readiness` fails until the signed AAB, required secrets, exactly one physical phone, and non-debuggable installed package are available. `pnpm scaffold:android-release-evidence-pack -- --print-dir` creates one top-level Android signed-release evidence workspace with focused subdirectories for release signing/install, pairing, dashboard subscription, terminal attach, resize/detach, biometric, dogfood, cold start, renderer flood, lifecycle, multisession, and FCM push; its `readiness.sh` runs local Android release readiness and `fw doctor` before capture, and its `verify.sh` runs every focused Android release evidence verifier in capture order including the strict release-install physical-device check, without fabricating verifier evidence. The optional `--with-artifacts` mode adds preserved AAB, staged npm binary, clean temp npm install, publish-readiness, and npm dry-run pack checks when local artifacts are present; `pnpm build:local-npm-artifacts` now builds and stages those local npm platform binaries before a full local pass. The optional `--with-runtime` mode adds CLI doctor smoke, CLI no-args raw-terminal smoke, local handoff smoke, demo-video, site typecheck/build, Terraform fmt/init/validate, relay TLS/OTLP loopback, and desktop cold-start checks when the local tools and release binaries are present; `pnpm check:local-release:full` is the package alias for the artifact plus runtime release-candidate pass. Its CLI doctor, CLI no-args, and local handoff smokes default to `/tmp/fieldwork-target-checks` unless `CARGO_TARGET_DIR` is already set, preserve host `CARGO_HOME`/`RUSTUP_HOME` while isolating Fieldwork `HOME`, and Terraform validation uses `TF_PLUGIN_CACHE_DIR` outside the generated working directory while still removing `.terraform/` on exit. CI runs the lightweight source-side fixture/syntax checks individually. CI syntax-checks the aggregate wrapper and list-checks artifact/runtime modes without re-running the heavyweight local artifact/runtime gate in pull requests. | Locally verified |
| No-ship marker guard | `scripts/verify-no-ship-markers.mjs`, `package.json` `check:no-ship`/`test:no-ship`, and `scripts/check-local-release.mjs` scan production Rust, Android, iOS, and npm dispatcher/install sources for `todo!`, `unimplemented!`, `TODO`, `FIXME`, `HACK`, `XXX`, and "not implemented" markers while excluding generated Android bindings and the compile-guarded iOS stub shim; `--self-test` injects synthetic blocked markers and verifies the exclusions | Locally verified |
| Pre-commit developer gate | `.pre-commit-config.yaml` runs `cargo fmt --check`, `cargo clippy --workspace -- -D warnings`, `cargo nextest run --workspace --no-fail-fast`, `node scripts/verify-secret-boundaries.mjs`, `node scripts/verify-no-ship-markers.mjs`, `node scripts/verify-no-ship-markers.mjs --self-test`, `node scripts/test-live-testing-evidence.mjs`, `node scripts/test-debug-instance.mjs`, and `node scripts/verify-structured-assets.mjs` through local system hooks; `scripts/verify-community-scaffold.mjs` pins those nine hooks as always-run workspace/security/lightweight release gates | Locally verified |
| Daemon service install/restart scaffold | `crates/cli/src/service.rs`, `crates/daemon/src/main.rs` stdio reservation before PTY creation under launchd, CLI daemon commands, IPC health wait, CLI auto-spawn reuse of validated colocated `fieldworkd` resolution, focused service context/path unit tests including colocated executable `fieldworkd` validation, macOS Gatekeeper rejection, non-secret service environment capture for `PATH`/`HOME`/`XDG_RUNTIME_DIR`/XDG config and state paths/Fieldwork runtime flags without persisting key material, and install rollback when service start fails, fake-command `service-manager` rendering tests for LaunchAgent `KeepAlive`/`SuccessfulExit=false` plus `LimitLoadToSessionType=Aqua` and `EnvironmentVariables`, and systemd `Restart=on-failure`/`RestartSec=5` plus `Environment="PATH=..."` and `Environment="XDG_RUNTIME_DIR=..."`, local handoff restart-restore smoke, `scripts/smoke-macos-daemon-launchd.sh` real local launchd restart smoke for npm-trust-prepared Darwin binaries using a temp project outside macOS Desktop/Documents TCC-protected locations, retained 2026-05-30 evidence at `/tmp/fwld.i7Ckgt/evidence` showing npm trust, `fw doctor --no-start`, `pkill -KILL fieldworkd`, `restart_ms=369`, socket reachability, restored session list, `MACOS_KILL_SCROLLBACK_BEFORE` in both live pre-kill and restored replay transcripts, restored attach `[fieldwork: session exited 0]`, and clean daemon log, `docs/MACOS_DAEMON_SURVIVAL.md`, `scripts/create-macos-daemon-survival-evidence-dir.mjs`, `scripts/verify-macos-daemon-survival-evidence.mjs` fixture coverage for npm-trust-prepared launchd sleep/wake plus `pkill -KILL fieldworkd` restart evidence with `processes_died_documented`, the macOS daemon survival evidence scaffold self-test, and `scripts/verify-daemon-service.mjs` | Static/source and local launchd restart verified; formal retained sleep/wake and Linux user-service survival gates still need an npm-installed/ad-hoc-signed artifact or an actual Linux user-service host |
| Daemon log retention | `crates/daemon/src/logging.rs`, `logging::tests::prune_old_log_files_removes_only_expired_daemon_logs`, and `scripts/verify-daemon-service.mjs` verify seven-day startup pruning for `daemon.log*` files only | Locally verified |
| Desktop cold-start performance thresholds | `scripts/measure-desktop-performance.mjs` and `pnpm measure:desktop-performance` build on release binaries, run one explicit warm-up sample to remove build-machine first-exec noise, then fail if any measured `fieldwork version` sample exceeds 50 ms or any measured daemon ready-to-handshake sample exceeds 200 ms; latest pass from `pnpm check:local-release:full` measured CLI max `3.47ms` and daemon max `41.51ms` over 25 measured samples | Locally verified |
| Development doc | `docs/DEVELOPMENT.md` documents the 15-minute source-build path, common local checks, protocol/ring/snapshot/mobile-core focused tests, local handoff smoke, desktop release/performance commands, website checks, UniFFI bindgen, iOS/Android development flows, mobile privacy/telemetry facts, daemon logs, and user-service lifecycle; `scripts/verify-development-doc.mjs` pins those claims and CI wiring | Locally verified |
| Docs synchronized | `scripts/verify-docs-sync.mjs` requires `README.md`, `PLAN.md`, `FUTURE.md`, `docs/PROTOCOL.md`, `docs/PRIVACY.md`, `docs/ARCHITECTURE.md`, `docs/INSTALL.md`, `docs/ANDROID_RENDERER.md`, `docs/ANDROID_PAIR_FLOW.md`, `docs/ANDROID_SESSION_SUBSCRIPTION.md`, `docs/ANDROID_TERMINAL_ATTACH.md`, `docs/ANDROID_RESIZE_DETACH.md`, `docs/ANDROID_BIOMETRIC.md`, `docs/ANDROID_DOGFOOD.md`, `docs/ANDROID_COLD_START.md`, `docs/ANDROID_RENDERER_FLOOD.md`, `docs/ANDROID_BACKGROUND_FOREGROUND.md`, `docs/ANDROID_NETWORK_RECONNECT.md`, `docs/ANDROID_RESTART_RESTORE.md`, `docs/ANDROID_MULTISESSION.md`, `docs/ANDROID_FCM_PUSH.md`, `docs/RELAY_HONEYCOMB.md`, `docs/MACOS_DAEMON_SURVIVAL.md`, `docs/LIVE_TESTING.md`, `docs/OPERATIONS.md`, and `docs/RELEASE_AUDIT.md` to exist and carry the current v1 install, protocol, privacy, architecture, Android renderer, Android pair flow, Android session subscription, Android terminal attach, Android resize/detach, Android biometric, Android dogfood, Android cold-start, Android renderer flood, Android background/foreground, Android network reconnect, Android restart restore, Android multisession, Android FCM push, relay Honeycomb evidence, macOS daemon survival, first live-test, operator npm/secret handoff, iOS blocker, mobile-boundary, npm-only distribution, and deferred-scope facts; `docs/DEVELOPMENT.md` and `docs/SECURITY.md` remain covered by the focused release, infra, security-model, telemetry, and privacy verifiers | Current |
| README screenshots and 60-second demo video | README embeds the three screenshot-style SVG captures and links `docs/assets/fieldwork-demo-v1.mp4`; `scripts/render-demo-video.mjs` regenerates the MP4 from those assets plus fixed release-boundary slates, and `pnpm check:demo-video` verifies an H.264 1920x1080 artifact with approximately 60-second duration | Locally verified |
| GitHub contribution templates | `.github/ISSUE_TEMPLATE/bug.yml`, `feature.yml`, `question.yml`, `.github/PULL_REQUEST_TEMPLATE.md`, `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, `LICENSE`, and `NOTICE`; `scripts/verify-community-scaffold.mjs` verifies the templates require actionable repro/scope/context fields, privacy/security reminders, v1/FUTURE boundary checks, external-gate disclosure, and the AGPL/App-Store-permission docs | Locally verified |
| Relay operations and key rotation | `docs/OPERATIONS.md` documents deploy verification, the `fieldwork-app/fieldwork` release-rust cosign identity, the macOS signing/notarization verifier handoff, the operator-owned release-gate handoff, GitHub Actions release secrets, npm ownership bootstrap for the platform child packages, quarterly APNs/FCM/Honeycomb/SSH rotation, incident response, and relay-side token deletion; `scripts/verify-infra-scaffold.mjs` now pins those runbook prerequisites, GitHub secrets checklist, npm bootstrap instructions, release-gate handoff steps, rotation steps, incident response steps, data-deletion flow, and local verification commands | Local runbook verified; hosted execution blocked |
| App Store privacy nutrition labels / Play Data safety | `docs/STORE_PRIVACY.md`, `scripts/verify-store-privacy.mjs`, and `scripts/verify-mobile-privacy.mjs` | Answer sheets prepared and synchronized with local manifest/default notification/diagnostics checks; console submission blocked |
| AGPL OSS posture | `scripts/verify-rust-workspace.mjs` checks Cargo AGPL/repository metadata, `scripts/verify-npm-packages.mjs` checks root AGPL text, NOTICE section-7 App Store/TestFlight permission wording, and npm package AGPL/repository metadata, and `scripts/generate-oss-notices.mjs --check` verifies generated native OSS notice screens | Locally verified |
| Site for `fieldwork.dev` | `site/` Astro project, `site/astro.config.mjs`, `deploy-site.yml`, `scripts/verify-site-content.mjs`, `scripts/verify-release-workflows.mjs`, and agent-browser screenshot smoke for all five pages; the verifiers pin the Cloudflare Pages deploy workflow contract, isolated `site/pnpm-lock.yaml` install, root `pnpm build:site`, Cloudflare credentials before site install/build, clean push skip when credentials are absent, manual-dispatch fail-closed behavior, `fieldwork-dev` Pages project, canonical `https://fieldwork.dev` site URL, v1 install/protocol/privacy claims, screenshot SVG imports, and out-of-scope surface exclusions. `scripts/check-domain-status.mjs --operator-refresh` remains available only for operator-requested status refreshes and fails closed without that flag | Local build, browser smoke, content, and deploy scaffold verified; Cloudflare/domain ownership blocked |
| Appendix B external reservations | `PLAN.md` Appendix B tracks platform child package publish rights, domain, GitHub org/repo, social handle, Oracle, Apple Developer, Honeycomb account setup, and the launch-plan calendar block. Live npm/domain/GitHub status scripts are not routine local checks; they remain available only for operator-requested post-state or status refreshes, and `scripts/test-external-status-refresh.mjs` verifies domain/GitHub refreshes fail closed before network access without `--operator-refresh` | Not locally completable from this shell without account ownership/payment credentials or the user's calendar commitments |

## Latest Focused Refresh

After tightening npm registry-state wording, adding the npm publish missing-token
guard, adding hosted-relay aggregate Android emulator substitute-suite evidence,
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
pnpm check:local-release:full
pnpm test:npm-publish-plan
pnpm check:npm-packages
pnpm check:development-doc
pnpm check:release-audit
pnpm check:docs-sync
pnpm test:live-testing-evidence
pnpm check:local-release
pnpm check:release-workflows
pnpm check:secret-boundaries
pnpm test:secret-boundaries
pnpm check:security-model
pnpm check:android-aab
node scripts/test-android-aab-verifier.mjs
node scripts/test-android-aab-signing-smoke.mjs
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
pnpm test:npm-local-install
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
coverage for default-off diagnostics sharing, declined one-time consent resolution,
and local diagnostics preference behavior. `pnpm test:android-debug-smoke` passed
on a wiped API 36.1 AVD with debug launch, locked-surface, crash-log, and
nonblank-screenshot evidence while preserving physical release-device gates.
The hosted-relay `pnpm test:android-emulator` aggregate passed on
`emulator-5554` with locked debug launch `TotalTime=6448ms` (below the default
8000ms limit), pair `pair_flow_ms=1420`, session subscription
`visible_ms=5493`, flood screenshot 8437/14400 nonblack samples, and successful
background replay, restart restore, multisession, reconnect, and notification
tap routing.
`pnpm check:android-aab` verified the preserved release AAB ABI slices,
packaged manifest identity/version, release `BuildConfig`, uses-permission
allowlist, packaged manifest privacy surface, and absence of Sentry/crash-reporting
SDK markers in packaged dex/manifest content and archive entry names; the Android AAB verifier
self-test now covers forbidden location permission, missing notification permission,
terminal-content metadata such as `last_line`, wrong release version, debug
`BuildConfig`, debuggable manifest state, synthetic Sentry dex markers, signed-bundle rejection
under the local unsigned policy, signed-release acceptance under
`--expect-signed`, signed-looking bundle rejection when `jarsigner` verification
fails, zero-exit `jarsigner` output without `jar verified`, Android Debug
certificate output, and unsigned-bundle rejection under `--expect-signed`. After
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
protocol, privacy, architecture, Android renderer, first live-test, operator
npm/secret handoff, iOS blocker, mobile-boundary, npm-only distribution, and
deferred-scope facts, including the README pointer to the operator-facing
release-gate handoff and `PLAN.md` completion-checkbox source of truth. The development doc verifier passed, pinning `docs/DEVELOPMENT.md` to the 15-minute source-build path, common checks, focused protocol/PTY/mobile-core tests, local handoff smoke, desktop release/performance commands, website checks, UniFFI bindgen, iOS/Android development flows, mobile privacy/telemetry facts, daemon logs, and user-service lifecycle. The community scaffold verifier passed,
pinning the PR/issue templates, root OSS/security docs, and pre-commit hooks to
the v1 privacy, security, verification, and external-gate contract. The security model verifier passed, pinning `docs/SECURITY.md` to the v1 trust zones, local IPC hardening, pairing/device auth, encrypted local storage, raw-byte terminal privacy, relay push controls, mobile biometric gates, remaining external gates, and CI wiring. The infra scaffold verifier passed, including focused coverage for the operations runbook's
operator-owned release-gate handoff, GitHub secrets checklist, npm ownership
bootstrap instructions, `PLAN.md` checkbox source of truth for external gates,
operator-reservation evidence handling, Appendix B operator reservations,
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
`tfvars` files. The site content verifier passed, pinning the `fieldwork.dev` pages to v1 install, protocol, architecture, privacy, screenshot SVG imports, and future-scope exclusions. Domain status refresh is no longer an agent-owned routine release activity; `scripts/check-domain-status.mjs --operator-refresh` remains available for explicit operator-requested refreshes only, and the script fails closed before network access without that flag. The release-workflow verifier now also pins the Cloudflare Pages deploy scaffold for `fieldwork.dev`, including the isolated site lockfile install, root `pnpm build:site`, Cloudflare credential preflight, clean skip for pushes without Cloudflare secrets, manual-dispatch fail-closed behavior, and the `fieldwork-dev` Pages project. The release-workflow verifier now also pins the weekly Dependabot matrix for Cargo, root npm package metadata, the isolated `site/` npm lockfile, Android Gradle, and GitHub Actions. The focused daemon state-inference fixture tests passed, and the focused daemon local-agent-hook tests passed for `matching_local_agent_hook_updates_session_state`, `mismatched_local_agent_hook_is_rejected`, and `ipc_handler_acknowledges_local_agent_hook_and_reports_errors`, verifying that matching LocalCli Claude/Codex hook events update only matching PTY sessions while mismatched hook sources or missing sessions are rejected and surfaced back to the CLI hook adapter. The daemon
service scaffold verifier passed, the direct bincode IPC mobile create/kill rejection test passed for `IosApp` and `AndroidApp`, the direct bincode IPC mobile agent-state hook rejection test passed for `IosApp` and `AndroidApp`, the local handoff smoke now also covers acknowledged matching Claude hook delivery, mismatched Codex hook nonzero failure, and paired iroh mobile agent-state hook rejection, and the latest local handoff smoke paired in 2 seconds before exercising `claude`, `bash`, `vim`, subscribed session updates,
mobile input, warm reconnect replay over iroh within 2 seconds from `last_seen_seq` (17ms in the latest local run), protocol-mismatch rejection, mobile create/kill/agent-state-event rejection, revocation, and restart restore.
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
`pnpm test:npm-local-install`, `pnpm test:bun-install`, `pnpm test:relay-tls`, `pnpm test:relay-otlp`,
`node scripts/measure-desktop-performance.mjs`,
`node scripts/verify-npm-packages.mjs --require-binaries`,
`node scripts/publish-npm-packages.mjs --check-ready`, and
`npm pack ./packages/cli --dry-run --json`. The focused relay ownership test
`cargo test -p fieldwork-relay rejects_cross_daemon_token_use` also passed,
verifying the Section 7.3.1 cross-daemon token-use no-ship gate. Bun optional
dependency install compatibility passed across four platform cases on Bun
1.3.13. Relay TLS and OTLP loopback smokes passed; the latest 2026-05-23 aggregate
`pnpm check:local-release:full`
pass verified the preserved AAB, staged npm binaries, npm publish readiness,
meta-package dry-run pack, local handoff smoke, demo video, site typecheck/build,
Terraform fmt/init/validate, relay TLS/OTLP loopbacks, and desktop performance.
An earlier rerun hit local temp-volume exhaustion while unpacking Cargo registry
files under an isolated temp `HOME`; after removing the generated
`/tmp/fieldwork-target-checks` directory and using the normal Cargo
cache/target paths, the same gate passed without product-code changes. A
follow-up 2026-05-30 `pnpm check:local-release:full` pass verified
the current source tree after the local handoff smoke preserved host
`CARGO_HOME`/`RUSTUP_HOME` and named its subscription/reconnect sessions
explicitly under the daemon duplicate-name rule. The latest 2026-05-30 full
pass after Android artifact hardening ended with
`local release gate ok with staged artifacts and runtime checks`. Its
performance run reported CLI median `2.71ms`, p95 `3.08ms`, max `3.47ms`, and
daemon ready-to-handshake median `39.18ms`, p95 `40.77ms`, max `41.51ms` over
25 measured release-build samples; npm binary readiness passed
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
A 2026-05-30 direct adb locked-launch refresh after the full local release gate
reinstalled the current default debug APK, cleared app data, confirmed the debug
`BuildConfig` still had biometric bypass, debug pairing code, and debug relay URL
disabled, launched `app.fieldwork.android/.MainActivity` with `Status: ok` and
`LaunchState: COLD`, captured `/tmp/fieldwork-adb-locked-20260530071152/locked.png`
plus UI XML showing only the locked `Unlock` surface, and found no Android fatal,
ANR, `am_crash`, or `AndroidRuntime` entries with an empty crash buffer. The same
refresh created `/tmp/fieldwork-live-testing-20260530071450`; local live-test
readiness and Android release-readiness checks passed with only physical-device,
real release-signing, and Play credential steps pending.
A 2026-05-19 raw adb emulator QA refresh installed the default debug APK, launched
with `Status: ok` and `TotalTime=5297ms`, captured
`/tmp/fieldwork-adb-direct-20260519225027/default.png`,
`/tmp/fieldwork-adb-direct-20260519225027/default-ui.xml`,
`/tmp/fieldwork-adb-direct-20260519225027/default-logcat.log`, and an empty
`/tmp/fieldwork-adb-direct-20260519225027/default-crash.log`, and verified the
locked `Unlock` surface. The same direct adb run rebuilt the debug APK with
`FIELDWORK_ANDROID_BIOMETRIC_BYPASS=true` plus debug-only
`FIELDWORK_ANDROID_PAIRING_CODE`, launched the pair build in
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
and `FIELDWORK_DEBUG_PAIRING_CODE = ""`, the restored default build launched
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
`FIELDWORK_DEBUG_PAIRING_CODE`. A paired-data force-stop/relaunch completed
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
`FIELDWORK_ANDROID_PAIRING_CODE`, paired through explicit desktop approval,
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
`FIELDWORK_DEBUG_PAIRING_CODE = ""`, the restored default build launched in
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
`FIELDWORK_DEBUG_PAIRING_CODE = ""`.
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
`FIELDWORK_DEBUG_PAIRING_CODE = ""`.
A 2026-05-23 direct adb refresh under
`/tmp/fieldwork-adb-direct-20260523103948` repeated that first-live-test shape
against the current tree without an Android wrapper smoke script. The default
debug APK launched locked in `TotalTime=1922ms`; a temp npm-layout `fw` shim
with sibling `fieldworkd` symlink created auto-named `widget`; `fw refactoringjob`
created the named Claude session; and `fieldwork new --name shell` created a
desktop-owned shell. Android paired through the actual Pair UI and explicit
desktop approval, the dashboard showed `widget`,
`refactoringjob`, and `shell`, app logcat showed `FieldworkRepository: pair
completed` plus `FieldworkRepository: listSessions returned 3 sessions`,
Android attached to `shell`, sent `fw_android_live_ok`, and
  `terminal-replay-clean.txt` contained `android-direct: fw_android_live_ok`. A
  force-stop/relaunch restored the paired dashboard in `TotalTime=1266ms` with
  that scrollback. The debug APK was rebuilt/reinstalled afterward,
  `BuildConfig.java` showed `FIELDWORK_BIOMETRIC_BYPASS = false` and
  `FIELDWORK_DEBUG_PAIRING_CODE = ""`, the restored locked launch completed in
  `TotalTime=1321ms`, and all Fieldwork crash/ANR scans plus crash buffers were
  empty. This remains debug-emulator evidence only, not physical release-device
  evidence.
  A 2026-05-30 direct adb current-app refresh under
  `/tmp/fieldwork-adb-direct-20260530042105` repeated the current hosted relay
  typed-code Pair UI path against an isolated release daemon. The default debug
  APK first showed the locked `Unlock` surface, the temporary biometric-bypass
  pair build completed only after explicit desktop approval, Android listed
  `adbpair`, attached the live terminal, sent `android_adb_direct_ok`, and
  `desktop-replay.txt` confirmed `android-direct: android_adb_direct_ok` in the
  daemon-owned PTY replay. Logcat showed repository pair/list activity, crash
  buffers were empty, no Fieldwork fatal/ANR entries were found, and the restored
  default debug APK returned to empty debug pairing and relay-control values.
  This remains debug-emulator evidence only, not physical release-device
  evidence.
A direct adb empty-dashboard refresh then paired an isolated release daemon with
no pre-existing sessions through explicit desktop approval and captured
`/tmp/fieldwork-empty-direct-20260520162209/empty-dashboard.png` plus
`/tmp/fieldwork-empty-direct-20260520162209/empty-dashboard.xml`. The UI dump
showed `No sessions` and `Create one on your laptop with fw new.`, app logcat
showed `FieldworkRepository: pair completed` and `FieldworkRepository:
listSessions returned 0 sessions`, crash buffers were empty, and the restored
default APK had `FIELDWORK_BIOMETRIC_BYPASS = false`,
`FIELDWORK_DEBUG_PAIRING_CODE = ""`, and the locked `Unlock` surface at
`/tmp/fieldwork-empty-direct-20260520162209/default-locked.png`.
A 2026-05-20 direct locked-launch refresh on a freshly booted `Medium_Phone_API_36.1` emulator
installed the default debug APK, launched with `Status: ok`,
`LaunchState: COLD`, and `TotalTime=1919ms`, captured
`/tmp/fieldwork-adb-direct-20260520092447/default-locked.png`,
`/tmp/fieldwork-adb-direct-20260520092447/default-ui.xml`,
`/tmp/fieldwork-adb-direct-20260520092447/default-logcat.log`,
`/tmp/fieldwork-adb-direct-20260520092447/default-app-pid-logcat.log`, and an
empty `/tmp/fieldwork-adb-direct-20260520092447/default-crash.log`, verified a
1080x2400 screenshot plus `text="Unlock"` in the UI dump, and found no Fieldwork `FATAL EXCEPTION` or ANR log entries.
A 2026-05-21 direct adb pair/attach refresh under
`/tmp/fieldwork-adb-direct-20260521165654` installed a debug-only pairing code
build after a default locked-surface capture, paired through explicit desktop
approval, listed `android-direct`, attached the terminal, sent
`fw_direct_20260521_ok` with `adb shell input text`, captured dashboard and
terminal screenshots/UI dumps/logcat/crash buffers, and saved a desktop replay at
`pair-runtime/pty-replay-after-input.txt` containing
`android-direct: fw_direct_20260521_ok`. The restored default debug APK had
`FIELDWORK_BIOMETRIC_BYPASS = false`, `FIELDWORK_DEBUG_PAIRING_CODE = ""`,
relaunched with `Status: ok` and `TotalTime=1862ms`, showed the locked `Unlock`
surface, and had an empty crash buffer.
The generated UniFFI binding refresh passed after verifying the Android Kotlin
binding exposes the v1 pair/list/subscribe/attach/input/resize/detach and
push-token API, rejects generated mobile create/kill/session-command APIs, and
verifies Android Gradle, Android Rust build-script, iOS build-script, Xcode
generated Swift, and xcframework wiring.
The release-workflow secret hygiene refresh also passed after verifying
`release-rust.yml` builds Darwin desktop artifacts without Apple credentials,
ad-hoc signs `fieldwork` and `fieldworkd` with `codesign --force --sign -`, and
runs `node scripts/verify-macos-signing.mjs` so both binaries must verify as
executable, signed, and quarantine-free before archive staging. `release-ios.yml`
keeps App Store Connect upload JSON outside the repository workspace and removes
signing and upload assets. `release-android.yml` preflights
Firebase/signing/HTTPS relay-control/Play secrets before toolchain setup and
mobile build. `release-android.yml` removes
generated Firebase/signing files in an `always()` cleanup step.
`deploy-relay.yml` removes the decoded relay SSH key in an `always()` cleanup
step.
The release-rust archive checksum step now runs `LC_ALL=C LANG=C shasum -a 256`
so macOS Perl-backed `shasum` is not sensitive to unsupported inherited
`C.UTF-8` locale settings.
The daemon service preflight refresh passed focused `fieldwork-cli` service
tests and targeted clippy after replacing the previous Developer ID notarization
requirement with the npm trust path. Direct daemon auto-spawn still uses the
colocated `fieldworkd` path, preserving source-build and dispatcher fallback
behavior. The 2026-05-30 retained launchd smoke at `/tmp/fwld.i7Ckgt/evidence`
covered the npm-installed/ad-hoc-signed local restart path and restored
scrollback replay from a temp project directory outside macOS Desktop/Documents
TCC-protected locations, but the formal survival evidence still requires
sleep/wake transcripts or an actual Linux user-service host.
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
and daemon commands, verifies the packed meta tarball includes both executable dispatcher files, and covers the no-subcommand auto-create parser and npm
dispatcher paths for `fieldwork`/`fw`, the `fw <name>` named-session fast path,
and `fieldwork new
--name <name> [cmd...]` for explicitly named arbitrary-command PTYs. The no-name
default create path now always creates a new default `claude` session, generates
short one-word names, and stores them in the daemon session summary that mobile
dashboards already render; daemon IPC rejects
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
  exact SwiftTerm 1.13.0 Xcode/SPM pin, the explicit
  iOS QR camera authorization path, the iOS raw-output revision guard that
  keeps SwiftTerm delivery independent of UTF-8 fallback decoding, and the
  SwiftTerm raw byte-array renderer guard.
- `pnpm check:store-privacy`: passed, verifying the App Store/Play answer sheet
  against the mobile manifests, native notification handlers, and diagnostics
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
pnpm test:npm-local-install
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
`pnpm check:secret-boundaries` scan covered 42 retained non-relay artifacts and
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
node scripts/verify-release-workflows.mjs --self-test
node scripts/verify-release-workflows.mjs
node scripts/verify-relay-provider-clients.mjs
cargo test -p fieldwork-cli service
node scripts/verify-daemon-service.mjs
node scripts/verify-daemon-resize.mjs
node scripts/verify-infra-scaffold.mjs
scripts/smoke-relay-tls-loopback.sh
node scripts/test-npm-dispatcher.mjs
node scripts/test-release-artifacts.mjs
node scripts/test-macos-signing-verifier.mjs
node scripts/test-macos-signing-evidence.mjs
node scripts/test-macos-signing-scaffold.mjs
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

- `cargo nextest run --workspace`: 203 tests passed.
- `cargo test --workspace --doc`: workspace doctest harnesses passed; there
  are currently zero doctests.
- `cargo nextest run -p fieldwork-daemon`: 75 daemon tests passed, including the
  seven-day daemon-log pruning,
  and the real `vim /etc/hosts` stale-attach snapshot rehydration gate.
- `cargo deny check`: exited successfully with `advisories ok, bans ok,
  licenses ok, sources ok`; duplicate-crate findings were warnings only.
- `cargo audit`: scanned 748 dependencies and exited successfully with allowed
  warnings only: `adler` `RUSTSEC-2025-0056`, `atomic-polyfill`
  `RUSTSEC-2023-0089`, `bincode` `RUSTSEC-2025-0141`, `paste`
  `RUSTSEC-2024-0436`, and `lru` `RUSTSEC-2026-0002`, as documented in
  `docs/DEVELOPMENT.md`.
  Follow-up dependency inspection confirmed `lru 0.12.5` is pulled only through
  `tattoy-wezterm-term`, `cargo update -p lru@0.12.5 --dry-run` found no
  compatible lockfile move, Fieldwork does not call `lru::IterMut` directly, and
  `scripts/verify-rust-workspace.mjs` rejects direct `lru` dependencies plus
  `lru::` source paths while the advisory is allowlisted only as a transitive
  terminal-state dependency.
  `atomic-polyfill 1.0.3` is pulled through `postcard 1.1.3 -> heapless
  0.7.17` for compact pairing-ticket encoding and iroh's relay path;
  `cargo update -p postcard --dry-run` found no compatible lockfile move,
  Fieldwork does not call `atomic_polyfill::` directly, and
  `scripts/verify-rust-workspace.mjs` rejects direct `atomic-polyfill`
  dependencies plus `atomic_polyfill::` source paths while the advisory is
  allowlisted only as a transitive pairing-ticket dependency.
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
- Cross-target desktop release builds passed on 2026-05-20 for `fieldwork`,
  `fieldworkd`, and `fieldwork-relay` on `aarch64-apple-darwin`,
  `x86_64-apple-darwin`, `x86_64-unknown-linux-gnu`, and
  `aarch64-unknown-linux-gnu`; `file` identified the expected
  Mach-O arm64/x86_64 and ELF x86-64/aarch64 binaries. The four generated npm
  platform package binary pairs were refreshed from those outputs, the host
  staged `fieldworkd` entrypoint was verified for `--help`/`--version`, and
  `pnpm check:local-release --with-artifacts` passed against the refreshed
  staged packages.
- Oracle relay provisioning scaffold is present under `infra/oracle`: Terraform
  fmt/init/validate passed against the OCI provider, `provision-region.sh`
  supplies the A1-capacity retry wrapper, `watch-a1-capacity.sh` polls Oracle's
  compute-capacity-report API before running Terraform, and
  `pnpm check:infra-scaffold` verifies the Terraform/Ansible/deploy handoff
  contract. A live 2026-05-28 OCI Mumbai apply authenticated through the local
  `FIELDWORK` profile, created the `fieldwork` compartment's VCN, public subnet,
  internet gateway, route table, and security list, then failed only at
  `VM.Standard.A1.Flex` launch with OCI `500-InternalError, Out of host
  capacity`; a reduced 1 OCPU / 1 GiB retry hit the same capacity blocker. The
  Terraform scaffold now supports explicit `fault_domain` placement for A1
  retries, and the capacity watcher checks `FAULT-DOMAIN-1`,
  `FAULT-DOMAIN-2`, and `FAULT-DOMAIN-3` every configured interval, applying
  only when one reports `AVAILABLE`. A live OCI capacity report on 2026-05-28
  returned `OUT_OF_HOST_CAPACITY` for 1 OCPU / 6 GiB A1 in all three fault
  domains.
- Relay OTLP loopback smoke passed: local collector received an
  `application/x-protobuf` `/v1/traces` POST for `/v1/version`, and the exported
  protobuf body did not contain injected terminal/session/token sentinel strings.
- Desktop performance passed after one explicit warm-up sample, with CLI median
  `2.71ms`, p95 `3.08ms`, max `3.47ms`, and daemon ready-to-handshake median
  `39.18ms`, p95 `40.77ms`, max `41.51ms` over 25 measured release-build
  samples in the latest `pnpm check:local-release:full` run.
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
- Android release bundle validation was refreshed locally on 2026-05-29 with
  `pnpm test:android-unit`,
  `apps/android/gradlew --no-daemon :app:bundleRelease`,
  `pnpm check:android-aab`, and
  `pnpm check:live-testing-readiness:local`, and
  `pnpm check:android-release-readiness:local`; `pnpm check:android-aab`
  passed for `arm64-v8a`, `armeabi-v7a`, and `x86_64`
  `libfieldwork_mobile_core.so`, with no accidental 32-bit x86 Fieldwork core
  and with the packaged protobuf manifest identity/version, release
  `BuildConfig`, uses-permission allowlist, and privacy surface checked for
  required Firebase opt-out metadata plus forbidden content/permission
  strings.
  Current AAB: `57M`, SHA-256
  `af38adfb7541caf31c45afa216c61c4fa2dbce9ab1168ce91181f91a1f0ccca8`.
  Firebase project `fieldwork-oss` has an active Android app for
  `app.fieldwork.android`, the ignored local
  `apps/android/app/google-services.json` is populated for source-checkout
  builds, and `ANDROID_GOOGLE_SERVICES_JSON` is set on the
  `fieldwork-app/fieldwork` GitHub repository. Local Android release readiness
  now recognizes that GitHub Actions secret while keeping signing, Play upload,
  signed artifact, and physical-phone requirements pending until those real
  gates are satisfied.
  `pnpm check:android-aab` now runs the verifier with `--expect-unsigned`, and
  `node scripts/test-android-aab-verifier.mjs` covers synthetic unsigned and
  signed AABs, including rejection of signature entries under
  `--expect-unsigned`, acceptance of signature entries under `--expect-signed`,
  rejection of signed-looking bundles when `jarsigner` verification fails, and
  rejection of zero-exit `jarsigner` output without `jar verified`, Android
  Debug certificate output, unsigned bundles under `--expect-signed`, wrong
  release version, debug `BuildConfig`, missing or non-HTTPS release relay
  control URL under `--expect-relay-control-url`, and debuggable manifest state.
  `pnpm test:android-aab-signing-smoke` signs a temporary copy of the current
  real AAB with an ephemeral non-debug certificate, verifies that copy through
  `node scripts/verify-android-aab.mjs --expect-signed`, and removes the
  temporary keystore plus signed bundle without changing the retained unsigned
  local artifact.
  A 2026-05-25 direct-adb debug APK hygiene refresh found a retained
  `app-debug.apk` from an earlier debug-pairing run that still embedded a
  one-time legacy JSON pairing payload even though generated debug `BuildConfig.java` had
  `FIELDWORK_BIOMETRIC_BYPASS = false` and
  `FIELDWORK_DEBUG_PAIRING_CODE = ""`. `pnpm check:android-debug-apk` now
  rejects stale legacy JSON pairing payload in `classes*.dex`, verifies the
  default debug `BuildConfig`, app identity/version, manifest privacy surface,
  and all three Fieldwork core ABI slices. `node scripts/test-android-debug-apk-verifier.mjs`
  covers stale legacy payload, explicit legacy-payload mode, missing-ABI,
  forbidden-permission, and non-empty BuildConfig cases, and
  `pnpm check:local-release -- --with-artifacts` runs the current debug APK
  artifact check alongside the AAB checks.
  `node scripts/test-android-pair-button-picker.mjs` pins the current Compose
  accessibility tree where the full-width Pair button is textless, so adb smokes
  locate it from the `Pairing code` field and the first enabled full-width
  clickable control below it rather than a brittle visible-text match.
  Android Studio's bundled `jarsigner` reports `jar is unsigned` for the local
  bundle. The release workflow verifier rejects using
  `node scripts/verify-android-aab.mjs --expect-unsigned` in
  `release-android.yml`, requires
  `node scripts/verify-android-aab.mjs --expect-signed --expect-relay-control-url`
  so signed mode also runs `jarsigner -verify -certs`, requires the
  `jar verified` marker, proves an HTTPS relay-control URL for typed-code
  pairing, rejects Android Debug certificates, and keeps a second
  `jarsigner -verify -certs` before Play upload. Real release signing remains
  blocked by the external Play-keystore gate. The signed-release evidence
  contract now lives in `scripts/verify-android-release-signing-evidence.mjs`
  with fixture coverage in `scripts/test-android-release-signing-evidence.mjs`.
  `scripts/create-android-release-signing-evidence-dir.mjs` creates a capture
  scaffold, and `scripts/test-android-release-signing-scaffold.mjs` verifies the
  scaffold does not fabricate `artifact-signing.txt`, `jarsigner.txt`,
  `sha256.txt`, `buildconfig.txt`, or `workflow-run.txt`. That verifier rejects
  debug, local smoke signers, and non-HTTPS release relay URL evidence, and
  remains unchecked until `release-android.yml` produces a signed AAB from the
  operator-owned release keystore.
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
  A 2026-05-23 direct adb pre-unlock biometric refresh under
  `/tmp/fieldwork-adb-direct-20260523120245` installed the current normal debug
  APK, launched `app.fieldwork.android/.MainActivity` with `Status: ok`,
  `LaunchState: COLD`, and `TotalTime=5888ms`, verified
  `FIELDWORK_BIOMETRIC_BYPASS = false` and
  `FIELDWORK_DEBUG_PAIRING_CODE = ""`, captured locked and post-Unlock-tap
  screenshots/UI dumps/logcat plus empty crash buffers, and showed the app
  stayed on the locked `Unlock` surface after `BiometricService` rejected
  authentication for no enrolled biometric. The filtered logcat did not show
  Fieldwork `listSessions`, `registerPushToken`, terminal attach, input,
  `FATAL EXCEPTION`, or ANR entries.
  `FIELDWORK_ANDROID_BIOMETRIC_BYPASS=true pnpm test:android-debug-smoke`
  compiles a debug-build-only bypass guarded by `BuildConfig.DEBUG` so emulator
  QA can reach the unlocked pairing/bottom-navigation UI when no biometric is
  enrolled; release builds hardcode it off. `pnpm test:android-emulator-pair`
  uses that guard plus debug-only `FIELDWORK_ANDROID_PAIRING_CODE` to pair the
  real Android app with an isolated local release daemon, measure the debug-app
  Pair tap through explicit desktop approval completion, fail above the local
  15-second emulator bound, verify a desktop-created session appears, open the
  terminal, background and foreground the app, send mobile-originated input into
  the PTY, and attach a separately approved verifier client to confirm the
  Android-sent output appears in replayed terminal bytes.
  The hosted-relay typed-code emulator smokes set a deterministic test-only
  `FIELDWORK_RELAY_SIGNING_KEY_B64` in isolated temp daemon environments,
  require an explicit relay control URL, and do not hardcode a public iroh relay
  unless the operator sets `FIELDWORK_ANDROID_IROH_RELAY_URL`.
  Latest focused run passed on `emulator-5554` with `pair_flow_ms=2206`.
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
  separately approved replay verifier; latest hosted-relay aggregate run
  reported 8437/14400 nonblack screenshot samples.
  `pnpm test:android-emulator-multisession` opens
  three desktop-created sessions (`fwm_a`, `fwm_b`, `fwm_c`), switches among all
  three in the app, sends Android-originated input to each, and verifies
  host-side per-session logs so `multi_a_ok`, `multi_b_ok`, and `multi_c_ok`
  land only in their selected PTYs; latest focused run on 2026-05-29 passed on
  `emulator-5554` after hosted-relay typed-code hardening.
  `pnpm test:android-emulator-session-subscription` pairs with no pre-existing
  sessions, observes the empty dashboard, creates `fw_subscribe_session` from
  the desktop CLI, verifies the subscribed dashboard receives it within the
  local 8-second emulator bound, opens it, sends `subscription_attach_ok`, and
  confirms the PTY receives that Android-originated input; the smoke now
  recovers Fieldwork foreground before UI dumps and falls back to file-backed
  `uiautomator` dumps when direct streaming hangs. Latest focused run passed on
  `emulator-5554` with `visible_ms=2904`.
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
