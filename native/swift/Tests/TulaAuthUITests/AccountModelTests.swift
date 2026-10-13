import Foundation
import TulaAuth
import XCTest

@testable import TulaAuthUI

// The account screen's model: what it reads, what each action does and says, where a refusal
// is shown, and that nothing secret is held past the form it was typed on. The step-up is in
// AccountStepUpTests.
@MainActor
final class AccountModelTests: XCTestCase {
    private func everythingOf(_ value: Any) -> String {
        var text = "\(value) \(String(describing: value)) \(String(reflecting: value))"
        dump(value, to: &text)
        print(value, to: &text)
        return text
    }

    private static let validation = "validation.failed"

    /// A 422 that names one field.
    private static func refused(_ field: String, _ code: String) -> Reply {
        Reply(
            status: 422,
            json:
                #"{"status":422,"code":"\#(validation)","detail":"\#(Canary.serverText)","errors":[{"field":"\#(field)","code":"\#(code)","message":"\#(Canary.serverText)"}]}"#
        )
    }

    /// A stage on the authenticator's setup form, the key on the screen.
    private func settingUp() async throws -> AccountStage {
        let stage = try await AccountStage.loaded()
        stage.api.on(Account.totpStart, Wire.totpEnrolment)
        await stage.model.perform(.setUpAuthenticator)
        XCTAssertEqual(stage.model.panel, .totpSetup)
        return stage
    }

    /// The same, with the backup codes on the screen.
    private func codesShown() async throws -> AccountStage {
        let stage = try await settingUp()
        stage.api.on(Account.totpConfirm, Account.codes)
        stage.api.on(Account.factors, Reply(json: Account.factors(totp: true, codes: 2)))
        stage.model.setText("123456", of: .code)
        await stage.model.perform(.confirmAuthenticator)
        XCTAssertEqual(stage.model.panel, .backupCodes)
        return stage
    }

    /// A stage whose phone number's code was asked for.
    private func phoneCodeAsked() async throws -> AccountStage {
        let stage = try await AccountStage.loaded(config: Account.config(phone: true))
        await stage.model.perform(.openPhone)
        XCTAssertEqual(stage.model.panel, .phoneNumber)
        stage.model.setText(Wire.number, of: .phoneNumber)
        stage.api.on(Account.phone, Account.sent("sms_code", to: Wire.masked))
        await stage.model.perform(.sendPhoneCode)
        XCTAssertEqual(stage.model.panel, .phoneCode(destination: Wire.masked))
        return stage
    }

    // MARK: Reading the account

    func testLoadReadsEveryPartAndWhatTheEnvironmentAllows() async throws {
        let stage = try await AccountStage.loaded(
            user: Account.user(phone: "+14155550142"), factors: Account.factors(totp: true, codes: 8),
            passkeys: Account.passkeys([Account.passkey()]), config: Account.config(mfa: "required", phone: true))
        let model = stage.model
        XCTAssertEqual(model.panel, .overview)
        XCTAssertEqual(model.user?.phoneNumber, "+14155550142")
        XCTAssertEqual(model.sessions?.map(\.id), ["ses_1", "ses_2"])
        XCTAssertEqual(model.factors?.totp.enabled, true)
        XCTAssertEqual(model.passkeys?.map(\.name), ["iPhone"])
        XCTAssertEqual(model.failed, [])
        XCTAssertTrue(model.mfaRequired)
        XCTAssertTrue(model.phoneEnabled)
        XCTAssertFalse(model.isPending)
        XCTAssertEqual(stage.heard.signedOut, 0)
        XCTAssertEqual(
            model.content.sections.map(\.identifier),
            [
                "tula.section.profile", "tula.section.password", "tula.section.sessions", "tula.section.mfa",
                "tula.section.phone", "tula.section.passkeys",
            ])
        // The facts are the model's, with whether the app gave the client a sheet.
        XCTAssertFalse(model.facts.passkeySheet)
        XCTAssertEqual(model.facts.user, model.user)
        XCTAssertEqual(model.facts.formatDate(Date(timeIntervalSince1970: 0)), "1970-01-01")
    }

    func testAnEnvironmentThatSaysNothingRequiresNothingAndAddsNoNumber() async throws {
        var stage = try await AccountStage.loaded(config: Wire.config(name: "Acme", signUpPassword: "required"))
        XCTAssertFalse(stage.model.mfaRequired)
        XCTAssertFalse(stage.model.phoneEnabled)
        // A configuration that could not be read changes nothing, and fails nothing.
        stage = try await AccountStage.loaded(config: Reply.error(503, "service.unavailable"))
        XCTAssertFalse(stage.model.mfaRequired)
        XCTAssertEqual(stage.model.failed, [])
        XCTAssertNil(stage.model.formError)
    }

    func testAPartThatCouldNotBeReadLeavesTheOthersAndIsReadAgain() async throws {
        let parts: [(TulaAccountPart, String, String)] = [
            (.user, Account.me, Account.user()), (.sessions, Account.sessions, Account.twoSessions),
            (.factors, Account.factors, Account.factors()), (.passkeys, Account.passkeys, Account.passkeys([])),
        ]
        for (part, route, answer) in parts {
            let stage = try await AccountStage.loaded(
                user: part == .user ? nil : Account.user(), sessions: part == .sessions ? nil : Account.twoSessions,
                factors: part == .factors ? nil : Account.factors(),
                passkeys: part == .passkeys ? nil : Account.passkeys([]))
            let model = stage.model
            XCTAssertEqual(model.failed, [part], "\(part)")
            XCTAssertEqual(model.user == nil, part == .user, "\(part)")
            XCTAssertEqual(model.sessions == nil, part == .sessions, "\(part)")
            XCTAssertEqual(model.factors == nil, part == .factors, "\(part)")
            XCTAssertEqual(model.passkeys == nil, part == .passkeys, "\(part)")
            XCTAssertFalse(stage.everything.contains(Canary.serverText), "\(part)")
            XCTAssertEqual(stage.heard.signedOut, 0, "\(part): a read that failed is not a session that ended")

            stage.api.on(route, Reply(json: answer))
            await model.perform(.reload)
            XCTAssertEqual(model.failed, [], "\(part)")
            XCTAssertFalse(model.content.actions.contains(.reload), "\(part)")
        }
    }

