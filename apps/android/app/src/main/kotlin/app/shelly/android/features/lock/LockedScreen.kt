package app.shelly.android.features.lock

import android.content.Context
import android.text.format.DateFormat
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
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
import androidx.compose.ui.graphics.Color
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
            eyebrow = "UNLOCK TO PICK UP\nWHERE YOU LEFT OFF",
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
private fun LockedHeroStatus(primary: Color, muted: Color) {
    Text(
        "SESSIONS HELD ON YOUR LAPTOP",
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
        Text(
            "Your sessions kept running on your laptop.\nUnlock to see where they're at.",
            style = ShellyType.itemTitle.copy(
                fontSize = 14.sp,
                lineHeight = 20.sp,
                fontWeight = FontWeight.Medium,
            ),
            color = primary,
        )
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

private fun lockedHeroStatusMuted(c: ShellyColors, primary: Color): Color =
    if (c.isDark) c.textMuted.copy(alpha = 0.7f) else primary.copy(alpha = 0.7f)

private fun lockedContentPrimary(c: ShellyColors): Color =
    c.ink

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
