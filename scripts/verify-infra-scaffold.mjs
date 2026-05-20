#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const failures = [];

const files = {
  versions: read("infra/oracle/terraform/versions.tf"),
  main: read("infra/oracle/terraform/main.tf"),
  variables: read("infra/oracle/terraform/variables.tf"),
  outputs: read("infra/oracle/terraform/outputs.tf"),
  terraformLock: read("infra/oracle/terraform/.terraform.lock.hcl"),
  readme: read("infra/oracle/README.md"),
  operations: read("docs/OPERATIONS.md"),
  terraformCheck: read("scripts/check-infra-terraform.sh"),
  provision: read("infra/oracle/provision-region.sh"),
  gitignore: read(".gitignore"),
  ansibleVars: read("infra/relay/ansible/group_vars/all/main.yml"),
  controlService: read("infra/relay/ansible/templates/fieldwork-control-plane.service.j2"),
  deployWorkflow: read(".github/workflows/deploy-relay.yml"),
  relayCargo: read("crates/relay/Cargo.toml"),
  relayLib: read("crates/relay/src/lib.rs"),
  relayMain: read("crates/relay/src/main.rs"),
  relayTlsSmoke: read("scripts/smoke-relay-tls-loopback.sh"),
};

requireText(files.versions, 'source  = "oracle/oci"', "Oracle Terraform scaffold must use the official OCI provider");
requireText(files.versions, 'version = "~> 8.12"', "OCI provider version must stay pinned to a reviewed major/minor range");
requireText(files.terraformLock, 'provider "registry.terraform.io/oracle/oci"', "Oracle Terraform provider lockfile must be committed");
requireText(files.terraformLock, 'version     = "8.14.0"', "Oracle Terraform provider lockfile must pin the reviewed provider version");
requireText(files.terraformLock, "h1:", "Oracle Terraform provider lockfile must contain the signed provider hash");
requireText(files.main, 'data "oci_identity_availability_domains"', "Terraform must discover OCI availability domains");
requireText(files.main, 'data "oci_core_images"', "Terraform must select or allow overriding an Oracle Linux platform image");

for (const resource of [
  'resource "oci_core_vcn"',
  'resource "oci_core_internet_gateway"',
  'resource "oci_core_route_table"',
  'resource "oci_core_security_list"',
  'resource "oci_core_subnet"',
  'resource "oci_core_instance"',
]) {
  requireText(files.main, resource, `Terraform scaffold is missing ${resource}`);
}

for (const port of ["22", "80", "443", "8443", "7842"]) {
  requireText(files.main, `= ${port}`, `Terraform security list must account for port ${port}`);
}

requireText(files.main, 'protocol    = "17"', "Terraform must allow iroh QUIC relay traffic over UDP");
requireText(files.main, "ssh_allowed_cidrs", "SSH ingress must be controlled by explicit CIDR input");
requireText(files.main, "assign_public_ip = true", "Relay host must receive a public IP for DNS and Ansible");
requireText(files.main, "are_legacy_imds_endpoints_disabled = true", "Relay host must disable legacy IMDS endpoints");
requireText(files.main, "ssh_authorized_keys", "Relay host must install only caller-supplied SSH public keys");
requireText(files.variables, 'default     = "VM.Standard.A1.Flex"', "Terraform must default to Oracle ARM A1 flex");
requireText(files.outputs, "ansible_inventory_line", "Terraform must output an Ansible inventory handoff line");

requireText(files.readme, "stores no Oracle credentials", "Oracle README must document that credentials are not committed");
requireText(files.readme, "committed Terraform provider lockfile pins the signed `oracle/oci`", "Oracle README must document the committed provider lockfile");
requireText(files.readme, "generated `.terraform/` caches and\n  all state/tfvars remain ignored", "Oracle README must document ignored Terraform caches and state");
requireText(files.readme, "infra/relay/ansible/inventory.ini", "Oracle README must document Ansible inventory handoff");
requireText(files.readme, "FIELDWORK_ORACLE_RETRY_ATTEMPTS", "Oracle README must document capacity retry controls");
requireText(files.provision, "terraform init", "Oracle provision wrapper must initialize Terraform");
requireText(files.provision, "terraform apply", "Oracle provision wrapper must apply Terraform");
requireText(files.provision, "FIELDWORK_ORACLE_RETRY_ATTEMPTS", "Oracle provision wrapper must support retry attempts");
requireExecutable("infra/oracle/provision-region.sh");
requireText(files.terraformCheck, 'TF_PLUGIN_CACHE_DIR', "Terraform validation script must use a plugin cache outside the generated working directory");
requireText(files.terraformCheck, 'mkdir -p "$TF_PLUGIN_CACHE_DIR"', "Terraform validation script must create the plugin cache before init");
requireText(files.terraformCheck, 'trap cleanup EXIT', "Terraform validation script must clean generated .terraform working directory");
requireText(files.terraformCheck, 'terraform fmt -check -recursive "$terraform_dir"', "Terraform validation script must check formatting");
requireText(files.terraformCheck, 'terraform -chdir="$terraform_dir" init -backend=false', "Terraform validation script must initialize without remote state");
requireText(files.terraformCheck, 'terraform -chdir="$terraform_dir" validate', "Terraform validation script must validate the Oracle scaffold");
requireExecutable("scripts/check-infra-terraform.sh");

