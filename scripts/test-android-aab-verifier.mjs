#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fieldwork-android-aab-verifier-"));
const goodBuildConfig = path.join(tempRoot, "BuildConfig.java");
const goodJarsigner = path.join(tempRoot, "jarsigner-ok");
const badJarsigner = path.join(tempRoot, "jarsigner-fail");
const noVerifiedJarsigner = path.join(tempRoot, "jarsigner-no-verified-marker");
const debugCertJarsigner = path.join(tempRoot, "jarsigner-debug-cert");
const relayBuildConfig = path.join(tempRoot, "RelayBuildConfig.java");
writeBuildConfig(goodBuildConfig);
writeBuildConfig(relayBuildConfig, { relayControlUrl: "https://relay.fieldwork.test" });
writeExecutable(goodJarsigner, "#!/usr/bin/env bash\nprintf 'X.509, CN=Fieldwork Release, O=Fieldwork\\njar verified.\\n'\n");
writeExecutable(badJarsigner, "#!/usr/bin/env bash\nprintf 'jar unsigned\\n' >&2\nexit 1\n");
writeExecutable(noVerifiedJarsigner, "#!/usr/bin/env bash\nprintf 'certificate chain verified\\n'\n");
writeExecutable(debugCertJarsigner, "#!/usr/bin/env bash\nprintf 'X.509, CN=Android Debug, O=Android, C=US\\njar verified.\\n'\n");

