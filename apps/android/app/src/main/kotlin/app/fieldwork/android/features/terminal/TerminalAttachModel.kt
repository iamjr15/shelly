package app.fieldwork.android.features.terminal

import uniffi.fieldwork_mobile_core.FieldworkException

internal const val TERMINAL_ATTACHING_TITLE = "Attaching"
internal const val TERMINAL_ATTACHING_BODY = "Opening the live PTY stream from your laptop."
internal const val TERMINAL_ATTACH_ERROR_BODY = "Check that your laptop is awake and try again."
internal const val TERMINAL_ATTACH_RETRY = "Retry"

internal fun terminalAttachErrorMessage(error: Throwable): String = when (error) {
    is FieldworkException.NotFound -> "Session unavailable"
    else -> "Connection unavailable"
}
