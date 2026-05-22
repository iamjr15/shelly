#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import zlib from "node:zlib";

const rawArgs = process.argv.slice(2).filter((arg) => arg !== "--");
const failures = [];
const root = path.resolve(new URL("..", import.meta.url).pathname);

if (rawArgs.length !== 1 || rawArgs[0] === "--help" || rawArgs[0] === "-h") {
  console.error("usage: node scripts/verify-live-testing-evidence.mjs <evidence-dir>");
  process.exit(rawArgs.length === 1 ? 0 : 2);
}

const evidenceDir = path.resolve(rawArgs[0]);
const autoSessionNames = readAutoSessionNames();
const autoSessionNameSource = `(?:${autoSessionNames.map(escapeRegExp).join("|")})`;
const autoSessionNamePattern = new RegExp(`\\b${autoSessionNameSource}\\b`, "i");
const autoClaudeSessionLinePattern = new RegExp(`^.*\\b${autoSessionNameSource}\\b.*\\bclaude\\b.*$`, "im");

requireDirectory(evidenceDir);

const requiredFiles = [
  "buildconfig.txt",
  "launch.txt",
  "locked.png",
  "locked-ui.xml",
  "locked-logcat.log",
  "locked-crash.log",
  "biometric.png",
  "biometric-ui.xml",
  "biometric-logcat.log",
  "biometric-crash.log",
  "adb-devices.txt",
  "pairing.txt",
  "dashboard.png",
  "dashboard-ui.xml",
  "dashboard-logcat.log",
  "dashboard-crash.log",
  "session.png",
  "session-ui.xml",
  "session-logcat.log",
  "session-crash.log",
  "terminal-replay.txt",
  "claude.png",
  "claude-ui.xml",
  "claude-logcat.log",
  "claude-crash.log",
  "claude-replay.txt",
  "flood.png",
  "flood-ui.xml",
  "flood-logcat.log",
  "flood-crash.log",
  "flood-replay.txt",
  "tui.png",
  "tui-ui.xml",
  "tui-logcat.log",
  "tui-crash.log",
  "devices.txt",
  "sessions.txt",
  "resize.png",
  "resize-ui.xml",
  "resize-logcat.log",
  "resize-crash.log",
  "resize-replay.txt",
  "detach.png",
  "detach-ui.xml",
  "detach-logcat.log",
  "detach-crash.log",
  "detach-replay.txt",
  "background.png",
  "background-ui.xml",
  "background-logcat.log",
  "background-crash.log",
  "background-replay.txt",
  "stale-biometric.png",
  "stale-biometric-ui.xml",
  "stale-biometric-logcat.log",
  "stale-biometric-crash.log",
  "stale-biometric.txt",
  "reconnect.png",
  "reconnect-ui.xml",
  "reconnect-logcat.log",
  "reconnect-crash.log",
  "reconnect-replay.txt",
  "restart.png",
  "restart-ui.xml",
  "restart-logcat.log",
  "restart-crash.log",
  "restart-replay.txt",
  "multisession.png",
  "multisession-ui.xml",
  "multisession-logcat.log",
  "multisession-crash.log",
  "multisession-a-replay.txt",
  "multisession-b-replay.txt",
  "multisession-c-replay.txt",
];

for (const file of requiredFiles) {
  requireFile(file);
}

