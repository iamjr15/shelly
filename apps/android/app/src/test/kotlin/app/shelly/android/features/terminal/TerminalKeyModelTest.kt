package app.shelly.android.features.terminal

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class TerminalKeyModelTest {
    @Test
    fun primaryKeysEmitCanonicalTerminalSequences() {
        val keys = terminalKeySpecs().associateBy(TerminalKeySpec::label)

        assertArrayEquals(byteArrayOf(0x1b), keys.getValue("esc").bytes)
        assertArrayEquals(byteArrayOf(0x09), keys.getValue("tab").bytes)
        assertArrayEquals(byteArrayOf(0x1b, 0x5b, 0x5a), keys.getValue("shift\ntab").bytes)
        assertArrayEquals(byteArrayOf(0x1b, 0x5b, 0x44), keys.getValue("←").bytes)
        assertArrayEquals(byteArrayOf(0x1b, 0x5b, 0x41), keys.getValue("↑").bytes)
        assertArrayEquals(byteArrayOf(0x1b, 0x5b, 0x42), keys.getValue("↓").bytes)
        assertArrayEquals(byteArrayOf(0x1b, 0x5b, 0x43), keys.getValue("→").bytes)
        assertArrayEquals("[]{}|/~-".encodeToByteArray(),
            listOf("[", "]", "{", "}", "|", "/", "~", "-")
                .flatMap { keys.getValue(it).bytes.asIterable() }
                .toByteArray())
        assertEquals(TerminalKeyAction.ToggleCtrl, keys.getValue("ctrl").action)
    }

    @Test
    fun overflowKeysCoverEditingNavigationAndCommonControlChords() {
        val keys = terminalOverflowKeySpecs().associateBy(TerminalKeySpec::label)

        assertEquals(TerminalKeyAction.ToggleAlt, keys.getValue("alt").action)
        assertArrayEquals(byteArrayOf(0x1b, 0x5b, 0x48), keys.getValue("home").bytes)
        assertArrayEquals(byteArrayOf(0x1b, 0x5b, 0x46), keys.getValue("end").bytes)
        assertArrayEquals(byteArrayOf(0x1b, 0x5b, 0x35, 0x7e), keys.getValue("pg up").bytes)
        assertArrayEquals(byteArrayOf(0x1b, 0x5b, 0x36, 0x7e), keys.getValue("pg dn").bytes)
        assertArrayEquals(byteArrayOf(0x1b, 0x5b, 0x33, 0x7e), keys.getValue("del").bytes)
        assertArrayEquals(byteArrayOf(0x1b, 0x5b, 0x32, 0x7e), keys.getValue("ins").bytes)
        assertArrayEquals(byteArrayOf(0x03), keys.getValue("^C").bytes)
        assertArrayEquals(byteArrayOf(0x0c), keys.getValue("^L").bytes)
        assertArrayEquals(byteArrayOf(0x12), keys.getValue("^R").bytes)
        assertArrayEquals(byteArrayOf(0x1a), keys.getValue("^Z").bytes)
        assertTrue(keys.values.all { it.contentDescription.isNotBlank() })
    }
}
