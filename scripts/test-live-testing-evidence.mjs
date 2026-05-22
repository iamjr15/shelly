#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import zlib from "node:zlib";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const verifier = path.join(root, "scripts/verify-live-testing-evidence.mjs");
const autoSessionName = readAutoSessionName();

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "fieldwork-live-evidence-"));
const crc32Table = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

try {
  const good = path.join(temp, "good");
  writeFixture(good);
  expectStatus(good, 0, "good evidence fixture should pass");

  const missing = path.join(temp, "missing");
  writeFixture(missing);
  fs.rmSync(path.join(missing, "session.png"));
  expectStatus(missing, 1, "missing session screenshot should fail", "missing evidence file: session.png");

  const missingTui = path.join(temp, "missing-tui");
  writeFixture(missingTui);
  fs.rmSync(path.join(missingTui, "tui.png"));
  expectStatus(missingTui, 1, "missing TUI screenshot should fail", "missing evidence file: tui.png");

  const blankScreenshot = path.join(temp, "blank-screenshot");
  writeFixture(blankScreenshot);
  writePng(path.join(blankScreenshot, "session.png"), { blank: true });
  expectStatus(blankScreenshot, 1, "blank screenshot should fail", "session.png appears blank or solid-color");

  const badTui = path.join(temp, "bad-tui");
  writeFixture(badTui);
  fs.writeFileSync(path.join(badTui, "tui-ui.xml"), '<hierarchy><node text="Attached"/><node text="plain shell"/></hierarchy>\n');
  expectStatus(badTui, 1, "TUI without vim/htop content should fail", "tui-ui.xml must include visible vim/htop terminal content");

  const missingReplay = path.join(temp, "missing-replay");
  writeFixture(missingReplay);
  fs.rmSync(path.join(missingReplay, "terminal-replay.txt"));
  expectStatus(missingReplay, 1, "missing desktop replay transcript should fail", "missing evidence file: terminal-replay.txt");

  const missingPairing = path.join(temp, "missing-pairing");
  writeFixture(missingPairing);
  fs.rmSync(path.join(missingPairing, "pairing.txt"));
  expectStatus(missingPairing, 1, "missing desktop pairing transcript should fail", "missing evidence file: pairing.txt");

  const deniedPairing = path.join(temp, "denied-pairing");
  writeFixture(deniedPairing);
  fs.writeFileSync(
    path.join(deniedPairing, "pairing.txt"),
    [
      '{"pair_token":"ABCDE","expires_at_ms":1700000000000}',
      "Waiting for a device to scan. Pair token expires in 10 minutes.",
      'Pair request from device "Pixel" (nodeid) — approve? [y/N]',
      "Denied. Pair token has been consumed.",
    ].join("\n"),
  );
  expectStatus(
    deniedPairing,
    1,
    "denied desktop pairing transcript should fail",
    "pairing.txt must show the desktop approval completed pairing",
  );

  const badReplay = path.join(temp, "bad-replay");
  writeFixture(badReplay);
  fs.writeFileSync(path.join(badReplay, "terminal-replay.txt"), "shell prompt only\n");
  expectStatus(badReplay, 1, "desktop replay without Android marker should fail", "terminal-replay.txt must prove Android-originated input/output");

  const missingAutoName = path.join(temp, "missing-auto-name");
  writeFixture(missingAutoName);
  fs.writeFileSync(
    path.join(missingAutoName, "dashboard-ui.xml"),
    '<hierarchy><node text="refactoringjob"/><node text="shell"/></hierarchy>\n',
  );
  expectStatus(
    missingAutoName,
    1,
    "dashboard without generated default session should fail",
    "dashboard-ui.xml must show the generated one-word default session created by bare fw",
  );

  const autoNameWrongCommand = path.join(temp, "auto-name-wrong-command");
  writeFixture(autoNameWrongCommand);
  fs.writeFileSync(
    path.join(autoNameWrongCommand, "sessions.txt"),
    [`${autoSessionName} bash`, "refactoringjob claude", "shell bash", "editor vim"].join("\n"),
  );
  expectStatus(
    autoNameWrongCommand,
    1,
    "auto-named non-claude session should fail",
    "sessions.txt must include the generated one-word default claude session created by bare fw",
  );

  const bypassBuild = path.join(temp, "bypass-build");
  writeFixture(bypassBuild);
  fs.writeFileSync(
    path.join(bypassBuild, "buildconfig.txt"),
    [
      "public static final boolean DEBUG = Boolean.parseBoolean(\"true\");",
      'public static final String APPLICATION_ID = "app.fieldwork.android";',
      'public static final String BUILD_TYPE = "debug";',
      "public static final boolean FIELDWORK_BIOMETRIC_BYPASS = true;",
      'public static final String FIELDWORK_DEBUG_PAIRING_PAYLOAD = "{\\"pairing\\":true}";',
    ].join("\n"),
  );
  expectStatus(
    bypassBuild,
    1,
    "debug bypass BuildConfig should fail",
    "buildconfig.txt must prove the installed test build has biometric bypass disabled",
  );

  const releaseBuild = path.join(temp, "release-build");
  writeFixture(releaseBuild);
  fs.writeFileSync(
    path.join(releaseBuild, "buildconfig.txt"),
    [
      "public static final boolean DEBUG = false;",
      'public static final String APPLICATION_ID = "app.fieldwork.android";',
      'public static final String BUILD_TYPE = "release";',
      "public static final boolean FIELDWORK_BIOMETRIC_BYPASS = false;",
      'public static final String FIELDWORK_DEBUG_PAIRING_PAYLOAD = "";',
    ].join("\n"),
  );
  expectStatus(
    releaseBuild,
    1,
    "release BuildConfig should fail first live-test debug evidence",
    "buildconfig.txt must prove the installed test build is the debug variant",
  );

  const warmLaunch = path.join(temp, "warm-launch");
  writeFixture(warmLaunch);
  fs.writeFileSync(
    path.join(warmLaunch, "launch.txt"),
    ["Status: ok", "LaunchState: WARM", "Activity: app.fieldwork.android/.MainActivity", "TotalTime: 934"].join("\n"),
  );
  expectStatus(warmLaunch, 1, "warm locked launch should fail", "launch.txt must prove the locked launch was cold");

  const badBackground = path.join(temp, "bad-background");
  writeFixture(badBackground);
  fs.writeFileSync(path.join(badBackground, "background-replay.txt"), "after_background_ok only\n");
  expectStatus(badBackground, 1, "background replay without missed output should fail", "background-replay.txt must include output emitted while Android was backgrounded");

  const slowReconnect = path.join(temp, "slow-reconnect");
  writeFixture(slowReconnect);
  fs.writeFileSync(path.join(slowReconnect, "reconnect-replay.txt"), "reconnect_ms=2501\nNETWORK_REPLAY_OUTPUT\nafter_reconnect_ok\n");
  expectStatus(slowReconnect, 1, "slow reconnect timing should fail", "reconnect-replay.txt records reconnect_ms=2501");

  const leakedMultisession = path.join(temp, "leaked-multisession");
  writeFixture(leakedMultisession);
  fs.writeFileSync(path.join(leakedMultisession, "multisession-a-replay.txt"), "fwm_a\nmulti_a_ok\nmulti_b_ok\n");
  expectStatus(leakedMultisession, 1, "cross-session output leakage should fail", "multisession-a-replay.txt must not contain multi_b_ok");

  const crash = path.join(temp, "crash");
  writeFixture(crash);
  fs.writeFileSync(path.join(crash, "session-crash.log"), "FATAL EXCEPTION: main\nProcess: app.fieldwork.android\n");
  expectStatus(crash, 1, "Fieldwork crash-buffer fixture should fail", "session-crash.log must not contain");

  const offlineDevice = path.join(temp, "offline-device");
  writeFixture(offlineDevice);
  fs.writeFileSync(path.join(offlineDevice, "devices.txt"), "emulator-5554 offline\n");
  expectStatus(offlineDevice, 1, "offline adb device fixture should fail", "devices.txt must not show the tested device as unauthorized or offline");

  const unlockedLeak = path.join(temp, "locked-leak");
  writeFixture(unlockedLeak);
  fs.writeFileSync(path.join(unlockedLeak, "locked-ui.xml"), '<node text="Unlock"/><node text="refactoringjob"/>');
  expectStatus(unlockedLeak, 1, "locked session-content leak fixture should fail", "locked-ui.xml must not expose");
} finally {
  fs.rmSync(temp, { force: true, recursive: true });
}

