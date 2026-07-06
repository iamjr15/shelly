# Shelly iOS (parked)

This app is parked source: it is not part of CI, the release workflow, or the
local script surface while iOS is deferred (see `docs/ARCHITECTURE.md`). The
sources are kept correct so work can resume, but the project does not build
from a fresh clone.

## What exists

- SwiftUI app: pairing (QR scan + typed code), live session list, SwiftTerm
  terminal with accessory bar, biometric/passcode gating, APNs registration.
- `Sources/Core/ShellyCoreStubs.swift`: hand-written stand-ins for the UniFFI
  bindings, gated behind the `SHELLY_STUBS` compilation condition, for UI work
  without the Rust core.

## Why it does not build from a fresh clone

- `GeneratedRust/` (the UniFFI binding `shelly_mobile_core.swift` and
  `ShellyCore.xcframework`) is gitignored and there is no checked-in generator:
  the "Build Rust Mobile Core" phase invokes `scripts/build-rust.sh`, which
  does not exist yet (`apps/android/scripts/build-rust.sh` is the Android
  equivalent to mirror when un-parking).
- Setting `SHELLY_SKIP_RUST_BUILD=1` silences that phase but the target still
  compiles and links the missing `GeneratedRust/` outputs.

## UI-only build with stubs

`SHELLY_STUBS` is not set by any build configuration; enable it from the
command line together with excluding the (absent) generated source:

```sh
SHELLY_SKIP_RUST_BUILD=1 xcodebuild build \
  -project apps/ios/Shelly.xcodeproj -scheme Shelly \
  -destination 'generic/platform=iOS Simulator' \
  SWIFT_ACTIVE_COMPILATION_CONDITIONS='DEBUG SHELLY_STUBS' \
  EXCLUDED_SOURCE_FILE_NAMES='shelly_mobile_core.swift' \
  CODE_SIGNING_ALLOWED=NO
```

Known gaps in the stub path (as of Xcode 26.x):

- `GeneratedRust/ShellyCore.xcframework` is still in the Frameworks phase, so
  the build needs a valid placeholder xcframework at that path (or drop it
  from the phase in Xcode).
- SwiftTerm's Metal shaders require the Metal toolchain
  (`xcodebuild -downloadComponent MetalToolchain`), or append `*.metal` to
  `EXCLUDED_SOURCE_FILE_NAMES`.
- Even then Xcode 26 reports a build-graph cycle between the "Build Rust
  Mobile Core" phase's declared `GeneratedRust/` outputs and xcframework
  processing. Until that is untangled, the sources can still be validated
  with `swiftc -typecheck -swift-version 6 -D SHELLY_STUBS` against a built
  SwiftTerm module.
