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
        case .emailCode, .emailVerification: return [.code]
        case .newPassword: return [.code, .newPassword]
        case .expiredPassword: return [.newPassword]
        case .emailCodeOffer, .signedIn, .notSupported: return []
        }
    }
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
    @Published public private(set) var screen: TulaAuthScreen
    /// The address field.
    @Published public var email = ""
    /// The password field of a sign-in or a sign-up. Emptied when its screen is left.
    @Published public var password = ""
    /// The code field. Emptied when its screen is left.
    @Published public var code = ""
    /// The new-password field. Emptied when its screen is left.
    @Published public var newPassword = ""
    /// Whether an action is being sent. A second one is not started meanwhile.
    @Published public private(set) var isPending = false
    /// What went wrong that is not about one field, in the table's words.
    @Published public private(set) var formError: String?
    /// What is wrong with each field, in the table's words.
    @Published public private(set) var fieldErrors: [TulaAuthField: [String]] = [:]
    /// Something that went right, in words: "A new code is on its way."
    @Published public private(set) var status: String?
    /// Where the focus was last asked to go, and how many times it was asked: a view moves
    /// the focus when `focusRequests` changes.
    @Published public private(set) var focus: TulaAuthFocus = .title
    /// Counts the requests to move the focus.
    @Published public private(set) var focusRequests = 0
    /// The environment's app name, once `loadConfig()` has read it.
    @Published public private(set) var appName: String?
    /// Whether a sign-up may leave the password out (`signUp.password: optional`).
    @Published public private(set) var passwordOptional = false
    /// The secret fields whose text is drawn in the clear ("show password"). Emptied with
    /// the fields: when a screen is left, when it closes, and for a field as it is sent
    /// and emptied.
    @Published public private(set) var revealed: Set<TulaAuthField> = []

    /// The strings the messages are taken from.
    public var strings: TulaStrings

    private enum Flow: Sendable {
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

    private let client: TulaClient
    private let announce: @MainActor (String) -> Void
    private let onSignedIn: (@MainActor () -> Void)?
    private var flow: Flow?
    /// The start the model opened on: where a closed screen is again.
    private let initialScreen: TulaAuthScreen
    /// The start of the kind of flow that is open: where "Start again" goes.
    private var startScreen: TulaAuthScreen
    /// Grows whenever a flow is left: an answer asked for under an older number is dropped.
    private var generation = 0

    /// - Parameters:
    ///   - client: The app's client.
    ///   - mode: The flow to open on.
    ///   - strings: The strings.
    ///   - announce: Says a message to VoiceOver. A view passes the system's; a test passes
    ///     its own.
    ///   - onSignedIn: Called once for each flow that completed, when the client is signed
    ///     in: also when the flow's screen was left or closed meanwhile (so it can be
    ///     called after `close()`), and also when the session could not be stored.
    public init(
        client: TulaClient,
        mode: TulaAuthMode = .signIn,
        strings: TulaStrings = .english,
        announce: @escaping @MainActor (String) -> Void = { _ in },
        onSignedIn: (@MainActor () -> Void)? = nil
    ) {
        self.client = client
        self.strings = strings
        self.announce = announce
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
        startScreen = initialScreen
        leave()
        email = ""
        show(initialScreen)
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

    private func open(_ start: TulaAuthScreen) {
        startScreen = start
        leave()
        show(start)
    }

    /// Discard the flow, drop whatever is still on its way, and empty the secret fields.
    /// The screen is the caller's to change: nothing but a test leaves it where it was.
    func leave() {
        flow?.any.discard()
        flow = nil
        generation += 1
        isPending = false
        wipe()
        clearMessages()
    }

    private func wipe() {
        password = ""
        code = ""
        newPassword = ""
        revealed = []
    }

    private func clearMessages() {
        formError = nil
        fieldErrors = [:]
        status = nil
    }

    private func show(_ next: TulaAuthScreen) {
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
    private func lost() {
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
    private func arrived(saved: Bool = true) {
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
    private func completed(by error: Error) async -> Bool {
        guard (error as? TulaError)?.code == TulaClientErrorCode.storageFailed else {
            return false
        }
        return await client.session.state.isSignedIn
    }

    private func ask(_ target: TulaAuthFocus) {
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
    }

    // MARK: Actions

    /// The main button of a screen that starts a flow.
    public func start() async {
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
        case (.emailCode, _), (.emailVerification, _):
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

    // MARK: Running an action

    /// Whether nothing is missing. Otherwise the fields are marked and the first takes the
    /// focus, without a request.
    private func require(_ missing: [TulaAuthField], message: String? = nil) -> Bool {
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
    private func perform(_ start: @escaping @Sendable () async throws -> Flow) async {
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
    private func perform(
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

    private func begin() -> Int? {
        guard !isPending else {
            return nil
        }
        isPending = true
        clearMessages()
        return generation
    }

    private func fail(_ error: Error, _ asked: Int) {
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
        place(failure)
        // A code the server refused is not sent again: it is read from the email again.
        if fieldErrors[.code] != nil {
            code = ""
        }
    }

    // MARK: Where a problem is shown

    /// The field of the open screen a problem belongs to, or `nil` for "above the form".
    private func target(code: String, named: String?) -> TulaAuthField? {
        let fields = screen.fields
        let secret: TulaAuthField = fields.contains(.newPassword) ? .newPassword : .password
        let byName: [String: TulaAuthField] = [
            "email": .email, "identifier": .email, "password": secret, "newPassword": secret, "code": .code,
        ]
        var found: TulaAuthField?
        if let named, let field = byName[named] {
            found = field
        } else if code == ErrorCode.authInvalidCredentials.rawValue {
            // The server never says which part was wrong: shown at the last thing typed.
            found = fields.last
        } else {
            switch code.split(separator: ".").first.map(String.init) {
            case "email": found = .email
            case "password": found = secret
            case "verification": found = .code
            default: found = nil
            }
        }
        return found.flatMap { fields.contains($0) ? $0 : nil }
    }

    private func place(_ error: TulaError) {
        var fields: [TulaAuthField: [String]] = [:]
        var above: String?
        let add = { (field: TulaAuthField, message: String) in
            if fields[field]?.contains(message) != true {
                fields[field, default: []].append(message)
            }
        }
        for problem in error.errors {
            if let field = target(code: problem.code, named: problem.field) {
                add(field, strings.message(for: problem))
            } else {
                above = strings.message(for: error)
            }
        }
        if error.errors.isEmpty {
            if let field = target(code: error.code, named: nil) {
                add(field, strings.message(for: error))
            } else {
                above = strings.message(for: error)
            }
        }
        if let wait = error.retryAfter, wait > 0, let message = above {
            above = message + " " + TulaStrings.format(strings.retryIn, ["time": strings.duration(wait)])
        }
        fieldErrors = fields
        formError = above
        let first = screen.fields.first(where: { fields[$0] != nil })
        if let first {
            ask(.field(first))
        }
        announce(above ?? first.flatMap { fields[$0]?.first } ?? strings.unknownError)
    }

    // MARK: The screen of a step

    private func screen(of flow: TulaFlow) -> TulaAuthScreen {
        switch flow.screen {
        case .password:
            return .password(canEmailCode: false)
        case .firstFactor(let step):
            let password = step.strategies.contains(.password)
            // The client can also prove a texted code; this version has no screen for one,
            // so a step that offers nothing else is still not one it can draw.
            guard password || step.strategies.contains(.emailCode) else {
                return .notSupported(status: flow.step.status)
            }
            if let prepared = step.prepared, prepared.strategy == .emailCode {
                return .emailCode(destination: prepared.destination, canUsePassword: password)
            }
            return password ? .password(canEmailCode: step.strategies.contains(.emailCode)) : .emailCodeOffer
        case .emailVerification(let step):
            return .emailVerification(destination: step.destination)
        case .newPassword(let step):
            return step.reason == nil ? .newPassword(destination: step.destination) : .expiredPassword
        case .complete:
            return .signedIn
        case .secondFactor, .factorEnrolment:
            // The client has calls for these; this version has no screen (TULA-60).
            return .notSupported(status: flow.step.status)
        case .notSupported(let status):
            return .notSupported(status: status)
        }
    }
}
