import Foundation

// What a signed-in user does to how their account is protected: passkeys, the second
// factor, the provider accounts they sign in with, and proving again that it is them.
// Each of these may answer `auth.step_up_required`: `TulaError.stepUpMethods` says with
// what, and `TulaClient.stepUp` proves it.

extension TulaError {
    /// The ways the user can prove again that it is them, for an `auth.step_up_required`
    /// answer: the server's `params.methods` (`password`, `totp`, `backup_code`,
    /// `email_code`, `passkey`, …), in its order. Empty for any other error.
    public var stepUpMethods: [String] {
        guard code == "auth.step_up_required", case .string(let methods)? = params["methods"] else {
            return []
        }
        return methods.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    }
}

/// Proving again that it is the user (ADR 0025): each call answers one of the methods an
/// `auth.step_up_required` listed, and replaces the access token with one that carries the
/// proof. A user with a second factor steps up with it, never with the password alone.
public struct TulaStepUp: Sendable, TulaRedacted {
    let context: FlowContext

    /// Step up with the account's password.
    ///
    /// - Throws: `TulaError`: `auth.invalid_credentials`, `rate_limited`.
    public func withPassword(_ password: String) async throws {
        try await context.session.stepUp(.password(StepUpRequestPassword(password: password)))
    }

    /// Step up with the code of the user's authenticator app.
    public func withTotp(_ code: String) async throws {
        try await context.session.stepUp(.totp(StepUpRequestTotp(code: code)))
    }

    /// Step up with a backup code. A code works once.
    public func withBackupCode(_ code: String) async throws {
        try await context.session.stepUp(.backupCode(StepUpRequestBackupCode(code: code)))
    }

    /// Ask for a code by email, for a user with a verified address and no second factor.
    /// Nothing is sent until this is called.
    ///
    /// - Returns: The masked address and when the code stops working. Never the code.
    public func sendEmailCode() async throws -> StepUpEmailCode {
        let sent = try await context.session.authorized(TulaOperations.sendStepUpEmailCode, as: StepUpEmailCode.self)
        guard sent.method == "email_code", !sent.destination.isEmpty, !sent.expiresAt.isEmpty else {
            throw TulaError.client(TulaClientErrorCode.responseInvalid)
        }
        return sent
    }

    /// Step up with the code `sendEmailCode()` asked for.
    public func withEmailCode(_ code: String) async throws {
        try await context.session.stepUp(.emailCode(StepUpRequestEmailCode(code: code)))
    }

    /// Ask for a code by text message, for a user whose second factor is a texted code
    /// (`sms_code` among `TulaError.stepUpMethods`). Nothing is texted until this is called:
    /// a message costs money, so an app asks, with a button.
    ///
    /// - Returns: The masked number and when the code stops working. Never the code.
    /// - Throws: `TulaError`: `auth.method_disabled` where a texted code is not this user's
    ///   way to step up, `sms.disabled`, `sms.country_not_allowed` or `sms.unavailable` when
    ///   the message cannot be sent, `rate_limited` with `retryAfter` when asked too soon.
    public func sendSmsCode() async throws -> SmsFactorCode {
        try TulaFactors.receipt(
            await context.session.authorized(TulaOperations.sendStepUpSmsCode, as: SmsFactorCode.self))
    }

    /// Step up with the code `sendSmsCode()` asked for.
    ///
    /// - Parameter code: The texted code, as the user typed it.
    /// - Throws: `TulaError`: `mfa.invalid_code` for a wrong or expired code, `rate_limited`
    ///   after repeated wrong ones.
    public func withSmsCode(_ code: String) async throws {
        try await context.session.stepUp(.smsCode(StepUpRequestSmsCode(code: code)))
    }

    /// Step up with a passkey: asks the API for the options, shows the system's sheet and
    /// proves what it returns.
    ///
    /// - Returns: `finished`, or `dismissed` when the user closed the sheet (nothing was sent
    ///   to be judged).
    /// - Throws: `TulaError`: `flow.busy`, `passkey.unsupported`, `passkey.failed`,
    ///   `auth.invalid_credentials` for an assertion the API refuses.
    @discardableResult
    public func withPasskey() async throws -> TulaCeremony<Bool> {
        try await context.gate.ceremony {
            try context.requirePasskeys()
            let options = try await context.session.authorized(
                TulaOperations.getStepUpPasskeyOptions, as: PasskeyRequestOptions.self)
            guard let credential = try await context.assertion(options) else {
                return .dismissed
            }
            try await context.session.stepUp(.passkey(StepUpRequestPasskey(credential: credential)))
            return .finished(true)
        }
    }
}

/// The signed-in user's passkeys (ADR 0027). Never key material: a name, whether it is
/// synced, and when it was added and last used.
public struct TulaPasskeys: Sendable, TulaRedacted {
    let context: FlowContext

