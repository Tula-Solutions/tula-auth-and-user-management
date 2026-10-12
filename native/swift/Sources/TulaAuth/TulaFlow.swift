import Foundation

/// What a flow is at one moment: the attempt's id, its kind, the step the server asks for
/// next and when the attempt expires. It never holds the attempt's secret.
public struct FlowSnapshot: Hashable, Sendable {
    /// The attempt's id.
    public let id: String
    /// Sign-up, sign-in or password reset.
    public let kind: FlowKind
    /// The step the server asks for next, as it sent it.
    public let step: FlowStep
    /// When the attempt expires (an ISO 8601 time, as the API wrote it).
    public let expiresAt: String
}

/// What an app draws for a step: the step where this version of the client has an action for
/// it, and `notSupported` for everything else.
///
/// The server decides the step; the client never guesses one. A status this version does not
/// know (a server ahead of the app), a known status this version has no action for yet, and a
/// known status that offers only ways this client cannot take are all `notSupported`: an app
/// says so in words, and never draws a blank screen or an action on a guess.
public enum FlowScreen: Hashable, Sendable {
    /// Ask for the password (`submitPassword`).
    case password
    /// Offer the first factors of the step that this client can take: the password and an
    /// emailed code.
    case firstFactor(FlowStepNeedsFirstFactor)
    /// Ask for the emailed code (`verifyEmail`, `resendCode`).
    case emailVerification(FlowStepNeedsEmailVerification)
    /// Ask for a new password: a reset's (`PasswordResetFlow.submit`), or a sign-in's whose
    /// password has expired (`SignInFlow.submitNewPassword`).
    case newPassword(FlowStepNeedsNewPassword)
    /// The flow is over and the client is signed in.
    case complete
    /// Nothing this version of the client can do with the step. `status` is the step's
    /// status as the server wrote it, for the words an app shows or a log line.
    case notSupported(status: String)

    /// The first factors a `firstFactor` screen can offer with this version of the client.
    public static let firstFactors: Set<FirstFactorStrategy> = [.password, .emailCode]

    /// The screen of a step.
    ///
    /// - Parameters:
    ///   - step: The step, as a flow has it.
    ///   - kind: The flow's kind: a new-password step means different things in a reset and
    ///     in a sign-in.
    public init(step: FlowStep, kind: FlowKind) {
        switch step {
        case .needsPassword:
            self = .password
        case .needsFirstFactor(let value) where !FlowScreen.firstFactors.isDisjoint(with: value.strategies):
            self = .firstFactor(value)
        case .needsEmailVerification(let value) where value.strategies.contains(.emailCode):
            self = .emailVerification(value)
        case .needsNewPassword(let value)
        where (kind == .passwordReset && value.reason == nil) || (kind == .signIn && value.reason == .expired):
            self = .newPassword(value)
        case .complete:
            self = .complete
        default:
            self = .notSupported(status: step.status)
        }
    }
}

/// What a flow needs from its client.
struct FlowContext: Sendable {
    let transport: ApiTransport
    let session: TulaSession
}

/// The attempt behind a flow: its secret, its newest step, and the rule that one action is
/// sent at a time.
final class FlowAttemptState: @unchecked Sendable {
    /// What every call after the start presents: the attempt's id and its secret.
    struct Binding: Sendable {
        let params: [String: String]
        let options: CallOptions
    }

    private struct State {
        var secret: String?
        var busy = false
        var discarded = false
        var current: FlowSnapshot
    }

    let context: FlowContext
    private let lock = NSLock()
    private var state: State

    init(context: FlowContext, started: FlowAttempt) throws {
        guard FlowAttemptState.isUsable(started), started.attemptSecret != nil || started.step.status == "complete"
        else {
            throw TulaError.client(TulaClientErrorCode.responseInvalid)
        }
        self.context = context
        self.state = State(
            secret: started.attemptSecret,
            current: FlowSnapshot(id: started.id, kind: started.kind, step: started.step, expiresAt: started.expiresAt)
        )
    }

