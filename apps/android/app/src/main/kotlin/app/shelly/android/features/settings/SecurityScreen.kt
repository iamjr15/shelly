package app.shelly.android.features.settings

import androidx.compose.foundation.layout.Spacer
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import app.shelly.android.ui.components.SettingsGlyph
import app.shelly.android.ui.components.SettingsHeroBody
import app.shelly.android.ui.components.SettingsListRow
import app.shelly.android.ui.components.ShellyScreen

@Composable
fun SecurityScreen(
    onBack: () -> Unit,
    telemetryEnabled: Boolean = false,
    biometricLockOn: Boolean = true,
    autoLockLabel: String = "5 min",
    blockOnBackgroundOn: Boolean = true,
    onToggleBiometricLock: () -> Unit = {},
    onCycleAutoLock: () -> Unit = {},
    onToggleBlockOnBackground: () -> Unit = {},
    onToggleTelemetry: () -> Unit = {},
) {
    SecurityContent(
        onBack = onBack,
        telemetryEnabled = telemetryEnabled,
        biometricLockOn = biometricLockOn,
        autoLockLabel = autoLockLabel,
        blockOnBackgroundOn = blockOnBackgroundOn,
        onToggleBiometricLock = onToggleBiometricLock,
        onCycleAutoLock = onCycleAutoLock,
        onToggleBlockOnBackground = onToggleBlockOnBackground,
        onToggleTelemetry = onToggleTelemetry,
    )
}

@Composable
private fun SecurityContent(
    onBack: () -> Unit,
    telemetryEnabled: Boolean,
    biometricLockOn: Boolean,
    autoLockLabel: String,
    blockOnBackgroundOn: Boolean,
    onToggleBiometricLock: () -> Unit,
    onCycleAutoLock: () -> Unit,
    onToggleBlockOnBackground: () -> Unit,
    onToggleTelemetry: () -> Unit,
) {
    ShellyScreen(
        hero = {
            SettingsHeroBody(
                eyebrow = "KEYS, LOCKS, AND WHAT\nTHIS PHONE CAN SEE",
                wordmark = "GUARD",
                status = if (biometricLockOn) "biometric lock is on" else "biometric lock is off",
                statusGlyph = SettingsGlyph.Fingerprint,
                onBack = onBack,
            )
        },
        content = {
            SettingsListRow("Biometric lock", if (biometricLockOn) "On" else "Off", onClick = onToggleBiometricLock)
            SettingsListRow("Auto-lock", autoLockLabel, onClick = onCycleAutoLock)
            SettingsListRow("Block on background", if (blockOnBackgroundOn) "On" else "Off", onClick = onToggleBlockOnBackground)
            SettingsListRow(
                "Telemetry",
                if (telemetryEnabled) "On" else "Off",
                showDivider = false,
                onClick = onToggleTelemetry,
            )
            Spacer(Modifier.weight(1f))
        },
    )
}

@Composable
internal fun SecurityContentPreview() {
    SecurityContent(
        onBack = {},
        telemetryEnabled = false,
        biometricLockOn = true,
        autoLockLabel = "5 min",
        blockOnBackgroundOn = true,
        onToggleBiometricLock = {},
        onCycleAutoLock = {},
        onToggleBlockOnBackground = {},
        onToggleTelemetry = {},
    )
}
