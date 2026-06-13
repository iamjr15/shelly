# Contributing

Fieldwork is built from `PLAN.md`. Keep implementation, tests, and docs synchronized with that plan. If implementation reality conflicts with the plan, update `PLAN.md` in the same change before continuing.

By contributing to Fieldwork, you license your contribution under
AGPL-3.0-or-later and the Apple App Store distribution additional permission in
`NOTICE`.

## Build

```sh
cargo build --workspace
cargo test --workspace
node scripts/test-npm-dispatcher.mjs
```

Before opening a PR, run:

```sh
cargo fmt --check
cargo clippy --workspace -- -D warnings
cargo nextest run --workspace
cargo test --workspace --doc
```

Run the focused build or smoke command for the area you touched as well, for
example `node scripts/test-npm-artifact-pack.mjs` for npm packaging,
`scripts/smoke-local-handoff.sh` for daemon/CLI handoff behavior, `pnpm
test:android-unit` for Android UI/core changes, or `pnpm check:site` for site
changes.
`cargo deny check` and `cargo audit` are CI supply-chain gates when the tools
are installed.

For release-milestone readiness, use the `Required Local Checks` section in
`PLAN.md`; it is intentionally broader than the day-to-day PR checklist above.

## Design Constraints

- Stream raw PTY bytes, not cell-grid diffs.
- Preserve arbitrary command support.
- Reject session creation and killing from non-local clients.
- Keep the Rust host core narrow and the mobile UI native.
- Keep daemon telemetry opt-in. Relay telemetry must be aggregate-only.
- npm is the only v1 desktop install/update path.
