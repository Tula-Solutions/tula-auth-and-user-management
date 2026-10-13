import Foundation
import XCTest

@testable import TulaAuth

// The flow protocol on a fake API: the start, every step this version has, the attempt's
// secret, discard, "one action at a time", and the screen of a step nobody can act on.
final class FlowTests: XCTestCase {
    private let signIns = "POST /v1/client/sign-ins"
    private let password = "POST /v1/client/sign-ins/att_1/password"
    private let needsPassword = #"{"status":"needs_password"}"#

    private func startedSignIn(_ step: String? = nil) async throws -> (World, SignInFlow) {
        let world = try World()
        world.api.on(signIns, Reply(json: Fixture.attempt("sign_in", step: step ?? needsPassword)))
        let flow = try await world.client.startSignIn(identifier: "maya@example.com")
        return (world, flow)
    }

    // MARK: The start and the secret

    func testAStartSendsTheKeyAndTheClientKindAndNoSecret() async throws {
        let world = try World(sessionProfile: "kiosk")
        world.api.on(
            "POST /v1/client/sign-ups",
            Reply(
                json: Fixture.attempt(
                    "sign_up",
                    step:
                        #"{"status":"needs_email_verification","destination":"m***@example.com","strategies":["email_code"]}"#
                )))
        let flow = try await world.client.startSignUp(email: "maya@example.com", password: "a long passphrase")
        let request = world.api.requests[0]
        XCTAssertEqual(request.value(forHTTPHeaderField: "x-tula-publishable-key"), Fixture.key)
        XCTAssertEqual(request.value(forHTTPHeaderField: "x-tula-client"), "ios")
        XCTAssertEqual(request.value(forHTTPHeaderField: "x-tula-session-profile"), "kiosk")
        XCTAssertNil(request.value(forHTTPHeaderField: "x-tula-attempt"))
        XCTAssertNil(request.value(forHTTPHeaderField: "authorization"))
        XCTAssertEqual(Fixture.body(request)["email"] as? String, "maya@example.com")
        XCTAssertNil(Fixture.body(request)["firstName"], "a value that is not there is a key left out")
        XCTAssertEqual(flow.id, "att_1")
        XCTAssertEqual(flow.kind, .signUp)
        XCTAssertEqual(flow.snapshot.expiresAt, "2030-01-01T00:00:00.000Z")
        guard case .emailVerification(let step) = flow.screen else {
            return XCTFail("not the email verification screen")
        }
        XCTAssertEqual(step.destination, "m***@example.com")
    }

    func testEveryStepAfterTheStartPresentsTheAttemptsSecretAsAHeader() async throws {
        let world = try World()
        world.api.on(
            "POST /v1/client/sign-ups",
            Reply(
                json: Fixture.attempt(
                    "sign_up",
                    step:
                        #"{"status":"needs_email_verification","destination":"m***@example.com","strategies":["email_code"]}"#
                )))
        let verify = "POST /v1/client/sign-ups/att_1/verify-email"
        let resend = "POST /v1/client/sign-ups/att_1/resend-code"
        world.api.on(
            resend,
            Reply(
                json: Fixture.attempt(
                    "sign_up",
                    step:
                        #"{"status":"needs_email_verification","destination":"m***@example.com","strategies":["email_code"]}"#,
                    secret: nil)))
        world.api.on(
            verify,
            Reply(
                json: Fixture.attempt(
                    "sign_up", step: Fixture.completeStep, secret: nil, session: Fixture.tokens("first"))))
        let flow = try await world.client.startSignUp(email: "maya@example.com", password: "a long passphrase")
        try await flow.resendCode()
        let step = try await flow.verifyEmail(code: "123456")
        XCTAssertEqual(step.status, "complete")
        XCTAssertEqual(flow.screen, .complete)

        for route in [resend, verify] {
            XCTAssertEqual(world.api.requests(route)[0].value(forHTTPHeaderField: "x-tula-attempt"), "attempt-secret-1")
        }
        XCTAssertNil(world.api.requests(resend)[0].httpBody, "a step with no body sends none")
        XCTAssertEqual(Fixture.body(world.api.requests(verify)[0])["code"] as? String, "123456")

        // Completing signs the client in and stores the refresh token.
        let state = await world.session.state
        XCTAssertEqual(state, .signedIn(sessionId: "ses_1", user: try JSONDecoder().decode(CurrentUser.self, from: Data(Fixture.user.utf8))))
        let stored = await world.storage.only
        XCTAssertEqual(stored, "refresh-first")
        let token = try await world.session.getToken()
        XCTAssertEqual(token, Fixture.accessToken("first"))

        // A flow that completed has no secret left: nothing more is sent for it.
        let code = await thrownCode { try await flow.resendCode() }
        XCTAssertEqual(code, "flow.invalid_step")
        XCTAssertEqual(world.api.count(resend), 1)
    }

