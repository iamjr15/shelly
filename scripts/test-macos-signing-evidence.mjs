#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const verifier = path.join(root, "scripts/verify-macos-signing-evidence.mjs");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "fieldwork-macos-npm-trust-evidence-"));
const platforms = ["darwin-arm64", "darwin-x64"];
const binaries = ["fieldwork", "fieldworkd"];

try {
  const good = path.join(temp, "good");
  writeFixture(good);
  expectStatus(good, 0, "good macOS npm trust evidence should pass");

  const unsigned = path.join(temp, "unsigned");
  writeFixture(unsigned);
  fs.writeFileSync(path.join(unsigned, "darwin-arm64-codesign-fieldwork.txt"), codesign({ signature: "unsigned", binary: "fieldwork" }));
  expectStatus(unsigned, 1, "unsigned output should fail", "must show an ad-hoc or Developer ID signature");

  const quarantined = path.join(temp, "quarantined");
  writeFixture(quarantined);
  fs.writeFileSync(path.join(quarantined, "darwin-x64-xattr-fieldworkd.txt"), "com.apple.quarantine=0081;bad\n");
  expectStatus(quarantined, 1, "quarantine xattr output should fail", "must prove com.apple.quarantine is absent");

  const missingDoctor = path.join(temp, "missing-doctor");
  writeFixture(missingDoctor);
  fs.writeFileSync(path.join(missingDoctor, "doctor-trust.txt"), "Fieldwork doctor\nmacOS trust: fail (unsigned)\n");
  expectStatus(missingDoctor, 1, "missing doctor trust mode should fail", "doctor-trust.txt must show macOS trust passed");

  const missingDaemonPreflight = path.join(temp, "missing-daemon-preflight");
  writeFixture(missingDaemonPreflight);
  fs.writeFileSync(path.join(missingDaemonPreflight, "daemon-preflight.txt"), "fieldwork daemon status\nsocket: not reachable\n");
  expectStatus(
    missingDaemonPreflight,
    1,
    "missing daemon install preflight should fail",
    "daemon-preflight.txt must show fieldwork daemon install was run",
  );

  const secretLeak = path.join(temp, "secret-leak");
  writeFixture(secretLeak);
  fs.appendFileSync(path.join(secretLeak, "release-integrity.txt"), `${"APPLE_P12_" + "PASSWORD"}=${"super" + "secret"}\n`);
  expectStatus(secretLeak, 1, "raw Apple secret should fail", "must not contain raw Apple signing credentials");

  const failedIntegrity = path.join(temp, "failed-integrity");
  writeFixture(failedIntegrity);
  fs.appendFileSync(path.join(failedIntegrity, "release-integrity.txt"), "integrity verification failed\n");
  expectStatus(failedIntegrity, 1, "failed integrity evidence should fail", "release-integrity.txt must not contain failed npm trust output");

  const scopedPackage = path.join(temp, "scoped-package");
  writeFixture(scopedPackage);
  fs.appendFileSync(path.join(scopedPackage, "package-identity.txt"), "@fieldwork/cli@1.0.0\n");
  expectStatus(scopedPackage, 1, "legacy scoped package identity should fail", "must not use legacy scoped @fieldwork/* package names");

  const missingProvenance = path.join(temp, "missing-provenance");
  writeFixture(missingProvenance);
  fs.writeFileSync(path.join(missingProvenance, "release-integrity.txt"), "sha256 ok for darwin-arm64 and darwin-x64\n");
  expectStatus(
    missingProvenance,
    1,
    "release integrity without provenance verification should fail",
    "release-integrity.txt must name fieldwork-darwin-arm64 npm package or release archive",
  );

  const genericIntegrity = path.join(temp, "generic-integrity");
  writeFixture(genericIntegrity);
  fs.writeFileSync(
    path.join(genericIntegrity, "release-integrity.txt"),
    [
      "npm package integrity ok for darwin-arm64 and darwin-x64",
      "npm provenance ok for darwin-arm64 and darwin-x64",
      "",
    ].join("\n"),
  );
  expectStatus(
    genericIntegrity,
    1,
    "release integrity without Fieldwork package/archive names should fail",
    "release-integrity.txt must name fieldwork-darwin-arm64 npm package or release archive",
  );

  const missingPlatformProvenance = path.join(temp, "missing-platform-provenance");
  writeFixture(missingPlatformProvenance);
  fs.writeFileSync(
    path.join(missingPlatformProvenance, "release-integrity.txt"),
    [
      "sha256 ok: fieldwork-darwin-arm64",
      "sha256 ok: fieldwork-darwin-x64",
      "npm provenance ok: fieldwork-darwin-arm64@1.0.0 SLSA attestation verified",
      "",
    ].join("\n"),
  );
  expectStatus(
    missingPlatformProvenance,
    1,
    "release integrity without per-platform provenance should fail",
    "release-integrity.txt must prove npm or Sigstore provenance verification",
  );

  const missingFile = path.join(temp, "missing-file");
  writeFixture(missingFile);
  fs.rmSync(path.join(missingFile, "darwin-x64-xattr-fieldworkd.txt"));
  expectStatus(missingFile, 1, "missing xattr file should fail", "darwin-x64-xattr-fieldworkd.txt is missing");
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

console.log("macOS npm trust evidence verifier ok");

function writeFixture(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "package-identity.txt"),
    [
      "npm package metadata: installed fieldwork package.json",
      "fieldwork@1.0.0",
      "fieldwork-darwin-arm64@1.0.0",
      "fieldwork-darwin-x64@1.0.0",
      "fieldwork-linux-arm64@1.0.0",
      "fieldwork-linux-x64@1.0.0",
      "bin/fieldwork=bin/fieldwork",
      "bin/fieldworkd=bin/fieldworkd",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(dir, "release-integrity.txt"),
    [
      "npm package integrity ok: package-lock dist.integrity entries verified",
      "sha256 ok: fieldwork-darwin-arm64",
      "sha256 ok: fieldwork-darwin-x64",
      "npm provenance ok: fieldwork-darwin-arm64@1.0.0 SLSA attestation verified",
      "npm provenance ok: fieldwork-darwin-x64@1.0.0 SLSA attestation verified",
      "",
    ].join("\n"),
  );
  for (const platform of platforms) {
    fs.writeFileSync(path.join(dir, `${platform}-trust.txt`), `macOS npm trust ok: /tmp/${platform}\n`);
    for (const binary of binaries) {
      fs.writeFileSync(path.join(dir, `${platform}-codesign-${binary}.txt`), codesign({ signature: "adhoc", binary }));
      fs.writeFileSync(path.join(dir, `${platform}-xattr-${binary}.txt`), `no com.apple.quarantine xattr on /tmp/${platform}/${binary}\n`);
    }
  }
  fs.writeFileSync(
    path.join(dir, "doctor-trust.txt"),
    [
      "Fieldwork doctor",
      "version: 1.0.0",
      "cli: ok (/usr/local/bin/fieldwork)",
      "daemon binary: ok (/usr/local/bin/fieldworkd)",
      "macOS trust: ok (npm/ad-hoc/not-notarized (fieldwork and fieldworkd signed, executable, no quarantine))",
      "daemon connection: ok (reachable (/var/folders/test/fieldwork/control.sock))",
      "protocol: ok (contract v2)",
      "summary: ok",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(dir, "daemon-preflight.txt"),
    [
      "$ fieldwork daemon install",
      "launchd LaunchAgent installed at /Users/test/Library/LaunchAgents/app.fieldwork.daemon.plist",
      "$ fieldwork daemon status",
      "service: running",
      "socket: reachable (/var/folders/test/fieldwork/control.sock)",
      "",
    ].join("\n"),
  );
}

function codesign({ signature, binary }) {
  return [
    `Executable=/tmp/${binary}`,
    `Identifier=${binary}`,
    signature === "adhoc" ? "Signature=adhoc" : "Signature=unsigned",
    "TeamIdentifier=not set",
    "",
  ].join("\n");
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
