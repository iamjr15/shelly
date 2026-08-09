# shellykit

## 1.0.3

### Patch Changes

- [`4858b10`](https://github.com/iamjr15/shelly/commit/4858b10e52891828163a99b11ea8d4f12f298f92) Thanks [@iamjr15](https://github.com/iamjr15)! - Security and reliability hardening for the daemon and relay:

  - npm installs no longer run a `postinstall` lifecycle script, eliminating npm's unreviewed-script warning while retaining automatic native platform selection.
  - First daemon startup now explains macOS Keychain prompts, waits as long as a live daemon needs in interactive terminals, prints periodic reminders, and reports the daemon's actual startup error when it exits early. Non-interactive runs retain a bounded timeout.
  - Pairing countdowns now redraw one terminal line without fixed-width padding, preventing narrow panes from appending a new line every second.
  - Revoking a paired device now tears down its live connection immediately, instead of letting an in-flight session keep streaming until it disconnects.
  - Relay `/v1/pair` rejects unauthorized key changes for an already-registered daemon under an atomic check, closing a registration-takeover race.
  - Relay now prunes expired replay nonces (in memory and SQLite) on a running cadence, fixing unbounded growth on a long-lived relay; adds per-daemon push-token rate limiting and cap eviction, and request/connect timeouts on the APNs and FCM clients.
  - Terminal hot path no longer deep-clones the visible screen on every PTY chunk and coalesces small ring writes, reducing per-output allocation.
  - Tightened Claude agent-state inference so prompts containing words like "allow" or "approve" no longer produce spurious "awaiting input" push notifications.
