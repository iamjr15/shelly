package app.shelly.android.features.settings

import androidx.compose.runtime.Composable
import androidx.compose.ui.res.stringResource
import app.shelly.android.R
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
    val onLabel = stringResource(R.string.state_on)
    val offLabel = stringResource(R.string.state_off)
    ShellyScreen(
        hero = {
            SettingsHeroBody(
                eyebrow = "WHAT BUZZES YOUR\nPHONE — AND WHEN",
                wordmark = "PINGS",
                onBack = onBack,
            )
        },
        content = {
            SettingsListRow("Push", if (pushOn) onLabel else offLabel, onClick = onTogglePush, toggleState = pushOn)
            SettingsListRow("Awaiting input", if (awaitingInputOn) onLabel else offLabel, onClick = onToggleAwaitingInput, toggleState = awaitingInputOn)
            SettingsListRow("Session crashed", if (sessionCrashedOn) onLabel else offLabel, onClick = onToggleSessionCrashed, toggleState = sessionCrashedOn)
            SettingsListRow(
                "Build finished",
                if (buildFinishedOn) onLabel else offLabel,
                showDivider = false,
                onClick = onToggleBuildFinished,
                toggleState = buildFinishedOn,
            )
        },
    )
}
