package app.fieldwork.android.features.sessions

import app.fieldwork.android.core.AgentState
import app.fieldwork.android.core.MobileSession
import org.junit.Assert.assertEquals
import org.junit.Test

class SessionDashboardModelTest {
    @Test
    fun sectionsPrioritizeSessionStateAndRecentActivity() {
        val sections = sessionDashboardSections(
            listOf(
                testSession("idle-old", AgentState.Idle, lastActivity = 10uL),
                testSession("working-old", AgentState.Working, lastActivity = 20uL),
                testSession("awaiting", AgentState.AwaitingInput, lastActivity = 5uL),
                testSession("working-new", AgentState.Working, lastActivity = 30uL),
                testSession("crashed", AgentState.Crashed, lastActivity = 40uL),
            ),
        )

        assertEquals(
            listOf(AgentState.AwaitingInput, AgentState.Working, AgentState.Idle, AgentState.Crashed),
            sections.map { it.state },
        )
        assertEquals(
            listOf("working-new", "working-old"),
            sections.first { it.state == AgentState.Working }.sessions.map { it.id },
        )
    }

    @Test
    fun displayTextUsesTerminalPreviewAndStableFallbacks() {
        val shell = testSession(
            id = "shell",
            state = AgentState.Idle,
            command = listOf("bash", "-lc", "echo ok"),
            cwd = "/Users/example/projects/fieldwork/",
            lastLine = "ready",
        )
        val fallback = testSession(
            id = "fallback",
            state = AgentState.Working,
            command = emptyList(),
            cwd = "",
            lastLine = " ",
        )

        assertEquals("Awaiting input", AgentState.AwaitingInput.sessionStateLabel())
        assertEquals("ready", shell.sessionPreviewText())
        assertEquals("bash", shell.sessionCommandLabel())
        assertEquals("fieldwork", shell.sessionCwdLabel())
        assertEquals("No terminal output yet", fallback.sessionPreviewText())
        assertEquals("shell", fallback.sessionCommandLabel())
        assertEquals("~", fallback.sessionCwdLabel())
    }

    @Test
    fun searchFiltersAcrossDashboardMetadataWithoutChangingSessionOrder() {
        val sessions = listOf(
            testSession(
                id = "refactor",
                state = AgentState.Working,
                command = listOf("claude"),
                cwd = "/Users/example/projects/api",
                lastLine = "editing auth flow",
                model = "sonnet",
            ),
            testSession(
                id = "shell",
                state = AgentState.Idle,
                command = listOf("bash"),
                cwd = "/Users/example/projects/fieldwork",
                lastLine = "ready",
            ),
            testSession(
                id = "agent",
                state = AgentState.AwaitingInput,
                command = listOf("codex"),
                cwd = "/tmp",
                lastLine = "approve patch?",
            ),
        )

        assertEquals(sessions, filterSessions(sessions, " "))
        assertEquals(listOf("refactor"), filterSessions(sessions, "auth").map { it.id })
        assertEquals(listOf("shell"), filterSessions(sessions, "fieldwork").map { it.id })
        assertEquals(listOf("agent"), filterSessions(sessions, "awaiting").map { it.id })
        assertEquals(listOf("refactor"), filterSessions(sessions, "SONNET").map { it.id })
    }

    @Test
    fun searchMatchesAllWhitespaceSeparatedTermsAcrossRowMetadata() {
        val sessions = listOf(
            testSession(
                id = "refactor",
                state = AgentState.Working,
                command = listOf("claude"),
                cwd = "/Users/example/projects/api",
                lastLine = "editing auth flow",
                model = "sonnet",
            ),
            testSession(
                id = "tests",
                state = AgentState.Working,
                command = listOf("bash"),
                cwd = "/Users/example/projects/api",
                lastLine = "running unit tests",
            ),
        )

        assertEquals(listOf("refactor"), filterSessions(sessions, "auth sonnet").map { it.id })
        assertEquals(listOf("refactor", "tests"), filterSessions(sessions, "working api").map { it.id })
        assertEquals(emptyList<String>(), filterSessions(sessions, "auth tests").map { it.id })
    }

    private fun testSession(
        id: String,
        state: AgentState,
        command: List<String> = listOf("claude"),
        cwd: String = "/tmp",
        lastLine: String? = null,
        lastActivity: ULong = 1uL,
        model: String? = null,
    ): MobileSession = MobileSession(
        id = id,
        name = id,
        command = command,
        cwd = cwd,
        createdAt = 1uL,
        lastActivity = lastActivity,
        state = state,
        lastLine = lastLine,
        model = model,
    )
}
