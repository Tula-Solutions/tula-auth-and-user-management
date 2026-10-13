import Foundation
import TulaAuth
import XCTest

@testable import TulaAuthUI

// Proving again that it is the user, on the account screen: which ways are offered, that a
// code is sent only when asked for, where a wrong proof is said, and what happens to what
// was asked for once the proof is accepted or the step-up is cancelled.
@MainActor
final class AccountStepUpTests: XCTestCase {
    private static let every = "password,totp,backup_code,email_code,sms_code,passkey"

    /// An account whose "Turn on" was answered with a demand for proof. The same call is
    /// answered with the setup key the next time it is made.
    private func asked(
        _ methods: String, sheet: ScriptedPasskeySheet? = nil, strings: TulaStrings = .english
    ) async throws -> AccountStage {
        let stage = try await AccountStage.loaded(strings: strings, sheet: sheet)
        stage.api.on(Account.totpStart, Account.stepUpRequired(methods))
        stage.api.on(Account.totpStart, Wire.totpEnrolment)
        await stage.model.perform(.setUpAuthenticator)
        XCTAssertEqual(stage.api.count(Account.totpStart), 1)
        XCTAssertTrue(stage.model.panel.isStepUp)
        XCTAssertFalse(stage.model.isPending)
        return stage
    }

    /// The step-up was accepted and what was owed was done: the setup form is open.
    private func assertOwedWasDone(_ stage: AccountStage, _ what: String, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertEqual(stage.model.panel, .totpSetup, what, file: file, line: line)
        XCTAssertEqual(stage.model.setup?.key, Wire.setupKey, what, file: file, line: line)
        XCTAssertEqual(stage.api.count(Account.totpStart), 2, "\(what): run again exactly once", file: file, line: line)
        XCTAssertNil(stage.model.formError, what, file: file, line: line)
    }

    // MARK: Which ways are offered

    func testTheWaysAreTheServersInItsOrderLessTheOnesThisAppCannotTake() async throws {
        var stage = try await asked(
            "password, totp,backup_code,email_code,sms_code,passkey,face_of_tomorrow,totp,", sheet: ScriptedPasskeySheet())
        XCTAssertEqual(
            stage.model.panel,
            .stepUp(.password, others: [.totp, .backupCode, .emailCode, .textedCode, .passkey], sent: nil))
        XCTAssertEqual(stage.model.focus, .title)
        XCTAssertFalse(stage.everything.contains(Canary.serverText))
        XCTAssertNil(stage.model.formError, "being asked for proof is not an error")

        // Without a passkey sheet a passkey is not a way.
        stage = try await asked("passkey,totp,backup_code")
        XCTAssertEqual(stage.model.panel, .stepUp(.totp, others: [.backupCode], sent: nil))
        stage = try await asked("passkey", sheet: ScriptedPasskeySheet())
        XCTAssertEqual(stage.model.panel, .stepUp(.passkey, others: [], sent: nil))
    }

    func testNoWayThisAppCanTakeSaysToSignOutAndInAgain() async throws {
        for methods in ["face_of_tomorrow", "passkey", ""] {
            let stage = try await asked(methods)
            XCTAssertEqual(stage.model.panel, .stepUpUnavailable, methods)
            XCTAssertEqual(stage.model.content.actions, [.signOut, .cancel], methods)
            await stage.model.submitStepUp()
            await stage.model.sendStepUpCode()
            await stage.model.stepUpWithPasskey()
            stage.model.useStepUpWay(.password)
            XCTAssertEqual(stage.model.panel, .stepUpUnavailable, methods)
            XCTAssertEqual(stage.api.count(Account.stepUp), 0, methods)

            await stage.model.perform(.cancel)
            XCTAssertEqual(stage.model.panel, .overview, methods)
            XCTAssertEqual(stage.model.notice, "Nothing was changed.", methods)
            XCTAssertEqual(stage.api.count(Account.totpStart), 1, methods)
        }
        // Its main button signs out, as any sign-out of the screen does.
        let stage = try await asked("face_of_tomorrow")
        stage.api.on(Account.signOut, Account.none)
        await stage.model.perform(.signOut)
        XCTAssertEqual(stage.heard.signedOut, 1)
    }

    func testAnotherWayIsOpenedOnlyAmongTheOnesOffered() async throws {
        let stage = try await asked("password,totp,backup_code")
        let model = stage.model
        model.setText(Canary.password, of: .password)
        model.toggleReveal(.password)
        await model.perform(.useStepUpWay(.backupCode))
        XCTAssertEqual(model.panel, .stepUp(.backupCode, others: [.password, .totp], sent: nil))
        stage.assertNothingSecretIsHeld("after the way was changed")
        await model.perform(.useStepUpWay(.totp))
        XCTAssertEqual(model.panel, .stepUp(.totp, others: [.backupCode, .password], sent: nil))

        model.useStepUpWay(.passkey)
        model.useStepUpWay(.emailCode)
        model.useStepUpWay(.totp)
        XCTAssertEqual(model.panel, .stepUp(.totp, others: [.backupCode, .password], sent: nil))
        XCTAssertEqual(stage.api.count(Account.stepUp), 0, "changing the way sends nothing")

        // What is owed is still owed after any number of changes.
        stage.acceptProof()
        model.setText("123456", of: .code)
        await model.perform(.submitStepUp)
        assertOwedWasDone(stage, "after changing the way")
    }