for (const ignored of [
  "infra/oracle/terraform/.terraform/",
  "infra/oracle/terraform/*.tfstate",
  "infra/oracle/terraform/*.tfvars",
]) {
  requireText(files.gitignore, ignored, `.gitignore must keep ${ignored} out of git`);
}

for (const secretPath of [
  "fieldwork_relay_control_tls_cert",
  "fieldwork_relay_control_tls_key",
  "fieldwork_relay_apns_credential",
  "fieldwork_relay_fcm_credential",
  "fieldwork_relay_honeycomb_credential",
]) {
  requireText(files.ansibleVars, secretPath, `Ansible relay vars must retain ${secretPath}`);
}
requireText(files.controlService, "Environment=FIELDWORK_RELAY_REQUIRE_TLS=true", "production relay control plane must require TLS");
requireText(files.controlService, "LoadCredential=control-plane.crt", "control-plane TLS cert must be a systemd credential");
requireText(files.controlService, "LoadCredential=control-plane.key", "control-plane TLS key must be a systemd credential");
requireText(files.relayCargo, "axum-server.workspace = true", "relay crate must depend on axum-server for Rustls serving");
requireText(files.relayLib, "serve_tls_with_metrics", "relay library must expose TLS control-plane serving");
requireText(files.relayLib, "rustls::crypto::ring::default_provider().install_default()", "relay TLS serving must install an explicit Rustls crypto provider");
requireText(files.relayLib, "RustlsConfig::from_pem_file", "relay TLS serving must load PEM cert/key files");
requireText(files.relayLib, "axum_server::bind_rustls", "relay control plane must use Rustls when TLS files are configured");
requireText(files.relayMain, "FIELDWORK_RELAY_REQUIRE_TLS", "relay binary must support a fail-closed production TLS requirement");
requireText(files.relayMain, "CREDENTIALS_DIRECTORY", "relay binary must discover systemd credential files");
requireText(files.relayTlsSmoke, 'relay_binary="${FIELDWORK_RELAY_BINARY:-}"', "relay TLS smoke must support an explicit relay binary");
requireText(files.relayTlsSmoke, "target/release/fieldwork-relay", "relay TLS smoke must prefer the existing release binary before debug builds");
requireText(files.deployWorkflow, "must contain at least one relay host", "Relay deploy workflow must reject placeholder inventory");
requireText(
  files.operations,
  "FIELDWORK_COSIGN_IDENTITY_REGEXP='^https://github.com/fieldwork-app/fieldwork/\\.github/workflows/release-rust\\.yml@refs/tags/v.*$'",
  "Operations runbook must pin cosign release verification to the fieldwork-app/fieldwork release-rust identity",
);
const staleGithubIdentity = "github.com/fieldwork/" + "fieldwork/";
if (files.operations.includes(staleGithubIdentity)) {
  failures.push("Operations runbook must not use the stale fieldwork/fieldwork GitHub identity");
}

for (const prerequisite of [
  "Operator-controlled npm `fieldwork` meta package",
  "publish rights for the four\n  platform child packages",
  "GitHub repository secrets for macOS signing/notarization",
  "Two Oracle ARM A1 relay hosts in different regions",
  "Relay-only APNs `.p8`, FCM service-account JSON, and Honeycomb API key",
  "Physical iOS and Android devices for the Section 13 smoke tests",
]) {
  requireText(files.operations, prerequisite, `Operations runbook prerequisites must include ${prerequisite}`);
}

