import Foundation
import TulaAuth
import XCTest

@testable import TulaAuthUI

// The second step of a sign-in and setting one up inside a sign-in: which way is open and
// which are offered, what a refused code and a closed sheet are said as, and that a setup
// key and backup codes are held only while their screen is open.
@MainActor
final class SecondStepTests: XCTestCase {
    /// A sign-in that has reached the second step.
    private func second(
        _ step: String = Wire.secondFactor, passkeys: ScriptedPasskeySheet? = nil,
        storage: any TulaTokenStorage = MemoryTokenStorage()
    ) async throws -> Stage {
        let stage = try Stage(storage: storage, passkeys: passkeys)
        await stage.signIn(to: step)
        return stage
    }

    /// A sign-in whose texted second step was asked for.
    private func textedSecond() async throws -> Stage {
        let stage = try await second(Wire.textedSecond)
        stage.api.on(Wire.secondPrepare, Wire.flow("sign_in", Wire.textedSecondPrepared))
        await stage.model.sendTextedCode()
        XCTAssertEqual(stage.model.screen, .secondFactor(.textedCode, others: [], sent: Wire.masked))
        return stage
    }

    /// A sign-in that has to set up an authenticator app.
    private func enrolling(storage: any TulaTokenStorage = MemoryTokenStorage()) async throws -> Stage {
        let stage = try Stage(storage: storage)
        await stage.signIn(to: Wire.enrolment)
        XCTAssertEqual(stage.model.screen, .enrolmentStart)
        return stage
    }

    /// The same, with the setup key on the screen.
    private func settingUp(storage: any TulaTokenStorage = MemoryTokenStorage()) async throws -> Stage {
        let stage = try await enrolling(storage: storage)
        stage.api.on(Wire.enrolStart, Wire.totpEnrolment)
        await stage.model.startEnrolment()
        XCTAssertEqual(stage.model.screen, .totpSetup)
        return stage
    }

    /// The same, with the backup codes on the screen: the flow has completed.
    private func codesShown(storage: any TulaTokenStorage = MemoryTokenStorage()) async throws -> Stage {
        let stage = try await settingUp(storage: storage)
        stage.api.on(Wire.enrolConfirm, Wire.enrolled())
        stage.model.code = "123456"
        await stage.model.confirmEnrolment()
        XCTAssertEqual(stage.model.screen, .backupCodes)
        return stage
    }

    // MARK: Which way is open

