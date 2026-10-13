import Foundation
import TulaAuth

/// Which of the three flows a `TulaAuthView` opens on.
public enum TulaAuthMode: Hashable, Sendable {
    /// Sign in.
    case signIn
    /// Sign up.
    case signUp
}

/// The screen a `TulaAuthView` draws: one per step of the server this version has a form
/// for, the three forms that start a flow, and `notSupported` for every other step.
public enum TulaAuthScreen: Hashable, Sendable {
    /// Ask for the address a sign-in is for.
    case signInStart
    /// Ask for the address, and the password, of a new account.
    case signUpStart
    /// Ask for the address a password reset is for.
    case resetStart
    /// Ask for the password. `canEmailCode`: the step also offers an emailed code.
    case password(canEmailCode: Bool)
    /// The step offers an emailed code and no password: offer to send it. Nothing is
    /// emailed by arriving here.
    case emailCodeOffer
    /// Ask for the emailed code that signs in. `canUsePassword`: the step also offers the
    /// password.
    case emailCode(destination: String, canUsePassword: Bool)
    /// Ask for the emailed code that proves the address.
    case emailVerification(destination: String)
    /// A reset: ask for the emailed code and the new password together.
    case newPassword(destination: String)
    /// A sign-in whose password has expired: ask for a new one.
    case expiredPassword
    /// A sign-in started with a phone number: offer to text the code. Nothing is texted
    /// by arriving here: a message costs money, so a person asks.
    case textedSignInOffer
    /// Ask for the texted code that signs in. `destination` is the masked number.
    case textedSignIn(destination: String)
    /// The second step, by the way that is open. `others` are the other ways the step
    /// offers and this app can take; `sent` is the masked number once a texted code was
    /// asked for, and `nil` before.
    case secondFactor(TulaSecondWay, others: [TulaSecondWay], sent: String?)
    /// The environment requires a second step and the account has none: offer to set up
    /// an authenticator app.
    case enrolmentStart
    /// The setup key and its QR code, and the field for the code the app then shows.
    case totpSetup
    /// The backup codes of an enrolment, shown once.
    case backupCodes
    /// The flow is over and the client is signed in.
    case signedIn
    /// A step this version has no screen for. `status` is the step's status as the server
    /// wrote it: for a developer's eyes, never drawn.
    case notSupported(status: String)

    /// The fields the screen has, in the order they are drawn.
    public var fields: [TulaAuthField] {
        switch self {
        case .signInStart, .resetStart: return [.email]
        case .signUpStart: return [.email, .password]
        case .password: return [.password]
        case .emailCode, .emailVerification, .textedSignIn, .totpSetup: return [.code]
        case .secondFactor(let way, _, let sent):
            switch way {
            case .totp: return [.code]
            case .backupCode: return [.backupCode]
            case .textedCode: return sent == nil ? [] : [.code]
            case .passkey: return []
            }
        case .newPassword: return [.code, .newPassword]
        case .expiredPassword: return [.newPassword]
        case .emailCodeOffer, .textedSignInOffer, .enrolmentStart, .backupCodes, .signedIn, .notSupported: return []
        }
    }
}

/// A way to take the second step of a sign-in.
public enum TulaSecondWay: Hashable, Sendable {
    /// The code of an authenticator app.
    case totp
    /// A passkey, through the system's sheet.
    case passkey
    /// A texted code: the weakest second step, offered alone or not at all.
    case textedCode
    /// A backup code.
    case backupCode
}

/// A way to sign in that is not typed: what is drawn under the first screen's form.
public enum TulaAuthWay: Hashable, Sendable {
    /// A passkey, through the system's sheet.
    case passkey
    /// A provider: its own sheet where the app gave one, the system's browser otherwise.
    case provider(OAuthProvider)
}

/// What the screens need of the app to sign in with a provider. Everything is `nil` by
/// default, and a provider that then has no way to be shown is not drawn.
public struct TulaAuthOptions: Sendable {
    /// Where the API sends the system's browser back to after a provider's page: an app
    /// link or a custom scheme of the app, listed in the environment's allowed redirect
    /// URLs. The server judges it, never these screens. Without one no provider is shown
    /// through the browser.
    public var redirectURL: String?
    /// Google's own sheet: handed the server's nonce, it answers Google's ID token, or
    /// `nil` when the sheet was closed. It is the app's call to Google's SDK: the package
    /// has no dependency. What it throws is never kept or shown.
    public var google: (@Sendable (_ nonce: String) async throws -> String?)?

