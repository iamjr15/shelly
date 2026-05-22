#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const rawArgs = process.argv.slice(2).filter((arg) => arg !== "--");
const failures = [];
const requiredFiles = [
  "sentry-project.txt",
  "privacy-review.txt",
  "daemon-telemetry.txt",
  "daemon-event.json",
  "android-buildconfig.txt",
  "android-settings-ui.xml",
  "android-event.json",
  "ios-settings.txt",
  "ios-event.json",
];

if (rawArgs.length !== 1 || rawArgs[0] === "--help" || rawArgs[0] === "-h") {
  console.error("usage: node scripts/verify-sentry-receipt-evidence.mjs <evidence-dir>");
  process.exit(rawArgs.length === 1 ? 0 : 2);
}

const evidenceDir = path.resolve(rawArgs[0]);
requireDirectory(evidenceDir);
for (const file of requiredFiles) {
  requireFile(file);
}

if (failures.length === 0) {
  verifyProject(readText("sentry-project.txt"));
  verifyPrivacyReview(readText("privacy-review.txt"));
  verifyDaemonTelemetry(readText("daemon-telemetry.txt"));
  verifySentryEvent("daemon-event.json", readText("daemon-event.json"), {
    service: /fieldworkd/i,
    platform: /rust/i,
    marker: /fieldworkd_sentry_receipt/i,
  });
  verifyAndroidBuildConfig(readText("android-buildconfig.txt"));
  verifyAndroidSettings(readText("android-settings-ui.xml"));
  verifySentryEvent("android-event.json", readText("android-event.json"), {
    service: /app\.fieldwork\.android/i,
    platform: /android|java|kotlin/i,
    marker: /android_sentry_receipt/i,
  });
  verifyIosSettings(readText("ios-settings.txt"));
  verifySentryEvent("ios-event.json", readText("ios-event.json"), {
    service: /app\.fieldwork\.ios/i,
    platform: /ios|swift|cocoa/i,
    marker: /ios_sentry_receipt/i,
  });
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(`Sentry receipt evidence ok: ${evidenceDir}`);

function verifyProject(text) {
  requirePatternText(text, /\bproject\s*[:=]\s*fieldwork\b/i, "sentry-project.txt must identify the Fieldwork Sentry project");
  requirePatternText(text, /\benvironment\s*[:=]\s*(?:release-candidate|production)\b/i, "sentry-project.txt must identify release-candidate or production environment");
  requirePatternText(text, /\brelease\s*[:=]\s*fieldwork@1\.0\.0\b/i, "sentry-project.txt must identify release fieldwork@1.0.0");
  rejectForbiddenContent("sentry-project.txt", text);
}

function verifyPrivacyReview(text) {
  for (const [pattern, message] of [
    [/\bsend_default_pii\s*[:=]\s*false\b/i, "privacy-review.txt must prove send_default_pii=false"],
    [/\btraces_sample_rate\s*[:=]\s*0\.0\b/i, "privacy-review.txt must prove traces_sample_rate=0.0"],
    [/\bsession_replay\s*[:=]\s*false\b/i, "privacy-review.txt must prove session_replay=false"],
    [/\bscreenshots\s*[:=]\s*false\b/i, "privacy-review.txt must prove screenshots=false"],
    [/\buser_interaction_tracing\s*[:=]\s*false\b/i, "privacy-review.txt must prove user_interaction_tracing=false"],
    [/\bterminal_content_attached\s*[:=]\s*false\b/i, "privacy-review.txt must prove terminal_content_attached=false"],
  ]) {
    requirePatternText(text, pattern, message);
  }
  rejectForbiddenContent("privacy-review.txt", text);
}

function verifyDaemonTelemetry(text) {
  requirePatternText(
    text,
    /\bfieldwork settings telemetry on --sentry-dsn <redacted>|FIELDWORK_TELEMETRY_OPT_IN\s*=\s*true/i,
    "daemon-telemetry.txt must prove daemon telemetry was explicitly opted in with a redacted DSN",
  );
  requirePatternText(text, /\bfieldworkd_sentry_receipt\b/i, "daemon-telemetry.txt must record the daemon Sentry receipt marker");
  requirePatternText(text, /\bsend_default_pii\s*[:=]\s*false\b/i, "daemon-telemetry.txt must prove send_default_pii=false");
  requirePatternText(text, /\btraces_sample_rate\s*[:=]\s*0\.0\b/i, "daemon-telemetry.txt must prove traces_sample_rate=0.0");
  rejectForbiddenContent("daemon-telemetry.txt", text);
}

function verifyAndroidBuildConfig(text) {
  requirePatternText(text, /\bAPPLICATION_ID\s*=\s*"app\.fieldwork\.android"/, "android-buildconfig.txt must prove the Android release app id");
  requirePatternText(text, /\bBUILD_TYPE\s*=\s*"release"/, "android-buildconfig.txt must prove the Android release variant");
  requirePatternText(text, /\bDEBUG\s*=\s*(?:false|Boolean\.parseBoolean\("false"\))/, "android-buildconfig.txt must prove DEBUG is false");
  requirePatternText(text, /\bFIELDWORK_SENTRY_DSN\b.*<redacted>/, "android-buildconfig.txt must prove a redacted Sentry DSN was injected");
  rejectForbiddenContent("android-buildconfig.txt", text);
}

function verifyAndroidSettings(text) {
  requirePatternText(text, /\bShare crash reports\b/i, "android-settings-ui.xml must show the crash-reporting setting");
  requirePatternText(text, /\b(?:checked|selected)\s*=\s*"?true"?/i, "android-settings-ui.xml must show crash reporting was enabled by user opt-in");
  rejectForbiddenContent("android-settings-ui.xml", text);
}

function verifyIosSettings(text) {
  requirePatternText(text, /\bShare crash reports\b/i, "ios-settings.txt must show the crash-reporting setting");
  requirePatternText(text, /\bFieldworkSentryDsn\s*[:=]\s*<redacted>/i, "ios-settings.txt must prove the iOS DSN was injected but redacted");
  requirePatternText(text, /\b(?:enabled|opt_in|crash_reports)\s*[:=]\s*true\b/i, "ios-settings.txt must prove crash reporting was enabled by user opt-in");
  rejectForbiddenContent("ios-settings.txt", text);
}

function verifySentryEvent(file, text, expected) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    failures.push(`${file} must be valid JSON: ${error.message}`);
    return;
  }

  const body = JSON.stringify(parsed);
  requirePatternText(body, expected.service, `${file} must identify the expected Fieldwork service/app`);
  requirePatternText(body, expected.platform, `${file} must identify the expected platform`);
  requirePatternText(body, expected.marker, `${file} must include the controlled Sentry receipt marker`);
  requirePatternText(body, /\bfieldwork@1\.0\.0\b/, `${file} must identify release fieldwork@1.0.0`);
  requirePatternText(body, /\brelease-candidate\b|\bproduction\b/, `${file} must identify release-candidate or production environment`);
  rejectForbiddenContent(file, body);
}

