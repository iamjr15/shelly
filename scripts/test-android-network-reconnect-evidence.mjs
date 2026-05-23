#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const verifier = path.join(root, "scripts/verify-android-network-reconnect-evidence.mjs");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "fieldwork-android-reconnect-"));

try {
  const good = path.join(temp, "good");
  writeFixture(good);
  expectStatus(good, 0, "good Android network reconnect evidence should pass");

  const emulator = path.join(temp, "emulator");
  writeFixture(emulator);
  fs.writeFileSync(
    path.join(emulator, "adb-devices.txt"),
    "List of devices attached\nemulator-5554 device product:sdk_gphone64_arm64 model:sdk_gphone64_arm64 device:emu64a transport_id:1\n",
  );
  expectStatus(emulator, 1, "emulator adb device should fail", "adb-devices.txt must show a physical Android phone");

  const multipleDevices = path.join(temp, "multiple-devices");
  writeFixture(multipleDevices);
  fs.writeFileSync(
    path.join(multipleDevices, "adb-devices.txt"),
    [
      "List of devices attached",
      "R58M1234567 device product:panther model:Pixel_8_Pro device:panther transport_id:1",
      "R58M7654321 device product:oriole model:Pixel_6 device:oriole transport_id:2",
      "",
    ].join("\n"),
  );
  expectStatus(
    multipleDevices,
    1,
    "multiple authorized adb devices should fail",
    "adb-devices.txt must show exactly one authorized physical Android device, found 2",
  );

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

  const notDisconnected = path.join(temp, "not-disconnected");
  writeFixture(notDisconnected);
  fs.writeFileSync(
    path.join(notDisconnected, "network-cut.txt"),
    "network_cut_command=adb shell cmd connectivity airplane-mode enable\nnetwork_state=connected\nnetwork_cut_ok\n",
  );
  expectStatus(notDisconnected, 1, "connected network state during cut should fail", "network_state=disconnected");

  const missingOfflineOutput = path.join(temp, "missing-offline-output");
  writeFixture(missingOfflineOutput);
  fs.writeFileSync(path.join(missingOfflineOutput, "offline-output-replay.txt"), "ANDROID_RECONNECT_READY\n");
  expectStatus(
    missingOfflineOutput,
    1,
    "missing offline output should fail",
    "offline-output-replay.txt must include output emitted while Android networking was cut",
  );

  const earlyInput = path.join(temp, "early-input");
  writeFixture(earlyInput);
  fs.writeFileSync(
    path.join(earlyInput, "offline-output-replay.txt"),
    "ANDROID_RECONNECT_READY\nANDROID_RECONNECT_OFFLINE_OUTPUT\nafter_reconnect_ok\n",
  );
  expectStatus(earlyInput, 1, "pre-reconnect replay with post-reconnect input should fail", "captured before post-reconnect input");

  const missingPing = path.join(temp, "missing-ping");
  writeFixture(missingPing);
  fs.writeFileSync(
    path.join(missingPing, "network-restore.txt"),
    "network_restore_command=adb shell cmd connectivity airplane-mode disable\nnetwork_restored_ok\n",
  );
  expectStatus(missingPing, 1, "missing ping after restore should fail", "network-restore.txt must record network_ping_ok");

  const slowReconnect = path.join(temp, "slow-reconnect");
  writeFixture(slowReconnect);
  fs.writeFileSync(path.join(slowReconnect, "reconnect-replay.txt"), writeReconnectReplay({ reconnectMs: 2001 }));
  expectStatus(slowReconnect, 1, "slow reconnect should fail", "reconnect_ms=2001");

  const dashboardAfter = path.join(temp, "dashboard-after");
  writeFixture(dashboardAfter);
  fs.writeFileSync(path.join(dashboardAfter, "attached-after-ui.xml"), '<hierarchy><node text="No sessions"/></hierarchy>\n');
  expectStatus(dashboardAfter, 1, "dashboard after reconnect should fail", "attached-after-ui.xml must show an attached terminal");

  const missingEcho = path.join(temp, "missing-echo");
  writeFixture(missingEcho);
  fs.writeFileSync(
    path.join(missingEcho, "reconnect-replay.txt"),
    "ANDROID_RECONNECT_OFFLINE_OUTPUT\nafter_reconnect_ok\nreconnect_ms=400\n",
  );
  expectStatus(missingEcho, 1, "missing post-reconnect PTY echo should fail", "PTY echo for the Android-originated post-reconnect input");

  const badLog = path.join(temp, "bad-log");
  writeFixture(badLog);
  fs.writeFileSync(path.join(badLog, "logcat.log"), "FATAL EXCEPTION: main\napp.fieldwork.android crashed\n");
  expectStatus(badLog, 1, "fatal log should fail", "logcat.log must not contain Android fatal, ANR, or exception entries");
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

console.log("Android network reconnect evidence verifier ok");

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
  writePng(path.join(dir, "attached-before.png"), { width: 1080, height: 2400 });
  fs.writeFileSync(
    path.join(dir, "attached-before-ui.xml"),
    '<hierarchy><node text="Attached"/><node text="Terminal"/><node text="ANDROID_RECONNECT_READY"/></hierarchy>\n',
  );
  fs.writeFileSync(
    path.join(dir, "network-cut.txt"),
    "network_cut_command=adb shell cmd connectivity airplane-mode enable\nnetwork_state=disconnected\nnetwork_cut_ok\n",
  );
  fs.writeFileSync(
    path.join(dir, "offline-output-replay.txt"),
    "ANDROID_RECONNECT_READY\nANDROID_RECONNECT_OFFLINE_OUTPUT\n",
  );
  fs.writeFileSync(
    path.join(dir, "network-restore.txt"),
    "network_restore_command=adb shell cmd connectivity airplane-mode disable\nnetwork_ping_ok\nnetwork_restored_ok\n",
  );
  writePng(path.join(dir, "attached-after.png"), { width: 1080, height: 2400 });
  fs.writeFileSync(
    path.join(dir, "attached-after-ui.xml"),
    '<hierarchy><node text="Attached"/><node text="Terminal"/><node text="ANDROID_RECONNECT_OFFLINE_OUTPUT"/></hierarchy>\n',
  );
  fs.writeFileSync(path.join(dir, "reconnect-replay.txt"), writeReconnectReplay());
  fs.writeFileSync(path.join(dir, "logcat.log"), "I Fieldwork network reconnect ok\n");
  fs.writeFileSync(path.join(dir, "crash.log"), "\n");
}

function writeReconnectReplay(options = {}) {
  const reconnectMs = options.reconnectMs ?? 399;
  return [
    "ANDROID_RECONNECT_READY",
    "ANDROID_RECONNECT_OFFLINE_OUTPUT",
    "after_reconnect_ok",
    "android-reconnect: after_reconnect_ok",
    `reconnect_ms=${reconnectMs}`,
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
