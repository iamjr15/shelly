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

    fun sync(context: Context) = Unit

    private fun Context.telemetryPreferences() =
        applicationContext.getSharedPreferences(preferencesName, Context.MODE_PRIVATE)
}
