#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "build-local-npm-artifacts currently requires macOS so Darwin package binaries can be built locally." >&2
  echo "CI release builds still use per-platform runners and release archives." >&2
  exit 2
fi

for tool in cargo rustup zig; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "$tool is required" >&2
    exit 2
  fi
done

if ! cargo zigbuild --help >/dev/null 2>&1; then
  echo "cargo-zigbuild is required; install it with: cargo install cargo-zigbuild --locked" >&2
  exit 2
fi

targets=(
  aarch64-apple-darwin
  x86_64-apple-darwin
  x86_64-unknown-linux-gnu
  aarch64-unknown-linux-gnu
)

rustup target add "${targets[@]}"

target_root="${CARGO_TARGET_DIR:-target}"
case "$target_root" in
  /*) target_root_abs="$target_root" ;;
  *) target_root_abs="$root/$target_root" ;;
esac

echo "==> building host release binaries"
cargo build --release -p fieldwork-cli -p fieldwork-daemon -p fieldwork-relay

echo "==> building Darwin npm platform binaries"
cargo build --release --target aarch64-apple-darwin -p fieldwork-cli -p fieldwork-daemon
cargo build --release --target x86_64-apple-darwin -p fieldwork-cli -p fieldwork-daemon

echo "==> building Linux npm platform binaries"
cargo zigbuild --release --target x86_64-unknown-linux-gnu -p fieldwork-cli -p fieldwork-daemon
cargo zigbuild --release --target aarch64-unknown-linux-gnu -p fieldwork-cli -p fieldwork-daemon

copy_platform() {
  local target="$1"
  local package="$2"
  local src="$target_root_abs/$target/release"
  local out="$root/packages/cli-$package/bin"

  if [[ ! -x "$src/fieldwork" || ! -x "$src/fieldworkd" ]]; then
    echo "missing built binaries for $target under $src" >&2
    exit 1
  fi

  mkdir -p "$out"
  cp "$src/fieldwork" "$out/fieldwork"
  cp "$src/fieldworkd" "$out/fieldworkd"
  chmod 755 "$out/fieldwork" "$out/fieldworkd"
}

copy_platform aarch64-apple-darwin darwin-arm64
copy_platform x86_64-apple-darwin darwin-x64
copy_platform aarch64-unknown-linux-gnu linux-arm64
copy_platform x86_64-unknown-linux-gnu linux-x64

for package_dir in "$root"/packages/cli "$root"/packages/cli-*; do
  cp "$root/LICENSE" "$package_dir/LICENSE"
  cp "$root/NOTICE" "$package_dir/NOTICE"
done

node scripts/verify-npm-packages.mjs --require-binaries
node scripts/publish-npm-packages.mjs --check-ready

echo "local npm artifact build/stage ok"
