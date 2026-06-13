# Development

This guide covers the current source workflow after the custom verifier harness
was removed. Keep checks focused on real build, test, package, and smoke
behavior.

## Rust

```sh
cargo fmt --check
cargo clippy --workspace -- -D warnings
cargo nextest run --workspace
cargo test --workspace --doc
```

The workspace crates are:

- `fieldwork-protocol`
- `fieldwork-daemon`
- `fieldwork-cli`
- `fieldwork-relay`
- `fieldwork-mobile-core`

`fieldworkd` owns PTY sessions and local persistence. `fieldwork` talks to the
daemon over the hardened local socket. Mobile clients use the UniFFI-backed
mobile core and MessagePack protocol over iroh.

## Supply Chain

```sh
cargo deny check
cargo audit
```

Current accepted RustSec output is warning-only and tracked in `deny.toml`.
Treat any new failing advisory, source, or license finding as a release blocker.

## Local Handoff

```sh
scripts/smoke-local-handoff.sh
```

The smoke starts an isolated daemon, creates CLI-owned `claude`, `bash`, and
`vim` sessions, verifies iroh rejects mismatched protocol versions and
`LocalCli` handshakes, pairs a simulated mobile client through explicit desktop
approval, attaches over iroh, sends mobile-originated input, rejects mobile
session create/kill attempts, removes the device, and verifies daemon restart
restore.

The simulated mobile client is intentionally feature-gated. The smoke builds
`fieldwork-cli` with `fieldwork-cli/test-client`; production CLI builds leave
that feature disabled, so the internal `pair-test` command is not present in
the shipped `fieldwork`/`fw` binary.

## npm Packages

```sh
node scripts/test-npm-dispatcher.mjs
node scripts/test-npm-artifact-pack.mjs
node scripts/test-npm-publish-plan.mjs
node scripts/test-bun-install.mjs
npm pack ./packages/cli --dry-run --json
```

The root `fieldwork` package is the meta package. It exposes `fieldwork`, `fw`,
and `fieldworkd`; platform packages provide native `fieldwork` and `fieldworkd`
for:

- `fieldwork-darwin-arm64`
- `fieldwork-darwin-x64`
- `fieldwork-linux-arm64`
- `fieldwork-linux-x64`

`scripts/prepare-npm-artifacts.mjs` stages native binaries from release archive
extracts into the platform packages and copies `LICENSE`/`NOTICE`. `scripts/publish-npm-packages.mjs`
publishes platform packages first and the meta package last with npm provenance.

For local macOS staging across all v1 package targets:

```sh
scripts/build-local-npm-artifacts.sh
```

That script builds the Rust binaries, stages package bins, ad-hoc signs Darwin
binaries, verifies Darwin signatures with `codesign`, and runs the publish
readiness check.

After local artifacts are staged, run the install smoke on a supported host:

```sh
node scripts/smoke-npm-local-install.mjs
```

It packs the meta package plus the matching platform package, installs them into
an isolated project, verifies `fieldwork`, `fw`, and `fieldworkd` entrypoints,
and checks that Darwin binaries remain signed and unquarantined.

## Relay

```sh
scripts/smoke-relay-tls-loopback.sh
node scripts/smoke-relay-otlp-loopback.mjs
```

The relay control plane validates daemon signatures, nonce replay windows,
timestamp skew, token ownership, and push payload shape. The OTLP smoke uses a
local collector and asserts terminal/session/token sentinel strings do not appear
in exported telemetry.

The hosted relay rendezvous smoke is operator-only because it needs a live relay
control URL:

```sh
FIELDWORK_HOSTED_RELAY_CONTROL_URL=https://relay.example.com scripts/smoke-hosted-relay-rendezvous.sh
```

## Android

```sh
apps/android/gradlew --no-daemon bundleRelease
apps/android/gradlew --no-daemon :app:testDebugUnitTest
```

Gradle app tasks depend on `buildRustMobileCore`, which runs
`apps/android/scripts/build-rust.sh` before Kotlin compilation or
native-library merge. `bundleRelease` exercises the release-oriented Android
build path used by CI; run the script directly only when you want an explicit
Rust/UniFFI preflight.

Emulator handoff testing is direct manual adb work: install the debug APK,
capture screenshots/UI dumps/logcat, pair through the relay or local daemon, and
verify terminal input/output with a second client. Physical-device release
testing is manual and deferred until release signing and device access are ready.

## Site

```sh
pnpm --dir site install --ignore-workspace --frozen-lockfile
pnpm check:site
pnpm build:site
```

## Syntax Sweep

For a quick script sanity pass:

```sh
for script in scripts/*.mjs; do node --check "$script"; done
for script in scripts/*.sh apps/android/scripts/*.sh; do bash -n "$script"; done
```
