---
"shellykit": patch
---

Security and reliability hardening for the daemon and relay:

- Revoking a paired device now tears down its live connection immediately, instead of letting an in-flight session keep streaming until it disconnects.
- Relay `/v1/pair` rejects unauthorized key changes for an already-registered daemon under an atomic check, closing a registration-takeover race.
- Relay now prunes expired replay nonces (in memory and SQLite) on a running cadence, fixing unbounded growth on a long-lived relay; adds per-daemon push-token rate limiting and cap eviction, and request/connect timeouts on the APNs and FCM clients.
- Terminal hot path no longer deep-clones the visible screen on every PTY chunk and coalesces small ring writes, reducing per-output allocation.
- Tightened Claude agent-state inference so prompts containing words like "allow" or "approve" no longer produce spurious "awaiting input" push notifications.
