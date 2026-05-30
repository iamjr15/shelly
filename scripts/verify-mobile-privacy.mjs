#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const repo = path.resolve(new URL("..", import.meta.url).pathname);
const failures = [];

const androidSourceManifest = read("apps/android/app/src/main/AndroidManifest.xml");
const androidMainActivity = read("apps/android/app/src/main/kotlin/app/fieldwork/android/MainActivity.kt");
const androidRoot = read("apps/android/app/src/main/kotlin/app/fieldwork/android/ui/FieldworkApp.kt");
const androidViewModel = read("apps/android/app/src/main/kotlin/app/fieldwork/android/core/FieldworkViewModel.kt");
const androidRepository = read("apps/android/app/src/main/kotlin/app/fieldwork/android/core/FieldworkRepository.kt");
const androidTerminalController = read("apps/android/app/src/main/kotlin/app/fieldwork/android/core/TerminalController.kt");
const androidViewModelTest = read("apps/android/app/src/test/kotlin/app/fieldwork/android/core/FieldworkViewModelTest.kt");
const androidFcmRegistrar = read("apps/android/app/src/main/kotlin/app/fieldwork/android/push/FcmTokenRegistrar.kt");
const androidFcmRegistrarTest = read("apps/android/app/src/test/kotlin/app/fieldwork/android/push/FcmTokenRegistrarTest.kt");
const androidSessions = read("apps/android/app/src/main/kotlin/app/fieldwork/android/features/sessions/SessionsScreen.kt");
const androidTerminal = read("apps/android/app/src/main/kotlin/app/fieldwork/android/features/terminal/TerminalScreen.kt");
const androidSettings = read("apps/android/app/src/main/kotlin/app/fieldwork/android/features/settings/SettingsScreen.kt");
const mobileCore = read("crates/mobile-core/src/lib.rs");
verifyAndroidSourceManifest(androidSourceManifest);
verifyAndroidJniContextInstaller(mobileCore);
verifyAndroidBiometricGate(
  read("apps/android/app/src/main/kotlin/app/fieldwork/android/core/AndroidBiometricGate.kt"),
  read("apps/android/app/src/test/kotlin/app/fieldwork/android/core/AndroidBiometricGateTest.kt"),
  read("apps/android/app/build.gradle.kts"),
);
verifyAndroidLockSurface(androidRoot, androidViewModel, androidSessions, androidTerminal);
verifyNoLockScreenSessionNameToggle(androidSettings, "Android settings");
verifyAndroidPairingStore(read("apps/android/app/src/main/kotlin/app/fieldwork/android/core/PairingStore.kt"));
verifyAndroidBackupRules(read("apps/android/app/src/main/res/xml/backup_rules.xml"));
verifyAndroidDataExtractionRules(read("apps/android/app/src/main/res/xml/data_extraction_rules.xml"));
verifyAndroidLifecycleViewModel(androidMainActivity);
verifyAndroidStartupRestore(androidViewModel, androidRepository, androidViewModelTest);
verifyAndroidTerminalRawByteDelivery(
  androidTerminalController,
  androidRepository,
  androidViewModel,
  androidViewModelTest,
);
verifyAndroidPushPrivacy(
  read("apps/android/app/src/main/kotlin/app/fieldwork/android/push/FieldworkPushNotifications.kt"),
  read("apps/android/app/src/main/kotlin/app/fieldwork/android/push/FieldworkFirebaseMessagingService.kt"),
  androidFcmRegistrar,
  androidViewModel,
  read("apps/android/app/src/main/res/values/strings.xml"),
  read("apps/android/app/src/test/kotlin/app/fieldwork/android/push/FieldworkPushNotificationsTest.kt"),
  androidFcmRegistrarTest,
);

for (const rel of [
  "apps/android/app/build/intermediates/merged_manifests/debug/processDebugManifest/AndroidManifest.xml",
  "apps/android/app/build/intermediates/merged_manifests/release/processReleaseManifest/AndroidManifest.xml",
]) {
  if (fs.existsSync(path.join(repo, rel))) {
    verifyAndroidMergedManifest(read(rel), rel);
  }
}

const iosRoot = read("apps/ios/Sources/App/FieldworkApp.swift");
const iosAppModel = read("apps/ios/Sources/App/AppModel.swift");
const iosPairing = read("apps/ios/Sources/Features/Pairing/PairingView.swift");
const iosSettings = read("apps/ios/Sources/Features/Settings/SettingsView.swift");
const iosService = read("apps/ios/Sources/Core/FieldworkService.swift");
const iosTerminalController = read("apps/ios/Sources/Core/TerminalSessionController.swift");
const iosSwiftTermView = read("apps/ios/Sources/Features/Terminal/SwiftTermView.swift");
const iosProject = read("apps/ios/Fieldwork.xcodeproj/project.pbxproj");
verifyIosBuildScript(read("apps/ios/scripts/build-rust.sh"));
verifyIosInfoPlist(read("apps/ios/Resources/Info.plist"));
verifyIosEntitlements(read("apps/ios/Resources/Fieldwork.entitlements"));
verifyIosProject(
  iosProject,
  read("apps/ios/Sources/Core/FieldworkCoreStubs.swift"),
  read(".github/workflows/release-ios.yml"),
);
verifyIosPackageResolution(
  iosProject,
  read("apps/ios/Fieldwork.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved"),
);
verifyIosSecurityGate(read("apps/ios/Sources/Core/SecurityGate.swift"));
verifyIosLockSurface(iosRoot, iosAppModel, iosTerminalController);
verifyIosCameraPairingPermission(iosPairing);
verifyIosTerminalRawByteDelivery(iosTerminalController);
verifyIosTerminalReconnect(iosService, iosTerminalController);
verifyIosSwiftTermRenderer(iosSwiftTermView);
verifyNoLockScreenSessionNameToggle(iosSettings, "iOS settings");
verifyIosKeychainStore(read("apps/ios/Sources/Core/KeychainStore.swift"));
verifyIosPushPrivacy(
  read("apps/ios/Sources/App/AppDelegate.swift"),
  iosAppModel,
);

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log("mobile privacy defaults ok");

