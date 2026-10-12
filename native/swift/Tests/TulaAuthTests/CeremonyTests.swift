import Foundation
import XCTest

@testable import TulaAuth

// Passkeys, the second factor and step-up on a fake API and a fake sheet: one ceremony at a
// time, a dismissed sheet that is neither an error nor a sign-in, and nothing of a ceremony
// in an error.
final class CeremonyTests: XCTestCase {
    private let start = "POST /v1/client/sign-ins/passkey"
    private let submit = "POST /v1/client/sign-ins/att_1/passkey"
    private let signIns = "POST /v1/client/sign-ins"
    private let secondFactor = "POST /v1/client/sign-ins/att_1/second-factor"
    private let stepUp = "POST /v1/client/sessions/step-up"

    private func passkeyStart() -> Reply {
        Reply(
            json:
                #"{"attempt":\#(Fixture.attempt("sign_in", step: #"{"status":"needs_first_factor","strategies":["passkey"]}"#)),"options":\#(Fixture.requestOptions)}"#
        )
    }

    private func complete() -> Reply {
        Reply(json: Fixture.attempt("sign_in", step: Fixture.completeStep, secret: nil, session: Fixture.tokens("first")))
    }

    // MARK: Signing in with a passkey

    func testAPasskeySignInStartsShowsTheSheetAndSubmitsWhatItReturned() async throws {
        let sheet = FakeSheet()
        let world = try World(passkeys: sheet)
        world.api.on(start, passkeyStart())
        world.api.on(submit, complete())
        guard case .finished(let flow) = try await world.client.signInWithPasskey() else {
            return XCTFail("the ceremony did not finish")
        }
        XCTAssertEqual(flow.screen, .complete)
        XCTAssertEqual(sheet.asked.map(\.rpId), ["example.test"])
        XCTAssertNil(world.api.requests(start)[0].httpBody, "the start has no identifier")
        let sent = world.api.requests(submit)[0]
        XCTAssertEqual(sent.value(forHTTPHeaderField: "x-tula-attempt"), "attempt-secret-1")
        let credential = Fixture.body(sent)["credential"] as? [String: Any]
        XCTAssertEqual(credential?["id"] as? String, "Y3JlZC0x")
        XCTAssertEqual(credential?["type"] as? String, "public-key")
        let state = await world.session.state
        XCTAssertTrue(state.isSignedIn)
    }

    func testADismissedSheetIsNeitherAnErrorNorASignIn() async throws {
        let sheet = FakeSheet()
        sheet.assertion = .failure(TulaSheetError.dismissed)
        let world = try World(passkeys: sheet)
        let started = passkeyStart()
        world.api.always(start) { _ in started }
        guard case .dismissed = try await world.client.signInWithPasskey() else {
            return XCTFail("a dismissed sheet is its own outcome")
        }
        XCTAssertEqual(world.api.count(submit), 0, "nothing was sent to be judged")
        let state = await world.session.state
        XCTAssertFalse(state.isSignedIn)
        // The same call works again.
        sheet.assertion = .success(FakeSheet.goodAssertion)
        world.api.on(submit, complete())
        let again = try await world.client.signInWithPasskey()
        XCTAssertNotNil(again.value)
    }

    func testWhatASheetThrowsIsOneOfTheClientsCodesAndNothingOfItsText() async throws {
        let table: [(Error, String)] = [
            (TulaSheetError.unsupported, "passkey.unsupported"),
            (TulaSheetError.failed, "passkey.failed"),
            (TulaSheetError.alreadyOnDevice, "passkey.already_on_device"),
            (LoudFailure(), "passkey.failed"),
        ]
        for (thrown, expected) in table {
            let sheet = FakeSheet()
            sheet.assertion = .failure(thrown)
            let world = try World(passkeys: sheet)
            world.api.on(start, passkeyStart())
            do {
                _ = try await world.client.signInWithPasskey()
                XCTFail("nothing was thrown")
            } catch {
                XCTAssertEqual((error as? TulaError)?.code, expected)
                XCTAssertEqual((error as? TulaError)?.status, 0)
                XCTAssertFalse(everythingOf(error).contains("CANARY"))
            }
            XCTAssertEqual(world.api.count(submit), 0)
        }
    }

