#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fieldwork="$repo_root/target/debug/fieldwork"

# Thin wrapper around `fieldwork pair-test` for manual pairing checks.
#
# QR/ticket path (default): pass the compact "fw1..." pairing ticket as the first
# argument, or pipe it on stdin. The ticket is what the desktop QR encodes.
#   scripts/pair-test.sh fw1abcd... --attach first
#   printf 'fw1abcd...' | scripts/pair-test.sh
#
# Typed-code path: pass --code <CODE> (plus a relay control URL via
# --relay-control-url or the FIELDWORK_RELAY_CONTROL_URL env var). The code is
# resolved to reachability through the relay rendezvous endpoint.
#   scripts/pair-test.sh --code AB C12 --relay-control-url http://127.0.0.1:8443
#
# Any additional flags are forwarded verbatim to `fieldwork pair-test`.

if [[ "${1:-}" == --* ]]; then
  # No leading ticket: caller is driving --code (or another flag form) directly.
  exec "$fieldwork" pair-test "$@"
fi

if [[ $# -gt 0 ]]; then
  payload="$1"
  shift
  exec "$fieldwork" pair-test --payload "$payload" "$@"
fi

payload="$(cat)"
exec "$fieldwork" pair-test --payload "$payload"
