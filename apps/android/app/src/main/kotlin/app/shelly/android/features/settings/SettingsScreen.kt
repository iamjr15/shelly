package app.shelly.android.features.settings

import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.shelly.android.R
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
    notificationsLabel: String? = null,
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
    val state by viewModel.state.collectAsStateWithLifecycle()

    SettingsContent(
        modifier = Modifier.padding(padding),
        paired = state.paired,
        pairedDaemon = state.pairedDaemon,
        themeModeLabel = themeModeLabel,
        notificationsLabel = notificationsLabel ?: stringResource(R.string.state_off),
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
internal fun SettingsContent(
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
                SettingsFooterAction(stringResource(R.string.unpair_this_device), onClick = onUnpair)
            }
        },
    )
}
