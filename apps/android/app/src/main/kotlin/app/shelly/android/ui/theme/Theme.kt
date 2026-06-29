package app.shelly.android.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.animation.animateColorAsState
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp

/** Safety-orange brand accent — identical in both modes. */
val ShellyOrange = Color(0xFFE85D29)

/**
 * Extended palette pulled straight from the Paper design system. Material's
 * ColorScheme can't express every brand role, so screens read these directly.
 */
@Immutable
data class ShellyColors(
    val isDark: Boolean,
    val screen: Color,         // outermost background (the black "bezel")
    val hero: Color,           // hero card background
    val heroWordmark: Color,   // big display wordmark color on the hero
    val content: Color,        // content card background
    val insetCard: Color,      // inset surfaces (activity card, recent chips, code preview)
    val modalCard: Color,      // elevated modal card
    val textPrimary: Color,
    val textMuted: Color,
    val accent: Color,         // orange
    val onAccent: Color,       // text/icon sitting on the orange accent
    val divider: Color,
    val surfaceSubtle: Color,  // icon-button circle / inactive chip fill
    val statusAwaiting: Color,
    val statusWorking: Color,
    val statusIdle: Color,     // outline stroke for idle dot
    val statusCrashed: Color,
    val buttonPrimary: Color,
    val onButtonPrimary: Color,
    val destructive: Color,
)

private val LightShellyColors = ShellyColors(
    isDark = false,
    screen = Color(0xFF000000),
    hero = ShellyOrange,
    heroWordmark = Color(0xFF000000),
    content = Color(0xFFFFFFFF),
    insetCard = Color(0xFFF4F3F1),
    modalCard = Color(0xFFFFFFFF),
    textPrimary = Color(0xFF111111),
    textMuted = Color(0xFF747471),
    accent = ShellyOrange,
    onAccent = Color(0xFF111111),
    divider = Color(0xFFE5E5E5),
    surfaceSubtle = Color(0x14000000),
    statusAwaiting = ShellyOrange,
    statusWorking = Color(0xFF111111),
    statusIdle = Color(0xFF9A9A97),
    statusCrashed = Color(0xFFA8423B),
    buttonPrimary = Color(0xFF111111),
    onButtonPrimary = Color(0xFFFFFFFF),
    destructive = Color(0xFFC0392B),
)

private val DarkShellyColors = ShellyColors(
    isDark = true,
    screen = Color(0xFF000000),
    hero = Color(0xFF0B0D0C),
    heroWordmark = ShellyOrange,
    content = Color(0xFF17191B),
    insetCard = Color(0xFF202325),
    modalCard = Color(0xFF1E2123),
    textPrimary = Color(0xFFE8EAE5),
    textMuted = Color(0xFF8B938D),
    accent = ShellyOrange,
    onAccent = Color(0xFF0B0D0C),
    divider = Color(0x14FFFFFF),
    surfaceSubtle = Color(0x1AFFFFFF),
    statusAwaiting = ShellyOrange,
    statusWorking = Color(0xFFE8EAE5),
    statusIdle = Color(0xFF8B938D),
    statusCrashed = Color(0xFFA8423B),
    buttonPrimary = Color(0xFFE8EAE5),
    onButtonPrimary = Color(0xFF0B0D0C),
    destructive = Color(0xFFD0584B),
)

val LocalShellyColors = staticCompositionLocalOf { DarkShellyColors }
val LocalShellyMotionEnabled = staticCompositionLocalOf { true }

object ShellyTheme {
    val colors: ShellyColors
        @Composable @ReadOnlyComposable get() = LocalShellyColors.current
    val motionEnabled: Boolean
        @Composable @ReadOnlyComposable get() = LocalShellyMotionEnabled.current
}

/** Shared geometry constants from the design. */
object ShellyDimens {
    val screenInset = 16.dp       // black margin around the card stack
    val cardRadius = 24.dp        // hero / content card corner radius
    val heroHeight = 313.dp       // uniform orange hero height
    val heroPaddingH = 24.dp
    val contentPaddingH = 24.dp
}

