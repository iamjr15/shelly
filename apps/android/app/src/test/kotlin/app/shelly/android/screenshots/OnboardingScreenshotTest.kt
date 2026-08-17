package app.shelly.android.screenshots

import app.shelly.android.features.onboarding.GetStartedScreen
import app.shelly.android.features.onboarding.HowItWorksScreen
import app.shelly.android.features.onboarding.PrivacyScreen
import app.shelly.android.features.onboarding.WelcomeScreen
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w412dp-h892dp-420dpi")
class OnboardingScreenshotTest {
    @Test
    fun welcome_dark() = ScreenshotHarness.render("welcome_dark", dark = true) {
        WelcomeScreen()
    }

    @Test
    fun welcome_light() = ScreenshotHarness.render("welcome_light", dark = false) {
        WelcomeScreen()
    }

    @Test
    fun how_it_works_dark() = ScreenshotHarness.render("how_it_works_dark", dark = true) {
        HowItWorksScreen()
    }

    @Test
    fun how_it_works_light() = ScreenshotHarness.render("how_it_works_light", dark = false) {
        HowItWorksScreen()
    }

    @Test
    fun privacy_dark() = ScreenshotHarness.render("privacy_dark", dark = true) {
        PrivacyScreen()
    }

    @Test
    fun privacy_light() = ScreenshotHarness.render("privacy_light", dark = false) {
        PrivacyScreen()
    }

    @Test
    fun get_started_dark() = ScreenshotHarness.render("get_started_dark", dark = true) {
        GetStartedScreen()
    }

    @Test
    fun get_started_light() = ScreenshotHarness.render("get_started_light", dark = false) {
        GetStartedScreen()
    }

    @Test
    fun welcome_large_font() = ScreenshotHarness.render(
        "welcome_large_font",
        dark = false,
        variant = ScreenshotHarness.Variant.LargeFont,
    ) { WelcomeScreen() }

    @Test
    fun privacy_rtl() = ScreenshotHarness.render(
        "privacy_rtl",
        dark = false,
        variant = ScreenshotHarness.Variant.Rtl,
    ) { PrivacyScreen() }
}
