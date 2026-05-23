#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const verifier = path.join(root, "scripts/verify-android-multisession-evidence.mjs");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "fieldwork-android-multisession-"));

try {
  const good = path.join(temp, "good");
  writeFixture(good);
  expectStatus(good, 0, "good Android multisession evidence should pass");

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

  const missingSession = path.join(temp, "missing-session");
  writeFixture(missingSession);
  fs.writeFileSync(path.join(missingSession, "sessions.txt"), "fwm_a bash\nfwm_b bash\n");
  expectStatus(missingSession, 1, "missing fwm_c should fail", "sessions.txt must include desktop-created fwm_c");

  const missingUi = path.join(temp, "missing-ui");
  writeFixture(missingUi);
  fs.writeFileSync(path.join(missingUi, "multisession-ui.xml"), '<hierarchy><node text="fwm_a"/><node text="fwm_b"/></hierarchy>\n');
  expectStatus(missingUi, 1, "UI without fwm_c should fail", "multisession-ui.xml must include fwm_c");

  const mobileCreateControl = path.join(temp, "mobile-create-control");
  writeFixture(mobileCreateControl);
  fs.writeFileSync(path.join(mobileCreateControl, "multisession-ui.xml"), '<hierarchy><node text="fwm_a"/><node text="fwm_b"/><node text="fwm_c"/><node text="Create session"/></hierarchy>\n');
  expectStatus(mobileCreateControl, 1, "mobile create control should fail", "must not expose mobile session creation");

  const missingMarker = path.join(temp, "missing-marker");
  writeFixture(missingMarker);
  fs.writeFileSync(path.join(missingMarker, "multisession-b-replay.txt"), "fwm_b\n");
  expectStatus(missingMarker, 1, "missing selected marker should fail", "multisession-b-replay.txt must contain multi_b_ok");

  const leakedMarker = path.join(temp, "leaked-marker");
  writeFixture(leakedMarker);
  fs.writeFileSync(path.join(leakedMarker, "multisession-a-replay.txt"), "fwm_a\nmulti_a_ok\nmulti_b_ok\n");
  expectStatus(leakedMarker, 1, "cross-session output leakage should fail", "multisession-a-replay.txt must not contain multi_b_ok");

  const badLog = path.join(temp, "bad-log");
  writeFixture(badLog);
  fs.writeFileSync(path.join(badLog, "multisession-logcat.log"), "FATAL EXCEPTION: main\napp.fieldwork.android crashed\n");
  expectStatus(badLog, 1, "fatal log should fail", "multisession-logcat.log must not contain Android fatal, ANR, or exception entries");
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

console.log("Android multisession evidence verifier ok");

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
  fs.writeFileSync(path.join(dir, "sessions.txt"), "fwm_a bash\nfwm_b bash\nfwm_c bash\n");
  writePng(path.join(dir, "multisession.png"), { width: 1080, height: 2400 });
  fs.writeFileSync(path.join(dir, "multisession-ui.xml"), '<hierarchy><node text="fwm_a"/><node text="fwm_b"/><node text="fwm_c"/></hierarchy>\n');
  fs.writeFileSync(path.join(dir, "multisession-logcat.log"), "I FieldworkRepository: listSessions returned 3 sessions\n");
  fs.writeFileSync(path.join(dir, "multisession-crash.log"), "\n");
  fs.writeFileSync(path.join(dir, "multisession-a-replay.txt"), "fwm_a\nmulti_a_ok\n");
  fs.writeFileSync(path.join(dir, "multisession-b-replay.txt"), "fwm_b\nmulti_b_ok\n");
  fs.writeFileSync(path.join(dir, "multisession-c-replay.txt"), "fwm_c\nmulti_c_ok\n");
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
