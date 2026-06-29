package app.shelly.android.features.settings

import androidx.compose.runtime.Composable
import app.shelly.android.ui.components.SettingsGlyph
import app.shelly.android.ui.components.SettingsHeroBody
import app.shelly.android.ui.components.SettingsListRow
import app.shelly.android.ui.components.ShellyScreen

@Composable
fun NotificationsScreen(
    onBack: () -> Unit,
    onOpenPush: () -> Unit = {},
    onOpenAwaitingInput: () -> Unit = {},
    onOpenSessionCrashed: () -> Unit = {},
    onOpenBuildFinished: () -> Unit = {},
    onOpenQuietHours: () -> Unit = {},
) {
    NotificationsContent(
        onBack = onBack,
        onOpenPush = onOpenPush,
        onOpenAwaitingInput = onOpenAwaitingInput,
        onOpenSessionCrashed = onOpenSessionCrashed,
        onOpenBuildFinished = onOpenBuildFinished,
        onOpenQuietHours = onOpenQuietHours,
    )
}

@Composable
private fun NotificationsContent(
    onBack: () -> Unit,
    onOpenPush: () -> Unit,
    onOpenAwaitingInput: () -> Unit,
    onOpenSessionCrashed: () -> Unit,
    onOpenBuildFinished: () -> Unit,
    onOpenQuietHours: () -> Unit,
) {
    ShellyScreen(
        hero = {
            SettingsHeroBody(
                eyebrow = "WHAT BUZZES YOUR\nPHONE — AND WHEN",
                wordmark = "PINGS",
                status = "push via FCM · on",
                statusGlyph = SettingsGlyph.Bell,
                backLabel = "Settings",
                onBack = onBack,
            )
        },
        content = {
            SettingsListRow("Push", "On", onClick = onOpenPush)
            SettingsListRow("Awaiting input", "On", onClick = onOpenAwaitingInput)
            SettingsListRow("Session crashed", "On", onClick = onOpenSessionCrashed)
            SettingsListRow("Build finished", "Off", onClick = onOpenBuildFinished)
            SettingsListRow("Quiet hours", "10pm–8am", showDivider = false, onClick = onOpenQuietHours)
        },
    )
}

@Composable
internal fun NotificationsContentPreview() {
    NotificationsContent(
        onBack = {},
        onOpenPush = {},
        onOpenAwaitingInput = {},
        onOpenSessionCrashed = {},
        onOpenBuildFinished = {},
        onOpenQuietHours = {},
    )
}
