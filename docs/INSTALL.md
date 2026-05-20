# Install

The v1 production install path will be:

```sh
npm i -g fieldwork
fw daemon install
fw pair
fw
fw refactoringjob
```

The npm package scaffold is implemented under `packages/`, but the packages are not published until release credentials and platform artifacts are available. For current local development:

```sh
cargo build --workspace
target/debug/fieldwork
target/debug/fieldwork refactoringjob
target/debug/fieldwork new --name shell bash
target/debug/fieldwork new bash
target/debug/fieldwork attach <session-id>
```

With no subcommand, `fieldwork` uses the same smart default as the npm `fw`
alias: create and attach a default `claude` session when none exist, attach the
only existing session, or list sessions when several are available. New no-name
default sessions get generated one-word names like `waffle` or `kazoo`, and the
same daemon session summary appears in the mobile app dashboard. With one
unknown word, `fieldwork`/`fw` uses the named session shortcut: attach the named
session if it exists, otherwise create a default `claude` PTY with that display
name and attach. Use `fw new --name <name> [cmd...]` when you want a
named session with an explicit command such as `bash`, `vim`, or `codex`.
Duplicate session names are rejected by the daemon so phone dashboard labels and
`fw <name>` shortcuts stay unambiguous.

Current remote-pairing development flow:

```sh
scripts/smoke-local-handoff.sh
```

The smoke script starts an isolated daemon, creates a default `claude` session through a temp stub command, a desktop `bash` session, and a `vim` TUI session, verifies the iroh transport rejects a mismatched protocol version before pairing, pairs the hidden iroh client through explicit desktop approval, lists and attaches to those sessions, starts a mobile session-list subscription before creating another desktop session, verifies that subscribed session appears, sends mobile-originated input into `bash`, `claude`, and the subscribed desktop-created session, checks that switched sessions do not receive each other's output markers, verifies the paired mobile client cannot create sessions, kill sessions, or emit agent-state hook events, removes the simulated device, verifies the reused identity is unauthorized, restarts the daemon, and checks last-known session restore. `fw pair` (or `fieldwork pair`) starts the daemon if needed, prints a QR payload, and requires explicit `y` approval before a device is stored. Pair tokens are single-use.

Optional local daemon service install while developing:

```sh
target/debug/fieldwork daemon install
target/debug/fieldwork daemon status
```

This installs a user-level service only. It does not install a root daemon.

Shell completion scripts can be generated locally:

```sh
target/debug/fieldwork completion bash
target/debug/fieldwork completion zsh
target/debug/fieldwork completion fish
```

Installed npm builds check the npm registry at most once per day for a newer `fieldwork`. The notice is printed to stderr for human-facing commands only and never downloads an update; use `npm update -g fieldwork` to update both `fieldwork` and `fieldworkd`. Set `FIELDWORK_DISABLE_UPDATE_CHECK=1` to suppress the registry check.

Daemon telemetry is off by default. To opt into local crash reporting, write the daemon config and restart the daemon:

```sh
target/debug/fieldwork settings telemetry on --sentry-dsn https://examplePublicKey@example.invalid/1
target/debug/fieldwork daemon restart
```

Use `target/debug/fieldwork settings telemetry off` and restart the daemon to disable it again.

Local scrollback/device persistence is encrypted by default. Device registry rows
use hashed keys, so raw device node IDs and push tokens live only inside encrypted
row payloads. The daemon keeps the local persistence parent private (`0700`),
keeps database files private (`0600`), and rejects symlinked persistence
directories or database files before opening the stores.

On macOS, Fieldwork may ask for Keychain access when `fieldworkd` starts. The
Keychain entries hold only local private keys: the scrollback/device database
encryption key, the daemon's iroh identity key for pairing, and, when relay push
is enabled, the relay-signing key. Terminal output, keystrokes, commands, paths,
session names, and push tokens are not stored in Keychain.

If OS keychain-backed encryption is unavailable and you explicitly accept
plaintext local persistence, use:

```sh
target/debug/fieldwork settings scrollback-encryption off
target/debug/fieldwork daemon restart
```

Turn it back on with `target/debug/fieldwork settings scrollback-encryption on` and restart the daemon.