    func testNothingOfACeremonyIsInAnErrorOfTheApi() async throws {
        let sheet = FakeSheet()
        let world = try World(passkeys: sheet)
        world.api.on(start, passkeyStart())
        world.api.on(submit, Reply.error(401, "auth.invalid_credentials"))
        do {
            _ = try await world.client.signInWithPasskey()
            XCTFail("nothing was thrown")
        } catch {
            let text = everythingOf(error)
            for secret in ["Q0FOQVJZ", "Y2hhbGxlbmdl", "attempt-secret-1", "Y3JlZC0x"] {
                XCTAssertFalse(text.contains(secret), secret)
            }
            XCTAssertEqual((error as? TulaError)?.code, "auth.invalid_credentials")
        }
    }

    func testAClientWithNoSheetAndAnAnswerThatIsNoCredentialAreRefusedBeforeARequest() async throws {
        let without = try World()
        let code = await thrownCode { _ = try await without.client.signInWithPasskey() }
        XCTAssertEqual(code, "passkey.unsupported")
        XCTAssertEqual(without.api.requests.count, 0)

        let sheet = FakeSheet()
        sheet.assertion = .success(
            PasskeyAssertionCredential(
                id: "not base64 url", rawId: "x",
                response: PasskeyAssertionCredentialResponse(clientDataJSON: "a", authenticatorData: "b", signature: "c")))
        let world = try World(passkeys: sheet)
        world.api.on(start, passkeyStart())
        let bad = await thrownCode { _ = try await world.client.signInWithPasskey() }
        XCTAssertEqual(bad, "passkey.failed")
        XCTAssertEqual(world.api.count(submit), 0, "what the sheet returned is checked before it is sent")

        // Options that are not options: the answer of the API is checked before the sheet.
        let other = try World(passkeys: sheet)
        other.api.on(
            start,
            Reply(
                json:
                    #"{"attempt":\#(Fixture.attempt("sign_in", step: #"{"status":"needs_password"}"#)),"options":{"challenge":"not base64!","timeout":1,"rpId":"","userVerification":"required"}}"#
            ))
        let invalid = await thrownCode { _ = try await other.client.signInWithPasskey() }
        XCTAssertEqual(invalid, "response.invalid")
    }

    // MARK: One at a time

    func testASecondCeremonyIsRefusedBeforeAnyRequest() async throws {
        let sheet = FakeSheet()
        let hold = Gate()
        sheet.hold = hold
        let world = try await World.signedIn(passkeys: sheet)
        world.api.on(start, passkeyStart())
        world.api.on(submit, complete())
        let first = Task { try await world.client.signInWithPasskey() }
        await eventually("the sheet is out") { sheet.asked.count == 1 }
        let before = world.api.requests.count
        for second in [
            { _ = try await world.client.signInWithPasskey() },
            { _ = try await world.client.passkeys.add() },
            { _ = try await world.client.stepUp.withPasskey() },
            { _ = try await world.client.retryProviderSignIn() },
        ] as [@Sendable () async throws -> Void] {
            let code = await thrownCode(second)
            XCTAssertEqual(code, "flow.busy")
        }
        XCTAssertEqual(world.api.requests.count, before, "a second ceremony makes no request")
        hold.open()
        let outcome = try await first.value
        XCTAssertNotNil(outcome.value)
        // The place is free again.
        sheet.hold = nil
        world.api.on(start, passkeyStart())
        world.api.on(submit, complete())
        let next = try await world.client.signInWithPasskey()
        XCTAssertNotNil(next.value)
    }

    func testASheetThatNeverAnswersIsGivenUpAndALateAnswerDropped() async throws {
        let gate = CeremonyGate(ceiling: 0.05)
        let hold = Gate()
        let answer: String? = try await gate.sheet(.passkey) {
            await hold.wait()
            return "late"
        }
        XCTAssertNil(answer, "after the ceiling the ceremony is over")
        hold.open()
        // An answer in time is the answer, and the gate is free for the next ceremony.
        let inTime = try await gate.ceremony { try await gate.sheet(.provider) { "now" } }
        XCTAssertEqual(inTime, "now")
        XCTAssertEqual(CeremonyGate.sheetCeiling, 300, "the lifetime of a challenge")
        let codes = [TulaSheetError.alreadyOnDevice, .unsupported, .failed].map { CeremonyGate.Kind.provider.code($0) }
        XCTAssertEqual(codes, ["provider.failed", "provider.unsupported", "provider.failed"])
    }

