import Foundation
#if canImport(Sentry)
import Sentry
#endif

enum MobileTelemetry {
    static let crashReportsOptInKey = "telemetryOptIn"
    private static let crashReportsConsentResolvedKey = "telemetryConsentResolved"

    static func shouldShowConsentPrompt() -> Bool {
        !UserDefaults.standard.bool(forKey: crashReportsOptInKey) &&
            !UserDefaults.standard.bool(forKey: crashReportsConsentResolvedKey)
    }

    static func setCrashReportingEnabled(_ enabled: Bool) {
        UserDefaults.standard.set(enabled, forKey: crashReportsOptInKey)
        UserDefaults.standard.set(true, forKey: crashReportsConsentResolvedKey)
        sync()
    }

    static func declineCrashReporting() {
        setCrashReportingEnabled(false)
    }

    static func sync() {
        #if canImport(Sentry)
        guard UserDefaults.standard.bool(forKey: crashReportsOptInKey),
              let dsn = configuredDsn() else {
            if SentrySDK.isEnabled {
                SentrySDK.close()
            }
            return
        }
        guard !SentrySDK.isEnabled else {
            return
        }

        SentrySDK.start { options in
            options.dsn = dsn
            options.sendDefaultPii = false
            options.tracesSampleRate = 0.0
            options.sampleRate = 1.0
            options.enableAutoPerformanceTracing = false
            options.releaseName = releaseName()
            options.environment = Bundle.main.object(forInfoDictionaryKey: "Configuration") as? String ?? "production"
        }
        #endif
    }

    private static func configuredDsn() -> String? {
        guard let raw = Bundle.main.object(forInfoDictionaryKey: "FieldworkSentryDsn") as? String else {
            return nil
        }
        let dsn = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !dsn.isEmpty, !dsn.contains("$(") else {
            return nil
        }
        return dsn
    }

    private static func releaseName() -> String {
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0"
        let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "0"
        return "app.fieldwork.ios@\(version)+\(build)"
    }
}
