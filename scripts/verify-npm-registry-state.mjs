#!/usr/bin/env node
import process from "node:process";

const packages = [
  "fieldwork",
  "fieldwork-darwin-arm64",
  "fieldwork-darwin-x64",
  "fieldwork-linux-arm64",
  "fieldwork-linux-x64",
];

const rawArgs = process.argv.slice(2).filter((arg) => arg !== "--");
const args = new Set(rawArgs);
const expectMetaPublished = args.has("--expect-meta-published");
const expectPlatformUnpublished = args.has("--expect-platform-unpublished");
const expectPlatformPublished = args.has("--expect-platform-published");
const expectProvenance = args.has("--expect-provenance");
let expectedLatestVersion = null;
const registry = (process.env.FIELDWORK_NPM_REGISTRY || "https://registry.npmjs.org").replace(/\/+$/, "");
const failures = [];
const results = [];

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

async function main() {
  expectedLatestVersion = parseValueArg(rawArgs, "--expect-latest-version");
  const hasExpectation =
    expectMetaPublished ||
    expectPlatformUnpublished ||
    expectPlatformPublished ||
    expectProvenance ||
    expectedLatestVersion;
  if (!hasExpectation) {
    throw new Error(
      [
        "verify-npm-registry-state requires an explicit release-state expectation flag.",
        "Use scripts/test-npm-registry-state.mjs for local fixture coverage.",
        "This script is not an npm name-availability checker.",
      ].join(" "),
    );
  }

  for (const name of packages) {
    const result = await checkPackage(name);
    results.push(result);
    if (expectMetaPublished && name === "fieldwork" && result.status !== "published") {
      failures.push("fieldwork meta package is not published");
    }
    if (expectPlatformUnpublished && name !== "fieldwork" && result.status === "published") {
      failures.push(`${name} platform package is already published as ${result.version}`);
    }
    if (expectPlatformPublished && name !== "fieldwork" && result.status !== "published") {
      failures.push(`${name} platform package is not published`);
    }
    if (expectedLatestVersion && result.status === "published" && result.version !== expectedLatestVersion) {
      failures.push(`${name} latest version is ${result.version}, expected ${expectedLatestVersion}`);
    }
    if (expectProvenance && result.status === "published" && !hasSlsaProvenance(result)) {
      failures.push(`${name}@${result.version} is missing npm SLSA provenance attestation metadata`);
    }
  }

  console.log(`npm registry-state check: ${registry}`);
  for (const result of results) {
    if (result.status === "unpublished") {
      console.log(`unpublished: ${result.name} (registry returned 404)`);
    } else {
      const provenance = hasSlsaProvenance(result) ? " (provenance: https://slsa.dev/provenance/v1)" : "";
      console.log(`published: ${result.name}@${result.version}${provenance}`);
    }
  }

  if (failures.length > 0) {
    console.error(failures.join("\n"));
    process.exit(1);
  }

  console.log("npm registry-state ok");
}

function hasSlsaProvenance(result) {
  return result.attestations?.provenance?.predicateType === "https://slsa.dev/provenance/v1";
}

function parseValueArg(argv, name) {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === name) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${name} requires a value`);
      }
      return value;
    }
    if (arg.startsWith(`${name}=`)) {
      const value = arg.slice(name.length + 1);
      if (!value) {
        throw new Error(`${name} requires a value`);
      }
      return value;
    }
  }
  return null;
}

async function checkPackage(name) {
  const url = `${registry}/${name.replace("/", "%2f")}`;
  let response;
  try {
    response = await fetch(url, {
      headers: { accept: "application/vnd.npm.install-v1+json" },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    throw new Error(`failed to query ${name}: ${error.message}`);
  }

  if (response.status === 404) {
    return { name, status: "unpublished" };
  }
  if (!response.ok) {
    throw new Error(`failed to query ${name}: registry returned HTTP ${response.status}`);
  }

  const metadata = await response.json();
  const version = metadata?.["dist-tags"]?.latest || metadata?.version || "unknown";
  const versionMetadata = metadata?.versions?.[version] || metadata;
  const attestations = versionMetadata?.dist?.attestations || metadata?.dist?.attestations || null;
  return { name, status: "published", version, attestations };
}
