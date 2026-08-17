package app.shelly.android.screenshots

import app.shelly.android.features.settings.AboutScreen
import app.shelly.android.features.settings.AppearanceScreen
import app.shelly.android.features.settings.DaemonDetailScreen
import app.shelly.android.features.settings.LicensesScreen
import app.shelly.android.features.settings.NotificationsScreen
import app.shelly.android.features.settings.SecurityScreen
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
        SettingsScreenshotFixture()
    }

    @Test
    fun settings_light() = ScreenshotHarness.render("settings_light", dark = false) {
        SettingsScreenshotFixture()
    }

    @Test
    fun appearance_dark() = ScreenshotHarness.render("appearance_dark", dark = true) {
        AppearanceScreen(onBack = {})
    }

    @Test
    fun appearance_light() = ScreenshotHarness.render("appearance_light", dark = false) {
        AppearanceScreen(onBack = {})
    }

    @Test
    fun notifications_dark() = ScreenshotHarness.render("notifications_dark", dark = true) {
        NotificationsScreen(onBack = {})
    }

    @Test
    fun notifications_light() = ScreenshotHarness.render("notifications_light", dark = false) {
        NotificationsScreen(onBack = {})
    }

    @Test
    fun security_dark() = ScreenshotHarness.render("security_dark", dark = true) {
        SecurityScreen(onBack = {})
    }

    @Test
    fun security_light() = ScreenshotHarness.render("security_light", dark = false) {
        SecurityScreen(onBack = {})
    }

    @Test
    fun about_dark() = ScreenshotHarness.render("about_dark", dark = true) {
        AboutScreen(onBack = {}, protocol = "v3", dependencyCount = "16 notices")
    }

    @Test
    fun about_light() = ScreenshotHarness.render("about_light", dark = false) {
        AboutScreen(onBack = {}, protocol = "v3", dependencyCount = "16 notices")
    }

    @Test
    fun daemon_detail_dark() = ScreenshotHarness.render("daemon_detail_dark", dark = true) {
        DaemonDetailScreen(onBack = {}, hostName = "dev-macbook", protocol = "v3")
    }

    @Test
    fun daemon_detail_light() = ScreenshotHarness.render("daemon_detail_light", dark = false) {
        DaemonDetailScreen(onBack = {}, hostName = "dev-macbook", protocol = "v3")
    }

    @Test
    fun licenses_dark() = ScreenshotHarness.render("licenses_dark", dark = true) {
        LicensesScreen(onBack = {})
    }

    @Test
    fun licenses_light() = ScreenshotHarness.render("licenses_light", dark = false) {
        LicensesScreen(onBack = {})
    }
}
