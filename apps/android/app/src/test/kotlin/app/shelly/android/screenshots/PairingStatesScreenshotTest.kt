package app.shelly.android.screenshots

import app.shelly.android.features.pairing.PairingCameraDeniedContentPreview
import app.shelly.android.features.pairing.PairingConnectingContentPreview
import app.shelly.android.features.pairing.PairingErrorContentPreview
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w412dp-h892dp-420dpi")
class PairingStatesScreenshotTest {
    @Test
    fun pairing_connecting_dark() = ScreenshotHarness.render("pairing_connecting_dark", dark = true) {
        PairingConnectingContentPreview()
    }

    @Test
    fun pairing_connecting_light() = ScreenshotHarness.render("pairing_connecting_light", dark = false) {
        PairingConnectingContentPreview()
    }

    @Test
    fun pairing_camera_denied_dark() = ScreenshotHarness.render("pairing_camera_denied_dark", dark = true) {
        PairingCameraDeniedContentPreview()
    }

    @Test
    fun pairing_camera_denied_light() = ScreenshotHarness.render("pairing_camera_denied_light", dark = false) {
        PairingCameraDeniedContentPreview()
    }

    @Test
    fun pairing_error_dark() = ScreenshotHarness.render("pairing_error_dark", dark = true) {
        PairingErrorContentPreview()
    }

    @Test
    fun pairing_error_light() = ScreenshotHarness.render("pairing_error_light", dark = false) {
        PairingErrorContentPreview()
    }
}
