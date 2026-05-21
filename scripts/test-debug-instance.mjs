#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fieldwork-debug-env-"));

try {
  const env = {
    ...process.env,
    FIELDWORK_DEBUG_TMUX_SESSION: "fieldwork-debug-test",
    FIELDWORK_DEBUG_ROOT: tempRoot,
  };

  const output = run("bash", ["-lc", 'eval "$(scripts/debug-instance.sh env)"; node - <<\'NODE\'\nconsole.log(JSON.stringify({\n  session: process.env.FIELDWORK_DEBUG_TMUX_SESSION,\n  root: process.env.FIELDWORK_DEBUG_ROOT,\n  home: process.env.HOME,\n  runtime: process.env.XDG_RUNTIME_DIR,\n  config: process.env.XDG_CONFIG_HOME,\n  state: process.env.XDG_STATE_HOME,\n  cache: process.env.XDG_CACHE_HOME,\n  updateCheck: process.env.FIELDWORK_DISABLE_UPDATE_CHECK,\n  encryption: process.env.FIELDWORK_SCROLLBACK_ENCRYPTION_ENABLED,\n  path: process.env.PATH,\n}));\nNODE'], env);
  const parsed = JSON.parse(output.trim());

  assert(parsed.session === "fieldwork-debug-test", "env output must preserve custom tmux session");
  assert(parsed.root === tempRoot, "env output must preserve custom state root");
  assert(parsed.home === path.join(tempRoot, "home"), "env output must set isolated HOME");
  assert(parsed.runtime === path.join(tempRoot, "runtime"), "env output must set isolated runtime dir");
  assert(parsed.config === path.join(tempRoot, "config"), "env output must set isolated config dir");
  assert(parsed.state === path.join(tempRoot, "state"), "env output must set isolated state dir");
  assert(parsed.cache === path.join(tempRoot, "cache"), "env output must set isolated cache dir");
  assert(parsed.updateCheck === "1", "env output must disable update checks");
  assert(parsed.encryption === "false", "env output must disable scrollback encryption only inside debug root");
  assert(parsed.path.split(path.delimiter)[0] === path.join(tempRoot, "bin"), "env output must prepend debug bin dir");

  const startOutput = run("scripts/debug-instance.sh", ["--help"], env);
  assert(startOutput.includes("FIELDWORK_DEBUG_TMUX_SESSION"), "help output must document custom session override");
  assert(startOutput.includes("FIELDWORK_DEBUG_ROOT"), "help output must document custom root override");

  const fakeBin = path.join(tempRoot, "fake-bin");
  const calls = path.join(tempRoot, "calls.log");
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.writeFileSync(
    path.join(fakeBin, "tmux"),
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'printf "tmux %s\\n" "$*" >> "$FIELDWORK_TEST_CALLS"',
      'if [[ "${1:-}" == "has-session" ]]; then exit 0; fi',
      'if [[ "${1:-}" == "show-environment" ]]; then echo "FIELDWORK_DEBUG_ROOT=$FIELDWORK_DEBUG_ROOT"; exit 0; fi',
      "exit 64",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(fakeBin, "cargo"),
    "#!/usr/bin/env bash\nprintf 'cargo %s\\n' \"$*\" >> \"$FIELDWORK_TEST_CALLS\"\nexit 0\n",
  );
  fs.chmodSync(path.join(fakeBin, "tmux"), 0o755);
  fs.chmodSync(path.join(fakeBin, "cargo"), 0o755);

  const existingOutput = run("scripts/debug-instance.sh", ["start"], {
    ...env,
    FIELDWORK_TEST_CALLS: calls,
    PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
  });
  assert(existingOutput.includes("already exists: fieldwork-debug-test"), "start must report an existing debug tmux session");
  assert(existingOutput.includes(`FIELDWORK_DEBUG_ROOT=${tempRoot}`), "start must report the existing debug root");
  const callsText = fs.readFileSync(calls, "utf8");
  assert(callsText.includes("tmux has-session"), "start must check tmux before reporting an existing session");
  assert(!callsText.includes("cargo "), "start must not run cargo build when the debug tmux session already exists");
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

console.log("debug instance env contract ok");

function run(command, args, env) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    env,
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  return result.stdout;
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
