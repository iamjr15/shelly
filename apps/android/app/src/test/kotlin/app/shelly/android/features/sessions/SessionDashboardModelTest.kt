package app.shelly.android.features.sessions

import app.shelly.android.core.AgentState
import app.shelly.android.core.MobileSession
import app.shelly.android.core.sessionOrderComparator
import org.junit.Assert.assertEquals
import org.junit.Test

class SessionDashboardModelTest {
    @Test
    fun sessionOrderPrioritizesSessionStateAndRecentActivity() {
        val ordered = listOf(
            testSession("idle-old", AgentState.Idle, lastActivity = 10uL),
            testSession("working-old", AgentState.Working, lastActivity = 20uL),
            testSession("awaiting", AgentState.AwaitingInput, lastActivity = 5uL),
            testSession("working-new", AgentState.Working, lastActivity = 30uL),
            testSession("crashed", AgentState.Crashed, lastActivity = 40uL),
        ).sortedWith(sessionOrderComparator)

        assertEquals(
            listOf(
                "awaiting",
                "working-new",
                "working-old",
                "idle-old",
                "crashed",
            ),
            ordered.map { it.id },
        )
    }

    @Test
    fun displayTextUsesTerminalPreviewAndStableFallbacks() {
        val shell = testSession(
            id = "shell",
            state = AgentState.Idle,
            command = listOf("bash", "-lc", "echo ok"),
            cwd = "/Users/example/projects/shelly/",
            lastLine = "ready",
        )
        val fallback = testSession(
            id = "fallback",
            state = AgentState.Working,
            command = emptyList(),
            cwd = "",
            lastLine = " ",
        )
        val freshShell = testSession(
            id = "fresh-shell",
            state = AgentState.Idle,
            command = listOf("zsh"),
            cwd = "/Users/example",
            lastLine = "➜",
        )
        val meaningfulArrow = freshShell.copy(lastLine = "➜ build ready")

        assertEquals("Awaiting input", AgentState.AwaitingInput.sessionStateLabel())
        assertEquals("ready", shell.sessionPreviewText())
        assertEquals("bash", shell.sessionCommandLabel())
        assertEquals("shelly", shell.sessionCwdLabel())
        assertEquals("No terminal output yet", fallback.sessionPreviewText())
        assertEquals("shell", fallback.sessionCommandLabel())
        assertEquals("~", fallback.sessionCwdLabel())
        assertEquals("shell ready", freshShell.sessionPreviewText())
        assertEquals("shell ready", freshShell.copy(lastLine = "$").sessionPreviewText())
        assertEquals("➜ build ready", meaningfulArrow.sessionPreviewText())
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
                cwd = "/Users/example/projects/shelly",
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
        assertEquals(listOf("shell"), filterSessions(sessions, "shelly").map { it.id })
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
