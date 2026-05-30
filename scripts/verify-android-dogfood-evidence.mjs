#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  verifyCleanAndroidLogs,
  verifyInstalledAndroidPackageInfo,
  verifyNoAndroidSystemErrorOverlays,
  verifyPhysicalAndroidAdbDevices,
} from "./android-evidence-common.mjs";

const rawArgs = process.argv.slice(2).filter((arg) => arg !== "--");
const failures = [];

if (rawArgs.length !== 1 || rawArgs[0] === "--help" || rawArgs[0] === "-h") {
  console.error("usage: node scripts/verify-android-dogfood-evidence.mjs <evidence-dir>");
  process.exit(rawArgs.length === 1 ? 0 : 2);
}

const evidenceDir = path.resolve(rawArgs[0]);

const requiredFiles = [
  "adb-devices.txt",
  "package-info.txt",
  "buildconfig.txt",
  "dogfood-duration.txt",
  "claude.png",
  "claude-ui.xml",
  "claude-logcat.log",
  "claude-crash.log",
  "typing-replay.txt",
  "scroll.png",
  "scroll-ui.xml",
  "scroll-logcat.log",
  "scroll-crash.log",
  "scroll-replay.txt",
  "resize.png",
  "resize-ui.xml",
  "resize-logcat.log",
  "resize-crash.log",
  "resize-replay.txt",
  "paste.png",
  "paste-ui.xml",
  "paste-logcat.log",
  "paste-crash.log",
  "paste-replay.txt",
  "final-logcat.log",
  "final-crash.log",
];

requireDirectory(evidenceDir);
for (const file of requiredFiles) {
  requireFile(file);
}

