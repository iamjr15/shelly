package app.shelly.android.screenshots

import app.shelly.android.features.sessions.DaemonUnreachablePreview
import app.shelly.android.features.sessions.ReconnectingPreview
import app.shelly.android.features.sessions.SessionsEmptyPreview
import app.shelly.android.features.sessions.SessionsGroupedPreview
import app.shelly.android.features.sessions.SessionsLongPressPreview
import app.shelly.android.features.sessions.SessionsSearchPreview
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

    @Test fun sessions_search_dark() = ScreenshotHarness.render("sessions_search_dark", dark = true) { SessionsSearchPreview() }
    @Test fun sessions_search_light() = ScreenshotHarness.render("sessions_search_light", dark = false) { SessionsSearchPreview() }

    @Test fun sessions_grouped_dark() = ScreenshotHarness.render("sessions_grouped_dark", dark = true) { SessionsGroupedPreview() }
    @Test fun sessions_grouped_light() = ScreenshotHarness.render("sessions_grouped_light", dark = false) { SessionsGroupedPreview() }

    @Test fun sessions_empty_dark() = ScreenshotHarness.render("sessions_empty_dark", dark = true) { SessionsEmptyPreview() }
    @Test fun sessions_empty_light() = ScreenshotHarness.render("sessions_empty_light", dark = false) { SessionsEmptyPreview() }

    @Test fun daemon_unreachable_dark() = ScreenshotHarness.render("daemon_unreachable_dark", dark = true) { DaemonUnreachablePreview() }
    @Test fun daemon_unreachable_light() = ScreenshotHarness.render("daemon_unreachable_light", dark = false) { DaemonUnreachablePreview() }

    @Test fun reconnecting_dark() = ScreenshotHarness.render("reconnecting_dark", dark = true) { ReconnectingPreview() }
    @Test fun reconnecting_light() = ScreenshotHarness.render("reconnecting_light", dark = false) { ReconnectingPreview() }

    @Test fun sessions_longpress_dark() = ScreenshotHarness.render("sessions_longpress_dark", dark = true) { SessionsLongPressPreview() }
    @Test fun sessions_longpress_light() = ScreenshotHarness.render("sessions_longpress_light", dark = false) { SessionsLongPressPreview() }
}