    /// Whether an answer can be a flow's: an id, a step, and tokens exactly when the step is
    /// `complete`. A 200 is checked before anything is built from it.
    private static func isUsable(_ attempt: FlowAttempt) -> Bool {
        guard !attempt.id.isEmpty, !attempt.step.status.isEmpty else {
            return false
        }
        if attempt.step.status == "complete" {
            guard let session = attempt.session, let token = session.accessToken else {
                return false
            }
            return !token.isEmpty && !session.sessionId.isEmpty
        }
        return attempt.session == nil
    }

    var snapshot: FlowSnapshot {
        lock.withLock { state.current }
    }

    /// Take the next answer of the attempt: the new step, and the session when it completed.
    func accept(_ next: FlowAttempt) async throws -> FlowStep {
        let dropped = lock.withLock { state.discarded }
        // Discarded while the answer was on its way: nothing is taken from it, so a late
        // `complete` signs nobody in.
        guard !dropped else {
            throw TulaError.client("flow.invalid_step")
        }
        guard FlowAttemptState.isUsable(next) else {
            throw TulaError.client(TulaClientErrorCode.responseInvalid)
        }
        lock.withLock {
            state.current = FlowSnapshot(id: next.id, kind: next.kind, step: next.step, expiresAt: next.expiresAt)
            if next.step.status == "complete" {
                state.secret = nil
            }
        }
        if let session = next.session {
            try await context.session.adopt(session)
        }
        return next.step
    }

    /// Run one action of the attempt, and refuse a second while it is being sent.
    func exclusive<T: Sendable>(_ action: @Sendable (Binding) async throws -> T) async throws -> T {
        try lock.withLock {
            guard state.secret != nil else {
                throw TulaError.client("flow.invalid_step")
            }
            guard !state.busy else {
                throw TulaError.client(TulaClientErrorCode.flowBusy)
            }
            state.busy = true
        }
        defer { lock.withLock { state.busy = false } }
        // A refresh under way finishes first: a flow that completes installs a new session,
        // and the refresh of the old one must not land over it.
        await context.session.idle()
        let held = lock.withLock { (state.secret, state.current.id) }
        guard let secret = held.0 else {
            throw TulaError.client("flow.invalid_step")
        }
        return try await action(
            Binding(params: ["attemptId": held.1], options: CallOptions(attemptSecret: secret))
        )
    }

    /// Send one step of the attempt and take its answer.
    func step<Body: Encodable & Sendable>(_ operation: TulaOperation, body: Body?) async throws -> FlowStep {
        let transport = context.transport
        return try await exclusive { bound in
            let next = try await transport.call(
                operation, params: bound.params, body: body, options: bound.options, as: FlowAttempt.self
            )
            return try await self.accept(next)
        }
    }

    func step(_ operation: TulaOperation) async throws -> FlowStep {
        try await step(operation, body: Optional<NoBody>.none)
    }

    func discard() {
        lock.withLock {
            if state.current.step.status != "complete" {
                state.discarded = true
                state.secret = nil
            }
        }
    }
}

/// An attempt to sign up, sign in or reset a password: the server's step, and the actions
/// that answer it.
///
/// The attempt's secret is held inside the flow and sent as `x-tula-attempt` on every call
/// after the start; it is never a property, and a flow prints as its type's name. One action
/// is sent at a time: a second one while the first is on its way throws `flow.busy`.
public class TulaFlow: @unchecked Sendable {
    let attempt: FlowAttemptState
    let resend: TulaOperation

    init(attempt: FlowAttemptState, resend: TulaOperation) {
        self.attempt = attempt
        self.resend = resend
    }

