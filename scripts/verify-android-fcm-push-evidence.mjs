#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const rawArgs = process.argv.slice(2).filter((arg) => arg !== "--");
const failures = [];
const hashPattern = /^[0-9a-f]{64}$/;
const requiredFiles = [
  "adb-devices.txt",
  "artifact-signing.txt",
  "buildconfig.txt",
  "relay-version.txt",
  "token-registration.txt",
  "provider-payloads.json",
  "delivery.txt",
  "notification.png",
  "notification-ui.xml",
  "tap-ui.xml",
  "tap-replay.txt",
  "logcat.log",
  "crash.log",
];

if (rawArgs.length !== 1 || rawArgs[0] === "--help" || rawArgs[0] === "-h") {
  console.error("usage: node scripts/verify-android-fcm-push-evidence.mjs <evidence-dir>");
  process.exit(rawArgs.length === 1 ? 0 : 2);
}

const evidenceDir = path.resolve(rawArgs[0]);
requireDirectory(evidenceDir);
for (const file of requiredFiles) {
  requireFile(file);
}

if (failures.length === 0) {
  verifyAdbDevices(readText("adb-devices.txt"));
  verifyArtifactSigning(readText("artifact-signing.txt"));
  verifyBuildConfig(readText("buildconfig.txt"));
  verifyRelayVersion(readText("relay-version.txt"));
  verifyTokenRegistration(readText("token-registration.txt"));
  verifyProviderPayloads(readText("provider-payloads.json"));
  verifyDelivery(readText("delivery.txt"));
  verifyPng("notification.png");
  verifyNotificationUi(readText("notification-ui.xml"));
  verifyTapEvidence(readText("tap-ui.xml"), readText("tap-replay.txt"));
  verifyLogs([
    ["logcat.log", readText("logcat.log")],
    ["crash.log", readText("crash.log")],
  ]);
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(`Android FCM push evidence ok: ${evidenceDir}`);

function verifyAdbDevices(text) {
  requirePatternText(text, /^List of devices attached\b/im, "adb-devices.txt must include adb devices output");
  const authorizedDevices = text
    .split(/\r?\n/)
    .filter((line) => /^[^\s#][^\n]*\s+device(?:\s|$)/i.test(line));
  if (authorizedDevices.length === 0) {
    failures.push("adb-devices.txt must show exactly one authorized physical Android device");
  } else if (authorizedDevices.length > 1) {
    failures.push(
      `adb-devices.txt must show exactly one authorized physical Android device, found ${authorizedDevices.length}`,
    );
  }
  rejectPatternText(
    text,
    /^(?:emulator-\d+|[^\n]*(?:\bsdk_gphone\b|\bsdk_gphone64\b|\bgeneric_x86\b|\bgeneric_x86_64\b|\bgoldfish\b|\branchu\b|\bqemu\b|\bavd\b|\bdevice:emu[^\s]*\b))[^\n]*\s+device(?:\s|$)/im,
    "adb-devices.txt must show a physical Android phone, not an emulator or AVD",
  );
  rejectPatternText(
    text,
    /\b(?:unauthorized|offline|no permissions)\b/i,
    "adb-devices.txt must not show the tested device as unauthorized, offline, or inaccessible",
  );
}

function verifyArtifactSigning(text) {
  requirePatternText(text, /\bAndroid AAB ok:/, "artifact-signing.txt must include scripts/verify-android-aab.mjs success output");
  requirePatternText(text, /\bsigned release bundle ok\b/, "artifact-signing.txt must prove the release App Bundle was signed");
}

function verifyBuildConfig(text) {
  requirePatternText(text, /\bAPPLICATION_ID\s*=\s*"app\.fieldwork\.android"/, "buildconfig.txt must prove the tested release build targets app.fieldwork.android");
  requirePatternText(text, /\bBUILD_TYPE\s*=\s*"release"/, "buildconfig.txt must prove the tested build is the release variant");
  requirePatternText(text, /\bDEBUG\s*=\s*(?:false|Boolean\.parseBoolean\("false"\))/, "buildconfig.txt must prove BuildConfig.DEBUG is disabled");
  requirePatternText(text, /\bFIELDWORK_BIOMETRIC_BYPASS\s*=\s*false\b/, "buildconfig.txt must prove biometric bypass is disabled");
  requirePatternText(text, /\bFIELDWORK_DEBUG_PAIRING_PAYLOAD\s*=\s*""/, "buildconfig.txt must prove no debug pairing payload is compiled into the release build");
}

function verifyRelayVersion(text) {
  requirePatternText(text, /\b(?:relay_version|fieldwork-relay)\b/i, "relay-version.txt must show the production relay version endpoint responded");
  requirePatternText(text, /\bcontract_version\b|\bCONTRACT_VERSION\b/i, "relay-version.txt must include the relay contract version");
}

function verifyTokenRegistration(text) {
  requirePatternText(text, /\bfcm\b/i, "token-registration.txt must identify the Android FCM push platform");
  requirePatternText(
    text,
    /\b(?:RegisterPushToken|registerPushToken|\/v1\/push\/register-token|push token registration accepted)\b/,
    "token-registration.txt must prove the Android FCM token was registered with daemon and relay",
  );
  rejectForbiddenContent("token-registration.txt", text);
}

function verifyProviderPayloads(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    failures.push(`provider-payloads.json must be valid JSON: ${error.message}`);
    return;
  }
  const payloads = Array.isArray(parsed) ? parsed : parsed?.payloads;
  if (!Array.isArray(payloads)) {
    failures.push("provider-payloads.json must be a JSON array or an object with a payloads array");
    return;
  }
  if (payloads.length < 10) {
    failures.push(`provider-payloads.json must include at least 10 inspected FCM provider payloads, found ${payloads.length}`);
  }
  payloads.forEach((payload, index) => verifyFcmPayload(payload, index));
}

function verifyFcmPayload(payload, index) {
  const prefix = `provider-payloads.json payload[${index}]`;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    failures.push(`${prefix} must be an object`);
    return;
  }
  requireExactKeys(prefix, payload, ["message"]);
  const message = payload.message;
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    failures.push(`${prefix}.message must be an object`);
    return;
  }
  requireExactKeys(`${prefix}.message`, message, ["android", "data", "notification", "token"]);
  requireNonEmptyString(`${prefix}.message.token`, message.token);

  requireExactKeys(`${prefix}.message.notification`, message.notification, ["body", "title"]);
  requireStringValue(`${prefix}.message.notification.title`, message.notification?.title, "Fieldwork");
  requireStringValue(
    `${prefix}.message.notification.body`,
    message.notification?.body,
    "A session is waiting for you.",
  );

  requireExactKeys(`${prefix}.message.data`, message.data, ["event_type", "session_id_hash", "session_name_hash"]);
  requireStringValue(`${prefix}.message.data.event_type`, message.data?.event_type, "awaiting_input");
  requireHash(`${prefix}.message.data.session_id_hash`, message.data?.session_id_hash);
  requireHash(`${prefix}.message.data.session_name_hash`, message.data?.session_name_hash);

  requireExactKeys(`${prefix}.message.android`, message.android, ["notification", "priority"]);
  requireStringValue(`${prefix}.message.android.priority`, message.android?.priority, "HIGH");
  requireExactKeys(`${prefix}.message.android.notification`, message.android?.notification, ["channel_id", "click_action"]);
  requireStringValue(
    `${prefix}.message.android.notification.channel_id`,
    message.android?.notification?.channel_id,
    "fieldwork-agent-state",
  );
  requireStringValue(
    `${prefix}.message.android.notification.click_action`,
    message.android?.notification?.click_action,
    "FIELDWORK_OPEN_SESSION",
  );
  rejectForbiddenObject(prefix, payload);
}

