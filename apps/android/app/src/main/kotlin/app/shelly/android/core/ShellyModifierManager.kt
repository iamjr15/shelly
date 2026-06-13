package app.shelly.android.core

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import org.connectbot.terminal.ModifierManager

class ShellyModifierManager : ModifierManager {
    var ctrl by mutableStateOf(false)
        private set
    var alt by mutableStateOf(false)
        private set
    var shift by mutableStateOf(false)
        private set

    fun toggleCtrl() {
        ctrl = !ctrl
    }

    fun toggleAlt() {
        alt = !alt
    }

    fun toggleShift() {
        shift = !shift
    }

    override fun isCtrlActive(): Boolean = ctrl
    override fun isAltActive(): Boolean = alt
    override fun isShiftActive(): Boolean = shift

    override fun clearTransients() {
        ctrl = false
        alt = false
        shift = false
    }
}
