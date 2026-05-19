#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fieldwork-release-artifacts-"));
const platforms = [
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64",
  "linux-x64",
];
const targets = new Map([
  ["darwin-arm64", "aarch64-apple-darwin"],
  ["darwin-x64", "x86_64-apple-darwin"],
  ["linux-arm64", "aarch64-unknown-linux-gnu"],
  ["linux-x64", "x86_64-unknown-linux-gnu"],
]);

try {
  writeArtifacts(artifactRoot, platforms);

  run(process.execPath, ["scripts/verify-release-artifacts.mjs"], {
    env: { ...process.env, FIELDWORK_ARTIFACT_DIR: artifactRoot },
  });

  const subsetRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fieldwork-release-artifacts-subset-"));
  try {
    writeArtifacts(subsetRoot, ["linux-arm64"]);
    run(process.execPath, ["scripts/verify-release-artifacts.mjs"], {
      env: {
        ...process.env,
        FIELDWORK_ARTIFACT_DIR: subsetRoot,
        FIELDWORK_RELEASE_PLATFORMS: "linux-arm64",
      },
    });
  } finally {
    fs.rmSync(subsetRoot, { recursive: true, force: true });
  }

  const tamperedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fieldwork-release-artifacts-tampered-"));
  try {
    writeArtifacts(tamperedRoot, ["linux-arm64"]);
    mutateBundle(tamperedRoot, "linux-arm64", (payload) => {
      payload.subject[0].digest.sha256 = "0".repeat(64);
      payload.predicate.buildDefinition.externalParameters.sha256 = "0".repeat(64);
    });
    expectFailure(process.execPath, ["scripts/verify-release-artifacts.mjs"], {
      env: {
        ...process.env,
        FIELDWORK_ARTIFACT_DIR: tamperedRoot,
        FIELDWORK_RELEASE_PLATFORMS: "linux-arm64",
      },
    }, "subject name and digest do not match archive");
  } finally {
    fs.rmSync(tamperedRoot, { recursive: true, force: true });
  }

  const wrongSubjectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fieldwork-release-artifacts-subject-"));
  try {
    writeArtifacts(wrongSubjectRoot, ["linux-arm64"]);
    mutateBundle(wrongSubjectRoot, "linux-arm64", (payload) => {
      payload.subject[0].name = "fieldwork-wrong-platform.tar.gz";
    });
    expectFailure(process.execPath, ["scripts/verify-release-artifacts.mjs"], {
      env: {
        ...process.env,
        FIELDWORK_ARTIFACT_DIR: wrongSubjectRoot,
        FIELDWORK_RELEASE_PLATFORMS: "linux-arm64",
      },
    }, "subject name and digest do not match archive");
  } finally {
    fs.rmSync(wrongSubjectRoot, { recursive: true, force: true });
  }

  const wrongPredicateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fieldwork-release-artifacts-predicate-"));
  try {
    writeArtifacts(wrongPredicateRoot, ["linux-arm64"]);
    mutateBundle(wrongPredicateRoot, "linux-arm64", (payload) => {
      payload.predicateType = "https://example.com/not-slsa";
    });
    expectFailure(process.execPath, ["scripts/verify-release-artifacts.mjs"], {
      env: {
        ...process.env,
        FIELDWORK_ARTIFACT_DIR: wrongPredicateRoot,
        FIELDWORK_RELEASE_PLATFORMS: "linux-arm64",
      },
    }, "payload predicateType is not SLSA provenance v1");
  } finally {
    fs.rmSync(wrongPredicateRoot, { recursive: true, force: true });
  }

  const wrongChecksumNameRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fieldwork-release-artifacts-checksum-name-"));
  try {
    writeArtifacts(wrongChecksumNameRoot, ["linux-arm64"]);
    const checksum = path.join(wrongChecksumNameRoot, "fieldwork-linux-arm64", "fieldwork-linux-arm64.tar.gz.sha256");
    const digest = fs.readFileSync(checksum, "utf8").trim().split(/\s+/)[0];
    fs.writeFileSync(checksum, `${digest}  fieldwork-linux-x64.tar.gz\n`);
    expectFailure(process.execPath, ["scripts/verify-release-artifacts.mjs"], {
      env: {
        ...process.env,
        FIELDWORK_ARTIFACT_DIR: wrongChecksumNameRoot,
        FIELDWORK_RELEASE_PLATFORMS: "linux-arm64",
      },
    }, "names fieldwork-linux-x64.tar.gz, expected fieldwork-linux-arm64.tar.gz");
  } finally {
    fs.rmSync(wrongChecksumNameRoot, { recursive: true, force: true });
  }

  const wrongExternalShaRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fieldwork-release-artifacts-external-sha-"));
  try {
    writeArtifacts(wrongExternalShaRoot, ["linux-arm64"]);
    mutateBundle(wrongExternalShaRoot, "linux-arm64", (payload) => {
      payload.predicate.buildDefinition.externalParameters.sha256 = "0".repeat(64);
    });
    expectFailure(process.execPath, ["scripts/verify-release-artifacts.mjs"], {
      env: {
        ...process.env,
        FIELDWORK_ARTIFACT_DIR: wrongExternalShaRoot,
        FIELDWORK_RELEASE_PLATFORMS: "linux-arm64",
      },
    }, "SLSA sha256 does not match archive SHA-256");
  } finally {
    fs.rmSync(wrongExternalShaRoot, { recursive: true, force: true });
  }

  const wrongPackageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fieldwork-release-artifacts-package-"));
  try {
    writeArtifacts(wrongPackageRoot, ["linux-arm64"]);
    mutateBundle(wrongPackageRoot, "linux-arm64", (payload) => {
      payload.predicate.buildDefinition.externalParameters.package = "linux-x64";
    });
    expectFailure(process.execPath, ["scripts/verify-release-artifacts.mjs"], {
      env: {
        ...process.env,
        FIELDWORK_ARTIFACT_DIR: wrongPackageRoot,
        FIELDWORK_RELEASE_PLATFORMS: "linux-arm64",
      },
    }, "SLSA package does not match linux-arm64");
  } finally {
    fs.rmSync(wrongPackageRoot, { recursive: true, force: true });
  }

  const wrongTargetRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fieldwork-release-artifacts-target-"));
  try {
    writeArtifacts(wrongTargetRoot, ["linux-arm64"]);
    mutateBundle(wrongTargetRoot, "linux-arm64", (payload) => {
      payload.predicate.buildDefinition.externalParameters.target = "x86_64-unknown-linux-gnu";
    });
    expectFailure(process.execPath, ["scripts/verify-release-artifacts.mjs"], {
      env: {
        ...process.env,
        FIELDWORK_ARTIFACT_DIR: wrongTargetRoot,
        FIELDWORK_RELEASE_PLATFORMS: "linux-arm64",
      },
    }, "SLSA target does not match aarch64-unknown-linux-gnu");
  } finally {
    fs.rmSync(wrongTargetRoot, { recursive: true, force: true });
  }

  const wrongBuildTypeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fieldwork-release-artifacts-buildtype-"));
  try {
    writeArtifacts(wrongBuildTypeRoot, ["linux-arm64"]);
    mutateBundle(wrongBuildTypeRoot, "linux-arm64", (payload) => {
      payload.predicate.buildDefinition.buildType = "https://github.com/fieldwork-app/not-fieldwork/.github/workflows/release-rust.yml";
    });
    expectFailure(process.execPath, ["scripts/verify-release-artifacts.mjs"], {
      env: {
        ...process.env,
        FIELDWORK_ARTIFACT_DIR: wrongBuildTypeRoot,
        FIELDWORK_RELEASE_PLATFORMS: "linux-arm64",
      },
    }, "SLSA buildType is not https://github.com/fieldwork-app/fieldwork/.github/workflows/release-rust.yml");
  } finally {
    fs.rmSync(wrongBuildTypeRoot, { recursive: true, force: true });
  }

  const wrongReleaseTagRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fieldwork-release-artifacts-release-tag-"));
  try {
    writeArtifacts(wrongReleaseTagRoot, ["linux-arm64"]);
    mutateBundle(wrongReleaseTagRoot, "linux-arm64", (payload) => {
      payload.predicate.buildDefinition.externalParameters.releaseTag = "v9.9.9";
    });
    expectFailure(process.execPath, ["scripts/verify-release-artifacts.mjs"], {
      env: {
        ...process.env,
        FIELDWORK_ARTIFACT_DIR: wrongReleaseTagRoot,
        FIELDWORK_RELEASE_PLATFORMS: "linux-arm64",
        FIELDWORK_EXPECTED_RELEASE_TAG: "v0.0.0-test",
      },
    }, "SLSA releaseTag does not match v0.0.0-test");
  } finally {
    fs.rmSync(wrongReleaseTagRoot, { recursive: true, force: true });
  }

  const missingReleaseTagRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fieldwork-release-artifacts-missing-release-tag-"));
  try {
    writeArtifacts(missingReleaseTagRoot, ["linux-arm64"]);
    mutateBundle(missingReleaseTagRoot, "linux-arm64", (payload) => {
      delete payload.predicate.buildDefinition.externalParameters.releaseTag;
    });
    expectFailure(process.execPath, ["scripts/verify-release-artifacts.mjs"], {
      env: {
        ...process.env,
        FIELDWORK_ARTIFACT_DIR: missingReleaseTagRoot,
        FIELDWORK_RELEASE_PLATFORMS: "linux-arm64",
      },
    }, "SLSA releaseTag is not a v-prefixed semver tag");
  } finally {
    fs.rmSync(missingReleaseTagRoot, { recursive: true, force: true });
  }

  const wrongMediaTypeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fieldwork-release-artifacts-mediatype-"));
  try {
    writeArtifacts(wrongMediaTypeRoot, ["linux-arm64"]);
    mutateBundleObject(wrongMediaTypeRoot, "linux-arm64", (bundle) => {
      bundle.mediaType = "application/json";
    });
    expectFailure(process.execPath, ["scripts/verify-release-artifacts.mjs"], {
      env: {
        ...process.env,
        FIELDWORK_ARTIFACT_DIR: wrongMediaTypeRoot,
        FIELDWORK_RELEASE_PLATFORMS: "linux-arm64",
      },
    }, "has unexpected Sigstore mediaType");
  } finally {
    fs.rmSync(wrongMediaTypeRoot, { recursive: true, force: true });
  }

  const missingTlogRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fieldwork-release-artifacts-tlog-"));
  try {
    writeArtifacts(missingTlogRoot, ["linux-arm64"]);
    mutateBundleObject(missingTlogRoot, "linux-arm64", (bundle) => {
      bundle.verificationMaterial.tlogEntries = [];
    });
    expectFailure(process.execPath, ["scripts/verify-release-artifacts.mjs"], {
      env: {
        ...process.env,
        FIELDWORK_ARTIFACT_DIR: missingTlogRoot,
        FIELDWORK_RELEASE_PLATFORMS: "linux-arm64",
      },
    }, "has no transparency-log entries");
  } finally {
    fs.rmSync(missingTlogRoot, { recursive: true, force: true });
  }

  const missingEnvelopeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fieldwork-release-artifacts-envelope-"));
  try {
    writeArtifacts(missingEnvelopeRoot, ["linux-arm64"]);
    mutateBundleObject(missingEnvelopeRoot, "linux-arm64", (bundle) => {
      delete bundle.dsseEnvelope;
    });
    expectFailure(process.execPath, ["scripts/verify-release-artifacts.mjs"], {
      env: {
        ...process.env,
        FIELDWORK_ARTIFACT_DIR: missingEnvelopeRoot,
        FIELDWORK_RELEASE_PLATFORMS: "linux-arm64",
      },
    }, "is missing a DSSE envelope");
  } finally {
    fs.rmSync(missingEnvelopeRoot, { recursive: true, force: true });
  }

  const missingSignatureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fieldwork-release-artifacts-signature-"));
  try {
    writeArtifacts(missingSignatureRoot, ["linux-arm64"]);
    mutateBundleObject(missingSignatureRoot, "linux-arm64", (bundle) => {
      bundle.dsseEnvelope.signatures = [];
    });
    expectFailure(process.execPath, ["scripts/verify-release-artifacts.mjs"], {
      env: {
        ...process.env,
        FIELDWORK_ARTIFACT_DIR: missingSignatureRoot,
        FIELDWORK_RELEASE_PLATFORMS: "linux-arm64",
      },
    }, "DSSE envelope has no signatures");
  } finally {
    fs.rmSync(missingSignatureRoot, { recursive: true, force: true });
  }

  const invalidPayloadRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fieldwork-release-artifacts-payload-"));
  try {
    writeArtifacts(invalidPayloadRoot, ["linux-arm64"]);
    mutateBundleObject(invalidPayloadRoot, "linux-arm64", (bundle) => {
      bundle.dsseEnvelope.payload = Buffer.from("not json").toString("base64");
    });
    expectFailure(process.execPath, ["scripts/verify-release-artifacts.mjs"], {
      env: {
        ...process.env,
        FIELDWORK_ARTIFACT_DIR: invalidPayloadRoot,
        FIELDWORK_RELEASE_PLATFORMS: "linux-arm64",
      },
    }, "DSSE payload is invalid");
  } finally {
    fs.rmSync(invalidPayloadRoot, { recursive: true, force: true });
  }

  const missingExternalRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fieldwork-release-artifacts-external-"));
  try {
    writeArtifacts(missingExternalRoot, ["linux-arm64"]);
    mutateBundle(missingExternalRoot, "linux-arm64", (payload) => {
      delete payload.predicate.buildDefinition.externalParameters;
    });
    expectFailure(process.execPath, ["scripts/verify-release-artifacts.mjs"], {
      env: {
        ...process.env,
        FIELDWORK_ARTIFACT_DIR: missingExternalRoot,
        FIELDWORK_RELEASE_PLATFORMS: "linux-arm64",
      },
    }, "payload is missing SLSA externalParameters");
  } finally {
    fs.rmSync(missingExternalRoot, { recursive: true, force: true });
  }

  const wrongPredicateTypeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fieldwork-release-artifacts-predicate-inner-"));
  try {
    writeArtifacts(wrongPredicateTypeRoot, ["linux-arm64"]);
    mutateBundle(wrongPredicateTypeRoot, "linux-arm64", (payload) => {
      payload.predicate._type = "https://example.com/not-slsa";
    });
    expectFailure(process.execPath, ["scripts/verify-release-artifacts.mjs"], {
      env: {
        ...process.env,
        FIELDWORK_ARTIFACT_DIR: wrongPredicateTypeRoot,
        FIELDWORK_RELEASE_PLATFORMS: "linux-arm64",
      },
    }, "SLSA predicate _type is not provenance v1");
  } finally {
    fs.rmSync(wrongPredicateTypeRoot, { recursive: true, force: true });
  }

  console.log("release artifact verifier test ok");
} finally {
  fs.rmSync(artifactRoot, { recursive: true, force: true });
}

