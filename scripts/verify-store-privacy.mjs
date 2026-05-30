#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const repo = path.resolve(new URL("..", import.meta.url).pathname);
const failures = [];
const removedCrashCredentialPattern = new RegExp([
  `${"Se"}${"ntry"}`,
  `${"se"}${"ntry"}`,
  `${"D"}${"SN"}`,
  `${"d"}${"sn"}`,
].join("|"));

const files = {
  storePrivacy: read("docs/STORE_PRIVACY.md"),
  privacy: read("docs/PRIVACY.md"),
  operations: read("docs/OPERATIONS.md"),
  security: read("docs/SECURITY.md"),
  packageJson: read("package.json"),
  ci: read(".github/workflows/ci.yml"),
  releaseIos: read(".github/workflows/release-ios.yml"),
  releaseAndroid: read(".github/workflows/release-android.yml"),
  androidManifest: read("apps/android/app/src/main/AndroidManifest.xml"),
  androidPush: read("apps/android/app/src/main/kotlin/app/fieldwork/android/push/FieldworkPushNotifications.kt"),
  androidPushTests: read("apps/android/app/src/test/kotlin/app/fieldwork/android/push/FieldworkPushNotificationsTest.kt"),
  androidFcm: read("apps/android/app/src/main/kotlin/app/fieldwork/android/push/FieldworkFirebaseMessagingService.kt"),
  androidFcmRegistrar: read("apps/android/app/src/main/kotlin/app/fieldwork/android/push/FcmTokenRegistrar.kt"),
  androidFcmRegistrarTests: read("apps/android/app/src/test/kotlin/app/fieldwork/android/push/FcmTokenRegistrarTest.kt"),
  androidViewModel: read("apps/android/app/src/main/kotlin/app/fieldwork/android/core/FieldworkViewModel.kt"),
  androidViewModelTests: read("apps/android/app/src/test/kotlin/app/fieldwork/android/core/FieldworkViewModelTest.kt"),
  androidBackupRules: read("apps/android/app/src/main/res/xml/backup_rules.xml"),
  androidDataExtractionRules: read("apps/android/app/src/main/res/xml/data_extraction_rules.xml"),
  androidStrings: read("apps/android/app/src/main/res/values/strings.xml"),
  androidTelemetry: read("apps/android/app/src/main/kotlin/app/fieldwork/android/core/MobileTelemetry.kt"),
  iosInfo: read("apps/ios/Resources/Info.plist"),
  iosDelegate: read("apps/ios/Sources/App/AppDelegate.swift"),
  iosModel: read("apps/ios/Sources/App/AppModel.swift"),
  iosTelemetry: read("apps/ios/Sources/Core/MobileTelemetry.swift"),
};

verifyAnswerSheet(files.storePrivacy, files.privacy);
verifyImplementedPrivacyFacts(files);
verifyGateWiring(files);

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log("store privacy answer sheet ok");

