#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
out_dir="$repo_root/apps/android/generated"
cargo_target_dir="${CARGO_TARGET_DIR:-$repo_root/target}"
if [[ "$cargo_target_dir" != /* ]]; then
  cargo_target_dir="$repo_root/$cargo_target_dir"
fi

command -v cargo-ndk >/dev/null

if [[ -z "${ANDROID_HOME:-}" ]]; then
  if [[ -d "$HOME/Library/Android/sdk" ]]; then
    export ANDROID_HOME="$HOME/Library/Android/sdk"
  elif [[ -d "$HOME/Android/Sdk" ]]; then
    export ANDROID_HOME="$HOME/Android/Sdk"
  fi
fi

if [[ -z "${ANDROID_NDK_HOME:-}" && -n "${ANDROID_HOME:-}" && -d "$ANDROID_HOME/ndk" ]]; then
  latest_ndk="$(find "$ANDROID_HOME/ndk" -mindepth 1 -maxdepth 1 -type d | sort | tail -n 1)"
  if [[ -n "$latest_ndk" ]]; then
    export ANDROID_NDK_HOME="$latest_ndk"
  fi
fi

if [[ -z "${ANDROID_HOME:-}" || ! -d "${ANDROID_HOME:-}" ]]; then
  echo "ANDROID_HOME is not set and no default Android SDK directory was found." >&2
  exit 1
fi

if [[ -z "${ANDROID_NDK_HOME:-}" || ! -d "${ANDROID_NDK_HOME:-}" ]]; then
  echo "ANDROID_NDK_HOME is not set and no NDK was found under $ANDROID_HOME/ndk." >&2
  exit 1
fi

rustup target add aarch64-linux-android armv7-linux-androideabi x86_64-linux-android

cargo ndk \
  --manifest-path "$repo_root/Cargo.toml" \
  -t arm64-v8a \
  -t armeabi-v7a \
  -t x86_64 \
  -o "$repo_root/apps/android/app/src/main/jniLibs" \
  build -p fieldwork-mobile-core --release

rm -rf "$out_dir"
mkdir -p "$out_dir"
cargo run -p fieldwork-mobile-core --bin uniffi-bindgen -- generate \
  --library "$cargo_target_dir/aarch64-linux-android/release/libfieldwork_mobile_core.so" \
  --language kotlin \
  --out-dir "$out_dir"
