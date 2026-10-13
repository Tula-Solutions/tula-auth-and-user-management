import Foundation
import XCTest

@testable import TulaAuth

// Texted codes and the phone number on a fake API: a sign-in by a texted code, a texted
// second factor, a texted step-up, the texted factor's enrolment and the account's number.
// Nothing is texted by arriving anywhere: every message is asked for by a call of its own.
final class TextedCodeTests: XCTestCase {
    private let signIns = "POST /v1/client/sign-ins"
    private let prepare = "POST /v1/client/sign-ins/att_1/first-factor/prepare"
    private let attempt = "POST /v1/client/sign-ins/att_1/first-factor/attempt"
    private let secondFactor = "POST /v1/client/sign-ins/att_1/second-factor"
    private let prepareSecond = "POST /v1/client/sign-ins/att_1/second-factor/prepare"
    private let stepUp = "POST /v1/client/sessions/step-up"
    private let stepUpCode = "POST /v1/client/sessions/step-up/sms-code"
    private let smsFactor = "POST /v1/client/me/factors/sms"
    private let phone = "POST /v1/client/me/phone"
    private let verify = "POST /v1/client/me/phone/verify"
    private let removePhone = "DELETE /v1/client/me/phone"

    private let textedOnly = #"{"status":"needs_first_factor","strategies":["sms_code"]}"#
    private let textedSecond = #"{"status":"needs_second_factor","options":["sms_code"]}"#
    private let receipt = #"{"method":"sms_code","destination":"+1 *** *** **42","expiresAt":"2030-01-01T00:00:00.000Z"}"#

    private func started(_ step: String, identifier: String = "+14155550142") async throws -> (World, SignInFlow) {
        let world = try World()
        world.api.on(signIns, Reply(json: Fixture.attempt("sign_in", step: step)))
        return (world, try await world.client.startSignIn(identifier: identifier))
    }

    private func complete() -> Reply {
        Reply(json: Fixture.attempt("sign_in", step: Fixture.completeStep, secret: nil, session: Fixture.tokens("first")))
    }

    private func secret(_ request: URLRequest) -> String? {
        request.value(forHTTPHeaderField: "x-tula-attempt")
    }

    // MARK: Signing in with a texted code

    func testASignInByTextedCodeAsksAndThenProves() async throws {
        let (world, flow) = try await started(textedOnly)
        // A step that offers only a texted code is one this client can act on, and nothing
        // was texted by arriving at it.
        guard case .firstFactor(let offered) = flow.screen else {
            return XCTFail("not the first factor screen")
        }
        XCTAssertEqual(offered.strategies, [.smsCode])
        XCTAssertNil(offered.prepared)
        XCTAssertEqual(world.api.requests.count, 1, "only the start was sent")

        world.api.on(
            prepare,
            Reply(
                json: Fixture.attempt(
                    "sign_in",
                    step:
                        #"{"status":"needs_first_factor","strategies":["sms_code"],"prepared":{"strategy":"sms_code","destination":"+1 *** *** **42"}}"#,
                    secret: nil)))
        world.api.on(attempt, complete())
        try await flow.prepareSmsCode()
        guard case .firstFactor(let step) = flow.screen else {
            return XCTFail("not the first factor screen")
        }
        XCTAssertEqual(step.prepared?.strategy, .smsCode)
        XCTAssertEqual(step.prepared?.destination, "+1 *** *** **42")
        let done = try await flow.attemptSmsCode("123456")
        XCTAssertEqual(done.status, "complete")

        let asked = world.api.requests(prepare)[0]
        XCTAssertEqual(Fixture.body(asked).count, 1, "only the strategy is sent")
        XCTAssertEqual(Fixture.body(asked)["strategy"] as? String, "sms_code")
        XCTAssertEqual(secret(asked), "attempt-secret-1")
        let proof = world.api.requests(attempt)[0]
        XCTAssertEqual(Fixture.body(proof)["strategy"] as? String, "sms_code")
        XCTAssertEqual(Fixture.body(proof)["code"] as? String, "123456")
        XCTAssertEqual(secret(proof), "attempt-secret-1")
        let state = await world.session.state
        XCTAssertTrue(state.isSignedIn)
    }

