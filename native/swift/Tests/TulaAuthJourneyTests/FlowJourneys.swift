import Foundation
import XCTest

@testable import TulaAuth

// The Swift client against the real API: the flows. Each test is the `swift` column's
// `journey` for the conformance scenario it names (conformance/client-journeys.json), and
// follows the journey of the same name in apps/api/src/testing/sdk-journeys.ts.
final class FlowJourneys: JourneyTestCase {
    // MARK: Sign-up and sign-in

    func testSignUp() async throws {
        try await journey(
            "sign-up",
            "sign-up: start, verify the emailed code, signed in with a user"
        ) { s in
            let app = try s.client()
            let email = s.freshEmail()
            var state = await app.state()
            XCTAssertEqual(state, .loading)

            let flow = try await app.tula.startSignUp(email: email, password: Journey.password, firstName: "Maya")
            XCTAssertEqual(flow.kind, .signUp)
            guard case .emailVerification(let asked) = flow.screen else {
                return XCTFail("not waiting for the emailed code")
            }
            XCTAssertEqual(asked.strategies, [.emailCode])
            state = await app.state()
            XCTAssertEqual(state, .loading)

            let step = try await flow.verifyEmail(code: try await s.code(email))
            XCTAssertEqual(step.status, "complete")
            XCTAssertEqual(flow.screen, .complete)
            state = await app.state()
            XCTAssertEqual(state.user?.email, email)
            XCTAssertEqual(state.user?.firstName, "Maya")
            XCTAssertNil(state.user?.bannedAt)
            let statuses = await app.statuses()
            XCTAssertEqual(statuses, ["signed-in"])
            let user = try await app.tula.user()
            XCTAssertNotNil(user.emailVerifiedAt)
            let token = try await app.session.getToken()
            XCTAssertEqual(token?.split(separator: ".").count, 3)
        }
    }

    func testSignIn() async throws {
        try await journey(
            "sign-in",
            "sign-in: password completes it; a wrong password is the generic error"
        ) { s in
            let (_, email) = try await s.signUp()

            let wrong = try s.client()
            let failing = try await wrong.tula.startSignIn(identifier: email)
            XCTAssertEqual(failing.screen, .password)
            let error = try await caught { try await failing.submitPassword("not-the-password-123") }
            XCTAssertEqual(error.code, "auth.invalid_credentials")
            XCTAssertEqual(error.known, .authInvalidCredentials)
            XCTAssertEqual(error.status, 401)
            XCTAssertEqual(error.message, "The email or password is incorrect.")
            var state = await wrong.state()
            XCTAssertEqual(state, .loading)
            // The same attempt can still be completed with the right password.
            let step = try await failing.submitPassword(Journey.password)
            XCTAssertEqual(step.status, "complete")
            state = await wrong.state()
            XCTAssertTrue(state.isSignedIn)

            // An address with no account gets the same first step and the same error.
            let unknown = try s.client()
            let ghost = try await unknown.tula.startSignIn(identifier: "nobody@example.com")
            XCTAssertEqual(ghost.screen, .password)
            let same = try await caught { try await ghost.submitPassword(Journey.password) }
            XCTAssertEqual(same.code, "auth.invalid_credentials")
        }
    }

    // MARK: Hooks

    func testSignUpDeniedByAHook() async throws {
        try await journey(
            "sign-up denied by a hook",
            "sign-up denied by a hook: the client gets the operator's code, stays signed out, and can start again"
        ) { s in
            let app = try s.client()
            let email = s.freshEmail()
            let hook = try await s.hook("before_sign_up", answer: ["decision": "deny", "code": "disposable_email"])

            let flow = try await app.tula.startSignUp(email: email, password: Journey.password)
            XCTAssertEqual(flow.step.status, "needs_email_verification")
            var asked = try await s.asked()
            XCTAssertEqual(asked, [0])

            let code = try await s.code(email)
            let error = try await caught { try await flow.verifyEmail(code: code) }
            XCTAssertEqual(error.code, "hook.denied")
            XCTAssertEqual(error.status, 403)
            XCTAssertEqual(error.params, ["code": .string("disposable_email")])
            XCTAssertEqual(error.message, "This was not allowed.")
            asked = try await s.asked()
            XCTAssertEqual(asked, [1])
            var state = await app.state()
            XCTAssertFalse(state.isSignedIn)
            let token = try await app.session.getToken()
            XCTAssertNil(token)

            // The attempt has ended on the server: the flow the client holds is spent.
            let spent = try await caught { try await flow.verifyEmail(code: code) }
            XCTAssertEqual(spent.code, "flow.not_found")
            try await s.setHook(hook, answer: ["decision": "allow"])
            let other = s.freshEmail()
            let again = try await app.tula.startSignUp(email: other, password: Journey.password)
            let step = try await again.verifyEmail(code: try await s.code(other))
            XCTAssertEqual(step.status, "complete")
            state = await app.state()
            XCTAssertTrue(state.isSignedIn)
        }
    }