if (failures.length === 0) {
  verifyBuildConfig(readText("buildconfig.txt"));
  verifyPng("locked.png");
  verifyPng("biometric.png");
  verifyPng("dashboard.png");
  verifyPng("session.png");
  verifyPng("claude.png");
  verifyPng("flood.png");
  verifyPng("tui.png");
  verifyPng("resize.png");
  verifyPng("detach.png");
  verifyPng("background.png");
  verifyPng("stale-biometric.png");
  verifyPng("reconnect.png");
  verifyPng("restart.png");
  verifyPng("multisession.png");
  verifyLaunch(readText("launch.txt"));
  verifyLockedSurface(readText("locked-ui.xml"));
  verifyLockedLaunchLog(readText("locked-logcat.log"));
  verifyBiometricPrompt(readText("biometric-ui.xml"), readText("biometric-logcat.log"));
  verifyAdbDevices(readText("adb-devices.txt"));
  verifyPairingTranscript(readText("pairing.txt"));
  verifyDashboardEvidence(
    readText("dashboard-ui.xml"),
    readText("dashboard-logcat.log"),
    readText("sessions.txt"),
  );
  verifySessionEvidence(
    readText("session-ui.xml"),
    readText("session-logcat.log"),
    readText("sessions.txt"),
    readText("terminal-replay.txt"),
  );
  verifyClaudeEvidence(readText("claude-ui.xml"), readText("claude-logcat.log"), readText("claude-replay.txt"));
  verifyFloodEvidence(readText("flood-ui.xml"), readText("flood-logcat.log"), readText("flood-replay.txt"));
  verifyTuiEvidence(readText("tui-ui.xml"));
  verifyResizeEvidence(readText("resize-ui.xml"), readText("resize-replay.txt"));
  verifyDetachEvidence(readText("detach-ui.xml"), readText("detach-replay.txt"));
  verifyBackgroundEvidence(readText("background-ui.xml"), readText("background-replay.txt"));
  verifyStaleBiometricPrompt(
    readText("stale-biometric-ui.xml"),
    readText("stale-biometric-logcat.log"),
    readText("stale-biometric.txt"),
  );
  verifyReconnectEvidence(readText("reconnect-ui.xml"), readText("reconnect-replay.txt"));
  verifyRestartEvidence(readText("restart-ui.xml"), readText("restart-replay.txt"));
  verifyMultisessionEvidence(
    readText("multisession-ui.xml"),
    readText("multisession-a-replay.txt"),
    readText("multisession-b-replay.txt"),
    readText("multisession-c-replay.txt"),
  );
  verifyMobileCapabilityBoundary([
    ["locked-ui.xml", readText("locked-ui.xml")],
    ["biometric-ui.xml", readText("biometric-ui.xml")],
    ["dashboard-ui.xml", readText("dashboard-ui.xml")],
    ["session-ui.xml", readText("session-ui.xml")],
    ["claude-ui.xml", readText("claude-ui.xml")],
    ["flood-ui.xml", readText("flood-ui.xml")],
    ["tui-ui.xml", readText("tui-ui.xml")],
    ["resize-ui.xml", readText("resize-ui.xml")],
    ["detach-ui.xml", readText("detach-ui.xml")],
    ["background-ui.xml", readText("background-ui.xml")],
    ["stale-biometric-ui.xml", readText("stale-biometric-ui.xml")],
    ["reconnect-ui.xml", readText("reconnect-ui.xml")],
    ["restart-ui.xml", readText("restart-ui.xml")],
    ["multisession-ui.xml", readText("multisession-ui.xml")],
  ]);
  verifyFieldworkDevices(readText("devices.txt"));
  verifyLogs([
    ["locked-logcat.log", readText("locked-logcat.log")],
    ["locked-crash.log", readText("locked-crash.log")],
    ["biometric-logcat.log", readText("biometric-logcat.log")],
    ["biometric-crash.log", readText("biometric-crash.log")],
    ["dashboard-logcat.log", readText("dashboard-logcat.log")],
    ["dashboard-crash.log", readText("dashboard-crash.log")],
    ["session-logcat.log", readText("session-logcat.log")],
    ["session-crash.log", readText("session-crash.log")],
    ["claude-logcat.log", readText("claude-logcat.log")],
    ["claude-crash.log", readText("claude-crash.log")],
    ["flood-logcat.log", readText("flood-logcat.log")],
    ["flood-crash.log", readText("flood-crash.log")],
    ["tui-logcat.log", readText("tui-logcat.log")],
    ["tui-crash.log", readText("tui-crash.log")],
    ["resize-logcat.log", readText("resize-logcat.log")],
    ["resize-crash.log", readText("resize-crash.log")],
    ["detach-logcat.log", readText("detach-logcat.log")],
    ["detach-crash.log", readText("detach-crash.log")],
    ["background-logcat.log", readText("background-logcat.log")],
    ["background-crash.log", readText("background-crash.log")],
    ["stale-biometric-logcat.log", readText("stale-biometric-logcat.log")],
    ["stale-biometric-crash.log", readText("stale-biometric-crash.log")],
    ["reconnect-logcat.log", readText("reconnect-logcat.log")],
    ["reconnect-crash.log", readText("reconnect-crash.log")],
    ["restart-logcat.log", readText("restart-logcat.log")],
    ["restart-crash.log", readText("restart-crash.log")],
    ["multisession-logcat.log", readText("multisession-logcat.log")],
    ["multisession-crash.log", readText("multisession-crash.log")],
  ]);
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(`live testing evidence ok: ${evidenceDir}`);

function readAutoSessionNames() {
  const sourcePath = path.join(root, "crates/cli/src/main.rs");
  const fallback = ["__fieldwork_auto_name_source_unavailable__"];
  let source;
  try {
    source = fs.readFileSync(sourcePath, "utf8");
  } catch (error) {
    failures.push(`cannot read CLI auto-session names from ${sourcePath}: ${error.message}`);
    return fallback;
  }

  const match = source.match(/const\s+AUTO_SESSION_NAMES\s*:\s*&\[[^\]]+\]\s*=\s*&\[(?<body>[\s\S]*?)\];/);
  if (!match?.groups?.body) {
    failures.push("cannot locate AUTO_SESSION_NAMES in crates/cli/src/main.rs");
    return fallback;
  }

  const names = [...match.groups.body.matchAll(/"([^"\n]+)"/g)].map((nameMatch) => nameMatch[1]);
  if (names.length === 0) {
    failures.push("AUTO_SESSION_NAMES in crates/cli/src/main.rs must not be empty");
    return fallback;
  }
  return names;
}

