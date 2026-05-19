#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const failures = [];

const files = {
  packageJson: JSON.parse(read("package.json")),
  ci: read(".github/workflows/ci.yml"),
  sitePackage: JSON.parse(read("site/package.json")),
  astroConfig: read("site/astro.config.mjs"),
  layout: read("site/src/layouts/BaseLayout.astro"),
  home: read("site/src/pages/index.astro"),
  install: read("site/src/pages/install.astro"),
  architecture: read("site/src/pages/architecture.astro"),
  protocol: read("site/src/pages/protocol.astro"),
  privacy: read("site/src/pages/privacy.astro"),
};

verifyRootScript();
verifySitePackage();
verifyLayout();
verifyHomePage();
verifyInstallPage();
verifyArchitecturePage();
verifyProtocolPage();
verifyPrivacyPage();
verifyNoFutureScopeClaims();
verifyAssets();
verifyCiWiring();

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log("site content contract ok");

function verifyRootScript() {
  if (files.packageJson.scripts?.["check:site-content"] !== "node scripts/verify-site-content.mjs") {
    failures.push("package.json must expose check:site-content");
  }
}

function verifySitePackage() {
  if (files.sitePackage.name !== "@fieldwork/site") {
    failures.push("site/package.json must keep the isolated @fieldwork/site package name");
  }
  if (files.sitePackage.private !== true) {
    failures.push("site/package.json must keep the site package private");
  }
  requireText(files.sitePackage.scripts?.check ?? "", "astro check", "site check script must run astro check");
  requireText(files.sitePackage.scripts?.check ?? "", "astro build", "site check script must build the static site");
  requireText(files.sitePackage.scripts?.build ?? "", "ASTRO_TELEMETRY_DISABLED=1", "site build must disable Astro telemetry");
  requireText(files.astroConfig, 'site: "https://fieldwork.dev"', "Astro config must pin the canonical fieldwork.dev URL");
}

function verifyLayout() {
  for (const nav of [
    'href="/install/"',
    'href="/architecture/"',
    'href="/protocol/"',
    'href="/privacy/"',
    "https://github.com/fieldwork-app/fieldwork",
    "Your terminal sessions, from anywhere.",
  ]) {
    requireText(files.layout, nav, `site layout must include ${nav}`);
  }
  requireText(files.layout, '<meta property="og:type" content="website" />', "site layout must include Open Graph website metadata");
}

function verifyHomePage() {
  for (const phrase of [
    "Open-source terminal handoff for any CLI",
    "Run any CLI on your laptop",
    "Shells, TUIs, REPLs, Claude Code, and Codex",
    "bash", "zsh", "vim", "htop", "python", "node", "lazygit", "claude", "codex",
    "Clients replay from a byte offset",
    "synthetic ANSI snapshot",
    "Claude Code and Codex get first-class waiting-for-input state",
    "unknown CLIs still hand off cleanly",
    "Install `fieldwork`",
    "desktop",
    "Mobile can list, attach, send input, resize, detach, and register push tokens",
    "Push payloads contain only fixed text and opaque hashes",
    "Store screenshots are still a release gate",
    "Protocol",
    "Architecture",
    "Privacy",
  ]) {
    requireText(files.home, phrase, `home page must preserve v1 product claim: ${phrase}`);
  }
  for (const asset of [
    "fieldwork-cli-flow.svg?url",
    "fieldwork-pairing.svg?url",
    "fieldwork-mobile-session.svg?url",
  ]) {
    requireText(files.home, asset, `home page must import ${asset}`);
  }
}

function verifyInstallPage() {
  for (const phrase of [
    "Fieldwork v1 distributes the desktop CLI and daemon through npm only",
    "Mobile apps attach to sessions created on the desktop",
    "they do not create sessions",
    "npm i -g fieldwork",
    "fieldwork daemon install",
    "fieldwork pair",
    "cargo build --workspace",
    "target/debug/fieldwork new bash",
    "target/debug/fieldwork attach",
    "external signing, TestFlight, Play Console, APNs, FCM, and physical-device gates",
  ]) {
    requireText(files.install, phrase, `install page must preserve current install fact: ${phrase}`);
  }
}