    func testARefusedTextedSignInCodeIsPassedOnByItsCodeAndLeavesTheStep() async throws {
        let (world, flow) = try await started(textedOnly)
        world.api.on(prepare, Reply.error(403, "auth.method_disabled"))
        let off = await thrownCode { try await flow.prepareSmsCode() }
        XCTAssertEqual(off, "auth.method_disabled")
        world.api.on(prepare, Reply.error(503, "sms.unavailable"))
        let unavailable = await thrownCode { try await flow.prepareSmsCode() }
        XCTAssertEqual(unavailable, "sms.unavailable")
        world.api.on(attempt, Reply.error(401, "auth.invalid_credentials"))
        do {
            try await flow.attemptSmsCode("CANARY-code")
            XCTFail("nothing was thrown")
        } catch {
            XCTAssertEqual((error as? TulaError)?.code, "auth.invalid_credentials")
            XCTAssertFalse(everythingOf(error).contains("CANARY"), "the code is in the error")
        }
        XCTAssertEqual(flow.step.status, "needs_first_factor")
        let state = await world.session.state
        XCTAssertFalse(state.isSignedIn)
    }

    func testATextedSignInCodeIsOneActionAtATimeAndALeftFlowDropsItsAnswer() async throws {
        let (world, flow) = try await started(textedOnly)
        let gate = Gate()
        let completed = complete()
        world.api.on(attempt) { _ in
            await gate.wait()
            return completed
        }
        let first = Task { try await flow.attemptSmsCode("123456") }
        await eventually("the code is on its way") { world.api.count(self.attempt) == 1 }
        let busy = await thrownCode { try await flow.prepareSmsCode() }
        XCTAssertEqual(busy, TulaClientErrorCode.flowBusy)
        XCTAssertEqual(world.api.count(prepare), 0)
        // Left while the code was being judged: a late `complete` signs nobody in.
        flow.discard()
        gate.open()
        let dropped = await thrownCode { _ = try await first.value }
        XCTAssertEqual(dropped, "flow.invalid_step")
        let state = await world.session.state
        XCTAssertFalse(state.isSignedIn)
        let left = await thrownCode { try await flow.prepareSmsCode() }
        XCTAssertEqual(left, "flow.invalid_step")
        XCTAssertEqual(world.api.count(prepare), 0)
    }

    // MARK: The screens

