## Summary

-

## Verification

- [ ] `cargo fmt --check`
- [ ] `cargo clippy --workspace -- -D warnings`
- [ ] `cargo nextest run --workspace`
- [ ] `cargo test --workspace --doc`
- [ ] Relevant npm/static checks, mobile builds, or smoke tests for touched areas

## v1 Boundaries

- [ ] Mobile still cannot create sessions, kill sessions, or choose commands
- [ ] Push payloads and notification UI remain content-free and generic
- [ ] npm remains the only desktop install/update path
- [ ] Future-only work stays in `FUTURE.md`

## External Gates

List any checks that require credentials, provider accounts, signing assets,
hosted infrastructure, or physical devices.

-