function verifyPairingTranscript(text) {
  requirePatternText(
    text,
    /"pair_token"\s*:/,
    "pairing.txt must include the JSON QR pairing payload from fw pair",
  );
  requirePatternText(
    text,
    /Waiting for a device to scan/i,
    "pairing.txt must show fw pair waited for a device scan",
  );
  requirePatternText(
    text,
    /Pair request from device\b[\s\S]*approve\?\s*\[y\/N\]/i,
    "pairing.txt must show the explicit desktop approval prompt",
  );
  requirePatternText(
    text,
    /Approved\. Device is paired\./,
    "pairing.txt must show the desktop approval completed pairing",
  );
  const timing = text.match(/\bpair_flow_ms=(\d+)\b/);
  if (!timing) {
    failures.push("pairing.txt must record pair_flow_ms=<elapsed-ms>");
  } else if (Number(timing[1]) > 15_000) {
    failures.push(`pairing.txt records pair_flow_ms=${timing[1]}, expected <=15000`);
  }
  rejectPatternText(
    text,
    /Denied\. Pair token has been consumed\./,
    "pairing.txt must not be a denied pairing transcript",
  );
}

function verifyBuildConfig(text) {
  requirePatternText(
    text,
    /\bAPPLICATION_ID\s*=\s*"app\.fieldwork\.android"/,
    "buildconfig.txt must prove the installed test build targets app.fieldwork.android",
  );
  requirePatternText(
    text,
    /\bBUILD_TYPE\s*=\s*"debug"/,
    "buildconfig.txt must prove the installed test build is the debug variant",
  );
  requirePatternText(
    text,
    /\bDEBUG\s*=\s*(?:true|Boolean\.parseBoolean\("true"\))/,
    "buildconfig.txt must prove the installed test build has BuildConfig.DEBUG enabled",
  );
  requirePatternText(
    text,
    /\bFIELDWORK_BIOMETRIC_BYPASS\s*=\s*false\b/,
    "buildconfig.txt must prove the installed test build has biometric bypass disabled",
  );
  requirePatternText(
    text,
    /\bFIELDWORK_DEBUG_PAIRING_PAYLOAD\s*=\s*""/,
    "buildconfig.txt must prove the installed test build has no debug pairing payload",
  );
}

function verifyLaunch(text) {
  requirePatternText(text, /\bStatus:\s*ok\b/, "launch.txt must contain Android am start Status: ok");
  requirePatternText(text, /\bLaunchState:\s*COLD\b/, "launch.txt must prove the locked launch was cold after force-stop");
  requirePatternText(text, /\bActivity:\s*app\.fieldwork\.android\/\.MainActivity\b/, "launch.txt must launch app.fieldwork.android/.MainActivity");
  requirePatternText(text, /\bTotalTime:\s*\d+\b/, "launch.txt must record TotalTime");
}

function verifyLockedSurface(text) {
  requirePatternText(text, /(?:>Unlock<|text="Unlock")/, "locked-ui.xml must show only the biometric unlock surface");
  rejectPatternText(
    text,
    /\b(No sessions|Pairing|Terminal|refactoringjob|bash|claude|ANDROID_)/i,
    "locked-ui.xml must not expose session, pairing, terminal, command, or test-marker content before unlock",
  );
}

