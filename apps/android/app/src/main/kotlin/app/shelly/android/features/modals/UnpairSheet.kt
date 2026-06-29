package app.shelly.android.features.modals

import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color

@Composable
fun UnpairSheet(
    modifier: Modifier = Modifier,
    daemonLabel: String = "this laptop",
    liveSessions: Int = 0,
    onConfirm: () -> Unit = {},
    onDismiss: () -> Unit = {},
) {
    val body = when (liveSessions) {
        0 -> "Keys for this phone are erased and Shelly\ndisconnects. Pairing again needs a fresh\ncode from your laptop."
        1 -> "Keys for this phone are erased and the one\nlive session detaches. Pairing again needs\na fresh code from your laptop."
        else -> "Keys for this phone are erased and all $liveSessions\nlive sessions detach. Pairing again needs\na fresh code from your laptop."
    }
    ShellyModalCard(
        kicker = "THIS CANNOT BE UNDONE",
        title = "DROP",
        meta = daemonLabel,
        body = body,
        primary = "Unpair this device",
        secondary = "Keep it paired",
        onConfirm = onConfirm,
        onDismiss = onDismiss,
        modifier = modifier,
        warning = true,
        destructive = true,
        primaryIcon = { TrashIcon(color = Color.White) },
    )
}

@Composable
internal fun UnpairSheetPreview() {
    ModalPreviewScaffold {
        UnpairSheet(daemonLabel = "6e7a1cdd29b0…", liveSessions = 6)
    }
}