    /// - Parameters:
    ///   - redirectURL: Where a provider's page comes back to.
    ///   - google: Google's own sheet.
    public init(redirectURL: String? = nil, google: (@Sendable (_ nonce: String) async throws -> String?)? = nil) {
        self.redirectURL = redirectURL
        self.google = google
    }
}

/// The setup key of an authenticator app and its `otpauth://` address, while their screen
/// is open. Prints as its type's name.
public struct TulaAuthSetup: Hashable, Sendable, TulaRedacted {
    /// The setup key, to type by hand.
    public let key: String
    /// The address a QR code is drawn from.
    public let uri: String
}

/// A field of a screen.
public enum TulaAuthField: Hashable, Sendable {
    /// The email address.
    case email
    /// The password of a sign-in or a sign-up.
    case password
    /// The emailed 6-digit code.
    case code
    /// The new password of a reset or of an expired password.
    case newPassword
    /// A backup code.
    case backupCode
    /// The password the account has now, where another is being chosen.
    case currentPassword
    /// A phone number.
    case phoneNumber
    /// A name a person gives something of theirs (a passkey).
    case name
}

/// Where the focus (the keyboard's and VoiceOver's) is asked to go.
public enum TulaAuthFocus: Hashable, Sendable {
    /// The screen's title: after a step change.
    case title
    /// A field: after a failure that is about it.
    case field(TulaAuthField)
}

/// What is behind a `TulaAuthView`: which screen is drawn, what the fields hold, what went
/// wrong, and the actions of the buttons. The views draw it and decide nothing.
///
/// **It holds no token.** A password and a code are in `password`, `code` and `newPassword`
/// only while their screen is open: every change of screen, the completion and `close()`
/// empty all three. It prints as its type's name, and nothing it holds is logged.
///
/// **A flow that is left is discarded** (`TulaFlow.discard()`): by `close()`, by going to
/// another flow and by starting again. An answer that arrives afterwards changes nothing
/// here and signs nobody in. A flow that had already completed when it was left is not one
/// of those: it cannot be discarded (the client is signed in), so its answer is shown and
/// reported like any other completion.
///
/// **No action is silent.** A button of the open screen does what it says, marks what is
/// missing, says what went wrong, or, where its flow is gone, lands on the start of the
/// flow with words. An action the open screen does not offer does nothing.
@MainActor
public final class TulaAuthModel: ObservableObject, TulaRedacted {
    /// How many digits an emailed code has.
    public static let codeLength = 6

    /// The screen to draw.
    @Published public internal(set) var screen: TulaAuthScreen
    /// The address field.
    @Published public var email = ""
    /// The password field of a sign-in or a sign-up. Emptied when its screen is left.
    @Published public var password = ""
    /// The code field. Emptied when its screen is left.
    @Published public var code = ""
    /// The new-password field. Emptied when its screen is left.
    @Published public var newPassword = ""
    /// Whether an action is being sent. A second one is not started meanwhile.
    @Published public internal(set) var isPending = false
    /// What went wrong that is not about one field, in the table's words.
    @Published public internal(set) var formError: String?
    /// What is wrong with each field, in the table's words.
    @Published public internal(set) var fieldErrors: [TulaAuthField: [String]] = [:]
    /// Something that went right, in words: "A new code is on its way."
    @Published public internal(set) var status: String?
    /// Where the focus was last asked to go, and how many times it was asked: a view moves
    /// the focus when `focusRequests` changes.
    @Published public internal(set) var focus: TulaAuthFocus = .title
    /// Counts the requests to move the focus.
    @Published public internal(set) var focusRequests = 0
    /// The environment's app name, once `loadConfig()` has read it.
    @Published public internal(set) var appName: String?
    /// Whether a sign-up may leave the password out (`signUp.password: optional`).
    @Published public internal(set) var passwordOptional = false
    /// The secret fields whose text is drawn in the clear ("show password"). Emptied with
    /// the fields: when a screen is left, when it closes, and for a field as it is sent
    /// and emptied.
    @Published public internal(set) var revealed: Set<TulaAuthField> = []

