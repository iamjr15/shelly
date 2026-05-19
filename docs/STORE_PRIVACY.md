# Store Privacy Answer Sheet

This is the working answer sheet for App Store Connect privacy labels and Google Play Data safety. It reflects the implemented v1 mobile behavior and should be rechecked immediately before submission against the built app, enabled SDKs, and published privacy policy.

Sources:

- Apple App Privacy Details: https://developer.apple.com/app-store/app-privacy-details/
- Google Play Data safety form: https://support.google.com/googleplay/android-developer/answer/10787469?hl=en
- Firebase Android setup and Cloud Messaging: https://firebase.google.com/docs/android/setup and https://firebase.google.com/docs/cloud-messaging/android/get-started

## Shared Facts

- No ads, ad tracking, broker sharing, cross-app tracking, account system, billing, contacts import, location permission, microphone permission, photo-library permission, clipboard telemetry, or webview browsing.
- QR camera frames are processed on device for pairing only.
- Face ID/Touch ID and BiometricPrompt are OS-mediated. Fieldwork never receives or stores biometric material.
- Terminal content, commands, paths, and session names are not sent to Fieldwork-operated analytics or push providers. Live terminal bytes travel only between the user's paired devices over encrypted iroh connections.
- Push payloads contain only fixed enum-derived copy plus opaque lowercase 64-character hex session hashes. The app rejects malformed hashes and fetches actual terminal content from the paired daemon after unlock.
- Mobile crash reporting is off by default and starts only after the user opts in through Settings or the delayed one-time consent prompt, and only when the release build contains a Sentry DSN.
- Android Firebase Messaging auto-init and Firebase Analytics collection are disabled in the manifest. FCM token generation is enabled only after pairing, biometric unlock, and only when `google-services.json` is present. Refreshed Android FCM tokens are queued in app-private `fieldwork_push_tokens.xml`, excluded from backup/transfer, and sent only after pairing plus biometric unlock.

## App Store Connect

Tracking: No.

Data linked to the user:

| Data type | Collection | Purpose | Notes |
| --- | --- | --- | --- |
| Identifiers: Device ID | Yes | App Functionality | APNs token registered after pairing so the daemon/relay can address generic push notifications. Not used for tracking or advertising. |
| Diagnostics: Crash Data | Optional | App Functionality | Sentry crash reporting only after explicit opt-in. `sendDefaultPii=false`; no terminal content is intentionally attached. |
| Diagnostics: Performance Data | Optional | App Functionality | Sentry SDK diagnostic context only after explicit opt-in; trace sampling is disabled. |

Data not collected by Fieldwork for App Store label purposes:

- Terminal text, keystrokes, command names, file paths, session names, QR camera images, biometric data, contacts, location, purchases, browsing history, search history, photos/videos, audio, health/fitness, financial info, and advertising data.

Submission notes:

- If relay infrastructure starts retaining IP addresses beyond short security/routing logs, update the label before submission using Apple's IP-address guidance.
- v1 has no iOS notification service extension and no lock-screen session-name
  setting. Re-audit the label before shipping any future build that changes
  notification copy or lock-screen behavior.

## Google Play Data Safety

Does the app collect or share user data? Yes, because FCM push tokens / Firebase installation identifiers and opt-in crash diagnostics can be transmitted off device.

Data shared with third parties: No, assuming APNs/FCM/Sentry are documented as service providers processing data for Fieldwork under the published privacy policy and applicable agreements. If that legal posture changes, mark the relevant rows as shared.

Security practices:

- Data encrypted in transit: Yes.
- Users can request data deletion: Yes, through device revocation/unpairing for app-held pairing data and the published support/privacy contact for relay-side push-token removal.
- Independent security review: Not completed for v1 unless a MASA review is obtained before launch.

Data types:

| Category | Type | Collected | Shared | Purpose | Required |
| --- | --- | --- | --- | --- | --- |
| Device or other IDs | FCM registration token / Firebase installation ID | Yes | No | App functionality | Required for Android push after pairing; core attach/list/input workflows still work without push delivery. |
| App info and performance | Crash logs | Optional | No | App functionality | Optional; collected only after explicit crash-reporting opt-in. |
| App info and performance | Diagnostics | Optional | No | App functionality | Optional; limited to Sentry diagnostic context with default PII disabled and trace sampling off. |

Not declared as collected:

- Terminal content and keystrokes because they are end-to-end encrypted between user-controlled endpoints and are unreadable to Fieldwork infrastructure.
- QR camera frames because they are processed only on device.
- Biometric data because Android does not expose it to the app.
- Location, contacts, messages, files/docs, photos/videos, audio, calendar, web browsing history, installed apps, purchases, financial info, health/fitness, and personal info.

Pre-submission checks:

- Run `pnpm check:store-privacy` before every mobile release candidate. It
  verifies this answer sheet still declares the same App Store/Play data facts
  enforced by the mobile manifests, native notification handlers, and Sentry
  settings.
- Run `pnpm check:mobile-privacy` before every mobile release candidate. It
  verifies the Android permission/default-collection surface, iOS privacy usage
  strings, APNs entitlement build settings, biometric-only gates, and mobile
  pairing-storage encryption/backup exclusions. It also guards fixed generic
  notification copy, lowercase `session_id_hash`-only native tap routing, locked
  app root surfaces, unlock-gated session/push activation, generated iOS
  mobile-core linkage, the Android queued FCM-token tests and backup/transfer
  exclusions, and the iOS no-stub-build guard.
- Confirm the production Android manifest still has `firebase_messaging_auto_init_enabled=false`, `firebase_analytics_collection_enabled=false`, and `io.sentry.auto-init=false`.
- Confirm the built iOS app still uses fixed APNs alert copy and does not add terminal content to notification payloads.
- Confirm Sentry release settings do not enable session replay, screenshots, user interaction tracing, or default PII.
- Run the relay push-payload privacy test and inspect a real APNs/FCM delivery before checking the Section 13 privacy gates.