    func testHookThatTimesOut() async throws {
        try await journey(
            "hook that times out",
            "hook that times out: the client is told to try again later, not that it was refused"
        ) { s in
            let app = try s.client()
            let email = s.freshEmail()
            _ = try await s.hook("before_sign_up", answer: nil, deadlineMs: 100)
            let flow = try await app.tula.startSignUp(email: email, password: Journey.password)
            let code = try await s.code(email)
            let started = Date()
            let error = try await caught { try await flow.verifyEmail(code: code) }
            // The hook's deadline is 100 ms: bounded well inside the request's own.
            XCTAssertLessThan(Date().timeIntervalSince(started), 3)
            XCTAssertEqual(error.code, "hook.unavailable")
            XCTAssertEqual(error.status, 503)
            // Nothing of an operator's code: this was not a denial.
            XCTAssertNil(error.params["code"])
            let asked = try await s.asked()
            XCTAssertEqual(asked, [1])
            let state = await app.state()
            XCTAssertFalse(state.isSignedIn)
            let token = try await app.session.getToken()
            XCTAssertNil(token)
        }
    }

    func testSignInDeniedByAHook() async throws {
        try await journey(
            "sign-in denied by a hook",
            "sign-in denied by a hook: the client gets the operator's code and no session, and a new attempt signs in"
        ) { s in
            let (_, email) = try await s.signUp()
            let hook = try await s.hook("before_session", answer: ["decision": "deny", "code": "account_suspended"])
            let app = try s.client()
            let flow = try await app.tula.startSignIn(identifier: email)
            var asked = try await s.asked()
            XCTAssertEqual(asked, [0])
            let wrong = try await caught { try await flow.submitPassword("not-the-password-123") }
            XCTAssertEqual(wrong.code, "auth.invalid_credentials")
            asked = try await s.asked()
            XCTAssertEqual(asked, [0], "a wrong password never reaches the hook")

            let error = try await caught { try await flow.submitPassword(Journey.password) }
            XCTAssertEqual(error.code, "hook.denied")
            XCTAssertEqual(error.status, 403)
            XCTAssertEqual(error.params, ["code": .string("account_suspended")])
            XCTAssertEqual(error.message, "This was not allowed.")
            asked = try await s.asked()
            XCTAssertEqual(asked, [1])
            var state = await app.state()
            XCTAssertFalse(state.isSignedIn)
            let token = try await app.session.getToken()
            XCTAssertNil(token)

            // The attempt has ended on the server: the flow the client holds is spent.
            let spent = try await caught { try await flow.submitPassword(Journey.password) }
            XCTAssertEqual(spent.code, "flow.not_found")
            try await s.setHook(hook, answer: ["decision": "allow"])
            let again = try await app.tula.startSignIn(identifier: email)
            let step = try await again.submitPassword(Journey.password)
            XCTAssertEqual(step.status, "complete")
            state = await app.state()
            XCTAssertTrue(state.isSignedIn)
            asked = try await s.asked()
            XCTAssertEqual(asked, [2])
        }
    }

    func testSignInHookThatTimesOut() async throws {
        try await journey(
            "sign-in hook that times out",
            "sign-in hook that times out: the client is told to try again later, in bounded time, and holds no session"
        ) { s in
            let (_, email) = try await s.signUp()
            _ = try await s.hook("before_session", answer: nil, deadlineMs: 100)
            let app = try s.client()
            let flow = try await app.tula.startSignIn(identifier: email)
            let started = Date()
            let error = try await caught { try await flow.submitPassword(Journey.password) }
            XCTAssertLessThan(Date().timeIntervalSince(started), 3)
            XCTAssertEqual(error.code, "hook.unavailable")
            XCTAssertEqual(error.status, 503)
            XCTAssertEqual(error.message, "This is unavailable right now. Try again later.")
            XCTAssertNil(error.params["code"])
            let asked = try await s.asked()
            XCTAssertEqual(asked, [1])
            let state = await app.state()
            XCTAssertFalse(state.isSignedIn)
            let token = try await app.session.getToken()
            XCTAssertNil(token)
        }
    }

