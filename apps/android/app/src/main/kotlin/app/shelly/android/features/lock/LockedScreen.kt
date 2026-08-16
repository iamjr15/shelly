package app.shelly.android.features.lock

import android.content.Context
import android.text.format.DateFormat
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import app.shelly.android.ui.components.HeroBody
import app.shelly.android.ui.components.DoubleChevronGlyph
import app.shelly.android.ui.components.SettingsGlyph
import app.shelly.android.ui.components.SettingsGlyphIcon
import app.shelly.android.ui.components.ShellyScreen
import app.shelly.android.ui.theme.LocalShellyColors
import app.shelly.android.ui.theme.ShellyColors
import app.shelly.android.ui.theme.ShellyTheme
import app.shelly.android.ui.theme.ShellyType
import app.shelly.android.ui.theme.ink
import app.shelly.android.ui.theme.shellyPressScale
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlinx.coroutines.delay

@Composable
fun LockedScreen(
    onUnlock: () -> Unit = {},
    unavailableMessage: String? = null,
) {
    val c = ShellyTheme.colors
    ShellyScreen(
        heroHeight = 338.dp,
        contentBackground = lockedContentBackground(c),
        hero = { LockedHero() },
        content = { LockedContent(onUnlock = onUnlock, unavailableMessage = unavailableMessage) },
    )
}

@Composable
private fun ColumnScope.LockedHero() {
    val c = ShellyTheme.colors
    val heroForeground = lockedHeroForeground(c)

    CompositionLocalProvider(LocalShellyColors provides c.copy(textPrimary = heroForeground)) {
        HeroBody(
            eyebrow = "PRIVATE ON THIS PHONE\nUNTIL YOU UNLOCK",
            wordmark = "LOCK",
            wordmarkSize = 100.sp,
            brandTrailing = {
                LockedDate(
                    primary = heroForeground,
                    muted = lockedHeroDateMuted(c, heroForeground),
                )
            },
        )
    }
}

@Composable
private fun LockedDate(primary: Color, muted: Color) {
    val context = LocalContext.current
    var clock by remember(context) { mutableStateOf(currentClock(context)) }
    LaunchedEffect(context) {
        while (true) {
            clock = currentClock(context)
            delay(60_000L - (System.currentTimeMillis() % 60_000L))
        }
    }
    val (clockTime, clockDay) = clock
    Row(
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            clockTime,
            style = ShellyType.brand.copy(
                fontWeight = FontWeight.Medium,
                letterSpacing = 0.em,
            ),
            color = primary,
            modifier = Modifier.alignByBaseline(),
        )
        Text(
            clockDay,
            style = ShellyType.mono.copy(
                fontFamily = ShellyType.brand.fontFamily,
                fontSize = 13.sp,
                lineHeight = 16.sp,
                fontWeight = FontWeight.Normal,
            ),
            color = muted,
            modifier = Modifier.alignByBaseline(),
        )
    }
}

@Composable
private fun ColumnScope.LockedContent(onUnlock: () -> Unit, unavailableMessage: String?) {
    Box(
        Modifier
            .fillMaxWidth()
            .weight(1f),
        contentAlignment = Alignment.Center,
    ) {
        LargeLockIcon()
    }
    unavailableMessage?.let {
        Text(
            text = it,
            style = ShellyType.monoSmall,
            color = ShellyTheme.colors.textMuted,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.padding(bottom = 12.dp),
        )
    }
    UnlockButton(onUnlock = onUnlock)
}

@Composable
private fun LargeLockIcon() {
    val c = ShellyTheme.colors
    Box(
        Modifier.size(width = 160.dp, height = 180.dp),
        contentAlignment = Alignment.Center,
    ) {
        androidx.compose.foundation.Canvas(Modifier.size(width = 150.dp, height = 168.dp)) {
            val sx = size.width / 160f
            val sy = size.height / 180f
            val lineScale = minOf(sx, sy)
            val outline = Stroke(
                width = 9f * lineScale,
                cap = StrokeCap.Round,
                join = StrokeJoin.Round,
            )
            val shackle = Path().apply {
                moveTo(44f * sx, 72f * sy)
                lineTo(44f * sx, 50f * sy)
                cubicTo(44f * sx, 27f * sy, 59f * sx, 12f * sy, 80f * sx, 12f * sy)
                cubicTo(101f * sx, 12f * sy, 116f * sx, 27f * sy, 116f * sx, 50f * sy)
                lineTo(116f * sx, 72f * sy)
            }
            drawPath(shackle, color = c.ink, style = outline)
            drawRoundRect(
                color = c.ink,
                topLeft = Offset(25f * sx, 70f * sy),
                size = Size(110f * sx, 91f * sy),
                cornerRadius = CornerRadius(14f * sx, 14f * sy),
                style = outline,
            )
            drawCircle(
                color = c.accent,
                radius = 8f * lineScale,
                center = Offset(80f * sx, 111f * sy),
            )
            drawLine(
                color = c.accent,
                start = Offset(80f * sx, 119f * sy),
                end = Offset(80f * sx, 137f * sy),
                strokeWidth = 8f * lineScale,
                cap = StrokeCap.Round,
            )
        }
    }
}

@Composable
private fun UnlockButton(onUnlock: () -> Unit, modifier: Modifier = Modifier) {
    val c = ShellyTheme.colors
    val background = lockedButtonBackground(c)
    val foreground = lockedButtonForeground(c)
    val leadingIcon = if (c.isDark) foreground else c.accent
    val interactionSource = remember { MutableInteractionSource() }
    val scale = shellyPressScale(interactionSource, pressedScale = 0.975f)

    Row(
        modifier
            .fillMaxWidth()
            .graphicsLayer {
                scaleX = scale
                scaleY = scale
            }
            .clip(RoundedCornerShape(8.dp))
            .background(background)
            .clickable(
                interactionSource = interactionSource,
                indication = null,
                onClick = onUnlock,
            )
            .height(58.dp)
            .padding(horizontal = 18.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            SettingsGlyphIcon(SettingsGlyph.Fingerprint, color = leadingIcon, size = 22.dp)
            Text(
                "Unlock now",
                style = ShellyType.button.copy(
                    fontSize = 20.sp,
                    lineHeight = 24.sp,
                    letterSpacing = 0.em,
                ),
                color = foreground,
            )
        }
        DoubleChevronGlyph(color = foreground, size = 22.dp)
    }
}

private fun currentClock(context: Context): Pair<String, String> {
    val now = Date()
    val time = DateFormat.getTimeFormat(context).format(now)
    val day = SimpleDateFormat("EEE", Locale.getDefault()).format(now).uppercase(Locale.getDefault())
    return time to day
}

private fun lockedHeroForeground(c: ShellyColors): Color =
    c.ink

private fun lockedHeroDateMuted(c: ShellyColors, primary: Color): Color =
    if (c.isDark) c.textMuted.copy(alpha = 0.6f) else primary.copy(alpha = 0.6f)

private fun lockedContentBackground(c: ShellyColors): Color =
    if (c.isDark) c.content else Color(0xFFF1EFE8)

private fun lockedButtonBackground(c: ShellyColors): Color =
    if (c.isDark) c.buttonPrimary else c.heroWordmark

private fun lockedButtonForeground(c: ShellyColors): Color =
    if (c.isDark) c.onButtonPrimary else c.content

@Composable
internal fun LockedContentPreview() {
    LockedScreen()
}
