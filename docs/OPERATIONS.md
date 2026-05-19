# Operations Runbook

This runbook covers v1 production operations for the Fieldwork relay, release
credentials, and incident response. It is intentionally scoped to v1: npm
desktop distribution, hosted relay push, TestFlight/App Store, and Play Store
release paths. Self-hostable relay Docker images, teams, billing, and cloud
sandboxes are deferred in `FUTURE.md`.

## Production Prerequisites

Before tagging v1.0.0, the operator must have:

- Operator-controlled npm `fieldwork` meta package, publish rights for the four
  platform child packages, and an `NPM_TOKEN` that can publish all five packages.
- GitHub repository secrets for macOS signing/notarization, npm provenance,
  iOS TestFlight upload, Android release signing, Play upload, relay deploy,
  Cloudflare Pages, and Sentry.
- Two Oracle ARM A1 relay hosts in different regions, DNS records for
  `relay.fieldwork.dev`, and SSH host keys pinned by the GitHub Actions runner.
- Relay-only APNs `.p8`, FCM service-account JSON, and Honeycomb API key
  installed on the relay hosts under `/etc/fieldwork/secrets/`.
- Physical iOS and Android devices for the Section 13 smoke tests.

The public iroh relay function can continue running during push-gateway
maintenance. Push delivery is the only v1 feature that requires the relay HTTP
control plane and provider credentials.

## Relay Deploy

Provision each Oracle region with the credential-free Terraform scaffold first:

```sh
infra/oracle/provision-region.sh infra/oracle/terraform/mumbai.tfvars
terraform -chdir=infra/oracle/terraform output -raw ansible_inventory_line
```

Keep tfvars and state local or in the operator's secured state backend; they are
ignored by git. Paste the real output hosts into
`infra/relay/ansible/inventory.ini` before running the deploy workflow.

`deploy-relay.yml` downloads `fieldwork-linux-arm64.tar.gz` plus its SHA-256 and
cosign bundle, then verifies the archive checksum, DSSE/SLSA bundle digest, and
cosign signature with:

```sh
FIELDWORK_RELEASE_PLATFORMS=linux-arm64 \
FIELDWORK_VERIFY_COSIGN_SIGNATURE=1 \
FIELDWORK_COSIGN_IDENTITY_REGEXP='^https://github.com/fieldwork-app/fieldwork/\.github/workflows/release-rust\.yml@refs/tags/v.*$' \
pnpm check:release-artifacts
```

It then extracts `fieldwork-relay`, checks that the binary is executable, writes
the `RELAY_SSH_KEY` with mode `0600`, refuses to deploy against the placeholder
inventory, and runs the Ansible playbook.

The playbook installs one binary that runs two systemd units:

- `fieldwork-control-plane.service`: HTTPS push/version control plane on
  `FIELDWORK_RELAY_ADDR`, with SQLite state under `FIELDWORK_RELAY_DB_PATH` and
  relay-only control-plane TLS/APNs/FCM/Honeycomb secrets through systemd
  `LoadCredential`.
- `fieldwork-iroh-relay.service`: iroh relay fallback on `:443`, `:80`, and
  `:7842`, with aggregate metrics on `127.0.0.1:9091`.

After deploy, verify:

```sh
systemctl status fieldwork-control-plane.service
systemctl status fieldwork-iroh-relay.service
curl -fsS https://relay.fieldwork.dev:8443/v1/version
```

Then run the physical push smoke: pair fresh devices, register APNs/FCM tokens,
trigger Claude or Codex `AwaitingInput`, and confirm 10/10 generic
notifications with correct tap-through.

## Quarterly Credential Rotation

Rotate relay provider credentials at least quarterly and immediately after any
suspected relay host, CI, or provider-console compromise. Rotate one provider at
a time so failures are attributable.

### APNs `.p8`

1. In Apple Developer, create a new APNs auth key for the Fieldwork team.
2. Copy the new `.p8` to each relay host as
   `/etc/fieldwork/secrets/apns.p8.new`, owned by `root:root`, mode `0400`.