Optional local relay push gateway while developing:

```sh
FIELDWORK_RELAY_DB_PATH="$(mktemp -d)/relay.db" target/debug/fieldwork-relay
FIELDWORK_RELAY_CONTROL_URL=http://127.0.0.1:8443 target/debug/fieldworkd
```

The relay gateway persists daemon keys, push-token ownership, and recent replay nonces in SQLite, then validates daemon signatures and privacy-preserving push requests locally. Set `FIELDWORK_RELAY_DB_PATH=off` for a purely in-memory local smoke test. Real APNs/FCM delivery requires relay-only Apple/Firebase credentials and physical-device verification, so it is not part of the local install flow.

The production relay deploy scaffold lives under `infra/relay/ansible`. Override `fieldwork_relay_binary` when running the playbook. The default group variables set the HTTPS control listener to `0.0.0.0:8443`, the control metrics listener to `127.0.0.1:9090`, the relay OTLP endpoint to Honeycomb, the trace sample rate to `0.01`, and the SQLite path to `/var/lib/fieldwork/relay.db`. The same binary is also deployed as `fieldwork-iroh-relay.service` with `FIELDWORK_RELAY_MODE=iroh-relay`, ACME-backed HTTPS on `0.0.0.0:443`, HTTP challenge/probe handling on `0.0.0.0:80`, QUIC address discovery on `0.0.0.0:7842`, and iroh relay metrics on `127.0.0.1:9091`. The playbook creates the relay data directory as `0700`; the relay process enforces `0600` on the SQLite database and sidecar files. Control-plane TLS cert/key paths, APNs `.p8`, FCM service-account JSON, and Honeycomb API-key paths are passed to the control-plane unit via `LoadCredential` and must exist only on the relay host. APNs delivery also requires `fieldwork_relay_apns_team_id`, `fieldwork_relay_apns_key_id`, and `fieldwork_relay_apns_topic`; the relay caches the signed APNs provider JWT for 50 minutes. FCM delivery reads `fieldwork_relay_fcm_credential`, uses `fieldwork_relay_fcm_endpoint`, and caches the Google OAuth token returned from the service-account JWT exchange.

Current npm packaging checks:

```sh
node scripts/verify-npm-packages.mjs
node scripts/verify-changesets-config.mjs
node scripts/test-npm-dispatcher.mjs
node scripts/test-npm-registry-state.mjs
node scripts/test-npm-artifact-pack.mjs
node scripts/test-bun-install.mjs
npm pack ./packages/cli --dry-run --json
```

`fieldwork` is the meta package. It exposes `fieldwork`, `fw`, and
`fieldworkd`: `fw` is a shorter alias for the same user-facing CLI, so `fw pair`
starts the same QR-pairing flow as `fieldwork pair`. Postinstall swaps the CLI
and daemon commands to native binaries when scripts are allowed, and the shipped
dispatchers run the matching platform package when postinstall is skipped.
Running either CLI name with no subcommand uses the smart default: create and
attach a default `claude` session when none exist, attach the only existing
session, or list sessions when several are available. The create branch
auto-generates a one-word display name that mobile apps show from the daemon
session list. Running `fw refactoringjob` uses the named-session fast path, and
`fw new --name <name> [cmd...]` creates an explicitly named arbitrary-command PTY. The v1 platform
packages are
`fieldwork-darwin-arm64`, `fieldwork-darwin-x64`,
`fieldwork-linux-arm64`, and `fieldwork-linux-x64`. Each platform
package receives `fieldwork` and `fieldworkd` from the release artifact pipeline
before publish. The artifact-pack test creates synthetic release artifacts
locally so the package-preparation and dry-run behavior can be checked without
publishing. It also proves a missing platform/target artifact directory is
rejected before a package can accidentally receive another platform's binaries.
The unscoped `fieldwork` meta package is operator-owned, so live registry
lookups are not used as name-availability checks for the meta package. The
registry-state checker fails closed when run without explicit release-state
expectation flags. The platform child publish rights still require the
operator's npm account and release token.
After the operator placeholder-publishes or release-publishes the platform
children, run `node scripts/verify-npm-registry-state.mjs --expect-meta-published --expect-platform-published`; after the
v1 release publish, add `--expect-latest-version=1.0.0 --expect-provenance` to
verify the latest registry dist-tag and npm SLSA provenance metadata across the
package family.

