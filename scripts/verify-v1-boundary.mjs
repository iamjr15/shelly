#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const repo = path.resolve(new URL("..", import.meta.url).pathname);
const failures = [];

verifyProtocolCapabilities();
verifyMobileSurface();
verifyMobileCoreRequiredSurface();
verifyFutureOnlyImports();
verifyFutureMobileMediaAndHandoffStayOutOfV1();
verifyFutureOptimizationClaimsStayOutOfV1Contract();
verifyDeferredTargetsStayOutOfV1Contract();
verifyFutureAgentAdaptersStayOutOfV1Code();
verifyFuturePluginProtocolStayOutOfV1Code();
verifyFutureRelaySelfHostingStayOutOfV1();
verifyFutureBoundaryDocumentsDeferredScope();
verifyNpmOnlyDistributionBoundary();
verifyUnscopedNpmPackageBoundary();

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log("v1 boundary ok");

function verifyProtocolCapabilities() {
  const files = [
    "crates/protocol/src/types.rs",
    "crates/protocol/src/snapshots/fieldwork_protocol__tests__server_to_client_wire_round_trips.snap",
    "PLAN.md",
  ];
  for (const rel of files) {
    const text = read(rel);
    rejectPattern(text, /\bpub\s+(voice|watch)\s*:/, `${rel} must not advertise future voice/watch capabilities in v1`);
    rejectPattern(
      text,
      /Capabilities\s*\{[^}\n]*(voice|watch)|\b(voice|watch):\s*false/,
      `${rel} must not retain inactive future voice/watch capability fields`,
    );
  }
}

function verifyMobileSurface() {
  const forbiddenProtocolVariants = /\b(CreateSession|KillSession)\b/;
  const forbiddenMobileApi =
    /\b(createSession|create_session|killSession|kill_session|newSession|new_session|startSession|start_session|runCommand|run_command|commandToRun|command_to_run)\b/;

  for (const file of mobileFiles()) {
    const rel = path.relative(repo, file);
    const text = fs.readFileSync(file, "utf8");
    rejectPattern(
      text,
      /ClientToServerMsg::\s*(CreateSession|KillSession)/,
      `${rel} must not send create/kill session protocol messages from mobile code`,
    );
    rejectPattern(
      text,
      forbiddenProtocolVariants,
      `${rel} must not reference create/kill session protocol variants from mobile code`,
    );
    rejectPattern(
      text,
      forbiddenMobileApi,
      `${rel} must not expose mobile session creation, killing, or command selection`,
    );
    rejectPattern(
      text,
      /(New Session|Start Session|Run Command|Kill Session|Choose Command)/,
      `${rel} must not contain mobile UI copy for creating/killing sessions or choosing commands`,
    );
  }
}

function verifyMobileCoreRequiredSurface() {
  const text = read("crates/mobile-core/src/lib.rs");
  const required = [
    "pub async fn pair_with_qr",
    "pub async fn list_sessions",
    "pub async fn subscribe_sessions",
    "pub async fn attach_session(",
    "pub async fn attach_session_from",
    "pub async fn register_push_token",
    "pub async fn send_input",
    "pub async fn resize",
    "pub async fn detach",
    "pub fn last_seen_seq",
    "ClientToServerMsg::PairWithToken",
    "ClientToServerMsg::ListSessions",
    "ClientToServerMsg::SubscribeSessions",
    "ClientToServerMsg::AttachSession",
    "ClientToServerMsg::RegisterPushToken",
    "ClientToServerMsg::Input",
    "ClientToServerMsg::Resize",
    "ClientToServerMsg::DetachSession",
  ];

  for (const needle of required) {
    requireText(
      text,
      needle,
      `crates/mobile-core/src/lib.rs is missing required v1 mobile surface: ${needle}`,
    );
  }
}

function verifyFutureOnlyImports() {
  const futureOnly = [
    /import\s+ActivityKit/,
    /import\s+WidgetKit/,
    /import\s+Speech/,
    /\bSFSpeechRecognizer\b/,
    /\bWatchConnectivity\b/,
    /\bWKApplication\b/,
    /android\.permission\.RECORD_AUDIO/,
    /\bSpeechRecognizer\b/,
    /\bRecognizerIntent\b/,
    /\bcom\.google\.android\.gms\.wearable\b/,
  ];

  for (const file of mobileFiles()) {
    const rel = path.relative(repo, file);
    const text = fs.readFileSync(file, "utf8");
    for (const pattern of futureOnly) {
      rejectPattern(text, pattern, `${rel} contains future-only voice/live-activity/watch surface: ${pattern}`);
    }
  }
}