    func testClaimsAddedByAHook() async throws {
        try await journey(
            "claims added by a hook",
            "claims added by a hook: the token the client hands out carries them, and a refresh keeps them without asking again"
        ) { s in
            let hook = try await s.hook("before_token", answer: ["claims": ["plan": "pro", "seats": 5]])
            let (app, email) = try await s.signUp()
            var asked = try await s.asked()
            XCTAssertEqual(asked, [1])
            let first = try await app.claims()
            XCTAssertEqual(first["ext"] as? NSDictionary, ["plan": "pro", "seats": 5])
            // Under the namespace claim only: nothing of the answer is a claim of its own.
            XCTAssertNil(first["plan"])

            try await s.setHook(hook, answer: ["claims": ["plan": "free"]])
            let refreshed = Journey.claims(try await app.session.refresh())
            XCTAssertEqual(refreshed["ext"] as? NSDictionary, ["plan": "pro", "seats": 5])
            XCTAssertEqual(refreshed["sid"] as? String, first["sid"] as? String)
            asked = try await s.asked()
            XCTAssertEqual(asked, [1], "a refresh reads the stored claims and asks nobody")

            // A new sign-in is a new session, and is asked about.
            let again = try await s.signIn(email)
            let claims = try await again.app.claims()
            XCTAssertEqual(claims["ext"] as? NSDictionary, ["plan": "free"])
            asked = try await s.asked()
            XCTAssertEqual(asked, [2])
        }
    }

    // MARK: Passwords

    func testPasswordPolicy() async throws {
        try await journey(
            "password policy",
            "password policy: a weak password is refused with one field error per rule, and nothing is sent"
        ) { s in
            let app = try s.client()
            let email = s.freshEmail()
            let config = try await app.tula.config()

            let error = try await caught { try await app.tula.startSignUp(email: email, password: "short") }
            // The error's own code is the first rule that failed; `errors` lists every one.
            XCTAssertEqual(error.code, "password.too_short")
            XCTAssertEqual(error.status, 422)
            XCTAssertTrue(
                error.errors.contains(
                    TulaFieldError(
                        field: "password", code: "password.too_short", message: "Password is too short.",
                        params: ["min": .number(Double(config.password.minLength))])))
            XCTAssertTrue(error.errors.allSatisfy { $0.field == "password" && $0.code.hasPrefix("password.") })

            let common = try await caught { try await app.tula.startSignUp(email: email, password: "password123") }
            XCTAssertTrue(common.errors.map(\.code).contains("password.common"))

            let invalid = try await caught {
                try await app.tula.startSignUp(email: "not-an-email", password: Journey.password)
            }
            XCTAssertEqual(invalid.errors.map(\.field), ["email"])
            XCTAssertEqual(invalid.errors.map(\.code), ["email.invalid"])
            let sent = try await s.emails()
            XCTAssertTrue(sent.isEmpty)
        }
    }

    func testPasswordLockout() async throws {
        try await journey(
            "password lockout",
            "lockout: after repeated wrong passwords every try is rate_limited with a wait, even the right one"
        ) { s in
            let (_, email) = try await s.signUp()
            let app = try s.client()
            let flow = try await app.tula.startSignIn(identifier: email)
            for attempt in 0..<6 {
                let wrong = try await caught { try await flow.submitPassword("wrong-password-\(attempt)") }
                XCTAssertEqual(wrong.code, "auth.invalid_credentials")
            }
            let locked = try await caught { try await flow.submitPassword(Journey.password) }
            XCTAssertEqual(locked.code, "rate_limited")
            XCTAssertEqual(locked.status, 429)
            let wait = try unwrap(locked.retryAfter)
            XCTAssertGreaterThan(wait, 0)
            XCTAssertEqual(locked.params["retryAfter"], .number(wait))
            let state = await app.state()
            XCTAssertEqual(state, .loading)

            // Once the wait is over the right password works.
            try await s.advance(wait + 1)
            let again = try await app.tula.startSignIn(identifier: email)
            let step = try await again.submitPassword(Journey.password)
            XCTAssertEqual(step.status, "complete")
        }
    }

    func testAdminBanAndAuditLog() async throws {
        try await journey(
            "admin ban and audit log",
            "a user banned by an admin is signed out at the next refresh, and cannot sign in"
        ) { s in
            let (app, email) = try await s.signUp()
            let userId = try unwrap(await app.state().user?.id)
            let banned = try await s.admin("POST", "/v1/admin/users/\(userId)/ban")
            XCTAssertEqual(banned.status, 200)

            let token = try await app.session.refresh()
            XCTAssertNil(token)
            let state = await app.state()
            XCTAssertEqual(state, .signedOut)
            let statuses = await app.statuses()
            XCTAssertEqual(statuses, ["signed-in", "signed-out"])

            let again = try s.client()
            let flow = try await again.tula.startSignIn(identifier: email)
            let error = try await caught { try await flow.submitPassword(Journey.password) }
            XCTAssertEqual(error.code, "auth.user_banned")
            XCTAssertEqual(error.status, 403)
        }
    }

