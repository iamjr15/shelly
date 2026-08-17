package app.shelly.android.features.settings

import androidx.compose.foundation.layout.Spacer
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import app.shelly.android.R
import app.shelly.android.ui.components.SettingsFooterAction
import app.shelly.android.ui.components.SettingsGlyph
import app.shelly.android.ui.components.SettingsHeroBody
import app.shelly.android.ui.components.SettingsListRow
import app.shelly.android.ui.components.ShellyScreen

@Composable
fun DaemonDetailScreen(
    onBack: () -> Unit,
    hostName: String = "your computer",
    pairedAge: String = "14d",
    daemon: String = "shellyd 1.0.0",
    protocol: String = "unknown",
    transport: String = "iroh QUIC",
    onOpenDaemon: (() -> Unit)? = null,
    onOpenProtocol: (() -> Unit)? = null,
    onOpenTransport: (() -> Unit)? = null,
    onUnpair: () -> Unit = {},
) {
    DaemonDetailContent(
        onBack = onBack,
        hostName = hostName,
        pairedAge = pairedAge,
        daemon = daemon,
        protocol = protocol,
        transport = transport,
        onOpenDaemon = onOpenDaemon,
        onOpenProtocol = onOpenProtocol,
        onOpenTransport = onOpenTransport,
        onUnpair = onUnpair,
    )
}

@Composable
private fun DaemonDetailContent(
    onBack: () -> Unit,
    hostName: String,
    pairedAge: String,
    daemon: String,
    protocol: String,
    transport: String,
    onOpenDaemon: (() -> Unit)?,
    onOpenProtocol: (() -> Unit)?,
    onOpenTransport: (() -> Unit)?,
    onUnpair: () -> Unit,
) {
    ShellyScreen(
        hero = {
            SettingsHeroBody(
                eyebrow = "THE COMPUTER THIS PHONE\nIS PAIRED WITH",
                wordmark = "NODE",
                status = "$hostName · paired $pairedAge",
                statusGlyph = SettingsGlyph.Monitor,
                onBack = onBack,
            )
        },
        content = {
            SettingsListRow("Daemon", daemon, onClick = onOpenDaemon)
            SettingsListRow("Protocol", protocol, onClick = onOpenProtocol)
            SettingsListRow("Transport", transport, showDivider = false, onClick = onOpenTransport)
            Spacer(Modifier.weight(1f))
            SettingsFooterAction(stringResource(R.string.unpair_this_device), onClick = onUnpair)
        },
    )
}
