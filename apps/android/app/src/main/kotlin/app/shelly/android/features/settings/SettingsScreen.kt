package app.shelly.android.features.settings

import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import app.shelly.android.core.PairedDaemonRecord
import app.shelly.android.core.ShellyViewModel
import app.shelly.android.core.displayName
import app.shelly.android.ui.components.SettingsFooterAction
import app.shelly.android.ui.components.SettingsGlyph
import app.shelly.android.ui.components.SettingsHeroBody
import app.shelly.android.ui.components.SettingsListRow
import app.shelly.android.ui.components.ShellyScreen

@Composable
fun SettingsScreen(
    padding: PaddingValues,
    viewModel: ShellyViewModel,
    themeModeLabel: String = "SYSTEM",
    notificationsLabel: String = "OFF",
    securityLabel: String = "5 MIN",
    aboutVersionLabel: String = "V1.0",
    onBackToSessions: () -> Unit = {},
    onOpenAppearance: () -> Unit = {},
    onOpenNotifications: () -> Unit = {},
    onOpenSecurity: () -> Unit = {},
    onOpenAbout: () -> Unit = {},
    onOpenDaemonDetail: () -> Unit = {},
    onUnpair: () -> Unit = {},
) {
    val state by viewModel.state.collectAsState()

    SettingsContent(
        modifier = Modifier.padding(padding),
        paired = state.paired,
        pairedDaemon = state.pairedDaemon,
        themeModeLabel = themeModeLabel,
        notificationsLabel = notificationsLabel,
        securityLabel = securityLabel,
        aboutVersionLabel = aboutVersionLabel,
        onBackToSessions = onBackToSessions,
        onOpenAppearance = onOpenAppearance,
        onOpenNotifications = onOpenNotifications,
        onOpenSecurity = onOpenSecurity,
        onOpenAbout = onOpenAbout,
        onOpenDaemonDetail = onOpenDaemonDetail,
        onUnpair = onUnpair,
    )
}

@Composable
private fun SettingsContent(
    modifier: Modifier = Modifier,
    paired: Boolean,
    pairedDaemon: PairedDaemonRecord?,
    themeModeLabel: String,
    notificationsLabel: String,
    securityLabel: String,
    aboutVersionLabel: String,
    onBackToSessions: () -> Unit,
    onOpenAppearance: () -> Unit,
    onOpenNotifications: () -> Unit,
    onOpenSecurity: () -> Unit,
    onOpenAbout: () -> Unit,
    onOpenDaemonDetail: () -> Unit,
    onUnpair: () -> Unit,
) {
    val daemonStatus = pairedDaemon?.let { "paired with ${it.displayName()}" } ?: DAEMON_UNPAIRED.lowercase()
    ShellyScreen(
        modifier = modifier,
        hero = {
            SettingsHeroBody(
                eyebrow = "YOUR PREFERENCES\nLIVE ON THIS DEVICE",
                wordmark = "PREFS",
                status = daemonStatus,
                statusGlyph = SettingsGlyph.Monitor,
                onBack = onBackToSessions,
                onStatusClick = onOpenDaemonDetail,
            )
        },
        content = {
            SettingsListRow("Appearance", themeModeLabel, glyph = SettingsGlyph.Sun, onClick = onOpenAppearance)
            SettingsListRow("Notifications", notificationsLabel, glyph = SettingsGlyph.Bell, onClick = onOpenNotifications)
            SettingsListRow("Security", securityLabel, glyph = SettingsGlyph.Lock, onClick = onOpenSecurity)
            SettingsListRow("About", aboutVersionLabel, glyph = SettingsGlyph.Info, showDivider = false, onClick = onOpenAbout)
            Spacer(Modifier.weight(1f))
            if (paired) {
                SettingsFooterAction("Unpair this device", onClick = onUnpair)
            }
        },
    )
}

@Composable
internal fun SettingsContentPreview() {
    SettingsContent(
        paired = true,
        pairedDaemon = PairedDaemonRecord(
            daemonNodeId = "preview-daemon",
            relayUrl = null,
            addrs = emptyList(),
            deviceNodeId = "preview-device",
            deviceSecretKey = ByteArray(0),
            pairedAtMillis = 0L,
            daemonVersion = "1.0.0",
            hostName = "dev-macbook",
            protocolVersion = 3,
        ),
        themeModeLabel = "SYSTEM",
        notificationsLabel = "OFF",
        securityLabel = "5 MIN",
        aboutVersionLabel = "V1.0",
        onBackToSessions = {},
        onOpenAppearance = {},
        onOpenNotifications = {},
        onOpenSecurity = {},
        onOpenAbout = {},
        onOpenDaemonDetail = {},
        onUnpair = {},
    )
}
