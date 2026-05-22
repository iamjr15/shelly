#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const failures = [];

const docs = {
  readme: read("README.md"),
  plan: read("PLAN.md"),
  protocol: read("docs/PROTOCOL.md"),
  privacy: read("docs/PRIVACY.md"),
  architecture: read("docs/ARCHITECTURE.md"),
  install: read("docs/INSTALL.md"),
  androidRenderer: read("docs/ANDROID_RENDERER.md"),
  androidDogfood: read("docs/ANDROID_DOGFOOD.md"),
  androidColdStart: read("docs/ANDROID_COLD_START.md"),
  androidBackgroundForeground: read("docs/ANDROID_BACKGROUND_FOREGROUND.md"),
  androidNetworkReconnect: read("docs/ANDROID_NETWORK_RECONNECT.md"),
  androidFcmPush: read("docs/ANDROID_FCM_PUSH.md"),
  macosDaemonSurvival: read("docs/MACOS_DAEMON_SURVIVAL.md"),
  liveTesting: read("docs/LIVE_TESTING.md"),
  operations: read("docs/OPERATIONS.md"),
};

verifyRequiredDocsExist();
verifyReadme();
verifyProtocolDoc();
verifyPrivacyDoc();
verifyArchitectureDoc();
verifyInstallDoc();
verifyAndroidRendererDoc();
verifyAndroidDogfoodDoc();
verifyAndroidColdStartDoc();
verifyAndroidBackgroundForegroundDoc();
verifyAndroidNetworkReconnectDoc();
verifyAndroidFcmPushDoc();
verifyMacosDaemonSurvivalDoc();
verifyLiveTestingDoc();
verifyOperationsDoc();
verifyPlanDoc();

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log("docs sync contract ok");

function verifyRequiredDocsExist() {
  for (const rel of [
    "README.md",
    "PLAN.md",
    "FUTURE.md",
    "docs/PROTOCOL.md",
    "docs/PRIVACY.md",
    "docs/ARCHITECTURE.md",
    "docs/INSTALL.md",
    "docs/ANDROID_RENDERER.md",
    "docs/ANDROID_DOGFOOD.md",
    "docs/ANDROID_COLD_START.md",
    "docs/ANDROID_BACKGROUND_FOREGROUND.md",
    "docs/ANDROID_NETWORK_RECONNECT.md",
    "docs/ANDROID_FCM_PUSH.md",
    "docs/MACOS_DAEMON_SURVIVAL.md",
    "docs/LIVE_TESTING.md",
    "docs/OPERATIONS.md",
    "docs/RELEASE_AUDIT.md",
  ]) {
    const fullPath = path.join(root, rel);
    if (!fs.existsSync(fullPath)) {
      failures.push(`${rel} is missing`);
      continue;
    }
    if (fs.statSync(fullPath).size < 200) {
      failures.push(`${rel} is unexpectedly small`);
    }
  }
}

function verifyAndroidRendererDoc() {
  for (const needle of [
    "connectbot/termlib",
    "org.connectbot:termlib",
    "`0.0.35`",
    "raw PTY byte stream",
    "The old WebView/xterm.js path remains rejected for v1",
    "pnpm test:android-emulator",
    "direct-adb emulator substitutes",
    "debug launch timing, pair flow, dashboard subscription, terminal flood rendering, background replay, restart restore, multisession, reconnect, and notification tap routing",
    "Latest default aggregate run on 2026-05-19 passed on `emulator-5554`",
    "`TotalTime=7920ms`",
    "`pair_flow_ms=2234`",
    "`visible_ms=3318`",
    "8440/14400 flood screenshot nonblack samples",
    "no Fieldwork crash log entries",
    "30-minute physical Android device dogfood is a counted unchecked\n  `PLAN.md` release gate before Play internal distribution",
    "docs/ANDROID_DOGFOOD.md",
    "pnpm check:android-dogfood-evidence",
    "lack of an attached Android test device",
  ]) {
    requireText(
      docs.androidRenderer,
      needle,
      `docs/ANDROID_RENDERER.md must document current renderer evidence: ${needle}`,
    );
  }
}

