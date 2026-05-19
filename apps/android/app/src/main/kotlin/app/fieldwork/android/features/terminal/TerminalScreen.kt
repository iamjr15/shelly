package app.fieldwork.android.features.terminal

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import app.fieldwork.android.core.AndroidBiometricGate
import app.fieldwork.android.core.FieldworkViewModel
import app.fieldwork.android.core.MobileSession
import app.fieldwork.android.core.TerminalController
import kotlinx.coroutines.launch
import org.connectbot.terminal.Terminal

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TerminalScreen(
    session: MobileSession,
    viewModel: FieldworkViewModel,
    biometricGate: AndroidBiometricGate,
    onBack: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    var controller by remember { mutableStateOf<TerminalController?>(null) }

    LaunchedEffect(session.id) {
        controller = viewModel.createTerminalController(session) {
            biometricGate.unlock("Send terminal input")
        }
    }

    DisposableEffect(Unit) {
        onDispose { controller?.detach() }
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
            controller?.let { AccessoryBar(it) }
        },
    ) { innerPadding ->
        val current = controller
        if (current == null) {
            Text("Attaching", modifier = Modifier.padding(innerPadding).padding(16.dp))
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
                    modifierManager = current.modifierManager,
                )
            }
        }
    }
}

@Composable
private fun AccessoryBar(controller: TerminalController) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .horizontalScroll(rememberScrollState())
            .padding(8.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        TextButton(onClick = { controller.sendAccessory(byteArrayOf(0x1b)) }) { Text("Esc") }
        Button(onClick = { controller.modifierManager.toggleCtrl() }) { Text("Ctrl") }
        Button(onClick = { controller.modifierManager.toggleAlt() }) { Text("Alt") }
        TextButton(onClick = { controller.sendAccessory(byteArrayOf(0x09)) }) { Text("Tab") }
        TextButton(onClick = { controller.sendAccessory("|".encodeToByteArray()) }) { Text("|") }
        TextButton(onClick = { controller.sendAccessory("/".encodeToByteArray()) }) { Text("/") }
        TextButton(onClick = { controller.sendAccessory(byteArrayOf(0x1b, 0x5b, 0x41)) }) { Text("^") }
        TextButton(onClick = { controller.sendAccessory(byteArrayOf(0x1b, 0x5b, 0x42)) }) { Text("v") }
        TextButton(onClick = { controller.sendAccessory(byteArrayOf(0x1b, 0x5b, 0x44)) }) { Text("<") }
        TextButton(onClick = { controller.sendAccessory(byteArrayOf(0x1b, 0x5b, 0x43)) }) { Text(">") }
    }
}
