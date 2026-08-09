package app.shelly.android.ui

import app.shelly.android.core.ShellyUiState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ShellyAppLockFlowTest {
    @Test
    fun pairingRestorePrecedesTheLockSurface() {
        val state = ShellyUiState(
            unlocked = false,
            paired = true,
            restoringPairing = true,
        )

        assertEquals(
            ShellySurface.RestoringPairing,
            shellySurfaceFor(onboarded = true, state = state, route = ShellyRoute.Sessions),
        )
        assertFalse(shouldUseBiometricGate(onboarded = true, state = state))
    }

    @Test
    fun unpairedDevicesGoStraightToPairingWithoutBiometrics() {
        val state = ShellyUiState(
            unlocked = false,
            paired = false,
            restoringPairing = false,
        )

        assertEquals(
            ShellySurface.Pairing,
            shellySurfaceFor(onboarded = true, state = state, route = ShellyRoute.Sessions),
        )
        assertFalse(shouldUseBiometricGate(onboarded = true, state = state))
    }

    @Test
    fun pairedLockedDevicesUseTheFallbackAndBiometricGate() {
        val state = ShellyUiState(
            unlocked = false,
            paired = true,
            restoringPairing = false,
        )

        assertEquals(
            ShellySurface.Locked,
            shellySurfaceFor(onboarded = true, state = state, route = ShellyRoute.Sessions),
        )
        assertTrue(shouldUseBiometricGate(onboarded = true, state = state))
    }

    @Test
    fun onboardingNeverUsesTheBiometricGate() {
        val state = ShellyUiState(
            unlocked = false,
            paired = true,
            restoringPairing = false,
        )

        assertEquals(
            ShellySurface.Onboarding,
            shellySurfaceFor(onboarded = false, state = state, route = ShellyRoute.Sessions),
        )
        assertFalse(shouldUseBiometricGate(onboarded = false, state = state))
    }
}