function verifyAndroidDogfoodDoc() {
  for (const needle of [
    "Section 7.6 physical Android terminal renderer decision\ngate",
    "connectbot/termlib",
    "30 minutes",
    "type, scroll, resize, and paste",
    "must not create sessions,\nkill sessions, or choose commands",
    "USB debugging is not an end-user requirement",
    "adb devices -l | tee \"$FW_DOGFOOD_DIR/adb-devices.txt\"",
    "FIELDWORK_BIOMETRIC_BYPASS = false",
    'FIELDWORK_DEBUG_PAIRING_PAYLOAD = ""',
    "fw refactoringjob",
    "dogfood_duration_ms",
    "termlib_decision_candidate=pass",
    "typing-replay.txt",
    "dogfood_typing_ok",
    "DOGFOOD_SCROLL_TOP",
    "scroll_verified_by_operator",
    "resize_size=%s",
    "dogfood_resize_ok",
    "DOGFOOD_PASTE_BEGIN",
    "dogfood_paste_line_020",
    "dogfood_paste_ok",
    "final-crash.log",
    "pnpm check:android-dogfood-evidence -- \"$FW_DOGFOOD_DIR\"",
    "Passing the verifier does not\nreplace human review",
  ]) {
    requireText(
      docs.androidDogfood,
      needle,
      `docs/ANDROID_DOGFOOD.md must document Android dogfood evidence: ${needle}`,
    );
  }
}

function verifyAndroidColdStartDoc() {
  for (const needle of [
    "Section 13 Android release-device cold-start gate",
    "physical phone with the signed release artifact",
    "TotalTime <= 1200ms",
    "five cold launches",
    "not an emulator or AVD",
    "debug build, biometric bypass, or debug pairing payload",
    "direct `adb`",
    "node scripts/verify-android-aab.mjs --expect-signed",
    "Android AAB ok:",
    "signed release bundle ok",
    "BUILD_TYPE = \"release\"",
    "DEBUG = false",
    "FIELDWORK_BIOMETRIC_BYPASS = false",
    'FIELDWORK_DEBUG_PAIRING_PAYLOAD = ""',
    "adb devices -l | tee \"$FW_ANDROID_COLD_DIR/adb-devices.txt\"",
    "bundletool install-apks",
    "launch-${sample}.txt",
    "LaunchState: COLD",
    "Activity: app.fieldwork.android/.MainActivity",
    "locked-ui.xml",
    "crash.log",
    "pnpm check:android-cold-start-evidence -- \"$FW_ANDROID_COLD_DIR\"",
  ]) {
    requireText(
      docs.androidColdStart,
      needle,
      `docs/ANDROID_COLD_START.md must document Android cold-start evidence: ${needle}`,
    );
  }
}

function verifyAndroidBackgroundForegroundDoc() {
  for (const needle of [
    "Android side of the Section 13\n`Background -> Foreground` survival gate",
    "signed release build on a\nphysical Android phone",
    "same daemon-owned PTY session surviving app\nbackgrounding",
    "not an emulator or AVD",
    "debug build, biometric bypass, or debug pairing payload",
    "real QR scanner and explicit desktop approval",
    "direct `adb`",
    "node scripts/verify-android-aab.mjs --expect-signed",
    "signed release bundle ok",
    "BUILD_TYPE = \"release\"",
    "DEBUG = false",
    "FIELDWORK_BIOMETRIC_BYPASS = false",
    'FIELDWORK_DEBUG_PAIRING_PAYLOAD = ""',
    "adb devices -l | tee \"$FW_ANDROID_BG_DIR/adb-devices.txt\"",
    "fw new --name fw_background_session bash",
    "ANDROID_BACKGROUND_READY",
    "trigger_background_output",
    "background_command=adb shell input keyevent KEYCODE_HOME",
    "background_top_package",
    "background-output-replay.txt",
    "ANDROID_BACKGROUND_REPLAY_OUTPUT",
    "adb shell monkey -p app.fieldwork.android 1",
    "after_background_ok",
    "android-background: after_background_ok",
    "foreground_reconnect_ms",
    "release_device_background_foreground_candidate=pass",
    "pnpm check:android-background-foreground-evidence -- \"$FW_ANDROID_BG_DIR\"",
    "only proves the Android release-device\nbackground/foreground path",
  ]) {
    requireText(
      docs.androidBackgroundForeground,
      needle,
      `docs/ANDROID_BACKGROUND_FOREGROUND.md must document Android background/foreground evidence: ${needle}`,
    );
  }
}