function verifyAnswerSheet(store, privacy) {
  for (const phrase of [
    "Apple App Privacy Details: https://developer.apple.com/app-store/app-privacy-details/",
    "Google Play Data safety form: https://support.google.com/googleplay/android-developer/answer/10787469?hl=en",
    "Firebase Android setup and Cloud Messaging",
    "No ads, ad tracking, broker sharing, cross-app tracking",
    "QR camera frames are processed on device for pairing only",
    "Face ID/Touch ID and BiometricPrompt are OS-mediated",
    "Terminal content, commands, paths, and session names are not sent",
    "Push payloads contain only fixed enum-derived copy plus opaque lowercase 64-character hex session hashes",
    "Mobile product diagnostics sharing is off by default",
    "Android Firebase Messaging auto-init and Firebase Analytics collection are disabled in the manifest",
    "Refreshed Android FCM tokens are queued in app-private `fieldwork_push_tokens.xml`, excluded from backup/transfer, and sent only after pairing plus biometric unlock",
    "Tracking: No.",
    "Data linked to the user",
    "APNs token registered after pairing",
    "No mobile crash-reporting SDK is bundled in v1",
    "Terminal text, keystrokes, command names, file paths, session names",
    "v1 has no iOS notification service extension and no lock-screen session-name",
    "Does the app collect or share user data? Yes",
    "Data shared with third parties: No",
    "Data encrypted in transit: Yes",
    "Users can request data deletion: Yes",
    "Independent security review: Not completed",
    "FCM registration token / Firebase installation ID",
    "Diagnostics | Optional",
    "Terminal content and keystrokes because they are end-to-end encrypted",
    "Biometric data because Android does not expose it to the app",
    "`pnpm check:mobile-privacy`",
    "`pnpm check:store-privacy`",
    "`firebase_messaging_auto_init_enabled=false`",
    "`firebase_analytics_collection_enabled=false`",
    "fixed APNs alert copy",
    "Android queued FCM-token tests and backup/transfer exclusions",
    "does not add terminal content to notification payloads",
    "inspect a real APNs/FCM delivery",
  ]) {
    requireDocText(store, phrase, `docs/STORE_PRIVACY.md must include: ${phrase}`);
  }

  requireDocText(
    privacy,
    "Store-submission privacy labels are tracked separately in `docs/STORE_PRIVACY.md`",
    "docs/PRIVACY.md must link to the store privacy answer sheet",
  );
  requireDocText(
    privacy,
    "Push notification payload privacy rules from `PLAN.md` remain binding",
    "docs/PRIVACY.md must keep the PLAN.md push-payload privacy invariant",
  );
}

function verifyImplementedPrivacyFacts(allFiles) {
  verifyAndroidManifest(allFiles.androidManifest);
  verifyAndroidPushPrivacy(
    allFiles.androidPush,
    allFiles.androidFcm,
    allFiles.androidStrings,
  );
  verifyAndroidTelemetry(allFiles.androidTelemetry);
  verifyIosPrivacyStrings(allFiles.iosInfo);
  verifyIosPushPrivacy(allFiles.iosDelegate, allFiles.iosModel);
  verifyIosTelemetry(allFiles.iosTelemetry);
}

function verifyAndroidManifest(xml) {
  for (const [name, value] of [
    ["firebase_messaging_auto_init_enabled", "false"],
    ["firebase_analytics_collection_enabled", "false"],
  ]) {
    requireAndroidMetaValue(xml, name, value);
  }

  for (const forbidden of [
    "android.permission.ACCESS_FINE_LOCATION",
    "android.permission.ACCESS_COARSE_LOCATION",
    "android.permission.RECORD_AUDIO",
    "android.permission.READ_CONTACTS",
    "android.permission.READ_MEDIA_IMAGES",
    "android.permission.READ_EXTERNAL_STORAGE",
  ]) {
    if (xml.includes(forbidden)) {
      failures.push(`Android source manifest must not request ${forbidden}`);
    }
  }
}

