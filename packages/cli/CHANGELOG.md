# shellykit

## 1.0.5

### Patch Changes

- [`1bf5491`](https://github.com/iamjr15/shelly/commit/1bf5491dff70b0fe3e8e30d47fcb5c1d5d8cecda) Thanks [@iamjr15](https://github.com/iamjr15)! - Make interactive pairing resize-safe with an alternate-screen UI, clean Ctrl+C cancellation, and explicit high-contrast colors for the QR panel and pairing-code keycaps.

## 1.0.4

### Patch Changes

- [`70dfaf8`](https://github.com/iamjr15/shelly/commit/70dfaf877cfe1549b7e81ad06f7e10803712f1f7) Thanks [@iamjr15](https://github.com/iamjr15)! - Keep Rust binaries, npm packages, and release tags on one version. This makes `shelly --version` report the installed release correctly and blocks future mismatched publishes.

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
