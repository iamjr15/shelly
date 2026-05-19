#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const failures = [];

const files = {
  security: read("docs/SECURITY.md"),
  operations: read("docs/OPERATIONS.md"),
  releaseAudit: read("docs/RELEASE_AUDIT.md"),
  plan: read("PLAN.md"),
  privacy: read("docs/PRIVACY.md"),
  protocol: read("docs/PROTOCOL.md"),
  architecture: read("docs/ARCHITECTURE.md"),
  packageJson: read("package.json"),
  ci: read(".github/workflows/ci.yml"),
};

verifySecurityDoc(files.security);
verifyCrossDocAnchors(files);
verifyWiring(files);

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log("security model contract ok");

function verifySecurityDoc(text) {
  requireText(text, "# Security Model", "docs/SECURITY.md must be the security model document");
  requireText(text, "v1 product security model", "docs/SECURITY.md must scope itself to v1");
  requireText(text, "root [`SECURITY.md`](../SECURITY.md)", "docs/SECURITY.md must link vulnerability reporting to the root SECURITY.md");

  for (const heading of [
    "## Trust Boundaries",
    "## Local IPC",
    "## Pairing And Device Auth",
    "## At-Rest Storage",
    "## Terminal Privacy",
    "## Relay Controls",
    "## Mobile Runtime Gates",
    "## Verification",
  ]) {
    requireText(text, heading, `docs/SECURITY.md is missing section ${heading}`);
  }

  for (const trustBoundary of [
    "**Local desktop CLI**",
    "**Daemon**",
    "**Paired mobile devices**",
    "**Relay**",
  ]) {
    requireText(text, trustBoundary, `docs/SECURITY.md must define trust zone ${trustBoundary}`);
  }

  for (const phrase of [
    "trusted to create and kill sessions",
    "owns PTYs, device registry, scrollback, pairing approval, local\n  state inference, relay-signing keys, and push-token registration dispatch",
    "long-lived Ed25519/iroh identity",
    "They can list, subscribe, attach, send input, resize, detach,\n  and register/unregister push tokens",
    "They cannot create sessions, kill\n  sessions, or specify commands",
    "sees daemon node IDs, daemon relay public keys, push tokens, opaque\n  session hashes, source IPs, aggregate metrics, and provider delivery status",
    "must never receive terminal bytes, command lines, paths, plaintext session\n  names, QR pair tokens, or local scrollback",
  ]) {
    requireNormalizedText(text, phrase, `docs/SECURITY.md trust boundary is missing: ${phrase}`);
  }

  for (const phrase of [
    "Parent directory is owned by the user, mode `0700`, and rejected if it is a\n  symlink",
    "Socket file mode is `0600`",
    "length-prefixed bincode",
    "rejects `CONTRACT_VERSION` mismatches",
    "`CreateSession` and `KillSession` are authorized only for `LocalCli`",
  ]) {
    requireNormalizedText(text, phrase, `docs/SECURITY.md local IPC model is missing: ${phrase}`);
  }

  for (const phrase of [
    "Pair tokens are 32 random bytes, base32 encoded, 10-minute TTL, and single\n  use",
    "desktop must explicitly approve the request",
    "Approved devices authenticate with long-lived Ed25519/iroh keys",
    "Lost devices are revoked through `fieldwork devices remove`",
    "there is no\n  password fallback",
  ]) {
    requireNormalizedText(text, phrase, `docs/SECURITY.md pairing/auth model is missing: ${phrase}`);
  }

  for (const phrase of [
    "encrypted in redb with OS-keychain-held keys",
    "Device registry rows\nuse hashed row keys",
    "raw device node IDs and push tokens live only inside the\nencrypted row payload",
    "fieldwork settings scrollback-encryption off",
    "applies after daemon restart",
    "future local persistence\nplaintext",
    "this-device-only Keychain items with data-protection accessibility",
    "encrypted, backup-excluded preferences",
  ]) {
    requireNormalizedText(text, phrase, `docs/SECURITY.md at-rest storage model is missing: ${phrase}`);
  }

  for (const phrase of [
    "streams raw PTY bytes only to authenticated attached clients",
    "local wezterm-term model for state inference and synthetic ANSI snapshots",
    "does not send cell-grid diffs",
    "Push payloads contain only fixed enum-derived copy and opaque hashes",
    "rejects user-content fields such as terminal content, command lines,\npaths, session names, or `last_line`",
  ]) {
    requireNormalizedText(text, phrase, `docs/SECURITY.md terminal privacy model is missing: ${phrase}`);
  }

  for (const phrase of [
    "Daemon public-key registration",
    "Ed25519 request signatures",
    "Nonce replay protection",
    "Timestamp skew checks",
    "Push-token ownership binding to the registering daemon",
    "garde request validation",
    "Per-daemon rate limiting",
    "Relay-only APNs `.p8`, FCM service-account JSON, and Honeycomb credentials",
    "Relay telemetry is aggregate-only",
    "Honeycomb credentials are loaded only by the\nrelay service through credential paths",
    "Reqwest rustls native-root feature",
    "rejects a regression to WebPKI-only roots",
    "NPM publish credentials (`NPM_TOKEN` / `NODE_AUTH_TOKEN`) live only in the\noperator environment or GitHub Secrets",
    "Repository `.npmrc` files and literal\nnpm token strings are rejected by `pnpm check:secret-boundaries`",
    "built non-relay artifacts for npm auth-token patterns",
  ]) {
    requireNormalizedText(text, phrase, `docs/SECURITY.md relay control model is missing: ${phrase}`);
  }

  for (const phrase of [
    "biometric-only\npolicies",
    "FIELDWORK_ANDROID_BIOMETRIC_BYPASS=true",
    "BuildConfig.DEBUG",
    "physical devices for biometric\nprompt behavior, notification tap-through, foreground/background reconnect,\nnetwork-change reconnect, and terminal flood rendering",
  ]) {
    requireNormalizedText(text, phrase, `docs/SECURITY.md mobile runtime gate is missing: ${phrase}`);
  }

  for (const command of [
    "cargo nextest run --workspace",
    "pnpm check:security-model",
    "pnpm check:mobile-privacy",
    "pnpm check:store-privacy",
    "pnpm check:telemetry-privacy",
    "pnpm check:secret-boundaries",
    "pnpm check:relay-provider-clients",
    "pnpm check:v1-boundary",
    "pnpm check:daemon-service",
    "pnpm check:infra-scaffold",
    "scripts/smoke-local-handoff.sh",
  ]) {
    requireText(text, command, `docs/SECURITY.md verification list must include ${command}`);
  }

  for (const blocker of [
    "real provider credentials",
    "signed/notarized\nartifacts",
    "hosted relay deployment",
    "npm provenance visibility",
    "physical\niOS/Android devices",
  ]) {
    requireNormalizedText(text, blocker, `docs/SECURITY.md must preserve external gate wording: ${blocker}`);
  }
}