    // MARK: Each way

    func testThePasswordProvesItAndWhatWasAskedForIsDoneOnce() async throws {
        let stage = try await asked("password")
        let model = stage.model
        await model.perform(.submitStepUp)
        XCTAssertEqual(model.fieldErrors, [.password: ["This field is required."]])
        XCTAssertEqual(stage.api.count(Account.stepUp), 0)

        model.setText(Canary.password, of: .password)
        model.toggleReveal(.password)
        stage.acceptProof()
        await model.perform(.submitStepUp)
        XCTAssertEqual(stage.api.count(Account.stepUp), 1)
        XCTAssertEqual(stage.api.body(Account.stepUp)["password"] as? String, Canary.password)
        assertOwedWasDone(stage, "the password")
        XCTAssertEqual(model.password, "")
        XCTAssertEqual(model.revealed, [])
        XCTAssertFalse(stage.everything.contains(Canary.password))
    }

    func testAWrongPasswordIsSaidAtItsFieldInTheStepUpsWords() async throws {
        let stage = try await asked("password,totp")
        let model = stage.model
        model.setText(Canary.password, of: .password)
        model.toggleReveal(.password)
        stage.api.on(Account.stepUp, Reply.error(401, "auth.invalid_credentials"))
        await model.perform(.submitStepUp)

        XCTAssertEqual(model.panel, .stepUp(.password, others: [.totp], sent: nil))
        XCTAssertEqual(model.fieldErrors, [.password: ["That password is incorrect."]])
        XCTAssertNil(model.formError)
        XCTAssertEqual(model.password, "")
        XCTAssertFalse(model.isRevealed(.password))
        XCTAssertEqual(model.focus, .field(.password))
        XCTAssertEqual(stage.heard.said.last, "That password is incorrect.")
        XCTAssertFalse(stage.everything.contains("email or password"))
        XCTAssertEqual(stage.api.count(Account.totpStart), 1, "nothing is done on a wrong proof")
        XCTAssertEqual(stage.heard.signedOut, 0)

        // The right one afterwards still does what was asked for.
        stage.acceptProof()
        model.setText(Canary.password, of: .password)
        await model.perform(.submitStepUp)
        assertOwedWasDone(stage, "after a wrong password")
    }

    func testAWrongCodeIsSaidInThePanelsOwnWordsAtItsField() async throws {
        // The words are the table's for this panel, whatever the code's own sentence is.
        var strings = TulaStrings.english
        strings.secondStep.codeWrong = "PANEL: wrong code"
        strings.errors["mfa.invalid_code"] = "TABLE: mfa"
        strings.errors["verification.invalid_code"] = "TABLE: verification"

        // An authenticator's code and a backup code: `mfa.invalid_code`, as the API answers.
        var stage = try await asked("totp,backup_code", strings: strings)
        var model = stage.model
        stage.api.on(Account.stepUp, Reply.error(422, "mfa.invalid_code"))
        model.setText("111111", of: .code)
        await model.perform(.submitStepUp)
        XCTAssertEqual(model.fieldErrors, [.code: ["PANEL: wrong code"]])
        XCTAssertNil(model.formError)
        XCTAssertEqual(model.code, "")
        XCTAssertEqual(model.focus, .field(.code))
        XCTAssertEqual(stage.api.body(Account.stepUp)["code"] as? String, "111111")

        await model.perform(.useStepUpWay(.backupCode))
        await model.perform(.submitStepUp)
        XCTAssertEqual(model.fieldErrors, [.backupCode: ["Enter a backup code."]])
        XCTAssertEqual(stage.api.count(Account.stepUp), 1)
        model.setText(" abcde-fghjk ", of: .backupCode)
        await model.perform(.submitStepUp)
        XCTAssertEqual(stage.api.body(Account.stepUp, 1)["code"] as? String, "abcde-fghjk")
        XCTAssertEqual(model.fieldErrors, [.backupCode: ["PANEL: wrong code"]])
        XCTAssertEqual(model.backupCode, "")
        XCTAssertEqual(model.focus, .field(.backupCode))
        // A used code is answered the same way, and said the same way.
        XCTAssertEqual(stage.api.count(Account.totpStart), 1)

        stage.acceptProof()
        model.setText("abcde-fghjk", of: .backupCode)
        await model.perform(.submitStepUp)
        assertOwedWasDone(stage, "a backup code")

        // An emailed code: `verification.invalid_code`; one that expired has its own sentence.
        stage = try await asked("email_code", strings: strings)
        model = stage.model
        stage.api.on(Account.stepUpEmail, Account.sent("email_code", to: Account.maskedEmail))
        await model.perform(.sendStepUpCode)
        stage.api.on(Account.stepUp, Reply.error(422, "verification.invalid_code"))
        model.setText("111111", of: .code)
        await model.perform(.submitStepUp)
        XCTAssertEqual(model.fieldErrors, [.code: ["PANEL: wrong code"]])
        XCTAssertEqual(model.code, "")
        stage.api.on(Account.stepUp, Reply.error(410, "verification.expired"))
        model.setText("111111", of: .code)
        await model.perform(.submitStepUp)
        XCTAssertEqual(model.fieldErrors, [.code: ["That code has expired. Request a new one."]])
        XCTAssertEqual(model.code, "")
        XCTAssertEqual(model.panel, .stepUp(.emailCode, others: [], sent: Account.maskedEmail))

        // Too many wrong ones: above the form, with the wait.
        stage.api.on(Account.stepUp, Reply.error(429, "rate_limited", headers: ["Retry-After": "30"]))
        model.setText("111111", of: .code)
        await model.perform(.submitStepUp)
        XCTAssertEqual(model.formError, "Too many requests. Try again shortly. Try again in 30s.")
        XCTAssertEqual(model.fieldErrors, [:])
    }

