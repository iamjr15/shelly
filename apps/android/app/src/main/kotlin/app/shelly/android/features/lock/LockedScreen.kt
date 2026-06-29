package app.shelly.android.features.lock

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import app.shelly.android.ui.components.HeroBody
import app.shelly.android.ui.components.ShellyScreen
import app.shelly.android.ui.theme.LocalShellyColors
import app.shelly.android.ui.theme.ShellyColors
import app.shelly.android.ui.theme.ShellyTheme
import app.shelly.android.ui.theme.ShellyType
import app.shelly.android.ui.theme.shellyPressScale

@Composable
fun LockedScreen(
    onUnlock: () -> Unit = {},
    unavailableMessage: String? = null,
) {
    ShellyScreen(
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
            eyebrow = "UNLOCK TO SEE YOUR\nSESSIONS · 5 MIN AGO",
            wordmark = "LOCK",
            wordmarkSize = 96.sp,
            brandTrailing = {
                LockedDate(
                    primary = heroForeground,
                    muted = lockedHeroDateMuted(c, heroForeground),
                )
            },
            below = {
                LockedHeroStatus(
                    primary = heroForeground,
                    muted = lockedHeroStatusMuted(c, heroForeground),
                )
            },
        )
    }
}

@Composable
private fun LockedDate(primary: Color, muted: Color) {
    Row(
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            "9:41 AM",
            style = ShellyType.brand.copy(
                fontWeight = FontWeight.Medium,
                letterSpacing = 0.em,
            ),
            color = primary,
            modifier = Modifier.alignByBaseline(),
        )
        Text(
            "Thu",
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
private fun LockedHeroStatus(primary: Color, muted: Color) {
    Text(
        "HELD SINCE 9:36 AM",
        style = ShellyType.monoSmall.copy(
            fontWeight = FontWeight.SemiBold,
            letterSpacing = 0.06.em,
        ),
        color = muted,
        modifier = Modifier.padding(bottom = 6.dp),
    )
    Text(
        "Backgrounded · keystrokes blocked until biometric refresh",
        style = ShellyType.itemTitle.copy(
            fontSize = 17.sp,
            lineHeight = 24.sp,
            fontWeight = FontWeight.Medium,
        ),
        color = primary,
    )
    Spacer(Modifier.height(6.6.dp))
}

@Composable
private fun ColumnScope.LockedContent(onUnlock: () -> Unit, unavailableMessage: String?) {
    Spacer(Modifier.height(4.dp))
    Spacer(Modifier.height(76.dp))
    ActivityCard(Modifier.padding(top = 16.dp))
    Spacer(Modifier.weight(1f))
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
    UnlockButton(onUnlock = onUnlock, modifier = Modifier.padding(bottom = 4.dp))
}

@Composable
private fun ActivityCard(modifier: Modifier = Modifier) {
    val c = ShellyTheme.colors
    val primary = lockedContentPrimary(c)
    val muted = lockedContentMuted(c, primary)

    Column(
        modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .background(lockedActivityCardColor(c))
            .padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text(
            "WHILE YOU WERE AWAY",
            style = ShellyType.microLabel.copy(
                fontSize = 10.sp,
                lineHeight = 12.sp,
                letterSpacing = 0.06.em,
            ),
            color = muted,
        )
        ActivityRow(
            dot = c.accent,
            title = "shelly · pkg/cli",
            subtitle = "awaiting input · 12s",
            primary = primary,
            muted = muted,
        )
        ActivityRow(
            dot = primary,
            title = "infra · scripts/dogfood",
            subtitle = "build started · 4m",
            primary = primary,
            muted = muted,
        )
    }
}

@Composable
private fun ActivityRow(
    dot: Color,
    title: String,
    subtitle: String,
    primary: Color,
    muted: Color,
) {
    Row(
        verticalAlignment = Alignment.Top,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Box(
            Modifier
                .padding(top = 6.dp)
                .size(8.dp)
                .clip(CircleShape)
                .background(dot),
        )
        Column(Modifier.weight(1f)) {
            Text(
                title,
                style = ShellyType.rowTitle.copy(
                    fontSize = 14.sp,
                    lineHeight = 18.sp,
                    fontWeight = FontWeight.SemiBold,
                ),
                color = primary,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                subtitle,
                style = ShellyType.monoSmall.copy(
                    fontSize = 11.sp,
                    lineHeight = 14.sp,
                ),
                color = muted.copy(alpha = 0.6f),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
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
            .clip(RoundedCornerShape(6.dp))
            .background(background)
            .clickable(
                interactionSource = interactionSource,
                indication = null,
                onClick = onUnlock,
            )
            .padding(horizontal = 20.dp, vertical = 16.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            FingerprintIcon(color = leadingIcon, modifier = Modifier.size(22.dp))
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
        DoubleChevronIcon(color = foreground, modifier = Modifier.size(22.dp))
    }
}

@Composable
private fun FingerprintIcon(color: Color, modifier: Modifier = Modifier) {
    Canvas(modifier) {
        val sx = size.width / 24f
        val sy = size.height / 24f
        fun x(value: Float) = value * sx
        fun y(value: Float) = value * sy
        fun path(block: Path.() -> Unit) {
            drawPath(
                Path().apply(block),
                color = color,
                style = Stroke(
                    width = 2f * sx,
                    cap = StrokeCap.Round,
                    join = StrokeJoin.Round,
                ),
            )
        }

        path {
            moveTo(x(2f), y(12f))
            cubicTo(x(2f), y(6.5f), x(6.5f), y(2f), x(12f), y(2f))
            cubicTo(x(15.2f), y(2f), x(18f), y(3.5f), x(20f), y(6f))
        }
        path {
            moveTo(x(5f), y(19.5f))
            cubicTo(x(5.5f), y(18f), x(6f), y(15f), x(6f), y(12f))
            cubicTo(x(6f), y(11.3f), x(6.12f), y(10.63f), x(6.34f), y(10f))
        }
        path {
            moveTo(x(14f), y(13.12f))
            cubicTo(x(14f), y(15.5f), x(14f), y(19.5f), x(13f), y(22f))
        }
        path {
            moveTo(x(9f), y(6.8f))
            cubicTo(x(10f), y(6.3f), x(11f), y(6f), x(12f), y(6f))
            cubicTo(x(15.3f), y(6f), x(18f), y(8.7f), x(18f), y(12f))
            cubicTo(x(18f), y(12.47f), x(18f), y(13.17f), x(17.98f), y(14f))
        }
    }
}

@Composable
private fun DoubleChevronIcon(color: Color, modifier: Modifier = Modifier) {
    Canvas(modifier) {
        val stroke = Stroke(
            width = 2.dp.toPx(),
            cap = StrokeCap.Round,
            join = StrokeJoin.Round,
        )

        fun polyline(firstX: Float, secondX: Float, thirdX: Float) {
            val path = Path().apply {
                moveTo(firstX / 24f * size.width, 6f / 24f * size.height)
                lineTo(secondX / 24f * size.width, 12f / 24f * size.height)
                lineTo(thirdX / 24f * size.width, 18f / 24f * size.height)
            }
            drawPath(path, color = color, style = stroke)
        }

        polyline(6f, 12f, 6f)
        polyline(13f, 19f, 13f)
    }
}

private fun lockedHeroForeground(c: ShellyColors): Color =
    if (c.isDark) c.textPrimary else c.heroWordmark

private fun lockedHeroDateMuted(c: ShellyColors, primary: Color): Color =
    if (c.isDark) c.textMuted.copy(alpha = 0.6f) else primary.copy(alpha = 0.6f)

private fun lockedHeroStatusMuted(c: ShellyColors, primary: Color): Color =
    if (c.isDark) c.textMuted.copy(alpha = 0.7f) else primary.copy(alpha = 0.7f)

private fun lockedContentPrimary(c: ShellyColors): Color =
    if (c.isDark) c.textPrimary else c.heroWordmark

private fun lockedContentMuted(c: ShellyColors, primary: Color): Color =
    if (c.isDark) c.textMuted else primary

private fun lockedActivityCardColor(c: ShellyColors): Color =
    if (c.isDark) c.insetCard else Color(0xFFF5F5F0)

private fun lockedButtonBackground(c: ShellyColors): Color =
    if (c.isDark) c.buttonPrimary else c.heroWordmark

private fun lockedButtonForeground(c: ShellyColors): Color =
    if (c.isDark) c.onButtonPrimary else c.content

@Composable
internal fun LockedContentPreview() {
    LockedScreen()
}
