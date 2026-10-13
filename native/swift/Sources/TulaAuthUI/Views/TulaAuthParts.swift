import SwiftUI
import TulaAuth

#if canImport(UIKit)
import UIKit
#endif

// The parts the screens are made of: the colours and type of a resolved theme, the field,
// the buttons, and the four parts an app can replace (ADR 0057, "Slots").

// MARK: Theme

extension TulaColorValue {
    /// The colour, for SwiftUI.
    public var color: Color {
        Color(.sRGB, red: red, green: green, blue: blue, opacity: opacity)
    }
}

/// The theme a screen is drawn with: the resolved theme and the scheme the system is in.
///
/// A slot reads it from the environment (`@Environment(\.tulaAuthAppearance)`) to draw in
/// the same colours as the parts around it.
public struct TulaAuthAppearance: Sendable {
    /// The resolved theme.
    public let theme: TulaResolvedTheme
    /// The colours of the scheme the system is in.
    public let colors: TulaResolvedScheme

    /// - Parameters:
    ///   - theme: A resolved theme.
    ///   - colorScheme: The system's scheme.
    public init(theme: TulaResolvedTheme = .defaults, colorScheme: ColorScheme = .light) {
        self.theme = theme
        self.colors = colorScheme == .dark ? theme.dark : theme.light
    }
}

private struct AppearanceKey: EnvironmentKey {
    static var defaultValue: TulaAuthAppearance { TulaAuthAppearance() }
}

extension EnvironmentValues {
    /// The theme the Tula screens are drawn with.
    public var tulaAuthAppearance: TulaAuthAppearance {
        get { self[AppearanceKey.self] }
        set { self[AppearanceKey.self] = newValue }
    }
}

/// The text sizes of a theme.
enum TextRole {
    case title, body, small, code

    var style: Font.TextStyle {
        switch self {
        case .title: return .title
        case .body, .code: return .body
        case .small: return .footnote
        }
    }
}

/// Draws text in the theme's typeface, at the theme's size scaled by Dynamic Type.
struct ThemedFont: ViewModifier {
    @ScaledMetric private var size: CGFloat
    private let family: TulaFontFamily
    private let weight: Font.Weight
    private let monospaced: Bool

    init(_ role: TextRole, theme: TulaResolvedTheme, weight: Font.Weight) {
        let points: Double
        switch role {
        case .title: points = theme.fontSizeTitle
        case .body, .code: points = theme.fontSize
        case .small: points = theme.fontSizeSmall
        }
        _size = ScaledMetric(wrappedValue: CGFloat(points), relativeTo: role.style)
        family = role == .code ? theme.fontFamilyMono : theme.fontFamily
        monospaced = role == .code
        self.weight = weight
    }

    func body(content: Content) -> some View {
        switch family {
        case .system:
            content.font(.system(size: size, weight: weight, design: monospaced ? .monospaced : .default))
        case .named(let name):
            content.font(.custom(name, fixedSize: size).weight(weight))
        }
    }
}

extension View {
    func themed(_ role: TextRole, _ appearance: TulaAuthAppearance, weight: Font.Weight = .regular) -> some View {
        modifier(ThemedFont(role, theme: appearance.theme, weight: weight))
    }
}

// MARK: Slots

/// What a header slot is told.
public struct TulaAuthHeaderContext: Sendable {
    /// The screen being drawn.
    public let screen: TulaAuthScreen
    /// The environment's app name, once it is known.
    public let appName: String?
}

/// What a field style draws: the label, the input, the hint and the problems of one field.
///
/// `input` is the text field itself, already labelled for VoiceOver (with its problems,
/// when it has any) and bound to the focus: a style places it and draws around it, and
/// cannot take its label away.
public struct TulaAuthFieldConfiguration {
    /// The field.
    public let field: TulaAuthField
    /// The field's label.
    public let label: String
    /// The text field, ready to place.
    public let input: AnyView
    /// A hint for the field, when it has one.
    public let hint: String?
    /// What is wrong with the field, each already worded as a problem ("Error: …").
    public let errors: [String]
    /// Whether the field has the keyboard's focus.
    public let isFocused: Bool
}

/// How a field is drawn. An app that wants its own text fields conforms a type and hands
/// it over with `.tulaAuthFieldStyle(_:)`.
///
/// ```swift
/// struct Underlined: TulaAuthFieldStyle {
///     func makeBody(configuration: TulaAuthFieldConfiguration) -> some View {
///         VStack(alignment: .leading) {
///             Text(configuration.label).font(.caption)
///             configuration.input
///             Divider()
///             ForEach(configuration.errors, id: \.self) { Text($0).foregroundColor(.red) }
///         }
///     }
/// }
/// ```
///
/// A style draws every entry of `errors` as text: a problem must be said in words, not only
/// by a colour.
@MainActor
public protocol TulaAuthFieldStyle {
    /// The view of a field.
    associatedtype Body: View
    /// Draw one field.
    @ViewBuilder func makeBody(configuration: TulaAuthFieldConfiguration) -> Body
}

