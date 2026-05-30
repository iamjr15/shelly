import Foundation

enum MobileTelemetry {
    static let diagnosticsOptInKey = "diagnosticsOptIn"
    private static let diagnosticsConsentResolvedKey = "diagnosticsConsentResolved"

    static func shouldShowConsentPrompt() -> Bool {
        !UserDefaults.standard.bool(forKey: diagnosticsOptInKey) &&
            !UserDefaults.standard.bool(forKey: diagnosticsConsentResolvedKey)
    }

    static func setDiagnosticsEnabled(_ enabled: Bool) {
        UserDefaults.standard.set(enabled, forKey: diagnosticsOptInKey)
        UserDefaults.standard.set(true, forKey: diagnosticsConsentResolvedKey)
    }

    static func declineDiagnostics() {
        setDiagnosticsEnabled(false)
    }

    static func sync() {}
}
