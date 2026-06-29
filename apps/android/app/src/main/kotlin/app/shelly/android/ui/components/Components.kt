package app.shelly.android.ui.components

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.foundation.background
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.KeyboardDoubleArrowRight
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.layout
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import app.shelly.android.core.AgentState
import app.shelly.android.core.MobileSession
import app.shelly.android.features.sessions.sessionPreviewText
import app.shelly.android.ui.theme.ShellyDimens
import app.shelly.android.ui.theme.ShellyMotion
import app.shelly.android.ui.theme.ShellyTheme
import app.shelly.android.ui.theme.ShellyType
import app.shelly.android.ui.theme.shellyPressScale
import kotlin.math.PI
import kotlin.math.sin

/**
 * The Shelly screen frame: a black background with a single rounded card stack
 * (orange/dark hero on top, content below), inset by 16dp inside the safe area.
 */
@Composable
fun ShellyScreen(
    modifier: Modifier = Modifier,
    heroHeight: Dp = ShellyDimens.heroHeight,
    hero: @Composable ColumnScope.() -> Unit,
    content: @Composable ColumnScope.() -> Unit,
) {
    val c = ShellyTheme.colors
    Box(modifier.fillMaxSize().background(c.screen)) {
        Column(
            Modifier
                .fillMaxSize()
                .systemBarsPadding()
                .padding(ShellyDimens.screenInset)
                .clip(RoundedCornerShape(ShellyDimens.cardRadius)),
        ) {
            Column(
                Modifier
                    .fillMaxWidth()
                    .height(heroHeight)
                    .background(c.hero)
                    .padding(horizontal = ShellyDimens.heroPaddingH)
                    .padding(top = 24.dp, bottom = 28.dp),
                content = hero,
            )
            Column(
                Modifier
                    .fillMaxWidth()
                    .weight(1f)
                    .background(c.content)
                    .padding(horizontal = ShellyDimens.contentPaddingH)
                    .padding(top = 18.dp, bottom = 24.dp),
                content = content,
            )
        }
    }
}

/**
 * Hero body: brand row pinned to the top, then a flexible spacer (min 8dp), then the
 * eyebrow → wordmark → optional below() cluster. With a correctly sized wordmark the
 * cluster fills the hero and the spacer collapses to its minimum — matching the Paper hero.
 */
@Composable
fun ColumnScope.HeroBody(
    eyebrow: String,
    wordmark: String,
    wordmarkSize: TextUnit = ShellyType.wordmark.fontSize,
    onBrandClick: (() -> Unit)? = null,
    brandTrailing: @Composable RowScope.() -> Unit = {},
    below: (@Composable ColumnScope.() -> Unit)? = null,
) {
    val c = ShellyTheme.colors
    BrandRow(onClick = onBrandClick, trailing = brandTrailing)
    Spacer(Modifier.weight(1f).heightIn(min = 8.dp))
    Text(eyebrow, style = ShellyType.eyebrow, color = c.textPrimary)
    Spacer(Modifier.height(18.dp))
    // Caps-only wordmark: measured UNBOUNDED so the glyph never clips (real-device Inter Black is
    // taller/wider than a constrained box would allow), then reported with a tight 0.9em footprint
    // (the Paper line box), full glyph centered in it. The empty ascent/descent leading overflows
    // harmlessly into the 18dp gaps above/below.
    Text(
        wordmark,
        style = ShellyType.wordmark.copy(fontSize = wordmarkSize, lineHeight = wordmarkSize),
        color = c.heroWordmark,
        maxLines = 1,
        softWrap = false,
        overflow = TextOverflow.Visible,
        modifier = Modifier.layout { measurable, _ ->
            val placeable = measurable.measure(Constraints())
            val footprint = (wordmarkSize.value * 0.9f).dp.roundToPx()
            layout(placeable.width, footprint) {
                placeable.place(0, (footprint - placeable.height) / 2)
            }
        },
    )
    if (below != null) {
        Spacer(Modifier.height(18.dp))
        below()
    }
}