function mutateBundle(rootDir, platform, mutatePayload) {
  mutateBundleObject(rootDir, platform, (bundle) => {
    const payload = JSON.parse(Buffer.from(bundle.dsseEnvelope.payload, "base64").toString("utf8"));
    mutatePayload(payload);
    bundle.dsseEnvelope.payload = Buffer.from(JSON.stringify(payload)).toString("base64");
  });
}

function mutateBundleObject(rootDir, platform, mutateBundleData) {
  const bundlePath = path.join(
    rootDir,
    `fieldwork-${platform}`,
    `fieldwork-${platform}.tar.gz.bundle`,
  );
  const bundle = JSON.parse(fs.readFileSync(bundlePath, "utf8"));
  mutateBundleData(bundle);
  fs.writeFileSync(bundlePath, `${JSON.stringify(bundle)}\n`);
}

function writeArtifacts(rootDir, platformNames) {
  for (const platform of platformNames) {
    const dir = path.join(rootDir, `fieldwork-${platform}`);
    fs.mkdirSync(dir, { recursive: true });
    const archive = path.join(dir, `fieldwork-${platform}.tar.gz`);
    const contents = Buffer.from(`synthetic archive for ${platform}\n`);
    fs.writeFileSync(archive, contents);
    fs.writeFileSync(
      `${archive}.sha256`,
      `${crypto.createHash("sha256").update(contents).digest("hex")}  fieldwork-${platform}.tar.gz\n`,
    );
    fs.writeFileSync(
      `${archive}.bundle`,
      `${JSON.stringify(sigstoreBundle(platform, crypto.createHash("sha256").update(contents).digest("hex")))}\n`,
    );
  }
}