3. Update `fieldwork_relay_apns_key_id` in the Ansible inventory or GitHub
   environment secret to the new key id.
4. Atomically move `apns.p8.new` to `apns.p8` on each host.
5. Run `deploy-relay.yml` or restart `fieldwork-control-plane.service`.
6. Verify iOS push delivery with a physical device and inspect that the payload
   still contains only fixed alert copy plus opaque hashes.
7. Revoke the old APNs key in Apple Developer after both relay regions pass.

### FCM Service Account JSON

1. In Google Cloud, create a new key for the relay FCM service account, or create
   a replacement service account with only the permissions required for FCM HTTP
   v1 send.
2. Copy the JSON to each relay host as
   `/etc/fieldwork/secrets/fcm-service-account.json.new`, owned by `root:root`,
   mode `0400`.
3. Atomically move it to `fcm-service-account.json`.
4. Run `deploy-relay.yml` or restart `fieldwork-control-plane.service`.
5. Verify Android push delivery with a physical device and inspect that the
   payload still contains only fixed alert copy plus opaque hashes.
6. Delete the old JSON key from Google Cloud after both relay regions pass.

### Honeycomb API Key

1. Create a new Honeycomb API key scoped to OTLP trace ingest for the relay
   dataset.
2. Copy it to `/etc/fieldwork/secrets/honeycomb-api-key.new`, owned by
   `root:root`, mode `0400`.
3. Atomically move it to `honeycomb-api-key`.
4. Restart `fieldwork-control-plane.service`.
5. Verify receipt of a sampled `/v1/version` trace in Honeycomb.
6. Revoke the old Honeycomb key.

### Deploy SSH Key

1. Add a new deploy public key to both relay hosts for the deployment user.
2. Replace `RELAY_SSH_KEY` in GitHub Actions secrets.
3. Run `deploy-relay.yml` against a no-op or current release tag.
4. Remove the old public key from both relay hosts.

## Incident Response

For suspected relay push-gateway compromise:

1. Stop provider push immediately:

   ```sh
   sudo systemctl stop fieldwork-control-plane.service
   ```

   Leave `fieldwork-iroh-relay.service` running if the iroh fallback itself is
   not implicated.

2. Rotate APNs, FCM, Honeycomb, and deploy SSH credentials using the procedures
   above.
3. Snapshot `/var/lib/fieldwork/relay.db` for forensics, then remove registered
   push-token rows if token exposure is suspected. Daemons will re-register
   tokens when paired devices reconnect.
4. Redeploy the relay from a freshly verified GitHub Release artifact.
5. Run provider push tests and inspect payloads before re-enabling production
   traffic.
6. Publish a security advisory if push tokens, daemon public keys, replay
   nonces, or relay logs may have been exposed.

For npm, signing, or mobile-store credential compromise, revoke the affected
provider credential first, rotate the GitHub secret, invalidate any pending
release run, and retag only after the relevant release workflow passes from a
fresh checkout.

## Data Deletion

Users remove lost or retired devices with:

```sh
fieldwork devices remove <name>
```

That removes the daemon-side device record and enqueue/registers relay token
unregistration when relay push is configured. If a user requests relay-side
push-token deletion and the daemon is unavailable, delete the token ownership row
from the relay SQLite store after verifying the request through the published
support channel.

## Local Verification

Run these checks after touching operations, deploy, release, push, or privacy
files:

```sh
node scripts/verify-secret-boundaries.mjs
node scripts/verify-infra-scaffold.mjs
pnpm check:infra-terraform
scripts/smoke-relay-tls-loopback.sh
node scripts/test-release-artifacts.mjs
node scripts/test-npm-publish-plan.mjs
node scripts/test-bun-install.mjs
pnpm check:release-workflows
pnpm check:relay-provider-clients
pnpm check:security-model
pnpm check:mobile-privacy
pnpm check:store-privacy
pnpm check:telemetry-privacy
pnpm check:v1-boundary
pnpm check:community-scaffold
pnpm check:site
```

Provider delivery, hosted Honeycomb receipt, signed mobile releases, and
physical-device reconnect tests remain external Section 13 gates.
