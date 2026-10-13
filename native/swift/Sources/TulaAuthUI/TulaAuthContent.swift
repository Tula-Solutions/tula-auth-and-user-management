import Foundation
import TulaAuth

// What a screen holds, as data: its words, its fields, its main button and its links, and
// the action of the model each of them performs. A view draws a `TulaAuthContent` from top
// to bottom and decides nothing: which button a step has, and what it does, is said here,
// where `swift test` can read it (a view's `body` runs only when SwiftUI draws it).

/// Something a person can ask a screen to do. Every button, link and keyboard "go" of a
/// screen is one of these, performed by `TulaAuthModel.perform(_:)`.
public enum TulaAuthAction: Hashable, Sendable, CaseIterable {
    /// Every action there is, with each way and each provider an action can name.
    public static let allCases: [TulaAuthAction] =
        [
            .start, .submitPassword, .sendEmailCode, .submitCode, .resendCode, .submitNewPassword, .usePassword,
            .showSignIn, .showSignUp, .showReset, .startAgain, .sendTextedCode, .submitBackupCode, .useSecondPasskey,
            .startEnrolment, .confirmEnrolment, .copySetupKey, .copyBackupCodes, .savedBackupCodes, .usePasskey,
            .retryProvider,
        ] + [TulaSecondWay.totp, .passkey, .textedCode, .backupCode].map { .useSecondWay($0) }
        + TulaAuthAction.providers.map { .useProvider($0) }

    /// The providers a button can be for.
    static let providers: [OAuthProvider] = [.google, .github, .apple, .microsoft, .discord, .linkedin, .x, .facebook]

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
    /// Ask for the texted code of the open screen.
    case sendTextedCode
    /// Send the backup code.
    case submitBackupCode
    /// Open another way to take the second step.
    case useSecondWay(TulaSecondWay)
    /// Show the passkey sheet for the second step.
    case useSecondPasskey
    /// Ask for the setup key of an authenticator app.
    case startEnrolment
    /// Confirm the authenticator app with its code.
    case confirmEnrolment
    /// Put the setup key on the pasteboard.
    case copySetupKey
    /// Put the backup codes on the pasteboard.
    case copyBackupCodes
    /// Leave the backup codes: they are saved.
    case savedBackupCodes
    /// Show the passkey sheet to sign in.
    case usePasskey
    /// Sign in with a provider.
    case useProvider(OAuthProvider)
    /// Send again the last step of a provider sign-in that got no answer.
    case retryProvider
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
    /// An address or a phone number: what a sign-in starts with where a number signs in too.
    case identifier
    /// A backup code: letters and digits, never corrected.
    case backupCode
    /// A phone number.
    case phoneNumber
    /// A name a person gives something.
    case name
}

/// Everything a screen holds, in the order it is drawn: the title and what is under it,
/// the address a sign-in is for (with the way to change it), the fields, the main button,
/// the links.
///
/// It prints as its type's name: on the setup screen it holds the setup key, and on the
/// codes' screen the backup codes.
public struct TulaAuthContent: Hashable, Sendable, TulaRedacted {
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
    /// The ways to sign in that are not typed, each a button under the form.
    public let ways: [TulaAuthOffer]
    /// What is drawn between the form and `ways`, when both are there: "or".
    public let divider: String?
    /// The setup key of an authenticator app, drawn with its QR code above the fields.
    public let setup: TulaAuthSetupContent?
    /// The backup codes, drawn as a list above the main button.
    public let codes: TulaAuthCodesContent?

    init(
        title: String, subtitle: String? = nil, identity: TulaAuthOffer? = nil, fields: [TulaAuthFieldContent] = [],
        primary: TulaAuthOffer? = nil, links: [TulaAuthOffer] = [], ways: [TulaAuthOffer] = [],
        divider: String? = nil, setup: TulaAuthSetupContent? = nil, codes: TulaAuthCodesContent? = nil
    ) {
        self.title = title
        self.subtitle = subtitle
        self.identity = identity
        self.fields = fields
        self.primary = primary
        self.links = links
        self.ways = ways
        self.divider = divider
        self.setup = setup
        self.codes = codes
    }

    /// Every action the screen offers. `TulaAuthModel.perform(_:)` does nothing for any
    /// other.
    public var actions: Set<TulaAuthAction> {
        let offers = [identity, primary, setup?.copy, codes?.copy].compactMap { $0 } + links + ways
        return Set(fields.map(\.submit) + offers.map(\.action))
    }

