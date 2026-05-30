#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const verifier = path.join(root, "scripts/verify-macos-signing.mjs");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "fieldwork-macos-npm-trust-test-"));

try {
  const binDir = path.join(temp, "bin");
  const artifactDir = path.join(temp, "artifact");
  fs.mkdirSync(binDir);
  fs.mkdirSync(artifactDir);
  fs.writeFileSync(path.join(binDir, "tar"), script("exec /usr/bin/tar \"$@\"\n"), { mode: 0o755 });
  writeArtifact(artifactDir, 0o755);

  writeTools(binDir, { signature: "adhoc", quarantined: false });
  expectStatus(artifactDir, 0, "valid ad-hoc npm trust fixture should pass", "macOS npm trust ok");

  writeTools(binDir, { signature: "developer-id", quarantined: false });
  expectStatus(artifactDir, 0, "valid Developer ID fixture should also pass", "macOS npm trust ok");

  writeTools(binDir, { signature: "unsigned", quarantined: false });
  expectStatus(artifactDir, 1, "unsigned fixture should fail", "must have an ad-hoc or Developer ID code signature");

  writeTools(binDir, { signature: "adhoc", quarantined: true });
  expectStatus(artifactDir, 1, "quarantined fixture should fail", "must not carry com.apple.quarantine");

  writeTools(binDir, { signature: "adhoc", quarantined: false });
  fs.chmodSync(path.join(artifactDir, "fieldworkd"), 0o644);
  expectStatus(artifactDir, 1, "non-executable daemon should fail", "fieldworkd must be executable");
  fs.chmodSync(path.join(artifactDir, "fieldworkd"), 0o755);

  const missingCli = path.join(temp, "missing-cli");
  fs.mkdirSync(missingCli);
  fs.writeFileSync(path.join(missingCli, "fieldworkd"), "fake daemon\n", { mode: 0o755 });
  expectStatus(missingCli, 1, "archive/directory missing CLI should fail", "exactly one fieldwork binary");

  const singleDaemon = path.join(artifactDir, "fieldworkd");
  expectStatus(singleDaemon, 0, "single fieldworkd binary should be accepted", "macOS npm trust ok");
} finally {
  fs.rmSync(temp, { force: true, recursive: true });
}

console.log("macOS npm trust verifier ok");

function writeArtifact(dir, mode) {
  fs.writeFileSync(path.join(dir, "fieldwork"), "fake cli\n", { mode });
  fs.writeFileSync(path.join(dir, "fieldworkd"), "fake daemon\n", { mode });
}

function writeTools(binDir, options) {
  const signature =
    options.signature === "adhoc"
      ? "Signature=adhoc\nTeamIdentifier=not set"
      : options.signature === "developer-id"
        ? "Authority=Developer ID Application: Fieldwork Test (ABCDE12345)\nTeamIdentifier=ABCDE12345"
        : "Signature=unsigned\nTeamIdentifier=not set";
  fs.writeFileSync(
    path.join(binDir, "codesign"),
    script(`case "$1" in
  --verify)
    ${options.signature === "unsigned" ? "exit 1" : "exit 0"}
    ;;
  --display)
    cat >&2 <<'OUT'
Executable=/tmp/fieldwork
Identifier=fieldwork
${signature}
OUT
    exit 0
    ;;
esac
exit 2
`),
    { mode: 0o755 },
  );

  fs.writeFileSync(
    path.join(binDir, "xattr"),
    script(`${options.quarantined ? "printf '0081;fieldwork quarantine\\n'; exit 0" : "exit 1"}\n`),
    { mode: 0o755 },
  );
}

function expectStatus(input, expectedStatus, message, expectedOutput) {
  const result = spawnSync(process.execPath, [verifier, input], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      FIELDWORK_TEST_DARWIN: "1",
      PATH: `${path.join(temp, "bin")}${path.delimiter}${process.env.PATH}`,
    },
  });
  if (result.status !== expectedStatus) {
    throw new Error(`${message}: exited ${result.status}, expected ${expectedStatus}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  if (expectedOutput && !`${result.stdout}\n${result.stderr}`.includes(expectedOutput)) {
    throw new Error(`${message}: missing output ${JSON.stringify(expectedOutput)}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
}

function script(body) {
  return `#!/bin/sh\n${body}`;
}
