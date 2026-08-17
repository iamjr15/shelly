package app.shelly.android.features.modals

import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import app.shelly.android.core.ShellyAlertMessage

@Composable
fun AlertSheet(
    message: ShellyAlertMessage,
    modifier: Modifier = Modifier,
    onConfirm: () -> Unit = {},
    onDismiss: () -> Unit = {},
) {
    ShellyModalCard(
        kicker = message.kicker,
        title = message.title,
        meta = message.meta,
        body = message.body,
        primary = message.primary,
        secondary = message.secondary,
        onConfirm = onConfirm,
        onDismiss = onDismiss,
        modifier = modifier,
        warning = true,
    )
}