    func testSignUpForAnExistingAddress() async throws {
        try await journey(
            "sign-up for an existing address",
            "sign-up for an address that already has an account looks the same and creates nothing"
        ) { s in
            let (_, email) = try await s.signUp()
            // Past the one-email-a-minute limit for the address, which the first sign-up used.
            try await s.advance(61)
            let app = try s.client()
            let flow = try await app.tula.startSignUp(email: email, password: Journey.newPassword)
            XCTAssertEqual(flow.step.status, "needs_email_verification")
            // No code was sent to the existing account's address for this attempt, so nothing
            // the newcomer can type completes it.
            let error = try await caught { try await flow.verifyEmail(code: "000000") }
            XCTAssertTrue(error.code.hasPrefix("verification."), error.code)
            let state = await app.state()
            XCTAssertEqual(state, .loading)
            // The original password still signs in: the account was not changed.
            let signedIn = try await s.signIn(email)
            XCTAssertEqual(signedIn.step.status, "complete")
        }
    }

    func testVerificationCodeAttempts() async throws {
        try await journey(
            "verification code attempts",
            "verification: wrong codes are counted, a resend retires the old code, too many guesses lock the code"
        ) { s in
            let app = try s.client()
            let email = s.freshEmail()
            let flow = try await app.tula.startSignUp(email: email, password: Journey.password)
            let firstCode = try await s.code(email)
            let wrongCode = firstCode == "000000" ? "111111" : "000000"

            let invalid = try await caught { try await flow.verifyEmail(code: wrongCode) }
            XCTAssertEqual(invalid.code, "verification.invalid_code")
            XCTAssertEqual(invalid.status, 422)
            // A resend asked for too soon is a typed rate limit with the wait.
            let tooSoon = try await caught { try await flow.resendCode() }
            XCTAssertEqual(tooSoon.code, "rate_limited")
            XCTAssertEqual(tooSoon.status, 429)
            XCTAssertGreaterThan(try unwrap(tooSoon.retryAfter), 0)

            try await s.advance(61)
            let resent = try await flow.resendCode()
            XCTAssertEqual(resent.status, "needs_email_verification")
            let secondCode = try await s.code(email)
            // The first code was retired by the resend.
            if secondCode != firstCode {
                let retired = try await caught { try await flow.verifyEmail(code: firstCode) }
                XCTAssertEqual(retired.code, "verification.invalid_code")
            }
            for _ in 0..<5 {
                _ = try await caught { try await flow.verifyEmail(code: wrongCode) }
            }
            let locked = try await caught { try await flow.verifyEmail(code: secondCode) }
            XCTAssertEqual(locked.code, "verification.too_many_attempts")
            XCTAssertEqual(locked.status, 429)
            let state = await app.state()
            XCTAssertEqual(state, .loading)
        }
    }

    func testPasswordReset() async throws {
        try await journey(
            "password reset",
            "password reset: code and new password together; other sessions end; the old password stops working"
        ) { s in
            let (other, email) = try await s.signUp()
            // Past the one-email-a-minute limit for the address, which the sign-up used.
            try await s.advance(61)
            let app = try s.client()

            let flow = try await app.tula.startPasswordReset(email: email)
            XCTAssertEqual(flow.kind, .passwordReset)
            guard case .newPassword(let asked) = flow.screen else {
                return XCTFail("not asking for a new password")
            }
            XCTAssertEqual(asked.strategies, [.emailCode])
            let code = try await s.code(email)

            let weak = try await caught { try await flow.submit(code: code, password: "short") }
            XCTAssertEqual(weak.code, "password.too_short")
            XCTAssertTrue(weak.errors.map(\.code).contains("password.too_short"))

            let step = try await flow.submit(code: code, password: Journey.newPassword)
            XCTAssertEqual(step.status, "complete")
            var state = await app.state()
            XCTAssertEqual(state.user?.email, email)

            // Every session from before the reset is over.
            let token = try await other.session.refresh()
            XCTAssertNil(token)
            state = await other.state()
            XCTAssertEqual(state, .signedOut)

            let old = try s.client()
            let oldFlow = try await old.tula.startSignIn(identifier: email)
            let refused = try await caught { try await oldFlow.submitPassword(Journey.password) }
            XCTAssertEqual(refused.code, "auth.invalid_credentials")
            let fresh = try await s.signIn(email, password: Journey.newPassword)
            XCTAssertEqual(fresh.step.status, "complete")

            // An address with no account gets the same first step.
            let ghost = try await s.client().tula.startPasswordReset(email: "nobody@example.com")
            XCTAssertEqual(ghost.step.status, "needs_new_password")
        }
    }