function verifyLockedLaunchLog(text) {
  rejectPatternText(
    text,
    /\bFieldworkRepository:\s+(?:pair completed|listSessions returned|registerPushToken|attach)|\bterminal attached\b|\bsendInput\b/i,
    "locked-logcat.log must not show session sync, terminal attach, push-token registration, or input before unlock",
  );
}

function verifyBiometricPrompt(ui, logcat, options = {}) {
  const uiFile = options.uiFile ?? "biometric-ui.xml";
  const logFile = options.logFile ?? "biometric-logcat.log";
  const stage = options.stage ?? "before session access";
  requirePatternText(
    ui,
    /\b(?:Biometric|Fingerprint|fingerprint|Face|face|Confirm|Authenticate|Unlock Fieldwork|Use fingerprint|Touch the fingerprint sensor)\b/i,
    `${uiFile} must show the Android biometric prompt ${stage}`,
  );
  rejectPatternText(
    ui,
    /\b(No sessions|Terminal|refactoringjob|bash|claude|ANDROID_)\b/i,
    `${uiFile} must not expose session or terminal content behind the prompt`,
  );
  rejectPatternText(
    logcat,
    /\bFieldworkRepository:\s+(?:listSessions returned|registerPushToken|attach)|\bterminal attached\b|\bsendInput\b/i,
    `${logFile} must not show session sync, terminal attach, push-token registration, or input before unlock succeeds`,
  );
}

function verifyDashboardEvidence(dashboardUi, dashboardLogcat, sessionsText) {
  rejectPatternText(dashboardUi, /\bNo sessions\b/i, "dashboard-ui.xml must not be the empty dashboard after pairing");
  requirePatternText(
    dashboardUi,
    autoSessionNamePattern,
    "dashboard-ui.xml must show the generated one-word default session created by bare fw",
  );
  requirePatternText(
    dashboardUi,
    /\brefactoringjob\b/i,
    "dashboard-ui.xml must show the named shortcut session refactoringjob",
  );
  requirePatternText(
    dashboardUi,
    /\b(shell|bash)\b/i,
    "dashboard-ui.xml must show the desktop-created shell/bash session",
  );
  requirePatternText(dashboardLogcat, /FieldworkRepository:\s+pair completed/, "dashboard-logcat.log must show repository pair completion");
  requirePatternText(dashboardLogcat, /FieldworkRepository:\s+listSessions returned \d+ sessions/, "dashboard-logcat.log must show session listing after pair");
  requirePatternText(
    sessionsText,
    autoClaudeSessionLinePattern,
    "sessions.txt must include the generated one-word default claude session created by bare fw",
  );
  requirePatternText(
    sessionsText,
    /^.*\brefactoringjob\b.*\bclaude\b.*$/im,
    "sessions.txt must include the named shortcut refactoringjob claude session",
  );
}

function verifySessionEvidence(sessionUi, sessionLogcat, sessionsText, terminalReplay) {
  rejectPatternText(sessionUi, /\bNo sessions\b/i, "session-ui.xml must not be the empty dashboard after pairing");
  requirePatternText(sessionUi, /\bAttached\b/i, "session-ui.xml must show the normal terminal attached state");
  requirePatternText(sessionLogcat, /FieldworkRepository:\s+pair completed/, "session-logcat.log must show repository pair completion");
  requirePatternText(sessionLogcat, /FieldworkRepository:\s+listSessions returned \d+ sessions/, "session-logcat.log must show session listing after pair");
  requirePatternText(sessionsText, /\brefactoringjob\b/, "sessions.txt must include the named shortcut session refactoringjob");
  requirePatternText(sessionsText, /\bclaude\b/i, "sessions.txt must include a Claude/default session command");
  requirePatternText(sessionsText, /\b(shell|bash)\b/i, "sessions.txt must include a desktop-created shell/bash session");
  requirePatternText(sessionsText, /\b(editor|vim|htop)\b/i, "sessions.txt must include a desktop-created TUI session");
  requirePatternText(
    terminalReplay,
    /\bandroid_live_ok\b/,
    "terminal-replay.txt must prove Android-originated input/output was visible from a desktop reattach",
  );
  requirePatternText(
    terminalReplay,
    /\b(shell|bash)\b/i,
    "terminal-replay.txt must identify the desktop-created shell/bash session",
  );
}

