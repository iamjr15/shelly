package app.shelly.android.features.settings

import androidx.compose.runtime.Composable
import app.shelly.android.ui.components.SettingsGlyph
import app.shelly.android.ui.components.SettingsHeroBody
import app.shelly.android.ui.components.SettingsListRow
import app.shelly.android.ui.components.ShellyScreen

@Composable
fun AppearanceScreen(
    onBack: () -> Unit,
    themeModeLabel: String = "System",
    onOpenTheme: () -> Unit = {},
    onOpenAccent: () -> Unit = {},
    onOpenCodeFont: () -> Unit = {},
    onOpenTextSize: () -> Unit = {},
    onOpenReduceMotion: () -> Unit = {},
) {
    AppearanceContent(
        onBack = onBack,
        themeModeLabel = themeModeLabel,
        onOpenTheme = onOpenTheme,
        onOpenAccent = onOpenAccent,
        onOpenCodeFont = onOpenCodeFont,
        onOpenTextSize = onOpenTextSize,
        onOpenReduceMotion = onOpenReduceMotion,
    )
}

@Composable
private fun AppearanceContent(
    onBack: () -> Unit,
    themeModeLabel: String,
    onOpenTheme: () -> Unit,
    onOpenAccent: () -> Unit,
    onOpenCodeFont: () -> Unit,
    onOpenTextSize: () -> Unit,
    onOpenReduceMotion: () -> Unit,
) {
    ShellyScreen(
        hero = {
            SettingsHeroBody(
                eyebrow = "HOW SHELLY LOOKS\nON THIS PHONE",
                wordmark = "LOOK",
                status = "following the system theme",
                statusGlyph = SettingsGlyph.HalfCircle,
                backLabel = "Settings",
                onBack = onBack,
            )
        },
        content = {
            SettingsListRow("Theme", themeModeLabel, onClick = onOpenTheme)
            SettingsListRow("Accent", "Safety orange", onClick = onOpenAccent)
            SettingsListRow("Code font", "JetBrains Mono", onClick = onOpenCodeFont)
            SettingsListRow("Text size", "Default", onClick = onOpenTextSize)
            SettingsListRow("Reduce motion", "Off", showDivider = false, onClick = onOpenReduceMotion)
        },
    )
}

@Composable
internal fun AppearanceContentPreview() {
    AppearanceContent(
        onBack = {},
        themeModeLabel = "System",
        onOpenTheme = {},
        onOpenAccent = {},
        onOpenCodeFont = {},
        onOpenTextSize = {},
        onOpenReduceMotion = {},
    )
}
