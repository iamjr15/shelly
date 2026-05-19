package app.fieldwork.android.features.settings

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ListItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import app.fieldwork.android.core.FieldworkViewModel
import app.fieldwork.android.core.MobileTelemetry

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(padding: PaddingValues, viewModel: FieldworkViewModel) {
    val context = LocalContext.current
    val state by viewModel.state.collectAsState()
    var telemetry by remember { mutableStateOf(MobileTelemetry.isCrashReportingEnabled(context)) }
    var showLicenses by remember { mutableStateOf(false) }

    if (showLicenses) {
        OpenSourceLicensesScreen(padding = padding, onBack = { showLicenses = false })
        return
    }

    Scaffold(
        modifier = Modifier.padding(padding),
        topBar = { TopAppBar(title = { Text("Settings") }) },
    ) { innerPadding ->
        androidx.compose.foundation.lazy.LazyColumn(modifier = Modifier.padding(innerPadding)) {
            item {
                ListItem(
                    headlineContent = { Text("Daemon") },
                    supportingContent = {
                        Text(state.pairedDaemon?.daemonNodeId?.take(12)?.plus("...") ?: "No paired daemon")
                    },
                )
            }
            item {
                ListItem(
                    headlineContent = { Text("Share crash reports") },
                    trailingContent = {
                        Switch(
                            checked = telemetry,
                            onCheckedChange = {
                                telemetry = it
                                MobileTelemetry.setCrashReportingEnabled(context, it)
                            },
                        )
                    },
                )
            }
            item {
                ListItem(
                    headlineContent = { Text("Open Source Licenses") },
                    supportingContent = { Text("Fieldwork and bundled dependency notices") },
                    modifier = Modifier.clickable { showLicenses = true },
                )
            }
            if (state.paired) {
                item {
                    Button(onClick = viewModel::unpair) {
                        Text("Unpair")
                    }
                }
            }
        }
    }
}
