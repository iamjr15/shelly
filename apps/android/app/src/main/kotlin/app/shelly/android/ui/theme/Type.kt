@file:OptIn(androidx.compose.ui.text.ExperimentalTextApi::class)

package app.shelly.android.ui.theme

import androidx.compose.material3.Typography
import androidx.compose.ui.text.PlatformTextStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontVariation
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.LineHeightStyle
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import app.shelly.android.R

// Variable fonts: one file per family, weight selected via FontVariation.
private fun inter(weight: Int) = Font(
    R.font.inter_variable,
    weight = FontWeight(weight),
    variationSettings = FontVariation.Settings(FontVariation.weight(weight)),
)

private fun mono(weight: Int) = Font(
    R.font.jetbrains_mono_variable,
    weight = FontWeight(weight),
    variationSettings = FontVariation.Settings(FontVariation.weight(weight)),
)

val Inter = FontFamily(
    inter(400), inter(500), inter(600), inter(700), inter(900),
)

val JetBrainsMono = FontFamily(
    mono(400), mono(500), mono(600), mono(700),
)

private val TrimBoth = LineHeightStyle(
    alignment = LineHeightStyle.Alignment.Center,
    trim = LineHeightStyle.Trim.None,
)

/** Named text styles taken directly from the Paper design specs. */
object ShellyType {
    // Display wordmark (ABOUT / SES / PREFS …) — Inter Black, tight tracking.
    // Size is set per screen via HeroBody(wordmarkSize=…); line box trimmed so the
    // glyphs hug the eyebrow above and content below (matches the Paper hero).
    val wordmark = TextStyle(
        fontFamily = Inter,
        fontWeight = FontWeight(900),
        fontSize = 132.sp,
        lineHeight = 119.sp,
        letterSpacing = (-0.05).em,
        lineHeightStyle = LineHeightStyle(
            alignment = LineHeightStyle.Alignment.Center,
            trim = LineHeightStyle.Trim.Both,
        ),
        platformStyle = PlatformTextStyle(includeFontPadding = false),
    )

    // Brand row "SHELLY".
    val brand = TextStyle(
        fontFamily = Inter,
        fontWeight = FontWeight(700),
        fontSize = 14.sp,
        lineHeight = 18.sp,
        letterSpacing = 0.04.em,
    )

    // Eyebrow / section label — bold caps, 2-line statements in the hero.
    val eyebrow = TextStyle(
        fontFamily = Inter,
        fontWeight = FontWeight(700),
        fontSize = 13.sp,
        lineHeight = 18.sp,
        letterSpacing = 0.04.em,
    )

    // Session row title (orange wordmark family weight).
    val rowTitle = TextStyle(
        fontFamily = Inter,
        fontWeight = FontWeight(700),
        fontSize = 17.sp,
        lineHeight = 22.sp,
        lineHeightStyle = TrimBoth,
    )

    // Settings / list-item title — slightly larger, medium weight.
    val itemTitle = TextStyle(
        fontFamily = Inter,
        fontWeight = FontWeight(500),
        fontSize = 20.sp,
        lineHeight = 24.sp,
    )

    // Big section heading inside content (e.g. "Start one from your laptop").
    val heading = TextStyle(
        fontFamily = Inter,
        fontWeight = FontWeight(600),
        fontSize = 22.sp,
        lineHeight = 27.sp,
    )

    // Monospace subtitle / command line under a row.
    val mono = TextStyle(
        fontFamily = JetBrainsMono,
        fontWeight = FontWeight(400),
        fontSize = 13.sp,
        lineHeight = 16.sp,
    )

    // Smaller mono — value labels, captions.
    val monoSmall = TextStyle(
        fontFamily = JetBrainsMono,
        fontWeight = FontWeight(400),
        fontSize = 12.sp,
        lineHeight = 16.sp,
    )

    // Micro caps label — "MATCHING COMMANDS", "WHILE YOU WERE AWAY".
    val microLabel = TextStyle(
        fontFamily = JetBrainsMono,
        fontWeight = FontWeight(700),
        fontSize = 11.sp,
        lineHeight = 14.sp,
        letterSpacing = 0.12.em,
    )

    // Filled / ghost button label.
    val button = TextStyle(
        fontFamily = Inter,
        fontWeight = FontWeight(700),
        fontSize = 16.sp,
        lineHeight = 20.sp,
        letterSpacing = 0.01.em,
    )

    // Chip label.
    val chip = TextStyle(
        fontFamily = Inter,
        fontWeight = FontWeight(600),
        fontSize = 13.sp,
        lineHeight = 16.sp,
    )
}

// Material fallback typography (used by stray Material components).
val ShellyTypography = Typography(
    bodyLarge = ShellyType.mono.copy(fontFamily = Inter, fontWeight = FontWeight(400), fontSize = 16.sp, lineHeight = 22.sp),
    bodyMedium = TextStyle(fontFamily = Inter, fontWeight = FontWeight(400), fontSize = 14.sp, lineHeight = 20.sp),
    titleLarge = ShellyType.heading,
    labelLarge = ShellyType.button,
)
