package app.fieldwork.android.features.terminal

import org.junit.Assert.assertEquals
import org.junit.Test
import uniffi.fieldwork_mobile_core.FieldworkException

class TerminalAttachModelTest {
    @Test
    fun attachStatusCopyIsStableAndPrivate() {
        assertEquals("Attaching", TERMINAL_ATTACHING_TITLE)
        assertEquals("Opening the live PTY stream from your laptop.", TERMINAL_ATTACHING_BODY)
        assertEquals("Check that your laptop is awake and try again.", TERMINAL_ATTACH_ERROR_BODY)
        assertEquals("Retry", TERMINAL_ATTACH_RETRY)
    }

    @Test
    fun attachErrorsUseStablePrivateMessages() {
        assertEquals(
            "Session unavailable",
            terminalAttachErrorMessage(FieldworkException.NotFound("session 018f... missing")),
        )
        assertEquals(
            "Connection unavailable",
            terminalAttachErrorMessage(IllegalStateException("node id or path details")),
        )
    }
}
