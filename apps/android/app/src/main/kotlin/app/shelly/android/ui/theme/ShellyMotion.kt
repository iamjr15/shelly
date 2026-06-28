package app.shelly.android.ui.theme

import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.interaction.InteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue

object ShellyMotion {
    const val FastMillis = 140
    const val StandardMillis = 220
    const val RouteMillis = 280
    const val SlowMillis = 900

    val EmphasizedEasing = FastOutSlowInEasing
    val Linear = LinearEasing

    fun <T> standardTween() = tween<T>(
        durationMillis = StandardMillis,
        easing = EmphasizedEasing,
    )

    fun <T> fastTween() = tween<T>(
        durationMillis = FastMillis,
        easing = EmphasizedEasing,
    )

    fun <T> routeTween() = tween<T>(
        durationMillis = RouteMillis,
        easing = EmphasizedEasing,
    )
}

@Composable
internal fun shellyPressScale(
    interactionSource: InteractionSource,
    pressedScale: Float = 0.975f,
): Float {
    val pressed by interactionSource.collectIsPressedAsState()
    val scale by animateFloatAsState(
        targetValue = if (pressed) pressedScale else 1f,
        animationSpec = ShellyMotion.fastTween(),
        label = "shellyPressScale",
    )
    return scale
}
