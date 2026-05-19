#!/usr/bin/env node

import http from "node:http";
import process from "node:process";
import { spawn } from "node:child_process";

const packages = [
  "fieldwork",
  "fieldwork-darwin-arm64",
  "fieldwork-darwin-x64",
  "fieldwork-linux-arm64",
  "fieldwork-linux-x64",
];

let registry = currentRegistryFixture();
const server = http.createServer((request, response) => {
  const name = decodeURIComponent(new URL(request.url, "http://registry.test").pathname.slice(1));
  const metadata = registry.get(name);
  if (!metadata) {
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "not_found" }));
    return;
  }
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(metadata));
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const registryUrl = `http://127.0.0.1:${server.address().port}`;

try {
  await expectSuccess(
    ["--expect-meta-published", "--expect-platform-unpublished", "--expect-latest-version=0.0.0"],
    "current registry state should accept published meta plus unpublished platform children",
  );

  await expectFailure(
    ["--expect-meta-published", "--expect-platform-published"],
    "fieldwork-darwin-arm64 platform package is not published",
    "platform-published mode must reject 404 platform children",
  );
  await expectFailure(
    ["--expect-latest-version"],
    "--expect-latest-version requires a value",
    "missing latest-version value should fail with a clean CLI error",
  );
  await expectFailure(
    [],
    "requires an explicit release-state expectation flag",
    "bare registry checks must fail closed instead of acting like name-availability checks",
  );

  registry = releasedRegistryFixture();
  await expectSuccess(
    [
      "--expect-meta-published",
      "--expect-platform-published",
      "--expect-latest-version=1.0.0",
      "--expect-provenance",
    ],
    "release registry state should require all packages, latest version, and provenance",
  );

  await expectFailure(
    ["--expect-meta-published", "--expect-platform-published", "--expect-latest-version=1.0.1"],
    "fieldwork latest version is 1.0.0, expected 1.0.1",
    "latest-version mode must reject dist-tag drift",
  );

  registry = releasedRegistryFixture({ missingProvenance: "fieldwork-linux-x64" });
  await expectFailure(
    [
      "--expect-meta-published",
      "--expect-platform-published",
      "--expect-latest-version=1.0.0",
      "--expect-provenance",
    ],
    "fieldwork-linux-x64@1.0.0 is missing npm SLSA provenance attestation metadata",
    "provenance mode must reject missing npm attestation metadata",
  );

  console.log("npm registry-state checker ok");
} finally {
  server.close();
}

function currentRegistryFixture() {
  return new Map([["fieldwork", packageMetadata("fieldwork", "0.0.0", { provenance: false })]]);
}

function releasedRegistryFixture(options = {}) {
  return new Map(
    packages.map((name) => [
      name,
      packageMetadata(name, "1.0.0", { provenance: options.missingProvenance !== name }),
    ]),
  );
}

function packageMetadata(name, version, options) {
  const dist = options.provenance
    ? {
        attestations: {
          url: `${registryUrl}/-/npm/v1/attestations/${encodeURIComponent(name)}@${version}`,
          provenance: {
            predicateType: "https://slsa.dev/provenance/v1",
          },
        },
      }
    : {};

  return {
    name,
    "dist-tags": { latest: version },
    versions: {
      [version]: {
        name,
        version,
        dist,
      },
    },
  };
}

async function expectSuccess(args, message) {
  const result = await run(args);
  if (result.status !== 0) {
    fail(message, result);
  }
  if (!result.stdout.includes("npm registry-state ok")) {
    fail(`${message}: missing success marker`, result);
  }
}

async function expectFailure(args, expectedOutput, message) {
  const result = await run(args);
  if (result.status === 0) {
    fail(`${message}: command unexpectedly passed`, result);
  }
  const combined = `${result.stdout}\n${result.stderr}`;
  if (!combined.includes(expectedOutput)) {
    fail(`${message}: expected output to include ${expectedOutput}`, result);
  }
}

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["scripts/verify-npm-registry-state.mjs", ...args], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        FIELDWORK_NPM_REGISTRY: registryUrl,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (status) => {
      resolve({ status, stdout, stderr });
    });
  });
}

function fail(message, result) {
  console.error(message);
  console.error(result.stdout);
  console.error(result.stderr);
  process.exit(1);
}