if (failures.length === 0) {
  verifyAdbDevices(readText("adb-devices.txt"));
  verifyPackageInfo(readText("package-info.txt"));
  verifyBuildConfig(readText("buildconfig.txt"));
  verifyDuration(readText("dogfood-duration.txt"));
  for (const file of ["claude.png", "scroll.png", "resize.png", "paste.png"]) {
    verifyPng(file);
  }
  verifyClaudeAttach(readText("claude-ui.xml"), readText("typing-replay.txt"));
  verifyScrollEvidence(readText("scroll-ui.xml"), readText("scroll-replay.txt"));
  verifyResizeEvidence(readText("resize-ui.xml"), readText("resize-replay.txt"));
  verifyPasteEvidence(readText("paste-ui.xml"), readText("paste-replay.txt"));
  verifyNoAndroidSystemErrorOverlays([
    ["claude-ui.xml", readText("claude-ui.xml")],
    ["scroll-ui.xml", readText("scroll-ui.xml")],
    ["resize-ui.xml", readText("resize-ui.xml")],
    ["paste-ui.xml", readText("paste-ui.xml")],
  ], failures);
  verifyLogs([
    ["claude-logcat.log", readText("claude-logcat.log")],
    ["claude-crash.log", readText("claude-crash.log")],
    ["scroll-logcat.log", readText("scroll-logcat.log")],
    ["scroll-crash.log", readText("scroll-crash.log")],
    ["resize-logcat.log", readText("resize-logcat.log")],
    ["resize-crash.log", readText("resize-crash.log")],
    ["paste-logcat.log", readText("paste-logcat.log")],
    ["paste-crash.log", readText("paste-crash.log")],
    ["final-logcat.log", readText("final-logcat.log")],
    ["final-crash.log", readText("final-crash.log")],
  ]);
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(`android dogfood evidence ok: ${evidenceDir}`);

function verifyPackageInfo(text) {
  verifyInstalledAndroidPackageInfo(text, failures, { forbidDebuggable: true });
}

function verifyBuildConfig(text) {
  requirePatternText(
    text,
    /\bAPPLICATION_ID\s*=\s*"app\.fieldwork\.android"/,
    "buildconfig.txt must prove the installed test build targets app.fieldwork.android",
  );
  requirePatternText(
    text,
    /\bBUILD_TYPE\s*=\s*"release"/,
    "buildconfig.txt must prove the installed test build is the release variant",
  );
  requirePatternText(
    text,
    /\bDEBUG\s*=\s*(?:false|Boolean\.parseBoolean\("false"\))/,
    "buildconfig.txt must prove BuildConfig.DEBUG is disabled",
  );
  requirePatternText(
    text,
    /\bFIELDWORK_BIOMETRIC_BYPASS\s*=\s*false\b/,
    "buildconfig.txt must prove biometric bypass is disabled",
  );
  requirePatternText(
    text,
    /\bFIELDWORK_DEBUG_PAIRING_CODE\s*=\s*""/,
    "buildconfig.txt must prove no debug pairing code is compiled in",
  );
}

function verifyDuration(text) {
  requirePatternText(text, /\bdogfood_started_at=/, "dogfood-duration.txt must record dogfood_started_at=<timestamp>");
  requirePatternText(text, /\bdogfood_finished_at=/, "dogfood-duration.txt must record dogfood_finished_at=<timestamp>");
  const timing = text.match(/\bdogfood_duration_ms=(\d+)\b/);
  if (!timing) {
    failures.push("dogfood-duration.txt must record dogfood_duration_ms=<elapsed-ms>");
  } else if (Number(timing[1]) < 1_800_000) {
    failures.push(`dogfood-duration.txt records dogfood_duration_ms=${timing[1]}, expected >=1800000`);
  }
  requirePatternText(
    text,
    /\btermlib_decision_candidate=pass\b/,
    "dogfood-duration.txt must record termlib_decision_candidate=pass after human review",
  );
}

function verifyClaudeAttach(ui, replay) {
  requireAttachedUi("claude-ui.xml", ui);
  requirePatternText(ui, /\b(?:claude|Claude Code|refactoringjob)\b/i, "claude-ui.xml must identify the attached Claude session");
  requirePatternText(replay, /\b(?:claude|refactoringjob)\b/i, "typing-replay.txt must identify the Claude/default session");
  requirePatternText(
    replay,
    /\bdogfood_typing_ok\b/,
    "typing-replay.txt must include Android-originated typed input",
  );
}

function verifyScrollEvidence(ui, replay) {
  requireAttachedUi("scroll-ui.xml", ui);
  requirePatternText(ui, /\bDOGFOOD_SCROLL_(?:TOP|BOTTOM)\b/, "scroll-ui.xml must show dogfood scroll marker content");
  requirePatternText(replay, /\bDOGFOOD_SCROLL_TOP\b/, "scroll-replay.txt must include DOGFOOD_SCROLL_TOP");
  requirePatternText(replay, /\bDOGFOOD_SCROLL_BOTTOM\b/, "scroll-replay.txt must include DOGFOOD_SCROLL_BOTTOM");
  requirePatternText(
    replay,
    /\bscroll_verified_by_operator\b/,
    "scroll-replay.txt must record scroll_verified_by_operator after physical scroll review",
  );
}

function verifyResizeEvidence(ui, replay) {
  requireAttachedUi("resize-ui.xml", ui);
  requirePatternText(replay, /\bdogfood_resize_ok\b/, "resize-replay.txt must include Android-originated input after resize");
  const size = replay.match(/\bresize_size=(\d+)(?:x|\s+)(\d+)\b/);
  if (!size) {
    failures.push("resize-replay.txt must record resize_size=<rows>x<cols> or resize_size=<rows> <cols>");
    return;
  }
  const rows = Number(size[1]);
  const cols = Number(size[2]);
  if (rows < 5 || cols < 20) {
    failures.push(`resize-replay.txt records implausible terminal size ${rows}x${cols}`);
  }
}

function verifyPasteEvidence(ui, replay) {
  requireAttachedUi("paste-ui.xml", ui);
  for (const marker of [
    "DOGFOOD_PASTE_BEGIN",
    "dogfood_paste_line_001",
    "dogfood_paste_line_020",
    "DOGFOOD_PASTE_END",
    "dogfood_paste_ok",
  ]) {
    requirePatternText(
      replay,
      new RegExp(`\\b${escapeRegExp(marker)}\\b`),
      `paste-replay.txt must include ${marker}`,
    );
  }
}

function requireAttachedUi(file, text) {
  rejectPatternText(text, /\bNo sessions\b/i, `${file} must show an attached terminal, not the dashboard`);
  requirePatternText(text, /\bAttached\b/i, `${file} must show the attached terminal state`);
}

function verifyAdbDevices(text) {
  verifyPhysicalAndroidAdbDevices(text, failures);
}

function verifyLogs(entries) {
  verifyCleanAndroidLogs(entries, failures);
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
  if (bytes.length < 1024) {
    failures.push(`${file} is too small to be useful evidence (${bytes.length} bytes)`);
    return;
  }
  if (bytes.length < 24) {
    failures.push(`${file} is truncated`);
    return;
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width < 320 || height < 480) {
    failures.push(`${file} is too small for Android phone evidence (${width}x${height})`);
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

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
