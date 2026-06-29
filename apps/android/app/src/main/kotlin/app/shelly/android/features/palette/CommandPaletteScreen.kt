package app.shelly.android.features.palette

import app.shelly.android.BuildConfig
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import app.shelly.android.ui.components.HeroBody
import app.shelly.android.ui.components.ShellyScreen
import app.shelly.android.ui.theme.ShellyTheme
import app.shelly.android.ui.theme.ShellyType

@Composable
fun CommandPaletteScreen(
    modifier: Modifier = Modifier,
    initialQuery: String = "",
    onDismiss: () -> Unit = {},
    onBack: () -> Unit = onDismiss,
    onAttachSession: () -> Unit = {},
    onNewSession: () -> Unit = {},
    onSearchSessions: () -> Unit = {},
    onLockNow: () -> Unit = {},
    onCopyLastOutput: () -> Unit = {},
    onOpenSettings: () -> Unit = {},
    onShowGroupedSessions: () -> Unit = {},
    onShowReconnecting: () -> Unit = {},
    onShowDaemonUnreachable: () -> Unit = {},
) {
    var query by rememberSaveable { mutableStateOf(initialQuery) }
    val commands = commandPaletteCommands(
        onAttachSession = onAttachSession,
        onNewSession = onNewSession,
        onSearchSessions = onSearchSessions,
        onLockNow = onLockNow,
        onCopyLastOutput = onCopyLastOutput,
        onOpenSettings = onOpenSettings,
        onShowGroupedSessions = onShowGroupedSessions,
        onShowReconnecting = onShowReconnecting,
        onShowDaemonUnreachable = onShowDaemonUnreachable,
    )
    val visibleCommands = commands.filter { it.matches(query) }.ifEmpty {
        commands.filterNot { it.hiddenUntilQuery }
    }

    BackHandler(onBack = onBack)
    CommandPaletteContent(
        modifier = modifier,
        query = query,
        onQueryChange = { query = it },
        commands = visibleCommands,
        onBack = onBack,
    )
}

@Composable
private fun CommandPaletteContent(
    query: String,
    commands: List<PaletteCommand>,
    onQueryChange: (String) -> Unit,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
) {
    ShellyScreen(
        modifier = modifier,
        hero = {
            HeroBody(
                eyebrow = "JUMP TO ANYTHING —\nNO MENUS, NO TAPS",
                wordmark = "CMD",
                wordmarkSize = 96.sp,
                brandTrailing = {
                    HeroShortcutKey("ESC", onBack)
                },
            )
        },
        content = {
            CommandSearchField(query = query, onQueryChange = onQueryChange)
            SectionLabel("MATCHING COMMANDS")
            commands.forEachIndexed { index, command ->
                CommandRow(command = command, selected = index == 0)
            }
            Spacer(Modifier.weight(1f))
            Box(Modifier.fillMaxWidth().height(1.dp).background(ShellyTheme.colors.divider))
            CommandHints()
        },
    )
}

