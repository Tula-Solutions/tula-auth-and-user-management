import Foundation
import XCTest

// Testable, for one thing: making a `TulaError` by hand (its initialiser is the client's).
@testable import TulaAuth
@testable import TulaAuthUI

// The one table of strings, and the road a theme value takes before anything is drawn with
// it: the contract's grammar, then "can this version draw it".
@MainActor
final class StringsTests: XCTestCase {
    func testPlaceholdersAreFilledOnceAndAValueIsNeverReadAgain() {
        XCTAssertEqual(TulaStrings.format("to {appName}", ["appName": "Northline"]), "to Northline")
        XCTAssertEqual(TulaStrings.format("{a}{b}", ["a": "{b}", "b": "x"]), "{b}x", "a value with braces is text")
        XCTAssertEqual(TulaStrings.format("{missing} stays", [:]), "{missing} stays")
        XCTAssertEqual(TulaStrings.format("an open { brace", ["x": "y"]), "an open { brace")
        XCTAssertEqual(TulaStrings.format("no placeholder", ["x": "y"]), "no placeholder")
        XCTAssertEqual(TulaStrings.format("{x}", ["x": ""]), "")
    }

    func testAWaitIsSaidInWords() {
        let strings = TulaStrings.english
        XCTAssertEqual(strings.duration(42), "42s")
        XCTAssertEqual(strings.duration(41.2), "42s", "a fraction is rounded up")
        XCTAssertEqual(strings.duration(60), "1m 0s")
        XCTAssertEqual(strings.duration(252), "4m 12s")
        XCTAssertEqual(strings.duration(-5), "0s")
        XCTAssertEqual(strings.duration(.infinity), "0s")
        XCTAssertEqual(strings.duration(10_000_000), "1440m 0s", "no more than a day")
    }

    func testAnErrorIsWordedByItsCode() {
        var strings = TulaStrings.english
        let known = TulaError(code: "auth.invalid_credentials", status: 401)
        XCTAssertEqual(strings.message(for: known), "The email or password is incorrect.")

        // The client's own codes have sentences too.
        XCTAssertNotEqual(
            strings.message(for: TulaError(code: TulaClientErrorCode.networkFailed, status: 0)), strings.unknownError)

        // A code this version does not know: the fallback, whatever message came with it.
        let unknown = TulaError(code: "teapot.of_tomorrow", status: 418, message: Canary.serverText)
        XCTAssertEqual(strings.message(for: unknown), "Something went wrong. Try again.")

        strings.errors["teapot.of_tomorrow"] = "I am a teapot."
        strings.errors["auth.invalid_credentials"] = "No."
        strings.unknownError = "Fallback."
        XCTAssertEqual(strings.message(for: unknown), "I am a teapot.")
        XCTAssertEqual(strings.message(for: known), "No.")
        XCTAssertEqual(strings.message(for: TulaError(code: "other.unknown", status: 400)), "Fallback.")
    }

    func testEveryCodeOfTheContractHasASentence() {
        XCTAssertGreaterThan(TulaErrorDefinitions.all.count, 50)
        let strings = TulaStrings.english
        for definition in TulaErrorDefinitions.all {
            let code = definition.code.rawValue
            let message = strings.message(for: TulaError(code: code, status: 400))
            XCTAssertNotEqual(message, strings.unknownError, code)
            XCTAssertFalse(message.isEmpty, code)
            XCTAssertNotEqual(message, code, code)
        }
    }

    func testTheEnglishTableIsTheDefaultAndNoStringIsEmpty() {
        XCTAssertEqual(TulaStrings.english, TulaStrings())
        for child in Mirror(reflecting: TulaStrings.english).children {
            if let text = child.value as? String {
                XCTAssertFalse(text.isEmpty, child.label ?? "")
            }
        }
    }
}

final class ThemeGrammarTests: XCTestCase {
    /// The rows of the contract's own table (`packages/contract/src/theme.test.ts` holds the
    /// same grammar to them): a value on the left is a plain value of its type.
    func testWhatTheGrammarAccepts() {
        let accepted: [(TulaThemeValueType, [String])] = [
            (.color, [
                "#fff", "#FFFA", "#5b4df0", "#5b4df0cc", "rgb(0, 0, 0)", "rgba(0, 0, 0, 0.5)", "rgb(0 0 0 / 50%)",
                "hsl(210 40% 50%)", "hsla(210, 40%, 50%, 0.3)", "oklch(60% 0.2 250)", "lab(50% 40 59.5)",
                "rebeccapurple", "transparent", "  #fff  ",
            ]),
            (.length, ["0", "12px", "0.75rem", ".5em", "+2pt", "-1px", "100%", "2ch", "10vw", "1.5vmin"]),
            (.fontFamily, [
                "system-ui", "\"Source Sans 3\", sans-serif", "'Inter', -apple-system, Arial", "ui-monospace, Menlo",
            ]),
            (.shadow, [
                "none", "0 1px 2px rgba(0, 0, 0, 0.4)", "0 1px 2px #000, 0 12px 32px rgba(0, 0, 0, 0.5)",
                "inset 0 0 0 1px #fff", "0 1px 2px",
            ]),
        ]
        for (type, values) in accepted {
            for value in values {
                XCTAssertTrue(TulaThemeGrammar.isValid(type, value), "\(type): \(value)")
            }
        }
    }

