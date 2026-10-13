package dev.tula.auth.compose

import android.graphics.Typeface
import androidx.compose.runtime.Immutable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.tula.auth.ui.TulaColorValue
import dev.tula.auth.ui.TulaFontFamily
import dev.tula.auth.ui.TulaResolvedScheme
import dev.tula.auth.ui.TulaResolvedTheme

/**
 * The colours of one scheme, as Compose draws them.
 *
 * Every value passed [TulaResolvedTheme]'s checks first: nothing an app or a tenant wrote
 * becomes a [Color] any other way.
 */
@Immutable
class TulaComposeColors internal constructor(scheme: TulaResolvedScheme) {
    /** Behind a screen. */
    val background: Color = scheme.background.color()

    /** Behind what stands out of the background. */
    val surface: Color = scheme.surface.color()

    /** Behind what is typed. */
    val input: Color = scheme.input.color()

    /** Titles, labels and what is typed. */
    val text: Color = scheme.text.color()

    /** Subtitles and hints. */
    val textMuted: Color = scheme.textMuted.color()

    /** The main button. */
    val primary: Color = scheme.primary.color()

    /** The main button while it is pressed. */
    val primaryHover: Color = scheme.primaryHover.color()

    /** The main button's words. */
    val primaryText: Color = scheme.primaryText.color()

    /** A link. */
    val link: Color = scheme.link.color()

    /** A quiet edge. */
    val border: Color = scheme.border.color()

    /** A field's edge. */
    val borderStrong: Color = scheme.borderStrong.color()

    /** A problem's words, and the edge of a field that has one. */
    val danger: Color = scheme.danger.color()

    /** Behind the form's problem. */
    val dangerSurface: Color = scheme.dangerSurface.color()

    /** A status. */
    val success: Color = scheme.success.color()

    /** The edge of the field with the focus. */
    val focus: Color = scheme.focus.color()
}

/**
 * What a slot draws with: the colours of the scheme the system is in, and the theme's sizes.
 *
 * Lengths are density-independent pixels and text sizes scale-independent pixels, so the
 * user's display size and font scale apply.
 */
@Immutable
class TulaComposeTheme internal constructor(theme: TulaResolvedTheme, dark: Boolean) {
    /** The colours of the scheme the system is in. */
    val colors: TulaComposeColors = TulaComposeColors(theme.scheme(dark))

    /** Corner radius of fields and buttons. */
    val radius: Dp = theme.radius.dp

    /** Corner radius of small parts. */
    val radiusSmall: Dp = theme.radiusSmall.dp

    /** The spacing unit. */
    val spacing: Dp = theme.spacing.dp

    /** Body text size. */
    val fontSize: TextUnit = theme.fontSize.sp

    /** Size of hints. */
    val fontSizeSmall: TextUnit = theme.fontSizeSmall.sp

    /** Size of a title. */
    val fontSizeTitle: TextUnit = theme.fontSizeTitle.sp

    /** The typeface of everything. */
    val fontFamily: FontFamily = theme.fontFamily.family(FontFamily.Default)

    /** The typeface of codes. */
    val fontFamilyMono: FontFamily = theme.fontFamilyMono.family(FontFamily.Monospace)
}

private fun TulaColorValue.color(): Color =
    Color(red = red.toFloat(), green = green.toFloat(), blue = blue.toFloat(), alpha = opacity.toFloat())

private val Double.dp: Dp get() = toFloat().dp

private val Double.sp: TextUnit get() = toFloat().sp

/**
 * A typeface by name is the system's to find: a name the device does not have is drawn in the
 * platform's default, which is what `Typeface.create` answers for one. No font file is read.
 */
private fun TulaFontFamily.family(platform: FontFamily): FontFamily = when (this) {
    TulaFontFamily.System -> platform
    is TulaFontFamily.Named -> FontFamily(Typeface.create(name, Typeface.NORMAL))
}