    /// The backup-code field. Emptied when its screen is left.
    @Published public var backupCode = ""
    /// Something that is neither a success nor a problem, in words: a sheet that was
    /// closed, another that is still open. Drawn quietly and announced, never as an error.
    @Published public internal(set) var notice: String?
    /// The ways to sign in that are not typed, once `loadConfig()` has read them: a passkey
    /// where the environment has them and the app gave the client a sheet, and each
    /// provider this app can show. Empty until then: a control is hidden until it is known
    /// to work here.
    @Published public internal(set) var ways: [TulaAuthWay] = []
    /// Whether the first screen has a field: `false` once the configuration says that no
    /// way of this environment starts with an address or a number.
    @Published public internal(set) var canIdentify = true
    /// Whether a phone number signs in too (`signIn.methods.smsCode`).
    @Published public internal(set) var phoneSignIn = false
    /// The setup key and its address, only while the setup screen is open.
    @Published public internal(set) var setup: TulaAuthSetup?
    /// The backup codes of an enrolment, only while their screen is open.
    @Published public internal(set) var backupCodes: [String] = []
    /// A texted code's controls are gone: the server said that no message will be sent
    /// (the method or text messages are off, the country is not allowed). A button that
    /// can only be refused again is not left on the screen.
    @Published public internal(set) var textedOff = false
    /// A provider's round trip got no answer at its last step and can be sent again.
    @Published public internal(set) var canRetryProvider = false

    /// The strings the messages are taken from.
    public var strings: TulaStrings

    enum Flow: Sendable {
        case signIn(SignInFlow)
        case signUp(SignUpFlow)
        case reset(PasswordResetFlow)

        var any: TulaFlow {
            switch self {
            case .signIn(let flow): return flow
            case .signUp(let flow): return flow
            case .reset(let flow): return flow
            }
        }
    }

    let client: TulaClient
    let announce: @MainActor (String) -> Void
    let options: TulaAuthOptions
    let copy: @MainActor (String) -> Void
    /// The flow completed while the backup codes are shown and the session could not be
    /// stored: said once the codes' screen is left for the signed-in one.
    var sessionUnsaved = false
    private let onSignedIn: (@MainActor () -> Void)?
    var flow: Flow?
    /// The start the model opened on: where a closed screen is again.
    private let initialScreen: TulaAuthScreen
    /// The start of the kind of flow that is open: where "Start again" goes.
    private var startScreen: TulaAuthScreen
    /// Grows whenever a flow is left: an answer asked for under an older number is dropped.
    var generation = 0

    /// - Parameters:
    ///   - client: The app's client.
    ///   - mode: The flow to open on.
    ///   - strings: The strings.
    ///   - options: What a provider sign-in needs of the app.
    ///   - announce: Says a message to VoiceOver. A view passes the system's; a test passes
    ///     its own.
    ///   - copy: Puts text on the pasteboard, when a person asks for a setup key or the
    ///     backup codes to be copied. A view passes the system's; a test passes its own.
    ///   - onSignedIn: Called once for each flow that completed, when the client is signed
    ///     in: also when the flow's screen was left or closed meanwhile (so it can be
    ///     called after `close()`), and also when the session could not be stored.
    public init(
        client: TulaClient,
        mode: TulaAuthMode = .signIn,
        strings: TulaStrings = .english,
        options: TulaAuthOptions = TulaAuthOptions(),
        announce: @escaping @MainActor (String) -> Void = { _ in },
        copy: @escaping @MainActor (String) -> Void = { _ in },
        onSignedIn: (@MainActor () -> Void)? = nil
    ) {
        self.client = client
        self.strings = strings
        self.options = options
        self.announce = announce
        self.copy = copy
        self.onSignedIn = onSignedIn
        let start: TulaAuthScreen = mode == .signUp ? .signUpStart : .signInStart
        self.screen = start
        self.initialScreen = start
        self.startScreen = start
    }

    // MARK: Going from one flow to another

    /// Leave what is open and show the start of a sign-in.
    public func showSignIn() { open(.signInStart) }
    /// Leave what is open and show the start of a sign-up.
    public func showSignUp() { open(.signUpStart) }
    /// Leave what is open and show the start of a password reset. The address typed for the
    /// sign-in is kept.
    public func showReset() { open(.resetStart) }

    /// Leave what is open and show the start of the same kind of flow again.
    public func startAgain() {
        open(startScreen)
    }

