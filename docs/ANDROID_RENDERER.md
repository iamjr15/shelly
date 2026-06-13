# Android Terminal Renderer Gate

Decision: use `connectbot/termlib` for v1 Android.

Rationale:

- `termlib` is an Apache-2.0 native Jetpack Compose terminal backed by MIT-licensed libvterm, so it consumes the same raw PTY byte stream that Shelly transports between daemon and mobile clients.
- It supports the v1 rendering needs called out in `PLAN.md`: 256/true color, double-width and combining characters, text selection, scrolling, zoom, and resize.
- It is published as `org.connectbot:termlib`; the Android app currently pins `0.0.35`.
- Recent upstream work specifically addressed two v1 risk areas: IME `ACTION_MULTIPLE` input handling and terminal recomposition overhead.

Known risk:

- `termlib` is young and still has open issues. The old WebView/xterm.js path remains rejected for v1 because Android WebView IME behavior is the exact class of issue the native renderer avoids.

Local verification status:

- Implemented the native Android Compose app target that wires `Terminal(...)` to `mobile-core` `ByteStreamSink` output and sends termlib keyboard bytes back through `AttachedSession.sendInput`.
- XML resources lint locally with `xmllint`.
- Android Gradle app tasks depend on `buildRustMobileCore`, which runs `apps/android/scripts/build-rust.sh` before Kotlin compilation or native-library merge.
- `apps/android/gradlew --no-daemon bundleRelease` builds the Rust mobile core for `arm64-v8a`, `armeabi-v7a`, and `x86_64`, then emits a release AAB that includes all three ABI slices.
- Latest direct adb emulator pass on 2026-06-02 used `Medium_Phone_API_36.1`,
  paired through the local relay/daemon, attached to a daemon-owned `bash`
  session named `pretzel`, sent `shelly_android_direct_ok` from the Android terminal,
  verified the live PTY bytes through a second paired client, force-stopped and
  relaunched the app, restored the paired dashboard, and found no Shelly
  crash/ANR logcat entries. This was a direct adb spot check, not a repo-owned
  evidence harness.
- A 2026-05-21 direct adb terminal attach/input refresh on `Medium_Phone_API_36.1`
  kept the terminal surface at the app root while attached, hid the global
  Sessions/Settings bottom navigation, showed the terminal accessory bar,
  explicitly focused termlib's IME target, and verified through a separately
  paired client that emulator keyboard input reached the live PTY as
  `android-direct: android_terminal_fix_ok`.
- A same-day direct adb TUI attach pass opened a daemon-owned `htop` session
  named `tui` from the Android dashboard and captured the attached terminal
  rendering `htop` function-key chrome (`F1Help`, `F2Setup`, `F10Quit`) with
  `Attached` status, the accessory bar, no global bottom navigation, focused
  termlib IME target, app logcat, and empty crash buffers. These were direct
  adb spot checks, not repo-owned evidence harnesses.
- A physical Android release-device pass is still required before Play internal
  distribution. The current local substitute is direct manual `adb` screenshots,
  UI dumps, and logcat inspection on an emulator when a device is available.

Sources checked on 2026-05-18:

- `https://github.com/connectbot/termlib`
- `https://github.com/connectbot/termlib/pull/192`
- `https://github.com/connectbot/termlib/pull/198`
- `https://github.com/connectbot/connectbot/commit/b12132ac9973613479a442c6a7d124f7cf6406be`
