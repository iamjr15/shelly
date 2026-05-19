#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const repo = path.resolve(new URL("..", import.meta.url).pathname);
const failures = [];

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
  relayMain: read("crates/relay/src/main.rs"),
  relayLib: read("crates/relay/src/lib.rs"),
  relayTelemetry: read("crates/relay/src/telemetry.rs"),
  relayOtlpSmoke: read("scripts/smoke-relay-otlp-loopback.mjs"),
  relayService: read("infra/relay/ansible/templates/fieldwork-control-plane.service.j2"),
  cargoToml: read("Cargo.toml"),
};

requirePattern(
  files.daemonConfig,
  /opt_in\s*&&\s*self\s*\.\s*sentry_dsn/,
  "daemon Sentry must require explicit telemetry opt-in plus a configured DSN",
);
requirePattern(
  files.daemonLogging,
  /send_default_pii:\s*false/,
  "daemon Sentry must disable default PII",
);
requirePattern(
  files.daemonLogging,
  /traces_sample_rate:\s*0\.0/,
  "daemon Sentry must keep trace sampling disabled",
);
rejectPattern(
  files.daemonLogging,
  /opentelemetry|FIELDWORK_RELAY_OTLP|Honeycomb/i,
  "daemon logging must not wire OTLP/Honeycomb export in v1",
);

requirePattern(
  files.iosTelemetry,
  /#if\s+canImport\(Sentry\)/,
  "iOS telemetry must remain parseable when Sentry is unavailable in local static checks",
);
requirePattern(
  files.iosTelemetry,
  /UserDefaults\.standard\.bool\(forKey:\s*crashReportsOptInKey\)/,
  "iOS Sentry must require the crash-report opt-in toggle",
);
requirePattern(
  files.iosTelemetry,
  /!dsn\.contains\("\$\(\"\)/,
  "iOS Sentry must ignore unresolved build-setting placeholders",
);
requirePattern(files.iosTelemetry, /SentrySDK\.close\(\)/, "iOS Sentry must close when opt-out is active");
requirePattern(files.iosTelemetry, /options\.sendDefaultPii\s*=\s*false/, "iOS Sentry must disable default PII");
requirePattern(files.iosTelemetry, /options\.tracesSampleRate\s*=\s*0\.0/, "iOS Sentry must disable tracing");
requirePattern(
  files.iosTelemetry,
  /options\.enableAutoPerformanceTracing\s*=\s*false/,
  "iOS Sentry must disable automatic performance tracing",
);
requirePattern(
  files.iosTelemetry,
  /crashReportsConsentResolvedKey/,
  "iOS telemetry consent prompt must persist a one-time resolved state",
);
requirePattern(
  files.iosTelemetry,
  /shouldShowConsentPrompt\(\)/,
  "iOS telemetry must expose delayed consent prompt gating",
);
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
  /getBoolean\(crashReportsKey,\s*false\)/,
  "Android Sentry must default crash reporting to opt-out",
);
requirePattern(files.androidTelemetry, /Sentry\.close\(\)/, "Android Sentry must close when opt-out is active");
requirePattern(
  files.androidTelemetry,
  /SentryAndroid\.init\(context\.applicationContext\)/,
  "Android Sentry must initialize only through the explicit telemetry sync path",
);
requirePattern(
  files.androidTelemetry,
  /options\.setSendDefaultPii\(false\)/,
  "Android Sentry must disable default PII",
);
requirePattern(
  files.androidTelemetry,
  /options\.setTracesSampleRate\(0\.0\)/,
  "Android Sentry must disable tracing",
);
requirePattern(
  files.androidTelemetry,
  /options\.setEnableAutoActivityLifecycleTracing\(false\)/,
  "Android Sentry must disable automatic activity tracing",
);
requirePattern(
  files.androidTelemetry,
  /options\.setEnableUserInteractionTracing\(false\)/,
  "Android Sentry must disable user interaction tracing",
);
requirePattern(
  files.androidTelemetry,
  /crashReportsConsentResolvedKey/,
  "Android telemetry consent prompt must persist a one-time resolved state",
);
requirePattern(
  files.androidTelemetry,
  /shouldShowConsentPrompt\(context: Context\)/,
  "Android telemetry must expose delayed consent prompt gating",
);
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

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log("telemetry privacy wiring ok");

function read(rel) {
  return fs.readFileSync(path.join(repo, rel), "utf8");
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