    func testATextedCodeIsAWayThisClientHasAtBothSteps() throws {
        func screen(_ json: String, _ kind: FlowKind = .signIn) throws -> FlowScreen {
            FlowScreen(step: try JSONDecoder().decode(FlowStep.self, from: Data(json.utf8)), kind: kind)
        }
        XCTAssertTrue(FlowScreen.firstFactors.contains(.smsCode))
        XCTAssertTrue(FlowScreen.secondFactors.contains(.smsCode))
        guard
            case .firstFactor = try screen(textedOnly),
            case .firstFactor = try screen(#"{"status":"needs_first_factor","strategies":["sms_code","email_link"]}"#),
            case .secondFactor = try screen(textedSecond),
            case .secondFactor = try screen(textedSecond, .passwordReset),
            case .secondFactor = try screen(#"{"status":"needs_second_factor","options":["sms_code","hardware_key"]}"#)
        else {
            return XCTFail("a texted code is a way this client can take")
        }
        // A sign-up has no second factor to ask for, texted or not.
        XCTAssertEqual(try screen(textedSecond, .signUp), .notSupported(status: "needs_second_factor"))
    }

    // MARK: A texted second factor

    func testATextedSecondFactorIsAskedForAndThenSubmitted() async throws {
        let (world, flow) = try await started(textedSecond, identifier: "maya@example.com")
        guard case .secondFactor(let offered) = flow.screen else {
            return XCTFail("not the second-factor screen")
        }
        XCTAssertEqual(offered.options, [.smsCode])
        XCTAssertEqual(world.api.requests.count, 1, "nothing is texted by arriving at the step")

        world.api.on(
            prepareSecond,
            Reply(
                json: Fixture.attempt(
                    "sign_in",
                    step:
                        #"{"status":"needs_second_factor","options":["sms_code"],"prepared":{"method":"sms_code","destination":"+1 *** *** **42"}}"#,
                    secret: nil)))
        let prepared = try await flow.prepareSmsSecondFactor()
        guard case .needsSecondFactor(let step) = prepared else {
            return XCTFail("not the second-factor step")
        }
        XCTAssertEqual(step.prepared?.method, .smsCode)
        XCTAssertEqual(step.prepared?.destination, "+1 *** *** **42")
        let asked = world.api.requests(prepareSecond)[0]
        XCTAssertEqual(Fixture.body(asked).count, 1, "only the method is sent")
        XCTAssertEqual(Fixture.body(asked)["method"] as? String, "sms_code")
        XCTAssertEqual(secret(asked), "attempt-secret-1")

        world.api.on(secondFactor, Reply.error(422, "mfa.invalid_code"))
        let wrong = await thrownCode { try await flow.submitSmsCode("000000") }
        XCTAssertEqual(wrong, "mfa.invalid_code")
        XCTAssertEqual(flow.step.status, "needs_second_factor")

        world.api.on(secondFactor, complete())
        let done = try await flow.submitSmsCode("123456")
        XCTAssertEqual(done.status, "complete")
        let proof = world.api.requests(secondFactor)[1]
        XCTAssertEqual(Fixture.body(proof)["method"] as? String, "sms_code")
        XCTAssertEqual(Fixture.body(proof)["code"] as? String, "123456")
        XCTAssertEqual(secret(proof), "attempt-secret-1")
        let state = await world.session.state
        XCTAssertTrue(state.isSignedIn)
    }

    func testATextedSecondFactorOfAResetGoesToTheResetsRoutesAndASignUpHasNone() async throws {
        let world = try World()
        world.api.on(
            "POST /v1/client/password-resets", Reply(json: Fixture.attempt("password_reset", step: textedSecond)))
        let reset = try await world.client.startPasswordReset(email: "maya@example.com")
        let route = "POST /v1/client/password-resets/att_1/second-factor/prepare"
        world.api.on(route, Reply.error(429, "rate_limited", headers: ["Retry-After": "30"]))
        do {
            try await reset.prepareSmsSecondFactor()
            XCTFail("nothing was thrown")
        } catch {
            XCTAssertEqual((error as? TulaError)?.code, "rate_limited")
            XCTAssertEqual((error as? TulaError)?.retryAfter, 30)
        }
        XCTAssertEqual(world.api.count(route), 1)
        world.api.on("POST /v1/client/password-resets/att_1/second-factor", Reply.error(403, "auth.method_disabled"))
        let off = await thrownCode { try await reset.submitSmsCode("123456") }
        XCTAssertEqual(off, "auth.method_disabled")

        world.api.on("POST /v1/client/sign-ups", Reply(json: Fixture.attempt("sign_up", step: textedSecond)))
        let signUp = try await world.client.startSignUp(email: "maya@example.com")
        let before = world.api.requests.count
        let none = await thrownCode { try await signUp.prepareSmsSecondFactor() }
        XCTAssertEqual(none, "flow.invalid_step")
        let noneSubmitted = await thrownCode { try await signUp.submitSmsCode("123456") }
        XCTAssertEqual(noneSubmitted, "flow.invalid_step")
        XCTAssertEqual(world.api.requests.count, before, "a sign-up asks nothing")
    }

    func testAskingForATextedSecondFactorIsOneActionAtATime() async throws {
        let (world, flow) = try await started(textedSecond, identifier: "maya@example.com")
        let gate = Gate()
        world.api.on(prepareSecond) { _ in
            await gate.wait()
            return Reply.error(503, "sms.unavailable")
        }
        let first = Task { try await flow.prepareSmsSecondFactor() }
        await eventually("the request is on its way") { world.api.count(self.prepareSecond) == 1 }
        let busy = await thrownCode { try await flow.submitSmsCode("123456") }
        XCTAssertEqual(busy, TulaClientErrorCode.flowBusy)
        XCTAssertEqual(world.api.count(secondFactor), 0)
        gate.open()
        let refused = await thrownCode { _ = try await first.value }
        XCTAssertEqual(refused, "sms.unavailable")
        XCTAssertEqual(flow.step.status, "needs_second_factor")
    }

    // MARK: Step-up

    func testAStepUpWithATextedCode() async throws {
        let world = try await World.signedIn()
        world.api.on(stepUpCode, Reply(json: receipt))
        let sent = try await world.client.stepUp.sendSmsCode()
        XCTAssertEqual(sent.destination, "+1 *** *** **42")
        XCTAssertEqual(sent.expiresAt, "2030-01-01T00:00:00.000Z")
        let asked = world.api.requests(stepUpCode)[0]
        XCTAssertNil(asked.httpBody)
        XCTAssertEqual(asked.value(forHTTPHeaderField: "Authorization"), "Bearer \(Fixture.accessToken("first"))")

        world.api.on(stepUp, Reply(json: Fixture.tokens("stepped")))
        try await world.client.stepUp.withSmsCode("123456")
        let proof = Fixture.body(world.api.requests(stepUp)[0])
        XCTAssertEqual(proof["method"] as? String, "sms_code")
        XCTAssertEqual(proof["code"] as? String, "123456")
        let token = try await world.session.getToken()
        XCTAssertEqual(token, Fixture.accessToken("stepped"))

        // A receipt of another method, or with no destination, is not one; a refusal is
        // passed on by its code and installs nothing.
        world.api.on(
            stepUpCode,
            Reply(json: #"{"method":"email_code","destination":"m***@example.com","expiresAt":"2030-01-01T00:00:00.000Z"}"#))
        let other = await thrownCode { _ = try await world.client.stepUp.sendSmsCode() }
        XCTAssertEqual(other, "response.invalid")
        world.api.on(stepUpCode, Reply(json: #"{"method":"sms_code","destination":"","expiresAt":"2030-01-01T00:00:00.000Z"}"#))
        let empty = await thrownCode { _ = try await world.client.stepUp.sendSmsCode() }
        XCTAssertEqual(empty, "response.invalid")
        world.api.on(stepUpCode, Reply.error(403, "auth.method_disabled"))
        let off = await thrownCode { _ = try await world.client.stepUp.sendSmsCode() }
        XCTAssertEqual(off, "auth.method_disabled")
        world.api.on(stepUp, Reply.error(422, "mfa.invalid_code"))
        let wrong = await thrownCode { try await world.client.stepUp.withSmsCode("000000") }
        XCTAssertEqual(wrong, "mfa.invalid_code")
        let kept = try await world.session.getToken()
        XCTAssertEqual(kept, Fixture.accessToken("stepped"))
    }

    // MARK: The texted factor

    func testATextedFactorIsEnrolledConfirmedAndRemoved() async throws {
        let world = try await World.signedIn()
        world.api.on(smsFactor, Reply(json: receipt))
        let sent = try await world.client.factors.startSms()
        XCTAssertEqual(sent.destination, "+1 *** *** **42")
        XCTAssertNil(world.api.requests(smsFactor)[0].httpBody)
        world.api.on(smsFactor, Reply(json: #"{"method":"sms_code","destination":"+1***","expiresAt":""}"#))
        let invalid = await thrownCode { _ = try await world.client.factors.startSms() }
        XCTAssertEqual(invalid, "response.invalid")
        world.api.on(smsFactor, Reply.error(409, "mfa.phone_number_required"))
        let noNumber = await thrownCode { _ = try await world.client.factors.startSms() }
        XCTAssertEqual(noNumber, "mfa.phone_number_required")

        // Confirming refreshes the session, so that its next token says what was proven.
        let confirm = "POST /v1/client/me/factors/sms/confirm"
        let factors =
            #"{"totp":{"enabled":false,"confirmedAt":null},"backupCodes":{"remaining":0},"sms":{"enabled":true,"enabledAt":"2026-01-01T00:00:00.000Z","inUse":true,"available":true}}"#
        world.api.on(confirm, Reply(json: factors))
        world.api.on(Fixture.refresh, Reply(json: Fixture.tokens("proven")))
        let now = try await world.client.factors.confirmSms(code: "123456")
        XCTAssertEqual(now.sms?.enabled, true)
        XCTAssertEqual(now.sms?.inUse, true)
        XCTAssertEqual(Fixture.body(world.api.requests(confirm)[0])["code"] as? String, "123456")
        let token = try await world.session.getToken()
        XCTAssertEqual(token, Fixture.accessToken("proven"))

        // When that refresh cannot be made the answer is returned all the same.
        world.api.on(confirm, Reply(json: factors))
        world.api.on(Fixture.refresh, Reply.error(503, "service.unavailable"))
        let again = try await world.client.factors.confirmSms(code: "123456")
        XCTAssertEqual(again.sms?.enabled, true)
        // A wrong code is refused by its code, and no refresh is made for it.
        let refreshes = world.api.count(Fixture.refresh)
        world.api.on(confirm, Reply.error(422, "mfa.invalid_code"))
        let wrong = await thrownCode { _ = try await world.client.factors.confirmSms(code: "000000") }
        XCTAssertEqual(wrong, "mfa.invalid_code")
        XCTAssertEqual(world.api.count(Fixture.refresh), refreshes)

        let remove = "DELETE /v1/client/me/factors/sms"
        world.api.on(remove, Reply(status: 204, json: ""))
        try await world.client.factors.disableSms()
        XCTAssertEqual(world.api.count(remove), 1)
        world.api.on(
            remove,
            Reply(
                status: 403,
                json: #"{"status":403,"code":"auth.step_up_required","detail":"x","params":{"methods":"sms_code"}}"#))
        do {
            try await world.client.factors.disableSms()
            XCTFail("nothing was thrown")
        } catch {
            XCTAssertEqual((error as? TulaError)?.stepUpMethods, ["sms_code"])
        }
    }

    // MARK: The phone number

    private func withNumber() -> String {
        Fixture.user
            .replacingOccurrences(of: #""phoneNumber":null"#, with: #""phoneNumber":"+14155550142""#)
            .replacingOccurrences(
                of: #""phoneNumberVerifiedAt":null"#, with: #""phoneNumberVerifiedAt":"2026-02-02T00:00:00.000Z""#)
    }

    private func knownUser(_ world: World) async -> CurrentUser? {
        guard case .signedIn(_, let user) = await world.session.state else {
            return nil
        }
        return user
    }

    func testAPhoneNumberIsAskedForProvenAndRemoved() async throws {
        let world = try await World.signedIn()
        world.api.on(phone, Reply(json: #"{"destination":"+1 *** *** **42","expiresAt":"2030-01-01T00:00:00.000Z"}"#))
        let sent = try await world.client.phone.request(phoneNumber: "+1 415 555 0142")
        XCTAssertEqual(sent.destination, "+1 *** *** **42")
        XCTAssertEqual(Fixture.body(world.api.requests(phone)[0])["phoneNumber"] as? String, "+1 415 555 0142")
        // Asking changed nothing of the user: there is no unverified number on an account.
        var user = await knownUser(world)
        XCTAssertNil(user?.phoneNumber)

        world.api.on(verify, Reply(json: withNumber()))
        let verified = try await world.client.phone.verify(code: "123456")
        XCTAssertEqual(verified.phoneNumber, "+14155550142")
        XCTAssertEqual(Fixture.body(world.api.requests(verify)[0])["code"] as? String, "123456")
        user = await knownUser(world)
        XCTAssertEqual(user?.phoneNumber, "+14155550142")
        XCTAssertEqual(user?.phoneNumberVerifiedAt, "2026-02-02T00:00:00.000Z")

        // Removing corrects the state's user without asking the server who they are.
        let profiles = world.api.count(Fixture.me)
        world.api.on(removePhone, Reply(status: 204, json: ""))
        try await world.client.phone.remove()
        user = await knownUser(world)
        XCTAssertEqual(user?.id, "usr_1")
        XCTAssertNil(user?.phoneNumber)
        XCTAssertNil(user?.phoneNumberVerifiedAt)
        XCTAssertEqual(world.api.count(Fixture.me), profiles)
    }

    func testARefusedPhoneCallHoldsNeitherTheNumberNorTheCodeAndChangesNoUser() async throws {
        let world = try await World.signedIn()
        world.api.on(phone, Reply.error(422, "phone.invalid"))
        do {
            _ = try await world.client.phone.request(phoneNumber: "CANARY-number")
            XCTFail("nothing was thrown")
        } catch {
            XCTAssertEqual((error as? TulaError)?.code, "phone.invalid")
            XCTAssertFalse(everythingOf(error).contains("CANARY"), "the number is in the error")
        }
        world.api.on(phone, Reply(json: #"{"destination":"","expiresAt":"2030-01-01T00:00:00.000Z"}"#))
        let invalid = await thrownCode { _ = try await world.client.phone.request(phoneNumber: "+14155550142") }
        XCTAssertEqual(invalid, "response.invalid")

        world.api.on(verify, Reply.error(422, "verification.invalid_code"))
        do {
            _ = try await world.client.phone.verify(code: "CANARY-code")
            XCTFail("nothing was thrown")
        } catch {
            XCTAssertEqual((error as? TulaError)?.code, "verification.invalid_code")
            XCTAssertFalse(everythingOf(error).contains("CANARY"), "the code is in the error")
        }
        world.api.on(
            removePhone,
            Reply(
                status: 403,
                json: #"{"status":403,"code":"auth.step_up_required","detail":"x","params":{"methods":"password"}}"#))
        do {
            try await world.client.phone.remove()
            XCTFail("nothing was thrown")
        } catch {
            XCTAssertEqual((error as? TulaError)?.stepUpMethods, ["password"])
        }
        let user = await knownUser(world)
        XCTAssertEqual(user?.id, "usr_1")
        XCTAssertNil(user?.phoneNumber)
    }

    func testAnAnswerAboutASessionThatEndedMeanwhileIsNobodysUser() async throws {
        // The user belongs to the session that asked: signed out while the code was being
        // judged, the answer is returned and installed nowhere.
        let world = try await World.signedIn()
        let gate = Gate()
        let proven = withNumber()
        world.api.on(verify) { _ in
            await gate.wait()
            return Reply(json: proven)
        }
        world.api.on(Fixture.signOut, Reply(status: 204, json: ""))
        let verifying = Task { try await world.client.phone.verify(code: "123456") }
        await eventually("the code is on its way") { world.api.count(self.verify) == 1 }
        try await world.session.signOut()
        gate.open()
        let answered = try await verifying.value
        XCTAssertEqual(answered.phoneNumber, "+14155550142")
        let state = await world.session.state
        XCTAssertEqual(state, .signedOut)

        // And with nobody signed in nothing is asked at all.
        let before = world.api.requests.count
        let nobody = await thrownCode { try await world.client.phone.remove() }
        XCTAssertEqual(nobody, "auth.unauthenticated")
        XCTAssertEqual(world.api.requests.count, before)
    }

    func testAUserOfAnotherSessionIsNotCorrected() async throws {
        let world = try await World.signedIn()
        await world.session.setUser(askedBy: "ses_other") { _ in
            XCTFail("another session's answer was looked at")
            return nil
        }
        await world.session.setUser(askedBy: nil) { _ in
            XCTFail("an answer nobody asked for was looked at")
            return nil
        }
        // A state with no user to correct installs nothing.
        await world.session.setUser(askedBy: "ses_1") { _ in nil }
        let user = await knownUser(world)
        XCTAssertEqual(user?.id, "usr_1")
    }
}
