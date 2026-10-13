import Foundation
import XCTest

@testable import TulaAuth

// The Swift client against the real API: the second step of a sign-in (an authenticator
// app's code, a backup code), enrolling inside a sign-in, and stepping a session up before a
// sensitive change (ADR 0025).
final class SecondStepJourneys: JourneyTestCase {
    private func stepUps(_ s: Server) async throws -> [Exchange] {
        try await s.exchanges("/v1/client/sessions/step-up")
    }

    func testTwoStepEnrolmentAndSignIn() async throws {
        try await journey(
            "two-step enrolment and sign-in",
            "two-step verification: enrol an authenticator, then sign in with the password and its code"
        ) { s in
            let (app, email) = try await s.signUp()
            var factors = try await app.tula.factors.get()
            XCTAssertEqual(factors.totp, FactorsTotp(enabled: false, confirmedAt: nil))
            XCTAssertEqual(factors.backupCodes.remaining, 0)
            XCTAssertEqual(factors.sms?.enabled, false)

            let enrolment = try await app.tula.factors.startTotp()
            let secret = enrolment.secret
            XCTAssertEqual(secret.count, 32)
            XCTAssertTrue(secret.allSatisfy { "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".contains($0) })
            XCTAssertTrue(enrolment.uri.hasPrefix("otpauth://totp/"))
            XCTAssertTrue(enrolment.uri.contains("secret=\(secret)"))
            factors = try await app.tula.factors.get()
            XCTAssertFalse(factors.totp.enabled)

            let wrong = try await s.wrongTotp(secret)
            let refused = try await caught { try await app.tula.factors.confirmTotp(code: wrong) }
            XCTAssertEqual(refused.code, "mfa.invalid_code")
            XCTAssertEqual(refused.status, 422)
            let before = try await s.refreshes().count
            let right = try await s.totp(secret)
            let codes = try await app.tula.factors.confirmTotp(code: right)
            XCTAssertEqual(codes.count, 10)
            XCTAssertTrue(codes.allSatisfy(Journey.isBackupCode))
            // The session's token is replaced at once, so that it says what was just proven.
            let after = try await s.refreshes().count
            XCTAssertEqual(after, before + 1)
            var amr = try await app.amr()
            XCTAssertTrue(amr.contains("mfa"))
            var state = await app.state()
            XCTAssertTrue(state.isSignedIn)
            factors = try await app.tula.factors.get()
            XCTAssertTrue(factors.totp.enabled)
            XCTAssertEqual(factors.backupCodes.remaining, 10)
            // Nothing of the enrolment is kept by the client.
            let visible = String(reflecting: app.tula) + String(reflecting: state)
            for hidden in [secret] + codes {
                XCTAssertFalse(visible.contains(hidden))
            }

            try await s.advance(Totp.step)
            let second = try await s.atSecondFactor(email)
            XCTAssertEqual(second.flow.screen, .secondFactor(FlowStepNeedsSecondFactor(options: [.totp, .backupCode])))
            let code = try await s.totp(secret)
            let step = try await second.flow.submitTotp(code)
            XCTAssertEqual(step.status, "complete")
            state = await second.app.state()
            XCTAssertEqual(state.user?.email, email)
            amr = try await second.app.amr()
            XCTAssertTrue(amr.isSuperset(of: ["pwd", "otp", "mfa"]))
            factors = try await second.app.tula.factors.get()
            XCTAssertEqual(factors.backupCodes.remaining, 10)
        }
    }

