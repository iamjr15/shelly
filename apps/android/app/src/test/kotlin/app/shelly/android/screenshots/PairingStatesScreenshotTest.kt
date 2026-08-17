package app.shelly.android.screenshots

import app.shelly.android.features.pairing.PairingUiState
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
        PairingScreenshotFixture(PairingUiState.Connecting)
    }

    @Test
    fun pairing_connecting_light() = ScreenshotHarness.render("pairing_connecting_light", dark = false) {
        PairingScreenshotFixture(PairingUiState.Connecting)
    }

    @Test
    fun pairing_sas_confirmation_dark() = ScreenshotHarness.render("pairing_sas_confirmation_dark", dark = true) {
        PairingScreenshotFixture(PairingUiState.ConfirmSas("84A9-FB21-1FC7-20DF-3B6E"))
    }

    @Test
    fun pairing_sas_confirmation_light() = ScreenshotHarness.render("pairing_sas_confirmation_light", dark = false) {
        PairingScreenshotFixture(PairingUiState.ConfirmSas("84A9-FB21-1FC7-20DF-3B6E"))
    }

    @Test
    fun pairing_camera_denied_dark() = ScreenshotHarness.render("pairing_camera_denied_dark", dark = true) {
        PairingScreenshotFixture(PairingUiState.CameraDenied)
    }

    @Test
    fun pairing_camera_denied_light() = ScreenshotHarness.render("pairing_camera_denied_light", dark = false) {
        PairingScreenshotFixture(PairingUiState.CameraDenied)
    }

    @Test
    fun pairing_error_dark() = ScreenshotHarness.render("pairing_error_dark", dark = true) {
        PairingScreenshotFixture(PairingUiState.Error())
    }

    @Test
    fun pairing_error_light() = ScreenshotHarness.render("pairing_error_light", dark = false) {
        PairingScreenshotFixture(PairingUiState.Error())
    }
}
