#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const rawArgs = process.argv.slice(2).filter((arg) => arg !== "--");
const failures = [];
const requiredFiles = [
  "relay-version.txt",
  "relay-config.txt",
  "systemd-credentials.txt",
  "request.txt",
  "honeycomb-query.json",
  "relay-log.txt",
];

if (rawArgs.length !== 1 || rawArgs[0] === "--help" || rawArgs[0] === "-h") {
  console.error("usage: node scripts/verify-relay-honeycomb-evidence.mjs <evidence-dir>");
  process.exit(rawArgs.length === 1 ? 0 : 2);
}

const evidenceDir = path.resolve(rawArgs[0]);
requireDirectory(evidenceDir);
for (const file of requiredFiles) {
  requireFile(file);
}

if (failures.length === 0) {
  verifyRelayVersion(readText("relay-version.txt"));
  verifyRelayConfig(readText("relay-config.txt"));
  verifySystemdCredentials(readText("systemd-credentials.txt"));
  verifyRequest(readText("request.txt"));
  verifyHoneycombQuery(readText("honeycomb-query.json"));
  verifyRelayLog(readText("relay-log.txt"));
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(`relay Honeycomb evidence ok: ${evidenceDir}`);

function verifyRelayVersion(text) {
  requirePatternText(text, /\b(?:relay_version|fieldwork-relay)\b/i, "relay-version.txt must show the relay version endpoint responded");
  requirePatternText(text, /\bcontract_version\b|\bCONTRACT_VERSION\b/i, "relay-version.txt must include the relay contract version");
  rejectForbiddenContent("relay-version.txt", text);
}

function verifyRelayConfig(text) {
  requirePatternText(
    text,
    /\bFIELDWORK_RELAY_OTLP_ENDPOINT\s*[:=]\s*https:\/\/api\.honeycomb\.io\/v1\/traces\b/,
    "relay-config.txt must point FIELDWORK_RELAY_OTLP_ENDPOINT at Honeycomb OTLP traces",
  );
  requirePatternText(
    text,
    /\b(?:production_default_sample_rate|FIELDWORK_RELAY_OTLP_SAMPLE_RATE_DEFAULT)\s*[:=]\s*0\.01\b/,
    "relay-config.txt must record the production default sample rate as 0.01",
  );
  requirePatternText(
    text,
    /\b(?:FIELDWORK_RELAY_HONEYCOMB_DATASET|honeycomb_dataset|dataset)\s*[:=]\s*[A-Za-z0-9_.-]+\b/,
    "relay-config.txt must record the Honeycomb dataset name",
  );
  requirePatternText(
    text,
    /\b(?:FIELDWORK_RELAY_HONEYCOMB_API_KEY_PATH|CREDENTIALS_DIRECTORY|LoadCredential)\b/,
    "relay-config.txt must record a relay-only Honeycomb credential path or systemd credential source",
  );

  const sampleRateMatch = text.match(/\bFIELDWORK_RELAY_OTLP_SAMPLE_RATE\b\s*[:=]\s*([0-9]+(?:\.[0-9]+)?)/);
  if (!sampleRateMatch) {
    failures.push("relay-config.txt must record FIELDWORK_RELAY_OTLP_SAMPLE_RATE");
  } else {
    const sampleRate = Number(sampleRateMatch[1]);
    if (!Number.isFinite(sampleRate) || sampleRate <= 0 || sampleRate > 1) {
      failures.push(`relay-config.txt sample rate ${sampleRateMatch[1]} must be greater than 0 and at most 1`);
    }
    if (sampleRate > 0.01) {
      requirePatternText(
        text,
        /\breceipt_test_window\s*[:=]\s*true\b/,
        "relay-config.txt must mark temporary sample rates above 0.01 as receipt_test_window=true",
      );
      requirePatternText(
        text,
        /\brestored_sample_rate\s*[:=]\s*0\.01\b/,
        "relay-config.txt must prove temporary Honeycomb sampling was restored to 0.01",
      );
    }
  }
  rejectForbiddenContent("relay-config.txt", text);
}

function verifySystemdCredentials(text) {
  requirePatternText(
    text,
    /\bLoadCredential\s*=\s*honeycomb-api-key\b|\bCREDENTIALS_DIRECTORY\b.*\bhoneycomb-api-key\b|\bhoneycomb-api-key\b/,
    "systemd-credentials.txt must prove the relay uses the honeycomb-api-key systemd credential",
  );
  requirePatternText(
    text,
    /\bFIELDWORK_RELAY_OTLP_ENDPOINT\b|\bFIELDWORK_RELAY_HONEYCOMB_API_KEY_PATH\b|\bLoadCredential\b/,
    "systemd-credentials.txt must include relay OTLP or Honeycomb credential wiring",
  );
  rejectForbiddenContent("systemd-credentials.txt", text);
}

function verifyRequest(text) {
  requirePatternText(text, /\/v1\/version\b/, "request.txt must record a /v1/version request");
  requirePatternText(text, /\b(?:status=)?200\b|HTTP\/[0-9.]+\s+200\b/i, "request.txt must prove the /v1/version request returned HTTP 200");
  rejectForbiddenContent("request.txt", text);
}

function verifyHoneycombQuery(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    failures.push(`honeycomb-query.json must be valid JSON: ${error.message}`);
    return;
  }

  const rows = queryRows(parsed);
  if (rows.length < 1) {
    failures.push("honeycomb-query.json must contain at least one exported Honeycomb row or event");
  }

  const body = JSON.stringify(parsed);
  requirePatternText(body, /\bfieldwork-relay\b/, "honeycomb-query.json must include service.name fieldwork-relay");
  requirePatternText(body, /\brelay\.version\b|\/v1\/version\b/, "honeycomb-query.json must include the relay.version span or /v1/version endpoint");
  requirePatternText(body, /\/v1\/version\b/, "honeycomb-query.json must include the /v1/version endpoint");
  requirePatternText(body, /\bservice\.version\b/, "honeycomb-query.json must include service.version");
  rejectForbiddenContent("honeycomb-query.json", body);
}