function verifyAndroidNetworkReconnectDoc() {
  for (const needle of [
    "Android side of the Section 13 network-change\nreconnect gate",
    "signed release build on a physical Android phone",
    "within\n2000 ms",
    "not an emulator or AVD",
    "debug build, biometric bypass, or debug pairing payload",
    "real QR scanner and explicit desktop approval",
    "direct `adb`",
    "node scripts/verify-android-aab.mjs --expect-signed",
    "signed release bundle ok",
    "BUILD_TYPE = \"release\"",
    "DEBUG = false",
    "FIELDWORK_BIOMETRIC_BYPASS = false",
    'FIELDWORK_DEBUG_PAIRING_PAYLOAD = ""',
    "adb devices -l | tee \"$FW_ANDROID_RECONNECT_DIR/adb-devices.txt\"",
    "fw new --name fw_reconnect_session bash",
    "ANDROID_RECONNECT_READY",
    "trigger_offline_output",
    "network_cut_command=adb shell cmd connectivity airplane-mode enable",
    "network_state=disconnected",
    "offline-output-replay.txt",
    "ANDROID_RECONNECT_OFFLINE_OUTPUT",
    "network_restore_command=adb shell cmd connectivity airplane-mode disable",
    "network_ping_ok",
    "after_reconnect_ok",
    "android-reconnect: after_reconnect_ok",
    "reconnect_ms=%s",
    "pnpm check:android-network-reconnect-evidence -- \"$FW_ANDROID_RECONNECT_DIR\"",
    "only proves the Android release-device network reconnect\npath",
  ]) {
    requireText(
      docs.androidNetworkReconnect,
      needle,
      `docs/ANDROID_NETWORK_RECONNECT.md must document Android network reconnect evidence: ${needle}`,
    );
  }
}

function verifyAndroidFcmPushDoc() {
  for (const needle of [
    "Android side of the Section 13 provider-push gates",
    "does not cover APNs\nor iOS",
    "10/10 delivered `AwaitingInput` FCM notifications",
    "physical Android phone",
    "signed release App Bundle",
    "production relay control plane",
    "relay-held FCM service-account\n  JSON",
    "debug build, biometric bypass, or debug pairing payload",
    "direct `adb`",
    "node scripts/verify-android-aab.mjs --expect-signed",
    "FIELDWORK_BIOMETRIC_BYPASS = false",
    'FIELDWORK_DEBUG_PAIRING_PAYLOAD = ""',
    "curl -fsS https://relay.fieldwork.dev:8443/v1/version",
    "token-registration.txt",
    "/v1/push/register-token",
    "provider-payloads.json",
    "\"session_id_hash\"",
    "\"session_name_hash\"",
    "\"event_type\": \"awaiting_input\"",
    "\"click_action\": \"FIELDWORK_OPEN_SESSION\"",
    "last_line",
    "notification_received_&_ok",
    "notification-ui.xml",
    "tap-replay.txt",
    "notify_tap_ok",
    "pnpm check:android-fcm-push-evidence -- \"$FW_ANDROID_FCM_DIR\"",
    "only proves the Android/FCM provider path",
  ]) {
    requireText(
      docs.androidFcmPush,
      needle,
      `docs/ANDROID_FCM_PUSH.md must document Android FCM push evidence: ${needle}`,
    );
  }
}

function verifyMacosDaemonSurvivalDoc() {
  for (const needle of [
    "Section 13 macOS daemon survival gates",
    "Developer ID signed, hardened-runtime enabled, and\n  Gatekeeper-notarized",
    "user-level launchd service",
    "30-second macOS sleep/wake cycle",
    "pkill -KILL fieldworkd",
    "Do not use this runbook with an unsigned source-build daemon",
    "node scripts/verify-macos-signing.mjs /path/to/fieldworkd",
    "macOS signing ok:",
    "fieldwork daemon install",
    "daemon-status-before.txt",
    "fieldwork new --name macos_sleep -- bash -lc",
    "MACOS_SLEEP_SCROLLBACK_BEFORE",
    "sleep_duration_ms",
    "after_sleep_wake_ok",
    "fieldwork new --name macos_kill -- bash -lc",
    "MACOS_KILL_SCROLLBACK_BEFORE",
    "restart_ms",
    "after_kill_restart_ok",
    "daemon-log.txt",
    "pnpm check:macos-daemon-survival-evidence -- \"$FW_MACOS_DIR\"",
  ]) {
    requireText(
      docs.macosDaemonSurvival,
      needle,
      `docs/MACOS_DAEMON_SURVIVAL.md must document macOS daemon survival evidence: ${needle}`,
    );
  }
}

