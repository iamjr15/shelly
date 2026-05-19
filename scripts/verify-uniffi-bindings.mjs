#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const failures = [];

const files = {
  cargo: read("crates/mobile-core/Cargo.toml"),
  rust: read("crates/mobile-core/src/lib.rs"),
  androidBuildScript: read("apps/android/scripts/build-rust.sh"),
  androidGradle: read("apps/android/app/build.gradle.kts"),
  androidKotlin: read("apps/android/generated/uniffi/fieldwork_mobile_core/fieldwork_mobile_core.kt"),
  iosBuildScript: read("apps/ios/scripts/build-rust.sh"),
  iosProject: read("apps/ios/Fieldwork.xcodeproj/project.pbxproj"),
  ci: read(".github/workflows/ci.yml"),
  packageJson: read("package.json"),
};

verifyMobileCoreCrate(files);
verifyAndroidGeneratedBinding(files.androidKotlin);
verifyBuildWiring(files);

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log("uniffi binding contract ok");

function verifyMobileCoreCrate({ cargo, rust }) {
  for (const expected of [
    'crate-type = ["lib", "cdylib", "staticlib"]',
    'uniffi = { workspace = true, features = ["cli"] }',
    'uniffi = { workspace = true, features = ["build"] }',
    'name = "uniffi-bindgen"',
    'path = "uniffi-bindgen.rs"',
  ]) {
    requireText(cargo, expected, `mobile-core Cargo.toml must include ${expected}`);
  }

  for (const expected of [
    "#![deny(missing_docs)]",
    "pub struct ClientConfig",
    "pub enum MobilePlatform",
    "pub enum PushPlatform",
    "pub enum AgentStateFfi",
    "pub struct DaemonInfo",
    "pub struct DaemonConfig",
    "pub struct SessionSummaryFfi",
    "pub enum FieldworkError",
    "pub trait SessionListSink",
    "pub trait ByteStreamSink",
    "pub struct FieldworkClient",
    "pub struct AttachedSession",
    "pub async fn pair_with_qr",
    "pub async fn connect",
    "pub async fn list_sessions",
    "pub async fn subscribe_sessions",
    "pub async fn attach_session(",
    "pub async fn attach_session_from",
    "pub async fn register_push_token",
    "pub async fn send_input",
    "pub async fn resize",
    "pub async fn detach",
    "uniffi::setup_scaffolding!();",
  ]) {
    requireText(rust, expected, `mobile-core Rust surface must include ${expected}`);
  }

  for (const forbidden of [
    /\bpub\s+(?:async\s+)?fn\s+(?:create|new|start|kill|terminate)_session\b/,
    /\bpub\s+(?:async\s+)?fn\s+(?:run|spawn|exec|set)_command\b/,
  ]) {
    rejectPattern(rust, forbidden, `mobile-core Rust surface must not expose ${forbidden}`);
  }
}

function verifyAndroidGeneratedBinding(kotlin) {
  for (const expected of [
    "public interface FieldworkClientInterface",
    "open class FieldworkClient",
    "data class ClientConfig",
    "enum class MobilePlatform",
    "enum class PushPlatform",
    "enum class AgentStateFfi",
    "data class DaemonInfo",
    "data class DaemonConfig",
    "data class SessionSummaryFfi",
    "public interface ByteStreamSink",
    "public interface SessionListSink",
    "open class AttachedSession",
    "suspend fun `pairWithQr`(`qrPayload`: kotlin.String): DaemonInfo",
    "suspend fun `connect`()",
    "suspend fun `listSessions`(): List<SessionSummaryFfi>",
    "suspend fun `subscribeSessions`(`sink`: SessionListSink)",
    "suspend fun `attachSession`(`id`: kotlin.String): AttachedSession",
    "suspend fun `attachSessionFrom`(`id`: kotlin.String, `lastSeenSeq`: kotlin.ULong?): AttachedSession",
    "suspend fun `registerPushToken`(`platform`: PushPlatform, `token`: kotlin.String)",
    "fun `initialSeq`(): kotlin.ULong",
    "fun `lastSeenSeq`(): kotlin.ULong",
    "suspend fun `resize`(`cols`: kotlin.UShort, `rows`: kotlin.UShort)",
    "suspend fun `sendInput`(`bytes`: kotlin.ByteArray)",
    "suspend fun `subscribe`(`sink`: ByteStreamSink)",
    "suspend fun `detach`()",
    "fun `onInitialBytes`(`bytes`: kotlin.ByteArray)",
    "fun `onOutput`(`bytes`: kotlin.ByteArray)",
    "fun `onLag`(`skippedBytes`: kotlin.ULong)",
  ]) {
    requireText(kotlin, expected, `generated Kotlin binding must include ${expected}`);
  }

  for (const forbidden of [
    /suspend fun `(?:create|new|start|kill|terminate)Session`\b/,
    /suspend fun `(?:run|spawn|exec|set)Command`\b/,
    /data class CreateSession\b/,
    /data class KillSession\b/,
  ]) {
    rejectPattern(kotlin, forbidden, `generated Kotlin binding must not expose ${forbidden}`);
  }
}