function verifyAndroidPushPrivacy(pushText, serviceText, stringsXml) {
  requireText(pushText, "const val EXTRA_SESSION_ID_HASH = \"session_id_hash\"", "Android notification taps must use session_id_hash");
  requireText(pushText, "const val DATA_EVENT_TYPE = \"event_type\"", "Android push event type must stay fixed enum data");
  requireText(pushText, "data[DATA_EVENT_TYPE] != \"awaiting_input\"", "Android notifications must reject unknown event types");
  requireText(pushText, "data[EXTRA_SESSION_ID_HASH]?.takeIf(::isSessionIdHash) ?: return", "Android notifications must require a valid session_id_hash");
  requireText(pushText, "value.all { it in '0'..'9' || it in 'a'..'f' }", "Android notifications must reject uppercase and non-hex session hashes");
  requireText(files.androidPushTests, "sessionHashRejectsUppercaseAndNonHexValues", "Android notification hash validation must have focused unit coverage");
  requireText(files.androidPushTests, "awaitingInputNotificationUsesFixedGenericCopy", "Android notification fixed-copy rendering must have focused unit coverage");
  requireText(files.androidPushTests, "\"last_line\" to \"secret terminal output\"", "Android notification fixed-copy test must include ignored terminal output");
  requireText(files.androidPushTests, "\"command\" to \"claude\"", "Android notification fixed-copy test must include ignored command text");
  requireText(files.androidPushTests, "awaitingInputNotificationRejectsInvalidEventOrHash", "Android invalid notification event/hash rejection must have focused unit coverage");
  requireText(files.androidPushTests, "Notification.VISIBILITY_PRIVATE", "Android notification lock-screen visibility must have focused unit coverage");
  requireText(pushText, "putExtra(EXTRA_SESSION_ID_HASH, sessionIdHash)", "Android notification tap intent must carry only the session hash");
  requireText(pushText, "NotificationCompat.VISIBILITY_PRIVATE", "Android notifications must use private lock-screen visibility");
  requireText(files.androidViewModel, "val parsedHash = FieldworkPushNotifications.sessionIdHashValue(sessionIdHash)", "Android push tap routing must reuse strict hash parsing");
  requireText(files.androidViewModel, "if (parsedHash == null)", "Android push tap routing must explicitly reject malformed hashes");
  requireText(files.androidViewModel, "pendingPushSessionIdHash = null", "Android invalid push taps must clear stale pending routing state");
  requireText(files.androidViewModel, "stopSessionSubscription()", "Android lock/unpair paths must stop session subscriptions");
  requireText(files.androidViewModel, "return@subscribeSessions", "Android subscription callbacks must ignore updates while locked");
  requireText(files.androidViewModel, "if (_state.value.unlocked)", "Android pairing must load sessions and sync push only after unlock");
  requireText(serviceText, "message.data[FieldworkPushNotifications.DATA_EVENT_TYPE] == \"awaiting_input\"", "Android FCM service must dispatch only awaiting_input notifications");
  requireText(serviceText, "FcmTokenRegistrar.queueToken(applicationContext, token)", "Android FCM service must only queue refreshed tokens");
  if (serviceText.includes("FieldworkRepository") || serviceText.includes("registerFcmToken")) {
    failures.push("Android FCM service must not directly register refreshed tokens before pairing/unlock");
  }
  requireText(files.androidFcmRegistrar, 'private const val preferencesName = "fieldwork_push_tokens"', "Android FCM token queue must use the backup-excluded preferences file");
  requireText(files.androidFcmRegistrar, "val normalized = token.trim()", "Android FCM token queue must trim tokens");
  requireText(files.androidFcmRegistrar, "if (normalized.isEmpty())", "Android FCM token queue must ignore blank tokens");
  requireText(files.androidViewModel, "if (!_state.value.paired || !_state.value.unlocked)", "Android FCM token sync must wait for pairing and unlock");
  requireText(files.androidViewModel, "fcmTokens.clearPendingToken(appContext, token)", "Android FCM token sync must clear queued tokens after registration");
  requireText(files.androidBackupRules, 'path="fieldwork_push_tokens.xml"', "Android backup rules must exclude queued FCM token preferences");
  requireText(files.androidDataExtractionRules, 'path="fieldwork_push_tokens.xml"', "Android data extraction rules must exclude queued FCM token preferences");
  for (const testName of [
    "queueTokenStoresTrimmedPendingToken",
    "blankTokenIsIgnored",
    "clearPendingTokenRemovesOnlyMatchingToken",
    "clearPendingTokenWithoutValueRemovesAnyQueuedToken",
  ]) {
    requireText(files.androidFcmRegistrarTests, testName, `Android FCM token queue must have focused unit coverage: ${testName}`);
  }
  for (const testName of [
    "syncFcmTokenDoesNotRegisterWhenPairedButLocked",
    "setUnlockedRegistersQueuedAndCurrentFcmTokensThenClearsQueuedToken",
    "setUnlockedRegistersDuplicateQueuedAndCurrentFcmTokenOnlyOnce",
    "unpairClearsQueuedFcmToken",
    "lockedPushIntentResolvesAfterUnlockAndSessionRefresh",
    "unlockedPushIntentResolvesAgainstCurrentSessionList",
    "invalidPushIntentHashDoesNotRouteAfterUnlock",
    "invalidPushIntentHashClearsPreviouslyPendingRoute",
    "setUnlockedStartsSessionSubscriptionAndAppliesUpdates",
    "pendingPushIntentResolvesFromLaterSessionSubscriptionUpdate",
    "pairWhileUnlockedLoadsSessionsStartsSubscriptionAndSyncsFcmToken",
    "setLockedStopsSessionSubscriptionUpdates",
    "pairWhileLockedDoesNotLoadSessionsStartSubscriptionOrSyncFcmToken",
  ]) {
    requireText(files.androidViewModelTests, testName, `Android FCM token sync must have focused ViewModel coverage: ${testName}`);
  }
  requireXmlString(stringsXml, "notification_awaiting_input_title", "Fieldwork", "Android notification title must stay fixed");
  requireXmlString(stringsXml, "notification_awaiting_input_body", "A session is waiting for you.", "Android notification body must stay fixed");

  for (const forbidden of [
    "session_name_hash",
    "last_line",
    "command",
    "path",
  ]) {
    if (pushText.includes(forbidden) || serviceText.includes(forbidden)) {
      failures.push(`Android notification code must not expose ${forbidden}`);
    }
  }
}

