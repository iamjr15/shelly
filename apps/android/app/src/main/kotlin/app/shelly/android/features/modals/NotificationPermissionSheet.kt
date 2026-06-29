package app.shelly.android.features.modals

import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier

@Composable
fun NotificationPermissionSheet(
    modifier: Modifier = Modifier,
    onConfirm: () -> Unit = {},
    onDismiss: () -> Unit = {},
) {
    ShellyModalCard(
        kicker = "WHILE YOU'RE AWAY",
        title = "PINGS",
        meta = "names stay on your laptop",
        body = "Get a ping when a session needs you or\nfinishes — even when Shelly is closed.",
        primary = "Enable notifications",
        secondary = "Maybe later",
        onConfirm = onConfirm,
        onDismiss = onDismiss,
        modifier = modifier,
    )
}

@Composable
internal fun NotificationPermissionSheetPreview() {
    ModalPreviewScaffold {
        NotificationPermissionSheet()
    }
}