    func testSecondFactorLockout() async throws {
        try await journey(
            "second factor lockout",
            "second factor lockout: six wrong codes, then every try is rate_limited, for the user and not the attempt"
        ) { s in
            let user = try await s.enrolled()
            let first = try await s.atSecondFactor(user.email)
            let wrong = try await s.wrongTotp(user.secret)
            for _ in 0..<6 {
                let error = try await caught { try await first.flow.submitTotp(wrong) }
                XCTAssertEqual(error.code, "mfa.invalid_code")
                XCTAssertEqual(error.status, 422)
            }
            let locked = try await caught { try await first.flow.submitTotp(wrong) }
            XCTAssertEqual(locked.code, "rate_limited")
            XCTAssertEqual(locked.status, 429)
            XCTAssertGreaterThan(locked.retryAfter ?? 0, 0)
            // The lock is the user's: a backup code is refused too.
            let backup = try await caught { try await first.flow.submitBackupCode(user.codes[0]) }
            XCTAssertEqual(backup.code, "rate_limited")
            XCTAssertEqual(first.flow.step.status, "needs_second_factor")

            // And another attempt of the same user, with the right code.
            let again = try await s.atSecondFactor(user.email)
            let right = try await s.totp(user.secret)
            let still = try await caught { try await again.flow.submitTotp(right) }
            XCTAssertEqual(still.code, "rate_limited")
            XCTAssertEqual(still.status, 429)
            var state = await again.app.state()
            XCTAssertFalse(state.isSignedIn)
            state = await first.app.state()
            XCTAssertFalse(state.isSignedIn)
        }
    }

    func testAuthenticatorCodeReplay() async throws {
        try await journey(
            "authenticator code replay",
            "an authenticator code is accepted once: not after it confirmed the enrolment, and not on a second sign-in"
        ) { s in
            let (app, email) = try await s.signUp()
            let secret = try await app.tula.factors.startTotp().secret
            let confirming = try await s.totp(secret)
            _ = try await app.tula.factors.confirmTotp(code: confirming)

            let first = try await s.atSecondFactor(email)
            var replayed = try await caught { try await first.flow.submitTotp(confirming) }
            XCTAssertEqual(replayed.code, "mfa.invalid_code")
            XCTAssertEqual(replayed.status, 422)
            var state = await first.app.state()
            XCTAssertFalse(state.isSignedIn)

            try await s.advance(Totp.step)
            let next = try await s.totp(secret)
            let step = try await first.flow.submitTotp(next)
            XCTAssertEqual(step.status, "complete")
            state = await first.app.state()
            XCTAssertTrue(state.isSignedIn)

            let second = try await s.atSecondFactor(email)
            replayed = try await caught { try await second.flow.submitTotp(next) }
            XCTAssertEqual(replayed.code, "mfa.invalid_code")
            state = await second.app.state()
            XCTAssertFalse(state.isSignedIn)
        }
    }

    func testBackupCodes() async throws {
        try await journey(
            "backup codes",
            "backup codes: each works once and says how many are left; a new set replaces the old one"
        ) { s in
            let user = try await s.enrolled()
            let codes = user.codes
            let unknown = Journey.unknownBackupCode(codes)

            let first = try await s.atSecondFactor(user.email)
            var refused = try await caught { try await first.flow.submitBackupCode(unknown) }
            XCTAssertEqual(refused.code, "mfa.invalid_code")
            XCTAssertEqual(refused.status, 422)
            var used = try await first.flow.submitBackupCode("  \(codes[0])  ")
            XCTAssertEqual(used.step.status, "complete")
            XCTAssertEqual(used.remaining, 9)
            var state = await first.app.state()
            XCTAssertTrue(state.isSignedIn)
            var factors = try await first.app.tula.factors.get()
            XCTAssertEqual(factors.backupCodes.remaining, 9)
            XCTAssertFalse(String(reflecting: first.flow).contains(codes[0]))

            let second = try await s.atSecondFactor(user.email)
            refused = try await caught { try await second.flow.submitBackupCode(codes[0]) }
            XCTAssertEqual(refused.code, "mfa.invalid_code")
            used = try await second.flow.submitBackupCode(codes[1])
            XCTAssertEqual(used.step.status, "complete")
            XCTAssertEqual(used.remaining, 8)

            // The session has just proven its second factor, so it may ask for a new set.
            let fresh = try await second.app.tula.factors.regenerateBackupCodes()
            XCTAssertEqual(fresh.count, 10)
            XCTAssertTrue(Set(fresh).isDisjoint(with: codes))
            factors = try await second.app.tula.factors.get()
            XCTAssertEqual(factors.backupCodes.remaining, 10)

            let third = try await s.atSecondFactor(user.email)
            refused = try await caught { try await third.flow.submitBackupCode(codes[2]) }
            XCTAssertEqual(refused.code, "mfa.invalid_code")
            used = try await third.flow.submitBackupCode(fresh[0])
            XCTAssertEqual(used.step.status, "complete")
            XCTAssertEqual(used.remaining, 9)
            state = await third.app.state()
            XCTAssertTrue(state.isSignedIn)
        }
    }

