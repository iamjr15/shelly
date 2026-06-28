package app.shelly.android.screenshots

import android.graphics.Bitmap
import android.graphics.Canvas
import android.os.Looper
import android.view.View
import androidx.activity.ComponentActivity
import androidx.compose.runtime.Composable
import androidx.compose.ui.platform.ComposeView
import app.shelly.android.ui.theme.ShellyTheme
import org.robolectric.Robolectric
import org.robolectric.Shadows.shadowOf
import java.io.File
import java.io.FileOutputStream

/**
 * Shared JVM screenshot renderer. Hosts a composable in a ComposeView on a Robolectric activity,
 * pumps the main looper, and draws the view to a PNG under apps/android/screenshots/.
 *
 * Bypasses the compose-ui-test idling machinery (which never settles under Robolectric).
 * Per-screen test classes call [render] — keep this the single source of the render logic so
 * screens can be added independently without touching a shared test file.
 *
 * Every test class must be annotated:
 *   @RunWith(RobolectricTestRunner::class)
 *   @GraphicsMode(GraphicsMode.Mode.NATIVE)
 *   @Config(sdk = [34], qualifiers = "w412dp-h892dp-420dpi")
 */
object ScreenshotHarness {
    private val outDir = File(System.getProperty("shelly.screenshotDir") ?: "build/screenshots")

    fun render(name: String, dark: Boolean, content: @Composable () -> Unit) {
        val activity = Robolectric.buildActivity(ComponentActivity::class.java).setup().get()
        val view = ComposeView(activity).apply {
            setContent { ShellyTheme(darkTheme = dark, animationsEnabled = false) { content() } }
        }
        activity.setContentView(view)
        shadowOf(Looper.getMainLooper()).idle()

        val dm = activity.resources.displayMetrics
        val w = dm.widthPixels
        val h = dm.heightPixels
        view.measure(
            View.MeasureSpec.makeMeasureSpec(w, View.MeasureSpec.EXACTLY),
            View.MeasureSpec.makeMeasureSpec(h, View.MeasureSpec.EXACTLY),
        )
        view.layout(0, 0, w, h)
        shadowOf(Looper.getMainLooper()).idle()

        val bitmap = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
        view.draw(Canvas(bitmap))
        outDir.mkdirs()
        FileOutputStream(File(outDir, "$name.png")).use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }
}
