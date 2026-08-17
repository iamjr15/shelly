package app.shelly.android.features.settings

import androidx.compose.foundation.layout.Spacer
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import app.shelly.android.R
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
    val onLabel = stringResource(R.string.state_on)
    val offLabel = stringResource(R.string.state_off)
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
            SettingsListRow("Biometric lock", if (biometricLockOn) onLabel else offLabel, onClick = onToggleBiometricLock, toggleState = biometricLockOn)
            SettingsListRow("Auto-lock", autoLockLabel, onClick = onCycleAutoLock)
            SettingsListRow("Block on background", if (blockOnBackgroundOn) onLabel else offLabel, onClick = onToggleBlockOnBackground, toggleState = blockOnBackgroundOn)
            SettingsListRow(
                "Telemetry",
                if (telemetryEnabled) onLabel else offLabel,
                showDivider = false,
                onClick = onToggleTelemetry,
                toggleState = telemetryEnabled,
            )
            Spacer(Modifier.weight(1f))
        },
    )
}