@Composable
fun BrandRow(onClick: (() -> Unit)? = null, trailing: @Composable RowScope.() -> Unit = {}) {
    val c = ShellyTheme.colors
    val interactionSource = remember { MutableInteractionSource() }
    val scale = if (onClick == null) 1f else shellyPressScale(interactionSource, pressedScale = 0.985f)
    val brandModifier = if (onClick == null) {
        Modifier
    } else {
        Modifier
            .graphicsLayer {
                scaleX = scale
                scaleY = scale
            }
            .clickable(
                interactionSource = interactionSource,
                indication = null,
                onClick = onClick,
            )
    }
    Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        // Only the brand mark (logo + wordmark) is clickable. The trailing action
        // icons live OUTSIDE this clickable so their taps aren't swallowed by the
        // brand's (command-palette) onClick.
        Row(
            modifier = brandModifier,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            TriangleLogo(color = c.textPrimary)
            Spacer(Modifier.width(8.dp))
            Text("SHELLY", style = ShellyType.brand, color = c.textPrimary)
        }
        Spacer(Modifier.weight(1f))
        trailing()
    }
}

/** Filled triangle "play"-style brand mark pointing up. */
@Composable
fun TriangleLogo(color: Color, size: Dp = 14.dp) {
    androidx.compose.foundation.Canvas(Modifier.size(size)) {
        val w = this.size.width
        val h = this.size.height
        val path = Path().apply {
            moveTo(w / 2f, h * 0.08f)
            lineTo(w * 0.92f, h * 0.9f)
            lineTo(w * 0.08f, h * 0.9f)
            close()
        }
        drawPath(path, color)
    }
}

/** Circular icon button used in the hero header (search / refresh / theme). */
@Composable
fun IconCircleButton(
    icon: ImageVector,
    contentDescription: String?,
    onClick: () -> Unit,
    iconModifier: Modifier = Modifier,
) {
    val c = ShellyTheme.colors
    val interactionSource = remember { MutableInteractionSource() }
    val scale = shellyPressScale(interactionSource, pressedScale = 0.92f)
    Box(
        Modifier
            .size(32.dp)
            .graphicsLayer {
                scaleX = scale
                scaleY = scale
            }
            .clip(CircleShape)
            .background(c.surfaceSubtle)
            .clickable(
                interactionSource = interactionSource,
                indication = null,
                onClick = onClick,
            ),
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, contentDescription, tint = c.textPrimary, modifier = Modifier.size(16.dp).then(iconModifier))
    }
}

/** Status dot for a session — awaiting/working/idle(outline)/crashed. */
@Composable
fun StatusDot(state: AgentState, size: Dp = 10.dp) {
    val c = ShellyTheme.colors
    val pulseProgress = if (ShellyTheme.motionEnabled && (state == AgentState.Working || state == AgentState.AwaitingInput)) {
        val pulse = rememberInfiniteTransition(label = "statusDotPulse")
        val progress by pulse.animateFloat(
            initialValue = 0f,
            targetValue = 1f,
            animationSpec = infiniteRepeatable(
                animation = androidx.compose.animation.core.tween(
                    durationMillis = if (state == AgentState.Working) 1100 else 1500,
                    easing = ShellyMotion.Linear,
                ),
                repeatMode = RepeatMode.Restart,
            ),
            label = "statusDotProgress",
        )
        progress
    } else {
        0f
    }
    androidx.compose.foundation.Canvas(Modifier.size(size)) {
        val r = this.size.minDimension / 2f
        val center = Offset(this.size.width / 2f, this.size.height / 2f)
        when (state) {
            AgentState.AwaitingInput -> {
                drawStatusPulse(c.statusAwaiting, center, r, pulseProgress, maxRadiusDelta = 4.dp.toPx(), maxAlpha = 0.12f)
                drawCircle(c.statusAwaiting, r, center)
            }
            AgentState.Working -> {
                drawStatusPulse(c.statusWorking, center, r, pulseProgress, maxRadiusDelta = 6.dp.toPx(), maxAlpha = 0.18f)
                drawCircle(c.statusWorking, r, center)
            }
            AgentState.Crashed -> drawCircle(c.statusCrashed, r, center)
            AgentState.Idle -> drawCircle(c.statusIdle, r - 1.dp.toPx(), center, style = Stroke(width = 2.dp.toPx()))
        }
    }
}

@Composable
fun DoubleChevron(color: Color = ShellyTheme.colors.textMuted, size: Dp = 22.dp) {
    Icon(Icons.Filled.KeyboardDoubleArrowRight, contentDescription = null, tint = color, modifier = Modifier.size(size))
}

