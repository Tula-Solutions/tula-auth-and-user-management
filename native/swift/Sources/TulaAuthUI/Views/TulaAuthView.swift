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
/// The view draws the server's step and decides nothing: a step this version has no screen
/// for is the "not supported" screen, never a blank one and never an action on a guess.
/// Where it goes afterwards is the closure's to say; the view reads no address and opens
/// no link.
///
/// **It holds no token**, and a password or a code only while its screen is open. When the
/// view goes away its flow is discarded and its fields are emptied: an answer that arrives
/// afterwards signs nobody in.
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
        let words = self.words
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
        if let problem = model.formError {
            ProblemText(message: TulaStrings.format(model.strings.errorPrefix, ["message": problem]))
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

    // MARK: The words of a screen

    private var words: (title: String, subtitle: String?) {
        let t = model.strings
        switch model.screen {
        case .signInStart:
            return (
                t.signInTitle,
                model.appName.map { TulaStrings.format(t.signInSubtitle, ["appName": $0]) } ?? t.signInSubtitleNoApp
            )
        case .signUpStart:
            return (t.signUpTitle, t.signUpSubtitle)
        case .resetStart:
            return (t.resetTitle, t.resetSubtitle)
        case .password:
            return (t.passwordTitle, nil)
        case .emailCodeOffer:
            return (t.emailCodeTitle, t.emailCodePrompt)
        case .emailCode(let destination, _):
            return (t.emailCodeTitle, TulaStrings.format(t.emailCodeSubtitle, ["destination": destination]))
        case .emailVerification(let destination):
            return (t.verificationTitle, TulaStrings.format(t.verificationSubtitle, ["destination": destination]))
        case .newPassword(let destination):
            return (t.newPasswordTitle, TulaStrings.format(t.newPasswordSubtitle, ["destination": destination]))
        case .expiredPassword:
            return (t.expiredPasswordTitle, t.expiredPasswordSubtitle)
        case .signedIn:
            return (t.signedIn, nil)
        case .notSupported:
            return (t.notSupportedTitle, t.notSupportedMessage)
        }
    }

    // MARK: The form of a screen

    @ViewBuilder private var form: some View {
        let t = model.strings
        let unit = appearance.theme.spacing
        VStack(spacing: unit) {
            switch model.screen {
            case .signInStart:
                field(.email, .email, t.emailLabel, $model.email) { await model.start() }
                primary(t.continueButton) { await model.start() }
                switcher(t.noAccount, t.signUpLink, "tula.link.signUp") { model.showSignUp() }
            case .signUpStart:
                field(.email, .email, t.emailLabel, $model.email) { await model.start() }
                field(
                    .password, .newPassword, model.passwordOptional ? t.passwordOptionalLabel : t.passwordLabel,
                    $model.password, hint: model.passwordOptional ? t.passwordOptionalHint : nil
                ) { await model.start() }
                primary(t.continueButton) { await model.start() }
                switcher(t.haveAccount, t.signInLink, "tula.link.signIn") { model.showSignIn() }
            case .resetStart:
                field(.email, .email, t.emailLabel, $model.email) { await model.start() }
                primary(t.sendCode) { await model.start() }
                LinkButton(title: t.backToSignIn, identifier: "tula.link.signIn") { model.showSignIn() }
            case .password(let canEmailCode):
                identity
                field(.password, .password, t.passwordLabel, $model.password) { await model.submitPassword() }
                primary(t.signInSubmit) { await model.submitPassword() }
                if canEmailCode {
                    LinkButton(title: t.emailCode, identifier: "tula.link.emailCode") {
                        run { await model.sendEmailCode() }
                    }
                }
                LinkButton(title: t.forgotPassword, identifier: "tula.link.reset") { model.showReset() }
            case .emailCodeOffer:
                identity
                primary(t.emailCode) { await model.sendEmailCode() }
            case .emailCode(_, let canUsePassword):
                identity
                codeField { await model.submitCode() }
                primary(t.signInSubmit) { await model.submitCode() }
                LinkButton(title: t.emailResend, identifier: "tula.link.resend") { run { await model.resendCode() } }
                if canUsePassword {
                    LinkButton(title: t.usePassword, identifier: "tula.link.password") { model.usePassword() }
                }
            case .emailVerification:
                codeField { await model.submitCode() }
                primary(t.verifySubmit) { await model.submitCode() }
                LinkButton(title: t.resend, identifier: "tula.link.resend") { run { await model.resendCode() } }
                LinkButton(title: t.back, identifier: "tula.link.back") { model.startAgain() }
            case .newPassword:
                codeField { await model.submitNewPassword() }
                field(.newPassword, .newPassword, t.newPasswordLabel, $model.newPassword) {
                    await model.submitNewPassword()
                }
                primary(t.resetSubmit) { await model.submitNewPassword() }
                LinkButton(title: t.resend, identifier: "tula.link.resend") { run { await model.resendCode() } }
                LinkButton(title: t.backToSignIn, identifier: "tula.link.signIn") { model.showSignIn() }
            case .expiredPassword:
                field(.newPassword, .newPassword, t.newPasswordLabel, $model.newPassword) {
                    await model.submitNewPassword()
                }
                primary(t.expiredPasswordSubmit) { await model.submitNewPassword() }
            case .signedIn:
                EmptyView()
            case .notSupported:
                // Every step this version has no form for ends here: said in words, with a
                // way out, and never a blank screen.
                primary(t.startAgain) { model.startAgain() }
            }
        }
    }

    private func run(_ action: @escaping @MainActor () async -> Void) {
        Task { @MainActor in await action() }
    }

    private func field(
        _ field: TulaAuthField, _ kind: FieldKind, _ label: String, _ text: Binding<String>, hint: String? = nil,
        onSubmit: @escaping @MainActor () async -> Void
    ) -> some View {
        AuthField(
            field: field, kind: kind, label: label, hint: hint, text: text, errors: model.fieldErrors[field] ?? [],
            strings: model.strings, focus: $focused, spoken: $spoken, onSubmit: { run(onSubmit) })
    }

    private func codeField(onSubmit: @escaping @MainActor () async -> Void) -> some View {
        let digits = Binding(get: { model.code }, set: { model.code = TulaAuthModel.digits($0) })
        return field(.code, .code, model.strings.codeLabel, digits, hint: model.strings.codeHint, onSubmit: onSubmit)
    }

    private func primary(_ title: String, _ action: @escaping @MainActor () async -> Void) -> some View {
        Button {
            run(action)
        } label: {
            HStack(spacing: appearance.theme.spacing * 0.5) {
                if model.isPending {
                    ProgressView()
                        .tint(appearance.colors.primaryText.color)
                        .accessibilityHidden(true)
                }
                Text(title)
            }
            .frame(maxWidth: .infinity)
        }
        .buttonStyle(slots.primaryButton ?? AnyButtonStyle(PrimaryButtonStyle(appearance: appearance)))
        .disabled(model.isPending)
        // Pending in words, for VoiceOver: the spinner alone would say nothing.
        .accessibilityValue(model.isPending ? model.strings.loading : "")
        .accessibilityIdentifier("tula.primary")
    }

    /// "New here? Create an account": a sentence and the link it leads to.
    private func switcher(
        _ question: String, _ link: String, _ identifier: String, _ action: @escaping () -> Void
    ) -> some View {
        VStack(spacing: 0) {
            Text(question)
                .themed(.body, appearance)
                .foregroundColor(appearance.colors.textMuted.color)
            LinkButton(title: link, identifier: identifier, action: action)
        }
    }

    /// The address a sign-in is for, and the way back to change it.
    private var identity: some View {
        VStack(spacing: 0) {
            Text(TulaStrings.format(model.strings.signingInAs, ["email": model.email]))
                .themed(.body, appearance)
                .foregroundColor(appearance.colors.textMuted.color)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
            LinkButton(title: model.strings.changeEmail, identifier: "tula.link.change") { model.showSignIn() }
        }
    }
}