function verifyOperationsDoc() {
  for (const needle of [
    "GitHub Secrets Checklist",
    "`GITHUB_TOKEN` is provided\nby GitHub Actions and does not need to be created manually",
    "`NPM_TOKEN`",
    "`APPLE_P12_BASE64`",
    "`APPLE_P12_PASSWORD`",
    "`APP_STORE_KEY_JSON`",
    "`SENTRY_DSN`",
    "`IOS_DISTRIBUTION_CERTIFICATE_BASE64`",
    "`IOS_DISTRIBUTION_CERTIFICATE_PASSWORD`",
    "`IOS_PROVISIONING_PROFILE_BASE64`",
    "`IOS_DEVELOPMENT_TEAM`",
    "`IOS_EXPORT_OPTIONS_PLIST`",
    "`ANDROID_GOOGLE_SERVICES_JSON`",
    "`ANDROID_KEYSTORE_BASE64`",
    "`ANDROID_KEYSTORE_PROPERTIES`",
    "`PLAY_SERVICE_ACCOUNT_JSON`",
    "`RELAY_SSH_KEY`",
    "`CLOUDFLARE_API_TOKEN`",
    "`CLOUDFLARE_ACCOUNT_ID`",
    "Relay provider credentials are not GitHub repository secrets",
    "APNs `.p8`, FCM service-account JSON, Honeycomb API key, and\ncontrol-plane TLS cert/key",
    "`LoadCredential`",
    "node scripts/verify-macos-signing.mjs target/${{ matrix.target }}/release/fieldworkd",
    "Developer ID,\n  hardened-runtime, and Gatekeeper-notarized",
    "npm Ownership Bootstrap",
    "The unscoped `fieldwork` meta package is already operator-owned",
    "Do not run\navailability checks for it",
    "Do not paste npm tokens into chat",
    "do not commit `.npmrc`",
    "`fieldwork-darwin-arm64`",
    "`fieldwork-darwin-x64`",
    "`fieldwork-linux-arm64`",
    "`fieldwork-linux-x64`",
    "Reserved Fieldwork platform package. Real binaries start at 1.0.0.",
    "node scripts/verify-npm-registry-state.mjs",
    "--expect-meta-published",
    "--expect-platform-published",
    "--expect-latest-version=1.0.0",
    "--expect-provenance",
    "publish only through `release-npm.yml`",
    "`NPM_TOKEN` secret",
    "four platform packages first\nand the `fieldwork` meta package last with provenance",
  ]) {
    requireText(docs.operations, needle, `docs/OPERATIONS.md must document npm ownership handoff: ${needle}`);
  }
}

function verifyReadme() {
  for (const needle of [
    "npm i -g fieldwork",
    "fw daemon install\nfw pair",
    "fw pair",
    "the shorter `fw` alias",
    "`fw` accepts the same arguments as `fieldwork`",
    "`fw refactoringjob` is the named\nsession fast path",
    "no subcommand creates and attaches a default `claude` session with a generated",
    "one-word name like `waffle` or `kazoo`",
    "appears as the active\nsession name in the mobile app dashboard",
    "daemon rejects duplicate session\nnames",
    "Desktop distribution is npm-only for v1",
    "Homebrew, `curl | sh`, `cargo install`, and self-update are intentionally out of scope",
    "docs/RELEASE_AUDIT.md",
    "`PLAN.md` remains the completion-checkbox source of truth",
    "operator-requested refresh",
    "operator-facing release-gate handoff",
    "operator-owned reservations for domain, GitHub, social, cloud, provider, and launch-calendar work",
    "docs/LIVE_TESTING.md",
    "target/debug/fieldwork refactoringjob",
    "target/debug/fieldwork new --name shell bash",
    "target/debug/fieldwork new bash",
    "With no subcommand, the CLI uses the same smart default as the npm `fw` alias",
    "auto-names a new default session with a short one-word name",
    "With an unknown single word, it uses the named session shortcut described above",
    "Pair tokens are 32 random bytes, base32 encoded, single-use, and expire after 10 minutes",
    "separate encrypted `devices.redb`, with hashed row keys",
    "Keychain prompts are only for local key material",
    "Shell completions are generated for the invoked command name",
    "`fw completion bash|zsh|fish|powershell|elvish` registers the\nshort alias",
    "scripts/smoke-local-handoff.sh",
    "default `claude` session, a `bash` session, and a `vim` TUI session",
    "mobile-kind clients cannot create sessions, kill sessions, or emit agent-state hook events",
    "SwiftUI v0 app",
    "Compose v0 target",
    "fixed copy plus opaque session hashes",
    "real APNs/FCM provider delivery requires relay-only Apple/Firebase credentials",
  ]) {
    requireText(docs.readme, needle, `README.md must document current v1 behavior: ${needle}`);
  }
}