    /// Replace the password policy's fields through the admin API, as an operator does.
    private func savePasswordPolicy(_ s: Server, _ fields: [String: Any]) async throws {
        let read = try await s.admin("GET", "/v1/admin/settings")
        var settings = read.object["settings"] as? [String: Any] ?? [:]
        var password = settings["password"] as? [String: Any] ?? [:]
        password["preset"] = "custom"
        password.merge(fields) { _, new in new }
        settings["password"] = password
        let saved = try await s.admin("PUT", "/v1/admin/settings", settings, headers: ["if-match": read.etag ?? ""])
        XCTAssertEqual(saved.status, 200)
    }

    private func assertReused(_ error: TulaError, history: Double, line: UInt = #line) {
        XCTAssertEqual(error.code, "password.reused", line: line)
        XCTAssertEqual(error.status, 422, line: line)
        XCTAssertEqual(error.params, ["history": .number(history)], line: line)
        // The message is the SDK's own, by code; nothing says which password it was.
        XCTAssertEqual(error.message, "You have used this password recently. Choose a different one.", line: line)
    }

    func testPasswordHistory() async throws {
        try await journey(
            "password history",
            "password history: a reused password is `password.reused` on a change and on a reset, with the policy's number and the message; with no history it is accepted again"
        ) { s in
            let (app, email) = try await s.signUp()
            try await self.savePasswordPolicy(s, ["history": 3])
            // What a checklist is drawn from says how many are remembered.
            let config = try await app.tula.config(force: true)
            XCTAssertEqual(config.password.history, 3)

            // The current password is one of the three.
            var reused = try await caught {
                try await app.tula.changePassword(current: Journey.password, new: Journey.password)
            }
            self.assertReused(reused, history: 3)
            XCTAssertEqual(reused.errors.map(\.code), ["password.reused"])
            XCTAssertEqual(reused.errors.first?.params, ["history": .number(3)])
            try await app.tula.changePassword(current: Journey.password, new: Journey.newPassword)
            // So is the one before it.
            reused = try await caught {
                try await app.tula.changePassword(current: Journey.newPassword, new: Journey.password)
            }
            self.assertReused(reused, history: 3)
            // A refused change changed nothing: the session and the password are as they were.
            let state = await app.state()
            XCTAssertTrue(state.isSignedIn)

            // A reset is held to the same rule, and a refusal does not spend its code.
            try await s.advance(61)
            let other = try s.client()
            let flow = try await other.tula.startPasswordReset(email: email)
            let code = try await s.code(email)
            reused = try await caught { try await flow.submit(code: code, password: Journey.password) }
            self.assertReused(reused, history: 3)
            reused = try await caught { try await flow.submit(code: code, password: Journey.newPassword) }
            self.assertReused(reused, history: 3)
            let third = "amber-Lynx-skates-63-canals"
            let step = try await flow.submit(code: code, password: third)
            XCTAssertEqual(step.status, "complete")

            // With the history back at 0 the first password is accepted again.
            try await self.savePasswordPolicy(s, ["history": 0])
            try await other.tula.changePassword(current: third, new: Journey.password)
            let signedIn = try await s.signIn(email)
            XCTAssertEqual(signedIn.step.status, "complete")
        }
    }

    func testPasswordExpiry() async throws {
        try await journey(
            "password expiry",
            "password expiry: a right password that is too old stops at needs_new_password with its reason and no session; submitNewPassword refuses the old one and completes with a new one"
        ) { s in
            let (_, email) = try await s.signUp()
            try await self.savePasswordPolicy(s, ["expiryDays": 1])

            // Not a day old yet: the password signs in.
            let young = try await s.signIn(email)
            XCTAssertEqual(young.step.status, "complete")
            try await s.advance(86_400)

            let app = try s.client()
            let flow = try await app.tula.startSignIn(identifier: email)
            // A wrong password is what it always was.
            let wrong = try await caught { try await flow.submitPassword("not-the-password-1") }
            XCTAssertEqual(wrong.code, "auth.invalid_credentials")
            let step = try await flow.submitPassword(Journey.password)
            guard case .needsNewPassword(let asked) = step, case .newPassword = flow.screen else {
                return XCTFail("not asking for a new password")
            }
            XCTAssertEqual(asked.reason, .expired)
            XCTAssertEqual(asked.strategies, [])
            var state = await app.state()
            XCTAssertFalse(state.isSignedIn)
            var token = try await app.session.getToken()
            XCTAssertNil(token)

            // The expired password is not its own replacement, with no history in the policy too.
            let reused = try await caught { try await flow.submitNewPassword(Journey.password) }
            self.assertReused(reused, history: 1)
            // A refusal leaves the flow on its step.
            XCTAssertEqual(flow.step.status, "needs_new_password")
            state = await app.state()
            XCTAssertFalse(state.isSignedIn)

            let done = try await flow.submitNewPassword(Journey.newPassword)
            XCTAssertEqual(done.status, "complete")
            state = await app.state()
            XCTAssertTrue(state.isSignedIn)
            token = try await app.session.getToken()
            XCTAssertEqual(Journey.claims(token)["amr"] as? [String], ["pwd"])

            // The old password is wrong now; the new one signs in and is not asked to be replaced.
            let again = try await s.client().tula.startSignIn(identifier: email)
            let old = try await caught { try await again.submitPassword(Journey.password) }
            XCTAssertEqual(old.code, "auth.invalid_credentials")
            let fresh = try await again.submitPassword(Journey.newPassword)
            XCTAssertEqual(fresh.status, "complete")
        }
    }

