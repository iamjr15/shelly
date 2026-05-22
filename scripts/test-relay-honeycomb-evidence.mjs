#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const verifier = path.join(root, "scripts/verify-relay-honeycomb-evidence.mjs");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "fieldwork-relay-honeycomb-"));

try {
  const good = path.join(temp, "good");
  writeFixture(good);
  expectStatus(good, 0, "good relay Honeycomb evidence should pass");

  const wrongEndpoint = path.join(temp, "wrong-endpoint");
  writeFixture(wrongEndpoint);
  fs.writeFileSync(
    path.join(wrongEndpoint, "relay-config.txt"),
    writeRelayConfig().replace("https://api.honeycomb.io/v1/traces", "http://127.0.0.1:4318/v1/traces"),
  );
  expectStatus(wrongEndpoint, 1, "non-Honeycomb endpoint should fail", "relay-config.txt must point FIELDWORK_RELAY_OTLP_ENDPOINT at Honeycomb");

  const leakedKey = path.join(temp, "leaked-key");
  writeFixture(leakedKey);
  fs.writeFileSync(path.join(leakedKey, "systemd-credentials.txt"), `${writeSystemdCredentials()}x-honeycomb-team=hcaik_live_secret\n`);
  expectStatus(leakedKey, 1, "leaked Honeycomb key should fail", "systemd-credentials.txt must not contain a raw Honeycomb API key");

  const badSampleRate = path.join(temp, "bad-sample-rate");
  writeFixture(badSampleRate);
  fs.writeFileSync(path.join(badSampleRate, "relay-config.txt"), writeRelayConfig({ sampleRate: "1.1" }));
  expectStatus(badSampleRate, 1, "out-of-range sample rate should fail", "sample rate 1.1 must be greater than 0 and at most 1");

  const unmarkedOverride = path.join(temp, "unmarked-override");
  writeFixture(unmarkedOverride);
  fs.writeFileSync(path.join(unmarkedOverride, "relay-config.txt"), writeRelayConfig({ sampleRate: "1.0", receiptWindow: false }));
  expectStatus(unmarkedOverride, 1, "temporary sample-rate override without receipt marker should fail", "receipt_test_window=true");

  const noCredential = path.join(temp, "no-credential");
  writeFixture(noCredential);
  fs.writeFileSync(path.join(noCredential, "systemd-credentials.txt"), "Environment=FIELDWORK_RELAY_OTLP_ENDPOINT=https://api.honeycomb.io/v1/traces\n");
  expectStatus(noCredential, 1, "missing systemd credential proof should fail", "honeycomb-api-key systemd credential");

  const missingSpan = path.join(temp, "missing-span");
  writeFixture(missingSpan);
  fs.writeFileSync(
    path.join(missingSpan, "honeycomb-query.json"),
    JSON.stringify({ events: [{ "service.name": "fieldwork-relay", "service.version": "1.0.0", name: "other.span" }] }, null, 2),
  );
  expectStatus(missingSpan, 1, "query without relay.version should fail", "relay.version span or /v1/version endpoint");

  const sensitiveField = path.join(temp, "sensitive-field");
  writeFixture(sensitiveField);
  fs.writeFileSync(
    path.join(sensitiveField, "honeycomb-query.json"),
    JSON.stringify(
      {
        events: [
          {
            "service.name": "fieldwork-relay",
            "service.version": "1.0.0",
            name: "relay.version",
            endpoint: "/v1/version",
            session_id_hash: "a".repeat(64),
          },
        ],
      },
      null,
      2,
    ),
  );
  expectStatus(sensitiveField, 1, "query with session hash should fail", "must not contain session, terminal, daemon, or push-token fields");

  const localPath = path.join(temp, "local-path");
  writeFixture(localPath);
  fs.writeFileSync(path.join(localPath, "relay-log.txt"), `${writeRelayLog()}path=/Users/example/secret-project\n`);
  expectStatus(localPath, 1, "logs with local filesystem paths should fail", "must not contain command, cwd, path, or plaintext session-name values");
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

console.log("relay Honeycomb evidence verifier ok");

function writeFixture(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "relay-version.txt"), '{"relay_version":"1.0.0","contract_version":1}\n');
  fs.writeFileSync(path.join(dir, "relay-config.txt"), writeRelayConfig());
  fs.writeFileSync(path.join(dir, "systemd-credentials.txt"), writeSystemdCredentials());
  fs.writeFileSync(path.join(dir, "request.txt"), "request=GET /v1/version\nstatus=200\n");
  fs.writeFileSync(
    path.join(dir, "honeycomb-query.json"),
    JSON.stringify(
      {
        events: [
          {
            "service.name": "fieldwork-relay",
            "service.version": "1.0.0",
            name: "relay.version",
            endpoint: "/v1/version",
            "http.status_code": 200,
          },
        ],
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(path.join(dir, "relay-log.txt"), writeRelayLog());
}

function writeRelayConfig(options = {}) {
  const sampleRate = options.sampleRate ?? "0.01";
  const receiptWindow = options.receiptWindow ?? sampleRate !== "0.01";
  const lines = [
    "FIELDWORK_RELAY_OTLP_ENDPOINT=https://api.honeycomb.io/v1/traces",
    "production_default_sample_rate=0.01",
    `FIELDWORK_RELAY_OTLP_SAMPLE_RATE=${sampleRate}`,
    "FIELDWORK_RELAY_HONEYCOMB_DATASET=fieldwork-relay",
    "FIELDWORK_RELAY_HONEYCOMB_API_KEY_PATH=/run/credentials/fieldwork-control-plane.service/honeycomb-api-key",
  ];
  if (receiptWindow) {
    lines.push("receipt_test_window=true", "restored_sample_rate=0.01");
  }
  return `${lines.join("\n")}\n`;
}

function writeSystemdCredentials() {
  return [
    "LoadCredential=honeycomb-api-key:/etc/fieldwork-relay/honeycomb-api-key",
    "Environment=FIELDWORK_RELAY_OTLP_ENDPOINT=https://api.honeycomb.io/v1/traces",
    "Environment=FIELDWORK_RELAY_HONEYCOMB_API_KEY_PATH=/run/credentials/fieldwork-control-plane.service/honeycomb-api-key",
  ].join("\n") + "\n";
}

function writeRelayLog() {
  return [
    "INFO fieldwork relay OTLP tracing enabled endpoint=https://api.honeycomb.io/v1/traces sample_rate=0.01",
    "INFO relay.version endpoint=/v1/version status=200 service.name=fieldwork-relay service.version=1.0.0",
  ].join("\n") + "\n";
}

function expectStatus(dir, expectedStatus, message, expectedOutput = null) {
  const result = spawnSync(process.execPath, [verifier, dir], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.status !== expectedStatus) {
    throw new Error(`${message}: exited ${result.status}, expected ${expectedStatus}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  if (expectedOutput && !`${result.stdout}\n${result.stderr}`.includes(expectedOutput)) {
    throw new Error(`${message}: missing output ${JSON.stringify(expectedOutput)}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
}
