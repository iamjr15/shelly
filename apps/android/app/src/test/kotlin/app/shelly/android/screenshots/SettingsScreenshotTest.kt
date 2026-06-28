package app.shelly.android.screenshots

import app.shelly.android.features.settings.AboutContentPreview
import app.shelly.android.features.settings.AppearanceContentPreview
import app.shelly.android.features.settings.DaemonDetailContentPreview
import app.shelly.android.features.settings.LicensesContentPreview
import app.shelly.android.features.settings.NotificationsContentPreview
import app.shelly.android.features.settings.SecurityContentPreview
import app.shelly.android.features.settings.SettingsContentPreview
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w412dp-h892dp-420dpi")
class SettingsScreenshotTest {
    @Test
    fun settings_dark() = ScreenshotHarness.render("settings_dark", dark = true) {
        SettingsContentPreview()
    }

    @Test
    fun settings_light() = ScreenshotHarness.render("settings_light", dark = false) {
        SettingsContentPreview()
    }

    @Test
    fun appearance_dark() = ScreenshotHarness.render("appearance_dark", dark = true) {
        AppearanceContentPreview()
    }

    @Test
    fun appearance_light() = ScreenshotHarness.render("appearance_light", dark = false) {
        AppearanceContentPreview()
    }

    @Test
    fun notifications_dark() = ScreenshotHarness.render("notifications_dark", dark = true) {
        NotificationsContentPreview()
    }

    @Test
    fun notifications_light() = ScreenshotHarness.render("notifications_light", dark = false) {
        NotificationsContentPreview()
    }

    @Test
    fun security_dark() = ScreenshotHarness.render("security_dark", dark = true) {
        SecurityContentPreview()
    }

    @Test
    fun security_light() = ScreenshotHarness.render("security_light", dark = false) {
        SecurityContentPreview()
    }

    @Test
    fun about_dark() = ScreenshotHarness.render("about_dark", dark = true) {
        AboutContentPreview()
    }

    @Test
    fun about_light() = ScreenshotHarness.render("about_light", dark = false) {
        AboutContentPreview()
    }

    @Test
    fun daemon_detail_dark() = ScreenshotHarness.render("daemon_detail_dark", dark = true) {
        DaemonDetailContentPreview()
    }

    @Test
    fun daemon_detail_light() = ScreenshotHarness.render("daemon_detail_light", dark = false) {
        DaemonDetailContentPreview()
    }

    @Test
    fun licenses_dark() = ScreenshotHarness.render("licenses_dark", dark = true) {
        LicensesContentPreview()
    }

    @Test
    fun licenses_light() = ScreenshotHarness.render("licenses_light", dark = false) {
        LicensesContentPreview()
    }
}
