package app.shelly.android.features.modals

import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import app.shelly.android.R

@Composable
fun UnpairSheet(
    modifier: Modifier = Modifier,
    daemonLabel: String = "this computer",
    liveSessions: Int = 0,
    onConfirm: () -> Unit = {},
    onDismiss: () -> Unit = {},
) {
    val unpairLabel = stringResource(R.string.unpair_this_device)
    val body = when (liveSessions) {
        0 -> "Keys for this phone are erased and Shelly\ndisconnects. Pairing again needs a fresh\ncode from your computer."
        1 -> "Keys for this phone are erased and the one\nlive session detaches. Pairing again needs\na fresh code from your computer."
        else -> "Keys for this phone are erased and all $liveSessions\nlive sessions detach. Pairing again needs\na fresh code from your computer."
    }
    ShellyModalCard(
        kicker = "THIS CANNOT BE UNDONE",
        title = "DROP",
        meta = daemonLabel,
        body = body,
        primary = unpairLabel,
        secondary = "Keep it paired",
        onConfirm = onConfirm,
        onDismiss = onDismiss,
        modifier = modifier,
        warning = true,
        destructive = true,
        primaryIcon = { TrashIcon(color = Color.White) },
    )
}
