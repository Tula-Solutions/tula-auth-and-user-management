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
    ///   - options: What a provider sign-in needs of the app: where its page comes back to,
    ///     and Google's own sheet.
    ///   - onSignedIn: Called once, when a flow completed and the client is signed in. An
    ///     app shows what is behind the sign-in from here, and not from the session's
    ///     state: backup codes made inside a sign-in are shown before it is called.
    public init(
        client: TulaClient,
        mode: TulaAuthMode = .signIn,
        theme: TulaTheme = .defaults,
        strings: TulaStrings = .english,
        options: TulaAuthOptions = TulaAuthOptions(),
        onSignedIn: (@MainActor () -> Void)? = nil
    ) {
        self.init(
            model: TulaAuthModel(
                client: client, mode: mode, strings: strings, options: options, announce: Announcer.say,
                copy: Pasteboard.copy, onSignedIn: onSignedIn),
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

    /// The open screen, drawn from the model's content.
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

    private var messages: some View {
        MessagesView(problem: model.formProblem, status: model.status, notice: model.notice)
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
        let run: (TulaAuthAction) -> Void = { self.run($0) }
        return VStack(spacing: appearance.theme.spacing) {
            if let identity = content.identity {
                OfferView(offer: identity, run: run)
            }
            if let setup = content.setup {
                SetupView(content: setup, run: run)
            }
            ForEach(content.fields, id: \.field) { field in
                AuthField(
                    content: field, text: text(of: field.field), errors: model.problems(of: field.field),
                    spokenLabel: model.spokenLabel(of: field), strings: model.strings, focus: $focused,
                    spoken: $spoken, revealed: model.isRevealed(field.field),
                    onReveal: { model.toggleReveal(field.field) }, onSubmit: { run(field.submit) })
            }
            if let codes = content.codes {
                CodesView(content: codes, run: run)
            }
            if let primary = content.primary {
                PrimaryButton(offer: primary, isPending: model.isPending, loading: model.strings.loading, run: run)
            }
            if let divider = content.divider {
                Text(divider)
                    .themed(.small, appearance)
                    .foregroundColor(appearance.colors.textMuted.color)
            }
            // A way that is not typed: a passkey, a provider. Unavailable, in the system's
            // own way, while another action is being sent.
            ForEach(content.ways, id: \.identifier) { way in
                Button(way.title) { run(way.action) }
                    .buttonStyle(SecondaryButtonStyle(appearance: appearance))
                    .disabled(model.isPending)
                    .accessibilityIdentifier(way.identifier)
            }
            ForEach(content.links, id: \.identifier) { link in
                OfferView(offer: link, run: run)
            }
        }
    }

    private func run(_ action: TulaAuthAction) {
        Task { @MainActor in await model.perform(action) }
    }

    private func text(of field: TulaAuthField) -> Binding<String> {
        Binding(get: { model.text(of: field) }, set: { model.setText($0, of: field) })
    }
}
