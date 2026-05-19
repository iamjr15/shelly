package app.fieldwork.android.features.sessions

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Terminal
import androidx.compose.material3.Card
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import app.fieldwork.android.core.AndroidBiometricGate
import app.fieldwork.android.core.FieldworkViewModel
import app.fieldwork.android.core.MobileSession
import app.fieldwork.android.features.terminal.TerminalScreen
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SessionsScreen(
    padding: PaddingValues,
    viewModel: FieldworkViewModel,
    biometricGate: AndroidBiometricGate,
) {
    val state by viewModel.state.collectAsState()
    var selectedSession by remember { mutableStateOf<MobileSession?>(null) }
    val scope = rememberCoroutineScope()

    LaunchedEffect(state.targetSession?.id) {
        val target = state.targetSession ?: return@LaunchedEffect
        val unlocked = biometricGate.unlock("Open terminal session")
        viewModel.consumeTargetSession()
        if (unlocked) {
            selectedSession = target
        }
    }

    selectedSession?.let { session ->
        TerminalScreen(
            session = session,
            viewModel = viewModel,
            biometricGate = biometricGate,
            onBack = { selectedSession = null },
        )
        return
    }

    Scaffold(
        modifier = Modifier.padding(padding),
        topBar = {
            TopAppBar(
                title = { Text("Sessions") },
                actions = {
                    IconButton(onClick = viewModel::refreshSessions) {
                        Icon(Icons.Default.Refresh, contentDescription = "Refresh")
                    }
                },
            )
        },
    ) { innerPadding ->
        LazyColumn(
            modifier = Modifier
                .fillMaxSize()
                .padding(innerPadding),
            contentPadding = PaddingValues(12.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            if (state.sessions.isEmpty()) {
                item {
                    Card {
                        ListItem(
                            headlineContent = { Text("No sessions") },
                            supportingContent = { Text("Create one on your laptop with fieldwork new.") },
                            leadingContent = { Icon(Icons.Default.Terminal, contentDescription = null) },
                        )
                    }
                }
            }
            items(state.sessions, key = { it.id }) { session ->
                SessionCard(session = session) {
                    scope.launch {
                        if (biometricGate.unlock("Open terminal session")) {
                            selectedSession = session
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun SessionCard(session: MobileSession, onClick: () -> Unit) {
    Card(onClick = onClick) {
        ListItem(
            headlineContent = { Text(session.name) },
            supportingContent = { Text(session.lastLine ?: session.command.joinToString(" ")) },
            overlineContent = { Text(session.state.name) },
            leadingContent = { Icon(Icons.Default.Terminal, contentDescription = null) },
            trailingContent = { Icon(Icons.Default.Folder, contentDescription = null) },
        )
    }
}
