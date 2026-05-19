#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

checks=(
  "locked debug launch|scripts/smoke-android-debug.sh"
  "pair attach input|scripts/smoke-android-emulator-pair.sh"
  "session subscription|scripts/smoke-android-emulator-session-subscription.sh"
  "background replay|scripts/smoke-android-emulator-background-replay.sh"
  "restart restore|scripts/smoke-android-emulator-restart-restore.sh"
  "terminal flood|scripts/smoke-android-emulator-flood.sh"
  "multisession switching|scripts/smoke-android-emulator-multisession.sh"
  "network reconnect|scripts/smoke-android-emulator-reconnect.sh"
  "notification tap routing|scripts/smoke-android-emulator-notification-tap.sh"
)

usage() {
  cat <<'EOF'
Usage: scripts/smoke-android-emulator-all.sh [--list]

Runs the local Android emulator substitute suite. Requires adb, exactly one
boot-complete device unless FIELDWORK_ANDROID_SERIAL is set, release
fieldwork/fieldworkd binaries for the pairing smokes, and the debug Android app
toolchain. This is not physical release-device evidence.
EOF
}

if [[ "${1:-}" == "--" ]]; then
  shift
fi

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  usage
  exit 0
fi

if [[ "${1:-}" == "--list" ]]; then
  for item in "${checks[@]}"; do
    label="${item%%|*}"
    script="${item#*|}"
    printf '%s: bash %s\n' "$label" "$script"
  done
  exit 0
fi

if [[ $# -gt 0 ]]; then
  echo "unknown argument: $1" >&2
  usage >&2
  exit 2
fi

if ! command -v adb >/dev/null 2>&1; then
  echo "adb is required for Android emulator smoke tests." >&2
  exit 1
fi

if [[ -n "${FIELDWORK_ANDROID_SERIAL:-}" ]]; then
  if [[ "$(adb -s "$FIELDWORK_ANDROID_SERIAL" get-state 2>/dev/null | tr -d '\r')" != "device" ]]; then
    echo "FIELDWORK_ANDROID_SERIAL=$FIELDWORK_ANDROID_SERIAL is not an online adb device." >&2
    adb devices >&2
    exit 1
  fi
  serial="$FIELDWORK_ANDROID_SERIAL"
else
  devices=()
  while IFS= read -r device; do
    devices+=("$device")
  done < <(adb devices | awk 'NR > 1 && $2 == "device" { print $1 }')
  if [[ "${#devices[@]}" -ne 1 ]]; then
    echo "Expected exactly one booted adb device, found ${#devices[@]}. Set FIELDWORK_ANDROID_SERIAL to choose one." >&2
    adb devices >&2
    exit 1
  fi
  serial="${devices[0]}"
fi

boot_completed="$(adb -s "$serial" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')"
if [[ "$boot_completed" != "1" ]]; then
  echo "Android device $serial is not boot-complete." >&2
  exit 1
fi

for item in "${checks[@]}"; do
  label="${item%%|*}"
  script="${item#*|}"
  echo
  echo "==> Android emulator smoke: $label"
  bash "$root/$script"
done

echo
echo "android emulator substitute suite ok"
