#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const verifier = path.join(root, "scripts/verify-android-fcm-push-evidence.mjs");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "fieldwork-android-fcm-push-"));
const hashA = "a".repeat(64);
const hashB = "b".repeat(64);

try {
  const good = path.join(temp, "good");
  writeFixture(good);
  expectStatus(good, 0, "good Android FCM push evidence should pass");

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

  const unsigned = path.join(temp, "unsigned");
  writeFixture(unsigned);
  fs.writeFileSync(path.join(unsigned, "artifact-signing.txt"), "Android AAB ok: unsigned local bundle ok\n");
  expectStatus(unsigned, 1, "unsigned AAB evidence should fail", "artifact-signing.txt must prove the release App Bundle was signed");

  const shortDelivery = path.join(temp, "short-delivery");
  writeFixture(shortDelivery);
  fs.writeFileSync(path.join(shortDelivery, "delivery.txt"), writeDelivery({ delivered: 9 }));
  expectStatus(shortDelivery, 1, "short delivery count should fail", "delivery.txt records push_delivered=9");

  const failedDelivery = path.join(temp, "failed-delivery");
  writeFixture(failedDelivery);
  fs.writeFileSync(path.join(failedDelivery, "delivery.txt"), `${writeDelivery()}provider_error=UNREGISTERED\n`);
  expectStatus(failedDelivery, 1, "provider failures should fail", "delivery.txt must not contain provider delivery failures");

  const tooFewPayloads = path.join(temp, "too-few-payloads");
  writeFixture(tooFewPayloads);
  fs.writeFileSync(path.join(tooFewPayloads, "provider-payloads.json"), JSON.stringify([fcmPayload()], null, 2));
  expectStatus(tooFewPayloads, 1, "too few inspected payloads should fail", "provider-payloads.json must include at least 10");

  const payloadWithContent = path.join(temp, "payload-with-content");
  writeFixture(payloadWithContent);
  fs.writeFileSync(
    path.join(payloadWithContent, "provider-payloads.json"),
    JSON.stringify(
      Array.from({ length: 10 }, () => ({
        message: {
          ...fcmPayload().message,
          data: {
            ...fcmPayload().message.data,
            last_line: "secret terminal output",
          },
        },
      })),
      null,
      2,
    ),
  );
  expectStatus(payloadWithContent, 1, "payload with terminal content key should fail", "keys must be exactly");

  const payloadWithPlainCommand = path.join(temp, "payload-with-plain-command");
  writeFixture(payloadWithPlainCommand);
  fs.writeFileSync(
    path.join(payloadWithPlainCommand, "provider-payloads.json"),
    JSON.stringify(
      Array.from({ length: 10 }, () => ({
        message: {
          ...fcmPayload().message,
          notification: {
            title: "Fieldwork",
            body: "claude is waiting",
          },
        },
      })),
      null,
      2,
    ),
  );
  expectStatus(payloadWithPlainCommand, 1, "payload with non-generic copy should fail", "message.notification.body");

  const badHash = path.join(temp, "bad-hash");
  writeFixture(badHash);
  fs.writeFileSync(
    path.join(badHash, "provider-payloads.json"),
    JSON.stringify(Array.from({ length: 10 }, () => fcmPayload({ sessionIdHash: "A".repeat(64) })), null, 2),
  );
  expectStatus(badHash, 1, "uppercase hash should fail", "session_id_hash must be a lowercase 64-character hex hash");

  const badNotification = path.join(temp, "bad-notification");
  writeFixture(badNotification);
  fs.writeFileSync(path.join(badNotification, "notification-ui.xml"), '<hierarchy><node text="Fieldwork"/><node text="refactoringjob"/></hierarchy>\n');
  expectStatus(
    badNotification,
    1,
    "notification UI with session name should fail",
    "notification-ui.xml must show the fixed generic notification body",
  );

  const badTap = path.join(temp, "bad-tap");
  writeFixture(badTap);
  fs.writeFileSync(path.join(badTap, "tap-replay.txt"), `session_id_hash=${hashA}\n`);
  expectStatus(badTap, 1, "tap replay without marker should fail", "tap-replay.txt must prove notification tap routed input to the target session");

  const badLog = path.join(temp, "bad-log");
  writeFixture(badLog);
  fs.writeFileSync(path.join(badLog, "logcat.log"), "FATAL EXCEPTION: main\napp.fieldwork.android crashed\n");
  expectStatus(badLog, 1, "fatal log should fail", "logcat.log must not contain Fieldwork fatal, ANR, or exception entries");
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

console.log("Android FCM push evidence verifier ok");

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
  fs.writeFileSync(path.join(dir, "relay-version.txt"), '{"relay_version":"1.0.0","contract_version":1}\n');
  fs.writeFileSync(
    path.join(dir, "token-registration.txt"),
    "platform=fcm\nRegisterPushToken sent\n/v1/push/register-token accepted\n",
  );
  fs.writeFileSync(
    path.join(dir, "provider-payloads.json"),
    JSON.stringify(Array.from({ length: 10 }, () => fcmPayload()), null, 2),
  );
  fs.writeFileSync(path.join(dir, "delivery.txt"), writeDelivery());
  writePng(path.join(dir, "notification.png"), { width: 1080, height: 2400 });
  fs.writeFileSync(
    path.join(dir, "notification-ui.xml"),
    '<hierarchy><node text="Fieldwork"/><node text="A session is waiting for you."/></hierarchy>\n',
  );
  fs.writeFileSync(path.join(dir, "tap-ui.xml"), '<hierarchy><node text="Attached"/><node text="Terminal"/></hierarchy>\n');
  fs.writeFileSync(path.join(dir, "tap-replay.txt"), `session_id_hash=${hashA}\nnotify_tap_ok\n`);
  fs.writeFileSync(path.join(dir, "logcat.log"), "I Fieldwork FCM push delivery ok\n");
  fs.writeFileSync(path.join(dir, "crash.log"), "\n");
}

function fcmPayload(options = {}) {
  return {
    message: {
      token: "fcm-token-redacted",
      notification: {
        title: "Fieldwork",
        body: "A session is waiting for you.",
      },
      data: {
        session_id_hash: options.sessionIdHash ?? hashA,
        session_name_hash: hashB,
        event_type: "awaiting_input",
      },
      android: {
        priority: "HIGH",
        notification: {
          channel_id: "fieldwork-agent-state",
          click_action: "FIELDWORK_OPEN_SESSION",
        },
      },
    },
  };
}

function writeDelivery(options = {}) {
  const attempts = options.attempts ?? 10;
  const delivered = options.delivered ?? 10;
  const lines = [
    "provider=fcm",
    "event_type=awaiting_input",
    `push_attempts=${attempts}`,
    `push_delivered=${delivered}`,
  ];
  for (let index = 1; index <= delivered; index += 1) {
    lines.push(`notification_received_${index}_ok`);
  }
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
  });
  if (result.status !== expectedStatus) {
    throw new Error(`${message}: exited ${result.status}, expected ${expectedStatus}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  if (expectedOutput && !`${result.stdout}\n${result.stderr}`.includes(expectedOutput)) {
    throw new Error(`${message}: missing output ${JSON.stringify(expectedOutput)}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
}
