import SwiftUI
import TulaAuth

/// Sign-in, sign-up and password reset, as screens: one per step the server asks for.
///
/// ```swift
/// TulaAuthView(client: tula) {
///     // The client is signed in: show the app.
/// }
/// ```
///
/// The view draws what its model holds (`TulaAuthModel.content`) and decides nothing: which
/// fields, buttons and links a step has, and what each does, is the model's to say. A step
/// this version has no screen for is the "not supported" screen, never a blank one and
/// never an action on a guess.
/// Where it goes afterwards is the closure's to say; the view reads no address and opens
/// no link.
///
/// **It holds no token**, and a password or a code only while its screen is open. When the
/// view goes away (also behind a pushed screen or another tab) its flow is discarded, its
/// fields are emptied and it is back on its first screen: an answer that arrives afterwards
/// signs nobody in.
///
/// Theme it with a `TulaTheme` (checked before anything is drawn: `TulaResolvedTheme`),
/// word it with a `TulaStrings`, and replace the header, the footer, the main button's
/// style or the field's with `.tulaAuthHeader`, `.tulaAuthFooter`,
/// `.tulaAuthPrimaryButtonStyle` and `.tulaAuthFieldStyle`.
public struct TulaAuthView: View {
    @StateObject private var model: TulaAuthModel
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.tulaAuthSlots) private var slots
    @FocusState private var focused: TulaAuthField?
    @AccessibilityFocusState private var spoken: TulaAuthFocus?

    private let theme: TulaResolvedTheme

    /// - Parameters:
    ///   - client: The app's client.
    ///   - mode: The flow to open on: sign-in (the default) or sign-up.
    ///   - theme: The theme, as strings; every value is checked and a refused one is
    ///     replaced by the default (`TulaResolvedTheme`).
    ///   - strings: The strings.
    ///   - onSignedIn: Called once, when a flow completed and the client is signed in.
    public init(
        client: TulaClient,
        mode: TulaAuthMode = .signIn,
        theme: TulaTheme = .defaults,
        strings: TulaStrings = .english,
        onSignedIn: (@MainActor () -> Void)? = nil
    ) {
        self.init(
            model: TulaAuthModel(
                client: client, mode: mode, strings: strings, announce: Announcer.say, onSignedIn: onSignedIn),
            theme: TulaResolvedTheme(theme))
    }

    /// Draw a model the app made itself, with a theme it already resolved.
    ///
    /// - Parameters:
    ///   - model: The model. The view owns it from here on: it closes it when it goes away.
    ///   - theme: A resolved theme.
    public init(model: @autoclosure @escaping () -> TulaAuthModel, theme: TulaResolvedTheme = .defaults) {
        _model = StateObject(wrappedValue: model())
        self.theme = theme
    }

    private var appearance: TulaAuthAppearance {
        TulaAuthAppearance(theme: theme, colorScheme: colorScheme)
    }

    public var body: some View {
        let appearance = self.appearance
        let unit = appearance.theme.spacing
        ScrollView {
            VStack(spacing: unit * 1.5) {
                header
                titles
                messages
                form
                    .frame(maxWidth: .infinity)
                footer
            }
            .padding(.horizontal, unit * 1.5)
            .padding(.vertical, unit * 2)
            .frame(maxWidth: 480)
            .frame(maxWidth: .infinity)
        }
        // A drag down puts the keyboard away: a number pad has no key that does, and the
        // last lines of a screen are under it.
        .scrollDismissesKeyboard(.interactively)
        .background(appearance.colors.background.color.ignoresSafeArea())
        .environment(\.tulaAuthAppearance, appearance)
        .task { await model.loadConfig() }
        .onReceive(model.$focusRequests.dropFirst()) { _ in moveFocus() }
        .onDisappear { model.close() }
    }

    /// Move the keyboard's focus and VoiceOver's to where the model asked, once the screen
    /// it asked for has been drawn.
    private func moveFocus() {
        Task { @MainActor in
            let target = model.focus
            if case .field(let field) = target {
                focused = field
            } else {
                focused = nil
            }
            spoken = target
        }
    }

    // MARK: The parts every screen has

    @ViewBuilder private var header: some View {
        if let custom = slots.header {
            custom(TulaAuthHeaderContext(screen: model.screen, appName: model.appName))
        } else if let name = model.appName {
            BrandMark(appName: name)
        }
    }

    private var titles: some View {
        let words = model.content
        return VStack(spacing: appearance.theme.spacing * 0.5) {
            Text(words.title)
                .themed(.title, appearance, weight: .bold)
                .foregroundColor(appearance.colors.text.color)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
                .accessibilityFocused($spoken, equals: .title)
                .accessibilityIdentifier("tula.title")
            if let subtitle = words.subtitle {
                Text(subtitle)
                    .themed(.body, appearance)
                    .foregroundColor(appearance.colors.textMuted.color)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("tula.subtitle")
            }
        }
    }

    @ViewBuilder private var messages: some View {
        if let problem = model.formProblem {
            ProblemText(message: problem)
                .padding(appearance.theme.spacing * 0.75)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(
                    RoundedRectangle(cornerRadius: appearance.theme.radiusSmall, style: .continuous)
                        .fill(appearance.colors.dangerSurface.color)
                )
                .accessibilityIdentifier("tula.formError")
        }
        if let status = model.status {
            HStack(alignment: .firstTextBaseline, spacing: appearance.theme.spacing * 0.375) {
                Image(systemName: "checkmark.circle.fill").accessibilityHidden(true)
                Text(status).fixedSize(horizontal: false, vertical: true)
            }
            .themed(.small, appearance, weight: .medium)
            .foregroundColor(appearance.colors.success.color)
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("tula.status")
        }
    }

    @ViewBuilder private var footer: some View {
        if let custom = slots.footer {
            custom()
        } else {
            Text(model.strings.securedBy)
                .themed(.small, appearance)
                .foregroundColor(appearance.colors.textMuted.color)
        }
    }

    // MARK: The form of a screen

    /// The open screen's content, from top to bottom. What is here, and what each control
    /// does, is `TulaAuthContent`'s to say: this only draws it.
    private var form: some View {
        let content = model.content
        return VStack(spacing: appearance.theme.spacing) {
            if let identity = content.identity {
                offer(identity)
            }
            ForEach(content.fields, id: \.field) { field in
                AuthField(
                    content: field, text: text(of: field.field), errors: model.problems(of: field.field),
                    spokenLabel: model.spokenLabel(of: field), strings: model.strings, focus: $focused,
                    spoken: $spoken, revealed: model.isRevealed(field.field),
                    onReveal: { model.toggleReveal(field.field) }, onSubmit: { run(field.submit) })
            }
            if let primary = content.primary {
                self.primary(primary)
            }
            ForEach(content.links, id: \.identifier) { link in
                offer(link)
            }
        }
    }

    private func run(_ action: TulaAuthAction) {
        Task { @MainActor in await model.perform(action) }
    }

    private func text(of field: TulaAuthField) -> Binding<String> {
        Binding(get: { model.text(of: field) }, set: { model.setText($0, of: field) })
    }

    private func primary(_ offer: TulaAuthOffer) -> some View {
        Button {
            run(offer.action)
        } label: {
            HStack(spacing: appearance.theme.spacing * 0.5) {
                if model.isPending {
                    ProgressView()
                        .tint(appearance.colors.primaryText.color)
                        .accessibilityHidden(true)
                }
                Text(offer.title)
            }
            .frame(maxWidth: .infinity)
        }
        .buttonStyle(slots.primaryButton ?? AnyButtonStyle(PrimaryButtonStyle(appearance: appearance)))
        .disabled(model.isPending)
        // Pending in words, for VoiceOver: the spinner alone would say nothing.
        .accessibilityValue(model.isPending ? model.strings.loading : "")
        .accessibilityIdentifier(offer.identifier)
    }

    /// A link, under the sentence that leads to it when it has one: "New here? Create an
    /// account".
    private func offer(_ offer: TulaAuthOffer) -> some View {
        VStack(spacing: 0) {
            if let lead = offer.lead {
                Text(lead)
                    .themed(.body, appearance)
                    .foregroundColor(appearance.colors.textMuted.color)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
            LinkButton(title: offer.title, identifier: offer.identifier) { run(offer.action) }
        }
    }
}
