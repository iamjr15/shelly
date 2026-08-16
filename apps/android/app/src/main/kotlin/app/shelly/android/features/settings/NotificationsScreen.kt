package app.shelly.android.features.settings

import androidx.compose.runtime.Composable
import app.shelly.android.ui.components.SettingsHeroBody
import app.shelly.android.ui.components.SettingsListRow
import app.shelly.android.ui.components.ShellyScreen

@Composable
fun NotificationsScreen(
    onBack: () -> Unit,
    pushOn: Boolean = true,
    awaitingInputOn: Boolean = true,
    sessionCrashedOn: Boolean = true,
    buildFinishedOn: Boolean = false,
    onTogglePush: () -> Unit = {},
    onToggleAwaitingInput: () -> Unit = {},
    onToggleSessionCrashed: () -> Unit = {},
    onToggleBuildFinished: () -> Unit = {},
) {
    NotificationsContent(
        onBack = onBack,
        pushOn = pushOn,
        awaitingInputOn = awaitingInputOn,
        sessionCrashedOn = sessionCrashedOn,
        buildFinishedOn = buildFinishedOn,
        onTogglePush = onTogglePush,
        onToggleAwaitingInput = onToggleAwaitingInput,
        onToggleSessionCrashed = onToggleSessionCrashed,
        onToggleBuildFinished = onToggleBuildFinished,
    )
}

@Composable
private fun NotificationsContent(
    onBack: () -> Unit,
    pushOn: Boolean,
    awaitingInputOn: Boolean,
    sessionCrashedOn: Boolean,
    buildFinishedOn: Boolean,
    onTogglePush: () -> Unit,
    onToggleAwaitingInput: () -> Unit,
    onToggleSessionCrashed: () -> Unit,
    onToggleBuildFinished: () -> Unit,
) {
    ShellyScreen(
        hero = {
            SettingsHeroBody(
                eyebrow = "WHAT BUZZES YOUR\nPHONE — AND WHEN",
                wordmark = "PINGS",
                onBack = onBack,
            )
        },
        content = {
            SettingsListRow("Push", if (pushOn) "On" else "Off", onClick = onTogglePush)
            SettingsListRow("Awaiting input", if (awaitingInputOn) "On" else "Off", onClick = onToggleAwaitingInput)
            SettingsListRow("Session crashed", if (sessionCrashedOn) "On" else "Off", onClick = onToggleSessionCrashed)
            SettingsListRow(
                "Build finished",
                if (buildFinishedOn) "On" else "Off",
                showDivider = false,
                onClick = onToggleBuildFinished,
            )
        },
    )
}

@Composable
internal fun NotificationsContentPreview() {
    NotificationsContent(
        onBack = {},
        pushOn = true,
        awaitingInputOn = true,
        sessionCrashedOn = true,
        buildFinishedOn = false,
        onTogglePush = {},
        onToggleAwaitingInput = {},
        onToggleSessionCrashed = {},
        onToggleBuildFinished = {},
    )
}