function verifyFutureMobileMediaAndHandoffStayOutOfV1() {
  const futureMobileSurface = [
    /import\s+PhotosUI/,
    /\bPHPickerViewController\b/,
    /\bUIImagePickerController\b/,
    /\bPhotosPicker\b/,
    /\bNSItemProvider\b[^\n]*image/i,
    /android\.permission\.READ_MEDIA_(?:IMAGES|VIDEO|VISUAL_USER_SELECTED)/,
    /\bActivityResultContracts\.(?:GetContent|GetMultipleContents|PickVisualMedia)\b/,
    /\bPickVisualMedia\b/,
    /\bandroid\.provider\.MediaStore\b/,
    /import\s+MultipeerConnectivity/,
    /\bMCSession\b/,
    /\bMCPeerID\b/,
    /\bNSUserActivity\b/,
    /\bCoreBluetooth\b/,
    /\bCBCentralManager\b/,
    /\bCBPeripheralManager\b/,
    /\bcom\.google\.android\.gms\.nearby\b/,
    /\bNearby\.get(?:Connections|Messages)Client\b/,
    /\bCompanionDeviceManager\b/,
    /\bResume on (?:iPhone|Android)\b/,
  ];

  for (const file of mobileFiles()) {
    const rel = path.relative(repo, file);
    const text = fs.readFileSync(file, "utf8");
    for (const pattern of futureMobileSurface) {
      rejectPattern(text, pattern, `${rel} contains future-only image paste or cross-device handoff surface: ${pattern}`);
    }
  }

  const protocolInputSurface = [
    /\bInputKind::\s*Image\b/,
    /\bImageInput\b/,
    /\bimage_bytes\b/,
    /\bkind:\s*Image\b/,
  ];
  for (const rel of ["crates/protocol/src/messages.rs", "crates/protocol/src/types.rs"]) {
    const text = read(rel);
    for (const pattern of protocolInputSurface) {
      rejectPattern(text, pattern, `${rel} contains future-only image input protocol surface: ${pattern}`);
    }
  }
}

function verifyDeferredTargetsStayOutOfV1Contract() {
  const files = [
    "PLAN.md",
    "packages/cli/bin/fieldwork",
    "packages/cli/bin/fieldworkd",
    "packages/cli/install.js",
  ];
  const targetPattern = /\b(?:v1\.[1-9]|v2\.0)\b|post-v1|\bdeferred\s+to\b/i;

  for (const rel of files) {
    const text = read(rel);
    rejectPattern(
      text,
      targetPattern,
      `${rel} must not advertise deferred target versions; keep that roadmap in FUTURE.md`,
    );
  }
}

function verifyFutureAgentAdaptersStayOutOfV1Code() {
  const sourceRoots = [
    "crates/daemon/src",
    "crates/protocol/src",
    "crates/mobile-core/src",
  ];
  const futureAgentPattern = /\b(opencode|aider|acp|agent client protocol)\b/i;

  for (const relRoot of sourceRoots) {
    for (const file of walk(path.join(repo, relRoot))) {
      const rel = path.relative(repo, file);
      const text = fs.readFileSync(file, "utf8");
      rejectPattern(
        text,
        futureAgentPattern,
        `${rel} contains future-only agent adapter surface; v1 supports Claude, Codex, and unknown byte-rate inference only`,
      );
    }
  }
}

function verifyFutureOptimizationClaimsStayOutOfV1Contract() {
  const plan = read("PLAN.md");
  rejectPattern(plan, /\bkani-verifier\b/i, "PLAN.md must not list Kani as a v1 model-checker dependency");
  rejectPattern(
    plan,
    /Drop in directly for the daemon's predictive-echo path|we may copy this directly/i,
    "PLAN.md must not describe predictive local echo as a v1 implementation path",
  );
  rejectPattern(
    plan,
    /v1 mobile-core[^.\n]*(?:implements|ships|includes|uses)[^.\n]*predictive local echo/i,
    "PLAN.md must keep mobile-core scoped to exact raw-byte handoff, not predictive local echo",
  );
}

