#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const scaffold = path.join(root, "scripts/create-android-release-evidence-pack.mjs");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "fieldwork-android-release-pack-"));
const packDir = path.join(temp, "pack");

const expectedDirs = [
  "00-release-signing",
  "01-release-install",
  "02-pair-flow",
  "03-session-subscription",
  "04-terminal-attach",
  "05-resize-detach",
  "06-biometric",
  "07-dogfood",
  "08-cold-start",
  "09-renderer-flood",
  "10-background-foreground",
  "11-network-reconnect",
  "12-restart-restore",
  "13-multisession",
  "14-fcm-push",
];

try {
  const create = run([scaffold, "--dir", packDir, "--quiet", "--print-dir"]);
  expect(create.status === 0, `pack scaffold should succeed: ${create.stderr}`);
  expectEqual(create.stdout.trim(), packDir, "--print-dir should print only the pack directory");

  for (const file of ["README.md", "manifest.json", "capture-order.md", "setup.sh", "readiness.sh", "verify.sh"]) {
    expect(fs.existsSync(path.join(packDir, file)), `${file} should exist in the pack`);
  }
  for (const file of ["fieldwork", "fw", "fieldworkd", "activate.sh", "manifest.json"]) {
    expect(fs.existsSync(path.join(packDir, "bin", file)), `bin/${file} should exist in the pack`);
  }

  const setupMode = fs.statSync(path.join(packDir, "setup.sh")).mode & 0o777;
  const readinessMode = fs.statSync(path.join(packDir, "readiness.sh")).mode & 0o777;
  const verifyMode = fs.statSync(path.join(packDir, "verify.sh")).mode & 0o777;
  expect((setupMode & 0o700) === 0o700, "setup.sh should be executable by the owner");
  expect((readinessMode & 0o700) === 0o700, "readiness.sh should be executable by the owner");
  expect((verifyMode & 0o700) === 0o700, "verify.sh should be executable by the owner");

  const manifest = JSON.parse(fs.readFileSync(path.join(packDir, "manifest.json"), "utf8"));
  expectEqual(manifest.schema, "fieldwork-android-release-evidence-pack-v1", "manifest schema should be pinned");
  expectEqual(manifest.binDir, path.join(packDir, "bin"), "manifest should record the command shim directory");
  expectEqual(manifest.scaffolds.bin, "scripts/create-live-testing-fw-shim.mjs", "manifest should record the fw shim scaffold");
  expectEqual(manifest.items.length, expectedDirs.length, "manifest should include every focused Android release evidence directory");

  for (const dir of expectedDirs) {
    const itemDir = path.join(packDir, dir);
    expect(fs.statSync(itemDir).isDirectory(), `${dir} should be created`);
    expect(fs.existsSync(path.join(itemDir, "manifest.json")), `${dir} should include its focused manifest`);
    expect(fs.existsSync(path.join(itemDir, "README.md")), `${dir} should include its focused README`);
    expect(
      manifest.items.some((item) => item.dir === dir && item.scaffold && item.verifier && item.packageCheck),
      `manifest should describe ${dir}`,
    );
  }

  const readme = fs.readFileSync(path.join(packDir, "README.md"), "utf8");
  expect(readme.includes("does not create or fabricate evidence"), "README should say the pack does not fabricate evidence");
  expect(readme.includes("source \"$FW_ANDROID_RELEASE_EVIDENCE_PACK/setup.sh\""), "README should tell operators to source setup.sh");
  expect(readme.includes("`fw`/`fieldworkd` shim on `PATH`"), "README should describe the command shim");
  expect(readme.includes("runs `fw doctor`"), "README should document the doctor preflight");
  expect(readme.includes("`--strict-release-device`"), "README should explain the strict release-install check");
  expect(readme.includes("`Fieldwork Release Smoke` signer"), "README should say the local smoke signer cannot satisfy the production pack");
  expect(readme.includes("pnpm check:android-release-readiness:local"), "README should include local readiness");
  expect(readme.includes("pnpm check:android-release-readiness"), "README should include strict readiness");
  expect(readme.includes("\"$FW_ANDROID_RELEASE_EVIDENCE_PACK/verify.sh\""), "README should include the verify-all helper");
  expect(readme.includes("strict release-install"), "README should say verify.sh keeps strict release-install");

  const setup = fs.readFileSync(path.join(packDir, "setup.sh"), "utf8");
  expect(setup.includes("FW_ANDROID_RELEASE_BIN"), "setup should export the release command shim directory");
  expect(setup.includes('PATH="$FW_ANDROID_RELEASE_BIN:$PATH"'), "setup should prepend the command shim to PATH");

  const readiness = fs.readFileSync(path.join(packDir, "readiness.sh"), "utf8");
  expect(readiness.includes('PATH="$FW_ANDROID_RELEASE_BIN:$PATH"'), "readiness should prepend the command shim to PATH");
  expect(readiness.includes("pnpm check:android-release-readiness:local"), "readiness should run Android release readiness");
  expect(readiness.includes("fw doctor"), "readiness should run fw doctor before capture");

  const verify = fs.readFileSync(path.join(packDir, "verify.sh"), "utf8");
  expect(verify.includes('PATH="$FW_ANDROID_RELEASE_BIN:$PATH"'), "verify should prepend the command shim to PATH");
  expect(verify.includes("pnpm check:android-release-signing-evidence"), "verify should include release signing");
  expect(verify.includes("pnpm check:android-release-install-evidence -- --strict-release-device"), "verify should include strict release install");
  expect(verify.includes("pnpm check:android-fcm-push-evidence"), "verify should include FCM push");

  const fakeTools = path.join(temp, "tools");
  fs.mkdirSync(fakeTools);
  const readinessLog = path.join(temp, "readiness.log");
  writeExecutable(path.join(fakeTools, "pnpm"), `#!/usr/bin/env bash
printf 'pnpm:%s\\n' "$*" >>"$FW_ANDROID_RELEASE_PACK_TEST_LOG"
`);
  writeExecutable(path.join(fakeTools, "fw"), `#!/usr/bin/env bash
printf 'fw:%s\\n' "$*" >>"$FW_ANDROID_RELEASE_PACK_TEST_LOG"
`);
  const readinessRun = spawnSync("bash", [path.join(packDir, "readiness.sh")], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      FIELDWORK_REPO_ROOT: root,
      FW_ANDROID_RELEASE_BIN: fakeTools,
      FW_ANDROID_RELEASE_PACK_TEST_LOG: readinessLog,
      PATH: `${fakeTools}:${process.env.PATH}`,
    },
  });
  expect(readinessRun.status === 0, `readiness should run with fake tools: ${readinessRun.stderr}`);
  expectEqual(
    fs.readFileSync(readinessLog, "utf8"),
    "pnpm:check:android-release-readiness:local\nfw:doctor\n",
    "readiness should run local readiness before fw doctor",
  );

  const verifyLog = path.join(temp, "verify.log");
  const verifyRun = spawnSync("bash", [path.join(packDir, "verify.sh")], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      FIELDWORK_REPO_ROOT: root,
      FW_ANDROID_RELEASE_BIN: fakeTools,
      FW_ANDROID_RELEASE_PACK_TEST_LOG: verifyLog,
      PATH: `${fakeTools}:${process.env.PATH}`,
    },
  });
  expect(verifyRun.status === 0, `verify should run with fake tools: ${verifyRun.stderr}`);
  const verifyLines = fs.readFileSync(verifyLog, "utf8").trim().split(/\r?\n/);
  expectEqual(verifyLines.length, expectedDirs.length, "verify should run one pnpm command per focused evidence directory");
  expect(
    verifyLines[0].includes("check:android-release-signing-evidence --") && verifyLines[0].includes("00-release-signing"),
    "verify should start with release signing",
  );
  expect(
    verifyLines[1].includes("check:android-release-install-evidence -- --strict-release-device") &&
      verifyLines[1].includes("01-release-install/apks") &&
      verifyLines[1].includes("01-release-install/install"),
    "verify should run strict release install second",
  );
  expect(
    verifyLines.at(-1).includes("check:android-fcm-push-evidence --") && verifyLines.at(-1).includes("14-fcm-push"),
    "verify should end with FCM push evidence",
  );

  const captureOrder = fs.readFileSync(path.join(packDir, "capture-order.md"), "utf8");
  expect(captureOrder.includes("pnpm check:android-release-signing-evidence"), "capture order should include release signing verifier");
  expect(captureOrder.includes("pnpm check:android-release-install-evidence -- --strict-release-device"), "capture order should include strict release install verifier");
  expect(captureOrder.includes("pnpm check:android-terminal-attach-evidence"), "capture order should include terminal attach verifier");
  expect(captureOrder.includes("pnpm check:android-fcm-push-evidence"), "capture order should include FCM push verifier");

  const repeatWithoutForce = run([scaffold, "--dir", packDir, "--quiet"]);
  expect(repeatWithoutForce.status !== 0, "non-empty pack should fail without --force");
  expect(repeatWithoutForce.stderr.includes("not empty"), "non-empty failure should explain --force");

  const forceRefresh = run([scaffold, "--dir", packDir, "--quiet", "--force"]);
  expect(forceRefresh.status === 0, `--force refresh should succeed: ${forceRefresh.stderr}`);

  console.log("Android release evidence pack scaffold self-test ok");
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

function run(args) {
  return spawnSync(process.execPath, args, {
    cwd: root,
    encoding: "utf8",
  });
}

function writeExecutable(filePath, contents) {
  fs.writeFileSync(filePath, contents, { mode: 0o700 });
  fs.chmodSync(filePath, 0o700);
}

function expect(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function expectEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