    /// What a screen holds.
    ///
    /// - Parameters:
    ///   - screen: The screen.
    ///   - strings: The strings its words are taken from.
    ///   - appName: The environment's app name, when it is known.
    ///   - passwordOptional: Whether a sign-up may leave the password out.
    ///   - email: The address typed for the sign-in.
    ///   - situation: What the screen's words depend on beside the screen itself.
    public init(
        screen: TulaAuthScreen, strings t: TulaStrings, appName: String? = nil, passwordOptional: Bool = false,
        email: String = "", situation: TulaAuthSituation = TulaAuthSituation()
    ) {
        let second = t.secondStep
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
            let ways = situation.ways.compactMap { way -> TulaAuthOffer? in
                switch way {
                case .passkey:
                    return TulaAuthOffer("passkey", t.ways.passkey, .usePasskey)
                case .provider(let provider):
                    // A provider the table has no name for is not drawn.
                    return t.ways.providers[provider.rawValue].map {
                        TulaAuthOffer(
                            "provider.\(provider.rawValue)",
                            TulaStrings.format(t.ways.continueWith, ["provider": $0]), .useProvider(provider))
                    }
                }
            }
            var subtitle =
                appName.map { TulaStrings.format(t.signInSubtitle, ["appName": $0]) } ?? t.signInSubtitleNoApp
            if !situation.canIdentify, ways.isEmpty {
                // Every way of this environment is one this app cannot take here: said in
                // words, never a screen with nothing on it.
                subtitle = t.ways.noWayHere
            }
            let field = TulaAuthFieldContent(
                field: .email, kind: situation.phoneSignIn ? .identifier : .email,
                label: situation.phoneSignIn ? t.ways.identifierLabel : t.emailLabel,
                hint: situation.phoneSignIn ? t.ways.identifierHint : nil, submit: .start)
            self.init(
                title: t.signInTitle, subtitle: subtitle,
                fields: situation.canIdentify ? [field] : [],
                primary: situation.canIdentify ? TulaAuthOffer(primary: t.continueButton, .start) : nil,
                links: (situation.canRetryProvider
                    ? [TulaAuthOffer("providerRetry", t.ways.providerRetry, .retryProvider)] : [])
                    + [TulaAuthOffer("signUp", t.signUpLink, .showSignUp, lead: t.noAccount)],
                ways: ways, divider: situation.canIdentify && !ways.isEmpty ? t.ways.divider : nil)
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
        case .textedSignInOffer:
            self.init(
                title: t.ways.smsTitle, subtitle: t.ways.smsPrompt, identity: identity,
                primary: situation.textedOff ? nil : TulaAuthOffer(primary: t.ways.smsCode, .sendTextedCode))
        case .textedSignIn(let destination):
            self.init(
                title: t.ways.smsTitle,
                subtitle: TulaStrings.format(t.ways.smsSubtitle, ["destination": destination]), identity: identity,
                fields: [code(.submitCode)], primary: TulaAuthOffer(primary: t.signInSubmit, .submitCode),
                links: [TulaAuthOffer("resend", t.ways.smsResend, .resendCode)])
        case .secondFactor(let way, let others, let sent):
            let links = others.map { other -> TulaAuthOffer in
                switch other {
                case .totp: return TulaAuthOffer("second.totp", second.useAuthenticator, .useSecondWay(.totp))
                case .backupCode:
                    return TulaAuthOffer("second.backupCode", second.useBackupCode, .useSecondWay(.backupCode))
                case .passkey:
                    return TulaAuthOffer("second.passkey", second.usePasskeyInstead, .useSecondWay(.passkey))
                case .textedCode:
                    return TulaAuthOffer("second.textedCode", second.smsInstead, .useSecondWay(.textedCode))
                }
            } + [TulaAuthOffer("back", t.startAgain, .startAgain)]
            switch way {
            case .totp:
                self.init(
                    title: second.title, subtitle: second.totpSubtitle,
                    fields: [
                        TulaAuthFieldContent(
                            field: .code, kind: .code, label: second.totpLabel, hint: t.codeHint, submit: .submitCode)
                    ],
                    primary: TulaAuthOffer(primary: second.submit, .submitCode), links: links)
            case .backupCode:
                self.init(
                    title: second.title, subtitle: second.backupSubtitle,
                    fields: [
                        TulaAuthFieldContent(
                            field: .backupCode, kind: .backupCode, label: second.backupLabel,
                            hint: second.backupHint, submit: .submitBackupCode)
                    ],
                    primary: TulaAuthOffer(primary: second.submit, .submitBackupCode), links: links)
            case .passkey:
                // Also where a passkey is the step's one way: said in words, with its button.
                self.init(
                    title: second.title, subtitle: second.passkeySubtitle,
                    primary: TulaAuthOffer(primary: second.usePasskey, .useSecondPasskey), links: links)
            case .textedCode:
                if let sent {
                    self.init(
                        title: second.title, subtitle: TulaStrings.format(second.smsSent, ["destination": sent]),
                        fields: [code(.submitCode)], primary: TulaAuthOffer(primary: second.submit, .submitCode),
                        links: [TulaAuthOffer("resend", second.smsResend, .resendCode)] + links)
                } else {
                    self.init(
                        title: second.title, subtitle: second.smsSubtitle,
                        primary: situation.textedOff ? nil : TulaAuthOffer(primary: second.smsSend, .sendTextedCode),
                        links: links)
                }
            }
        case .enrolmentStart:
            self.init(
                title: second.enrolTitle, subtitle: second.enrolRequired,
                primary: TulaAuthOffer(primary: second.enrolStart, .startEnrolment),
                links: [TulaAuthOffer("back", t.startAgain, .startAgain)])
        case .totpSetup:
            self.init(
                title: second.enrolTitle, subtitle: second.scanInstruction,
                fields: [
                    TulaAuthFieldContent(
                        field: .code, kind: .code, label: second.totpLabel, hint: t.codeHint,
                        submit: .confirmEnrolment)
                ],
                primary: TulaAuthOffer(primary: second.confirmSubmit, .confirmEnrolment),
                links: [TulaAuthOffer("back", t.startAgain, .startAgain)],
                setup: situation.setup.map {
                    TulaAuthSetupContent(
                        uri: $0.uri, key: $0.key, qrLabel: second.qrLabel, keyLabel: second.secretLabel,
                        keyHint: second.secretHint, copy: TulaAuthOffer("copyKey", second.copyKey, .copySetupKey))
                })
        case .backupCodes:
            self.init(
                title: second.backupCodesTitle, subtitle: second.backupCodesIntro,
                primary: TulaAuthOffer(primary: second.saved, .savedBackupCodes),
                codes: TulaAuthCodesContent(
                    label: second.backupCodesList, codes: situation.backupCodes,
                    copy: TulaAuthOffer("copyCodes", second.copy, .copyBackupCodes)))
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

/// What a screen's content depends on beside the screen: what the environment's
/// configuration said, and what a screen holds only while it is open.
public struct TulaAuthSituation: Hashable, Sendable, TulaRedacted {
    /// The ways to sign in that are not typed.
    public var ways: [TulaAuthWay] = []
    /// Whether the first screen has a field.
    public var canIdentify = true
    /// Whether a phone number signs in too.
    public var phoneSignIn = false
    /// Whether a provider sign-in can be sent again.
    public var canRetryProvider = false
    /// Whether a texted code's controls are gone.
    public var textedOff = false
    /// The setup key, on the setup screen.
    public var setup: TulaAuthSetup?
    /// The backup codes, on their screen.
    public var backupCodes: [String] = []

    /// A situation in which nothing is known yet.
    public init() {}
}

extension TulaAuthModel {
    /// What the open screen's words depend on beside the screen.
    public var situation: TulaAuthSituation {
        var situation = TulaAuthSituation()
        situation.ways = ways
        situation.canIdentify = canIdentify
        situation.phoneSignIn = phoneSignIn
        situation.canRetryProvider = canRetryProvider
        situation.textedOff = textedOff
        situation.setup = setup
        situation.backupCodes = backupCodes
        return situation
    }

    /// What the open screen holds: what a view draws.
    public var content: TulaAuthContent {
        TulaAuthContent(
            screen: screen, strings: strings, appName: appName, passwordOptional: passwordOptional, email: email,
            situation: situation)
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
        case .sendTextedCode: await sendTextedCode()
        case .submitBackupCode: await submitBackupCode()
        case .useSecondWay(let way): useSecondWay(way)
        case .useSecondPasskey: await useSecondPasskey()
        case .startEnrolment: await startEnrolment()
        case .confirmEnrolment: await confirmEnrolment()
        case .copySetupKey: copySetupKey()
        case .copyBackupCodes: copyBackupCodes()
        case .savedBackupCodes: savedBackupCodes()
        case .usePasskey: await usePasskey()
        case .useProvider(let provider): await useProvider(provider)
        case .retryProvider: await retryProvider()
        }
    }

    /// What a field holds.
    public func text(of field: TulaAuthField) -> String {
        switch field {
        case .email: return email
        case .password: return password
        case .code: return code
        case .newPassword: return newPassword
        case .backupCode: return backupCode
        // Fields of the account screen: these screens have none of them.
        case .currentPassword, .phoneNumber, .name: return ""
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
        case .backupCode: backupCode = typed
        case .currentPassword, .phoneNumber, .name: break
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