    /// The screen is closing: discard the flow, forget what every field held, the address
    /// included, and go back to the start the model opened on.
    ///
    /// A view that goes away and comes back (a push and a pop, another tab) keeps its
    /// model, so a closed model is never left on a step: its flow is gone, and a step
    /// without one would have buttons that can do nothing. It closes onto the start of its
    /// own mode also when what was open is a reset reached from a sign-in, or a finished
    /// sign-in. Nobody is signed out by it.
    public func close() {
        let owed = owesArrival
        startScreen = initialScreen
        leave()
        email = ""
        show(initialScreen)
        if owed {
            onSignedIn?()
        }
    }

    /// Whether the flow completed and the app was not told yet: the backup codes of an
    /// enrolment are shown before the sign-in is reported, because an app takes the
    /// screens away the moment it is. Whatever leaves that screen reports it.
    var owesArrival: Bool {
        guard screen == .backupCodes, let flow else {
            return false
        }
        return screen(of: flow.any) == .signedIn
    }

    /// From the emailed code back to the password, where the step offers both.
    public func usePassword() {
        guard case .emailCode(_, canUsePassword: true) = screen, !isPending else {
            return
        }
        show(.password(canEmailCode: true))
    }

    /// Whether a secret field's text is drawn in the clear.
    ///
    /// - Parameter field: A field of the open screen.
    /// - Returns: `true` only for a password field of the open screen that "show password"
    ///   was last asked for.
    public func isRevealed(_ field: TulaAuthField) -> Bool {
        revealed.contains(field)
    }

    /// "Show password" and "hide password": draw a secret field's text in the clear, or
    /// stop. A field the open screen does not have, and one that is no secret, stay as
    /// they are.
    ///
    /// - Parameter field: A password field of the open screen.
    public func toggleReveal(_ field: TulaAuthField) {
        guard field == .password || field == .newPassword, screen.fields.contains(field) else {
            return
        }
        if revealed.remove(field) == nil {
            revealed.insert(field)
        }
    }

    func open(_ start: TulaAuthScreen) {
        let owed = owesArrival
        startScreen = start
        leave()
        show(start)
        if owed {
            onSignedIn?()
        }
    }

    /// Discard the flow, drop whatever is still on its way, and empty the secret fields.
    /// The screen is the caller's to change: nothing but a test leaves it where it was.
    func leave() {
        flow?.any.discard()
        flow = nil
        if canRetryProvider {
            // A ticket that waited for another try is for a sign-in nobody is on any more.
            client.discardProviderSignIn()
        }
        generation += 1
        isPending = false
        wipe()
        clearMessages()
    }

    private func wipe() {
        password = ""
        code = ""
        newPassword = ""
        backupCode = ""
        revealed = []
        setup = nil
        backupCodes = []
        textedOff = false
        canRetryProvider = false
        sessionUnsaved = false
    }

    func clearMessages() {
        formError = nil
        fieldErrors = [:]
        status = nil
        notice = nil
    }

    /// Say something that is neither a success nor a problem: shown quietly, announced.
    func quiet(_ words: String) {
        notice = words
        announce(words)
    }

    func show(_ next: TulaAuthScreen) {
        guard next != screen else {
            return
        }
        wipe()
        clearMessages()
        screen = next
        ask(.title)
        if next == .signedIn {
            flow = nil
            onSignedIn?()
        }
    }

    /// An action the open screen offers found no flow to send it on. Nothing in this file
    /// leaves a step open without its flow, so this is a defence and not a path; but a
    /// button that did nothing would be worse than one that says the attempt is over.
    func lost() {
        open(startScreen)
        formError = strings.flowLost
        announce(strings.flowLost)
    }

    /// A flow completed and the screen does not show it: it was left meanwhile, or the
    /// action that completed it threw. The client is signed in, whatever is open now.
    /// Leave that and say so, once.
    ///
    /// - Parameter saved: `false` when the session could not be stored (`storage.failed`):
    ///   the client holds it in memory, so it lasts as long as the app runs, and the
    ///   signed-in screen says that in words.
    func arrived(saved: Bool = true) {
        leave()
        show(.signedIn)
        if !saved {
            formError = strings.sessionNotSaved
            announce(strings.sessionNotSaved)
        }
    }

