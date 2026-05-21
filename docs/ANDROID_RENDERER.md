# Android Terminal Renderer Gate

Decision: use `connectbot/termlib` for v1 Android.

Rationale:

- `termlib` is an Apache-2.0 native Jetpack Compose terminal backed by MIT-licensed libvterm, so it consumes the same raw PTY byte stream as SwiftTerm on iOS.
- It supports the v1 rendering needs called out in `PLAN.md`: 256/true color, double-width and combining characters, text selection, scrolling, zoom, and resize.
- It is published as `org.connectbot:termlib`; the Android app currently pins `0.0.35`.
- Recent upstream work specifically addressed two v1 risk areas: IME `ACTION_MULTIPLE` input handling and terminal recomposition overhead.

Known risk:

- `termlib` is young and still has open issues. The old WebView/xterm.js path remains rejected for v1 because Android WebView IME behavior is the exact class of issue the native renderer avoids.

Local verification status:

- Implemented an Android Compose v0 target that wires `Terminal(...)` to `mobile-core` `ByteStreamSink` output and sends termlib keyboard bytes back through `AttachedSession.sendInput`.
- XML resources lint locally with `xmllint`.
- `apps/android/scripts/build-rust.sh` builds the Rust mobile core for `arm64-v8a`, `armeabi-v7a`, and `x86_64`.
- `apps/android/gradlew --no-daemon bundleRelease` builds a release AAB that includes all three ABI slices.
- `pnpm test:android-emulator` aggregates the direct-adb emulator substitutes: debug launch timing, pair flow, dashboard subscription, terminal flood rendering, background replay, restart restore, multisession, reconnect, and notification tap routing.
- Latest default aggregate run on 2026-05-19 passed on `emulator-5554` with locked debug launch `TotalTime=7920ms`, pair `pair_flow_ms=2234`, session subscription `visible_ms=3318`, 8440/14400 flood screenshot nonblack samples, no Fieldwork crash log entries, and adb artifacts captured under `/tmp/fieldwork-android-aggregate-*`.
- A 2026-05-21 direct adb terminal attach/input refresh on `Medium_Phone_API_36.1`
  kept the terminal surface at the app root while attached, hid the global
  Sessions/Settings bottom navigation, showed the terminal accessory bar, and
  explicitly focused termlib's IME target. Evidence under
  `/tmp/fieldwork-adb-terminalfix-live-20260521155139` includes screenshots, UI
  XML, app logcat, an empty crash buffer, and a separately approved verifier
  client that saw `android-direct: android_terminal_fix_ok` from emulator
  keyboard input in the live PTY.
- The required 30-minute physical Android device dogfood is a counted unchecked
  `PLAN.md` release gate before Play internal distribution. It remains blocked
  in this shell by the lack of an attached Android test device.

Sources checked on 2026-05-18:

- `https://github.com/connectbot/termlib`
- `https://github.com/connectbot/termlib/pull/192`
- `https://github.com/connectbot/termlib/pull/198`
- `https://github.com/connectbot/connectbot/commit/b12132ac9973613479a442c6a7d124f7cf6406be`
