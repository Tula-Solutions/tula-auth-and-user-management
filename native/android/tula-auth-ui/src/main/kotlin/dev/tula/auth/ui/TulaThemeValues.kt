package dev.tula.auth.ui

import dev.tula.auth.generated.TulaTheme
import dev.tula.auth.generated.TulaThemeDefaults
import dev.tula.auth.generated.TulaThemeScheme

// A theme reaches the screens in two steps, and both refuse rather than guess (ADR 0061):
//
//   1. `TulaThemeGrammar.isValid` is the contract's `isValidThemeValue`
//      (packages/contract/src/theme.ts), rule for rule. A theme value is untrusted (a brand
//      colour can come from data a tenant edits), so it is checked, never escaped.
//   2. A value the grammar accepts is turned into a number the platform draws with. What this
//      version cannot turn into one (a `lab()` colour, a length in `vw`) is refused as well.
//
// A refused value is replaced by the default theme's value for the same token, and its token
// is named in `TulaResolvedTheme.refused`: the token's key, never the value.

/** The kinds of value a theme token has, as the generated `TulaThemeToken.type` spells them. */
enum class TulaThemeValueType(
    /** The contract's name of the type. */
    val rawValue: String,
) {
    /** A colour. */
    COLOR("color"),

    /** A length. */
    LENGTH("length"),

    /** A list of typefaces. */
    FONT_FAMILY("fontFamily"),

    /** A shadow. */
    SHADOW("shadow"),
}

/**
 * The contract's grammar of theme values (`isValidThemeValue` in `@tula-tech/contract/theme`).
 *
 * It is never looser than the contract's: what that refuses, this refuses. It is stricter in
 * one place, on purpose: a value that holds anything outside ASCII is refused (the contract
 * allows Unicode white space between the parts of a value, and nothing else outside ASCII).
 *
 * It is a copy kept equal by hand, and held to `packages/contract/src/theme-cases.json` by a
 * test: a rule changed in `theme.ts` is changed here in the same change.
 */
object TulaThemeGrammar {
    /** No value is longer than this, in UTF-16 units, as the contract counts them. */
    internal const val MAX_LENGTH = 200

    private val ignoreCase = setOf(RegexOption.IGNORE_CASE)

    /** What no value may contain, whatever its type. */
    private val forbidden = Regex("""[;{}<>\\@!\n\r\f\u0000]|/\*|url\(|expression\(|var\(""", ignoreCase)
    private val hexColor = Regex("""#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})""", ignoreCase)
    private val functionColor = Regex(
        """(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(\s*[0-9a-z.%+-]+(?:\s*[\s,/]\s*[0-9a-z.%+-]+){2,4}\s*\)""",
        ignoreCase,
    )
    private val namedColor = Regex("""[a-z]{3,30}""", ignoreCase)
    private val length = Regex("""(?:0|[+-]?(?:\d+\.?\d*|\.\d+)(?:px|rem|em|%|ch|ex|pt|vw|vh|vmin|vmax))""", ignoreCase)
    private val fontFamily = Regex(""""[\w .-]+"|'[\w .-]+'|-?[a-z_][\w-]*(?: [\w-]+)*""", ignoreCase)

    /** The white space of ASCII, which is all the white space a value may hold here. */
    internal fun isSpace(character: Char): Boolean =
        character == ' ' || character == '\t' || character == '\n' || character == '\u000B' ||
            character == '\u000C' || character == '\r'

    internal fun trimmed(value: String): String = value.trim(::isSpace)

    internal fun isColor(value: String): Boolean =
        hexColor.matches(value) || functionColor.matches(value) || namedColor.matches(value)

    internal fun isLength(value: String): Boolean = length.matches(value)

    /** Split on a separator wherever it is not inside parentheses; `null` for unbalanced ones. */
    internal fun splitOutsideParentheses(value: String, separates: (Char) -> Boolean): List<String>? {
        val parts = ArrayList<String>()
        var depth = 0
        val current = StringBuilder()
        for (character in value) {
            if (character == '(') {
                depth += 1
            } else if (character == ')') {
                depth -= 1
                if (depth < 0) {
                    return null
                }
            }
            if (depth == 0 && separates(character)) {
                parts.add(current.toString())
                current.setLength(0)
            } else {
                current.append(character)
            }
        }
        parts.add(current.toString())
        return if (depth == 0) parts else null
    }