function verifyAndroidSourceManifest(xml) {
  const permissions = new Set(permissionNames(xml));
  const expected = new Set([
    "android.permission.INTERNET",
    "android.permission.CAMERA",
    "android.permission.POST_NOTIFICATIONS",
    "android.permission.USE_BIOMETRIC",
  ]);
  assertSetEquals(
    permissions,
    expected,
    "apps/android/app/src/main/AndroidManifest.xml source permissions",
  );

  requireAndroidMetaFalse(xml, "firebase_messaging_auto_init_enabled");
  requireAndroidMetaFalse(xml, "firebase_analytics_collection_enabled");
  requireAndroidApplicationAttr(xml, "android:allowBackup", "false");
  requireAndroidApplicationAttr(xml, "android:dataExtractionRules", "@xml/data_extraction_rules");
  requireAndroidApplicationAttr(xml, "android:fullBackupContent", "@xml/backup_rules");
  requireAndroidServiceExportedFalse(xml, ".push.FieldworkFirebaseMessagingService");
}

function verifyAndroidJniContextInstaller(text) {
  const start = text.indexOf('#[cfg(target_os = "android")]');
  const end = text.indexOf("impl From<MobilePlatform> for ClientKind", start);
  if (start < 0 || end < 0) {
    failures.push("mobile-core must keep a target_os=android JNI context installer block");
    return;
  }

  const block = text.slice(start, end);
  requireText(
    block,
    "OnceLock<Result<(), String>>",
    "Android JNI context installer must cache initialization as a Result, not poison/panic a Once",
  );
  requireText(
    block,
    "throw_java_runtime_exception",
    "Android JNI context installer must surface initialization failures to Java",
  );
  requireText(
    block,
    "env.throw(message)",
    "Android JNI context installer must throw a Java exception for native initialization failures",
  );
  requireText(
    block,
    "Outcome::Err(error) => Err(error.to_string())",
    "Android JNI context installer must convert JNI errors without panicking",
  );
  requireText(
    block,
    'Outcome::Panic(_) => Err("panic while installing Android JNI context".to_string())',
    "Android JNI context installer must catch Rust panics before returning to the JVM",
  );

  if (/panic!\s*\(|resume_unwind|unwrap\(\)|expect\(/.test(block)) {
    failures.push("Android JNI context installer must not panic, unwrap, expect, or resume_unwind across JNI");
  }
}

function verifyAndroidBiometricGate(text, testText, gradleText) {
  if (!/BiometricManager\.Authenticators\.BIOMETRIC_STRONG/.test(text)) {
    failures.push("Android biometric gate must require BIOMETRIC_STRONG");
  }
  requireText(
    text,
    "BuildConfig.DEBUG && BuildConfig.FIELDWORK_BIOMETRIC_BYPASS",
    "Android biometric bypass must be debug-build-only",
  );
  requireText(
    gradleText,
    'System.getenv("FIELDWORK_ANDROID_BIOMETRIC_BYPASS") == "true"',
    "Android biometric bypass must require an explicit debug-smoke environment variable",
  );
  requireText(
    gradleText,
    "FIELDWORK_ANDROID_PAIRING_CODE",
    "Android debug pairing prefill must require an explicit emulator-smoke environment variable",
  );
  requireText(
    gradleText,
    'buildConfigField("String", "FIELDWORK_DEBUG_PAIRING_CODE", "\\"\\"")',
    "Android default config must keep debug pairing code empty",
  );
  const releaseBuildType = sliceBetween(gradleText, 'getByName("release") {', "if (keystorePropertiesFile.exists())");
  requireText(
    releaseBuildType,
    'buildConfigField("boolean", "FIELDWORK_BIOMETRIC_BYPASS", "false")',
    "Android release builds must force the biometric bypass off",
  );
  requireText(
    releaseBuildType,
    'buildConfigField("String", "FIELDWORK_DEBUG_PAIRING_CODE", "\\"\\"")',
    "Android release builds must force the debug pairing code empty",
  );
  if (/BiometricManager\.Authenticators\.DEVICE_CREDENTIAL/.test(text)) {
    failures.push("Android biometric gate must not allow device credential fallback");
  }
  if (!/\.setNegativeButtonText\("Cancel"\)/.test(text)) {
    failures.push("Android biometric-only prompt must keep an explicit Cancel button");
  }
  requireText(
    text,
    "lastUnlockMillis != 0L && nowMillis() - lastUnlockMillis < FRESH_MILLIS",
    "Android biometric freshness must treat the zero unlock timestamp as locked",
  );
  requireText(
    text,
    "!isFreshNow() ||",
    "Android resume lock decision must lock stale unlocks",
  );
  requireText(
    text,
    "backgroundedMillis != 0L && nowMillis() - backgroundedMillis >= FRESH_MILLIS",
    "Android resume lock decision must apply the 5-minute background window",
  );
  requireText(
    testText,
    "debugBiometricBypassDefaultsOffForUnitTests",
    "Android debug biometric bypass must default off in unit tests",
  );
  requireText(
    testText,
    "resumeRequiresLockBeforeFirstUnlock",
    "Android biometric freshness must have unit coverage before first unlock",
  );
  requireText(
    testText,
    "successfulUnlockMakesImmediateResumeFresh",
    "Android biometric freshness must have unit coverage after successful unlock",
  );
  requireText(
    testText,
    "freshBackgroundResumeDoesNotLock",
    "Android biometric freshness must have unit coverage for fresh foreground resumes",
  );
  requireText(
    testText,
    "staleBackgroundResumeLocksAtFiveMinutes",
    "Android biometric freshness must have unit coverage for stale foreground resumes",
  );
}

function verifyNoLockScreenSessionNameToggle(text, label) {
  if (/Show session name on lock screen|showSessionName|showSessionNameOnLockScreen/.test(text)) {
    failures.push(`${label} must not expose a lock-screen session-name toggle in v1`);
  }
}

function verifyAndroidLockSurface(rootText, viewModelText, sessionsText, terminalText) {
  if (!/if\s*\(state\.unlocked\)\s*\{[\s\S]*Scaffold[\s\S]*\}\s*else\s*\{\s*LockedOverlay/.test(rootText)) {
    failures.push("Android root must render only the locked surface while unauthenticated");
  }
  requireText(
    rootText,
    "MaterialTheme(colorScheme = FieldworkColorScheme)",
    "Android root must use an explicit color scheme so the locked surface does not depend on system dark-mode defaults",
  );
  requireText(
    rootText,
    "ButtonDefaults.buttonColors(",
    "Android locked-surface unlock button must pin readable container/content colors",
  );
  requireText(
    rootText,
    "containerColor = MaterialTheme.colorScheme.primary",
    "Android locked-surface unlock button must use the explicit primary container color",
  );
  requireText(
    rootText,
    "contentColor = MaterialTheme.colorScheme.onPrimary",
    "Android locked-surface unlock button must use the explicit on-primary content color",
  );
  requireText(
    viewModelText,
    "if (unlocked && !wasUnlocked && _state.value.paired)",
    "Android session fetch/subscription/push sync must activate only after successful unlock",
  );
  requireText(
    rootText,
    "if (state.paired && state.unlocked)",
    "Android notification permission prompt must wait for pairing plus successful unlock",
  );
  requireText(
    sessionsText,
    'biometricGate.unlock("Open terminal session")',
    "Android terminal open must pass through BiometricPrompt",
  );
  requireText(
    terminalText,
    'biometricGate.unlock("Send terminal input")',
    "Android terminal input must pass through BiometricPrompt",
  );
}

function verifyAndroidPairingStore(text) {
  if (!/EncryptedSharedPreferences\.create\(/.test(text)) {
    failures.push("Android pairing store must use EncryptedSharedPreferences");
  }
  if (!/MasterKey\.KeyScheme\.AES256_GCM/.test(text)) {
    failures.push("Android pairing store must use an AES256_GCM MasterKey");
  }
  if (!/PrefKeyEncryptionScheme\.AES256_SIV/.test(text)) {
    failures.push("Android pairing store must encrypt preference keys");
  }
  if (!/PrefValueEncryptionScheme\.AES256_GCM/.test(text)) {
    failures.push("Android pairing store must encrypt preference values");
  }
}

function verifyAndroidBackupRules(xml) {
  requireXmlFragment(
    xml,
    /<exclude\b[^>]*domain="sharedpref"[^>]*path="fieldwork_pairing\.xml"[^>]*\/>/,
    "Android full-backup rules must exclude encrypted pairing preferences",
  );
  requireXmlFragment(
    xml,
    /<exclude\b[^>]*domain="sharedpref"[^>]*path="fieldwork_push_tokens\.xml"[^>]*\/>/,
    "Android full-backup rules must exclude queued FCM token preferences",
  );
}

function verifyAndroidDataExtractionRules(xml) {
  requireXmlFragment(
    xml,
    /<cloud-backup>[\s\S]*<exclude\b[^>]*domain="sharedpref"[^>]*path="fieldwork_pairing\.xml"[^>]*\/>[\s\S]*<\/cloud-backup>/,
    "Android cloud-backup rules must exclude encrypted pairing preferences",
  );
  requireXmlFragment(
    xml,
    /<cloud-backup>[\s\S]*<exclude\b[^>]*domain="sharedpref"[^>]*path="fieldwork_push_tokens\.xml"[^>]*\/>[\s\S]*<\/cloud-backup>/,
    "Android cloud-backup rules must exclude queued FCM token preferences",
  );
  requireXmlFragment(
    xml,
    /<device-transfer>[\s\S]*<exclude\b[^>]*domain="sharedpref"[^>]*path="fieldwork_pairing\.xml"[^>]*\/>[\s\S]*<\/device-transfer>/,
    "Android device-transfer rules must exclude encrypted pairing preferences",
  );
  requireXmlFragment(
    xml,
    /<device-transfer>[\s\S]*<exclude\b[^>]*domain="sharedpref"[^>]*path="fieldwork_push_tokens\.xml"[^>]*\/>[\s\S]*<\/device-transfer>/,
    "Android device-transfer rules must exclude queued FCM token preferences",
  );
}

function verifyAndroidLifecycleViewModel(text) {
  requireText(
    text,
    "androidx.lifecycle.viewmodel.compose.viewModel",
    "Android MainActivity must obtain FieldworkViewModel from the lifecycle ViewModel store",
  );
  requireText(
    text,
    "val viewModel: FieldworkViewModel = viewModel(",
    "Android MainActivity must use the Compose lifecycle ViewModel helper",
  );
  requireText(
    text,
    "fieldworkViewModelFactory(applicationContext)",
    "Android MainActivity must construct FieldworkViewModel through an application-context factory",
  );
  rejectText(
    text,
    "remember { FieldworkViewModel(applicationContext) }",
    "Android MainActivity must not manually remember a ViewModel inside Compose",
  );
}

function verifyAndroidStartupRestore(viewModelText, repositoryText, testText) {
  requireText(
    repositoryText,
    "private val store by lazy { PairingStore(appContext) }",
    "Android encrypted pairing store must be lazy so app construction avoids eager keystore work",
  );
  requireText(
    viewModelText,
    "private val restoreDispatcher: CoroutineDispatcher = Dispatchers.IO",
    "Android saved-pairing restore must default to Dispatchers.IO",
  );
  requireText(
    viewModelText,
    "withContext(restoreDispatcher)",
    "Android saved-pairing restore must leave the main dispatcher",
  );
  requireText(
    viewModelText,
    "restoreJob = viewModelScope.launch",
    "Android saved-pairing restore must run asynchronously from ViewModel construction",
  );
  requireText(
    viewModelText,
    "restoreJob?.cancel()",
    "Android pair/unpair paths must cancel any pending startup restore",
  );
  requireText(
    viewModelText,
    "restoreGeneration += 1",
    "Android pair/unpair paths must invalidate stale startup restore results",
  );
  requireText(
    testText,
    "constructorDoesNotBlockOnSavedPairingRestore",
    "Android ViewModel must have JVM coverage for nonblocking startup pairing restore",
  );
  requireText(
    testText,
    "pairCancelsPendingSavedPairingRestoreResult",
    "Android ViewModel must have JVM coverage that stale startup restore results cannot override pairing",
  );
}

function verifyAndroidTerminalRawByteDelivery(controllerText, repositoryText, viewModelText, testText) {
  requireText(
    controllerText,
    ") : ByteStreamSink {",
    "Android terminal controller must consume the UniFFI raw byte stream directly",
  );
  requireText(
    controllerText,
    "override fun onInitialBytes(bytes: ByteArray)",
    "Android terminal controller must handle initial attach bytes as raw ByteArray",
  );
  requireText(
    controllerText,
    "override fun onOutput(bytes: ByteArray)",
    "Android terminal controller must handle live output bytes as raw ByteArray",
  );
  requireText(
    controllerText,
    "emulator.writeInput(bytes)",
    "Android terminal controller must feed raw ByteArray chunks directly to termlib",
  );
  rejectText(
    controllerText,
    "decodeToString(",
    "Android terminal controller must not decode PTY output before termlib delivery",
  );
  rejectText(
    controllerText,
    "String(bytes",
    "Android terminal controller must not convert PTY output into String before termlib delivery",
  );
  requireText(
    repositoryText,
    "private val lastSeenSeqBySession = mutableMapOf<String, ULong>()",
    "Android repository must cache per-session reconnect offsets",
  );
  requireText(
    repositoryText,
    "requireClient().attachSessionFrom(sessionId, seq)",
    "Android repository must reattach from the cached last_seen_seq when present",
  );
  requireText(
    viewModelText,
    "reattach = { lastSeenSeq ->",
    "Android terminal view model must wire lag reattach through repository offsets",
  );
  requireText(
    viewModelText,
    "withContext(repositoryDispatcher) {\n                    repository.attach(session.id, lastSeenSeq)\n                }",
    "Android terminal view model must perform lag reattach on the repository dispatcher",
  );
  requireText(
    testText,
    "terminalAttachAndLagReattachRunRepositoryWorkOffMainThread",
    "Android ViewModel must have JVM coverage that terminal attach and lag reattach use the repository dispatcher",
  );
  requireText(
    viewModelText,
    "recordLastSeenSeq = { seq -> repository.recordLastSeenSeq(session.id, seq) }",
    "Android terminal view model must persist observed terminal offsets",
  );
  requireText(
    controllerText,
    "override fun onLag(skippedBytes: ULong)",
    "Android terminal controller must handle daemon Lag events",
  );
  requireText(
    controllerText,
    "val lastSeenSeq = attachedSession.lastSeenSeq()",
    "Android lag handling must read the latest mobile-core offset before reattaching",
  );
  requireText(
    controllerText,
    "attachedSession = reattach(lastSeenSeq)",
    "Android lag handling must reattach from the last seen offset",
  );
  requireText(
    controllerText,
    "launchSubscribe(cancelExisting = false)",
    "Android lag handling must restart byte-stream subscription after reattach",
  );
  requireText(
    controllerText,
    "recoverAttachment(\"Reconnecting\")",
    "Android terminal controller must recover attached-stream errors through the reattach path",
  );
  requireText(
    controllerText,
    "if (error is CancellationException)",
    "Android stream-error recovery must preserve coroutine cancellation",
  );
  requireText(
    controllerText,
    "attachedSession.destroy()",
    "Android reattach recovery must destroy broken attachments before replacing them",
  );
}

function verifyAndroidPushPrivacy(pushText, serviceText, registrarText, viewModelText, stringsXml, testText, registrarTestText) {
  requireText(pushText, "const val EXTRA_SESSION_ID_HASH = \"session_id_hash\"", "Android notification tap must expose only the session id hash extra");
  requireText(pushText, "const val DATA_EVENT_TYPE = \"event_type\"", "Android FCM handler must treat event_type as payload data, not a tap extra");
  requireText(pushText, "putExtra(EXTRA_SESSION_ID_HASH, sessionIdHash)", "Android notification tap must carry session_id_hash");
  if (/session_name_hash/.test(pushText)) {
    failures.push("Android notification tap code must not read or forward session_name_hash");
  }
  if (/putExtra\([^)]*event_type|putExtra\([^)]*DATA_EVENT_TYPE/.test(pushText)) {
    failures.push("Android notification tap intent must not carry event_type");
  }
  requireText(pushText, "data[DATA_EVENT_TYPE] != \"awaiting_input\"", "Android notification rendering must reject non-awaiting_input events");
  requireText(pushText, "data[EXTRA_SESSION_ID_HASH]?.takeIf(::isSessionIdHash) ?: return", "Android notification rendering must require a valid session_id_hash");
  requireText(pushText, "value.all { it in '0'..'9' || it in 'a'..'f' }", "Android notification hash validation must reject uppercase and non-hex session hashes");
  requireText(pushText, "?.trim() ?: return null", "Android notification tap handling must trim but not lowercase session hashes");
  requireText(pushText, "internal fun sessionIdHashValue(value: String?): String?", "Android notification tap hash parser must be unit-testable without Android Intent");
  requireText(viewModelText, "val parsedHash = FieldworkPushNotifications.sessionIdHashValue(sessionIdHash)", "Android push tap routing must use the strict lowercase session hash parser");
  requireText(viewModelText, "if (parsedHash == null)", "Android push tap routing must explicitly reject malformed hashes");
  requireText(viewModelText, "pendingPushSessionIdHash = null", "Android invalid push taps must clear stale pending routing state");
  requireText(viewModelText, "pendingPushSessionIdHash = parsedHash", "Android valid push taps must store only parsed lowercase session hashes");
  rejectText(viewModelText, ".lowercase()", "Android push tap routing must not lowercase untrusted notification hashes");
  requireText(testText, "sessionHashRejectsUppercaseAndNonHexValues", "Android notification hash validation must have focused unit coverage");
  requireText(testText, "tapSessionHashParserTrimsButDoesNotLowercase", "Android notification tap parser must have focused unit coverage");
  requireText(testText, "assertFalse(FieldworkPushNotifications.isSessionIdHash(\"A\".repeat(64)))", "Android hash unit test must reject uppercase hashes");
  requireText(testText, "assertFalse(FieldworkPushNotifications.isSessionIdHash(\"g\".repeat(64)))", "Android hash unit test must reject non-hex hashes");
  requireText(testText, "assertNull(FieldworkPushNotifications.sessionIdHashValue(\"  ${\"A\".repeat(64)}  \"))", "Android tap parser test must reject uppercase hashes after trimming");
  for (const testName of [
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
    requireText(androidViewModelTest, testName, `Android push tap routing must have ViewModel unit coverage: ${testName}`);
  }
  requireText(pushText, "setContentTitle(context.getString(R.string.notification_awaiting_input_title))", "Android notification title must be fixed resource text");
  requireText(pushText, "setContentText(context.getString(R.string.notification_awaiting_input_body))", "Android notification body must be fixed resource text");
  requireText(pushText, "NotificationCompat.VISIBILITY_PRIVATE", "Android notification must use private lock-screen visibility");
  requireText(serviceText, "message.data[FieldworkPushNotifications.DATA_EVENT_TYPE] == \"awaiting_input\"", "Android FCM service must dispatch only fixed awaiting_input events");
  requireText(serviceText, "FcmTokenRegistrar.queueToken(applicationContext, token)", "Android FCM token refresh callbacks must queue tokens locally");
  rejectText(serviceText, "FieldworkRepository", "Android FCM service must not directly depend on the repository");
  rejectText(serviceText, "registerFcmToken", "Android FCM service must not register tokens before app unlock");
  requireText(registrarText, 'private const val preferencesName = "fieldwork_push_tokens"', "Android queued FCM token store must use the backup-excluded preferences file");
  requireText(registrarText, 'private const val pendingFcmTokenKey = "pending_fcm_token"', "Android queued FCM token store must use a stable pending-token key");
  requireText(registrarText, "val normalized = token.trim()", "Android queued FCM tokens must be trimmed before storage");
  requireText(registrarText, "if (normalized.isEmpty())", "Android queued FCM token store must ignore blank tokens");
  requireText(registrarText, "fun clearPendingToken(context: Context, token: String)", "Android queued FCM token store must clear only matching registered tokens");
  requireText(viewModelText, "if (!_state.value.paired || !_state.value.unlocked)", "Android FCM token sync must wait for pairing plus unlock");
  requireText(viewModelText, "val pendingToken = fcmTokens.pendingToken(appContext)", "Android FCM token sync must include queued refreshed tokens");
  requireText(viewModelText, "fcmTokens.clearPendingToken(appContext, token)", "Android FCM token sync must clear queued tokens after successful registration");
  requireText(viewModelText, "fcmTokens.clearPendingToken(appContext)", "Android unpair must clear queued FCM tokens");
  requireText(viewModelText, "stopSessionSubscription()", "Android lock/unpair paths must stop session subscriptions");
  requireText(viewModelText, "return@subscribeSessions", "Android session subscription callbacks must ignore updates while locked");
  requireText(viewModelText, "if (_state.value.unlocked)", "Android pairing must load sessions and sync push only after unlock");
  for (const testName of [
    "syncFcmTokenDoesNotRegisterWhenPairedButLocked",
    "setUnlockedRegistersQueuedAndCurrentFcmTokensThenClearsQueuedToken",
    "setUnlockedRegistersDuplicateQueuedAndCurrentFcmTokenOnlyOnce",
    "unpairClearsQueuedFcmToken",
  ]) {
    requireText(androidViewModelTest, testName, `Android FCM token sync must have ViewModel unit coverage: ${testName}`);
  }
  for (const testName of [
    "queueTokenStoresTrimmedPendingToken",
    "blankTokenIsIgnored",
    "clearPendingTokenRemovesOnlyMatchingToken",
    "clearPendingTokenWithoutValueRemovesAnyQueuedToken",
  ]) {
    requireText(registrarTestText, testName, `Android queued FCM token store must have focused unit coverage: ${testName}`);
  }
  requirePlistStringLikeXml(stringsXml, "notification_awaiting_input_title", /^Fieldwork$/, "Android notification title must stay fixed and generic");
  requirePlistStringLikeXml(stringsXml, "notification_awaiting_input_body", /^A session is waiting for you\.$/, "Android notification body must stay fixed and generic");
}

function verifyAndroidMergedManifest(xml, rel) {
  const allowed = new Set([
    "android.permission.INTERNET",
    "android.permission.CAMERA",
    "android.permission.POST_NOTIFICATIONS",
    "android.permission.USE_BIOMETRIC",
    "android.permission.USE_FINGERPRINT",
    "android.permission.ACCESS_NETWORK_STATE",
    "android.permission.WAKE_LOCK",
    "com.google.android.c2dm.permission.RECEIVE",
    "app.fieldwork.android.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION",
  ]);

  const permissions = new Set(permissionNames(xml));
  for (const permission of permissions) {
    if (!allowed.has(permission)) {
      failures.push(`${rel} contains unexpected permission: ${permission}`);
    }
  }

  requireAndroidMetaFalse(xml, "firebase_messaging_auto_init_enabled", rel);
  requireAndroidMetaFalse(xml, "firebase_analytics_collection_enabled", rel);
  requireAndroidServiceExportedFalse(xml, ".push.FieldworkFirebaseMessagingService", rel);
}

function verifyIosInfoPlist(xml) {
  requirePlistString(
    xml,
    "NSCameraUsageDescription",
    /pairing QR/i,
    "iOS camera usage string must be limited to QR pairing",
  );
  requirePlistString(
    xml,
    "NSFaceIDUsageDescription",
    /(biometric|unlock).*terminal|terminal.*(biometric|unlock)/i,
    "iOS Face ID usage string must describe terminal unlock protection",
  );
  for (const key of [
    "NSLocationWhenInUseUsageDescription",
    "NSMicrophoneUsageDescription",
    "NSContactsUsageDescription",
    "NSPhotoLibraryUsageDescription",
    "NSUserTrackingUsageDescription",
  ]) {
    if (plistHasKey(xml, key)) {
      failures.push(`apps/ios/Resources/Info.plist contains forbidden privacy key: ${key}`);
    }
  }
}

function verifyIosEntitlements(xml) {
  requirePlistString(
    xml,
    "aps-environment",
    /^\$\(APS_ENVIRONMENT\)$/,
    "iOS APNs entitlement must come from APS_ENVIRONMENT build setting",
  );
}

function verifyIosBuildScript(text) {
  requireText(
    text,
    "scripts/check-ios-prereqs.sh",
    "iOS Rust build script must run the prereq checker before invoking Cargo/Xcode",
  );
  requireText(
    text,
    "FIELDWORK_IOS_RELEASE_XCODE_MAJOR",
    "iOS Rust build script must detect release-runner prereq mode",
  );
  requireText(
    text,
    "FIELDWORK_SKIP_IOS_PREREQ_CHECK",
    "iOS Rust build script must keep an explicit CI/debug escape hatch for prereq-only tests",
  );
}

function verifyIosProject(text, stubsText, releaseWorkflowText) {
  verifyIosStubBuildGuard(text, stubsText, releaseWorkflowText);
  requireText(
    text,
    "01000000000000000000010E /* fieldwork_mobile_core.swift in Sources */",
    "iOS target must compile generated UniFFI Swift bindings",
  );
  requireText(
    text,
    "01000000000000000000010F /* FieldworkCore.xcframework in Frameworks */",
    "iOS target must link the generated Rust xcframework",
  );
  requireText(
    text,
    "scripts/build-rust.sh",
    "iOS target must run the Rust mobile-core build script before compilation",
  );
  requireText(
    text,
    "\"$(SRCROOT)/GeneratedRust/fieldwork_mobile_core.swift\"",
    "iOS build phase must declare generated Swift bindings as an output",
  );
  requireText(
    text,
    "\"$(SRCROOT)/GeneratedRust/FieldworkCore.xcframework\"",
    "iOS build phase must declare generated xcframework as an output",
  );

  for (const [configuration, value] of [
    ["Debug", "development"],
    ["Release", "production"],
  ]) {
    const block = targetBuildConfigurationBlock(text, configuration);
    if (!block) {
      failures.push(`apps/ios/Fieldwork.xcodeproj/project.pbxproj is missing ${configuration} build settings`);
      continue;
    }
    if (!new RegExp(`\\bAPS_ENVIRONMENT\\s*=\\s*${value};`).test(block)) {
      failures.push(`${configuration} build settings must set APS_ENVIRONMENT = ${value}`);
    }
  }
}

function verifyIosPackageResolution(projectText, resolvedText) {
  const expectedDirectPackages = [
    {
      label: "SwiftTerm",
      identity: "swiftterm",
      url: "https://github.com/migueldeicaza/SwiftTerm",
      version: "1.13.0",
      revision: "8e7a1e154f470e19c709a00a8768df348ba5fc43",
    },
  ];

  for (const dependency of expectedDirectPackages) {
    const referencePattern = new RegExp(
      `repositoryURL = "${escapeRegExp(dependency.url)}";[\\s\\S]*?requirement = \\{[\\s\\S]*?kind = exactVersion;[\\s\\S]*?version = ${escapeRegExp(dependency.version)};`,
    );
    if (!referencePattern.test(projectText)) {
      failures.push(`iOS Xcode project must pin ${dependency.label} to exact version ${dependency.version}`);
    }
  }

  let resolved;
  try {
    resolved = JSON.parse(resolvedText);
  } catch (error) {
    failures.push(`iOS Package.resolved must be valid JSON: ${error.message}`);
    return;
  }

  if (resolved.version !== 3) {
    failures.push("iOS Package.resolved must use SwiftPM lockfile version 3");
  }
  if (!Array.isArray(resolved.pins)) {
    failures.push("iOS Package.resolved must contain a pins array");
    return;
  }

  const expectedIdentities = new Set([
    "hdrhistogram-swift",
    "package-benchmark",
    "package-jemalloc",
    "swift-argument-parser",
    "swift-atomics",
    "swift-docc-plugin",
    "swift-docc-symbolkit",
    "swift-numerics",
    "swift-system",
    "swiftterm",
    "texttable",
  ]);
  const pinsByIdentity = new Map();
  for (const pin of resolved.pins) {
    if (typeof pin.identity === "string") {
      pinsByIdentity.set(pin.identity, pin);
    }
  }
  assertSetEquals(new Set(pinsByIdentity.keys()), expectedIdentities, "iOS Package.resolved pins");

  for (const dependency of expectedDirectPackages) {
    const pin = pinsByIdentity.get(dependency.identity);
    if (!pin) {
      continue;
    }
    if (pin.location !== dependency.url) {
      failures.push(`iOS Package.resolved ${dependency.label} location must be ${dependency.url}`);
    }
    if (pin.state?.version !== dependency.version) {
      failures.push(`iOS Package.resolved ${dependency.label} version must be ${dependency.version}`);
    }
    if (pin.state?.revision !== dependency.revision) {
      failures.push(`iOS Package.resolved ${dependency.label} revision must be ${dependency.revision}`);
    }
  }
}

function verifyIosStubBuildGuard(projectText, stubsText, releaseWorkflowText) {
  if (!stubsText.trimStart().startsWith("#if FIELDWORK_STUBS")) {
    failures.push("iOS FieldworkCoreStubs.swift must be compiled only under FIELDWORK_STUBS");
  }
  if (!stubsText.trimEnd().endsWith("#endif")) {
    failures.push("iOS FieldworkCoreStubs.swift guard must cover the entire file");
  }
  if (!/FieldworkClient[\s\S]*fieldwork stub terminal/.test(stubsText)) {
    failures.push("iOS FieldworkCoreStubs.swift must remain recognizable as a stub-only shim");
  }
  for (const configuration of ["Debug", "Release"]) {
    const block = targetBuildConfigurationBlock(projectText, configuration);
    if (block && /\bFIELDWORK_STUBS\b/.test(block)) {
      failures.push(`${configuration} build settings must not enable FIELDWORK_STUBS`);
    }
  }
  if (/\bFIELDWORK_STUBS\b/.test(releaseWorkflowText)) {
    failures.push("release-ios workflow must not enable FIELDWORK_STUBS");
  }
}

function verifyIosSecurityGate(text) {
  if (!/\.deviceOwnerAuthenticationWithBiometrics\b/.test(text)) {
    failures.push("iOS SecurityGate must use biometric-only LocalAuthentication");
  }
  if (/\.deviceOwnerAuthentication\b/.test(text)) {
    failures.push("iOS SecurityGate must not allow passcode fallback for terminal unlock");
  }
}

function verifyIosLockSurface(rootText, modelText, terminalText) {
  if (!/if\s+model\.isUnlocked\s*\{[\s\S]*TabView[\s\S]*\}\s*else\s*\{\s*LockedOverlay/.test(rootText)) {
    failures.push("iOS root must render only the locked surface while unauthenticated");
  }
  const bootstrapStart = modelText.indexOf("func bootstrap() async");
  const unlockStart = modelText.indexOf("@discardableResult", bootstrapStart);
  const bootstrapBlock = bootstrapStart >= 0 && unlockStart > bootstrapStart
    ? modelText.slice(bootstrapStart, unlockStart)
    : "";
  if (!bootstrapBlock) {
    failures.push("iOS AppModel must keep an auditable bootstrap method");
  }
  if (/refreshSessions|startSessionSubscription|requestPushTokenRegistration/.test(bootstrapBlock)) {
    failures.push("iOS bootstrap must not fetch sessions or request APNs before biometric unlock succeeds");
  }
  requireText(
    modelText,
    "if isUnlocked, isPaired, (!wasUnlocked || sessions.isEmpty || pendingPushSessionIdHash != nil)",
    "iOS paired session services must activate only after successful biometric unlock",
  );
  requireText(
    modelText,
    "private func activatePairedSessionServices() async",
    "iOS paired session service activation must stay centralized for privacy review",
  );
  requireText(
    terminalText,
    'securityGate.unlockIfNeeded(reason: "Send terminal input")',
    "iOS terminal input must pass through LocalAuthentication",
  );
}

function verifyIosCameraPairingPermission(text) {
  requireText(
    text,
    "AVCaptureDevice.authorizationStatus(for: .video)",
    "iOS QR pairing scanner must explicitly check camera authorization state",
  );
  requireText(
    text,
    "AVCaptureDevice.requestAccess(for: .video)",
    "iOS QR pairing scanner must request camera access before capture setup",
  );
  requireText(
    text,
    "Camera access is required for QR pairing",
    "iOS QR pairing scanner must show fixed, pairing-only denial copy",
  );
  requireText(
    text,
    "wantsSessionRunning",
    "iOS QR pairing scanner must start capture only after the view is visible and authorized",
  );
}

function verifyIosTerminalRawByteDelivery(text) {
  requireText(
    text,
    "@Published private(set) var outputRevision: UInt64",
    "iOS terminal controller must publish raw-output revisions for non-text PTY bytes",
  );
  requireText(
    text,
    "pendingChunks.append(bytes)",
    "iOS terminal controller must buffer raw PTY Data chunks for SwiftTerm",
  );
  requireText(
    text,
    "outputRevision &+= 1",
    "iOS terminal controller must notify SwiftUI whenever raw PTY bytes arrive",
  );
  const appendStart = text.indexOf("private func append(_ bytes: Data)");
  const fallbackStart = text.indexOf("if let text = String(data: bytes, encoding: .utf8)", appendStart);
  const revisionStart = text.indexOf("outputRevision &+= 1", appendStart);
  if (appendStart < 0 || fallbackStart < 0 || revisionStart < 0 || revisionStart > fallbackStart) {
    failures.push("iOS outputRevision must be incremented before optional UTF-8 fallback decoding");
  }
}

function verifyIosTerminalReconnect(serviceText, controllerText) {
  requireText(
    serviceText,
    "private var lastSeenSeqBySession: [String: UInt64] = [:]",
    "iOS service must cache per-session reconnect offsets",
  );
  requireText(
    serviceText,
    "let initialSeq = lastSeenSeqBySession[session.id]",
    "iOS attach must start from the cached lastSeenSeq when present",
  );
  requireText(
    serviceText,
    "client.attachSessionFrom(id: session.id, lastSeenSeq: initialSeq)",
    "iOS initial attach must pass cached lastSeenSeq into mobile-core",
  );
  requireText(
    serviceText,
    "attachFromSeq: { lastSeenSeq in",
    "iOS terminal controller must receive an attachFromSeq reconnect closure",
  );
  requireText(
    serviceText,
    "client.attachSessionFrom(id: session.id, lastSeenSeq: lastSeenSeq)",
    "iOS lag reattach closure must pass the latest lastSeenSeq into mobile-core",
  );
  requireText(
    serviceText,
    "self?.lastSeenSeqBySession[session.id] = seq",
    "iOS terminal controller must persist observed terminal offsets",
  );
  requireText(
    controllerText,
    "fileprivate func markLag(_ skippedBytes: UInt64)",
    "iOS terminal controller must handle daemon Lag events",
  );
  requireText(
    controllerText,
    "status = \"Resyncing after missing \\(skippedBytes) updates\"",
    "iOS lag handling must show fixed resync status without terminal content",
  );
  requireText(
    controllerText,
    "await resync()",
    "iOS lag handling must start the reconnect path",
  );
  requireText(
    controllerText,
    "let seq = attachedSession.lastSeenSeq()",
    "iOS lag handling must read the latest mobile-core offset before reattaching",
  );
  requireText(
    controllerText,
    "attachedSession = try await attachFromSeq(seq)",
    "iOS lag handling must reattach from the last seen offset",
  );
  requireText(
    controllerText,
    "startSubscription()",
    "iOS lag handling must restart byte-stream subscription after reattach",
  );
}

function verifyIosSwiftTermRenderer(text) {
  const swiftTermStart = text.indexOf("#if canImport(SwiftTerm)");
  const fallbackStart = text.indexOf("#else", swiftTermStart);
  const fallbackRendererStart = text.indexOf("struct TerminalRenderer: View", fallbackStart);
  const endStart = text.indexOf("#endif", fallbackStart);
  if (swiftTermStart < 0 || fallbackStart < 0 || fallbackRendererStart < fallbackStart || endStart < fallbackRendererStart) {
    failures.push("iOS SwiftTerm renderer must keep the text fallback behind #else");
    return;
  }

  requireText(
    text,
    "import SwiftTerm",
    "iOS SwiftTerm renderer must import SwiftTerm in the real renderer branch",
  );
  requireText(
    text,
    "for chunk in controller.drainPendingOutput()",
    "iOS SwiftTerm renderer must drain raw pending Data chunks",
  );
  requireText(
    text,
    "uiView.feed(data: chunk)",
    "iOS SwiftTerm renderer must feed raw Data chunks into the terminal view",
  );
  requireText(
    text,
    "func feed(data: Data)",
    "iOS SwiftTerm view must expose a raw Data feed entry point",
  );
  requireText(
    text,
    "let bytes = [UInt8](data)",
    "iOS SwiftTerm view must convert Data to bytes for SwiftTerm",
  );
  requireText(
    text,
    "feed(byteArray: bytes[0..<bytes.count])",
    "iOS SwiftTerm view must call SwiftTerm's raw byte-array feed",
  );
  requireText(
    text,
    "func send(source: TerminalView, data: ArraySlice<UInt8>)",
    "iOS SwiftTerm view must receive terminal input as raw bytes",
  );
  requireText(
    text,
    "onInput(Data(data))",
    "iOS SwiftTerm input must return raw Data to mobile-core",
  );
  requireText(
    text,
    "controller.resize(cols: UInt16(max(cols, 1)), rows: UInt16(max(rows, 1)))",
    "iOS SwiftTerm resize callback must update the attached PTY viewport",
  );

  const updateBlock = sliceBetween(text, "func updateUIView(_ uiView: FieldworkTerminalView, context: Context)", "final class FieldworkTerminalView");
  rejectText(
    updateBlock,
    "String(",
    "iOS SwiftTerm renderer must not convert PTY output to String before rendering",
  );
  const feedBlock = sliceBetween(text, "func feed(data: Data)", "func scrolled(source: TerminalView, position: Double)");
  rejectText(
    feedBlock,
    "String(data:",
    "iOS SwiftTerm feed path must not decode PTY output before rendering",
  );
}

function verifyIosKeychainStore(text) {
  if (!/kSecAttrAccessibleWhenUnlockedThisDeviceOnly/.test(text)) {
    failures.push("iOS Keychain pairing record must be this-device-only and available only when unlocked");
  }
  if (!/kSecUseDataProtectionKeychain/.test(text)) {
    failures.push("iOS Keychain pairing record must use the data-protection keychain");
  }
  if (/kSecAttrSynchronizable/.test(text)) {
    failures.push("iOS Keychain pairing record must not be synchronizable");
  }
}

function verifyIosPushPrivacy(delegateText, modelText) {
  requireText(delegateText, "userInfo[\"session_id_hash\"] as? String", "iOS notification taps must read session_id_hash only");
  requireText(delegateText, ".fieldworkDidReceivePushSessionHash", "iOS notification taps must forward only the session hash");
  if (/session_name_hash/.test(delegateText)) {
    failures.push("iOS notification delegate must not read or forward session_name_hash");
  }
  requireText(modelText, "isLowercaseHexHash(normalized)", "iOS push deep-link handling must require lowercase 64-character hex hashes");
  requireText(modelText, "value.utf8.count == 64", "iOS push deep-link handling must length-check hash bytes");
  requireText(modelText, "(48...57).contains(Int(byte)) || (97...102).contains(Int(byte))", "iOS push deep-link handling must reject uppercase and non-hex session hashes");
  requireText(modelText, "sha256Hex($0.id) == pendingPushSessionIdHash", "iOS push deep-link handling must resolve hashes against locally fetched sessions");
}

function read(rel) {
  return fs.readFileSync(path.join(repo, rel), "utf8");
}

function xmlTags(xml, tagName) {
  return [...xml.matchAll(new RegExp(`<${tagName}\\b[^>]*>`, "gis"))].map((match) => match[0]);
}

function attr(tag, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return tag.match(new RegExp(`\\b${escaped}\\s*=\\s*"([^"]*)"`, "i"))?.[1];
}

function permissionNames(xml) {
  return xmlTags(xml, "uses-permission")
    .map((tag) => attr(tag, "android:name"))
    .filter(Boolean);
}

function requireXmlFragment(xml, pattern, message) {
  if (!pattern.test(xml)) {
    failures.push(message);
  }
}

function requireText(text, needle, message) {
  if (!text.includes(needle)) {
    failures.push(message);
  }
}

function rejectText(text, needle, message) {
  if (text.includes(needle)) {
    failures.push(message);
  }
}

function sliceBetween(text, startNeedle, endNeedle) {
  const start = text.indexOf(startNeedle);
  if (start < 0) {
    return "";
  }
  const end = text.indexOf(endNeedle, start + startNeedle.length);
  return end > start ? text.slice(start, end) : text.slice(start);
}

function requirePlistStringLikeXml(xml, key, pattern, message) {
  const match = xml.match(
    new RegExp(`<string\\s+name="${escapeRegExp(key)}">([^<]*)</string>`, "i"),
  );
  if (!match) {
    failures.push(`missing string resource ${key}: ${message}`);
    return;
  }
  if (!pattern.test(match[1])) {
    failures.push(`${key} has unexpected value "${match[1]}": ${message}`);
  }
}

function requireAndroidMetaFalse(xml, name, rel = "apps/android/app/src/main/AndroidManifest.xml") {
  const tag = xmlTags(xml, "meta-data").find((candidate) => attr(candidate, "android:name") === name);
  if (!tag) {
    failures.push(`${rel} is missing meta-data ${name}=false`);
    return;
  }
  if (attr(tag, "android:value") !== "false") {
    failures.push(`${rel} must set meta-data ${name}=false`);
  }
}

function requireAndroidApplicationAttr(xml, name, expected) {
  const tag = xmlTags(xml, "application")[0];
  if (!tag) {
    failures.push("apps/android/app/src/main/AndroidManifest.xml is missing <application>");
    return;
  }
  if (attr(tag, name) !== expected) {
    failures.push(`apps/android/app/src/main/AndroidManifest.xml must set ${name}="${expected}"`);
  }
}

function requireAndroidServiceExportedFalse(
  xml,
  serviceName,
  rel = "apps/android/app/src/main/AndroidManifest.xml",
) {
  const tag = xmlTags(xml, "service").find(
    (candidate) => {
      const name = attr(candidate, "android:name");
      return name === serviceName || name?.endsWith(serviceName.replace(/^\./, "."));
    },
  );
  if (!tag) {
    failures.push(`${rel} is missing service ${serviceName}`);
    return;
  }
  if (attr(tag, "android:exported") !== "false") {
    failures.push(`${rel} must set ${serviceName} android:exported="false"`);
  }
}

function assertSetEquals(actual, expected, label) {
  for (const value of expected) {
    if (!actual.has(value)) {
      failures.push(`${label} is missing ${value}`);
    }
  }
  for (const value of actual) {
    if (!expected.has(value)) {
      failures.push(`${label} contains unexpected ${value}`);
    }
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

function targetBuildConfigurationBlock(text, name) {
  const blocks = [
    ...text.matchAll(
      new RegExp(`/\\* ${escapeRegExp(name)} \\*/ = \\{[\\s\\S]*?buildSettings = \\{([\\s\\S]*?)\\n\\s*\\};[\\s\\S]*?name = ${escapeRegExp(name)};`, "gm"),
    ),
  ].map((match) => match[1]);
  return blocks.find((block) =>
    /CODE_SIGN_ENTITLEMENTS\s*=\s*Resources\/Fieldwork\.entitlements;/.test(block),
  ) ?? null;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