try {
  const unsigned = writeAab("unsigned", { signed: false });
  run([unsigned], "unsigned synthetic AAB should pass content checks");
  run(["--expect-unsigned", unsigned], "unsigned synthetic AAB should pass unsigned-local checks");

  const signed = writeAab("signed", { signed: true });
  run([signed], "signed synthetic AAB should pass content checks when signature policy is not requested");
  run(["--expect-signed", signed], "signed synthetic AAB should pass signed-release checks");
  run(
    ["--expect-signed", "--expect-relay-control-url", signed],
    "signed synthetic AAB should pass signed-release relay URL checks",
    { FIELDWORK_ANDROID_RELEASE_BUILDCONFIG: relayBuildConfig },
  );
  expectFailure(
    ["--expect-signed", signed],
    "release AAB jarsigner verification failed",
    "signed synthetic AAB must fail when jarsigner verification fails",
    { FIELDWORK_JARSIGNER: badJarsigner },
  );
  expectFailure(
    ["--expect-signed", signed],
    "release AAB jarsigner verification did not report jar verified",
    "signed synthetic AAB must fail when jarsigner exits zero without the verified marker",
    { FIELDWORK_JARSIGNER: noVerifiedJarsigner },
  );
  expectFailure(
    ["--expect-signed", signed],
    "release AAB appears to be signed with the Android debug certificate",
    "signed synthetic AAB must fail when jarsigner reports the Android debug certificate",
    { FIELDWORK_JARSIGNER: debugCertJarsigner },
  );
  expectFailure(
    ["--expect-unsigned", signed],
    "local AAB should be unsigned but contains signature entries",
    "signed synthetic AAB must fail local unsigned-policy checks",
  );
  expectFailure(
    ["--expect-signed", unsigned],
    "release AAB should be signed but contains no META-INF signature entries",
    "unsigned synthetic AAB must fail signed-release checks",
  );
  expectFailure(
    ["--expect-unsigned", "--expect-signed", signed],
    "--expect-unsigned and --expect-signed cannot be used together",
    "mutually exclusive signing policies should fail",
  );
  expectFailure(
    ["--expect-signed", "--expect-relay-control-url", signed],
    "release BuildConfig must set FIELDWORK_RELAY_CONTROL_URL to an https:// relay control endpoint",
    "signed synthetic AAB must fail relay URL checks when the release BuildConfig is empty",
  );

  const httpRelayConfig = path.join(tempRoot, "HttpRelayBuildConfig.java");
  writeBuildConfig(httpRelayConfig, { relayControlUrl: "http://127.0.0.1:8443" });
  expectFailure(
    ["--expect-signed", "--expect-relay-control-url", signed],
    "release BuildConfig must set FIELDWORK_RELAY_CONTROL_URL to an https:// relay control endpoint",
    "signed synthetic AAB must fail relay URL checks when the release BuildConfig uses http",
    { FIELDWORK_ANDROID_RELEASE_BUILDCONFIG: httpRelayConfig },
  );

  const forbiddenPermission = writeAab("forbidden-permission", {
    signed: false,
    extraPermissions: ["android.permission.ACCESS_FINE_LOCATION"],
  });
  expectFailure(
    [forbiddenPermission],
    "AAB manifest unexpectedly contains android.permission.ACCESS_FINE_LOCATION",
    "synthetic AAB with location permission must fail manifest privacy checks",
  );

  const missingPermission = writeAab("missing-permission", {
    signed: false,
    omitPermissions: ["android.permission.POST_NOTIFICATIONS"],
  });
  expectFailure(
    [missingPermission],
    "AAB manifest is missing expected uses-permission android.permission.POST_NOTIFICATIONS",
    "synthetic AAB missing notification permission must fail required-permission checks",
  );

  const terminalContent = writeAab("terminal-content", {
    signed: false,
    extraManifestText: '<meta-data android:name="last_line" android:value="secret" />',
  });
  expectFailure(
    [terminalContent],
    "AAB manifest unexpectedly contains last_line",
    "synthetic AAB with terminal-content metadata must fail manifest privacy checks",
  );

  const sentryDex = writeAab("sentry-dex", {
    signed: false,
    dexText: "Lio/sentry/android/core/SentryAndroid;",
  });
  expectFailure(
    [sentryDex],
    "AAB contains forbidden Sentry SDK marker io/sentry in base/dex/classes.dex",
    "synthetic AAB with Sentry SDK dex marker must fail",
  );

  const wrongVersionConfig = path.join(tempRoot, "WrongVersionBuildConfig.java");
  writeBuildConfig(wrongVersionConfig, { versionCode: 2, versionName: "1.1" });
  expectFailure(
    [unsigned],
    "release BuildConfig must set VERSION_CODE=1",
    "synthetic AAB with wrong release BuildConfig versionCode must fail",
    { FIELDWORK_ANDROID_RELEASE_BUILDCONFIG: wrongVersionConfig },
  );
  expectFailure(
    [unsigned],
    "release BuildConfig must set VERSION_NAME=1.0",
    "synthetic AAB with wrong release BuildConfig versionName must fail",
    { FIELDWORK_ANDROID_RELEASE_BUILDCONFIG: wrongVersionConfig },
  );

  const debugConfig = path.join(tempRoot, "DebugBuildConfig.java");
  writeBuildConfig(debugConfig, { buildType: "debug", debug: "true" });
  expectFailure(
    [unsigned],
    "release BuildConfig must be the release variant",
    "synthetic AAB with debug BuildConfig must fail",
    { FIELDWORK_ANDROID_RELEASE_BUILDCONFIG: debugConfig },
  );

  const debuggableManifest = writeAab("debuggable-manifest", {
    signed: false,
    applicationAttrs: 'android:debuggable="true"',
  });
  expectFailure(
    [debuggableManifest],
    "AAB manifest unexpectedly contains debuggable",
    "synthetic AAB with debuggable manifest must fail",
  );

  console.log("android AAB verifier test ok");
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

function writeAab(name, options) {
  const dir = path.join(tempRoot, name);
  const aab = path.join(tempRoot, `${name}.aab`);
  for (const rel of [
    "base/manifest",
    "base/dex",
    "base/lib/arm64-v8a",
    "base/lib/armeabi-v7a",
    "base/lib/x86_64",
  ]) {
    fs.mkdirSync(path.join(dir, rel), { recursive: true });
  }
  fs.writeFileSync(path.join(dir, "base/manifest/AndroidManifest.xml"), manifestFixture(options));
  for (const rel of [
    "base/lib/arm64-v8a/libfieldwork_mobile_core.so",
    "base/lib/armeabi-v7a/libfieldwork_mobile_core.so",
    "base/lib/x86_64/libfieldwork_mobile_core.so",
  ]) {
    fs.writeFileSync(path.join(dir, rel), `synthetic ${rel}\n`);
  }
  fs.writeFileSync(path.join(dir, "base/dex/classes.dex"), `synthetic classes ${options.dexText || ""}\n`);
  if (options.signed) {
    fs.mkdirSync(path.join(dir, "META-INF"), { recursive: true });
    fs.writeFileSync(path.join(dir, "META-INF/MANIFEST.MF"), "Manifest-Version: 1.0\n");
    fs.writeFileSync(path.join(dir, "META-INF/FIELDWORK.SF"), "Signature-Version: 1.0\n");
    fs.writeFileSync(path.join(dir, "META-INF/FIELDWORK.RSA"), "synthetic signature\n");
  }
  const result = spawnSync("zip", ["-qr", aab, "."], { cwd: dir, encoding: "utf8" });
  if (result.status !== 0) {
    fail(`failed to create synthetic AAB ${name}`, result);
  }
  return aab;
}

function manifestFixture(options = {}) {
  const omitted = new Set(options.omitPermissions || []);
  const permissions = [
    "android.permission.INTERNET",
    "android.permission.CAMERA",
    "android.permission.POST_NOTIFICATIONS",
    "android.permission.USE_BIOMETRIC",
    "android.permission.USE_FINGERPRINT",
    "android.permission.ACCESS_NETWORK_STATE",
    "android.permission.WAKE_LOCK",
    "com.google.android.c2dm.permission.RECEIVE",
    ...(options.extraPermissions || []),
  ]
    .filter((permission) => !omitted.has(permission))
    .map((permission) => `<uses-permission android:name="${permission}" />`)
    .join("\n");

  return `
<manifest package="app.fieldwork.android" android:versionCode="1" android:versionName="1.0">
${permissions}
<application allowBackup="false" dataExtractionRules="@xml/data_extraction_rules" fullBackupContent="@xml/backup_rules" ${options.applicationAttrs || ""}>
  <meta-data android:name="firebase_messaging_auto_init_enabled" android:value="false" />
  <meta-data android:name="firebase_analytics_collection_enabled" android:value="false" />
  ${options.extraManifestText || ""}
  <service android:name="app.fieldwork.android.push.FieldworkFirebaseMessagingService">
    <intent-filter>
      <action android:name="com.google.firebase.MESSAGING_EVENT" />
      <action android:name="FIELDWORK_OPEN_SESSION" />
    </intent-filter>
  </service>
</application>
</manifest>
`.trim();
}

function run(args, message, extraEnv = {}) {
  const result = spawnSync(process.execPath, ["scripts/verify-android-aab.mjs", ...args], {
    cwd: root,
    env: verifierEnv(extraEnv),
    encoding: "utf8",
  });
  if (result.status !== 0) {
    fail(message, result);
  }
  if (!result.stdout.includes("Android AAB ok")) {
    fail(`${message}: missing success marker`, result);
  }
}

function expectFailure(args, expectedOutput, message, extraEnv = {}) {
  const result = spawnSync(process.execPath, ["scripts/verify-android-aab.mjs", ...args], {
    cwd: root,
    env: verifierEnv(extraEnv),
    encoding: "utf8",
  });
  if (result.status === 0) {
    fail(`${message}: command unexpectedly passed`, result);
  }
  const combined = `${result.stdout}\n${result.stderr}`;
  if (!combined.includes(expectedOutput)) {
    fail(`${message}: expected output to include ${expectedOutput}`, result);
  }
}

function verifierEnv(extraEnv = {}) {
  return {
    ...process.env,
    FIELDWORK_ANDROID_RELEASE_BUILDCONFIG: goodBuildConfig,
    FIELDWORK_JARSIGNER: goodJarsigner,
    ...extraEnv,
  };
}

function writeExecutable(file, text) {
  fs.writeFileSync(file, text);
  fs.chmodSync(file, 0o755);
}

function writeBuildConfig(file, options = {}) {
  const {
    applicationId = "app.fieldwork.android",
    buildType = "release",
    debug = "false",
    versionCode = 1,
    versionName = "1.0",
    biometricBypass = "false",
    pairingCode = "",
    relayControlUrl = "",
  } = options;
  fs.writeFileSync(
    file,
    [
      "public final class BuildConfig {",
      `  public static final boolean DEBUG = ${debug};`,
      `  public static final String APPLICATION_ID = "${applicationId}";`,
      `  public static final String BUILD_TYPE = "${buildType}";`,
      `  public static final int VERSION_CODE = ${versionCode};`,
      `  public static final String VERSION_NAME = "${versionName}";`,
      `  public static final boolean FIELDWORK_BIOMETRIC_BYPASS = ${biometricBypass};`,
      `  public static final String FIELDWORK_DEBUG_PAIRING_CODE = "${pairingCode}";`,
      `  public static final String FIELDWORK_RELAY_CONTROL_URL = "${relayControlUrl}";`,
      "}",
    ].join("\n"),
  );
}

function fail(message, result) {
  console.error(message);
  console.error(result?.stdout || "");
  console.error(result?.stderr || "");
  process.exit(1);
}