    // MARK: The signed-in user's passkeys

    func testAddingAPasskeyRegistersWhatTheSheetMade() async throws {
        let sheet = FakeSheet()
        let world = try await World.signedIn(passkeys: sheet)
        world.api.on("POST /v1/client/me/passkeys/options", Reply(json: Fixture.creationOptions))
        world.api.on("POST /v1/client/me/passkeys", Reply(json: Fixture.passkey))
        guard case .finished(let passkey) = try await world.client.passkeys.add(name: "iPhone") else {
            return XCTFail("the ceremony did not finish")
        }
        XCTAssertEqual(passkey.id, "pk_1")
        XCTAssertEqual(sheet.made.map(\.rp.id), ["example.test"])
        let sent = world.api.requests("POST /v1/client/me/passkeys")[0]
        XCTAssertEqual(Fixture.body(sent)["name"] as? String, "iPhone")
        XCTAssertNotNil(sent.value(forHTTPHeaderField: "authorization"))

        sheet.registration = .failure(TulaSheetError.dismissed)
        world.api.on("POST /v1/client/me/passkeys/options", Reply(json: Fixture.creationOptions))
        guard case .dismissed = try await world.client.passkeys.add() else {
            return XCTFail("a dismissed sheet is its own outcome")
        }
        XCTAssertEqual(world.api.count("POST /v1/client/me/passkeys"), 1, "nothing was registered")

        sheet.registration = .failure(TulaSheetError.alreadyOnDevice)
        let already = await thrownCode { _ = try await world.client.passkeys.add() }
        XCTAssertEqual(already, "passkey.already_on_device")

        sheet.registration = .success(
            PasskeyRegistrationCredential(
                id: "", rawId: "",
                response: PasskeyRegistrationCredentialResponse(clientDataJSON: "a", attestationObject: "b")))
        let bad = await thrownCode { _ = try await world.client.passkeys.add() }
        XCTAssertEqual(bad, "passkey.failed")

        let without = try await World.signedIn()
        let none = await thrownCode { _ = try await without.client.passkeys.add() }
        XCTAssertEqual(none, "passkey.unsupported")
    }