    /// The user's passkeys, oldest first.
    public func list() async throws -> [Passkey] {
        try await context.session.authorized(TulaOperations.listMyPasskeys, as: PasskeyList.self).passkeys
    }

    /// Make a passkey on this device and register it.
    ///
    /// - Parameter name: A name for it, shown in the list. The server names it otherwise.
    /// - Returns: The passkey, or `dismissed` when the user closed the sheet: nothing was
    ///   registered.
    /// - Throws: `TulaError`: `flow.busy` while another sheet of the client is out,
    ///   `passkey.unsupported`, `passkey.already_on_device`, `passkey.failed`,
    ///   `auth.step_up_required`.
    public func add(name: String? = nil) async throws -> TulaCeremony<Passkey> {
        try await context.gate.ceremony {
            guard let sheet = context.passkeys else {
                throw TulaError.client(TulaClientErrorCode.passkeyUnsupported)
            }
            let options = try await context.session.authorized(
                TulaOperations.startPasskeyRegistration, as: PasskeyCreationOptions.self)
            guard PasskeyChecks.usable(options) else {
                throw TulaError.client(TulaClientErrorCode.responseInvalid)
            }
            guard let credential = try await context.gate.sheet(.passkey, { try await sheet.create(options) }) else {
                return .dismissed
            }
            guard PasskeyChecks.usable(credential) else {
                throw TulaError.client(TulaClientErrorCode.passkeyFailed)
            }
            let passkey = try await context.session.authorized(
                TulaOperations.finishPasskeyRegistration,
                body: PasskeyRegisterRequest(credential: credential, name: name), as: Passkey.self)
            guard !passkey.id.isEmpty else {
                throw TulaError.client(TulaClientErrorCode.responseInvalid)
            }
            return .finished(passkey)
        }
    }

    /// Give a passkey another name.
    public func rename(_ id: String, to name: String) async throws -> Passkey {
        try await context.session.authorized(
            TulaOperations.renamePasskey, params: ["passkeyId": id], body: PasskeyRenameRequest(name: name),
            as: Passkey.self)
    }

    /// Remove a passkey from the account. The last way to sign in cannot be removed
    /// (`passkey.last_sign_in_method`). The passkey stays on the device: the system's
    /// password settings remove it there.
    public func remove(_ id: String) async throws {
        _ = try await context.session.authorized(
            TulaOperations.removePasskey, params: ["passkeyId": id], as: NoAnswer.self)
    }
}

/// The signed-in user's second factor (ADR 0025): an authenticator app and its backup
/// codes, or, where the environment allows it and the user has nothing stronger, a texted
/// code.
///
/// A setup key, its URI and backup codes are returned once and kept nowhere in the client.
public struct TulaFactors: Sendable, TulaRedacted {
    let context: FlowContext

    /// Whether an authenticator app is confirmed, since when, and how many backup codes
    /// are unused. Never a secret.
    public func get() async throws -> Factors {
        try await context.session.authorized(TulaOperations.getMyFactors, as: Factors.self)
    }

    /// Start enrolling an authenticator app. It counts for nothing until confirmed, and
    /// lapses after ten minutes; calling it again replaces the pending secret.
    ///
    /// - Returns: The setup key and its `otpauth://` URI, once.
    public func startTotp() async throws -> TotpEnrolment {
        let enrolment = try await context.session.authorized(TulaOperations.startTotpEnrolment, as: TotpEnrolment.self)
        guard !enrolment.secret.isEmpty, enrolment.uri.hasPrefix("otpauth://") else {
            throw TulaError.client(TulaClientErrorCode.responseInvalid)
        }
        return enrolment
    }

    /// Confirm the authenticator app with a code it shows. The user's other sessions end.
    /// The client then refreshes this session, so that its next access token says the second
    /// factor was proven; when that refresh cannot be made the codes are returned all the
    /// same, and the next `getToken()` tries again.
    ///
    /// - Returns: The backup codes, once.
    /// - Throws: `TulaError`: `mfa.invalid_code`, `mfa.enrolment_expired`.
    public func confirmTotp(code: String) async throws -> [String] {
        let codes = try await TulaFactors.codes(
            context.session.authorized(
                TulaOperations.confirmTotpEnrolment, body: TotpConfirmRequest(code: code), as: BackupCodes.self))
        _ = try? await context.session.refresh()
        return codes
    }

    /// Turn two-step verification off: removes the authenticator and every backup code.
    ///
    /// - Throws: `TulaError`: `mfa.not_enabled`, `mfa.required_by_policy`,
    ///   `auth.step_up_required`.
    public func disableTotp() async throws {
        _ = try await context.session.authorized(TulaOperations.disableTotp, as: NoAnswer.self)
    }