    /// Whether a start that threw signed the client in all the same: the answer said
    /// `complete`, the session is in the client's memory, and only storing it failed.
    /// A start hands back no flow to ask, so the client's own session is asked. Nothing
    /// else a start does writes to the storage, so this error says a session was adopted.
    func completed(by error: Error) async -> Bool {
        guard (error as? TulaError)?.code == TulaClientErrorCode.storageFailed else {
            return false
        }
        return await client.session.state.isSignedIn
    }

    func ask(_ target: TulaAuthFocus) {
        focus = target
        focusRequests += 1
    }

    // MARK: The environment

    /// Read what the screens are worded from: the app's name, and whether a sign-up may
    /// leave the password out. A failure changes nothing: the screens then say less.
    public func loadConfig() async {
        guard let config = try? await client.config() else {
            return
        }
        appName = config.app.name.isEmpty ? nil : config.app.name
        passwordOptional = config.signUp?.password == .optional
        let methods = Set(config.signIn.methods)
        // An emailed link is not among them: this client has no call that asks for one.
        canIdentify = !methods.isDisjoint(with: ["password", "emailCode", "smsCode"])
        phoneSignIn = methods.contains("smsCode")
        let sheets = client.sheets
        var found: [TulaAuthWay] = methods.contains("passkey") && sheets.passkeys ? [.passkey] : []
        for name in config.signIn.oauth ?? [] {
            // A name this version does not know, or has no words for, is not drawn.
            guard let provider = OAuthProvider(rawValue: name), strings.ways.providers[name] != nil,
                !found.contains(.provider(provider))
            else {
                continue
            }
            let own = (provider == .apple && sheets.apple) || (provider == .google && options.google != nil)
            if own || (sheets.browser && options.redirectURL != nil) {
                found.append(.provider(provider))
            }
        }
        ways = found
    }

    // MARK: Actions

    /// The main button of a screen that starts a flow.
    public func start() async {
        guard canIdentify || screen != .signInStart else {
            return
        }
        let address = email.trimmingCharacters(in: .whitespacesAndNewlines)
        var missing: [TulaAuthField] = address.isEmpty ? [.email] : []
        if screen == .signUpStart, password.isEmpty, !passwordOptional {
            missing.append(.password)
        }
        guard require(missing) else {
            return
        }
        let client = self.client
        switch screen {
        case .signInStart:
            await perform {
                let flow = try await client.startSignIn(identifier: address)
                // Where an emailed code is the only way in there is nothing to choose: ask
                // for it, so that the user goes from their address straight to the code.
                if case .firstFactor(let step) = flow.screen, step.strategies == [.emailCode], step.prepared == nil {
                    do {
                        try await flow.prepareEmailCode()
                    } catch {
                        flow.discard()
                        throw error
                    }
                }
                return .signIn(flow)
            }
        case .signUpStart:
            let typed = password
            await perform {
                .signUp(try await client.startSignUp(email: address, password: typed.isEmpty ? nil : typed))
            }
        case .resetStart:
            await perform { .reset(try await client.startPasswordReset(email: address)) }
        default:
            return
        }
    }

    /// The main button of the password screen. The field is emptied as the password is
    /// sent, right or wrong.
    public func submitPassword() async {
        guard case .password = screen, !isPending else {
            return
        }
        guard case .signIn(let flow) = flow else {
            lost()
            return
        }
        guard require(password.isEmpty ? [.password] : []) else {
            return
        }
        let typed = password
        password = ""
        revealed.remove(.password)
        await perform(flow: flow) { try await flow.submitPassword(typed) }
    }

    /// "Email me a code": ask the server to send the code that signs in.
    public func sendEmailCode() async {
        switch screen {
        case .password(canEmailCode: true), .emailCodeOffer:
            guard !isPending else {
                return
            }
            guard case .signIn(let flow) = flow else {
                lost()
                return
            }
            await perform(flow: flow) { try await flow.prepareEmailCode() }
        default:
            return
        }
    }

