package app.shelly.android.features.settings

import androidx.compose.runtime.Composable
import app.shelly.android.ui.components.SettingsGlyph
import app.shelly.android.ui.components.SettingsHeroBody
import app.shelly.android.ui.components.SettingsListRow
import app.shelly.android.ui.components.ShellyScreen

@Composable
fun AboutScreen(
    onBack: () -> Unit,
    version: String = "1.0",
    build: String = "1",
    protocol: String = "unknown",
    source: String = "GitHub",
    dependencyCount: String = "Open source",
    onOpenVersion: (() -> Unit)? = null,
    onOpenBuild: (() -> Unit)? = null,
    onOpenProtocol: (() -> Unit)? = null,
    onOpenPrivacy: () -> Unit = {},
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
        onOpenPrivacy = onOpenPrivacy,
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
    onOpenVersion: (() -> Unit)?,
    onOpenBuild: (() -> Unit)?,
    onOpenProtocol: (() -> Unit)?,
    onOpenPrivacy: () -> Unit,
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
                onBack = onBack,
            )
        },
        content = {
            SettingsListRow("Version", version, onClick = onOpenVersion)
            SettingsListRow("Build", build, onClick = onOpenBuild)
            SettingsListRow("Protocol", protocol, onClick = onOpenProtocol)
            SettingsListRow("Privacy & encryption", onClick = onOpenPrivacy)
            SettingsListRow("Source", source, onClick = onOpenSource)
            SettingsListRow("Licenses", dependencyCount, showDivider = false, onClick = onOpenLicenses)
        },
    )
}

@Composable
internal fun AboutContentPreview() {
    AboutContent(
        onBack = {},
        version = "1.0",
        build = "1",
        protocol = "v3",
        source = "GitHub",
        dependencyCount = "16 notices",
        onOpenVersion = null,
        onOpenBuild = null,
        onOpenProtocol = null,
        onOpenPrivacy = {},
        onOpenSource = {},
        onOpenLicenses = {},
    )
}