console.log("live testing evidence verifier ok");

function writeFixture(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "buildconfig.txt"),
    [
      "public static final boolean DEBUG = Boolean.parseBoolean(\"true\");",
      'public static final String APPLICATION_ID = "app.fieldwork.android";',
      'public static final String BUILD_TYPE = "debug";',
      "public static final boolean FIELDWORK_BIOMETRIC_BYPASS = false;",
      'public static final String FIELDWORK_DEBUG_PAIRING_PAYLOAD = "";',
    ].join("\n"),
  );
  writePng(path.join(dir, "locked.png"));
  writePng(path.join(dir, "dashboard.png"));
  writePng(path.join(dir, "session.png"));
  writePng(path.join(dir, "tui.png"));
  writePng(path.join(dir, "background.png"));
  writePng(path.join(dir, "reconnect.png"));
  writePng(path.join(dir, "restart.png"));
  writePng(path.join(dir, "multisession.png"));
  fs.writeFileSync(
    path.join(dir, "launch.txt"),
    ["Status: ok", "LaunchState: COLD", "Activity: app.fieldwork.android/.MainActivity", "TotalTime: 934"].join("\n"),
  );
  fs.writeFileSync(path.join(dir, "locked-ui.xml"), '<hierarchy><node text="Unlock"/></hierarchy>\n');
  fs.writeFileSync(
    path.join(dir, "dashboard-ui.xml"),
    `<hierarchy><node text="${autoSessionName}"/><node text="refactoringjob"/><node text="shell"/></hierarchy>\n`,
  );
  fs.writeFileSync(path.join(dir, "session-ui.xml"), '<hierarchy><node text="shell"/><node text="Attached"/><node text="android_live_ok"/></hierarchy>\n');
  fs.writeFileSync(path.join(dir, "tui-ui.xml"), '<hierarchy><node text="tui"/><node text="Attached"/><node text="F1Help F2Setup F10Quit"/></hierarchy>\n');
  fs.writeFileSync(path.join(dir, "background-ui.xml"), '<hierarchy><node text="Attached"/><node text="after_background_ok"/></hierarchy>\n');
  fs.writeFileSync(path.join(dir, "reconnect-ui.xml"), '<hierarchy><node text="Attached"/><node text="after_reconnect_ok"/></hierarchy>\n');
  fs.writeFileSync(path.join(dir, "restart-ui.xml"), '<hierarchy><node text="fw_restart_session"/><node text="Attached"/></hierarchy>\n');
  fs.writeFileSync(path.join(dir, "multisession-ui.xml"), '<hierarchy><node text="fwm_a"/><node text="fwm_b"/><node text="fwm_c"/></hierarchy>\n');
  fs.writeFileSync(path.join(dir, "locked-logcat.log"), "I Fieldwork: locked launch\n");
  fs.writeFileSync(path.join(dir, "locked-crash.log"), "");
  fs.writeFileSync(
    path.join(dir, "pairing.txt"),
    [
      '{"pair_token":"ABCDE","expires_at_ms":1700000000000}',
      "Waiting for a device to scan. Pair token expires in 10 minutes.",
      'Pair request from device "Pixel 8 Pro" (nodeid) — approve? [y/N]',
      "Approved. Device is paired.",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(dir, "dashboard-logcat.log"),
    ["I FieldworkRepository: pair completed", "I FieldworkRepository: listSessions returned 4 sessions"].join("\n"),
  );
  fs.writeFileSync(path.join(dir, "dashboard-crash.log"), "");
  fs.writeFileSync(
    path.join(dir, "session-logcat.log"),
    [
      "I FieldworkRepository: pair completed",
      "I FieldworkRepository: listSessions returned 4 sessions",
      "I Fieldwork: terminal attached",
    ].join("\n"),
  );
  fs.writeFileSync(path.join(dir, "session-crash.log"), "");
  fs.writeFileSync(path.join(dir, "tui-logcat.log"), "I Fieldwork: terminal attached\n");
  fs.writeFileSync(path.join(dir, "tui-crash.log"), "");
  fs.writeFileSync(path.join(dir, "background-logcat.log"), "I Fieldwork: background replay attached\n");
  fs.writeFileSync(path.join(dir, "background-crash.log"), "");
  fs.writeFileSync(path.join(dir, "reconnect-logcat.log"), "I Fieldwork: reconnect attached\n");
  fs.writeFileSync(path.join(dir, "reconnect-crash.log"), "");
  fs.writeFileSync(path.join(dir, "restart-logcat.log"), "I Fieldwork: restart restore attached\n");
  fs.writeFileSync(path.join(dir, "restart-crash.log"), "");
  fs.writeFileSync(path.join(dir, "multisession-logcat.log"), "I Fieldwork: multisession switched\n");
  fs.writeFileSync(path.join(dir, "multisession-crash.log"), "");
  fs.writeFileSync(path.join(dir, "devices.txt"), "Pixel 8 Pro paired\n");
  fs.writeFileSync(path.join(dir, "terminal-replay.txt"), "shell bash\n$ echo android_live_ok\nandroid_live_ok\n");
  fs.writeFileSync(path.join(dir, "background-replay.txt"), "shell bash\nANDROID_BACKGROUND_REPLAY_OUTPUT\nafter_background_ok\n");
  fs.writeFileSync(path.join(dir, "reconnect-replay.txt"), "reconnect_ms=843\nNETWORK_REPLAY_OUTPUT\nafter_reconnect_ok\n");
  fs.writeFileSync(path.join(dir, "restart-replay.txt"), "fw_restart_session\nANDROID_RESTART_SCROLLBACK\n");
  fs.writeFileSync(path.join(dir, "multisession-a-replay.txt"), "fwm_a\nmulti_a_ok\n");
  fs.writeFileSync(path.join(dir, "multisession-b-replay.txt"), "fwm_b\nmulti_b_ok\n");
  fs.writeFileSync(path.join(dir, "multisession-c-replay.txt"), "fwm_c\nmulti_c_ok\n");
  fs.writeFileSync(
    path.join(dir, "sessions.txt"),
    [`${autoSessionName} claude`, "refactoringjob claude", "shell bash", "editor vim"].join("\n"),
  );
}