function rejectForbiddenContent(name, text) {
  rejectPatternText(name, text, /https:\/\/[^@\s"]+@[^/\s"]+\/\d+/i, `${name} must not contain a raw Sentry DSN`);
  rejectPatternText(name, text, /\b(?:SENTRY_AUTH_TOKEN|auth_token)\b\s*[:=]\s*(?!<redacted>|redacted|REDACTED|$)\S+/i, `${name} must not contain a Sentry auth token`);
  rejectPatternText(
    name,
    text,
    /\b(?:dsn|FIELDWORK_SENTRY_DSN|FieldworkSentryDsn)\b\s*[:=]\s*(?!"?<redacted>"?|"?redacted"?|"?REDACTED"?|$)\S+/i,
    `${name} must not contain a raw Sentry DSN value`,
  );
  rejectPatternText(
    name,
    text,
    /\b(?:session_id_hash|session_name_hash|last_line|terminal_content|terminal_output|terminal_input|pty_output|pty_input|push_token|recipient_token|daemon_node_id|device_token|fcm_token|apns_token)\b/i,
    `${name} must not contain session, terminal, daemon, or push-token fields`,
  );
  rejectPatternText(
    name,
    text,
    /"?(?:command|cwd|path|session_name)"?\s*[:=]\s*"?(?!<redacted>|redacted|REDACTED)\S+/i,
    `${name} must not contain command, cwd, path, or plaintext session-name values`,
  );
  rejectPatternText(name, text, /\/Users\/|\/home\/[A-Za-z0-9_-]+\/|\/tmp\/fieldwork-[^\s"]+/i, `${name} must not contain local filesystem paths`);
  rejectPatternText(name, text, /\b(?:claude|codex|bash|zsh|vim|htop|lazygit)\b/i, `${name} must not contain command names`);
  rejectPatternText(name, text, /"?(?:user\.email|email|username|ip_address)"?\s*[:=]\s*"?(?!<redacted>|redacted|REDACTED|null|false)\S+/i, `${name} must not contain user identity or IP fields`);
  rejectPatternText(name, text, /"?(?:screenshot|session_replay|replay_id)"?\s*[:=]\s*"?(?!false|null|<redacted>|redacted|REDACTED)\S+/i, `${name} must not contain screenshots or session replay data`);
}

function requireDirectory(dir) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    failures.push(`evidence directory does not exist: ${dir}`);
  }
}

function requireFile(file) {
  const absolute = path.join(evidenceDir, file);
  if (!fs.existsSync(absolute)) {
    failures.push(`${file} is missing`);
    return;
  }
  if (!fs.statSync(absolute).isFile()) {
    failures.push(`${file} must be a regular file`);
    return;
  }
  if (fs.statSync(absolute).size === 0) {
    failures.push(`${file} must not be empty`);
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

function rejectPatternText(name, text, pattern, message) {
  if (pattern.test(text)) {
    failures.push(message ?? `${name} contains forbidden content matching ${pattern}`);
  }
}