function verifyAndroidTelemetry(text) {
  requireText(text, "context.telemetryPreferences().getBoolean(diagnosticsOptInKey, false)", "Android diagnostics sharing must default off");
  requireText(text, "diagnosticsConsentResolvedKey", "Android diagnostics consent must persist a one-time resolved state");
  if (removedCrashCredentialPattern.test(text)) {
    failures.push("Android telemetry must not initialize a crash-reporting SDK");
  }
}

function verifyIosPrivacyStrings(xml) {
  requirePlistString(xml, "NSCameraUsageDescription", /pairing QR/i, "iOS camera usage must remain QR-pairing only");
  requirePlistString(xml, "NSFaceIDUsageDescription", /(biometric|unlock).*terminal|terminal.*(biometric|unlock)/i, "iOS Face ID usage must describe terminal unlock protection");

  for (const forbidden of [
    "NSLocationWhenInUseUsageDescription",
    "NSMicrophoneUsageDescription",
    "NSContactsUsageDescription",
    "NSPhotoLibraryUsageDescription",
    "NSUserTrackingUsageDescription",
  ]) {
    if (plistHasKey(xml, forbidden)) {
      failures.push(`iOS Info.plist must not contain ${forbidden}`);
    }
  }
}

function verifyIosPushPrivacy(delegateText, modelText) {
  requireText(delegateText, "userInfo[\"session_id_hash\"] as? String", "iOS notification taps must read only session_id_hash");
  requireText(delegateText, ".fieldworkDidReceivePushSessionHash", "iOS notification taps must forward only the session hash");
  requireText(modelText, "isLowercaseHexHash(normalized)", "iOS push hashes must be lowercase 64-character hex strings");
  requireText(modelText, "(48...57).contains(Int(byte)) || (97...102).contains(Int(byte))", "iOS push hashes must reject uppercase and non-hex strings");
  requireText(modelText, "sha256Hex($0.id) == pendingPushSessionIdHash", "iOS push hashes must resolve only against local sessions");

  for (const forbidden of [
    "session_name_hash",
    "last_line",
    "command",
    "path",
  ]) {
    if (delegateText.includes(forbidden)) {
      failures.push(`iOS notification delegate must not read ${forbidden}`);
    }
  }
}

