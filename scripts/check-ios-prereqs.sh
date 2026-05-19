#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
required_xcode="${FIELDWORK_XCODE_VERSION:-}"
if [ -z "$required_xcode" ] && [ -f "$repo_root/.xcode-version" ]; then
  required_xcode="$(tr -d '[:space:]' < "$repo_root/.xcode-version")"
fi
release_mode=0
release_xcode_major="${FIELDWORK_IOS_RELEASE_XCODE_MAJOR:-26}"
release_sdk_major="${FIELDWORK_IOS_RELEASE_SDK_MAJOR:-26}"
download_dir="${FIELDWORK_XCODE_DOWNLOAD_DIR:-$HOME/Downloads}"
download_xcode=0
failures=0
warnings=0
xip_match=""

usage() {
  cat <<EOF
usage: scripts/check-ios-prereqs.sh [--release] [--download-xcode] [--download-dir DIR]

Checks the local iOS build prerequisites for Fieldwork. By default this is
read-only and checks the local development Xcode pin in .xcode-version.
Pass --release to check the TestFlight/App Store release floor instead.
Pass --download-xcode to invoke xcodes once Apple authentication and enough
disk space are available.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --release)
      release_mode=1
      shift
      ;;
    --download-xcode)
      download_xcode=1
      shift
      ;;
    --download-dir)
      if [ "$#" -lt 2 ]; then
        echo "missing value for --download-dir" >&2
        exit 2
      fi
      download_dir="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

ok() {
  printf 'ok: %s\n' "$1"
}

warn() {
  warnings=$((warnings + 1))
  printf 'warn: %s\n' "$1"
}

fail() {
  failures=$((failures + 1))
  printf 'fail: %s\n' "$1"
}

have_command() {
  command -v "$1" >/dev/null 2>&1
}

print_command_version() {
  command_name="$1"
  shift
  if have_command "$command_name"; then
    version="$("$@" 2>/dev/null | sed -n '1p')"
    ok "$command_name available${version:+ ($version)}"
  else
    fail "$command_name is required"
  fi
}

free_gib_for() {
  path="$1"
  if [ ! -d "$path" ]; then
    path="$(dirname "$path")"
  fi
  df -Pk "$path" | awk 'NR == 2 { printf "%d", int($4 / 1024 / 1024) }'
}

check_reference_checkout() {
  reference="$1"
  required_tag="${2:-}"
  path="$repo_root/references/$reference"

  if [ ! -d "$path" ]; then
    warn "reference checkout missing: references/$reference"
    return
  fi

  if [ -z "$required_tag" ]; then
    ok "reference checkout present: references/$reference"
    return
  fi

  if ! have_command git || ! git -C "$path" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    warn "reference checkout present but cannot verify tag: references/$reference"
    return
  fi

  if git -C "$path" tag --points-at HEAD | grep -qx "$required_tag"; then
    ok "reference checkout present: references/$reference@$required_tag"
  elif git -C "$path" rev-parse -q --verify "refs/tags/$required_tag" >/dev/null; then
    current_ref="$(git -C "$path" describe --tags --always --dirty 2>/dev/null || git -C "$path" rev-parse --short HEAD)"
    warn "reference checkout references/$reference is at $current_ref; $required_tag is fetched but not checked out"
  else
    warn "reference checkout references/$reference is missing required tag $required_tag"
  fi
}

echo "Fieldwork iOS prerequisite check"
if [ "$release_mode" -eq 1 ]; then
  echo "mode: release"
  echo "required Xcode major: >= $release_xcode_major"
  echo "required iOS SDK major: >= $release_sdk_major"
else
  echo "mode: local development"
  echo "required Xcode: ${required_xcode:-unknown}"
fi
echo "download dir: $download_dir"
echo

if have_command sw_vers; then
  macos_version="$(sw_vers -productVersion)"
  ok "macOS $macos_version detected"
else
  warn "sw_vers unavailable; cannot report macOS version"
fi

