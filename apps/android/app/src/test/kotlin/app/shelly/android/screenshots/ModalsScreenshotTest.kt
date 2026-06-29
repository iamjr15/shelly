package app.shelly.android.screenshots

import app.shelly.android.features.modals.AlertSheetPreview
import app.shelly.android.features.modals.NotificationPermissionSheetPreview
import app.shelly.android.features.modals.TelemetrySheetPreview
import app.shelly.android.features.modals.UnpairSheetPreview
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
        UnpairSheetPreview()
    }

    @Test
    fun unpair_light() = ScreenshotHarness.render("unpair_light", dark = false) {
        UnpairSheetPreview()
    }

    @Test
    fun telemetry_dark() = ScreenshotHarness.render("telemetry_dark", dark = true) {
        TelemetrySheetPreview()
    }

    @Test
    fun telemetry_light() = ScreenshotHarness.render("telemetry_light", dark = false) {
        TelemetrySheetPreview()
    }

    @Test
    fun alert_dark() = ScreenshotHarness.render("alert_dark", dark = true) {
        AlertSheetPreview()
    }

    @Test
    fun alert_light() = ScreenshotHarness.render("alert_light", dark = false) {
        AlertSheetPreview()
    }

    @Test
    fun notif_permission_dark() = ScreenshotHarness.render("notif_permission_dark", dark = true) {
        NotificationPermissionSheetPreview()
    }

    @Test
    fun notif_permission_light() = ScreenshotHarness.render("notif_permission_light", dark = false) {
        NotificationPermissionSheetPreview()
    }
}
