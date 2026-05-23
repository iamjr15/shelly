#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const verifier = path.join(root, "scripts/verify-android-resize-detach-evidence.mjs");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "fieldwork-android-resize-detach-"));

try {
  const good = path.join(temp, "good");
  writeFixture(good);
  expectStatus(good, 0, "good Android resize/detach evidence should pass");

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

  const missingResizeMarker = path.join(temp, "missing-resize-marker");
  writeFixture(missingResizeMarker);
  fs.writeFileSync(path.join(missingResizeMarker, "resize-replay.txt"), "shell bash\nresize_size=24x80\n");
  expectStatus(missingResizeMarker, 1, "missing resize marker should fail", "resize-replay.txt must contain after_resize_ok");

  const badResizeSize = path.join(temp, "bad-resize-size");
  writeFixture(badResizeSize);
  fs.writeFileSync(path.join(badResizeSize, "resize-replay.txt"), "shell bash\nafter_resize_ok\nresize_size=4x19\n");
  expectStatus(badResizeSize, 1, "implausible resize size should fail", "expected rows>=5 and cols>=20");

  const missingDetachMarker = path.join(temp, "missing-detach-marker");
  writeFixture(missingDetachMarker);
  fs.writeFileSync(path.join(missingDetachMarker, "detach-replay.txt"), "shell bash\n");
  expectStatus(missingDetachMarker, 1, "missing detach marker should fail", "detach-replay.txt must contain after_detach_reattach_ok");

  const emptyDetach = path.join(temp, "empty-detach");
  writeFixture(emptyDetach);
  fs.writeFileSync(path.join(emptyDetach, "detach-ui.xml"), '<hierarchy><node text="No sessions"/></hierarchy>\n');
  expectStatus(emptyDetach, 1, "empty detach dashboard should fail", "detach-ui.xml must not be the empty dashboard after detach");

  const mobileCreateControl = path.join(temp, "mobile-create-control");
  writeFixture(mobileCreateControl);
  fs.writeFileSync(path.join(mobileCreateControl, "resize-ui.xml"), '<hierarchy><node text="Attached"/><node text="shell"/><node text="Create session"/></hierarchy>\n');
  expectStatus(mobileCreateControl, 1, "mobile create control should fail", "resize-ui.xml must not expose mobile session creation");

  const badLog = path.join(temp, "bad-log");
  writeFixture(badLog);
  fs.writeFileSync(path.join(badLog, "detach-logcat.log"), "FATAL EXCEPTION: main\napp.fieldwork.android crashed\n");
  expectStatus(badLog, 1, "fatal log should fail", "detach-logcat.log must not contain Android fatal, ANR, or exception entries");
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

console.log("Android resize/detach evidence verifier ok");

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
  fs.writeFileSync(path.join(dir, "sessions.txt"), "refactoringjob claude\nshell bash\n");
  writePng(path.join(dir, "resize.png"), { width: 1080, height: 2400 });
  fs.writeFileSync(path.join(dir, "resize-ui.xml"), '<hierarchy><node text="Attached"/><node text="shell"/><node text="bash"/></hierarchy>\n');
  fs.writeFileSync(path.join(dir, "resize-logcat.log"), "I FieldworkRepository: listSessions returned 2 sessions\n");
  fs.writeFileSync(path.join(dir, "resize-crash.log"), "\n");
  fs.writeFileSync(path.join(dir, "resize-replay.txt"), "shell bash\nafter_resize_ok\nresize_size=24x80\n");
  writePng(path.join(dir, "detach.png"), { width: 1080, height: 2400 });
  fs.writeFileSync(path.join(dir, "detach-ui.xml"), '<hierarchy><node text="refactoringjob"/><node text="shell"/><node text="bash"/></hierarchy>\n');
  fs.writeFileSync(path.join(dir, "detach-logcat.log"), "I FieldworkRepository: listSessions returned 2 sessions\n");
  fs.writeFileSync(path.join(dir, "detach-crash.log"), "\n");
  fs.writeFileSync(path.join(dir, "detach-replay.txt"), "shell bash\nafter_detach_reattach_ok\n");
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
