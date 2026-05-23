#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const verifier = path.join(root, "scripts/verify-android-background-foreground-evidence.mjs");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "fieldwork-android-background-"));

try {
  const good = path.join(temp, "good");
  writeFixture(good);
  expectStatus(good, 0, "good Android background/foreground evidence should pass");

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

  const stillTop = path.join(temp, "still-top");
  writeFixture(stillTop);
  fs.writeFileSync(
    path.join(stillTop, "background-state.txt"),
    "background_command=adb shell input keyevent KEYCODE_HOME\nbackground_top_package=app.fieldwork.android\napp_backgrounded_ok\n",
  );
  expectStatus(stillTop, 1, "top Fieldwork package should fail", "background-state.txt must prove Fieldwork was not the top package");

  const missingBackgroundOutput = path.join(temp, "missing-background-output");
  writeFixture(missingBackgroundOutput);
  fs.writeFileSync(path.join(missingBackgroundOutput, "background-output-replay.txt"), "ANDROID_BACKGROUND_READY\n");
  expectStatus(
    missingBackgroundOutput,
    1,
    "missing background output should fail",
    "background-output-replay.txt must include output emitted while Android was backgrounded",
  );

  const earlyInput = path.join(temp, "early-input");
  writeFixture(earlyInput);
  fs.writeFileSync(
    path.join(earlyInput, "background-output-replay.txt"),
    "ANDROID_BACKGROUND_READY\nANDROID_BACKGROUND_REPLAY_OUTPUT\nafter_background_ok\n",
  );
  expectStatus(earlyInput, 1, "pre-foreground replay with post-foreground input should fail", "captured before post-foreground input");

  const slowReconnect = path.join(temp, "slow-reconnect");
  writeFixture(slowReconnect);
  fs.writeFileSync(
    path.join(slowReconnect, "timing.txt"),
    writeTiming({ foregroundReconnectMs: 5001 }),
  );
  expectStatus(slowReconnect, 1, "slow foreground reconnect should fail", "foreground_reconnect_ms=5001");

  const shortBackground = path.join(temp, "short-background");
  writeFixture(shortBackground);
  fs.writeFileSync(
    path.join(shortBackground, "timing.txt"),
    writeTiming({ backgroundDurationMs: 2999 }),
  );
  expectStatus(shortBackground, 1, "short background duration should fail", "background_duration_ms=2999");

  const dashboardAfter = path.join(temp, "dashboard-after");
  writeFixture(dashboardAfter);
  fs.writeFileSync(path.join(dashboardAfter, "attached-after-ui.xml"), '<hierarchy><node text="No sessions"/></hierarchy>\n');
  expectStatus(dashboardAfter, 1, "dashboard after foreground should fail", "attached-after-ui.xml must show an attached terminal");

  const missingEcho = path.join(temp, "missing-echo");
  writeFixture(missingEcho);
  fs.writeFileSync(path.join(missingEcho, "post-foreground-replay.txt"), "ANDROID_BACKGROUND_REPLAY_OUTPUT\nafter_background_ok\n");
  expectStatus(missingEcho, 1, "missing post-foreground PTY echo should fail", "PTY echo for the Android-originated post-foreground input");

  const badLog = path.join(temp, "bad-log");
  writeFixture(badLog);
  fs.writeFileSync(path.join(badLog, "logcat.log"), "FATAL EXCEPTION: main\napp.fieldwork.android crashed\n");
  expectStatus(badLog, 1, "fatal log should fail", "logcat.log must not contain Android fatal, ANR, or exception entries");
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

console.log("Android background/foreground evidence verifier ok");

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
    '<hierarchy><node text="Attached"/><node text="Terminal"/><node text="ANDROID_BACKGROUND_READY"/></hierarchy>\n',
  );
  fs.writeFileSync(
    path.join(dir, "background-state.txt"),
    "background_command=adb shell input keyevent KEYCODE_HOME\nbackground_top_package=com.android.launcher3\napp_backgrounded_ok\n",
  );
  fs.writeFileSync(
    path.join(dir, "background-output-replay.txt"),
    "ANDROID_BACKGROUND_READY\nANDROID_BACKGROUND_REPLAY_OUTPUT\n",
  );
  writePng(path.join(dir, "attached-after.png"), { width: 1080, height: 2400 });
  fs.writeFileSync(
    path.join(dir, "attached-after-ui.xml"),
    '<hierarchy><node text="Attached"/><node text="Terminal"/><node text="ANDROID_BACKGROUND_REPLAY_OUTPUT"/></hierarchy>\n',
  );
  fs.writeFileSync(
    path.join(dir, "post-foreground-replay.txt"),
    "ANDROID_BACKGROUND_READY\nANDROID_BACKGROUND_REPLAY_OUTPUT\nafter_background_ok\nandroid-background: after_background_ok\n",
  );
  fs.writeFileSync(path.join(dir, "timing.txt"), writeTiming());
  fs.writeFileSync(path.join(dir, "logcat.log"), "I Fieldwork background foreground reconnect ok\n");
  fs.writeFileSync(path.join(dir, "crash.log"), "\n");
}

function writeTiming(options = {}) {
  const backgroundDurationMs = options.backgroundDurationMs ?? 3200;
  const foregroundReconnectMs = options.foregroundReconnectMs ?? 481;
  return [
    "backgrounded_at=2026-05-22T00:00:00Z",
    "foregrounded_at=2026-05-22T00:00:04Z",
    `background_duration_ms=${backgroundDurationMs}`,
    `foreground_reconnect_ms=${foregroundReconnectMs}`,
    "release_device_background_foreground_candidate=pass",
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
