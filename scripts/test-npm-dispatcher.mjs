#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const metaDir = path.join(root, "packages/cli");
const dispatcher = path.join(metaDir, "bin/fieldwork");
const daemonDispatcher = path.join(metaDir, "bin/fieldworkd");
const platformCases = [
  { platform: "darwin", arch: "arm64", key: "darwin-arm64" },
  { platform: "darwin", arch: "x64", key: "darwin-x64" },
  { platform: "linux", arch: "arm64", key: "linux-arm64" },
  { platform: "linux", arch: "x64", key: "linux-x64" },
];

for (const platformCase of platformCases) {
  verifyDispatcher(platformCase);
  verifyPostinstallSwap(platformCase);
}

verifyDispatcherSpawnError(platformCases[0]);

fs.rmSync(path.join(metaDir, "node_modules"), { recursive: true, force: true });
let result = spawnSync(process.execPath, [dispatcher], {
  cwd: root,
  encoding: "utf8",
});
assert(result.status === 1, "dispatcher should fail clearly when optional dependency is omitted");
assert(result.stderr.includes("--omit=optional"), "dispatcher should mention --omit=optional");

result = spawnSync(process.execPath, [daemonDispatcher], {
  cwd: root,
  encoding: "utf8",
});
assert(result.status === 1, "fieldworkd dispatcher should fail clearly when optional dependency is omitted");
assert(result.stderr.includes("--omit=optional"), "fieldworkd dispatcher should mention --omit=optional");

const unsupported = spawnSync(process.execPath, [dispatcher], {
  cwd: root,
  encoding: "utf8",
  env: { ...process.env, FIELDWORK_NPM_PLATFORM: "win32", FIELDWORK_NPM_ARCH: "x64" },
});
assert(unsupported.status === 1, "unsupported host should exit 1");
assert(unsupported.stderr.includes("WSL2"), "unsupported Windows message should mention WSL2");

const unsupportedDaemon = spawnSync(process.execPath, [daemonDispatcher], {
  cwd: root,
  encoding: "utf8",
  env: { ...process.env, FIELDWORK_NPM_PLATFORM: "win32", FIELDWORK_NPM_ARCH: "x64" },
});
assert(unsupportedDaemon.status === 1, "unsupported host should exit 1 for fieldworkd");
assert(unsupportedDaemon.stderr.includes("WSL2"), "unsupported Windows fieldworkd message should mention WSL2");

console.log(`npm dispatcher fallback and postinstall swap ok for ${platformCases.map((value) => value.key).join(", ")} (host ${os.platform()} ${os.arch()})`);

function verifyDispatcher({ platform, arch, key }) {
  const fakePackageDir = path.join(metaDir, "node_modules", `fieldwork-${key}`);
  fs.rmSync(path.join(metaDir, "node_modules"), { recursive: true, force: true });
  fs.mkdirSync(path.join(fakePackageDir, "bin"), { recursive: true });
  fs.writeFileSync(
    path.join(fakePackageDir, "package.json"),
    JSON.stringify({ name: `fieldwork-${key}`, version: "0.0.0-test" }),
  );
  fs.writeFileSync(
    path.join(fakePackageDir, "bin/fieldwork"),
    "#!/usr/bin/env node\nconsole.log(['fake-fieldwork', process.env.FIELDWORK_CLI_BIN_NAME || '', ...process.argv.slice(2)].join(' ').trim());\n",
  );
  fs.writeFileSync(
    path.join(fakePackageDir, "bin/fieldworkd"),
    "#!/usr/bin/env node\nconsole.log('fake-fieldworkd ' + process.argv.slice(2).join(' '));\n",
  );
  fs.chmodSync(path.join(fakePackageDir, "bin/fieldwork"), 0o755);
  fs.chmodSync(path.join(fakePackageDir, "bin/fieldworkd"), 0o755);

  let result = spawnSync(process.execPath, [dispatcher, "alpha", "beta"], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      FIELDWORK_NPM_PLATFORM: platform,
      FIELDWORK_NPM_ARCH: arch,
    },
  });
  assert(result.status === 0, `${key} dispatcher should exit 0, got ${result.status}\n${result.stderr}`);
  assert(result.stdout.trim() === "fake-fieldwork fieldwork alpha beta", `unexpected ${key} dispatcher stdout: ${result.stdout}`);

  const aliasTmp = fs.mkdtempSync(path.join(os.tmpdir(), "fieldwork-fw-alias-"));
  try {
    const fwAlias = path.join(aliasTmp, "fw");
    fs.symlinkSync(dispatcher, fwAlias);
    for (const aliasCase of [
      { name: "smart default", args: [], stdout: "fake-fieldwork fw" },
      { name: "pair", args: ["pair"], stdout: "fake-fieldwork fw pair" },
      {
        name: "named-session shortcut",
        args: ["refactoringjob"],
        stdout: "fake-fieldwork fw refactoringjob",
      },
      { name: "completion alias", args: ["completion", "bash"], stdout: "fake-fieldwork fw completion bash" },
    ]) {
      result = spawnSync(process.execPath, [fwAlias, ...aliasCase.args], {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          FIELDWORK_NPM_PLATFORM: platform,
          FIELDWORK_NPM_ARCH: arch,
        },
      });
      assert(
        result.status === 0,
        `${key} fw alias should exit 0 for ${aliasCase.name}, got ${result.status}\n${result.stderr}`,
      );
      assert(
        result.stdout.trim() === aliasCase.stdout,
        `unexpected ${key} fw alias ${aliasCase.name} stdout: ${result.stdout}`,
      );
    }
  } finally {
    fs.rmSync(aliasTmp, { recursive: true, force: true });
  }

  result = spawnSync(process.execPath, [daemonDispatcher, "--foreground"], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      FIELDWORK_NPM_PLATFORM: platform,
      FIELDWORK_NPM_ARCH: arch,
    },
  });
  assert(result.status === 0, `${key} fieldworkd dispatcher should exit 0, got ${result.status}\n${result.stderr}`);
  assert(result.stdout.trim() === "fake-fieldworkd --foreground", `unexpected ${key} fieldworkd dispatcher stdout: ${result.stdout}`);
}

