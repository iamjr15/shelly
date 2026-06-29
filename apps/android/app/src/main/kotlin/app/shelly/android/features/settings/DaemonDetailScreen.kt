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
    nodeId: String = "node_01k9c4f3hg",
    pairedAge: String = "14d",
    host: String = "your laptop",
    daemon: String = "shellyd 1.0.0",
    protocol: String = "v3",
    transport: String = "iroh QUIC",
    lastSeen: String = "just now",
    onOpenHost: () -> Unit = {},
    onOpenDaemon: () -> Unit = {},
    onOpenProtocol: () -> Unit = {},
    onOpenTransport: () -> Unit = {},
    onOpenLastSeen: () -> Unit = {},
    onUnpair: () -> Unit = {},
) {
    DaemonDetailContent(
        onBack = onBack,
        nodeId = nodeId,
        pairedAge = pairedAge,
        host = host,
        daemon = daemon,
        protocol = protocol,
        transport = transport,
        lastSeen = lastSeen,
        onOpenHost = onOpenHost,
        onOpenDaemon = onOpenDaemon,
        onOpenProtocol = onOpenProtocol,
        onOpenTransport = onOpenTransport,
        onOpenLastSeen = onOpenLastSeen,
        onUnpair = onUnpair,
    )
}

@Composable
private fun DaemonDetailContent(
    onBack: () -> Unit,
    nodeId: String,
    pairedAge: String,
    host: String,
    daemon: String,
    protocol: String,
    transport: String,
    lastSeen: String,
    onOpenHost: () -> Unit,
    onOpenDaemon: () -> Unit,
    onOpenProtocol: () -> Unit,
    onOpenTransport: () -> Unit,
    onOpenLastSeen: () -> Unit,
    onUnpair: () -> Unit,
) {
    ShellyScreen(
        hero = {
            SettingsHeroBody(
                eyebrow = "THE LAPTOP THIS PHONE\nIS PAIRED WITH",
                wordmark = "NODE",
                status = "$nodeId · paired $pairedAge",
                statusGlyph = SettingsGlyph.Monitor,
                backLabel = "Settings",
                onBack = onBack,
            )
        },
        content = {
            SettingsListRow("Host", host, onClick = onOpenHost)
            SettingsListRow("Daemon", daemon, onClick = onOpenDaemon)
            SettingsListRow("Protocol", protocol, onClick = onOpenProtocol)
            SettingsListRow("Transport", transport, onClick = onOpenTransport)
            SettingsListRow("Last seen", lastSeen, showDivider = false, onClick = onOpenLastSeen)
            Spacer(Modifier.weight(1f))
            SettingsFooterAction("Unpair this device", onClick = onUnpair)
        },
    )
}

@Composable
internal fun DaemonDetailContentPreview() {
    DaemonDetailContent(
        onBack = {},
        nodeId = "node_01k9c4f3hg",
        pairedAge = "14d",
        host = "macbook-pro",
        daemon = "shellyd 1.0.0",
        protocol = "v3",
        transport = "iroh QUIC",
        lastSeen = "just now",
        onOpenHost = {},
        onOpenDaemon = {},
        onOpenProtocol = {},
        onOpenTransport = {},
        onOpenLastSeen = {},
        onUnpair = {},
    )
}
