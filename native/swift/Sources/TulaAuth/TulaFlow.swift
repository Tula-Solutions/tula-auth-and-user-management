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
    /// Ask for the second factor, in one of the ways of the step this client can take: an
    /// authenticator's code (`submitTotp`), a backup code (`submitBackupCode`) and, where the
    /// client was given a passkey sheet, a passkey (`submitSecondFactorWithPasskey`).
    case secondFactor(FlowStepNeedsSecondFactor)
    /// The environment requires a second factor and the user has none: enrol an
    /// authenticator app inside the attempt (`startTotpEnrolment`, `confirmTotpEnrolment`).
    case factorEnrolment(FlowStepNeedsFactorEnrolment)
    /// The flow is over and the client is signed in.
    case complete
    /// Nothing this version of the client can do with the step. `status` is the step's
    /// status as the server wrote it, for the words an app shows or a log line.
    case notSupported(status: String)

    /// The first factors a `firstFactor` screen can offer with this version of the client.
    public static let firstFactors: Set<FirstFactorStrategy> = [.password, .emailCode]

    /// The second factors a `secondFactor` screen can offer whatever the client was given. A
    /// passkey is a third, only for a client with a passkey sheet. A texted code is not among
    /// them: this version has no call that asks for one.
    public static let secondFactors: Set<SecondFactorMethod> = [.totp, .backupCode]

    /// The screen of a step.
    ///
    /// - Parameters:
    ///   - step: The step, as a flow has it.
    ///   - kind: The flow's kind: a new-password step means different things in a reset and
    ///     in a sign-in.
    ///   - passkeys: Whether the client has a passkey sheet. Without one a second factor
    ///     that offers only a passkey is `notSupported`.
    public init(step: FlowStep, kind: FlowKind, passkeys: Bool = false) {
        switch step {
        case .needsSecondFactor(let value)
        where kind != .signUp
            && value.options.contains(where: { FlowScreen.secondFactors.contains($0) || (passkeys && $0 == .passkey) }):
            self = .secondFactor(value)
        case .needsFactorEnrolment(let value) where value.methods.contains(.totp):
            self = .factorEnrolment(value)
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

/// The attempt behind a flow: its secret, its newest step, and the rule that one action is
/// sent at a time.
final class FlowAttemptState: @unchecked Sendable, TulaRedacted {
    /// What every call after the start presents: the attempt's id and its secret.
    struct Binding: Sendable {
        let params: [String: String]
        let options: CallOptions
    }

    private struct State: TulaRedacted {
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
    @discardableResult
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
public class TulaFlow: @unchecked Sendable, TulaRedacted {
    /// The operations of a kind of flow that every kind has under its own path.
    struct Operations: Sendable {
        let resend: TulaOperation
        var secondFactor: TulaOperation?
        var passkeyOptions: TulaOperation?
        let startEnrolment: TulaOperation
        let confirmEnrolment: TulaOperation

        static let signUp = Operations(
            resend: TulaOperations.resendSignUpCode,
            startEnrolment: TulaOperations.startSignUpTotpEnrolment,
            confirmEnrolment: TulaOperations.confirmSignUpTotpEnrolment)
        static let signIn = Operations(
            resend: TulaOperations.resendSignInCode,
            secondFactor: TulaOperations.submitSignInSecondFactor,
            passkeyOptions: TulaOperations.getSignInSecondFactorPasskeyOptions,
            startEnrolment: TulaOperations.startSignInTotpEnrolment,
            confirmEnrolment: TulaOperations.confirmSignInTotpEnrolment)
        static let passwordReset = Operations(
            resend: TulaOperations.resendPasswordResetCode,
            secondFactor: TulaOperations.submitPasswordResetSecondFactor,
            passkeyOptions: TulaOperations.getPasswordResetSecondFactorPasskeyOptions,
            startEnrolment: TulaOperations.startPasswordResetTotpEnrolment,
            confirmEnrolment: TulaOperations.confirmPasswordResetTotpEnrolment)
    }

    let attempt: FlowAttemptState
    let operations: Operations

    init(attempt: FlowAttemptState, operations: Operations) {
        self.attempt = attempt
        self.operations = operations
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
        return FlowScreen(step: now.step, kind: now.kind, passkeys: attempt.context.passkeys != nil)
    }

    /// Ask for the emailed code of the current step again.
    ///
    /// - Throws: `TulaError`: `rate_limited` with `retryAfter` while the last one is too new.
    @discardableResult
    public func resendCode() async throws -> FlowStep {
        try await attempt.step(operations.resend)
    }

    // MARK: The second factor

    private func secondFactor(_ proof: SecondFactorRequest) async throws -> FlowAttempt {
        guard let operation = operations.secondFactor else {
            throw TulaError.client("flow.invalid_step")
        }
        let transport = attempt.context.transport
        let attempt = self.attempt
        return try await attempt.exclusive { bound in
            let next = try await transport.call(
                operation, params: bound.params, body: proof, options: bound.options, as: FlowAttempt.self)
            try await attempt.accept(next)
            return next
        }
    }

    /// Answer `needs_second_factor` with the code of the user's authenticator app.
    ///
    /// - Throws: `TulaError`: `auth.invalid_credentials` for a wrong code and for one that
    ///   was already used, `rate_limited` after repeated wrong ones.
    @discardableResult
    public func submitTotp(_ code: String) async throws -> FlowStep {
        try await secondFactor(.totp(SecondFactorRequestTotp(code: code))).step
    }

    /// Answer `needs_second_factor` with one of the user's backup codes. A code works once.
    ///
    /// - Returns: The next step, and how many backup codes the user has left when the
    ///   server said so.
    @discardableResult
    public func submitBackupCode(_ code: String) async throws -> BackupCodeResult {
        let next = try await secondFactor(.backupCode(SecondFactorRequestBackupCode(code: code)))
        return BackupCodeResult(step: next.step, remaining: next.backupCodesRemaining)
    }

    /// Answer `needs_second_factor` with a passkey: asks the API for the options, shows the
    /// system's sheet and submits what it returns.
    ///
    /// - Returns: The next step, or `dismissed` when the user closed the sheet: nothing was
    ///   submitted, and the step is still the one it was.
    /// - Throws: `TulaError`: `flow.busy` while another sheet of the client is out,
    ///   `passkey.unsupported` for a client with no passkey sheet, `passkey.failed`,
    ///   `auth.invalid_credentials` for an assertion the API refuses.
    public func submitSecondFactorWithPasskey() async throws -> TulaCeremony<FlowStep> {
        guard let optionsOf = operations.passkeyOptions, let submit = operations.secondFactor else {
            throw TulaError.client("flow.invalid_step")
        }
        let context = attempt.context
        let attempt = self.attempt
        return try await context.gate.ceremony {
            try context.requirePasskeys()
            return try await attempt.exclusive { bound in
                let options = try await context.transport.call(
                    optionsOf, params: bound.params, options: bound.options, as: PasskeyRequestOptions.self)
                guard let credential = try await context.assertion(options) else {
                    return .dismissed
                }
                let next = try await context.transport.call(
                    submit, params: bound.params,
                    body: SecondFactorRequest.passkey(SecondFactorRequestPasskey(credential: credential)),
                    options: bound.options, as: FlowAttempt.self)
                return .finished(try await attempt.accept(next))
            }
        }
    }

    // MARK: Enrolling a second factor inside the attempt

    /// Answer `needs_factor_enrolment`: start enrolling an authenticator app. Calling it
    /// again replaces the pending secret.
    ///
    /// - Returns: The setup key and its `otpauth://` URI, once. The client keeps neither:
    ///   an app shows them while their screen is open and nowhere else.
    public func startTotpEnrolment() async throws -> TotpEnrolment {
        let transport = attempt.context.transport
        let operation = operations.startEnrolment
        return try await attempt.exclusive { bound in
            let enrolment = try await transport.call(
                operation, params: bound.params, options: bound.options, as: TotpEnrolment.self)
            guard !enrolment.secret.isEmpty, enrolment.uri.hasPrefix("otpauth://") else {
                throw TulaError.client(TulaClientErrorCode.responseInvalid)
            }
            return enrolment
        }
    }

    /// Confirm the authenticator app with a code it shows. The attempt goes on (normally to
    /// `complete`), and the answer carries the user's backup codes, once.
    ///
    /// - Returns: The next step and the backup codes. `failure` is set when the attempt
    ///   completed and the session could not be saved (`storage.failed`): the codes are
    ///   handed over all the same, because the server shows them once.
    /// - Throws: `TulaError`: `mfa.invalid_code`, `mfa.enrolment_expired`.
    public func confirmTotpEnrolment(code: String) async throws -> FactorEnrolmentResult {
        let transport = attempt.context.transport
        let operation = operations.confirmEnrolment
        let attempt = self.attempt
        return try await attempt.exclusive { bound in
            let next = try await transport.call(
                operation, params: bound.params, body: TotpConfirmRequest(code: code), options: bound.options,
                as: FlowAttempt.self)
            let codes = next.backupCodes ?? []
            guard !codes.isEmpty, !codes.contains(where: \.isEmpty) else {
                throw TulaError.client(TulaClientErrorCode.responseInvalid)
            }
            do {
                return FactorEnrolmentResult(step: try await attempt.accept(next), backupCodes: codes, failure: nil)
            } catch let failure as TulaError where next.step.status == "complete" && attempt.snapshot.step == next.step {
                return FactorEnrolmentResult(step: next.step, backupCodes: codes, failure: failure)
            }
        }
    }

    /// Leave the flow. The attempt's secret is forgotten, every later action throws
    /// `flow.invalid_step` without a request, and an answer still on its way is dropped, so
    /// that a late `complete` signs nobody in. A flow that has completed is left as it is.
    public func discard() {
        attempt.discard()
    }
}

/// What submitting a backup code answered.
///
/// It prints as its type's name, as everything a flow answers does.
public struct BackupCodeResult: Hashable, Sendable, TulaRedacted {
    /// The next step.
    public let step: FlowStep
    /// How many backup codes the user has left, when the server said so.
    public let remaining: Int?
}

/// What confirming an authenticator app inside an attempt answered.
///
/// It prints as its type's name: the backup codes are for the user's eyes, once.
public struct FactorEnrolmentResult: Sendable, TulaRedacted {
    /// The next step.
    public let step: FlowStep
    /// The user's backup codes. Shown once; the client keeps none.
    public let backupCodes: [String]
    /// Why the session of a completed attempt could not be saved, when it could not.
    public let failure: TulaError?

    /// The type's name, and nothing of what it holds.
    public var description: String { "FactorEnrolmentResult" }
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
