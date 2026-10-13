import Foundation
import TulaAuth

// What a screen holds, as data: its words, its fields, its main button and its links, and
// the action of the model each of them performs. A view draws a `TulaAuthContent` from top
// to bottom and decides nothing: which button a step has, and what it does, is said here,
// where `swift test` can read it (a view's `body` runs only when SwiftUI draws it).

/// Something a person can ask a screen to do. Every button, link and keyboard "go" of a
/// screen is one of these, performed by `TulaAuthModel.perform(_:)`.
public enum TulaAuthAction: Hashable, Sendable, CaseIterable {
    /// Start the flow of the open start screen with what its fields hold.
    case start
    /// Send the password of a sign-in.
    case submitPassword
    /// Ask for the emailed code that signs in.
    case sendEmailCode
    /// Send the emailed code.
    case submitCode
    /// Ask for the email again.
    case resendCode
    /// Send the new password (with the code, in a reset).
    case submitNewPassword
    /// Go from the emailed code back to the password.
    case usePassword
    /// Leave what is open for the start of a sign-in.
    case showSignIn
    /// Leave what is open for the start of a sign-up.
    case showSignUp
    /// Leave what is open for the start of a password reset.
    case showReset
    /// Leave what is open for the start of the same kind of flow.
    case startAgain
}

/// What a field asks of the keyboard and of the system's autofill.
public enum TulaAuthFieldKind: Hashable, Sendable {
    /// An email address.
    case email
    /// A password the account already has.
    case password
    /// A password that is being chosen.
    case newPassword
    /// A 6-digit code.
    case code
}

/// One field of a screen.
public struct TulaAuthFieldContent: Hashable, Sendable {
    /// The field.
    public let field: TulaAuthField
    /// What it asks of the keyboard and of autofill.
    public let kind: TulaAuthFieldKind
    /// Its label.
    public let label: String
    /// A hint under it, when it has one.
    public let hint: String?
    /// What the keyboard's "go" does: the screen's main action.
    public let submit: TulaAuthAction
}

/// A button or a link of a screen: its words and the action it performs.
public struct TulaAuthOffer: Hashable, Sendable {
    /// The control's accessibility identifier: `tula.primary`, `tula.link.reset`.
    public let identifier: String
    /// The words on it.
    public let title: String
    /// What it does.
    public let action: TulaAuthAction
    /// A sentence drawn before it, when it has one: "New here?".
    public let lead: String?

    init(_ name: String, _ title: String, _ action: TulaAuthAction, lead: String? = nil) {
        identifier = "tula.link.\(name)"
        self.title = title
        self.action = action
        self.lead = lead
    }

    init(primary title: String, _ action: TulaAuthAction) {
        identifier = "tula.primary"
        self.title = title
        self.action = action
        lead = nil
    }
}

/// Everything a screen holds, in the order it is drawn: the title and what is under it,
/// the address a sign-in is for (with the way to change it), the fields, the main button,
/// the links.
public struct TulaAuthContent: Hashable, Sendable {
    /// The screen's title.
    public let title: String
    /// What is under the title, when the screen has it.
    public let subtitle: String?
    /// The address a sign-in is for, as the offer's `lead`, and the link that changes it.
    public let identity: TulaAuthOffer?
    /// The fields.
    public let fields: [TulaAuthFieldContent]
    /// The main button.
    public let primary: TulaAuthOffer?
    /// The links under it.
    public let links: [TulaAuthOffer]

    init(
        title: String, subtitle: String? = nil, identity: TulaAuthOffer? = nil, fields: [TulaAuthFieldContent] = [],
        primary: TulaAuthOffer? = nil, links: [TulaAuthOffer] = []
    ) {
        self.title = title
        self.subtitle = subtitle
        self.identity = identity
        self.fields = fields
        self.primary = primary
        self.links = links
    }

    /// Every action the screen offers. `TulaAuthModel.perform(_:)` does nothing for any
    /// other.
    public var actions: Set<TulaAuthAction> {
        Set(fields.map(\.submit) + ([identity, primary].compactMap { $0 } + links).map(\.action))
    }

