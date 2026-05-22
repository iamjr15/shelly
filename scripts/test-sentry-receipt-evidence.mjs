#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const verifier = path.join(root, "scripts/verify-sentry-receipt-evidence.mjs");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "fieldwork-sentry-receipt-"));

try {
  const good = path.join(temp, "good");
  writeFixture(good);
  expectStatus(good, 0, "good Sentry receipt evidence should pass");

  const rawDsn = path.join(temp, "raw-dsn");
  writeFixture(rawDsn);
  fs.writeFileSync(path.join(rawDsn, "sentry-project.txt"), "project=fieldwork\nenvironment=release-candidate\nrelease=fieldwork@1.0.0\ndsn=https://abc123@o1.ingest.sentry.io/2\n");
  expectStatus(rawDsn, 1, "raw DSN evidence should fail", "must not contain a raw Sentry DSN");

  const noOptIn = path.join(temp, "no-opt-in");
  writeFixture(noOptIn);
  fs.writeFileSync(path.join(noOptIn, "daemon-telemetry.txt"), "fieldwork settings telemetry status: disabled\nfieldworkd_sentry_receipt\n");
  expectStatus(noOptIn, 1, "daemon without explicit opt-in should fail", "explicitly opted in");

  const debugAndroid = path.join(temp, "debug-android");
  writeFixture(debugAndroid);
  fs.writeFileSync(path.join(debugAndroid, "android-buildconfig.txt"), writeAndroidBuildConfig().replace('BUILD_TYPE = "release"', 'BUILD_TYPE = "debug"'));
  expectStatus(debugAndroid, 1, "debug Android build should fail", "Android release variant");

  const missingIos = path.join(temp, "missing-ios");
  writeFixture(missingIos);
  fs.rmSync(path.join(missingIos, "ios-event.json"));
  expectStatus(missingIos, 1, "missing iOS event should fail", "ios-event.json is missing");

  const terminalLeak = path.join(temp, "terminal-leak");
  writeFixture(terminalLeak);
  fs.writeFileSync(
    path.join(terminalLeak, "android-event.json"),
    JSON.stringify({
      release: "fieldwork@1.0.0",
      environment: "release-candidate",
      platform: "android",
      service: "app.fieldwork.android",
      message: "android_sentry_receipt",
      last_line: "secret terminal output",
    }),
  );
  expectStatus(terminalLeak, 1, "terminal-content event should fail", "must not contain session, terminal, daemon, or push-token fields");

  const commandLeak = path.join(temp, "command-leak");
  writeFixture(commandLeak);
  fs.writeFileSync(
    path.join(commandLeak, "daemon-event.json"),
    JSON.stringify({
      release: "fieldwork@1.0.0",
      environment: "release-candidate",
      platform: "rust",
      service: "fieldworkd",
      message: "fieldworkd_sentry_receipt",
      command: "claude",
    }),
  );
  expectStatus(commandLeak, 1, "command leak should fail", "must not contain command, cwd, path, or plaintext session-name values");

  const screenshotLeak = path.join(temp, "screenshot-leak");
  writeFixture(screenshotLeak);
  fs.writeFileSync(
    path.join(screenshotLeak, "ios-event.json"),
    JSON.stringify({
      release: "fieldwork@1.0.0",
      environment: "release-candidate",
      platform: "ios",
      service: "app.fieldwork.ios",
      message: "ios_sentry_receipt",
      screenshot: "base64-pixels",
    }),
  );
  expectStatus(screenshotLeak, 1, "screenshot event should fail", "must not contain screenshots or session replay data");
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

console.log("Sentry receipt evidence verifier ok");

function writeFixture(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "sentry-project.txt"), "project=fieldwork\nenvironment=release-candidate\nrelease=fieldwork@1.0.0\ndsn=<redacted>\nauth_token=<redacted>\n");
  fs.writeFileSync(path.join(dir, "privacy-review.txt"), "send_default_pii=false\ntraces_sample_rate=0.0\nsession_replay=false\nscreenshots=false\nuser_interaction_tracing=false\nterminal_content_attached=false\n");
  fs.writeFileSync(path.join(dir, "daemon-telemetry.txt"), "fieldwork settings telemetry on --sentry-dsn <redacted>\nfieldwork settings telemetry status: enabled\nsend_default_pii=false\ntraces_sample_rate=0.0\ndaemon_test_event=fieldworkd_sentry_receipt\n");
  fs.writeFileSync(path.join(dir, "daemon-event.json"), JSON.stringify(sentryEvent("fieldworkd", "rust", "fieldworkd_sentry_receipt"), null, 2));
  fs.writeFileSync(path.join(dir, "android-buildconfig.txt"), writeAndroidBuildConfig());
  fs.writeFileSync(path.join(dir, "android-settings-ui.xml"), '<hierarchy><node text="Share crash reports" checked="true"/></hierarchy>\n');
  fs.writeFileSync(path.join(dir, "android-event.json"), JSON.stringify(sentryEvent("app.fieldwork.android", "android", "android_sentry_receipt"), null, 2));
  fs.writeFileSync(path.join(dir, "ios-settings.txt"), "Share crash reports\nenabled=true\nFieldworkSentryDsn=<redacted>\n");
  fs.writeFileSync(path.join(dir, "ios-event.json"), JSON.stringify(sentryEvent("app.fieldwork.ios", "ios", "ios_sentry_receipt"), null, 2));
}

function writeAndroidBuildConfig() {
  return [
    'APPLICATION_ID = "app.fieldwork.android"',
    'BUILD_TYPE = "release"',
    "DEBUG = false",
    'FIELDWORK_SENTRY_DSN = "<redacted>"',
  ].join("\n") + "\n";
}

function sentryEvent(service, platform, marker) {
  return {
    release: "fieldwork@1.0.0",
    environment: "release-candidate",
    platform,
    service,
    message: marker,
    contexts: {
      app: { app_identifier: service },
    },
  };
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