    /// Replace the user's backup codes. The earlier ones stop working.
    ///
    /// - Returns: The new codes, once.
    public func regenerateBackupCodes() async throws -> [String] {
        try await TulaFactors.codes(
            context.session.authorized(TulaOperations.regenerateBackupCodes, as: BackupCodes.self))
    }

    /// Text a code to the account's proven phone number, to make a texted code the second
    /// factor. Offered where the environment switched it on, to a user with a proven number
    /// and no authenticator app or passkey (`get().sms?.available`). A new call replaces
    /// the earlier code.
    ///
    /// - Returns: The masked number and when the code stops working. Never the code.
    /// - Throws: `TulaError`: `auth.method_disabled` where the environment has not switched
    ///   it on, `mfa.phone_number_required` for an account with no proven number,
    ///   `mfa.sms_not_allowed` for a user who has an authenticator app or a passkey,
    ///   `auth.step_up_required`, `sms.disabled`, `sms.country_not_allowed` or
    ///   `sms.unavailable` when the message cannot be sent, `rate_limited`.
    public func startSms() async throws -> SmsFactorCode {
        try TulaFactors.receipt(
            await context.session.authorized(TulaOperations.startSmsFactorEnrolment, as: SmsFactorCode.self))
    }

    /// Confirm the texted code `startSms()` asked for: a texted code is then the account's
    /// second factor. As after `confirmTotp`, the client refreshes this session so that its
    /// next access token says what was proven; when that refresh cannot be made the answer
    /// is returned all the same, and the next `getToken()` tries again.
    ///
    /// - Parameter code: The texted code, as the user typed it.
    /// - Returns: The account's factors as they are now.
    /// - Throws: `TulaError`: `mfa.invalid_code` for a wrong or expired code, `rate_limited`
    ///   after repeated wrong ones, and what `startSms()` refuses with.
    public func confirmSms(code: String) async throws -> Factors {
        let factors = try await context.session.authorized(
            TulaOperations.confirmSmsFactorEnrolment, body: SmsFactorConfirmRequest(code: code), as: Factors.self)
        _ = try? await context.session.refresh()
        return factors
    }

    /// Stop using a texted code as the second factor. The phone number stays on the account.
    ///
    /// - Throws: `TulaError`: `mfa.not_enabled`, `mfa.required_by_policy`,
    ///   `auth.step_up_required`.
    public func disableSms() async throws {
        _ = try await context.session.authorized(TulaOperations.disableSmsFactor, as: NoAnswer.self)
    }

    private static func codes(_ answer: BackupCodes) throws -> [String] {
        guard !answer.codes.isEmpty, !answer.codes.contains(where: \.isEmpty) else {
            throw TulaError.client(TulaClientErrorCode.responseInvalid)
        }
        return answer.codes
    }

    /// The receipt of a texted code, checked before it is handed on: a 200 that names
    /// another method, no destination or no expiry is not one.
    static func receipt(_ sent: SmsFactorCode) throws -> SmsFactorCode {
        guard sent.method == "sms_code", !sent.destination.isEmpty, !sent.expiresAt.isEmpty else {
            throw TulaError.client(TulaClientErrorCode.responseInvalid)
        }
        return sent
    }
}

/// The signed-in user's phone number (ADR 0037): one, optional, proven with a code sent by
/// text message. Whether a number can be added at all is `phone.enabled` of the client
/// configuration; the number itself is `phoneNumber` of the user.
///
/// The number is personal data: the client keeps it only as part of the session's user, and
/// puts neither it nor a code in an error.
public struct TulaPhone: Sendable, TulaRedacted {
    let context: FlowContext

    /// Text a code to a number, to add it to the account (or replace the one it has). The
    /// number is on the account only once `verify(code:)` proved it.
    ///
    /// - Parameter phoneNumber: The number with its country code, such as `+14155550142`.
    /// - Returns: The masked number and when the code stops working. Never the code.
    /// - Throws: `TulaError`: `phone.invalid` for what is not a phone number, `sms.disabled`
    ///   where the application sends no text messages, `sms.country_not_allowed` for a
    ///   number of a country it does not send to, `sms.unavailable` when the message could
    ///   not be sent, `rate_limited`, `auth.step_up_required`.
    public func request(phoneNumber: String) async throws -> PhoneCodeSent {
        let sent = try await context.session.authorized(
            TulaOperations.requestPhoneCode, body: PhoneNumberRequest(phoneNumber: phoneNumber),
            as: PhoneCodeSent.self)
        guard !sent.destination.isEmpty, !sent.expiresAt.isEmpty else {
            throw TulaError.client(TulaClientErrorCode.responseInvalid)
        }
        return sent
    }