    /// The main button of a screen that asks for the emailed code. The field is emptied as
    /// the code is sent, right or wrong: a refused code is read from the email again.
    public func submitCode() async {
        guard !isPending else {
            return
        }
        let attempt: TulaFlow
        let send: @Sendable (String) async throws -> FlowStep
        switch (screen, flow) {
        case (.emailCode, .signIn(let flow)):
            attempt = flow
            send = { try await flow.attemptEmailCode($0) }
        case (.emailVerification, .signIn(let flow)):
            attempt = flow
            send = { try await flow.verifyEmail(code: $0) }
        case (.emailVerification, .signUp(let flow)):
            attempt = flow
            send = { try await flow.verifyEmail(code: $0) }
        case (.textedSignIn, .signIn(let flow)):
            attempt = flow
            send = { try await flow.attemptSmsCode($0) }
        case (.secondFactor(.totp, _, _), .some(let flow)):
            let any = flow.any
            attempt = any
            send = { try await any.submitTotp($0) }
        case (.secondFactor(.textedCode, _, .some), .some(let flow)):
            let any = flow.any
            attempt = any
            send = { try await any.submitSmsCode($0) }
        case (.emailCode, _), (.emailVerification, _), (.textedSignIn, _), (.secondFactor(.totp, _, _), _),
            (.secondFactor(.textedCode, _, .some), _):
            lost()
            return
        default:
            return
        }
        let typed = code
        guard require(typed.count == TulaAuthModel.codeLength ? [] : [.code], message: strings.codeIncomplete) else {
            return
        }
        code = ""
        await perform(flow: attempt) { try await send(typed) }
    }

    /// Ask for the email again.
    public func resendCode() async {
        guard !isPending else {
            return
        }
        switch (screen, flow) {
        case (.emailCode, .signIn(let signIn)):
            await perform(flow: signIn, done: strings.emailResent) { try await signIn.prepareEmailCode() }
        case (.textedSignIn, .signIn(let signIn)):
            await perform(flow: signIn, done: strings.ways.smsResent) { try await signIn.prepareSmsCode() }
        case (.secondFactor(.textedCode, _, .some), .some(let flow)):
            let any = flow.any
            await perform(flow: any, done: strings.secondStep.smsResent) { try await any.prepareSmsSecondFactor() }
        case (.textedSignIn, _), (.secondFactor(.textedCode, _, .some), _):
            lost()
        case (.emailVerification, .some(let flow)), (.newPassword, .some(let flow)):
            let any = flow.any
            await perform(flow: any, done: strings.resent) { try await any.resendCode() }
        case (.emailCode, _), (.emailVerification, _), (.newPassword, _):
            lost()
        default:
            return
        }
    }

    /// The main button of a screen that asks for a new password. A password that is being
    /// chosen is kept when the server refuses it, to be put right; in a reset the code is
    /// kept with it unless the code is what was refused.
    public func submitNewPassword() async {
        guard !isPending else {
            return
        }
        let typed = newPassword
        let typedCode = code
        switch (screen, flow) {
        case (.newPassword, .reset(let flow)):
            var missing: [TulaAuthField] = typedCode.count == TulaAuthModel.codeLength ? [] : [.code]
            if typed.isEmpty {
                missing.append(.newPassword)
            }
            guard require(missing, message: missing.first == .code ? strings.codeIncomplete : nil) else {
                return
            }
            await perform(flow: flow) { try await flow.submit(code: typedCode, password: typed) }
        case (.expiredPassword, .signIn(let flow)):
            guard require(typed.isEmpty ? [.newPassword] : []) else {
                return
            }
            await perform(flow: flow) { try await flow.submitNewPassword(typed) }
        case (.newPassword, _), (.expiredPassword, _):
            lost()
        default:
            return
        }
    }

    /// Keep what a code field holds to the digits of a code.
    ///
    /// - Parameter typed: What the field holds, typed or pasted.
    /// - Returns: At most six ASCII digits.
    public static func digits(_ typed: String) -> String {
        String(typed.filter { $0.isASCII && $0.isNumber }.prefix(codeLength))
    }

/// Whether what a sign-in was started with is a phone number: a plus sign, then 8 to 15
    /// digits that do not start with zero, once the spaces, parentheses and hyphens people
    /// type between them are taken out. It chooses which of the offered forms is drawn and
    /// nothing else: the server judges the number.
    ///
    /// - Parameter identifier: What the first field held.
    /// - Returns: `true` for a number in the international form.
    public static func isPhoneNumber(_ identifier: String) -> Bool {
        let kept = identifier.trimmingCharacters(in: .whitespacesAndNewlines).filter { !" ()-".contains($0) }
        guard kept.first == "+" else {
            return false
        }
        let digits = kept.dropFirst()
        return (8...15).contains(digits.count) && digits.first != "0"
            && digits.allSatisfy { $0.isASCII && $0.isNumber }
    }

        // MARK: Running an action