    /** One shadow: an optional `inset`, two to four lengths and at most one colour. */
    private fun isShadowLayer(layer: String): Boolean {
        val split = splitOutsideParentheses(trimmed(layer), ::isSpace) ?: return false
        val parts = split.filter { it.isNotEmpty() }
        val rest = parts.filter { it.lowercase() != "inset" }
        val lengths = rest.count(::isLength)
        val colors = rest.filterNot(::isLength)
        return parts.size - rest.size <= 1 && lengths in 2..4 && colors.size <= 1 && colors.all(::isColor)
    }

    /**
     * Whether a string is a plain value of a token's type.
     *
     * @param type The token's type.
     * @param value The candidate, as an app or a tenant wrote it.
     * @return `true` when the contract's grammar accepts it.
     */
    fun isValid(type: TulaThemeValueType, value: String): Boolean {
        if (value.isEmpty() || value.length > MAX_LENGTH || value.any { it.code > 0x7F } ||
            forbidden.containsMatchIn(value)
        ) {
            return false
        }
        val plain = trimmed(value)
        return when (type) {
            TulaThemeValueType.COLOR -> isColor(plain)
            TulaThemeValueType.LENGTH -> isLength(plain)
            TulaThemeValueType.FONT_FAMILY ->
                (splitOutsideParentheses(plain) { it == ',' } ?: listOf("")).all { fontFamily.matches(trimmed(it)) }
            TulaThemeValueType.SHADOW ->
                plain.lowercase() == "none" ||
                    splitOutsideParentheses(plain) { it == ',' }?.all(::isShadowLayer) == true
        }
    }
}

/** A colour as the platform draws it: sRGB channels and an opacity, each from 0 to 1. */
class TulaColorValue internal constructor(red: Double, green: Double, blue: Double, opacity: Double = 1.0) {
    /** Red, 0 to 1. */
    val red: Double = red.coerceIn(0.0, 1.0)

    /** Green, 0 to 1. */
    val green: Double = green.coerceIn(0.0, 1.0)

    /** Blue, 0 to 1. */
    val blue: Double = blue.coerceIn(0.0, 1.0)

    /** Opacity, 0 (clear) to 1 (opaque). */
    val opacity: Double = opacity.coerceIn(0.0, 1.0)

    override fun equals(other: Any?): Boolean =
        other is TulaColorValue && red == other.red && green == other.green && blue == other.blue &&
            opacity == other.opacity

    override fun hashCode(): Int = listOf(red, green, blue, opacity).hashCode()

    override fun toString(): String = "TulaColorValue($red, $green, $blue, $opacity)"

