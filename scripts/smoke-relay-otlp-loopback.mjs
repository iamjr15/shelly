#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const repo = path.resolve(new URL("..", import.meta.url).pathname);
const traceTimeoutMs = Number.parseInt(process.env.SHELLY_OTLP_SMOKE_TIMEOUT_MS ?? "15000", 10);
const sensitiveSentinels = [
  "shelly-secret-terminal-bytes",
  "shelly-secret-session-hash",
  "shelly-secret-daemon-node",
  "shelly-secret-push-token",
  "shelly-secret-command",
  "shelly-secret-path",
];

const collector = await startCollector();
let relay;

try {
  const relayPort = await freePort();
  const relayUrl = `http://127.0.0.1:${relayPort}`;
  const binary = await ensureRelayBinary();
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "shelly-relay-otlp-"));

  relay = spawn(binary, [], {
    cwd: repo,
    env: {
      ...process.env,
      HOME: tempHome,
      XDG_RUNTIME_DIR: tempHome,
      XDG_CONFIG_HOME: tempHome,
      XDG_STATE_HOME: tempHome,
      SHELLY_RELAY_ADDR: `127.0.0.1:${relayPort}`,
      SHELLY_RELAY_METRICS_ADDR: "off",
      SHELLY_RELAY_DB_PATH: "off",
      SHELLY_RELAY_OTLP_ENDPOINT: collector.url,
      SHELLY_RELAY_OTLP_SAMPLE_RATE: "1.0",
      RUST_LOG: "shelly_relay=info",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let relayOutput = "";
  relay.stdout.on("data", (chunk) => {
    relayOutput += chunk.toString();
  });
  relay.stderr.on("data", (chunk) => {
    relayOutput += chunk.toString();
  });

  await waitForRelay(relayUrl, () => relayOutput);

  const sensitiveQuery = sensitiveSentinels
    .map((value, index) => `sentinel${index}=${encodeURIComponent(value)}`)
    .join("&");
  await fetch(`${relayUrl}/v1/version?${sensitiveQuery}`, {
    headers: {
      "user-agent": sensitiveSentinels[0],
      "x-shelly-test": sensitiveSentinels[1],
    },
  });

  const trace = await collector.waitForTrace(traceTimeoutMs);
  assertTrace(trace);

  console.log("relay OTLP loopback smoke ok");
} finally {
  if (relay && relay.exitCode === null) {
    relay.kill("SIGTERM");
    await waitForProcessExit(relay, 5_000);
  }
  await collector.close();
}

async function ensureRelayBinary() {
  const binaryName = process.platform === "win32" ? "shelly-relay.exe" : "shelly-relay";
  const configuredBinary = process.env.SHELLY_RELAY_BINARY;
  if (configuredBinary) {
    if (!fs.existsSync(configuredBinary)) {
      throw new Error(`SHELLY_RELAY_BINARY does not exist: ${configuredBinary}`);
    }
    return configuredBinary;
  }

  const releaseBinary = path.join(repo, "target", "release", binaryName);
  if (fs.existsSync(releaseBinary)) {
    return releaseBinary;
  }

  const debugBinary = path.join(repo, "target", "debug", binaryName);
  if (fs.existsSync(debugBinary)) {
    return debugBinary;
  }

  const result = spawnSync("cargo", ["build", "-p", "shelly-relay"], {
    cwd: repo,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error("cargo build -p shelly-relay failed");
  }
  if (!fs.existsSync(debugBinary)) {
    throw new Error(`expected relay binary missing after build: ${debugBinary}`);
  }
  return debugBinary;
}

function assertTrace(trace) {
  if (!trace.contentType.startsWith("application/x-protobuf")) {
    throw new Error(`expected OTLP protobuf content-type, got ${trace.contentType || "(missing)"}`);
  }

  const bodyText = trace.body.toString("latin1");
  for (const expected of ["shelly-relay", "relay.version", "/v1/version"]) {
    if (!bodyText.includes(expected)) {
      throw new Error(`OTLP trace missing expected field: ${expected}`);
    }
  }

  for (const sentinel of sensitiveSentinels) {
    if (trace.body.includes(Buffer.from(sentinel))) {
      throw new Error(`OTLP trace leaked sensitive sentinel: ${sentinel}`);
    }
  }
}

async function waitForRelay(baseUrl, output) {
  const deadline = Date.now() + 10_000;
  let lastError;
  while (Date.now() < deadline) {
    if (relay?.exitCode !== null) {
      throw new Error(`shelly-relay exited before becoming ready:\n${output()}`);
    }
    try {
      const response = await fetch(`${baseUrl}/v1/version`);
      if (response.ok) {
        return;
      }
      lastError = new Error(`GET /v1/version returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(150);
  }
  throw new Error(`shelly-relay did not become ready: ${lastError?.message ?? "unknown"}\n${output()}`);
}

async function startCollector() {
  let pendingResolve;
  let pendingReject;
  const tracePromise = new Promise((resolve, reject) => {
    pendingResolve = resolve;
    pendingReject = reject;
  });

  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      if (request.method === "POST" && request.url === "/v1/traces") {
        pendingResolve({
          body: Buffer.concat(chunks),
          contentType: request.headers["content-type"] ?? "",
        });
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{}");
        return;
      }
      response.writeHead(404);
      response.end();
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/v1/traces`,
    waitForTrace(timeoutMs) {
      let timeoutId;
      const timeout = new Promise((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error(`timed out waiting ${timeoutMs}ms for OTLP trace`)),
          timeoutMs,
        );
      });
      return Promise.race([tracePromise, timeout])
        .finally(() => clearTimeout(timeoutId))
        .catch((error) => {
          pendingReject(error);
          throw error;
        });
    },
    close() {
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

async function freePort() {
  const server = http.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForProcessExit(child, timeoutMs) {
  if (child.exitCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}
