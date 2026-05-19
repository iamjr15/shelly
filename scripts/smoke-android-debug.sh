#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
package="app.fieldwork.android"
activity="$package/.MainActivity"
max_launch_ms="${FIELDWORK_ANDROID_DEBUG_SMOKE_MAX_MS:-8000}"
biometric_bypass="${FIELDWORK_ANDROID_BIOMETRIC_BYPASS:-false}"

if [[ -n "${FIELDWORK_ANDROID_SERIAL:-}" ]]; then
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

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

adb -s "$serial" shell pm clear "$package" >/dev/null 2>&1 || true
"$root/apps/android/gradlew" --no-daemon :app:installDebug >/tmp/fieldwork-android-install-debug.log
if [[ "$biometric_bypass" == "true" ]]; then
  adb -s "$serial" shell pm grant "$package" android.permission.CAMERA >/dev/null 2>&1 || true
fi
adb -s "$serial" logcat -c
adb -s "$serial" shell am force-stop "$package"

launch_log="$tmp_dir/launch.txt"
adb -s "$serial" shell am start -W -n "$activity" | tee "$launch_log"

if ! grep -q '^Status: ok$' "$launch_log"; then
  echo "Android debug smoke launch did not report Status: ok" >&2
  exit 1
fi

total_time="$(awk '/^TotalTime:/ { print $2 }' "$launch_log")"
if [[ -z "$total_time" || ! "$total_time" =~ ^[0-9]+$ ]]; then
  echo "Android debug smoke could not parse launch TotalTime." >&2
  exit 1
fi
if (( total_time > max_launch_ms )); then
  echo "Android debug smoke launch took ${total_time}ms, above debug smoke limit ${max_launch_ms}ms." >&2
  exit 1
fi

ui_xml="$tmp_dir/ui.xml"
adb -s "$serial" exec-out uiautomator dump /dev/tty >"$ui_xml"
if grep -Eq "Process system isn't responding|System UI isn't responding|Application Not Responding" "$ui_xml"; then
  echo "Android debug smoke is blocked by a system ANR dialog." >&2
  exit 1
fi
if [[ "$biometric_bypass" == "true" ]]; then
  if grep -q 'text="Unlock"' "$ui_xml"; then
    echo "Android debug smoke biometric bypass still showed the locked Unlock surface." >&2
    exit 1
  fi
  if ! grep -q 'text="Pairing payload"' "$ui_xml"; then
    echo "Android debug smoke biometric bypass did not reach the pairing screen." >&2
    exit 1
  fi
  if ! grep -q 'text="Settings"' "$ui_xml"; then
    echo "Android debug smoke biometric bypass did not render the bottom navigation." >&2
    exit 1
  fi
else
  if ! grep -q 'text="Unlock"' "$ui_xml"; then
    echo "Android debug smoke did not find the locked Unlock surface in UIAutomator output." >&2
    exit 1
  fi
fi

crash_log="$tmp_dir/crash.log"
adb -s "$serial" logcat -d -b crash >"$crash_log"
if grep -q "$package" "$crash_log"; then
  echo "Android debug smoke found $package in the crash log." >&2
  tail -120 "$crash_log" >&2
  exit 1
fi

full_log="$tmp_dir/logcat.log"
adb -s "$serial" logcat -d >"$full_log"
if grep -Eq "FATAL EXCEPTION.*$package|ANR in $package|am_crash.*$package|am_anr.*$package" "$full_log"; then
  echo "Android debug smoke found a Fieldwork crash or ANR in logcat." >&2
  grep -E "FATAL EXCEPTION.*$package|ANR in $package|am_crash.*$package|am_anr.*$package" "$full_log" >&2
  exit 1
fi

screenshot="$tmp_dir/screen.png"
adb -s "$serial" exec-out screencap -p >"$screenshot"
python3 - "$screenshot" <<'PY'
import struct
import sys
import zlib
from pathlib import Path

path = Path(sys.argv[1])
data = path.read_bytes()
if not data.startswith(b"\x89PNG\r\n\x1a\n"):
    raise SystemExit("Android debug smoke screenshot is not a PNG")

pos = 8
width = height = bit_depth = color_type = None
idat = []
while pos < len(data):
    size = struct.unpack(">I", data[pos:pos + 4])[0]
    pos += 4
    chunk_type = data[pos:pos + 4]
    pos += 4
    chunk = data[pos:pos + size]
    pos += size + 4
    if chunk_type == b"IHDR":
        width, height, bit_depth, color_type, compression, png_filter, interlace = struct.unpack(">IIBBBBB", chunk)
        if compression != 0 or png_filter != 0 or interlace != 0:
            raise SystemExit("Android debug smoke screenshot uses an unsupported PNG format")
    elif chunk_type == b"IDAT":
        idat.append(chunk)

if (bit_depth, color_type) != (8, 6):
    raise SystemExit(f"Android debug smoke screenshot must be 8-bit RGBA, got bit_depth={bit_depth} color_type={color_type}")

raw = zlib.decompress(b"".join(idat))
bytes_per_pixel = 4
stride = width * bytes_per_pixel
previous = bytearray(stride)
rows = []
offset = 0
for _ in range(height):
    filter_type = raw[offset]
    offset += 1
    row = bytearray(raw[offset:offset + stride])
    offset += stride
    for i in range(stride):
        left = row[i - bytes_per_pixel] if i >= bytes_per_pixel else 0
        up = previous[i]
        upper_left = previous[i - bytes_per_pixel] if i >= bytes_per_pixel else 0
        if filter_type == 1:
            row[i] = (row[i] + left) & 0xff
        elif filter_type == 2:
            row[i] = (row[i] + up) & 0xff
        elif filter_type == 3:
            row[i] = (row[i] + ((left + up) // 2)) & 0xff
        elif filter_type == 4:
            predictor = left + up - upper_left
            pa = abs(predictor - left)
            pb = abs(predictor - up)
            pc = abs(predictor - upper_left)
            row[i] = (row[i] + (left if pa <= pb and pa <= pc else up if pb <= pc else upper_left)) & 0xff
        elif filter_type != 0:
            raise SystemExit(f"Android debug smoke screenshot has unsupported PNG filter {filter_type}")
    rows.append(row)
    previous = row

samples = []
for y in range(0, height, max(1, height // 120)):
    row = rows[y]
    for x in range(0, width, max(1, width // 120)):
        i = x * bytes_per_pixel
        samples.append(tuple(row[i:i + 3]))

nonblack = sum(1 for pixel in samples if max(pixel) > 10)
if nonblack < len(samples) * 0.25:
    raise SystemExit(f"Android debug smoke screenshot appears blank: nonblack={nonblack} samples={len(samples)}")
print(f"screenshot nonblank: {width}x{height}, nonblack samples {nonblack}/{len(samples)}")
PY

echo "android debug smoke ok: serial=$serial total_time_ms=$total_time biometric_bypass=$biometric_bypass"