    /** Reads a colour from a theme value. */
    companion object {
        internal val BLACK = TulaColorValue(0.0, 0.0, 0.0)
        internal val WHITE = TulaColorValue(1.0, 1.0, 1.0)

        /**
         * The colour of a theme value, or `null` for one the grammar refuses or this version
         * cannot draw.
         *
         * Drawn: `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`; `rgb()` and `rgba()`; `hsl()` and
         * `hsla()`; and the keywords `transparent`, `black` and `white`. Every other form the
         * grammar accepts (`hwb()`, `lab()`, `lch()`, `oklab()`, `oklch()`, another keyword) is
         * `null`: there is no table of CSS colour names here, and a guess would draw a brand in
         * the wrong colour.
         *
         * @param value A theme value.
         * @return The colour, or `null`.
         */
        fun of(value: String): TulaColorValue? {
            if (!TulaThemeGrammar.isValid(TulaThemeValueType.COLOR, value)) {
                return null
            }
            val plain = TulaThemeGrammar.trimmed(value).lowercase()
            if (plain.startsWith("#")) {
                return hex(plain.drop(1))
            }
            when (plain) {
                "transparent" -> return TulaColorValue(0.0, 0.0, 0.0, 0.0)
                "black" -> return BLACK
                "white" -> return WHITE
            }
            val open = plain.indexOf('(')
            if (open < 0 || !plain.endsWith(")")) {
                return null
            }
            val arguments = plain.substring(open + 1, plain.length - 1)
                .split(*SEPARATORS)
                .filter { it.isNotEmpty() }
            if (arguments.size != 3 && arguments.size != 4) {
                return null
            }
            val opacity = if (arguments.size == 4) alpha(arguments[3]) ?: return null else 1.0
            return when (plain.substring(0, open)) {
                "rgb", "rgba" -> {
                    val red = channel(arguments[0]) ?: return null
                    val green = channel(arguments[1]) ?: return null
                    val blue = channel(arguments[2]) ?: return null
                    TulaColorValue(red, green, blue, opacity)
                }
                "hsl", "hsla" -> {
                    val hue = number(arguments[0], "deg", "") ?: return null
                    val saturation = number(arguments[1], "%") ?: return null
                    val lightness = number(arguments[2], "%") ?: return null
                    hsl(hue, saturation / 100, lightness / 100, opacity)
                }
                else -> null
            }
        }

        private val SEPARATORS = arrayOf(" ", "\t", "\n", "\u000B", "\u000C", "\r", ",", "/")

        private fun hex(digits: String): TulaColorValue? {
            val wide = if (digits.length <= 4) digits.map { "$it$it" }.joinToString("") else digits
            if (wide.length != 6 && wide.length != 8) {
                return null
            }
            val packed = wide.toLongOrNull(16) ?: return null
            val all = if (wide.length == 6) (packed shl 8) or 0xFF else packed
            fun byte(shift: Int) = ((all shr shift) and 0xFF).toDouble() / 255
            return TulaColorValue(byte(24), byte(16), byte(8), byte(0))
        }

        /** A plain decimal number with one of the given suffixes. No exponent, no keyword. */
        private fun number(text: String, vararg suffixes: String): Double? {
            for (suffix in suffixes) {
                if (!text.endsWith(suffix)) {
                    continue
                }
                val digits = text.dropLast(suffix.length)
                val unsigned = digits.trimStart('+', '-')
                val plain = digits.length - unsigned.length <= 1 && unsigned.isNotEmpty() && unsigned != "." &&
                    unsigned.all { it in '0'..'9' || it == '.' } && unsigned.count { it == '.' } <= 1
                val value = if (plain) digits.toDoubleOrNull() else null
                if (value != null && value.isFinite()) {
                    return value
                }
            }
            return null
        }

        private fun channel(text: String): Double? =
            number(text, "%")?.let { it / 100 } ?: number(text, "")?.let { it / 255 }

        private fun alpha(text: String): Double? = number(text, "%")?.let { it / 100 } ?: number(text, "")

        private fun hsl(hue: Double, saturation: Double, lightness: Double, opacity: Double): TulaColorValue {
            val turn = ((hue % 360 + 360) % 360) / 30
            val s = saturation.coerceIn(0.0, 1.0)
            val l = lightness.coerceIn(0.0, 1.0)
            val a = s * minOf(l, 1 - l)
            fun part(n: Double): Double {
                val k = (n + turn) % 12
                return l - a * maxOf(-1.0, minOf(k - 3, 9 - k, 1.0))
            }
            return TulaColorValue(part(0.0), part(8.0), part(4.0), opacity)
        }
    }
}

/** The typeface of a theme: the platform's, or a named one. */
sealed class TulaFontFamily {
    /** The platform's typeface (its monospaced one for the theme's `fontFamilyMono`). */
    data object System : TulaFontFamily()

    /** A typeface by name. One the device does not have is drawn in the platform's. */
    data class Named(val name: String) : TulaFontFamily()