function verifyLiveTestingDoc() {
  for (const needle of [
    "first operator-assisted live test round",
    "Android physical-device terminal handoff only",
    "same daemon-owned PTY session",
    "not screen mirroring",
    "does not\n  take over arbitrary already-open Terminal.app or iTerm tabs",
    "Do not include iOS, npm publish, store submission, production relay deploy, APNs\nor FCM provider delivery",
    "USB debugging is not an\n  end-user requirement",
    "enable it for this QA run only when capturing direct\n  `adb` evidence",
    "can be exercised without USB debugging",
    "equivalent bug report, screen recording, logs, and crash data",
    "No debug biometric bypass and no debug pairing payload",
    "apps/android/gradlew --no-daemon :app:assembleDebug",
    "adb install -r apps/android/app/build/outputs/apk/debug/app-debug.apk",
    'export FW_LIVE_BIN="$(mktemp -d /tmp/fieldwork-live-bin.XXXXXX)"',
    "trap 'rm -rf \"$FW_LIVE_BIN\"' EXIT",
    'ln -sf "$PWD/target/release/fieldwork" "$FW_LIVE_BIN/fw"',
    "fw daemon start",
    "fw\nfw refactoringjob",
    "fw new --name shell bash",
    "fw new --name editor -- vim",
    "fw new bash",
    "fw new -- claude",
    "fw new -- vim",
    "fw pair",
    "buildconfig.txt",
    'APPLICATION_ID = "app\\.fieldwork\\.android"',
    'BUILD_TYPE = "debug"',
    'DEBUG = Boolean\\.parseBoolean\\("true"\\)',
    "FIELDWORK_BIOMETRIC_BYPASS = false",
    'FIELDWORK_DEBUG_PAIRING_PAYLOAD = ""',
    "adb devices -l | tee \"$FW_LIVE_DIR/adb-devices.txt\"",
    "adb-devices.txt` shows at least one authorized connected device and no\nunauthorized/offline/emulator/AVD device state",
    "pair_start_ms=\"$(node -e 'console.log(Date.now())')\"",
    "pair_flow_ms=%s",
    "script -q \"$FW_LIVE_DIR/pairing.txt\" fw pair",
    "pairing.txt` proves the desktop-side\nQR payload, device-scan wait, explicit approval prompt, and approved completion,\nrecords `pair_flow_ms=<elapsed-ms>` at or below 15000",
    "fw new --name fw_live_sub bash",
    "subscription-visible.txt",
    "visible_ms=<elapsed-ms>",
    "subscription_attach_ok",
    "subscription-replay.txt",
    "fw devices > \"$FW_LIVE_DIR/devices.txt\"",
    "generated one-word name such as `waffle` or `kazoo`",
    "`refactoringjob` appear as active sessions in the Android dashboard",
    "auto-named default `claude` session",
    "adb shell am start -W -n app.fieldwork.android/.MainActivity",
    "adb exec-out screencap -p",
    "adb shell uiautomator dump",
    "adb logcat -d -b crash",
    "active sessions dashboard",
    "dashboard.png",
    "dashboard-ui.xml",
    "dashboard-logcat.log",
    "dashboard-crash.log",
    "subscription-ui.xml",
    "subscription-logcat.log",
    "subscription-crash.log",
    "script -q \"$FW_LIVE_DIR/terminal-replay.txt\" fw attach shell",
    "flood-replay.txt",
    "yes ANDROID_LIVE_FLOOD | head -10000",
    "`flood_lines=10000`",
    "claude-replay.txt",
    "claude_live_ok",
    "fw attach refactoringjob",
    "resize-replay.txt",
    "after_resize_ok",
    "resize_size=<rows>x<cols>",
    "detach-replay.txt",
    "after_detach_reattach_ok",
    "`subscription-ui.xml` shows the post-pair desktop-created `fw_live_sub` session",
    "`visible_ms=<elapsed-ms>` at or below 2000",
    "`subscription-replay.txt` contains\n`subscription_attach_ok` from Android-originated input",
    "desktop replay transcript contains `android_live_ok`",
    "`flood-ui.xml` shows the `ANDROID_LIVE_FLOOD` marker in the Android terminal\nview",
    "`yes ANDROID_LIVE_FLOOD | head -10000` stream completed",
    "`claude-replay.txt` contains `claude_live_ok` from Android-originated input",
    "background-replay.txt",
    "reconnect-replay.txt",
    "`reconnect_ms=<elapsed-ms>`",
    "restart-replay.txt",
    "multisession-a-replay.txt",
    "expected replay/no-leakage\nmarkers",
    "pnpm check:live-testing-evidence -- \"$FW_LIVE_DIR\"",
    "direct `adb` evidence set is complete",
    "screenshots are nontrivial\nfull-size Android PNGs",
    "unauthorized/offline/emulator/AVD device state",
    "the locked UI and freshly cleared locked-launch logcat did not expose or fetch\nsession, terminal, push-token, or input content before unlock",
    "`biometric-ui.xml`\nshows an Android biometric prompt with no session or terminal content behind it",
    "`stale-biometric-ui.xml` shows the same prompt after at least five minutes in\nbackground",
    "`stale-biometric.txt` proves stale terminal input was blocked\nbefore unlock",
    "do not expose mobile session creation, session kill, or\ncommand-selection controls",
    "logs/crash buffers do not contain Fieldwork\nfatal, ANR, or crash entries",
    "echo android_live_ok",
    "Create `fw_live_sub` from the desktop after pairing",
    "Run `yes ANDROID_LIVE_FLOOD | head -10000` from Android",
    "Resize the terminal and verify the PTY reports a plausible row/column size",
    "Detach and reattach; verify the terminal resumes from the latest seen offset",
    "Background the app while a PTY emits output",
    "Leave the app backgrounded for at least five minutes",
    "stale terminal input",
    "Toggle Wi-Fi or airplane mode",
    "Mobile never creates or kills sessions and never chooses commands",
    "Do not check provider-push, signing, publish, store-console, iOS, domain, or\noperator-reservation boxes",
  ]) {
    requireText(docs.liveTesting, needle, `docs/LIVE_TESTING.md must document first live test behavior: ${needle}`);
  }
}

