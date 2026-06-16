package app.shelly.android.features.sessions

internal const val EMPTY_SESSIONS_TITLE = "No sessions yet"
internal const val EMPTY_SESSIONS_BODY =
    "Tap + to start a shell, or run shelly on your laptop. New sessions appear here automatically."

internal const val KILL_SESSION_TITLE = "Close session?"
internal const val KILL_SESSION_CONFIRM = "Close"
internal const val KILL_SESSION_CANCEL = "Cancel"

internal fun killSessionBody(name: String): String =
    "This stops \"$name\" on your laptop and ends its running processes."

internal const val LOADING_SESSIONS_TITLE = "Syncing sessions"
internal const val LOADING_SESSIONS_BODY =
    "Checking your laptop for live terminal sessions."

internal const val SESSION_SEARCH_LABEL = "Search sessions"
internal const val SESSION_SEARCH_PLACEHOLDER = "Name, folder, status, or preview"
internal const val NO_MATCHING_SESSIONS_TITLE = "No matching sessions"
internal const val NO_MATCHING_SESSIONS_BODY =
    "Try a different name, folder, status, or terminal preview."
