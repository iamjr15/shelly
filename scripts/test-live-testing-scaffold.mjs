#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const node = process.execPath;
const scaffold = path.join(root, "scripts/create-live-testing-evidence-dir.mjs");
const verifier = path.join(root, "scripts/verify-live-testing-evidence.mjs");

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fieldwork-live-scaffold-test-"));

try {
  const evidenceDir = path.join(tmpRoot, "evidence");
  const scaffoldResult = spawnSync(node, [scaffold, "--dir", evidenceDir, "--quiet", "--print-dir"], {
    cwd: root,
    encoding: "utf8",
  });
  expectStatus(scaffoldResult, 0, "scaffold should create an evidence directory");
  expectEqual(scaffoldResult.stdout.trim(), evidenceDir, "--print-dir should print only the evidence path");

  for (const file of ["README.md", "manifest.json", "missing-files.txt", "capture-checklist.md", "preflight.sh"]) {
    expect(fs.existsSync(path.join(evidenceDir, file)), `${file} should exist`);
  }

  const requiredFiles = readRequiredFiles();
  const manifest = JSON.parse(fs.readFileSync(path.join(evidenceDir, "manifest.json"), "utf8"));
  expectEqual(manifest.schema, "fieldwork-live-testing-evidence-v1", "manifest schema should be pinned");
  expectDeepEqual(manifest.requiredFiles, requiredFiles, "manifest should mirror verifier required files");
  expectDeepEqual(
    manifest.generatedFiles,
    ["README.md", "manifest.json", "missing-files.txt", "capture-checklist.md", "preflight.sh"],
    "manifest should list every scaffold-generated helper file",
  );
  expectEqual(
    fs.readFileSync(path.join(evidenceDir, "missing-files.txt"), "utf8"),
    `${requiredFiles.join("\n")}\n`,
    "missing-files.txt should list every required evidence file",
  );
  const checklist = fs.readFileSync(path.join(evidenceDir, "capture-checklist.md"), "utf8");
  expect(checklist.includes("Direct adb capture pattern"), "capture checklist should preserve direct adb capture workflow");
  expect(checklist.includes("preflight.sh"), "capture checklist should point to the direct adb preflight helper");
  expect(checklist.includes("adb exec-out screencap -p"), "capture checklist should include screenshot commands");
  expect(checklist.includes("adb shell uiautomator dump"), "capture checklist should include UI dump commands");
  expect(checklist.includes("adb logcat -d -b crash"), "capture checklist should include crash-buffer commands");
  expect(
    checklist.includes("After pre-pair evidence is captured"),
    "capture checklist should preserve the QR pairing order after pre-pair evidence capture",
  );
  assertPerStageAdbCaptureCommands(checklist);
  expect(
    checklist.includes('APPLICATION_ID = "app\\.fieldwork\\.android"'),
    "capture checklist should emit a copyable ripgrep regex for the Android application id",
  );
  expect(!checklist.includes('APPLICATION_ID = "app\\\\.fieldwork'), "capture checklist must not over-escape the application-id regex");
  expect(
    checklist.includes('DEBUG = Boolean\\.parseBoolean\\("true"\\)'),
    "capture checklist should emit a copyable ripgrep regex for the debug BuildConfig shape",
  );
  expect(!checklist.includes("Boolean\\\\.parseBoolean"), "capture checklist must not over-escape the debug BuildConfig regex");
  expect(
    checklist.includes('FIELDWORK_RELAY_CONTROL_URL = ""'),
    "capture checklist should require the debug relay-control override to be empty",
  );
  for (const file of requiredFiles) {
    expect(checklist.includes(`\`${file}\``), `capture checklist should mention ${file}`);
  }

  const readme = fs.readFileSync(path.join(evidenceDir, "README.md"), "utf8");
  expect(readme.includes("preflight.sh"), "README should explain the generated preflight helper");

  const preflight = fs.readFileSync(path.join(evidenceDir, "preflight.sh"), "utf8");
  expect(preflight.startsWith("#!/usr/bin/env bash"), "preflight helper should be a shell script");
  expect(preflight.includes("require_command fw"), "preflight should require the short fw alias");
  expect(preflight.includes("Usage: fw"), "preflight should verify fw resolves the short alias");
  expect(
    preflight.includes("Desktop Setup shim"),
    "preflight should tell source-checkout testers to create the temporary fw shim first",
  );
  expect(preflight.includes("adb devices -l | tee \"$adb_devices\""), "preflight should capture adb device evidence directly");
  expect(preflight.includes("adb shell pm path app.fieldwork.android"), "preflight should capture installed package path");
  expect(preflight.includes("adb shell dumpsys package app.fieldwork.android"), "preflight should capture installed package details");
  expect(preflight.includes("versionName=1\\.0"), "preflight should require the expected installed version name");
  expect(preflight.includes("connect one physical Android phone"), "preflight should reject emulator-only evidence");
  expect(
    preflight.includes("expected exactly one authorized physical Android device"),
    "preflight should reject ambiguous multi-device adb evidence",
  );
  expect(
    preflight.includes("live-test preflight ok: fw alias, exactly one physical adb device"),
    "preflight success message should confirm fw alias and single-device targeting",
  );
  expect(preflight.includes("FIELDWORK_BIOMETRIC_BYPASS = false"), "preflight should require the normal non-bypass debug build");
  expect(preflight.includes('FIELDWORK_RELAY_CONTROL_URL = ""'), "preflight should require the normal no-relay-override debug build");
  expect(
    (fs.statSync(path.join(evidenceDir, "preflight.sh")).mode & 0o700) === 0o700,
    "preflight helper should be executable by the owner",
  );

  for (const file of requiredFiles) {
    expect(!fs.existsSync(path.join(evidenceDir, file)), `scaffold must not fabricate ${file}`);
  }

  const verifyEmpty = spawnSync(node, [verifier, evidenceDir], { cwd: root, encoding: "utf8" });
  expectStatus(verifyEmpty, 1, "empty scaffold should not pass the evidence verifier");
  expect(
    verifyEmpty.stderr.includes("missing evidence file: buildconfig.txt"),
    "verifier should still require real buildconfig evidence",
  );

  const noForce = spawnSync(node, [scaffold, "--dir", evidenceDir, "--quiet"], { cwd: root, encoding: "utf8" });
  expectStatus(noForce, 1, "scaffold should not overwrite a non-empty directory without --force");
  expect(noForce.stderr.includes("rerun with --force"), "non-empty directory failure should explain --force");

  const force = spawnSync(node, [scaffold, "--dir", evidenceDir, "--force", "--quiet"], {
    cwd: root,
    encoding: "utf8",
  });
  expectStatus(force, 0, "scaffold should refresh metadata with --force");

  console.log("live testing evidence scaffold self-test ok");
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

function readRequiredFiles() {
  const source = fs.readFileSync(verifier, "utf8");
  const match = source.match(/const\s+requiredFiles\s*=\s*\[(?<body>[\s\S]*?)\];/);
  if (!match?.groups?.body) {
    throw new Error("cannot locate requiredFiles in verifier");
  }
  return [...match.groups.body.matchAll(/"([^"\n]+)"/g)].map((fileMatch) => fileMatch[1]);
}

function assertPerStageAdbCaptureCommands(checklist) {
  const prefixes = [
    "locked",
    "biometric",
    "dashboard",
    "subscription",
    "session",
    "claude",
    "flood",
    "tui",
    "resize",
    "detach",
    "background",
    "stale-biometric",
    "reconnect",
    "restart",
    "multisession",
  ];

  for (const prefix of prefixes) {
    expect(
      checklist.includes(`adb exec-out screencap -p > "$FW_LIVE_DIR/${prefix}.png"`),
      `capture checklist should include screenshot capture for ${prefix}`,
    );
    expect(
      checklist.includes(`adb pull /sdcard/window.xml "$FW_LIVE_DIR/${prefix}-ui.xml"`),
      `capture checklist should include UI dump capture for ${prefix}`,
    );
    expect(
      checklist.includes(`adb logcat -d > "$FW_LIVE_DIR/${prefix}-logcat.log"`),
      `capture checklist should include logcat capture for ${prefix}`,
    );
    expect(
      checklist.includes(`adb logcat -d -b crash > "$FW_LIVE_DIR/${prefix}-crash.log"`),
      `capture checklist should include crash-buffer capture for ${prefix}`,
    );
  }
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