    // MARK: The environment

    func testEnvironmentSettings() async throws {
        try await journey(
            "environment settings",
            "config: the client sees the app name, methods and password policy an admin sets"
        ) { s in
            let app = try s.client()
            let before = try await app.tula.config()
            XCTAssertEqual(before.app.name, "Tula")
            XCTAssertEqual(before.signIn.methods, ["password"])
            XCTAssertEqual(before.password.minLength, 10)

            let read = try await s.admin("GET", "/v1/admin/settings")
            var password = (read.object["settings"] as? [String: Any])?["password"] as? [String: Any] ?? [:]
            password["preset"] = "custom"
            password["minLength"] = 14
            let saved = try await s.admin(
                "PUT", "/v1/admin/settings", ["app": ["name": "Northline"], "password": password],
                headers: ["if-match": "\"0\""])
            XCTAssertEqual(saved.status, 200)

            // Kept until asked again.
            let kept = try await app.tula.config()
            XCTAssertEqual(kept.app.name, "Tula")
            let after = try await app.tula.config(force: true)
            XCTAssertEqual(after.app.name, "Northline")
            XCTAssertEqual(after.password.minLength, 14)

            // The server enforces what the config says.
            let error = try await caught {
                try await app.tula.startSignUp(email: s.freshEmail(), password: "twelve-chars")
            }
            let short = try unwrap(error.errors.first { $0.code == "password.too_short" })
            XCTAssertEqual(short.params, ["min": .number(14)])
        }
    }

    func testEmailWording() async throws {
        try await journey(
            "email wording",
            "email wording: a sign-up completes with the code from an email in the environment's own words, whose subject does not lead with it"
        ) { s in
            let saved = try await s.admin(
                "PUT", "/v1/admin/settings",
                [
                    "emails": [
                        "templates": [
                            "email_verification": [
                                "subject": "Welcome to {{appName}}: your code is inside",
                                "body": "Welcome aboard.\n\nYour code: {{code}}\n\nGood for {{expiresInMinutes}} minutes.",
                            ]
                        ]
                    ]
                ],
                headers: ["if-match": "\"0\""])
            XCTAssertEqual(saved.status, 200)
            let app = try s.client()
            let email = s.freshEmail()
            let flow = try await app.tula.startSignUp(email: email, password: Journey.password)
            XCTAssertEqual(flow.step.status, "needs_email_verification")

            // Nothing of the client reads a subject: only this suite's own `code` does, and it
            // finds no code in this one.
            let sent = try unwrap(try await s.emails(to: email).last)
            XCTAssertEqual(sent.subject, "Welcome to Tula: your code is inside")
            do {
                _ = try await s.code(email)
                XCTFail("the subject does not lead with a code")
            } catch is JourneyFailure {}
            let line = try unwrap(sent.text.split(separator: "\n").first { $0.hasPrefix("Your code: ") })
            let code = String(line.dropFirst("Your code: ".count))
            XCTAssertEqual(code.count, 6)
            XCTAssertTrue(sent.text.hasPrefix("Welcome aboard.\n\nYour code: \(code)\n\nGood for 10 minutes."))

            let step = try await flow.verifyEmail(code: code)
            XCTAssertEqual(step.status, "complete")
            let state = await app.state()
            XCTAssertEqual(state.user?.email, email)
        }
    }

    // MARK: The attempt's secret

