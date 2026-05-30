#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const node = process.execPath;
const scaffold = path.join(root, "scripts/create-relay-honeycomb-evidence-dir.mjs");
const verifier = path.join(root, "scripts/verify-relay-honeycomb-evidence.mjs");
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fieldwork-relay-honeycomb-scaffold-test-"));

try {
  const evidenceDir = path.join(tmpRoot, "evidence");
  const scaffoldResult = spawnSync(node, [scaffold, "--dir", evidenceDir, "--quiet", "--print-dir"], {
    cwd: root,
    encoding: "utf8",
  });
  expectStatus(scaffoldResult, 0, "scaffold should create an evidence directory");
  expectEqual(scaffoldResult.stdout.trim(), evidenceDir, "--print-dir should print only the evidence path");

  for (const file of ["README.md", "manifest.json", "missing-files.txt", "capture-checklist.md", "preflight.sh"]) {
    expect(fs.existsSync(path.join(evidenceDir, file)), `${file} should exist`);
  }

  const requiredFiles = readRequiredFiles();
  const manifest = JSON.parse(fs.readFileSync(path.join(evidenceDir, "manifest.json"), "utf8"));
  expectEqual(manifest.schema, "fieldwork-relay-honeycomb-evidence-v1", "manifest schema should be pinned");
  expectDeepEqual(manifest.requiredFiles, requiredFiles, "manifest should mirror verifier required files");
  expectDeepEqual(
    manifest.generatedFiles,
    ["README.md", "manifest.json", "missing-files.txt", "capture-checklist.md", "preflight.sh"],
    "manifest should list every scaffold-generated helper file",
  );
  expectEqual(
    fs.readFileSync(path.join(evidenceDir, "missing-files.txt"), "utf8"),
    `${requiredFiles.join("\n")}\n`,
    "missing-files.txt should list every required evidence file",
  );

  const checklist = fs.readFileSync(path.join(evidenceDir, "capture-checklist.md"), "utf8");
  for (const file of requiredFiles) {
    expect(checklist.includes(`\`${file}\``), `capture checklist should mention ${file}`);
    expect(!fs.existsSync(path.join(evidenceDir, file)), `scaffold must not fabricate ${file}`);
  }
  expect(checklist.includes("service.name=fieldwork-relay"), "checklist should include Honeycomb service query");
  expect(checklist.includes("relay.version"), "checklist should include relay.version span");
  expect(checklist.includes("x-honeycomb-team"), "checklist should warn against Honeycomb headers");
  expect(checklist.includes("terminal/session fields"), "checklist should warn against terminal/session fields");

  const readme = fs.readFileSync(path.join(evidenceDir, "README.md"), "utf8");
  expect(readme.includes("does not export hosted Honeycomb query"), "README should state scaffold is not hosted query evidence");
  expect(readme.includes("FIELDWORK_RELAY_VERSION_URL=https://relay.fieldwork.dev:8443/v1/version"), "README should document relay URL override");
  expect(readme.includes("FIELDWORK_RELAY_RECEIPT_TEST_WINDOW=true"), "README should document temporary sampling proof");

  const preflightPath = path.join(evidenceDir, "preflight.sh");
  const preflight = fs.readFileSync(preflightPath, "utf8");
  expect(preflight.startsWith("#!/usr/bin/env bash"), "preflight helper should be a shell script");
  expect(preflight.includes("FIELDWORK_RELAY_VERSION_URL"), "preflight should allow relay URL override");
  expect(preflight.includes("FIELDWORK_RELAY_OTLP_ENDPOINT"), "preflight should pin the Honeycomb OTLP endpoint");
  expect(preflight.includes("FIELDWORK_RELAY_RECEIPT_TEST_WINDOW"), "preflight should require temporary sampling marker");
  expect(preflight.includes("FIELDWORK_RELAY_SYSTEMD_UNIT_FILE"), "preflight should allow captured systemd unit input");
  expect(preflight.includes("honeycomb-api-key"), "preflight should require the relay-only systemd credential");
  expect(
    (fs.statSync(preflightPath).mode & 0o700) === 0o700,
    "preflight helper should be executable by the owner",
  );

  const verifyEmpty = spawnSync(node, [verifier, evidenceDir], { cwd: root, encoding: "utf8" });
  expectStatus(verifyEmpty, 1, "empty scaffold should not pass the evidence verifier");
  expect(verifyEmpty.stderr.includes("relay-version.txt is missing"), "verifier should still require real relay version evidence");

  const binDir = path.join(tmpRoot, "bin");
  fs.mkdirSync(binDir);
  const curlStub = path.join(binDir, "curl");
  fs.writeFileSync(curlStub, buildCurlStub(), { mode: 0o700 });
  fs.chmodSync(curlStub, 0o700);
  const unitFile = path.join(tmpRoot, "fieldwork-control-plane.service.txt");
  fs.writeFileSync(unitFile, writeSystemdUnit());

  const preflightResult = spawnSync("bash", [preflightPath], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
      FIELDWORK_RELAY_VERSION_URL: "https://relay.example.test:8443/v1/version",
      FIELDWORK_RELAY_SYSTEMD_UNIT_FILE: unitFile,
      FIELDWORK_RELAY_OTLP_SAMPLE_RATE: "1.0",
      FIELDWORK_RELAY_RECEIPT_TEST_WINDOW: "true",
      FIELDWORK_RELAY_RESTORED_SAMPLE_RATE: "0.01",
    },
  });
  expectStatus(preflightResult, 0, "preflight should capture real-looking relay config without hosted query rows");
  expect(preflightResult.stdout.includes("relay Honeycomb preflight ok"), "preflight should report success");

  const relayVersion = fs.readFileSync(path.join(evidenceDir, "relay-version.txt"), "utf8");
  expect(relayVersion.includes('"relay_version":"1.0.0"'), "preflight should capture relay version response");
  expect(relayVersion.includes('"contract_version":2'), "preflight should capture contract version");

  const relayConfig = fs.readFileSync(path.join(evidenceDir, "relay-config.txt"), "utf8");
  expect(relayConfig.includes("FIELDWORK_RELAY_OTLP_ENDPOINT=https://api.honeycomb.io/v1/traces"), "preflight should capture Honeycomb endpoint");
  expect(relayConfig.includes("production_default_sample_rate=0.01"), "preflight should capture default sample rate");
  expect(relayConfig.includes("FIELDWORK_RELAY_OTLP_SAMPLE_RATE=1.0"), "preflight should capture temporary sample rate");
  expect(relayConfig.includes("receipt_test_window=true"), "preflight should capture temporary receipt window");
  expect(relayConfig.includes("restored_sample_rate=0.01"), "preflight should capture restored sampling proof");
  expect(relayConfig.includes("FIELDWORK_RELAY_HONEYCOMB_DATASET=fieldwork-relay"), "preflight should capture dataset");
  expect(!relayConfig.includes("hcaik_"), "relay-config.txt must not contain a raw Honeycomb key");

  const request = fs.readFileSync(path.join(evidenceDir, "request.txt"), "utf8");
  expect(request.includes("request=GET /v1/version"), "preflight should capture request path");
  expect(request.includes("status=200"), "preflight should capture HTTP 200 status");

  const systemdCredentials = fs.readFileSync(path.join(evidenceDir, "systemd-credentials.txt"), "utf8");
  expect(systemdCredentials.includes("LoadCredential=honeycomb-api-key"), "preflight should capture systemd credential wiring");
  expect(systemdCredentials.includes("FIELDWORK_RELAY_HONEYCOMB_API_KEY_PATH"), "preflight should capture API key path wiring");
  expect(!systemdCredentials.includes("hcaik_"), "systemd credential proof must not contain the raw Honeycomb key");
  expect(!fs.existsSync(path.join(evidenceDir, "honeycomb-query.json")), "preflight must not fabricate hosted Honeycomb query evidence");
  expect(!fs.existsSync(path.join(evidenceDir, "relay-log.txt")), "preflight must not fabricate relay logs");

  const verifyAfterPreflight = spawnSync(node, [verifier, evidenceDir], { cwd: root, encoding: "utf8" });
  expectStatus(verifyAfterPreflight, 1, "preflight-only evidence should not pass the hosted receipt verifier");
  expect(
    verifyAfterPreflight.stderr.includes("honeycomb-query.json is missing"),
    "verifier should still require real hosted Honeycomb query evidence",
  );

  const missingWindowDir = path.join(tmpRoot, "missing-window");
  expectStatus(
    spawnSync(node, [scaffold, "--dir", missingWindowDir, "--quiet"], { cwd: root, encoding: "utf8" }),
    0,
    "scaffold should create missing-window test evidence directory",
  );
  const missingWindowResult = spawnSync("bash", [path.join(missingWindowDir, "preflight.sh")], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
      FIELDWORK_RELAY_VERSION_URL: "https://relay.example.test:8443/v1/version",
      FIELDWORK_RELAY_SYSTEMD_UNIT_FILE: unitFile,
      FIELDWORK_RELAY_OTLP_SAMPLE_RATE: "1.0",
    },
  });
  expectStatus(missingWindowResult, 1, "preflight should reject temporary sampling without receipt marker");
  expect(missingWindowResult.stderr.includes("FIELDWORK_RELAY_RECEIPT_TEST_WINDOW=true"), "temporary sampling failure should be explicit");

  const noForce = spawnSync(node, [scaffold, "--dir", evidenceDir, "--quiet"], { cwd: root, encoding: "utf8" });
  expectStatus(noForce, 1, "scaffold should not overwrite a non-empty directory without --force");
  expect(noForce.stderr.includes("rerun with --force"), "non-empty directory failure should explain --force");

  const force = spawnSync(node, [scaffold, "--dir", evidenceDir, "--force", "--quiet"], {
    cwd: root,
    encoding: "utf8",
  });
  expectStatus(force, 0, "scaffold should refresh metadata with --force");

  console.log("relay Honeycomb evidence scaffold self-test ok");
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