    /// Prove the number with the code `request(phoneNumber:)` asked for. The session's state
    /// is given the answer, when the session that asked is still the one signed in.
    ///
    /// - Parameter code: The texted code, as the user typed it.
    /// - Returns: The user, now with the number and when it was proven.
    /// - Throws: `TulaError`: `verification.invalid_code` for a wrong or expired code,
    ///   `rate_limited` after repeated wrong ones, `sms.disabled` or
    ///   `sms.country_not_allowed` when the setting changed meanwhile,
    ///   `auth.step_up_required`.
    public func verify(code: String) async throws -> CurrentUser {
        let asked = try await context.session.settledSessionId()
        let user = try await context.session.authorized(
            TulaOperations.verifyPhoneNumber, body: PhoneNumberVerifyRequest(code: code), as: CurrentUser.self)
        await context.session.setUser(askedBy: asked) { _ in user }
        return user
    }

    /// Take the phone number off the account. Nothing happens when it has none. The
    /// session's user is corrected without asking the server again.
    ///
    /// - Throws: `TulaError`: `auth.step_up_required`.
    public func remove() async throws {
        let asked = try await context.session.settledSessionId()
        _ = try await context.session.authorized(TulaOperations.removePhoneNumber, as: NoAnswer.self)
        await context.session.setUser(askedBy: asked) { held in
            guard var user = held else {
                return nil
            }
            user.phoneNumber = nil
            user.phoneNumberVerifiedAt = nil
            return user
        }
    }
}

/// The provider accounts the signed-in user signs in with (ADR 0026).
public struct TulaIdentities: Sendable, TulaRedacted {
    let context: FlowContext

    /// The user's connected accounts: a provider and when it was connected. Never a
    /// provider's token.
    public func list() async throws -> [Identity] {
        try await context.session.authorized(TulaOperations.listMyIdentities, as: IdentityList.self).data
    }

    /// Connect a provider account, through the system's browser session.
    ///
    /// - Parameters:
    ///   - provider: The provider.
    ///   - redirectURL: Where the API sends the browser back to; one of the environment's
    ///     allowed redirect URLs. The server judges it, never the client. (A link start is
    ///     a `web` attempt to the server: it takes an app link, and refuses a custom scheme
    ///     with `request.redirect_not_allowed`.)
    /// - Returns: `linked`, `cancelled` or `refused`.
    public func link(_ provider: OAuthProvider, redirectURL: String) async throws -> ProviderOutcome {
        try await context.providerRoundTrip(.link, provider: provider, redirectURL: redirectURL)
    }

    /// Disconnect a provider account. The last way to sign in cannot be removed.
    public func unlink(_ id: String) async throws {
        _ = try await context.session.authorized(
            TulaOperations.deleteMyIdentity, params: ["identityId": id], as: NoAnswer.self)
    }
}

/// An email address for a signed-in user whose account has none (ADR 0059): one made by a
/// first sign-in with a provider that gives no address (X, Facebook).
///
/// Only for an account with **no** address: once it has one both calls answer
/// `email.already_set`. Both need a recent authentication. An account with no address has
/// no password and no emailed code to step up with, so an `auth.step_up_required` here may
/// list no method at all (`TulaError.stepUpMethods` is empty): the user then signs in again
/// with their provider and repeats the call.
public struct TulaEmailAddress: Sendable, TulaRedacted {
    let context: FlowContext

    /// Ask for a code to be emailed to an address. Nothing is on the account until
    /// `verify(code:)`; asking again replaces the pending address.
    ///
    /// An address another account holds is answered exactly like a free one: the answer
    /// does not say which, and no code then confirms it.
    ///
    /// - Returns: The masked address and when the code stops working. Never the code.
    /// - Throws: `TulaError`: `email.invalid`, `email.already_set`, `rate_limited`,
    ///   `auth.step_up_required`.
    public func request(_ email: String) async throws -> EmailCodeSent {
        let sent = try await context.session.authorized(
            TulaOperations.requestEmailAddressCode, body: EmailAddressRequest(email: email), as: EmailCodeSent.self)
        guard !sent.destination.isEmpty, !sent.expiresAt.isEmpty else {
            throw TulaError.client(TulaClientErrorCode.responseInvalid)
        }
        return sent
    }

    /// Confirm the pending address with the code that was emailed to it. The account then
    /// has the address, verified, and the session's state is given the user.
    ///
    /// - Returns: The user, with the address.
    /// - Throws: `TulaError`: `verification.invalid_code`, `verification.expired`,
    ///   `email.already_set`, `auth.step_up_required`.
    public func verify(code: String) async throws -> CurrentUser {
        let user = try await context.session.authorized(
            TulaOperations.verifyEmailAddress, body: EmailAddressVerifyRequest(code: code), as: CurrentUser.self)
        await context.session.setUser(user)
        return user
    }
}
