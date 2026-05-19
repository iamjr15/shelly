#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const failures = [];

const files = {
  apns: read("crates/relay/src/apns.rs"),
  fcm: read("crates/relay/src/fcm.rs"),
  relay: read("crates/relay/src/lib.rs"),
};

verifyKeepalive("APNs", files.apns, "build APNs HTTP/2 client");
verifyKeepalive("FCM", files.fcm, "build FCM HTTP/2 client");

requireText(
  files.relay,
  "providers: PushProviders::from_env()?",
  "relay state must construct provider clients during startup state initialization",
);
requireText(
  files.relay,
  'pattern(r"^[0-9a-f]{64}$")',
  "relay push requests must validate session hashes as lowercase 64-byte hex strings",
);
requireText(
  files.relay,
  "rejects_push_payload_with_non_hex_hashes",
  "relay must test rejection of non-hex or uppercase push hash fields",
);
requireText(
  files.relay,
  "rejects_push_payload_with_forbidden_free_text_fields",
  "relay must test rejection of free-text push payload fields",
);
requireText(
  files.relay,
  "apns: apns::ApnsClient::from_env()?",
  "relay provider initialization must include APNs",
);
requireText(
  files.relay,
  "fcm: fcm::FcmClient::from_env()?",
  "relay provider initialization must include FCM",
);
requireText(
  files.relay,
  "#[cfg(test)]\n    delivered: Vec<DeliveredPush>",
  "relay delivered-push retention must be compiled only into tests",
);
requireText(
  files.relay,
  "retained only in test builds",
  "relay metrics must make delivered-push buffering test-only",
);
requireText(
  files.relay,
  "provider_error_response_does_not_reflect_provider_body",
  "relay must test that daemon-facing provider errors do not reflect provider response bodies",
);
requireText(
  files.relay,
  "APNs delivery failed",
  "relay provider error display must use fixed provider copy",
);
requireText(
  files.apns,
  "async fn apns_send_reuses_persistent_provider_connection()",
  "APNs provider-client connection reuse must have focused test coverage",
);
requireText(
  files.apns,
  "peer_addrs[0], peer_addrs[1]",
  "APNs reuse test must compare observed provider peer addresses across dispatches",
);
requireText(
  files.apns,
  "fn assert_apns_payload_shape(payload: &serde_json::Value)",
  "APNs provider payload tests must structurally assert the JSON shape",
);
requireText(
  files.apns,
  'vec!["aps", "event_type", "session_id_hash", "session_name_hash"]',
  "APNs provider payload test must allow only aps/hash/event top-level keys",
);
requireText(
  files.apns,
  'vec!["alert", "thread-id"]',
  "APNs provider payload test must pin aps keys",
);
requireText(
  files.fcm,
  "fn assert_fcm_payload_shape(payload: &serde_json::Value)",
  "FCM provider payload tests must structurally assert the JSON shape",
);
requireText(
  files.fcm,
  'vec!["android", "data", "notification", "token"]',
  "FCM provider payload test must pin message keys",
);
requireText(
  files.fcm,
  '"session_id_hash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"',
  "FCM provider payload test must keep hash-only data payload coverage",
);
requireText(
  files.relay,
  "enum ProviderDeliveryError",
  "relay provider delivery errors must be typed so stale-token responses can prune bindings",
);
requireText(
  files.relay,
  "remove_push_token_binding",
  "relay must share token-binding deletion between explicit unregister and provider invalid-token handling",
);
requireText(
  files.relay,
  "apns_bad_device_token_removes_token_binding_from_memory_and_sqlite",
  "relay must test APNs BadDeviceToken stale-token pruning through SQLite",
);
requireText(
  files.apns,
  'Some("BadDeviceToken")',
  "APNs provider must treat BadDeviceToken as a stale-token signal",
);
requireText(
  files.fcm,
  'error_code == Some("UNREGISTERED")',
  "FCM provider must treat UNREGISTERED as a stale-token signal",
);

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log("relay provider clients ok");

function verifyKeepalive(label, source, buildContext) {
  requireText(
    source,
    "http: reqwest::Client",
    `${label} client must own a reusable reqwest client`,
  );
  requireText(
    source,
    "reqwest::Client::builder()",
    `${label} client must use an explicit reqwest client builder`,
  );
  requireText(
    source,
    ".http2_keep_alive_interval(Some(Duration::from_secs(60)))",
    `${label} client must keep HTTP/2 connections alive with 60 second pings`,
  );
  requireText(
    source,
    ".http2_keep_alive_timeout(Duration::from_secs(10))",
    `${label} client must bound HTTP/2 keepalive ping timeouts`,
  );
  requireText(
    source,
    ".http2_keep_alive_while_idle(true)",
    `${label} client must keep idle provider connections alive`,
  );
  requireText(source, buildContext, `${label} client builder errors must keep provider context`);
}

function read(rel) {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

function requireText(text, needle, message) {
  if (!text.includes(needle)) {
    failures.push(message);
  }
}
