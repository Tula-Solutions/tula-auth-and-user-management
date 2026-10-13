import Foundation
import TulaAuth
import XCTest

@testable import TulaAuthUI

// A sign-in with a texted code: which screen a number and an address get from the same
// step, that nothing is texted by arriving, what a refused code is said as, and what
// becomes of the controls when an operator's setting means no message will be sent.
@MainActor
final class TextedCodeScreenTests: XCTestCase {
    /// A sign-in started with a number, in an environment with a password and a texted code.
    private func number(_ step: String = Wire.passwordAndText) async throws -> Stage {
        let stage = try Stage()
        stage.api.on(Wire.signIns, Wire.flow("sign_in", step, start: true))
        stage.model.email = Wire.number
        await stage.model.start()
        return stage
    }

    /// The same, with the code asked for.
    private func texted() async throws -> Stage {
        let stage = try await number()
        stage.api.on(Wire.prepare, Wire.flow("sign_in", Wire.passwordAndTextPrepared))
        await stage.model.sendTextedCode()
        XCTAssertEqual(stage.model.screen, .textedSignIn(destination: Wire.masked))
        return stage
    }

    // MARK: Which screen

    func testANumberIsShownTheTextedCodeAndNothingElseAndAnAddressNeverIs() async throws {
        // The step is the environment's, whatever was typed: the same three ways.
        let byNumber = try await number()
        XCTAssertEqual(byNumber.model.screen, .textedSignInOffer)
        XCTAssertEqual(byNumber.api.body(Wire.signIns)["identifier"] as? String, Wire.number)
        XCTAssertEqual(byNumber.model.content.identity?.lead, "Signing in as +1 415 555 0142")

        let byAddress = try Stage()
        await byAddress.signIn(to: Wire.passwordAndText)
        XCTAssertEqual(byAddress.model.screen, .password(canEmailCode: true))
        XCTAssertFalse(byAddress.model.content.actions.contains(.sendTextedCode))

        // A step that already holds a texted code is the code's screen for the number.
        let prepared = try await number(Wire.passwordAndTextPrepared)
        XCTAssertEqual(prepared.model.screen, .textedSignIn(destination: Wire.masked))
        // And for an address the screen of what an address can do.
        let address = try Stage()
        await address.signIn(to: Wire.passwordAndTextPrepared)
        XCTAssertEqual(address.model.screen, .password(canEmailCode: true))

        // A number in an environment that texts nothing gets what the step offers.
        let untexted = try await number(Wire.both)
        XCTAssertEqual(untexted.model.screen, .password(canEmailCode: true))
    }

    func testWhatIsTakenForAPhoneNumber() {
        let rows: [(String, Bool)] = [
            ("+14155550142", true), (" +1 (415) 555-0142 ", true), ("+4915112345678", true), ("+12345678", true),
            ("+123456789012345", true),
            // Too short, too long, no plus, a leading zero, a letter, digits of another script.
            ("+1234567", false), ("+1234567890123456", false), ("14155550142", false), ("+04155550142", false),
            ("+1415555014a", false), ("+١٤١٥٥٥٥٠١٤٢", false), ("maya@example.com", false), ("", false), ("+", false),
            ("++14155550142", false),
        ]
        for (typed, expected) in rows {
            XCTAssertEqual(TulaAuthModel.isPhoneNumber(typed), expected, typed)
        }
    }

    // MARK: Nothing is texted by arriving

    func testNothingIsTextedByArrivingAndTheCodeIsAskedForByAPerson() async throws {
        let stage = try await number()
        XCTAssertEqual(stage.api.routes, [Wire.signIns], "a message costs money: a person asks")
        XCTAssertEqual(stage.model.screen.fields, [], "no field for a code nobody was sent")
        XCTAssertEqual(stage.model.content.actions, [.sendTextedCode, .showSignIn])

        stage.api.on(Wire.prepare, Wire.flow("sign_in", Wire.passwordAndTextPrepared))
        await stage.model.perform(.sendTextedCode)
        XCTAssertEqual(stage.api.count(Wire.prepare), 1)
        XCTAssertEqual(stage.api.body(Wire.prepare)["strategy"] as? String, "sms_code")
        XCTAssertEqual(stage.model.screen, .textedSignIn(destination: Wire.masked))
        XCTAssertEqual(stage.model.focus, .title)

        // The offer's button is not a button of the code's screen.
        await stage.model.sendTextedCode()
        XCTAssertEqual(stage.api.count(Wire.prepare), 1)
    }

