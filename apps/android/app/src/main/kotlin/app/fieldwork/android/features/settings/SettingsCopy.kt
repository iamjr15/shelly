package app.fieldwork.android.features.settings

import app.fieldwork.android.core.PairedDaemonRecord

internal const val SETTINGS_CONNECTION_SECTION = "Connection"
internal const val SETTINGS_PRIVACY_SECTION = "Privacy"
internal const val SETTINGS_HELP_SECTION = "Help"
internal const val SETTINGS_DEVICE_SECTION = "Device"
internal const val DAEMON_TITLE = "Daemon"
internal const val DAEMON_UNPAIRED = "No paired daemon"
internal const val DIAGNOSTICS_TITLE = "Share diagnostics"
internal const val DIAGNOSTICS_BODY =
    "Records a local preference only. This version of Fieldwork collects and sends no diagnostics; " +
        "the preference takes effect only if a future version adds them. " +
        "No terminal output, prompts, commands, or paths are sent."
internal const val LICENSES_TITLE = "Open Source Licenses"
internal const val LICENSES_BODY = "Fieldwork and bundled dependency notices"
internal const val UNPAIR_TITLE = "Unpair this phone?"
internal const val UNPAIR_BODY =
    "This removes Fieldwork pairing data from this phone. Desktop sessions keep running. " +
        "If the phone is lost, revoke it on your laptop with fw devices remove <device>."
internal const val UNPAIR_CONFIRM = "Unpair"
internal const val UNPAIR_CANCEL = "Cancel"
internal const val UNPAIR_ROW_BODY = "Removes this app's local pairing. Desktop sessions keep running."

internal fun pairedDaemonSummary(record: PairedDaemonRecord?): String =
    record?.daemonNodeId?.take(12)?.plus("...") ?: DAEMON_UNPAIRED
