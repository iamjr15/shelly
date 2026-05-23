#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const verifier = path.join(root, "scripts/verify-android-cold-start-evidence.mjs");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "fieldwork-android-cold-start-"));

try {
  const good = path.join(temp, "good");
  writeFixture(good);
  expectStatus(good, 0, "good Android cold-start evidence should pass");

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

  const unsigned = path.join(temp, "unsigned");
  writeFixture(unsigned);
  fs.writeFileSync(path.join(unsigned, "artifact-signing.txt"), "Android AAB ok: unsigned local bundle ok\n");
  expectStatus(unsigned, 1, "unsigned AAB evidence should fail", "artifact-signing.txt must prove the release App Bundle was signed");

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

  const bypassBuild = path.join(temp, "bypass-build");
  writeFixture(bypassBuild);
  fs.writeFileSync(
    path.join(bypassBuild, "buildconfig.txt"),
    [
      'APPLICATION_ID = "app.fieldwork.android"',
      'BUILD_TYPE = "release"',
      "DEBUG = false",
      "FIELDWORK_BIOMETRIC_BYPASS = true",
      'FIELDWORK_DEBUG_PAIRING_PAYLOAD = ""',
    ].join("\n"),
  );
  expectStatus(bypassBuild, 1, "release build with biometric bypass should fail", "buildconfig.txt must prove biometric bypass is disabled");

  const slowLaunch = path.join(temp, "slow-launch");
  writeFixture(slowLaunch);
  fs.writeFileSync(path.join(slowLaunch, "launch-3.txt"), writeLaunch(1201));
  expectStatus(slowLaunch, 1, "slow cold launch should fail", "launch-3.txt records TotalTime=1201ms");

  const warmLaunch = path.join(temp, "warm-launch");
  writeFixture(warmLaunch);
  fs.writeFileSync(path.join(warmLaunch, "launch-2.txt"), writeLaunch(900, { launchState: "HOT" }));
  expectStatus(warmLaunch, 1, "warm launch should fail", "launch-2.txt must prove the launch was cold after force-stop");

  const wrongActivity = path.join(temp, "wrong-activity");
  writeFixture(wrongActivity);
  fs.writeFileSync(path.join(wrongActivity, "launch-4.txt"), writeLaunch(800, { activity: "other.app/.MainActivity" }));
  expectStatus(wrongActivity, 1, "wrong launched activity should fail", "launch-4.txt must launch app.fieldwork.android/.MainActivity");

  const badUi = path.join(temp, "bad-ui");
  writeFixture(badUi);
  fs.writeFileSync(path.join(badUi, "locked-ui.xml"), '<hierarchy><node text="No sessions"/></hierarchy>\n');
  expectStatus(badUi, 1, "unlocked UI evidence should fail", "locked-ui.xml must show the locked biometric unlock surface");

  const tinyScreenshot = path.join(temp, "tiny-screenshot");
  writeFixture(tinyScreenshot);
  writePng(path.join(tinyScreenshot, "locked.png"), { width: 200, height: 320 });
  expectStatus(tinyScreenshot, 1, "tiny screenshot should fail", "locked.png is too small for Android phone evidence");

  const badLog = path.join(temp, "bad-log");
  writeFixture(badLog);
  fs.writeFileSync(path.join(badLog, "logcat.log"), "FATAL EXCEPTION: main\napp.fieldwork.android crashed\n");
  expectStatus(badLog, 1, "fatal log should fail", "logcat.log must not contain Android fatal, ANR, or exception entries");
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

console.log("Android cold-start evidence verifier ok");

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
  fs.writeFileSync(path.join(dir, "install.txt"), "Success\n");
  for (let index = 1; index <= 5; index += 1) {
    fs.writeFileSync(path.join(dir, `launch-${index}.txt`), writeLaunch(850 + index));
  }
  writePng(path.join(dir, "locked.png"), { width: 1080, height: 2400 });
  fs.writeFileSync(path.join(dir, "locked-ui.xml"), '<hierarchy><node text="Unlock"/></hierarchy>\n');
  fs.writeFileSync(path.join(dir, "logcat.log"), "I Fieldwork cold launch ok\n");
  fs.writeFileSync(path.join(dir, "crash.log"), "\n");
}

function writeLaunch(totalTime, options = {}) {
  const launchState = options.launchState ?? "COLD";
  const activity = options.activity ?? "app.fieldwork.android/.MainActivity";
  return [
    "Starting: Intent { cmp=app.fieldwork.android/.MainActivity }",
    "Status: ok",
    `LaunchState: ${launchState}`,
    `Activity: ${activity}`,
    `TotalTime: ${totalTime}`,
  ].join("\n");
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
