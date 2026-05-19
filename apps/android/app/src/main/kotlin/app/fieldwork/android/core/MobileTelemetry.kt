package app.fieldwork.android.core

import android.content.Context
import app.fieldwork.android.BuildConfig
import io.sentry.Sentry
import io.sentry.android.core.SentryAndroid

object MobileTelemetry {
    private const val preferencesName = "fieldwork_privacy"
    private const val crashReportsKey = "crash_reports_opt_in"
    private const val crashReportsConsentResolvedKey = "crash_reports_consent_resolved"
    private var started = false

    fun isCrashReportingEnabled(context: Context): Boolean =
        context.telemetryPreferences().getBoolean(crashReportsKey, false)

    fun shouldShowConsentPrompt(context: Context): Boolean {
        val preferences = context.telemetryPreferences()
        return !preferences.getBoolean(crashReportsKey, false) &&
            !preferences.getBoolean(crashReportsConsentResolvedKey, false)
    }

    fun setCrashReportingEnabled(context: Context, enabled: Boolean) {
        context.telemetryPreferences().edit()
            .putBoolean(crashReportsKey, enabled)
            .putBoolean(crashReportsConsentResolvedKey, true)
            .apply()
        sync(context)
    }

    fun sync(context: Context) {
        val dsn = BuildConfig.FIELDWORK_SENTRY_DSN.trim()
        if (!isCrashReportingEnabled(context) || dsn.isEmpty()) {
            if (started || Sentry.isEnabled()) {
                Sentry.close()
                started = false
            }
            return
        }
        if (started || Sentry.isEnabled()) {
            return
        }

        SentryAndroid.init(context.applicationContext) { options ->
            options.setDsn(dsn)
            options.setSendDefaultPii(false)
            options.setTracesSampleRate(0.0)
            options.setRelease("app.fieldwork.android@${BuildConfig.VERSION_NAME}+${BuildConfig.VERSION_CODE}")
            options.setEnvironment(BuildConfig.BUILD_TYPE)
            options.setEnableAutoActivityLifecycleTracing(false)
            options.setEnableActivityLifecycleTracingAutoFinish(false)
            options.setEnableUserInteractionTracing(false)
        }
        started = true
    }

    private fun Context.telemetryPreferences() =
        applicationContext.getSharedPreferences(preferencesName, Context.MODE_PRIVATE)
}