    /// Whether nothing is missing. Otherwise the fields are marked and the first takes the
    /// focus, without a request.
    func require(_ missing: [TulaAuthField], message: String? = nil) -> Bool {
        guard !isPending else {
            return false
        }
        guard let first = missing.first else {
            return true
        }
        clearMessages()
        for field in missing {
            fieldErrors[field] = [field == first ? (message ?? strings.required) : strings.required]
        }
        ask(.field(first))
        announce(fieldErrors[first]?.first ?? strings.required)
        return false
    }

    /// Start a flow and show its first step.
    func perform(_ start: @escaping @Sendable () async throws -> Flow) async {
        guard let asked = begin() else {
            return
        }
        do {
            let started = try await start()
            guard asked == generation else {
                // Left while the start was on its way: the attempt is nobody's. A start
                // that completed at once cannot be discarded: somebody is signed in.
                if screen(of: started.any) == .signedIn {
                    arrived()
                } else {
                    started.any.discard()
                }
                return
            }
            flow = started
            isPending = false
            show(screen(of: started.any))
        } catch {
            if await completed(by: error) {
                arrived(saved: false)
            } else {
                fail(error, asked)
            }
        }
    }

    /// Send one action of the open flow and show the step it answers.
    func perform(
        flow: TulaFlow, done: String? = nil, _ action: @escaping @Sendable () async throws -> FlowStep
    ) async {
        guard let asked = begin() else {
            return
        }
        do {
            _ = try await action()
            guard asked == generation else {
                // Left while the answer was on its way. The flow was discarded then, and a
                // discarded flow takes nothing from an answer (the action throws): the one
                // answer that reaches this line is of a flow that had completed before it
                // was left, which no discard undoes. The client is signed in, and a model
                // that dropped that would show a form to a signed-in user and tell the app
                // nothing.
                if screen(of: flow) == .signedIn {
                    arrived()
                }
                return
            }
            isPending = false
            let next = screen(of: flow)
            if next == screen {
                status = done
                if let done {
                    announce(done)
                }
            } else {
                show(next)
            }
        } catch {
            // An action that throws after its answer was taken: the answer said `complete`,
            // the client adopted the session, and storing it failed. The flow is over
            // whatever the error says, and whether or not its screen was left: a form kept
            // open could only answer `flow.invalid_step` to somebody who is signed in.
            if screen(of: flow) == .signedIn {
                arrived(saved: false)
            } else {
                fail(error, asked)
            }
        }
    }

    func begin() -> Int? {
        guard !isPending else {
            return nil
        }
        isPending = true
        clearMessages()
        return generation
    }

    /// Say why an action failed, on the screen that is open.
    ///
    /// - Parameters:
    ///   - error: What the action threw.
    ///   - asked: The generation the action was started under: a failure of a screen that
    ///     was left is not shown.
    ///   - refused: What `auth.invalid_credentials` is said as when what was refused is
    ///     not something typed (a passkey): above the form, never under a field. That
    ///     code's own sentence is about an address and a password.
    func fail(_ error: Error, _ asked: Int, refused: String? = nil) {
        guard asked == generation else {
            return
        }
        isPending = false
        // Everything the client throws is a `TulaError`. Anything else is a bug somewhere,
        // and is said with the table's fallback: its own words were not written for a user.
        guard let failure = error as? TulaError else {
            formError = strings.unknownError
            announce(strings.unknownError)
            return
        }
        if failure.code == TulaClientErrorCode.flowBusy {
            // Another sheet of the app is still out: nothing went wrong, and nothing was sent.
            quiet(strings.ways.sheetBusy)
            return
        }
        if let refused, failure.code == ErrorCode.authInvalidCredentials.rawValue {
            formError = refused
            announce(refused)
            return
        }
        if TulaAuthModel.switchedOff.contains(failure.code), let offer = textedOffer {
            // No message will be sent whatever is pressed: the controls go, the words stay.
            show(offer)
            textedOff = true
        }
        place(failure)
        // A code the server refused is not sent again: it is read from the email again.
        if fieldErrors[.code] != nil {
            code = ""
        }
        if fieldErrors[.backupCode] != nil {
            backupCode = ""
        }
    }

    /// The refusals of a texted code that an operator's setting causes: asking again can
    /// only be refused again.
    static let switchedOff: Set<String> = ["auth.method_disabled", "sms.disabled", "sms.country_not_allowed"]

