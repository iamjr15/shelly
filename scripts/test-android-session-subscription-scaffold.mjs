#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const node = process.execPath;
const scaffold = path.join(root, "scripts/create-android-session-subscription-evidence-dir.mjs");
const verifier = path.join(root, "scripts/verify-android-session-subscription-evidence.mjs");
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fieldwork-android-subscription-scaffold-test-"));

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
  expectEqual(manifest.schema, "fieldwork-android-session-subscription-evidence-v1", "manifest schema should be pinned");
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
  for (const file of requiredFiles) {
    expect(checklist.includes(`\`${file}\``), `capture checklist should mention ${file}`);
    expect(!fs.existsSync(path.join(evidenceDir, file)), `scaffold must not fabricate ${file}`);
  }
  expect(checklist.includes("visible_ms<=2000"), "checklist should include visibility threshold");
  expect(checklist.includes("does not create the\ndesktop session"), "checklist should state desktop session evidence is not fabricated");

  const readme = fs.readFileSync(path.join(evidenceDir, "README.md"), "utf8");
  expect(readme.includes("FIELDWORK_ANDROID_SUBSCRIPTION_CAPTURE_BEFORE=true"), "README should document before-capture mode");
  expect(readme.includes("FIELDWORK_ANDROID_SUBSCRIPTION_CAPTURE_AFTER=true"), "README should document after-capture mode");
  expect(readme.includes("does not create\n`desktop-create.txt`"), "README should state desktop create transcript is not fabricated");

  const preflightPath = path.join(evidenceDir, "preflight.sh");
  const preflight = fs.readFileSync(preflightPath, "utf8");
  expect(preflight.startsWith("#!/usr/bin/env bash"), "preflight helper should be a shell script");
  expect(preflight.includes("FIELDWORK_ANDROID_AAB"), "preflight should allow signed AAB override");
  expect(preflight.includes("FIELDWORK_ANDROID_ARTIFACT_SIGNING_FILE"), "preflight should allow captured signing output");
  expect(preflight.includes("FIELDWORK_ANDROID_SUBSCRIPTION_CAPTURE_BEFORE"), "preflight should support before-capture mode");
  expect(preflight.includes("FIELDWORK_ANDROID_SUBSCRIPTION_CAPTURE_AFTER"), "preflight should support after-capture mode");
  expect(preflight.includes("exec-out screencap -p"), "preflight should capture screenshot evidence");
  expect(
    (fs.statSync(preflightPath).mode & 0o700) === 0o700,
    "preflight helper should be executable by the owner",
  );

  const verifyEmpty = spawnSync(node, [verifier, evidenceDir], { cwd: root, encoding: "utf8" });
  expectStatus(verifyEmpty, 1, "empty scaffold should not pass the evidence verifier");
  expect(verifyEmpty.stderr.includes("missing evidence file: adb-devices.txt"), "verifier should still require real adb evidence");

  const binDir = path.join(tmpRoot, "bin");
  fs.mkdirSync(binDir);
  const adbStub = path.join(binDir, "adb");
  const fwStub = path.join(binDir, "fw");
  fs.writeFileSync(adbStub, buildAdbStub(), { mode: 0o700 });
  fs.writeFileSync(fwStub, buildFwStub(), { mode: 0o700 });
  fs.chmodSync(adbStub, 0o700);
  fs.chmodSync(fwStub, 0o700);

  const buildConfig = path.join(tmpRoot, "BuildConfig.java");
  fs.writeFileSync(buildConfig, writeBuildConfig());
  const artifactSigning = path.join(tmpRoot, "artifact-signing.txt");
  fs.writeFileSync(
    artifactSigning,
    "Android AAB ok: base/lib/arm64-v8a/libfieldwork_mobile_core.so; packaged manifest identity, version, uses-permission allowlist, and privacy surface ok; signed release bundle ok\n",
  );

  const staticPreflight = runPreflight(preflightPath, binDir, artifactSigning, buildConfig);
  expectStatus(staticPreflight, 0, "preflight should capture release/device/package evidence");
  expect(staticPreflight.stdout.includes("Android session-subscription preflight ok"), "preflight should report static success");
  expect(fs.existsSync(path.join(evidenceDir, "artifact-signing.txt")), "preflight should write artifact signing evidence");
  expect(fs.existsSync(path.join(evidenceDir, "buildconfig.txt")), "preflight should write BuildConfig evidence");
  expect(fs.existsSync(path.join(evidenceDir, "adb-devices.txt")), "preflight should write adb device evidence");
  expect(fs.existsSync(path.join(evidenceDir, "package-info.txt")), "preflight should write package info evidence");
  expect(!fs.existsSync(path.join(evidenceDir, "desktop-create.txt")), "preflight must not fabricate desktop create transcript");
  expect(!fs.existsSync(path.join(evidenceDir, "subscription-replay.txt")), "preflight must not fabricate Android input replay");

  const verifyAfterStatic = spawnSync(node, [verifier, evidenceDir], { cwd: root, encoding: "utf8" });
  expectStatus(verifyAfterStatic, 1, "static preflight-only evidence should not pass the subscription verifier");
  expect(
    verifyAfterStatic.stderr.includes("missing evidence file: dashboard-before-ui.xml"),
    "verifier should still require dashboard-before evidence",
  );

  const beforeCapture = runPreflight(preflightPath, binDir, artifactSigning, buildConfig, {
    FIELDWORK_ANDROID_SUBSCRIPTION_CAPTURE_BEFORE: "true",
  });
  expectStatus(beforeCapture, 0, "before capture should capture primed dashboard evidence");
  expect(beforeCapture.stdout.includes("before-create capture ok"), "before capture should report success");
  expect(fs.existsSync(path.join(evidenceDir, "dashboard-before-ui.xml")), "before capture should write dashboard-before-ui.xml");

  fs.writeFileSync(path.join(evidenceDir, "desktop-create.txt"), "$ fw new --name fw_live_sub bash\ncreated fw_live_sub bash\n");
  fs.writeFileSync(path.join(evidenceDir, "subscription-visible.txt"), "created_by_desktop_cli\nvisible_ms=1200\n");
  fs.writeFileSync(path.join(evidenceDir, "subscription-replay.txt"), "fw attach fw_live_sub\nsubscription_attach_ok\n");

  const afterCapture = runPreflight(preflightPath, binDir, artifactSigning, buildConfig, {
    FIELDWORK_ANDROID_SUBSCRIPTION_CAPTURE_AFTER: "true",
  });
  expectStatus(afterCapture, 0, "after capture should complete when real transcripts exist");
  expect(afterCapture.stdout.includes("after-create capture ok"), "after capture should report success");

  for (const file of requiredFiles) {
    expect(fs.existsSync(path.join(evidenceDir, file)), `after capture should write ${file}`);
  }
  const verifyAfterCapture = spawnSync(node, [verifier, evidenceDir], { cwd: root, encoding: "utf8" });
  expectStatus(verifyAfterCapture, 0, "stubbed subscription evidence should pass the verifier shape");
  expect(verifyAfterCapture.stdout.includes("Android session-subscription evidence ok"), "verifier should report subscription success");

  const emulatorDir = path.join(tmpRoot, "emulator");
  expectStatus(
    spawnSync(node, [scaffold, "--dir", emulatorDir, "--quiet"], { cwd: root, encoding: "utf8" }),
    0,
    "scaffold should create emulator test evidence directory",
  );
  const emulatorPreflight = spawnSync("bash", [path.join(emulatorDir, "preflight.sh")], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
      FIELDWORK_ANDROID_ARTIFACT_SIGNING_FILE: artifactSigning,
      FIELDWORK_ANDROID_RELEASE_BUILDCONFIG: buildConfig,
      FIELDWORK_ADB_STUB_MODE: "emulator",
    },
  });
  expectStatus(emulatorPreflight, 1, "preflight should reject emulator adb evidence");
  expect(emulatorPreflight.stderr.includes("not an emulator or AVD"), "emulator failure should be explicit");

  const missingTranscriptDir = path.join(tmpRoot, "missing-transcript");
  expectStatus(
    spawnSync(node, [scaffold, "--dir", missingTranscriptDir, "--quiet"], { cwd: root, encoding: "utf8" }),
    0,
    "scaffold should create missing-transcript evidence directory",
  );
  const missingTranscript = spawnSync("bash", [path.join(missingTranscriptDir, "preflight.sh")], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
      FIELDWORK_ANDROID_ARTIFACT_SIGNING_FILE: artifactSigning,
      FIELDWORK_ANDROID_RELEASE_BUILDCONFIG: buildConfig,
      FIELDWORK_ANDROID_SUBSCRIPTION_CAPTURE_AFTER: "true",
    },
  });
  expectStatus(missingTranscript, 1, "after capture should require real transcripts");
  expect(missingTranscript.stderr.includes("dashboard-before-ui.xml is missing"), "missing transcript failure should be explicit");

  const noForce = spawnSync(node, [scaffold, "--dir", evidenceDir, "--quiet"], { cwd: root, encoding: "utf8" });
  expectStatus(noForce, 1, "scaffold should not overwrite a non-empty directory without --force");
  expect(noForce.stderr.includes("rerun with --force"), "non-empty directory failure should explain --force");

  const force = spawnSync(node, [scaffold, "--dir", evidenceDir, "--force", "--quiet"], {
    cwd: root,
    encoding: "utf8",
  });
  expectStatus(force, 0, "scaffold should refresh metadata with --force");

  console.log("Android session-subscription evidence scaffold self-test ok");
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

