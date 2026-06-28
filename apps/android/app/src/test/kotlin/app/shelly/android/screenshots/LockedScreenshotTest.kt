package app.shelly.android.screenshots

import app.shelly.android.features.lock.LockedContentPreview
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** Locked screen (B55/B03). */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w412dp-h892dp-420dpi")
class LockedScreenshotTest {
    @Test
    fun locked_dark() = ScreenshotHarness.render("locked_dark", dark = true) {
        LockedContentPreview()
    }

    @Test
    fun locked_light() = ScreenshotHarness.render("locked_light", dark = false) {
        LockedContentPreview()
    }
}