    func testWhatTheGrammarRefuses() {
        let long = String(repeating: "a", count: 201)
        let refused: [(TulaThemeValueType, [String])] = [
            (.color, [
                "", " ", "#ff", "#fffff", "#gggggg", "red; background: url(x)", "url(https://evil.example/x)",
                "var(--x)", "expression(alert(1))", "#fff}", "#fff/*", "rgb(0,0)", "rgb(0,0,0,0,0,0)",
                "javascript:alert(1)", "#fff\n", "<b>", "@import", "a\\62", "#fff !important", "ab", long,
                "rgb(0, 0, 0) rgb(0, 0, 0)", "rgb((0),0,0)", "rgb(0, 0, 0", "тёмный", "#ｆｆｆ", "#fff\u{2028}",
                "#f\u{200B}ff",
            ]),
            (.length, ["", "12", "px", "1e3px", "12 px", "calc(1px + 1px)", "12px;", "1px 2px", "٣px", "auto"]),
            (.fontFamily, ["", "\"unterminated", "Inter;", "Inter, url(x)", "a,,b", "Inter (x)", "'a\"b'", "!x"]),
            (.shadow, [
                "", "1px", "0 1px 2px red blue", "0 1px 2px url(x)", "inset inset 0 0", "0 1px 2px 3px 4px 5px",
                "0 1px 2px rgba(0,0,0,0.4", "0 1px, ",
            ]),
        ]
        for (type, values) in refused {
            for value in values {
                XCTAssertFalse(TulaThemeGrammar.isValid(type, value), "\(type): \(value.debugDescription)")
            }
        }
    }

    /// The corpus the contract's own test reads (`packages/contract/src/theme-cases.json`,
    /// held to `isValidThemeValue` by `theme.test.ts`): one table, two implementations.
    func testTheGrammarGivesTheContractsVerdictForEveryValueOfTheSharedCorpus() throws {
        struct Case: Decodable {
            let type: String
            let value: String
            let valid: Bool
        }
        let file = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("packages/contract/src/theme-cases.json")
        let cases = try JSONDecoder().decode([Case].self, from: Data(contentsOf: file))
        XCTAssertGreaterThanOrEqual(cases.count, 60)

        // The corpus is ASCII (the contract's test holds it to that), which is where the two
        // grammars are meant to be equal: this one is stricter only outside ASCII. A vertical
        // tab (U+000B) is in it on purpose: around a value both take it for white space, as
        // JavaScript's `trim()` does, and inside a font family both refuse it.
        XCTAssertTrue(cases.contains { $0.value.contains("\u{0B}") && $0.valid })
        XCTAssertTrue(cases.contains { $0.value.contains("\u{0B}") && !$0.valid })
        for entry in cases {
            let type = try XCTUnwrap(TulaThemeValueType(rawValue: entry.type), entry.type)
            XCTAssertEqual(
                TulaThemeGrammar.isValid(type, entry.value), entry.valid, "\(type): \(entry.value.debugDescription)")
        }
    }

    func testTheLengthCapCountsAsTheContractDoes() {
        let family = String(repeating: "a", count: 200)
        XCTAssertTrue(TulaThemeGrammar.isValid(.fontFamily, family))
        XCTAssertFalse(TulaThemeGrammar.isValid(.fontFamily, family + "a"))
    }

    func testSplittingKeepsWhatIsInParenthesesTogether() {
        XCTAssertEqual(
            TulaThemeGrammar.splitOutsideParentheses("a, rgb(1, 2, 3), b", where: { $0 == "," }) ?? [],
            ["a", " rgb(1, 2, 3)", " b"])
        XCTAssertNil(TulaThemeGrammar.splitOutsideParentheses("a)", where: { $0 == "," }))
        XCTAssertNil(TulaThemeGrammar.splitOutsideParentheses("(a", where: { $0 == "," }))
    }

    // MARK: From a string to a colour

    private func color(_ value: String) -> [Double]? {
        TulaColorValue(themeValue: value).map { [$0.red, $0.green, $0.blue, $0.opacity].map { ($0 * 1000).rounded() / 1000 } }
    }

