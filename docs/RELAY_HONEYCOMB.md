# Relay Honeycomb Evidence

This runbook verifies the Section 13 hosted Honeycomb trace receipt gate for
`fieldwork-relay`. It does not prove daemon or mobile telemetry; daemon OTLP is
not part of v1 and mobile crash reporting remains opt-in Sentry only.

The pass condition is a hosted Honeycomb query export containing a sampled
`/v1/version` relay span with only aggregate/static fields: `fieldwork-relay`,
`relay.version`, `/v1/version`, and `service.version`. The evidence must not
contain terminal content, commands, paths, session names, session hashes, daemon
node IDs, push tokens, or raw Honeycomb API keys.

## Scope

- Use the production relay control plane or a release-candidate relay host.
- Configure OTLP with `FIELDWORK_RELAY_OTLP_ENDPOINT=https://api.honeycomb.io/v1/traces`.
- Keep the production default sample rate at `0.01`.
- For a short receipt-test window, `FIELDWORK_RELAY_OTLP_SAMPLE_RATE=1.0` is
  allowed only when the evidence records `receipt_test_window=true` and
  `restored_sample_rate=0.01`.
- Store the Honeycomb key as a relay-only systemd credential named
  `honeycomb-api-key`; do not place it in GitHub repository secrets, daemon
  config, mobile config, shell transcripts, or evidence files.
- Do not capture `x-honeycomb-team`, bearer tokens, API keys, or provider
  credential values in the evidence directory.

## Evidence Directory

```sh
export FW_RELAY_HONEYCOMB_DIR="/tmp/fieldwork-relay-honeycomb-$(date +%Y%m%d%H%M%S)"
mkdir -p "$FW_RELAY_HONEYCOMB_DIR"
```

## Relay Configuration

Capture the relay version endpoint:

```sh
curl -fsS https://relay.fieldwork.dev:8443/v1/version \
  | tee "$FW_RELAY_HONEYCOMB_DIR/relay-version.txt"
```

Capture redacted relay OTLP configuration. Include the endpoint, dataset, default
sample rate, actual test sample rate, and credential path or credential source.
Do not print secret values.

```sh
{
  printf 'FIELDWORK_RELAY_OTLP_ENDPOINT=https://api.honeycomb.io/v1/traces\n'
  printf 'production_default_sample_rate=0.01\n'
  printf 'FIELDWORK_RELAY_OTLP_SAMPLE_RATE=0.01\n'
  printf 'FIELDWORK_RELAY_HONEYCOMB_DATASET=fieldwork-relay\n'
  printf 'FIELDWORK_RELAY_HONEYCOMB_API_KEY_PATH=/run/credentials/fieldwork-control-plane.service/honeycomb-api-key\n'
} | tee "$FW_RELAY_HONEYCOMB_DIR/relay-config.txt"
```

If using a temporary receipt-test override, record it explicitly and restore
production sampling before accepting the gate:

```sh
{
  printf 'FIELDWORK_RELAY_OTLP_ENDPOINT=https://api.honeycomb.io/v1/traces\n'
  printf 'production_default_sample_rate=0.01\n'
  printf 'FIELDWORK_RELAY_OTLP_SAMPLE_RATE=1.0\n'
  printf 'receipt_test_window=true\n'
  printf 'restored_sample_rate=0.01\n'
  printf 'FIELDWORK_RELAY_HONEYCOMB_DATASET=fieldwork-relay\n'
  printf 'FIELDWORK_RELAY_HONEYCOMB_API_KEY_PATH=/run/credentials/fieldwork-control-plane.service/honeycomb-api-key\n'
} | tee "$FW_RELAY_HONEYCOMB_DIR/relay-config.txt"
```

Capture systemd credential wiring without printing the key:

```sh
systemctl --user cat fieldwork-control-plane.service \
  | rg 'LoadCredential=honeycomb-api-key|CREDENTIALS_DIRECTORY|FIELDWORK_RELAY_HONEYCOMB_API_KEY_PATH|FIELDWORK_RELAY_OTLP' \
  | tee "$FW_RELAY_HONEYCOMB_DIR/systemd-credentials.txt"
```

## Generate A Test Span

Send enough `/v1/version` requests to overcome 1% sampling, or use the documented
temporary receipt-test window above:

```sh
{
  printf 'request=GET /v1/version\n'
  for i in $(seq 1 500); do
    curl -fsS -o /dev/null -w 'status=%{http_code}\n' \
      https://relay.fieldwork.dev:8443/v1/version
  done
} | tee "$FW_RELAY_HONEYCOMB_DIR/request.txt"
```

Capture relay logs with redacted headers and no secret values:

```sh
journalctl --user -u fieldwork-control-plane.service --since '10 minutes ago' \
  | rg 'fieldwork relay OTLP tracing enabled|relay.version|/v1/version|sample_rate|api.honeycomb.io' \
  | tee "$FW_RELAY_HONEYCOMB_DIR/relay-log.txt"
```

## Export The Honeycomb Query

In Honeycomb, query for the test window:

- `service.name = fieldwork-relay`
- span name `relay.version`
- endpoint `/v1/version`
- `service.version` present

Export the matching rows as JSON into:

```sh
$FW_RELAY_HONEYCOMB_DIR/honeycomb-query.json
```

The JSON can be Honeycomb's native query-result shape or a redacted array of
matching rows. It must contain the hosted receipt fields and no API keys, header
values, terminal data, command names, paths, daemon node IDs, push tokens, or
session hashes.

Verify the evidence:

```sh
pnpm check:relay-honeycomb-evidence -- "$FW_RELAY_HONEYCOMB_DIR"
```

Passing this verifier only proves the relay/Honeycomb hosted trace receipt path.
The live Honeycomb receipt gate remains unchecked until the query export comes
from a real Honeycomb account and relay host.