function verifyClaudeEvidence(ui, logcat, replay) {
  rejectPatternText(ui, /\bNo sessions\b/i, "claude-ui.xml must show an attached Claude session, not the dashboard");
  requirePatternText(ui, /\bAttached\b/i, "claude-ui.xml must show the Claude terminal attached state");
  requirePatternText(ui, /\b(?:claude|refactoringjob|Claude Code)\b/i, "claude-ui.xml must identify the attached Claude/default session");
  requirePatternText(logcat, /Fieldwork:\s+terminal attached|FieldworkRepository:\s+listSessions returned \d+ sessions/i, "claude-logcat.log must show app activity while attached to the Claude session");
  requirePatternText(
    replay,
    /\bclaude_live_ok\b/,
    "claude-replay.txt must prove Android-originated input/output was visible from a desktop reattach to the Claude session",
  );
  requirePatternText(replay, /\b(?:claude|refactoringjob)\b/i, "claude-replay.txt must identify the Claude/default session");
  rejectPatternText(replay, /\bandroid_live_ok\b/, "claude-replay.txt must be a dedicated Claude-session transcript, not the shell replay");
}

function verifyFloodEvidence(ui, logcat, replay) {
  rejectPatternText(ui, /\bNo sessions\b/i, "flood-ui.xml must show an attached terminal, not the dashboard");
  requirePatternText(ui, /\bAttached\b/i, "flood-ui.xml must show the flood terminal attached state");
  requirePatternText(
    ui,
    /\bANDROID_LIVE_FLOOD\b/,
    "flood-ui.xml must show the high-volume flood marker in the Android terminal view",
  );
  requirePatternText(logcat, /Fieldwork:\s+terminal attached|FieldworkRepository:\s+listSessions returned \d+ sessions/i, "flood-logcat.log must show app activity while attached to the flooded terminal");
  requirePatternText(replay, /\b(shell|bash)\b/i, "flood-replay.txt must identify the desktop-created shell/bash session");
  requirePatternText(
    replay,
    /\byes\s+ANDROID_LIVE_FLOOD\s*\|\s*head\s+-10000\b/,
    "flood-replay.txt must show the Android-originated yes | head -10000 flood command",
  );
  requirePatternText(
    replay,
    /\bANDROID_LIVE_FLOOD_DONE\b/,
    "flood-replay.txt must include the completion marker after the high-volume flood",
  );
  const lineMarkerLine = replay.split(/\r?\n/).find((line) => line.trim().match(/^flood_lines=\d+$/));
  const lineMarker = lineMarkerLine?.match(/^flood_lines=(\d+)$/);
  if (!lineMarker) {
    failures.push("flood-replay.txt must record flood_lines=10000");
  } else if (Number(lineMarker[1]) !== 10_000) {
    failures.push(`flood-replay.txt records flood_lines=${lineMarker[1]}, expected 10000`);
  }
  const markerCount = replay.split(/\r?\n/).filter((line) => line.trim() === "ANDROID_LIVE_FLOOD").length;
  if (markerCount < 10_000) {
    failures.push(`flood-replay.txt contains ${markerCount} ANDROID_LIVE_FLOOD markers, expected at least 10000`);
  }
}

function verifyTuiEvidence(text) {
  rejectPatternText(text, /\bNo sessions\b/i, "tui-ui.xml must show an attached TUI, not the dashboard");
  requirePatternText(text, /\bAttached\b/i, "tui-ui.xml must show the terminal attached state");
  requirePatternText(
    text,
    /(F1\s*Help|F1Help|F2\s*Setup|F2Setup|F10\s*Quit|F10Quit|VIM|--\s*INSERT\s*--|\/etc\/hosts|~\s*$)/im,
    "tui-ui.xml must include visible vim/htop terminal content",
  );
}

