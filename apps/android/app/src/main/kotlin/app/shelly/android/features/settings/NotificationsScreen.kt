package app.shelly.android.features.settings

import androidx.compose.runtime.Composable
import app.shelly.android.ui.components.SettingsGlyph
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
    quietHoursLabel: String = "10pm–8am",
    onTogglePush: () -> Unit = {},
    onToggleAwaitingInput: () -> Unit = {},
    onToggleSessionCrashed: () -> Unit = {},
    onToggleBuildFinished: () -> Unit = {},
    onCycleQuietHours: () -> Unit = {},
) {
    NotificationsContent(
        onBack = onBack,
        pushOn = pushOn,
        awaitingInputOn = awaitingInputOn,
        sessionCrashedOn = sessionCrashedOn,
        buildFinishedOn = buildFinishedOn,
        quietHoursLabel = quietHoursLabel,
        onTogglePush = onTogglePush,
        onToggleAwaitingInput = onToggleAwaitingInput,
        onToggleSessionCrashed = onToggleSessionCrashed,
        onToggleBuildFinished = onToggleBuildFinished,
        onCycleQuietHours = onCycleQuietHours,
    )
}

@Composable
private fun NotificationsContent(
    onBack: () -> Unit,
    pushOn: Boolean,
    awaitingInputOn: Boolean,
    sessionCrashedOn: Boolean,
    buildFinishedOn: Boolean,
    quietHoursLabel: String,
    onTogglePush: () -> Unit,
    onToggleAwaitingInput: () -> Unit,
    onToggleSessionCrashed: () -> Unit,
    onToggleBuildFinished: () -> Unit,
    onCycleQuietHours: () -> Unit,
) {
    ShellyScreen(
        hero = {
            SettingsHeroBody(
                eyebrow = "WHAT BUZZES YOUR\nPHONE — AND WHEN",
                wordmark = "PINGS",
                status = "push via FCM · ${if (pushOn) "on" else "off"}",
                statusGlyph = SettingsGlyph.Bell,
                backLabel = "Settings",
                onBack = onBack,
            )
        },
        content = {
            SettingsListRow("Push", if (pushOn) "On" else "Off", onClick = onTogglePush)
            SettingsListRow("Awaiting input", if (awaitingInputOn) "On" else "Off", onClick = onToggleAwaitingInput)
            SettingsListRow("Session crashed", if (sessionCrashedOn) "On" else "Off", onClick = onToggleSessionCrashed)
            SettingsListRow("Build finished", if (buildFinishedOn) "On" else "Off", onClick = onToggleBuildFinished)
            SettingsListRow("Quiet hours", quietHoursLabel, showDivider = false, onClick = onCycleQuietHours)
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
        quietHoursLabel = "10pm–8am",
        onTogglePush = {},
        onToggleAwaitingInput = {},
        onToggleSessionCrashed = {},
        onToggleBuildFinished = {},
        onCycleQuietHours = {},
    )
}
