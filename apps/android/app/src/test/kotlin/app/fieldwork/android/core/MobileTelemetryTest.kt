package app.fieldwork.android.core

import android.content.Context
import io.sentry.Sentry
import org.junit.After
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class MobileTelemetryTest {
    private lateinit var context: Context

    @Before
    fun setUp() {
        context = RuntimeEnvironment.getApplication().applicationContext
        context.telemetryPrefsForTests().edit().clear().commit()
        Sentry.close()
    }

    @After
    fun tearDown() {
        context.telemetryPrefsForTests().edit().clear().commit()
        Sentry.close()
    }

    @Test
    fun crashReportingDefaultsOffAndConsentPromptIsEligible() {
        MobileTelemetry.sync(context)

        assertFalse(MobileTelemetry.isCrashReportingEnabled(context))
        assertTrue(MobileTelemetry.shouldShowConsentPrompt(context))
        assertFalse(Sentry.isEnabled())
    }

    @Test
    fun declinedConsentIsResolvedWithoutEnablingCrashReporting() {
        MobileTelemetry.setCrashReportingEnabled(context, enabled = false)

        assertFalse(MobileTelemetry.isCrashReportingEnabled(context))
        assertFalse(MobileTelemetry.shouldShowConsentPrompt(context))
        assertFalse(Sentry.isEnabled())
    }

    @Test
    fun acceptedConsentPersistsButDebugBuildWithoutDsnDoesNotStartSentry() {
        MobileTelemetry.setCrashReportingEnabled(context, enabled = true)

        assertTrue(MobileTelemetry.isCrashReportingEnabled(context))
        assertFalse(MobileTelemetry.shouldShowConsentPrompt(context))
        assertFalse(Sentry.isEnabled())
    }

    private fun Context.telemetryPrefsForTests() =
        applicationContext.getSharedPreferences("fieldwork_privacy", Context.MODE_PRIVATE)
}
