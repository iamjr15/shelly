package app.shelly.android.features.settings

import app.shelly.android.core.PairedDaemonRecord
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SettingsCopyTest {
    @Test
    fun settingsSectionsMatchProductionInformationArchitecture() {
        assertEquals("Connection", SETTINGS_CONNECTION_SECTION)
        assertEquals("Privacy", SETTINGS_PRIVACY_SECTION)
        assertEquals("Help", SETTINGS_HELP_SECTION)
        assertEquals("Device", SETTINGS_DEVICE_SECTION)
        assertEquals("Daemon", DAEMON_TITLE)
        assertEquals("Share diagnostics", DIAGNOSTICS_TITLE)
        assertEquals("Open Source Licenses", LICENSES_TITLE)
    }

    @Test
    fun diagnosticsCopyKeepsTelemetryBoundaryExplicit() {
        assertTrue(DIAGNOSTICS_BODY.contains("Records a local preference only"))
        assertTrue(DIAGNOSTICS_BODY.contains("collects and sends no diagnostics"))
        assertTrue(DIAGNOSTICS_BODY.contains("only if a future version adds them"))
        assertTrue(DIAGNOSTICS_BODY.contains("No terminal output"))
        assertTrue(DIAGNOSTICS_BODY.contains("commands"))
        assertFalse(DIAGNOSTICS_BODY.contains("crash", ignoreCase = true))
    }

    @Test
    fun unpairCopyPreservesDesktopRevocationBoundary() {
        assertEquals("Unpair this phone?", UNPAIR_TITLE)
        assertEquals("Unpair", UNPAIR_CONFIRM)
        assertTrue(UNPAIR_BODY.contains("Desktop sessions keep running"))
        assertTrue(UNPAIR_BODY.contains("shelly devices remove <device>"))
        assertTrue(UNPAIR_ROW_BODY.contains("local pairing"))
        assertTrue(UNPAIR_ROW_BODY.contains("Desktop sessions keep running"))
        assertFalse(UNPAIR_BODY.contains("kill", ignoreCase = true))
    }

    @Test
    fun daemonSummaryDoesNotExposeFullDeviceSecretOrFullNodeId() {
        val record = PairedDaemonRecord(
            daemonNodeId = "0123456789abcdef0123456789abcdef",
            relayUrl = "https://relay.example",
            addrs = listOf("127.0.0.1:1"),
            deviceNodeId = "device-node",
            deviceSecretKey = byteArrayOf(1, 2, 3),
            pairedAtMillis = 1L,
        )

        assertEquals("No paired daemon", pairedDaemonSummary(null))
        assertEquals("0123456789ab...", pairedDaemonSummary(record))
        assertFalse(pairedDaemonSummary(record).contains("abcdef0123456789abcdef"))
    }
}
