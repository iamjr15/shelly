@file:OptIn(androidx.compose.ui.text.ExperimentalTextApi::class)

package app.shelly.android.features.modals

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.PlatformTextStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.LineHeightStyle
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import app.shelly.android.ui.components.SettingsFooterAction
import app.shelly.android.ui.components.SettingsGlyph
import app.shelly.android.ui.components.SettingsHeroBody
import app.shelly.android.ui.components.SettingsListRow
import app.shelly.android.ui.components.ShellyScreen
import app.shelly.android.ui.theme.Inter
import app.shelly.android.ui.theme.JetBrainsMono
import app.shelly.android.ui.theme.ShellyTheme
import app.shelly.android.ui.theme.shellyPressScale

private val PaperDanger = Color(0xFFA12E27)
private const val PaperScrimAlpha = 0.7019608f

private val ModalLineBox = LineHeightStyle(
    alignment = LineHeightStyle.Alignment.Center,
    trim = LineHeightStyle.Trim.None,
)

private val ModalKickerStyle = TextStyle(
    fontFamily = JetBrainsMono,
    fontWeight = FontWeight.Bold,
    fontSize = 11.sp,
    lineHeight = 14.sp,
    letterSpacing = 0.12.em,
    lineHeightStyle = ModalLineBox,
    platformStyle = PlatformTextStyle(includeFontPadding = false),
)

private val ModalTitleStyle = TextStyle(
    fontFamily = Inter,
    fontWeight = FontWeight.Black,
    fontSize = 78.sp,
    lineHeight = 84.sp,
    letterSpacing = (-0.05).em,
    lineHeightStyle = ModalLineBox,
    platformStyle = PlatformTextStyle(includeFontPadding = false),
)

private val ModalMetaStyle = TextStyle(
    fontFamily = JetBrainsMono,
    fontWeight = FontWeight.Medium,
    fontSize = 13.sp,
    lineHeight = 16.sp,
    lineHeightStyle = ModalLineBox,
    platformStyle = PlatformTextStyle(includeFontPadding = false),
)

private val ModalBodyStyle = TextStyle(
    fontFamily = Inter,
    fontWeight = FontWeight.Normal,
    fontSize = 15.sp,
    lineHeight = 23.sp,
    lineHeightStyle = ModalLineBox,
    platformStyle = PlatformTextStyle(includeFontPadding = false),
)

private val ModalButtonStyle = TextStyle(
    fontFamily = Inter,
    fontWeight = FontWeight.Bold,
    fontSize = 18.sp,
    lineHeight = 24.sp,
    lineHeightStyle = ModalLineBox,
    platformStyle = PlatformTextStyle(includeFontPadding = false),
)

private val ModalSecondaryStyle = TextStyle(
    fontFamily = Inter,
    fontWeight = FontWeight.SemiBold,
    fontSize = 17.sp,
    lineHeight = 22.sp,
    lineHeightStyle = ModalLineBox,
    platformStyle = PlatformTextStyle(includeFontPadding = false),
)

