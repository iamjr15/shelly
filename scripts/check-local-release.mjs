#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const args = new Set(process.argv.slice(2).filter((arg) => arg !== "--"));
const listOnly = args.has("--list");
const withArtifacts = args.has("--with-artifacts");
const withRuntime = args.has("--with-runtime");

for (const arg of args) {
  if (!["--list", "--with-artifacts", "--with-runtime"].includes(arg)) {
    console.error(`unknown argument: ${arg}`);
    process.exit(2);
  }
}

const node = process.execPath;
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const bash = process.platform === "win32" ? "bash.exe" : "bash";
const ruby = process.platform === "win32" ? "ruby.exe" : "ruby";

const checks = [
  ["rust workspace contract", node, ["scripts/verify-rust-workspace.mjs"]],
  ["npm package metadata", node, ["scripts/verify-npm-packages.mjs"]],
  ["changesets fixed group", node, ["scripts/verify-changesets-config.mjs"]],
  ["OSS notice drift", node, ["scripts/generate-oss-notices.mjs", "--check"]],
  ["docs sync", node, ["scripts/verify-docs-sync.mjs"]],
  ["development doc", node, ["scripts/verify-development-doc.mjs"]],
  ["community scaffold", node, ["scripts/verify-community-scaffold.mjs"]],
  ["secret-boundary source scan", node, ["scripts/verify-secret-boundaries.mjs"]],
  ["secret-boundary self-test", node, ["scripts/verify-secret-boundaries.mjs", "--self-test"]],
  ["mobile privacy/static gates", node, ["scripts/verify-mobile-privacy.mjs"]],
  ["store privacy answer sheet", node, ["scripts/verify-store-privacy.mjs"]],
  ["telemetry privacy", node, ["scripts/verify-telemetry-privacy.mjs"]],
  ["v1/FUTURE boundary", node, ["scripts/verify-v1-boundary.mjs"]],
  ["no-ship marker scan", node, ["scripts/verify-no-ship-markers.mjs"]],
  ["no-ship marker self-test", node, ["scripts/verify-no-ship-markers.mjs", "--self-test"]],
  ["release audit", node, ["scripts/verify-release-audit.mjs"]],
  ["release audit list mode", node, ["scripts/test-release-audit-list.mjs"]],
  ["live testing readiness self-test", node, ["scripts/check-live-testing-readiness.mjs", "--self-test"]],
  ["live testing evidence verifier self-test", node, ["scripts/test-live-testing-evidence.mjs"]],
  ["live testing evidence scaffold self-test", node, ["scripts/test-live-testing-scaffold.mjs"]],
  ["Android pair-flow evidence verifier self-test", node, ["scripts/test-android-pair-flow-evidence.mjs"]],
  ["Android session-subscription evidence verifier self-test", node, ["scripts/test-android-session-subscription-evidence.mjs"]],
  ["Android terminal attach evidence verifier self-test", node, ["scripts/test-android-terminal-attach-evidence.mjs"]],
  ["Android resize/detach evidence verifier self-test", node, ["scripts/test-android-resize-detach-evidence.mjs"]],
  ["Android biometric evidence verifier self-test", node, ["scripts/test-android-biometric-evidence.mjs"]],
  ["Android dogfood evidence verifier self-test", node, ["scripts/test-android-dogfood-evidence.mjs"]],
  ["Android cold-start evidence verifier self-test", node, ["scripts/test-android-cold-start-evidence.mjs"]],
  ["Android renderer flood evidence verifier self-test", node, ["scripts/test-android-renderer-flood-evidence.mjs"]],
  ["Android background/foreground evidence verifier self-test", node, ["scripts/test-android-background-foreground-evidence.mjs"]],
  ["Android network reconnect evidence verifier self-test", node, ["scripts/test-android-network-reconnect-evidence.mjs"]],
  ["Android restart-restore evidence verifier self-test", node, ["scripts/test-android-restart-restore-evidence.mjs"]],
  ["Android multisession evidence verifier self-test", node, ["scripts/test-android-multisession-evidence.mjs"]],
  ["Android FCM push evidence verifier self-test", node, ["scripts/test-android-fcm-push-evidence.mjs"]],
  ["relay Honeycomb evidence verifier self-test", node, ["scripts/test-relay-honeycomb-evidence.mjs"]],
  ["Sentry receipt evidence verifier self-test", node, ["scripts/test-sentry-receipt-evidence.mjs"]],
  ["macOS daemon survival evidence verifier self-test", node, ["scripts/test-macos-daemon-survival-evidence.mjs"]],
  ["debug instance env contract", node, ["scripts/test-debug-instance.mjs"]],
  [
    "Node script syntax",
    bash,
    [
      "-lc",
      'for script in scripts/*.mjs; do node --check "$script" >/dev/null || exit 1; done; printf "node script syntax ok\\n"',
    ],
  ],
  [
    "shell script syntax",
    bash,
    [
      "-lc",
      'for script in scripts/*.sh apps/ios/scripts/*.sh; do bash -n "$script" || exit 1; done; printf "shell script syntax ok\\n"',
    ],
  ],
  ["structured asset syntax", node, ["scripts/verify-structured-assets.mjs"]],
  [
    "workflow YAML syntax",
    ruby,
    [
      "-e",
      'require "yaml"; Dir[".github/workflows/*.yml"].sort.each { |path| YAML.load_file(path) }; YAML.load_file(".github/dependabot.yml"); YAML.load_file(".pre-commit-config.yaml"); puts "workflow yaml ok"',
    ],
  ],
  ["release workflows", node, ["scripts/verify-release-workflows.mjs"]],
  ["relay provider clients", node, ["scripts/verify-relay-provider-clients.mjs"]],
  ["security model", node, ["scripts/verify-security-model.mjs"]],
  ["daemon service scaffold", node, ["scripts/verify-daemon-service.mjs"]],
  ["daemon resize contract", node, ["scripts/verify-daemon-resize.mjs"]],
  ["infra scaffold", node, ["scripts/verify-infra-scaffold.mjs"]],
  ["site content", node, ["scripts/verify-site-content.mjs"]],
  ["UniFFI binding surface", node, ["scripts/verify-uniffi-bindings.mjs"]],
  ["npm dispatcher", node, ["scripts/test-npm-dispatcher.mjs"]],
  ["npm registry-state fixtures", node, ["scripts/test-npm-registry-state.mjs"]],
  ["external-refresh opt-in guards", node, ["scripts/test-external-status-refresh.mjs"]],
  ["npm publish plan", node, ["scripts/test-npm-publish-plan.mjs"]],
  ["Bun optional dependency smoke", node, ["scripts/test-bun-install.mjs"]],
  ["Android AAB verifier self-test", node, ["scripts/test-android-aab-verifier.mjs"]],
  ["Android pair-button picker self-test", node, ["scripts/test-android-pair-button-picker.mjs"]],
  ["release artifact verifier self-test", node, ["scripts/test-release-artifacts.mjs"]],
  ["macOS signing verifier self-test", node, ["scripts/test-macos-signing-verifier.mjs"]],
  ["npm artifact pack self-test", node, ["scripts/test-npm-artifact-pack.mjs"]],
];