if [ "$release_mode" -eq 0 ]; then
  if [ -f "$repo_root/.xcode-version" ]; then
    pinned_xcode="$(tr -d '[:space:]' < "$repo_root/.xcode-version")"
    if [ "$pinned_xcode" = "$required_xcode" ]; then
      ok ".xcode-version pins $pinned_xcode"
    else
      fail ".xcode-version pins $pinned_xcode, expected $required_xcode"
    fi
  else
    fail ".xcode-version is missing"
  fi
else
  if [ -f "$repo_root/.xcode-version" ]; then
    pinned_xcode="$(tr -d '[:space:]' < "$repo_root/.xcode-version")"
    ok ".xcode-version pins local development Xcode $pinned_xcode"
  else
    warn ".xcode-version is missing; local development Xcode pin cannot be reported"
  fi
fi

print_command_version rustup rustup --version
print_command_version cargo cargo --version
if [ "$release_mode" -eq 0 ]; then
  print_command_version xcodes xcodes version
  print_command_version aria2c aria2c --version
else
  if have_command xcodes; then
    print_command_version xcodes xcodes version
  else
    warn "xcodes unavailable; not required on the preinstalled release runner"
  fi
  if have_command aria2c; then
    print_command_version aria2c aria2c --version
  else
    warn "aria2c unavailable; not required on the preinstalled release runner"
  fi
fi
print_command_version swiftc swiftc --version

for target in aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios; do
  if rustup target list --installed 2>/dev/null | grep -qx "$target"; then
    ok "Rust target installed: $target"
  else
    fail "Rust target missing: $target (run: rustup target add $target)"
  fi
done

developer_dir="${DEVELOPER_DIR:-}"
if [ -z "$developer_dir" ]; then
  developer_dir="$(xcode-select -p 2>/dev/null || true)"
fi

if [ -n "$developer_dir" ]; then
  ok "developer dir: $developer_dir"
else
  fail "no selected developer directory"
fi

if xcodebuild_version="$(xcodebuild -version 2>/dev/null)"; then
  first_line="$(printf '%s\n' "$xcodebuild_version" | sed -n '1p')"
  if [ "$release_mode" -eq 1 ]; then
    xcode_major="$(printf '%s\n' "$first_line" | sed -n 's/^Xcode \([0-9][0-9]*\).*/\1/p')"
    if [ -n "$xcode_major" ] && [ "$xcode_major" -ge "$release_xcode_major" ]; then
      ok "$first_line selected"
    else
      fail "$first_line selected, expected Xcode major >= $release_xcode_major"
    fi
  else
    selected_xcode_version="$(printf '%s\n' "$first_line" | sed -n 's/^Xcode \([^[:space:]]*\).*/\1/p')"
    if [ -n "$required_xcode" ] && [ "$selected_xcode_version" = "$required_xcode" ]; then
      ok "$first_line selected"
    else
      fail "$first_line selected, expected Xcode $required_xcode"
    fi
  fi
else
  fail "xcodebuild cannot run; select a full Xcode, not Command Line Tools"
fi

for sdk in iphoneos iphonesimulator; do
  if sdk_path="$(xcrun --sdk "$sdk" --show-sdk-path 2>/dev/null)"; then
    ok "$sdk SDK available at $sdk_path"
    if [ "$release_mode" -eq 1 ]; then
      sdk_version="$(xcrun --sdk "$sdk" --show-sdk-version 2>/dev/null || true)"
      sdk_major="${sdk_version%%.*}"
      if [ -n "$sdk_major" ] && [ "$sdk_major" -ge "$release_sdk_major" ]; then
        ok "$sdk SDK version $sdk_version"
      else
        fail "$sdk SDK version ${sdk_version:-unknown}, expected major >= $release_sdk_major"
      fi
    fi
  else
    fail "$sdk SDK unavailable"
  fi
done

if have_command lipo; then
  ok "lipo available"
else
  fail "lipo is required to create the simulator universal static library"
