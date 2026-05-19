#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const failures = [];

const session = read("crates/daemon/src/session.rs");
const packageJson = read("package.json");
const ci = read(".github/workflows/ci.yml");

verifyResizeState();
verifyAttachUpdateDetachFlow();
verifyDebouncedResizeScheduling();
verifyMinViewportSelection();
verifyTests();
verifyToolingWiresVerifier();

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log("daemon resize invariant ok");

function verifyResizeState() {
  requireText(session, "const RESIZE_DEBOUNCE_MS: u64 = 100;", "daemon resize debounce must remain 100 ms");
  requireText(
    session,
    "attached_sizes: Mutex<HashMap<ClientId, ClientSize>>,",
    "daemon must track attached client viewports per client",
  );
  requireText(session, "resize_epoch: AtomicU64,", "daemon must keep a resize epoch for stale debounce suppression");
  requireText(session, "resize_epoch: AtomicU64::new(0),", "daemon resize epoch must be initialized per session");
}

function verifyAttachUpdateDetachFlow() {
  const attachBody = functionBody("pub fn attach_client");
  requireText(attachBody, ".insert(client_id, size);", "attach_client must record the attaching client's viewport");
  requireText(
    attachBody,
    "self.apply_min_attached_resize()?;",
    "attach_client must resize immediately to the minimum attached viewport",
  );

  const updateBody = functionBody("pub fn update_client_size");
  requireText(updateBody, "sizes.get_mut(&client_id)", "update_client_size must update only known attached clients");
  requireText(updateBody, "*current = size;", "update_client_size must replace the stored client viewport");
  requireText(
    updateBody,
    "self.schedule_min_attached_resize();",
    "update_client_size must debounce PTY resize storms",
  );

  const detachBody = functionBody("fn detach_client");
  requireText(detachBody, "sizes.remove(&client_id);", "detach_client must remove the departing client's viewport");
  requireText(
    detachBody,
    "self.schedule_min_attached_resize();",
    "detach_client must recompute the minimum viewport after clients leave",
  );
}

function verifyDebouncedResizeScheduling() {
  const applyBody = functionBody("fn apply_min_attached_resize");
  requireText(
    applyBody,
    "min_client_size(sizes.values().copied())",
    "apply_min_attached_resize must use the minimum over all attached clients",
  );
  requireText(applyBody, "self.resize(size)?;", "apply_min_attached_resize must call the PTY resize path");

  const scheduleBody = functionBody("fn schedule_min_attached_resize");
  requireText(
    scheduleBody,
    "self.resize_epoch.fetch_add(1, Ordering::AcqRel) + 1",
    "resize scheduling must advance an epoch for every resize request",
  );
  requireText(
    scheduleBody,
    "std::thread::sleep(Duration::from_millis(RESIZE_DEBOUNCE_MS));",
    "resize scheduling must wait for the configured debounce window",
  );
  requireInOrder(
    scheduleBody,
    [
      "if session.resize_epoch.load(Ordering::Acquire) != epoch {",
      "return;",
      "session.apply_min_attached_resize()",
    ],
    "stale resize debounce workers must exit before applying a resize",
  );
}

function verifyMinViewportSelection() {
  const minBody = functionBody("fn min_client_size");
  requireText(
    session,
    "fn min_client_size(sizes: impl IntoIterator<Item = ClientSize>) -> Option<ClientSize>",
    "min_client_size must represent no-client detach as no resize target",
  );
  requireText(minBody, "cols: min.cols.min(size.cols),", "min_client_size must choose the smallest attached columns");
  requireText(minBody, "rows: min.rows.min(size.rows),", "min_client_size must choose the smallest attached rows");
}

function verifyTests() {
  for (const test of [
    "chooses_smallest_attached_viewport",
    "empty_attached_viewport_set_has_no_resize_target",
    "single_attached_viewport_is_resize_target",
  ]) {
    requireText(session, `fn ${test}()`, `daemon resize invariant must keep test ${test}`);
  }
}

function verifyToolingWiresVerifier() {
  requireText(packageJson, '"check:daemon-resize": "node scripts/verify-daemon-resize.mjs"', "package.json must expose check:daemon-resize");
  requireText(ci, "node scripts/verify-daemon-resize.mjs", "CI must run the daemon resize invariant verifier");
}

function functionBody(signaturePrefix) {
  const start = session.indexOf(signaturePrefix);
  if (start === -1) {
    failures.push(`missing function ${signaturePrefix}`);
    return "";
  }

  const open = session.indexOf("{", start);
  if (open === -1) {
    failures.push(`missing body for ${signaturePrefix}`);
    return "";
  }

  let depth = 0;
  for (let index = open; index < session.length; index += 1) {
    const char = session[index];
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return session.slice(open, index + 1);
      }
    }
  }

  failures.push(`unterminated body for ${signaturePrefix}`);
  return "";
}

function read(rel) {
  return fs.readFileSync(path.join(root, rel), "utf8");
}

function requireText(text, needle, message) {
  if (!text.includes(needle)) {
    failures.push(message);
  }
}

function requireInOrder(text, needles, message) {
  let offset = 0;
  for (const needle of needles) {
    const index = text.indexOf(needle, offset);
    if (index === -1) {
      failures.push(message);
      return;
    }
    offset = index + needle.length;
  }
}
