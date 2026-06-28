package app.shelly.android.features.modals

import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier

@Composable
fun TelemetrySheet(
    modifier: Modifier = Modifier,
    onConfirm: () -> Unit = {},
    onDismiss: () -> Unit = {},
) {
    ShellyModalCard(
        kicker = "OPTIONAL · OFF BY DEFAULT",
        title = "STATS",
        meta = "anonymous · never your terminal",
        body = "Counts and timings help us squash bugs.\nNever your commands, paths, or output.",
        primary = "Share anonymous stats",
        secondary = "No thanks",
        onConfirm = onConfirm,
        onDismiss = onDismiss,
        modifier = modifier,
    )
}

@Composable
internal fun TelemetrySheetPreview() {
    ModalPreviewScaffold {
        TelemetrySheet()
    }
}