fi

if [ "$release_mode" -eq 0 ]; then
  mkdir -p "$download_dir"
  free_gib="$(free_gib_for "$download_dir")"
  if [ "$free_gib" -ge 70 ]; then
    ok "$download_dir has ${free_gib} GiB free"
  else
    warn "$download_dir has ${free_gib} GiB free; Xcode download plus expansion should have at least 70 GiB free"
  fi

  if [ -z "$required_xcode" ]; then
    warn "no required Xcode version configured; cannot look for Xcode XIP"
  else
    xip_match="$(find "$download_dir" -maxdepth 1 -type f \( -name "Xcode_${required_xcode}.xip" -o -name "Xcode-${required_xcode}.xip" -o -name "Xcode ${required_xcode}.xip" \) -print -quit 2>/dev/null || true)"
  fi
  if [ -n "$xip_match" ]; then
    ok "found Xcode XIP: $xip_match"
  elif [ -z "$required_xcode" ]; then
    :
  else
    warn "no Xcode $required_xcode XIP found in $download_dir"
  fi

  check_reference_checkout SwiftTerm v1.13.0
  check_reference_checkout blink
  check_reference_checkout sentry-cocoa 9.13.0
fi

if [ "$download_xcode" -eq 1 ]; then
  if [ "$release_mode" -eq 1 ]; then
    fail "--download-xcode is only supported for the local pinned Xcode path; use a macos-26 release runner for TestFlight/App Store builds"
  elif [ -z "$required_xcode" ]; then
    fail "cannot download Xcode because no required Xcode version is configured"
  elif ! have_command xcodes; then
    fail "cannot download Xcode because xcodes is unavailable"
  elif [ "$free_gib" -lt 70 ]; then
    fail "refusing Xcode download with only ${free_gib} GiB free in $download_dir"
  else
    echo
    echo "Starting Xcode $required_xcode download through xcodes using the XcodeReleases data source."
    echo "Apple may still require an authenticated Developer account/session before the XIP transfer can start."
    if xcodes download "$required_xcode" --directory "$download_dir" --data-source xcodeReleases --no-color; then
      ok "Xcode $required_xcode download completed in $download_dir"
    else
      fail "Xcode $required_xcode download was blocked; sign in with an Apple Developer account for xcodes or place Xcode_${required_xcode}.xip in $download_dir"
    fi
  fi
fi

echo
if [ "$failures" -gt 0 ]; then
  echo "iOS prerequisite check failed with $failures failure(s) and $warnings warning(s)."
  if [ "$release_mode" -eq 0 ]; then
    echo
    echo "Next local iOS steps:"
    if [ -z "$required_xcode" ]; then
      echo "  1. Restore .xcode-version or set FIELDWORK_XCODE_VERSION to the local Xcode version."
      echo "  2. Rerun:"
      echo "     pnpm check:ios-prereqs"
    elif [ -z "$xip_match" ]; then
      echo "  1. Authenticate with an Apple Developer account, then run:"
      echo "     scripts/check-ios-prereqs.sh --download-xcode"
      echo "     Or place Xcode_${required_xcode}.xip in $download_dir."
    else
      echo "  1. Expand the downloaded XIP:"
      echo "     open \"$xip_match\""
    fi
    if [ -n "$required_xcode" ]; then
      echo "  2. Move the expanded app to /Applications/Xcode-${required_xcode}.app or /Applications/Xcode.app."
      echo "  3. Select the full Xcode developer directory, for example:"
      echo "     sudo xcode-select -s /Applications/Xcode-${required_xcode}.app/Contents/Developer"
      echo "  4. Accept/finish first-launch setup, then rerun:"
      echo "     sudo xcodebuild -runFirstLaunch"
      echo "     pnpm check:ios-prereqs"
      echo "     apps/ios/scripts/build-rust.sh"
    fi
  fi
  exit 1
fi

echo "iOS prerequisite check passed with $warnings warning(s)."