    func testATextedCodeSignsIn() async throws {
        let stage = try await texted()
        stage.api.on(Wire.attempt, Wire.flow("sign_in", Wire.complete))
        stage.model.setText("123 456", of: .code)
        await stage.model.perform(.submitCode)
        XCTAssertEqual(stage.api.body(Wire.attempt)["strategy"] as? String, "sms_code")
        XCTAssertEqual(stage.api.body(Wire.attempt)["code"] as? String, "123456")
        XCTAssertEqual(stage.model.screen, .signedIn)
        XCTAssertEqual(stage.heard.signedIn, 1)
        let signedIn = await stage.isSignedIn
        XCTAssertTrue(signedIn)
        XCTAssertEqual(stage.model.code, "")
    }

    func testACodeThatIsNotSixDigitsIsSaidAtTheFieldWithoutARequest() async throws {
        let stage = try await texted()
        stage.model.code = "123"
        await stage.model.submitCode()
        XCTAssertEqual(stage.model.fieldErrors[.code], ["Enter the 6-digit code."])
        XCTAssertEqual(stage.model.focus, .field(.code))
        XCTAssertEqual(stage.api.count(Wire.attempt), 0)
    }

    func testAnotherMessageIsAskedForAndSaidWithoutAClaimThatItWillArrive() async throws {
        let stage = try await texted()
        await stage.model.perform(.resendCode)
        XCTAssertEqual(stage.api.count(Wire.prepare), 2)
        XCTAssertEqual(stage.model.status, "If you can sign in with this number, a new code is on its way.")
        XCTAssertEqual(stage.heard.said.last, "If you can sign in with this number, a new code is on its way.")
        XCTAssertEqual(stage.model.screen, .textedSignIn(destination: Wire.masked))
    }

    func testNoScreenOfATextedSignInSaysThatAMessageWasSent() async throws {
        // A number that signs nobody in is answered like one that does and is texted
        // nothing: a sentence that says a code was texted would be false for it.
        func words(_ stage: Stage) -> String {
            (String(describing: stage.model.content) + "\n" + stage.shown).lowercased()
        }
        let offered = try await number()
        let stage = try await texted()
        var drawn = [words(offered), words(stage)]
        await stage.model.perform(.resendCode)
        drawn.append(words(stage))
        for text in drawn {
            for claim in ["we texted", "we sent", "was sent", "has been sent"] {
                XCTAssertFalse(text.contains(claim), "\(claim): \(text)")
            }
        }
        XCTAssertEqual(
            stage.model.content.subtitle,
            "If this number can sign in, a 6-digit code is on its way to +1 *** *** **42. Enter it below.")
    }

    // MARK: A number that is not in the international form

    func testWhereOnlyANumberIdentifiesWhatIsNotOneIsSaidAtTheFieldAndNotAsAnAppToUpdate() async throws {
        // A texted code beside ways that take no identifier: the step offers an address
        // nothing, and a number typed without its plus sign is not a version problem.
        let only = #"{"status":"needs_first_factor","strategies":["sms_code","passkey"]}"#
        let words = "Enter a phone number with its country code, starting with +."
        for typed in ["4155550142", "0415 555 0142", "maya@example.com"] {
            let stage = try Stage()
            stage.api.on(Wire.signIns, Wire.flow("sign_in", only, start: true))
            stage.model.email = typed
            await stage.model.start()
            XCTAssertEqual(stage.model.screen, .signInStart, typed)
            XCTAssertEqual(stage.model.fieldErrors, [.email: [words]], typed)
            XCTAssertNil(stage.model.formError)
            XCTAssertEqual(stage.model.focus, .field(.email))
            XCTAssertEqual(stage.heard.said.last, words)
            XCTAssertFalse(stage.model.isPending)
            XCTAssertEqual(stage.model.email, typed, "what was typed is kept, to be put right")

            // The attempt is nobody's: no action of it is sent, and a number starts anew.
            await stage.model.sendTextedCode()
            await stage.model.submitCode()
            XCTAssertEqual(stage.api.routes, [Wire.signIns], typed)
            stage.model.email = Wire.number
            await stage.model.start()
            XCTAssertEqual(stage.model.screen, .textedSignInOffer)
            XCTAssertEqual(stage.model.fieldErrors, [:])
        }

        // Where an address has a way, a number without its plus sign is taken for one.
        let both = try Stage()
        both.api.on(Wire.signIns, Wire.flow("sign_in", Wire.passwordAndText, start: true))
        both.model.email = "4155550142"
        await both.model.start()
        XCTAssertEqual(both.model.screen, .password(canEmailCode: true))
    }

