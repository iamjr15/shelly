package app.shelly.android.features.modals

import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color

@Composable
fun UnpairSheet(
    modifier: Modifier = Modifier,
    onConfirm: () -> Unit = {},
    onDismiss: () -> Unit = {},
) {
    ShellyModalCard(
        kicker = "THIS CANNOT BE UNDONE",
        title = "DROP",
        meta = "node_01k9c4f3hg · paired 14d",
        body = "Keys for this phone are erased and all 6\nlive sessions detach. Pairing again needs\na fresh QR from your laptop.",
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
        UnpairSheet()
    }
}