function verifyResizeEvidence(ui, replay) {
  requirePatternText(ui, /\bAttached\b/i, "resize-ui.xml must show the app remained attached after terminal resize");
  requirePatternText(
    replay,
    /\bafter_resize_ok\b/,
    "resize-replay.txt must include Android-originated input after terminal resize",
  );
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

function verifyDetachEvidence(ui, replay) {
  rejectPatternText(ui, /\bNo sessions\b/i, "detach-ui.xml must show the sessions dashboard after detach, not an empty state");
  requirePatternText(
    ui,
    /\b(refactoringjob|shell|bash)\b/i,
    "detach-ui.xml must show the sessions dashboard after Android detach",
  );
  requirePatternText(
    replay,
    /\bafter_detach_reattach_ok\b/,
    "detach-replay.txt must include Android-originated input after detach and reattach",
  );
  requirePatternText(replay, /\b(shell|bash)\b/i, "detach-replay.txt must identify the reattached shell/bash session");
}

function verifyBackgroundEvidence(ui, replay) {
  requirePatternText(ui, /\bAttached\b/i, "background-ui.xml must show the app returned to an attached terminal after foreground");
  requirePatternText(
    replay,
    /\bANDROID_BACKGROUND_REPLAY_OUTPUT\b/,
    "background-replay.txt must include output emitted while Android was backgrounded",
  );
  requirePatternText(
    replay,
    /\bafter_background_ok\b/,
    "background-replay.txt must include Android-originated input after foreground resume",
  );
}

function verifyStaleBiometricPrompt(ui, logcat, transcript) {
  verifyBiometricPrompt(ui, logcat, {
    uiFile: "stale-biometric-ui.xml",
    logFile: "stale-biometric-logcat.log",
    stage: "after at least 5 minutes in background",
  });
  const timing = transcript.match(/\bstale_background_ms=(\d+)\b/);
  if (!timing) {
    failures.push("stale-biometric.txt must record stale_background_ms=<elapsed-ms>");
  } else if (Number(timing[1]) < 300_000) {
    failures.push(`stale-biometric.txt records stale_background_ms=${timing[1]}, expected >=300000`);
  }
  requirePatternText(
    transcript,
    /\bstale_input_before_unlock_blocked\b/,
    "stale-biometric.txt must prove terminal input was blocked before stale biometric unlock",
  );
  rejectPatternText(
    transcript,
    /\b(?:stale_input_before_unlock_sent|stale_input_before_unlock_visible)\b/,
    "stale-biometric.txt must not show stale terminal input was sent before unlock",
  );
}

function verifyReconnectEvidence(ui, replay) {
  requirePatternText(ui, /\bAttached\b/i, "reconnect-ui.xml must show the app returned to an attached terminal after network reconnect");
  requirePatternText(
    replay,
    /\b(?:NETWORK_REPLAY_OUTPUT|ANDROID_RECONNECT_REPLAY_OUTPUT)\b/,
    "reconnect-replay.txt must include output emitted during the network gap",
  );
  requirePatternText(
    replay,
    /\bafter_reconnect_ok\b/,
    "reconnect-replay.txt must include Android-originated input after network restore",
  );
  const timing = replay.match(/\breconnect_ms=(\d+)\b/);
  if (!timing) {
    failures.push("reconnect-replay.txt must record reconnect_ms=<elapsed-ms>");
  } else if (Number(timing[1]) > 2_000) {
    failures.push(`reconnect-replay.txt records reconnect_ms=${timing[1]}, expected <=2000`);
  }
}

function verifyRestartEvidence(ui, replay) {
  requirePatternText(ui, /\b(?:fw_restart_session|Attached)\b/i, "restart-ui.xml must show the restored session after daemon restart");
  requirePatternText(
    replay,
    /\bANDROID_RESTART_SCROLLBACK\b/,
    "restart-replay.txt must include restored daemon scrollback from before restart",
  );
  requirePatternText(
    replay,
    /\bfw_restart_session\b/,
    "restart-replay.txt must identify the restored desktop-created session",
  );
}

function verifyMultisessionEvidence(ui, replayA, replayB, replayC) {
  requirePatternText(ui, /\bfwm_a\b/i, "multisession-ui.xml must include fwm_a in the switched session set");
  requirePatternText(ui, /\bfwm_b\b/i, "multisession-ui.xml must include fwm_b in the switched session set");
  requirePatternText(ui, /\bfwm_c\b/i, "multisession-ui.xml must include fwm_c in the switched session set");
  verifyMultisessionReplay("multisession-a-replay.txt", replayA, "fwm_a", "multi_a_ok", ["multi_b_ok", "multi_c_ok"]);
  verifyMultisessionReplay("multisession-b-replay.txt", replayB, "fwm_b", "multi_b_ok", ["multi_a_ok", "multi_c_ok"]);
  verifyMultisessionReplay("multisession-c-replay.txt", replayC, "fwm_c", "multi_c_ok", ["multi_a_ok", "multi_b_ok"]);
}

function verifyMultisessionReplay(file, text, sessionName, requiredMarker, forbiddenMarkers) {
  requirePatternText(text, new RegExp(`\\b${escapeRegExp(sessionName)}\\b`, "i"), `${file} must identify ${sessionName}`);
  requirePatternText(text, new RegExp(`\\b${escapeRegExp(requiredMarker)}\\b`), `${file} must contain ${requiredMarker}`);
  for (const marker of forbiddenMarkers) {
    rejectPatternText(text, new RegExp(`\\b${escapeRegExp(marker)}\\b`), `${file} must not contain ${marker} from another session`);
  }
}

function verifyMobileCapabilityBoundary(entries) {
  const forbiddenAction = /\b(?:Create|New|Start)\s+(?:session|terminal)\b|\b(?:Kill|Delete|Remove|Terminate)\s+(?:session|terminal)\b|\b(?:Choose|Select|Pick)\s+(?:command|shell|session command)\b|\bcommand picker\b/i;
  for (const [file, text] of entries) {
    rejectPatternText(
      text,
      forbiddenAction,
      `${file} must not expose mobile session creation, kill, or command-selection controls`,
    );
  }
}

function verifyAdbDevices(text) {
  requirePatternText(text, /^List of devices attached\b/im, "adb-devices.txt must include adb devices output");
  requirePatternText(
    text,
    /^[^\s#][^\n]*\s+device(?:\s|$)/im,
    "adb-devices.txt must show at least one authorized adb device",
  );
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

function verifyFieldworkDevices(text) {
  requirePatternText(text, /\S/, "devices.txt must not be empty");
  rejectPatternText(text, /\bno paired devices\b/i, "devices.txt must show at least one paired Fieldwork device");
}

function verifyLogs(entries) {
  const fatalPattern = /\bFATAL EXCEPTION\b|\bANR in app\.fieldwork\.android\b|Fieldwork.*\b(FATAL|ANR|Exception)\b/i;
  const crashPattern = /\bapp\.fieldwork\.android\b|\bFATAL EXCEPTION\b|\bANR\b/i;
  for (const [name, text] of entries) {
    rejectPatternText(text, fatalPattern, `${name} must not contain Fieldwork fatal, ANR, or exception entries`);
    if (name.endsWith("-crash.log")) {
      rejectPatternText(text, crashPattern, `${name} must not contain app.fieldwork.android crash-buffer entries`);
    }
  }
}

function verifyPng(file) {
  const absolute = path.join(evidenceDir, file);
  const bytes = fs.readFileSync(absolute);
  const pngMagic = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const hasMagic = pngMagic.every((byte, index) => bytes[index] === byte);
  if (!hasMagic) {
    failures.push(`${file} must be a PNG screenshot`);
  }
  if (bytes.length < 1024) {
    failures.push(`${file} is too small to be useful evidence (${bytes.length} bytes)`);
  }
  try {
    const image = decodePng(bytes);
    verifyScreenshotDimensions(file, image);
    verifyVisiblePng(file, image);
  } catch (error) {
    failures.push(`${file} must be a decodable nonblank PNG screenshot: ${error.message}`);
  }
}

function decodePng(bytes) {
  let offset = 8;
  let header = null;
  const idat = [];

  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    offset += 4;
    const type = bytes.toString("ascii", offset, offset + 4);
    offset += 4;
    const dataStart = offset;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > bytes.length) {
      throw new Error(`truncated ${type || "PNG"} chunk`);
    }
    const data = bytes.subarray(dataStart, dataEnd);
    offset = dataEnd + 4;

    if (type === "IHDR") {
      if (length !== 13) {
        throw new Error("invalid IHDR length");
      }
      header = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        compression: data[10],
        filter: data[11],
        interlace: data[12],
      };
    } else if (type === "IDAT") {
      idat.push(Buffer.from(data));
    } else if (type === "IEND") {
      break;
    }
  }

  if (!header) {
    throw new Error("missing IHDR");
  }
  if (idat.length === 0) {
    throw new Error("missing IDAT");
  }
  if (header.width === 0 || header.height === 0) {
    throw new Error("empty dimensions");
  }
  if (header.bitDepth !== 8) {
    throw new Error(`unsupported bit depth ${header.bitDepth}`);
  }
  if (header.compression !== 0 || header.filter !== 0 || header.interlace !== 0) {
    throw new Error("unsupported PNG compression, filter, or interlace mode");
  }

  const channels = channelsForColorType(header.colorType);
  const rowBytes = header.width * channels;
  const expected = (rowBytes + 1) * header.height;
  const inflated = zlib.inflateSync(Buffer.concat(idat));
  if (inflated.length < expected) {
    throw new Error(`truncated image data (${inflated.length}/${expected} bytes)`);
  }

  const pixels = Buffer.alloc(rowBytes * header.height);
  let inputOffset = 0;
  for (let y = 0; y < header.height; y += 1) {
    const filterType = inflated[inputOffset];
    inputOffset += 1;
    const rowStart = y * rowBytes;
    const prevRowStart = rowStart - rowBytes;
    for (let x = 0; x < rowBytes; x += 1) {
      const byte = inflated[inputOffset];
      inputOffset += 1;
      const left = x >= channels ? pixels[rowStart + x - channels] : 0;
      const up = y > 0 ? pixels[prevRowStart + x] : 0;
      const upLeft = y > 0 && x >= channels ? pixels[prevRowStart + x - channels] : 0;
      pixels[rowStart + x] = unfilterByte(filterType, byte, left, up, upLeft);
    }
  }

  return { ...header, channels, pixels };
}