function runPreflight(preflightPath, binDir, artifactSigning, buildConfig, extraEnv = {}) {
  return spawnSync("bash", [preflightPath], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
      FIELDWORK_ANDROID_ARTIFACT_SIGNING_FILE: artifactSigning,
      FIELDWORK_ANDROID_RELEASE_BUILDCONFIG: buildConfig,
      ...extraEnv,
    },
  });
}

function readRequiredFiles() {
  const source = fs.readFileSync(verifier, "utf8");
  const match = source.match(/const\s+requiredFiles\s*=\s*\[(?<body>[\s\S]*?)\];/);
  if (!match?.groups?.body) {
    throw new Error("cannot locate requiredFiles in verifier");
  }
  return [...match.groups.body.matchAll(/"([^"\n]+)"/g)].map((fileMatch) => fileMatch[1]);
}

function writeBuildConfig() {
  return [
    "public final class BuildConfig {",
    '  public static final String APPLICATION_ID = "app.fieldwork.android";',
    '  public static final String BUILD_TYPE = "release";',
    "  public static final boolean DEBUG = false;",
    "  public static final boolean FIELDWORK_BIOMETRIC_BYPASS = false;",
    '  public static final String FIELDWORK_DEBUG_PAIRING_CODE = "";',
    "}",
    "",
  ].join("\n");
}

