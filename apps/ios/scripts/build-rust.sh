#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
out_dir="$repo_root/apps/ios/GeneratedRust"
framework_out="$out_dir/FieldworkCore.xcframework"
device_lib="$repo_root/target/aarch64-apple-ios/release/libfieldwork_mobile_core.a"
sim_arm64_lib="$repo_root/target/aarch64-apple-ios-sim/release/libfieldwork_mobile_core.a"
sim_x64_lib="$repo_root/target/x86_64-apple-ios/release/libfieldwork_mobile_core.a"
sim_universal_lib="$out_dir/libfieldwork_mobile_core_simulator.a"

if [ "${FIELDWORK_SKIP_IOS_PREREQ_CHECK:-0}" != "1" ]; then
  if [ -n "${FIELDWORK_IOS_RELEASE_XCODE_MAJOR:-}" ] || [ -n "${FIELDWORK_IOS_RELEASE_SDK_MAJOR:-}" ]; then
    "$repo_root/scripts/check-ios-prereqs.sh" --release
  else
    "$repo_root/scripts/check-ios-prereqs.sh"
  fi
fi

rustup target add aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios

cargo build -p fieldwork-mobile-core --release --target aarch64-apple-ios
cargo build -p fieldwork-mobile-core --release --target aarch64-apple-ios-sim
cargo build -p fieldwork-mobile-core --release --target x86_64-apple-ios

rm -rf "$out_dir"
mkdir -p "$out_dir/Headers"

cargo run -p fieldwork-mobile-core --bin uniffi-bindgen -- generate \
  --library "$device_lib" \
  --language swift \
  --out-dir "$out_dir"

cp "$out_dir/fieldwork_mobile_coreFFI.h" "$out_dir/Headers/"
cp "$out_dir/fieldwork_mobile_coreFFI.modulemap" "$out_dir/Headers/module.modulemap"

lipo -create "$sim_arm64_lib" "$sim_x64_lib" -output "$sim_universal_lib"
lipo -info "$sim_universal_lib"

rm -rf "$framework_out"
xcodebuild -create-xcframework \
  -library "$device_lib" \
  -headers "$out_dir/Headers" \
  -library "$sim_universal_lib" \
  -headers "$out_dir/Headers" \
  -output "$framework_out"
