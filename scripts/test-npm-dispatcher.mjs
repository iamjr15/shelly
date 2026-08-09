#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn, spawnSync } from "node:child_process";

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
}

verifyDispatcherSpawnError(platformCases[0]);

if (process.platform !== "win32") {
  await verifySignalPassthrough(platformCases[0]);
}

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

console.log(`npm dispatchers ok for ${platformCases.map((value) => value.key).join(", ")} (host ${os.platform()} ${os.arch()})`);

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

// The dispatcher must die by the child's death signal (not exit 0) so shells
// and supervisors like launchd see faithful Ctrl+C/TERM status.
async function verifySignalPassthrough({ platform, arch, key }) {
  const fakePackageDir = path.join(metaDir, "node_modules", `shellykit-${key}`);
  fs.rmSync(path.join(metaDir, "node_modules"), { recursive: true, force: true });
  fs.mkdirSync(path.join(fakePackageDir, "bin"), { recursive: true });
  fs.writeFileSync(
    path.join(fakePackageDir, "package.json"),
    JSON.stringify({ name: `shellykit-${key}`, version: "0.0.0-test" }),
  );
  for (const name of ["shelly", "shellyd"]) {
    fs.writeFileSync(
      path.join(fakePackageDir, "bin", name),
      "#!/usr/bin/env node\nconsole.log('ready');\nsetTimeout(() => {}, 60000);\n",
    );
    fs.chmodSync(path.join(fakePackageDir, "bin", name), 0o755);
  }

  for (const binPath of [dispatcher, daemonDispatcher]) {
    const name = path.basename(binPath);
    const child = spawn(process.execPath, [binPath], {
      cwd: root,
      env: {
        ...process.env,
        SHELLY_NPM_PLATFORM: platform,
        SHELLY_NPM_ARCH: arch,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    await new Promise((resolve, reject) => {
      child.stdout.on("data", (chunk) => {
        if (chunk.toString().includes("ready")) {
          resolve();
        }
      });
      child.on("error", reject);
      child.on("exit", () => reject(new Error(`${name} dispatcher exited before its child was ready`)));
    });
    const [code, signal] = await new Promise((resolve) => {
      child.on("exit", (exitCode, exitSignal) => resolve([exitCode, exitSignal]));
      child.kill("SIGTERM");
    });
    assert(
      signal === "SIGTERM" && code === null,
      `${name} dispatcher must die by SIGTERM when its child does, got code=${code} signal=${signal}`,
    );
  }
}

function assert(condition, message) {
  if (!condition) {
    console.error(message);
    process.exit(1);
  }
}
