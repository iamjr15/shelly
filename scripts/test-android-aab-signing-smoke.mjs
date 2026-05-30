#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const args = process.argv.slice(2);
const aabArg = args.find((arg) => !arg.startsWith("--"));
const unsignedAab = path.resolve(
  root,
  aabArg || "apps/android/app/build/outputs/bundle/release/app-release.aab",
);
const keytool = process.env.FIELDWORK_KEYTOOL || "keytool";
const jarsigner = process.env.FIELDWORK_JARSIGNER || "jarsigner";
const alias = "fieldwork_release_smoke";
const password = "fieldwork-smoke-pass";
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fieldwork-android-aab-signing-"));
const keystore = path.join(tempRoot, "release-smoke.p12");
const signedAab = path.join(tempRoot, "fieldwork-release-smoke-signed.aab");

try {
  if (!fs.existsSync(unsignedAab)) {
    fail(
      `Android App Bundle not found: ${path.relative(root, unsignedAab)}; run apps/android/gradlew --no-daemon bundleRelease first`,
    );
  }

  run(keytool, [
    "-genkeypair",
    "-keystore",
    keystore,
    "-storetype",
    "PKCS12",
    "-storepass",
    password,
    "-keypass",
    password,
    "-alias",
    alias,
    "-keyalg",
    "RSA",
    "-keysize",
    "2048",
    "-validity",
    "1",
    "-dname",
    "CN=Fieldwork Release Smoke, OU=Release, O=Fieldwork, L=Local, ST=Local, C=US",
    "-noprompt",
  ]);

  run(jarsigner, [
    "-keystore",
    keystore,
    "-storetype",
    "PKCS12",
    "-storepass",
    password,
    "-keypass",
    password,
    "-signedjar",
    signedAab,
    unsignedAab,
    alias,
  ]);

  const verifier = spawnSync(process.execPath, [
    "scripts/verify-android-aab.mjs",
    "--expect-signed",
    signedAab,
  ], {
    cwd: root,
    env: {
      ...process.env,
      FIELDWORK_JARSIGNER: jarsigner,
    },
    encoding: "utf8",
  });
  if (verifier.status !== 0) {
    fail("signed Android AAB smoke verification failed", verifier);
  }
  if (!verifier.stdout.includes("signed release bundle ok")) {
    fail("signed Android AAB smoke verification did not report signed release bundle ok", verifier);
  }

  console.log("Android AAB local signing smoke ok");
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

function run(command, commandArgs) {
  const result = spawnSync(command, commandArgs, {
    cwd: root,
    encoding: "utf8",
  });
  if (result.error) {
    fail(`${command} failed to start: ${result.error.message}`, result);
  }
  if (result.status !== 0) {
    fail(`${command} failed with exit code ${result.status}`, result);
  }
}

function fail(message, result) {
  console.error(message);
  if (result?.stdout) {
    console.error(result.stdout.trim());
  }
  if (result?.stderr) {
    console.error(result.stderr.trim());
  }
  process.exit(1);
}
