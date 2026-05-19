#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const artifactDir = path.resolve(root, process.env.FIELDWORK_ARTIFACT_DIR || "artifacts");
const defaultPlatforms = [
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64",
  "linux-x64",
];
const expectedTargets = new Map([
  ["darwin-arm64", "aarch64-apple-darwin"],
  ["darwin-x64", "x86_64-apple-darwin"],
  ["linux-arm64", "aarch64-unknown-linux-gnu"],
  ["linux-x64", "x86_64-unknown-linux-gnu"],
]);
const platforms = (process.env.FIELDWORK_RELEASE_PLATFORMS || defaultPlatforms.join(","))
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const verifyCosignSignature = process.env.FIELDWORK_VERIFY_COSIGN_SIGNATURE === "1";
const cosignIssuer = process.env.FIELDWORK_COSIGN_OIDC_ISSUER || "https://token.actions.githubusercontent.com";
const cosignIdentityRegexp = process.env.FIELDWORK_COSIGN_IDENTITY_REGEXP;
const expectedRepository = process.env.FIELDWORK_RELEASE_REPOSITORY || "fieldwork-app/fieldwork";
const expectedBuildType = `https://github.com/${expectedRepository}/.github/workflows/release-rust.yml`;
const expectedReleaseTag = process.env.FIELDWORK_EXPECTED_RELEASE_TAG || "";
const failures = [];

if (!fs.existsSync(artifactDir)) {
  fail([
    `artifact directory not found: ${artifactDir}`,
    "populate artifacts/ with release-rust outputs or set FIELDWORK_ARTIFACT_DIR",
    "for deterministic local verifier coverage without release artifacts, run: pnpm test:release-artifacts",
  ].join("\n"));
}

if (verifyCosignSignature && !cosignIdentityRegexp) {
  fail("FIELDWORK_COSIGN_IDENTITY_REGEXP is required when FIELDWORK_VERIFY_COSIGN_SIGNATURE=1");
}

const files = [...walk(artifactDir)];

for (const platform of platforms) {
  const archiveName = `fieldwork-${platform}.tar.gz`;
  const archive = findUnique(archiveName);
  const checksum = findUnique(`${archiveName}.sha256`);
  const bundle = findUnique(`${archiveName}.bundle`);

  if (!archive || !checksum || !bundle) {
    continue;
  }

  const archiveDigest = verifyChecksum(platform, archive, checksum);
  if (archiveDigest) {
    verifyBundle(platform, archiveDigest, bundle);
    verifyCosign(platform, archive, bundle);
  }
}

if (failures.length > 0) {
  fail(failures.join("\n"));
}

console.log("release artifacts ok: archives, sha256 files, and cosign attestation bundles verified");

function findUnique(name) {
  const matches = files.filter((file) => path.basename(file) === name);
  if (matches.length === 0) {
    failures.push(`missing release artifact: ${name}`);
    return null;
  }
  if (matches.length > 1) {
    failures.push(`duplicate release artifact ${name}: ${matches.map((file) => path.relative(root, file)).join(", ")}`);
    return null;
  }
  return matches[0];
}

function verifyChecksum(platform, archive, checksumFile) {
  const expected = fs
    .readFileSync(checksumFile, "utf8")
    .trim()
    .split(/\s+/);
  const [expectedDigest, expectedName] = expected;
  if (!/^[0-9a-f]{64}$/i.test(expectedDigest)) {
    failures.push(`${path.relative(root, checksumFile)} has invalid SHA-256 content`);
    return null;
  }
  if (expectedName && path.basename(expectedName) !== path.basename(archive)) {
    failures.push(`${path.relative(root, checksumFile)} names ${expectedName}, expected ${path.basename(archive)}`);
    return null;
  }

  const actual = crypto
    .createHash("sha256")
    .update(fs.readFileSync(archive))
    .digest("hex");
  if (actual !== expectedDigest.toLowerCase()) {
    failures.push(`fieldwork-${platform}.tar.gz SHA-256 mismatch: expected ${expectedDigest}, got ${actual}`);
    return null;
  }
  return actual;
}