const artifactChecks = [
  ["Android AAB artifact", node, ["scripts/verify-android-aab.mjs", "--expect-unsigned"]],
  ["staged npm package binaries", node, ["scripts/verify-npm-packages.mjs", "--require-binaries"]],
  ["staged host binary entrypoints", node, ["scripts/verify-binary-entrypoints.mjs", "--staged-host"]],
  ["npm publish readiness", node, ["scripts/publish-npm-packages.mjs", "--check-ready"]],
  ["npm meta dry-run pack", npm, ["pack", "./packages/cli", "--dry-run", "--json"], { env: cleanNpmEnv() }],
];

const runtimeChecks = [
  ["CLI no-args smoke", bash, ["scripts/smoke-cli-no-args.sh"], { env: localHandoffEnv() }],
  ["local handoff smoke", bash, ["scripts/smoke-local-handoff.sh"], { env: localHandoffEnv() }],
  ["binary entrypoints", node, ["scripts/verify-binary-entrypoints.mjs"]],
  ["demo video artifact", node, ["scripts/verify-demo-video.mjs"]],
  [
    "site typecheck/build",
    bash,
    ["-lc", "cd site && ASTRO_TELEMETRY_DISABLED=1 ./node_modules/.bin/astro check && ASTRO_TELEMETRY_DISABLED=1 ./node_modules/.bin/astro build"],
  ],
  ["Terraform validate", bash, ["scripts/check-infra-terraform.sh"]],
  ["relay TLS loopback", bash, ["scripts/smoke-relay-tls-loopback.sh"]],
  ["relay OTLP loopback", node, ["scripts/smoke-relay-otlp-loopback.mjs"]],
  ["desktop performance thresholds", node, ["scripts/measure-desktop-performance.mjs"]],
];

const selected = [
  ...checks,
  ...(withArtifacts ? artifactChecks : []),
  ...(withRuntime ? runtimeChecks : []),
];

if (listOnly) {
  for (const [label, command, commandArgs] of selected) {
    console.log(`${label}: ${formatCommand(command, commandArgs)}`);
  }
  process.exit(0);
}

for (const [label, command, commandArgs, options = {}] of selected) {
  console.log(`\n==> ${label}`);
  const result = spawnSync(command, commandArgs, {
    cwd: root,
    stdio: "inherit",
    env: options.env ?? process.env,
  });

  if (result.error) {
    console.error(`${label} failed to start: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`${label} failed with exit code ${result.status}`);
    process.exit(result.status ?? 1);
  }
}

const suffixes = [
  withArtifacts ? "staged artifacts" : "",
  withRuntime ? "runtime checks" : "",
].filter(Boolean);
console.log(`\nlocal release gate ok${suffixes.length ? ` with ${suffixes.join(" and ")}` : ""}`);

function formatCommand(command, commandArgs) {
  return [command, ...commandArgs].map(shellQuote).join(" ");
}

function shellQuote(value) {
  if (/^[A-Za-z0-9_./:=@+-]+$/.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function cleanNpmEnv() {
  const env = { ...process.env };
  for (const key of [
    "npm_config_supported_architectures",
    "npm_config_npm_globalconfig",
    "npm_config_verify_deps_before_run",
    "npm_config__jsr_registry",
  ]) {
    delete env[key];
  }
  return env;
}

function localHandoffEnv() {
  const env = { ...process.env };
  env.CARGO_TARGET_DIR ??= "/tmp/fieldwork-target-checks";
  return env;
}