    func testAttemptBinding() async throws {
        try await journey(
            "attempt binding",
            "attempt binding: the client sends the attempt's secret on every step; a tampered or missing one is flow.not_found"
        ) { s in
            let (_, email) = try await s.signUp()

            let honest = try s.client()
            let flow = try await honest.tula.startSignIn(identifier: email)
            try await flow.submitPassword(Journey.password)
            let step = try unwrap(try await s.exchanges().first { $0.path.hasSuffix("/password") })
            XCTAssertTrue(step.headers["x-tula-attempt"]?.hasPrefix("tula_at_") == true)
            // The secret is in a header and nowhere else: not in a path, not in a body.
            let secret = try unwrap(step.headers["x-tula-attempt"])
            for exchange in try await s.exchanges() {
                XCTAssertFalse(exchange.path.contains(secret))
                XCTAssertFalse(exchange.requestBody.contains(secret))
            }
            var state = await honest.state()
            XCTAssertTrue(state.isSignedIn)

            let tampers: [@Sendable (URLRequest) -> URLRequest] = [
                { original in
                    var request = original
                    if request.value(forHTTPHeaderField: "x-tula-attempt") != nil {
                        request.setValue("tula_at_not-the-secret", forHTTPHeaderField: "x-tula-attempt")
                    }
                    return request
                },
                { original in
                    var request = original
                    request.setValue(nil, forHTTPHeaderField: "x-tula-attempt")
                    return request
                },
            ]
            for tamper in tampers {
                let tampering = try s.client()
                tampering.wire.tamper(tamper)
                let bound = try await tampering.tula.startSignIn(identifier: email)
                let error = try await caught { try await bound.submitPassword(Journey.password) }
                XCTAssertEqual(error.code, "flow.not_found")
                XCTAssertEqual(error.status, 404)
                state = await tampering.state()
                XCTAssertEqual(state, .loading)
            }
            // Nothing was counted against the account by the refused tries.
            let signedIn = try await s.signIn(email)
            XCTAssertEqual(signedIn.step.status, "complete")
        }
    }

    // MARK: Signing in by emailed code

    /// A server whose environment signs in by password, emailed code and emailed link.
    private func emailServer(_ s: Server, signUpPassword: String = "required") async throws {
        let saved = try await s.admin(
            "PUT", "/v1/admin/settings",
            [
                "signIn": [
                    "methods": [
                        "password": ["enabled": true], "emailCode": ["enabled": true], "emailLink": ["enabled": true],
                    ]
                ],
                "signUp": ["password": signUpPassword],
            ],
            headers: ["if-match": "\"0\""])
        XCTAssertEqual(saved.status, 200)
    }

    func testEmailCodeSignIn() async throws {
        try await journey(
            "email code sign-in",
            "email code: the offered strategies, a code by email, a wrong code, the right one signs in"
        ) { s in
            try await self.emailServer(s)
            // A user an admin created, with no password.
            let email = s.freshEmail()
            let made = try await s.admin("POST", "/v1/admin/users", ["email": email])
            XCTAssertEqual(made.status, 201)
            let app = try s.client()
            let config = try await app.tula.config()
            XCTAssertEqual(config.signIn.methods, ["password", "emailCode", "emailLink"])

            let flow = try await app.tula.startSignIn(identifier: email)
            let offered: [FirstFactorStrategy] = [.password, .emailCode, .emailLink]
            guard case .needsFirstFactor(let choice) = flow.step, case .firstFactor = flow.screen else {
                return XCTFail("not offering first factors")
            }
            XCTAssertEqual(choice.strategies, offered)
            XCTAssertNil(choice.prepared)
            // An address with no account is offered, and answered, exactly the same.
            let ghost = try await s.client().tula.startSignIn(identifier: "nobody@example.com")
            XCTAssertEqual(ghost.step, flow.step)
            guard case .needsFirstFactor(let decoy) = try await ghost.prepareEmailCode() else {
                return XCTFail("a decoy is not answered like an account")
            }
            XCTAssertEqual(decoy.strategies, offered)
            XCTAssertEqual(decoy.prepared?.strategy, .emailCode)
            XCTAssertEqual(decoy.prepared?.destination, "n***@example.com")

            guard case .needsFirstFactor(let prepared) = try await flow.prepareEmailCode() else {
                return XCTFail("the code was not asked for")
            }
            XCTAssertEqual(prepared.strategies, offered)
            XCTAssertEqual(prepared.prepared?.strategy, .emailCode)
            let tooSoon = try await caught { try await flow.prepareEmailCode() }
            XCTAssertEqual(tooSoon.code, "rate_limited")
            XCTAssertEqual(tooSoon.retryAfter, 60)

            let code = try await s.code(email)
            let last = try unwrap(code.last?.wholeNumberValue)
            let wrong = "\(code.dropLast())\((last + 1) % 10)"
            let invalid = try await caught { try await flow.attemptEmailCode(wrong) }
            XCTAssertEqual(invalid.code, "verification.invalid_code")
            XCTAssertEqual(invalid.params["attemptsRemaining"], .number(4))
            var state = await app.state()
            XCTAssertEqual(state, .loading)

            let step = try await flow.attemptEmailCode(code)
            XCTAssertEqual(step.status, "complete")
            state = await app.state()
            XCTAssertEqual(state.user?.email, email)
            // The code proved the address.
            let user = try await app.tula.user()
            XCTAssertNotNil(user.emailVerifiedAt)

            // The account has no password: one never works for it.
            let again = try await s.client().tula.startSignIn(identifier: email)
            let refused = try await caught { try await again.submitPassword(Journey.password) }
            XCTAssertEqual(refused.code, "auth.invalid_credentials")
        }
    }