for (const handoff of [
  "## Release Gate Handoff",
  "should not run\nlive reservation, publish, domain, provider-console, or account checks",
  "already-owned unscoped `fieldwork` meta package",
  "`fieldwork-darwin-arm64`, `fieldwork-darwin-x64`,",
  "`fieldwork-linux-arm64`, and `fieldwork-linux-x64`",
  "children publish first and `fieldwork`\n  publishes last with provenance",
  "Appendix B account and reservation work remains\n  outside agent ownership",
  "domain `fieldwork.dev`, GitHub org `fieldwork-app`,\n  GitHub repo `fieldwork`, `@fieldworkdev`",
  "Oracle Cloud capacity, Apple\n  Developer, Sentry, Honeycomb, and launch-calendar commitments",
  "signed/notarized Darwin artifacts, Linux archives,\n  SHA-256 files, and Sigstore attestations",
  "verify HTTPS `/v1/version`, iroh relay\n  fallback, sampled Honeycomb traces, and 10/10 generic push delivery",
  "prepared App Store privacy nutrition labels and\n  Play Data safety answers",
  "iOS implementation work is\n  otherwise paused until the team resumes that track",
  "QR pairing,\n  session list subscription, terminal attach/input, reconnect/replay after\n  network changes",
  "biometric launch/stale-input\n  gates",
  "use `docs/LIVE_TESTING.md` for\n  the first operator-assisted Android-only terminal handoff run",
  "same\n  daemon-owned PTY session",
  "no screen mirroring",
  "no arbitrary Terminal.app/iTerm\n  takeover",
  "direct `adb` screenshot/UI/log/crash evidence",
  "pnpm check:local-release -- --with-artifacts --with-runtime",
  "node scripts/verify-release-audit.mjs --list-unchecked",
  "Only check the external boxes in `PLAN.md` after the matching hosted account,\nprovider, signed-artifact, physical-device, or operator-reservation evidence\nexists, and keep `docs/RELEASE_AUDIT.md` synchronized with the evidence",
]) {
  requireText(files.operations, handoff, `Operations runbook release-gate handoff must include ${handoff}`);
}

for (const deployCheck of [
  "systemctl status fieldwork-control-plane.service",
  "systemctl status fieldwork-iroh-relay.service",
  "curl -fsS https://relay.fieldwork.dev:8443/v1/version",
  "confirm 10/10 generic\nnotifications",
]) {
  requireText(files.operations, deployCheck, `Operations runbook deploy verification must include ${deployCheck}`);
}

for (const rotationSection of [
  "### APNs `.p8`",
  "### FCM Service Account JSON",
  "### Honeycomb API Key",
  "### Deploy SSH Key",
]) {
  requireText(files.operations, rotationSection, `Operations runbook must include rotation section ${rotationSection}`);
}

for (const rotationStep of [
  "mode `0400`",
  "Atomically move",
  "Verify iOS push delivery with a physical device",
  "Verify Android push delivery with a physical device",
  "Verify receipt of a sampled `/v1/version` trace in Honeycomb",
  "Remove the old public key from both relay hosts",
]) {
  requireText(files.operations, rotationStep, `Operations runbook rotation steps must include ${rotationStep}`);
}

for (const incidentStep of [
  "sudo systemctl stop fieldwork-control-plane.service",
  "Leave `fieldwork-iroh-relay.service` running",
  "Rotate APNs, FCM, Honeycomb, and deploy SSH credentials",
  "Snapshot `/var/lib/fieldwork/relay.db` for forensics",
  "remove registered\n   push-token rows",
  "Redeploy the relay from a freshly verified GitHub Release artifact",
  "Publish a security advisory",
]) {
  requireText(files.operations, incidentStep, `Operations runbook incident response must include ${incidentStep}`);
}

for (const deletionStep of [
  "fieldwork devices remove <name>",
  "daemon-side device record",
  "relay token\nunregistration",
  "delete the token ownership row\nfrom the relay SQLite store",
]) {
  requireText(files.operations, deletionStep, `Operations runbook data-deletion flow must include ${deletionStep}`);
}

for (const command of [
  "node scripts/verify-secret-boundaries.mjs",
  "node scripts/verify-infra-scaffold.mjs",
  "pnpm check:docs-sync",
  "pnpm check:release-audit",
  "pnpm check:infra-terraform",
  "scripts/smoke-relay-tls-loopback.sh",
  "node scripts/test-release-artifacts.mjs",
  "node scripts/test-npm-publish-plan.mjs",
  "node scripts/test-bun-install.mjs",
  "pnpm check:local-release",
  "pnpm check:release-workflows",
  "pnpm check:relay-provider-clients",
  "pnpm check:security-model",
  "pnpm check:mobile-privacy",
  "pnpm check:store-privacy",
  "pnpm check:telemetry-privacy",
  "pnpm check:v1-boundary",
  "pnpm check:community-scaffold",
  "pnpm check:site",
]) {
  requireText(files.operations, command, `Operations runbook local verification must include ${command}`);
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log("infra scaffold ok");

function read(rel) {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

function requireText(text, needle, message) {
  if (!text.includes(needle)) {
    failures.push(message);
  }
}

function requireExecutable(rel) {
  const mode = fs.statSync(path.join(root, rel)).mode;
  if ((mode & 0o111) === 0) {
    failures.push(`${rel} must be executable`);
  }
}
