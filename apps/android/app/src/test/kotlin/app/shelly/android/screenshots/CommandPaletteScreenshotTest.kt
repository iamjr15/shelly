package app.shelly.android.screenshots

import app.shelly.android.features.palette.CommandPaletteContentPreview
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** Command palette screen (B44/B09). */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w412dp-h892dp-420dpi")
class CommandPaletteScreenshotTest {
    @Test
    fun command_palette_dark() = ScreenshotHarness.render("command_palette_dark", dark = true) {
        CommandPaletteContentPreview()
    }

    @Test
    fun command_palette_light() = ScreenshotHarness.render("command_palette_light", dark = false) {
        CommandPaletteContentPreview()
    }
}