function verifyFuturePluginProtocolStayOutOfV1Code() {
  const sourceRoots = [
    "crates/daemon/src",
    "crates/protocol/src",
    "crates/mobile-core/src",
    "crates/relay/src",
  ];
  const pluginProtocolPattern =
    /\b(PluginProtocol|PluginHost|PluginManifest|PluginRegistry|WasmPlugin|ExtensionApi|ExtensionHost|wasmtime|wasmer|extism|wit_bindgen|wit-bindgen)\b/i;

  for (const relRoot of sourceRoots) {
    for (const file of walk(path.join(repo, relRoot))) {
      const rel = path.relative(repo, file);
      const text = fs.readFileSync(file, "utf8");
      rejectPattern(
        text,
        pluginProtocolPattern,
        `${rel} contains future-only plugin protocol or WASM extension surface`,
      );
    }
  }
}

function verifyFutureRelaySelfHostingStayOutOfV1() {
  for (const file of walkRepo()) {
    const rel = path.relative(repo, file);
    const base = path.basename(file);
    if (
      /^Dockerfile(?:\..*)?$/.test(base) ||
      /^Containerfile(?:\..*)?$/.test(base) ||
      /^docker-compose\.(?:ya?ml)$/.test(base) ||
      /^compose\.(?:ya?ml)$/.test(base) ||
      base === ".dockerignore"
    ) {
      failures.push(`${rel} must not exist; self-hostable relay Docker packaging is deferred to FUTURE.md`);
    }

    if (
      /^\.github\/workflows\/.*docker.*\.ya?ml$/i.test(rel) ||
      /^scripts\/.*(?:docker|container).*$/i.test(rel) ||
      /^infra\/relay\/.*(?:docker|container).*$/i.test(rel)
    ) {
      failures.push(`${rel} must not add v1 Docker/container release surface; self-hostable relay packaging is deferred`);
    }
  }
}

function verifyFutureBoundaryDocumentsDeferredScope() {
  const future = read("FUTURE.md").toLowerCase();
  const required = [
    "opencode",
    "aider",
    "generic acp",
    "voice",
    "live activities",
    "apple watch",
    "multi-host",
    "hosted sandbox",
    "cloud-sandbox",
    "teams",
    "billing",
    "native windows host",
    "native desktop gui",
    "lunel-style ide",
    "foreground-service",
    "homebrew",
    "curl | sh",
    "cargo install",
    "self-update",
    "predictive local echo",
    "kani",
    "self-hostable relay docker image",
    "image paste",
    "plugin protocol",
    "cross-device handoff",
  ];

  for (const item of required) {
    if (!future.includes(item)) {
      failures.push(`FUTURE.md must document deferred/out-of-scope item: ${item}`);
    }
  }
}