function verifyCrossDocAnchors(allFiles) {
  requireNormalizedText(allFiles.plan, "mobile clients cannot create or kill sessions", "PLAN.md must retain mobile capability boundary");
  requireText(allFiles.plan, "Push notification payloads", "PLAN.md must retain push payload security table");
  requireText(allFiles.privacy, "Push notification payload privacy rules from `PLAN.md` remain binding", "docs/PRIVACY.md must preserve push privacy binding");
  requireText(allFiles.protocol, "rejected with `Error { Forbidden }` for `CreateSession`, `KillSession`", "docs/PROTOCOL.md must preserve mobile capability rejection");
  requireText(allFiles.architecture, "socket parent is created as `0700`", "docs/ARCHITECTURE.md must preserve Unix socket hardening");
  requireText(allFiles.releaseAudit, "Security model doc", "docs/RELEASE_AUDIT.md must include security model doc evidence");
  requireText(allFiles.releaseAudit, "scripts/verify-security-model.mjs", "docs/RELEASE_AUDIT.md must cite the security model verifier");
}

function verifyWiring(allFiles) {
  const packageJson = JSON.parse(allFiles.packageJson);
  if (packageJson.scripts?.["check:security-model"] !== "node scripts/verify-security-model.mjs") {
    failures.push("package.json must expose pnpm check:security-model");
  }
  requireText(allFiles.ci, "node scripts/verify-security-model.mjs", "CI must run the security model verifier");
  requireText(allFiles.operations, "pnpm check:security-model", "docs/OPERATIONS.md must list pnpm check:security-model");
}

function read(rel) {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

function requireText(text, needle, message) {
  if (!text.includes(needle)) {
    failures.push(message);
  }
}

function requireNormalizedText(text, needle, message) {
  if (!normalize(text).includes(normalize(needle))) {
    failures.push(message);
  }
}

function normalize(text) {
  return text.replace(/\s+/g, " ").trim();
}
