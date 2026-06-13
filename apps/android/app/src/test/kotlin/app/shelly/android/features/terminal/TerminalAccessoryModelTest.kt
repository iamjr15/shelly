package app.shelly.android.features.terminal

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Test

class TerminalAccessoryModelTest {
    @Test
    fun accessoryOrderMatchesCommonTerminalWorkflow() {
        assertEquals(
            listOf(
                "Esc",
                "Ctrl",
                "Alt",
                "C-c",
                "C-d",
                "Tab",
                "|",
                "/",
                "Up",
                "Down",
                "Left",
                "Right",
                "Home",
                "End",
                "PgUp",
                "PgDn",
                "F1",
                "F2",
                "F3",
                "F4",
                "F5",
                "F6",
                "F7",
                "F8",
                "F9",
                "F10",
                "F11",
                "F12",
            ),
            terminalAccessoryItems().map { it.label },
        )
    }

    @Test
    fun sendByteAccessoriesUseTerminalControlSequences() {
        val items = terminalAccessoryItems().associateBy { it.label }

        assertArrayEquals(byteArrayOf(0x1b), items.getValue("Esc").bytes)
        assertArrayEquals(byteArrayOf(0x03), items.getValue("C-c").bytes)
        assertArrayEquals(byteArrayOf(0x04), items.getValue("C-d").bytes)
        assertArrayEquals(byteArrayOf(0x09), items.getValue("Tab").bytes)
        assertArrayEquals("|".encodeToByteArray(), items.getValue("|").bytes)
        assertArrayEquals("/".encodeToByteArray(), items.getValue("/").bytes)
        assertArrayEquals(byteArrayOf(0x1b, 0x5b, 0x41), items.getValue("Up").bytes)
        assertArrayEquals(byteArrayOf(0x1b, 0x5b, 0x42), items.getValue("Down").bytes)
        assertArrayEquals(byteArrayOf(0x1b, 0x5b, 0x44), items.getValue("Left").bytes)
        assertArrayEquals(byteArrayOf(0x1b, 0x5b, 0x43), items.getValue("Right").bytes)
    }

    @Test
    fun navigationAccessoriesUseTerminalControlSequences() {
        val items = terminalAccessoryItems().associateBy { it.label }

        assertArrayEquals(byteArrayOf(0x1b, 0x5b, 0x48), items.getValue("Home").bytes)
        assertArrayEquals(byteArrayOf(0x1b, 0x5b, 0x46), items.getValue("End").bytes)
        assertArrayEquals(byteArrayOf(0x1b, 0x5b, 0x35, 0x7e), items.getValue("PgUp").bytes)
        assertArrayEquals(byteArrayOf(0x1b, 0x5b, 0x36, 0x7e), items.getValue("PgDn").bytes)
    }

    @Test
    fun functionKeyAccessoriesUseXtermControlSequences() {
        val items = terminalAccessoryItems().associateBy { it.label }

        assertArrayEquals(byteArrayOf(0x1b, 0x4f, 0x50), items.getValue("F1").bytes)
        assertArrayEquals(byteArrayOf(0x1b, 0x4f, 0x51), items.getValue("F2").bytes)
        assertArrayEquals(byteArrayOf(0x1b, 0x4f, 0x52), items.getValue("F3").bytes)
        assertArrayEquals(byteArrayOf(0x1b, 0x4f, 0x53), items.getValue("F4").bytes)
        assertArrayEquals(byteArrayOf(0x1b, 0x5b, 0x31, 0x35, 0x7e), items.getValue("F5").bytes)
        assertArrayEquals(byteArrayOf(0x1b, 0x5b, 0x31, 0x37, 0x7e), items.getValue("F6").bytes)
        assertArrayEquals(byteArrayOf(0x1b, 0x5b, 0x31, 0x38, 0x7e), items.getValue("F7").bytes)
        assertArrayEquals(byteArrayOf(0x1b, 0x5b, 0x31, 0x39, 0x7e), items.getValue("F8").bytes)
        assertArrayEquals(byteArrayOf(0x1b, 0x5b, 0x32, 0x30, 0x7e), items.getValue("F9").bytes)
        assertArrayEquals(byteArrayOf(0x1b, 0x5b, 0x32, 0x31, 0x7e), items.getValue("F10").bytes)
        assertArrayEquals(byteArrayOf(0x1b, 0x5b, 0x32, 0x33, 0x7e), items.getValue("F11").bytes)
        assertArrayEquals(byteArrayOf(0x1b, 0x5b, 0x32, 0x34, 0x7e), items.getValue("F12").bytes)
    }

    @Test
    fun modifierAccessoriesDoNotSendBytes() {
        val items = terminalAccessoryItems().associateBy { it.label }

        assertEquals(TerminalAccessoryAction.ToggleCtrl, items.getValue("Ctrl").action)
        assertEquals(TerminalAccessoryAction.ToggleAlt, items.getValue("Alt").action)
        assertEquals(emptyList<Byte>(), items.getValue("Ctrl").bytes.toList())
        assertEquals(emptyList<Byte>(), items.getValue("Alt").bytes.toList())
    }
}
