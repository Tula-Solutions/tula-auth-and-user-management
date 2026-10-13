import Foundation
import TulaAuth
import XCTest

@testable import TulaAuthUI

// What a screen is when it comes back after it went away, what each secret field holds after
// the server refused it, and what becomes of a sign-in that completed while its screen was
// being left.
@MainActor
final class LeftAndRefusedTests: XCTestCase {
    // MARK: A closed screen

    /// A sign-up that waits for its emailed code.
    private func signUpWaiting() async throws -> Stage {
        let stage = try Stage(mode: .signUp)
        stage.api.on(Wire.signUps, Wire.flow("sign_up", Wire.verification, start: true))
        stage.model.email = "maya@example.com"
        stage.model.password = Canary.password
        await stage.model.start()
        XCTAssertEqual(stage.model.screen, .emailVerification(destination: "m***@example.com"))
        return stage
    }

    /// A reset that waits for its code and the new password.
    private func resetWaiting() async throws -> Stage {
        let stage = try Stage()
        stage.model.showReset()
        stage.api.on(Wire.resets, Wire.flow("password_reset", Wire.reset, start: true))
        stage.model.email = "maya@example.com"
        await stage.model.start()
        XCTAssertEqual(stage.model.screen, .newPassword(destination: "m***@example.com"))
        return stage
    }

    func testAClosedScreenIsBackOnTheStartItOpenedOn() async throws {
        // A view that disappears and comes back (a push and a pop, another tab) keeps its
        // model: a closed model must not be left on a step whose flow it discarded.
        let password = try Stage()
        await password.signIn(to: Wire.needsPassword)
        XCTAssertEqual(password.model.screen, .password(canEmailCode: false))
        password.model.close()
        XCTAssertEqual(password.model.screen, .signInStart, "from the password")
        XCTAssertEqual(password.model.email, "")

        let code = try Stage()
        await code.signIn(to: Wire.codeOnlyPrepared)
        XCTAssertEqual(code.model.screen, .emailCode(destination: "m***@example.com", canUsePassword: false))
        code.model.close()
        XCTAssertEqual(code.model.screen, .signInStart, "from the emailed code")

        // A reset was opened from a sign-in: closed, the view is a sign-in again.
        let reset = try await resetWaiting()
        reset.model.close()
        XCTAssertEqual(reset.model.screen, .signInStart, "from the new password")

        let signUp = try await signUpWaiting()
        signUp.model.close()
        XCTAssertEqual(signUp.model.screen, .signUpStart, "a sign-up closes onto a sign-up")
        XCTAssertNil(signUp.model.formError)
        XCTAssertEqual(signUp.model.fieldErrors, [:])
    }

    func testAScreenThatSignedSomebodyInClosesOntoItsStart() async throws {
        let stage = try Stage()
        await stage.signIn(to: Wire.needsPassword)
        stage.api.on(Wire.password, Wire.flow("sign_in", Wire.complete))
        stage.model.password = Canary.password
        await stage.model.submitPassword()
        XCTAssertEqual(stage.model.screen, .signedIn)
        stage.model.close()
        XCTAssertEqual(stage.model.screen, .signInStart, "after a sign-out the view asks for an address again")
        let signedIn = await stage.isSignedIn
        XCTAssertTrue(signedIn, "closing a screen signs nobody out")
    }

    // MARK: What a refused secret leaves in its field

    func testASignUpPasswordTheServerRefusedIsKeptToBePutRight() async throws {
        let stage = try Stage(mode: .signUp)
        stage.api.on(Wire.signUps, Reply.error(422, "password.too_short"))
        stage.model.email = "maya@example.com"
        stage.model.password = "short"
        await stage.model.start()
        XCTAssertEqual(stage.model.screen, .signUpStart)
        XCTAssertEqual(stage.model.fieldErrors[.password]?.count, 1)
        XCTAssertEqual(stage.model.password, "short", "a password being chosen is put right, not typed again")
    }

    func testANewPasswordTheServerRefusedIsKeptWithItsCode() async throws {
        let stage = try await resetWaiting()
        stage.api.on(Wire.resetSubmit, Reply.error(422, "password.too_short"))
        stage.model.code = "123456"
        stage.model.newPassword = "short"
        await stage.model.submitNewPassword()
        XCTAssertEqual(stage.model.fieldErrors[.newPassword]?.count, 1)
        XCTAssertEqual(stage.model.newPassword, "short")
        XCTAssertEqual(stage.model.code, "123456", "the code was not what was refused, and is still the one to send")
    }