    func testTheWaysAreOfferedStrongestFirstAndOnlyTheOnesThisAppCanTake() async throws {
        let plain = try await second()
        XCTAssertEqual(plain.model.screen, .secondFactor(.totp, others: [.backupCode], sent: nil))
        XCTAssertEqual(plain.api.routes, [Wire.signIns], "nothing is sent by arriving")
        XCTAssertNil(plain.model.formError)

        // Whatever order the server lists them in.
        let sheet = try await second(Wire.everySecondWay, passkeys: ScriptedPasskeySheet())
        XCTAssertEqual(sheet.model.screen, .secondFactor(.totp, others: [.passkey, .backupCode], sent: nil))

        // Without a passkey sheet there is no passkey link: a control that cannot work.
        let none = try await second(Wire.everySecondWay)
        XCTAssertEqual(none.model.screen, .secondFactor(.totp, others: [.backupCode], sent: nil))
        XCTAssertFalse(none.model.content.actions.contains(.useSecondWay(.passkey)))
        XCTAssertFalse(none.model.content.actions.contains(.useSecondPasskey))

        // A passkey alone, with a sheet, is said in words with its button.
        let only = try await second(Wire.passkeySecond, passkeys: ScriptedPasskeySheet())
        XCTAssertEqual(only.model.screen, .secondFactor(.passkey, others: [], sent: nil))
        XCTAssertEqual(only.model.content.primary?.action, .useSecondPasskey)
        XCTAssertEqual(only.model.content.subtitle, "Use your passkey to finish signing in.")

        // A way of tomorrow beside one this version knows is left out, never guessed.
        let mixed = try await second(#"{"status":"needs_second_factor","options":["retina_scan","totp"]}"#)
        XCTAssertEqual(mixed.model.screen, .secondFactor(.totp, others: [], sent: nil))
    }

    func testAnotherWayIsOpenedByAPersonAndStaysOpenWhileTheStepIsTheSame() async throws {
        let sheet = ScriptedPasskeySheet()
        let stage = try await second(Wire.everySecondWay, passkeys: sheet)
        stage.model.code = "123456"
        await stage.model.perform(.useSecondWay(.backupCode))
        XCTAssertEqual(stage.model.screen, .secondFactor(.backupCode, others: [.totp, .passkey], sent: nil))
        XCTAssertEqual(stage.model.code, "", "the code of the screen that was left is gone")
        XCTAssertEqual(stage.model.focus, .title)
        XCTAssertEqual(stage.api.routes, [Wire.signIns], "choosing a way sends nothing")

        // A way the open screen does not offer is not opened.
        stage.model.useSecondWay(.textedCode)
        stage.model.useSecondWay(.backupCode)
        XCTAssertEqual(stage.model.screen, .secondFactor(.backupCode, others: [.totp, .passkey], sent: nil))

        // A refused backup code leaves the backup code's screen open: the step is the same.
        stage.api.on(Wire.secondFactorRoute, Reply.error(422, "mfa.invalid_code"))
        stage.model.backupCode = "abcde-fghjk"
        await stage.model.submitBackupCode()
        XCTAssertEqual(stage.model.screen, .secondFactor(.backupCode, others: [.totp, .passkey], sent: nil))

        stage.model.backupCode = "abcde-fghjk"
        stage.model.useSecondWay(.passkey)
        XCTAssertEqual(stage.model.screen, .secondFactor(.passkey, others: [.backupCode, .totp], sent: nil))
        XCTAssertEqual(stage.model.backupCode, "")
        XCTAssertEqual(sheet.asked, 0, "no sheet is shown by arriving")
    }

    func testAnActionOfTheSecondStepWithoutItsFlowSaysSo() async throws {
        let sheet = ScriptedPasskeySheet()
        let rows: [(String, () async throws -> Stage, TulaAuthAction)] = [
            ("an authenticator code", { try await self.second() }, .submitCode),
            ("another way", { try await self.second() }, .useSecondWay(.backupCode)),
            (
                "a backup code",
                {
                    let stage = try await self.second()
                    stage.model.useSecondWay(.backupCode)
                    return stage
                }, .submitBackupCode
            ),
            ("a passkey", { try await self.second(Wire.passkeySecond, passkeys: sheet) }, .useSecondPasskey),
            ("asking for a texted code", { try await self.second(Wire.textedSecond) }, .sendTextedCode),
            ("a texted code", textedSecond, .submitCode), ("another texted code", textedSecond, .resendCode),
            ("setting up", { try await self.enrolling() }, .startEnrolment),
            ("confirming", { try await self.settingUp() }, .confirmEnrolment),
            ("the codes are saved", { try await self.codesShown() }, .savedBackupCodes),
        ]
        for (name, make, action) in rows {
            let stage = try await make()
            XCTAssertTrue(stage.model.content.actions.contains(action), name)
            // `leave()` alone leaves a step open without its flow: only a test does that.
            let told = stage.heard.signedIn
            stage.model.leave()
            let sent = stage.api.routes
            stage.model.code = "123456"
            stage.model.backupCode = "abcde-fghjk"
            await stage.model.perform(action)
            XCTAssertEqual(stage.model.screen, .signInStart, name)
            XCTAssertEqual(stage.model.formError, "That attempt is no longer open. Start again.", name)
            XCTAssertEqual(stage.heard.said.last, "That attempt is no longer open. Start again.", name)
            XCTAssertEqual(stage.api.routes, sent, "\(name): nothing is sent on a guess")
            XCTAssertEqual([stage.model.code, stage.model.backupCode], ["", ""], name)
            XCTAssertEqual(stage.heard.signedIn, told, name)
            XCTAssertFalse(stage.model.isPending, name)
        }
        XCTAssertEqual(sheet.asked, 0)
    }

    // MARK: An authenticator app's code

    func testAnAuthenticatorCodeFinishesTheSignIn() async throws {
        let stage = try await second()
        stage.api.on(Wire.secondFactorRoute, Wire.flow("sign_in", Wire.complete))
        stage.model.code = "123456"
        await stage.model.perform(.submitCode)
        XCTAssertEqual(stage.api.body(Wire.secondFactorRoute)["method"] as? String, "totp")
        XCTAssertEqual(stage.api.body(Wire.secondFactorRoute)["code"] as? String, "123456")
        XCTAssertEqual(stage.model.screen, .signedIn)
        XCTAssertEqual(stage.heard.signedIn, 1)
        XCTAssertEqual(stage.model.code, "")
    }

    func testAWrongAnExpiredAndAUsedCodeAreSaidAtTheCodeAndTheFieldIsEmptied() async throws {
        let rows: [(Reply, String)] = [
            // A wrong code, and one whose time step was already used: one code for both.
            (Reply.error(422, "mfa.invalid_code"), "That code is incorrect."),
            // The code the server has for a wrong password, on a screen with no password.
            (Reply.error(401, "auth.invalid_credentials"), "That code is incorrect."),
            (Reply.error(410, "verification.expired"), "That code has expired. Request a new one."),
        ]
        for (reply, words) in rows {
            let stage = try await second()
            stage.api.on(Wire.secondFactorRoute, reply)
            stage.model.code = "000000"
            await stage.model.submitCode()
            XCTAssertEqual(stage.model.fieldErrors, [.code: [words]], reply.json)
            XCTAssertNil(stage.model.formError, reply.json)
            XCTAssertEqual(stage.model.code, "", reply.json)
            XCTAssertEqual(stage.model.focus, .field(.code), reply.json)
            XCTAssertEqual(stage.model.screen, .secondFactor(.totp, others: [.backupCode], sent: nil), reply.json)
            XCTAssertEqual(stage.heard.said.last, words, reply.json)
            XCTAssertFalse(stage.shown.contains(Canary.serverText), reply.json)
            XCTAssertFalse(stage.shown.contains("password"), reply.json)
            XCTAssertEqual(stage.heard.signedIn, 0, reply.json)

            // Sent again it is refused again: nothing remembers that it "was right".
            stage.model.code = "000000"
            await stage.model.submitCode()
            XCTAssertEqual(stage.api.count(Wire.secondFactorRoute), 2, reply.json)
            XCTAssertEqual(stage.model.code, "", reply.json)
        }
    }

    func testALockedSecondStepSaysTheWaitInWords() async throws {
        let stage = try await second()
        stage.api.on(Wire.secondFactorRoute, Reply.error(429, "rate_limited", headers: ["retry-after": "75"]))
        stage.model.code = "123456"
        await stage.model.submitCode()
        let said = try XCTUnwrap(stage.model.formError)
        XCTAssertTrue(said.hasSuffix("Try again in 1m 15s."), said)
        XCTAssertEqual(stage.model.fieldErrors, [:])
        XCTAssertEqual(stage.model.code, "")
        XCTAssertFalse(stage.shown.contains(Canary.serverText))
    }

    func testACodeThatIsNotSixDigitsIsNotSent() async throws {
        let stage = try await second()
        await stage.model.submitCode()
        XCTAssertEqual(stage.model.fieldErrors, [.code: ["Enter the 6-digit code."]])
        XCTAssertEqual(stage.api.count(Wire.secondFactorRoute), 0)
    }

    // MARK: A backup code

    func testABackupCodeFinishesTheSignInAndIsEmptiedAsItIsSent() async throws {
        let stage = try await second()
        stage.model.useSecondWay(.backupCode)
        // Empty: said at the field, in the field's own words, without a request.
        stage.model.setText("  ", of: .backupCode)
        await stage.model.perform(.submitBackupCode)
        XCTAssertEqual(stage.model.fieldErrors, [.backupCode: ["Enter a backup code."]])
        XCTAssertEqual(stage.model.focus, .field(.backupCode))
        XCTAssertEqual(stage.api.count(Wire.secondFactorRoute), 0)

        let done = Wire.flow("sign_in", Wire.complete)
        stage.api.on(Wire.secondFactorRoute, Reply(json: String(done.json.dropLast()) + #","backupCodesRemaining":9}"#))
        stage.model.setText(" abcde-fghjk\n", of: .backupCode)
        XCTAssertEqual(stage.model.text(of: .backupCode), " abcde-fghjk\n")
        await stage.model.perform(.submitBackupCode)
        XCTAssertEqual(stage.api.body(Wire.secondFactorRoute)["method"] as? String, "backup_code")
        XCTAssertEqual(stage.api.body(Wire.secondFactorRoute)["code"] as? String, "abcde-fghjk")
        XCTAssertEqual(stage.model.screen, .signedIn)
        XCTAssertEqual(stage.model.backupCode, "")
        XCTAssertEqual(stage.heard.signedIn, 1)
    }

    func testARefusedBackupCodeIsSaidAtItsFieldAndEmptied() async throws {
        for (reply, words) in [
            (Reply.error(422, "mfa.invalid_code"), "That code is incorrect."),
            (Reply.error(401, "auth.invalid_credentials"), "That code is incorrect."),
        ] {
            let stage = try await second()
            stage.model.useSecondWay(.backupCode)
            stage.api.on(Wire.secondFactorRoute, reply)
            stage.model.backupCode = "abcde-fghjk"
            await stage.model.submitBackupCode()
            XCTAssertEqual(stage.model.fieldErrors, [.backupCode: [words]], reply.json)
            XCTAssertEqual(stage.model.backupCode, "", "a code works once: it is not sent twice")
            XCTAssertEqual(stage.model.focus, .field(.backupCode), reply.json)
            XCTAssertFalse(stage.shown.contains(Canary.serverText), reply.json)
        }
        // A problem the answer names by the field's wire name lands on the same field.
        let named = try await second()
        named.model.useSecondWay(.backupCode)
        named.api.on(
            Wire.secondFactorRoute,
            Reply(
                status: 422,
                json:
                    #"{"status":422,"code":"validation.failed","detail":"x","errors":[{"field":"code","code":"validation.failed","message":"\#(Canary.serverText)"}]}"#
            ))
        named.model.backupCode = "abcde"
        await named.model.submitBackupCode()
        XCTAssertEqual(named.model.fieldErrors[.backupCode]?.count, 1)
        XCTAssertFalse(named.shown.contains(Canary.serverText))
    }

    // MARK: A passkey as the second step

    private func passkeyStep(
        _ sheet: ScriptedPasskeySheet, storage: any TulaTokenStorage = MemoryTokenStorage()
    ) async throws -> Stage {
        let stage = try await second(Wire.passkeySecond, passkeys: sheet, storage: storage)
        stage.api.on(Wire.secondPasskeyOptions, Reply(json: Wire.requestOptions))
        return stage
    }

    func testAPasskeyFinishesTheSignIn() async throws {
        let sheet = ScriptedPasskeySheet()
        let stage = try await passkeyStep(sheet)
        stage.api.on(Wire.secondFactorRoute, Wire.flow("sign_in", Wire.complete))
        await stage.model.perform(.useSecondPasskey)
        XCTAssertEqual(sheet.asked, 1)
        XCTAssertEqual(stage.api.body(Wire.secondFactorRoute)["method"] as? String, "passkey")
        XCTAssertEqual(stage.model.screen, .signedIn)
        XCTAssertEqual(stage.heard.signedIn, 1)
    }

    func testAClosedPasskeySheetIsSaidQuietlyAndTheButtonWorksAgain() async throws {
        let sheet = ScriptedPasskeySheet()
        sheet.answer(.failure(TulaSheetError.dismissed))
        let stage = try await passkeyStep(sheet)
        await stage.model.useSecondPasskey()
        XCTAssertEqual(
            stage.model.notice, "The passkey request was cancelled. Nothing was changed; you can try again.")
        XCTAssertEqual(stage.heard.said.last, stage.model.notice)
        XCTAssertNil(stage.model.formError, "a closed sheet is not an error")
        XCTAssertEqual(stage.model.fieldErrors, [:])
        XCTAssertNil(stage.model.status, "and not a success")
        XCTAssertFalse(stage.model.isPending)
        XCTAssertEqual(stage.model.screen, .secondFactor(.passkey, others: [], sent: nil))
        XCTAssertEqual(stage.api.count(Wire.secondFactorRoute), 0, "nothing was sent to be judged")
        let signedIn = await stage.isSignedIn
        XCTAssertFalse(signedIn)
        XCTAssertEqual(stage.heard.signedIn, 0)

        // The same button, pressed again.
        sheet.answer(.success(ScriptedPasskeySheet.assertion))
        stage.api.on(Wire.secondFactorRoute, Wire.flow("sign_in", Wire.complete))
        await stage.model.useSecondPasskey()
        XCTAssertEqual(sheet.asked, 2)
        XCTAssertEqual(stage.model.screen, .signedIn)
        XCTAssertNil(stage.model.notice, "the note went with its screen")
    }

    func testAPasskeySheetThatFailedIsSaidInTheClientsWordsAndNothingOfItsOwn() async throws {
        for thrown in [TulaSheetError.failed as Error, LoudSheetFailure()] {
            let sheet = ScriptedPasskeySheet()
            sheet.answer(.failure(thrown))
            let stage = try await passkeyStep(sheet)
            await stage.model.useSecondPasskey()
            XCTAssertEqual(stage.model.formError, "The passkey could not be used. Try again.")
            XCTAssertNil(stage.model.notice)
            XCTAssertFalse(stage.model.isPending)
            XCTAssertEqual(stage.model.screen, .secondFactor(.passkey, others: [], sent: nil))
            XCTAssertFalse(stage.everything.contains(LoudSheetFailure.text))
        }
    }

    func testAPasskeyTheServerRefusedIsSaidAboutThePasskey() async throws {
        let stage = try await passkeyStep(ScriptedPasskeySheet())
        stage.api.on(Wire.secondFactorRoute, Reply.error(401, "auth.invalid_credentials"))
        await stage.model.useSecondPasskey()
        XCTAssertEqual(stage.model.formError, "That passkey did not sign you in. Try again, or sign in another way.")
        XCTAssertEqual(stage.heard.said.last, stage.model.formError)
        XCTAssertEqual(stage.model.fieldErrors, [:])
        XCTAssertFalse(stage.shown.contains("password"), "nothing here was a password")
        XCTAssertFalse(stage.shown.contains(Canary.serverText))
        XCTAssertFalse(stage.model.isPending)
    }

    func testASheetThatIsStillOpenElsewhereIsSaidQuietly() async throws {
        // Another part of the app has the client's one sheet out: `flow.busy`.
        let sheet = ScriptedPasskeySheet()
        let gate = Gate()
        sheet.hold(gate)
        let stage = try await passkeyStep(sheet)
        stage.api.on(Wire.passkeyStart, Wire.passkeyStarted)
        let client = stage.client
        let other = Task { _ = try? await client.signInWithPasskey() }
        await eventually("the other sheet is out") { sheet.asked == 1 }

        await stage.model.useSecondPasskey()
        XCTAssertEqual(stage.model.notice, "Another sign-in window is still open. Finish or close it first.")
        XCTAssertEqual(stage.heard.said.last, stage.model.notice)
        XCTAssertNil(stage.model.formError, "nothing went wrong, and nothing was sent")
        XCTAssertFalse(stage.model.isPending)
        XCTAssertEqual(stage.api.count(Wire.secondPasskeyOptions), 0)
        XCTAssertEqual(sheet.asked, 1, "no second sheet")

        sheet.answer(.failure(TulaSheetError.dismissed))
        gate.open()
        await other.value
    }

    func testAPasskeyAnsweredAfterItsScreenWasLeftChangesNothing() async throws {
        let sheet = ScriptedPasskeySheet()
        let gate = Gate()
        sheet.hold(gate)
        let stage = try await passkeyStep(sheet)
        stage.api.on(Wire.secondFactorRoute, Wire.flow("sign_in", Wire.complete))
        let asking = Task { await stage.model.useSecondPasskey() }
        await eventually("the sheet is out") { sheet.asked == 1 }
        // A second press meanwhile starts nothing.
        await stage.model.useSecondPasskey()
        XCTAssertEqual(sheet.asked, 1)
        stage.model.close()
        gate.open()
        await asking.value
        XCTAssertEqual(stage.model.screen, .signInStart)
        XCTAssertEqual(stage.heard.signedIn, 0)
        XCTAssertNil(stage.model.notice)
        XCTAssertNil(stage.model.formError)
    }

    // MARK: A texted code as the second step

    func testNothingIsTextedByArrivingAtTheSecondStep() async throws {
        let stage = try await second(Wire.textedSecond)
        XCTAssertEqual(stage.model.screen, .secondFactor(.textedCode, others: [], sent: nil))
        XCTAssertEqual(stage.api.routes, [Wire.signIns], "also where it is the only way")
        XCTAssertEqual(stage.model.screen.fields, [], "no field for a code nobody was sent")
        // The code's buttons are not there before a code was asked for.
        await stage.model.submitCode()
        await stage.model.resendCode()
        XCTAssertEqual(stage.api.routes, [Wire.signIns])

        stage.api.on(Wire.secondPrepare, Wire.flow("sign_in", Wire.textedSecondPrepared))
        await stage.model.perform(.sendTextedCode)
        XCTAssertEqual(stage.api.body(Wire.secondPrepare)["method"] as? String, "sms_code")
        XCTAssertEqual(stage.model.screen, .secondFactor(.textedCode, others: [], sent: Wire.masked))
        await stage.model.sendTextedCode()
        XCTAssertEqual(stage.api.count(Wire.secondPrepare), 1, "the offer's button is not on the code's screen")
    }

    func testATextedSecondStepIsSentAskedForAgainAndRefused() async throws {
        let stage = try await textedSecond()
        await stage.model.perform(.resendCode)
        XCTAssertEqual(stage.api.count(Wire.secondPrepare), 2)
        XCTAssertEqual(stage.model.status, "A new code is on its way.")

        stage.api.on(Wire.secondFactorRoute, Reply.error(401, "auth.invalid_credentials"))
        stage.model.code = "000000"
        await stage.model.submitCode()
        XCTAssertEqual(stage.model.fieldErrors, [.code: ["That code is incorrect."]])
        XCTAssertEqual(stage.model.code, "")
        XCTAssertNil(stage.model.status, "what went right is not said beside what went wrong")

        stage.api.on(Wire.secondFactorRoute, Wire.flow("sign_in", Wire.complete))
        stage.model.code = "123456"
        await stage.model.perform(.submitCode)
        XCTAssertEqual(stage.api.body(Wire.secondFactorRoute, 1)["method"] as? String, "sms_code")
        XCTAssertEqual(stage.model.screen, .signedIn)
        XCTAssertEqual(stage.heard.signedIn, 1)
    }

    func testASwitchedOffTextedSecondStepLosesItsControlsAndKeepsItsWords() async throws {
        for code in ["auth.method_disabled", "sms.disabled", "sms.country_not_allowed"] {
            let offer = try await second(Wire.textedSecond)
            offer.api.on(Wire.secondPrepare, Reply.error(403, code))
            await offer.model.sendTextedCode()
            XCTAssertEqual(offer.model.screen, .secondFactor(.textedCode, others: [], sent: nil), code)
            XCTAssertTrue(offer.model.textedOff, code)
            XCTAssertNil(offer.model.content.primary, code)
            XCTAssertEqual(offer.model.content.actions, [.startAgain], "\(code): the way out stays")
            XCTAssertNotNil(offer.model.formError, code)
            await offer.model.perform(.sendTextedCode)
            await offer.model.sendTextedCode()
            XCTAssertEqual(offer.api.count(Wire.secondPrepare), 1, code)

            let sent = try await textedSecond()
            sent.api.on(Wire.secondFactorRoute, Reply.error(403, code))
            sent.model.code = "123456"
            await sent.model.submitCode()
            XCTAssertEqual(sent.model.screen, .secondFactor(.textedCode, others: [], sent: nil), code)
            XCTAssertTrue(sent.model.textedOff, code)
            XCTAssertEqual(sent.model.content.fields, [], code)
            XCTAssertNil(sent.model.content.primary, code)
            XCTAssertNotNil(sent.model.formError, code)
            XCTAssertFalse(sent.shown.contains(Canary.serverText), code)
        }
    }

    func testATextedCodeAskedForEarlierInTheStepIsStillTheOneToType() async throws {
        // The server lists a texted code alone or not at all; a step that says otherwise is
        // still drawn from what it says.
        let stage = try await second(
            #"{"status":"needs_second_factor","options":["totp","sms_code"],"prepared":{"method":"sms_code","destination":"\#(Wire.masked)"}}"#
        )
        XCTAssertEqual(stage.model.screen, .secondFactor(.totp, others: [.textedCode], sent: nil))
        stage.model.useSecondWay(.textedCode)
        XCTAssertEqual(stage.model.screen, .secondFactor(.textedCode, others: [.totp], sent: Wire.masked))
        XCTAssertEqual(stage.api.routes, [Wire.signIns])
    }

    // MARK: Setting up an authenticator app inside a sign-in

    func testTheSetupKeyIsAskedForByAPersonAndHeldOnlyWhileItsScreenIsOpen() async throws {
        let stage = try await enrolling()
        XCTAssertEqual(stage.api.routes, [Wire.signIns], "no key is made by arriving")
        XCTAssertNil(stage.model.setup)
        XCTAssertEqual(stage.model.content.actions, [.startEnrolment, .startAgain])

        stage.api.on(Wire.enrolStart, Wire.totpEnrolment)
        await stage.model.perform(.startEnrolment)
        XCTAssertEqual(stage.model.screen, .totpSetup)
        XCTAssertEqual(stage.model.setup, TulaAuthSetup(key: Wire.setupKey, uri: Wire.setupAddress))
        let setup = try XCTUnwrap(stage.model.content.setup)
        XCTAssertEqual(
            setup,
            TulaAuthSetupContent(
                uri: Wire.setupAddress, key: Wire.setupKey,
                qrLabel: "QR code for your authenticator app. If you cannot scan it, use the setup key.",
                keyLabel: "Setup key", keyHint: "Keep this key private. It is shown only now.",
                copy: TulaAuthOffer("copyKey", "Copy setup key", .copySetupKey)))
        XCTAssertEqual(stage.model.content.actions, [.confirmEnrolment, .startAgain, .copySetupKey])
        XCTAssertEqual(stage.heard.copied, [], "nothing is copied by arriving")

        // Its button is not on its own screen: the key is not replaced behind a person's back.
        await stage.model.startEnrolment()
        XCTAssertEqual(stage.api.count(Wire.enrolStart), 1)

        // Leaving the screen forgets the key, whichever way it is left.
        stage.model.code = "123456"
        await stage.model.perform(.startAgain)
        XCTAssertEqual(stage.model.screen, .signInStart)
        XCTAssertNil(stage.model.setup)
        XCTAssertNil(stage.model.situation.setup)
        XCTAssertEqual(stage.model.code, "")
        XCTAssertFalse(stage.everything.contains(Wire.setupKey))
    }

    func testTheSetupKeyIsCopiedOnlyWhenAPersonAsks() async throws {
        let stage = try await settingUp()
        XCTAssertEqual(stage.heard.copied, [])
        await stage.model.perform(.copySetupKey)
        XCTAssertEqual(stage.heard.copied, [Wire.setupKey])
        XCTAssertEqual(stage.model.status, "Copied.")
        XCTAssertEqual(stage.heard.said.last, "Copied.")
        XCTAssertFalse(stage.heard.said.joined().contains(Wire.setupKey), "the key is never spoken")

        // The codes' button copies nothing here, and neither does once the screen is gone.
        stage.model.copyBackupCodes()
        stage.model.startAgain()
        stage.model.copySetupKey()
        await stage.model.perform(.copySetupKey)
        XCTAssertEqual(stage.heard.copied, [Wire.setupKey])
    }

    func testAnAuthenticatorCodeThatWasRefusedKeepsTheSetupOpen() async throws {
        let stage = try await settingUp()
        await stage.model.confirmEnrolment()
        XCTAssertEqual(stage.model.fieldErrors, [.code: ["Enter the 6-digit code."]])
        XCTAssertEqual(stage.api.count(Wire.enrolConfirm), 0)

        stage.api.on(Wire.enrolConfirm, Reply.error(422, "mfa.invalid_code"))
        stage.model.code = "000000"
        await stage.model.perform(.confirmEnrolment)
        XCTAssertEqual(stage.api.body(Wire.enrolConfirm)["code"] as? String, "000000")
        XCTAssertEqual(stage.model.fieldErrors, [.code: ["That code is incorrect."]])
        XCTAssertEqual(stage.model.code, "")
        XCTAssertEqual(stage.model.screen, .totpSetup)
        XCTAssertEqual(stage.model.setup?.key, Wire.setupKey, "the key is still the one to scan")
        XCTAssertEqual(stage.model.backupCodes, [])
        XCTAssertEqual(stage.heard.signedIn, 0)
        XCTAssertFalse(stage.model.isPending)
    }

    func testASetupKeyThatCouldNotBeHadIsSaidOnTheOffer() async throws {
        let stage = try await enrolling()
        stage.api.on(Wire.enrolStart, Reply.error(503, "service.unavailable"))
        await stage.model.startEnrolment()
        XCTAssertEqual(stage.model.screen, .enrolmentStart)
        XCTAssertNotNil(stage.model.formError)
        XCTAssertNil(stage.model.setup)
        XCTAssertFalse(stage.model.isPending)
        XCTAssertFalse(stage.shown.contains(Canary.serverText))
    }

    func testTheBackupCodesAreShownBeforeTheSignInIsReportedAndItIsReportedOnce() async throws {
        let stage = try await codesShown()
        // The client is signed in, and the app is not told yet: it would take the screens
        // away, and the codes with them.
        let signedIn = await stage.isSignedIn
        XCTAssertTrue(signedIn)
        XCTAssertEqual(stage.heard.signedIn, 0)
        XCTAssertEqual(stage.model.backupCodes, Wire.backupCodes)
        XCTAssertNil(stage.model.setup, "the setup key went with its screen")
        XCTAssertEqual(stage.model.code, "")
        XCTAssertEqual(
            stage.model.content.codes,
            TulaAuthCodesContent(
                label: "Backup codes", codes: Wire.backupCodes, copy: TulaAuthOffer("copyCodes", "Copy", .copyBackupCodes)
            ))
        XCTAssertEqual(stage.model.content.actions, [.savedBackupCodes, .copyBackupCodes])
        XCTAssertFalse(stage.heard.said.joined().contains("aaaaa"), "a code is never spoken")
        XCTAssertEqual(stage.heard.copied, [])

        await stage.model.perform(.copyBackupCodes)
        XCTAssertEqual(stage.heard.copied, ["aaaaa-bbbbb\nccccc-ddddd"])
        XCTAssertEqual(stage.model.status, "Copied.")
        stage.model.copySetupKey()
        XCTAssertEqual(stage.heard.copied.count, 1, "the key's button copies nothing here")

        await stage.model.perform(.savedBackupCodes)
        XCTAssertEqual(stage.model.screen, .signedIn)
        XCTAssertEqual(stage.heard.signedIn, 1)
        XCTAssertEqual(stage.model.backupCodes, [])
        XCTAssertEqual(stage.model.situation.backupCodes, [])
        XCTAssertNil(stage.model.formError)

        // Nothing reports it a second time.
        stage.model.savedBackupCodes()
        stage.model.copyBackupCodes()
        stage.model.close()
        stage.model.showSignUp()
        XCTAssertEqual(stage.heard.signedIn, 1)
        XCTAssertEqual(stage.heard.copied.count, 1)
    }

    func testWhateverLeavesTheBackupCodesReportsTheSignInOnceAndForgetsTheCodes() async throws {
        let ways: [(String, @MainActor (TulaAuthModel) -> Void, TulaAuthScreen)] = [
            ("closing", { $0.close() }, .signInStart), ("a sign-up", { $0.showSignUp() }, .signUpStart),
            ("a reset", { $0.showReset() }, .resetStart), ("starting again", { $0.startAgain() }, .signInStart),
        ]
        for (name, leave, landed) in ways {
            let stage = try await codesShown()
            leave(stage.model)
            XCTAssertEqual(stage.heard.signedIn, 1, "\(name): the app is told, though nobody pressed \"saved\"")
            XCTAssertEqual(stage.model.backupCodes, [], name)
            XCTAssertEqual(stage.model.screen, landed, name)
            leave(stage.model)
            stage.model.close()
            XCTAssertEqual(stage.heard.signedIn, 1, "\(name): once")
            XCTAssertFalse(stage.everything.contains("aaaaa"), name)
        }
    }

    func testCodesWhoseSessionCouldNotBeStoredAreShownAndTheSignedInScreenSaysSo() async throws {
        let storage = RefusingStorage()
        let stage = try await codesShown(storage: storage)
        let refused = await storage.refused
        XCTAssertEqual(refused, 1)
        XCTAssertEqual(stage.model.backupCodes, Wire.backupCodes, "the codes survive a session that was not saved")
        XCTAssertNil(stage.model.formError, "said where it is about: on the signed-in screen")
        stage.model.savedBackupCodes()
        XCTAssertEqual(stage.model.screen, .signedIn)
        XCTAssertEqual(stage.model.formError, stage.model.strings.sessionNotSaved)
        XCTAssertEqual(stage.heard.said.filter { $0 == stage.model.strings.sessionNotSaved }.count, 1)
        XCTAssertEqual(stage.heard.signedIn, 1)
    }

    func testAnEnrolmentThatDoesNotCompleteGoesOnToTheStepItIsAt() async throws {
        // The codes are shown whatever comes next: here an expired password.
        let stage = try await settingUp()
        stage.api.on(Wire.enrolConfirm, Wire.enrolled(Wire.expired))
        stage.model.code = "123456"
        await stage.model.confirmEnrolment()
        XCTAssertEqual(stage.model.screen, .backupCodes)
        XCTAssertEqual(stage.model.backupCodes, Wire.backupCodes)
        stage.model.savedBackupCodes()
        XCTAssertEqual(stage.model.screen, .expiredPassword)
        XCTAssertEqual(stage.heard.signedIn, 0)
        XCTAssertEqual(stage.model.backupCodes, [])

        // Left instead, nobody is reported: nobody is signed in.
        let left = try await settingUp()
        left.api.on(Wire.enrolConfirm, Wire.enrolled(Wire.expired))
        left.model.code = "123456"
        await left.model.confirmEnrolment()
        left.model.close()
        XCTAssertEqual(left.heard.signedIn, 0)
    }

    // MARK: A screen left in the middle of an enrolment

    func testAScreenLeftWhileTheSetupKeyWasOnItsWayHoldsNoKey() async throws {
        let stage = try await enrolling()
        let gate = Gate()
        stage.api.on(Wire.enrolStart) { _ in
            await gate.wait()
            return Wire.totpEnrolment
        }
        let asking = Task { await stage.model.startEnrolment() }
        await eventually("the key is asked for") { stage.api.count(Wire.enrolStart) == 1 }
        XCTAssertTrue(stage.model.isPending)
        // One action at a time.
        await stage.model.startEnrolment()
        XCTAssertEqual(stage.api.count(Wire.enrolStart), 1)
        stage.model.close()
        gate.open()
        await asking.value
        XCTAssertEqual(stage.model.screen, .signInStart)
        XCTAssertNil(stage.model.setup)
        XCTAssertFalse(stage.model.isPending)
        XCTAssertFalse(stage.everything.contains(Wire.setupKey))
    }

    func testAScreenLeftWhileTheConfirmationWasOnItsWayShowsNoCodesAndSignsNobodyIn() async throws {
        let stage = try await settingUp()
        let gate = Gate()
        stage.api.on(Wire.enrolConfirm) { _ in
            await gate.wait()
            return Wire.enrolled()
        }
        stage.model.code = "123456"
        let confirming = Task { await stage.model.confirmEnrolment() }
        await eventually("the code is on its way") { stage.api.count(Wire.enrolConfirm) == 1 }
        await stage.model.confirmEnrolment()
        XCTAssertEqual(stage.api.count(Wire.enrolConfirm), 1, "one action at a time")
        stage.model.close()
        gate.open()
        await confirming.value
        XCTAssertEqual(stage.model.screen, .signInStart)
        XCTAssertNil(stage.model.setup)
        XCTAssertEqual(stage.model.backupCodes, [])
        XCTAssertEqual(stage.heard.signedIn, 0, "a discarded attempt takes nothing from an answer")
        let signedIn = await stage.isSignedIn
        XCTAssertFalse(signedIn)
        XCTAssertFalse(stage.everything.contains("aaaaa"))
    }

    func testAnEnrolmentThatCompletedWhileItsScreenWasClosingIsReportedOnceAndItsCodesAreShownToNobody() async throws {
        // The answer was taken and the session is being stored when the screen closes: the
        // client is signed in whatever the screen does, so the app is told, once.
        for toAnotherFlow in [false, true] {
            let gate = Gate()
            let held = HeldStorage(gate)
            let stage = try await settingUp(storage: held)
            stage.api.on(Wire.enrolConfirm, Wire.enrolled())
            stage.model.code = "123456"
            let confirming = Task { await stage.model.confirmEnrolment() }
            await eventually("the session is being stored") { await held.writes == 1 }
            if toAnotherFlow {
                stage.model.showSignUp()
            } else {
                stage.model.close()
            }
            gate.open()
            await confirming.value
            let signedIn = await stage.isSignedIn
            XCTAssertTrue(signedIn)
            XCTAssertEqual(stage.model.screen, .signedIn)
            XCTAssertEqual(stage.heard.signedIn, 1)
            XCTAssertEqual(stage.model.backupCodes, [], "new ones are a button of the account screen")
            XCTAssertNil(stage.model.setup)
            XCTAssertFalse(stage.everything.contains("aaaaa"))
            stage.model.close()
            XCTAssertEqual(stage.heard.signedIn, 1)
        }
    }

    // MARK: A session that could not be stored

    func testASecondStepThatCompletedIsSignedInAlsoWhenItsSessionCouldNotBeStored() async throws {
        let sheet = ScriptedPasskeySheet()
        let rows: [(String, (any TulaTokenStorage) async throws -> Stage, @MainActor (TulaAuthModel) async -> Void)] = [
            ("an authenticator code", { try await self.second(storage: $0) }, { await $0.submitCode() }),
            (
                "a backup code",
                {
                    let stage = try await self.second(storage: $0)
                    stage.model.useSecondWay(.backupCode)
                    return stage
                }, { await $0.submitBackupCode() }
            ),
            ("a passkey", { try await self.passkeyStep(sheet, storage: $0) }, { await $0.useSecondPasskey() }),
        ]
        for (name, make, finish) in rows {
            let storage = RefusingStorage()
            let stage = try await make(storage)
            stage.api.on(Wire.secondFactorRoute, Wire.flow("sign_in", Wire.complete))
            stage.model.code = "123456"
            stage.model.backupCode = "abcde-fghjk"
            await finish(stage.model)
            let refused = await storage.refused
            XCTAssertEqual(refused, 1, name)
            XCTAssertEqual(stage.model.screen, .signedIn, name)
            XCTAssertEqual(stage.heard.signedIn, 1, name)
            XCTAssertEqual(stage.model.formError, stage.model.strings.sessionNotSaved, name)
            XCTAssertEqual([stage.model.code, stage.model.backupCode], ["", ""], name)
            XCTAssertFalse(stage.model.isPending, name)
        }
    }
}
