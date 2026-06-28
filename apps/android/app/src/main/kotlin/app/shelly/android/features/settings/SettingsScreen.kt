package app.shelly.android.features.settings

import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import app.shelly.android.core.MobileTelemetry
import app.shelly.android.core.ShellyViewModel
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
    onBackToSessions: () -> Unit = {},
    onOpenAppearance: () -> Unit = {},
    onOpenNotifications: () -> Unit = {},
    onOpenSecurity: () -> Unit = {},
    onOpenPrivacy: () -> Unit = {},
    onOpenAbout: () -> Unit = {},
    onOpenDaemonDetail: () -> Unit = {},
    onUnpair: () -> Unit = {},
) {
    val context = LocalContext.current
    val state by viewModel.state.collectAsState()
    val telemetry by remember { mutableStateOf(MobileTelemetry.isDiagnosticsEnabled(context)) }

    SettingsContent(
        modifier = Modifier.padding(padding),
        paired = state.paired,
        daemonNodeId = state.pairedDaemon?.daemonNodeId,
        themeModeLabel = themeModeLabel,
        telemetryEnabled = telemetry,
        onBackToSessions = onBackToSessions,
        onOpenAppearance = onOpenAppearance,
        onOpenNotifications = onOpenNotifications,
        onOpenSecurity = onOpenSecurity,
        onOpenPrivacy = onOpenPrivacy,
        onOpenAbout = onOpenAbout,
        onOpenDaemonDetail = onOpenDaemonDetail,
        onUnpair = onUnpair,
    )
}

@Composable
private fun SettingsContent(
    modifier: Modifier = Modifier,
    paired: Boolean,
    daemonNodeId: String?,
    themeModeLabel: String,
    telemetryEnabled: Boolean,
    onBackToSessions: () -> Unit,
    onOpenAppearance: () -> Unit,
    onOpenNotifications: () -> Unit,
    onOpenSecurity: () -> Unit,
    onOpenPrivacy: () -> Unit,
    onOpenAbout: () -> Unit,
    onOpenDaemonDetail: () -> Unit,
    onUnpair: () -> Unit,
) {
    val daemonStatus = daemonNodeId?.let { "paired with ${compactDaemonNodeId(it)}" } ?: DAEMON_UNPAIRED.lowercase()
    ShellyScreen(
        modifier = modifier,
        hero = {
            SettingsHeroBody(
                eyebrow = "YOUR PREFERENCES\nLIVE ON THIS DEVICE",
                wordmark = "PREFS",
                status = daemonStatus,
                statusGlyph = SettingsGlyph.Monitor,
                backLabel = "Sessions",
                onBack = onBackToSessions,
                onStatusClick = onOpenDaemonDetail,
            )
        },
        content = {
            SettingsListRow("Appearance", themeModeLabel, glyph = SettingsGlyph.Sun, onClick = onOpenAppearance)
            SettingsListRow("Notifications", "ON", glyph = SettingsGlyph.Bell, onClick = onOpenNotifications)
            SettingsListRow("Security", "5 MIN", glyph = SettingsGlyph.Lock, onClick = onOpenSecurity)
            SettingsListRow(
                "Privacy",
                if (telemetryEnabled) "OPT-IN" else "OPT-OUT",
                glyph = SettingsGlyph.Shield,
                onClick = onOpenPrivacy,
            )
            SettingsListRow("About", "V1.0.0", glyph = SettingsGlyph.Info, showDivider = false, onClick = onOpenAbout)
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
        daemonNodeId = "node_01k9c4f3hg7z",
        themeModeLabel = "SYSTEM",
        telemetryEnabled = false,
        onBackToSessions = {},
        onOpenAppearance = {},
        onOpenNotifications = {},
        onOpenSecurity = {},
        onOpenPrivacy = {},
        onOpenAbout = {},
        onOpenDaemonDetail = {},
        onUnpair = {},
    )
}
