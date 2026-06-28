package app.shelly.android.screenshots

import app.shelly.android.core.AgentState
import app.shelly.android.core.MobileSession
import app.shelly.android.features.sessions.SessionsContentPreview
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** Sessions screen (B34/B02). Renders the real composable with mock data via [ScreenshotHarness]. */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w412dp-h892dp-420dpi")
class ScreenshotTests {

    private fun mockSessions() = listOf(
        MobileSession("1", "shelly · crates/cli", listOf("claude"), "/x", 0u, 6u, AgentState.AwaitingInput, "› Approve replacing src/cli/pair.rs ?", "opus-4-8"),
        MobileSession("2", "shelly · crates/daemon", listOf("cargo", "test"), "/x", 0u, 5u, AgentState.Working, "cargo test --workspace --no-fail-fast", null),
        MobileSession("3", "infra · scripts/dogfood", listOf("./gradlew"), "/x", 0u, 4u, AgentState.Working, "Building Android release · :app:assemble", null),
        MobileSession("4", "scratch · ~/notes", listOf("vim"), "/x", 0u, 3u, AgentState.Idle, "vim notes/2026-06-28-plan.md", null),
        MobileSession("5", "dotfiles · ~", listOf("zsh"), "/x", 0u, 2u, AgentState.Idle, "zsh · idle 1h", null),
        MobileSession("6", "ios-release · apps/ios", listOf("xcodebuild"), "/x", 0u, 1u, AgentState.Crashed, "xcodebuild: archive failed (code 65)", null),
    )

    @Test
    fun sessions_dark() = ScreenshotHarness.render("sessions_dark", dark = true) {
        SessionsContentPreview(mockSessions(), loading = false)
    }

    @Test
    fun sessions_light() = ScreenshotHarness.render("sessions_light", dark = false) {
        SessionsContentPreview(mockSessions(), loading = false)
    }
}