    func testNoSecretTokenPasswordOrCodeIsEverInAURL() async throws {
        let (world, flow) = try await startedSignIn()
        world.api.on(
            password,
            Reply(json: Fixture.attempt("sign_in", step: Fixture.completeStep, secret: nil, session: Fixture.tokens("first"))))
        world.api.on(Fixture.refresh, Reply(json: Fixture.tokens("second")))
        world.api.on(Fixture.signOut, Reply(status: 204, json: ""))
        try await flow.submitPassword("the-typed-password")
        _ = try await world.session.refresh()
        _ = try await world.client.user()
        try await world.session.signOut()
        let secrets = [
            "attempt-secret-1", "the-typed-password", "refresh-first", "refresh-second",
            Fixture.accessToken("first"), Fixture.accessToken("second"), "maya", Fixture.key,
        ]
        XCTAssertGreaterThanOrEqual(world.api.requests.count, 6)
        for request in world.api.requests {
            let url = request.url?.absoluteString ?? ""
            XCTAssertNil(request.url?.query)
            XCTAssertNil(request.url?.fragment)
            for secret in secrets {
                XCTAssertFalse(url.contains(secret), url)
            }
        }
    }

    func testAnAnswerThatCannotBeAFlowIsRefused() async throws {
        let cases = [
            // No secret on a start that did not complete.
            Fixture.attempt("sign_in", step: needsPassword, secret: nil),
            // Tokens beside a step that is not `complete`.
            Fixture.attempt("sign_in", step: needsPassword, session: Fixture.tokens("first")),
            // `complete` with no tokens.
            Fixture.attempt("sign_in", step: Fixture.completeStep),
            // `complete` with no access token.
            Fixture.attempt("sign_in", step: Fixture.completeStep, session: #"{"sessionId":"ses_1"}"#),
            // Not a flow at all.
            #"{"ok":true}"#,
        ]
        for json in cases {
            let world = try World()
            world.api.on(signIns, Reply(json: json))
            let client = world.client
            let code = await thrownCode { _ = try await client.startSignIn(identifier: "maya@example.com") }
            XCTAssertEqual(code, TulaClientErrorCode.responseInvalid, json)
            let state = await world.session.state
            XCTAssertFalse(state.isSignedIn)
        }
    }

    // MARK: Not supported

    func testAStepThisVersionDoesNotKnowIsNotSupportedAndKeptWhole() async throws {
        let raw = #"{"status":"needs_hardware_key","options":["usb","nfc"]}"#
        let (world, flow) = try await startedSignIn(raw)
        XCTAssertEqual(flow.screen, .notSupported(status: "needs_hardware_key"))
        guard case .unknown(let status, let kept) = flow.step else {
            return XCTFail("the step was not kept as unknown")
        }
        XCTAssertEqual(status, "needs_hardware_key")
        XCTAssertEqual(kept, try JSONDecoder().decode(TulaJSONValue.self, from: Data(raw.utf8)))
        // Nothing was thrown and nothing was sent on a guess.
        XCTAssertEqual(world.api.requests.count, 1)
    }

    func testAKnownStepThisClientHasNoActionForIsNotSupported() throws {
        func screen(_ json: String, _ kind: FlowKind = .signIn) throws -> FlowScreen {
            FlowScreen(step: try JSONDecoder().decode(FlowStep.self, from: Data(json.utf8)), kind: kind)
        }
        XCTAssertEqual(try screen(#"{"status":"needs_password"}"#), .password)
        // A second factor: a code, typed or texted, is a way this client has, a passkey only
        // with a sheet, a method it does not know never; and a sign-up has no second factor
        // to ask for.
        guard
            case .secondFactor = try screen(#"{"status":"needs_second_factor","options":["totp","backup_code"]}"#),
            case .secondFactor = try screen(#"{"status":"needs_second_factor","options":["backup_code"]}"#, .passwordReset)
        else {
            return XCTFail("a code is a second factor this client can take")
        }
        let passkeyOnly = try JSONDecoder().decode(
            FlowStep.self, from: Data(#"{"status":"needs_second_factor","options":["passkey"]}"#.utf8))
        XCTAssertEqual(FlowScreen(step: passkeyOnly, kind: .signIn), .notSupported(status: "needs_second_factor"))
        guard case .secondFactor = FlowScreen(step: passkeyOnly, kind: .signIn, passkeys: true) else {
            return XCTFail("a passkey is a second factor for a client with a sheet")
        }
        guard
            case .secondFactor = try screen(#"{"status":"needs_second_factor","options":["sms_code"]}"#),
            case .secondFactor = try screen(#"{"status":"needs_second_factor","options":["sms_code"]}"#, .passwordReset)
        else {
            return XCTFail("a texted code is a second factor this client can ask for")
        }
        XCTAssertEqual(
            try screen(#"{"status":"needs_second_factor","options":["hardware_key"]}"#),
            .notSupported(status: "needs_second_factor"))
        XCTAssertEqual(
            try screen(#"{"status":"needs_second_factor","options":["sms_code"]}"#, .signUp),
            .notSupported(status: "needs_second_factor"))
        XCTAssertEqual(
            try screen(#"{"status":"needs_second_factor","options":["totp"]}"#, .signUp),
            .notSupported(status: "needs_second_factor"))
        guard case .factorEnrolment = try screen(#"{"status":"needs_factor_enrolment","methods":["totp"]}"#, .signUp)
        else {
            return XCTFail("an authenticator app can be enrolled inside an attempt")
        }
        XCTAssertEqual(
            try screen(#"{"status":"needs_factor_enrolment","methods":["hardware_key"]}"#),
            .notSupported(status: "needs_factor_enrolment"))
        XCTAssertEqual(
            try screen(#"{"status":"needs_identifier","strategies":["passkey"]}"#),
            .notSupported(status: "needs_identifier"))
        // Only ways this client cannot take: a passkey, a provider, an emailed link.
        XCTAssertEqual(
            try screen(#"{"status":"needs_first_factor","strategies":["passkey","oauth_google","email_link"]}"#),
            .notSupported(status: "needs_first_factor"))
        guard
            case .firstFactor = try screen(#"{"status":"needs_first_factor","strategies":["passkey","email_code"]}"#),
            case .firstFactor = try screen(#"{"status":"needs_first_factor","strategies":["sms_code"]}"#)
        else {
            return XCTFail("an emailed code and a texted code are ways this client has")
        }
        XCTAssertEqual(
            try screen(
                #"{"status":"needs_email_verification","destination":"m***@example.com","strategies":["email_link"]}"#),
            .notSupported(status: "needs_email_verification"))
        // A new password: a reset's has no reason, a sign-in's is `expired`; anything else is
        // a reason this version has no screen for.
        let plain = #"{"status":"needs_new_password","destination":"m***@example.com","strategies":["email_code"]}"#
        let expired = #"{"status":"needs_new_password","destination":"m***@example.com","strategies":[],"reason":"expired"}"#
        let other = #"{"status":"needs_new_password","destination":"m***@example.com","strategies":[],"reason":"compromised"}"#
        guard case .newPassword = try screen(plain, .passwordReset), case .newPassword = try screen(expired) else {
            return XCTFail("a new password this client can set")
        }
        XCTAssertEqual(try screen(plain), .notSupported(status: "needs_new_password"))
        XCTAssertEqual(try screen(expired, .passwordReset), .notSupported(status: "needs_new_password"))
        XCTAssertEqual(try screen(other), .notSupported(status: "needs_new_password"))
        XCTAssertEqual(try screen(plain, .unknown("sign_over")), .notSupported(status: "needs_new_password"))
    }

    // MARK: One action at a time, and discard

    func testASecondActionWhileOneIsBeingSentIsRefusedWithoutARequest() async throws {
        let (world, flow) = try await startedSignIn()
        let gate = Gate()
        world.api.on(password) { _ in
            await gate.wait()
            return Reply.error(401, "auth.invalid_credentials")
        }
        let first = Task { try await flow.submitPassword("one") }
        await eventually("the first action is in flight") { world.api.count(self.password) == 1 }
        let busy = await thrownCode { try await flow.submitPassword("two") }
        XCTAssertEqual(busy, TulaClientErrorCode.flowBusy)
        XCTAssertEqual(world.api.count(password), 1)
        gate.open()
        let refused = await thrownCode { _ = try await first.value }
        XCTAssertEqual(refused, "auth.invalid_credentials")
        // The refusal left the attempt where it was, and it can be answered again.
        XCTAssertEqual(flow.screen, .password)
        _ = await thrownCode { try await flow.submitPassword("three") }
        XCTAssertEqual(world.api.count(password), 2)
    }

    func testADiscardedFlowDropsALateCompleteAndSignsNobodyIn() async throws {
        let (world, flow) = try await startedSignIn()
        let gate = Gate()
        world.api.on(password) { _ in
            await gate.wait()
            return Reply(
                json: Fixture.attempt("sign_in", step: Fixture.completeStep, secret: nil, session: Fixture.tokens("first")))
        }
        let submit = Task { try await flow.submitPassword("the-typed-password") }
        await eventually("the action is in flight") { world.api.count(self.password) == 1 }
        flow.discard()
        gate.open()
        let dropped = await thrownCode { _ = try await submit.value }
        XCTAssertEqual(dropped, "flow.invalid_step")
        let state = await world.session.state
        XCTAssertFalse(state.isSignedIn, "a late complete signs nobody in")
        let stored = await world.storage.only
        XCTAssertNil(stored)
        XCTAssertEqual(flow.screen, .password, "nothing was taken from the answer")

        // Nothing more is sent for a flow that was left.
        let later = await thrownCode { try await flow.submitPassword("again") }
        XCTAssertEqual(later, "flow.invalid_step")
        XCTAssertEqual(world.api.count(password), 1)
    }

    func testAFlowDiscardedWhileItsSessionIsBeingStoredIsCompleteAndSignedIn() async throws {
        // The answer said `complete` and the session is being stored when the flow is
        // discarded. The step was taken under the lock the discard takes, so the discard
        // finds a completed flow and leaves it: never a discarded flow with an adopted
        // session, which no caller could tell from one that signed nobody in.
        let (world, flow) = try await startedSignIn()
        let gate = Gate()
        await world.storage.hold(gate)
        world.api.on(
            password,
            Reply(json: Fixture.attempt("sign_in", step: Fixture.completeStep, secret: nil, session: Fixture.tokens("first"))))
        let submit = Task { try await flow.submitPassword("the-typed-password") }
        await eventually("the session is being stored") { await world.storage.writes == 1 }
        flow.discard()
        XCTAssertEqual(flow.screen, .complete, "the discard came after the step and changed nothing")
        gate.open()
        let step = try await submit.value
        XCTAssertEqual(step.status, "complete", "the action says what happened: it is not refused as discarded")
        let state = await world.session.state
        XCTAssertTrue(state.isSignedIn)
        let stored = await world.storage.only
        XCTAssertEqual(stored, "refresh-first")
    }

    func testDiscardLeavesACompletedFlowAsItIs() async throws {
        let world = try World()
        // A start can complete at once (a sign-up that needs no verification).
        world.api.on(
            signIns,
            Reply(json: Fixture.attempt("sign_in", step: Fixture.completeStep, secret: nil, session: Fixture.tokens("first"))))
        let flow = try await world.client.startSignIn(identifier: "maya@example.com")
        flow.discard()
        XCTAssertEqual(flow.screen, .complete)
        let state = await world.session.state
        XCTAssertTrue(state.isSignedIn)
    }

    // MARK: The steps

    func testASignInByEmailedCodeAsksAndThenProves() async throws {
        let (world, flow) = try await startedSignIn(#"{"status":"needs_first_factor","strategies":["password","email_code","email_link"]}"#)
        let prepare = "POST /v1/client/sign-ins/att_1/first-factor/prepare"
        let attempt = "POST /v1/client/sign-ins/att_1/first-factor/attempt"
        world.api.on(
            prepare,
            Reply(
                json: Fixture.attempt(
                    "sign_in",
                    step:
                        #"{"status":"needs_first_factor","strategies":["password","email_code"],"prepared":{"strategy":"email_code","destination":"m***@example.com"}}"#,
                    secret: nil)))
        world.api.always(attempt) { _ in
            Reply(json: Fixture.attempt("sign_in", step: Fixture.completeStep, secret: nil, session: Fixture.tokens("first")))
        }
        try await flow.prepareEmailCode()
        guard case .firstFactor(let step) = flow.screen else {
            return XCTFail("not the first factor screen")
        }
        XCTAssertEqual(step.prepared?.destination, "m***@example.com")
        try await flow.attemptEmailCode("123456")
        XCTAssertEqual(Fixture.body(world.api.requests(prepare)[0])["strategy"] as? String, "email_code")
        let proof = Fixture.body(world.api.requests(attempt)[0])
        XCTAssertEqual(proof["strategy"] as? String, "email_code")
        XCTAssertEqual(proof["code"] as? String, "123456")
        let state = await world.session.state
        XCTAssertTrue(state.isSignedIn)
    }

    func testAStepThatOffersOnlyALinkIsNotSupportedAndATextedCodeIsOffered() async throws {
        // This version proves a password, an emailed code and a texted code. It has no call
        // for an emailed link, so a step with nothing else is not a screen it can draw.
        let (world, flow) = try await startedSignIn(#"{"status":"needs_first_factor","strategies":["email_link"]}"#)
        XCTAssertEqual(flow.screen, .notSupported(status: "needs_first_factor"))
        XCTAssertEqual(world.api.requests.count, 1, "only the start was sent")
        for strategies in [#"["sms_code"]"#, #"["sms_code","email_link"]"#] {
            let (world, flow) = try await startedSignIn(#"{"status":"needs_first_factor","strategies":\#(strategies)}"#)
            guard case .firstFactor = flow.screen else {
                return XCTFail("a texted code is a way this client has")
            }
            // Arriving at the step texts nothing: a message is asked for.
            XCTAssertEqual(world.api.requests.count, 1, "only the start was sent")
        }
    }

    func testTheOtherStepsOfASignInGoToTheirOwnRoutes() async throws {
        let (world, flow) = try await startedSignIn()
        let routes = [
            "POST /v1/client/sign-ins/att_1/new-password",
            "POST /v1/client/sign-ins/att_1/verify-email",
            "POST /v1/client/sign-ins/att_1/resend-code",
        ]
        for route in routes {
            world.api.always(route) { _ in Reply.error(409, "flow.invalid_step") }
        }
        _ = await thrownCode { try await flow.submitNewPassword("a new long passphrase") }
        _ = await thrownCode { try await flow.verifyEmail(code: "123456") }
        _ = await thrownCode { try await flow.resendCode() }
        XCTAssertEqual(Array(world.api.routes.dropFirst()), routes)
        XCTAssertEqual(Fixture.body(world.api.requests(routes[0])[0])["password"] as? String, "a new long passphrase")
    }

    func testAPasswordResetSendsTheCodeAndThePasswordTogether() async throws {
        let world = try World()
        world.api.on(
            "POST /v1/client/password-resets",
            Reply(
                json: Fixture.attempt(
                    "password_reset",
                    step: #"{"status":"needs_new_password","destination":"m***@example.com","strategies":["email_code"]}"#
                )))
        let submit = "POST /v1/client/password-resets/att_1/password"
        world.api.on(
            submit,
            Reply(
                json: Fixture.attempt(
                    "password_reset", step: Fixture.completeStep, secret: nil, session: Fixture.tokens("first"))))
        let flow = try await world.client.startPasswordReset(email: "maya@example.com")
        guard case .newPassword = flow.screen else {
            return XCTFail("not the new password screen")
        }
        try await flow.submit(code: "123456", password: "a new long passphrase")
        let body = Fixture.body(world.api.requests(submit)[0])
        XCTAssertEqual(body["code"] as? String, "123456")
        XCTAssertEqual(body["password"] as? String, "a new long passphrase")
        XCTAssertEqual(flow.screen, .complete)
    }

    func testAStepWhoseTokensCannotBeStoredSignsInAndSaysSo() async throws {
        let (world, flow) = try await startedSignIn()
        await world.storage.fail("set")
        world.api.on(
            password,
            Reply(json: Fixture.attempt("sign_in", step: Fixture.completeStep, secret: nil, session: Fixture.tokens("first"))))
        let code = await thrownCode { try await flow.submitPassword("the-typed-password") }
        XCTAssertEqual(code, TulaClientErrorCode.storageFailed)
        let state = await world.session.state
        XCTAssertTrue(state.isSignedIn, "the running app is signed in; the session will not outlive it")
        XCTAssertEqual(flow.screen, .complete)
    }
}
