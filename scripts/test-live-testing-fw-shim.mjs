#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const node = process.execPath;
const scaffold = path.join(root, "scripts/create-live-testing-fw-shim.mjs");
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fieldwork-live-testing-fw-shim-"));

try {
  const fakeRepo = path.join(tmpRoot, "repo");
  const releaseDir = path.join(fakeRepo, "target", "release");
  fs.mkdirSync(releaseDir, { recursive: true });
  writeExecutable(path.join(releaseDir, "fieldwork"), "#!/usr/bin/env bash\nprintf 'Usage: %s\\n' \"$(basename \"$0\")\"\n");
  writeExecutable(path.join(releaseDir, "fieldworkd"), "#!/usr/bin/env bash\nprintf 'fieldworkd fake\\n'\n");

  const shimDir = path.join(tmpRoot, "shim");
  const result = spawnSync(node, [scaffold, "--repo-root", fakeRepo, "--dir", shimDir, "--quiet", "--print-dir"], {
    cwd: root,
    encoding: "utf8",
  });
  expectStatus(result, 0, "fw shim scaffold should succeed");
  expectEqual(result.stdout.trim(), shimDir, "--print-dir should print only the shim path");

  for (const file of ["README.md", "manifest.json", "activate.sh", "fieldwork", "fw", "fieldworkd"]) {
    expect(fs.existsSync(path.join(shimDir, file)), `${file} should exist`);
  }

  const manifest = JSON.parse(fs.readFileSync(path.join(shimDir, "manifest.json"), "utf8"));
  expectEqual(manifest.schema, "fieldwork-live-testing-fw-shim-v1", "manifest schema should be pinned");
  expectEqual(manifest.repoRoot, fakeRepo, "manifest should record source repo root");
  expectEqual(manifest.binaries.fw, path.join(releaseDir, "fieldwork"), "manifest should map fw to release fieldwork");
  expectDeepEqual(
    manifest.generatedFiles,
    ["README.md", "manifest.json", "activate.sh", "fieldwork", "fw", "fieldworkd"],
    "manifest should list generated files",
  );

  expectEqual(fs.readlinkSync(path.join(shimDir, "fw")), path.join(releaseDir, "fieldwork"), "fw should symlink to release fieldwork");
  expectEqual(fs.readlinkSync(path.join(shimDir, "fieldwork")), path.join(releaseDir, "fieldwork"), "fieldwork should symlink to release fieldwork");
  expectEqual(fs.readlinkSync(path.join(shimDir, "fieldworkd")), path.join(releaseDir, "fieldworkd"), "fieldworkd should symlink to release fieldworkd");

  const readme = fs.readFileSync(path.join(shimDir, "README.md"), "utf8");
  for (const needle of ["fw --help", "pnpm check:live-testing-readiness", "npm package", "release signing"]) {
    expect(readme.includes(needle), `README should include ${needle}`);
  }

  const activate = fs.readFileSync(path.join(shimDir, "activate.sh"), "utf8");
  expect(activate.includes("export PATH="), "activate.sh should export PATH");
  expect(activate.includes(shimDir), "activate.sh should include shim path");
  expect((fs.statSync(path.join(shimDir, "activate.sh")).mode & 0o700) === 0o700, "activate.sh should be owner-executable");

  const fwHelp = spawnSync("fw", ["--help"], {
    env: { ...process.env, PATH: `${shimDir}:${process.env.PATH}` },
    encoding: "utf8",
  });
  expectStatus(fwHelp, 0, "fw on shim path should execute");
  expect(fwHelp.stdout.includes("Usage: fw"), "fw should preserve invoked alias name");

  const fieldworkHelp = spawnSync("fieldwork", ["--help"], {
    env: { ...process.env, PATH: `${shimDir}:${process.env.PATH}` },
    encoding: "utf8",
  });
  expectStatus(fieldworkHelp, 0, "fieldwork on shim path should execute");
  expect(fieldworkHelp.stdout.includes("Usage: fieldwork"), "fieldwork should preserve invoked command name");

  const printExport = spawnSync(node, [scaffold, "--repo-root", fakeRepo, "--dir", path.join(tmpRoot, "export-shim"), "--quiet", "--print-export"], {
    cwd: root,
    encoding: "utf8",
  });
  expectStatus(printExport, 0, "--print-export should succeed");
  expect(printExport.stdout.includes("export PATH="), "--print-export should print shell export");
  expect(printExport.stdout.includes("/export-shim"), "--print-export should include generated path");

  const noForce = spawnSync(node, [scaffold, "--repo-root", fakeRepo, "--dir", shimDir, "--quiet"], {
    cwd: root,
    encoding: "utf8",
  });
  expectStatus(noForce, 1, "non-empty shim dir should require --force");
  expect(noForce.stderr.includes("--force"), "non-empty failure should mention --force");

  const force = spawnSync(node, [scaffold, "--repo-root", fakeRepo, "--dir", shimDir, "--force", "--quiet"], {
    cwd: root,
    encoding: "utf8",
  });
  expectStatus(force, 0, "--force should refresh shim");

  const missingRepo = path.join(tmpRoot, "missing-repo");
  fs.mkdirSync(path.join(missingRepo, "target", "release"), { recursive: true });
  const missing = spawnSync(node, [scaffold, "--repo-root", missingRepo, "--dir", path.join(tmpRoot, "missing-shim"), "--quiet"], {
    cwd: root,
    encoding: "utf8",
  });
  expectStatus(missing, 1, "missing release binaries should fail");
  expect(missing.stderr.includes("missing release fieldwork binary"), "missing binary failure should be explicit");

  console.log("live testing fw shim scaffold self-test ok");
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

function expectDeepEqual(actual, expected, message) {
  expectEqual(JSON.stringify(actual), JSON.stringify(expected), message);
}