/// The parts of a screen an app replaced. Empty by default.
struct TulaAuthSlots {
    var header: ((TulaAuthHeaderContext) -> AnyView)?
    var footer: (() -> AnyView)?
    var primaryButton: AnyButtonStyle?
    var field: ((TulaAuthFieldConfiguration) -> AnyView)?
}

private struct SlotsKey: EnvironmentKey {
    static var defaultValue: TulaAuthSlots { TulaAuthSlots() }
}

extension EnvironmentValues {
    var tulaAuthSlots: TulaAuthSlots {
        get { self[SlotsKey.self] }
        set { self[SlotsKey.self] = newValue }
    }
}

/// A button style behind one type, so that the environment can hold any.
struct AnyButtonStyle: ButtonStyle {
    private let make: (Configuration) -> AnyView

    init<Style: ButtonStyle>(_ style: Style) {
        make = { AnyView(style.makeBody(configuration: $0)) }
    }

    func makeBody(configuration: Configuration) -> some View {
        make(configuration)
    }
}

extension View {
    /// Replace what is drawn above a screen's title (by default the app's initial on the
    /// brand colour, once the app's name is known).
    ///
    /// - Parameter header: The view, given the screen and the app's name.
    public func tulaAuthHeader<Header: View>(
        @ViewBuilder _ header: @escaping (TulaAuthHeaderContext) -> Header
    ) -> some View {
        transformEnvironment(\.tulaAuthSlots) { $0.header = { AnyView(header($0)) } }
    }

    /// Replace the last line of every screen (by default "Secured by Tula").
    public func tulaAuthFooter<Footer: View>(@ViewBuilder _ footer: @escaping () -> Footer) -> some View {
        transformEnvironment(\.tulaAuthSlots) { $0.footer = { AnyView(footer()) } }
    }

    /// Replace the style of every screen's main button. The label a style is given
    /// already says, in words, when the action is being sent.
    public func tulaAuthPrimaryButtonStyle<Style: ButtonStyle>(_ style: Style) -> some View {
        transformEnvironment(\.tulaAuthSlots) { $0.primaryButton = AnyButtonStyle(style) }
    }

    /// Replace how every field is drawn.
    public func tulaAuthFieldStyle<Style: TulaAuthFieldStyle>(_ style: Style) -> some View {
        transformEnvironment(\.tulaAuthSlots) { $0.field = { AnyView(style.makeBody(configuration: $0)) } }
    }
}

// MARK: The default parts

/// The app's initial on the brand colour: what the design draws above the title.
struct BrandMark: View {
    let appName: String
    @Environment(\.tulaAuthAppearance) private var appearance

    var body: some View {
        Text(String(appName.prefix(1)).uppercased())
            .themed(.title, appearance, weight: .bold)
            .foregroundColor(appearance.colors.primaryText.color)
            .frame(minWidth: 56, minHeight: 56)
            .background(
                RoundedRectangle(cornerRadius: appearance.theme.radius, style: .continuous)
                    .fill(appearance.colors.primary.color)
            )
            // Decoration: the app's name is in the subtitle, in words.
            .accessibilityHidden(true)
    }
}

/// The main button's look: the brand colour, full width, at least 44 points high.
struct PrimaryButtonStyle: ButtonStyle {
    let appearance: TulaAuthAppearance

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .themed(.body, appearance, weight: .semibold)
            .foregroundColor(appearance.colors.primaryText.color)
            .padding(.vertical, appearance.theme.spacing * 0.75)
            .padding(.horizontal, appearance.theme.spacing)
            .frame(maxWidth: .infinity, minHeight: 44)
            .background(
                RoundedRectangle(cornerRadius: appearance.theme.radius, style: .continuous)
                    .fill((configuration.isPressed ? appearance.colors.primaryHover : appearance.colors.primary).color)
            )
            .contentShape(Rectangle())
    }
}

/// A text button: "Forgot password?", "Resend code".
struct LinkButton: View {
    let title: String
    let identifier: String
    let action: () -> Void
    @Environment(\.tulaAuthAppearance) private var appearance