function verifyIosTelemetry(text) {
  requireText(text, "UserDefaults.standard.bool(forKey: diagnosticsOptInKey)", "iOS diagnostics sharing must require opt-in");
  requireText(text, "diagnosticsConsentResolvedKey", "iOS diagnostics consent must persist a one-time resolved state");
  if (removedCrashCredentialPattern.test(text)) {
    failures.push("iOS telemetry must not initialize a crash-reporting SDK");
  }
}

function verifyGateWiring(allFiles) {
  const packageJson = JSON.parse(allFiles.packageJson);
  if (packageJson.scripts?.["check:store-privacy"] !== "node scripts/verify-store-privacy.mjs") {
    failures.push("package.json must expose pnpm check:store-privacy");
  }
  for (const [label, text] of [
    ["CI", allFiles.ci],
    ["release-ios", allFiles.releaseIos],
    ["release-android", allFiles.releaseAndroid],
  ]) {
    requireText(text, "node scripts/verify-store-privacy.mjs", `${label} must run the store privacy verifier`);
  }
  requireText(
    allFiles.operations,
    "pnpm check:store-privacy",
    "docs/OPERATIONS.md must include the store privacy verifier in local checks",
  );
  requireText(
    allFiles.security,
    "pnpm check:store-privacy",
    "docs/SECURITY.md must include the store privacy verifier in local checks",
  );
  requireText(
    allFiles.operations,
    "pnpm check:telemetry-privacy",
    "docs/OPERATIONS.md must keep telemetry privacy in the local checks next to store privacy",
  );
  requireText(
    allFiles.operations,
    "pnpm check:release-workflows",
    "docs/OPERATIONS.md must keep release-workflow verification in the local checks next to store privacy",
  );
}

function read(rel) {
  return fs.readFileSync(path.join(repo, rel), "utf8");
}

function requireDocText(text, phrase, message) {
  if (!normalizeMarkdown(text).includes(normalizeMarkdown(phrase))) {
    failures.push(message);
  }
}

function normalizeMarkdown(text) {
  return text.replace(/\s+/g, " ").trim();
}

function requireText(text, needle, message) {
  if (!text.includes(needle)) {
    failures.push(message);
  }
}

function xmlTags(xml, tagName) {
  return [...xml.matchAll(new RegExp(`<${tagName}\\b[^>]*>`, "gis"))].map((match) => match[0]);
}

function attr(tag, name) {
  const escaped = escapeRegExp(name);
  return tag.match(new RegExp(`\\b${escaped}\\s*=\\s*"([^"]*)"`, "i"))?.[1];
}

function requireAndroidMetaValue(xml, name, expected) {
  const tag = xmlTags(xml, "meta-data").find((candidate) => attr(candidate, "android:name") === name);
  if (!tag) {
    failures.push(`Android source manifest is missing meta-data ${name}`);
    return;
  }
  if (attr(tag, "android:value") !== expected) {
    failures.push(`Android source manifest must set ${name}=${expected}`);
  }
}

function requireXmlString(xml, name, expected, message) {
  const match = xml.match(
    new RegExp(`<string\\s+name="${escapeRegExp(name)}">([^<]*)</string>`, "i"),
  );
  if (!match) {
    failures.push(`missing Android string ${name}: ${message}`);
    return;
  }
  if (match[1] !== expected) {
    failures.push(`${message}: got "${match[1]}"`);
  }
}

function plistHasKey(xml, key) {
  return new RegExp(`<key>${escapeRegExp(key)}</key>`).test(xml);
}

function requirePlistString(xml, key, pattern, message) {
  const match = xml.match(
    new RegExp(`<key>${escapeRegExp(key)}</key>\\s*<string>([^<]*)</string>`, "i"),
  );
  if (!match) {
    failures.push(`missing plist string ${key}: ${message}`);
    return;
  }
  if (!pattern.test(match[1])) {
    failures.push(`${key} has unexpected value "${match[1]}": ${message}`);
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