@Composable
fun Chevron(color: Color = ShellyTheme.colors.textMuted, size: Dp = 20.dp) {
    Icon(Icons.Filled.KeyboardArrowRight, contentDescription = null, tint = color, modifier = Modifier.size(size))
}

/** Session list row: status dot · name + subtitle · trailing chevron. */
@Composable
fun SessionRow(
    session: MobileSession,
    onClick: () -> Unit,
    showDivider: Boolean = true,
) {
    val c = ShellyTheme.colors
    val interactionSource = remember { MutableInteractionSource() }
    val scale = shellyPressScale(interactionSource, pressedScale = 0.985f)
    Row(
        Modifier
            .fillMaxWidth()
            .graphicsLayer {
                scaleX = scale
                scaleY = scale
            }
            .clickable(
                interactionSource = interactionSource,
                indication = null,
                onClick = onClick,
            )
            .then(if (showDivider) Modifier.drawBehind {
                val y = this.size.height - 0.5.dp.toPx()
                drawLine(c.divider, Offset(0f, y), Offset(this.size.width, y), 1.dp.toPx())
            } else Modifier)
            .padding(vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Box(Modifier.width(10.dp), contentAlignment = Alignment.Center) {
            StatusDot(session.state)
        }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(session.name, style = ShellyType.rowTitle, color = c.textPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(
                session.sessionPreviewText(),
                style = ShellyType.monoSmall,
                color = c.textMuted.copy(alpha = 0.55f),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        DoubleChevron()
    }
}

/** Filter chip in the sessions hero: "All 6", "Awaiting 1"… */
@Composable
fun StateChip(
    label: String,
    count: Int?,
    active: Boolean,
    dotState: AgentState?,
    onClick: () -> Unit,
) {
    val c = ShellyTheme.colors
    val background by animateColorAsState(
        targetValue = if (active) c.accent else c.surfaceSubtle,
        animationSpec = ShellyMotion.standardTween(),
        label = "stateChipBackground",
    )
    val foreground by animateColorAsState(
        targetValue = if (active) c.onAccent else c.textPrimary,
        animationSpec = ShellyMotion.standardTween(),
        label = "stateChipForeground",
    )
    val secondary by animateColorAsState(
        targetValue = if (active) c.onAccent.copy(alpha = 0.7f) else c.textPrimary.copy(alpha = 0.55f),
        animationSpec = ShellyMotion.standardTween(),
        label = "stateChipSecondary",
    )
    val elevation by animateDpAsState(
        targetValue = if (active) 0.75.dp else 0.dp,
        animationSpec = ShellyMotion.standardTween(),
        label = "stateChipElevation",
    )
    val interactionSource = remember { MutableInteractionSource() }
    val scale = shellyPressScale(interactionSource, pressedScale = 0.96f)
    val chipShape = RoundedCornerShape(100)
    Row(
        Modifier
            .graphicsLayer {
                scaleX = scale
                scaleY = scale
                shadowElevation = elevation.toPx()
                shape = chipShape
                clip = true
            }
            .clip(chipShape)
            .background(background)
            .clickable(
                interactionSource = interactionSource,
                indication = null,
                onClick = onClick,
            )
            .padding(start = 12.dp, end = 14.dp, top = 8.dp, bottom = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        if (!active && dotState != null) StatusDot(dotState, size = 6.dp)
        Text(label, style = ShellyType.chip, color = foreground)
        if (count != null) {
            Text(
                count.toString(),
                style = ShellyType.monoSmall.copy(fontSize = 12.sp),
                color = secondary,
            )
        }
    }
}

enum class SettingsGlyph {
    Bell,
    Fingerprint,
    HalfCircle,
    Info,
    Lock,
    Monitor,
    Package,
    Phone,
    Shield,
    Sun,
}

@Composable
fun ColumnScope.SettingsHeroBody(
    eyebrow: String,
    wordmark: String,
    status: String,
    statusGlyph: SettingsGlyph,
    backLabel: String,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
    wordmarkSize: TextUnit = 96.sp,
    onStatusClick: (() -> Unit)? = null,
) {
    val c = ShellyTheme.colors
    val heroForeground = if (c.isDark) c.textPrimary else c.heroWordmark
    Row(
        modifier
            .fillMaxWidth()
            .padding(bottom = 60.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        TriangleLogo(color = heroForeground)
        Spacer(Modifier.width(8.dp))
        Text("SHELLY", style = ShellyType.brand, color = heroForeground)
        Spacer(Modifier.weight(1f))
        SettingsBackLink(label = backLabel, color = heroForeground, onClick = onBack)
    }
    Text(
        text = eyebrow,
        style = ShellyType.eyebrow,
        color = heroForeground,
        modifier = Modifier.padding(bottom = 16.dp),
    )
    Text(
        text = wordmark,
        style = ShellyType.wordmark.copy(fontSize = wordmarkSize, lineHeight = wordmarkSize),
        color = c.heroWordmark,
        maxLines = 1,
        softWrap = false,
        overflow = TextOverflow.Visible,
        modifier = Modifier.layout { measurable, _ ->
            val placeable = measurable.measure(Constraints())
            val footprint = (wordmarkSize.value * 0.9f).dp.roundToPx()
            layout(placeable.width, footprint) {
                placeable.place(0, (footprint - placeable.height) / 2)
            }
        },
    )
    Spacer(Modifier.height(20.dp))
    Row(
        Modifier
            .then(if (onStatusClick != null) Modifier.clickable(onClick = onStatusClick) else Modifier)
            .padding(bottom = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        SettingsGlyphIcon(statusGlyph, color = heroForeground, size = 18.dp)
        Text(
            text = status,
            style = ShellyType.mono.copy(
                fontWeight = FontWeight.Medium,
                fontSize = 13.sp,
                lineHeight = 16.sp,
            ),
            color = heroForeground,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

@Composable
private fun SettingsBackLink(label: String, color: Color, onClick: () -> Unit) {
    val interactionSource = remember { MutableInteractionSource() }
    val scale = shellyPressScale(interactionSource, pressedScale = 0.98f)
    Row(
        Modifier
            .graphicsLayer {
                scaleX = scale
                scaleY = scale
            }
            .clickable(
                interactionSource = interactionSource,
                indication = null,
                onClick = onClick,
            ),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Canvas(Modifier.size(16.dp)) {
            val stroke = Stroke(width = 2.4.dp.toPx(), cap = StrokeCap.Round, join = StrokeJoin.Round)
            drawLine(color, Offset(size.width * 0.79f, size.height * 0.5f), Offset(size.width * 0.21f, size.height * 0.5f), stroke.width, StrokeCap.Round)
            val path = Path().apply {
                moveTo(size.width * 0.5f, size.height * 0.79f)
                lineTo(size.width * 0.21f, size.height * 0.5f)
                lineTo(size.width * 0.5f, size.height * 0.21f)
            }
            drawPath(path, color = color, style = stroke)
        }
        Text(
            text = label,
            style = ShellyType.brand.copy(fontWeight = FontWeight.SemiBold, letterSpacing = 0.em),
            color = color,
        )
    }
}

@Composable
fun SettingsListRow(
    title: String,
    value: String,
    modifier: Modifier = Modifier,
    glyph: SettingsGlyph? = null,
    showDivider: Boolean = true,
    onClick: (() -> Unit)? = null,
) {
    val c = ShellyTheme.colors
    val primary = settingsPrimaryColor(c)
    val iconColor = if (c.isDark) c.textMuted else primary
    val valueColor = if (c.isDark) c.textMuted.copy(alpha = 0.55f) else primary.copy(alpha = 0.55f)
    val interactionSource = remember { MutableInteractionSource() }
    val scale = if (onClick == null) 1f else shellyPressScale(interactionSource, pressedScale = 0.985f)
    Row(
        modifier
            .fillMaxWidth()
            .graphicsLayer {
                scaleX = scale
                scaleY = scale
            }
            .then(
                if (onClick != null) {
                    Modifier.clickable(
                        interactionSource = interactionSource,
                        indication = null,
                        onClick = onClick,
                    )
                } else {
                    Modifier
                },
            )
            .then(if (showDivider) Modifier.drawBehind {
                val y = size.height - 0.5.dp.toPx()
                drawLine(c.divider, Offset(0f, y), Offset(size.width, y), 1.dp.toPx())
            } else Modifier)
            .padding(vertical = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        if (glyph != null) {
            Box(Modifier.size(20.dp), contentAlignment = Alignment.Center) {
                SettingsGlyphIcon(glyph, color = iconColor, size = 20.dp)
            }
        }
        Text(
            text = title,
            style = ShellyType.itemTitle,
            color = primary,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
        Text(
            text = value,
            style = ShellyType.monoSmall,
            color = valueColor,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        SettingsChevron(color = iconColor)
    }
}

@Composable
fun SettingsSectionLabel(text: String, modifier: Modifier = Modifier) {
    val c = ShellyTheme.colors
    val primary = settingsPrimaryColor(c)
    Text(
        text = text.uppercase(),
        style = ShellyType.microLabel,
        color = if (c.isDark) c.textMuted.copy(alpha = 0.55f) else primary.copy(alpha = 0.55f),
        modifier = modifier.padding(top = 18.dp, bottom = 8.dp),
    )
}

@Composable
fun SettingsFooterAction(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    destructive: Boolean = true,
) {
    val c = ShellyTheme.colors
    val color = if (destructive) c.statusCrashed else settingsPrimaryColor(c)
    val interactionSource = remember { MutableInteractionSource() }
    val scale = shellyPressScale(interactionSource, pressedScale = 0.985f)
    Column(modifier.fillMaxWidth().padding(top = 10.dp)) {
        Box(Modifier.fillMaxWidth().height(2.dp).background(color))
        Row(
            Modifier
                .fillMaxWidth()
                .graphicsLayer {
                    scaleX = scale
                    scaleY = scale
                }
                .clickable(
                    interactionSource = interactionSource,
                    indication = null,
                    onClick = onClick,
                )
                .padding(top = 16.dp, bottom = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Text(
                text = text,
                style = ShellyType.heading.copy(
                    fontWeight = FontWeight.Bold,
                    fontSize = 22.sp,
                    lineHeight = 28.sp,
                ),
                color = color,
                textDecoration = TextDecoration.Underline,
            )
            SettingsDoubleChevron(color = color)
        }
    }
}

@Composable
fun SettingsGlyphIcon(glyph: SettingsGlyph, color: Color, modifier: Modifier = Modifier, size: Dp = 20.dp) {
    Canvas(modifier.size(size)) {
        val sx = this.size.width / 24f
        val sy = this.size.height / 24f
        fun x(v: Float) = v * sx
        fun y(v: Float) = v * sy
        fun o(px: Float, py: Float) = Offset(x(px), y(py))
        fun s(w: Float = 1.8f) = Stroke(
            width = w * sx,
            cap = StrokeCap.Round,
            join = StrokeJoin.Round,
        )
        fun line(x1: Float, y1: Float, x2: Float, y2: Float, width: Float = 1.8f) {
            drawLine(color, o(x1, y1), o(x2, y2), strokeWidth = width * sx, cap = StrokeCap.Round)
        }
        fun roundRect(left: Float, top: Float, width: Float, height: Float, radius: Float, stroke: Stroke = s()) {
            drawRoundRect(
                color = color,
                topLeft = o(left, top),
                size = Size(x(width), y(height)),
                cornerRadius = CornerRadius(x(radius), y(radius)),
                style = stroke,
            )
        }
        fun path(stroke: Stroke = s(), block: Path.() -> Unit) {
            drawPath(Path().apply(block), color = color, style = stroke)
        }

        when (glyph) {
            SettingsGlyph.Monitor -> {
                roundRect(2f, 4f, 20f, 12f, 2f)
                line(2f, 20f, 22f, 20f)
            }
            SettingsGlyph.Sun -> {
                drawCircle(color, radius = x(5f), center = o(12f, 12f), style = s())
                line(12f, 1f, 12f, 3f)
                line(12f, 21f, 12f, 23f)
                line(4.22f, 4.22f, 5.64f, 5.64f)
                line(18.36f, 18.36f, 19.78f, 19.78f)
                line(1f, 12f, 3f, 12f)
                line(21f, 12f, 23f, 12f)
            }
            SettingsGlyph.Bell -> {
                path {
                    moveTo(x(18f), y(8f))
                    cubicTo(x(18f), y(4.7f), x(15.3f), y(2f), x(12f), y(2f))
                    cubicTo(x(8.7f), y(2f), x(6f), y(4.7f), x(6f), y(8f))
                    cubicTo(x(6f), y(15f), x(3f), y(17f), x(3f), y(17f))
                    lineTo(x(21f), y(17f))
                    cubicTo(x(21f), y(17f), x(18f), y(15f), x(18f), y(8f))
                }
                path {
                    moveTo(x(13.73f), y(21f))
                    cubicTo(x(12.9f), y(22.3f), x(11.1f), y(22.3f), x(10.27f), y(21f))
                }
            }
            SettingsGlyph.Lock -> {
                roundRect(3f, 11f, 18f, 11f, 2f)
                line(7f, 11f, 7f, 7f)
                drawArc(
                    color = color,
                    startAngle = 180f,
                    sweepAngle = 180f,
                    useCenter = false,
                    topLeft = o(7f, 2f),
                    size = Size(x(10f), y(10f)),
                    style = s(),
                )
                line(17f, 7f, 17f, 11f)
            }
            SettingsGlyph.Shield -> path {
                moveTo(x(12f), y(22f))
                cubicTo(x(12f), y(22f), x(20f), y(18f), x(20f), y(12f))
                lineTo(x(20f), y(5f))
                lineTo(x(12f), y(2f))
                lineTo(x(4f), y(5f))
                lineTo(x(4f), y(12f))
                cubicTo(x(4f), y(18f), x(12f), y(22f), x(12f), y(22f))
            }
            SettingsGlyph.Info -> {
                drawCircle(color, radius = x(10f), center = o(12f, 12f), style = s())
                line(12f, 16f, 12f, 12f)
                drawCircle(color, radius = x(0.9f), center = o(12f, 8f))
            }
            SettingsGlyph.HalfCircle -> {
                drawCircle(color, radius = x(9f), center = o(12f, 12f), style = s())
                val fill = Path().apply {
                    moveTo(x(12f), y(3f))
                    arcTo(Rect(x(3f), y(3f), x(21f), y(21f)), -90f, 180f, false)
                    close()
                }
                drawPath(fill, color = color)
            }
            SettingsGlyph.Fingerprint -> {
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
            SettingsGlyph.Phone -> {
                roundRect(6f, 2f, 12f, 20f, 2.5f)
                line(10.5f, 18f, 13.5f, 18f)
            }
            SettingsGlyph.Package -> {
                path {
                    moveTo(x(12f), y(2f))
                    lineTo(x(21f), y(7f))
                    lineTo(x(21f), y(17f))
                    lineTo(x(12f), y(22f))
                    lineTo(x(3f), y(17f))
                    lineTo(x(3f), y(7f))
                    close()
                }
                path {
                    moveTo(x(3.27f), y(6.96f))
                    lineTo(x(12f), y(12.01f))
                    lineTo(x(20.73f), y(6.96f))
                }
                line(12f, 22.08f, 12f, 12f)
            }
        }
    }
}

@Composable
private fun SettingsChevron(color: Color) {
    Canvas(Modifier.size(20.dp)) {
        val stroke = Stroke(width = 2.dp.toPx(), cap = StrokeCap.Round, join = StrokeJoin.Round)
        val path = Path().apply {
            moveTo(size.width * 0.375f, size.height * 0.75f)
            lineTo(size.width * 0.625f, size.height * 0.5f)
            lineTo(size.width * 0.375f, size.height * 0.25f)
        }
        drawPath(path, color = color, style = stroke)
    }
}

@Composable
private fun SettingsDoubleChevron(color: Color) {
    Canvas(Modifier.size(26.dp)) {
        val stroke = Stroke(width = 2.dp.toPx(), cap = StrokeCap.Round, join = StrokeJoin.Round)
        fun chevron(left: Float, right: Float) {
            val path = Path().apply {
                moveTo(size.width * left, size.height * 0.25f)
                lineTo(size.width * right, size.height * 0.5f)
                lineTo(size.width * left, size.height * 0.75f)
            }
            drawPath(path, color = color, style = stroke)
        }
        chevron(0.25f, 0.5f)
        chevron(0.54f, 0.79f)
    }
}

private fun settingsPrimaryColor(c: app.shelly.android.ui.theme.ShellyColors): Color =
    if (c.isDark) c.textPrimary else c.heroWordmark

private fun androidx.compose.ui.graphics.drawscope.DrawScope.drawStatusPulse(
    color: Color,
    center: Offset,
    radius: Float,
    progress: Float,
    maxRadiusDelta: Float,
    maxAlpha: Float,
) {
    val alpha = (sin(progress * PI).toFloat()).coerceAtLeast(0f) * maxAlpha
    if (alpha <= 0.001f) return
    drawCircle(
        color = color.copy(alpha = alpha),
        radius = radius + maxRadiusDelta * progress,
        center = center,
        style = Stroke(width = 1.4.dp.toPx()),
    )
}