    func testPasswordResetWithASecondFactor() async throws {
        try await journey(
            "password reset with a second factor",
            "a password reset stops at the second factor: no session until the authenticator's code"
        ) { s in
            let before = try await s.enrolled()
            // Past the one-email-a-minute limit for the address, which the sign-up used.
            try await s.advance(61)
            let app = try s.client()
            let flow = try await app.tula.startPasswordReset(email: before.email)
            let code = try await s.code(before.email)
            let step = try await flow.submit(code: code, password: Journey.newPassword)
            XCTAssertEqual(step, .needsSecondFactor(FlowStepNeedsSecondFactor(options: [.totp, .backupCode])))
            var state = await app.state()
            XCTAssertFalse(state.isSignedIn)

            let wrong = try await s.wrongTotp(before.secret)
            let refused = try await caught { try await flow.submitTotp(wrong) }
            XCTAssertEqual(refused.code, "mfa.invalid_code")
            XCTAssertEqual(refused.status, 422)
            XCTAssertEqual(flow.step.status, "needs_second_factor")

            let right = try await s.totp(before.secret)
            let done = try await flow.submitTotp(right)
            XCTAssertEqual(done.status, "complete")
            state = await app.state()
            XCTAssertEqual(state.user?.email, before.email)

            // The password was stored before the second factor was asked for: every session
            // from before the reset is over, and the next sign-in takes the new password.
            let token = try await before.app.session.refresh()
            XCTAssertNil(token)
            state = await before.app.state()
            XCTAssertEqual(state, .signedOut)
            try await s.advance(Totp.step)
            _ = try await s.atSecondFactor(before.email, password: Journey.newPassword)
        }
    }