function buildAdbStub() {
  return `#!/usr/bin/env node
const fs = require("fs");
let args = process.argv.slice(2);
const mode = process.env.FIELDWORK_ADB_STUB_MODE || "physical";
if (args[0] === "-s") {
  args = args.slice(2);
}
function out(text) {
  process.stdout.write(text);
}
function writePng() {
  const bytes = Buffer.alloc(128);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(1080, 16);
  bytes.writeUInt32BE(2400, 20);
  bytes[24] = 8;
  bytes[25] = 6;
  bytes.writeUInt32BE(0, 33);
  bytes.write("IEND", 37, "ascii");
  process.stdout.write(bytes);
}
if (args[0] === "devices") {
  if (mode === "emulator") {
    out("List of devices attached\\nemulator-5554 device product:sdk_gphone64_arm64 model:sdk_gphone64_arm64 device:emu64a transport_id:1\\n");
  } else {
    out("List of devices attached\\nR5CT1234567 device usb:336592896X product:oriole model:Pixel_6 device:oriole transport_id:9\\n");
  }
  process.exit(0);
}
if (args[0] === "shell" && args[1] === "pm" && args[2] === "path") {
  out("package:/data/app/~~hash/app.fieldwork.android-base.apk\\n");
  process.exit(0);
}
if (args[0] === "shell" && args[1] === "dumpsys" && args[2] === "package") {
  out("Packages:\\n  Package [app.fieldwork.android] (abc):\\n    versionCode=1 minSdk=30 targetSdk=36\\n    versionName=1.0\\n");
  process.exit(0);
}
if (args[0] === "logcat") {
  if (args.includes("-c")) {
    process.exit(0);
  }
  if (args.includes("-b") && args.includes("crash")) {
    out("\\n");
  } else {
    out("I FieldworkRepository: listSessions returned 4 sessions\\n");
  }
  process.exit(0);
}
if (args[0] === "exec-out" && args[1] === "screencap") {
  writePng();
  process.exit(0);
}
if (args[0] === "shell" && args[1] === "uiautomator") {
  out("UI hierchary dumped to: /sdcard/fieldwork-subscription.xml\\n");
  process.exit(0);
}
if (args[0] === "pull") {
  const file = args[2];
  if (file.includes("dashboard-before")) {
    fs.writeFileSync(file, '<hierarchy><node text="refactoringjob"/><node text="shell"/></hierarchy>\\n');
  } else {
    fs.writeFileSync(file, '<hierarchy><node text="refactoringjob"/><node text="fw_live_sub"/><node text="bash"/></hierarchy>\\n');
  }
  process.exit(0);
}
if (args[0] === "shell" && args[1] === "rm") {
  process.exit(0);
}
console.error("unexpected adb invocation: " + args.join(" "));
process.exit(64);
`;
}

function buildFwStub() {
  return `#!/usr/bin/env bash
set -euo pipefail
case "\${1:-}" in
  ls)
    printf 'fw_live_sub bash\\nrefactoringjob claude\\nshell bash\\n'
    ;;
  *)
    echo "unexpected fw invocation: $*" >&2
    exit 64
    ;;
esac
`;
}

function expectStatus(result, expectedStatus, message) {
  if (result.status !== expectedStatus) {
    throw new Error(`${message}: exited ${result.status}, expected ${expectedStatus}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
}

function expectEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function expectDeepEqual(actual, expected, message) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function expect(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