    /// What a screen holds.
    ///
    /// - Parameters:
    ///   - screen: The screen.
    ///   - strings: The strings its words are taken from.
    ///   - appName: The environment's app name, when it is known.
    ///   - passwordOptional: Whether a sign-up may leave the password out.
    ///   - email: The address typed for the sign-in.
    public init(
        screen: TulaAuthScreen, strings t: TulaStrings, appName: String? = nil, passwordOptional: Bool = false,
        email: String = ""
    ) {
        let address = { (submit: TulaAuthAction) in
            TulaAuthFieldContent(field: .email, kind: .email, label: t.emailLabel, hint: nil, submit: submit)
        }
        let code = { (submit: TulaAuthAction) in
            TulaAuthFieldContent(field: .code, kind: .code, label: t.codeLabel, hint: t.codeHint, submit: submit)
        }
        let chosen = { (submit: TulaAuthAction) in
            TulaAuthFieldContent(
                field: .newPassword, kind: .newPassword, label: t.newPasswordLabel, hint: nil, submit: submit)
        }
        let identity = TulaAuthOffer(
            "change", t.changeEmail, .showSignIn, lead: TulaStrings.format(t.signingInAs, ["email": email]))

        switch screen {
        case .signInStart:
            self.init(
                title: t.signInTitle,
                subtitle: appName.map { TulaStrings.format(t.signInSubtitle, ["appName": $0]) }
                    ?? t.signInSubtitleNoApp,
                fields: [address(.start)],
                primary: TulaAuthOffer(primary: t.continueButton, .start),
                links: [TulaAuthOffer("signUp", t.signUpLink, .showSignUp, lead: t.noAccount)])
        case .signUpStart:
            self.init(
                title: t.signUpTitle, subtitle: t.signUpSubtitle,
                fields: [
                    address(.start),
                    // A password that is being chosen, though it is the sign-up's `password`.
                    TulaAuthFieldContent(
                        field: .password, kind: .newPassword,
                        label: passwordOptional ? t.passwordOptionalLabel : t.passwordLabel,
                        hint: passwordOptional ? t.passwordOptionalHint : nil, submit: .start),
                ],
                primary: TulaAuthOffer(primary: t.continueButton, .start),
                links: [TulaAuthOffer("signIn", t.signInLink, .showSignIn, lead: t.haveAccount)])
        case .resetStart:
            self.init(
                title: t.resetTitle, subtitle: t.resetSubtitle, fields: [address(.start)],
                primary: TulaAuthOffer(primary: t.sendCode, .start),
                links: [TulaAuthOffer("signIn", t.backToSignIn, .showSignIn)])
        case .password(let canEmailCode):
            self.init(
                title: t.passwordTitle, identity: identity,
                fields: [
                    TulaAuthFieldContent(
                        field: .password, kind: .password, label: t.passwordLabel, hint: nil, submit: .submitPassword)
                ],
                primary: TulaAuthOffer(primary: t.signInSubmit, .submitPassword),
                links: (canEmailCode ? [TulaAuthOffer("emailCode", t.emailCode, .sendEmailCode)] : [])
                    + [TulaAuthOffer("reset", t.forgotPassword, .showReset)])
        case .emailCodeOffer:
            self.init(
                title: t.emailCodeTitle, subtitle: t.emailCodePrompt, identity: identity,
                primary: TulaAuthOffer(primary: t.emailCode, .sendEmailCode))
        case .emailCode(let destination, let canUsePassword):
            self.init(
                title: t.emailCodeTitle,
                subtitle: TulaStrings.format(t.emailCodeSubtitle, ["destination": destination]), identity: identity,
                fields: [code(.submitCode)], primary: TulaAuthOffer(primary: t.signInSubmit, .submitCode),
                links: [TulaAuthOffer("resend", t.emailResend, .resendCode)]
                    + (canUsePassword ? [TulaAuthOffer("password", t.usePassword, .usePassword)] : []))
        case .emailVerification(let destination):
            self.init(
                title: t.verificationTitle,
                subtitle: TulaStrings.format(t.verificationSubtitle, ["destination": destination]),
                fields: [code(.submitCode)], primary: TulaAuthOffer(primary: t.verifySubmit, .submitCode),
                links: [
                    TulaAuthOffer("resend", t.resend, .resendCode), TulaAuthOffer("back", t.back, .startAgain),
                ])
        case .newPassword(let destination):
            self.init(
                title: t.newPasswordTitle,
                subtitle: TulaStrings.format(t.newPasswordSubtitle, ["destination": destination]),
                fields: [code(.submitNewPassword), chosen(.submitNewPassword)],
                primary: TulaAuthOffer(primary: t.resetSubmit, .submitNewPassword),
                links: [
                    TulaAuthOffer("resend", t.resend, .resendCode),
                    TulaAuthOffer("signIn", t.backToSignIn, .showSignIn),
                ])
        case .expiredPassword:
            self.init(
                title: t.expiredPasswordTitle, subtitle: t.expiredPasswordSubtitle,
                fields: [chosen(.submitNewPassword)],
                primary: TulaAuthOffer(primary: t.expiredPasswordSubmit, .submitNewPassword))
        case .signedIn:
            self.init(title: t.signedIn)
        case .notSupported:
            // Every step this version has no form for ends here: said in words, with a way
            // out, and never a blank screen.
            self.init(
                title: t.notSupportedTitle, subtitle: t.notSupportedMessage,
                primary: TulaAuthOffer(primary: t.startAgain, .startAgain))
        }
    }
}

