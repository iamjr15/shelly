package app.shelly.android

import android.content.Intent
import android.content.Context
import android.os.Bundle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewmodel.compose.viewModel
import app.shelly.android.core.AndroidBiometricGate
import app.shelly.android.core.ShellyViewModel
import app.shelly.android.core.MobileTelemetry
import app.shelly.android.push.ShellyPushNotifications
import app.shelly.android.ui.ShellyApp
import kotlinx.coroutines.flow.MutableSharedFlow

class MainActivity : FragmentActivity() {
    private val pushSessionHashes = MutableSharedFlow<String>(extraBufferCapacity = 8)
    private val requestNotifications =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) {}

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        MobileTelemetry.sync(applicationContext)
        ShellyPushNotifications.ensureChannels(this)

        setContent {
            val biometricGate = remember { AndroidBiometricGate(this) }
            val viewModel: ShellyViewModel = viewModel(
                factory = remember { shellyViewModelFactory(applicationContext) },
            )
            LaunchedEffect(viewModel) {
                ShellyPushNotifications.sessionIdHash(intent)?.let(viewModel::handlePushIntent)
                pushSessionHashes.collect(viewModel::handlePushIntent)
            }
            ShellyApp(
                viewModel = viewModel,
                biometricGate = biometricGate,
                onRequestNotifications = {
                    ShellyPushNotifications.requestPermissionIfNeeded(this, requestNotifications)
                },
            )
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        ShellyPushNotifications.sessionIdHash(intent)?.let(pushSessionHashes::tryEmit)
    }
}

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
    }
}
