#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const verifier = path.join(root, "scripts/verify-android-release-install-evidence.mjs");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "fieldwork-android-release-install-"));

try {
  const good = writeFixture(path.join(temp, "good"));
  expectStatus(good, 0, "good Android release install evidence should pass");

  const strictGood = writeFixture(path.join(temp, "strict-good"), {
    signerDn: "CN=Fieldwork Android Release,O=Fieldwork,C=US",
    adbDevices: "List of devices attached\nR5CT123456 device product:oriole model:Pixel_6 device:oriole transport_id:1\n",
  });
  expectStatus(strictGood, 0, "strict physical release install evidence should pass", null, ["--strict-release-device"]);

  const strictSmokeCert = writeFixture(path.join(temp, "strict-smoke-cert"), {
    adbDevices: "List of devices attached\nR5CT123456 device product:oriole model:Pixel_6 device:oriole transport_id:1\n",
  });
  expectStatus(
    strictSmokeCert,
    1,
    "strict release-device mode should reject the local smoke certificate",
    "apksigner-universal.txt must not use the local ephemeral release-smoke certificate",
    ["--strict-release-device"],
  );

  const strictEmulator = writeFixture(path.join(temp, "strict-emulator"), {
    signerDn: "CN=Fieldwork Android Release,O=Fieldwork,C=US",
  });
  expectStatus(
    strictEmulator,
    1,
    "strict release-device mode should reject emulator adb evidence",
    "adb-devices.txt must show a physical Android phone, not an emulator or AVD",
    ["--strict-release-device"],
  );

  const unsigned = writeFixture(path.join(temp, "unsigned"));
  fs.writeFileSync(
    path.join(unsigned.apks, "apksigner-universal.txt"),
    [
      "Verifies",
      "Verified using v3 scheme (APK Signature Scheme v3): false",
      "Number of signers: 1",
      "Signer #1 certificate DN: CN=Fieldwork Release Smoke",
    ].join("\n"),
  );
  expectStatus(unsigned, 1, "unsigned APK evidence should fail", "apksigner-universal.txt must prove APK Signature Scheme v3 verification");

  const debugCert = writeFixture(path.join(temp, "debug-cert"));
  fs.writeFileSync(
    path.join(debugCert.apks, "apksigner-universal.txt"),
    [
      "Verifies",
      "Verified using v3 scheme (APK Signature Scheme v3): true",
      "Number of signers: 1",
      "Signer #1 certificate DN: CN=Android Debug,O=Android,C=US",
    ].join("\n"),
  );
  expectStatus(debugCert, 1, "Android debug certificate should fail", "apksigner-universal.txt must prove the ephemeral non-debug release-smoke signer");

  const wrongVersion = writeFixture(path.join(temp, "wrong-version"));
  fs.writeFileSync(
    path.join(wrongVersion.apks, "aapt-badging.txt"),
    [
      "package: name='app.fieldwork.android' versionCode='2' versionName='1.1'",
      "targetSdkVersion:'36'",
      "launchable-activity: name='app.fieldwork.android.MainActivity'",
      "uses-permission: name='android.permission.INTERNET'",
      "uses-permission: name='android.permission.CAMERA'",
      "uses-permission: name='android.permission.POST_NOTIFICATIONS'",
      "uses-permission: name='android.permission.USE_BIOMETRIC'",
      "uses-permission: name='android.permission.ACCESS_NETWORK_STATE'",
    ].join("\n"),
  );
  expectStatus(wrongVersion, 1, "wrong release version should fail", "aapt-badging.txt must prove package identity and v1 release version");

  const forbiddenPermission = writeFixture(path.join(temp, "forbidden-permission"));
  fs.appendFileSync(path.join(forbiddenPermission.apks, "aapt-permissions.txt"), "uses-permission: name='android.permission.RECORD_AUDIO'\n");
  expectStatus(forbiddenPermission, 1, "forbidden permission should fail", "aapt-permissions.txt must not request android.permission.RECORD_AUDIO");

  const manifestDebuggable = writeFixture(path.join(temp, "manifest-debuggable"));
  fs.appendFileSync(path.join(manifestDebuggable.apks, "aapt-manifest-tree.txt"), "A: android:debuggable=true\n");
  expectStatus(manifestDebuggable, 1, "debuggable manifest should fail", "aapt-manifest-tree.txt must not contain debuggable markers");

  const missingInstall = writeFixture(path.join(temp, "missing-install"));
  fs.rmSync(path.join(missingInstall.install, "install.txt"));
  expectStatus(missingInstall, 1, "missing install transcript should fail", "missing evidence file");

  const offlineDevice = writeFixture(path.join(temp, "offline-device"));
  fs.writeFileSync(path.join(offlineDevice.install, "adb-devices.txt"), "List of devices attached\nemulator-5554 offline\n");
  expectStatus(offlineDevice, 1, "offline adb device should fail", "adb-devices.txt must show exactly one authorized Android device, found 0");

  const debuggablePackage = writeFixture(path.join(temp, "debuggable-package"));
  fs.appendFileSync(path.join(debuggablePackage.install, "package-info.txt"), "    flags=[ HAS_CODE DEBUGGABLE ALLOW_CLEAR_USER_DATA ]\n");
  expectStatus(debuggablePackage, 1, "installed DEBUGGABLE flag should fail", "package-info.txt must prove the installed package is not a debug/debuggable build");

  const runAsAllowed = writeFixture(path.join(temp, "run-as-allowed"));
  fs.writeFileSync(path.join(runAsAllowed.install, "run-as.txt"), "uid=10218(app.fieldwork.android) gid=10218(app.fieldwork.android)\n");
  expectStatus(runAsAllowed, 1, "debuggable run-as should fail", "run-as.txt must prove app.fieldwork.android is not debuggable");

  const slowLaunch = writeFixture(path.join(temp, "slow-launch"));
  fs.writeFileSync(path.join(slowLaunch.install, "launch.txt"), writeLaunch(1201));
  expectStatus(slowLaunch, 1, "slow release launch should fail", "launch.txt records TotalTime=1201ms");

  const warmLaunch = writeFixture(path.join(temp, "warm-launch"));
  fs.writeFileSync(path.join(warmLaunch.install, "launch.txt"), writeLaunch(900, { launchState: "HOT" }));
  expectStatus(warmLaunch, 1, "warm launch should fail", "launch.txt must prove the launch was cold");

  const unlockedUi = writeFixture(path.join(temp, "unlocked-ui"));
  fs.writeFileSync(path.join(unlockedUi.install, "locked-ui.xml"), '<hierarchy><node text="No sessions"/></hierarchy>\n');
  expectStatus(unlockedUi, 1, "unlocked UI should fail", "locked-ui.xml must show the locked unlock surface");

  const tinyScreenshot = writeFixture(path.join(temp, "tiny-screenshot"));
  writePng(path.join(tinyScreenshot.install, "locked.png"), { width: 200, height: 320 });
  expectStatus(tinyScreenshot, 1, "tiny screenshot should fail", "locked.png is too small for Android phone evidence");

  const crashLog = writeFixture(path.join(temp, "crash-log"));
  fs.writeFileSync(path.join(crashLog.install, "crash.log"), "FATAL EXCEPTION: main\n");
  expectStatus(crashLog, 1, "crash buffer should fail", "crash.log must not contain Android fatal, ANR, or exception entries");
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

console.log("Android release install evidence verifier ok");

function writeFixture(dir, options = {}) {
  const signerDn = options.signerDn ?? "CN=Fieldwork Release Smoke, O=Fieldwork, L=Local, ST=Local, C=US";
  const adbDevices =
    options.adbDevices ?? "List of devices attached\nemulator-5554 device product:sdk_gphone64_arm64 model:sdk_gphone64_arm64 device:emu64a transport_id:1\n";
  const apks = path.join(dir, "apks");
  const install = path.join(dir, "install");
  fs.mkdirSync(apks, { recursive: true });
  fs.mkdirSync(install, { recursive: true });

  fs.writeFileSync(
    path.join(apks, "summary.txt"),
    [
      "bundletool=/tmp/fieldwork-tools/bundletool-all-1.18.3.jar",
      "apks=/tmp/fieldwork-android-release-install-20260530045350/apks/fieldwork-release-universal.apks",
      "universal_apk=/tmp/fieldwork-android-release-install-20260530045350/apks/universal.apk",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(apks, "apksigner-universal.txt"),
    [
      "Verifies",
      "Verified using v1 scheme (JAR signing): false",
      "Verified using v2 scheme (APK Signature Scheme v2): false",
      "Verified using v3 scheme (APK Signature Scheme v3): true",
      "Number of signers: 1",
      `Signer #1 certificate DN: ${signerDn}`,
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(apks, "aapt-badging.txt"),
    [
      "package: name='app.fieldwork.android' versionCode='1' versionName='1.0'",
      "targetSdkVersion:'36'",
      "launchable-activity: name='app.fieldwork.android.MainActivity'",
      "uses-permission: name='android.permission.INTERNET'",
      "uses-permission: name='android.permission.CAMERA'",
      "uses-permission: name='android.permission.POST_NOTIFICATIONS'",
      "uses-permission: name='android.permission.USE_BIOMETRIC'",
      "uses-permission: name='android.permission.ACCESS_NETWORK_STATE'",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(apks, "aapt-permissions.txt"),
    [
      "package: app.fieldwork.android",
      "uses-permission: name='android.permission.INTERNET'",
      "uses-permission: name='android.permission.CAMERA'",
      "uses-permission: name='android.permission.POST_NOTIFICATIONS'",
      "uses-permission: name='android.permission.USE_BIOMETRIC'",
      "uses-permission: name='android.permission.ACCESS_NETWORK_STATE'",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(apks, "aapt-manifest-tree.txt"),
    [
      "N: android=http://schemas.android.com/apk/res/android",
      "E: manifest",
      "  A: android:versionCode(0x0101021b)=1",
      '  A: android:versionName(0x0101021c)="1.0" (Raw: "1.0")',
      '  A: package="app.fieldwork.android" (Raw: "app.fieldwork.android")',
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(apks, "sha256.txt"),
    [
      "3f7a19f5a41a557e75d23a13c63e45e05501e831fcb57cf39be38b09e7227e4a  /tmp/fieldwork-android-release-install-20260530045350/apks/fieldwork-release-universal.apks",
      "f89c2abb3899264b2f8d42060b533cf38f1bd6934b3ea384ca028b08fd2df643  /tmp/fieldwork-android-release-install-20260530045350/apks/universal.apk",
    ].join("\n"),
  );

  fs.writeFileSync(path.join(install, "adb-devices.txt"), adbDevices);
  fs.writeFileSync(path.join(install, "install.txt"), "Performing Streamed Install\nSuccess\n");
  fs.writeFileSync(path.join(install, "pm-path.txt"), "package:/data/app/~~hash/app.fieldwork.android/base.apk\n");
  fs.writeFileSync(
    path.join(install, "package-info.txt"),
    [
      "Packages:",
      "  Package [app.fieldwork.android] (abc):",
      "    versionCode=1 minSdk=30 targetSdk=36",
      "    versionName=1.0",
      "    apkSigningVersion=3",
      "    flags=[ HAS_CODE ALLOW_CLEAR_USER_DATA ]",
    ].join("\n"),
  );
  fs.writeFileSync(path.join(install, "run-as.txt"), "run-as: package not debuggable: app.fieldwork.android\n");
  fs.writeFileSync(path.join(install, "resolve-activity.txt"), "app.fieldwork.android/.MainActivity\n");
  fs.writeFileSync(path.join(install, "launch.txt"), writeLaunch(914));
  writePng(path.join(install, "locked.png"), { width: 1080, height: 2400 });
  fs.writeFileSync(path.join(install, "locked-ui.xml"), '<hierarchy><node text="Unlock"/></hierarchy>\n');
  fs.writeFileSync(path.join(install, "logcat.log"), "I Fieldwork release install smoke ok\n");
  fs.writeFileSync(path.join(install, "crash.log"), "\n");
  fs.writeFileSync(
    path.join(install, "sha256.txt"),
    [
      "f89c2abb3899264b2f8d42060b533cf38f1bd6934b3ea384ca028b08fd2df643  /tmp/fieldwork-android-release-install-20260530045350/apks/universal.apk",
      "1ccff806dd6e6b9d065d948a7e4697508fc986683a798e3e90727df53dd706d6  /tmp/fieldwork-android-release-install-20260530045350/locked.png",
    ].join("\n"),
  );

  return { apks, install };
}

function writeLaunch(totalTime, options = {}) {
  const launchState = options.launchState ?? "COLD";
  return [
    "Starting: Intent { cmp=app.fieldwork.android/.MainActivity }",
    "Status: ok",
    `LaunchState: ${launchState}`,
    "Activity: app.fieldwork.android/.MainActivity",
    `TotalTime: ${totalTime}`,
    `WaitTime: ${totalTime + 5}`,
    "Complete",
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

function expectStatus(fixture, expectedStatus, message, expectedOutput = null, verifierArgs = []) {
  const result = spawnSync(process.execPath, [verifier, ...verifierArgs, fixture.apks, fixture.install], {
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