    func testStepUp() async throws {
        try await journey(
            "step-up",
            "step-up: a sensitive call says what to prove; a step-up installs a fresh token for the same session, and the repeated call succeeds"
        ) { s in
            let (app, _) = try await s.signUp()
            let sessionId = await app.state().sessionId

            let wrongPassword = try await caught { try await app.tula.stepUp.withPassword("wrong-password-1") }
            XCTAssertEqual(wrongPassword.code, "auth.invalid_credentials")
            XCTAssertEqual(wrongPassword.status, 401)
            var state = await app.state()
            XCTAssertTrue(state.isSignedIn)
            let tokenBefore = try await app.session.getToken()
            let stored = await app.storage.get(s.storageKey)
            try await s.advance(1)
            try await app.tula.stepUp.withPassword(Journey.password)
            let tokenAfter = try await app.session.getToken()
            XCTAssertNotEqual(tokenAfter, tokenBefore)
            state = await app.state()
            XCTAssertEqual(state.sessionId, sessionId)
            var amr = try await app.amr()
            XCTAssertTrue(amr.contains("pwd"))
            // The same session: no new refresh token, and no refresh.
            var sent = try await self.stepUps(s)
            XCTAssertEqual(sent.last?.status, 200)
            XCTAssertFalse(sent.last?.responseBody.contains("refreshToken") == true)
            let kept = await app.storage.get(s.storageKey)
            XCTAssertEqual(kept, stored)
            var refreshes = try await s.refreshes().count
            XCTAssertEqual(refreshes, 0)
            let statuses = await app.statuses()
            XCTAssertEqual(statuses, ["signed-in"])

            // A factor the user does not have: the server says what they can prove.
            let noFactor = try await caught { try await app.tula.stepUp.withTotp("123456") }
            XCTAssertEqual(noFactor.code, "auth.step_up_required")
            XCTAssertEqual(noFactor.stepUpMethods, ["password", "email_code"])

            let secret = try await app.tula.factors.startTotp().secret
            let confirming = try await s.totp(secret)
            let codes = try await app.tula.factors.confirmTotp(code: confirming)
            let factors = try await app.tula.factors.get()
            XCTAssertEqual(factors.backupCodes.remaining, 10)

            // Past the window, every sensitive call names the second factor and nothing else.
            try await s.advance(11 * 60)
            let regenerate = try await caught { try await app.tula.factors.regenerateBackupCodes() }
            let disable = try await caught { try await app.tula.factors.disableTotp() }
            let change = try await caught {
                try await app.tula.changePassword(current: Journey.password, new: Journey.newPassword)
            }
            for refused in [regenerate, disable, change] {
                XCTAssertEqual(refused.code, "auth.step_up_required")
                XCTAssertEqual(refused.status, 403)
                XCTAssertEqual(refused.stepUpMethods, ["totp", "backup_code"])
            }
            let asked = try await self.stepUps(s).count

            // The password alone is not a step-up for a user with a second factor.
            let passwordOnly = try await caught { try await app.tula.stepUp.withPassword(Journey.password) }
            XCTAssertEqual(passwordOnly.stepUpMethods, ["totp", "backup_code"])
            let unknown = Journey.unknownBackupCode(codes)
            let badCode = try await caught { try await app.tula.stepUp.withBackupCode(unknown) }
            XCTAssertEqual(badCode.code, "mfa.invalid_code")
            XCTAssertEqual(badCode.status, 422)
            sent = try await self.stepUps(s)
            XCTAssertEqual(sent.count, asked + 2)

            refreshes = try await s.refreshes().count
            try await app.tula.stepUp.withBackupCode(codes[0])
            let refreshesAfter = try await s.refreshes().count
            XCTAssertEqual(refreshesAfter, refreshes)
            amr = try await app.amr()
            XCTAssertTrue(amr.isSuperset(of: ["backup_code", "mfa"]))
            state = await app.state()
            XCTAssertEqual(state.sessionId, sessionId)

            let fresh = try await app.tula.factors.regenerateBackupCodes()
            XCTAssertEqual(fresh.count, 10)
            // What the session has proven is the session's, not one token's.
            _ = try await app.session.refresh()
            amr = try await app.amr()
            XCTAssertTrue(amr.contains("mfa"))
            try await app.tula.changePassword(current: Journey.password, new: Journey.newPassword)
            state = await app.state()
            XCTAssertTrue(state.isSignedIn)
        }
    }

    func testStepUpWindowPerProfile() async throws {
        try await journey(
            "step-up window per profile",
            "a sensitive call past the profile's window asks for a step-up, and works again after it"
        ) { s in
            try await s.settings([
                "sessions": ["profiles": ["mobile": ["accessTokenTtl": "5m", "stepUpAfter": "1m"]]]
            ])
            let (app, _) = try await s.signUp()
            _ = try await app.tula.factors.startTotp()
            try await s.advance(61)
            let error = try await caught { try await app.tula.factors.startTotp() }
            XCTAssertEqual(error.code, "auth.step_up_required")
            XCTAssertTrue(error.stepUpMethods.contains("password"))
            // A call that is not sensitive still works.
            let user = try await app.tula.user()
            XCTAssertFalse(user.id.isEmpty)
            try await app.tula.stepUp.withPassword(Journey.password)
            let enrolment = try await app.tula.factors.startTotp()
            XCTAssertFalse(enrolment.secret.isEmpty)
        }
    }

