# Install

The v1 production install path will be:

```sh
npm i -g shellykit
shelly daemon install
shelly pair
shelly
shelly refactoringjob
shelly kill <session-id-or-name>
shelly kill-all
```

Before a live test, run `shelly doctor` to check the local CLI, daemon binary,
Unix-socket hardening/protocol handshake, visible sessions, telemetry setting, and
scrollback-encryption setting.

The npm package scaffold is implemented under `packages/`. The unscoped package
family is already reserved on npm with operator-controlled `0.0.0` placeholder
publishes, but the real Changesets-managed `1.0.0` packages are not released
until signed release artifacts, provenance, and release credentials are ready.
For current local development:

```sh
cargo build --workspace
target/debug/shelly
target/debug/shelly doctor
target/debug/shelly refactoringjob
target/debug/shelly new --name shell bash
target/debug/shelly new bash
target/debug/shelly attach <session-id>
```

With no subcommand, `shelly` creates and attaches a new shell-backed Shelly session with a generated
one-word name like `waffle` or `kazoo`, even when other sessions already exist.
The same daemon session summary appears in the mobile app dashboard. From that
shell, users can start Claude, exit it, start Codex, or run any other terminal
program inside the same Shelly session. `shelly new` without `--name` also
auto-generates a short one-word display name while keeping the requested PTY
command, so `shelly new bash` creates an auto-named `bash` session and
`shelly new claude` creates an explicit Claude session. With one unknown word,
`shelly` uses the named session shortcut: attach the named session if it
exists, otherwise create a shell-backed Shelly PTY with that display name and
attach. Use `shelly new --name <name> [cmd...]` when you want a named session with
an explicit command such as `bash`, `vim`, or `codex`.
Duplicate session names are rejected by the daemon so phone dashboard labels and
`shelly <name>` shortcuts stay unambiguous.

Current remote-pairing development flow:

```sh
scripts/smoke-local-handoff.sh
```

The smoke script starts an isolated daemon, creates an explicit `claude` session through a temp stub command, a desktop `bash` session, and a `vim` TUI session, verifies the iroh transport rejects a mismatched protocol version before pairing, verifies iroh rejects `LocalCli` before `Welcome`, pairs the hidden iroh client through explicit desktop approval, lists and attaches to those sessions, starts a mobile session-list subscription before creating another desktop session, verifies that subscribed session appears, sends mobile-originated input into `bash`, `claude`, and the subscribed desktop-created session, checks that switched sessions do not receive each other's output markers, verifies the paired mobile client cannot create sessions, kill sessions, or emit agent-state hook events, removes the simulated device, verifies the reused identity is unauthorized, restarts the daemon, and checks last-known session restore. The iroh transport accepts mobile client kinds only; desktop CLI clients use the local Unix socket. `shelly pair` (or `shelly pair`) starts the daemon if needed, prints a compact high-contrast terminal QR plus the 5-character code when the whole QR fits the current terminal pane, and requires explicit `y` approval before a device is stored. If the pane is too small, it omits the oversized QR and keeps the typed code visible. The active pairing code is invalidated after use.

Optional local daemon service install while developing:

```sh
target/debug/shelly daemon install
target/debug/shelly daemon status
target/debug/shelly doctor --no-start
```

This installs a user-level service only. It does not install a root daemon.
`shelly doctor` checks the colocated `shellyd`, service status,
Unix-socket parent/file hardening, protocol handshake, visible sessions,
telemetry setting, and scrollback-encryption setting. Without `--no-start`, it
may auto-start the daemon the same way `shelly pair`, `shelly`, and `shelly <name>` do.

Shell completion scripts can be generated locally:

```sh
target/debug/shelly completion bash
target/debug/shelly completion zsh
target/debug/shelly completion fish
```

After npm install, `shelly --help` prints `Usage: shelly`, and
`shelly completion bash|zsh|fish|powershell|elvish` generates a completion script
registered for the short `shelly` alias. Running the same subcommand through
`shelly` registers completions for the long command name.

Installed npm builds check the npm registry at most once per day for a newer `shelly`. The notice is printed to stderr for human-facing commands only and never downloads an update; use `npm update -g shellykit` to update both `shelly` and `shellyd`. Set `SHELLY_DISABLE_UPDATE_CHECK=1` to suppress the registry check.

Daemon and mobile crash reporting are not bundled in v1. To record local diagnostics consent, write the daemon config and restart the daemon:

```sh
target/debug/shelly settings telemetry on
target/debug/shelly daemon restart
```

Use `target/debug/shelly settings telemetry off` and restart the daemon to disable the local preference again. Production observability is relay-only Honeycomb tracing with aggregate/static fields.

Local scrollback/device persistence is encrypted by default. Device registry rows
use hashed keys, so raw device node IDs and push tokens live only inside encrypted
row payloads. The daemon keeps the local persistence parent private (`0700`),
keeps database files private (`0600`), and rejects symlinked persistence
directories or database files before opening the stores.

On macOS, Shelly may ask for Keychain access when `shellyd` starts. The
Keychain entries hold only local private keys: the scrollback/device database
encryption key, the daemon's iroh identity key for pairing, and, when relay push
is enabled, the relay-signing key. Terminal output, keystrokes, commands, paths,
session names, and push tokens are not stored in Keychain.

If OS keychain-backed encryption is unavailable and you explicitly accept
plaintext local persistence, use:

```sh
target/debug/shelly settings scrollback-encryption off
target/debug/shelly daemon restart
```

