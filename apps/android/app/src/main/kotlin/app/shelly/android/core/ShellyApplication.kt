package app.shelly.android.core

import android.app.Application
import android.os.StrictMode
import app.shelly.android.BuildConfig
import app.shelly.android.push.FcmTokenRegistrar
import app.shelly.android.ui.ShellyUiPreferences
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

class ShellyApplication : Application() {
    private val applicationScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val preferencesReady = CompletableDeferred<Unit>()

    override fun onCreate() {
        super.onCreate()
        if (BuildConfig.DEBUG) {
            StrictMode.setThreadPolicy(
                StrictMode.ThreadPolicy.Builder()
                    .detectDiskReads()
                    .detectDiskWrites()
                    .penaltyLog()
                    .build(),
            )
        }
        applicationScope.launch {
            try {
                PairingStore(applicationContext).warm()
                FcmTokenRegistrar.warm(applicationContext)
                ShellyUiPreferences.warm(applicationContext)
                MobileTelemetry.warm(applicationContext)
            } catch (error: Throwable) {
                debugLog("preference warm-up failed", error, "ShellyApplication")
            } finally {
                preferencesReady.complete(Unit)
            }
        }
    }

    suspend fun awaitPreferencesReady() {
        preferencesReady.await()
    }
}
