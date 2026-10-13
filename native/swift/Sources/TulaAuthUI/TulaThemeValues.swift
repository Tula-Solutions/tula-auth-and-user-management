import Foundation
import TulaAuth

// A theme reaches the screens in two steps, and both refuse rather than guess (ADR 0057):
//
//   1. `TulaThemeGrammar.isValid` is the contract's `isValidThemeValue`
//      (packages/contract/src/theme.ts), rule for rule. A theme value is untrusted (a brand
//      colour can come from data a tenant edits), so it is checked, never escaped.
//   2. A value the grammar accepts is turned into a number the system draws with. What this
//      version cannot turn into one (a `lab()` colour, a length in `vw`) is refused as well.
//
// A refused value is replaced by the default theme's value for the same token, and its
// token is named in `TulaResolvedTheme.refused`: the token's key, never the value.

/// The kinds of value a theme token has, as `TulaThemeToken.type` spells them.
public enum TulaThemeValueType: String, Hashable, Sendable, CaseIterable {
    /// A colour.
    case color
    /// A length.
    case length
    /// A list of typefaces.
    case fontFamily
    /// A shadow.
    case shadow
}

/// The contract's grammar of theme values (`isValidThemeValue` in `@tula-tech/contract/theme`).
///
/// It is never looser than the contract's: what that refuses, this refuses. It is stricter
/// in one place, on purpose: a value that holds anything outside ASCII is refused (the
/// contract allows Unicode white space between the parts of a value, and nothing else
/// outside ASCII).
public enum TulaThemeGrammar {
    /// No value is longer than this, in UTF-16 units, as the contract counts them.
    static let maxLength = 200