@Composable
private fun CommandSearchField(query: String, onQueryChange: (String) -> Unit) {
    val c = ShellyTheme.colors
    val shape = RoundedCornerShape(14.dp)
    val primary = palettePrimary()
    val border = if (c.isDark) c.textPrimary.copy(alpha = 0.08f) else c.heroWordmark
    Row(
        Modifier
            .fillMaxWidth()
            .clip(shape)
            .background(if (c.isDark) c.insetCard else c.content)
            .border(1.5.dp, border, shape)
            .padding(horizontal = 16.dp, vertical = 15.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Text(
            text = "›",
            style = ShellyType.mono.copy(
                fontWeight = FontWeight.Bold,
                fontSize = 17.sp,
                lineHeight = 20.sp,
            ),
            color = c.accent,
        )
        BasicTextField(
            value = query,
            onValueChange = onQueryChange,
            singleLine = true,
            textStyle = ShellyType.mono.copy(
                color = primary,
                fontWeight = FontWeight.Medium,
                fontSize = 16.sp,
                lineHeight = 20.sp,
            ),
            cursorBrush = SolidColor(c.accent),
            modifier = Modifier.weight(1f),
        )
        ShortcutKey(
            label = "/",
            color = primary,
            borderColor = shortcutBorderColor(),
            horizontalPadding = 7.dp,
            verticalPadding = 2.dp,
            letterSpacing = 0.04.em,
            muted = true,
        )
    }
}

@Composable
private fun SectionLabel(text: String) {
    Text(
        text = text,
        style = ShellyType.microLabel,
        color = paletteMuted().copy(alpha = 0.55f),
        modifier = Modifier.padding(top = 20.dp, bottom = 10.dp),
    )
}

@Composable
private fun CommandRow(command: PaletteCommand, selected: Boolean) {
    val c = ShellyTheme.colors
    val shape = RoundedCornerShape(12.dp)
    val primary = palettePrimary()
    val rowBackground = when {
        selected && c.isDark -> c.surfaceSubtle
        selected -> c.insetCard
        else -> Color.Transparent
    }
    Row(
        Modifier
            .fillMaxWidth()
            .clip(shape)
            .background(rowBackground)
            .clickable(onClick = command.onClick)
            .padding(horizontal = 14.dp, vertical = 13.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        CommandGlyphIcon(
            glyph = command.glyph,
            color = if (c.isDark) c.textMuted else c.heroWordmark,
            fillColor = rowBackground.takeUnless { it == Color.Transparent } ?: c.content,
        )
        Text(
            text = command.title,
            style = ShellyType.rowTitle.copy(
                fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Medium,
            ),
            color = primary,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
        ShortcutKey(
            label = command.shortcut,
            color = if (selected) c.accent else primary,
            borderColor = if (selected) c.accent else shortcutBorderColor(),
            muted = !selected,
        )
    }
}

@Composable
private fun HeroShortcutKey(label: String, onClick: () -> Unit) {
    val c = ShellyTheme.colors
    val foreground = if (c.isDark) c.textPrimary else c.heroWordmark
    ShortcutKey(
        label = label,
        color = foreground,
        borderColor = foreground.copy(alpha = if (c.isDark) 0.10f else 0.32f),
        horizontalPadding = 8.dp,
        verticalPadding = 3.dp,
        letterSpacing = 0.08.em,
        onClick = onClick,
    )
}

@Composable
private fun ShortcutKey(
    label: String,
    color: Color,
    borderColor: Color,
    horizontalPadding: Dp = 8.dp,
    verticalPadding: Dp = 3.dp,
    letterSpacing: androidx.compose.ui.unit.TextUnit = 0.em,
    muted: Boolean = false,
    onClick: (() -> Unit)? = null,
) {
    val shape = RoundedCornerShape(6.dp)
    val clickableModifier = if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier
    Box(
        Modifier
            .alpha(if (muted) 0.5f else 1f)
            .clip(shape)
            .then(clickableModifier)
            .border(1.5.dp, borderColor, shape)
            .padding(horizontal = horizontalPadding, vertical = verticalPadding),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = label,
            style = ShellyType.monoSmall.copy(
                fontWeight = FontWeight.Bold,
                lineHeight = 14.sp,
                letterSpacing = letterSpacing,
            ),
            color = color,
            maxLines = 1,
        )
    }
}

@Composable
private fun CommandHints() {
    Row(
        Modifier.padding(top = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(18.dp),
    ) {
        HintText("↑↓\u00A0\u00A0move")
        HintText("⏎\u00A0\u00A0run")
        HintText("esc\u00A0\u00A0close")
    }
}

@Composable
private fun HintText(text: String) {
    Text(
        text = text,
        style = ShellyType.monoSmall.copy(
            fontWeight = FontWeight.Medium,
            fontSize = 12.sp,
            lineHeight = 15.sp,
            letterSpacing = 0.02.em,
        ),
        color = paletteMuted().copy(alpha = 0.55f),
        maxLines = 1,
    )
}

@Composable
private fun CommandGlyphIcon(glyph: CommandGlyph, color: Color, fillColor: Color, iconSize: Dp = 20.dp) {
    Canvas(Modifier.size(iconSize)) {
        val scale = size.minDimension / 24f
        fun x(v: Float) = v * scale
        fun y(v: Float) = v * scale
        fun o(px: Float, py: Float) = Offset(x(px), y(py))
        val stroke = Stroke(width = x(2f), cap = StrokeCap.Round, join = StrokeJoin.Round)

        fun line(x1: Float, y1: Float, x2: Float, y2: Float) {
            drawLine(color, o(x1, y1), o(x2, y2), strokeWidth = stroke.width, cap = StrokeCap.Round)
        }

        fun roundRect(left: Float, top: Float, width: Float, height: Float, radius: Float) {
            drawRoundRect(
                color = color,
                topLeft = o(left, top),
                size = Size(x(width), y(height)),
                cornerRadius = CornerRadius(x(radius), y(radius)),
                style = stroke,
            )
        }

        fun strokedPath(block: Path.() -> Unit) {
            drawPath(Path().apply(block), color = color, style = stroke)
        }

        when (glyph) {
            CommandGlyph.Link -> {
                strokedPath {
                    moveTo(x(10f), y(13f))
                    cubicTo(x(12f), y(15f), x(15f), y(15f), x(17f), y(13f))
                    lineTo(x(20f), y(10f))
                    cubicTo(x(22f), y(8f), x(22f), y(5f), x(20f), y(3f))
                    cubicTo(x(18f), y(1f), x(15f), y(1f), x(13f), y(3f))
                    lineTo(x(11.5f), y(4.5f))
                }
                strokedPath {
                    moveTo(x(14f), y(11f))
                    cubicTo(x(12f), y(9f), x(9f), y(9f), x(7f), y(11f))
                    lineTo(x(4f), y(14f))
                    cubicTo(x(2f), y(16f), x(2f), y(19f), x(4f), y(21f))
                    cubicTo(x(6f), y(23f), x(9f), y(23f), x(11f), y(21f))
                    lineTo(x(12.5f), y(19.5f))
                }
            }
            CommandGlyph.New -> {
                roundRect(3f, 3f, 18f, 18f, 3f)
                line(12f, 8f, 12f, 16f)
                line(8f, 12f, 16f, 12f)
            }
            CommandGlyph.Search -> {
                drawCircle(
                    color = color,
                    radius = x(6f),
                    center = o(10f, 10f),
                    style = stroke,
                )
                line(14.5f, 14.5f, 20f, 20f)
            }
            CommandGlyph.Lock -> {
                roundRect(4f, 11f, 16f, 10f, 2f)
                line(8f, 11f, 8f, 7f)
                drawArc(
                    color = color,
                    startAngle = 180f,
                    sweepAngle = 180f,
                    useCenter = false,
                    topLeft = o(8f, 3f),
                    size = Size(x(8f), y(8f)),
                    style = stroke,
                )
                line(16f, 7f, 16f, 11f)
            }
            CommandGlyph.Copy -> {
                roundRect(9f, 9f, 11f, 11f, 2f)
                strokedPath {
                    moveTo(x(5f), y(15f))
                    lineTo(x(4f), y(15f))
                    cubicTo(x(2.9f), y(15f), x(2f), y(14.1f), x(2f), y(13f))
                    lineTo(x(2f), y(4f))
                    cubicTo(x(2f), y(2.9f), x(2.9f), y(2f), x(4f), y(2f))
                    lineTo(x(13f), y(2f))
                    cubicTo(x(14.1f), y(2f), x(15f), y(2.9f), x(15f), y(4f))
                    lineTo(x(15f), y(5f))
                }
            }
            CommandGlyph.Settings -> {
                line(4f, 8f, 20f, 8f)
                line(4f, 16f, 20f, 16f)
                drawCircle(fillColor, radius = x(2.5f), center = o(9f, 8f))
                drawCircle(color, radius = x(2.5f), center = o(9f, 8f), style = stroke)
                drawCircle(fillColor, radius = x(2.5f), center = o(15f, 16f))
                drawCircle(color, radius = x(2.5f), center = o(15f, 16f), style = stroke)
            }
        }
    }
}

@Composable
private fun palettePrimary(): Color =
    if (ShellyTheme.colors.isDark) ShellyTheme.colors.textPrimary else ShellyTheme.colors.heroWordmark

@Composable
private fun paletteMuted(): Color =
    if (ShellyTheme.colors.isDark) ShellyTheme.colors.textMuted else ShellyTheme.colors.heroWordmark

@Composable
private fun shortcutBorderColor(): Color {
    val c = ShellyTheme.colors
    return if (c.isDark) c.textPrimary.copy(alpha = 0.10f) else c.heroWordmark.copy(alpha = 0.20f)
}

private data class PaletteCommand(
    val title: String,
    val shortcut: String,
    val glyph: CommandGlyph,
    val onClick: () -> Unit,
    val searchTerms: List<String> = emptyList(),
    val hiddenUntilQuery: Boolean = false,
) {
    fun matches(query: String): Boolean {
        val normalized = query.trim().removeSuffix("█").lowercase()
        if (normalized.isBlank()) return !hiddenUntilQuery
        return title.lowercase().contains(normalized) || searchTerms.any { it.lowercase().contains(normalized) }
    }
}

private enum class CommandGlyph {
    Link,
    New,
    Search,
    Lock,
    Copy,
    Settings,
}

private fun commandPaletteCommands(
    onAttachSession: () -> Unit,
    onNewSession: () -> Unit,
    onSearchSessions: () -> Unit,
    onLockNow: () -> Unit,
    onCopyLastOutput: () -> Unit,
    onOpenSettings: () -> Unit,
    onShowGroupedSessions: () -> Unit,
    onShowReconnecting: () -> Unit,
    onShowDaemonUnreachable: () -> Unit,
) = listOf(
    PaletteCommand(
        title = "Attach session",
        shortcut = "⏎",
        glyph = CommandGlyph.Link,
        onClick = onAttachSession,
        searchTerms = listOf("open", "connect"),
    ),
    PaletteCommand(
        title = "New session",
        shortcut = "⌘N",
        glyph = CommandGlyph.New,
        onClick = onNewSession,
        searchTerms = listOf("create"),
    ),
    PaletteCommand(
        title = "Search sessions",
        shortcut = "/",
        glyph = CommandGlyph.Search,
        onClick = onSearchSessions,
        searchTerms = listOf("find", "filter"),
        hiddenUntilQuery = true,
    ),
    PaletteCommand(
        title = "Lock now",
        shortcut = "⌘L",
        glyph = CommandGlyph.Lock,
        onClick = onLockNow,
        searchTerms = listOf("secure"),
    ),
    PaletteCommand(
        title = "Open settings",
        shortcut = ",",
        glyph = CommandGlyph.Settings,
        onClick = onOpenSettings,
        searchTerms = listOf("preferences"),
    ),
) + if (BuildConfig.DEBUG) {
    // Debug-only previews of the reconnecting / daemon-unreachable / grouped states.
    // Gated so they never ship in release builds.
    listOf(
        PaletteCommand(
            title = "Show grouped sessions",
            shortcut = "DBG",
            glyph = CommandGlyph.Settings,
            onClick = onShowGroupedSessions,
            searchTerms = listOf("debug grouped multi device"),
            hiddenUntilQuery = true,
        ),
        PaletteCommand(
            title = "Show reconnecting",
            shortcut = "DBG",
            glyph = CommandGlyph.Settings,
            onClick = onShowReconnecting,
            searchTerms = listOf("debug reconnect offline sync"),
            hiddenUntilQuery = true,
        ),
        PaletteCommand(
            title = "Show daemon unreachable",
            shortcut = "DBG",
            glyph = CommandGlyph.Settings,
            onClick = onShowDaemonUnreachable,
            searchTerms = listOf("debug daemon unreachable offline"),
            hiddenUntilQuery = true,
        ),
    )
} else {
    emptyList()
}

@Composable
internal fun CommandPaletteContentPreview() {
    val visibleCommands = commandPaletteCommands(
        onAttachSession = {},
        onNewSession = {},
        onSearchSessions = {},
        onLockNow = {},
        onCopyLastOutput = {},
        onOpenSettings = {},
        onShowGroupedSessions = {},
        onShowReconnecting = {},
        onShowDaemonUnreachable = {},
    ).filterNot { it.hiddenUntilQuery }

    CommandPaletteContent(
        query = "attach█",
        onQueryChange = {},
        commands = visibleCommands,
        onBack = {},
    )
}
