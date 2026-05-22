#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const verifier = path.join(root, "scripts/verify-macos-signing.mjs");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "fieldwork-macos-signing-test-"));

try {
  const binDir = path.join(temp, "bin");
  const artifactDir = path.join(temp, "artifact");
  const fakeFieldworkd = path.join(artifactDir, "fieldworkd");
  fs.mkdirSync(binDir);
  fs.mkdirSync(artifactDir);
  fs.writeFileSync(fakeFieldworkd, "fake daemon\n", { mode: 0o755 });
  fs.writeFileSync(path.join(binDir, "tar"), script("exec /usr/bin/tar \"$@\"\n"), { mode: 0o755 });

  writeTools(binDir, { signed: true, runtime: true, notarized: true });
  expectStatus(fakeFieldworkd, 0, "valid signing fixture should pass", "macOS signing ok");

  writeTools(binDir, { signed: false, runtime: true, notarized: true });
  expectStatus(fakeFieldworkd, 1, "unsigned fixture should fail", "Developer ID Application");

  writeTools(binDir, { signed: true, runtime: false, notarized: true });
  expectStatus(fakeFieldworkd, 1, "missing hardened runtime should fail", "hardened runtime");

  writeTools(binDir, { signed: true, runtime: true, notarized: false });
  expectStatus(fakeFieldworkd, 1, "non-notarized fixture should fail", "notarized Developer ID");

  writeTools(binDir, { signed: true, runtime: true, notarized: true });
  fs.renameSync(fakeFieldworkd, path.join(artifactDir, "fieldworkd.real"));
  expectStatus(path.join(artifactDir, "fieldworkd.real"), 1, "non-daemon binary name should fail", "only accepts the daemon binary");
} finally {
  fs.rmSync(temp, { force: true, recursive: true });
}

console.log("macOS signing verifier ok");

function writeTools(binDir, options) {
  const authority = options.signed ? "Authority=Developer ID Application: Fieldwork Test (ABCDE12345)" : "Authority=Ad Hoc";
  const runtime = options.runtime ? "Runtime Version=15.0.0\nflags=0x10000(runtime)" : "flags=0x0";
  fs.writeFileSync(
    path.join(binDir, "codesign"),
    script(`case "$1" in
  --verify)
    exit 0
    ;;
  --display)
    cat >&2 <<'OUT'
Executable=/tmp/fieldworkd
Identifier=fieldworkd
${authority}
TeamIdentifier=ABCDE12345
${runtime}
OUT
    exit 0
    ;;
esac
exit 2
`),
    { mode: 0o755 },
  );

  const source = options.notarized ? "source=Notarized Developer ID" : "source=Developer ID";
  fs.writeFileSync(
    path.join(binDir, "spctl"),
    script(`printf '%s: accepted\\n' "$4"
printf '${source}\\n'
`),
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