    func testStepUpByEmailedCode() async throws {
        try await journey(
            "step-up by emailed code",
            "step-up by email: a user with no password asks for a code, proves it and repeats the sensitive call; with a second factor the code is gone"
        ) { s in
            let s = try await self.server(oauth: true)
            try await s.provider("google")
            let email = s.freshEmail()
            let (outcome, app, _) = try await s.continueWith(.google, ["email": email])
            XCTAssertEqual(outcome.word, "signed_in")
            let user = try await app.tula.user()
            XCTAssertFalse(user.hasPassword)
            let sessionId = await app.state().sessionId
            let sends = { try await s.exchanges("/v1/client/sessions/step-up/email-code") }

            try await s.advance(11 * 60)
            let refused = try await caught { try await app.tula.factors.startTotp() }
            XCTAssertEqual(refused.code, "auth.step_up_required")
            XCTAssertEqual(refused.stepUpMethods, ["email_code"])
            var sent = try await sends()
            XCTAssertEqual(sent.count, 0)

            let receipt = try await app.tula.stepUp.sendEmailCode()
            XCTAssertEqual(receipt.method, "email_code")
            XCTAssertTrue(receipt.destination.dropFirst().hasPrefix("***@"))
            XCTAssertFalse(receipt.expiresAt.isEmpty)
            let code = try await s.code(email)
            sent = try await sends()
            XCTAssertFalse(sent.last?.responseBody.contains(code) == true)
            let again = try await caught { try await app.tula.stepUp.sendEmailCode() }
            XCTAssertEqual(again.code, "rate_limited")
            XCTAssertEqual(again.status, 429)
            XCTAssertNotNil(again.retryAfter)

            let wrong = try await caught {
                try await app.tula.stepUp.withEmailCode(code == "000000" ? "111111" : "000000")
            }
            XCTAssertEqual(wrong.code, "verification.invalid_code")
            XCTAssertEqual(wrong.status, 422)
            let stored = await app.storage.get(s.storageKey)
            try await app.tula.stepUp.withEmailCode(code)
            let state = await app.state()
            XCTAssertEqual(state.sessionId, sessionId)
            let amr = try await app.amr()
            XCTAssertEqual(amr, ["fed", "email"])
            let kept = await app.storage.get(s.storageKey)
            XCTAssertEqual(kept, stored)
            let spent = try await caught { try await app.tula.stepUp.withEmailCode(code) }
            XCTAssertEqual(spent.code, "verification.expired")
            XCTAssertEqual(spent.status, 410)

            // With a second factor an emailed code is no step-up any more.
            let secret = try await app.tula.factors.startTotp().secret
            let confirming = try await s.totp(secret)
            _ = try await app.tula.factors.confirmTotp(code: confirming)
            let gone = try await caught { try await app.tula.stepUp.sendEmailCode() }
            XCTAssertEqual(gone.stepUpMethods, ["totp", "backup_code"])
            let late = try await caught { try await app.tula.stepUp.withEmailCode(code) }
            XCTAssertEqual(late.stepUpMethods, ["totp", "backup_code"])
        }
    }

    func testAdminSecondFactorReset() async throws {
        try await journey(
            "admin second factor reset",
            "an admin resets a user's second factor: their sessions end at once, and the next sign-in needs the password alone"
        ) { s in
            let user = try await s.enrolled()
            let userId = try unwrap(await user.app.state().user?.id)
            let reset = try await s.admin("DELETE", "/v1/admin/users/\(userId)/factors")
            XCTAssertEqual(reset.status, 204)

            let refused = try await caught { try await user.app.tula.factors.get() }
            XCTAssertEqual(refused.status, 401)
            let state = await user.app.state()
            XCTAssertEqual(state, .signedOut)
            let statuses = await user.app.statuses()
            XCTAssertEqual(statuses.last, "signed-out")
            XCTAssertEqual(statuses.filter { $0 == "signed-out" }.count, 1)

            let again = try await s.signIn(user.email)
            XCTAssertEqual(again.step.status, "complete")
            let factors = try await again.app.tula.factors.get()
            XCTAssertEqual(factors.totp, FactorsTotp(enabled: false, confirmedAt: nil))
            XCTAssertEqual(factors.backupCodes.remaining, 0)
        }
    }

