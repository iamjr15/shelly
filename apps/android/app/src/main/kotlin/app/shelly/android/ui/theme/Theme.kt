package app.shelly.android.ui.theme

import android.database.ContentObserver
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.animation.animateColorAsState
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
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
    val textMutedSubtle: Color,
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

/** Fixed dark terminal palette, named here so terminal chrome and transcript states share tokens. */
@Immutable
data class ShellyTerminalColors(
    val shellSurface: Color,
    val toolbar: Color,
    val tabSelected: Color,
    val tabSelectedText: Color,
    val tabInactive: Color,
    val keySurface: Color,
    val foreground: Color,
    val mutedBase: Color,
    val muted: Color,
    val mutedStrong: Color,
    val dim: Color,
    val success: Color,
    val error: Color,
    val diffPanel: Color,
    val border: Color,
    val soft: Color,
    val softText: Color,
    val editPath: Color,
    val codeMuted: Color,
    val choice: Color,
    val diffRemovedSurface: Color,
    val diffAddedSurface: Color,
    val choiceSelectedSurface: Color,
)

internal val ShellyTerminalPalette = ShellyTerminalColors(
    shellSurface = Color(0xFF1E1E2E),
    toolbar = Color(0xFF202033),
    tabSelected = Color(0xFF19382D),
    tabSelectedText = Color(0xFF83D4AF),
    tabInactive = Color(0xFF29293D),
    keySurface = Color(0xFF313244),
    foreground = Color(0xFFCDD6F4),
    mutedBase = Color(0xFF989EB6),
    muted = Color(0xFF9CA2BA),
    mutedStrong = Color(0xFFBAC2DE),
    dim = Color(0xFF949AB2),
    success = Color(0xFFA6E3A1),
    error = Color(0xFFF38BA8),
    diffPanel = Color(0xFF181825),
    border = Color(0xFF313244),
    soft = Color(0xFF585B70),
    softText = Color(0xFFA6ADC8),
    editPath = Color(0xFF89B4FA),
    codeMuted = Color(0xFF6E756F),
    choice = Color(0xFFF2A07E),
    diffRemovedSurface = Color(0x1FE0705E),
    diffAddedSurface = Color(0x1F6BC48E),
    choiceSelectedSurface = Color(0x29E85D29),
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
    textMutedSubtle = Color(0xFF6B6B68),
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
    textMutedSubtle = Color(0xFF9BA39D),
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

val LocalShellyColors = compositionLocalOf { DarkShellyColors }
val LocalShellyMotionEnabled = staticCompositionLocalOf { true }
val LocalShellyTerminalColors = staticCompositionLocalOf { ShellyTerminalPalette }

val ShellyColors.ink: Color get() = if (isDark) textPrimary else heroWordmark
val ShellyColors.mutedInk: Color get() = if (isDark) textMuted else heroWordmark

object ShellyTheme {
    val colors: ShellyColors
        @Composable @ReadOnlyComposable get() = LocalShellyColors.current
    val motionEnabled: Boolean
        @Composable @ReadOnlyComposable get() = LocalShellyMotionEnabled.current
    val terminalColors: ShellyTerminalColors
        @Composable @ReadOnlyComposable get() = LocalShellyTerminalColors.current
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
    val motionEnabled = animationsEnabled && systemAnimatorAnimationsEnabled()
    val target = if (darkTheme) DarkShellyColors else LightShellyColors
    val colors = animatedShellyColors(target, motionEnabled)
    val materialColors = remember(darkTheme) { materialScheme(target) }
    androidx.compose.runtime.CompositionLocalProvider(
        LocalShellyColors provides colors,
        LocalShellyMotionEnabled provides motionEnabled,
        LocalShellyTerminalColors provides ShellyTerminalPalette,
    ) {
        MaterialTheme(
            colorScheme = materialColors,
            typography = ShellyTypography,
            content = content,
        )
    }
}

@Composable
private fun systemAnimatorAnimationsEnabled(): Boolean {
    val context = LocalContext.current
    val resolver = context.contentResolver
    fun readScale(): Float = Settings.Global.getFloat(
        resolver,
        Settings.Global.ANIMATOR_DURATION_SCALE,
        1f,
    )
    var enabled by remember(resolver) { mutableStateOf(readScale() > 0f) }

    DisposableEffect(resolver) {
        val observer = object : ContentObserver(Handler(Looper.getMainLooper())) {
            override fun onChange(selfChange: Boolean) {
                enabled = readScale() > 0f
            }
        }
        resolver.registerContentObserver(
            Settings.Global.getUriFor(Settings.Global.ANIMATOR_DURATION_SCALE),
            false,
            observer,
        )
        enabled = readScale() > 0f
        onDispose { resolver.unregisterContentObserver(observer) }
    }
    return enabled
}

@Composable
private fun animatedShellyColors(target: ShellyColors, animationsEnabled: Boolean): ShellyColors {
    val spec = ShellyMotion.standardSpec<Color>(animationsEnabled)
    val screen by animateColorAsState(target.screen, spec, label = "shellyScreen")
    val hero by animateColorAsState(target.hero, spec, label = "shellyHero")
    val heroWordmark by animateColorAsState(target.heroWordmark, spec, label = "shellyHeroWordmark")
    val content by animateColorAsState(target.content, spec, label = "shellyContent")
    val insetCard by animateColorAsState(target.insetCard, spec, label = "shellyInsetCard")
    val modalCard by animateColorAsState(target.modalCard, spec, label = "shellyModalCard")
    val textPrimary by animateColorAsState(target.textPrimary, spec, label = "shellyTextPrimary")
    val textMuted by animateColorAsState(target.textMuted, spec, label = "shellyTextMuted")
    val textMutedSubtle by animateColorAsState(target.textMutedSubtle, spec, label = "shellyTextMutedSubtle")
    val accent by animateColorAsState(target.accent, spec, label = "shellyAccent")
    val onAccent by animateColorAsState(target.onAccent, spec, label = "shellyOnAccent")
    val divider by animateColorAsState(target.divider, spec, label = "shellyDivider")
    val surfaceSubtle by animateColorAsState(target.surfaceSubtle, spec, label = "shellySurfaceSubtle")
    val statusAwaiting by animateColorAsState(target.statusAwaiting, spec, label = "shellyStatusAwaiting")
    val statusWorking by animateColorAsState(target.statusWorking, spec, label = "shellyStatusWorking")
    val statusIdle by animateColorAsState(target.statusIdle, spec, label = "shellyStatusIdle")
    val statusCrashed by animateColorAsState(target.statusCrashed, spec, label = "shellyStatusCrashed")
    val buttonPrimary by animateColorAsState(target.buttonPrimary, spec, label = "shellyButtonPrimary")
    val onButtonPrimary by animateColorAsState(target.onButtonPrimary, spec, label = "shellyOnButtonPrimary")
    val destructive by animateColorAsState(target.destructive, spec, label = "shellyDestructive")

    return target.copy(
        screen = screen,
        hero = hero,
        heroWordmark = heroWordmark,
        content = content,
        insetCard = insetCard,
        modalCard = modalCard,
        textPrimary = textPrimary,
        textMuted = textMuted,
        textMutedSubtle = textMutedSubtle,
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
