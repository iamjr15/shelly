package app.shelly.android.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Terminal
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import app.shelly.android.core.AndroidBiometricGate
import app.shelly.android.core.ShellyViewModel
import app.shelly.android.features.pairing.PairingScreen
import app.shelly.android.features.sessions.SessionsScreen
import app.shelly.android.features.settings.SettingsScreen
import app.shelly.android.features.terminal.TerminalScreen
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import kotlinx.coroutines.launch

private enum class AppTab {
    Sessions,
    Settings,
}

private val ShellyLightColorScheme = lightColorScheme(
    primary = Color(0xFF245B4E),
    onPrimary = Color.White,
    primaryContainer = Color(0xFFD7EEE6),
    onPrimaryContainer = Color(0xFF0F211D),
    secondary = Color(0xFF62533B),
    onSecondary = Color.White,
    background = Color(0xFFFAFAF7),
    onBackground = Color(0xFF171A18),
    surface = Color(0xFFFAFAF7),
    onSurface = Color(0xFF171A18),
    surfaceVariant = Color(0xFFE2E6DF),
    onSurfaceVariant = Color(0xFF414941),
    outline = Color(0xFF737B72),
)

private val ShellyDarkColorScheme = darkColorScheme(
    primary = Color(0xFF8DCCB8),
    onPrimary = Color(0xFF12342C),
    primaryContainer = Color(0xFF1D4037),
    onPrimaryContainer = Color(0xFFD7EEE6),
    secondary = Color(0xFFD2C1A5),
    onSecondary = Color(0xFF352B1B),
    background = Color(0xFF101412),
    onBackground = Color(0xFFE8EAE5),
    surface = Color(0xFF181C1A),
    onSurface = Color(0xFFE8EAE5),
    surfaceVariant = Color(0xFF2A302D),
    onSurfaceVariant = Color(0xFFC3CAC2),
    outline = Color(0xFF8A938A),
    error = Color(0xFFFFB4AB),
    onError = Color(0xFF690005),
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ShellyApp(
    viewModel: ShellyViewModel,
    biometricGate: AndroidBiometricGate,
    onRequestNotifications: () -> Unit = {},
) {
    val state by viewModel.state.collectAsState()
    var selectedTab by remember { mutableStateOf(AppTab.Sessions) }
    var unlockUnavailableMessage by remember { mutableStateOf(biometricGate.unlockUnavailableMessage()) }
    val activeTerminalSession = state.activeTerminalSessionId?.let { sessionId ->
        state.sessions.firstOrNull { it.id == sessionId }
    }
    val scope = rememberCoroutineScope()
    val lifecycleOwner = LocalLifecycleOwner.current
    val colorScheme = if (isSystemInDarkTheme()) ShellyDarkColorScheme else ShellyLightColorScheme

    LaunchedEffect(Unit) {
        val unlocked = biometricGate.unlock("Unlock Shelly")
        viewModel.setUnlocked(unlocked)
    }

    LaunchedEffect(state.paired, state.unlocked) {
        if (state.paired && state.unlocked) {
            onRequestNotifications()
        }
    }

    DisposableEffect(lifecycleOwner, biometricGate, viewModel) {
        val observer = LifecycleEventObserver { _, event ->
            when (event) {
                Lifecycle.Event.ON_STOP -> {
                    AndroidBiometricGate.markBackgrounded()
                    viewModel.onAppBackgrounded()
                }
                Lifecycle.Event.ON_RESUME -> {
                    unlockUnavailableMessage = biometricGate.unlockUnavailableMessage()
                    viewModel.onAppForegrounded()
                    if (biometricGate.shouldLockOnResume) {
                        viewModel.setUnlocked(false)
                        scope.launch {
                            viewModel.setUnlocked(biometricGate.unlock("Unlock Shelly"))
                        }
                    }
                }
                else -> Unit
            }
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose {
            lifecycleOwner.lifecycle.removeObserver(observer)
        }
    }

    MaterialTheme(colorScheme = colorScheme) {
        Surface(modifier = Modifier.fillMaxSize()) {
            if (state.unlocked) {
                Scaffold(
                    bottomBar = {
                        if (state.activeTerminalSessionId == null) {
                            NavigationBar {
                                NavigationBarItem(
                                    selected = selectedTab == AppTab.Sessions,
                                    onClick = { selectedTab = AppTab.Sessions },
                                    icon = { Icon(Icons.Default.Terminal, contentDescription = null) },
                                    label = { Text("Sessions") },
                                )
                                NavigationBarItem(
                                    selected = selectedTab == AppTab.Settings,
                                    onClick = {
                                        viewModel.closeTerminalSession()
                                        selectedTab = AppTab.Settings
                                    },
                                    icon = { Icon(Icons.Default.Settings, contentDescription = null) },
                                    label = { Text("Settings") },
                                )
                            }
                        }
                    },
                ) { padding ->
                    Box(modifier = Modifier.fillMaxSize()) {
                        when (selectedTab) {
                            AppTab.Sessions -> {
                                if (state.restoringPairing) {
                                    RestoringPairingPlaceholder(padding)
                                } else if (state.paired) {
                                    if (state.activeTerminalSessionId == null) {
                                        SessionsScreen(
                                            padding = padding,
                                            viewModel = viewModel,
                                            biometricGate = biometricGate,
                                            onOpenSession = viewModel::openTerminalSession,
                                        )
                                    } else if (activeTerminalSession == null) {
                                        RestoringPairingPlaceholder(padding)
                                    } else {
                                        TerminalScreen(
                                            session = activeTerminalSession,
                                            viewModel = viewModel,
                                            biometricGate = biometricGate,
                                            onBack = viewModel::closeTerminalSession,
                                        )
                                    }
                                } else {
                                    PairingScreen(
                                        padding = padding,
                                        pairing = state.loading,
                                        onPair = viewModel::pair,
                                        onPairWithCode = viewModel::pairWithCode,
                                    )
                                }
                            }
                            AppTab.Settings -> SettingsScreen(padding = padding, viewModel = viewModel)
                        }
                    }
                }
            } else {
                LockedOverlay(unavailableMessage = unlockUnavailableMessage) {
                    unlockUnavailableMessage = biometricGate.unlockUnavailableMessage()
                    scope.launch {
                        viewModel.setUnlocked(biometricGate.unlock("Unlock Shelly"))
                    }
                }
            }
        }
    }

    state.message?.let { message ->
        AlertDialog(
            onDismissRequest = viewModel::clearMessage,
            confirmButton = {
                Button(onClick = viewModel::clearMessage) {
                    Text("OK")
                }
            },
            title = { Text("Shelly") },
            text = { Text(message) },
        )
    }

    if (state.telemetryConsentPromptVisible) {
        ModalBottomSheet(onDismissRequest = { viewModel.answerTelemetryConsent(false) }) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 24.dp, vertical = 18.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Text(
                    text = "Help improve Shelly?",
                    style = MaterialTheme.typography.titleLarge,
                )
                Text(
                    "Records a local preference only. This version of Shelly collects and sends no diagnostics; " +
                        "the preference takes effect only if a future version adds them. " +
                        "No code, prompts, terminal output, or file paths.",
                )
                Button(
                    onClick = { viewModel.answerTelemetryConsent(true) },
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text("Sure")
                }
                TextButton(
                    onClick = { viewModel.answerTelemetryConsent(false) },
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text("No thanks")
                }
            }
        }
    }
}

@Composable
private fun RestoringPairingPlaceholder(padding: PaddingValues) {
    Box(
        modifier = Modifier
            .fillMaxSize()
            .padding(padding),
        contentAlignment = Alignment.Center,
    ) {
        CircularProgressIndicator()
    }
}

@Composable
private fun LockedOverlay(
    unavailableMessage: String?,
    onUnlock: () -> Unit,
) {
    Surface(
        modifier = Modifier.fillMaxSize(),
        color = MaterialTheme.colorScheme.background,
    ) {
        Box(contentAlignment = Alignment.Center) {
            Column(
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Button(
                    onClick = onUnlock,
                    colors = ButtonDefaults.buttonColors(
                        containerColor = MaterialTheme.colorScheme.primary,
                        contentColor = MaterialTheme.colorScheme.onPrimary,
                    ),
                ) {
                    Icon(Icons.Default.Lock, contentDescription = null)
                    Text("Unlock")
                }
                unavailableMessage?.let { message ->
                    Text(
                        text = message,
                        modifier = Modifier.padding(horizontal = 24.dp),
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        textAlign = TextAlign.Center,
                    )
                }
            }
        }
    }
}
