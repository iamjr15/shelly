package app.shelly.android.core

import androidx.biometric.BiometricManager
import org.junit.After
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class AndroidBiometricGateTest {
    private var nowMillis = 10_000L

    @Before
    fun setUp() {
        AndroidBiometricGate.resetForTests { nowMillis }
    }

    @After
    fun tearDown() {
        AndroidBiometricGate.resetForTests()
    }

    @Test
    fun resumeRequiresLockBeforeFirstUnlock() {
        assertFalse(AndroidBiometricGate.isFreshForTests())
        assertTrue(AndroidBiometricGate.shouldLockOnResumeForTests())
    }

    @Test
    fun debugBiometricBypassDefaultsOffForUnitTests() {
        assertFalse(AndroidBiometricGate.debugBypassEnabledForTests())
    }

    @Test
    fun successfulUnlockMakesImmediateResumeFresh() {
        AndroidBiometricGate.recordSuccessfulUnlockForTests()

        assertTrue(AndroidBiometricGate.isFreshForTests())
        assertFalse(AndroidBiometricGate.shouldLockOnResumeForTests())
    }

    @Test
    fun freshBackgroundResumeDoesNotLock() {
        AndroidBiometricGate.recordSuccessfulUnlockForTests()
        AndroidBiometricGate.markBackgrounded()

        nowMillis += FIVE_MINUTES_MILLIS - 1

        assertTrue(AndroidBiometricGate.isFreshForTests())
        assertFalse(AndroidBiometricGate.shouldLockOnResumeForTests())
    }

    @Test
    fun staleBackgroundResumeLocksAtFiveMinutes() {
        AndroidBiometricGate.recordSuccessfulUnlockForTests()
        AndroidBiometricGate.markBackgrounded()

        nowMillis += FIVE_MINUTES_MILLIS

        assertFalse(AndroidBiometricGate.isFreshForTests())
        assertTrue(AndroidBiometricGate.shouldLockOnResumeForTests())
    }

    @Test
    fun staleUnlockLocksEvenAfterFreshBackground() {
        AndroidBiometricGate.recordSuccessfulUnlockForTests()
        nowMillis += FIVE_MINUTES_MILLIS
        AndroidBiometricGate.markBackgrounded()

        assertFalse(AndroidBiometricGate.isFreshForTests())
        assertTrue(AndroidBiometricGate.shouldLockOnResumeForTests())
    }

    @Test
    fun permanentBiometricFailuresExposeRecoverySettingsButTransientFailureDoesNot() {
        assertTrue(biometricFailureIsPermanent(BiometricManager.BIOMETRIC_ERROR_NO_HARDWARE))
        assertTrue(biometricFailureIsPermanent(BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED))
        assertFalse(biometricFailureIsPermanent(BiometricManager.BIOMETRIC_ERROR_HW_UNAVAILABLE))
        assertFalse(biometricFailureIsPermanent(BiometricManager.BIOMETRIC_SUCCESS))
    }

    private companion object {
        const val FIVE_MINUTES_MILLIS = 5 * 60 * 1000L
    }
}