function verifyProtocolDoc() {
  for (const needle of [
    "`CONTRACT_VERSION` is `1`",
    "length-prefixed bincode frames",
    "MessagePack payloads",
    "PTY output is streamed as raw bytes",
    "256 KB PTY byte ring",
    "synthetic ANSI snapshot",
    "`Attached.seq` and `Output.seq` are the monotonic byte offset immediately after the bytes carried in that message",
    "`Lag` is terminal",
    "skipped broadcast-message count",
    "`SubscribeSessions`",
    "`attach_session_from(id, last_seen_seq)`",
    "single-use 10-minute pair token",
    "remote iroh node id as the long-lived device identity",
    "encrypted `devices.redb` under a hashed row key",
    "may list sessions, subscribe to session-list snapshots, attach, send input, resize, detach, ping, and register push tokens",
    "rejected with `Error { Forbidden }` for `CreateSession`, `KillSession`",
    "lowercase 64-character hex `session_id_hash`",
    "terminal content, command lines, paths, plaintext session names, and `last_line` out of push-provider payloads",
  ]) {
    requireText(docs.protocol, needle, `docs/PROTOCOL.md must document current protocol invariant: ${needle}`);
  }
}

function verifyPrivacyDoc() {
  for (const needle of [
    "Terminal input and output stay on the host unless a paired remote iroh client attaches",
    "encrypted QUIC connections",
    "Pair tokens are single-use and expire after 10 minutes",
    "No daemon telemetry is exported by default",
    "send_default_pii=false",
    "traces_sample_rate=0.0",
    "The CLI update notice contacts the public npm registry at most once per day",
    "WhenUnlockedThisDeviceOnly",
    "BiometricPrompt",
    "Android Keystore-backed `EncryptedSharedPreferences`",
    "fieldwork_push_tokens.xml",
    "Notification tap routing carries only lowercase 64-character hex `session_id_hash`",
    "Scrollback is persisted locally in `redb` and encrypted with XChaCha20-Poly1305",
    "separate encrypted `devices.redb` under hashed row keys",
    "Local persistence directories are forced to `0700`, `redb` database files are forced to `0600`",
    "APNs `.p8` and FCM service-account JSON are not present in this repository or daemon/mobile code",
    "Push notification payload privacy rules from `PLAN.md` remain binding",
  ]) {
    requireText(docs.privacy, needle, `docs/PRIVACY.md must document current privacy invariant: ${needle}`);
  }
}