    func testAnAuthenticatorsCodeProvesIt() async throws {
        let stage = try await asked("totp")
        let model = stage.model
        model.setText("123", of: .code)
        await model.perform(.submitStepUp)
        XCTAssertEqual(model.fieldErrors, [.code: ["Enter the 6-digit code."]])
        XCTAssertEqual(stage.api.count(Account.stepUp), 0)
        stage.acceptProof()
        model.setText("123456", of: .code)
        await model.perform(.submitStepUp)
        XCTAssertEqual(stage.api.body(Account.stepUp)["method"] as? String, "totp")
        assertOwedWasDone(stage, "an authenticator's code")
    }

    func testAnEmailedCodeIsSentOnlyWhenAskedFor() async throws {
        let stage = try await asked("email_code,password")
        let model = stage.model
        XCTAssertEqual(model.panel, .stepUp(.emailCode, others: [.password], sent: nil))
        XCTAssertEqual(stage.api.count(Account.stepUpEmail), 0, "nothing is sent by arriving")
        model.setText("123456", of: .code)
        await model.submitStepUp()
        XCTAssertEqual(stage.api.count(Account.stepUp), 0, "there is no code to prove yet")

        stage.api.on(Account.stepUpEmail, Account.sent("email_code", to: Account.maskedEmail))
        await model.perform(.sendStepUpCode)
        XCTAssertEqual(model.panel, .stepUp(.emailCode, others: [.password], sent: Account.maskedEmail))
        XCTAssertEqual(stage.api.count(Account.stepUpEmail), 1)
        XCTAssertNil(model.status)

        await model.perform(.sendStepUpCode)
        XCTAssertEqual(model.status, "A new code is on its way.")
        XCTAssertEqual(stage.api.count(Account.stepUpEmail), 2)
        XCTAssertEqual(model.panel, .stepUp(.emailCode, others: [.password], sent: Account.maskedEmail))

        stage.acceptProof()
        model.setText("123456", of: .code)
        await model.perform(.submitStepUp)
        XCTAssertEqual(stage.api.body(Account.stepUp)["method"] as? String, "email_code")
        assertOwedWasDone(stage, "an emailed code")
    }

    func testATextedCodeIsSentOnlyWhenAskedFor() async throws {
        let stage = try await asked("sms_code")
        let model = stage.model
        XCTAssertEqual(model.panel, .stepUp(.textedCode, others: [], sent: nil))
        XCTAssertEqual(stage.api.count(Account.stepUpSms), 0, "a message costs money: asked for with a button")

        stage.api.on(Account.stepUpSms, Reply.error(429, "rate_limited", headers: ["Retry-After": "12"]))
        await model.perform(.sendStepUpCode)
        XCTAssertEqual(model.formError, "Too many requests. Try again shortly. Try again in 12s.")
        XCTAssertEqual(model.panel, .stepUp(.textedCode, others: [], sent: nil))
        XCTAssertFalse(model.textedOff, "asked too soon is not switched off")

        stage.api.on(Account.stepUpSms, Account.sent("sms_code", to: Wire.masked))
        await model.perform(.sendStepUpCode)
        XCTAssertEqual(model.panel, .stepUp(.textedCode, others: [], sent: Wire.masked))
        await model.perform(.sendStepUpCode)
        XCTAssertEqual(model.status, "A new code is on its way.")

        stage.api.on(Account.stepUp, Reply.error(422, "mfa.invalid_code"))
        model.setText("111111", of: .code)
        await model.perform(.submitStepUp)
        XCTAssertEqual(model.fieldErrors, [.code: ["That code is incorrect."]])
        XCTAssertEqual(model.code, "")

        stage.acceptProof()
        model.setText("123456", of: .code)
        await model.perform(.submitStepUp)
        XCTAssertEqual(stage.api.body(Account.stepUp, 1)["method"] as? String, "sms_code")
        assertOwedWasDone(stage, "a texted code")
    }

