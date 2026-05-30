#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fieldwork-android-debug-apk-verifier-"));
const goodBuildConfig = path.join(tempRoot, "BuildConfig.java");

try {
  writeBuildConfig(goodBuildConfig);

  const clean = writeApk("clean", { payload: null });
  run([clean], "clean synthetic debug APK should pass");

  const staleLegacyPayload = writeApk("stale-legacy-payload", {
    payload:
      '{"relay_url":null,"node_id":"2f8c6129d816cf51c374bc7f08c3e63ed156cf78aefb4a6550d97b87997977ee","addrs":["100.125.95.54:56965"],"pair_token":"AQIKRCMGWJH45JK3SOHJI63P4NSOBWKK3NLBAZMHKTIPC5GY3G2Q","expires_at":1779687309358}',
  });
  expectFailure(
    [staleLegacyPayload],
    "debug APK contains a stale legacy JSON pairing payload",
    "stale legacy pairing payload should fail default debug APK verification",
  );
  run(
    ["--expect-legacy-pairing-payload", staleLegacyPayload],
    "explicit legacy pairing payload mode should allow the injected payload",
  );

  const missingAbi = writeApk("missing-abi", { payload: null, omitAbi: "x86_64" });
  expectFailure(
    [missingAbi],
    "debug APK is missing lib/x86_64/libfieldwork_mobile_core.so",
    "missing required ABI should fail",
  );

  const forbiddenManifest = writeApk("forbidden-manifest", {
    payload: null,
    extraManifestText: '<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />',
  });
  expectFailure(
    [forbiddenManifest],
    "debug APK manifest unexpectedly contains android.permission.ACCESS_FINE_LOCATION",
    "forbidden location permission should fail",
  );

  const sentryDex = writeApk("sentry-dex", {
    payload: "Lio/sentry/android/core/SentryAndroid;",
  });
  expectFailure(
    [sentryDex],
    "debug APK contains forbidden Sentry SDK marker io/sentry in classes.dex",
    "forbidden Sentry SDK dex marker should fail",
  );

  const badBuildConfig = path.join(tempRoot, "BadBuildConfig.java");
  writeBuildConfig(badBuildConfig, { pairingCode: "ABCDE" });
  expectFailure(
    [clean],
    "default debug BuildConfig must have an empty debug pairing code",
    "non-empty generated debug BuildConfig code should fail",
    { FIELDWORK_ANDROID_DEBUG_BUILDCONFIG: badBuildConfig },
  );

  console.log("android debug APK verifier test ok");
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

function run(args, message, env = {}) {
  const result = spawnSync(process.execPath, ["scripts/verify-android-debug-apk.mjs", ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, FIELDWORK_ANDROID_DEBUG_BUILDCONFIG: goodBuildConfig, ...env },
  });
  if (result.status !== 0) {
    fail(`${message}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
}

function expectFailure(args, expected, message, env = {}) {
  const result = spawnSync(process.execPath, ["scripts/verify-android-debug-apk.mjs", ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, FIELDWORK_ANDROID_DEBUG_BUILDCONFIG: goodBuildConfig, ...env },
  });
  if (result.status === 0) {
    fail(`${message}: expected failure but command passed`);
  }
  const output = `${result.stdout}\n${result.stderr}`;
  if (!output.includes(expected)) {
    fail(`${message}: expected ${JSON.stringify(expected)} in output\n${output}`);
  }
}

function writeBuildConfig(file, options = {}) {
  fs.writeFileSync(
    file,
    `package app.fieldwork.android;

public final class BuildConfig {
  public static final boolean DEBUG = Boolean.parseBoolean("true");
  public static final String APPLICATION_ID = "app.fieldwork.android";
  public static final String BUILD_TYPE = "debug";
  public static final int VERSION_CODE = 1;
  public static final String VERSION_NAME = "1.0";
  public static final boolean FIELDWORK_BIOMETRIC_BYPASS = false;
  public static final String FIELDWORK_DEBUG_PAIRING_CODE = "${options.pairingCode ?? ""}";
}
`,
  );
}

function writeApk(name, options) {
  const dir = path.join(tempRoot, name);
  const apk = path.join(tempRoot, `${name}.apk`);
  for (const rel of [
    "lib/arm64-v8a",
    "lib/armeabi-v7a",
    "lib/x86_64",
  ]) {
    fs.mkdirSync(path.join(dir, rel), { recursive: true });
  }
  fs.writeFileSync(path.join(dir, "AndroidManifest.xml"), manifestFixture(options));
  for (const rel of [
    "lib/arm64-v8a/libfieldwork_mobile_core.so",
    "lib/armeabi-v7a/libfieldwork_mobile_core.so",
    "lib/x86_64/libfieldwork_mobile_core.so",
  ]) {
    if (!rel.includes(`/${options.omitAbi || "__none__"}/`)) {
      fs.writeFileSync(path.join(dir, rel), `synthetic ${rel}\n`);
    }
  }
  fs.writeFileSync(path.join(dir, "classes.dex"), `synthetic classes ${options.payload || ""}\n`);
  const result = spawnSync("zip", ["-qr", apk, "."], { cwd: dir, encoding: "utf8" });
  if (result.status !== 0) {
    fail(`failed to create synthetic APK ${name}\n${result.stdout}\n${result.stderr}`);
  }
  return apk;
}

function manifestFixture(options = {}) {
  return `<manifest package="app.fieldwork.android" android:versionCode="1" android:versionName="1.0">
<uses-permission android:name="android.permission.INTERNET" />
<uses-permission android:name="android.permission.CAMERA" />
<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
<uses-permission android:name="android.permission.USE_BIOMETRIC" />
${options.extraManifestText || ""}
<application android:label="Fieldwork">
  <meta-data android:name="firebase_messaging_auto_init_enabled" android:value="false" />
  <meta-data android:name="firebase_analytics_collection_enabled" android:value="false" />
  <service android:name="app.fieldwork.android.push.FieldworkFirebaseMessagingService">
    <intent-filter><action android:name="com.google.firebase.MESSAGING_EVENT" /></intent-filter>
  </service>
  <activity android:name="app.fieldwork.android.MainActivity">
    <intent-filter><action android:name="FIELDWORK_OPEN_SESSION" /></intent-filter>
  </activity>
</application>
</manifest>
`;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