function channelsForColorType(colorType) {
  switch (colorType) {
    case 0:
      return 1;
    case 2:
      return 3;
    case 4:
      return 2;
    case 6:
      return 4;
    default:
      throw new Error(`unsupported color type ${colorType}`);
  }
}

function unfilterByte(filterType, byte, left, up, upLeft) {
  switch (filterType) {
    case 0:
      return byte;
    case 1:
      return (byte + left) & 0xff;
    case 2:
      return (byte + up) & 0xff;
    case 3:
      return (byte + Math.floor((left + up) / 2)) & 0xff;
    case 4:
      return (byte + paeth(left, up, upLeft)) & 0xff;
    default:
      throw new Error(`unsupported PNG filter ${filterType}`);
  }
}

function paeth(left, up, upLeft) {
  const estimate = left + up - upLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const upLeftDistance = Math.abs(estimate - upLeft);
  if (leftDistance <= upDistance && leftDistance <= upLeftDistance) {
    return left;
  }
  if (upDistance <= upLeftDistance) {
    return up;
  }
  return upLeft;
}

function verifyScreenshotDimensions(file, image) {
  const shortSide = Math.min(image.width, image.height);
  const longSide = Math.max(image.width, image.height);
  if (shortSide < 360 || longSide < 640) {
    throw new Error(`${file} is too small for Android phone evidence (${image.width}x${image.height})`);
  }
}