    func testRequiredSecondFactor() async throws {
        try await journey(
            "required second factor",
            "policy required: sign-in and sign-up stop at the enrolment and complete with backup codes; the factor cannot be turned off"
        ) { s in
            let (existing, email) = try await s.signUp()
            var config = try await existing.tula.config()
            XCTAssertEqual(config.mfa?.policy, .optional)
            let saved = try await s.admin(
                "PUT", "/v1/admin/settings", ["mfa": ["policy": "required"]], headers: ["if-match": "\"0\""])
            XCTAssertEqual(saved.status, 200)
            config = try await existing.tula.config(force: true)
            XCTAssertEqual(config.mfa?.policy, .required)

            let (app, flow, step) = try await s.signIn(email)
            XCTAssertEqual(step, .needsFactorEnrolment(FlowStepNeedsFactorEnrolment(methods: [.totp])))
            XCTAssertEqual(flow.screen, .factorEnrolment(FlowStepNeedsFactorEnrolment(methods: [.totp])))
            var state = await app.state()
            XCTAssertFalse(state.isSignedIn)
            let enrolment = try await flow.startTotpEnrolment()
            let secret = enrolment.secret
            XCTAssertEqual(secret.count, 32)
            XCTAssertTrue(enrolment.uri.hasPrefix("otpauth://totp/"))
            XCTAssertEqual(flow.step.status, "needs_factor_enrolment")
            let wrong = try await s.wrongTotp(secret)
            let refused = try await caught { try await flow.confirmTotpEnrolment(code: wrong) }
            XCTAssertEqual(refused.code, "mfa.invalid_code")
            XCTAssertEqual(refused.status, 422)
            state = await app.state()
            XCTAssertFalse(state.isSignedIn)

            let right = try await s.totp(secret)
            let result = try await flow.confirmTotpEnrolment(code: right)
            XCTAssertEqual(result.step.status, "complete")
            XCTAssertNil(result.failure)
            XCTAssertEqual(result.backupCodes.count, 10)
            XCTAssertTrue(result.backupCodes.allSatisfy(Journey.isBackupCode))
            state = await app.state()
            XCTAssertEqual(state.user?.email, email)
            let amr = try await app.amr()
            XCTAssertTrue(amr.contains("mfa"))
            // The codes are in the result the app was handed, and nowhere the client keeps.
            let visible =
                String(reflecting: flow) + String(reflecting: app.tula) + String(reflecting: state)
                + String(describing: result)
            for hidden in [secret] + result.backupCodes {
                XCTAssertFalse(visible.contains(hidden))
            }

            let disable = try await caught { try await app.tula.factors.disableTotp() }
            XCTAssertEqual(disable.code, "mfa.required_by_policy")
            XCTAssertEqual(disable.status, 403)
            let factors = try await app.tula.factors.get()
            XCTAssertTrue(factors.totp.enabled)
            XCTAssertEqual(factors.backupCodes.remaining, 10)

            // A sign-up meets the same step after its address is verified.
            let newcomer = try s.client()
            let newcomerEmail = s.freshEmail()
            let signUp = try await newcomer.tula.startSignUp(email: newcomerEmail, password: Journey.password)
            let verified = try await signUp.verifyEmail(code: try await s.code(newcomerEmail))
            XCTAssertEqual(verified, .needsFactorEnrolment(FlowStepNeedsFactorEnrolment(methods: [.totp])))
            state = await newcomer.state()
            XCTAssertFalse(state.isSignedIn)
            let theirs = try await signUp.startTotpEnrolment()
            let theirCode = try await s.totp(theirs.secret)
            let joined = try await signUp.confirmTotpEnrolment(code: theirCode)
            XCTAssertEqual(joined.step.status, "complete")
            XCTAssertEqual(joined.backupCodes.count, 10)
            state = await newcomer.state()
            XCTAssertEqual(state.user?.email, newcomerEmail)

            try await s.advance(Totp.step)
            let next = try await s.atSecondFactor(email)
            let used = try await next.flow.submitBackupCode(result.backupCodes[0])
            XCTAssertEqual(used.step.status, "complete")
            XCTAssertEqual(used.remaining, 9)
        }
    }
}
