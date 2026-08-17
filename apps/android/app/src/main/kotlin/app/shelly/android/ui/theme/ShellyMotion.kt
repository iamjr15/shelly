package app.shelly.android.ui.theme

import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.DurationBasedAnimationSpec
import androidx.compose.animation.core.Easing
import androidx.compose.animation.core.FiniteAnimationSpec
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.snap
import androidx.compose.animation.core.tween
import androidx.compose.foundation.interaction.InteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue

object ShellyMotion {
    const val FastMillis = 140
    const val StandardMillis = 220
    const val RouteMillis = 280

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

    fun <T> durationSpec(
        motionEnabled: Boolean,
        durationMillis: Int,
        easing: Easing = EmphasizedEasing,
    ): FiniteAnimationSpec<T> = if (motionEnabled) {
        tween(durationMillis = durationMillis, easing = easing)
    } else {
        snap()
    }

    fun <T> repeatingSpec(
        motionEnabled: Boolean,
        durationMillis: Int,
        easing: Easing = Linear,
    ): DurationBasedAnimationSpec<T> = if (motionEnabled) {
        tween(durationMillis = durationMillis, easing = easing)
    } else {
        snap()
    }

    fun <T> standardSpec(motionEnabled: Boolean): FiniteAnimationSpec<T> =
        if (motionEnabled) standardTween() else snap()

    fun <T> fastSpec(motionEnabled: Boolean): FiniteAnimationSpec<T> =
        if (motionEnabled) fastTween() else snap()

    fun <T> routeSpec(motionEnabled: Boolean): FiniteAnimationSpec<T> =
        if (motionEnabled) routeTween() else snap()

    @Composable
    fun <T> standardSpec(): FiniteAnimationSpec<T> =
        standardSpec(ShellyTheme.motionEnabled)

    @Composable
    fun <T> fastSpec(): FiniteAnimationSpec<T> =
        fastSpec(ShellyTheme.motionEnabled)

    @Composable
    fun <T> routeSpec(): FiniteAnimationSpec<T> =
        routeSpec(ShellyTheme.motionEnabled)

    @Composable
    fun <T> durationSpec(
        durationMillis: Int,
        easing: Easing = EmphasizedEasing,
    ): FiniteAnimationSpec<T> = durationSpec(ShellyTheme.motionEnabled, durationMillis, easing)

    @Composable
    fun <T> repeatingSpec(
        durationMillis: Int,
        easing: Easing = Linear,
    ): DurationBasedAnimationSpec<T> = repeatingSpec(ShellyTheme.motionEnabled, durationMillis, easing)
}

@Composable
internal fun shellyPressScale(
    interactionSource: InteractionSource,
    pressedScale: Float = 0.975f,
): Float {
    val pressed by interactionSource.collectIsPressedAsState()
    val scale by animateFloatAsState(
        targetValue = if (pressed) pressedScale else 1f,
        animationSpec = ShellyMotion.fastSpec(),
        label = "shellyPressScale",
    )
    return scale
}