    func testAnExpiredPasswordsReplacementTheServerRefusedIsKept() async throws {
        let stage = try Stage()
        await stage.signIn(to: Wire.needsPassword)
        stage.api.on(Wire.password, Wire.flow("sign_in", Wire.expired))
        stage.model.password = "the old one"
        await stage.model.submitPassword()
        stage.api.on(Wire.newPassword, Reply.error(422, "password.reused"))
        stage.model.newPassword = "the old one"
        await stage.model.submitNewPassword()
        XCTAssertEqual(stage.model.screen, .expiredPassword)
        XCTAssertEqual(stage.model.newPassword, "the old one")
    }

    func testACodeThatProvesAnAddressIsEmptiedAsItIsSentRightOrWrong() async throws {
        let stage = try await signUpWaiting()
        let gate = Gate()
        stage.api.on(Wire.signUpVerify) { _ in
            await gate.wait()
            return Reply.error(400, "verification.invalid_code")
        }
        stage.model.code = "000000"
        let sending = Task { await stage.model.submitCode() }
        await eventually("the code is sent") { stage.api.count(Wire.signUpVerify) == 1 }
        XCTAssertEqual(stage.model.code, "", "not kept while the answer is on its way")
        gate.open()
        await sending.value
        XCTAssertEqual(stage.api.body(Wire.signUpVerify)["code"] as? String, "000000")
        XCTAssertEqual(stage.model.code, "", "a refused code is typed again from the email")
        XCTAssertEqual(stage.model.fieldErrors[.code]?.count, 1)
        XCTAssertEqual(stage.model.focus, .field(.code))
    }

    func testACodeThatSignsInIsEmptiedAsItIsSent() async throws {
        let stage = try Stage()
        await stage.signIn(to: Wire.codeOnlyPrepared)
        stage.api.on(Wire.attempt, Reply.error(401, "auth.invalid_credentials"))
        stage.model.code = "000000"
        await stage.model.submitCode()
        XCTAssertEqual(stage.model.screen, .emailCode(destination: "m***@example.com", canUsePassword: false))
        XCTAssertEqual(stage.model.code, "")
        XCTAssertEqual(stage.model.fieldErrors[.code], ["The email or password is incorrect."])
    }

    func testAResetsCodeTheServerRefusedIsEmptiedAndTheNewPasswordKept() async throws {
        let stage = try await resetWaiting()
        stage.api.on(Wire.resetSubmit, Reply.error(400, "verification.invalid_code"))
        stage.model.code = "000000"
        stage.model.newPassword = Canary.password
        await stage.model.submitNewPassword()
        XCTAssertEqual(stage.model.fieldErrors[.code]?.count, 1)
        XCTAssertEqual(stage.model.code, "", "the code was refused: it is typed again")
        XCTAssertEqual(stage.model.newPassword, Canary.password, "the password was not what was refused")
    }

    // MARK: A sign-in that completed while its screen was being left

    func testASignInThatCompletedWhileItsScreenWasLeftIsSaidNotDropped() async throws {
        // The answer said `complete` and the client was storing the session when the user
        // went to another screen. The flow is over and somebody is signed in: a model that
        // dropped that answer would show a form to a signed-in user and tell the app nothing.
        let gate = Gate()
        let storage = HeldStorage(gate)
        let stage = try Stage(storage: storage)
        await stage.signIn(to: Wire.needsPassword)
        stage.api.on(Wire.password, Wire.flow("sign_in", Wire.complete))
        stage.model.password = Canary.password
        let sending = Task { await stage.model.submitPassword() }
        await eventually("the session is being stored") { await storage.writes == 1 }

        stage.model.showSignUp()
        XCTAssertEqual(stage.model.screen, .signUpStart)
        gate.open()
        await sending.value

        let signedIn = await stage.isSignedIn
        XCTAssertTrue(signedIn, "the flow had completed: leaving its screen does not undo it")
        XCTAssertEqual(stage.model.screen, .signedIn)
        XCTAssertEqual(stage.heard.signedIn, 1, "the app is told, once")
        XCTAssertEqual([stage.model.password, stage.model.code, stage.model.newPassword], ["", "", ""])
    }

    func testASignInThatCompletedWhileItsScreenWasClosingIsToldToTheApp() async throws {
        let gate = Gate()
        let storage = HeldStorage(gate)
        let stage = try Stage(storage: storage)
        await stage.signIn(to: Wire.needsPassword)
        stage.api.on(Wire.password, Wire.flow("sign_in", Wire.complete))
        stage.model.password = Canary.password
        let sending = Task { await stage.model.submitPassword() }
        await eventually("the session is being stored") { await storage.writes == 1 }
        stage.model.close()
        gate.open()
        await sending.value
        XCTAssertEqual(stage.heard.signedIn, 1)
        XCTAssertEqual(stage.model.screen, .signedIn)
    }
}
