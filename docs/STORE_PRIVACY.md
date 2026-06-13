# Store Privacy Answer Sheet

This is the current working answer sheet for Google Play Data safety. iOS/App Store submission is deferred, so App Store Connect labels are not part of the active release surface.

Sources:

- Google Play Data safety form: https://support.google.com/googleplay/android-developer/answer/10787469?hl=en
- Firebase Android setup and Cloud Messaging: https://firebase.google.com/docs/android/setup and https://firebase.google.com/docs/cloud-messaging/android/get-started

## Shared Facts

- No ads, ad tracking, broker sharing, cross-app tracking, account system, billing, contacts import, location permission, microphone permission, photo-library permission, clipboard telemetry, or webview browsing.
- QR camera frames are processed on device for pairing only.
- BiometricPrompt is OS-mediated. Shelly never receives or stores biometric material.
- Terminal content, commands, paths, and session names are not sent to Shelly-operated analytics or push providers. Live terminal bytes travel only between the user's paired devices over encrypted iroh connections.
- Push payloads contain only fixed enum-derived copy plus opaque lowercase 64-character hex session hashes. The app rejects malformed hashes and fetches actual terminal content from the paired daemon after unlock.
- Mobile product diagnostics sharing is off by default. No mobile crash-reporting SDK is bundled in v1.
- Android Firebase Messaging auto-init and Firebase Analytics collection are disabled in the manifest. FCM token generation is enabled only after pairing, biometric unlock, and only when `google-services.json` is present. Refreshed Android FCM tokens are queued in app-private `shelly_push_tokens.xml`, excluded from backup/transfer, and sent only after pairing plus biometric unlock.

## Google Play Data Safety

Does the app collect or share user data? Yes, because FCM push tokens / Firebase installation identifiers can be transmitted off device.

Data shared with third parties: No, assuming FCM is documented as a service provider processing data for Shelly under the published privacy policy and applicable agreements. If that legal posture changes, mark the relevant rows as shared.

Security practices:

- Data encrypted in transit: Yes.
- Users can request data deletion: Yes, through device revocation/unpairing for app-held pairing data and the published support/privacy contact for relay-side push-token removal.
- Independent security review: Not completed for v1 unless a MASA review is obtained before launch.

Data types:

| Category | Type | Collected | Shared | Purpose | Required |
| --- | --- | --- | --- | --- | --- |
| Device or other IDs | FCM registration token / Firebase installation ID | Yes | No | App functionality | Required for Android push after pairing; core attach/list/input workflows still work without push delivery. |
| App info and performance | Diagnostics | Optional | No | App functionality | Optional local consent only in v1; no mobile diagnostics are sent off device. |

Not declared as collected:

- Terminal content and keystrokes because they are end-to-end encrypted between user-controlled endpoints and are unreadable to Shelly infrastructure.
- QR camera frames because they are processed only on device.
- Biometric data because Android does not expose it to the app.
- Location, contacts, messages, files/docs, photos/videos, audio, calendar, web browsing history, installed apps, purchases, financial info, health/fitness, and personal info.

Pre-submission checks:

- Compare this answer sheet against the built Android manifest before every
  mobile release candidate.
- Confirm no mobile crash-reporting SDK or analytics SDK has been added.
- Confirm push payload handlers still accept only fixed copy and opaque
  lowercase 64-character session hashes.
- Confirm the production Android manifest still has `firebase_messaging_auto_init_enabled=false` and `firebase_analytics_collection_enabled=false`.
- Inspect a real FCM delivery before final store submission.