function readAutoSessionName() {
  const source = fs.readFileSync(path.join(root, "crates/cli/src/main.rs"), "utf8");
  const match = source.match(/const\s+AUTO_SESSION_NAMES\s*:\s*&\[[^\]]+\]\s*=\s*&\[(?<body>[\s\S]*?)\];/);
  const name = match?.groups?.body.match(/"([^"\n]+)"/)?.[1];
  if (!name) {
    throw new Error("cannot read AUTO_SESSION_NAMES from crates/cli/src/main.rs");
  }
  return name;
}

function writePng(file, options = {}) {
  const width = 360;
  const height = 640;
  const rowBytes = width * 4;
  const raw = Buffer.alloc((rowBytes + 1) * height);
  let offset = 0;
  for (let y = 0; y < height; y += 1) {
    raw[offset] = 0;
    offset += 1;
    for (let x = 0; x < width; x += 1) {
      if (options.blank) {
        raw[offset] = 18;
        raw[offset + 1] = 18;
        raw[offset + 2] = 18;
      } else {
        raw[offset] = (x * 3 + y) & 0xff;
        raw[offset + 1] = (x + y * 2) & 0xff;
        raw[offset + 2] = x > 90 && x < 270 && y > 220 && y < 420 ? 240 : 36;
      }
      raw[offset + 3] = 255;
      offset += 4;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw, { level: options.blank ? 0 : 6 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
  fs.writeFileSync(file, png);
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0);
  return Buffer.concat([length, typeBytes, data, crc]);
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = (crc >>> 8) ^ crc32Table[(crc ^ byte) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
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
