#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const verifier = path.join(root, "scripts/verify-android-pair-flow-evidence.mjs");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "fieldwork-android-pair-flow-"));

try {
  const good = path.join(temp, "good");
  writeFixture(good);
  expectStatus(good, 0, "good Android pair-flow evidence should pass");

  const emulator = path.join(temp, "emulator");
  writeFixture(emulator);
  fs.writeFileSync(
    path.join(emulator, "adb-devices.txt"),
    "List of devices attached\nemulator-5554 device product:sdk_gphone64_arm64 model:sdk_gphone64_arm64 device:emu64a transport_id:1\n",
  );
  expectStatus(emulator, 1, "emulator adb device should fail", "adb-devices.txt must show a physical Android phone");

  const debugBuild = path.join(temp, "debug-build");
  writeFixture(debugBuild);
  fs.writeFileSync(
    path.join(debugBuild, "buildconfig.txt"),
    [
      'APPLICATION_ID = "app.fieldwork.android"',
      'BUILD_TYPE = "debug"',
      'DEBUG = Boolean.parseBoolean("true")',
      "FIELDWORK_BIOMETRIC_BYPASS = false",
      'FIELDWORK_DEBUG_PAIRING_PAYLOAD = ""',
    ].join("\n"),
  );
  expectStatus(debugBuild, 1, "debug BuildConfig should fail", "buildconfig.txt must prove the tested build is the release variant");

  const unsigned = path.join(temp, "unsigned");
  writeFixture(unsigned);
  fs.writeFileSync(path.join(unsigned, "artifact-signing.txt"), "Android AAB ok: unsigned local bundle ok\n");
  expectStatus(unsigned, 1, "unsigned AAB evidence should fail", "artifact-signing.txt must prove the release App Bundle was signed");

  const slowPair = path.join(temp, "slow-pair");
  writeFixture(slowPair);
  fs.writeFileSync(path.join(slowPair, "pairing.txt"), writePairing({ pairFlowMs: 15001 }));
  expectStatus(slowPair, 1, "slow pair should fail", "pair_flow_ms=15001");

  const deniedPair = path.join(temp, "denied-pair");
  writeFixture(deniedPair);
  fs.writeFileSync(path.join(deniedPair, "pairing.txt"), `${writePairing()}Denied. Pair token has been consumed.\n`);
  expectStatus(deniedPair, 1, "denied pair should fail", "pairing.txt must not be a denied pairing transcript");

  const missingApproval = path.join(temp, "missing-approval");
  writeFixture(missingApproval);
  fs.writeFileSync(
    path.join(missingApproval, "pairing.txt"),
    '{"pair_token":"abc","contract_version":1}\nWaiting for a device to scan...\npair_flow_ms=481\n',
  );
  expectStatus(missingApproval, 1, "missing explicit approval should fail", "explicit desktop approval prompt");

  const debugPayload = path.join(temp, "debug-payload");
  writeFixture(debugPayload);
  fs.writeFileSync(path.join(debugPayload, "pairing.txt"), `${writePairing()}FIELDWORK_DEBUG_PAIRING_PAYLOAD=true\n`);
  expectStatus(debugPayload, 1, "debug pairing payload should fail", "pairing.txt must not use debug pairing payload injection");

  const emptyDashboard = path.join(temp, "empty-dashboard");
  writeFixture(emptyDashboard);
  fs.writeFileSync(path.join(emptyDashboard, "dashboard-ui.xml"), '<hierarchy><node text="No sessions"/></hierarchy>\n');
  expectStatus(emptyDashboard, 1, "empty dashboard should fail", "dashboard-ui.xml must not be the empty dashboard after pairing");

  const missingSession = path.join(temp, "missing-session");
  writeFixture(missingSession);
  fs.writeFileSync(path.join(missingSession, "sessions.txt"), "shell bash\n");
  expectStatus(missingSession, 1, "missing refactoringjob session should fail", "sessions.txt must include the named shortcut refactoringjob");

  const emptyDevices = path.join(temp, "empty-devices");
  writeFixture(emptyDevices);
  fs.writeFileSync(path.join(emptyDevices, "devices.txt"), "No devices\n");
  expectStatus(emptyDevices, 1, "empty devices should fail", "devices.txt must not be empty after pairing");

  const badLog = path.join(temp, "bad-log");
  writeFixture(badLog);
  fs.writeFileSync(path.join(badLog, "logcat.log"), "FATAL EXCEPTION: main\napp.fieldwork.android crashed\n");
  expectStatus(badLog, 1, "fatal log should fail", "logcat.log must not contain Fieldwork fatal, ANR, or exception entries");
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

console.log("Android pair-flow evidence verifier ok");

function writeFixture(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "adb-devices.txt"),
    "List of devices attached\nR5CT1234567 device usb:336592896X product:oriole model:Pixel_6 device:oriole transport_id:9\n",
  );
  fs.writeFileSync(
    path.join(dir, "artifact-signing.txt"),
    "Android AAB ok: base/lib/arm64-v8a/libfieldwork_mobile_core.so; packaged manifest uses-permission allowlist and privacy surface ok; signed release bundle ok\n",
  );
  fs.writeFileSync(
    path.join(dir, "buildconfig.txt"),
    [
      'APPLICATION_ID = "app.fieldwork.android"',
      'BUILD_TYPE = "release"',
      "DEBUG = false",
      "FIELDWORK_BIOMETRIC_BYPASS = false",
      'FIELDWORK_DEBUG_PAIRING_PAYLOAD = ""',
    ].join("\n"),
  );
  fs.writeFileSync(path.join(dir, "pairing.txt"), writePairing());
  writePng(path.join(dir, "dashboard.png"), { width: 1080, height: 2400 });
  fs.writeFileSync(
    path.join(dir, "dashboard-ui.xml"),
    '<hierarchy><node text="refactoringjob"/><node text="shell"/><node text="bash"/></hierarchy>\n',
  );
  fs.writeFileSync(path.join(dir, "sessions.txt"), "kazoo claude\nrefactoringjob claude\nshell bash\n");
  fs.writeFileSync(path.join(dir, "devices.txt"), "Android Pixel_6 paired device\n");
  fs.writeFileSync(
    path.join(dir, "logcat.log"),
    "I FieldworkRepository: pair completed\nI FieldworkRepository: listSessions returned 3 sessions\n",
  );
  fs.writeFileSync(path.join(dir, "crash.log"), "\n");
}

function writePairing(options = {}) {
  const pairFlowMs = options.pairFlowMs ?? 481;
  return [
    '{"pair_token":"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567","contract_version":1}',
    "Waiting for a device to scan...",
    "Pair request from device Android Pixel_6",
    "approve? [y/N]",
    "Approved. Device is paired.",
    `pair_flow_ms=${pairFlowMs}`,
  ].join("\n") + "\n";
}

function writePng(file, { width, height }) {
  const bytes = Buffer.alloc(64);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  bytes[24] = 8;
  bytes[25] = 6;
  bytes.writeUInt32BE(0, 33);
  bytes.write("IEND", 37, "ascii");
  fs.writeFileSync(file, bytes);
}

function expectStatus(dir, expectedStatus, message, expectedOutput = null) {
  const result = spawnSync(process.execPath, [verifier, dir], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.status !== expectedStatus) {
    throw new Error(`${message}: exited ${result.status}, expected ${expectedStatus}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  if (expectedOutput && !`${result.stdout}\n${result.stderr}`.includes(expectedOutput)) {
    throw new Error(`${message}: missing output ${JSON.stringify(expectedOutput)}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
}