@Composable
internal fun ShellyModalCard(
    kicker: String,
    title: String,
    meta: String,
    body: String,
    primary: String,
    secondary: String,
    onConfirm: () -> Unit,
    onDismiss: () -> Unit,
    modifier: Modifier = Modifier,
    warning: Boolean = false,
    destructive: Boolean = false,
    primaryIcon: (@Composable () -> Unit)? = null,
) {
    val c = ShellyTheme.colors
    val blackInk = c.heroWordmark
    val modalInk = if (c.isDark) c.textPrimary else blackInk
    val mutedInk = if (c.isDark) c.textMuted else blackInk
    val primaryBackground = when {
        destructive -> PaperDanger
        c.isDark -> c.buttonPrimary
        else -> blackInk
    }
    val primaryForeground = if (destructive) Color.White else c.onButtonPrimary
    val primaryInteractionSource = remember { MutableInteractionSource() }
    val primaryScale = shellyPressScale(primaryInteractionSource, pressedScale = 0.975f)
    val secondaryInteractionSource = remember { MutableInteractionSource() }
    val secondaryScale = shellyPressScale(secondaryInteractionSource, pressedScale = 0.985f)

    Column(
        modifier
            .width(356.dp)
            .clip(RoundedCornerShape(24.dp))
            .background(c.modalCard)
            .padding(horizontal = 24.dp, vertical = 26.dp),
    ) {
        androidx.compose.foundation.layout.Row(
            Modifier.padding(bottom = 14.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(9.dp),
        ) {
            if (warning) {
                WarningTriangleIcon(color = PaperDanger)
            }
            Text(
                text = kicker,
                style = ModalKickerStyle,
                color = if (warning) PaperDanger else mutedInk.copy(alpha = if (c.isDark) 1f else 0.45f),
                maxLines = 1,
                overflow = TextOverflow.Clip,
            )
        }
        Box(Modifier.fillMaxWidth().height(84.dp)) {
            Text(
                text = title,
                style = ModalTitleStyle,
                color = c.heroWordmark,
                maxLines = 1,
                modifier = Modifier.align(Alignment.CenterStart),
            )
        }
        androidx.compose.foundation.layout.Row(
            Modifier.padding(top = 12.dp).height(16.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            MonitorIcon(color = modalInk)
            Text(
                text = meta,
                style = ModalMetaStyle,
                color = mutedInk.copy(alpha = 0.6f),
                maxLines = 1,
                overflow = TextOverflow.Clip,
            )
        }
        Box(Modifier.fillMaxWidth().padding(top = 18.dp, bottom = 22.dp)) {
            Text(
                text = body,
                style = ModalBodyStyle,
                color = modalInk.copy(alpha = 0.82f),
            )
        }
        androidx.compose.foundation.layout.Row(
            Modifier
                .fillMaxWidth()
                .height(58.dp)
                .graphicsLayer {
                    scaleX = primaryScale
                    scaleY = primaryScale
                }
                .clip(RoundedCornerShape(14.dp))
                .background(primaryBackground)
                .clickable(
                    interactionSource = primaryInteractionSource,
                    indication = null,
                    onClick = onConfirm,
                )
                .padding(horizontal = 16.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp, Alignment.CenterHorizontally),
        ) {
            primaryIcon?.invoke()
            Text(
                text = primary,
                style = ModalButtonStyle,
                color = primaryForeground,
                maxLines = 1,
            )
        }
        Box(
            Modifier
                .fillMaxWidth()
                .height(54.dp)
                .graphicsLayer {
                    scaleX = secondaryScale
                    scaleY = secondaryScale
                }
                .clickable(
                    interactionSource = secondaryInteractionSource,
                    indication = null,
                    onClick = onDismiss,
                ),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                text = secondary,
                style = ModalSecondaryStyle,
                color = mutedInk.copy(alpha = 0.65f),
                maxLines = 1,
            )
        }
    }
}

@Composable
internal fun ModalPreviewScaffold(content: @Composable () -> Unit) {
    Box(Modifier.fillMaxSize().background(ShellyTheme.colors.screen)) {
        ModalBackdrop()
        Box(
            Modifier
                .fillMaxSize()
                .padding(16.dp)
                .clip(RoundedCornerShape(24.dp))
                .background(Color(0xFF0B0D0C).copy(alpha = PaperScrimAlpha)),
        )
        Box(
            Modifier
                .align(Alignment.BottomCenter)
                .padding(bottom = 28.dp),
        ) {
            content()
        }
    }
}

@Composable
internal fun WarningTriangleIcon(color: Color, modifier: Modifier = Modifier) {
    Canvas(modifier.size(16.dp)) {
        val sx = size.width / 24f
        val sy = size.height / 24f
        fun o(x: Float, y: Float) = Offset(x * sx, y * sy)
        val triangle = Path().apply {
            moveTo(12f * sx, 3f * sy)
            lineTo(22f * sx, 20f * sy)
            lineTo(2f * sx, 20f * sy)
            close()
        }
        drawPath(
            path = triangle,
            color = color,
            style = Stroke(width = 2.2f * sx, join = StrokeJoin.Round),
        )
        drawLine(color, o(12f, 10f), o(12f, 14f), strokeWidth = 2.2f * sx, cap = StrokeCap.Round)
        drawLine(color, o(12f, 17f), o(12.01f, 17f), strokeWidth = 2.4f * sx, cap = StrokeCap.Round)
    }
}

@Composable
internal fun MonitorIcon(color: Color, modifier: Modifier = Modifier) {
    Canvas(modifier.size(16.dp)) {
        val sx = size.width / 24f
        val sy = size.height / 24f
        val stroke = Stroke(width = 2f * sx, cap = StrokeCap.Round, join = StrokeJoin.Round)
        drawRoundRect(
            color = color,
            topLeft = Offset(3f * sx, 4f * sy),
            size = Size(18f * sx, 12f * sy),
            cornerRadius = CornerRadius(2f * sx, 2f * sy),
            style = stroke,
        )
        drawLine(
            color = color,
            start = Offset(8f * sx, 20f * sy),
            end = Offset(16f * sx, 20f * sy),
            strokeWidth = 2f * sx,
            cap = StrokeCap.Round,
        )
    }
}

@Composable
internal fun TrashIcon(color: Color, modifier: Modifier = Modifier) {
    Canvas(modifier.size(19.dp)) {
        val sx = size.width / 24f
        val sy = size.height / 24f
        fun o(x: Float, y: Float) = Offset(x * sx, y * sy)
        fun path(block: Path.() -> Unit) {
            drawPath(
                path = Path().apply(block),
                color = color,
                style = Stroke(width = 2f * sx, cap = StrokeCap.Round, join = StrokeJoin.Round),
            )
        }
        drawLine(color, o(3f, 6f), o(21f, 6f), strokeWidth = 2f * sx, cap = StrokeCap.Round)
        path {
            moveTo(8f * sx, 6f * sy)
            lineTo(8f * sx, 4f * sy)
            cubicTo(8f * sx, 2.895f * sy, 8.895f * sx, 2f * sy, 10f * sx, 2f * sy)
            lineTo(14f * sx, 2f * sy)
            cubicTo(15.105f * sx, 2f * sy, 16f * sx, 2.895f * sy, 16f * sx, 4f * sy)
            lineTo(16f * sx, 6f * sy)
        }
        path {
            moveTo(6f * sx, 6f * sy)
            lineTo(7f * sx, 20f * sy)
            cubicTo(7f * sx, 21.105f * sy, 7.895f * sx, 22f * sy, 9f * sx, 22f * sy)
            lineTo(15f * sx, 22f * sy)
            cubicTo(16.105f * sx, 22f * sy, 17f * sx, 21.105f * sy, 17f * sx, 20f * sy)
            lineTo(18f * sx, 6f * sy)
        }
    }
}

@Composable
private fun ModalBackdrop() {
    ShellyScreen(
        hero = {
            SettingsHeroBody(
                eyebrow = "YOUR PREFERENCES\nLIVE ON THIS DEVICE",
                wordmark = "PREFS",
                status = "paired with node_01k9c4f3hg...",
                statusGlyph = SettingsGlyph.Monitor,
                backLabel = "Sessions",
                onBack = {},
            )
        },
        content = {
            SettingsListRow("Appearance", "SYSTEM", glyph = SettingsGlyph.Sun, onClick = {})
            SettingsListRow("Notifications", "ON", glyph = SettingsGlyph.Bell, onClick = {})
            SettingsListRow("Security", "5 MIN", glyph = SettingsGlyph.Lock, onClick = {})
            SettingsListRow("Privacy", "OPT-OUT", glyph = SettingsGlyph.Shield, onClick = {})
            SettingsListRow("About", "V1.0.0", glyph = SettingsGlyph.Info, showDivider = false, onClick = {})
            Spacer(Modifier.weight(1f))
            SettingsFooterAction("Unpair this device", onClick = {})
        },
    )
}
