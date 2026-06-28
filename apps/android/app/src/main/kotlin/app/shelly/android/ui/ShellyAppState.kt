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

internal class ShellyUiPreferences(context: Context) {
    private val prefs: SharedPreferences =
        context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    fun readThemeMode(): ShellyThemeMode =
        ShellyThemeMode.fromStorage(prefs.getString(KEY_THEME_MODE, null))

    fun writeThemeMode(mode: ShellyThemeMode) {
        prefs.edit().putString(KEY_THEME_MODE, mode.storageValue).apply()
    }

    fun readOnboarded(): Boolean = prefs.getBoolean(KEY_ONBOARDED, false)

    fun writeOnboarded(onboarded: Boolean) {
        prefs.edit().putBoolean(KEY_ONBOARDED, onboarded).apply()
    }

    private companion object {
        const val PREFS_NAME = "shelly_ui"
        const val KEY_THEME_MODE = "theme_mode"
        const val KEY_ONBOARDED = "onboarded"
    }
}
