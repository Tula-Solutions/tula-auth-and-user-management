import Foundation
import TulaAuth
import XCTest

@testable import TulaAuthUI

// What is behind the screens: which screen a step of the server is, what a field holds and
// when it stops holding it, where a problem is shown and in whose words, and what becomes of
// a flow that is left.
@MainActor
final class ModelTests: XCTestCase {
    // MARK: A screen per step

    func testAPasswordSignInGoesFromTheAddressToThePasswordToSignedIn() async throws {
        let stage = try Stage()
        XCTAssertEqual(stage.model.screen, .signInStart)
        await stage.signIn(to: Wire.needsPassword)
        XCTAssertEqual(stage.model.screen, .password(canEmailCode: false))
        XCTAssertEqual(stage.api.body(Wire.signIns)["identifier"] as? String, "maya@example.com")

        stage.api.on(Wire.password, Wire.flow("sign_in", Wire.complete))
        stage.model.password = Canary.password
        await stage.model.submitPassword()

        XCTAssertEqual(stage.model.screen, .signedIn)
        XCTAssertEqual(stage.api.body(Wire.password)["password"] as? String, Canary.password)
        XCTAssertEqual(stage.heard.signedIn, 1)
        let signedIn = await stage.isSignedIn
        XCTAssertTrue(signedIn)
        XCTAssertEqual(stage.model.password, "")
        XCTAssertFalse(stage.model.isPending)
    }

    func testTheAddressIsTrimmedBeforeItIsSent() async throws {
        let stage = try Stage()
        stage.api.on(Wire.signIns, Wire.flow("sign_in", Wire.needsPassword, start: true))
        stage.model.email = "  maya@example.com \n"
        await stage.model.start()
        XCTAssertEqual(stage.api.body(Wire.signIns)["identifier"] as? String, "maya@example.com")
    }

    func testWhereAStepOffersBothWaysThePasswordIsAskedAndNothingIsEmailedByArriving() async throws {
        let stage = try Stage()
        await stage.signIn(to: Wire.both)
        XCTAssertEqual(stage.model.screen, .password(canEmailCode: true))
        XCTAssertEqual(stage.api.count(Wire.prepare), 0)

        stage.api.on(Wire.prepare, Wire.flow("sign_in", Wire.bothPrepared))
        stage.model.password = "half typed"
        await stage.model.sendEmailCode()
        XCTAssertEqual(stage.model.screen, .emailCode(destination: "m***@example.com", canUsePassword: true))
        XCTAssertEqual(stage.model.password, "", "a password is not kept once its screen is left")

        stage.model.code = "123"
        stage.model.usePassword()
        XCTAssertEqual(stage.model.screen, .password(canEmailCode: true))
        XCTAssertEqual(stage.model.code, "", "a code is not kept once its screen is left")
    }

    func testWhereACodeIsTheOnlyWayItIsAskedForAtOnce() async throws {
        let stage = try Stage()
        stage.api.on(Wire.prepare, Wire.flow("sign_in", Wire.codeOnlyPrepared))
        await stage.signIn(to: Wire.codeOnly)
        XCTAssertEqual(stage.model.screen, .emailCode(destination: "m***@example.com", canUsePassword: false))
        XCTAssertEqual(stage.api.count(Wire.prepare), 1)

        // There is no password to go back to.
        stage.model.usePassword()
        XCTAssertEqual(stage.model.screen, .emailCode(destination: "m***@example.com", canUsePassword: false))

        stage.api.on(Wire.attempt, Wire.flow("sign_in", Wire.complete))
        stage.model.code = "123456"
        await stage.model.submitCode()
        XCTAssertEqual(stage.model.screen, .signedIn)
        XCTAssertEqual(stage.api.body(Wire.attempt)["code"] as? String, "123456")
    }

    func testACodeThatCouldNotBeAskedForLeavesTheStartAndNoAttempt() async throws {
        let stage = try Stage()
        stage.api.on(Wire.prepare, Reply.error(429, "rate_limited", headers: ["retry-after": "61"]))
        await stage.signIn(to: Wire.codeOnly)
        XCTAssertEqual(stage.model.screen, .signInStart)
        XCTAssertEqual(stage.model.formError, "Too many requests. Try again shortly. Try again in 1m 1s.")
        XCTAssertFalse(stage.model.isPending)

        // The attempt was discarded: nothing can be sent for it.
        await stage.model.sendEmailCode()
        await stage.model.submitCode()
        XCTAssertEqual(stage.api.routes, [Wire.signIns, Wire.prepare])
    }

