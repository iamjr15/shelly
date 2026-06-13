#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const metaDir = path.join(root, "packages/cli");
const dispatcher = path.join(metaDir, "bin/shelly");
const daemonDispatcher = path.join(metaDir, "bin/shellyd");
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
assert(result.status === 1, "shellyd dispatcher should fail clearly when optional dependency is omitted");
assert(result.stderr.includes("--omit=optional"), "shellyd dispatcher should mention --omit=optional");

const unsupported = spawnSync(process.execPath, [dispatcher], {
  cwd: root,
  encoding: "utf8",
  env: { ...process.env, SHELLY_NPM_PLATFORM: "win32", SHELLY_NPM_ARCH: "x64" },
});
assert(unsupported.status === 1, "unsupported host should exit 1");
assert(unsupported.stderr.includes("WSL2"), "unsupported Windows message should mention WSL2");

const unsupportedDaemon = spawnSync(process.execPath, [daemonDispatcher], {
  cwd: root,
  encoding: "utf8",
  env: { ...process.env, SHELLY_NPM_PLATFORM: "win32", SHELLY_NPM_ARCH: "x64" },
});
assert(unsupportedDaemon.status === 1, "unsupported host should exit 1 for shellyd");
assert(unsupportedDaemon.stderr.includes("WSL2"), "unsupported Windows shellyd message should mention WSL2");

console.log(`npm dispatcher fallback and postinstall swap ok for ${platformCases.map((value) => value.key).join(", ")} (host ${os.platform()} ${os.arch()})`);

function verifyDispatcher({ platform, arch, key }) {
  const fakePackageDir = path.join(metaDir, "node_modules", `shellykit-${key}`);
  fs.rmSync(path.join(metaDir, "node_modules"), { recursive: true, force: true });
  fs.mkdirSync(path.join(fakePackageDir, "bin"), { recursive: true });
  fs.writeFileSync(
    path.join(fakePackageDir, "package.json"),
    JSON.stringify({ name: `shellykit-${key}`, version: "0.0.0-test" }),
  );
  fs.writeFileSync(
    path.join(fakePackageDir, "bin/shelly"),
    "#!/usr/bin/env node\nconsole.log(['fake-shelly', process.env.SHELLY_CLI_BIN_NAME || '', ...process.argv.slice(2)].join(' ').trim());\n",
  );
  fs.writeFileSync(
    path.join(fakePackageDir, "bin/shellyd"),
    "#!/usr/bin/env node\nconsole.log('fake-shellyd ' + process.argv.slice(2).join(' '));\n",
  );
  fs.chmodSync(path.join(fakePackageDir, "bin/shelly"), 0o755);
  fs.chmodSync(path.join(fakePackageDir, "bin/shellyd"), 0o755);

  let result = spawnSync(process.execPath, [dispatcher, "alpha", "beta"], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      SHELLY_NPM_PLATFORM: platform,
      SHELLY_NPM_ARCH: arch,
    },
  });
  assert(result.status === 0, `${key} dispatcher should exit 0, got ${result.status}\n${result.stderr}`);
  assert(result.stdout.trim() === "fake-shelly shelly alpha beta", `unexpected ${key} dispatcher stdout: ${result.stdout}`);

  result = spawnSync(process.execPath, [daemonDispatcher, "--foreground"], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      SHELLY_NPM_PLATFORM: platform,
      SHELLY_NPM_ARCH: arch,
    },
  });
  assert(result.status === 0, `${key} shellyd dispatcher should exit 0, got ${result.status}\n${result.stderr}`);
  assert(result.stdout.trim() === "fake-shellyd --foreground", `unexpected ${key} shellyd dispatcher stdout: ${result.stdout}`);
}