function sigstoreBundle(platform, digest) {
  const payload = {
    _type: "https://in-toto.io/Statement/v1",
    predicateType: "https://slsa.dev/provenance/v1",
    subject: [
      {
        name: `fieldwork-${platform}.tar.gz`,
        digest: {
          sha256: digest,
        },
      },
    ],
    predicate: {
      _type: "https://slsa.dev/provenance/v1",
      buildDefinition: {
        buildType: "https://github.com/fieldwork-app/fieldwork/.github/workflows/release-rust.yml",
        externalParameters: {
          releaseTag: "v0.0.0-test",
          package: platform,
          target: targets.get(platform),
          sha256: digest,
        },
        internalParameters: {},
      },
      runDetails: {
        builder: {
          id: "https://github.com/fieldwork-app/fieldwork/actions/runs/1",
        },
        metadata: {
          invocationId: "1-1",
        },
      },
    },
  };
  return {
    mediaType: "application/vnd.dev.sigstore.bundle+json;version=0.3",
    verificationMaterial: {
      tlogEntries: [
        {
          logIndex: "1",
        },
      ],
    },
    dsseEnvelope: {
      payload: Buffer.from(JSON.stringify(payload)).toString("base64"),
      payloadType: "application/vnd.in-toto+json",
      signatures: [
        {
          sig: Buffer.from(`signature-${platform}`).toString("base64"),
          keyid: "",
        },
      ],
    },
  };
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    ...options,
  });
  if (result.status !== 0) {
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }
}

function expectFailure(command, args, options, expectedStderr) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    ...options,
  });
  if (result.status === 0) {
    process.stderr.write("expected command to fail, but it passed\n");
    process.exit(1);
  }
  if (!result.stderr.includes(expectedStderr)) {
    process.stderr.write(result.stdout);
    process.stderr.write(result.stderr);
    process.stderr.write(`expected stderr to include: ${expectedStderr}\n`);
    process.exit(1);
  }
}