extension TulaAuthModel {
    /// What the open screen holds: what a view draws.
    public var content: TulaAuthContent {
        TulaAuthContent(
            screen: screen, strings: strings, appName: appName, passwordOptional: passwordOptional, email: email)
    }

    /// Do what a button, a link or the keyboard's "go" of the open screen asks.
    ///
    /// An action the open screen does not offer does nothing: it cannot be asked for.
    ///
    /// - Parameter action: An action of `content`.
    public func perform(_ action: TulaAuthAction) async {
        guard content.actions.contains(action) else {
            return
        }
        switch action {
        case .start: await start()
        case .submitPassword: await submitPassword()
        case .sendEmailCode: await sendEmailCode()
        case .submitCode: await submitCode()
        case .resendCode: await resendCode()
        case .submitNewPassword: await submitNewPassword()
        case .usePassword: usePassword()
        case .showSignIn: showSignIn()
        case .showSignUp: showSignUp()
        case .showReset: showReset()
        case .startAgain: startAgain()
        }
    }

    /// What a field holds.
    public func text(of field: TulaAuthField) -> String {
        switch field {
        case .email: return email
        case .password: return password
        case .code: return code
        case .newPassword: return newPassword
        }
    }

    /// Take what was typed, or pasted, into a field. A code field keeps the digits of a
    /// code and nothing else.
    public func setText(_ typed: String, of field: TulaAuthField) {
        switch field {
        case .email: email = typed
        case .password: password = typed
        case .code: code = TulaAuthModel.digits(typed)
        case .newPassword: newPassword = typed
        }
    }

    /// What is wrong with a field, each worded as a problem ("Error: …"): what is drawn
    /// under it.
    public func problems(of field: TulaAuthField) -> [String] {
        (fieldErrors[field] ?? []).map { TulaStrings.format(strings.errorPrefix, ["message": $0]) }
    }

    /// What went wrong that is not about one field, worded as a problem: what is drawn
    /// above the form.
    public var formProblem: String? {
        formError.map { TulaStrings.format(strings.errorPrefix, ["message": $0]) }
    }

    /// What VoiceOver reads for a field: its label, and its problems when it has any.
    public func spokenLabel(of field: TulaAuthFieldContent) -> String {
        let problems = fieldErrors[field.field] ?? []
        return problems.isEmpty
            ? field.label
            : TulaStrings.format(
                strings.fieldInvalid, ["label": field.label, "message": problems.joined(separator: " ")])
    }
}