function verifyPostinstallSwap({ platform, arch, key }) {
  const installTmp = fs.mkdtempSync(path.join(os.tmpdir(), "shelly-install-"));
  try {
    fs.mkdirSync(path.join(installTmp, "bin"), { recursive: true });
    fs.copyFileSync(path.join(metaDir, "install.js"), path.join(installTmp, "install.js"));
    fs.writeFileSync(path.join(installTmp, "bin/shelly"), "#!/usr/bin/env node\n");
    fs.writeFileSync(path.join(installTmp, "bin/shellyd"), "#!/usr/bin/env node\n");
    const platformBin = path.join(installTmp, "node_modules", `shellykit-${key}`, "bin");
    fs.mkdirSync(platformBin, { recursive: true });
    fs.writeFileSync(path.join(platformBin, "shelly"), `native-shellykit-${key}\n`);
    fs.writeFileSync(path.join(platformBin, "shellyd"), `native-shellyd-${key}\n`);
    const trustLog = path.join(installTmp, "macos-trust.jsonl");
    const fakeTools = path.join(installTmp, "fake-tools");
    fs.mkdirSync(fakeTools, { recursive: true });
    writeFakeMacTrustTool(fakeTools, "codesign");
    writeFakeMacTrustTool(fakeTools, "xattr");

    const result = spawnSync(process.execPath, [path.join(installTmp, "install.js")], {
      cwd: installTmp,
      encoding: "utf8",
      env: {
        ...process.env,
        SHELLY_NPM_PLATFORM: platform,
        SHELLY_NPM_ARCH: arch,
        SHELLY_TEST_MACOS_TRUST_LOG: trustLog,
        PATH: `${fakeTools}${path.delimiter}${process.env.PATH || ""}`,
      },
    });
    assert(result.status === 0, `${key} install.js should exit 0, got ${result.status}\n${result.stderr}`);
    assert(
      fs.readFileSync(path.join(installTmp, "bin/shelly"), "utf8") === `native-shellykit-${key}\n`,
      `${key} install.js should copy shelly`,
    );
    assert(
      fs.readFileSync(path.join(installTmp, "bin/shellyd"), "utf8") === `native-shellyd-${key}\n`,
      `${key} install.js should copy shellyd`,
    );
    assert((fs.statSync(path.join(installTmp, "bin/shelly")).mode & 0o111) !== 0, `${key} shelly should be executable after install`);
    assert((fs.statSync(path.join(installTmp, "bin/shellyd")).mode & 0o111) !== 0, `${key} shellyd should be executable after install`);
    const trustCalls = readTrustCalls(trustLog);
    if (platform === "darwin") {
      const installedShelly = fs.realpathSync(path.join(installTmp, "bin/shelly"));
      const installedDaemon = fs.realpathSync(path.join(installTmp, "bin/shellyd"));
      assert(trustCalls.length === 4, `${key} install.js should run macOS trust prep for both binaries`);
      assertToolCall(trustCalls[0], "codesign", ["--force", "--sign", "-", installedShelly], `${key} shelly codesign`);
      assertToolCall(trustCalls[1], "xattr", ["-d", "com.apple.quarantine", installedShelly], `${key} shelly quarantine cleanup`);
      assertToolCall(trustCalls[2], "codesign", ["--force", "--sign", "-", installedDaemon], `${key} shellyd codesign`);
      assertToolCall(trustCalls[3], "xattr", ["-d", "com.apple.quarantine", installedDaemon], `${key} shellyd quarantine cleanup`);
    } else {
      assert(trustCalls.length === 0, `${key} install.js must not run macOS trust tools on non-Darwin hosts`);
    }
  } finally {
    fs.rmSync(installTmp, { recursive: true, force: true });
  }
}

function verifyDispatcherSpawnError({ platform, arch, key }) {
  const fakePackageDir = path.join(metaDir, "node_modules", `shellykit-${key}`);
  fs.rmSync(path.join(metaDir, "node_modules"), { recursive: true, force: true });
  fs.mkdirSync(path.join(fakePackageDir, "bin"), { recursive: true });
  fs.writeFileSync(
    path.join(fakePackageDir, "package.json"),
    JSON.stringify({ name: `shellykit-${key}`, version: "0.0.0-test" }),
  );
  for (const name of ["shelly", "shellyd"]) {
    fs.writeFileSync(path.join(fakePackageDir, "bin", name), "#!/usr/bin/env node\n");
    fs.chmodSync(path.join(fakePackageDir, "bin", name), 0o644);
  }

  let result = spawnSync(process.execPath, [dispatcher], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      SHELLY_NPM_PLATFORM: platform,
      SHELLY_NPM_ARCH: arch,
    },
  });
  assert(result.status === 1, `${key} dispatcher should fail clearly on a non-executable native binary`);
  assert(result.stderr.includes("failed to start native binary"), `${key} dispatcher should report spawn failure`);

  result = spawnSync(process.execPath, [daemonDispatcher], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      SHELLY_NPM_PLATFORM: platform,
      SHELLY_NPM_ARCH: arch,
    },
  });
  assert(result.status === 1, `${key} shellyd dispatcher should fail clearly on a non-executable native binary`);
  assert(result.stderr.includes("failed to start native binary"), `${key} shellyd dispatcher should report spawn failure`);
}

function assert(condition, message) {
  if (!condition) {
    console.error(message);
    process.exit(1);
  }
}

function writeFakeMacTrustTool(dir, name) {
  const toolPath = path.join(dir, name);
  fs.writeFileSync(
    toolPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
if (process.env.SHELLY_TEST_MACOS_TRUST_LOG) {
  fs.appendFileSync(
    process.env.SHELLY_TEST_MACOS_TRUST_LOG,
    JSON.stringify({ tool: path.basename(process.argv[1]), args: process.argv.slice(2) }) + "\\n",
  );
}
process.exit(0);
`,
  );
  fs.chmodSync(toolPath, 0o755);
}

function readTrustCalls(logPath) {
  if (!fs.existsSync(logPath)) {
    return [];
  }
  return fs
    .readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function assertToolCall(call, tool, args, label) {
  assert(call?.tool === tool, `${label} should call ${tool}, got ${call?.tool}`);
  assert(
    JSON.stringify(call.args) === JSON.stringify(args),
    `${label} should use args ${JSON.stringify(args)}, got ${JSON.stringify(call.args)}`,
  );
}
