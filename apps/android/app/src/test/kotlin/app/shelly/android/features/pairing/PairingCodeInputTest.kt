package app.shelly.android.features.pairing

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PairingCodeInputTest {
    @Test
    fun normalizesLowercaseAndCrockfordAliases() {
        assertEquals("101AB", normalizePairingCodeInput("ioLab"))
    }

    @Test
    fun dropsCharactersOutsidePairingAlphabet() {
        assertEquals("AB12C", normalizePairingCodeInput("a b-1_2+c!"))
    }

    @Test
    fun capsAtPairingCodeLength() {
        assertEquals(PAIRING_CODE_LENGTH, normalizePairingCodeInput("abcdef12345").length)
        assertEquals("ABCDE", normalizePairingCodeInput("abcdef12345"))
    }

    @Test
    fun completeCodeRequiresLengthAndAlphabet() {
        assertTrue(isCompletePairingCode("AB12C"))
        assertFalse(isCompletePairingCode("AB12"))
        assertFalse(isCompletePairingCode("AB12U"))
    }

    @Test
    fun cameraDeniedCopyRoutesToTypedCodeInsteadOfPayloads() {
        assertTrue(PAIRING_CAMERA_DENIED_BODY.contains("pairing code"))
        assertEquals("Enter code instead", PAIRING_CAMERA_DENIED_ACTION)
        assertFalse(PAIRING_CAMERA_DENIED_BODY.contains("payload", ignoreCase = true))
    }
}
