package app.shelly.android.features.sessions

import app.shelly.android.core.AgentState
import app.shelly.android.core.MobileSession

internal data class SessionDashboardSection(
    val state: AgentState,
    val sessions: List<MobileSession>,
)

internal fun sessionDashboardSections(sessions: List<MobileSession>): List<SessionDashboardSection> {
    val sessionsByState = sessions
        .sortedWith(compareBy<MobileSession> { it.state.sortRank }.thenByDescending { it.lastActivity })
        .groupBy { it.state }
    return AgentState.values()
        .sortedBy { it.sortRank }
        .mapNotNull { state ->
            sessionsByState[state]?.takeIf { it.isNotEmpty() }?.let { grouped ->
                SessionDashboardSection(state = state, sessions = grouped)
            }
        }
}

internal fun filterSessions(sessions: List<MobileSession>, query: String): List<MobileSession> {
    val terms = query
        .trim()
        .lowercase()
        .split(Regex("\\s+"))
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

internal fun MobileSession.sessionPreviewText(): String =
    lastLine?.takeIf { it.isNotBlank() } ?: command.joinToString(" ").ifBlank { "No terminal output yet" }

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
