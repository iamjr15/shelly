#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const repo = path.resolve(new URL("..", import.meta.url).pathname);
const failures = [];
const removedCrashSdkPattern = new RegExp([
  `${"Se"}${"ntry"}`,
  `${"se"}${"ntry"}`,
  `FIELDWORK_${"SE"}${"NTRY"}`,
  `${"se"}${"ntry"}_${"d"}${"sn"}`,
].join("|"));
const removedCrashCredentialPattern = new RegExp([
  `${"Se"}${"ntry"}`,
  `${"se"}${"ntry"}`,
  `${"D"}${"SN"}`,
  `${"d"}${"sn"}`,
].join("|"));

const files = {
  daemonLogging: read("crates/daemon/src/logging.rs"),
  daemonConfig: read("crates/daemon/src/config.rs"),
  iosTelemetry: read("apps/ios/Sources/Core/MobileTelemetry.swift"),
  iosAppModel: read("apps/ios/Sources/App/AppModel.swift"),
  iosRoot: read("apps/ios/Sources/App/FieldworkApp.swift"),
  iosTerminal: read("apps/ios/Sources/Core/TerminalSessionController.swift"),
  androidTelemetry: read("apps/android/app/src/main/kotlin/app/fieldwork/android/core/MobileTelemetry.kt"),
  androidViewModel: read("apps/android/app/src/main/kotlin/app/fieldwork/android/core/FieldworkViewModel.kt"),
  androidRoot: read("apps/android/app/src/main/kotlin/app/fieldwork/android/ui/FieldworkApp.kt"),
  androidTerminal: read("apps/android/app/src/main/kotlin/app/fieldwork/android/core/TerminalController.kt"),
  androidBuildFiles: readAllExisting([
    "apps/android/build.gradle.kts",
    "apps/android/settings.gradle.kts",
    "apps/android/gradle.properties",
    "apps/android/app/build.gradle.kts",
  ]),
  relayMain: read("crates/relay/src/main.rs"),
  relayLib: read("crates/relay/src/lib.rs"),
  relayTelemetry: read("crates/relay/src/telemetry.rs"),
  relayOtlpSmoke: read("scripts/smoke-relay-otlp-loopback.mjs"),
  relayService: read("infra/relay/ansible/templates/fieldwork-control-plane.service.j2"),
  cargoToml: read("Cargo.toml"),
};

rejectPattern(
  `${files.daemonConfig}\n${files.daemonLogging}\n${files.cargoToml}`,
  removedCrashSdkPattern,
  "daemon and workspace dependencies must not contain crash-reporting SDK wiring",
);
rejectPattern(
  files.daemonLogging,
  /opentelemetry|FIELDWORK_RELAY_OTLP|Honeycomb/i,
  "daemon logging must not wire OTLP/Honeycomb export in v1",
);

