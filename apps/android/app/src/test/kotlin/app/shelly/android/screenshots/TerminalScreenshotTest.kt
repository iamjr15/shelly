package app.shelly.android.screenshots

import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** Terminal screen (B04/B20/B21/B22/B10). Renders static chrome states via [ScreenshotHarness]. */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w412dp-h892dp-420dpi")
class TerminalScreenshotTest {
    @Test
    fun terminal_dark() = ScreenshotHarness.render("terminal_dark", dark = true) {
        TerminalScreenshotFixture(TerminalFixtureState.Base)
    }

    @Test
    fun terminal_light() = ScreenshotHarness.render("terminal_light", dark = false) {
        TerminalScreenshotFixture(TerminalFixtureState.Base)
    }

    @Test
    fun terminal_attaching() = ScreenshotHarness.render("terminal_attaching", dark = false) {
        TerminalScreenshotFixture(TerminalFixtureState.Attaching)
    }

    @Test
    fun terminal_locked() = ScreenshotHarness.render("terminal_locked", dark = false) {
        TerminalScreenshotFixture(TerminalFixtureState.Locked)
    }

    @Test
    fun terminal_exited() = ScreenshotHarness.render("terminal_exited", dark = false) {
        TerminalScreenshotFixture(TerminalFixtureState.Exited)
    }

    @Test
    fun terminal_claude_tui() = ScreenshotHarness.render("terminal_claude_tui", dark = false) {
        TerminalScreenshotFixture(TerminalFixtureState.ClaudeTui)
    }
}