`scripts/test-bun-install.mjs` uses pinned `esbuild@0.25.12` registry packages to smoke-test Bun's platform optional-dependency selection for the same meta-package plus platform-child package pattern Fieldwork publishes.

Current iOS development flow:

```sh
open apps/ios/Fieldwork.xcodeproj
```

The Xcode target expects Xcode 16.3 for local development on the current macOS 15.2 host and a selected iOS SDK. It builds the Rust static libraries through `apps/ios/scripts/build-rust.sh`, generates the UniFFI Swift binding, links exact Swift Package Manager pins for SwiftTerm 1.13.0 and sentry-cocoa 9.13.0 from the committed `Package.resolved`, and runs the native SwiftUI app. The Rust script builds an xcframework with `arm64` iOS device plus `arm64`/`x86_64` iOS simulator slices. Full iOS verification is blocked in this shell because only Command Line Tools are selected, not Xcode. Local prerequisites already installed or downloaded: `xcodes` 1.6.2, `aria2` 1.37.0_2, Rust iOS targets, `.xcode-version` set to `16.3`, and reference/source checkouts for `SwiftTerm` v1.13.0, `blink`, and `sentry-cocoa` 9.13.0. `pnpm check:ios-prereqs` runs the same local audit, reports the remaining blocker, and now prints concrete recovery steps to authenticate, run `scripts/check-ios-prereqs.sh --download-xcode`, expand or place `Xcode_16.3.xip`, select `/Applications/Xcode-16.3.app/Contents/Developer`, run `sudo xcodebuild -runFirstLaunch`, rerun the audit, and then run `apps/ios/scripts/build-rust.sh`. Generated `target/debug` and Android build intermediates were cleaned while preserving the release AAB; the latest local audit reports at least 70 GiB free in `~/Downloads`, satisfying the repo script's Xcode download/expansion guard. Downloading Xcode itself remains blocked by Apple Developer authentication/access: `scripts/check-ios-prereqs.sh --download-xcode` and direct `xcodes download 16.3 --data-source xcodeReleases` both report a missing Apple ID/password or require an authenticated Apple Developer session, direct `curl` against Apple's Xcode 16.3 XIP redirects to the unauthorized page, and the existing Chrome session is not signed into an account with access. No Xcode `.xip` is present in `~/Downloads`. Direct Rust iOS target builds also fail until full Xcode is selected because dependency build scripts need `xcrun --sdk iphoneos` and `xcrun --sdk iphonesimulator`. TestFlight/App Store release builds are separate: Apple now requires Xcode 26+ with an iOS 26+ SDK, so `release-ios.yml` runs on `macos-26` and `pnpm check:ios-release-prereqs` verifies that release floor.

Current Android development flow:

```sh
cd apps/android
scripts/build-rust.sh
./gradlew assembleDebug
```

The Android target expects Android Studio, `cargo-ndk`, API 36, and NDK r27. The repo-local `./gradlew` downloads and verifies Gradle 8.14.3 and uses Android Studio's bundled JBR when `JAVA_HOME` is unset. `scripts/build-rust.sh` builds Rust `.so` files into `app/src/main/jniLibs`, generates Kotlin UniFFI bindings into `apps/android/generated`, and renders terminal output with `connectbot/termlib`.

Windows host support is not part of v1; Windows users will use the Linux build inside WSL2 when v1 packaging lands.

## Website

The launch/docs site is a static Astro project in `site/`:

```sh
pnpm --dir site install --ignore-workspace --frozen-lockfile
pnpm check:site
pnpm build:site
```

The optional domain status check,
`node scripts/check-domain-status.mjs --operator-refresh --require-registered --require-dns`,
queries RDAP and DNS for `fieldwork.dev`. Run it only when the operator asks for
a status refresh. It is not an ownership check, a reservation task, or a
Cloudflare Pages credential check.

Cloudflare Pages deployment is handled by `.github/workflows/deploy-site.yml` once the `fieldwork.dev` domain and `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` secrets exist.