function verifyRelayLog(text) {
  requirePatternText(text, /\bfieldwork relay OTLP tracing enabled\b/i, "relay-log.txt must show relay OTLP tracing was enabled");
  requirePatternText(text, /https:\/\/api\.honeycomb\.io\/v1\/traces\b/, "relay-log.txt must show the Honeycomb OTLP endpoint");
  requirePatternText(text, /\bsample_rate\b/i, "relay-log.txt must show the configured OTLP sample_rate");
  requirePatternText(text, /\brelay\.version\b|\/v1\/version\b/, "relay-log.txt must show the test /v1/version span or request");
  rejectForbiddenContent("relay-log.txt", text);
}

function queryRows(value) {
  if (Array.isArray(value)) {
    return value;
  }
  if (!value || typeof value !== "object") {
    return [];
  }
  for (const key of ["events", "results", "data", "rows"]) {
    if (Array.isArray(value[key])) {
      return value[key];
    }
  }
  return [];
}

function rejectForbiddenContent(name, text) {
  rejectPatternText(name, text, /\bhcaik_[A-Za-z0-9_-]+\b/i, `${name} must not contain a raw Honeycomb API key`);
  rejectPatternText(name, text, /\bx-honeycomb-team\b/i, `${name} must not contain Honeycomb team header names or values`);
  rejectPatternText(
    name,
    text,
    /\b(?:HONEYCOMB_API_KEY|FIELDWORK_RELAY_HONEYCOMB_API_KEY)\b\s*[:=]\s*(?!<redacted>|redacted|REDACTED|$)\S+/,
    `${name} must not contain a Honeycomb API key value`,
  );
  rejectPatternText(name, text, /\b(?:Authorization|Bearer)\b\s*[:=]\s*\S+/i, `${name} must not contain authorization header values`);
  rejectPatternText(name, text, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, `${name} must not contain private key material`);
  rejectPatternText(
    name,
    text,
    /\b(?:session_id_hash|session_name_hash|last_line|terminal_content|terminal_output|terminal_input|pty_output|pty_input|push_token|recipient_token|daemon_node_id|device_token|fcm_token|apns_token)\b/i,
    `${name} must not contain session, terminal, daemon, or push-token fields`,
  );
  rejectPatternText(
    name,
    text,
    /\b(?:command|cwd|path|session_name)\s*[:=]\s*(?!<redacted>|redacted|REDACTED)\S+/i,
    `${name} must not contain command, cwd, path, or plaintext session-name values`,
  );
  rejectPatternText(name, text, /\/Users\/|\/home\/[A-Za-z0-9_-]+\/|\/tmp\/fieldwork-[^\s"]+/i, `${name} must not contain local filesystem paths`);
  rejectPatternText(name, text, /\b(?:claude|codex|bash|zsh|vim|htop|lazygit)\b/i, `${name} must not contain command names`);
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

function rejectPatternText(nameOrText, textOrPattern, patternOrMessage, maybeMessage) {
  let name;
  let text;
  let pattern;
  let message;
  if (typeof maybeMessage === "string") {
    name = nameOrText;
    text = textOrPattern;
    pattern = patternOrMessage;
    message = maybeMessage;
  } else {
    name = "text";
    text = nameOrText;
    pattern = textOrPattern;
    message = patternOrMessage;
  }
  if (pattern.test(text)) {
    failures.push(message ?? `${name} contains forbidden content matching ${pattern}`);
  }
}
