package app.shelly.android.screenshots

import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** Sessions variants/states (B45/B53/B49/B54/B56/B57). */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w412dp-h892dp-420dpi")
class SessionsVariantsScreenshotTest {

    @Test fun sessions_search_dark() = ScreenshotHarness.render("sessions_search_dark", dark = true) { SessionsSearchFixture() }
    @Test fun sessions_search_light() = ScreenshotHarness.render("sessions_search_light", dark = false) { SessionsSearchFixture() }

    @Test fun sessions_loading_dark() = ScreenshotHarness.render("sessions_loading_dark", dark = true) { SessionsDashboardFixture(loading = true, sessions = emptyList()) }
    @Test fun sessions_loading_light() = ScreenshotHarness.render("sessions_loading_light", dark = false) { SessionsDashboardFixture(loading = true, sessions = emptyList()) }

    @Test fun sessions_empty_dark() = ScreenshotHarness.render("sessions_empty_dark", dark = true) { SessionsEmptyFixture() }
    @Test fun sessions_empty_light() = ScreenshotHarness.render("sessions_empty_light", dark = false) { SessionsEmptyFixture() }

    @Test fun daemon_unreachable_dark() = ScreenshotHarness.render("daemon_unreachable_dark", dark = true) { DaemonUnreachableFixture() }
    @Test fun daemon_unreachable_light() = ScreenshotHarness.render("daemon_unreachable_light", dark = false) { DaemonUnreachableFixture() }

    @Test fun reconnecting_dark() = ScreenshotHarness.render("reconnecting_dark", dark = true) { ReconnectingFixture() }
    @Test fun reconnecting_light() = ScreenshotHarness.render("reconnecting_light", dark = false) { ReconnectingFixture() }

    @Test fun sessions_longpress_dark() = ScreenshotHarness.render("sessions_longpress_dark", dark = true) { SessionsLongPressFixture() }
    @Test fun sessions_longpress_light() = ScreenshotHarness.render("sessions_longpress_light", dark = false) { SessionsLongPressFixture() }
}
