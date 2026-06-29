package app.shelly.android.features.terminal

import app.shelly.android.core.terminalAttachErrorMessage
import org.junit.Assert.assertEquals
import org.junit.Test
import uniffi.shelly_mobile_core.ShellyException

class TerminalAttachModelTest {
    @Test
    fun attachStatusCopyIsStableAndPrivate() {
        assertEquals("Attaching", TERMINAL_ATTACHING_TITLE)
        assertEquals("Opening the live PTY stream from your laptop.", TERMINAL_ATTACHING_BODY)
        assertEquals("Retry", TERMINAL_ATTACH_RETRY)
    }

    @Test
    fun attachErrorsUseStablePrivateMessages() {
        val missing = terminalAttachErrorMessage(ShellyException.NotFound("session 018f... missing"))
        assertEquals("Session not found", missing.title)
        assertEquals(
            "That session ended or was removed on your laptop. Go back to Sessions and refresh.",
            missing.body,
        )

        val transport = terminalAttachErrorMessage(ShellyException.Transport("timed out connecting"))
        assertEquals("Could not reach daemon", transport.title)
        assertEquals(
            "Make sure your laptop is awake and `shellyd` is running, then retry the attach.",
            transport.body,
        )

        val unexpected = terminalAttachErrorMessage(IllegalStateException("node id or path details"))
        assertEquals("Terminal attach failed", unexpected.title)
        assertEquals(
            "Shelly could not open that terminal because Android reported an unexpected error. Go back to Sessions and try again.",
            unexpected.body,
        )
    }
}
