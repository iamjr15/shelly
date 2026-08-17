package app.shelly.android

import android.Manifest
import android.content.Intent
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.view.WindowManager
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.createSavedStateHandle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.CreationExtras
import app.shelly.android.core.AndroidBiometricGate
import app.shelly.android.core.ShellyViewModel
import app.shelly.android.core.MobileTelemetry
import app.shelly.android.core.ShellyApplication
import app.shelly.android.push.ShellyPushNotifications
import app.shelly.android.ui.ShellyApp
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.launch

class MainActivity : FragmentActivity() {
    private val pushSessionHashes = MutableSharedFlow<String>(replay = 1, extraBufferCapacity = 8)
    private var pushIntentConsumed = false
    private var contentReady = false
    private val requestNotifications =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) {}

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.setFlags(
            WindowManager.LayoutParams.FLAG_SECURE,
            WindowManager.LayoutParams.FLAG_SECURE,
        )
        enableEdgeToEdge()
        MobileTelemetry.sync(applicationContext)
        ShellyPushNotifications.ensureChannels(this)
        pushIntentConsumed = savedInstanceState?.getBoolean(PUSH_INTENT_CONSUMED_KEY) == true

        lifecycleScope.launch {
            (application as? ShellyApplication)?.awaitPreferencesReady()
            setContent {
                val biometricGate = remember { AndroidBiometricGate(this@MainActivity) }
                val viewModel: ShellyViewModel = viewModel(
                    factory = remember { shellyViewModelFactory(applicationContext) },
                )
                LaunchedEffect(viewModel) {
                    consumePushSessionHash(intent)?.let(viewModel::handlePushIntent)
                    pushSessionHashes.collect(viewModel::handlePushIntent)
                }
                ShellyApp(
                    viewModel = viewModel,
                    biometricGate = biometricGate,
                    shouldRequestNotifications = { shouldRequestNotificationPermission() },
                    onRequestNotifications = {
                        ShellyPushNotifications.requestPermissionIfNeeded(this@MainActivity, requestNotifications)
                    },
                )
            }
            contentReady = true
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        pushIntentConsumed = false
        if (contentReady) {
            consumePushSessionHash(intent)?.let(pushSessionHashes::tryEmit)
        }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        outState.putBoolean(PUSH_INTENT_CONSUMED_KEY, pushIntentConsumed)
        super.onSaveInstanceState(outState)
    }

    private fun consumePushSessionHash(intent: Intent): String? {
        if (pushIntentConsumed) {
            return null
        }
        pushIntentConsumed = true
        val hash = ShellyPushNotifications.sessionIdHash(intent) ?: return null
        intent.removeExtra(ShellyPushNotifications.EXTRA_SESSION_ID_HASH)
        return hash
    }

    private companion object {
        const val PUSH_INTENT_CONSUMED_KEY = "shelly_push_intent_consumed"
    }
}

private fun MainActivity.shouldRequestNotificationPermission(): Boolean =
    Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
        ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) !=
        PackageManager.PERMISSION_GRANTED

private fun shellyViewModelFactory(context: Context): ViewModelProvider.Factory {
    val appContext = context.applicationContext
    return object : ViewModelProvider.Factory {
        @Suppress("UNCHECKED_CAST")
        override fun <T : ViewModel> create(modelClass: Class<T>): T {
            if (modelClass.isAssignableFrom(ShellyViewModel::class.java)) {
                return ShellyViewModel(appContext) as T
            }
            throw IllegalArgumentException("Unknown ViewModel class ${modelClass.name}")
        }

        @Suppress("UNCHECKED_CAST")
        override fun <T : ViewModel> create(modelClass: Class<T>, extras: CreationExtras): T {
            if (modelClass.isAssignableFrom(ShellyViewModel::class.java)) {
                return ShellyViewModel(appContext, extras.createSavedStateHandle()) as T
            }
            throw IllegalArgumentException("Unknown ViewModel class ${modelClass.name}")
        }
    }
}
