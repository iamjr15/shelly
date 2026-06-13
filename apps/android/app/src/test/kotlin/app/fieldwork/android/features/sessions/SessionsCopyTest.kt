package app.fieldwork.android.features.sessions

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SessionsCopyTest {
    @Test
    fun loadingDashboardCopyExplainsRefreshBeforeEmptyState() {
        assertTrue(LOADING_SESSIONS_TITLE.contains("Syncing"))
        assertTrue(LOADING_SESSIONS_BODY.contains("laptop"))
        assertTrue(LOADING_SESSIONS_BODY.contains("live terminal sessions"))
    }

    @Test
    fun emptyDashboardCopyPointsToDesktopShortcutsAndAutomaticRefresh() {
        assertTrue(EMPTY_SESSIONS_TITLE.contains("No sessions"))
        assertTrue(EMPTY_SESSIONS_BODY.contains("fw"))
        assertTrue(EMPTY_SESSIONS_BODY.contains("fw <name>"))
        assertTrue(EMPTY_SESSIONS_BODY.contains("automatically"))
    }

    @Test
    fun emptyDashboardCopyDoesNotExposeMobileCreationOrKillControls() {
        assertFalse(LOADING_SESSIONS_BODY.contains("create", ignoreCase = true))
        assertFalse(LOADING_SESSIONS_BODY.contains("kill", ignoreCase = true))
        assertFalse(LOADING_SESSIONS_BODY.contains("command", ignoreCase = true))
        assertFalse(EMPTY_SESSIONS_BODY.contains("create", ignoreCase = true))
        assertFalse(EMPTY_SESSIONS_BODY.contains("kill", ignoreCase = true))
        assertFalse(EMPTY_SESSIONS_BODY.contains("command", ignoreCase = true))
    }

    @Test
    fun searchCopyKeepsFilteringLocalToTheExistingDashboard() {
        assertTrue(SESSION_SEARCH_LABEL.contains("Search"))
        assertTrue(SESSION_SEARCH_PLACEHOLDER.contains("Name"))
        assertTrue(NO_MATCHING_SESSIONS_TITLE.contains("No matching"))
        assertTrue(NO_MATCHING_SESSIONS_BODY.contains("terminal preview"))
        assertFalse(NO_MATCHING_SESSIONS_BODY.contains("create", ignoreCase = true))
        assertFalse(NO_MATCHING_SESSIONS_BODY.contains("kill", ignoreCase = true))
        assertFalse(NO_MATCHING_SESSIONS_BODY.contains("command", ignoreCase = true))
    }
}
