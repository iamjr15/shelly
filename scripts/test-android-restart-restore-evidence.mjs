#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const verifier = path.join(root, "scripts/verify-android-restart-restore-evidence.mjs");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "fieldwork-android-restart-restore-"));

try {
  const good = path.join(temp, "good");
  writeFixture(good);
  expectStatus(good, 0, "good Android restart-restore evidence should pass");

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

  const missingSeed = path.join(temp, "missing-seed");
  writeFixture(missingSeed);
  fs.writeFileSync(path.join(missingSeed, "sessions-before.txt"), "shell bash\n");
  expectStatus(missingSeed, 1, "missing restart session should fail", "sessions-before.txt must include fw_restart_session");

  const missingRestart = path.join(temp, "missing-restart");
  writeFixture(missingRestart);
  fs.writeFileSync(path.join(missingRestart, "daemon-restart.txt"), "restart_ms=400\nprocesses_died_documented\n");
  expectStatus(missingRestart, 1, "missing daemon restart command should fail", "daemon-restart.txt must show fw daemon restart was run");

  const slowRestart = path.join(temp, "slow-restart");
  writeFixture(slowRestart);
  fs.writeFileSync(path.join(slowRestart, "daemon-restart.txt"), "fw daemon restart\nrestart_ms=30001\nprocesses_died_documented\n");
  expectStatus(slowRestart, 1, "slow daemon restart should fail", "restart_ms=30001");

  const missingProcessDoc = path.join(temp, "missing-process-doc");
  writeFixture(missingProcessDoc);
  fs.writeFileSync(path.join(missingProcessDoc, "daemon-restart.txt"), "fw daemon restart\nrestart_ms=400\n");
  expectStatus(missingProcessDoc, 1, "missing process death note should fail", "live PTY processes are not expected to survive");

  const emptyRestore = path.join(temp, "empty-restore");
  writeFixture(emptyRestore);
  fs.writeFileSync(path.join(emptyRestore, "restart-ui.xml"), '<hierarchy><node text="No sessions"/></hierarchy>\n');
  expectStatus(emptyRestore, 1, "empty restored dashboard should fail", "restart-ui.xml must show the restored session");

  const missingScrollback = path.join(temp, "missing-scrollback");
  writeFixture(missingScrollback);
  fs.writeFileSync(path.join(missingScrollback, "restart-replay.txt"), "fw_restart_session\n");
  expectStatus(missingScrollback, 1, "missing restored scrollback should fail", "restart-replay.txt must include restored daemon scrollback");

  const badLog = path.join(temp, "bad-log");
  writeFixture(badLog);
  fs.writeFileSync(path.join(badLog, "restart-logcat.log"), "FATAL EXCEPTION: main\napp.fieldwork.android crashed\n");
  expectStatus(badLog, 1, "fatal log should fail", "restart-logcat.log must not contain Android fatal, ANR, or exception entries");
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

console.log("Android restart-restore evidence verifier ok");

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
  fs.writeFileSync(path.join(dir, "sessions-before.txt"), "fw_restart_session bash\n");
  fs.writeFileSync(path.join(dir, "devices.txt"), "Android Pixel_6 paired device\n");
  fs.writeFileSync(path.join(dir, "daemon-restart.txt"), "fw daemon restart\nrestart_ms=450\nprocesses_died_documented\n");
  writePng(path.join(dir, "restart.png"), { width: 1080, height: 2400 });
  fs.writeFileSync(path.join(dir, "restart-ui.xml"), '<hierarchy><node text="fw_restart_session"/><node text="Attached"/></hierarchy>\n');
  fs.writeFileSync(path.join(dir, "restart-logcat.log"), "I FieldworkRepository: listSessions returned 1 sessions\n");
  fs.writeFileSync(path.join(dir, "restart-crash.log"), "\n");
  fs.writeFileSync(path.join(dir, "restart-replay.txt"), "fw_restart_session\nANDROID_RESTART_SCROLLBACK\n");
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
