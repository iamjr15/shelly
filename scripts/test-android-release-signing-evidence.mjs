#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const verifier = path.join(root, "scripts/verify-android-release-signing-evidence.mjs");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "fieldwork-android-release-signing-"));

try {
  const good = writeFixture(path.join(temp, "good"));
  expectStatus(good, 0, "good Android release signing evidence should pass");

  const missing = writeFixture(path.join(temp, "missing"));
  fs.rmSync(path.join(missing, "jarsigner.txt"));
  expectStatus(missing, 1, "missing jarsigner evidence should fail", "missing evidence file: jarsigner.txt");

  const unsigned = writeFixture(path.join(temp, "unsigned"));
  fs.writeFileSync(path.join(unsigned, "artifact-signing.txt"), "Android AAB ok; unsigned local bundle ok\n");
  expectStatus(unsigned, 1, "unsigned verifier output should fail", "artifact-signing.txt must not describe an unsigned bundle");

  const noJarVerified = writeFixture(path.join(temp, "no-jar-verified"));
  fs.writeFileSync(path.join(noJarVerified, "jarsigner.txt"), "s = signature was verified\nCN=Fieldwork Release,O=Fieldwork\n");
  expectStatus(noJarVerified, 1, "jarsigner output without jar verified should fail", "jarsigner.txt must contain jar verified");

  const debugCert = writeFixture(path.join(temp, "debug-cert"));
  fs.appendFileSync(path.join(debugCert, "jarsigner.txt"), "\nX.509, CN=Android Debug,O=Android,C=US\n");
  expectStatus(debugCert, 1, "Android debug certificate should fail", "jarsigner.txt must not use the Android debug certificate");

  const smokeCert = writeFixture(path.join(temp, "smoke-cert"));
  fs.appendFileSync(path.join(smokeCert, "jarsigner.txt"), "\nX.509, CN=Fieldwork Release Smoke,O=Fieldwork\n");
  expectStatus(smokeCert, 1, "local smoke certificate should fail", "jarsigner.txt must not use the local ephemeral release-smoke certificate");

  const badBuildConfig = writeFixture(path.join(temp, "bad-buildconfig"));
  fs.writeFileSync(path.join(badBuildConfig, "buildconfig.txt"), 'public static final String BUILD_TYPE = "debug";\n');
  expectStatus(badBuildConfig, 1, "debug BuildConfig should fail", "buildconfig.txt must prove release build type");

  const badRelayBuildConfig = writeFixture(path.join(temp, "bad-relay-buildconfig"));
  fs.writeFileSync(
    path.join(badRelayBuildConfig, "buildconfig.txt"),
    [
      'public static final String APPLICATION_ID = "app.fieldwork.android";',
      'public static final String BUILD_TYPE = "release";',
      "public static final boolean DEBUG = false;",
      "public static final int VERSION_CODE = 1;",
      'public static final String VERSION_NAME = "1.0";',
      "public static final boolean FIELDWORK_BIOMETRIC_BYPASS = false;",
      'public static final String FIELDWORK_DEBUG_PAIRING_CODE = "";',
      'public static final String FIELDWORK_RELAY_CONTROL_URL = "http://127.0.0.1:8443";',
    ].join("\n"),
  );
  expectStatus(
    badRelayBuildConfig,
    1,
    "non-HTTPS relay BuildConfig should fail",
    "buildconfig.txt must prove FIELDWORK_RELAY_CONTROL_URL is an https:// relay control endpoint",
  );

  const badWorkflow = writeFixture(path.join(temp, "bad-workflow"));
  fs.writeFileSync(path.join(badWorkflow, "workflow-run.txt"), "workflow=ci.yml\nref=main\nrun_id=123\n");
  expectStatus(badWorkflow, 1, "wrong workflow/ref should fail", "workflow-run.txt must identify release-android.yml");

  const badSha = writeFixture(path.join(temp, "bad-sha"));
  fs.writeFileSync(path.join(badSha, "sha256.txt"), "not-a-sha  app-release.aab\n");
  expectStatus(badSha, 1, "bad sha256 should fail", "sha256.txt must hash the signed release AAB");
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

console.log("Android release signing evidence verifier ok");

function writeFixture(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "artifact-signing.txt"),
    [
      "Android AAB ok: base/lib/arm64-v8a/libfieldwork_mobile_core.so, base/lib/armeabi-v7a/libfieldwork_mobile_core.so, base/lib/x86_64/libfieldwork_mobile_core.so; packaged manifest identity, version, uses-permission allowlist, and privacy surface ok; signed release bundle ok",
      "release relay control URL ok",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(dir, "jarsigner.txt"),
    [
      "s = signature was verified",
      "X.509, CN=Fieldwork Android Release,O=Fieldwork,L=Local,ST=Local,C=US",
      "jar verified.",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(dir, "sha256.txt"),
    "af38adfb7541caf31c45afa216c61c4fa2dbce9ab1168ce91181f91a1f0ccca8  app-release.aab\n",
  );
  fs.writeFileSync(
    path.join(dir, "buildconfig.txt"),
    [
      'public static final String APPLICATION_ID = "app.fieldwork.android";',
      'public static final String BUILD_TYPE = "release";',
      "public static final boolean DEBUG = false;",
      "public static final int VERSION_CODE = 1;",
      'public static final String VERSION_NAME = "1.0";',
      "public static final boolean FIELDWORK_BIOMETRIC_BYPASS = false;",
      'public static final String FIELDWORK_DEBUG_PAIRING_CODE = "";',
      'public static final String FIELDWORK_RELAY_CONTROL_URL = "https://relay.fieldwork.test";',
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(dir, "workflow-run.txt"),
    [
      "workflow=release-android.yml",
      "ref=android-v1.0.0",
      "tag=android-v1.0.0",
      "run_id=123456789",
      "run-url=https://github.com/fieldwork-app/fieldwork/actions/runs/123456789",
    ].join("\n"),
  );
  return dir;
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
