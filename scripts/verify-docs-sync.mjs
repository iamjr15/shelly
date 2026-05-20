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
  liveTesting: read("docs/LIVE_TESTING.md"),
};

verifyRequiredDocsExist();
verifyReadme();
verifyProtocolDoc();
verifyPrivacyDoc();
verifyArchitectureDoc();
verifyInstallDoc();
verifyAndroidRendererDoc();
verifyLiveTestingDoc();
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
    "docs/LIVE_TESTING.md",
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
    "30-minute physical Android device dogfood remains blocked",
  ]) {
    requireText(
      docs.androidRenderer,
      needle,
      `docs/ANDROID_RENDERER.md must document current renderer evidence: ${needle}`,
    );
  }
}

function verifyReadme() {
  for (const needle of [
    "npm i -g fieldwork",
    "the shorter `fw` alias",
    "`fw` accepts the same arguments as `fieldwork`",
    "`fw refactoringjob` is the named\nsession fast path",
    "no subcommand creates and attaches a default `claude` session with a generated",
    "one-word name like `waffle` or `kazoo`",
    "appears as the active\nsession name in the mobile app dashboard",
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
    "target/release/fieldwork\n",
    "target/release/fieldwork refactoringjob",
    "target/release/fieldwork new --name shell bash",
    "target/release/fieldwork new --name editor -- vim",
    "target/release/fieldwork new bash",
    "target/release/fieldwork new -- claude",
    "target/release/fieldwork new -- vim",
    "target/release/fieldwork pair",
    "generated one-word name such as `waffle` or `kazoo`",
    "`refactoringjob` appear as active sessions in the Android dashboard",
    "auto-named default `claude` session",
    "adb exec-out screencap -p",
    "adb shell uiautomator dump",
    "adb logcat -d -b crash",
    "echo android_live_ok",
    "Background the app while a PTY emits output",
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
    "Use `fieldwork new --name <name> [cmd...]`",
    "scripts/smoke-local-handoff.sh",
    "default `claude` session through a temp stub command, a desktop `bash` session, and a `vim` TUI session",
    "Installed npm builds check the npm registry at most once per day",
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
    "Running either CLI name with no subcommand uses the smart default",
    "auto-generates a one-word display name that mobile apps show from the daemon\nsession list",
    "Running `fw refactoringjob` uses the named-session fast path",
    "`fieldwork new --name <name> [cmd...]` creates an explicitly named arbitrary-command PTY",
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
    "fieldwork                               # smart default: create+attach default claude",
    "fw                                      # npm-installed short alias for the same CLI and smart default",
    "fw <name>                               # named fast path: attach existing name or create+attach default claude",
    "fieldwork new --name <name> --dir <path> [cmd...]",
    "**No-args fast path**",
    "generated one-word display name such\nas `waffle` or `kazoo`",
    "`SessionSummary.name`, so mobile apps show the same active session name in the\ndashboard",
    "**Named-session fast path**",
    "`fw <name>` is the product replacement for a\ntmux/mosh/Tailscale alias like `mc refactoringjob`",
    "`fieldwork new --name <name>` if a desired session name collides with a\nsubcommand",
    "Mobile clients still cannot create sessions, kill sessions, or choose\ncommands",
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