function verifyVisiblePng(file, image) {
  let first = null;
  let opaquePixels = 0;
  let differingPixels = 0;

  for (let offset = 0; offset < image.pixels.length; offset += image.channels) {
    const pixel = pixelRgb(image, offset);
    if (pixel.alpha < 16) {
      continue;
    }
    opaquePixels += 1;
    if (!first) {
      first = pixel;
    } else if (rgbDistance(first, pixel) > 8) {
      differingPixels += 1;
    }
  }

  if (!first) {
    throw new Error("no opaque pixels");
  }
  const minimumDifferingPixels = Math.max(8, Math.min(200, Math.floor(opaquePixels * 0.00005)));
  if (differingPixels < minimumDifferingPixels) {
    throw new Error(
      `${file} appears blank or solid-color (${differingPixels}/${opaquePixels} visibly different pixels)`,
    );
  }
}

function pixelRgb(image, offset) {
  const data = image.pixels;
  switch (image.colorType) {
    case 0:
      return { red: data[offset], green: data[offset], blue: data[offset], alpha: 255 };
    case 2:
      return { red: data[offset], green: data[offset + 1], blue: data[offset + 2], alpha: 255 };
    case 4:
      return { red: data[offset], green: data[offset], blue: data[offset], alpha: data[offset + 1] };
    case 6:
      return { red: data[offset], green: data[offset + 1], blue: data[offset + 2], alpha: data[offset + 3] };
    default:
      throw new Error(`unsupported color type ${image.colorType}`);
  }
}

function rgbDistance(a, b) {
  return Math.abs(a.red - b.red) + Math.abs(a.green - b.green) + Math.abs(a.blue - b.blue);
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
