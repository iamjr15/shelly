package app.fieldwork.android.features.terminal

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.union
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.activity.compose.BackHandler
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import app.fieldwork.android.core.AndroidBiometricGate
import app.fieldwork.android.core.FieldworkViewModel
import app.fieldwork.android.core.MobileSession
import app.fieldwork.android.core.TerminalController
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import org.connectbot.terminal.Terminal

@OptIn(ExperimentalMaterial3Api::class, ExperimentalComposeUiApi::class)
@Composable
fun TerminalScreen(
    session: MobileSession,
    viewModel: FieldworkViewModel,
    biometricGate: AndroidBiometricGate,
    onBack: () -> Unit,
) {
    val terminalFocusRequester = remember { FocusRequester() }
    val keyboardController = LocalSoftwareKeyboardController.current
    var controller by remember(session.id) { mutableStateOf<TerminalController?>(null) }
    var attachError by remember(session.id) { mutableStateOf<String?>(null) }
    var attachAttempt by remember(session.id) { mutableStateOf(0) }

    LaunchedEffect(session.id, attachAttempt) {
        controller = null
        attachError = null
        try {
            controller = viewModel.createTerminalController(session) {
                biometricGate.unlock("Send terminal input")
            }
        } catch (error: Throwable) {
            if (error is CancellationException) {
                throw error
            }
            attachError = terminalAttachErrorMessage(error)
        }
    }

    LaunchedEffect(controller) {
        if (controller != null) {
            delay(100)
            runCatching { terminalFocusRequester.requestFocus() }
            keyboardController?.show()
        }
    }

    val currentController = controller
    BackHandler(onBack = onBack)

    DisposableEffect(currentController) {
        onDispose { currentController?.detach() }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(session.name) },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                    }
                },
            )
        },
        bottomBar = {
            currentController?.let { AccessoryBar(it) }
        },
    ) { innerPadding ->
        val current = currentController
        if (current == null) {
            TerminalAttachStatus(
                error = attachError,
                onRetry = { attachAttempt += 1 },
                modifier = Modifier.padding(innerPadding),
            )
        } else {
            val terminalState by current.state.collectAsState()
            Column(modifier = Modifier.padding(innerPadding)) {
                Text(
                    text = terminalState.status,
                    modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp),
                    color = Color.Gray,
                )
                Terminal(
                    terminalEmulator = current.emulator,
                    modifier = Modifier
                        .fillMaxSize()
                        .weight(1f),
                    keyboardEnabled = true,
                    focusRequester = terminalFocusRequester,
                    onTerminalTap = {
                        runCatching { terminalFocusRequester.requestFocus() }
                        keyboardController?.show()
                    },
                    modifierManager = current.modifierManager,
                )
            }
        }
    }
}

@Composable
private fun TerminalAttachStatus(
    error: String?,
    onRetry: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier = modifier
            .fillMaxSize()
            .padding(16.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            if (error == null) {
                CircularProgressIndicator()
            }
            Text(
                text = error ?: TERMINAL_ATTACHING_TITLE,
                color = if (error == null) Color.Gray else MaterialTheme.colorScheme.error,
                style = MaterialTheme.typography.titleMedium,
            )
            Text(
                text = if (error == null) TERMINAL_ATTACHING_BODY else TERMINAL_ATTACH_ERROR_BODY,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            if (error != null) {
                OutlinedButton(onClick = onRetry) {
                    Text(TERMINAL_ATTACH_RETRY)
                }
            }
        }
    }
}

@Composable
private fun AccessoryBar(controller: TerminalController) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .windowInsetsPadding(WindowInsets.ime.union(WindowInsets.navigationBars))
            .horizontalScroll(rememberScrollState())
            .padding(8.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = androidx.compose.ui.Alignment.CenterVertically,
    ) {
        terminalAccessoryItems().forEach { item ->
            AccessoryButton(
                item = item,
                selected = when (item.action) {
                    TerminalAccessoryAction.ToggleCtrl -> controller.modifierManager.ctrl
                    TerminalAccessoryAction.ToggleAlt -> controller.modifierManager.alt
                    TerminalAccessoryAction.SendBytes -> false
                },
                onClick = {
                    when (item.action) {
                        TerminalAccessoryAction.SendBytes -> controller.sendAccessory(item.bytes)
                        TerminalAccessoryAction.ToggleCtrl -> controller.modifierManager.toggleCtrl()
                        TerminalAccessoryAction.ToggleAlt -> controller.modifierManager.toggleAlt()
                    }
                },
            )
        }
    }
}

@Composable
private fun AccessoryButton(
    item: TerminalAccessoryItem,
    selected: Boolean,
    onClick: () -> Unit,
) {
    val colors = if (selected) {
        ButtonDefaults.outlinedButtonColors(
            containerColor = MaterialTheme.colorScheme.primaryContainer,
            contentColor = MaterialTheme.colorScheme.onPrimaryContainer,
        )
    } else {
        ButtonDefaults.outlinedButtonColors(
            contentColor = MaterialTheme.colorScheme.onSurface,
        )
    }
    OutlinedButton(
        onClick = onClick,
        modifier = Modifier
            .height(40.dp)
            .widthIn(min = 48.dp)
            .semantics {
                contentDescription = item.contentDescription
            },
        shape = RoundedCornerShape(8.dp),
        border = BorderStroke(
            width = 1.dp,
            color = if (selected) {
                MaterialTheme.colorScheme.primary
            } else {
                MaterialTheme.colorScheme.outline
            },
        ),
        colors = colors,
        contentPadding = PaddingValues(horizontal = 12.dp),
    ) {
        Text(item.label)
    }
}
