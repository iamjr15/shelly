# Android FCM Push Evidence

This runbook verifies the Android side of the Section 13 provider-push gates
with a signed release build on a physical Android phone. It does not cover APNs
or iOS; those gates remain unchecked until iOS work resumes with Apple provider
credentials and a physical device.

The pass condition is 10/10 delivered `AwaitingInput` FCM notifications, fixed
generic notification copy, inspected FCM HTTP v1 payloads containing only opaque
hashes, and notification tap-through into the correct daemon-owned session.

## Scope

- Use exactly one physical Android phone, not an emulator or AVD.
- Install the signed release App Bundle output or APKs produced from it.
- Use the production relay control plane with relay-held FCM service-account
  JSON. The daemon and Android app must not hold APNs or FCM provider
  credentials.
- Do not use a debug build, biometric bypass, or debug pairing payload.
- Capture evidence with direct `adb`: device listing, notification screenshot,
  UI dumps, app logcat, crash buffer, and desktop PTY replay.

## Evidence Directory

```sh
export FW_ANDROID_FCM_DIR="/tmp/fieldwork-android-fcm-push-$(date +%Y%m%d%H%M%S)"
mkdir -p "$FW_ANDROID_FCM_DIR"
```

## Release Build And Relay

Verify the signed release App Bundle:

```sh
node scripts/verify-android-aab.mjs --expect-signed \
  apps/android/app/build/outputs/bundle/release/app-release.aab \
  | tee "$FW_ANDROID_FCM_DIR/artifact-signing.txt"
```

Capture the release `BuildConfig` values:

```sh
rg 'APPLICATION_ID = "app\.fieldwork\.android"|BUILD_TYPE = "release"|DEBUG = false|DEBUG = Boolean\.parseBoolean\("false"\)|FIELDWORK_BIOMETRIC_BYPASS = false|FIELDWORK_DEBUG_PAIRING_PAYLOAD = ""' \
  apps/android/app/build/generated/source/buildConfig/release/app/fieldwork/android/BuildConfig.java \
  | tee "$FW_ANDROID_FCM_DIR/buildconfig.txt"
```

Confirm the production relay control plane is reachable:

```sh
curl -fsS https://relay.fieldwork.dev:8443/v1/version \
  | tee "$FW_ANDROID_FCM_DIR/relay-version.txt"
```

## Install, Pair, And Register FCM

Capture the physical device list and install the release artifact:

```sh
adb devices -l | tee "$FW_ANDROID_FCM_DIR/adb-devices.txt"
bundletool install-apks --apks /path/to/fieldwork-release.apks
```

Pair the phone with the production-relay-configured daemon through the real QR
scanner and explicit desktop approval. After biometric unlock, confirm the
Android app registers an FCM token with the daemon and relay:

```sh
adb logcat -c
adb logcat -b crash -c
fw devices
adb logcat -d | rg -i 'fcm|registerPushToken|RegisterPushToken|push token' \
  | tee "$FW_ANDROID_FCM_DIR/token-registration.txt"
```

The transcript must identify `fcm` and either `RegisterPushToken`,
`registerPushToken`, `/v1/push/register-token`, or
`push token registration accepted`.

## Inspect Provider Payloads

Trigger 10 Claude Code or Codex `AwaitingInput` state changes against the same
desktop-created session. Capture the relay-side FCM HTTP v1 request bodies sent
to Google in `provider-payloads.json`; redact only the raw FCM token value.

Each payload must have this shape and no extra keys:

```json
{
  "message": {
    "token": "redacted",
    "notification": {
      "title": "Fieldwork",
      "body": "A session is waiting for you."
    },
    "data": {
      "session_id_hash": "lowercase-64-hex",
      "session_name_hash": "lowercase-64-hex",
      "event_type": "awaiting_input"
    },
    "android": {
      "priority": "HIGH",
      "notification": {
        "channel_id": "fieldwork-agent-state",
        "click_action": "FIELDWORK_OPEN_SESSION"
      }
    }
  }
}
```

The verifier rejects `last_line`, command names, file paths, plaintext session
names, terminal content, and extra provider payload keys.

## Delivery And Tap-Through

Record the delivery count:

```sh
{
  printf 'provider=fcm\n'
  printf 'event_type=awaiting_input\n'
  printf 'push_attempts=10\n'
  printf 'push_delivered=10\n'
  seq 1 10 | sed 's/.*/notification_received_&_ok/'
} | tee "$FW_ANDROID_FCM_DIR/delivery.txt"
```

Pull down the Android notification shade and capture the generic notification:

```sh
adb exec-out screencap -p > "$FW_ANDROID_FCM_DIR/notification.png"
adb shell uiautomator dump /sdcard/window.xml
adb pull /sdcard/window.xml "$FW_ANDROID_FCM_DIR/notification-ui.xml"
```

Tap the notification, unlock through BiometricPrompt if required, and confirm it
opens the correct session. Then type `echo notify_tap_ok` from Android and
capture a desktop replay:

```sh
adb shell uiautomator dump /sdcard/window.xml
adb pull /sdcard/window.xml "$FW_ANDROID_FCM_DIR/tap-ui.xml"
script -q "$FW_ANDROID_FCM_DIR/tap-replay.txt" fw attach <target-session-name>
# Confirm session_id_hash=<lowercase-64-hex> and notify_tap_ok are visible, then detach.
```

Capture logs:

```sh
adb logcat -d > "$FW_ANDROID_FCM_DIR/logcat.log"
adb logcat -d -b crash > "$FW_ANDROID_FCM_DIR/crash.log"
```

Verify the evidence:

```sh
pnpm check:android-fcm-push-evidence -- "$FW_ANDROID_FCM_DIR"
```

Passing this verifier only proves the Android/FCM provider path. The broader
push release gates still require APNs evidence, provider payload inspection for
iOS, and lock-screen tap-through on physical devices.