function readRequiredFiles() {
  const source = fs.readFileSync(verifier, "utf8");
  const match = source.match(/const\s+requiredFiles\s*=\s*\[(?<body>[\s\S]*?)\];/);
  if (!match?.groups?.body) {
    throw new Error("cannot locate requiredFiles in verifier");
  }
  return [...match.groups.body.matchAll(/"([^"\n]+)"/g)].map((fileMatch) => fileMatch[1]);
}

function buildCurlStub() {
  return `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == *"-w status=%{http_code}"* ]]; then
  printf 'status=200\\n'
  exit 0
fi
printf '{"relay_version":"1.0.0","contract_version":2}\\n'
`;
}

function writeSystemdUnit() {
  return [
    "[Service]",
    "LoadCredential=honeycomb-api-key:/etc/fieldwork-relay/honeycomb-api-key",
    "Environment=FIELDWORK_RELAY_OTLP_ENDPOINT=https://api.honeycomb.io/v1/traces",
    "Environment=FIELDWORK_RELAY_HONEYCOMB_API_KEY_PATH=/run/credentials/fieldwork-control-plane.service/honeycomb-api-key",
    "",
  ].join("\n");
}

function expectStatus(result, expectedStatus, message) {
  if (result.status !== expectedStatus) {
    throw new Error(`${message}: exited ${result.status}, expected ${expectedStatus}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
}

function expectEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function expectDeepEqual(actual, expected, message) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function expect(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
