package app.shelly.android.screenshots

import app.shelly.android.features.onboarding.GetStartedContentPreview
import app.shelly.android.features.onboarding.HowItWorksContentPreview
import app.shelly.android.features.onboarding.PrivacyContentPreview
import app.shelly.android.features.onboarding.WelcomeContentPreview
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
        WelcomeContentPreview()
    }

    @Test
    fun welcome_light() = ScreenshotHarness.render("welcome_light", dark = false) {
        WelcomeContentPreview()
    }

    @Test
    fun how_it_works_dark() = ScreenshotHarness.render("how_it_works_dark", dark = true) {
        HowItWorksContentPreview()
    }

    @Test
    fun how_it_works_light() = ScreenshotHarness.render("how_it_works_light", dark = false) {
        HowItWorksContentPreview()
    }

    @Test
    fun privacy_dark() = ScreenshotHarness.render("privacy_dark", dark = true) {
        PrivacyContentPreview()
    }

    @Test
    fun privacy_light() = ScreenshotHarness.render("privacy_light", dark = false) {
        PrivacyContentPreview()
    }

    @Test
    fun get_started_dark() = ScreenshotHarness.render("get_started_dark", dark = true) {
        GetStartedContentPreview()
    }

    @Test
    fun get_started_light() = ScreenshotHarness.render("get_started_light", dark = false) {
        GetStartedContentPreview()
    }
}
