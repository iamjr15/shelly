package app.shelly.android.features.settings

import androidx.compose.foundation.layout.Spacer
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import app.shelly.android.ui.components.SettingsFooterAction
import app.shelly.android.ui.components.SettingsGlyph
import app.shelly.android.ui.components.SettingsHeroBody
import app.shelly.android.ui.components.SettingsListRow
import app.shelly.android.ui.components.ShellyScreen

@Composable
fun SecurityScreen(
    onBack: () -> Unit,
    telemetryEnabled: Boolean = false,
    onOpenBiometricLock: () -> Unit = {},
    onOpenAutoLock: () -> Unit = {},
    onOpenScrollback: () -> Unit = {},
    onOpenBlockOnBackground: () -> Unit = {},
    onOpenTelemetry: () -> Unit = {},
    onRevokeAllKeys: () -> Unit = {},
) {
    SecurityContent(
        onBack = onBack,
        telemetryEnabled = telemetryEnabled,
        onOpenBiometricLock = onOpenBiometricLock,
        onOpenAutoLock = onOpenAutoLock,
        onOpenScrollback = onOpenScrollback,
        onOpenBlockOnBackground = onOpenBlockOnBackground,
        onOpenTelemetry = onOpenTelemetry,
        onRevokeAllKeys = onRevokeAllKeys,
    )
}

@Composable
private fun SecurityContent(
    onBack: () -> Unit,
    telemetryEnabled: Boolean,
    onOpenBiometricLock: () -> Unit,
    onOpenAutoLock: () -> Unit,
    onOpenScrollback: () -> Unit,
    onOpenBlockOnBackground: () -> Unit,
    onOpenTelemetry: () -> Unit,
    onRevokeAllKeys: () -> Unit,
) {
    ShellyScreen(
        hero = {
            SettingsHeroBody(
                eyebrow = "KEYS, LOCKS, AND WHAT\nTHIS PHONE CAN SEE",
                wordmark = "GUARD",
                status = "biometric lock is on",
                statusGlyph = SettingsGlyph.Fingerprint,
                backLabel = "Settings",
                onBack = onBack,
            )
        },
        content = {
            SettingsListRow("Biometric lock", "On", onClick = onOpenBiometricLock)
            SettingsListRow("Auto-lock", "5 min", onClick = onOpenAutoLock)
            SettingsListRow("Scrollback", "Encrypted", onClick = onOpenScrollback)
            SettingsListRow("Block on background", "On", onClick = onOpenBlockOnBackground)
            SettingsListRow(
                "Telemetry",
                if (telemetryEnabled) "On" else "Off",
                showDivider = false,
                onClick = onOpenTelemetry,
            )
            Spacer(Modifier.weight(1f))
            SettingsFooterAction("Revoke all keys", onClick = onRevokeAllKeys)
        },
    )
}

@Composable
internal fun SecurityContentPreview() {
    SecurityContent(
        onBack = {},
        telemetryEnabled = false,
        onOpenBiometricLock = {},
        onOpenAutoLock = {},
        onOpenScrollback = {},
        onOpenBlockOnBackground = {},
        onOpenTelemetry = {},
        onRevokeAllKeys = {},
    )
}