    /** Reads a typeface from a theme value. */
    companion object {
        /** The names CSS gives the platform's own typefaces: each means "the platform's" here. */
        internal val GENERIC = setOf(
            "ui-sans-serif", "system-ui", "-apple-system", "blinkmacsystemfont", "sans-serif", "serif", "ui-serif",
            "ui-monospace", "monospace", "ui-rounded", "cursive", "fantasy", "inherit", "initial", "unset",
        )

        /**
         * The typeface of a theme value: the **first** family of the list decides. A generic
         * name is the platform's typeface; anything else is asked for by name.
         *
         * @param value A theme value of type `fontFamily`.
         * @return `null` for a value the grammar refuses.
         */
        fun of(value: String): TulaFontFamily? {
            if (!TulaThemeGrammar.isValid(TulaThemeValueType.FONT_FAMILY, value)) {
                return null
            }
            val first = TulaThemeGrammar.trimmed(value).split(',').first()
            val name = TulaThemeGrammar.trimmed(first).trim('"', '\'')
            return if (name.lowercase() in GENERIC) System else Named(name)
        }
    }
}

/** The colours of one scheme, ready to draw. */
data class TulaResolvedScheme(
    /** Behind a screen. */
    val background: TulaColorValue,
    /** A raised part (the brand tile). */
    val surface: TulaColorValue,
    /** Inside a field. */
    val input: TulaColorValue,
    /** Text. */
    val text: TulaColorValue,
    /** Subtitles, hints and the last line. */
    val textMuted: TulaColorValue,
    /** The main button. */
    val primary: TulaColorValue,
    /** The main button while it is pressed. */
    val primaryHover: TulaColorValue,
    /** The main button's text. */
    val primaryText: TulaColorValue,
    /** Links. */
    val link: TulaColorValue,
    /** A divider. */
    val border: TulaColorValue,
    /** A field's edge. */
    val borderStrong: TulaColorValue,
    /** A problem's text, and the edge of a field that has one. */
    val danger: TulaColorValue,
    /** Behind a screen's error. */
    val dangerSurface: TulaColorValue,
    /** A status that says something worked. */
    val success: TulaColorValue,
    /** The edge of the field that has the focus. */
    val focus: TulaColorValue,
    /** Over a screen that is covered. Checked, and not drawn by these screens. */
    val overlay: TulaColorValue,
)

/**
 * A theme with every value checked and turned into what the platform draws with.
 *
 * ```kotlin
 * val theme = TulaThemeDefaults.theme.let {
 *     it.copy(light = it.light.copy(primary = "#0f766e"), dark = it.dark.copy(primary = "#5eead4"))
 * }
 * val resolved = TulaResolvedTheme.of(theme)
 * resolved.refused   // [] — or the tokens whose value was not used, e.g. ["light.primary"]
 * ```
 *
 * A value that is refused (by the contract's grammar, or because this version cannot draw it)
 * is replaced by the default theme's value for that token. Nothing an app or a tenant wrote
 * reaches a screen any other way.
 */
