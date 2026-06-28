package app.shelly.android.screenshots

import app.shelly.android.features.pairing.PairingContentPreview
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** Pairing screen (B48/B06). Renders the camera-off preview via [ScreenshotHarness]. */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w412dp-h892dp-420dpi")
class PairingScreenshotTest {
    @Test
    fun pairing_dark() = ScreenshotHarness.render("pairing_dark", dark = true) {
        PairingContentPreview()
    }

    @Test
    fun pairing_light() = ScreenshotHarness.render("pairing_light", dark = false) {
        PairingContentPreview()
    }
}
