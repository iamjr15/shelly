#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const verifier = path.join(root, "scripts/verify-android-renderer-flood-evidence.mjs");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "fieldwork-android-flood-"));

try {
  const good = path.join(temp, "good");
  writeFixture(good);
  expectStatus(good, 0, "good Android renderer flood evidence should pass");

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

  const dashboard = path.join(temp, "dashboard");
  writeFixture(dashboard);
  fs.writeFileSync(path.join(dashboard, "flood-ui.xml"), '<hierarchy><node text="No sessions"/></hierarchy>\n');
  expectStatus(dashboard, 1, "dashboard flood UI should fail", "flood-ui.xml must show an attached terminal");

  const missingCommand = path.join(temp, "missing-command");
  writeFixture(missingCommand);
  fs.writeFileSync(path.join(missingCommand, "flood-replay.txt"), writeFloodReplay({ includeCommand: false }));
  expectStatus(missingCommand, 1, "missing flood command should fail", "flood command");

  const tooFewLines = path.join(temp, "too-few-lines");
  writeFixture(tooFewLines);
  fs.writeFileSync(path.join(tooFewLines, "flood-replay.txt"), writeFloodReplay({ markerCount: 9999, floodLines: 9999 }));
  expectStatus(tooFewLines, 1, "too few flood lines should fail", "flood_lines=9999");

  const missingDone = path.join(temp, "missing-done");
  writeFixture(missingDone);
  fs.writeFileSync(path.join(missingDone, "flood-replay.txt"), writeFloodReplay({ includeDone: false }));
  expectStatus(missingDone, 1, "missing done marker should fail", "ANDROID_LIVE_FLOOD_DONE");

  const badLog = path.join(temp, "bad-log");
  writeFixture(badLog);
  fs.writeFileSync(path.join(badLog, "logcat.log"), "FATAL EXCEPTION: main\napp.fieldwork.android crashed\n");
  expectStatus(badLog, 1, "fatal log should fail", "logcat.log must not contain Android fatal, ANR, or exception entries");
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

console.log("Android renderer flood evidence verifier ok");

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
  writePng(path.join(dir, "flood.png"), { width: 1080, height: 2400 });
  fs.writeFileSync(
    path.join(dir, "flood-ui.xml"),
    '<hierarchy><node text="Attached"/><node text="Terminal"/><node text="ANDROID_LIVE_FLOOD"/></hierarchy>\n',
  );
  fs.writeFileSync(path.join(dir, "flood-replay.txt"), writeFloodReplay());
  fs.writeFileSync(path.join(dir, "logcat.log"), "I Fieldwork renderer flood ok\n");
  fs.writeFileSync(path.join(dir, "crash.log"), "\n");
}

function writeFloodReplay(options = {}) {
  const markerCount = options.markerCount ?? 10_000;
  const floodLines = options.floodLines ?? 10_000;
  const lines = [];
  if (options.includeCommand !== false) {
    lines.push("yes ANDROID_LIVE_FLOOD | head -10000");
  }
  lines.push("ANDROID_LIVE_FLOOD_START");
  for (let index = 0; index < markerCount; index += 1) {
    lines.push("ANDROID_LIVE_FLOOD");
  }
  if (options.includeDone !== false) {
    lines.push("ANDROID_LIVE_FLOOD_DONE");
  }
  lines.push(`flood_lines=${floodLines}`);
  return `${lines.join("\n")}\n`;
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
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.status !== expectedStatus) {
    throw new Error(`${message}: exited ${result.status}, expected ${expectedStatus}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  if (expectedOutput && !`${result.stdout}\n${result.stderr}`.includes(expectedOutput)) {
    throw new Error(`${message}: missing output ${JSON.stringify(expectedOutput)}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
}
