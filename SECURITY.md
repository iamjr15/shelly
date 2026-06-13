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
- Pairing uses one active 5-character Crockford code plus a compact `fw1`
  `PairingTicket`; the code has a 5-minute TTL, is invalidated after 5 wrong
  attempts, and still requires explicit desktop approval.
- Paired device records, push tokens, session summaries, and scrollback are persisted in encrypted `redb` stores with OS-keychain-held keys.
- Long-lived iroh and relay-signing keys are stored in the OS keychain.
- iroh clients are authorized by their paired node identity.
- The Android app gates resume and stale input through BiometricPrompt. The parked iOS source does the same through LocalAuthentication.
- Relay push requests are schema-validated, Ed25519-signed, nonce-protected, clock-skew checked, token-ownership checked, and rate-limited.
- Relay push payloads reject terminal content fields and only carry opaque hashes plus fixed event enums.

## Release Blockers

The v1 release still requires real-device and hosted-infrastructure verification:

- FCM service-account JSON must live only on the relay. The same boundary
  applies to the APNs `.p8` when the deferred iOS client resumes.
- Actual FCM payloads must be inspected to confirm generic lock-screen content
  and no terminal data; APNs payload inspection is deferred with iOS.
- Device revocation must be verified against real Android clients after
  `fieldwork devices remove` (and against iOS clients when iOS resumes).
- macOS npm trust/ad-hoc-signing checks, Android release signing, npm
  provenance, and relay deployment must pass in CI with production secrets.
  iOS signing is deferred with the iOS client.
- `cargo deny`, `cargo audit`, and the full Android build must run in CI before
  a v1 tag.