    /// The attempt as it is now.
    public var snapshot: FlowSnapshot { attempt.snapshot }
    /// The attempt's id.
    public var id: String { attempt.snapshot.id }
    /// The flow's kind.
    public var kind: FlowKind { attempt.snapshot.kind }
    /// The step the server asks for next, exactly as it sent it. A step of a status this
    /// version does not know is `FlowStep.unknown`, with the whole object kept.
    public var step: FlowStep { attempt.snapshot.step }
    /// What to draw for the step: see `FlowScreen`.
    public var screen: FlowScreen {
        let now = attempt.snapshot
        return FlowScreen(step: now.step, kind: now.kind)
    }

    /// Ask for the emailed code of the current step again.
    ///
    /// - Throws: `TulaError`: `rate_limited` with `retryAfter` while the last one is too new.
    @discardableResult
    public func resendCode() async throws -> FlowStep {
        try await attempt.step(resend)
    }

    /// Leave the flow. The attempt's secret is forgotten, every later action throws
    /// `flow.invalid_step` without a request, and an answer still on its way is dropped, so
    /// that a late `complete` signs nobody in. A flow that has completed is left as it is.
    public func discard() {
        attempt.discard()
    }
}

/// A sign-up.
public final class SignUpFlow: TulaFlow, @unchecked Sendable {
    /// Prove the address with the emailed code. On `complete` the client is signed in.
    @discardableResult
    public func verifyEmail(code: String) async throws -> FlowStep {
        try await attempt.step(TulaOperations.verifySignUpEmail, body: VerifyEmailRequest(code: code))
    }
}

/// A sign-in.
public final class SignInFlow: TulaFlow, @unchecked Sendable {
    /// Answer `needs_password` (or choose the password at `needs_first_factor`). A wrong
    /// password, an unknown address and a locked account are the same
    /// `auth.invalid_credentials`.
    @discardableResult
    public func submitPassword(_ password: String) async throws -> FlowStep {
        try await attempt.step(TulaOperations.submitSignInPassword, body: PasswordAttemptRequest(password: password))
    }

    /// Answer `needs_new_password` of a sign-in whose password has expired
    /// (`reason: expired`). The expired password itself is refused with `password.reused`.
    @discardableResult
    public func submitNewPassword(_ password: String) async throws -> FlowStep {
        try await attempt.step(TulaOperations.submitSignInNewPassword, body: NewPasswordRequest(password: password))
    }

    /// Answer `needs_email_verification` with the emailed code.
    @discardableResult
    public func verifyEmail(code: String) async throws -> FlowStep {
        try await attempt.step(TulaOperations.verifySignInEmail, body: VerifyEmailRequest(code: code))
    }

    /// Ask the server to email the code of an emailed-code first factor. Nothing is sent by a
    /// start: an app asks, with a button.
    ///
    /// There is no call that asks for an emailed **link**: a link is honoured only together
    /// with a binding the asking client keeps and a page that reads it, and this client has
    /// neither. The code in the same email is the way.
    @discardableResult
    public func prepareEmailCode() async throws -> FlowStep {
        try await attempt.step(
            TulaOperations.prepareSignInFirstFactor, body: FirstFactorPrepareRequest(strategy: .emailCode)
        )
    }

    /// Prove the first factor with the code `prepareEmailCode()` asked for.
    @discardableResult
    public func attemptEmailCode(_ code: String) async throws -> FlowStep {
        try await attempt.step(
            TulaOperations.attemptSignInFirstFactor,
            body: FirstFactorAttemptRequest.emailCode(FirstFactorAttemptRequestEmailCode(code: code))
        )
    }
}

/// A password reset.
public final class PasswordResetFlow: TulaFlow, @unchecked Sendable {
    /// Answer `needs_new_password` with the emailed code and the new password together. The
    /// code is spent only when the password is accepted.
    @discardableResult
    public func submit(code: String, password: String) async throws -> FlowStep {
        try await attempt.step(
            TulaOperations.submitPasswordReset, body: PasswordResetRequest(code: code, password: password)
        )
    }
}
