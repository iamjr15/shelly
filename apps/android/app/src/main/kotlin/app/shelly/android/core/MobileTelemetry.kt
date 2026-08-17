package app.shelly.android.core

import android.content.Context

object MobileTelemetry {
    private const val preferencesName = "shelly_privacy"
    private const val diagnosticsOptInKey = "diagnostics_opt_in"
    private const val diagnosticsConsentResolvedKey = "diagnostics_consent_resolved"

    fun isDiagnosticsEnabled(context: Context): Boolean =
        context.telemetryPreferences().getBoolean(diagnosticsOptInKey, false)

    fun shouldShowConsentPrompt(context: Context): Boolean {
        val preferences = context.telemetryPreferences()
        return !preferences.getBoolean(diagnosticsOptInKey, false) &&
            !preferences.getBoolean(diagnosticsConsentResolvedKey, false)
    }

    fun setDiagnosticsEnabled(context: Context, enabled: Boolean) {
        context.telemetryPreferences().edit()
            .putBoolean(diagnosticsOptInKey, enabled)
            .putBoolean(diagnosticsConsentResolvedKey, true)
            .apply()
    }

    // Intentional no-op: diagnostics consent is local-only in v1; no telemetry transport exists.
    fun sync(context: Context) = Unit

    internal fun warm(context: Context) {
        context.telemetryPreferences().all
    }

    private fun Context.telemetryPreferences() =
        applicationContext.getSharedPreferences(preferencesName, Context.MODE_PRIVATE)
}
