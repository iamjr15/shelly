package app.shelly.android.features.settings

import androidx.compose.runtime.Composable
import app.shelly.android.ui.components.SettingsGlyph
import app.shelly.android.ui.components.SettingsHeroBody
import app.shelly.android.ui.components.SettingsListRow
import app.shelly.android.ui.components.ShellyScreen

@Composable
fun AboutScreen(
    onBack: () -> Unit,
    version: String = "1.0.0",
    build: String = "12834",
    protocol: String = "v3",
    source: String = "GitHub",
    dependencyCount: String = "47 deps",
    onOpenVersion: () -> Unit = {},
    onOpenBuild: () -> Unit = {},
    onOpenProtocol: () -> Unit = {},
    onOpenSource: () -> Unit = {},
    onOpenLicenses: () -> Unit = {},
) {
    AboutContent(
        onBack = onBack,
        version = version,
        build = build,
        protocol = protocol,
        source = source,
        dependencyCount = dependencyCount,
        onOpenVersion = onOpenVersion,
        onOpenBuild = onOpenBuild,
        onOpenProtocol = onOpenProtocol,
        onOpenSource = onOpenSource,
        onOpenLicenses = onOpenLicenses,
    )
}

@Composable
private fun AboutContent(
    onBack: () -> Unit,
    version: String,
    build: String,
    protocol: String,
    source: String,
    dependencyCount: String,
    onOpenVersion: () -> Unit,
    onOpenBuild: () -> Unit,
    onOpenProtocol: () -> Unit,
    onOpenSource: () -> Unit,
    onOpenLicenses: () -> Unit,
) {
    ShellyScreen(
        hero = {
            SettingsHeroBody(
                eyebrow = "THE BUILD RUNNING\nON THIS PHONE",
                wordmark = "ABOUT",
                status = "shelly for android",
                statusGlyph = SettingsGlyph.Phone,
                backLabel = "Settings",
                onBack = onBack,
            )
        },
        content = {
            SettingsListRow("Version", version, onClick = onOpenVersion)
            SettingsListRow("Build", build, onClick = onOpenBuild)
            SettingsListRow("Protocol", protocol, onClick = onOpenProtocol)
            SettingsListRow("Source", source, onClick = onOpenSource)
            SettingsListRow("Licenses", dependencyCount, showDivider = false, onClick = onOpenLicenses)
        },
    )
}

@Composable
internal fun AboutContentPreview() {
    AboutContent(
        onBack = {},
        version = "1.0.0",
        build = "12834",
        protocol = "v3",
        source = "GitHub",
        dependencyCount = "47 deps",
        onOpenVersion = {},
        onOpenBuild = {},
        onOpenProtocol = {},
        onOpenSource = {},
        onOpenLicenses = {},
    )
}