function verifyArchitectureDoc() {
  for (const needle of [
    "socket parent is created as `0700`",
    "socket file is chmodded to `0600`",
    "length-prefixed bincode IPC",
    "length-prefixed MessagePack frames",
    "spawns arbitrary commands inside PTYs",
    "256 KB PTY byte ring",
    "`wezterm-term` terminal model",
    "encrypted `devices.redb` under hashed row keys",
    "Mobile-core tracks `last_seen_seq` from `Attached.seq` and `Output.seq`",
    "minimum attached rows/columns",
    "create sessions, kill sessions",
    "stores the paired daemon record in the data-protection iOS Keychain",
    "renders attached PTY bytes with SwiftTerm",
    "renders attached PTY bytes with `connectbot/termlib`",
    "FCM token refresh callbacks only queue trimmed pending tokens",
    "Production deployment serves this listener over Rustls",
    "Relay push requests are validated with strict Serde schemas and `garde`",
    "Desktop distribution is npm-only",
    "The meta package exposes `fieldwork`, `fw`, and `fieldworkd` through npm",
    "`fieldwork` and the short `fw` alias both point at the same CLI dispatcher in `bin/fieldwork`",
    "the CLI dispatcher (`fieldwork`/`fw`) and daemon dispatcher fall back to the platform package",
    "`dist-workspace.toml` keeps cargo-dist in archive/audit mode only",
  ]) {
    requireText(docs.architecture, needle, `docs/ARCHITECTURE.md must document current architecture: ${needle}`);
  }
}

function verifyInstallDoc() {
  for (const needle of [
    "npm i -g fieldwork",
    "cargo build --workspace",
    "target/debug/fieldwork",
    "target/debug/fieldwork refactoringjob",
    "target/debug/fieldwork new --name shell bash",
    "With no subcommand, `fieldwork` uses the same smart default as the npm `fw`\nalias",
    "New no-name\ndefault sessions get generated one-word names like `waffle` or `kazoo`",
    "same daemon session summary appears in the mobile app dashboard",
    "With one\nunknown word, `fieldwork`/`fw` uses the named session shortcut",
    "Use `fw new --name <name> [cmd...]`",
    "Duplicate session names are rejected by the daemon",
    "scripts/smoke-local-handoff.sh",
    "default `claude` session through a temp stub command, a desktop `bash` session, and a `vim` TUI session",
    "Installed npm builds check the npm registry at most once per day",
    "After npm install, `fw completion bash|zsh|fish|powershell|elvish` generates a\ncompletion script registered for the short `fw` alias",
    "Local scrollback/device persistence is encrypted by default",
    "Device registry rows\nuse hashed keys",
    "Fieldwork may ask for Keychain access when `fieldworkd` starts",
    "Terminal output, keystrokes, commands, paths,\nsession names, and push tokens are not stored in Keychain",
    "FIELDWORK_RELAY_DB_PATH",
    "Real APNs/FCM delivery requires relay-only Apple/Firebase credentials and physical-device verification",
    "Current npm packaging checks",
    "The unscoped `fieldwork` meta package is operator-owned",
    "not used as name-availability checks for the meta package",
    "fails closed when run without explicit release-state\nexpectation flags",
    "--expect-platform-published",
    "--expect-latest-version=1.0.0 --expect-provenance",
    "`fieldwork` is the meta package",
    "`fw` is a shorter alias for the same user-facing CLI, so `fw pair`\nstarts the same QR-pairing flow as `fieldwork pair`",
    "Running either CLI name with no subcommand uses the smart default",
    "auto-generates a one-word display name that mobile apps show from the daemon\nsession list",
    "Running `fw refactoringjob` uses the named-session fast path",
    "`fw new --name <name> [cmd...]` creates an explicitly named arbitrary-command PTY",
    "Xcode 16.3 for local development on the current macOS 15.2 host",
    "node scripts/check-domain-status.mjs --operator-refresh --require-registered --require-dns",
    "Run it only when the operator asks for\na status refresh",
    "It is not an ownership check",
    "at least 70 GiB free in `~/Downloads`",
    "No Xcode `.xip` is present in `~/Downloads`",
    "Apple now requires Xcode 26+ with an iOS 26+ SDK",
    "prints concrete recovery steps to authenticate",
    "select `/Applications/Xcode-16.3.app/Contents/Developer`",
    "connectbot/termlib",
    "Windows host support is not part of v1",
  ]) {
    requireText(docs.install, needle, `docs/INSTALL.md must document current install/development fact: ${needle}`);
  }
}

