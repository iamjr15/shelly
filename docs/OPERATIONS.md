# Operations

This document covers the current production-facing operations surface after the
local verifier harness was removed. Operator-owned work is handled manually and
through CI workflows, not through repository capture scripts.

## npm Release

The publish flow is npm-only for desktop.

1. Build Rust release artifacts with `.github/workflows/release-rust.yml`.
2. Run `.github/workflows/release-npm.yml` with `NPM_TOKEN` configured.
3. The workflow downloads release archives, checks `.sha256` files with
   `shasum`, stages platform package binaries with
   `scripts/prepare-npm-artifacts.mjs`, and publishes through
   `scripts/publish-npm-packages.mjs`.

The publish script always publishes in dependency order:

1. `shellykit-darwin-arm64`
2. `shellykit-darwin-x64`
3. `shellykit-linux-arm64`
4. `shellykit-linux-x64`
5. `shellykit`

Use npm registry UI/API checks after publish to confirm the latest dist-tags and
provenance visibility.

## Relay Deployment

The relay infrastructure scaffold lives under `infra/lightsail` and
`infra/relay/ansible`. The active Mumbai relay runs on AWS Lightsail as
`dock-relay` with static IP `3.7.138.203`. Production relay deployment still
needs operator-owned DNS/TLS and relay-only credentials.

The committed Ansible defaults run the host in a pre-production posture:

- iroh relay is HTTP-only on port 80 until DNS points at `dock-relay` and ACME
  can issue certificates.
- the control plane listens on port 8443 without mandatory TLS credentials until
  `shelly_relay_control_require_tls` and the cert/key credential paths are
  set.
- FCM, APNs, and Honeycomb credentials are optional; missing files disable those
  integrations instead of preventing the relay from starting.

`.github/workflows/deploy-relay.yml` deploys the relay automatically from
`main` when relay code or relay infrastructure files change. It builds
`shelly-relay` on an Ubuntu x64 runner, temporarily opens Lightsail SSH to
that runner's public IPv4 address, runs the Ansible playbook, and closes the
temporary SSH rule in an `always()` cleanup step.

The workflow expects this GitHub repository variable:

- `RELAY_AWS_ROLE_ARN` (`arn:aws:iam::526867055655:role/GitHubActionsDockRelayDeploy`)

The workflow expects these GitHub Secrets:

- `RELAY_SSH_KEY`
- `RELAY_KNOWN_HOSTS` (ssh-keyscan output for the relay hosts; generate with
  `ssh-keyscan -H <relay-host> 2>/dev/null`)

`RELAY_SSH_KEY` is a dedicated deploy key installed in `ubuntu`'s
`authorized_keys` on `dock-relay`; it is not a personal operator SSH key. The
AWS role is assumed through GitHub OIDC and is limited to reading Lightsail
instance state plus opening/closing the temporary SSH ingress rule.

The AWS OIDC trust accepts only the GitHub Actions subject for the
`relay-production` environment, and that environment has a deployment branch
policy allowing only `main`. This keeps AWS role assumption tied to the
release environment instead of any arbitrary workflow or branch in the
repository.

Lightsail host creation is direct Terraform. Run `terraform init` and
`terraform apply` in `infra/lightsail/terraform` with a local, ignored tfvars
file containing operator SSH CIDRs. Existing AWS CLI-created resources must be
imported into Terraform state before the first apply.

For local infrastructure validation:

```sh
scripts/check-infra-terraform.sh
scripts/smoke-relay-tls-loopback.sh
node scripts/smoke-relay-otlp-loopback.mjs
```

Relay-only secrets must stay on the relay host:

- FCM service-account JSON
- Honeycomb API key
- TLS private key

Do not commit those files or copy them into CLI, daemon, npm package, mobile, or
site directories.

When DNS is cut over to `dock-relay`, switch
`shelly_iroh_relay_http_only` to `false`, set
`shelly_iroh_relay_hostname` and `shelly_iroh_relay_contact_email`, and
enable Terraform's `enable_iroh_tls_ports` variable before opening 443/tcp and
7842/udp. For the control plane, install the TLS cert/key under
`/etc/shelly/secrets/`, set their Ansible paths, and set
`shelly_relay_control_require_tls` to `true`.

APNs credentials and environment are only configured when the deferred iOS
client resumes; Ansible omits the APNs env vars and `apns.p8` credential while
`shelly_relay_apns_team_id` is empty.

`SHELLY_RELAY_TRUST_FORWARDED_FOR` is off by default, so rate-limit identity
uses the socket peer address. Set it only when the relay sits behind a trusted
proxy that overwrites `X-Forwarded-For`.

## Android Release

`.github/workflows/release-android.yml` expects these GitHub Secrets:

- `ANDROID_GOOGLE_SERVICES_JSON`
- `ANDROID_KEYSTORE_BASE64`
- `ANDROID_KEYSTORE_PROPERTIES`
- `SHELLY_RELAY_CONTROL_URL`
- `PLAY_SERVICE_ACCOUNT_JSON`

The workflow builds mobile Rust libraries, decodes Firebase/signing config,
builds the release AAB, verifies the JAR signature with `jarsigner`, uploads to
Play internal track, and removes generated Firebase/signing files in cleanup.

Physical Android testing remains manual. Use direct `adb` screenshots, UI dumps,
logcat, crash-buffer checks, and app behavior checks on the signed release build.

## Site Deployment

The site deploy workflow needs:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

Local commands:

```sh
pnpm --dir site install --ignore-workspace --frozen-lockfile
pnpm check:site
pnpm build:site
```

Domain ownership and Cloudflare project setup are operator-owned.

## Manual Release Checklist

Before a public v1 release, manually confirm:

- npm package ownership and token freshness.
- GitHub Release archives, checksums, and provenance bundles are present.
- macOS npm-installed binaries launch without quarantine issues.
- Relay host uses production DNS/TLS and relay-only credentials.
- Android release AAB is signed with the production keystore.
- Play internal upload succeeds.
- Store privacy labels match `docs/STORE_PRIVACY.md`.
- Physical Android testing has been done on signed release builds.
