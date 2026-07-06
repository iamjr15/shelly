// Shared helpers for the npm packaging test/smoke scripts. Every helper throws
// on failure (never process.exit) so callers keep their own finally-based
// cleanup semantics (temp dirs, restored platform bins).

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// Host package-manager env leaks (pnpm/npm wrappers) that would skew the
// isolated install runs. smoke-macos-daemon-launchd.sh unsets the same list by
// hand; keep them in sync.
export const NPM_CONFIG_KEYS_TO_STRIP = [
  "npm_config_supported_architectures",
  "npm_config_npm_globalconfig",
  "npm_config_verify_deps_before_run",
  "npm_config__jsr_registry",
];

export function cleanPackageManagerEnv(env) {
  const cleaned = { ...env };
  for (const key of NPM_CONFIG_KEYS_TO_STRIP) {
    delete cleaned[key];
  }
  return cleaned;
}

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
  if (result.error?.code === "ENOENT") {
    throw new Error(`${command} is required on PATH`);
  }
  if (result.error) {
    throw new Error(`${command} failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(`${command} ${args.join(" ")} failed with exit ${result.status}${output ? `\n${output}` : ""}`);
  }
  return result;
}

export function packPackage(npm, packageDir, packDir, options = {}) {
  const result = run(npm, ["pack", packageDir, "--pack-destination", packDir, "--json"], {
    env: cleanPackageManagerEnv(process.env),
    ...options,
  });
  let packs;
  try {
    packs = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`could not parse npm pack JSON for ${packageDir}: ${error.message}\n${result.stdout}`);
  }
  const filename = packs?.[0]?.filename;
  if (!filename) {
    throw new Error(`npm pack did not report a tarball filename for ${packageDir}`);
  }
  const tarball = path.join(packDir, filename);
  if (!fs.existsSync(tarball)) {
    throw new Error(`npm pack tarball missing: ${tarball}`);
  }
  return tarball;
}

export function requireExecutable(file) {
  if (!fs.existsSync(file)) {
    throw new Error(`expected executable is missing: ${file}`);
  }
  const stat = fs.statSync(file);
  if (!stat.isFile() && !stat.isSymbolicLink?.()) {
    throw new Error(`expected a file executable, got something else: ${file}`);
  }
  if ((stat.mode & 0o111) === 0) {
    throw new Error(`expected executable bit on ${file}`);
  }
}

export function assertIncludes(text, expected, label) {
  if (!text.includes(expected)) {
    throw new Error(`${label} must include ${JSON.stringify(expected)}, got:\n${text}`);
  }
}

export function assertExecutablePackFile(files, filePath, label) {
  const entry = files.get(filePath);
  if (!entry) {
    throw new Error(`${label} is missing ${filePath}`);
  }
  if ((entry.mode & 0o111) === 0) {
    throw new Error(`${label} ${filePath} is not executable`);
  }
}
