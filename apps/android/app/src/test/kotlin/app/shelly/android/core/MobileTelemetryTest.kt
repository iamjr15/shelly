package app.shelly.android.core

import android.content.Context
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
    }

    @After
    fun tearDown() {
        context.telemetryPrefsForTests().edit().clear().commit()
    }

    @Test
    fun diagnosticsDefaultsOffAndConsentPromptIsEligible() {
        MobileTelemetry.sync(context)

        assertFalse(MobileTelemetry.isDiagnosticsEnabled(context))
        assertTrue(MobileTelemetry.shouldShowConsentPrompt(context))
    }

    @Test
    fun declinedConsentIsResolvedWithoutEnablingDiagnostics() {
        MobileTelemetry.setDiagnosticsEnabled(context, enabled = false)

        assertFalse(MobileTelemetry.isDiagnosticsEnabled(context))
        assertFalse(MobileTelemetry.shouldShowConsentPrompt(context))
    }

    @Test
    fun acceptedConsentPersistsAsLocalDiagnosticsPreference() {
        MobileTelemetry.setDiagnosticsEnabled(context, enabled = true)

        assertTrue(MobileTelemetry.isDiagnosticsEnabled(context))
        assertFalse(MobileTelemetry.shouldShowConsentPrompt(context))
    }

    private fun Context.telemetryPrefsForTests() =
        applicationContext.getSharedPreferences("shelly_privacy", Context.MODE_PRIVATE)
}
