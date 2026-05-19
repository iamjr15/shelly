package app.fieldwork.android

import android.content.Intent
import android.content.Context
import android.os.Bundle
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewmodel.compose.viewModel
import app.fieldwork.android.core.AndroidBiometricGate
import app.fieldwork.android.core.FieldworkViewModel
import app.fieldwork.android.core.MobileTelemetry
import app.fieldwork.android.push.FieldworkPushNotifications
import app.fieldwork.android.ui.FieldworkApp
import kotlinx.coroutines.flow.MutableSharedFlow

class MainActivity : FragmentActivity() {
    private val pushSessionHashes = MutableSharedFlow<String>(extraBufferCapacity = 8)
    private val requestNotifications =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) {}

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        MobileTelemetry.sync(applicationContext)
        FieldworkPushNotifications.ensureChannels(this)

        setContent {
            val biometricGate = remember { AndroidBiometricGate(this) }
            val viewModel: FieldworkViewModel = viewModel(
                factory = remember { fieldworkViewModelFactory(applicationContext) },
            )
            LaunchedEffect(viewModel) {
                FieldworkPushNotifications.sessionIdHash(intent)?.let(viewModel::handlePushIntent)
                pushSessionHashes.collect(viewModel::handlePushIntent)
            }
            FieldworkApp(
                viewModel = viewModel,
                biometricGate = biometricGate,
                onRequestNotifications = {
                    FieldworkPushNotifications.requestPermissionIfNeeded(this, requestNotifications)
                },
            )
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        FieldworkPushNotifications.sessionIdHash(intent)?.let(pushSessionHashes::tryEmit)
    }
}

private fun fieldworkViewModelFactory(context: Context): ViewModelProvider.Factory {
    val appContext = context.applicationContext
    return object : ViewModelProvider.Factory {
        @Suppress("UNCHECKED_CAST")
        override fun <T : ViewModel> create(modelClass: Class<T>): T {
            if (modelClass.isAssignableFrom(FieldworkViewModel::class.java)) {
                return FieldworkViewModel(appContext) as T
            }
            throw IllegalArgumentException("Unknown ViewModel class ${modelClass.name}")
        }
    }
}