    func testACodeOfferedBesideAWayThisVersionLacksIsOfferedAndNotSentByArriving() async throws {
        let stage = try Stage()
        await stage.signIn(to: #"{"status":"needs_first_factor","strategies":["email_code","email_link"]}"#)
        XCTAssertEqual(stage.model.screen, .emailCodeOffer)
        XCTAssertEqual(stage.api.count(Wire.prepare), 0)

        stage.api.on(Wire.prepare, Wire.flow("sign_in", Wire.codeOnlyPrepared))
        await stage.model.sendEmailCode()
        XCTAssertEqual(stage.model.screen, .emailCode(destination: "m***@example.com", canUsePassword: false))
        XCTAssertEqual(stage.api.body(Wire.prepare)["strategy"] as? String, "email_code")

        // "Send a new email" asks again and says so.
        await stage.model.resendCode()
        XCTAssertEqual(stage.api.count(Wire.prepare), 2)
        XCTAssertEqual(stage.model.status, "A new email is on its way.")
    }

    func testAStepThatWasAlreadyPreparedIsTheCodeScreen() async throws {
        let stage = try Stage()
        await stage.signIn(to: Wire.codeOnlyPrepared)
        XCTAssertEqual(stage.model.screen, .emailCode(destination: "m***@example.com", canUsePassword: false))
        XCTAssertEqual(stage.api.count(Wire.prepare), 0)
    }

    func testASignUpProvesItsAddressWithTheEmailedCode() async throws {
        let stage = try Stage(mode: .signUp)
        XCTAssertEqual(stage.model.screen, .signUpStart)
        stage.api.on(Wire.signUps, Wire.flow("sign_up", Wire.verification, start: true))
        stage.model.email = "maya@example.com"
        stage.model.password = Canary.password
        await stage.model.start()
        XCTAssertEqual(stage.model.screen, .emailVerification(destination: "m***@example.com"))
        XCTAssertEqual(stage.api.body(Wire.signUps)["password"] as? String, Canary.password)
        XCTAssertEqual(stage.model.password, "")

        // Half a code is said without a request.
        stage.model.code = "123"
        await stage.model.submitCode()
        XCTAssertEqual(stage.model.fieldErrors[.code], ["Enter the 6-digit code."])
        XCTAssertEqual(stage.model.focus, .field(.code))
        XCTAssertEqual(stage.api.count(Wire.signUpVerify), 0)

        stage.api.on(Wire.signUpResend, Wire.flow("sign_up", Wire.verification))
        await stage.model.resendCode()
        XCTAssertEqual(stage.model.status, "A new code is on its way.")
        XCTAssertEqual(stage.heard.said.last, "A new code is on its way.")
        XCTAssertEqual(stage.model.fieldErrors, [:])

        stage.api.on(Wire.signUpVerify, Wire.flow("sign_up", Wire.complete))
        stage.model.code = "123456"
        await stage.model.submitCode()
        XCTAssertEqual(stage.model.screen, .signedIn)
        XCTAssertEqual(stage.model.code, "")
        XCTAssertNil(stage.model.status)
        XCTAssertEqual(stage.heard.signedIn, 1)
    }

    func testASignInOfAnUnprovenAddressAsksForTheEmailedCode() async throws {
        let stage = try Stage()
        await stage.signIn(to: Wire.needsPassword)
        stage.api.on(Wire.password, Wire.flow("sign_in", Wire.verification))
        stage.model.password = Canary.password
        await stage.model.submitPassword()
        XCTAssertEqual(stage.model.screen, .emailVerification(destination: "m***@example.com"))

        stage.api.on(Wire.signInVerify, Wire.flow("sign_in", Wire.complete))
        stage.model.code = "123456"
        await stage.model.submitCode()
        XCTAssertEqual(stage.model.screen, .signedIn)
    }

    func testAResetAsksForTheCodeAndTheNewPasswordTogether() async throws {
        let stage = try Stage()
        stage.model.email = "maya@example.com"
        stage.model.showReset()
        XCTAssertEqual(stage.model.screen, .resetStart)
        XCTAssertEqual(stage.model.email, "maya@example.com", "the address typed for the sign-in is carried over")

        stage.api.on(Wire.resets, Wire.flow("password_reset", Wire.reset, start: true))
        await stage.model.start()
        XCTAssertEqual(stage.model.screen, .newPassword(destination: "m***@example.com"))

        // Both are missing: both are said, the first takes the focus, nothing is sent.
        await stage.model.submitNewPassword()
        XCTAssertEqual(stage.model.fieldErrors[.code], ["Enter the 6-digit code."])
        XCTAssertEqual(stage.model.fieldErrors[.newPassword], ["This field is required."])
        XCTAssertEqual(stage.model.focus, .field(.code))

        stage.model.code = "123456"
        await stage.model.submitNewPassword()
        XCTAssertEqual(stage.model.fieldErrors, [.newPassword: ["This field is required."]])
        XCTAssertEqual(stage.api.count(Wire.resetSubmit), 0)

        stage.api.on(Wire.resetResend, Wire.flow("password_reset", Wire.reset))
        await stage.model.resendCode()
        XCTAssertEqual(stage.model.status, "A new code is on its way.")

        stage.api.on(Wire.resetSubmit, Wire.flow("password_reset", Wire.complete))
        stage.model.newPassword = Canary.password
        await stage.model.submitNewPassword()
        XCTAssertEqual(stage.model.screen, .signedIn)
        XCTAssertEqual(stage.api.body(Wire.resetSubmit)["code"] as? String, "123456")
        XCTAssertEqual(stage.api.body(Wire.resetSubmit)["password"] as? String, Canary.password)
        XCTAssertEqual(stage.model.newPassword, "")
        XCTAssertEqual(stage.model.code, "")
    }

    func testAnExpiredPasswordIsReplacedAsTheLastStepOfTheSignIn() async throws {
        let stage = try Stage()
        await stage.signIn(to: Wire.needsPassword)
        stage.api.on(Wire.password, Wire.flow("sign_in", Wire.expired))
        stage.model.password = "the old one"
        await stage.model.submitPassword()
        XCTAssertEqual(stage.model.screen, .expiredPassword)

        await stage.model.submitNewPassword()
        XCTAssertEqual(stage.model.fieldErrors, [.newPassword: ["This field is required."]])
        XCTAssertEqual(stage.api.count(Wire.newPassword), 0)

        stage.api.on(Wire.newPassword, Reply.error(422, "password.reused"))
        stage.model.newPassword = "the old one"
        await stage.model.submitNewPassword()
        XCTAssertEqual(stage.model.screen, .expiredPassword)
        XCTAssertEqual(stage.model.fieldErrors[.newPassword]?.count, 1)
        XCTAssertNil(stage.model.formError)

        stage.api.on(Wire.newPassword, Wire.flow("sign_in", Wire.complete))
        stage.model.newPassword = Canary.password
        await stage.model.submitNewPassword()
        XCTAssertEqual(stage.model.screen, .signedIn)
    }

    // MARK: Not supported

    func testAStepWithNoScreenIsNotSupportedAndNeverBlank() async throws {
        let steps = [
            // A second step whose every way is one of tomorrow, and one whose only way is a
            // passkey on a client the app gave no sheet. (The second step and the enrolment
            // themselves have screens now: SecondStepTests.)
            (#"{"status":"needs_second_factor","options":["retina_scan"]}"#, "needs_second_factor"),
            (#"{"status":"needs_second_factor","options":["passkey"]}"#, "needs_second_factor"),
            (Wire.tomorrow, "needs_a_step_of_tomorrow"),
            (#"{"status":"needs_first_factor","strategies":["passkey","oauth_google"]}"#, "needs_first_factor"),
            // (A step whose one way for something typed is a texted code is no longer here:
            // what is not a number is said at the first field. TextedCodeScreenTests.)
            (#"{"status":"needs_new_password","destination":"m***@example.com","strategies":[],"reason":"compromised"}"#, "needs_new_password"),
        ]
        for (step, status) in steps {
            let stage = try Stage()
            await stage.signIn(to: step)
            XCTAssertEqual(stage.model.screen, .notSupported(status: status), step)
            XCTAssertEqual(stage.model.screen.fields, [])
            XCTAssertNil(stage.model.formError, "not an error: a screen of its own")

            // No action is sent on a guess.
            await stage.model.submitPassword()
            await stage.model.submitCode()
            await stage.model.sendEmailCode()
            await stage.model.resendCode()
            await stage.model.submitNewPassword()
            XCTAssertEqual(stage.api.routes, [Wire.signIns], step)

            // The way out is the start of the same kind of flow.
            stage.model.startAgain()
            XCTAssertEqual(stage.model.screen, .signInStart)
        }
    }

    func testStartAgainGoesToTheStartOfTheFlowThatWasOpen() async throws {
        let stage = try Stage()
        stage.model.showSignUp()
        stage.api.on(Wire.signUps, Wire.flow("sign_up", Wire.secondFactor, start: true))
        stage.model.email = "maya@example.com"
        stage.model.password = Canary.password
        await stage.model.start()
        XCTAssertEqual(stage.model.screen, .notSupported(status: "needs_second_factor"))
        stage.model.startAgain()
        XCTAssertEqual(stage.model.screen, .signUpStart)
    }

    // MARK: What a field holds, and when it stops

    func testASignInPasswordIsEmptiedAsItIsSentRightOrWrong() async throws {
        let stage = try Stage()
        await stage.signIn(to: Wire.needsPassword)
        let gate = Gate()
        stage.api.on(Wire.password) { _ in
            await gate.wait()
            return Reply.error(401, "auth.invalid_credentials")
        }
        stage.model.password = Canary.password
        let sending = Task { await stage.model.submitPassword() }
        await eventually("the password is sent") { stage.api.count(Wire.password) == 1 }
        XCTAssertEqual(stage.model.password, "", "not kept while the answer is on its way")
        XCTAssertTrue(stage.model.isPending)
        gate.open()
        await sending.value
        XCTAssertEqual(stage.model.password, "")
        XCTAssertEqual(stage.model.screen, .password(canEmailCode: false))
    }

    func testEveryChangeOfScreenEmptiesThePasswordTheCodeAndTheNewPassword() async throws {
        let stage = try Stage()
        let fill = {
            stage.model.password = Canary.password
            stage.model.code = "123456"
            stage.model.newPassword = Canary.password
        }
        let moves: [(String, () -> Void)] = [
            ("sign-up", { stage.model.showSignUp() }), ("sign-in", { stage.model.showSignIn() }),
            ("reset", { stage.model.showReset() }), ("start again", { stage.model.startAgain() }),
            ("close", { stage.model.close() }),
        ]
        for (name, move) in moves {
            fill()
            move()
            XCTAssertEqual([stage.model.password, stage.model.code, stage.model.newPassword], ["", "", ""], name)
        }
        XCTAssertEqual(stage.model.email, "", "a closed screen forgets the address too")
    }

    func testTheModelPrintsAsItsNameAndNothingItHolds() async throws {
        let stage = try Stage()
        stage.model.email = "maya@example.com"
        stage.model.password = Canary.password
        stage.model.code = "654321"
        var dumped = ""
        dump(stage.model, to: &dumped)
        for text in ["\(stage.model)", String(reflecting: stage.model), dumped] {
            XCTAssertFalse(text.contains(Canary.password), text)
            XCTAssertFalse(text.contains("654321"), text)
            XCTAssertFalse(text.contains("maya"), text)
        }
    }

    func testACodeFieldKeepsSixAsciiDigits() {
        XCTAssertEqual(TulaAuthModel.digits("12 34-56"), "123456")
        XCTAssertEqual(TulaAuthModel.digits("1234567890"), "123456")
        XCTAssertEqual(TulaAuthModel.digits("abc"), "")
        XCTAssertEqual(TulaAuthModel.digits("١٢٣456"), "456", "digits of another script are not a code")
    }

    // MARK: A flow that is left

    func testAnAnswerThatArrivesAfterTheScreenWasLeftSignsNobodyIn() async throws {
        let stage = try Stage()
        await stage.signIn(to: Wire.needsPassword)
        let gate = Gate()
        stage.api.on(Wire.password) { _ in
            await gate.wait()
            return Wire.flow("sign_in", Wire.complete)
        }
        stage.model.password = Canary.password
        let sending = Task { await stage.model.submitPassword() }
        await eventually("the password is sent") { stage.api.count(Wire.password) == 1 }

        stage.model.showSignUp()
        XCTAssertEqual(stage.model.screen, .signUpStart)
        XCTAssertFalse(stage.model.isPending, "the screen that was opened is usable at once")
        gate.open()
        await sending.value

        XCTAssertEqual(stage.model.screen, .signUpStart)
        XCTAssertEqual(stage.heard.signedIn, 0)
        let signedIn = await stage.isSignedIn
        XCTAssertFalse(signedIn, "the flow was discarded: its late answer is dropped by the client")
        XCTAssertNil(stage.model.formError)
    }

    func testAStartThatAnswersAfterTheScreenClosedIsDiscarded() async throws {
        let stage = try Stage()
        let gate = Gate()
        stage.api.on(Wire.signIns) { _ in
            await gate.wait()
            return Wire.flow("sign_in", Wire.needsPassword, start: true)
        }
        stage.model.email = "maya@example.com"
        let starting = Task { await stage.model.start() }
        await eventually("the start is sent") { stage.api.count(Wire.signIns) == 1 }
        stage.model.close()
        gate.open()
        await starting.value

        XCTAssertEqual(stage.model.screen, .signInStart)
        XCTAssertEqual(stage.model.email, "")
        // The attempt that came back is nobody's: no action of the model reaches it.
        stage.model.password = "anything"
        await stage.model.submitPassword()
        XCTAssertEqual(stage.api.routes, [Wire.signIns])
    }

    func testAFailureThatArrivesAfterTheScreenWasLeftIsNotShown() async throws {
        let stage = try Stage()
        await stage.signIn(to: Wire.needsPassword)
        let gate = Gate()
        stage.api.on(Wire.password) { _ in
            await gate.wait()
            return Reply.error(401, "auth.invalid_credentials")
        }
        stage.model.password = Canary.password
        let sending = Task { await stage.model.submitPassword() }
        await eventually("the password is sent") { stage.api.count(Wire.password) == 1 }
        stage.model.showReset()
        gate.open()
        await sending.value
        XCTAssertEqual(stage.model.screen, .resetStart)
        XCTAssertEqual(stage.model.fieldErrors, [:])
        XCTAssertNil(stage.model.formError)
    }

    func testLeavingDiscardsTheAttempt() async throws {
        let stage = try Stage()
        await stage.signIn(to: Wire.both)
        stage.model.showSignIn()
        XCTAssertEqual(stage.model.screen, .signInStart)
        await stage.model.sendEmailCode()
        stage.model.password = "anything"
        await stage.model.submitPassword()
        XCTAssertEqual(stage.api.routes, [Wire.signIns])
    }

    func testOneActionAtATime() async throws {
        let stage = try Stage()
        let gate = Gate()
        stage.api.on(Wire.signIns) { _ in
            await gate.wait()
            return Wire.flow("sign_in", Wire.needsPassword, start: true)
        }
        stage.model.email = "maya@example.com"
        let first = Task { await stage.model.start() }
        await eventually("the start is sent") { stage.api.count(Wire.signIns) == 1 }
        await stage.model.start()
        XCTAssertEqual(stage.api.count(Wire.signIns), 1, "a second tap while the first is on its way sends nothing")
        gate.open()
        await first.value
        XCTAssertEqual(stage.model.screen, .password(canEmailCode: false))
    }

    // MARK: Where a problem is shown, and in whose words

    func testAnEmptyFieldIsSaidAtTheFieldWithoutARequest() async throws {
        let stage = try Stage(mode: .signUp)
        let before = stage.model.focusRequests
        await stage.model.start()
        XCTAssertEqual(
            stage.model.fieldErrors, [.email: ["This field is required."], .password: ["This field is required."]])
        XCTAssertEqual(stage.model.focus, .field(.email))
        XCTAssertEqual(stage.model.focusRequests, before + 1)
        XCTAssertEqual(stage.heard.said, ["This field is required."])
        XCTAssertEqual(stage.api.routes, [])
    }

    func testARefusedPasswordIsSaidAtThePasswordInTheContractsWords() async throws {
        let stage = try Stage()
        await stage.signIn(to: Wire.needsPassword)
        stage.api.on(Wire.password, Reply.error(401, "auth.invalid_credentials"))
        stage.model.password = Canary.password
        let before = stage.model.focusRequests
        await stage.model.submitPassword()

        XCTAssertEqual(stage.model.fieldErrors, [.password: ["The email or password is incorrect."]])
        XCTAssertNil(stage.model.formError)
        XCTAssertEqual(stage.model.focus, .field(.password))
        XCTAssertEqual(stage.model.focusRequests, before + 1)
        XCTAssertEqual(stage.heard.said.last, "The email or password is incorrect.")
        XCTAssertFalse(stage.shown.contains(Canary.serverText))
        XCTAssertFalse(stage.shown.contains(Canary.password))
    }

    func testACodeThisVersionDoesNotKnowIsSaidWithTheFallbackNeverTheServersWords() async throws {
        let stage = try Stage()
        stage.api.on(Wire.signIns, Reply.error(418, "teapot.of_tomorrow"))
        stage.model.email = "maya@example.com"
        await stage.model.start()
        XCTAssertEqual(stage.model.formError, "Something went wrong. Try again.")
        XCTAssertEqual(stage.heard.said, ["Something went wrong. Try again."])
        XCTAssertFalse(stage.shown.contains(Canary.serverText))
        XCTAssertEqual(stage.model.screen, .signInStart)
    }

    func testAnAnswerThatIsNoAnswerIsSaidByTheClientsCode() async throws {
        let stage = try Stage()
        stage.api.on(Wire.signIns, Reply(status: 200, json: "<html>\(Canary.serverText)</html>"))
        stage.model.email = "maya@example.com"
        await stage.model.start()
        XCTAssertNotNil(stage.model.formError)
        XCTAssertNotEqual(stage.model.formError, "Something went wrong. Try again.", "a code of the client's own has a sentence")
        XCTAssertFalse(stage.shown.contains(Canary.serverText))
    }

    func testEachRefusedRuleIsSaidUnderItsField() async throws {
        let stage = try Stage(mode: .signUp)
        stage.api.on(
            Wire.signUps,
            Reply(
                status: 422,
                json:
                    #"{"status":422,"code":"validation.failed","detail":"\#(Canary.serverText)","errors":[{"field":"password","code":"password.too_short","message":"\#(Canary.serverText)","params":{"min":10}},{"field":"password","code":"password.too_short","message":"again"},{"field":"password","code":"password.rule_of_tomorrow","message":"\#(Canary.serverText)"},{"field":"email","code":"email.invalid","message":"\#(Canary.serverText)"},{"field":"firstName","code":"validation.failed","message":"\#(Canary.serverText)"}]}"#
            ))
        stage.model.email = "maya"
        stage.model.password = "short"
        await stage.model.start()

        let password = stage.model.fieldErrors[.password] ?? []
        XCTAssertEqual(password.count, 2, "a rule said twice is shown once")
        XCTAssertEqual(password.last, "Something went wrong. Try again.")
        XCTAssertEqual(stage.model.fieldErrors[.email]?.count, 1)
        XCTAssertNotNil(stage.model.formError, "a problem with no field of this screen is said above the form")
        XCTAssertEqual(stage.model.focus, .field(.email), "the first field with a problem takes the focus")
        XCTAssertFalse(stage.shown.contains(Canary.serverText))
    }

    func testAProblemOfAFieldTheScreenDoesNotHaveIsSaidAboveTheForm() async throws {
        let stage = try Stage()
        stage.api.on(Wire.signIns, Reply.error(422, "password.too_short"))
        stage.model.email = "maya@example.com"
        let before = stage.model.focusRequests
        await stage.model.start()
        XCTAssertEqual(stage.model.fieldErrors, [:])
        XCTAssertNotNil(stage.model.formError)
        XCTAssertEqual(stage.model.focusRequests, before, "no field to move to")
    }

    func testAWrongCodeIsSaidAtTheCode() async throws {
        let stage = try Stage(mode: .signUp)
        stage.api.on(Wire.signUps, Wire.flow("sign_up", Wire.verification, start: true))
        stage.model.email = "maya@example.com"
        stage.model.password = Canary.password
        await stage.model.start()
        stage.api.on(Wire.signUpVerify, Reply.error(400, "verification.invalid_code"))
        stage.model.code = "000000"
        await stage.model.submitCode()
        XCTAssertEqual(stage.model.fieldErrors[.code]?.count, 1)
        XCTAssertEqual(stage.model.focus, .field(.code))
    }

    func testAWaitTheServerAsksForIsSaidInWords() async throws {
        let stage = try Stage()
        stage.api.on(Wire.signIns, Reply.error(429, "rate_limited", headers: ["retry-after": "42"]))
        stage.model.email = "maya@example.com"
        await stage.model.start()
        XCTAssertEqual(stage.model.formError, "Too many requests. Try again shortly. Try again in 42s.")
    }

    func testAMessageOfTheAppsOwnTableIsUsed() async throws {
        var strings = TulaStrings.english
        strings.errors["auth.invalid_credentials"] = "Das stimmt nicht."
        strings.required = "Pflichtfeld."
        let stage = try Stage(strings: strings)
        await stage.model.start()
        XCTAssertEqual(stage.model.fieldErrors[.email], ["Pflichtfeld."])
        await stage.signIn(to: Wire.needsPassword)
        stage.api.on(Wire.password, Reply.error(401, "auth.invalid_credentials"))
        stage.model.password = "wrong"
        await stage.model.submitPassword()
        XCTAssertEqual(stage.model.fieldErrors[.password], ["Das stimmt nicht."])
    }

    // MARK: Focus

    func testEveryChangeOfScreenAsksForTheFocusOnTheTitle() async throws {
        let stage = try Stage()
        var asked = stage.model.focusRequests
        await stage.signIn(to: Wire.needsPassword)
        XCTAssertEqual(stage.model.focus, .title)
        XCTAssertEqual(stage.model.focusRequests, asked + 1)

        asked = stage.model.focusRequests
        stage.model.showReset()
        XCTAssertEqual(stage.model.focus, .title)
        XCTAssertEqual(stage.model.focusRequests, asked + 1)

        // The same screen again is no change.
        asked = stage.model.focusRequests
        stage.model.showReset()
        XCTAssertEqual(stage.model.focusRequests, asked)
    }

    // MARK: The environment

    func testTheAppsNameAndAnOptionalPasswordComeFromTheEnvironment() async throws {
        let stage = try Stage(mode: .signUp)
        XCTAssertNil(stage.model.appName)
        stage.api.on(Wire.config, Wire.config(name: "Northline", signUpPassword: "optional"))
        await stage.model.loadConfig()
        XCTAssertEqual(stage.model.appName, "Northline")
        XCTAssertTrue(stage.model.passwordOptional)

        // No password: the account is made without one.
        stage.api.on(Wire.signUps, Wire.flow("sign_up", Wire.verification, start: true))
        stage.model.email = "maya@example.com"
        await stage.model.start()
        XCTAssertEqual(stage.model.screen, .emailVerification(destination: "m***@example.com"))
        XCTAssertNil(stage.api.body(Wire.signUps)["password"])
    }

    func testAnEnvironmentThatCannotBeReadChangesNothing() async throws {
        let stage = try Stage()
        stage.api.on(Wire.config, Reply.error(500, "internal"))
        await stage.model.loadConfig()
        XCTAssertNil(stage.model.appName)
        XCTAssertFalse(stage.model.passwordOptional)
        XCTAssertNil(stage.model.formError)

        let empty = try Stage()
        empty.api.on(Wire.config, Wire.config(name: "", signUpPassword: "required"))
        await empty.model.loadConfig()
        XCTAssertNil(empty.model.appName, "an empty name is no name")
    }

    func testTheFieldsOfEveryScreen() {
        let screens: [(TulaAuthScreen, [TulaAuthField])] = [
            (.signInStart, [.email]), (.signUpStart, [.email, .password]), (.resetStart, [.email]),
            (.password(canEmailCode: true), [.password]), (.emailCodeOffer, []),
            (.emailCode(destination: "d", canUsePassword: false), [.code]), (.emailVerification(destination: "d"), [.code]),
            (.newPassword(destination: "d"), [.code, .newPassword]), (.expiredPassword, [.newPassword]),
            (.signedIn, []), (.notSupported(status: "x"), []),
        ]
        for (screen, fields) in screens {
            XCTAssertEqual(screen.fields, fields, "\(screen)")
        }
    }
}
