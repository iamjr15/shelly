#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import zlib from "node:zlib";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const verifier = path.join(root, "scripts/verify-android-dogfood-evidence.mjs");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "fieldwork-android-dogfood-"));
const crc32Table = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

try {
  const good = path.join(temp, "good");
  writeFixture(good);
  expectStatus(good, 0, "good dogfood evidence should pass");

  const missingDuration = path.join(temp, "missing-duration");
  writeFixture(missingDuration);
  fs.rmSync(path.join(missingDuration, "dogfood-duration.txt"));
  expectStatus(missingDuration, 1, "missing duration evidence should fail", "missing evidence file: dogfood-duration.txt");

  const shortDuration = path.join(temp, "short-duration");
  writeFixture(shortDuration);
  fs.writeFileSync(
    path.join(shortDuration, "dogfood-duration.txt"),
    "dogfood_started_at=2026-05-22T10:00:00Z\ndogfood_finished_at=2026-05-22T10:10:00Z\ndogfood_duration_ms=1799999\ntermlib_decision_candidate=pass\n",
  );
  expectStatus(shortDuration, 1, "short dogfood duration should fail", "dogfood-duration.txt records dogfood_duration_ms=1799999");

  const noHumanPass = path.join(temp, "no-human-pass");
  writeFixture(noHumanPass);
  fs.writeFileSync(
    path.join(noHumanPass, "dogfood-duration.txt"),
    "dogfood_started_at=2026-05-22T10:00:00Z\ndogfood_finished_at=2026-05-22T10:30:01Z\ndogfood_duration_ms=1801000\n",
  );
  expectStatus(noHumanPass, 1, "missing human decision marker should fail", "dogfood-duration.txt must record termlib_decision_candidate=pass");

  const emulatorDevice = path.join(temp, "emulator-device");
  writeFixture(emulatorDevice);
  fs.writeFileSync(
    path.join(emulatorDevice, "adb-devices.txt"),
    "List of devices attached\nemulator-5554 device product:sdk_gphone64_arm64 model:sdk_gphone64_arm64 device:emu64a transport_id:1\n",
  );
  expectStatus(emulatorDevice, 1, "emulator adb device should fail", "adb-devices.txt must show a physical Android phone");

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

  const bypassBuild = path.join(temp, "bypass-build");
  writeFixture(bypassBuild);
  fs.writeFileSync(
    path.join(bypassBuild, "buildconfig.txt"),
    [
      'public static final String APPLICATION_ID = "app.fieldwork.android";',
      'public static final String BUILD_TYPE = "release";',
      "public static final boolean DEBUG = false;",
      "public static final boolean FIELDWORK_BIOMETRIC_BYPASS = true;",
      'public static final String FIELDWORK_DEBUG_PAIRING_CODE = "";',
    ].join("\n"),
  );
  expectStatus(bypassBuild, 1, "biometric bypass build should fail", "buildconfig.txt must prove biometric bypass is disabled");

  const debugBuild = path.join(temp, "debug-build");
  writeFixture(debugBuild);
  fs.writeFileSync(
    path.join(debugBuild, "buildconfig.txt"),
    [
      'public static final String APPLICATION_ID = "app.fieldwork.android";',
      'public static final String BUILD_TYPE = "debug";',
      'public static final boolean DEBUG = Boolean.parseBoolean("true");',
      "public static final boolean FIELDWORK_BIOMETRIC_BYPASS = false;",
      'public static final String FIELDWORK_DEBUG_PAIRING_CODE = "";',
    ].join("\n"),
  );
  expectStatus(debugBuild, 1, "debug dogfood build should fail", "buildconfig.txt must prove the installed test build is the release variant");

  const debugPairingBuild = path.join(temp, "debug-pairing-build");
  writeFixture(debugPairingBuild);
  fs.writeFileSync(
    path.join(debugPairingBuild, "buildconfig.txt"),
    [
      'public static final String APPLICATION_ID = "app.fieldwork.android";',
      'public static final String BUILD_TYPE = "release";',
      "public static final boolean DEBUG = false;",
      "public static final boolean FIELDWORK_BIOMETRIC_BYPASS = false;",
      'public static final String FIELDWORK_DEBUG_PAIRING_CODE = "A1B2C";',
    ].join("\n"),
  );
  expectStatus(debugPairingBuild, 1, "debug pairing code build should fail", "buildconfig.txt must prove no debug pairing code is compiled in");

  const badTyping = path.join(temp, "bad-typing");
  writeFixture(badTyping);
  fs.writeFileSync(path.join(badTyping, "typing-replay.txt"), "refactoringjob claude\n");
  expectStatus(badTyping, 1, "missing typing marker should fail", "typing-replay.txt must include Android-originated typed input");

  const badScroll = path.join(temp, "bad-scroll");
  writeFixture(badScroll);
  fs.writeFileSync(path.join(badScroll, "scroll-replay.txt"), "DOGFOOD_SCROLL_TOP\nDOGFOOD_SCROLL_BOTTOM\n");
  expectStatus(badScroll, 1, "missing scroll operator marker should fail", "scroll-replay.txt must record scroll_verified_by_operator");

  const badResize = path.join(temp, "bad-resize");
  writeFixture(badResize);
  fs.writeFileSync(path.join(badResize, "resize-replay.txt"), "resize_size=1x5\ndogfood_resize_ok\n");
  expectStatus(badResize, 1, "implausible resize should fail", "resize-replay.txt records implausible terminal size 1x5");

  const badPaste = path.join(temp, "bad-paste");
  writeFixture(badPaste);
  fs.writeFileSync(path.join(badPaste, "paste-replay.txt"), "DOGFOOD_PASTE_BEGIN\ndogfood_paste_line_001\nDOGFOOD_PASTE_END\ndogfood_paste_ok\n");
  expectStatus(badPaste, 1, "missing paste line should fail", "paste-replay.txt must include dogfood_paste_line_020");

  const crash = path.join(temp, "crash");
  writeFixture(crash);
  fs.writeFileSync(path.join(crash, "final-crash.log"), "FATAL EXCEPTION: main\nProcess: app.fieldwork.android\n");
  expectStatus(crash, 1, "crash-buffer evidence should fail", "final-crash.log must be empty after adb logcat -c");
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

console.log("android dogfood evidence verifier ok");

function writeFixture(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "adb-devices.txt"),
    "List of devices attached\nR58M1234567 device product:panther model:Pixel_8_Pro device:panther transport_id:1\n",
  );
  writePackageInfo(dir);
  fs.writeFileSync(
    path.join(dir, "buildconfig.txt"),
    [
      'public static final String APPLICATION_ID = "app.fieldwork.android";',
      'public static final String BUILD_TYPE = "release";',
      "public static final boolean DEBUG = false;",
      "public static final boolean FIELDWORK_BIOMETRIC_BYPASS = false;",
      'public static final String FIELDWORK_DEBUG_PAIRING_CODE = "";',
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(dir, "dogfood-duration.txt"),
    "dogfood_started_at=2026-05-22T10:00:00Z\ndogfood_finished_at=2026-05-22T10:30:01Z\ndogfood_duration_ms=1801000\ntermlib_decision_candidate=pass\n",
  );
  for (const file of ["claude.png", "scroll.png", "resize.png", "paste.png"]) {
    writePng(path.join(dir, file));
  }
  fs.writeFileSync(path.join(dir, "claude-ui.xml"), '<hierarchy><node text="refactoringjob"/><node text="claude"/><node text="Attached"/></hierarchy>\n');
  fs.writeFileSync(path.join(dir, "scroll-ui.xml"), '<hierarchy><node text="Attached"/><node text="DOGFOOD_SCROLL_BOTTOM"/></hierarchy>\n');
  fs.writeFileSync(path.join(dir, "resize-ui.xml"), '<hierarchy><node text="Attached"/><node text="dogfood_resize_ok"/></hierarchy>\n');
  fs.writeFileSync(path.join(dir, "paste-ui.xml"), '<hierarchy><node text="Attached"/><node text="dogfood_paste_ok"/></hierarchy>\n');
  fs.writeFileSync(path.join(dir, "typing-replay.txt"), "refactoringjob claude\ndogfood_typing_ok\n");
  fs.writeFileSync(path.join(dir, "scroll-replay.txt"), "DOGFOOD_SCROLL_TOP\nDOGFOOD_SCROLL_BOTTOM\nscroll_verified_by_operator\n");
  fs.writeFileSync(path.join(dir, "resize-replay.txt"), "resize_size=32x120\ndogfood_resize_ok\n");
  fs.writeFileSync(
    path.join(dir, "paste-replay.txt"),
    [
      "DOGFOOD_PASTE_BEGIN",
      ...Array.from({ length: 20 }, (_, index) => `dogfood_paste_line_${String(index + 1).padStart(3, "0")}`),
      "DOGFOOD_PASTE_END",
      "dogfood_paste_ok",
    ].join("\n"),
  );
  for (const name of ["claude", "scroll", "resize", "paste", "final"]) {
    fs.writeFileSync(path.join(dir, `${name}-logcat.log`), `I Fieldwork: ${name} dogfood evidence\n`);
    fs.writeFileSync(path.join(dir, `${name}-crash.log`), "");
  }
}

function writePackageInfo(dir) {
  fs.writeFileSync(
    path.join(dir, "package-info.txt"),
    [
      "package:/data/app/~~hash/app.fieldwork.android-base.apk",
      "Packages:",
      "  Package [app.fieldwork.android] (abc):",
      "    versionCode=1 minSdk=30 targetSdk=36",
      "    versionName=1.0",
    ].join("\n"),
  );
}

function writePng(file) {
  const width = 360;
  const height = 640;
  const rowBytes = width * 4;
  const raw = Buffer.alloc((rowBytes + 1) * height);
  let offset = 0;
  for (let y = 0; y < height; y += 1) {
    raw[offset] = 0;
    offset += 1;
    for (let x = 0; x < width; x += 1) {
      raw[offset] = (x * 3 + y) & 0xff;
      raw[offset + 1] = (x + y * 2) & 0xff;
      raw[offset + 2] = x > 90 && x < 270 && y > 220 && y < 420 ? 240 : 36;
      raw[offset + 3] = 255;
      offset += 4;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
  fs.writeFileSync(file, png);
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0);
  return Buffer.concat([length, typeBytes, data, crc]);
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = (crc >>> 8) ^ crc32Table[(crc ^ byte) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
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