@ConsistentCopyVisibility
data class TulaResolvedTheme internal constructor(
    /** The light scheme. */
    val light: TulaResolvedScheme,
    /** The dark scheme. */
    val dark: TulaResolvedScheme,
    /** Corner radius of fields and buttons, in density-independent pixels. */
    val radius: Double,
    /** Corner radius of small parts, in density-independent pixels. */
    val radiusSmall: Double,
    /** The typeface of everything. */
    val fontFamily: TulaFontFamily,
    /** The typeface of codes. */
    val fontFamilyMono: TulaFontFamily,
    /** Body text size, in scale-independent pixels: the user's font scale applies. */
    val fontSize: Double,
    /** Size of hints, in scale-independent pixels. */
    val fontSizeSmall: Double,
    /** Size of a title, in scale-independent pixels. */
    val fontSizeTitle: Double,
    /** The spacing unit, in density-independent pixels. */
    val spacing: Double,
    /**
     * The tokens whose value was refused and replaced by the default: `light.primary`,
     * `radius`. A token's key, never the value it was given.
     */
    val refused: List<String>,
) {
    /**
     * The scheme the system is in.
     *
     * @param dark Whether the system is in its dark scheme.
     * @return [TulaResolvedTheme.dark] or [light].
     */
    fun scheme(dark: Boolean): TulaResolvedScheme = if (dark) this.dark else light

    /** Resolves a theme. */
    companion object {
        /** The longest length a token may be. Nothing on a sign-in screen is that large. */
        internal const val MAX_POINTS = 200.0

        /** The smallest text size. A smaller one is refused: it could not be read. */
        internal const val MIN_FONT_SIZE = 11.0

        /** What one `rem` or `em` is: a browser's default text size. */
        internal const val POINTS_PER_REM = 16.0

        internal val COLOR_TOKENS: List<Pair<String, (TulaThemeScheme) -> String>> = listOf(
            "background" to { it.background }, "surface" to { it.surface }, "input" to { it.input },
            "text" to { it.text }, "textMuted" to { it.textMuted }, "primary" to { it.primary },
            "primaryHover" to { it.primaryHover }, "primaryText" to { it.primaryText }, "link" to { it.link },
            "border" to { it.border }, "borderStrong" to { it.borderStrong }, "danger" to { it.danger },
            "dangerSurface" to { it.dangerSurface }, "success" to { it.success }, "focus" to { it.focus },
            "overlay" to { it.overlay },
        )

        /**
         * The tokens a phone's screens do not draw: there is no card to cast a shadow. They are
         * still checked, so that `refused` names a bad one.
         */
        internal val CHECKED_ONLY: List<Triple<String, (TulaThemeScheme) -> String, TulaThemeValueType>> =
            listOf(Triple("shadow", { it.shadow }, TulaThemeValueType.SHADOW))

        /** Key, how it is read, and whether it is a text size. */
        internal val LENGTH_TOKENS: List<Triple<String, (TulaTheme) -> String, Boolean>> = listOf(
            Triple("radius", { it.radius }, false), Triple("radiusSmall", { it.radiusSmall }, false),
            Triple("fontSize", { it.fontSize }, true), Triple("fontSizeSmall", { it.fontSizeSmall }, true),
            Triple("fontSizeTitle", { it.fontSizeTitle }, true), Triple("spacing", { it.spacing }, false),
        )

        internal val FONT_TOKENS: List<Pair<String, (TulaTheme) -> String>> =
            listOf("fontFamily" to { it.fontFamily }, "fontFamilyMono" to { it.fontFamilyMono })

        /**
         * What stands in where a generated default itself could not be read (a change of the
         * contract this file has not followed): the token is then named in `refused` of
         * [defaults], and the test "the default theme resolves whole" fails.
         */
        private val LAST_RESORT_LENGTHS = mapOf(
            "radius" to 12.0, "radiusSmall" to 8.0, "fontSize" to 15.0, "fontSizeSmall" to 13.0,
            "fontSizeTitle" to 24.0, "spacing" to 16.0,
        )

        /** The contract's default theme. */
        val defaults: TulaResolvedTheme by lazy { resolve(TulaThemeDefaults.theme, null) }

        /**
         * Check a theme and turn it into what the platform draws with.
         *
         * @param theme A theme: the generated `TulaThemeDefaults.theme` with the values an app,
         *   or a tenant, changed.
         * @return The theme, with every refused value replaced by the default's.
         */
        fun of(theme: TulaTheme): TulaResolvedTheme =
            if (theme == TulaThemeDefaults.theme) defaults else resolve(theme, defaults)

        /**
         * A length in density-independent pixels, or `null` for one the grammar refuses or this
         * version cannot measure.
         *
         * Measured: `0`, `px` and `pt` (one each), `rem` and `em` (16 each). Every other unit
         * the grammar accepts (`%`, `ch`, `ex`, `vw`, `vh`, `vmin`, `vmax`) is `null`: it is a
         * share of something a native screen does not have. So is a negative length, one over
         * 200, and a text size under 11.
         */
        internal fun points(value: String, text: Boolean): Double? {
            if (!TulaThemeGrammar.isValid(TulaThemeValueType.LENGTH, value)) {
                return null
            }
            val plain = TulaThemeGrammar.trimmed(value).lowercase()
            val measured = if (plain == "0") {
                0.0
            } else {
                // `rem` before `em`: the longer unit ends with the shorter.
                listOf("rem" to POINTS_PER_REM, "em" to POINTS_PER_REM, "px" to 1.0, "pt" to 1.0)
                    .firstOrNull { plain.endsWith(it.first) }
                    ?.let { (unit, scale) -> plain.dropLast(unit.length).toDoubleOrNull()?.times(scale) }
            }
            val floor = if (text) MIN_FONT_SIZE else 0.0
            return measured?.takeIf { it.isFinite() && it >= floor && it <= MAX_POINTS }
        }

        private fun resolve(theme: TulaTheme, fallback: TulaResolvedTheme?): TulaResolvedTheme {
            val refused = ArrayList<String>()
            fun scheme(name: String, from: TulaThemeScheme, base: TulaResolvedScheme?, dark: Boolean): TulaResolvedScheme {
                val ink = if (dark) TulaColorValue.WHITE else TulaColorValue.BLACK
                val paper = if (dark) TulaColorValue.BLACK else TulaColorValue.WHITE
                val standIn = base ?: TulaResolvedScheme(
                    paper, paper, paper, ink, ink, ink, ink, paper, ink, ink, ink, ink, paper, ink, ink, ink,
                )
                val colors = COLOR_TOKENS.associate { (key, read) ->
                    key to (TulaColorValue.of(read(from)) ?: null.also { refused.add("$name.$key") })
                }
                for ((key, read, type) in CHECKED_ONLY) {
                    if (!TulaThemeGrammar.isValid(type, read(from))) {
                        refused.add("$name.$key")
                    }
                }
                return TulaResolvedScheme(
                    background = colors["background"] ?: standIn.background,
                    surface = colors["surface"] ?: standIn.surface,
                    input = colors["input"] ?: standIn.input,
                    text = colors["text"] ?: standIn.text,
                    textMuted = colors["textMuted"] ?: standIn.textMuted,
                    primary = colors["primary"] ?: standIn.primary,
                    primaryHover = colors["primaryHover"] ?: standIn.primaryHover,
                    primaryText = colors["primaryText"] ?: standIn.primaryText,
                    link = colors["link"] ?: standIn.link,
                    border = colors["border"] ?: standIn.border,
                    borderStrong = colors["borderStrong"] ?: standIn.borderStrong,
                    danger = colors["danger"] ?: standIn.danger,
                    dangerSurface = colors["dangerSurface"] ?: standIn.dangerSurface,
                    success = colors["success"] ?: standIn.success,
                    focus = colors["focus"] ?: standIn.focus,
                    overlay = colors["overlay"] ?: standIn.overlay,
                )
            }
            val light = scheme("light", theme.light, fallback?.light, dark = false)
            val dark = scheme("dark", theme.dark, fallback?.dark, dark = true)
            val standIns = fallback?.let {
                mapOf(
                    "radius" to it.radius, "radiusSmall" to it.radiusSmall, "fontSize" to it.fontSize,
                    "fontSizeSmall" to it.fontSizeSmall, "fontSizeTitle" to it.fontSizeTitle, "spacing" to it.spacing,
                )
            } ?: LAST_RESORT_LENGTHS
            val lengths = LENGTH_TOKENS.associate { (key, read, text) ->
                key to (points(read(theme), text) ?: standIns.getValue(key).also { refused.add(key) })
            }
            val fonts = FONT_TOKENS.associate { (key, read) ->
                val standIn = (if (key == "fontFamily") fallback?.fontFamily else fallback?.fontFamilyMono)
                    ?: TulaFontFamily.System
                key to (TulaFontFamily.of(read(theme)) ?: standIn.also { refused.add(key) })
            }
            return TulaResolvedTheme(
                light = light,
                dark = dark,
                radius = lengths.getValue("radius"),
                radiusSmall = lengths.getValue("radiusSmall"),
                fontFamily = fonts.getValue("fontFamily"),
                fontFamilyMono = fonts.getValue("fontFamilyMono"),
                fontSize = lengths.getValue("fontSize"),
                fontSizeSmall = lengths.getValue("fontSizeSmall"),
                fontSizeTitle = lengths.getValue("fontSizeTitle"),
                spacing = lengths.getValue("spacing"),
                refused = refused,
            )
        }
    }
}
