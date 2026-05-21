package app.fieldwork.android.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
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
import androidx.compose.ui.unit.dp
import app.fieldwork.android.core.AndroidBiometricGate
import app.fieldwork.android.core.FieldworkViewModel
import app.fieldwork.android.core.MobileSession
import app.fieldwork.android.features.pairing.PairingScreen
import app.fieldwork.android.features.sessions.SessionsScreen
import app.fieldwork.android.features.settings.SettingsScreen
import app.fieldwork.android.features.terminal.TerminalScreen
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import kotlinx.coroutines.launch

private enum class AppTab {
    Sessions,
    Settings,
}

private val FieldworkColorScheme = lightColorScheme(
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

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun FieldworkApp(
    viewModel: FieldworkViewModel,
    biometricGate: AndroidBiometricGate,
    onRequestNotifications: () -> Unit = {},
) {
    val state by viewModel.state.collectAsState()
    var selectedTab by remember { mutableStateOf(AppTab.Sessions) }
    var activeTerminalSession by remember { mutableStateOf<MobileSession?>(null) }
    val scope = rememberCoroutineScope()
    val lifecycleOwner = LocalLifecycleOwner.current

    LaunchedEffect(Unit) {
        val unlocked = biometricGate.unlock("Unlock Fieldwork")
        viewModel.setUnlocked(unlocked)
    }

    LaunchedEffect(state.paired, state.unlocked) {
        if (state.paired && state.unlocked) {
            onRequestNotifications()
        }
        if (!state.paired || !state.unlocked) {
            activeTerminalSession = null
        }
    }

    DisposableEffect(lifecycleOwner, biometricGate, viewModel) {
        val observer = LifecycleEventObserver { _, event ->
            when (event) {
                Lifecycle.Event.ON_STOP -> AndroidBiometricGate.markBackgrounded()
                Lifecycle.Event.ON_RESUME -> {
                    if (biometricGate.shouldLockOnResume) {
                        viewModel.setUnlocked(false)
                        scope.launch {
                            viewModel.setUnlocked(biometricGate.unlock("Unlock Fieldwork"))
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

    MaterialTheme(colorScheme = FieldworkColorScheme) {
        Surface(modifier = Modifier.fillMaxSize()) {
            if (state.unlocked) {
                Scaffold(
                    bottomBar = {
                        if (activeTerminalSession == null) {
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
                                        activeTerminalSession = null
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
                                    val terminalSession = activeTerminalSession
                                    if (terminalSession == null) {
                                        SessionsScreen(
                                            padding = padding,
                                            viewModel = viewModel,
                                            biometricGate = biometricGate,
                                            onOpenSession = { activeTerminalSession = it },
                                        )
                                    } else {
                                        TerminalScreen(
                                            session = terminalSession,
                                            viewModel = viewModel,
                                            biometricGate = biometricGate,
                                            onBack = { activeTerminalSession = null },
                                        )
                                    }
                                } else {
                                    PairingScreen(
                                        padding = padding,
                                        onPair = viewModel::pair,
                                    )
                                }
                            }
                            AppTab.Settings -> SettingsScreen(padding = padding, viewModel = viewModel)
                        }
                    }
                }
            } else {
                LockedOverlay {
                    scope.launch {
                        viewModel.setUnlocked(biometricGate.unlock("Unlock Fieldwork"))
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
            title = { Text("Fieldwork") },
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
                    text = "Help improve Fieldwork?",
                    style = MaterialTheme.typography.titleLarge,
                )
                Text("Crash reports only. No code, prompts, terminal output, or file paths.")
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
private fun LockedOverlay(onUnlock: () -> Unit) {
    Surface(
        modifier = Modifier.fillMaxSize(),
        color = MaterialTheme.colorScheme.background,
    ) {
        Box(contentAlignment = Alignment.Center) {
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
        }
    }
}
