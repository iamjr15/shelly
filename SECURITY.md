# Security

Report security issues privately before opening public issues. Until the project has a dedicated security address, send reports to the maintainer through GitHub private vulnerability reporting for the repository.

## Supported Versions

Fieldwork has not published a stable v1.0.0 release yet. Security fixes currently land on `main`.

## Current Controls

The current implementation enforces:

- Unix socket parent directory ownership and `0700` permissions.
- Symlink rejection for the Unix socket parent.
- Unix socket file mode `0600`.
- `CreateSession` and `KillSession` authorization restricted to `LocalCli`.
- Arbitrary PTY commands stream raw bytes through the daemon; mobile clients can attach/input/resize/detach but cannot launch or kill commands.
- Pair tokens are 32 random bytes, base32 encoded, 10-minute TTL, single-use, and require explicit desktop approval.
- Paired device records, push tokens, session summaries, and scrollback are persisted in encrypted `redb` stores with OS-keychain-held keys.
- Long-lived iroh and relay-signing keys are stored in the OS keychain.
- iroh clients are authorized by their paired node identity.
- iOS and Android app sources gate resume and stale input through LocalAuthentication/BiometricPrompt.
- Relay push requests are schema-validated, Ed25519-signed, nonce-protected, clock-skew checked, token-ownership checked, and rate-limited.
- Relay push payloads reject terminal content fields and only carry opaque hashes plus fixed event enums.

## Release Blockers

The v1 release still requires real-device and hosted-infrastructure verification:

- APNs `.p8` and FCM service-account JSON must live only on the relay.
- Actual APNs/FCM payloads must be inspected to confirm generic lock-screen content and no terminal data.
- Device revocation must be verified against real iOS and Android clients after `fieldwork devices remove`.
- macOS daemon signing/notarization, iOS signing, Android release signing, npm provenance, and relay deployment must pass in CI with production secrets.
- `cargo deny`, `cargo audit`, and full mobile builds must run in CI before a v1 tag.
