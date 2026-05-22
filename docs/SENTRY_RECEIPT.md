# Sentry Receipt Evidence

This runbook verifies the Section 13 hosted Sentry receipt gate for daemon, Android, and iOS crash reporting. It does not change the v1 telemetry policy:
daemon telemetry is opt-in only, mobile crash reporting is opt-in only, Sentry
default PII is disabled, trace sampling is `0.0`, and terminal/session content
must never be attached to events.

The pass condition is one hosted Sentry event each from `fieldworkd`, the signed
Android release app, and the signed iOS release app. The evidence must include
the privacy configuration that produced the events and exported Sentry JSON rows
with release/environment/service identifiers. The gate remains unchecked until a
real Sentry project/DSN and signed daemon/mobile builds are available.

## Scope

- Use a real Sentry project and release-build DSN values injected through the
  release workflows or temporary local release-candidate environment.
- Do not include raw Sentry DSNs, auth tokens, release-upload tokens, terminal
  output, command lines, paths, session names, session hashes, daemon node IDs,
  push tokens, screenshots, or session replay data in the evidence directory.
- For Android and iOS, enable crash reporting only through the app Settings
  toggle or the delayed post-value consent prompt. Do not use debug auto-init.
- For the daemon, enable telemetry only through `fieldwork settings telemetry on`
  or the documented `FIELDWORK_TELEMETRY_OPT_IN=true` plus redacted
  `FIELDWORK_SENTRY_DSN=<redacted>` environment override.

## Evidence Directory

```sh
export FW_SENTRY_DIR="/tmp/fieldwork-sentry-$(date +%Y%m%d%H%M%S)"
mkdir -p "$FW_SENTRY_DIR"
```

## Sentry Project And Privacy Config

Capture the project/release summary without secrets:

```sh
{
  printf 'project=fieldwork\n'
  printf 'environment=release-candidate\n'
  printf 'release=fieldwork@1.0.0\n'
  printf 'dsn=<redacted>\n'
  printf 'auth_token=<redacted>\n'
} | tee "$FW_SENTRY_DIR/sentry-project.txt"
```

Capture privacy settings:

```sh
{
  printf 'send_default_pii=false\n'
  printf 'traces_sample_rate=0.0\n'
  printf 'session_replay=false\n'
  printf 'screenshots=false\n'
  printf 'user_interaction_tracing=false\n'
  printf 'terminal_content_attached=false\n'
} | tee "$FW_SENTRY_DIR/privacy-review.txt"
```

## Daemon Event

Enable daemon telemetry with a redacted DSN transcript, restart the daemon, and
trigger a controlled test panic or crash path in a release-candidate daemon:

```sh
{
  printf 'fieldwork settings telemetry on --sentry-dsn <redacted>\n'
  printf 'fieldwork settings telemetry status: enabled\n'
  printf 'send_default_pii=false\n'
  printf 'traces_sample_rate=0.0\n'
  printf 'daemon_test_event=fieldworkd_sentry_receipt\n'
} | tee "$FW_SENTRY_DIR/daemon-telemetry.txt"
```

Export the matching Sentry event JSON as:

```sh
$FW_SENTRY_DIR/daemon-event.json
```

The exported event must identify `fieldworkd`, Rust, `fieldwork@1.0.0`, the test
environment, and the `fieldworkd_sentry_receipt` marker.

## Android Event

Capture release `BuildConfig` values without the raw DSN:

```sh
rg 'APPLICATION_ID = "app\.fieldwork\.android"|BUILD_TYPE = "release"|DEBUG = false|DEBUG = Boolean\.parseBoolean\("false"\)|FIELDWORK_SENTRY_DSN' \
  apps/android/app/build/generated/source/buildConfig/release/app/fieldwork/android/BuildConfig.java \
  | sed -E 's#(FIELDWORK_SENTRY_DSN[^\"]*\")([^\"]+)#\1<redacted>#' \
  | tee "$FW_SENTRY_DIR/android-buildconfig.txt"
```

Enable the Android Settings toggle through the signed release app, trigger a
controlled release-candidate crash, and export:

```sh
$FW_SENTRY_DIR/android-settings-ui.xml
$FW_SENTRY_DIR/android-event.json
```

The exported Android event must identify `app.fieldwork.android`, Android,
`fieldwork@1.0.0`, the test environment, and the
`android_sentry_receipt` marker.

## iOS Event

When iOS work resumes, use the signed release app with `FieldworkSentryDsn`
injected from release secrets, enable the Settings toggle or delayed consent
prompt, trigger a controlled release-candidate crash, and export:

```sh
$FW_SENTRY_DIR/ios-settings.txt
$FW_SENTRY_DIR/ios-event.json
```

The exported iOS event must identify `app.fieldwork.ios`, iOS,
`fieldwork@1.0.0`, the test environment, and the `ios_sentry_receipt` marker.

Verify the evidence:

```sh
pnpm check:sentry-receipt-evidence -- "$FW_SENTRY_DIR"
```

Passing this verifier only proves the hosted Sentry receipt evidence shape. The
release gate remains unchecked until all three events are exported from the real
hosted Sentry project using signed/release-candidate artifacts.
