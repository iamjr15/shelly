package app.shelly.android.features.settings

import androidx.compose.runtime.Composable
import app.shelly.android.ui.components.SettingsGlyph
import app.shelly.android.ui.components.SettingsHeroBody
import app.shelly.android.ui.components.SettingsListRow
import app.shelly.android.ui.components.ShellyScreen

private val defaultLicenseRows = listOf(
    "iroh" to "Apache-2.0",
    "wezterm-term" to "MIT",
    "tokio" to "MIT",
    "ed25519-dalek" to "BSD-3",
    "serde" to "MIT",
)

@Composable
fun LicensesScreen(
    onBack: () -> Unit,
    dependencyCount: String = "47 deps",
    appLicense: String = "AGPL-3.0-or-later",
    rows: List<Pair<String, String>> = defaultLicenseRows,
    onOpenLicense: (String) -> Unit = {},
) {
    LicensesContent(
        onBack = onBack,
        dependencyCount = dependencyCount,
        appLicense = appLicense,
        rows = rows,
        onOpenLicense = onOpenLicense,
    )
}

@Composable
private fun LicensesContent(
    onBack: () -> Unit,
    dependencyCount: String,
    appLicense: String,
    rows: List<Pair<String, String>>,
    onOpenLicense: (String) -> Unit,
) {
    ShellyScreen(
        hero = {
            SettingsHeroBody(
                eyebrow = "THE OPEN SOURCE\nTHIS IS BUILT ON",
                wordmark = "LEGAL",
                status = "$dependencyCount · $appLicense",
                statusGlyph = SettingsGlyph.Package,
                backLabel = "About",
                onBack = onBack,
            )
        },
        content = {
            rows.forEachIndexed { index, row ->
                SettingsListRow(
                    title = row.first,
                    value = row.second,
                    showDivider = index != rows.lastIndex,
                    onClick = { onOpenLicense(row.first) },
                )
            }
        },
    )
}

@Composable
internal fun LicensesContentPreview() {
    LicensesContent(
        onBack = {},
        dependencyCount = "47 deps",
        appLicense = "AGPL-3.0-or-later",
        rows = defaultLicenseRows,
        onOpenLicense = {},
    )
}