function verifyArchitecturePage() {
  for (const phrase of [
    "daemon owns every session",
    "Desktop CLI, iOS, and Android are views into",
    "streams raw PTY bytes",
    "256 KB byte ring",
    "monotonic sequence numbers",
    "`wezterm-term` terminal model",
    "length-prefixed bincode",
    "hardened Unix socket",
    "length-prefixed MessagePack",
    "iroh QUIC",
    "encrypted local `redb` databases",
    "keys held by the OS keychain",
    "private `0700`",
    "database files are `0600`",
    "APNs `.p8`, FCM service-account JSON, and Honeycomb credentials live only on the relay",
  ]) {
    requireText(files.architecture, phrase, `architecture page must preserve current architecture fact: ${phrase}`);
  }
}

function verifyProtocolPage() {
  for (const phrase of [
    "Contract version 1",
    "Every client starts with `Hello`",
    "rejects contract mismatches",
    "bincode",
    "MessagePack",
    "length-prefixed",
    "4-byte big-endian payload length",
    "`AttachSession.last_seen_seq`",
    "warm replay from the PTY byte ring",
    "daemon-rendered ANSI snapshot",
    "Pair tokens are 32 random bytes",
    "base32 encoded",
    "single-use",
    "expire after 10 minutes",
    "desktop must approve",
    "Mobile clients can list, attach, input, resize, detach, ping, and register push tokens",
    "Create and kill operations are rejected",
  ]) {
    requireText(files.protocol, phrase, `protocol page must preserve protocol fact: ${phrase}`);
  }
}

function verifyPrivacyPage() {
  for (const phrase of [
    "Terminal content stays out of push and relay control planes",
    "terminal bytes move only between",
    "paired clients over encrypted transport",
    "fixed generic copy and opaque hashes",
    "PTY input and output stay on the host unless a paired iroh client attaches",
    "short-lived and single-use",
    "paired iroh node identity",
    "revoked from the desktop CLI",
    "Push payloads contain only event type, fixed alert text, and opaque hashes",
    "never include terminal content, commands, paths, session names, or `last_line`",
    "Daemon telemetry is off by default",
    "Mobile crash reporting is opt-in",
    "disables default PII and trace sampling",
    "encrypted locally by default",
    "rejects symlinked stores",
  ]) {
    requireText(files.privacy, phrase, `privacy page must preserve privacy fact: ${phrase}`);
  }
}

function verifyNoFutureScopeClaims() {
  const combined = [
    files.home,
    files.install,
    files.architecture,
    files.protocol,
    files.privacy,
  ].join("\n");

  for (const forbidden of [
    "Homebrew",
    "curl | sh",
    "cargo install",
    "self-update",
    "Live Activities",
    "Apple Watch",
    "voice input",
    "teams",
    "billing",
    "cloud sandbox",
    "native Windows",
    "OpenCode gets first-class push",
    "Aider gets first-class push",
  ]) {
    rejectText(combined, forbidden, `site content must not advertise out-of-scope v1 surface: ${forbidden}`);
  }
}

function verifyAssets() {
  for (const rel of [
    "docs/assets/fieldwork-cli-flow.svg",
    "docs/assets/fieldwork-pairing.svg",
    "docs/assets/fieldwork-mobile-session.svg",
  ]) {
    const absolute = path.join(root, rel);
    if (!fs.existsSync(absolute)) {
      failures.push(`${rel} is missing`);
      continue;
    }
    if (fs.statSync(absolute).size < 500) {
      failures.push(`${rel} is unexpectedly small`);
    }
  }
}

function verifyCiWiring() {
  requireText(files.ci, "node scripts/verify-site-content.mjs", "CI must run the site content verifier");
}

function read(rel) {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

function requireText(text, needle, message) {
  if (!text.includes(needle)) {
    failures.push(message);
  }
}

function rejectText(text, needle, message) {
  if (text.includes(needle)) {
    failures.push(message);
  }
}