    func testTextMessagesSwitchedOffTakeTheSendButtonAway() async throws {
        for code in ["auth.method_disabled", "sms.disabled", "sms.country_not_allowed"] {
            // Refused when first asked for.
            var stage = try await asked("sms_code,password")
            var model = stage.model
            stage.api.on(Account.stepUpSms, Reply.error(403, code))
            await model.perform(.sendStepUpCode)
            XCTAssertTrue(model.textedOff, code)
            XCTAssertEqual(model.panel, .stepUp(.textedCode, others: [.password], sent: nil), code)
            XCTAssertNil(model.content.primary, code)
            XCTAssertFalse(model.content.actions.contains(.sendStepUpCode), code)
            XCTAssertNotNil(model.formError, "\(code): and the screen says why")
            XCTAssertFalse(stage.everything.contains(Canary.serverText), code)
            await model.sendStepUpCode()
            XCTAssertEqual(stage.api.count(Account.stepUpSms), 1, "\(code): asking again could only be refused again")
            // The other ways are still there.
            await model.perform(.useStepUpWay(.password))
            XCTAssertEqual(model.panel, .stepUp(.password, others: [.textedCode], sent: nil), code)

            // Refused on a resend: the code field goes with the button.
            stage = try await asked("sms_code")
            model = stage.model
            stage.api.on(Account.stepUpSms, Account.sent("sms_code", to: Wire.masked))
            await model.perform(.sendStepUpCode)
            model.setText("123456", of: .code)
            stage.api.on(Account.stepUpSms, Reply.error(403, code))
            await model.perform(.sendStepUpCode)
            XCTAssertEqual(model.panel, .stepUp(.textedCode, others: [], sent: nil), code)
            XCTAssertTrue(model.textedOff, code)
            XCTAssertEqual(model.code, "", code)
            XCTAssertEqual(model.content.fields, [], code)
            XCTAssertEqual(model.content.actions, [.cancel], code)
            XCTAssertNotNil(model.formError, code)
        }
    }

    func testAPasskeyProvesItThroughTheSheet() async throws {
        let sheet = ScriptedPasskeySheet()
        let stage = try await asked("passkey,password", sheet: sheet)
        let model = stage.model
        XCTAssertEqual(sheet.asked, 0, "no sheet is shown by arriving")
        await model.submitStepUp()
        XCTAssertEqual(stage.api.count(Account.stepUp), 0, "a passkey is not typed")

        stage.api.on(Account.stepUpPasskey, Reply(json: Wire.requestOptions))
        stage.acceptProof()
        await model.perform(.stepUpWithPasskey)
        XCTAssertEqual(sheet.asked, 1)
        XCTAssertEqual(stage.api.body(Account.stepUp)["method"] as? String, "passkey")
        assertOwedWasDone(stage, "a passkey")
        XCTAssertFalse(stage.everything.contains("CANARY"))
    }

    func testAClosedSheetARefusedPasskeyAndASheetThatFailed() async throws {
        let sheet = ScriptedPasskeySheet()
        let stage = try await asked("passkey,password", sheet: sheet)
        let model = stage.model
        let open = TulaAccountPanel.stepUp(.passkey, others: [.password], sent: nil)
        stage.api.on(Account.stepUpPasskey, Reply(json: Wire.requestOptions))

        // Closed: nothing was proven, and that is no error.
        sheet.answer(.failure(TulaSheetError.dismissed))
        await model.perform(.stepUpWithPasskey)
        XCTAssertEqual(model.panel, open)
        XCTAssertEqual(model.notice, "The passkey request was cancelled. Nothing was changed; you can try again.")
        XCTAssertNil(model.formError)
        XCTAssertEqual(stage.api.count(Account.stepUp), 0)
        XCTAssertEqual(stage.api.count(Account.totpStart), 1)
        XCTAssertFalse(model.isPending)

        // Failed: the table's words, never the sheet's own.
        sheet.answer(.failure(LoudSheetFailure()))
        await model.perform(.stepUpWithPasskey)
        XCTAssertNotNil(model.formError)
        XCTAssertNil(model.notice)
        XCTAssertFalse(stage.everything.contains(LoudSheetFailure.text))
        XCTAssertEqual(stage.api.count(Account.stepUp), 0)

        // Refused by the server: about the passkey, never about an address and a password.
        sheet.answer(.success(ScriptedPasskeySheet.assertion))
        stage.api.on(Account.stepUp, Reply.error(401, "auth.invalid_credentials"))
        await model.perform(.stepUpWithPasskey)
        XCTAssertEqual(model.panel, open)
        XCTAssertEqual(model.formError, "That passkey was not accepted. Try again, or confirm it is you another way.")
        XCTAssertEqual(model.fieldErrors, [:])
        XCTAssertEqual(stage.heard.said.last, model.formError)
        XCTAssertEqual(stage.api.count(Account.totpStart), 1)

        // Another sheet of the app still out.
        let gate = Gate()
        sheet.hold(gate)
        let stepUp = stage.client.stepUp
        let first = Task { _ = try? await stepUp.withPasskey() }
        await eventually("the first sheet is out") { sheet.asked == 4 }
        await model.perform(.stepUpWithPasskey)
        XCTAssertEqual(model.notice, "Another sign-in window is still open. Finish or close it first.")
        XCTAssertNil(model.formError)
        XCTAssertEqual(sheet.asked, 4)
        sheet.answer(.failure(TulaSheetError.dismissed))
        gate.open()
        await first.value
    }

