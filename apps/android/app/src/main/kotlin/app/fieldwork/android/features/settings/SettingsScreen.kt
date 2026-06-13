package app.fieldwork.android.features.settings

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import app.fieldwork.android.core.FieldworkViewModel
import app.fieldwork.android.core.MobileTelemetry

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(padding: PaddingValues, viewModel: FieldworkViewModel) {
    val context = LocalContext.current
    val state by viewModel.state.collectAsState()
    var telemetry by remember { mutableStateOf(MobileTelemetry.isDiagnosticsEnabled(context)) }
    var showLicenses by remember { mutableStateOf(false) }
    var confirmUnpair by remember { mutableStateOf(false) }

    if (showLicenses) {
        OpenSourceLicensesScreen(padding = padding, onBack = { showLicenses = false })
        return
    }

    if (confirmUnpair) {
        AlertDialog(
            onDismissRequest = { confirmUnpair = false },
            title = { Text(UNPAIR_TITLE) },
            text = { Text(UNPAIR_BODY) },
            confirmButton = {
                Button(
                    onClick = {
                        confirmUnpair = false
                        viewModel.unpair()
                    },
                ) {
                    Text(UNPAIR_CONFIRM)
                }
            },
            dismissButton = {
                TextButton(onClick = { confirmUnpair = false }) {
                    Text(UNPAIR_CANCEL)
                }
            },
        )
    }

    Scaffold(
        modifier = Modifier.padding(padding),
        topBar = { TopAppBar(title = { Text("Settings") }) },
    ) { innerPadding ->
        LazyColumn(
            modifier = Modifier
                .fillMaxSize()
                .padding(innerPadding),
            contentPadding = PaddingValues(horizontal = 12.dp, vertical = 8.dp),
            verticalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            item { SettingsSectionHeader(SETTINGS_CONNECTION_SECTION) }
            item {
                ListItem(
                    headlineContent = { Text(DAEMON_TITLE) },
                    supportingContent = { Text(pairedDaemonSummary(state.pairedDaemon)) },
                )
            }
            item { SettingsSectionHeader(SETTINGS_PRIVACY_SECTION) }
            item {
                ListItem(
                    headlineContent = { Text(DIAGNOSTICS_TITLE) },
                    supportingContent = { Text(DIAGNOSTICS_BODY) },
                    trailingContent = {
                        Switch(
                            checked = telemetry,
                            onCheckedChange = {
                                telemetry = it
                                MobileTelemetry.setDiagnosticsEnabled(context, it)
                            },
                        )
                    },
                )
            }
            item { SettingsSectionHeader(SETTINGS_HELP_SECTION) }
            item {
                ListItem(
                    headlineContent = { Text(LICENSES_TITLE) },
                    supportingContent = { Text(LICENSES_BODY) },
                    modifier = Modifier.clickable { showLicenses = true },
                )
            }
            if (state.paired) {
                item { SettingsSectionHeader(SETTINGS_DEVICE_SECTION) }
                item {
                    ListItem(
                        headlineContent = { Text("Unpair this phone") },
                        supportingContent = { Text(UNPAIR_ROW_BODY) },
                        trailingContent = {
                            Button(onClick = { confirmUnpair = true }) {
                                Text(UNPAIR_CONFIRM)
                            }
                        },
                    )
                }
            }
        }
    }
}

@Composable
private fun SettingsSectionHeader(text: String) {
    Text(
        text = text,
        modifier = Modifier.padding(start = 4.dp, top = 14.dp, bottom = 4.dp),
        style = MaterialTheme.typography.labelLarge,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
}
