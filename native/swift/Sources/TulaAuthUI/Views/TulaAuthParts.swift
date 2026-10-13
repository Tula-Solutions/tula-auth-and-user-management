import SwiftUI
import TulaAuth

#if canImport(UIKit)
import UIKit
import UniformTypeIdentifiers
#elseif canImport(AppKit)
import AppKit
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
    /// What VoiceOver reads where the words alone do not say what the link acts on.
    var spoken: String?
    /// Whether it removes or ends something: the danger colour, beside words that say so.
    var destructive = false
    let action: () -> Void
    @Environment(\.tulaAuthAppearance) private var appearance

    var body: some View {
        Button(action: action) {
            Text(title)
                .themed(.body, appearance, weight: .medium)
                .underline()
                .foregroundColor((destructive ? appearance.colors.danger : appearance.colors.link).color)
                .multilineTextAlignment(.center)
                .frame(minHeight: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(spoken ?? title)
        .accessibilityIdentifier(identifier)
    }
}

/// A button that is not the screen's main one: a way to sign in, an action of a section.
struct SecondaryButtonStyle: ButtonStyle {
    let appearance: TulaAuthAppearance

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .themed(.body, appearance, weight: .semibold)
            .foregroundColor(appearance.colors.text.color)
            .padding(.vertical, appearance.theme.spacing * 0.75)
            .padding(.horizontal, appearance.theme.spacing)
            .frame(maxWidth: .infinity, minHeight: 44)
            .background(
                RoundedRectangle(cornerRadius: appearance.theme.radius, style: .continuous)
                    .fill(appearance.colors.input.color)
            )
            .overlay(
                RoundedRectangle(cornerRadius: appearance.theme.radius, style: .continuous)
                    .strokeBorder(appearance.colors.borderStrong.color, lineWidth: configuration.isPressed ? 2 : 1)
            )
            .contentShape(Rectangle())
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
                .themed(configuration.field == .code || configuration.field == .backupCode ? .code : .body, appearance)
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

/// One field of a screen: the system's text field, labelled, bound to the focus, drawn by
/// the field style. What it is, what is wrong with it and what VoiceOver reads for it are
/// the model's: nothing is composed here.
struct AuthField<Action: Hashable & Sendable>: View {
    let content: TulaFieldContent<Action>
    @Binding var text: String
    /// What is wrong with the field, each already worded as a problem.
    let errors: [String]
    /// What VoiceOver reads for the field.
    let spokenLabel: String
    let strings: TulaStrings
    let focus: FocusState<TulaAuthField?>.Binding
    let spoken: AccessibilityFocusState<TulaAuthFocus?>.Binding
    /// Whether a secret field's text is drawn in the clear. The model's, never a state of
    /// this view: a view's own copy would outlive the screen it was set on.
    let revealed: Bool
    /// "Show password" or "hide password" was pressed.
    let onReveal: () -> Void
    let onSubmit: () -> Void

    @Environment(\.tulaAuthAppearance) private var appearance
    @Environment(\.tulaAuthSlots) private var slots

    private var field: TulaAuthField { content.field }
    private var secret: Bool { content.kind == .password || content.kind == .newPassword }

    var body: some View {
        let configuration = TulaAuthFieldConfiguration(
            field: field, label: content.label, input: AnyView(input), hint: content.hint, errors: errors,
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
            .modifier(Typing(kind: content.kind))
            // The text field itself is the whole height of its box: what is tapped, and
            // what the system measures as the field, is at least 44 points high.
            .frame(maxWidth: .infinity, minHeight: 44)
            .contentShape(Rectangle())
            .submitLabel(.go)
            .onSubmit(onSubmit)
            .focused(focus, equals: field)
            .accessibilityLabel(spokenLabel)
            .accessibilityHint(content.hint ?? "")
            .accessibilityFocused(spoken, equals: .field(field))
            .accessibilityIdentifier("tula.field.\(field)")
            if secret {
                Button {
                    onReveal()
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
    let kind: TulaAuthFieldKind

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
        case .identifier:
            // An address or a number: the keyboard that has both an "@" and digits.
            content.keyboardType(.emailAddress).textContentType(.username).textInputAutocapitalization(.never)
                .autocorrectionDisabled()
        case .backupCode:
            content.textInputAutocapitalization(.never).autocorrectionDisabled()
        case .phoneNumber:
            content.keyboardType(.phonePad).textContentType(.telephoneNumber).autocorrectionDisabled()
        case .name:
            content.autocorrectionDisabled()
        }
        #else
        content.autocorrectionDisabled()
        #endif
    }
}

// MARK: Messages

/// What a screen says above its form: what went wrong, what went right, and what is
/// neither (a sheet that was closed). Each in words, with a mark, never by colour alone.
struct MessagesView: View {
    let problem: String?
    let status: String?
    let notice: String?
    @Environment(\.tulaAuthAppearance) private var appearance

    var body: some View {
        if let problem {
            ProblemText(message: problem)
                .padding(appearance.theme.spacing * 0.75)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(
                    RoundedRectangle(cornerRadius: appearance.theme.radiusSmall, style: .continuous)
                        .fill(appearance.colors.dangerSurface.color)
                )
                .accessibilityIdentifier("tula.formError")
        }
        if let status {
            line(status, mark: "checkmark.circle.fill", colour: appearance.colors.success)
                .accessibilityIdentifier("tula.status")
        }
        if let notice {
            // Quiet: the muted text colour, not the danger one and not the success one.
            line(notice, mark: "info.circle", colour: appearance.colors.textMuted)
                .accessibilityIdentifier("tula.notice")
        }
    }

    private func line(_ words: String, mark: String, colour: TulaColorValue) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: appearance.theme.spacing * 0.375) {
            Image(systemName: mark).accessibilityHidden(true)
            Text(words).fixedSize(horizontal: false, vertical: true)
        }
        .themed(.small, appearance, weight: .medium)
        .foregroundColor(colour.color)
        .accessibilityElement(children: .combine)
    }
}

// MARK: An authenticator app's setup, and backup codes

/// The QR code of a setup key, the key in words and the button that copies it. The image
/// is made in memory when it is drawn and is kept nowhere.
struct SetupView<Action: Hashable & Sendable>: View {
    let content: TulaSetupContent<Action>
    let run: (Action) -> Void
    @Environment(\.tulaAuthAppearance) private var appearance

    var body: some View {
        VStack(spacing: appearance.theme.spacing) {
            if let image = TulaQRCode.image(for: content.uri) {
                Image(decorative: image, scale: 1)
                    .interpolation(.none)
                    .resizable()
                    .aspectRatio(1, contentMode: .fit)
                    .frame(maxWidth: 200)
                    // A QR code is dark on light whatever the scheme: a reader needs it so.
                    .padding(appearance.theme.spacing)
                    .background(Color.white)
                    .accessibilityElement()
                    .accessibilityLabel(content.qrLabel)
                    .accessibilityAddTraits(.isImage)
                    .accessibilityIdentifier("tula.qr")
            }
            VStack(spacing: appearance.theme.spacing * 0.375) {
                Text(content.keyLabel)
                    .themed(.small, appearance, weight: .semibold)
                    .foregroundColor(appearance.colors.text.color)
                Text(content.key)
                    .themed(.code, appearance)
                    .foregroundColor(appearance.colors.text.color)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("tula.setupKey")
                Text(content.keyHint)
                    .themed(.small, appearance)
                    .foregroundColor(appearance.colors.textMuted.color)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
            LinkButton(title: content.copy.title, identifier: content.copy.identifier) { run(content.copy.action) }
        }
    }
}

/// Backup codes as a list, with the button that copies them.
struct CodesView<Action: Hashable & Sendable>: View {
    let content: TulaCodesContent<Action>
    let run: (Action) -> Void
    @Environment(\.tulaAuthAppearance) private var appearance

    var body: some View {
        VStack(spacing: appearance.theme.spacing * 0.5) {
            VStack(spacing: appearance.theme.spacing * 0.25) {
                ForEach(content.codes, id: \.self) { code in
                    Text(code)
                        .themed(.code, appearance)
                        .foregroundColor(appearance.colors.text.color)
                }
            }
            .frame(maxWidth: .infinity)
            .padding(appearance.theme.spacing)
            .background(
                RoundedRectangle(cornerRadius: appearance.theme.radius, style: .continuous)
                    .fill(appearance.colors.input.color)
            )
            .accessibilityElement(children: .contain)
            .accessibilityLabel(content.label)
            .accessibilityIdentifier("tula.codes")
            LinkButton(title: content.copy.title, identifier: content.copy.identifier) { run(content.copy.action) }
        }
    }
}

/// A link, under the sentence that leads to it when it has one: "New here? Create an
/// account".
struct OfferView<Action: Hashable & Sendable>: View {
    let offer: TulaOffer<Action>
    let run: (Action) -> Void
    @Environment(\.tulaAuthAppearance) private var appearance

    var body: some View {
        VStack(spacing: 0) {
            if let lead = offer.lead {
                Text(lead)
                    .themed(.body, appearance)
                    .foregroundColor(appearance.colors.textMuted.color)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
            LinkButton(
                title: offer.title, identifier: offer.identifier, spoken: offer.spoken, destructive: offer.destructive
            ) { run(offer.action) }
        }
    }
}

/// A screen's main button: its words, and "loading" in words while its action is sent.
struct PrimaryButton<Action: Hashable & Sendable>: View {
    let offer: TulaOffer<Action>
    let isPending: Bool
    let loading: String
    let run: (Action) -> Void
    @Environment(\.tulaAuthAppearance) private var appearance
    @Environment(\.tulaAuthSlots) private var slots

    var body: some View {
        Button {
            run(offer.action)
        } label: {
            HStack(spacing: appearance.theme.spacing * 0.5) {
                if isPending {
                    ProgressView()
                        .tint(appearance.colors.primaryText.color)
                        .accessibilityHidden(true)
                }
                Text(offer.title)
            }
            .frame(maxWidth: .infinity)
        }
        .buttonStyle(slots.primaryButton ?? AnyButtonStyle(PrimaryButtonStyle(appearance: appearance)))
        .disabled(isPending)
        // Pending in words, for VoiceOver: the spinner alone would say nothing.
        .accessibilityValue(isPending ? loading : "")
        .accessibilityIdentifier(offer.identifier)
    }
}

// MARK: The pasteboard

/// Puts text on the pasteboard. Called only from a button a person pressed.
///
/// What is copied is a setup key or backup codes, so it is written as `TulaCopyRule` says:
/// for this device only, and with a time after which the system takes it back. No test
/// writes a pasteboard: the rule is tested, this call is not.
enum Pasteboard {
    @MainActor
    static func copy(_ text: String) {
        #if canImport(UIKit)
        UIPasteboard.general.setItems(
            [[UTType.plainText.identifier: text]],
            options: [
                .localOnly: TulaCopyRule.localOnly,
                .expirationDate: TulaCopyRule.expiry(from: Date()),
            ])
        #elseif canImport(AppKit)
        // AppKit has no expiry for a pasteboard's contents: only "this Mac" is asked for.
        NSPasteboard.general.prepareForNewContents(with: TulaCopyRule.localOnly ? .currentHostOnly : [])
        NSPasteboard.general.setString(text, forType: .string)
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