function verifyBuildWiring({
  androidBuildScript,
  androidGradle,
  iosBuildScript,
  iosProject,
  ci,
  packageJson,
}) {
  for (const expected of [
    "cargo ndk",
    "-t arm64-v8a",
    "-t armeabi-v7a",
    "-t x86_64",
    'build -p fieldwork-mobile-core --release',
    'cargo run -p fieldwork-mobile-core --bin uniffi-bindgen -- generate',
    '--language kotlin',
    '--out-dir "$out_dir"',
    "aarch64-linux-android/release/libfieldwork_mobile_core.so",
  ]) {
    requireText(androidBuildScript, expected, `Android Rust build script must include ${expected}`);
  }

  requireText(androidGradle, 'kotlin.srcDir("../generated")', "Android Gradle source set must compile generated UniFFI Kotlin");

  for (const expected of [
    "scripts/check-ios-prereqs.sh",
    "aarch64-apple-ios",
    "aarch64-apple-ios-sim",
    "x86_64-apple-ios",
    'cargo run -p fieldwork-mobile-core --bin uniffi-bindgen -- generate',
    '--language swift',
    'xcodebuild -create-xcframework',
    'FieldworkCore.xcframework',
    'fieldwork_mobile_coreFFI.h',
  ]) {
    requireText(iosBuildScript, expected, `iOS Rust build script must include ${expected}`);
  }

  for (const expected of [
    "fieldwork_mobile_core.swift in Sources",
    "FieldworkCore.xcframework in Frameworks",
    "GeneratedRust/fieldwork_mobile_core.swift",
    "GeneratedRust/FieldworkCore.xcframework",
    '${SRCROOT}/scripts/build-rust.sh',
    'if [ \\"${FIELDWORK_SKIP_RUST_BUILD:-}\\" != \\"1\\" ]; then',
  ]) {
    requireText(iosProject, expected, `iOS Xcode project must include ${expected}`);
  }

  requireText(ci, "apps/android/scripts/build-rust.sh", "CI must generate Android UniFFI bindings before Kotlin compile");
  requireText(ci, "node scripts/verify-uniffi-bindings.mjs", "CI must run the UniFFI binding verifier");

  const pkg = JSON.parse(packageJson);
  if (pkg.scripts?.["check:uniffi-bindings"] !== "node scripts/verify-uniffi-bindings.mjs") {
    failures.push("package.json must expose pnpm check:uniffi-bindings");
  }
}

function read(relativePath) {
  const fullPath = path.join(root, relativePath);
  try {
    return fs.readFileSync(fullPath, "utf8");
  } catch (error) {
    failures.push(`missing required file ${relativePath}: ${error.message}`);
    return "";
  }
}

function requireText(text, needle, message) {
  if (!text.includes(needle)) {
    failures.push(message);
  }
}

function rejectPattern(text, pattern, message) {
  if (pattern.test(text)) {
    failures.push(message);
  }
}