    func testTheColoursThisVersionDraws() {
        XCTAssertEqual(color("#fff"), [1, 1, 1, 1])
        XCTAssertEqual(color("#F008"), [1, 0, 0, 0.533])
        XCTAssertEqual(color("#0080ff"), [0, 0.502, 1, 1])
        XCTAssertEqual(color("#0080FF80"), [0, 0.502, 1, 0.502])
        XCTAssertEqual(color("rgb(255, 0, 0)"), [1, 0, 0, 1])
        XCTAssertEqual(color("RGBA(0, 0, 0, 0.65)"), [0, 0, 0, 0.65])
        XCTAssertEqual(color("rgb(100% 50% 0% / 25%)"), [1, 0.5, 0, 0.25])
        XCTAssertEqual(color("rgb(300, -5, 0)"), [1, 0, 0, 1], "a channel is kept inside 0 to 1")
        XCTAssertEqual(color("hsl(0, 100%, 50%)"), [1, 0, 0, 1])
        XCTAssertEqual(color("hsl(120deg 100% 25%)"), [0, 0.5, 0, 1])
        XCTAssertEqual(color("hsla(240, 100%, 50%, 0.5)"), [0, 0, 1, 0.5])
        XCTAssertEqual(color("hsl(-120, 100%, 50%)"), [0, 0, 1, 1])
        XCTAssertEqual(color("hsl(0, 0%, 100%)"), [1, 1, 1, 1])
        XCTAssertEqual(color("transparent"), [0, 0, 0, 0])
        XCTAssertEqual(color("Black"), [0, 0, 0, 1])
        XCTAssertEqual(color("white"), [1, 1, 1, 1])
        XCTAssertEqual(color("  #000  "), [0, 0, 0, 1])
    }

    func testAColourTheGrammarAcceptsAndThisVersionCannotDrawIsRefusedNotGuessed() {
        for value in [
            "rebeccapurple", "red", "currentcolor", "oklch(60% 0.2 250)", "lab(50% 40 59.5)", "lch(50% 30 20)",
            "hwb(120 0% 0%)", "oklab(0.5 0.1 0.1)", "rgb(a, b, c)", "rgb(1e2, 0, 0)", "rgb(1.2.3, 0, 0)",
            "rgb(0, 0, 0, x)", "hsl(1turn, 50%, 50%)", "hsl(120, 0.5, 0.5)", "rgb(., 0, 0)", "rgb(--1, 0, 0)",
        ] {
            XCTAssertTrue(TulaThemeGrammar.isValid(.color, value), "the grammar has it: \(value)")
            XCTAssertNil(TulaColorValue(themeValue: value), value)
        }
        XCTAssertNil(TulaColorValue(themeValue: "url(x)"))
    }

    // MARK: From a string to a length and a typeface

    func testTheLengthsThisVersionMeasures() {
        XCTAssertEqual(TulaResolvedTheme.points("0", text: false), 0)
        XCTAssertEqual(TulaResolvedTheme.points("12px", text: false), 12)
        XCTAssertEqual(TulaResolvedTheme.points("12PT", text: false), 12)
        XCTAssertEqual(TulaResolvedTheme.points("0.75rem", text: false), 12)
        XCTAssertEqual(TulaResolvedTheme.points("1.5em", text: true), 24)
        XCTAssertEqual(TulaResolvedTheme.points("200px", text: false), 200)
        for refused in ["50%", "10vw", "2ch", "1ex", "5vh", "1vmin", "1vmax", "-1px", "201px", "13rem", "url(x)", ""] {
            XCTAssertNil(TulaResolvedTheme.points(refused, text: false), refused)
        }
        XCTAssertNil(TulaResolvedTheme.points("10px", text: true), "text under 11 points could not be read")
        XCTAssertNil(TulaResolvedTheme.points("0", text: true))
        XCTAssertEqual(TulaResolvedTheme.points("11px", text: true), 11)
    }

    func testTheFirstFamilyDecidesTheTypeface() {
        XCTAssertEqual(TulaFontFamily(themeValue: "ui-sans-serif, system-ui, Arial"), .system)
        XCTAssertEqual(TulaFontFamily(themeValue: "-apple-system"), .system)
        XCTAssertEqual(TulaFontFamily(themeValue: "MONOSPACE"), .system)
        XCTAssertEqual(TulaFontFamily(themeValue: "\"Source Sans 3\", sans-serif"), .named("Source Sans 3"))
        XCTAssertEqual(TulaFontFamily(themeValue: "'Inter', Arial"), .named("Inter"))
        XCTAssertEqual(TulaFontFamily(themeValue: " Georgia "), .named("Georgia"))
        XCTAssertNil(TulaFontFamily(themeValue: "Inter; color: red"))
        XCTAssertNil(TulaFontFamily(themeValue: ""))
    }

    // MARK: A whole theme