    /// The screen that offers the texted code of the open screen, when it is about one.
    var textedOffer: TulaAuthScreen? {
        switch screen {
        case .textedSignIn, .textedSignInOffer: return .textedSignInOffer
        case .secondFactor(.textedCode, let others, _): return .secondFactor(.textedCode, others: others, sent: nil)
        default: return nil
        }
    }

    // MARK: Where a problem is shown

    /// Say an error's problems on the open screen: under the fields they are about, or above
    /// the form. Where each goes is `TulaPlacedProblems`'s rule, which the account screen
    /// shares.
    private func place(_ error: TulaError) {
        let fields = screen.fields
        // The server never says which part was wrong: shown at the last thing typed.
        let wrong = wrongCode.flatMap { words in fields.last.map { ($0, words) } }
        let placed = TulaPlacedProblems(error, fields: fields, strings: strings, wrong: wrong)
        fieldErrors = placed.fields
        formError = placed.above
        let first = fields.first(where: { placed.fields[$0] != nil })
        if let first {
            ask(.field(first))
        }
        announce(placed.above ?? first.flatMap { placed.fields[$0]?.first } ?? strings.unknownError)
    }

    /// What a refused code is said as on a screen that asks for a code and nothing else.
    /// The server answers every such refusal with the code it has for a wrong password
    /// (it never says which part was wrong), and that code's sentence is about an address
    /// and a password: on these screens the words are about the code.
    private var wrongCode: String? {
        switch screen {
        case .textedSignIn: return strings.ways.smsCodeWrong
        case .secondFactor: return strings.secondStep.codeWrong
        default: return nil
        }
    }

    // MARK: The screen of a step

    func screen(of flow: TulaFlow) -> TulaAuthScreen {
        switch flow.screen {
        case .password:
            return .password(canEmailCode: false)
        case .firstFactor(let step):
            // A sign-in offers what the environment has switched on, whatever was typed. A
            // code is texted to a number, and a password or an emailed code for a number
            // signs nobody in: a number is shown the texted code and nothing else, and an
            // address is never shown it.
            if step.strategies.contains(.smsCode), TulaAuthModel.isPhoneNumber(email) {
                if let prepared = step.prepared, prepared.strategy == .smsCode {
                    return .textedSignIn(destination: prepared.destination)
                }
                return .textedSignInOffer
            }
            let password = step.strategies.contains(.password)
            // A step that offers neither of the two ways an address has a form for (a
            // passkey or a provider alone, a way of tomorrow) is not one to draw.
            guard password || step.strategies.contains(.emailCode) else {
                return .notSupported(status: flow.step.status)
            }
            if let prepared = step.prepared, prepared.strategy == .emailCode {
                return .emailCode(destination: prepared.destination, canUsePassword: password)
            }
            if password {
                return .password(canEmailCode: step.strategies.contains(.emailCode))
            }
            return .emailCodeOffer
        case .emailVerification(let step):
            return .emailVerification(destination: step.destination)
        case .newPassword(let step):
            return step.reason == nil ? .newPassword(destination: step.destination) : .expiredPassword
        case .complete:
            return .signedIn
        case .secondFactor(let step):
            // In the order they are offered: what is strongest and at hand first, the
            // backup code last. A way this version does not know is left out, never guessed.
            let order: [(SecondFactorMethod, TulaSecondWay)] = [
                (.totp, .totp), (.passkey, .passkey), (.smsCode, .textedCode), (.backupCode, .backupCode),
            ]
            let offered = order.filter { step.options.contains($0.0) && ($0.1 != .passkey || client.sheets.passkeys) }
                .map(\.1)
            var chosen = offered.first
            // The way a person chose stays open while the step is the same.
            if case .secondFactor(let open, _, _) = screen, offered.contains(open) {
                chosen = open
            }
            guard let chosen else {
                return .notSupported(status: flow.step.status)
            }
            let sent = step.prepared.flatMap { $0.method == .smsCode ? $0.destination : nil }
            return .secondFactor(
                chosen, others: offered.filter { $0 != chosen }, sent: chosen == .textedCode ? sent : nil)
        case .factorEnrolment:
            // The setup key is asked for by a person, and its screen is the model's to open:
            // the step is the same before and after.
            return screen == .totpSetup ? .totpSetup : .enrolmentStart
        case .notSupported(let status):
            return .notSupported(status: status)
        }
    }
}