function verifyDelivery(text) {
  requirePatternText(text, /\bprovider=fcm\b/i, "delivery.txt must record provider=fcm");
  requirePatternText(text, /\bevent_type=awaiting_input\b/i, "delivery.txt must record awaiting_input events");
  const attempts = text.match(/\bpush_attempts=(\d+)\b/);
  const delivered = text.match(/\bpush_delivered=(\d+)\b/);
  if (!attempts) {
    failures.push("delivery.txt must record push_attempts=10");
  } else if (Number(attempts[1]) !== 10) {
    failures.push(`delivery.txt records push_attempts=${attempts[1]}, expected 10`);
  }
  if (!delivered) {
    failures.push("delivery.txt must record push_delivered=10");
  } else if (Number(delivered[1]) !== 10) {
    failures.push(`delivery.txt records push_delivered=${delivered[1]}, expected 10`);
  }
  const notificationMarkers = text.match(/\bnotification_received_\d+_ok\b/g) ?? [];
  if (notificationMarkers.length < 10) {
    failures.push(`delivery.txt contains ${notificationMarkers.length} notification_received_N_ok markers, expected at least 10`);
  }
  rejectPatternText(text, /\b(?:push_failed|provider_error|BadDeviceToken|UNREGISTERED)\b/i, "delivery.txt must not contain provider delivery failures");
}