function verifyNpmOnlyDistributionBoundary() {
  for (const rel of ["Cargo.toml", "crates/cli/Cargo.toml"]) {
    const text = read(rel);
    rejectPattern(text, /\bself[-_]update\b/i, `${rel} must not depend on a self-updater in v1`);
  }

  const cliMain = read("crates/cli/src/main.rs");
  rejectPattern(
    cliMain,
    /\bUpdate\s*(?:,|\{|\()/,
    "fieldwork CLI must not expose a product self-update subcommand in v1",
  );

  const dist = read("dist-workspace.toml");
  for (const required of ["installers = []", "publish-jobs = []", "install-updater = false"]) {
    if (!dist.includes(required)) {
      failures.push(`dist-workspace.toml must keep cargo-dist archive-only: missing ${required}`);
    }
  }
  rejectPattern(
    dist,
    /\[dist\.homebrew\]|homebrew-tap|x86_64-pc-windows-msvc/i,
    "dist-workspace.toml must not configure Homebrew publishing or native Windows host artifacts in v1",
  );

  for (const scriptName of ["install.sh", "curl-install.sh", "self-update.sh"]) {
    if (fs.existsSync(path.join(repo, scriptName)) || fs.existsSync(path.join(repo, "scripts", scriptName))) {
      failures.push(`${scriptName} must not exist; v1 desktop install/update path is npm only`);
    }
  }
}

function verifyUnscopedNpmPackageBoundary() {
  const files = [
    "PLAN.md",
    "README.md",
    "docs/INSTALL.md",
    "docs/DEVELOPMENT.md",
    "docs/RELEASE_AUDIT.md",
    "package.json",
    ".changeset/config.json",
    ".github/workflows/release-npm.yml",
    "packages/cli/package.json",
    "packages/cli-darwin-arm64/package.json",
    "packages/cli-darwin-x64/package.json",
    "packages/cli-linux-arm64/package.json",
    "packages/cli-linux-x64/package.json",
  ];

  for (const rel of files) {
    const text = read(rel);
    rejectPattern(text, /@fieldwork\/cli\b/, `${rel} must not reintroduce the obsolete scoped desktop package name`);
  }

  const meta = JSON.parse(read("packages/cli/package.json"));
  if (meta.name !== "fieldwork") {
    failures.push("packages/cli/package.json must keep the unscoped fieldwork meta-package name");
  }
  if (meta.bin?.fieldwork !== "bin/fieldwork" || meta.bin?.fieldworkd !== "bin/fieldworkd") {
    failures.push("packages/cli/package.json must expose both fieldwork and fieldworkd command shims");
  }

  const plan = read("PLAN.md");
  requireText(plan, "**npm meta-package**: `fieldwork`", "PLAN.md must name the unscoped fieldwork npm meta-package");
  requireText(plan, "The unscoped `fieldwork` meta package is operator-owned", "PLAN.md must record that the unscoped fieldwork package is operator-owned");
  requireText(plan, "The meta-package's `bin` field exposes both commands to npm", "PLAN.md must keep npm meta-package bin exposure aligned with implementation");
  requireText(plan, '"fieldworkd": "bin/fieldworkd"', "PLAN.md must show the daemon command in the npm meta package example");
  requireText(plan, '"directory": "packages/cli"', "PLAN.md must show the npm meta package repository directory");
  requireText(plan, 'fs.mkdirSync(binDir, { recursive: true });', "PLAN.md must keep postinstall binary-swap example aligned with implementation");
  rejectPattern(plan, /bin` field exposes only the CLI/, "PLAN.md must not claim the npm meta-package exposes only the CLI");
}

function* mobileFiles() {
  for (const rel of [
    "crates/mobile-core/src",
    "apps/ios/Sources",
    "apps/ios/Resources",
    "apps/android/app/src/main/kotlin",
    "apps/android/app/src/main/res",
    "apps/android/app/src/main/AndroidManifest.xml",
  ]) {
    yield* walk(path.join(repo, rel));
  }
}

function* walk(target) {
  if (!fs.existsSync(target)) {
    return;
  }
  const stat = fs.statSync(target);
  if (stat.isFile()) {
    if (isTextFile(target)) {
      yield target;
    }
    return;
  }
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    if (entry.name === "build" || entry.name === "generated" || entry.name === "jniLibs") {
      continue;
    }
    const full = path.join(target, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (entry.isFile() && isTextFile(full)) {
      yield full;
    }
  }
}

function* walkRepo() {
  yield* walkWithIgnoredDirs(repo, new Set([".git", ".gradle", ".idea", ".next", "build", "dist", "generated", "jniLibs", "node_modules", "references", "target"]));
}

function* walkWithIgnoredDirs(target, ignoredDirs) {
  if (!fs.existsSync(target)) {
    return;
  }
  const stat = fs.statSync(target);
  if (stat.isFile()) {
    yield target;
    return;
  }
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    if (ignoredDirs.has(entry.name)) {
      continue;
    }
    const full = path.join(target, entry.name);
    if (entry.isDirectory()) {
      yield* walkWithIgnoredDirs(full, ignoredDirs);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

function isTextFile(file) {
  return /\.(kt|swift|plist|pbxproj|xml|rs|toml|md|snap)$/.test(file);
}

function read(rel) {
  return fs.readFileSync(path.join(repo, rel), "utf8");
}

function rejectPattern(text, pattern, message) {
  if (pattern.test(text)) {
    failures.push(message);
  }
}

function requireText(text, needle, message) {
  if (!text.includes(needle)) {
    failures.push(message);
  }
}
