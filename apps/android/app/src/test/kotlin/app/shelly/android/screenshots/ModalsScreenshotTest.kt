package app.shelly.android.screenshots

import app.shelly.android.core.ShellyAlertMessage
import app.shelly.android.features.modals.AlertSheet
import app.shelly.android.features.modals.NotificationPermissionSheet
import app.shelly.android.features.modals.TelemetrySheet
import app.shelly.android.features.modals.UnpairSheet
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w412dp-h892dp-420dpi")
class ModalsScreenshotTest {
    @Test
    fun unpair_dark() = ScreenshotHarness.render("unpair_dark", dark = true) {
        ModalScreenshotHost { UnpairSheet(daemonLabel = "6e7a1cdd29b0…", liveSessions = 6) }
    }

    @Test
    fun unpair_light() = ScreenshotHarness.render("unpair_light", dark = false) {
        ModalScreenshotHost { UnpairSheet(daemonLabel = "6e7a1cdd29b0…", liveSessions = 6) }
    }

    @Test
    fun telemetry_dark() = ScreenshotHarness.render("telemetry_dark", dark = true) {
        ModalScreenshotHost { TelemetrySheet() }
    }

    @Test
    fun telemetry_light() = ScreenshotHarness.render("telemetry_light", dark = false) {
        ModalScreenshotHost { TelemetrySheet() }
    }

    @Test
    fun alert_dark() = ScreenshotHarness.render("alert_dark", dark = true) {
        ModalScreenshotHost { AlertSheet(offlineAlert) }
    }

    @Test
    fun alert_light() = ScreenshotHarness.render("alert_light", dark = false) {
        ModalScreenshotHost { AlertSheet(offlineAlert) }
    }

    @Test
    fun notif_permission_dark() = ScreenshotHarness.render("notif_permission_dark", dark = true) {
        ModalScreenshotHost { NotificationPermissionSheet() }
    }

    @Test
    fun notif_permission_light() = ScreenshotHarness.render("notif_permission_light", dark = false) {
        ModalScreenshotHost { NotificationPermissionSheet() }
    }

    private companion object {
        val offlineAlert = ShellyAlertMessage(
            kicker = "DAEMON CONNECTION TIMED OUT",
            title = "OFFLINE",
            meta = "transport timeout",
            body = "Shelly could not reach your computer. Make sure it is awake and shellyd is running, then try again.",
        )
    }
}
