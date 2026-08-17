package app.shelly.android.features.settings

import androidx.compose.runtime.Composable
import androidx.compose.ui.res.stringResource
import app.shelly.android.R
import app.shelly.android.ui.components.SettingsGlyph
import app.shelly.android.ui.components.SettingsHeroBody
import app.shelly.android.ui.components.SettingsListRow
import app.shelly.android.ui.components.ShellyScreen

@Composable
fun AppearanceScreen(
    onBack: () -> Unit,
    themeModeLabel: String = "System",
    textSizeLabel: String = "Default",
    reduceMotionOn: Boolean = false,
    onOpenTheme: () -> Unit = {},
    onOpenTextSize: () -> Unit = {},
    onToggleReduceMotion: () -> Unit = {},
) {
    AppearanceContent(
        onBack = onBack,
        themeModeLabel = themeModeLabel,
        textSizeLabel = textSizeLabel,
        reduceMotionOn = reduceMotionOn,
        onOpenTheme = onOpenTheme,
        onOpenTextSize = onOpenTextSize,
        onToggleReduceMotion = onToggleReduceMotion,
    )
}

@Composable
private fun AppearanceContent(
    onBack: () -> Unit,
    themeModeLabel: String,
    textSizeLabel: String,
    reduceMotionOn: Boolean,
    onOpenTheme: () -> Unit,
    onOpenTextSize: () -> Unit,
    onToggleReduceMotion: () -> Unit,
) {
    val onLabel = stringResource(R.string.state_on)
    val offLabel = stringResource(R.string.state_off)
    ShellyScreen(
        hero = {
            SettingsHeroBody(
                eyebrow = "HOW SHELLY LOOKS\nON THIS PHONE",
                wordmark = "LOOK",
                status = when (themeModeLabel.lowercase()) {
                    "light" -> "always light"
                    "dark" -> "always dark"
                    else -> "following the system theme"
                },
                statusGlyph = SettingsGlyph.HalfCircle,
                onBack = onBack,
            )
        },
        content = {
            SettingsListRow("Theme", themeModeLabel, onClick = onOpenTheme)
            SettingsListRow("Text size", textSizeLabel, onClick = onOpenTextSize)
            SettingsListRow(
                "Reduce motion",
                if (reduceMotionOn) onLabel else offLabel,
                showDivider = false,
                onClick = onToggleReduceMotion,
                toggleState = reduceMotionOn,
            )
        },
    )
}