    var body: some View {
        Button(action: action) {
            Text(title)
                .themed(.body, appearance, weight: .medium)
                .underline()
                .foregroundColor(appearance.colors.link.color)
                .multilineTextAlignment(.center)
                .frame(minHeight: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier(identifier)
    }
}

/// The field as the package draws it: the label above, an edged box, the hint and the
/// problems below.
struct DefaultFieldStyle: TulaAuthFieldStyle {
    let appearance: TulaAuthAppearance

    func makeBody(configuration: TulaAuthFieldConfiguration) -> some View {
        let colors = appearance.colors
        let invalid = !configuration.errors.isEmpty
        let edge = invalid ? colors.danger : (configuration.isFocused ? colors.focus : colors.borderStrong)
        VStack(alignment: .leading, spacing: appearance.theme.spacing * 0.375) {
            Text(configuration.label)
                .themed(.small, appearance, weight: .semibold)
                .foregroundColor(colors.text.color)
                // The input carries the label for VoiceOver; read twice it is noise.
                .accessibilityHidden(true)
            configuration.input
                .themed(configuration.field == .code ? .code : .body, appearance)
                .foregroundColor(colors.text.color)
                .padding(.horizontal, appearance.theme.spacing * 0.75)
                .frame(minHeight: 44)
                .background(
                    RoundedRectangle(cornerRadius: appearance.theme.radius, style: .continuous)
                        .fill(colors.input.color)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: appearance.theme.radius, style: .continuous)
                        .strokeBorder(edge.color, lineWidth: invalid || configuration.isFocused ? 2 : 1)
                )
            if let hint = configuration.hint {
                Text(hint)
                    .themed(.small, appearance)
                    .foregroundColor(colors.textMuted.color)
                    .fixedSize(horizontal: false, vertical: true)
            }
            ForEach(configuration.errors, id: \.self) { message in
                ProblemText(message: message)
            }
        }
    }
}

/// A problem, in words, with a mark beside it: never by its colour alone.
struct ProblemText: View {
    let message: String
    @Environment(\.tulaAuthAppearance) private var appearance

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: appearance.theme.spacing * 0.375) {
            Image(systemName: "exclamationmark.circle.fill")
                .accessibilityHidden(true)
            Text(message)
                .fixedSize(horizontal: false, vertical: true)
        }
        .themed(.small, appearance, weight: .medium)
        .foregroundColor(appearance.colors.danger.color)
        .accessibilityElement(children: .combine)
    }
}

// MARK: The field

/// What a field asks of the keyboard and of the system's autofill.
enum FieldKind {
    case email, password, newPassword, code
}

/// One field of a screen: the system's text field, labelled, bound to the focus, with its
/// problems in its label for VoiceOver, drawn by the field style.
struct AuthField: View {
    let field: TulaAuthField
    let kind: FieldKind
    let label: String
    var hint: String?
    @Binding var text: String
    let errors: [String]
    let strings: TulaStrings
    let focus: FocusState<TulaAuthField?>.Binding
    let spoken: AccessibilityFocusState<TulaAuthFocus?>.Binding
    let onSubmit: () -> Void

    @State private var revealed = false
    @Environment(\.tulaAuthAppearance) private var appearance
    @Environment(\.tulaAuthSlots) private var slots

    private var secret: Bool { kind == .password || kind == .newPassword }

    /// What VoiceOver reads for the field: its label, and its problems when it has any.
    private var spokenLabel: String {
        errors.isEmpty
            ? label
            : TulaStrings.format(strings.fieldInvalid, ["label": label, "message": errors.joined(separator: " ")])
    }

    var body: some View {
        let configuration = TulaAuthFieldConfiguration(
            field: field, label: label, input: AnyView(input), hint: hint,
            errors: errors.map { TulaStrings.format(strings.errorPrefix, ["message": $0]) },
            isFocused: focus.wrappedValue == field)
        if let custom = slots.field {
            custom(configuration)
        } else {
            DefaultFieldStyle(appearance: appearance).makeBody(configuration: configuration)
        }
    }

    private var input: some View {
        HStack(spacing: appearance.theme.spacing * 0.5) {
            Group {
                if secret && !revealed {
                    SecureField("", text: $text)
                } else {
                    TextField("", text: $text)
                }
            }
            .modifier(Typing(kind: kind))
            // The text field itself is the whole height of its box: what is tapped, and
            // what the system measures as the field, is at least 44 points high.
            .frame(maxWidth: .infinity, minHeight: 44)
            .contentShape(Rectangle())
            .submitLabel(.go)
            .onSubmit(onSubmit)
            .focused(focus, equals: field)
            .accessibilityLabel(spokenLabel)
            .accessibilityHint(hint ?? "")
            .accessibilityFocused(spoken, equals: .field(field))
            .accessibilityIdentifier("tula.field.\(field)")
            if secret {
                Button {
                    revealed.toggle()
                } label: {
                    Image(systemName: revealed ? "eye.slash" : "eye")
                        .foregroundColor(appearance.colors.textMuted.color)
                        .frame(minWidth: 44, minHeight: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(revealed ? strings.hidePassword : strings.showPassword)
                .accessibilityIdentifier("tula.reveal.\(field)")
            }
        }
    }
}

/// The keyboard, the capitalisation and the autofill of a kind of field.
private struct Typing: ViewModifier {
    let kind: FieldKind

    func body(content: Content) -> some View {
        #if os(iOS)
        switch kind {
        case .email:
            content.keyboardType(.emailAddress).textContentType(.username).textInputAutocapitalization(.never)
                .autocorrectionDisabled()
        case .password:
            content.textContentType(.password).textInputAutocapitalization(.never).autocorrectionDisabled()
        case .newPassword:
            content.textContentType(.newPassword).textInputAutocapitalization(.never).autocorrectionDisabled()
        case .code:
            content.keyboardType(.numberPad).textContentType(.oneTimeCode).autocorrectionDisabled()
        }
        #else
        content.autocorrectionDisabled()
        #endif
    }
}

// MARK: VoiceOver

/// Says a message to VoiceOver.
enum Announcer {
    @MainActor
    static func say(_ message: String) {
        #if canImport(UIKit)
        UIAccessibility.post(notification: .announcement, argument: message)
        #endif
    }
}