    /// What no value may contain, whatever its type.
    private static let forbidden = pattern(#"[;{}<>\\@!\n\r\f\x00]|/\*|url\(|expression\(|var\("#)
    private static let hexColor = pattern(#"\A#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})\z"#)
    private static let functionColor = pattern(
        #"\A(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(\s*[0-9a-z.%+-]+(?:\s*[\s,/]\s*[0-9a-z.%+-]+){2,4}\s*\)\z"#)
    private static let namedColor = pattern(#"\A[a-z]{3,30}\z"#)
    private static let length = pattern(
        #"\A(?:0|[+-]?(?:\d+\.?\d*|\.\d+)(?:px|rem|em|%|ch|ex|pt|vw|vh|vmin|vmax))\z"#)
    private static let fontFamily = pattern(#"\A(?:"[\w .-]+"|'[\w .-]+'|-?[a-z_][\w-]*(?: [\w-]+)*)\z"#)

    private static func pattern(_ text: String) -> NSRegularExpression {
        // The patterns are constants of this file: one that does not compile is a bug here.
        // swiftlint:disable:next force_try
        try! NSRegularExpression(pattern: text, options: [.caseInsensitive])
    }

    private static func matches(_ expression: NSRegularExpression, _ value: String) -> Bool {
        expression.firstMatch(in: value, range: NSRange(value.startIndex..., in: value)) != nil
    }

    /// The white space of ASCII, which is all the white space a value may hold here.
    static let space: Set<Character> = [" ", "\t", "\n", "\u{0B}", "\u{0C}", "\r"]

    static func trimmed(_ value: String) -> String {
        var text = Substring(value)
        while let first = text.first, space.contains(first) { text.removeFirst() }
        while let last = text.last, space.contains(last) { text.removeLast() }
        return String(text)
    }

    static func isColor(_ value: String) -> Bool {
        matches(hexColor, value) || matches(functionColor, value) || matches(namedColor, value)
    }

    static func isLength(_ value: String) -> Bool {
        matches(length, value)
    }

    /// Split on a separator wherever it is not inside parentheses; `nil` for unbalanced ones.
    static func splitOutsideParentheses(_ value: String, where separates: (Character) -> Bool) -> [String]? {
        var parts: [String] = []
        var depth = 0
        var current = ""
        for character in value {
            if character == "(" {
                depth += 1
            } else if character == ")" {
                depth -= 1
                if depth < 0 {
                    return nil
                }
            }
            if depth == 0, separates(character) {
                parts.append(current)
                current = ""
            } else {
                current.append(character)
            }
        }
        parts.append(current)
        return depth == 0 ? parts : nil
    }

    /// One shadow: an optional `inset`, two to four lengths and at most one colour.
    private static func isShadowLayer(_ layer: String) -> Bool {
        guard let split = splitOutsideParentheses(trimmed(layer), where: { space.contains($0) }) else {
            return false
        }
        let parts = split.filter { !$0.isEmpty }
        let rest = parts.filter { $0.lowercased() != "inset" }
        let lengths = rest.filter(isLength)
        let colors = rest.filter { !isLength($0) }
        return parts.count - rest.count <= 1 && lengths.count >= 2 && lengths.count <= 4 && colors.count <= 1
            && colors.allSatisfy(isColor)
    }

    /// Whether a string is a plain value of a token's type.
    ///
    /// - Parameters:
    ///   - type: The token's type.
    ///   - value: The candidate, as an app or a tenant wrote it.
    /// - Returns: `true` when the contract's grammar accepts it.
    public static func isValid(_ type: TulaThemeValueType, _ value: String) -> Bool {
        guard !value.isEmpty, value.utf16.count <= maxLength, value.unicodeScalars.allSatisfy(\.isASCII),
            !matches(forbidden, value)
        else {
            return false
        }
        let plain = trimmed(value)
        switch type {
        case .color:
            return isColor(plain)
        case .length:
            return isLength(plain)
        case .fontFamily:
            return (splitOutsideParentheses(plain, where: { $0 == "," }) ?? [""]).allSatisfy {
                matches(fontFamily, trimmed($0))
            }
        case .shadow:
            if plain.lowercased() == "none" {
                return true
            }
            guard let layers = splitOutsideParentheses(plain, where: { $0 == "," }) else {
                return false
            }
            return layers.allSatisfy(isShadowLayer)
        }
    }
}

/// A colour as the system draws it: sRGB channels and an opacity, each from 0 to 1.
public struct TulaColorValue: Hashable, Sendable {
    /// Red, 0 to 1.
    public let red: Double
    /// Green, 0 to 1.
    public let green: Double
    /// Blue, 0 to 1.
    public let blue: Double
    /// Opacity, 0 (clear) to 1 (opaque).
    public let opacity: Double

    init(red: Double, green: Double, blue: Double, opacity: Double = 1) {
        self.red = TulaColorValue.unit(red)
        self.green = TulaColorValue.unit(green)
        self.blue = TulaColorValue.unit(blue)
        self.opacity = TulaColorValue.unit(opacity)
    }

    private static func unit(_ value: Double) -> Double { min(max(value, 0), 1) }

    /// The colour of a theme value, or `nil` for one the grammar refuses or this version
    /// cannot draw.
    ///
    /// Drawn: `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`; `rgb()` and `rgba()`; `hsl()` and
    /// `hsla()`; and the keywords `transparent`, `black` and `white`. Every other form the
    /// grammar accepts (`hwb()`, `lab()`, `lch()`, `oklab()`, `oklch()`, another keyword) is
    /// `nil`: the system has no table of CSS colour names, and a guess would draw a brand
    /// in the wrong colour.
    ///
    /// - Parameter value: A theme value.
    public init?(themeValue value: String) {
        guard TulaThemeGrammar.isValid(.color, value) else {
            return nil
        }
        let plain = TulaThemeGrammar.trimmed(value).lowercased()
        if plain.hasPrefix("#") {
            guard let color = TulaColorValue.hex(String(plain.dropFirst())) else {
                return nil
            }
            self = color
            return
        }
        switch plain {
        case "transparent":
            self.init(red: 0, green: 0, blue: 0, opacity: 0)
            return
        case "black":
            self.init(red: 0, green: 0, blue: 0)
            return
        case "white":
            self.init(red: 1, green: 1, blue: 1)
            return
        default:
            break
        }
        guard let open = plain.firstIndex(of: "("), plain.hasSuffix(")") else {
            return nil
        }
        let name = plain[plain.startIndex..<open]
        let inside = plain[plain.index(after: open)..<plain.index(before: plain.endIndex)]
        let arguments = inside.split(whereSeparator: { TulaThemeGrammar.space.contains($0) || $0 == "," || $0 == "/" })
            .map(String.init)
        guard arguments.count == 3 || arguments.count == 4 else {
            return nil
        }
        let alpha = arguments.count == 4 ? TulaColorValue.alpha(arguments[3]) : 1
        guard let opacity = alpha else {
            return nil
        }
        switch name {
        case "rgb", "rgba":
            let channels = arguments.prefix(3).map(TulaColorValue.channel)
            guard let red = channels[0], let green = channels[1], let blue = channels[2] else {
                return nil
            }
            self.init(red: red, green: green, blue: blue, opacity: opacity)
        case "hsl", "hsla":
            guard
                let hue = TulaColorValue.number(arguments[0], suffixes: ["deg", ""]),
                let saturation = TulaColorValue.number(arguments[1], suffixes: ["%"]),
                let lightness = TulaColorValue.number(arguments[2], suffixes: ["%"])
            else {
                return nil
            }
            self = TulaColorValue.hsl(hue: hue, saturation: saturation / 100, lightness: lightness / 100, opacity)
        default:
            return nil
        }
    }

    private static func hex(_ digits: String) -> TulaColorValue? {
        let wide = digits.count <= 4 ? digits.map { "\($0)\($0)" }.joined() : digits
        guard wide.count == 6 || wide.count == 8, let packed = UInt64(wide, radix: 16) else {
            return nil
        }
        let all = wide.count == 6 ? (packed << 8) | 0xFF : packed
        let byte = { (shift: UInt64) in Double((all >> shift) & 0xFF) / 255 }
        return TulaColorValue(red: byte(24), green: byte(16), blue: byte(8), opacity: byte(0))
    }

    /// A plain decimal number with one of the given suffixes. No exponent, no keyword.
    private static func number(_ text: String, suffixes: [String]) -> Double? {
        for suffix in suffixes where text.hasSuffix(suffix) {
            let digits = text.dropLast(suffix.count)
            let unsigned = digits.drop(while: { $0 == "+" || $0 == "-" })
            guard
                digits.count - unsigned.count <= 1, !unsigned.isEmpty,
                unsigned.allSatisfy({ $0.isASCII && ($0.isNumber || $0 == ".") }),
                unsigned.filter({ $0 == "." }).count <= 1, unsigned != ".",
                let value = Double(digits), value.isFinite
            else {
                continue
            }
            return value
        }
        return nil
    }

    private static func channel(_ text: String) -> Double? {
        if let percent = number(text, suffixes: ["%"]) {
            return percent / 100
        }
        return number(text, suffixes: [""]).map { $0 / 255 }
    }

    private static func alpha(_ text: String) -> Double? {
        if let percent = number(text, suffixes: ["%"]) {
            return percent / 100
        }
        return number(text, suffixes: [""])
    }

    private static func hsl(hue: Double, saturation: Double, lightness: Double, _ opacity: Double) -> TulaColorValue {
        let turn = (hue.truncatingRemainder(dividingBy: 360) + 360).truncatingRemainder(dividingBy: 360) / 30
        let s = min(max(saturation, 0), 1)
        let l = min(max(lightness, 0), 1)
        let a = s * min(l, 1 - l)
        let part = { (n: Double) -> Double in
            let k = (n + turn).truncatingRemainder(dividingBy: 12)
            return l - a * max(-1, min(k - 3, 9 - k, 1))
        }
        return TulaColorValue(red: part(0), green: part(8), blue: part(4), opacity: opacity)
    }
}

/// The typeface of a theme: the system's, or a named one.
public enum TulaFontFamily: Hashable, Sendable {
    /// The system's typeface (its monospaced design for the theme's `fontFamilyMono`).
    case system
    /// A typeface by name. One the device does not have is drawn in the system's.
    case named(String)

    /// The names CSS gives the platform's own typefaces: each means "the system's" here.
    static let generic: Set<String> = [
        "ui-sans-serif", "system-ui", "-apple-system", "blinkmacsystemfont", "sans-serif", "serif", "ui-serif",
        "ui-monospace", "monospace", "ui-rounded", "cursive", "fantasy", "inherit", "initial", "unset",
    ]

    /// The typeface of a theme value: the **first** family of the list decides. A generic
    /// name is the system's typeface; anything else is asked for by name.
    ///
    /// - Parameter value: A theme value of type `fontFamily`.
    /// - Returns: `nil` for a value the grammar refuses.
    public init?(themeValue value: String) {
        guard
            TulaThemeGrammar.isValid(.fontFamily, value),
            let first = TulaThemeGrammar.trimmed(value).split(separator: ",").first
        else {
            return nil
        }
        let name = TulaThemeGrammar.trimmed(String(first)).trimmingCharacters(in: CharacterSet(charactersIn: "\"'"))
        self = TulaFontFamily.generic.contains(name.lowercased()) ? .system : .named(name)
    }
}

/// The colours of one scheme, ready to draw.
public struct TulaResolvedScheme: Hashable, Sendable {
    /// Behind a screen.
    public var background: TulaColorValue
    /// A raised part (the brand tile).
    public var surface: TulaColorValue
    /// Inside a field.
    public var input: TulaColorValue
    /// Text.
    public var text: TulaColorValue
    /// Subtitles, hints and the last line.
    public var textMuted: TulaColorValue
    /// The main button.
    public var primary: TulaColorValue
    /// The main button while it is pressed.
    public var primaryHover: TulaColorValue
    /// The main button's text.
    public var primaryText: TulaColorValue
    /// Links.
    public var link: TulaColorValue
    /// A divider.
    public var border: TulaColorValue
    /// A field's edge.
    public var borderStrong: TulaColorValue
    /// A problem's text, and the edge of a field that has one.
    public var danger: TulaColorValue
    /// Behind a screen's error.
    public var dangerSurface: TulaColorValue
    /// A status that says something worked.
    public var success: TulaColorValue
    /// The edge of the field that has the focus.
    public var focus: TulaColorValue
    /// Over a screen that is covered. Checked, and not drawn by these screens.
    public var overlay: TulaColorValue
}

/// A theme with every value checked and turned into what the system draws with.
///
/// ```swift
/// var theme = TulaTheme.defaults
/// theme.light.primary = "#0f766e"
/// theme.dark.primary = "#5eead4"
/// let resolved = TulaResolvedTheme(theme)
/// resolved.refused   // [] — or the tokens whose value was not used, e.g. ["light.primary"]
/// ```
///
/// A value that is refused (by the contract's grammar, or because this version cannot draw
/// it) is replaced by the default theme's value for that token. Nothing an app or a tenant
/// wrote reaches a view any other way.
public struct TulaResolvedTheme: Hashable, Sendable {
    /// The light scheme.
    public private(set) var light: TulaResolvedScheme
    /// The dark scheme.
    public private(set) var dark: TulaResolvedScheme
    /// Corner radius of fields and buttons, in points.
    public private(set) var radius: Double
    /// Corner radius of small parts, in points.
    public private(set) var radiusSmall: Double
    /// The typeface of everything.
    public private(set) var fontFamily: TulaFontFamily
    /// The typeface of codes.
    public private(set) var fontFamilyMono: TulaFontFamily
    /// Body text size in points, before Dynamic Type scales it.
    public private(set) var fontSize: Double
    /// Size of hints, in points, before Dynamic Type scales it.
    public private(set) var fontSizeSmall: Double
    /// Size of a title, in points, before Dynamic Type scales it.
    public private(set) var fontSizeTitle: Double
    /// The spacing unit, in points.
    public private(set) var spacing: Double
    /// The tokens whose value was refused and replaced by the default: `light.primary`,
    /// `radius`. A token's key, never the value it was given.
    public private(set) var refused: [String]

    /// The contract's default theme.
    public static let defaults = TulaResolvedTheme(.defaults)

    /// The longest length a token may be, in points. A radius or a font size beyond it is
    /// refused: nothing on a sign-in screen is that large.
    static let maxLength: Double = 200
    /// The smallest text size, in points. A smaller one is refused: it could not be read.
    static let minFontSize: Double = 11
    /// What one `rem` or `em` is, in points: a browser's default text size.
    static let pointsPerRem: Double = 16

    static var colorTokens: [(key: String, from: KeyPath<TulaThemeScheme, String>, to: WritableKeyPath<TulaResolvedScheme, TulaColorValue>)] {
        [
            ("background", \.background, \.background), ("surface", \.surface, \.surface), ("input", \.input, \.input),
            ("text", \.text, \.text), ("textMuted", \.textMuted, \.textMuted), ("primary", \.primary, \.primary),
            ("primaryHover", \.primaryHover, \.primaryHover), ("primaryText", \.primaryText, \.primaryText),
            ("link", \.link, \.link), ("border", \.border, \.border), ("borderStrong", \.borderStrong, \.borderStrong),
            ("danger", \.danger, \.danger), ("dangerSurface", \.dangerSurface, \.dangerSurface),
            ("success", \.success, \.success), ("focus", \.focus, \.focus), ("overlay", \.overlay, \.overlay),
        ]
    }

    static var lengthTokens: [(key: String, from: KeyPath<TulaTheme, String>, to: WritableKeyPath<TulaResolvedTheme, Double>, text: Bool)] {
        [
            ("radius", \.radius, \.radius, false), ("radiusSmall", \.radiusSmall, \.radiusSmall, false),
            ("fontSize", \.fontSize, \.fontSize, true), ("fontSizeSmall", \.fontSizeSmall, \.fontSizeSmall, true),
            ("fontSizeTitle", \.fontSizeTitle, \.fontSizeTitle, true), ("spacing", \.spacing, \.spacing, false),
        ]
    }

    static var fontTokens: [(key: String, from: KeyPath<TulaTheme, String>, to: WritableKeyPath<TulaResolvedTheme, TulaFontFamily>)] {
        [
            ("fontFamily", \.fontFamily, \.fontFamily), ("fontFamilyMono", \.fontFamilyMono, \.fontFamilyMono),
        ]
    }

    /// The tokens a phone's screens do not draw: there is no card to cast a shadow. They
    /// are still checked, so that `refused` names a bad one.
    static var checkedOnly: [(key: String, from: KeyPath<TulaThemeScheme, String>, type: TulaThemeValueType)] {
        [
            ("shadow", \.shadow, .shadow)
        ]
    }

    /// Check a theme and turn it into what the system draws with.
    ///
    /// - Parameter theme: A theme: the generated `TulaTheme.defaults` with the values an
    ///   app, or a tenant, changed.
    public init(_ theme: TulaTheme) {
        self = TulaResolvedTheme.base
        guard theme != TulaTheme.defaults else {
            return
        }
        refused = []
        for token in TulaResolvedTheme.colorTokens {
            for (name, scheme, target) in [
                ("light", theme.light, \TulaResolvedTheme.light), ("dark", theme.dark, \TulaResolvedTheme.dark),
            ] {
                if let color = TulaColorValue(themeValue: scheme[keyPath: token.from]) {
                    self[keyPath: target][keyPath: token.to] = color
                } else {
                    refused.append("\(name).\(token.key)")
                }
            }
        }
        for token in TulaResolvedTheme.checkedOnly {
            for (name, scheme) in [("light", theme.light), ("dark", theme.dark)]
            where !TulaThemeGrammar.isValid(token.type, scheme[keyPath: token.from]) {
                refused.append("\(name).\(token.key)")
            }
        }
        for token in TulaResolvedTheme.lengthTokens {
            if let points = TulaResolvedTheme.points(theme[keyPath: token.from], text: token.text) {
                self[keyPath: token.to] = points
            } else {
                refused.append(token.key)
            }
        }
        for token in TulaResolvedTheme.fontTokens {
            if let family = TulaFontFamily(themeValue: theme[keyPath: token.from]) {
                self[keyPath: token.to] = family
            } else {
                refused.append(token.key)
            }
        }
    }

    /// A length in points, or `nil` for one the grammar refuses or this version cannot
    /// measure.
    ///
    /// Measured: `0`, `px` and `pt` (one point each), `rem` and `em` (16 points each).
    /// Every other unit the grammar accepts (`%`, `ch`, `ex`, `vw`, `vh`, `vmin`, `vmax`) is
    /// `nil`: it is a share of something a native screen does not have. So is a negative
    /// length, one over 200 points, and a text size under 11 points.
    static func points(_ value: String, text: Bool) -> Double? {
        guard TulaThemeGrammar.isValid(.length, value) else {
            return nil
        }
        let plain = TulaThemeGrammar.trimmed(value).lowercased()
        var points: Double?
        if plain == "0" {
            points = 0
        } else {
            for (unit, scale) in [("rem", pointsPerRem), ("em", pointsPerRem), ("px", 1), ("pt", 1)]
            where plain.hasSuffix(unit) {
                points = Double(plain.dropLast(unit.count)).map { $0 * scale }
                break
            }
        }
        guard let measured = points, measured.isFinite, measured >= (text ? minFontSize : 0), measured <= maxLength
        else {
            return nil
        }
        return measured
    }

    private init(
        light: TulaResolvedScheme, dark: TulaResolvedScheme, radius: Double, radiusSmall: Double, fontSize: Double,
        fontSizeSmall: Double, fontSizeTitle: Double, spacing: Double
    ) {
        self.light = light
        self.dark = dark
        self.radius = radius
        self.radiusSmall = radiusSmall
        self.fontFamily = .system
        self.fontFamilyMono = .system
        self.fontSize = fontSize
        self.fontSizeSmall = fontSizeSmall
        self.fontSizeTitle = fontSizeTitle
        self.spacing = spacing
        self.refused = []
    }

    /// The default theme, resolved from the generated constants. Where a generated default
    /// could not be read (a change of the contract this file has not followed) the value
    /// here stands in, the token is named in `refused`, and the test "the default theme
    /// resolves whole" fails.
    private static let base: TulaResolvedTheme = {
        let generated = TulaTheme.defaults
        var unread: [String] = []
        let scheme = { (name: String, from: TulaThemeScheme, ink: TulaColorValue, paper: TulaColorValue) -> TulaResolvedScheme in
            var scheme = TulaResolvedScheme(
                background: paper, surface: paper, input: paper, text: ink, textMuted: ink, primary: ink,
                primaryHover: ink, primaryText: paper, link: ink, border: ink, borderStrong: ink, danger: ink,
                dangerSurface: paper, success: ink, focus: ink, overlay: ink)
            for token in colorTokens {
                if let color = TulaColorValue(themeValue: from[keyPath: token.from]) {
                    scheme[keyPath: token.to] = color
                } else {
                    unread.append("\(name).\(token.key)")
                }
            }
            for token in checkedOnly where !TulaThemeGrammar.isValid(token.type, from[keyPath: token.from]) {
                unread.append("\(name).\(token.key)")
            }
            return scheme
        }
        let black = TulaColorValue(red: 0, green: 0, blue: 0)
        let white = TulaColorValue(red: 1, green: 1, blue: 1)
        var theme = TulaResolvedTheme(
            light: scheme("light", generated.light, black, white),
            dark: scheme("dark", generated.dark, white, black), radius: 12,
            radiusSmall: 8, fontSize: 15, fontSizeSmall: 13, fontSizeTitle: 24, spacing: 16)
        for token in lengthTokens {
            if let points = points(generated[keyPath: token.from], text: token.text) {
                theme[keyPath: token.to] = points
            } else {
                unread.append(token.key)
            }
        }
        for token in fontTokens {
            if let family = TulaFontFamily(themeValue: generated[keyPath: token.from]) {
                theme[keyPath: token.to] = family
            } else {
                unread.append(token.key)
            }
        }
        theme.refused = unread
        return theme
    }()
}
