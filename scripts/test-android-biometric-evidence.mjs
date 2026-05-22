#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const verifier = path.join(root, "scripts/verify-android-biometric-evidence.mjs");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "fieldwork-android-biometric-"));

try {
  const good = path.join(temp, "good");
  writeFixture(good);
  expectStatus(good, 0, "good Android biometric evidence should pass");

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
  expectStatus(bypassBuild, 1, "biometric bypass should fail", "buildconfig.txt must prove biometric bypass is disabled");

  const unsigned = path.join(temp, "unsigned");
  writeFixture(unsigned);
  fs.writeFileSync(path.join(unsigned, "artifact-signing.txt"), "Android AAB ok: unsigned local bundle ok\n");
  expectStatus(unsigned, 1, "unsigned AAB evidence should fail", "artifact-signing.txt must prove the release App Bundle was signed");

  const missingSession = path.join(temp, "missing-session");
  writeFixture(missingSession);
  fs.writeFileSync(path.join(missingSession, "sessions.txt"), "shell bash\n");
  expectStatus(missingSession, 1, "missing paired session should fail", "sessions.txt must include the named shortcut refactoringjob");

  const lockedLeak = path.join(temp, "locked-leak");
  writeFixture(lockedLeak);
  fs.writeFileSync(path.join(lockedLeak, "locked-ui.xml"), '<hierarchy><node text="Unlock"/><node text="refactoringjob"/></hierarchy>\n');
  expectStatus(lockedLeak, 1, "locked session leak should fail", "locked-ui.xml must not expose session");

  const promptMissing = path.join(temp, "prompt-missing");
  writeFixture(promptMissing);
  fs.writeFileSync(path.join(promptMissing, "biometric-ui.xml"), '<hierarchy><node text="Unlock"/></hierarchy>\n');
  expectStatus(promptMissing, 1, "missing biometric prompt should fail", "biometric-ui.xml must show the Android biometric prompt");

  const promptLeak = path.join(temp, "prompt-leak");
  writeFixture(promptLeak);
  fs.writeFileSync(path.join(promptLeak, "biometric-ui.xml"), '<hierarchy><node text="Confirm fingerprint"/><node text="bash"/></hierarchy>\n');
  expectStatus(promptLeak, 1, "prompt content leak should fail", "biometric-ui.xml must not expose session or terminal content behind the prompt");

  const preUnlockLog = path.join(temp, "pre-unlock-log");
  writeFixture(preUnlockLog);
  fs.writeFileSync(path.join(preUnlockLog, "biometric-logcat.log"), "I FieldworkRepository: listSessions returned 3 sessions\n");
  expectStatus(preUnlockLog, 1, "pre-unlock session sync should fail", "biometric-logcat.log must not show session sync");

  const earlyStale = path.join(temp, "early-stale");
  writeFixture(earlyStale);
  fs.writeFileSync(path.join(earlyStale, "stale-biometric.txt"), "stale_background_ms=299999\nstale_input_before_unlock_blocked\n");
  expectStatus(earlyStale, 1, "early stale resume should fail", "stale_background_ms=299999");

  const staleInputLeak = path.join(temp, "stale-input-leak");
  writeFixture(staleInputLeak);
  fs.writeFileSync(
    path.join(staleInputLeak, "stale-biometric.txt"),
    "stale_background_ms=300000\nstale_input_before_unlock_blocked\nstale_input_before_unlock_sent\n",
  );
  expectStatus(staleInputLeak, 1, "stale input leak should fail", "stale-biometric.txt must not show stale terminal input was sent");

  const badLog = path.join(temp, "bad-log");
  writeFixture(badLog);
  fs.writeFileSync(path.join(badLog, "locked-logcat.log"), "FATAL EXCEPTION: main\napp.fieldwork.android crashed\n");
  expectStatus(badLog, 1, "fatal log should fail", "locked-logcat.log must not contain Fieldwork fatal, ANR, or exception entries");
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

console.log("Android biometric evidence verifier ok");

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
  fs.writeFileSync(path.join(dir, "devices.txt"), "Android Pixel_6 paired device\n");
  fs.writeFileSync(
    path.join(dir, "launch.txt"),
    "Status: ok\nLaunchState: COLD\nActivity: app.fieldwork.android/.MainActivity\nTotalTime: 920\n",
  );
  writePng(path.join(dir, "locked.png"), { width: 1080, height: 2400 });
  fs.writeFileSync(path.join(dir, "locked-ui.xml"), '<hierarchy><node text="Unlock"/></hierarchy>\n');
  fs.writeFileSync(path.join(dir, "locked-logcat.log"), "I Fieldwork locked surface shown\n");
  fs.writeFileSync(path.join(dir, "locked-crash.log"), "\n");
  writePng(path.join(dir, "biometric.png"), { width: 1080, height: 2400 });
  fs.writeFileSync(path.join(dir, "biometric-ui.xml"), '<hierarchy><node text="Confirm fingerprint"/><node text="Touch the fingerprint sensor"/></hierarchy>\n');
  fs.writeFileSync(path.join(dir, "biometric-logcat.log"), "I Fieldwork biometric prompt shown\n");
  fs.writeFileSync(path.join(dir, "biometric-crash.log"), "\n");
  writePng(path.join(dir, "stale-biometric.png"), { width: 1080, height: 2400 });
  fs.writeFileSync(path.join(dir, "stale-biometric-ui.xml"), '<hierarchy><node text="Confirm fingerprint"/><node text="Touch the fingerprint sensor"/></hierarchy>\n');
  fs.writeFileSync(path.join(dir, "stale-biometric-logcat.log"), "I Fieldwork stale biometric prompt shown\n");
  fs.writeFileSync(path.join(dir, "stale-biometric-crash.log"), "\n");
  fs.writeFileSync(path.join(dir, "stale-biometric.txt"), "stale_background_ms=300000\nstale_input_before_unlock_blocked\n");
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
