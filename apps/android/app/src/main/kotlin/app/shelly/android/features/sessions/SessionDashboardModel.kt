package app.shelly.android.features.sessions

import app.shelly.android.core.AgentState
import app.shelly.android.core.MobileSession

private val PromptOnlyTerminalLine = Regex("^[\\s\\u0024#>%❯➜λ›»❱→]+$")
private val Whitespace = Regex("\\s+")

internal fun filterSessions(sessions: List<MobileSession>, query: String): List<MobileSession> {
    val terms = query
        .trim()
        .lowercase()
        .split(Whitespace)
        .filter { it.isNotEmpty() }
    if (terms.isEmpty()) return sessions

    return sessions.filter { session ->
        val searchText = session.searchText()
        terms.all { term -> searchText.contains(term) }
    }
}

internal fun AgentState.sessionStateLabel(): String =
    when (this) {
        AgentState.AwaitingInput -> "Awaiting input"
        AgentState.Working -> "Working"
        AgentState.Idle -> "Idle"
        AgentState.Crashed -> "Crashed"
    }

internal fun MobileSession.sessionPreviewText(): String {
    val preview = lastLine?.trim().orEmpty()
    return when {
        preview.isEmpty() -> command.joinToString(" ").ifBlank { "No terminal output yet" }
        PromptOnlyTerminalLine.matches(preview) -> "shell ready"
        else -> preview
    }
}

internal fun MobileSession.sessionCommandLabel(): String =
    command.firstOrNull()?.takeIf { it.isNotBlank() } ?: "shell"

internal fun MobileSession.sessionCwdLabel(): String =
    cwd.trimEnd('/').substringAfterLast('/').ifBlank { cwd.ifBlank { "~" } }

private fun MobileSession.searchText(): String =
    listOf(
        name,
        state.sessionStateLabel(),
        command.joinToString(" "),
        cwd,
        sessionCwdLabel(),
        lastLine.orEmpty(),
        model.orEmpty(),
    )
        .joinToString("\n")
        .lowercase()
