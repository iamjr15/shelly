package app.shelly.android.screenshots

import android.os.Looper
import android.os.SystemClock
import android.view.View
import androidx.activity.ComponentActivity
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.platform.ComposeView
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.LayoutDirection
import app.shelly.android.core.UiTestClock
import app.shelly.android.ui.theme.ShellyTheme
import com.github.takahirom.roborazzi.RoborazziOptions
import com.github.takahirom.roborazzi.captureRoboImage
import org.robolectric.Robolectric
import org.robolectric.Shadows.shadowOf
import java.util.TimeZone

/**
 * Shared JVM screenshot renderer. Hosts a composable in a ComposeView on a Robolectric activity,
 * pumps the main looper, and delegates record/compare/verify behavior to Roborazzi.
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
    private const val FIXED_TIME_MILLIS = 1_700_000_000_000L

    data class Variant(
        val fontScale: Float = 1f,
        val layoutDirection: LayoutDirection = LayoutDirection.Ltr,
    ) {
        companion object {
            val LargeFont = Variant(fontScale = 1.3f)
            val Rtl = Variant(layoutDirection = LayoutDirection.Rtl)
        }
    }

    fun render(
        name: String,
        dark: Boolean,
        variant: Variant = Variant(),
        content: @Composable () -> Unit,
    ) {
        val mainLooper = shadowOf(Looper.getMainLooper()).apply { pause() }
        check(SystemClock.setCurrentTimeMillis(FIXED_TIME_MILLIS)) {
            "Unable to freeze Robolectric's clock for screenshot rendering"
        }
        UiTestClock.nowMillis = { FIXED_TIME_MILLIS }
        TimeZone.setDefault(TimeZone.getTimeZone("UTC"))

        val activity = Robolectric.buildActivity(ComponentActivity::class.java).setup().get()
        val view = ComposeView(activity).apply {
            setContent {
                val density = LocalDensity.current
                CompositionLocalProvider(
                    LocalDensity provides Density(
                        density = density.density,
                        fontScale = density.fontScale * variant.fontScale,
                    ),
                    LocalLayoutDirection provides variant.layoutDirection,
                ) {
                    ShellyTheme(darkTheme = dark, animationsEnabled = false, content = content)
                }
            }
        }
        activity.setContentView(view)
        mainLooper.idle()

        val dm = activity.resources.displayMetrics
        val w = dm.widthPixels
        val h = dm.heightPixels
        view.measure(
            View.MeasureSpec.makeMeasureSpec(w, View.MeasureSpec.EXACTLY),
            View.MeasureSpec.makeMeasureSpec(h, View.MeasureSpec.EXACTLY),
        )
        view.layout(0, 0, w, h)
        mainLooper.idle()

        // A small change-threshold tolerates sub-pixel/antialiasing and single-frame animation
        // jitter (observed ~0.05% of pixels) while still failing on real layout/color regressions,
        // which move far more than 0.2% of the image.
        view.captureRoboImage(
            "$name.png",
            roborazziOptions = RoborazziOptions(
                compareOptions = RoborazziOptions.CompareOptions(changeThreshold = 0.002f),
            ),
        )
    }
}