function verifyPostinstallSwap({ platform, arch, key }) {
  const installTmp = fs.mkdtempSync(path.join(os.tmpdir(), "fieldwork-install-"));
  try {
    fs.mkdirSync(path.join(installTmp, "bin"), { recursive: true });
    fs.copyFileSync(path.join(metaDir, "install.js"), path.join(installTmp, "install.js"));
    fs.writeFileSync(path.join(installTmp, "bin/fieldwork"), "#!/usr/bin/env node\n");
    fs.writeFileSync(path.join(installTmp, "bin/fieldworkd"), "#!/usr/bin/env node\n");
    const platformBin = path.join(installTmp, "node_modules", `fieldwork-${key}`, "bin");
    fs.mkdirSync(platformBin, { recursive: true });
    fs.writeFileSync(path.join(platformBin, "fieldwork"), `native-fieldwork-${key}\n`);
    fs.writeFileSync(path.join(platformBin, "fieldworkd"), `native-fieldworkd-${key}\n`);

    const result = spawnSync(process.execPath, [path.join(installTmp, "install.js")], {
      cwd: installTmp,
      encoding: "utf8",
      env: {
        ...process.env,
        FIELDWORK_NPM_PLATFORM: platform,
        FIELDWORK_NPM_ARCH: arch,
      },
    });
    assert(result.status === 0, `${key} install.js should exit 0, got ${result.status}\n${result.stderr}`);
    assert(
      fs.readFileSync(path.join(installTmp, "bin/fieldwork"), "utf8") === `native-fieldwork-${key}\n`,
      `${key} install.js should copy fieldwork`,
    );
    assert(
      fs.readFileSync(path.join(installTmp, "bin/fieldworkd"), "utf8") === `native-fieldworkd-${key}\n`,
      `${key} install.js should copy fieldworkd`,
    );
    assert((fs.statSync(path.join(installTmp, "bin/fieldwork")).mode & 0o111) !== 0, `${key} fieldwork should be executable after install`);
    assert((fs.statSync(path.join(installTmp, "bin/fieldworkd")).mode & 0o111) !== 0, `${key} fieldworkd should be executable after install`);
  } finally {
    fs.rmSync(installTmp, { recursive: true, force: true });
  }
}

function verifyDispatcherSpawnError({ platform, arch, key }) {
  const fakePackageDir = path.join(metaDir, "node_modules", `fieldwork-${key}`);
  fs.rmSync(path.join(metaDir, "node_modules"), { recursive: true, force: true });
  fs.mkdirSync(path.join(fakePackageDir, "bin"), { recursive: true });
  fs.writeFileSync(
    path.join(fakePackageDir, "package.json"),
    JSON.stringify({ name: `fieldwork-${key}`, version: "0.0.0-test" }),
  );
  for (const name of ["fieldwork", "fieldworkd"]) {
    fs.writeFileSync(path.join(fakePackageDir, "bin", name), "#!/usr/bin/env node\n");
    fs.chmodSync(path.join(fakePackageDir, "bin", name), 0o644);
  }

  let result = spawnSync(process.execPath, [dispatcher], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      FIELDWORK_NPM_PLATFORM: platform,
      FIELDWORK_NPM_ARCH: arch,
    },
  });
  assert(result.status === 1, `${key} dispatcher should fail clearly on a non-executable native binary`);
  assert(result.stderr.includes("failed to start native binary"), `${key} dispatcher should report spawn failure`);

  result = spawnSync(process.execPath, [daemonDispatcher], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      FIELDWORK_NPM_PLATFORM: platform,
      FIELDWORK_NPM_ARCH: arch,
    },
  });
  assert(result.status === 1, `${key} fieldworkd dispatcher should fail clearly on a non-executable native binary`);
  assert(result.stderr.includes("failed to start native binary"), `${key} fieldworkd dispatcher should report spawn failure`);
}

function assert(condition, message) {
  if (!condition) {
    console.error(message);
    process.exit(1);
  }
}