function verifyPng(file) {
  const absolute = path.join(evidenceDir, file);
  const bytes = fs.readFileSync(absolute);
  const pngMagic = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const hasMagic = pngMagic.every((byte, index) => bytes[index] === byte);
  if (!hasMagic) {
    failures.push(`${file} must be a PNG screenshot`);
    return;
  }
  if (bytes.length < 64) {
    failures.push(`${file} is too small to be useful evidence (${bytes.length} bytes)`);
    return;
  }
  const ihdrLength = bytes.readUInt32BE(8);
  const ihdrType = bytes.toString("ascii", 12, 16);
  if (ihdrLength !== 13 || ihdrType !== "IHDR") {
    failures.push(`${file} must contain a valid PNG IHDR header`);
    return;
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  const shortSide = Math.min(width, height);
  const longSide = Math.max(width, height);
  if (shortSide < 360 || longSide < 640) {
    failures.push(`${file} is too small for Android phone evidence (${width}x${height})`);
  }
}

function verifyNotificationUi(text) {
  requirePatternText(text, /\bFieldwork\b/, "notification-ui.xml must show the fixed notification title");
  requirePatternText(
    text,
    /\bA session is waiting for you\./,
    "notification-ui.xml must show the fixed generic notification body",
  );
  rejectForbiddenContent("notification-ui.xml", text);
}

function verifyTapEvidence(ui, replay) {
  requirePatternText(ui, /\b(?:Attached|Terminal)\b/i, "tap-ui.xml must show the tapped notification opened an attached terminal");
  requirePatternText(replay, /\bnotify_tap_ok\b/, "tap-replay.txt must prove notification tap routed input to the target session");
  requirePatternText(replay, /\bsession_id_hash=[0-9a-f]{64}\b/, "tap-replay.txt must record the lowercase target session_id_hash");
  rejectPatternText(replay, /\bsession_id_hash=[0-9A-F]*[A-F][0-9A-F]*\b/, "tap-replay.txt must not use an uppercase session_id_hash");
}

function verifyLogs(entries) {
  const fatalPattern = /\bFATAL EXCEPTION\b|\bANR in app\.fieldwork\.android\b|Fieldwork.*\b(FATAL|ANR|Exception)\b/i;
  const crashPattern = /\bapp\.fieldwork\.android\b|\bFATAL EXCEPTION\b|\bANR\b/i;
  for (const [name, text] of entries) {
    rejectPatternText(text, fatalPattern, `${name} must not contain Fieldwork fatal, ANR, or exception entries`);
    if (name === "crash.log") {
      rejectPatternText(text, crashPattern, `${name} must not contain app.fieldwork.android crash-buffer entries`);
    }
  }
}

function rejectForbiddenObject(prefix, value) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectForbiddenObject(`${prefix}[${index}]`, item));
    return;
  }
  if (!value || typeof value !== "object") {
    if (typeof value === "string") {
      rejectForbiddenContent(prefix, value);
    }
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (["command", "cwd", "last_line", "lastLine", "path", "session_name", "sessionName", "terminal_content"].includes(key)) {
      failures.push(`${prefix} must not include provider payload key ${key}`);
    }
    rejectForbiddenObject(`${prefix}.${key}`, child);
  }
}

function rejectForbiddenContent(file, text) {
  rejectPatternText(
    text,
    /\b(?:last_line|lastLine|command|cwd|terminal_content|ANDROID_|refactoringjob|claude|bash|zsh|\/Users\/|\/home\/)\b/i,
    `${file} must not include terminal content, commands, paths, plaintext session names, or test markers`,
  );
}

function requireExactKeys(label, value, expectedKeys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    failures.push(`${label} must be an object`);
    return;
  }
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (actual.join(",") !== expected.join(",")) {
    failures.push(`${label} keys must be exactly ${expected.join(", ")}, got ${actual.join(", ") || "(none)"}`);
  }
}

function requireHash(label, value) {
  if (typeof value !== "string" || !hashPattern.test(value)) {
    failures.push(`${label} must be a lowercase 64-character hex hash`);
  }
}

function requireNonEmptyString(label, value) {
  if (typeof value !== "string" || value.trim() === "") {
    failures.push(`${label} must be a non-empty string`);
  }
}

function requireStringValue(label, actual, expected) {
  if (actual !== expected) {
    failures.push(`${label} must be ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function requireDirectory(dir) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    failures.push(`evidence directory is missing: ${dir}`);
  }
}

function requireFile(file) {
  const absolute = path.join(evidenceDir, file);
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
    failures.push(`missing evidence file: ${file}`);
  }
}

function readText(file) {
  return fs.readFileSync(path.join(evidenceDir, file), "utf8");
}

function requirePatternText(text, pattern, message) {
  if (!pattern.test(text)) {
    failures.push(message);
  }
}

function rejectPatternText(text, pattern, message) {
  if (pattern.test(text)) {
    failures.push(message);
  }
}
