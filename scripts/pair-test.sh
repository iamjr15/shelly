#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ $# -gt 0 ]]; then
  payload="$1"
  shift
  exec "$repo_root/target/debug/fieldwork" pair-test --payload "$payload" "$@"
fi

payload="$(cat)"
exec "$repo_root/target/debug/fieldwork" pair-test --payload "$payload"