    func testPasswordlessSignUp() async throws {
        try await journey(
            "passwordless sign-up",
            "passwordless sign-up: an account with no password, which then signs in by emailed code"
        ) { required in
            let refused = try await caught {
                try await required.client().tula.startSignUp(email: required.freshEmail())
            }
            XCTAssertEqual(refused.code, "validation.failed")
            XCTAssertEqual(refused.status, 422)
            XCTAssertTrue(refused.errors.map(\.field).contains("password"))

            let s = try await self.server()
            try await self.emailServer(s, signUpPassword: "optional")
            let app = try s.client()
            let config = try await app.tula.config()
            XCTAssertEqual(config.signUp?.password, .optional)
            let email = s.freshEmail()
            let signUp = try await app.tula.startSignUp(email: email, firstName: "Ines")
            XCTAssertEqual(signUp.step.status, "needs_email_verification")
            let done = try await signUp.verifyEmail(code: try await s.code(email))
            XCTAssertEqual(done.status, "complete")
            var state = await app.state()
            XCTAssertEqual(state.user?.email, email)
            XCTAssertEqual(state.user?.firstName, "Ines")
            let notSet = try await caught {
                try await app.tula.changePassword(current: Journey.password, new: Journey.password)
            }
            XCTAssertEqual(notSet.code, "password.not_set")

            try await s.advance(61)
            let next = try s.client()
            let flow = try await next.tula.startSignIn(identifier: email)
            let wrong = try await caught { try await flow.submitPassword(Journey.password) }
            XCTAssertEqual(wrong.code, "auth.invalid_credentials")
            try await flow.prepareEmailCode()
            let step = try await flow.attemptEmailCode(try await s.code(email))
            XCTAssertEqual(step.status, "complete")
            state = await next.state()
            XCTAssertTrue(state.isSignedIn)
        }
    }

    // MARK: A device key

    func testAProfileThatRequiresADeviceKeyRefusesANativeSignInWithoutOne() async throws {
        try await journey(
            "a profile that requires a device key refuses a native sign-in without one",
            "device binding required: this client has no device key yet, is told so at the start by a code of its own, and is neither signed in nor signed out by it"
        ) { s in
            try await s.settings(["sessions": ["profiles": ["mobile": ["deviceBinding": "required"]]]])
            let app = try s.client()
            let email = s.freshEmail()
            let signUp = try await caught { try await app.tula.startSignUp(email: email, password: Journey.password) }
            XCTAssertEqual(signUp.code, "device.binding_required")
            XCTAssertEqual(signUp.status, 400)
            // The same for a sign-in, whoever it names: nothing was looked up.
            let signIn = try await caught { try await app.tula.startSignIn(identifier: email) }
            XCTAssertEqual(signIn.code, "device.binding_required")
            // One request each, with no proof: the client does not repeat what it cannot answer.
            let exchanges = try await s.exchanges()
            XCTAssertEqual(exchanges.map(\.status), [400, 400])
            XCTAssertTrue(exchanges.allSatisfy { $0.headers["dpop"] == nil })
            // A `device.*` code never ends a session and never makes one.
            let state = await app.state()
            XCTAssertEqual(state, .loading)
            let token = try await app.session.getToken()
            XCTAssertNil(token)
            // Nothing was made or sent for the refused starts.
            let exists = try await s.userExists(email)
            XCTAssertFalse(exists)
            let sent = try await s.emails()
            XCTAssertTrue(sent.isEmpty)
        }
    }

    func testASessionThatIsNotBoundBehavesAsBefore() async throws {
        try await journey(
            "a session that is not bound behaves as before",
            "device binding: this client sends no proof and gets a session with no key, which refreshes as it always did"
        ) { s in
            let (app, _) = try await s.signUp()
            let claims = try await app.claims()
            XCTAssertNil(claims["cnf"])
            try await s.advance(1)
            _ = try await app.session.refresh()
            let exchanges = try await s.exchanges()
            XCTAssertTrue(exchanges.allSatisfy { $0.headers["dpop"] == nil })
            let refreshes = try await s.refreshes()
            XCTAssertEqual(refreshes.map(\.status), [200])
            let sessions = try await app.session.list()
            XCTAssertEqual(sessions.map(\.deviceBound), [false])
        }
    }
}