    // MARK: A code the server refused

    func testARefusedCodeIsSaidAboutTheCodeAndTheFieldIsEmptied() async throws {
        // Wrong, expired, a decoy's, used before: the server answers every one alike, with
        // the code whose own sentence is about an address and a password.
        let stage = try await texted()
        stage.api.on(Wire.attempt, Reply.error(401, "auth.invalid_credentials"))
        stage.model.code = "000000"
        await stage.model.submitCode()
        XCTAssertEqual(
            stage.model.fieldErrors,
            [.code: ["That code did not sign you in. Check it, ask for a new one, or sign in another way."]])
        XCTAssertNil(stage.model.formError)
        XCTAssertEqual(stage.model.code, "", "a refused code is read from the message again")
        XCTAssertEqual(stage.model.focus, .field(.code))
        XCTAssertEqual(stage.model.screen, .textedSignIn(destination: Wire.masked))
        XCTAssertFalse(stage.shown.contains("password"), "nothing here was a password")
        XCTAssertFalse(stage.shown.contains(Canary.serverText))
        let signedIn = await stage.isSignedIn
        XCTAssertFalse(signedIn)

        // The same code again is one more refused try, said the same way.
        stage.model.code = "000000"
        await stage.model.submitCode()
        XCTAssertEqual(stage.api.count(Wire.attempt), 2)
        XCTAssertEqual(stage.model.fieldErrors[.code]?.count, 1)
        XCTAssertEqual(stage.model.code, "")
    }

    func testAnExpiredCodeIsSaidAtTheCodeInTheContractsWords() async throws {
        let stage = try await texted()
        stage.api.on(Wire.attempt, Reply.error(410, "verification.expired"))
        stage.model.code = "123456"
        await stage.model.submitCode()
        XCTAssertEqual(stage.model.fieldErrors, [.code: ["That code has expired. Request a new one."]])
        XCTAssertEqual(stage.model.code, "")
        XCTAssertFalse(stage.shown.contains(Canary.serverText))
    }

    func testTheWaitOfALimitIsSaidInWordsAboveTheForm() async throws {
        // Asking too often, and guessing too often where the server says so.
        let asking = try await number()
        asking.api.on(Wire.prepare, Reply.error(429, "rate_limited", headers: ["retry-after": "90"]))
        await asking.model.sendTextedCode()
        let said = try XCTUnwrap(asking.model.formError)
        XCTAssertTrue(said.hasSuffix("Try again in 1m 30s."), said)
        XCTAssertEqual(asking.model.screen, .textedSignInOffer)
        XCTAssertFalse(asking.model.textedOff, "a limit passes: the button stays")
        XCTAssertNotNil(asking.model.content.primary)

        let guessing = try await texted()
        guessing.api.on(Wire.attempt, Reply.error(429, "rate_limited", headers: ["retry-after": "30"]))
        guessing.model.code = "123456"
        await guessing.model.submitCode()
        let wait = try XCTUnwrap(guessing.model.formError)
        XCTAssertTrue(wait.hasSuffix("Try again in 30s."), wait)
        XCTAssertEqual(guessing.model.fieldErrors, [:])
        XCTAssertFalse(guessing.shown.contains(Canary.serverText))
    }

    // MARK: Switched off

