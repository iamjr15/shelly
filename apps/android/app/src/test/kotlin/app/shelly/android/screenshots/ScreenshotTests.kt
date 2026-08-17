package app.shelly.android.screenshots

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

    @Test
    fun sessions_dark() = ScreenshotHarness.render("sessions_dark", dark = true) {
        SessionsDashboardFixture()
    }

    @Test
    fun sessions_light() = ScreenshotHarness.render("sessions_light", dark = false) {
        SessionsDashboardFixture()
    }
}