function verifyPlanDoc() {
  for (const needle of [
    "Fieldwork — v1 Build Plan",
    "FUTURE.md",
    "CLI binary**: `fieldwork`",
    "Daemon binary**: `fieldworkd`",
    "AI-coding-agent-aware push notifications for Claude Code AND Codex",
    "Codex (structured JSON events accepted through the local `fieldwork hook codex-event` adapter",
    "Other CLIs run perfectly fine but don't get this push",
    "**v1 does not ship** voice input",
    "state inference for OpenCode/Aider",
    "streams raw bytes",
    "VT/ANSI parser | `wezterm-term`",
    "**Length-prefixed framing**",
    "**Bincode for local IPC**",
    "**MessagePack for mobile**",
    "`CONTRACT_VERSION = 1`",
    "**Pairing token**: 32 bytes of randomness",
    "**Scrollback/device registry encrypted at rest**",
    "encrypted devices.redb under a hashed device row key",
    "Pair tokens are daemon-local in-memory pending tokens",
    "## 8. npm distribution (the only desktop install path)",
    "The meta-package's `bin` field exposes `fieldwork`, the shorter `fw` alias",
    '"fw": "bin/fieldwork"',
    "fw pair                                 # show QR for new device; prompts to approve incoming pair requests",
    "fieldwork pair                          # full command name for the same QR-pairing flow",
    "fieldwork                               # smart default: create+attach default claude",
    "fw                                      # npm-installed short alias for the same CLI and smart default",
    "fw <name>                               # named fast path: attach existing name or create+attach default claude",
    "fw new --name <name> --dir <path> [cmd...]",
    "**No-args fast path**",
    "generated one-word display name such\nas `waffle` or `kazoo`",
    "`SessionSummary.name`, so mobile apps show the same active session name in the\ndashboard",
    "**Named-session fast path**",
    "`fw <name>` is the product replacement for a\ntmux/mosh/Tailscale alias like `mc refactoringjob`",
    "**Create session from desktop CLI** (`fw new --dir ~/projects claude`)",
    "daemon rejects duplicate session\nnames with `ErrorCode::InvalidRequest`",
    "`fw new --name <name>` if a\ndesired session name collides with a subcommand",
    "Mobile clients still cannot create sessions, kill sessions, or choose\ncommands",
    "mobile clients cannot create or kill sessions — those happen via `fw new` / `fw kill` on the desktop",
    "Create a session on your laptop with `fw new`",
    "**Local substitute note (2026-05-20)**",
    "preserves\nhost `CARGO_HOME`/`RUSTUP_HOME` while isolating Fieldwork's temp `HOME`",
    "explicitly named `FW_SUBSCRIBE_SESSION_READY` and `FW_RECONNECT_READY`",
    "replayed missed output after a simulated iroh reconnect within 2 seconds (13ms",
    '"fieldworkd": "bin/fieldworkd"',
    '"README.md"',
    '"access": "public"',
    '"directory": "packages/cli"',
    "fs.mkdirSync(binDir, { recursive: true });",
    "Operator: reserve/verify control of domain `fieldwork.dev`",
    "available only for explicit operator-requested status refreshes",
    "node scripts/check-github-namespace.mjs --operator-refresh --expect-available",
    "fieldwork-app/fieldwork",
    "not the older planned `codex app-server daemon --remote-control` form",
    "A 2026-05-19 direct adb emulator QA refresh installed the default debug APK",
    "`TotalTime=5297ms`",
    "`pair_flow_ms=1043`",
    "`TotalTime=5105ms`",
    "`FIELDWORK_BIOMETRIC_BYPASS = false`",
    "empty `FIELDWORK_DEBUG_PAIRING_PAYLOAD`",
    "30-minute physical Android device dogfood is now a counted unchecked Section 13 release gate before Play internal distribution",
  ]) {
    requireText(docs.plan, needle, `PLAN.md must preserve v1 contract text: ${needle}`);
  }
  rejectText(
    docs.plan,
    "Codex (uses `codex app-server daemon --remote-control`",
    "PLAN.md must not claim the obsolete Codex daemon remote-control spawn path",
  );
  rejectText(
    docs.plan,
    "Codex `app-server daemon --remote-control`, Cursor",
    "PLAN.md cultural-moment text must not preserve the obsolete Codex command as current",
  );
  rejectText(
    docs.plan,
    "bin` field exposes only the CLI",
    "PLAN.md must not claim the npm meta-package exposes only the CLI",
  );
  rejectText(
    docs.plan,
    "Create a session on your laptop with `fieldwork new`",
    "PLAN.md mobile empty-state copy must prefer the short `fw new` command",
  );
  rejectText(
    docs.plan,
    "**Create session from desktop CLI** (`fieldwork new --dir ~/projects claude`)",
    "PLAN.md Section 13 smoke gate must prefer the short `fw new` command",
  );
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
