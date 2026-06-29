package app.shelly.android.ui

import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue

/**
 * Compose-observable mirror of [ShellyUiPreferences]. Every value is read once at construction
 * into snapshot state; each cycle/toggle updates the state var (so the UI recomposes) and writes
 * straight back through to disk (so the choice survives process death). Construct one per
 * [ShellyUiPreferences] and remember it for the app's lifetime.
 */
@Stable
internal class ShellySettings(private val prefs: ShellyUiPreferences) {
    var themeMode by mutableStateOf(prefs.readThemeMode())
        private set
    var textSize by mutableStateOf(prefs.readTextSize())
        private set
    var reduceMotion by mutableStateOf(prefs.readReduceMotion())
        private set
    var autoLock by mutableStateOf(prefs.readAutoLock())
        private set
    var biometricLock by mutableStateOf(prefs.readBiometricLock())
        private set
    var blockOnBackground by mutableStateOf(prefs.readBlockOnBackground())
        private set
    var pushEnabled by mutableStateOf(prefs.readPushEnabled())
        private set
    var notifyAwaitingInput by mutableStateOf(prefs.readNotifyAwaitingInput())
        private set
    var notifySessionCrashed by mutableStateOf(prefs.readNotifySessionCrashed())
        private set
    var notifyBuildFinished by mutableStateOf(prefs.readNotifyBuildFinished())
        private set
    var quietHours by mutableStateOf(prefs.readQuietHours())
        private set

    fun cycleTheme() {
        val next = themeMode.next()
        themeMode = next
        prefs.writeThemeMode(next)
    }

    fun cycleTextSize() {
        val next = textSize.next()
        textSize = next
        prefs.writeTextSize(next)
    }

    fun toggleReduceMotion() {
        val next = !reduceMotion
        reduceMotion = next
        prefs.writeReduceMotion(next)
    }

    fun cycleAutoLock() {
        val next = autoLock.next()
        autoLock = next
        prefs.writeAutoLock(next)
    }

    fun toggleBiometricLock() {
        val next = !biometricLock
        biometricLock = next
        prefs.writeBiometricLock(next)
    }

    fun toggleBlockOnBackground() {
        val next = !blockOnBackground
        blockOnBackground = next
        prefs.writeBlockOnBackground(next)
    }

    fun togglePush() {
        val next = !pushEnabled
        pushEnabled = next
        prefs.writePushEnabled(next)
    }

    fun toggleNotifyAwaiting() {
        val next = !notifyAwaitingInput
        notifyAwaitingInput = next
        prefs.writeNotifyAwaitingInput(next)
    }

    fun toggleNotifySessionCrashed() {
        val next = !notifySessionCrashed
        notifySessionCrashed = next
        prefs.writeNotifySessionCrashed(next)
    }

    fun toggleNotifyBuildFinished() {
        val next = !notifyBuildFinished
        notifyBuildFinished = next
        prefs.writeNotifyBuildFinished(next)
    }

    fun cycleQuietHours() {
        val next = quietHours.next()
        quietHours = next
        prefs.writeQuietHours(next)
    }
}