    // MARK: Cancelling

    func testCancellingAStepUpShowsTheAccountAndDoesNotDoWhatWasAskedFor() async throws {
        let stage = try await asked("password,totp")
        let model = stage.model
        model.setText(Canary.password, of: .password)
        await model.perform(.cancel)
        XCTAssertEqual(model.panel, .overview)
        XCTAssertEqual(model.notice, "Nothing was changed.")
        XCTAssertEqual(stage.heard.said.last, "Nothing was changed.")
        XCTAssertNil(model.formError)
        XCTAssertNil(model.status)
        stage.assertNothingSecretIsHeld("after the step-up was cancelled")
        XCTAssertEqual(stage.api.count(Account.stepUp), 0)
        XCTAssertEqual(stage.api.count(Account.totpStart), 1, "what was asked for was not done")

        // What was owed is forgotten: a proof given for something else does only that.
        stage.api.on(Account.revokeOthers, Account.stepUpRequired("password"))
        stage.api.on(Account.revokeOthers, Reply(json: #"{"revoked":1}"#))
        await model.perform(.signOutOthers)
        stage.acceptProof()
        model.setText(Canary.password, of: .password)
        await model.perform(.submitStepUp)
        XCTAssertEqual(model.panel, .overview)
        XCTAssertEqual(model.status, "Signed out of 1 other device.")
        XCTAssertEqual(stage.api.count(Account.revokeOthers), 2)
        XCTAssertEqual(stage.api.count(Account.totpStart), 1)
    }

    func testCancellingAStepUpOverAFormClosesTheFormToo() async throws {
        let stage = try await AccountStage.loaded(config: Account.config(phone: true))
        let model = stage.model
        await model.perform(.openPhone)
        model.setText(Wire.number, of: .phoneNumber)
        stage.api.on(Account.phone, Account.stepUpRequired("password"))
        await model.perform(.sendPhoneCode)
        XCTAssertEqual(model.panel, .stepUp(.password, others: [], sent: nil))
        XCTAssertEqual(model.phoneNumber, Wire.number, "kept behind the step-up: what is owed needs it")
        await model.perform(.cancel)
        XCTAssertEqual(model.panel, .overview)
        XCTAssertEqual(model.phoneNumber, "")
        XCTAssertEqual(model.notice, "Nothing was changed.")
        XCTAssertEqual(stage.api.count(Account.phone), 1)
    }

    // MARK: What is owed

    func testASecondDemandForProofReplacesTheFirst() async throws {
        // The proof was accepted, and the server asks again for the same call: the step-up
        // is open again, and nothing loops.
        let stage = try await AccountStage.loaded()
        stage.api.on(Account.totpStart, Account.stepUpRequired("password"))
        await stage.model.perform(.setUpAuthenticator)
        stage.acceptProof()
        stage.model.setText(Canary.password, of: .password)
        await stage.model.perform(.submitStepUp)
        XCTAssertEqual(stage.model.panel, .stepUp(.password, others: [], sent: nil))
        XCTAssertEqual(stage.api.count(Account.totpStart), 2)
        XCTAssertEqual(stage.api.count(Account.stepUp), 1)
        XCTAssertEqual(stage.model.password, "")
    }

    func testRemovingAPasskeyIsDoneOnceAfterTheProof() async throws {
        let stage = try await AccountStage.loaded(passkeys: Account.passkeys([Account.passkey()]))
        let model = stage.model
        let question = TulaAccountConfirmation.removePasskey(id: "pk_1", name: "iPhone")
        await model.perform(.ask(question))
        stage.api.on(Account.passkeyRemove("pk_1"), Account.stepUpRequired("totp,backup_code"))
        stage.api.on(Account.passkeyRemove("pk_1"), Account.none)
        await model.perform(.confirm)
        XCTAssertEqual(model.panel, .stepUp(.totp, others: [.backupCode], sent: nil))
        XCTAssertEqual(model.passkeys?.count, 1, "nothing was removed yet")

        stage.acceptProof()
        stage.api.on(Account.passkeys, Reply(json: Account.passkeys([])))
        model.setText("123456", of: .code)
        await model.perform(.submitStepUp)
        XCTAssertEqual(model.panel, .overview)
        XCTAssertEqual(model.status, "The passkey was removed.")
        XCTAssertEqual(stage.api.count(Account.passkeyRemove("pk_1")), 2, "asked, refused for proof, done once")
        XCTAssertEqual(model.passkeys, [])
    }

    func testAPhoneCodeIsSentAfterTheProofWithTheNumberThatWasTyped() async throws {
        let stage = try await AccountStage.loaded(config: Account.config(phone: true))
        let model = stage.model
        await model.perform(.openPhone)
        model.setText(Wire.number, of: .phoneNumber)
        stage.api.on(Account.phone, Account.stepUpRequired("password"))
        stage.api.on(Account.phone, Account.sent("sms_code", to: Wire.masked))
        await model.perform(.sendPhoneCode)
        XCTAssertEqual(model.panel, .stepUp(.password, others: [], sent: nil))

        stage.acceptProof()
        model.setText(Canary.password, of: .password)
        await model.perform(.submitStepUp)
        XCTAssertEqual(model.panel, .phoneCode(destination: Wire.masked))
        XCTAssertEqual(stage.api.count(Account.phone), 2)
        XCTAssertEqual(stage.api.body(Account.phone, 1)["phoneNumber"] as? String, Wire.number)
        XCTAssertEqual(model.phoneNumber, Wire.number)
        XCTAssertEqual(model.password, "")

        // A proof asked for by the code itself texts a new one: the code did not wait.
        stage.api.on(Account.phoneVerify, Account.stepUpRequired("password"))
        model.setText("123456", of: .code)
        await model.perform(.verifyPhone)
        XCTAssertEqual(model.code, "")
        stage.acceptProof()
        model.setText(Canary.password, of: .password)
        await model.perform(.submitStepUp)
        XCTAssertEqual(model.panel, .phoneCode(destination: Wire.masked))
        XCTAssertEqual(stage.api.count(Account.phone), 3)
        XCTAssertEqual(stage.api.count(Account.phoneVerify), 1)
    }

    func testAPasskeysNameIsSavedAfterTheProofWithTheNameThatWasTyped() async throws {
        let stage = try await AccountStage.loaded(passkeys: Account.passkeys([Account.passkey()]))
        let model = stage.model
        await model.perform(.openRename("pk_1"))
        model.setText("Work phone", of: .name)
        stage.api.on(Account.passkeyRename("pk_1"), Account.stepUpRequired("password"))
        stage.api.on(Account.passkeyRename("pk_1"), Reply(json: Account.passkey(name: "Work phone")))
        await model.perform(.saveName)
        XCTAssertEqual(model.panel, .stepUp(.password, others: [], sent: nil))
        XCTAssertEqual(model.name, "Work phone")

        stage.acceptProof()
        model.setText(Canary.password, of: .password)
        await model.perform(.submitStepUp)
        XCTAssertEqual(model.panel, .overview)
        XCTAssertEqual(model.status, "The passkey was renamed.")
        XCTAssertEqual(stage.api.count(Account.passkeyRename("pk_1")), 2)
        XCTAssertEqual(stage.api.body(Account.passkeyRename("pk_1"), 1)["name"] as? String, "Work phone")
    }

    func testEveryOtherActionIsDoneOnceAfterTheProof() async throws {
        // Each row: what is asked for, its route, the answer once proven, and where it ends.
        let sheet = ScriptedPasskeySheet()
        let stage = try await AccountStage.loaded(
            sheet: sheet, user: Account.user(phone: "+14155550142"),
            factors: Account.factors(totp: true, codes: 1, sms: Account.sms(enabled: true, inUse: false, available: false)))
        let model = stage.model
        func prove(_ what: String, file: StaticString = #filePath, line: UInt = #line) async {
            XCTAssertEqual(model.panel, .stepUp(.password, others: [], sent: nil), what, file: file, line: line)
            stage.acceptProof()
            model.setText(Canary.password, of: .password)
            await model.perform(.submitStepUp)
        }

        stage.api.on(Account.backupCodes, Account.stepUpRequired("password"))
        stage.api.on(Account.backupCodes, Account.codes)
        await model.perform(.newBackupCodes)
        await prove("new backup codes")
        XCTAssertEqual(model.panel, .backupCodes)
        XCTAssertEqual(model.backupCodes, Wire.backupCodes)
        XCTAssertEqual(stage.api.count(Account.backupCodes), 2)
        await model.perform(.savedBackupCodes)

        stage.api.on(Account.passkeyOptions, Account.stepUpRequired("password"))
        stage.api.on(Account.passkeyOptions, Reply(json: Account.creationOptions))
        stage.api.on(Account.passkeyAdd, Reply(status: 201, json: Account.passkey()))
        await model.perform(.addPasskey)
        XCTAssertEqual(sheet.created, 0, "no sheet before the proof")
        await prove("adding a passkey")
        XCTAssertEqual(sheet.created, 1)
        XCTAssertEqual(model.status, "Your passkey was added.")

        await model.perform(.ask(.turnOffTexted))
        stage.api.on(Account.smsOff, Account.stepUpRequired("password"))
        stage.api.on(Account.smsOff, Account.none)
        await model.perform(.confirm)
        await prove("turning the texted code off")
        XCTAssertEqual(model.status, "Text messages are no longer your second step.")
        XCTAssertEqual(stage.api.count(Account.smsOff), 2)

        await model.perform(.ask(.removePhone))
        stage.api.on(Account.phoneRemove, Account.stepUpRequired("password"))
        stage.api.on(Account.phoneRemove, Account.none)
        await model.perform(.confirm)
        await prove("removing the phone number")
        XCTAssertEqual(model.status, "Your phone number was removed.")
        XCTAssertEqual(stage.api.count(Account.phoneRemove), 2)

        await model.perform(.ask(.turnOffAuthenticator))
        stage.api.on(Account.totpOff, Account.stepUpRequired("password"))
        stage.api.on(Account.totpOff, Account.none)
        await model.perform(.confirm)
        await prove("turning the authenticator off")
        XCTAssertEqual(model.status, "Two-step verification is off.")
        XCTAssertEqual(stage.api.count(Account.totpOff), 2)

        stage.api.on(Account.revoke("ses_2"), Account.stepUpRequired("password"))
        stage.api.on(Account.revoke("ses_2"), Account.none)
        await model.perform(.signOutSession("ses_2"))
        await prove("signing a device out")
        XCTAssertEqual(model.status, "That device was signed out.")
        XCTAssertEqual(stage.api.count(Account.revoke("ses_2")), 2)
    }

    func testAProofAskedForWhileConfirmingASetupStartsTheSetupAgain() async throws {
        let stage = try await AccountStage.loaded(
            factors: Account.factors(sms: Account.sms(enabled: false, inUse: false, available: true)))
        let model = stage.model
        stage.api.on(Account.totpStart, Wire.totpEnrolment)
        await model.perform(.setUpAuthenticator)
        stage.api.on(Account.totpConfirm, Account.stepUpRequired("password"))
        model.setText("123456", of: .code)
        await model.perform(.confirmAuthenticator)
        XCTAssertEqual(model.panel, .stepUp(.password, others: [], sent: nil))
        XCTAssertNil(model.setup, "the key does not wait behind the step-up")
        stage.acceptProof()
        model.setText(Canary.password, of: .password)
        await model.perform(.submitStepUp)
        XCTAssertEqual(model.panel, .totpSetup)
        XCTAssertEqual(stage.api.count(Account.totpStart), 2, "a new key")
        XCTAssertEqual(stage.api.count(Account.totpConfirm), 1, "the code that was typed is not sent again")
        XCTAssertEqual(model.code, "")
        model.cancel()

        // The same for a texted second step: a new code is texted.
        stage.api.on(Account.smsStart, Account.sent("sms_code", to: Wire.masked))
        await model.perform(.turnOnTexted)
        stage.api.on(Account.smsConfirm, Account.stepUpRequired("password"))
        model.setText("123456", of: .code)
        await model.perform(.confirmTexted)
        stage.acceptProof()
        model.setText(Canary.password, of: .password)
        await model.perform(.submitStepUp)
        XCTAssertEqual(model.panel, .textedFactor(destination: Wire.masked))
        XCTAssertEqual(stage.api.count(Account.smsStart), 2)
        XCTAssertEqual(stage.api.count(Account.smsConfirm), 1)
    }

    func testAPasswordChangeIsTypedAgainAfterTheProofAndNothingIsSentByItself() async throws {
        let stage = try await AccountStage.loaded()
        let model = stage.model
        await model.perform(.openChangePassword)
        model.setText(Canary.password, of: .currentPassword)
        model.setText("New-Password-CANARY-2!", of: .newPassword)
        model.toggleReveal(.newPassword)
        stage.api.on(Account.password, Account.stepUpRequired("totp"))
        await model.perform(.submitPassword)
        XCTAssertEqual(model.panel, .stepUp(.totp, others: [], sent: nil))
        stage.assertNothingSecretIsHeld("behind the step-up: a typed secret does not wait")

        stage.acceptProof()
        model.setText("123456", of: .code)
        await model.perform(.submitStepUp)
        XCTAssertEqual(model.panel, .changePassword, "the form is open again")
        stage.assertNothingSecretIsHeld("on the form opened again: it is empty")
        XCTAssertEqual(model.notice, "Confirmed. Enter it again to continue.")
        XCTAssertEqual(model.notice, TulaStrings.english.account.stepUpDone)
        XCTAssertEqual(stage.heard.said.last, "Confirmed. Enter it again to continue.")
        XCTAssertNil(model.status)
        XCTAssertNil(model.formError)
        XCTAssertEqual(stage.api.count(Account.password), 1, "nothing was sent by itself")
        XCTAssertFalse(stage.everything.contains("CANARY"))

        // Typed again, it goes through.
        stage.api.on(Account.password, Account.none)
        model.setText(Canary.password, of: .currentPassword)
        model.setText("New-Password-CANARY-2!", of: .newPassword)
        await model.perform(.submitPassword)
        XCTAssertEqual(model.panel, .overview)
        XCTAssertEqual(model.status, "Your password was changed. Your other devices were signed out.")
        XCTAssertEqual(stage.api.count(Account.password), 2)
    }

    // MARK: Leaving meanwhile

    func testClosingWhileAProofIsOnItsWayDoesNothingOfWhatWasOwed() async throws {
        let stage = try await asked("password")
        let model = stage.model
        let gate = Gate()
        stage.api.on(Account.stepUp) { _ in
            await gate.wait()
            return Reply(json: Wire.tokens)
        }
        model.setText(Canary.password, of: .password)
        let proof = Task { await model.perform(.submitStepUp) }
        await eventually("the proof left") { stage.api.count(Account.stepUp) == 1 }
        XCTAssertEqual(model.password, "", "emptied as it is sent")
        await model.perform(.submitStepUp)
        XCTAssertEqual(stage.api.count(Account.stepUp), 1, "one at a time")
        model.close()
        gate.open()
        await proof.value
        XCTAssertEqual(model.panel, .overview)
        XCTAssertEqual(stage.api.count(Account.totpStart), 1, "the screen closed: nothing is done for it")
        stage.assertNothingSecretIsHeld("after close()")

        // The same for a code that was being sent, and for a sheet that was out.
        let sheet = ScriptedPasskeySheet()
        let other = try await asked("email_code,passkey", sheet: sheet)
        let held = Gate()
        other.api.on(Account.stepUpEmail) { _ in
            await held.wait()
            return Account.sent("email_code", to: Account.maskedEmail)
        }
        let sending = Task { await other.model.perform(.sendStepUpCode) }
        await eventually("the code was asked for") { other.api.count(Account.stepUpEmail) == 1 }
        other.model.close()
        held.open()
        await sending.value
        XCTAssertEqual(other.model.panel, .overview)

        let third = try await asked("passkey", sheet: sheet)
        third.api.on(Account.stepUpPasskey, Reply(json: Wire.requestOptions))
        let out = Gate()
        sheet.hold(out)
        let showing = Task { await third.model.perform(.stepUpWithPasskey) }
        await eventually("the sheet is out") { sheet.asked == 1 }
        third.model.close()
        sheet.answer(.failure(TulaSheetError.dismissed))
        out.open()
        await showing.value
        XCTAssertEqual(third.model.panel, .overview)
        XCTAssertNil(third.model.notice, "a screen that closed says nothing")
    }

    func testAFailureThatArrivesAfterTheScreenClosedIsNotSaid() async throws {
        let sheet = ScriptedPasskeySheet()
        let stage = try await asked("email_code,passkey", sheet: sheet)
        let model = stage.model
        let gate = Gate()
        stage.api.on(Account.stepUpEmail) { _ in
            await gate.wait()
            return Reply.error(503, "service.unavailable")
        }
        let sending = Task { await model.perform(.sendStepUpCode) }
        await eventually("the code was asked for") { stage.api.count(Account.stepUpEmail) == 1 }
        model.close()
        gate.open()
        await sending.value
        XCTAssertNil(model.formError)

        let second = try await asked("password")
        let held = Gate()
        second.api.on(Account.stepUp) { _ in
            await held.wait()
            return Reply.error(401, "auth.invalid_credentials")
        }
        second.model.setText(Canary.password, of: .password)
        let proof = Task { await second.model.perform(.submitStepUp) }
        await eventually("the proof left") { second.api.count(Account.stepUp) == 1 }
        second.model.close()
        held.open()
        await proof.value
        XCTAssertEqual(second.model.fieldErrors, [:])

        let third = try await asked("passkey", sheet: sheet)
        let out = Gate()
        third.api.on(Account.stepUpPasskey) { _ in
            await out.wait()
            return Reply.error(503, "service.unavailable")
        }
        let showing = Task { await third.model.perform(.stepUpWithPasskey) }
        await eventually("the options were asked for") { third.api.count(Account.stepUpPasskey) == 1 }
        third.model.close()
        out.open()
        await showing.value
        XCTAssertNil(third.model.formError)
    }
}
