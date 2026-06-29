package app.shelly.android.features.settings

import androidx.compose.foundation.layout.Spacer
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import app.shelly.android.ui.components.SettingsFooterAction
import app.shelly.android.ui.components.SettingsGlyph
import app.shelly.android.ui.components.SettingsHeroBody
import app.shelly.android.ui.components.SettingsListRow
import app.shelly.android.ui.components.ShellyScreen

@Composable
fun DaemonDetailScreen(
    onBack: () -> Unit,
    hostName: String = "your laptop",
    pairedAge: String = "14d",
    daemon: String = "shellyd 1.0.0",
    protocol: String = "v3",
    transport: String = "iroh QUIC",
    onOpenDaemon: () -> Unit = {},
    onOpenProtocol: () -> Unit = {},
    onOpenTransport: () -> Unit = {},
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
    onOpenDaemon: () -> Unit,
    onOpenProtocol: () -> Unit,
    onOpenTransport: () -> Unit,
    onUnpair: () -> Unit,
) {
    ShellyScreen(
        hero = {
            SettingsHeroBody(
                eyebrow = "THE LAPTOP THIS PHONE\nIS PAIRED WITH",
                wordmark = "NODE",
                status = "$hostName · paired $pairedAge",
                statusGlyph = SettingsGlyph.Monitor,
                backLabel = "Settings",
                onBack = onBack,
            )
        },
        content = {
            SettingsListRow("Daemon", daemon, onClick = onOpenDaemon)
            SettingsListRow("Protocol", protocol, onClick = onOpenProtocol)
            SettingsListRow("Transport", transport, showDivider = false, onClick = onOpenTransport)
            Spacer(Modifier.weight(1f))
            SettingsFooterAction("Unpair this device", onClick = onUnpair)
        },
    )
}

@Composable
internal fun DaemonDetailContentPreview() {
    DaemonDetailContent(
        onBack = {},
        hostName = "macbook-pro",
        pairedAge = "14d",
        daemon = "shellyd 1.0.0",
        protocol = "v3",
        transport = "iroh QUIC",
        onOpenDaemon = {},
        onOpenProtocol = {},
        onOpenTransport = {},
        onUnpair = {},
    )
}