Turn it back on with `target/debug/shelly settings scrollback-encryption on` and restart the daemon.

Optional local relay push gateway while developing:

```sh
SHELLY_RELAY_DB_PATH="$(mktemp -d)/relay.db" target/debug/shelly-relay
SHELLY_RELAY_CONTROL_URL=http://127.0.0.1:8443 target/debug/shellyd
```

The relay gateway persists daemon keys, push-token ownership, and recent replay nonces in SQLite, then validates daemon signatures and privacy-preserving push requests locally. Set `SHELLY_RELAY_DB_PATH=off` for a purely in-memory local smoke test. Real FCM delivery requires relay-only Firebase credentials and physical-device verification, so it is not part of the local install flow. APNs delivery is parked with the deferred iOS path.

The production relay deploy scaffold lives under `infra/relay/ansible`. Override `shelly_relay_binary` when running the playbook. The default group variables set the HTTPS control listener to `0.0.0.0:8443`, the control metrics listener to `127.0.0.1:9090`, the relay OTLP endpoint to Honeycomb, the trace sample rate to `0.01`, and the SQLite path to `/var/lib/shelly/relay.db`. The same binary is also deployed as `shelly-iroh-relay.service` with `SHELLY_RELAY_MODE=iroh-relay`, ACME-backed HTTPS on `0.0.0.0:443`, HTTP challenge/probe handling on `0.0.0.0:80`, QUIC address discovery on `0.0.0.0:7842`, and iroh relay metrics on `127.0.0.1:9091`. The playbook creates the relay data directory as `0700`; the relay process enforces `0600` on the SQLite database and sidecar files. Control-plane TLS cert/key paths, FCM service-account JSON, and Honeycomb API-key paths are passed to the control-plane unit via `LoadCredential` and must exist only on the relay host. FCM delivery reads `shelly_relay_fcm_credential`, uses `shelly_relay_fcm_endpoint`, and caches the Google OAuth token returned from the service-account JWT exchange.

Current npm packaging checks:

```sh
node scripts/test-npm-dispatcher.mjs
node scripts/test-npm-artifact-pack.mjs
node scripts/test-npm-publish-plan.mjs
node scripts/test-bun-install.mjs
npm pack ./packages/cli --dry-run --json
```

`shellykit` is the meta package. It exposes `shelly` and `shellyd`.
Postinstall swaps the CLI
and daemon commands to native binaries when scripts are allowed, and the shipped
dispatchers run the matching platform package when postinstall is skipped. On
macOS, postinstall also ad-hoc signs the copied `shelly` and `shellyd`
binaries and removes `com.apple.quarantine` only from those two verified
executables, so the npm desktop path does not require Apple Developer ID
notarization.
Running `shelly` with no subcommand uses the no-args fast path: create
and attach a new shell-backed Shelly session with an auto-generated one-word
display name that mobile apps show from the daemon session list, even when other
sessions already exist. Running `shelly refactoringjob` uses the named-session fast
path, and `shelly new --name <name> [cmd...]` creates an explicitly named arbitrary-command PTY. The v1 platform
packages are
`shellykit-darwin-arm64`, `shellykit-darwin-x64`,
`shellykit-linux-arm64`, and `shellykit-linux-x64`. Each platform
package receives `shelly` and `shellyd` from the release artifact pipeline
before publish. The artifact-pack test creates synthetic release artifacts
locally so the package-preparation and dry-run behavior can be checked without
publishing. It also proves a missing platform/target artifact directory is
rejected before a package can accidentally receive another platform's binaries.
The unscoped `shellykit` meta package is operator-owned, and the platform child
package names are reserved by operator-controlled placeholder publishes. The
remaining external npm gate is the real Changesets-managed `1.0.0` publish with
npm provenance.

`scripts/test-bun-install.mjs` packs the local Shelly meta package plus each
v1 platform package, installs them with Bun for the four supported host tuples,
and verifies that the selected optional platform package is present. Bun blocks
dependency postinstall scripts by default unless the root project trusts them,
so the smoke accepts both install modes: native binary swap when scripts run and
the shipped JS dispatcher fallback when postinstall stays blocked. On the current
host, it also executes `shelly` and `shellyd` from Bun's `.bin`
directory.

Current Android development flow:

```sh
apps/android/gradlew --no-daemon :app:assembleDebug
```

The Android target expects Android Studio, `cargo-ndk`, API 36, NDK r27, and JDK 21+. The repo-local Gradle wrapper downloads and verifies Gradle 8.14.3 and uses Android Studio's bundled JBR when `JAVA_HOME` is unset or points to a pre-21 JDK. Gradle's app tasks run `buildRustMobileCore`, which invokes `apps/android/scripts/build-rust.sh` to build Rust `.so` files into `app/src/main/jniLibs` and generate Kotlin UniFFI bindings into `apps/android/generated` before Kotlin compilation or native-library merge. Run that script directly only as an explicit Rust/UniFFI preflight. Android renders terminal output with `connectbot/termlib`.

Windows host support is not part of v1; Windows users will use the Linux build inside WSL2 when v1 packaging lands.

## Website

The launch/docs site is a static Astro project in `site/`:

```sh
pnpm --dir site install --ignore-workspace --frozen-lockfile
pnpm check:site
pnpm build:site
```

Cloudflare Pages deployment is handled by `.github/workflows/deploy-site.yml` once the `shelly.dev` domain and `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` secrets exist.