private fun materialScheme(c: ShellyColors) = if (c.isDark) {
    darkColorScheme(
        primary = c.accent,
        onPrimary = c.onAccent,
        background = c.screen,
        onBackground = c.textPrimary,
        surface = c.content,
        onSurface = c.textPrimary,
        surfaceVariant = c.insetCard,
        onSurfaceVariant = c.textMuted,
        outline = c.divider,
        error = c.destructive,
    )
} else {
    lightColorScheme(
        primary = c.accent,
        onPrimary = c.onAccent,
        background = c.screen,
        onBackground = c.textPrimary,
        surface = c.content,
        onSurface = c.textPrimary,
        surfaceVariant = c.insetCard,
        onSurfaceVariant = c.textMuted,
        outline = c.divider,
        error = c.destructive,
    )
}

@Composable
fun ShellyTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    animationsEnabled: Boolean = true,
    content: @Composable () -> Unit,
) {
    val colors = animatedShellyColors(if (darkTheme) DarkShellyColors else LightShellyColors)
    androidx.compose.runtime.CompositionLocalProvider(
        LocalShellyColors provides colors,
        LocalShellyMotionEnabled provides animationsEnabled,
    ) {
        MaterialTheme(
            colorScheme = materialScheme(colors),
            typography = ShellyTypography,
            content = content,
        )
    }
}

@Composable
private fun animatedShellyColors(target: ShellyColors): ShellyColors {
    val screen by animateColorAsState(target.screen, ShellyMotion.standardTween(), label = "shellyScreen")
    val hero by animateColorAsState(target.hero, ShellyMotion.standardTween(), label = "shellyHero")
    val heroWordmark by animateColorAsState(target.heroWordmark, ShellyMotion.standardTween(), label = "shellyHeroWordmark")
    val content by animateColorAsState(target.content, ShellyMotion.standardTween(), label = "shellyContent")
    val insetCard by animateColorAsState(target.insetCard, ShellyMotion.standardTween(), label = "shellyInsetCard")
    val modalCard by animateColorAsState(target.modalCard, ShellyMotion.standardTween(), label = "shellyModalCard")
    val textPrimary by animateColorAsState(target.textPrimary, ShellyMotion.standardTween(), label = "shellyTextPrimary")
    val textMuted by animateColorAsState(target.textMuted, ShellyMotion.standardTween(), label = "shellyTextMuted")
    val accent by animateColorAsState(target.accent, ShellyMotion.standardTween(), label = "shellyAccent")
    val onAccent by animateColorAsState(target.onAccent, ShellyMotion.standardTween(), label = "shellyOnAccent")
    val divider by animateColorAsState(target.divider, ShellyMotion.standardTween(), label = "shellyDivider")
    val surfaceSubtle by animateColorAsState(target.surfaceSubtle, ShellyMotion.standardTween(), label = "shellySurfaceSubtle")
    val statusAwaiting by animateColorAsState(target.statusAwaiting, ShellyMotion.standardTween(), label = "shellyStatusAwaiting")
    val statusWorking by animateColorAsState(target.statusWorking, ShellyMotion.standardTween(), label = "shellyStatusWorking")
    val statusIdle by animateColorAsState(target.statusIdle, ShellyMotion.standardTween(), label = "shellyStatusIdle")
    val statusCrashed by animateColorAsState(target.statusCrashed, ShellyMotion.standardTween(), label = "shellyStatusCrashed")
    val buttonPrimary by animateColorAsState(target.buttonPrimary, ShellyMotion.standardTween(), label = "shellyButtonPrimary")
    val onButtonPrimary by animateColorAsState(target.onButtonPrimary, ShellyMotion.standardTween(), label = "shellyOnButtonPrimary")
    val destructive by animateColorAsState(target.destructive, ShellyMotion.standardTween(), label = "shellyDestructive")

    return target.copy(
        screen = screen,
        hero = hero,
        heroWordmark = heroWordmark,
        content = content,
        insetCard = insetCard,
        modalCard = modalCard,
        textPrimary = textPrimary,
        textMuted = textMuted,
        accent = accent,
        onAccent = onAccent,
        divider = divider,
        surfaceSubtle = surfaceSubtle,
        statusAwaiting = statusAwaiting,
        statusWorking = statusWorking,
        statusIdle = statusIdle,
        statusCrashed = statusCrashed,
        buttonPrimary = buttonPrimary,
        onButtonPrimary = onButtonPrimary,
        destructive = destructive,
    )
}
