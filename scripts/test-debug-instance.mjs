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

  const startOutput = run("bash", ["-lc", "scripts/debug-instance.sh --help"], env);
  assert(startOutput.includes("FIELDWORK_DEBUG_TMUX_SESSION"), "help output must document custom session override");
  assert(startOutput.includes("FIELDWORK_DEBUG_ROOT"), "help output must document custom root override");
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
