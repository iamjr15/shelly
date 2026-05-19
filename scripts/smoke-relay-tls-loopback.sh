#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

command -v openssl >/dev/null || {
  echo "openssl is required for the relay TLS smoke" >&2
  exit 1
}
command -v curl >/dev/null || {
  echo "curl is required for the relay TLS smoke" >&2
  exit 1
}

relay_binary="${FIELDWORK_RELAY_BINARY:-}"
if [[ -n "$relay_binary" ]]; then
  if [[ ! -x "$relay_binary" ]]; then
    echo "FIELDWORK_RELAY_BINARY is not executable: $relay_binary" >&2
    exit 1
  fi
elif [[ -x target/release/fieldwork-relay ]]; then
  relay_binary="target/release/fieldwork-relay"
elif [[ -x target/debug/fieldwork-relay ]]; then
  relay_binary="target/debug/fieldwork-relay"
else
  cargo build -p fieldwork-relay
  relay_binary="target/debug/fieldwork-relay"
fi

tmp="$(mktemp -d)"
port="$((18443 + RANDOM % 1000))"
pid=""

cleanup() {
  if [[ -n "$pid" ]]; then
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  fi
  rm -rf "$tmp"
}
trap cleanup EXIT

openssl req \
  -x509 \
  -newkey rsa:2048 \
  -nodes \
  -days 1 \
  -subj "/CN=localhost" \
  -keyout "$tmp/control-plane.key" \
  -out "$tmp/control-plane.crt" \
  >/dev/null 2>&1

FIELDWORK_RELAY_ADDR="127.0.0.1:$port" \
FIELDWORK_RELAY_METRICS_ADDR=off \
FIELDWORK_RELAY_DB_PATH=off \
FIELDWORK_RELAY_REQUIRE_TLS=true \
FIELDWORK_RELAY_TLS_CERT_PATH="$tmp/control-plane.crt" \
FIELDWORK_RELAY_TLS_KEY_PATH="$tmp/control-plane.key" \
  "$relay_binary" >"$tmp/relay.log" 2>&1 &
pid="$!"

for _ in $(seq 1 50); do
  if body="$(curl -ksSf "https://127.0.0.1:$port/healthz" 2>/dev/null)"; then
    if [[ "$body" == "ok" ]]; then
      echo "relay TLS loopback ok"
      exit 0
    fi
    echo "unexpected /healthz response: $body" >&2
    exit 1
  fi
  sleep 0.1
done

cat "$tmp/relay.log" >&2
exit 1