    func testARefusalAnOperatorsSettingCausesTakesTheControlsAway() async throws {
        for code in ["auth.method_disabled", "sms.disabled", "sms.country_not_allowed"] {
            // Asking for the code.
            let offer = try await number()
            offer.api.on(Wire.prepare, Reply.error(403, code))
            await offer.model.sendTextedCode()
            XCTAssertEqual(offer.model.screen, .textedSignInOffer, code)
            XCTAssertTrue(offer.model.textedOff, code)
            XCTAssertNil(offer.model.content.primary, "\(code): a button that can only be refused again is gone")
            XCTAssertFalse(offer.model.content.actions.contains(.sendTextedCode), code)
            XCTAssertNotNil(offer.model.formError, "\(code): the words stay")
            XCTAssertEqual(offer.model.fieldErrors, [:], code)
            XCTAssertFalse(offer.shown.contains(Canary.serverText), code)
            // Neither the door nor the action itself sends another.
            await offer.model.perform(.sendTextedCode)
            await offer.model.sendTextedCode()
            XCTAssertEqual(offer.api.count(Wire.prepare), 1, code)
            // The way out is still there.
            XCTAssertTrue(offer.model.content.actions.contains(.showSignIn), code)

            // Asking again, and sending a code, from the code's screen: back on the offer.
            for action in [TulaAuthAction.resendCode, .submitCode] {
                let sent = try await texted()
                sent.api.on(action == .resendCode ? Wire.prepare : Wire.attempt, Reply.error(403, code))
                sent.model.code = "123456"
                await sent.model.perform(action)
                XCTAssertEqual(sent.model.screen, .textedSignInOffer, "\(code) \(action)")
                XCTAssertTrue(sent.model.textedOff, "\(code) \(action)")
                XCTAssertNil(sent.model.content.primary, "\(code) \(action)")
                XCTAssertEqual(sent.model.content.fields, [], "\(code) \(action)")
                XCTAssertEqual(sent.model.code, "", "\(code) \(action)")
                XCTAssertNotNil(sent.model.formError, "\(code) \(action)")
            }
        }
    }

    func testASwitchedOffScreenIsWholeAgainAfterItWasLeft() async throws {
        let stage = try await number()
        stage.api.on(Wire.prepare, Reply.error(403, "sms.disabled"))
        await stage.model.sendTextedCode()
        XCTAssertTrue(stage.model.textedOff)
        stage.model.showSignIn()
        XCTAssertFalse(stage.model.textedOff)
        XCTAssertFalse(stage.model.situation.textedOff)
    }

    func testAMessageThatCouldNotBeSentKeepsTheButton() async throws {
        // The provider failed: it may pass, so asking again is not pointless.
        let stage = try await number()
        stage.api.on(Wire.prepare, Reply.error(503, "sms.unavailable"))
        await stage.model.sendTextedCode()
        XCTAssertFalse(stage.model.textedOff)
        XCTAssertEqual(stage.model.content.primary?.action, .sendTextedCode)
        XCTAssertNotNil(stage.model.formError)
        stage.api.on(Wire.prepare, Wire.flow("sign_in", Wire.passwordAndTextPrepared))
        await stage.model.sendTextedCode()
        XCTAssertEqual(stage.model.screen, .textedSignIn(destination: Wire.masked))
    }

    // MARK: Left

    func testTheCodeIsEmptiedWhenItsScreenIsLeftAndAnActionWithoutItsFlowSaysSo() async throws {
        let left = try await texted()
        left.model.code = "123456"
        left.model.showSignIn()
        XCTAssertEqual(left.model.code, "")
        XCTAssertEqual(left.model.screen, .signInStart)

        let rows: [(String, () async throws -> Stage, TulaAuthAction)] = [
            ("asking for a texted code", { try await self.number() }, .sendTextedCode),
            ("a texted code", texted, .submitCode), ("another texted code", texted, .resendCode),
        ]
        for (name, make, action) in rows {
            let stage = try await make()
            XCTAssertTrue(stage.model.content.actions.contains(action), name)
            stage.model.leave()
            let sent = stage.api.routes
            stage.model.code = "123456"
            await stage.model.perform(action)
            XCTAssertEqual(stage.model.screen, .signInStart, name)
            XCTAssertEqual(stage.model.formError, "That attempt is no longer open. Start again.", name)
            XCTAssertEqual(stage.api.routes, sent, "\(name): nothing is sent on a guess")
            XCTAssertEqual(stage.model.code, "", name)
        }
    }

    func testAnAnswerOfATextedCodeThatArrivesAfterItsScreenWasLeftSignsNobodyIn() async throws {
        let stage = try await texted()
        let gate = Gate()
        stage.api.on(Wire.attempt) { _ in
            await gate.wait()
            return Wire.flow("sign_in", Wire.complete)
        }
        stage.model.code = "123456"
        let sending = Task { await stage.model.submitCode() }
        await eventually("the code is on its way") { stage.api.count(Wire.attempt) == 1 }
        stage.model.close()
        gate.open()
        await sending.value
        let signedIn = await stage.isSignedIn
        XCTAssertFalse(signedIn, "a discarded attempt takes nothing from an answer")
        XCTAssertEqual(stage.model.screen, .signInStart)
        XCTAssertEqual(stage.heard.signedIn, 0)
    }
}
