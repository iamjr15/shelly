#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn, spawnSync } from "node:child_process";

const root = process.cwd();
const fieldwork = path.join(root, "target", "release", "fieldwork");
const fieldworkd = path.join(root, "target", "release", "fieldworkd");
const cliThresholdMs = Number(process.env.FIELDWORK_CLI_COLD_START_MS || 50);
const daemonThresholdMs = Number(process.env.FIELDWORK_DAEMON_COLD_START_MS || 200);
const samples = Number(process.env.FIELDWORK_PERF_SAMPLES || 25);
const warmups = Number(process.env.FIELDWORK_PERF_WARMUP_SAMPLES || 1);

if (!fs.existsSync(fieldwork) || !fs.existsSync(fieldworkd)) {
  fail("release binaries are missing; run cargo build --release -p fieldwork-cli -p fieldwork-daemon first");
}

const cliTimes = [];
for (let i = 0; i < warmups; i += 1) {
  measureCliVersion();
}
for (let i = 0; i < samples; i += 1) {
  cliTimes.push(measureCliVersion());
}

const daemonTimes = [];
for (let i = 0; i < warmups; i += 1) {
  await measureDaemonReadyMs();
}
for (let i = 0; i < samples; i += 1) {
  daemonTimes.push(await measureDaemonReadyMs());
}

const cli = summarize(cliTimes);
const daemon = summarize(daemonTimes);
console.log(`warmup samples ignored: ${warmups}`);
console.log(`cli cold start ms: median=${cli.median.toFixed(2)} p95=${cli.p95.toFixed(2)} max=${cli.max.toFixed(2)} n=${samples}`);
console.log(`daemon ready ms: median=${daemon.median.toFixed(2)} p95=${daemon.p95.toFixed(2)} max=${daemon.max.toFixed(2)} n=${samples}`);

if (cli.max > cliThresholdMs) {
  fail(`CLI max ${cli.max.toFixed(2)}ms exceeds ${cliThresholdMs}ms`);
}
if (daemon.max > daemonThresholdMs) {
  fail(`daemon max ${daemon.max.toFixed(2)}ms exceeds ${daemonThresholdMs}ms`);
}

function measureCliVersion() {
  const start = process.hrtime.bigint();
  const result = spawnSync(fieldwork, ["version"], {
    env: {
      ...process.env,
      FIELDWORK_DISABLE_UPDATE_CHECK: "1",
    },
    stdio: "ignore",
  });
  const elapsed = elapsedMs(start);
  if (result.status !== 0) {
    fail(`fieldwork version failed with status ${result.status}`);
  }
  return elapsed;
}

async function measureDaemonReadyMs() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fieldwork-perf-"));
  const home = path.join(tmp, "home");
  const runtime = path.join(tmp, "runtime");
  const config = path.join(tmp, "config");
  const state = path.join(tmp, "state");
  const logs = path.join(tmp, "logs");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(runtime, { recursive: true });
  fs.mkdirSync(config, { recursive: true });
  fs.mkdirSync(state, { recursive: true });
  fs.mkdirSync(logs, { recursive: true });
  const socketPath = path.join(runtime, "fieldwork", "control.sock");
  const start = process.hrtime.bigint();
  const child = spawn(fieldworkd, {
    env: {
      ...process.env,
      HOME: home,
      XDG_RUNTIME_DIR: runtime,
      XDG_CONFIG_HOME: config,
      XDG_STATE_HOME: state,
      FIELDWORK_LOG_DIR: logs,
      FIELDWORK_SCROLLBACK_ENCRYPTION_ENABLED: "false",
    },
    stdio: "ignore",
  });

  try {
    while (true) {
      if (fs.existsSync(socketPath)) {
        const status = spawnSync(fieldwork, ["daemon", "status"], {
          env: {
            ...process.env,
            HOME: home,
            XDG_RUNTIME_DIR: runtime,
            XDG_CONFIG_HOME: config,
            XDG_STATE_HOME: state,
            FIELDWORK_LOG_DIR: logs,
            FIELDWORK_SCROLLBACK_ENCRYPTION_ENABLED: "false",
            FIELDWORK_DISABLE_UPDATE_CHECK: "1",
          },
          encoding: "utf8",
        });
        if (status.status !== 0) {
          fail(`fieldwork daemon status failed with status ${status.status}`);
        }
        if (status.stdout.includes("socket: reachable")) {
          return elapsedMs(start);
        }
      }
      if (child.exitCode !== null) {
        fail(`fieldworkd exited before creating socket with status ${child.exitCode}`);
      }
      if (elapsedMs(start) > 5000) {
        fail("fieldworkd did not create its socket within 5s");
      }
      await sleep(2);
    }
  } finally {
    child.kill("SIGINT");
    await waitForExit(child);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function summarize(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    median: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted[sorted.length - 1],
  };
}

function percentile(sorted, value) {
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * value) - 1);
  return sorted[index];
}

function elapsedMs(start) {
  return Number(process.hrtime.bigint() - start) / 1_000_000;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForExit(child) {
  if (child.exitCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => child.once("exit", resolve));
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
