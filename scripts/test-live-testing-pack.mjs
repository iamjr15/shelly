#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const node = process.execPath;
const scaffold = path.join(root, "scripts/create-live-testing-pack.mjs");
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fieldwork-live-testing-pack-"));

try {
  const fakeRepo = path.join(tmpRoot, "repo");
  const releaseDir = path.join(fakeRepo, "target", "release");
  fs.mkdirSync(releaseDir, { recursive: true });
  writeExecutable(path.join(releaseDir, "fieldwork"), `#!/usr/bin/env bash
if [[ -n "\${FW_PACK_TEST_LOG:-}" ]]; then
  printf 'fw:%s:%s\\n' "$(basename "$0")" "$*" >>"$FW_PACK_TEST_LOG"
fi
if [[ "\${1:-}" == "--help" ]]; then
  printf 'Usage: %s\\n' "$(basename "$0")"
elif [[ "\${1:-}" == "doctor" ]]; then
  printf 'doctor ok\\n'
else
  printf 'Usage: %s\\n' "$(basename "$0")"
fi
`);
  writeExecutable(path.join(releaseDir, "fieldworkd"), "#!/usr/bin/env bash\nprintf 'fieldworkd fake\\n'\n");

  const packDir = path.join(tmpRoot, "pack");
  const result = spawnSync(node, [scaffold, "--repo-root", fakeRepo, "--dir", packDir, "--quiet", "--print-dir"], {
    cwd: root,
    encoding: "utf8",
  });
  expectStatus(result, 0, "live-testing pack scaffold should succeed");
  expectEqual(result.stdout.trim(), packDir, "--print-dir should print only the pack path");

  for (const file of ["README.md", "manifest.json", "setup.sh", "preflight.sh"]) {
    expect(fs.existsSync(path.join(packDir, file)), `${file} should exist`);
  }
  for (const dir of ["bin", "evidence"]) {
    expect(fs.statSync(path.join(packDir, dir)).isDirectory(), `${dir} should be a directory`);
  }
  for (const file of ["fw", "fieldwork", "fieldworkd", "activate.sh", "manifest.json"]) {
    expect(fs.existsSync(path.join(packDir, "bin", file)), `bin/${file} should exist`);
  }
  for (const file of ["README.md", "manifest.json", "missing-files.txt", "capture-checklist.md", "preflight.sh"]) {
    expect(fs.existsSync(path.join(packDir, "evidence", file)), `evidence/${file} should exist`);
  }

  const manifest = JSON.parse(fs.readFileSync(path.join(packDir, "manifest.json"), "utf8"));
  expectEqual(manifest.schema, "fieldwork-live-testing-pack-v1", "manifest schema should be pinned");
  expectEqual(manifest.repoRoot, fakeRepo, "manifest should record source repo root");
  expectEqual(manifest.binDir, path.join(packDir, "bin"), "manifest should record bin dir");
  expectEqual(manifest.evidenceDir, path.join(packDir, "evidence"), "manifest should record evidence dir");

  const readme = fs.readFileSync(path.join(packDir, "README.md"), "utf8");
  for (const needle of [
    "does not create passing evidence",
    "source \"$FW_LIVE_PACK/setup.sh\"",
    "fw doctor",
    "pnpm check:live-testing-evidence",
    "does not replace npm package",
  ]) {
    expect(readme.includes(needle), `README should include ${needle}`);
  }

  const setup = fs.readFileSync(path.join(packDir, "setup.sh"), "utf8");
  expect(setup.includes("export FW_LIVE_PACK="), "setup should export FW_LIVE_PACK");
  expect(setup.includes("export FW_LIVE_BIN="), "setup should export FW_LIVE_BIN");
  expect(setup.includes("export FW_LIVE_DIR="), "setup should export FW_LIVE_DIR");
  expect(setup.includes('export PATH="$FW_LIVE_BIN:$PATH"'), "setup should add shim to PATH");
  expect((fs.statSync(path.join(packDir, "setup.sh")).mode & 0o700) === 0o700, "setup.sh should be owner-executable");
  expect((fs.statSync(path.join(packDir, "preflight.sh")).mode & 0o700) === 0o700, "preflight.sh should be owner-executable");

  const shellCheck = spawnSync("bash", ["-lc", `source ${shellQuote(path.join(packDir, "setup.sh"))}; fw --help; printf 'DIR=%s\\n' "$FW_LIVE_DIR"`], {
    cwd: root,
    encoding: "utf8",
  });
  expectStatus(shellCheck, 0, "setup should expose the fw alias");
  expect(shellCheck.stdout.includes("Usage: fw"), "setup should preserve fw argv0");
  expect(shellCheck.stdout.includes(`DIR=${path.join(packDir, "evidence")}`), "setup should export evidence directory");

  const preflight = fs.readFileSync(path.join(packDir, "preflight.sh"), "utf8");
  expect(preflight.includes("pnpm check:live-testing-readiness:local"), "preflight should run local readiness first");
  expect(preflight.includes("fw doctor"), "preflight should run fw doctor before direct-adb capture");
  expect(preflight.includes('"$FW_LIVE_DIR/preflight.sh"'), "preflight should delegate to evidence preflight");

  const fakeTools = path.join(tmpRoot, "tools");
  fs.mkdirSync(fakeTools);
  const preflightLog = path.join(tmpRoot, "preflight.log");
  writeExecutable(path.join(fakeTools, "pnpm"), `#!/usr/bin/env bash
printf 'pnpm:%s\\n' "$*" >>"$FW_PACK_TEST_LOG"
`);
  writeExecutable(path.join(packDir, "evidence", "preflight.sh"), `#!/usr/bin/env bash
printf 'evidence-preflight\\n' >>"$FW_PACK_TEST_LOG"
`);
  const preflightRun = spawnSync("bash", [path.join(packDir, "preflight.sh")], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      FIELDWORK_REPO_ROOT: fakeRepo,
      FW_PACK_TEST_LOG: preflightLog,
      PATH: `${fakeTools}:${process.env.PATH}`,
    },
  });
  expectStatus(preflightRun, 0, "top-level preflight should run with fake tools");
  expectEqual(
    fs.readFileSync(preflightLog, "utf8"),
    "pnpm:check:live-testing-readiness:local\nfw:fw:doctor\nevidence-preflight\n",
    "top-level preflight should run readiness, fw doctor, then evidence preflight",
  );

  const noForce = spawnSync(node, [scaffold, "--repo-root", fakeRepo, "--dir", packDir, "--quiet"], {
    cwd: root,
    encoding: "utf8",
  });
  expectStatus(noForce, 1, "non-empty pack should require --force");
  expect(noForce.stderr.includes("--force"), "non-empty pack failure should mention --force");

  const force = spawnSync(node, [scaffold, "--repo-root", fakeRepo, "--dir", packDir, "--force", "--quiet"], {
    cwd: root,
    encoding: "utf8",
  });
  expectStatus(force, 0, "--force should refresh the pack");

  console.log("live testing pack scaffold self-test ok");
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

function writeExecutable(filePath, contents) {
  fs.writeFileSync(filePath, contents, { mode: 0o700 });
  fs.chmodSync(filePath, 0o700);
}

function expectStatus(result, status, message) {
  if (result.status !== status) {
    throw new Error(`${message}: expected status ${status}, got ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
}

function expect(value, message) {
  if (!value) {
    throw new Error(message);
  }
}

function expectEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