    func testTheDefaultThemeResolvesWhole() {
        let theme = TulaResolvedTheme.defaults
        XCTAssertEqual(theme.refused, [], "a default of the contract this version cannot read")
        XCTAssertEqual(theme, TulaResolvedTheme(.defaults))
        // The generated constants are what is drawn, not the stand-ins of this package.
        XCTAssertEqual(theme.light.primary, TulaColorValue(themeValue: TulaTheme.defaults.light.primary))
        XCTAssertEqual(theme.dark.background, TulaColorValue(themeValue: TulaTheme.defaults.dark.background))
        XCTAssertEqual(theme.dark.overlay, TulaColorValue(themeValue: TulaTheme.defaults.dark.overlay))
        XCTAssertNotEqual(theme.light.background, theme.dark.background)
        XCTAssertEqual(theme.radius, TulaResolvedTheme.points(TulaTheme.defaults.radius, text: false))
        XCTAssertEqual(theme.fontSize, TulaResolvedTheme.points(TulaTheme.defaults.fontSize, text: true))
        XCTAssertEqual(theme.fontFamily, .system)
        XCTAssertEqual(theme.fontFamilyMono, .system)
    }

    func testEveryTokenOfTheContractIsCheckedAndNothingElse() {
        var checked: [String: String] = [:]
        for token in TulaResolvedTheme.colorTokens { checked[token.key] = "color" }
        for token in TulaResolvedTheme.checkedOnly { checked[token.key] = token.type.rawValue }
        for token in TulaResolvedTheme.lengthTokens { checked[token.key] = "length" }
        for token in TulaResolvedTheme.fontTokens { checked[token.key] = "fontFamily" }
        var contract: [String: String] = [:]
        for token in TulaThemeToken.all { contract[token.key] = token.type }
        XCTAssertEqual(checked, contract)
        XCTAssertEqual(Set(TulaThemeValueType.allCases.map(\.rawValue)), Set(contract.values))
    }

    func testAnAppsValuesAreUsed() {
        var theme = TulaTheme.defaults
        theme.light.primary = "#0f766e"
        theme.dark.primary = "rgb(94, 234, 212)"
        theme.radius = "6px"
        theme.fontSize = "1.125rem"
        theme.fontFamily = "\"Source Sans 3\", sans-serif"
        theme.light.shadow = "none"
        let resolved = TulaResolvedTheme(theme)
        XCTAssertEqual(resolved.refused, [])
        XCTAssertEqual(resolved.light.primary, TulaColorValue(themeValue: "#0f766e"))
        XCTAssertEqual(resolved.dark.primary, TulaColorValue(themeValue: "#5eead4"))
        XCTAssertEqual(resolved.radius, 6)
        XCTAssertEqual(resolved.fontSize, 18)
        XCTAssertEqual(resolved.fontFamily, .named("Source Sans 3"))
        // What was not changed is the default.
        XCTAssertEqual(resolved.light.text, TulaResolvedTheme.defaults.light.text)
        XCTAssertEqual(resolved.spacing, TulaResolvedTheme.defaults.spacing)
    }

    func testARefusedValueIsReplacedByTheDefaultAndNamedByItsTokenNeverItsValue() {
        let canary = "url(https://evil.example/CANARY)"
        var theme = TulaTheme.defaults
        theme.light.primary = canary
        theme.dark.text = "rebeccapurple"
        theme.dark.shadow = "0 0 0 url(CANARY)"
        theme.radius = "50%"
        theme.fontSizeSmall = "4px"
        theme.spacing = "9999px"
        theme.fontFamilyMono = "x; CANARY"
        let resolved = TulaResolvedTheme(theme)
        XCTAssertEqual(
            Set(resolved.refused),
            ["light.primary", "dark.text", "dark.shadow", "radius", "fontSizeSmall", "spacing", "fontFamilyMono"])
        XCTAssertEqual(resolved.refused.count, 7)

        var defaults = TulaResolvedTheme.defaults
        XCTAssertEqual(resolved.light, defaults.light)
        XCTAssertEqual(resolved.dark, defaults.dark)
        XCTAssertEqual(resolved.radius, defaults.radius)
        XCTAssertEqual(resolved.fontSizeSmall, defaults.fontSizeSmall)
        XCTAssertEqual(resolved.spacing, defaults.spacing)
        XCTAssertEqual(resolved.fontFamilyMono, defaults.fontFamilyMono)
        defaults = resolved
        XCTAssertFalse(String(reflecting: defaults).contains("CANARY"), "nothing of a refused value is kept")
    }

    func testTheAppearanceIsTheSchemeTheSystemIsIn() {
        let theme = TulaResolvedTheme.defaults
        XCTAssertEqual(TulaAuthAppearance(theme: theme, colorScheme: .light).colors, theme.light)
        XCTAssertEqual(TulaAuthAppearance(theme: theme, colorScheme: .dark).colors, theme.dark)
        XCTAssertEqual(TulaAuthAppearance().colors, theme.light)
    }
}
