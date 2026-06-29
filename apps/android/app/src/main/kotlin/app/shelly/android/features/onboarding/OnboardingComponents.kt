package app.shelly.android.features.onboarding

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.layout.layout
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import app.shelly.android.ui.components.ShellyScreen
import app.shelly.android.ui.components.TriangleLogo
import app.shelly.android.ui.theme.ShellyTheme
import app.shelly.android.ui.theme.ShellyType

private val WordmarkSize = 96.sp

@Composable
internal fun OnboardingShell(
    hero: @Composable ColumnScope.() -> Unit,
    content: @Composable ColumnScope.() -> Unit,
) {
    ShellyScreen(
        hero = hero,
        content = content,
    )
}

@Composable
internal fun ColumnScope.WelcomeHero(
    onDateClick: () -> Unit = {},
) {
    val heroForeground = onboardingHeroForeground()
    val heroMuted = onboardingHeroMuted()

    OnboardingBrandRow(
        trailing = {
            Row(
                verticalAlignment = Alignment.Bottom,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Text(
                    text = "May 28",
                    style = ShellyType.brand.copy(
                        fontWeight = FontWeight(500),
                        letterSpacing = 0.em,
                    ),
                    color = heroForeground,
                    modifier = Modifier.clickable(onClick = onDateClick),
                )
                Text(
                    text = "Thu",
                    style = ShellyType.brand.copy(
                        fontSize = 13.sp,
                        lineHeight = 16.sp,
                        fontWeight = FontWeight(400),
                        letterSpacing = 0.em,
                    ),
                    color = heroMuted.copy(alpha = 0.6f),
                )
            }
        },
    )
    Spacer(Modifier.weight(1f).heightIn(min = 8.dp))
    Text(
        text = "YOUR TERMINAL, ANYWHERE",
        style = ShellyType.eyebrow,
        color = heroForeground,
    )
    Spacer(Modifier.height(18.dp))
    OnboardingWordmark("SH")
    Spacer(Modifier.height(18.dp))
    OnboardingStatusRow(
        icon = OnboardingStatusIcon.Phone,
        text = "shelly for android · v1.0.0",
        iconColor = heroMuted,
        textColor = heroForeground,
        modifier = Modifier.padding(bottom = 4.dp),
    )
}

@Composable
internal fun ColumnScope.OnboardingHero(
    eyebrow: String,
    wordmark: String,
    trailing: String,
    onTrailingClick: () -> Unit,
    status: OnboardingStatus? = null,
) {
    val heroForeground = onboardingHeroForeground()
    val heroMuted = onboardingHeroMuted()

    OnboardingBrandRow(
        modifier = Modifier.padding(bottom = 60.dp),
        trailing = {
            Text(
                text = trailing,
                style = ShellyType.monoSmall.copy(
                    fontWeight = FontWeight(600),
                    letterSpacing = 0.04.em,
                ),
                color = heroMuted,
                modifier = Modifier.clickable(onClick = onTrailingClick),
            )
        },
    )
    Text(
        text = eyebrow,
        style = ShellyType.eyebrow,
        color = heroForeground,
        modifier = Modifier.padding(bottom = 16.dp),
    )
    OnboardingWordmark(wordmark)
    Spacer(Modifier.height(20.dp))
    if (status != null) {
        OnboardingStatusRow(
            icon = status.icon,
            text = status.text,
            iconColor = heroMuted,
            textColor = heroForeground,
            modifier = Modifier.padding(bottom = 4.dp),
        )
    }
}

@Composable
private fun OnboardingBrandRow(
    modifier: Modifier = Modifier,
    trailing: @Composable RowScope.() -> Unit,
) {
    val heroForeground = onboardingHeroForeground()
    Row(
        modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        TriangleLogo(color = heroForeground)
        Spacer(Modifier.width(8.dp))
        Text("SHELLY", style = ShellyType.brand, color = heroForeground)
        Spacer(Modifier.weight(1f))
        trailing()
    }
}

@Composable
private fun OnboardingWordmark(text: String) {
    Text(
        text = text,
        style = ShellyType.wordmark.copy(fontSize = WordmarkSize, lineHeight = WordmarkSize),
        color = ShellyTheme.colors.heroWordmark,
        maxLines = 1,
        softWrap = false,
        overflow = TextOverflow.Visible,
        modifier = Modifier.layout { measurable, _ ->
            val placeable = measurable.measure(Constraints())
            val footprint = (WordmarkSize.value * 0.9f).dp.roundToPx()
            layout(placeable.width, footprint) {
                placeable.place(0, (footprint - placeable.height) / 2)
            }
        },
    )
}

internal data class OnboardingStatus(
    val icon: OnboardingStatusIcon,
    val text: String,
)

internal enum class OnboardingStatusIcon {
    Lock,
    Phone,
    Scanner,
}