requirePattern(
  files.iosTelemetry,
  /diagnosticsOptInKey/,
  "iOS telemetry consent must persist a diagnostics opt-in key",
);
requirePattern(
  files.iosTelemetry,
  /diagnosticsConsentResolvedKey/,
  "iOS telemetry consent prompt must persist a one-time resolved state",
);
requirePattern(
  files.iosTelemetry,
  /shouldShowConsentPrompt\(\)/,
  "iOS telemetry must expose delayed consent prompt gating",
);
rejectPattern(files.iosTelemetry, removedCrashCredentialPattern, "iOS telemetry must not initialize a crash-reporting SDK");
requirePattern(
  files.iosAppModel,
  /recordTelemetryExperience\(\)/,
  "iOS app model must surface delayed telemetry consent only after a real product experience",
);
requirePattern(
  files.iosRoot,
  /confirmationDialog\(\s*"Help improve Fieldwork\?"/,
  "iOS must present the delayed telemetry consent as a bottom-sheet confirmation dialog",
);
requirePattern(
  files.iosRoot,
  /No code, prompts, terminal output, or file paths/,
  "iOS delayed telemetry consent copy must exclude terminal/user content",
);
requirePattern(
  files.iosTerminal,
  /awaitingInputObserved[\s\S]*inputSentAfterAwaiting[\s\S]*outputLinesAfterResponse/,
  "iOS terminal controller must gate delayed telemetry prompt on AwaitingInput, user input, and subsequent output",
);
requirePattern(
  files.iosTerminal,
  /outputLinesAfterResponse\s*>=\s*10/,
  "iOS delayed telemetry prompt must wait for 10+ output lines after response",
);

requirePattern(
  files.androidTelemetry,
  /getBoolean\(diagnosticsOptInKey,\s*false\)/,
  "Android diagnostics sharing must default to opt-out",
);
requirePattern(
  files.androidTelemetry,
  /diagnosticsConsentResolvedKey/,
  "Android telemetry consent prompt must persist a one-time resolved state",
);
requirePattern(
  files.androidTelemetry,
  /shouldShowConsentPrompt\(context: Context\)/,
  "Android telemetry must expose delayed consent prompt gating",
);
rejectPattern(files.androidTelemetry, removedCrashCredentialPattern, "Android telemetry must not initialize a crash-reporting SDK");
rejectPattern(files.androidBuildFiles, removedCrashSdkPattern, "Android build files must not declare a removed crash-reporting SDK");
requirePattern(
  files.androidViewModel,
  /recordTelemetryExperience\(\)/,
  "Android view model must surface delayed telemetry consent only after a real product experience",
);
requirePattern(
  files.androidRoot,
  /ModalBottomSheet\(onDismissRequest = \{ viewModel\.answerTelemetryConsent\(false\) \}\)/,
  "Android must present the delayed telemetry consent as a bottom sheet",
);
requirePattern(
  files.androidRoot,
  /No code, prompts, terminal output, or file paths/,
  "Android delayed telemetry consent copy must exclude terminal/user content",
);
requirePattern(
  files.androidTerminal,
  /awaitingInputObserved[\s\S]*inputSentAfterAwaiting[\s\S]*outputLinesAfterResponse/,
  "Android terminal controller must gate delayed telemetry prompt on AwaitingInput, user input, and subsequent output",
);
requirePattern(
  files.androidTerminal,
  /outputLinesAfterResponse\s*>=\s*10/,
  "Android delayed telemetry prompt must wait for 10+ output lines after response",
);

requirePattern(
  files.relayTelemetry,
  /const DEFAULT_SAMPLE_RATE:\s*f64\s*=\s*0\.01;/,
  "relay OTLP/Honeycomb sample rate must default to 1%",
);
requirePattern(
  files.relayTelemetry,
  /FIELDWORK_RELAY_OTLP_ENDPOINT/,
  "relay OTLP export must be controlled by explicit relay environment",
);
requirePattern(
  files.relayOtlpSmoke,
  /process\.env\.FIELDWORK_RELAY_BINARY/,
  "relay OTLP smoke must support an explicit relay binary",
);
requirePattern(
  files.relayOtlpSmoke,
  /target", "release", binaryName/,
  "relay OTLP smoke must prefer the existing release binary before debug builds",
);
requirePattern(
  files.relayTelemetry,
  /FIELDWORK_RELAY_HONEYCOMB_API_KEY_PATH/,
  "relay Honeycomb key path must be relay-only configuration",
);
requirePattern(
  files.relayTelemetry,
  /CREDENTIALS_DIRECTORY/,
  "relay Honeycomb key must support systemd credentials",
);
requirePattern(
  files.relayTelemetry,
  /header_names/,
  "relay telemetry debug output must expose header names instead of values",
);
requirePattern(
  files.relayTelemetry,
  /!debug\.contains\("hcaik_live_secret"\)/,
  "relay telemetry tests must assert Honeycomb API keys are redacted",
);
requirePattern(
  files.cargoToml,
  /opentelemetry-otlp[^\n]*"reqwest-rustls"/,
  "relay OTLP exporter must use Reqwest's OS-native rustls root feature",
);
rejectPattern(
  files.cargoToml,
  /opentelemetry-otlp[^\n]*reqwest-rustls-webpki-roots/,
  "relay OTLP exporter must not use WebPKI roots for Fieldwork-owned Honeycomb TLS",
);
requirePattern(
  files.relayService,
  /LoadCredential=honeycomb-api-key:/,
  "relay systemd unit must load Honeycomb as a credential, not an environment value",
);
requirePattern(
  files.relayMain,
  /\.with\(PrivacySanitizerLayer\)/,
  "relay tracing stack must install the privacy sanitizer layer",
);
requirePattern(
  files.relayLib,
  /#\[cfg\(test\)\]\s+delivered:\s*Vec<DeliveredPush>/,
  "relay must keep accepted delivery record retention out of production builds",
);

for (const [label, source] of [
  ["relay main", files.relayMain],
  ["relay library", stripTestModules(files.relayLib)],
]) {
  rejectPattern(
    source,
    /tracing::(?:info|warn|error|debug|trace)!\([^;\n]*(daemon_node_id|recipient_token|push_token|session_id_hash|session_name_hash|command|path|last_line|terminal)/,
    `${label} must not attach user or stable device/session identifiers to tracing events`,
  );
}

verifyPackagedArtifactHasNoCrashSdk(
  "Android debug APK",
  "apps/android/app/build/outputs/apk/debug/app-debug.apk",
);
verifyPackagedArtifactHasNoCrashSdk(
  "Android release AAB",
  "apps/android/app/build/outputs/bundle/release/app-release.aab",
);

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log("telemetry privacy wiring ok");

function read(rel) {
  return fs.readFileSync(path.join(repo, rel), "utf8");
}

function readAllExisting(paths) {
  return paths
    .filter((rel) => fs.existsSync(path.join(repo, rel)))
    .map((rel) => fs.readFileSync(path.join(repo, rel), "utf8"))
    .join("\n");
}

function requirePattern(text, pattern, message) {
  if (!pattern.test(text)) {
    failures.push(message);
  }
}

function rejectPattern(text, pattern, message) {
  if (pattern.test(text)) {
    failures.push(message);
  }
}

function stripTestModules(text) {
  return text.replace(/#\[cfg\(test\)\]\s*mod tests \{[\s\S]*$/m, "");
}

function verifyPackagedArtifactHasNoCrashSdk(label, rel) {
  const artifact = path.join(repo, rel);
  if (!fs.existsSync(artifact)) {
    return;
  }

  let archive;
  try {
    archive = readZipArchive(artifact);
  } catch (error) {
    failures.push(`${label} could not be inspected for removed crash SDK classes: ${error.message}`);
    return;
  }

  const removedSdk = `${"se"}${"ntry"}`;
  const forbiddenNeedles = [
    `io/${removedSdk}`,
    `lio/${removedSdk}`,
    `io.${removedSdk}`,
    `${removedSdk}android`,
    `${removedSdk}initprovider`,
    `${removedSdk}dsn`,
    `${removedSdk}_dsn`,
    `${removedSdk}-dsn`,
    `fieldwork_${removedSdk}`,
  ];

  for (const entry of archive.entries) {
    const entryName = entry.name.toLowerCase();
    const matchedName = forbiddenNeedles.find((needle) => entryName.includes(needle));
    if (matchedName) {
      failures.push(`${label} packages removed crash SDK marker ${matchedName} in ${entry.name}`);
      continue;
    }

    if (entry.directory) {
      continue;
    }

    let bytes;
    try {
      bytes = readZipEntryBytes(archive.bytes, entry);
    } catch (error) {
      failures.push(`${label} could not read ${entry.name} while checking removed crash SDK classes: ${error.message}`);
      continue;
    }

    const matchedContent = forbiddenNeedles.find((needle) => asciiIncludes(bytes, needle));
    if (matchedContent) {
      failures.push(`${label} packages removed crash SDK marker ${matchedContent} in ${entry.name}`);
    }
  }
}

function readZipArchive(file) {
  const bytes = fs.readFileSync(file);
  const eocd = findEndOfCentralDirectory(bytes);
  const entries = [];
  let offset = bytes.readUInt32LE(eocd + 16);
  const totalEntries = bytes.readUInt16LE(eocd + 10);

  for (let index = 0; index < totalEntries; index += 1) {
    if (bytes.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error(`invalid central directory header at offset ${offset}`);
    }
    const compressionMethod = bytes.readUInt16LE(offset + 10);
    const compressedSize = bytes.readUInt32LE(offset + 20);
    const uncompressedSize = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const localHeaderOffset = bytes.readUInt32LE(offset + 42);
    const name = bytes.toString("utf8", offset + 46, offset + 46 + nameLength);
    entries.push({
      compressedSize,
      compressionMethod,
      directory: name.endsWith("/"),
      localHeaderOffset,
      name,
      uncompressedSize,
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }

  return { bytes, entries };
}

function findEndOfCentralDirectory(bytes) {
  const minimum = Math.max(0, bytes.length - 22 - 0xffff);
  for (let offset = bytes.length - 22; offset >= minimum; offset -= 1) {
    if (bytes.readUInt32LE(offset) === 0x06054b50) {
      return offset;
    }
  }
  throw new Error("missing ZIP end-of-central-directory record");
}

function readZipEntryBytes(bytes, entry) {
  const offset = entry.localHeaderOffset;
  if (bytes.readUInt32LE(offset) !== 0x04034b50) {
    throw new Error(`invalid local header at offset ${offset}`);
  }
  const nameLength = bytes.readUInt16LE(offset + 26);
  const extraLength = bytes.readUInt16LE(offset + 28);
  const dataStart = offset + 30 + nameLength + extraLength;
  const compressed = bytes.subarray(dataStart, dataStart + entry.compressedSize);

  if (entry.compressionMethod === 0) {
    return compressed;
  }
  if (entry.compressionMethod === 8) {
    return zlib.inflateRawSync(compressed, { finishFlush: zlib.constants.Z_SYNC_FLUSH });
  }
  throw new Error(`unsupported ZIP compression method ${entry.compressionMethod}`);
}

function asciiIncludes(bytes, needle) {
  return bytes.toString("latin1").toLowerCase().includes(needle);
}
