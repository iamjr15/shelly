package app.shelly.android.features.settings

import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import app.shelly.android.ui.components.SettingsGlyph
import app.shelly.android.ui.components.SettingsHeroBody
import app.shelly.android.ui.components.SettingsListRow
import app.shelly.android.ui.components.ShellyScreen

internal val defaultLicenseRows = listOf(
    "Shelly" to "AGPL-3.0-or-later",
    "AndroidX" to "Apache-2.0",
    "Firebase Android SDK" to "Apache-2.0",
    "CameraX" to "Apache-2.0",
    "ML Kit Barcode Scanning" to "Apache-2.0",
    "Java Native Access (JNA)" to "Apache-2.0 OR LGPL-2.1-or-later",
    "kotlinx.coroutines" to "Apache-2.0",
    "ConnectBot termlib" to "Apache-2.0",
    "iroh" to "MIT OR Apache-2.0",
    "tokio" to "MIT",
    "UniFFI" to "MPL-2.0",
    "wezterm-term" to "MIT",
    "portable-pty" to "MIT",
    "redb" to "MIT OR Apache-2.0",
    "serde" to "MIT OR Apache-2.0",
    "rustls" to "Apache-2.0 OR ISC OR MIT",
)

internal val licenseDependencyCount = "${defaultLicenseRows.size} notices"

@Composable
fun LicensesScreen(
    onBack: () -> Unit,
    dependencyCount: String = licenseDependencyCount,
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
                onBack = onBack,
            )
        },
        content = {
            LazyColumn(Modifier.fillMaxSize()) {
                itemsIndexed(rows) { index, row ->
                    SettingsListRow(
                        title = row.first,
                        value = row.second,
                        showDivider = index != rows.lastIndex,
                        onClick = { onOpenLicense(row.first) },
                    )
                }
            }
        },
    )
}
