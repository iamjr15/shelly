package app.shelly.android.ui

import android.content.Context
import android.content.SharedPreferences

internal enum class ShellyThemeMode(val storageValue: String, val label: String) {
    System("system", "System"),
    Light("light", "Light"),
    Dark("dark", "Dark"),
    ;

    fun next(): ShellyThemeMode = when (this) {
        System -> Light
        Light -> Dark
        Dark -> System
    }

    fun resolvedDark(systemDark: Boolean): Boolean = when (this) {
        System -> systemDark
        Light -> false
        Dark -> true
    }

    companion object {
        fun fromStorage(value: String?): ShellyThemeMode =
            entries.firstOrNull { it.storageValue == value } ?: System
    }
}

/** Global text scale applied to the whole UI via [androidx.compose.ui.platform.LocalDensity]. */
internal enum class ShellyTextSize(val storageValue: String, val label: String, val scale: Float) {
    Small("small", "Small", 0.9f),
    Default("default", "Default", 1.0f),
    Large("large", "Large", 1.15f),
    Huge("huge", "Huge", 1.3f),
    ;

    fun next(): ShellyTextSize = entries[(ordinal + 1) % entries.size]

    companion object {
        fun fromStorage(value: String?): ShellyTextSize =
            entries.firstOrNull { it.storageValue == value } ?: Default
    }
}

/** Idle timeout after which the app re-locks behind the biometric gate. */
internal enum class ShellyAutoLock(val storageValue: String, val label: String, val millis: Long) {
    Immediately("immediately", "Immediately", 0L),
    OneMinute("1m", "1 min", 60_000L),
    FiveMinutes("5m", "5 min", 5L * 60_000L),
    FifteenMinutes("15m", "15 min", 15L * 60_000L),
    OneHour("1h", "1 hour", 60L * 60_000L),
    Never("never", "Never", Long.MAX_VALUE),
    ;

    fun next(): ShellyAutoLock = entries[(ordinal + 1) % entries.size]

    companion object {
        fun fromStorage(value: String?): ShellyAutoLock =
            entries.firstOrNull { it.storageValue == value } ?: FiveMinutes
    }
}

/** Window during which local notifications are suppressed. Hours are 0–23, end is exclusive. */
internal enum class ShellyQuietHours(
    val storageValue: String,
    val label: String,
    val startHour: Int,
    val endHour: Int,
) {
    Off("off", "Off", -1, -1),
    TenToEight("22-08", "10pm–8am", 22, 8),
    ElevenToSeven("23-07", "11pm–7am", 23, 7),
    MidnightToNine("00-09", "12am–9am", 0, 9),
    ;

    fun next(): ShellyQuietHours = entries[(ordinal + 1) % entries.size]

    /** True if [hour] (0–23) falls inside this quiet window (handles midnight wraparound). */
    fun contains(hour: Int): Boolean = when {
        this == Off -> false
        startHour <= endHour -> hour in startHour until endHour
        else -> hour >= startHour || hour < endHour
    }

    companion object {
        fun fromStorage(value: String?): ShellyQuietHours =
            entries.firstOrNull { it.storageValue == value } ?: TenToEight
    }
}

internal enum class ShellyRoute {
    Sessions,
    Settings,
    Appearance,
    Notifications,
    Security,
    Privacy,
    About,
    DaemonDetail,
    Licenses,
    OpenSourceLicenses,
    SessionsGrouped,
    SessionsReconnecting,
    SessionsDaemonUnreachable,
}

internal enum class ShellyOnboardingStep {
    Welcome,
    HowItWorks,
    Privacy,
    GetStarted,
}

/**
 * Local, on-device UI preferences. Backed by a single SharedPreferences file; every setting is
 * read once into Compose state at launch and written back immediately on change (see ShellyApp).
 */
internal class ShellyUiPreferences(context: Context) {
    private val prefs: SharedPreferences =
        context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    fun readThemeMode(): ShellyThemeMode =
        ShellyThemeMode.fromStorage(prefs.getString(KEY_THEME_MODE, null))

    fun writeThemeMode(mode: ShellyThemeMode) {
        prefs.edit().putString(KEY_THEME_MODE, mode.storageValue).apply()
    }