function verifyBundle(platform, archiveDigest, bundleFile) {
  const raw = fs.readFileSync(bundleFile, "utf8").trim();
  if (raw.length === 0) {
    failures.push(`fieldwork-${platform}.tar.gz.bundle is empty`);
    return;
  }
  let bundle;
  try {
    bundle = JSON.parse(raw);
  } catch (error) {
    failures.push(`fieldwork-${platform}.tar.gz.bundle is not valid JSON: ${error.message}`);
    return;
  }

  if (bundle.mediaType !== "application/vnd.dev.sigstore.bundle+json;version=0.3") {
    failures.push(`fieldwork-${platform}.tar.gz.bundle has unexpected Sigstore mediaType`);
  }

  if (!bundle.verificationMaterial || typeof bundle.verificationMaterial !== "object") {
    failures.push(`fieldwork-${platform}.tar.gz.bundle is missing verificationMaterial`);
  } else if (
    !Array.isArray(bundle.verificationMaterial.tlogEntries) ||
    bundle.verificationMaterial.tlogEntries.length === 0
  ) {
    failures.push(`fieldwork-${platform}.tar.gz.bundle has no transparency-log entries`);
  }

  const envelope = bundle.dsseEnvelope;
  if (!envelope || typeof envelope !== "object") {
    failures.push(`fieldwork-${platform}.tar.gz.bundle is missing a DSSE envelope`);
    return;
  }
  if (envelope.payloadType !== "application/vnd.in-toto+json") {
    failures.push(`fieldwork-${platform}.tar.gz.bundle DSSE payloadType is not in-toto`);
  }
  if (
    !Array.isArray(envelope.signatures) ||
    envelope.signatures.length === 0 ||
    envelope.signatures.some((signature) => typeof signature?.sig !== "string" || signature.sig.length === 0)
  ) {
    failures.push(`fieldwork-${platform}.tar.gz.bundle DSSE envelope has no signatures`);
  }

  let payload;
  try {
    payload = JSON.parse(decodeBase64(envelope.payload).toString("utf8"));
  } catch (error) {
    failures.push(`fieldwork-${platform}.tar.gz.bundle DSSE payload is invalid: ${error.message}`);
    return;
  }

  if (typeof payload._type !== "string" || !payload._type.startsWith("https://in-toto.io/Statement/")) {
    failures.push(`fieldwork-${platform}.tar.gz.bundle payload is not an in-toto statement`);
  }
  if (payload.predicateType !== "https://slsa.dev/provenance/v1") {
    failures.push(`fieldwork-${platform}.tar.gz.bundle payload predicateType is not SLSA provenance v1`);
  }

  const expectedSubjectName = `fieldwork-${platform}.tar.gz`;
  const subjectMatches = Array.isArray(payload.subject) &&
    payload.subject.some((subject) =>
      subject?.name === expectedSubjectName &&
      subject?.digest?.sha256?.toLowerCase() === archiveDigest
    );
  if (!subjectMatches) {
    failures.push(`fieldwork-${platform}.tar.gz.bundle subject name and digest do not match archive`);
  }

  const externalParameters = payload.predicate?.buildDefinition?.externalParameters;
  if (!externalParameters || typeof externalParameters !== "object") {
    failures.push(`fieldwork-${platform}.tar.gz.bundle payload is missing SLSA externalParameters`);
    return;
  }
  if (payload.predicate?._type !== "https://slsa.dev/provenance/v1") {
    failures.push(`fieldwork-${platform}.tar.gz.bundle SLSA predicate _type is not provenance v1`);
  }
  if (externalParameters.sha256?.toLowerCase() !== archiveDigest) {
    failures.push(`fieldwork-${platform}.tar.gz.bundle SLSA sha256 does not match archive SHA-256`);
  }
  if (externalParameters.package !== platform) {
    failures.push(`fieldwork-${platform}.tar.gz.bundle SLSA package does not match ${platform}`);
  }
  if (externalParameters.target !== expectedTargets.get(platform)) {
    failures.push(`fieldwork-${platform}.tar.gz.bundle SLSA target does not match ${expectedTargets.get(platform)}`);
  }
  if (expectedReleaseTag && externalParameters.releaseTag !== expectedReleaseTag) {
    failures.push(`fieldwork-${platform}.tar.gz.bundle SLSA releaseTag does not match ${expectedReleaseTag}`);
  } else if (!isReleaseTag(externalParameters.releaseTag)) {
    failures.push(`fieldwork-${platform}.tar.gz.bundle SLSA releaseTag is not a v-prefixed semver tag`);
  }

  const buildType = payload.predicate?.buildDefinition?.buildType;
  if (buildType !== expectedBuildType) {
    failures.push(`fieldwork-${platform}.tar.gz.bundle SLSA buildType is not ${expectedBuildType}`);
  }
}

function isReleaseTag(value) {
  return typeof value === "string" &&
    /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value);
}

function verifyCosign(platform, archive, bundleFile) {
  if (!verifyCosignSignature) {
    return;
  }

  const result = spawnSync("cosign", [
    "verify-blob-attestation",
    "--bundle",
    bundleFile,
    "--certificate-oidc-issuer",
    cosignIssuer,
    "--certificate-identity-regexp",
    cosignIdentityRegexp,
    "--type",
    "slsaprovenance1",
    archive,
  ], {
    cwd: root,
    encoding: "utf8",
  });

  if (result.status !== 0) {
    const output = result.error ? result.error.message : `${result.stdout}${result.stderr}`;
    failures.push(
      `fieldwork-${platform}.tar.gz cosign attestation verification failed:\n${output}`.trim(),
    );
  }
}

function decodeBase64(value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("missing payload");
  }
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
  return Buffer.from(padded, "base64");
}

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