@Composable
private fun OnboardingStatusRow(
    icon: OnboardingStatusIcon,
    text: String,
    iconColor: Color,
    textColor: Color,
    modifier: Modifier = Modifier,
) {
    Row(
        modifier,
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        when (icon) {
            OnboardingStatusIcon.Lock -> LockIcon(iconColor)
            OnboardingStatusIcon.Phone -> PhoneIcon(iconColor)
            OnboardingStatusIcon.Scanner -> ScannerIcon(iconColor)
        }
        Text(
            text = text,
            style = ShellyType.mono.copy(fontWeight = FontWeight(500)),
            color = textColor,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

@Composable
private fun PhoneIcon(color: Color) {
    Canvas(Modifier.size(18.dp)) {
        val sx = size.width / 24f
        val sy = size.height / 24f
        val stroke = Stroke(width = 1.8.dp.toPx(), cap = StrokeCap.Round, join = StrokeJoin.Round)
        drawRoundRect(
            color = color,
            topLeft = Offset(6f * sx, 2f * sy),
            size = Size(12f * sx, 20f * sy),
            cornerRadius = CornerRadius(2.5f * sx, 2.5f * sy),
            style = stroke,
        )
        drawLine(
            color = color,
            start = Offset(10.5f * sx, 18f * sy),
            end = Offset(13.5f * sx, 18f * sy),
            strokeWidth = stroke.width,
            cap = StrokeCap.Round,
        )
    }
}

@Composable
private fun LockIcon(color: Color) {
    Canvas(Modifier.size(18.dp)) {
        val sx = size.width / 24f
        val sy = size.height / 24f
        val stroke = Stroke(width = 1.8.dp.toPx(), cap = StrokeCap.Round, join = StrokeJoin.Round)
        drawRoundRect(
            color = color,
            topLeft = Offset(4f * sx, 11f * sy),
            size = Size(16f * sx, 9f * sy),
            cornerRadius = CornerRadius(2f * sx, 2f * sy),
            style = stroke,
        )
        drawLine(color, Offset(7.5f * sx, 11f * sy), Offset(7.5f * sx, 7.5f * sy), stroke.width, StrokeCap.Round)
        drawArc(
            color = color,
            startAngle = 180f,
            sweepAngle = 180f,
            useCenter = false,
            topLeft = Offset(7.5f * sx, 3f * sy),
            size = Size(9f * sx, 9f * sy),
            style = stroke,
        )
        drawLine(color, Offset(16.5f * sx, 7.5f * sy), Offset(16.5f * sx, 11f * sy), stroke.width, StrokeCap.Round)
    }
}

@Composable
private fun ScannerIcon(color: Color) {
    Canvas(Modifier.size(18.dp)) {
        val sx = size.width / 24f
        val sy = size.height / 24f
        val stroke = Stroke(width = 1.8.dp.toPx(), cap = StrokeCap.Round, join = StrokeJoin.Round)

        fun path(block: Path.() -> Unit) {
            drawPath(Path().apply(block), color = color, style = stroke)
        }

        path {
            moveTo(4f * sx, 9f * sy)
            lineTo(4f * sx, 6f * sy)
            quadraticTo(4f * sx, 4f * sy, 6f * sx, 4f * sy)
            lineTo(9f * sx, 4f * sy)
        }
        path {
            moveTo(15f * sx, 4f * sy)
            lineTo(18f * sx, 4f * sy)
            quadraticTo(20f * sx, 4f * sy, 20f * sx, 6f * sy)
            lineTo(20f * sx, 9f * sy)
        }
        path {
            moveTo(20f * sx, 15f * sy)
            lineTo(20f * sx, 18f * sy)
            quadraticTo(20f * sx, 20f * sy, 18f * sx, 20f * sy)
            lineTo(15f * sx, 20f * sy)
        }
        path {
            moveTo(9f * sx, 20f * sy)
            lineTo(6f * sx, 20f * sy)
            quadraticTo(4f * sx, 20f * sy, 4f * sx, 18f * sy)
            lineTo(4f * sx, 15f * sy)
        }
    }
}

@Composable
internal fun WelcomeMenuRow(
    text: String,
    onClick: () -> Unit,
) {
    Row(
        Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        BranchIcon(color = onboardingMuted())
        Text(
            text = text,
            style = ShellyType.itemTitle.copy(
                fontWeight = FontWeight(500),
                fontSize = 22.sp,
                lineHeight = 28.sp,
            ),
            color = onboardingPrimary(),
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

@Composable
private fun BranchIcon(color: Color) {
    Canvas(Modifier.size(20.dp)) {
        val sx = size.width / 24f
        val sy = size.height / 24f
        val strokeWidth = 1.8.dp.toPx()
        val path = Path().apply {
            moveTo(9f * sx, 4f * sy)
            lineTo(9f * sx, 14f * sy)
            lineTo(20f * sx, 14f * sy)
        }
        drawPath(
            path = path,
            color = color,
            style = Stroke(width = strokeWidth, cap = StrokeCap.Round, join = StrokeJoin.Round),
        )
    }
}

@Composable
internal fun OnboardingStepRow(
    number: Int,
    title: String,
    detail: String,
    showDivider: Boolean,
) {
    val divider = ShellyTheme.colors.divider
    Row(
        Modifier
            .fillMaxWidth()
            .then(
                if (showDivider) {
                    Modifier.drawBehind {
                        val y = size.height - 0.5.dp.toPx()
                        drawLine(divider, Offset(0f, y), Offset(size.width, y), 1.dp.toPx())
                    }
                } else {
                    Modifier
                },
            )
            .padding(vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Text(
            text = number.toString(),
            style = ShellyType.wordmark.copy(
                fontSize = 32.sp,
                lineHeight = 40.sp,
                letterSpacing = 0.em,
            ),
            color = ShellyTheme.colors.accent,
            modifier = Modifier.widthIn(min = 32.dp),
        )
        Column(
            Modifier.weight(1f),
            verticalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            Text(
                text = title,
                style = ShellyType.rowTitle,
                color = onboardingPrimary(),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                text = detail,
                style = ShellyType.monoSmall,
                color = onboardingMuted().copy(alpha = 0.6f),
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

@Composable
internal fun OnboardingFooterLink(
    label: String,
    onClick: () -> Unit,
    strongDivider: Boolean,
    welcomeWeight: Boolean = false,
) {
    if (strongDivider) {
        Spacer(Modifier.height(10.dp))
        Box(
            Modifier
                .fillMaxWidth()
                .height(2.dp)
                .background(strongFooterDivider()),
        )
        FooterClickRow(
            label = label,
            onClick = onClick,
            labelWeight = FontWeight(700),
            topPadding = 16,
            bottomPadding = 4,
        )
    } else {
        Box(
            Modifier
                .fillMaxWidth()
                .height(1.dp)
                .background(ShellyTheme.colors.divider),
        )
        FooterClickRow(
            label = label,
            onClick = onClick,
            labelWeight = if (welcomeWeight) FontWeight(600) else FontWeight(700),
            topPadding = 18,
            bottomPadding = 18,
        )
    }
}

@Composable
private fun FooterClickRow(
    label: String,
    onClick: () -> Unit,
    labelWeight: FontWeight,
    topPadding: Int,
    bottomPadding: Int,
) {
    Row(
        Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(top = topPadding.dp, bottom = bottomPadding.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Text(
            text = label,
            style = ShellyType.heading.copy(
                fontWeight = labelWeight,
                fontSize = 22.sp,
                lineHeight = 28.sp,
            ),
            color = onboardingPrimary(),
            textDecoration = TextDecoration.Underline,
        )
        OnboardingDoubleChevron(color = onboardingMuted(), size = 26.dp)
    }
}

@Composable
private fun OnboardingDoubleChevron(color: Color, size: androidx.compose.ui.unit.Dp) {
    Canvas(Modifier.size(size)) {
        val sx = this.size.width / 24f
        val sy = this.size.height / 24f
        val stroke = Stroke(width = 2.dp.toPx(), cap = StrokeCap.Round, join = StrokeJoin.Round)
        fun polyline(points: List<Offset>) {
            val path = Path().apply {
                moveTo(points.first().x, points.first().y)
                points.drop(1).forEach { lineTo(it.x, it.y) }
            }
            drawPath(path, color = color, style = stroke)
        }
        polyline(listOf(Offset(6f * sx, 6f * sy), Offset(12f * sx, 12f * sy), Offset(6f * sx, 18f * sy)))
        polyline(listOf(Offset(13f * sx, 6f * sy), Offset(19f * sx, 12f * sy), Offset(13f * sx, 18f * sy)))
    }
}

@Composable
internal fun onboardingPrimary(): Color =
    if (ShellyTheme.colors.isDark) ShellyTheme.colors.textPrimary else ShellyTheme.colors.heroWordmark

@Composable
internal fun onboardingMuted(): Color =
    if (ShellyTheme.colors.isDark) ShellyTheme.colors.textMuted else ShellyTheme.colors.heroWordmark

@Composable
private fun onboardingHeroForeground(): Color =
    if (ShellyTheme.colors.isDark) ShellyTheme.colors.textPrimary else ShellyTheme.colors.heroWordmark

@Composable
private fun onboardingHeroMuted(): Color =
    if (ShellyTheme.colors.isDark) ShellyTheme.colors.textMuted else ShellyTheme.colors.heroWordmark

@Composable
private fun strongFooterDivider(): Color =
    if (ShellyTheme.colors.isDark) Color.White.copy(alpha = 0.14f) else ShellyTheme.colors.heroWordmark