    fun readTextSize(): ShellyTextSize =
        ShellyTextSize.fromStorage(prefs.getString(KEY_TEXT_SIZE, null))

    fun writeTextSize(size: ShellyTextSize) {
        prefs.edit().putString(KEY_TEXT_SIZE, size.storageValue).apply()
    }

    fun readReduceMotion(): Boolean = prefs.getBoolean(KEY_REDUCE_MOTION, false)

    fun writeReduceMotion(enabled: Boolean) {
        prefs.edit().putBoolean(KEY_REDUCE_MOTION, enabled).apply()
    }

    fun readAutoLock(): ShellyAutoLock =
        ShellyAutoLock.fromStorage(prefs.getString(KEY_AUTO_LOCK, null))

    fun writeAutoLock(value: ShellyAutoLock) {
        prefs.edit().putString(KEY_AUTO_LOCK, value.storageValue).apply()
    }

    fun readBiometricLock(): Boolean = prefs.getBoolean(KEY_BIOMETRIC_LOCK, true)

    fun writeBiometricLock(enabled: Boolean) {
        prefs.edit().putBoolean(KEY_BIOMETRIC_LOCK, enabled).apply()
    }

    fun readBlockOnBackground(): Boolean = prefs.getBoolean(KEY_BLOCK_ON_BACKGROUND, true)

    fun writeBlockOnBackground(enabled: Boolean) {
        prefs.edit().putBoolean(KEY_BLOCK_ON_BACKGROUND, enabled).apply()
    }

    fun readPushEnabled(): Boolean = prefs.getBoolean(KEY_PUSH_ENABLED, true)

    fun writePushEnabled(enabled: Boolean) {
        prefs.edit().putBoolean(KEY_PUSH_ENABLED, enabled).apply()
    }

    fun readNotifyAwaitingInput(): Boolean = prefs.getBoolean(KEY_NOTIFY_AWAITING, true)

    fun writeNotifyAwaitingInput(enabled: Boolean) {
        prefs.edit().putBoolean(KEY_NOTIFY_AWAITING, enabled).apply()
    }

    fun readNotifySessionCrashed(): Boolean = prefs.getBoolean(KEY_NOTIFY_CRASHED, true)

    fun writeNotifySessionCrashed(enabled: Boolean) {
        prefs.edit().putBoolean(KEY_NOTIFY_CRASHED, enabled).apply()
    }

    fun readNotifyBuildFinished(): Boolean = prefs.getBoolean(KEY_NOTIFY_BUILD, false)

    fun writeNotifyBuildFinished(enabled: Boolean) {
        prefs.edit().putBoolean(KEY_NOTIFY_BUILD, enabled).apply()
    }

    fun readQuietHours(): ShellyQuietHours =
        ShellyQuietHours.fromStorage(prefs.getString(KEY_QUIET_HOURS, null))

    fun writeQuietHours(value: ShellyQuietHours) {
        prefs.edit().putString(KEY_QUIET_HOURS, value.storageValue).apply()
    }

    fun readOnboarded(): Boolean = prefs.getBoolean(KEY_ONBOARDED, false)

    fun writeOnboarded(onboarded: Boolean) {
        prefs.edit().putBoolean(KEY_ONBOARDED, onboarded).apply()
    }

    private companion object {
        const val PREFS_NAME = "shelly_ui"
        const val KEY_THEME_MODE = "theme_mode"
        const val KEY_TEXT_SIZE = "text_size"
        const val KEY_REDUCE_MOTION = "reduce_motion"
        const val KEY_AUTO_LOCK = "auto_lock"
        const val KEY_BIOMETRIC_LOCK = "biometric_lock"
        const val KEY_BLOCK_ON_BACKGROUND = "block_on_background"
        const val KEY_PUSH_ENABLED = "push_enabled"
        const val KEY_NOTIFY_AWAITING = "notify_awaiting_input"
        const val KEY_NOTIFY_CRASHED = "notify_session_crashed"
        const val KEY_NOTIFY_BUILD = "notify_build_finished"
        const val KEY_QUIET_HOURS = "quiet_hours"
        const val KEY_ONBOARDED = "onboarded"
    }
}