    func testPasskeysAreListedRenamedAndRemoved() async throws {
        let world = try await World.signedIn()
        world.api.on("GET /v1/client/me/passkeys", Reply(json: #"{"passkeys":[\#(Fixture.passkey)]}"#))
        world.api.on("PATCH /v1/client/me/passkeys/pk_1", Reply(json: Fixture.passkey))
        world.api.on("DELETE /v1/client/me/passkeys/pk_1", Reply.error(409, "passkey.last_sign_in_method"))
        let list = try await world.client.passkeys.list()
        XCTAssertEqual(list.map(\.name), ["iPhone"])
        _ = try await world.client.passkeys.rename("pk_1", to: "Phone")
        XCTAssertEqual(
            Fixture.body(world.api.requests("PATCH /v1/client/me/passkeys/pk_1")[0])["name"] as? String, "Phone")
        let code = await thrownCode { try await world.client.passkeys.remove("pk_1") }
        XCTAssertEqual(code, "passkey.last_sign_in_method")
    }

    // MARK: The second factor in a flow

    private func atSecondFactor(passkeys: FakeSheet? = nil) async throws -> (World, SignInFlow) {
        let world = try World(passkeys: passkeys)
        world.api.on(signIns, Reply(json: Fixture.attempt("sign_in", step: Fixture.secondFactor)))
        return (world, try await world.client.startSignIn(identifier: "maya@example.com"))
    }

    func testASecondFactorIsACodeABackupCodeOrAPasskey() async throws {
        var (world, flow) = try await atSecondFactor()
        guard case .secondFactor(let step) = flow.screen else {
            return XCTFail("not the second-factor screen")
        }
        XCTAssertEqual(step.options, [.totp, .backupCode, .passkey])
        world.api.on(secondFactor, complete())
        let next = try await flow.submitTotp("123456")
        XCTAssertEqual(next.status, "complete")
        var body = Fixture.body(world.api.requests(secondFactor)[0])
        XCTAssertEqual(body["method"] as? String, "totp")
        XCTAssertEqual(body["code"] as? String, "123456")

        (world, flow) = try await atSecondFactor()
        world.api.on(
            secondFactor,
            Reply(
                json: String(
                    Fixture.attempt("sign_in", step: Fixture.completeStep, secret: nil, session: Fixture.tokens("first"))
                        .dropLast()) + #","backupCodesRemaining":9}"#))
        let spent = try await flow.submitBackupCode("abcde-fghjk")
        XCTAssertEqual(spent.remaining, 9)
        XCTAssertEqual(spent.step.status, "complete")
        body = Fixture.body(world.api.requests(secondFactor)[0])
        XCTAssertEqual(body["method"] as? String, "backup_code")

        let sheet = FakeSheet()
        (world, flow) = try await atSecondFactor(passkeys: sheet)
        world.api.on("POST /v1/client/sign-ins/att_1/second-factor/passkey/options", Reply(json: Fixture.requestOptions))
        world.api.on(secondFactor, complete())
        guard case .finished(let done) = try await flow.submitSecondFactorWithPasskey() else {
            return XCTFail("the ceremony did not finish")
        }
        XCTAssertEqual(done.status, "complete")
        body = Fixture.body(world.api.requests(secondFactor)[0])
        XCTAssertEqual(body["method"] as? String, "passkey")
        XCTAssertNotNil(body["credential"])
    }

    func testADismissedSecondFactorSheetLeavesTheStepAndAWrongCodeToo() async throws {
        let sheet = FakeSheet()
        sheet.assertion = .failure(TulaSheetError.dismissed)
        let (world, flow) = try await atSecondFactor(passkeys: sheet)
        world.api.on("POST /v1/client/sign-ins/att_1/second-factor/passkey/options", Reply(json: Fixture.requestOptions))
        guard case .dismissed = try await flow.submitSecondFactorWithPasskey() else {
            return XCTFail("a dismissed sheet is its own outcome")
        }
        XCTAssertEqual(world.api.count(secondFactor), 0)
        XCTAssertEqual(flow.step.status, "needs_second_factor")
        world.api.on(secondFactor, Reply.error(401, "auth.invalid_credentials"))
        let code = await thrownCode { _ = try await flow.submitTotp("000000") }
        XCTAssertEqual(code, "auth.invalid_credentials")
        XCTAssertEqual(flow.step.status, "needs_second_factor")

        // Without a sheet the passkey is refused before any request; a sign-up has no
        // second factor at all.
        let (bare, plain) = try await atSecondFactor()
        let unsupported = await thrownCode { _ = try await plain.submitSecondFactorWithPasskey() }
        XCTAssertEqual(unsupported, "passkey.unsupported")
        XCTAssertEqual(bare.api.requests.count, 1)
        bare.api.on(
            "POST /v1/client/sign-ups", Reply(json: Fixture.attempt("sign_up", step: Fixture.secondFactor)))
        let signUp = try await bare.client.startSignUp(email: "maya@example.com")
        let none = await thrownCode { _ = try await signUp.submitTotp("123456") }
        XCTAssertEqual(none, "flow.invalid_step")
        let nonePasskey = await thrownCode { _ = try await signUp.submitSecondFactorWithPasskey() }
        XCTAssertEqual(nonePasskey, "flow.invalid_step")
    }

    // MARK: Enrolling inside a flow

    func testAnAuthenticatorIsEnrolledInsideTheAttemptAndTheCodesAreHandedOverOnce() async throws {
        let world = try World()
        world.api.on(signIns, Reply(json: Fixture.attempt("sign_in", step: Fixture.enrolment)))
        let flow = try await world.client.startSignIn(identifier: "maya@example.com")
        guard case .factorEnrolment = flow.screen else {
            return XCTFail("not the enrolment screen")
        }
        let startRoute = "POST /v1/client/sign-ins/att_1/factor-enrolment/totp"
        let confirmRoute = "POST /v1/client/sign-ins/att_1/factor-enrolment/totp/confirm"
        world.api.on(startRoute, Reply(json: #"{"secret":"JBSWY3DPEHPK3PXP","uri":"otpauth://totp/x?secret=JBSWY3DPEHPK3PXP"}"#))
        let enrolment = try await flow.startTotpEnrolment()
        XCTAssertEqual(enrolment.secret, "JBSWY3DPEHPK3PXP")
        XCTAssertEqual(world.api.requests(startRoute)[0].value(forHTTPHeaderField: "x-tula-attempt"), "attempt-secret-1")

        let done =
            String(Fixture.attempt("sign_in", step: Fixture.completeStep, secret: nil, session: Fixture.tokens("first")).dropLast())
            + #","backupCodes":["aaaaa-bbbbb","ccccc-ddddd"]}"#
        world.api.on(confirmRoute, Reply(json: done))
        let result = try await flow.confirmTotpEnrolment(code: "123456")
        XCTAssertEqual(result.backupCodes, ["aaaaa-bbbbb", "ccccc-ddddd"])
        XCTAssertEqual(result.step.status, "complete")
        XCTAssertNil(result.failure)
        XCTAssertEqual("\(result)", "FactorEnrolmentResult", "the codes are not printed")
        XCTAssertEqual(Fixture.body(world.api.requests(confirmRoute)[0])["code"] as? String, "123456")
        let state = await world.session.state
        XCTAssertTrue(state.isSignedIn)
    }

    func testTheCodesSurviveASessionThatCouldNotBeSavedAndABadAnswerIsRefused() async throws {
        let world = try World()
        world.api.on("POST /v1/client/password-resets", Reply(json: Fixture.attempt("password_reset", step: Fixture.enrolment)))
        let flow = try await world.client.startPasswordReset(email: "maya@example.com")
        let startRoute = "POST /v1/client/password-resets/att_1/factor-enrolment/totp"
        let confirmRoute = "POST /v1/client/password-resets/att_1/factor-enrolment/totp/confirm"
        world.api.on(startRoute, Reply(json: #"{"secret":"JBSWY3DPEHPK3PXP","uri":"https://not-an-otpauth-uri"}"#))
        let invalid = await thrownCode { _ = try await flow.startTotpEnrolment() }
        XCTAssertEqual(invalid, "response.invalid")

        // A completion with no codes is not an answer of this route.
        world.api.on(
            confirmRoute,
            Reply(json: Fixture.attempt("password_reset", step: Fixture.completeStep, secret: nil, session: Fixture.tokens("first"))))
        let none = await thrownCode { _ = try await flow.confirmTotpEnrolment(code: "123456") }
        XCTAssertEqual(none, "response.invalid")
        var state = await world.session.state
        XCTAssertFalse(state.isSignedIn, "nothing was taken from an answer that was refused")

        await world.storage.fail("set")
        let done =
            String(
                Fixture.attempt("password_reset", step: Fixture.completeStep, secret: nil, session: Fixture.tokens("first"))
                    .dropLast()) + #","backupCodes":["aaaaa-bbbbb"]}"#
        world.api.on(confirmRoute, Reply(json: done))
        let result = try await flow.confirmTotpEnrolment(code: "123456")
        XCTAssertEqual(result.backupCodes, ["aaaaa-bbbbb"], "shown once by the server, so handed over all the same")
        XCTAssertEqual(result.failure?.code, "storage.failed")
        state = await world.session.state
        XCTAssertTrue(state.isSignedIn)
    }

    // MARK: Step-up and the user's factors

    func testAStepUpInstallsOnlyTheAccessTokenOfItsAnswer() async throws {
        let world = try await World.signedIn()
        world.api.on(stepUp, Reply(json: Fixture.tokens("stepped")))
        try await world.client.stepUp.withTotp("123456")
        let token = try await world.session.getToken()
        XCTAssertEqual(token, Fixture.accessToken("stepped"))
        let stored = await world.storage.only
        XCTAssertEqual(stored, "refresh-first", "a refresh token in a step-up's answer replaces nothing")
        let sent = world.api.requests(stepUp)[0]
        XCTAssertEqual(sent.value(forHTTPHeaderField: "authorization"), "Bearer \(Fixture.accessToken("first"))")
        XCTAssertEqual(Fixture.body(sent)["method"] as? String, "totp")

        let methods: [(String, @Sendable () async throws -> Void)] = [
            ("password", { try await world.client.stepUp.withPassword("a long passphrase") }),
            ("backup_code", { try await world.client.stepUp.withBackupCode("aaaaa-bbbbb") }),
            ("email_code", { try await world.client.stepUp.withEmailCode("123456") }),
        ]
        for (method, call) in methods {
            world.api.on(stepUp, Reply(json: Fixture.tokens("stepped")))
            try await call()
            XCTAssertEqual(Fixture.body(world.api.requests(stepUp).last ?? URLRequest(url: URL(fileURLWithPath: "/")))["method"] as? String, method)
        }
    }

    func testAStepUpForAnotherSessionOrABadAnswerIsRefused() async throws {
        let world = try await World.signedIn()
        world.api.on(stepUp, Reply(json: Fixture.tokens("other", session: "ses_2")))
        let foreign = await thrownCode { try await world.client.stepUp.withTotp("123456") }
        XCTAssertEqual(foreign, "auth.unauthenticated")
        world.api.on(stepUp, Reply(json: #"{"sessionId":"ses_1"}"#))
        let invalid = await thrownCode { try await world.client.stepUp.withTotp("123456") }
        XCTAssertEqual(invalid, "response.invalid")
        world.api.on(stepUp, Reply.error(401, "auth.invalid_credentials"))
        let wrong = await thrownCode { try await world.client.stepUp.withPassword("wrong") }
        XCTAssertEqual(wrong, "auth.invalid_credentials")
        let token = try await world.session.getToken()
        XCTAssertEqual(token, Fixture.accessToken("first"), "a refused step-up changes nothing")

        let signedOut = try World()
        _ = try await signedOut.session.load()
        let nobody = await thrownCode { try await signedOut.client.stepUp.withTotp("123456") }
        XCTAssertEqual(nobody, "auth.unauthenticated")
    }

    func testAStepUpOvertakenByARefreshIsCarriedByOneRefreshStartedAfterIt() async throws {
        let world = try await World.signedIn()
        let gate = Gate()
        world.api.on(stepUp) { _ in
            await gate.wait()
            return Reply(json: Fixture.tokens("stepped"))
        }
        let proving = Task { try await world.client.stepUp.withTotp("123456") }
        await eventually("the proof is on its way") { world.api.count(self.stepUp) == 1 }
        world.api.on(Fixture.refresh, Reply(json: Fixture.tokens("second")))
        _ = try await world.session.refresh()
        world.api.on(Fixture.refresh, Reply(json: Fixture.tokens("third")))
        gate.open()
        try await proving.value
        let token = try await world.session.getToken()
        XCTAssertEqual(token, Fixture.accessToken("third"), "neither earlier token is trusted")
        XCTAssertEqual(world.api.count(Fixture.refresh), 3)
    }

    func testAStepUpWithAPasskeyAndWithAnEmailedCode() async throws {
        let sheet = FakeSheet()
        let world = try await World.signedIn(passkeys: sheet)
        world.api.on("POST /v1/client/sessions/step-up/passkey", Reply(json: Fixture.requestOptions))
        world.api.on(stepUp, Reply(json: Fixture.tokens("stepped")))
        guard case .finished = try await world.client.stepUp.withPasskey() else {
            return XCTFail("the ceremony did not finish")
        }
        XCTAssertEqual(Fixture.body(world.api.requests(stepUp)[0])["method"] as? String, "passkey")
        sheet.assertion = .failure(TulaSheetError.dismissed)
        guard case .dismissed = try await world.client.stepUp.withPasskey() else {
            return XCTFail("a dismissed sheet is its own outcome")
        }
        XCTAssertEqual(world.api.count(stepUp), 1)

        let route = "POST /v1/client/sessions/step-up/email-code"
        world.api.on(
            route, Reply(json: #"{"method":"email_code","destination":"m***@example.com","expiresAt":"2030-01-01T00:00:00.000Z"}"#))
        let sent = try await world.client.stepUp.sendEmailCode()
        XCTAssertEqual(sent.destination, "m***@example.com")
        world.api.on(route, Reply(json: #"{"method":"sms_code","destination":"+1***","expiresAt":"2030-01-01T00:00:00.000Z"}"#))
        let invalid = await thrownCode { _ = try await world.client.stepUp.sendEmailCode() }
        XCTAssertEqual(invalid, "response.invalid")
    }

    func testTheMethodsOfAStepUpRequirementAreRead() {
        let required = TulaError(
            code: "auth.step_up_required", status: 403, params: ["methods": .string("passkey, password,email_code,")])
        XCTAssertEqual(required.stepUpMethods, ["passkey", "password", "email_code"])
        XCTAssertEqual(TulaError(code: "auth.step_up_required", status: 403).stepUpMethods, [])
        XCTAssertEqual(
            TulaError(code: "auth.invalid_credentials", status: 401, params: ["methods": .string("totp")]).stepUpMethods, [])
    }

    func testTheUsersFactorsAreReadEnrolledAndRemoved() async throws {
        let world = try await World.signedIn()
        world.api.on(
            "GET /v1/client/me/factors",
            Reply(json: #"{"totp":{"enabled":false,"confirmedAt":null},"backupCodes":{"remaining":0}}"#))
        let factors = try await world.client.factors.get()
        XCTAssertFalse(factors.totp.enabled)

        world.api.on("POST /v1/client/me/factors/totp", Reply(json: #"{"secret":"JBSWY3DPEHPK3PXP","uri":"otpauth://totp/x"}"#))
        let enrolment = try await world.client.factors.startTotp()
        XCTAssertEqual(enrolment.uri, "otpauth://totp/x")
        world.api.on("POST /v1/client/me/factors/totp", Reply(json: #"{"secret":"","uri":"otpauth://totp/x"}"#))
        let invalid = await thrownCode { _ = try await world.client.factors.startTotp() }
        XCTAssertEqual(invalid, "response.invalid")

        // Confirming refreshes the session, so that its next token says the factor was proven.
        world.api.on("POST /v1/client/me/factors/totp/confirm", Reply(json: #"{"codes":["aaaaa-bbbbb"]}"#))
        world.api.on(Fixture.refresh, Reply(json: Fixture.tokens("proven")))
        let codes = try await world.client.factors.confirmTotp(code: "123456")
        XCTAssertEqual(codes, ["aaaaa-bbbbb"])
        let token = try await world.session.getToken()
        XCTAssertEqual(token, Fixture.accessToken("proven"))

        // When that refresh cannot be made the codes are returned all the same.
        world.api.on("POST /v1/client/me/factors/totp/confirm", Reply(json: #"{"codes":["ccccc-ddddd"]}"#))
        world.api.on(Fixture.refresh, Reply.error(503, "service.unavailable"))
        let again = try await world.client.factors.confirmTotp(code: "123456")
        XCTAssertEqual(again, ["ccccc-ddddd"])

        world.api.on("POST /v1/client/me/factors/backup-codes", Reply(json: #"{"codes":[]}"#))
        let empty = await thrownCode { _ = try await world.client.factors.regenerateBackupCodes() }
        XCTAssertEqual(empty, "response.invalid")
        world.api.on("POST /v1/client/me/factors/backup-codes", Reply(json: #"{"codes":["eeeee-fffff"]}"#))
        let fresh = try await world.client.factors.regenerateBackupCodes()
        XCTAssertEqual(fresh, ["eeeee-fffff"])

        world.api.on(
            "DELETE /v1/client/me/factors/totp",
            Reply(
                status: 403,
                json: #"{"status":403,"code":"auth.step_up_required","detail":"x","params":{"methods":"totp,backup_code"}}"#))
        do {
            try await world.client.factors.disableTotp()
            XCTFail("nothing was thrown")
        } catch {
            XCTAssertEqual((error as? TulaError)?.stepUpMethods, ["totp", "backup_code"])
        }
    }
}