    func testWhatWasReadIsKeptWhenALaterReadOfItFails() async throws {
        let stage = try await AccountStage.loaded()
        stage.api.on(Account.sessions, Reply.error(500, "internal"))
        stage.api.on(Account.revokeOthers, Reply(json: #"{"revoked":1}"#))
        await stage.model.perform(.signOutOthers)
        XCTAssertEqual(stage.model.failed, [.sessions])
        XCTAssertEqual(stage.model.sessions?.count, 2, "the list is the last one that was read")
        XCTAssertEqual(stage.model.status, "Signed out of 1 other device.")
    }

    // MARK: Sessions

    func testSigningOutOfEveryOtherDeviceSaysHowManyAndReadsTheSessionsAgain() async throws {
        let stage = try await AccountStage.loaded()
        let userReads = stage.api.count(Account.me)
        stage.api.on(Account.revokeOthers, Reply(json: #"{"revoked":2}"#))
        stage.api.on(Account.sessions, Reply(json: Account.sessions([Account.session("ses_1", current: true)])))
        await stage.model.perform(.signOutOthers)
        XCTAssertEqual(stage.model.status, "Signed out of 2 other devices.")
        XCTAssertEqual(stage.heard.said, ["Signed out of 2 other devices."])
        XCTAssertEqual(stage.model.sessions?.map(\.id), ["ses_1"])
        XCTAssertEqual(stage.api.count(Account.sessions), 2)
        XCTAssertEqual(stage.api.count(Account.me), userReads, "only what changed is read again")
        XCTAssertFalse(stage.model.content.actions.contains(.signOutOthers), "nothing is left to sign out of")
        XCTAssertEqual(stage.heard.signedOut, 0)
    }

    func testSigningOutOneOtherDevice() async throws {
        let stage = try await AccountStage.loaded()
        stage.api.on(Account.revoke("ses_2"), Account.none)
        stage.api.on(Account.sessions, Reply(json: Account.sessions([Account.session("ses_1", current: true)])))
        await stage.model.perform(.signOutSession("ses_2"))
        XCTAssertEqual(stage.model.status, "That device was signed out.")
        XCTAssertEqual(stage.api.count(Account.revoke("ses_2")), 1)
        XCTAssertEqual(stage.model.sessions?.count, 1)
        let signedIn = await stage.isSignedIn
        XCTAssertTrue(signedIn)

        // This device's own session is not a row's to end, also when asked for directly.
        await stage.model.signOutSession("ses_1")
        await stage.model.signOutSession("ses_9")
        XCTAssertEqual(stage.api.count(Account.revoke("ses_1")), 0)
        XCTAssertEqual(stage.api.count(Account.revoke("ses_9")), 0)
    }

    // MARK: The password

    func testChangingThePassword() async throws {
        let stage = try await AccountStage.loaded()
        let model = stage.model
        await model.perform(.openChangePassword)
        XCTAssertEqual(model.panel, .changePassword)
        XCTAssertEqual(model.focus, .title)
        model.setText(Canary.password, of: .currentPassword)
        model.setText("New-Password-CANARY-2!", of: .newPassword)
        model.toggleReveal(.currentPassword)
        model.toggleReveal(.newPassword)
        stage.api.on(Account.password, Account.none)
        await model.perform(.submitPassword)

        XCTAssertEqual(model.panel, .overview)
        XCTAssertEqual(model.status, "Your password was changed. Your other devices were signed out.")
        XCTAssertEqual(stage.api.body(Account.password)["currentPassword"] as? String, Canary.password)
        XCTAssertEqual(stage.api.body(Account.password)["newPassword"] as? String, "New-Password-CANARY-2!")
        XCTAssertEqual(stage.api.count(Account.sessions), 2, "the other devices were signed out: read again")
        stage.assertNothingSecretIsHeld("after the change")
        XCTAssertFalse(stage.everything.contains("CANARY"))
    }

    func testAnAccountWithoutAPasswordHasNoFormToChangeIt() async throws {
        let stage = try await AccountStage.loaded(user: Account.user(hasPassword: false))
        XCTAssertFalse(stage.model.content.actions.contains(.openChangePassword))
        stage.model.openChangePassword()
        XCTAssertEqual(stage.model.panel, .overview)
        await stage.model.submitPassword()
        XCTAssertEqual(stage.api.count(Account.password), 0)
    }

    func testAWrongCurrentPasswordIsSaidAtItsFieldAndTheNewOneIsKept() async throws {
        let stage = try await AccountStage.loaded()
        let model = stage.model
        await model.perform(.openChangePassword)
        model.setText(Canary.password, of: .currentPassword)
        model.setText("the-new-one-12", of: .newPassword)
        model.toggleReveal(.currentPassword)
        stage.api.on(Account.password, Reply.error(401, "auth.invalid_credentials"))
        await model.perform(.submitPassword)

        XCTAssertEqual(model.panel, .changePassword)
        XCTAssertEqual(model.fieldErrors, [.currentPassword: ["That is not your current password."]])
        XCTAssertNil(model.formError)
        XCTAssertEqual(model.currentPassword, "", "a refused secret is typed again")
        XCTAssertFalse(model.isRevealed(.currentPassword))
        XCTAssertEqual(model.newPassword, "the-new-one-12", "the one being chosen is kept")
        XCTAssertEqual(model.focus, .field(.currentPassword))
        XCTAssertEqual(stage.heard.said.last, "That is not your current password.")
        XCTAssertFalse(stage.everything.contains(Canary.serverText))
        XCTAssertFalse(stage.everything.contains("email or password"), "never the sentence about an address")
        XCTAssertEqual(stage.heard.signedOut, 0)
        let signedIn = await stage.isSignedIn
        XCTAssertTrue(signedIn)
    }

    func testARefusedNewPasswordStaysToBeCorrected() async throws {
        let stage = try await AccountStage.loaded()
        let model = stage.model
        await model.perform(.openChangePassword)
        model.setText(Canary.password, of: .currentPassword)
        model.setText("short", of: .newPassword)
        stage.api.on(Account.password, AccountModelTests.refused("newPassword", "password.too_short"))
        await model.perform(.submitPassword)

        XCTAssertEqual(model.panel, .changePassword)
        XCTAssertEqual(model.fieldErrors, [.newPassword: ["Password is too short."]])
        XCTAssertEqual(model.newPassword, "short")
        XCTAssertEqual(model.currentPassword, "", "the current one was sent, and is not kept")
        XCTAssertEqual(model.focus, .field(.newPassword))
        XCTAssertFalse(stage.everything.contains(Canary.serverText))

        // A refusal by its code alone lands on the same field: the history's, for one.
        model.setText(Canary.password, of: .currentPassword)
        stage.api.on(Account.password, Reply.error(422, "password.reused"))
        await model.perform(.submitPassword)
        XCTAssertEqual(
            model.fieldErrors, [.newPassword: ["You have used this password recently. Choose a different one."]])
        XCTAssertEqual(model.newPassword, "short")
    }

    func testAFormIsNotSentWithAFieldMissing() async throws {
        let stage = try await AccountStage.loaded(config: Account.config(phone: true))
        let model = stage.model
        await model.perform(.openChangePassword)
        await model.perform(.submitPassword)
        XCTAssertEqual(
            model.fieldErrors,
            [.currentPassword: ["This field is required."], .newPassword: ["This field is required."]])
        XCTAssertEqual(model.focus, .field(.currentPassword))
        model.setText("x", of: .currentPassword)
        await model.perform(.submitPassword)
        XCTAssertEqual(model.fieldErrors, [.newPassword: ["This field is required."]])
        XCTAssertEqual(model.currentPassword, "x", "nothing was sent, so nothing was emptied")
        XCTAssertEqual(stage.api.count(Account.password), 0)

        model.cancel()
        await model.perform(.openPhone)
        model.setText("   ", of: .phoneNumber)
        await model.perform(.sendPhoneCode)
        XCTAssertEqual(model.fieldErrors, [.phoneNumber: ["This field is required."]])
        XCTAssertEqual(stage.api.count(Account.phone), 0)
        XCTAssertEqual(stage.heard.said.last, "This field is required.")
    }

    func testARateLimitSaysHowLongToWait() async throws {
        let stage = try await AccountStage.loaded()
        let model = stage.model
        await model.perform(.openChangePassword)
        model.setText("a", of: .currentPassword)
        model.setText("b", of: .newPassword)
        stage.api.on(Account.password, Reply.error(429, "rate_limited", headers: ["Retry-After": "42"]))
        await model.perform(.submitPassword)
        XCTAssertEqual(model.formError, "Too many requests. Try again shortly. Try again in 42s.")
        XCTAssertEqual(model.fieldErrors, [:])
        XCTAssertEqual(model.newPassword, "b")
        XCTAssertEqual(stage.heard.said.last, model.formError)

        stage.api.on(Account.revokeOthers, Reply.error(429, "rate_limited", headers: ["Retry-After": "252"]))
        model.cancel()
        await model.perform(.signOutOthers)
        XCTAssertEqual(model.formError, "Too many requests. Try again shortly. Try again in 4m 12s.")
        XCTAssertNil(model.status)
    }

    func testACodeTheServerDoesNotKnowIsSaidWithTheTablesFallback() async throws {
        let stage = try await AccountStage.loaded()
        stage.api.on(Account.revokeOthers, Reply.error(418, "teapot.of_tomorrow"))
        await stage.model.perform(.signOutOthers)
        XCTAssertEqual(stage.model.formError, "Something went wrong. Try again.")
        XCTAssertFalse(stage.everything.contains(Canary.serverText))
    }

    // MARK: Two-step verification

    func testTurningOnAnAuthenticatorApp() async throws {
        let stage = try await settingUp()
        let model = stage.model
        XCTAssertEqual(model.setup, TulaAuthSetup(key: Wire.setupKey, uri: Wire.setupAddress))
        XCTAssertEqual(model.content.setup?.key, Wire.setupKey)
        XCTAssertEqual(stage.heard.copied, [], "nothing is copied by arriving")

        await model.perform(.copySetupKey)
        XCTAssertEqual(stage.heard.copied, [Wire.setupKey])
        XCTAssertEqual(model.status, "Copied.")

        // A code that is not whole is not sent.
        model.setText("12 34", of: .code)
        await model.perform(.confirmAuthenticator)
        XCTAssertEqual(model.fieldErrors, [.code: ["Enter the 6-digit code."]])
        XCTAssertEqual(stage.api.count(Account.totpConfirm), 0)
        XCTAssertNotNil(model.setup, "the key is still on the screen")

        stage.api.on(Account.totpConfirm, Account.codes)
        stage.api.on(Account.factors, Reply(json: Account.factors(totp: true, codes: 2)))
        model.setText("123 456", of: .code)
        await model.perform(.confirmAuthenticator)
        XCTAssertEqual(model.panel, .backupCodes)
        XCTAssertEqual(stage.api.body(Account.totpConfirm)["code"] as? String, "123456")
        XCTAssertEqual(model.backupCodes, Wire.backupCodes)
        XCTAssertNil(model.setup, "the key went with its form")
        XCTAssertEqual(model.code, "")
        XCTAssertEqual(model.factors?.totp.enabled, true, "the second step was read again")
        XCTAssertNil(model.status, "what is said waits for the codes to be saved")

        // The codes are left only by saying they are saved.
        model.cancel()
        XCTAssertEqual(model.panel, .backupCodes)
        XCTAssertEqual(model.backupCodes, Wire.backupCodes)

        await model.perform(.copyBackupCodes)
        XCTAssertEqual(stage.heard.copied, [Wire.setupKey, "aaaaa-bbbbb\nccccc-ddddd"])
        XCTAssertEqual(model.status, "Copied.")

        await model.perform(.savedBackupCodes)
        XCTAssertEqual(model.panel, .overview)
        XCTAssertEqual(model.status, "Two-step verification is on.")
        stage.assertNothingSecretIsHeld("after the codes were saved")
        XCTAssertEqual(stage.heard.copied.count, 2)
    }

    func testAWrongCodeOfTheSetupIsSaidAtItsFieldAndTheKeyStays() async throws {
        let stage = try await settingUp()
        let model = stage.model
        let refusals = [
            (Reply.error(422, "mfa.invalid_code"), "That code is incorrect."),
            (Reply.error(410, "mfa.enrolment_expired"), "This setup has expired. Start again."),
        ]
        for (reply, words) in refusals {
            stage.api.on(Account.totpConfirm, reply)
            model.setText("654321", of: .code)
            await model.perform(.confirmAuthenticator)
            XCTAssertEqual(model.panel, .totpSetup, words)
            XCTAssertEqual(model.fieldErrors, [.code: [words]])
            XCTAssertNil(model.formError, words)
            XCTAssertEqual(model.code, "", words)
            XCTAssertEqual(model.focus, .field(.code), words)
            XCTAssertEqual(stage.heard.said.last, words)
            XCTAssertNotNil(model.setup, words)
            XCTAssertFalse(stage.everything.contains(Canary.serverText), words)
        }
        // A refusal that names the field is shown at it too, never in the server's words.
        stage.api.on(Account.totpConfirm, AccountModelTests.refused("code", AccountModelTests.validation))
        model.setText("654321", of: .code)
        await model.perform(.confirmAuthenticator)
        XCTAssertEqual(model.fieldErrors[.code]?.count, 1)
        XCTAssertEqual(model.code, "")
        XCTAssertFalse(stage.everything.contains(Canary.serverText))
    }

    func testNewBackupCodesReplaceTheEarlierOnes() async throws {
        let stage = try await AccountStage.loaded(factors: Account.factors(totp: true, codes: 1))
        let model = stage.model
        stage.api.on(Account.backupCodes, Account.codes)
        await model.perform(.newBackupCodes)
        XCTAssertEqual(model.panel, .backupCodes)
        XCTAssertEqual(model.backupCodes, Wire.backupCodes)
        XCTAssertEqual(stage.api.count(Account.factors), 2)
        await model.perform(.savedBackupCodes)
        XCTAssertEqual(model.status, "Your earlier backup codes no longer work.")
        XCTAssertEqual(model.backupCodes, [])

        // Neither is on the screen of a user without an authenticator app.
        let without = try await AccountStage.loaded()
        await without.model.newBackupCodes()
        XCTAssertEqual(without.api.count(Account.backupCodes), 0)
        without.model.savedBackupCodes()
        without.model.copyBackupCodes()
        without.model.copySetupKey()
        XCTAssertEqual(without.heard.copied, [])
        XCTAssertNil(without.model.status)
    }

    func testTurningTheAuthenticatorOffAsksFirst() async throws {
        let stage = try await AccountStage.loaded(factors: Account.factors(totp: true, codes: 8))
        let model = stage.model
        await model.perform(.ask(.turnOffAuthenticator))
        XCTAssertEqual(model.panel, .confirm(.turnOffAuthenticator))
        XCTAssertEqual(stage.api.count(Account.totpOff), 0, "asking sends nothing")

        await model.perform(.cancel)
        XCTAssertEqual(model.panel, .overview)
        XCTAssertEqual(model.notice, "Nothing was changed.")
        XCTAssertNil(model.status)
        XCTAssertNil(model.formError)
        XCTAssertEqual(stage.api.count(Account.totpOff), 0)

        await model.perform(.ask(.turnOffAuthenticator))
        XCTAssertNil(model.notice, "a notice goes with the panel it was said on")
        stage.api.on(Account.totpOff, Account.none)
        stage.api.on(Account.factors, Reply(json: Account.factors()))
        await model.perform(.confirm)
        XCTAssertEqual(model.panel, .overview)
        XCTAssertEqual(model.status, "Two-step verification is off.")
        XCTAssertEqual(model.factors?.totp.enabled, false)
        XCTAssertEqual(stage.api.count(Account.totpOff), 1)
    }

    func testARefusedQuestionStaysOpenAndSaysWhy() async throws {
        let stage = try await AccountStage.loaded(passkeys: Account.passkeys([Account.passkey()]))
        let model = stage.model
        await model.perform(.ask(.removePasskey(id: "pk_1", name: "iPhone")))
        stage.api.on(Account.passkeyRemove("pk_1"), Reply.error(409, "passkey.last_sign_in_method"))
        await model.perform(.confirm)
        XCTAssertEqual(model.panel, .confirm(.removePasskey(id: "pk_1", name: "iPhone")))
        XCTAssertEqual(
            model.formError, "This is your only way to sign in. Add a password or connect an account first.")
        XCTAssertEqual(model.passkeys?.count, 1)
    }

    func testATextedCodeAsTheSecondStep() async throws {
        let offered = Account.factors(sms: Account.sms(enabled: false, inUse: false, available: true))
        let stage = try await AccountStage.loaded(user: Account.user(phone: "+14155550142"), factors: offered)
        let model = stage.model
        stage.api.on(Account.smsStart, Account.sent("sms_code", to: Wire.masked))
        await model.perform(.turnOnTexted)
        XCTAssertEqual(model.panel, .textedFactor(destination: Wire.masked))

        stage.api.on(Account.smsConfirm, Reply.error(422, "mfa.invalid_code"))
        model.setText("111111", of: .code)
        await model.perform(.confirmTexted)
        XCTAssertEqual(model.panel, .textedFactor(destination: Wire.masked))
        XCTAssertEqual(model.fieldErrors, [.code: ["That code is incorrect."]])
        XCTAssertEqual(model.code, "")

        let on = Account.factors(sms: Account.sms(enabled: true, inUse: true, available: true))
        stage.api.on(Account.smsConfirm, Reply(json: on))
        model.setText("123456", of: .code)
        await model.perform(.confirmTexted)
        XCTAssertEqual(model.panel, .overview)
        XCTAssertEqual(model.status, "A code by text message is now your second step.")
        XCTAssertEqual(model.factors?.sms?.enabled, true, "the answer is the second step as it is now")
        XCTAssertEqual(stage.api.count(Account.factors), 1, "and is not asked for again")
        XCTAssertFalse(model.content.actions.contains(.turnOnTexted))

        await model.perform(.ask(.turnOffTexted))
        stage.api.on(Account.smsOff, Account.none)
        stage.api.on(Account.factors, Reply(json: offered))
        await model.perform(.confirm)
        XCTAssertEqual(model.status, "Text messages are no longer your second step.")
        XCTAssertEqual(model.factors?.sms?.enabled, false)
    }

    func testATextedCodeIsNotAskedForWhereTheServerDoesNotOfferIt() async throws {
        let stage = try await AccountStage.loaded(
            factors: Account.factors(sms: Account.sms(enabled: false, inUse: false, available: false)))
        await stage.model.turnOnTexted()
        await stage.model.confirmTexted()
        XCTAssertEqual(stage.api.count(Account.smsStart), 0)
        XCTAssertEqual(stage.model.panel, .overview)

        // An answer that is no receipt of a texted code is not shown as one.
        let offered = try await AccountStage.loaded(
            factors: Account.factors(sms: Account.sms(enabled: false, inUse: false, available: true)))
        offered.api.on(Account.smsStart, Account.sent("email_code", to: Wire.masked))
        await offered.model.perform(.turnOnTexted)
        XCTAssertEqual(offered.model.panel, .overview)
        XCTAssertNotNil(offered.model.formError)
    }

    // MARK: The phone number

    func testAddingAPhoneNumber() async throws {
        let stage = try await phoneCodeAsked()
        let model = stage.model
        let userReads = stage.api.count(Account.me)
        XCTAssertEqual(stage.api.body(Account.phone)["phoneNumber"] as? String, Wire.number)
        XCTAssertEqual(model.phoneNumber, Wire.number, "kept: sending again needs it")

        await model.perform(.sendPhoneCode)
        XCTAssertEqual(model.panel, .phoneCode(destination: Wire.masked))
        XCTAssertEqual(model.status, "A new code is on its way.")
        XCTAssertEqual(stage.api.count(Account.phone), 2)

        model.setText("111111", of: .code)
        await model.perform(.differentNumber)
        XCTAssertEqual(model.panel, .phoneNumber)
        XCTAssertEqual(model.phoneNumber, Wire.number)
        XCTAssertEqual(model.code, "")
        await model.perform(.sendPhoneCode)
        XCTAssertEqual(model.panel, .phoneCode(destination: Wire.masked))

        stage.api.on(Account.phoneVerify, Reply(json: Account.user(phone: "+14155550142")))
        model.setText("123456", of: .code)
        await model.perform(.verifyPhone)
        XCTAssertEqual(model.panel, .overview)
        XCTAssertEqual(model.status, "Your phone number was added.")
        XCTAssertEqual(model.user?.phoneNumber, "+14155550142")
        XCTAssertEqual(model.phoneNumber, "", "the field is emptied once the account is shown again")
        XCTAssertEqual(stage.api.count(Account.factors), 2, "a proven number changes what the second step can be")
        XCTAssertEqual(stage.api.count(Account.me), userReads, "the answer is the user: it is not read again")
    }

    func testAWrongOrExpiredPhoneCodeAndANumberThatIsNotOne() async throws {
        let stage = try await phoneCodeAsked()
        let model = stage.model
        for (reply, words) in [
            (Reply.error(422, "verification.invalid_code"), "That code is incorrect."),
            (Reply.error(410, "verification.expired"), "That code has expired. Request a new one."),
        ] {
            stage.api.on(Account.phoneVerify, reply)
            model.setText("111111", of: .code)
            await model.perform(.verifyPhone)
            XCTAssertEqual(model.panel, .phoneCode(destination: Wire.masked))
            XCTAssertEqual(model.fieldErrors, [.code: [words]])
            XCTAssertEqual(model.code, "")
            XCTAssertEqual(model.focus, .field(.code))
            XCTAssertNil(model.user?.phoneNumber)
        }
        model.setText("12", of: .code)
        await model.perform(.verifyPhone)
        XCTAssertEqual(model.fieldErrors, [.code: ["Enter the 6-digit code."]])
        XCTAssertEqual(stage.api.count(Account.phoneVerify), 2)

        await model.perform(.differentNumber)
        model.setText("12345", of: .phoneNumber)
        stage.api.on(Account.phone, AccountModelTests.refused("phoneNumber", "phone.invalid"))
        await model.perform(.sendPhoneCode)
        XCTAssertEqual(model.panel, .phoneNumber)
        XCTAssertEqual(
            model.fieldErrors, [.phoneNumber: ["Enter a phone number with its country code, such as +14155550100."]])
        XCTAssertEqual(model.phoneNumber, "12345", "a number is not a secret: kept, to be put right")
        stage.api.on(Account.phone, Reply.error(422, "phone.invalid"))
        await model.perform(.sendPhoneCode)
        XCTAssertNotNil(model.fieldErrors[.phoneNumber])
        stage.api.on(Account.phone, Reply.error(403, "sms.disabled"))
        await model.perform(.sendPhoneCode)
        XCTAssertEqual(model.formError, "Text messages are not available.")
    }

    func testRemovingThePhoneNumberAsksFirstAndReadsTheUserAgain() async throws {
        let stage = try await AccountStage.loaded(user: Account.user(phone: "+14155550142"))
        let model = stage.model
        XCTAssertFalse(model.content.actions.contains(.openPhone), "text messages are off: a number is not added")
        model.openPhone()
        XCTAssertEqual(model.panel, .overview)
        await model.sendPhoneCode()
        await model.verifyPhone()
        model.differentNumber()
        XCTAssertEqual(stage.api.count(Account.phone), 0)

        await model.perform(.ask(.removePhone))
        let userReads = stage.api.count(Account.me)
        stage.api.on(Account.phoneRemove, Account.none)
        stage.api.on(Account.me, Reply(json: Account.user()))
        await model.perform(.confirm)
        XCTAssertEqual(model.panel, .overview)
        XCTAssertEqual(model.status, "Your phone number was removed.")
        XCTAssertNil(model.user?.phoneNumber)
        XCTAssertEqual(stage.api.count(Account.me), userReads + 1)
        XCTAssertEqual(stage.api.count(Account.factors), 2)
    }

    // MARK: Passkeys

    private func withSheet(passkeys: [String] = []) async throws -> (AccountStage, ScriptedPasskeySheet) {
        let sheet = ScriptedPasskeySheet()
        let stage = try await AccountStage.loaded(sheet: sheet, passkeys: Account.passkeys(passkeys))
        stage.api.on(Account.passkeyOptions, Reply(json: Account.creationOptions))
        return (stage, sheet)
    }

    func testAddingAPasskeyThroughTheSheet() async throws {
        let (stage, sheet) = try await withSheet()
        XCTAssertTrue(stage.model.facts.passkeySheet)
        stage.api.on(Account.passkeyAdd, Reply(status: 201, json: Account.passkey()))
        stage.api.on(Account.passkeys, Reply(json: Account.passkeys([Account.passkey()])))
        await stage.model.perform(.addPasskey)
        XCTAssertEqual(sheet.created, 1)
        XCTAssertEqual(stage.model.status, "Your passkey was added.")
        XCTAssertNil(stage.model.notice)
        XCTAssertEqual(stage.model.passkeys?.map(\.id), ["pk_1"])
        XCTAssertEqual(stage.api.count(Account.passkeys), 2)
        XCTAssertEqual(stage.api.count(Account.factors), 2, "a passkey can take the second step over")
        XCTAssertFalse(stage.everything.contains("CANARY"))
    }

    func testAClosedSheetIsSaidQuietlyAndChangesNothing() async throws {
        let (stage, sheet) = try await withSheet()
        sheet.make(.failure(TulaSheetError.dismissed))
        await stage.model.perform(.addPasskey)
        XCTAssertEqual(sheet.created, 1)
        XCTAssertEqual(stage.model.notice, "The passkey request was cancelled. Nothing was changed; you can try again.")
        XCTAssertNil(stage.model.formError, "a closed sheet is not an error")
        XCTAssertNil(stage.model.status)
        XCTAssertEqual(stage.model.fieldErrors, [:])
        XCTAssertEqual(stage.api.count(Account.passkeyAdd), 0)
        XCTAssertEqual(stage.api.count(Account.passkeys), 1, "nothing changed, so nothing is read again")
        XCTAssertFalse(stage.model.isPending)
        XCTAssertTrue(stage.model.content.actions.contains(.addPasskey), "and the button works again")
    }

    func testASheetThatFailsIsSaidInTheTablesWordsAndNeverItsOwn() async throws {
        let (stage, sheet) = try await withSheet()
        sheet.make(.failure(LoudSheetFailure()))
        await stage.model.perform(.addPasskey)
        XCTAssertNotNil(stage.model.formError)
        XCTAssertNil(stage.model.notice)
        XCTAssertFalse(stage.everything.contains(LoudSheetFailure.text))
        XCTAssertEqual(stage.api.count(Account.passkeyAdd), 0)
        XCTAssertEqual(stage.model.panel, .overview)
    }

    func testAnotherSheetStillOutIsSaidQuietly() async throws {
        let (stage, sheet) = try await withSheet()
        let gate = Gate()
        sheet.hold(gate)
        let passkeys = stage.client.passkeys
        let first = Task { _ = try? await passkeys.add() }
        await eventually("the first sheet is out") { sheet.created == 1 }

        await stage.model.perform(.addPasskey)
        XCTAssertEqual(stage.model.notice, "Another sign-in window is still open. Finish or close it first.")
        XCTAssertNil(stage.model.formError)
        XCTAssertEqual(sheet.created, 1, "a second sheet was not shown")
        XCTAssertFalse(stage.model.isPending)

        sheet.make(.failure(TulaSheetError.dismissed))
        gate.open()
        await first.value
    }

    func testWithoutASheetOrWithTheSecondStepUnreadNoPasskeyIsAdded() async throws {
        let none = try await AccountStage.loaded()
        XCTAssertFalse(none.model.content.actions.contains(.addPasskey))
        await none.model.addPasskey()
        XCTAssertEqual(none.api.count(Account.passkeyOptions), 0)

        let unread = try await AccountStage.loaded(sheet: ScriptedPasskeySheet(), factors: nil)
        XCTAssertFalse(unread.model.content.actions.contains(.addPasskey))
        await unread.model.addPasskey()
        XCTAssertEqual(unread.api.count(Account.passkeyOptions), 0)
    }

    func testRenamingAPasskey() async throws {
        let stage = try await AccountStage.loaded(passkeys: Account.passkeys([Account.passkey()]))
        let model = stage.model
        await model.perform(.openRename("pk_1"))
        XCTAssertEqual(model.panel, .renamePasskey(id: "pk_1"))
        XCTAssertEqual(model.name, "iPhone", "the form holds the name the passkey has")

        model.setText("  ", of: .name)
        await model.perform(.saveName)
        XCTAssertEqual(model.fieldErrors, [.name: ["This field is required."]])
        XCTAssertEqual(stage.api.count(Account.passkeyRename("pk_1")), 0)

        model.setText(" Work phone ", of: .name)
        stage.api.on(Account.passkeyRename("pk_1"), AccountModelTests.refused("name", AccountModelTests.validation))
        await model.perform(.saveName)
        XCTAssertEqual(model.panel, .renamePasskey(id: "pk_1"))
        XCTAssertNotNil(model.fieldErrors[.name])
        XCTAssertEqual(model.name, " Work phone ", "a name is not a secret: kept")

        stage.api.on(Account.passkeyRename("pk_1"), Reply(json: Account.passkey(name: "Work phone")))
        stage.api.on(Account.passkeys, Reply(json: Account.passkeys([Account.passkey(name: "Work phone")])))
        await model.perform(.saveName)
        XCTAssertEqual(stage.api.body(Account.passkeyRename("pk_1"), 1)["name"] as? String, "Work phone")
        XCTAssertEqual(model.panel, .overview)
        XCTAssertEqual(model.status, "The passkey was renamed.")
        XCTAssertEqual(model.passkeys?.first?.name, "Work phone")
        XCTAssertEqual(model.name, "")

        model.openRename("pk_9")
        XCTAssertEqual(model.panel, .overview, "a passkey the account does not have has no form")
        await model.saveName()
        XCTAssertEqual(stage.api.count(Account.passkeyRename("pk_1")), 2)
    }

    func testRemovingAPasskeyAsksFirstAndNamesIt() async throws {
        let stage = try await AccountStage.loaded(passkeys: Account.passkeys([Account.passkey()]))
        let model = stage.model
        let question = TulaAccountConfirmation.removePasskey(id: "pk_1", name: "iPhone")
        await model.perform(.ask(question))
        XCTAssertEqual(model.panel, .confirm(question))
        XCTAssertEqual(model.content.subtitle, "Remove “iPhone”? You will no longer be able to sign in with it.")
        stage.api.on(Account.passkeyRemove("pk_1"), Account.none)
        stage.api.on(Account.passkeys, Reply(json: Account.passkeys([])))
        await model.perform(.confirm)
        XCTAssertEqual(model.panel, .overview)
        XCTAssertEqual(model.status, "The passkey was removed.")
        XCTAssertEqual(model.passkeys, [])
        XCTAssertEqual(stage.api.count(Account.factors), 2)

        await model.confirm()
        XCTAssertEqual(stage.api.count(Account.passkeyRemove("pk_1")), 1, "there is no question open")
    }

    // MARK: Signing out

    func testSigningOutTellsTheAppOnce() async throws {
        let stage = try await AccountStage.loaded()
        stage.api.on(Account.signOut, Account.none)
        await stage.model.perform(.openChangePassword)
        stage.model.setText(Canary.password, of: .currentPassword)
        await stage.model.signOut()
        XCTAssertEqual(stage.heard.signedOut, 1)
        XCTAssertEqual(stage.api.count(Account.signOut), 1)
        XCTAssertFalse(stage.model.signOutFailed)
        XCTAssertFalse(stage.model.isPending)
        XCTAssertEqual(stage.model.panel, .overview)
        stage.assertNothingSecretIsHeld("after a sign-out")
        let signedIn = await stage.isSignedIn
        XCTAssertFalse(signedIn)
    }

    func testASignOutTheServerCouldNotBeToldOfIsNotOne() async throws {
        let stage = try await AccountStage.loaded()
        let model = stage.model
        stage.api.on(Account.signOut, Reply.error(503, "service.unavailable"))
        await model.perform(.signOut)

        XCTAssertTrue(model.signOutFailed)
        XCTAssertEqual(stage.heard.signedOut, 0, "the app is not told of a sign-out that failed")
        XCTAssertEqual(model.panel, .overview)
        XCTAssertEqual(
            model.formError,
            "We could not confirm the sign-out, so you may still be signed in on this device. Try again.")
        XCTAssertEqual(model.formError, TulaStrings.english.account.signOutFailed)
        XCTAssertEqual(stage.heard.said.last, model.formError)
        XCTAssertFalse(model.isPending)
        XCTAssertEqual(model.content.actions, [.signOut], "what is left to do here is to tell the server")
        XCTAssertEqual(model.content.sections, [])
        XCTAssertFalse(stage.everything.contains(Canary.serverText))

        // The client has dropped its session, so nothing can be read: reading says nothing
        // new, and above all does not report a sign-out.
        await model.load()
        XCTAssertEqual(stage.heard.signedOut, 0)
        XCTAssertTrue(model.signOutFailed)
        XCTAssertEqual(model.content.actions, [.signOut])
        await model.perform(.reload)
        await model.perform(.signOutOthers)
        XCTAssertEqual(stage.heard.signedOut, 0)

        stage.api.on(Account.signOut, Account.none)
        await model.perform(.signOut)
        XCTAssertEqual(stage.heard.signedOut, 1)
        XCTAssertFalse(model.signOutFailed)
        XCTAssertNil(model.formError)
        XCTAssertEqual(stage.api.count(Account.signOut), 2, "the second try told the server")
    }

    func testASessionThatEndedElsewhereTellsTheAppOnce() async throws {
        // Found by an action: the server refuses the token, and the refresh too.
        var stage = try await AccountStage.loaded()
        stage.api.on(Account.revokeOthers, Reply.error(401, "session.revoked"))
        stage.api.on(Account.refresh, Reply.error(401, "session.revoked"))
        await stage.model.perform(.openChangePassword)
        stage.model.cancel()
        await stage.model.perform(.signOutOthers)
        XCTAssertEqual(stage.heard.signedOut, 1)
        XCTAssertEqual(stage.model.panel, .overview)
        XCTAssertFalse(stage.model.isPending)
        XCTAssertFalse(stage.model.signOutFailed)
        var signedIn = await stage.isSignedIn
        XCTAssertFalse(signedIn)
        XCTAssertFalse(stage.everything.contains(Canary.serverText))

        // Found by reading the account.
        stage = try await AccountStage.loaded()
        stage.api.on(Account.refresh, Reply.error(401, "session.expired"))
        stage.api.on(Account.me, Reply.error(401, "session.expired"))
        await stage.model.load()
        XCTAssertEqual(stage.heard.signedOut, 1)
        signedIn = await stage.isSignedIn
        XCTAssertFalse(signedIn)

        // Read again, by the app or by "Try again": the same ended session, told once.
        await stage.model.load()
        await stage.model.perform(.reload)
        XCTAssertEqual(stage.heard.signedOut, 1, "an ended session is reported once")

        // Somebody signs in again and that session ends too: that is another one.
        stage.api.on(Wire.signIns, Wire.flow("sign_in", Wire.complete, start: true))
        _ = try await stage.client.startSignIn(identifier: "maya@example.com")
        signedIn = await stage.isSignedIn
        XCTAssertTrue(signedIn)
        stage.api.on(Account.me, Reply(json: Account.user()))
        await stage.model.load()
        XCTAssertEqual(stage.heard.signedOut, 1)
        stage.api.on(Account.me, Reply.error(401, "session.expired"))
        await stage.model.load()
        await stage.model.load()
        XCTAssertEqual(stage.heard.signedOut, 2)
    }

    func testASignOutOfThisScreenIsNotReportedAgainByALaterRead() async throws {
        let stage = try await AccountStage.loaded()
        stage.api.on(Account.signOut, Account.none)
        await stage.model.perform(.signOut)
        XCTAssertEqual(stage.heard.signedOut, 1)
        // A view that is still there reads once more: nobody is signed in, as was said.
        await stage.model.load()
        XCTAssertEqual(stage.heard.signedOut, 1)
    }

    // MARK: Nothing secret outlives its panel

    func testEveryChangeOfPanelEmptiesWhatTheOneBeforeHeld() async throws {
        let stage = try await AccountStage.loaded(
            user: Account.user(phone: "+14155550142"),
            factors: Account.factors(sms: Account.sms(enabled: false, inUse: false, available: true)),
            passkeys: Account.passkeys([Account.passkey()]), config: Account.config(phone: true))
        let model = stage.model
        func fill() {
            for field in model.panel.fields {
                model.setText(field == .code ? "123456" : "TYPED-CANARY", of: field)
                model.toggleReveal(field)
            }
        }

        await model.perform(.openChangePassword)
        fill()
        XCTAssertEqual(model.revealed, [.currentPassword, .newPassword])
        model.cancel()
        stage.assertNothingSecretIsHeld("after the password form was cancelled")

        stage.api.on(Account.totpStart, Wire.totpEnrolment)
        await model.perform(.setUpAuthenticator)
        fill()
        XCTAssertNotNil(model.setup)
        model.cancel()
        stage.assertNothingSecretIsHeld("after the setup was cancelled")
        XCTAssertNil(model.content.setup)

        stage.api.on(Account.smsStart, Account.sent("sms_code", to: Wire.masked))
        await model.perform(.turnOnTexted)
        fill()
        model.cancel()
        stage.assertNothingSecretIsHeld("after the texted factor was cancelled")

        await model.perform(.openPhone)
        fill()
        stage.api.on(Account.phone, Account.sent("sms_code", to: Wire.masked))
        await model.perform(.sendPhoneCode)
        fill()
        model.cancel()
        stage.assertNothingSecretIsHeld("after the phone code was cancelled")
        XCTAssertEqual(model.phoneNumber, "")

        await model.perform(.openRename("pk_1"))
        model.cancel()
        XCTAssertEqual(model.name, "")

        // A step-up over a form, with each of its ways.
        stage.api.on(Account.totpStart, Account.stepUpRequired("password,totp,backup_code"))
        await model.perform(.setUpAuthenticator)
        XCTAssertEqual(model.panel, .stepUp(.password, others: [.totp, .backupCode], sent: nil))
        fill()
        XCTAssertEqual(model.revealed, [.password])
        await model.perform(.useStepUpWay(.totp))
        stage.assertNothingSecretIsHeld("after the way was changed")
        fill()
        await model.perform(.useStepUpWay(.backupCode))
        stage.assertNothingSecretIsHeld("after the way was changed again")
        fill()
        model.cancel()
        stage.assertNothingSecretIsHeld("after the step-up was cancelled")
        XCTAssertFalse(stage.everything.contains("TYPED-CANARY"))
    }

    func testClosingForgetsEverythingAndSignsNobodyOut() async throws {
        let stage = try await codesShown()
        let model = stage.model
        XCTAssertEqual(model.backupCodes, Wire.backupCodes)
        model.close()
        XCTAssertEqual(model.panel, .overview)
        stage.assertNothingSecretIsHeld("after close()")
        XCTAssertNil(model.status)
        XCTAssertNil(model.content.codes)
        XCTAssertEqual(stage.heard.signedOut, 0)
        let signedIn = await stage.isSignedIn
        XCTAssertTrue(signedIn)
        // What was to be said once the codes were saved went with them.
        model.savedBackupCodes()
        XCTAssertNil(model.status)

        let onSetup = try await settingUp()
        onSetup.model.setText("123456", of: .code)
        onSetup.model.close()
        onSetup.assertNothingSecretIsHeld("after close() on the setup")
        // On the account itself it changes no panel and moves no focus.
        let requests = onSetup.model.focusRequests
        onSetup.model.close()
        XCTAssertEqual(onSetup.model.focusRequests, requests)
    }

    func testClosingWhileAKeyOrCodesAreOnTheirWayDropsTheLateAnswer() async throws {
        // The setup key.
        var stage = try await AccountStage.loaded()
        var gate = Gate()
        stage.api.on(Account.totpStart) { [gate] _ in
            await gate.wait()
            return Wire.totpEnrolment
        }
        var model = stage.model
        var action = Task { [model] in await model.perform(.setUpAuthenticator) }
        await eventually("the key was asked for") { [stage] in stage.api.count(Account.totpStart) == 1 }
        XCTAssertTrue(model.isPending)
        model.close()
        XCTAssertFalse(model.isPending)
        gate.open()
        await action.value
        XCTAssertEqual(model.panel, .overview, "the answer of a screen that closed is dropped")
        stage.assertNothingSecretIsHeld("after the late key")
        XCTAssertFalse(stage.everything.contains(Wire.setupKey))

        // The backup codes of a confirmation.
        stage = try await settingUp()
        gate = Gate()
        stage.api.on(Account.totpConfirm) { [gate] _ in
            await gate.wait()
            return Account.codes
        }
        model = stage.model
        model.setText("123456", of: .code)
        action = Task { [model] in await model.perform(.confirmAuthenticator) }
        await eventually("the code was sent") { [stage] in stage.api.count(Account.totpConfirm) == 1 }
        model.close()
        gate.open()
        await action.value
        XCTAssertEqual(model.panel, .overview)
        stage.assertNothingSecretIsHeld("after the late codes")
        XCTAssertFalse(stage.everything.contains("aaaaa"))
        XCTAssertNil(model.status)

        // New backup codes.
        stage = try await AccountStage.loaded(factors: Account.factors(totp: true, codes: 1))
        gate = Gate()
        stage.api.on(Account.backupCodes) { [gate] _ in
            await gate.wait()
            return Account.codes
        }
        model = stage.model
        action = Task { [model] in await model.perform(.newBackupCodes) }
        await eventually("new codes were asked for") { [stage] in stage.api.count(Account.backupCodes) == 1 }
        model.close()
        gate.open()
        await action.value
        XCTAssertEqual(model.panel, .overview)
        stage.assertNothingSecretIsHeld("after the late new codes")
        XCTAssertEqual(stage.api.count(Account.factors), 1, "and nothing is read for a screen that closed")
    }

    func testClosingWhileAFailureIsOnItsWaySaysNothing() async throws {
        let stage = try await AccountStage.loaded()
        let gate = Gate()
        stage.api.on(Account.revokeOthers) { _ in
            await gate.wait()
            return Reply.error(503, "service.unavailable")
        }
        let model = stage.model
        let action = Task { await model.perform(.signOutOthers) }
        await eventually("the call left") { stage.api.count(Account.revokeOthers) == 1 }
        model.close()
        gate.open()
        await action.value
        XCTAssertNil(model.formError)
        XCTAssertEqual(stage.heard.said, [])
    }

    func testASecondActionWhileOneIsPendingDoesNothing() async throws {
        let stage = try await AccountStage.loaded(passkeys: Account.passkeys([Account.passkey()]))
        let gate = Gate()
        stage.api.on(Account.revokeOthers) { _ in
            await gate.wait()
            return Reply(json: #"{"revoked":1}"#)
        }
        let model = stage.model
        let action = Task { await model.perform(.signOutOthers) }
        await eventually("the call left") { stage.api.count(Account.revokeOthers) == 1 }
        XCTAssertTrue(model.isPending)

        await model.perform(.signOutOthers)
        await model.perform(.signOutSession("ses_2"))
        await model.perform(.signOut)
        await model.perform(.setUpAuthenticator)
        await model.perform(.openChangePassword)
        await model.perform(.openRename("pk_1"))
        await model.perform(.ask(.removePasskey(id: "pk_1", name: "iPhone")))
        model.openPhone()
        model.cancel()
        XCTAssertEqual(model.panel, .overview)
        XCTAssertEqual(stage.api.count(Account.revokeOthers), 1)
        XCTAssertEqual(stage.api.count(Account.revoke("ses_2")), 0)
        XCTAssertEqual(stage.api.count(Account.signOut), 0)
        XCTAssertEqual(stage.api.count(Account.totpStart), 0)
        XCTAssertTrue(model.isPending)

        gate.open()
        await action.value
        XCTAssertFalse(model.isPending)
        XCTAssertEqual(model.status, "Signed out of 1 other device.")
    }

    // MARK: Fields

    func testOnlyAPasswordFieldOfTheOpenFormIsRevealed() async throws {
        let stage = try await AccountStage.loaded()
        let model = stage.model
        // On the account there is no field.
        for field in [TulaAuthField.password, .currentPassword, .newPassword, .code] {
            model.toggleReveal(field)
        }
        XCTAssertEqual(model.revealed, [])

        await model.perform(.openChangePassword)
        model.toggleReveal(.password)
        model.toggleReveal(.code)
        model.toggleReveal(.backupCode)
        model.toggleReveal(.name)
        XCTAssertEqual(model.revealed, [], "not a field of this form, or not a password")
        model.toggleReveal(.newPassword)
        XCTAssertTrue(model.isRevealed(.newPassword))
        XCTAssertFalse(model.isRevealed(.currentPassword))
        model.toggleReveal(.newPassword)
        XCTAssertFalse(model.isRevealed(.newPassword))
    }

    func testAFieldHoldsWhatWasTypedAndACodeFieldOnlyTheDigitsOfACode() async throws {
        let stage = try await AccountStage.loaded()
        let model = stage.model
        model.setText("12a3 4-5.6789", of: .code)
        XCTAssertEqual(model.code, "123456")
        XCTAssertEqual(model.text(of: .code), "123456")
        model.setText("١٢٣", of: .code)
        XCTAssertEqual(model.code, "", "the digits of a code are ASCII")
        let typed: [(TulaAuthField, String)] = [
            (.password, "a b"), (.currentPassword, "c d"), (.newPassword, "e f"), (.backupCode, "abcde-fghjk"),
            (.phoneNumber, "+1 415"), (.name, "My key"),
        ]
        for (field, text) in typed {
            model.setText(text, of: field)
            XCTAssertEqual(model.text(of: field), text, "\(field): as typed")
        }
        XCTAssertEqual(model.backupCode, "abcde-fghjk")
        // The account screen has no address field.
        model.setText("maya@example.com", of: .email)
        XCTAssertEqual(model.text(of: .email), "")
    }

    func testTheDefaultDateIsTheSystemsMediumDateAndShortTime() {
        let date = Date(timeIntervalSince1970: 1_700_000_000)
        XCTAssertEqual(
            TulaAccountModel.mediumDate(date),
            DateFormatter.localizedString(from: date, dateStyle: .medium, timeStyle: .short))
        XCTAssertEqual(TulaAccountFacts().formatDate(date), TulaAccountModel.mediumDate(date))
    }

    // MARK: What holds a secret prints as its type's name

    func testTheModelItsFactsAndItsContentPrintAsTheirTypesName() async throws {
        let stage = try await settingUp()
        let model = stage.model
        model.setText("123456", of: .code)
        var printed = everythingOf(model) + everythingOf(model.facts) + everythingOf(model.content)
        XCTAssertEqual(model.content.setup?.key, Wire.setupKey, "the content does hold the key")
        XCTAssertFalse(printed.contains(Wire.setupKey), printed)
        XCTAssertFalse(printed.contains("otpauth"), printed)
        XCTAssertFalse(printed.contains("123456"), printed)

        stage.api.on(Account.totpConfirm, Account.codes)
        await model.perform(.confirmAuthenticator)
        XCTAssertEqual(model.content.codes?.codes, Wire.backupCodes, "and the codes")
        await model.perform(.savedBackupCodes)
        await model.perform(.openChangePassword)
        model.setText(Canary.password, of: .currentPassword)
        model.setText(Canary.password, of: .newPassword)

        var facts = model.facts
        facts.setup = TulaAuthSetup(key: "SETUP-KEY-CANARY", uri: "otpauth://totp/x?secret=SETUP-KEY-CANARY")
        facts.backupCodes = ["CODE-CANARY-1"]
        let rows: [(Any, String)] = [
            (model, "TulaAccountModel"), (facts, "TulaAccountFacts"),
            (TulaAccountContent(panel: .totpSetup, strings: .english, facts: facts), "TulaAccountContent"),
            (TulaAccountContent(panel: .backupCodes, strings: .english, facts: facts), "TulaAccountContent"),
            (Optional(model) as Any, "TulaAccountModel"), ([facts], "TulaAccountFacts"),
        ]
        for (value, name) in rows {
            printed = everythingOf(value)
            XCTAssertFalse(printed.contains("CANARY"), "\(name): \(printed)")
            XCTAssertFalse(printed.contains("maya@example.com"), "\(name): \(printed)")
            XCTAssertTrue(printed.contains(name), "\(name): \(printed)")
        }
        XCTAssertEqual("\(model)", "TulaAccountModel")
        XCTAssertEqual(String(reflecting: facts), "TulaAccountFacts")
        XCTAssertEqual("\(model.content)", "TulaAccountContent")
    }
}
