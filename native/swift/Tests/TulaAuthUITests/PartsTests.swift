import CoreGraphics
import Foundation
import TulaAuth
import XCTest

@testable import TulaAuthUI

// The parts the screens are made of: what holds a secret prints as its type's name, where a
// failed call's problems are said, the words of a code that came without an error, a date
// in words, the QR code of a setup address, and the one door every new action goes through.
@MainActor
final class PartsTests: XCTestCase {
    private static let secret = "SETUP-KEY-CANARY"
    private static let codes = ["CODE-CANARY-1", "CODE-CANARY-2"]

    private func everythingOf(_ value: Any) -> String {
        var text = "\(value) \(String(describing: value)) \(String(reflecting: value))"
        dump(value, to: &text)
        print(value, to: &text)
        return text
    }

    // MARK: What holds a secret

    func testWhatHoldsASetupKeyOrBackupCodesPrintsAsItsTypesName() {
        let setup = TulaAuthSetup(key: PartsTests.secret, uri: "otpauth://totp/x?secret=\(PartsTests.secret)")
        var situation = TulaAuthSituation()
        situation.setup = setup
        situation.backupCodes = PartsTests.codes
        let copyKey = TulaAuthOffer("copyKey", "Copy setup key", .copySetupKey)
        let setupContent = TulaAuthSetupContent(
            uri: setup.uri, key: setup.key, qrLabel: "QR", keyLabel: "Key", keyHint: "Hint", copy: copyKey)
        let codesContent = TulaAuthCodesContent(
            label: "Codes", codes: PartsTests.codes, copy: TulaAuthOffer("copyCodes", "Copy", .copyBackupCodes))
        let onSetup = TulaAuthContent(screen: .totpSetup, strings: .english, situation: situation)
        let onCodes = TulaAuthContent(screen: .backupCodes, strings: .english, situation: situation)
        XCTAssertEqual(onSetup.setup?.key, PartsTests.secret, "the content does hold the key")
        XCTAssertEqual(onCodes.codes?.codes, PartsTests.codes, "and the codes")

        let rows: [(Any, String)] = [
            (setup, "TulaAuthSetup"), (situation, "TulaAuthSituation"), (onSetup, "TulaAuthContent"),
            (onCodes, "TulaAuthContent"), (setupContent, "TulaSetupContent"),
            (codesContent, "TulaCodesContent"),
            // Reached through an optional and a collection, as a view's state holds them.
            (Optional(setup) as Any, "TulaAuthSetup"), ([onSetup, onCodes], "TulaAuthContent"),
        ]
        for (value, name) in rows {
            let printed = everythingOf(value)
            XCTAssertFalse(printed.contains("CANARY"), "\(name): \(printed)")
            XCTAssertTrue(printed.contains(name), "\(name): \(printed)")
        }
        XCTAssertEqual("\(setup)", "TulaAuthSetup")
        XCTAssertEqual(String(reflecting: situation), "TulaAuthSituation")
        XCTAssertEqual("\(onCodes)", "TulaAuthContent")
    }

    func testAModelThatHoldsASetupKeyAndBackupCodesPrintsNeither() async throws {
        let stage = try Stage()
        await stage.signIn(to: Wire.enrolment)
        stage.api.on(Wire.enrolStart, Wire.totpEnrolment)
        await stage.model.startEnrolment()
        stage.model.backupCode = "BACKUP-CANARY"
        XCTAssertFalse(everythingOf(stage.model).contains(Wire.setupKey))
        stage.api.on(Wire.enrolConfirm, Wire.enrolled())
        stage.model.code = "123456"
        await stage.model.confirmEnrolment()
        XCTAssertEqual(stage.model.backupCodes, Wire.backupCodes)
        let printed = everythingOf(stage.model) + everythingOf(stage.model.situation) + everythingOf(stage.model.content)
        XCTAssertFalse(printed.contains("aaaaa"), printed)
        XCTAssertFalse(printed.contains("BACKUP-CANARY"), printed)
    }

    // MARK: Where a problem is said

    /// The error the client throws for an answer.
    private func thrown(_ reply: Reply) async throws -> TulaError {
        let stage = try Stage()
        stage.api.on(Wire.signIns, reply)
        do {
            _ = try await stage.client.startSignIn(identifier: "maya@example.com")
        } catch let error as TulaError {
            return error
        }
        throw NothingThrown()
    }

    /// Thrown where a helper expected an error and got none: the test then fails.
    private struct NothingThrown: Error {}

    private func problems(_ fields: [(String?, String)], code: String = "validation.failed") -> Reply {
        let list = fields.map { field, code in
            #"{\#(field.map { #""field":"\#($0)","# } ?? "")"code":"\#(code)","message":"\#(Canary.serverText)"}"#
        }
        return Reply(
            status: 422,
            json:
                #"{"status":422,"code":"\#(code)","detail":"\#(Canary.serverText)","errors":[\#(list.joined(separator: ","))]}"#
        )
    }

    func testAProblemIsSaidAtTheFieldItNamesOrItsCodeBelongsTo() async throws {
        let strings = TulaStrings.english
        let unknown = strings.unknownError
        struct Row {
            let name: String
            let reply: Reply
            let shown: [TulaAuthField]
            var wrong: (TulaAuthField, String)?
            let fields: [TulaAuthField: [String]]
            let above: Bool
        }
        let rows: [Row] = [
            Row(
                name: "by the field's wire name", reply: problems([("phoneNumber", "phone.invalid"), ("name", "x.y")]),
                shown: [.phoneNumber, .name], fields: [.phoneNumber: [strings.message(code: "phone.invalid")], .name: [unknown]],
                above: false),
            Row(
                name: "a password that is being chosen", reply: problems([("password", "password.too_short")]),
                shown: [.currentPassword, .newPassword],
                fields: [.newPassword: [strings.message(code: "password.too_short")]], above: false),
            Row(
                name: "the current password by name", reply: problems([("currentPassword", "x.y")]),
                shown: [.currentPassword, .newPassword], fields: [.currentPassword: [unknown]], above: false),
            Row(
                name: "a code where the field is a backup code", reply: problems([("code", "x.y"), ("other", "mfa.invalid_code")]),
                shown: [.backupCode], fields: [.backupCode: [unknown, "That code is incorrect."]], above: false),
            Row(
                name: "by the code's area", reply: problems([("other", "email.invalid"), ("other", "phone.invalid"), ("other", "verification.expired")]),
                shown: [.email, .phoneNumber, .code],
                fields: [
                    .email: [strings.message(code: "email.invalid")], .phoneNumber: [strings.message(code: "phone.invalid")],
                    .code: ["That code has expired. Request a new one."],
                ], above: false),
            Row(
                name: "a rule said twice is shown once", reply: problems([("email", "email.invalid"), ("email", "email.invalid")]),
                shown: [.email], fields: [.email: [strings.message(code: "email.invalid")]], above: false),
            Row(
                name: "a field the screen does not have", reply: problems([("phoneNumber", "phone.invalid"), ("other", "service.unavailable")]),
                shown: [.email], fields: [:], above: true),
            Row(
                name: "a refused secret at the last field", reply: Reply.error(401, "auth.invalid_credentials"),
                shown: [.email, .password], fields: [.password: ["The email or password is incorrect."]], above: false),
            Row(
                name: "a refused secret in the screen's own words", reply: Reply.error(401, "auth.invalid_credentials"),
                shown: [.currentPassword, .newPassword], wrong: (.currentPassword, "That is not your current password."),
                fields: [.currentPassword: ["That is not your current password."]], above: false),
            Row(
                name: "the screen's words inside a list", reply: problems([("other", "auth.invalid_credentials")]),
                shown: [.code], wrong: (.code, "That code is incorrect."), fields: [.code: ["That code is incorrect."]],
                above: false),
            Row(
                name: "a refused secret where the screen names a field it lacks", reply: Reply.error(401, "auth.invalid_credentials"),
                shown: [.name], wrong: (.code, "x"), fields: [:], above: true),
            Row(
                name: "a refused secret on a screen with no field", reply: Reply.error(401, "auth.invalid_credentials"),
                shown: [], fields: [:], above: true),
            Row(
                name: "an error with no list, by its area", reply: Reply.error(422, "password.too_short"),
                shown: [.password], fields: [.password: [strings.message(code: "password.too_short")]], above: false),
            Row(
                name: "an error about nothing typed", reply: Reply.error(503, "service.unavailable"), shown: [.email],
                fields: [:], above: true),
        ]
        for row in rows {
            let error = try await thrown(row.reply)
            let placed = TulaPlacedProblems(error, fields: row.shown, strings: strings, wrong: row.wrong)
            XCTAssertEqual(placed.fields, row.fields, row.name)
            XCTAssertEqual(placed.above != nil, row.above, row.name)
            let said = ([placed.above].compactMap { $0 } + placed.fields.values.flatMap { $0 }).joined()
            XCTAssertFalse(said.contains(Canary.serverText), row.name)
        }

        // A wait is said after what is above the form, and only there.
        let limited = try await thrown(Reply.error(429, "rate_limited", headers: ["retry-after": "61"]))
        let above = TulaPlacedProblems(limited, fields: [.email], strings: strings).above
        XCTAssertTrue(above?.hasSuffix(" Try again in 1m 1s.") == true, above ?? "")
        let atField = try await thrown(Reply.error(422, "email.invalid", headers: ["retry-after": "61"]))
        let field = TulaPlacedProblems(atField, fields: [.email], strings: strings)
        XCTAssertNil(field.above)
        XCTAssertEqual(field.fields[.email]?.count, 1)
        XCTAssertFalse(field.fields[.email]?.first?.contains("1m") == true)
    }

    // MARK: What is copied

    func testWhatIsCopiedStaysOnThisDeviceAndIsTakenBackAfterAMinute() {
        // A setup key and backup codes: not for the other devices of the same account, and
        // not for whatever reads the pasteboard an hour later.
        XCTAssertTrue(TulaCopyRule.localOnly)
        XCTAssertEqual(TulaCopyRule.lifetime, 60)
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        XCTAssertEqual(TulaCopyRule.expiry(from: now), Date(timeIntervalSince1970: 1_800_000_060))
    }

    // MARK: Words

    func testACodeThatCameWithoutAnErrorIsSaidByTheTableThenTheContractThenTheFallback() {
        var strings = TulaStrings.english
        XCTAssertEqual(strings.message(code: "auth.invalid_credentials"), "The email or password is incorrect.")
        XCTAssertEqual(strings.message(code: "oauth.made_up_tomorrow"), "Something went wrong. Try again.")
        XCTAssertEqual(strings.message(code: Canary.serverText), "Something went wrong. Try again.")
        strings.errors["oauth.access_denied"] = "Zugriff verweigert."
        strings.unknownError = "Etwas ist schiefgelaufen."
        XCTAssertEqual(strings.message(code: "oauth.access_denied"), "Zugriff verweigert.")
        XCTAssertEqual(strings.message(code: "oauth.made_up_tomorrow"), "Etwas ist schiefgelaufen.")
    }

    func testADateTheServerWroteIsSaidInWordsOrNotAtAll() {
        let seconds: (Date) -> String = { String(Int($0.timeIntervalSince1970)) }
        XCTAssertEqual(TulaStrings.date("2026-01-01T00:00:00.000Z", seconds), "1767225600")
        XCTAssertEqual(TulaStrings.date("2026-01-01T00:00:00Z", seconds), "1767225600")
        XCTAssertEqual(TulaStrings.date("2026-01-01T01:00:00.250+01:00", seconds), "1767225600")
        XCTAssertNil(TulaStrings.date(nil, seconds))
        XCTAssertNil(TulaStrings.date("", seconds))
        XCTAssertNil(TulaStrings.date("yesterday", seconds))
        XCTAssertNil(TulaStrings.date(Canary.serverText, seconds), "what is not a date is never shown as one")
    }

    func testEveryStringOfTheNewTablesIsThereAndAProviderIsNamedForEveryProviderOfTheContract() {
        func strings(of value: Any) -> [(String, String)] {
            Mirror(reflecting: value).children.flatMap { child -> [(String, String)] in
                if let text = child.value as? String {
                    return [(child.label ?? "", text)]
                }
                if let table = child.value as? [String: String] {
                    return table.map { ($0.key, $0.value) }
                }
                return []
            }
        }
        let tables: [(String, Any)] = [
            ("ways", TulaSignInWayStrings()), ("secondStep", TulaSecondStepStrings()), ("account", TulaAccountStrings()),
        ]
        for (name, table) in tables {
            let found = strings(of: table)
            XCTAssertGreaterThan(found.count, 20, name)
            for (label, text) in found {
                XCTAssertFalse(text.trimmingCharacters(in: .whitespaces).isEmpty, "\(name).\(label)")
            }
        }
        XCTAssertEqual(TulaStrings.english.ways, TulaSignInWayStrings())
        XCTAssertEqual(TulaStrings.english.secondStep, TulaSecondStepStrings())
        XCTAssertEqual(TulaStrings.english.account, TulaAccountStrings())
        XCTAssertEqual(
            Set(TulaStrings.english.ways.providers.keys), Set(TulaAuthAction.providers.map(\.rawValue)),
            "a provider the contract has and the table does not would never be drawn")
        // Nothing says more of a device or a message than is known.
        let all = tables.flatMap { strings(of: $0.1).map(\.1) }.joined(separator: "\n").lowercased()
        for claim in ["verified device", "trusted device", "device verification", "was delivered"] {
            XCTAssertFalse(all.contains(claim), claim)
        }
    }

    // MARK: The QR code

    func testTheQRCodeOfASetupAddressIsASquareMadeInMemory() throws {
        let image = try XCTUnwrap(TulaQRCode.image(for: Wire.setupAddress))
        XCTAssertEqual(image.width, image.height)
        XCTAssertGreaterThanOrEqual(image.width, 21, "the smallest QR code has 21 modules a side")
        XCTAssertNil(TulaQRCode.image(for: ""), "no address, no code")
        // A longer address is a larger code, never a refused one.
        let longer = try XCTUnwrap(TulaQRCode.image(for: Wire.setupAddress + String(repeating: "A", count: 200)))
        XCTAssertGreaterThan(longer.width, image.width)
        XCTAssertEqual(longer.width, longer.height)
        // More than any QR code holds: the system makes none, and the screen then draws the
        // setup key alone instead of something that is not a code.
        XCTAssertNil(TulaQRCode.image(for: String(repeating: "A", count: 8000)), "no code, never a wrong one")
    }

    // MARK: The one door

    func testEveryNewActionIsPerformedThroughTheOneDoorAndOnlyWhereItsScreenOffersIt() async throws {
        // Each action of TULA-60 on a screen that does not offer it: nothing is sent,
        // nothing is copied, nothing is said.
        let stage = try Stage(passkeys: ScriptedPasskeySheet())
        await stage.signIn(to: Wire.needsPassword)
        let offered = stage.model.content.actions
        let before = stage.api.routes
        for action in TulaAuthAction.allCases where !offered.contains(action) {
            await stage.model.perform(action)
            XCTAssertEqual(stage.model.screen, .password(canEmailCode: false), "\(action)")
        }
        // And each of the model's own functions, called past the door.
        await stage.model.sendTextedCode()
        await stage.model.submitBackupCode()
        await stage.model.useSecondPasskey()
        await stage.model.startEnrolment()
        await stage.model.confirmEnrolment()
        stage.model.copySetupKey()
        stage.model.copyBackupCodes()
        stage.model.savedBackupCodes()
        stage.model.useSecondWay(.totp)
        await stage.model.usePasskey()
        await stage.model.useProvider(.github)
        await stage.model.retryProvider()
        XCTAssertEqual(stage.api.routes, before)
        XCTAssertEqual(stage.heard.copied, [])
        XCTAssertEqual(stage.heard.said, [])
        XCTAssertNil(stage.model.formError)
        XCTAssertNil(stage.model.notice)
        XCTAssertFalse(stage.model.isPending)

        XCTAssertEqual(Set(TulaAuthAction.allCases).count, TulaAuthAction.allCases.count, "each action once")
        XCTAssertEqual(TulaAuthAction.allCases.count, 21 + 4 + 8)
    }

    func testWhatAFieldHoldsIsReadAndWrittenByItsName() throws {
        let stage = try Stage()
        stage.model.setText("abcde-fghjk", of: .backupCode)
        XCTAssertEqual(stage.model.backupCode, "abcde-fghjk", "a backup code is kept as typed: letters too")
        XCTAssertEqual(stage.model.text(of: .backupCode), "abcde-fghjk")
        // The fields of the account screen are none of this model's.
        for field in [TulaAuthField.currentPassword, .phoneNumber, .name] {
            stage.model.setText(Canary.password, of: field)
            XCTAssertEqual(stage.model.text(of: field), "")
        }
        var dumped = ""
        dump(stage.model, to: &dumped)
        XCTAssertFalse(dumped.contains(Canary.password))
    }

    func testEveryChangeOfScreenEmptiesEverySecretOfTheNewScreens() async throws {
        let stage = try Stage()
        await stage.signIn(to: Wire.enrolment)
        stage.api.on(Wire.enrolStart, Wire.totpEnrolment)
        let moves: [(String, @MainActor (TulaAuthModel) async -> Void)] = [
            ("to the setup", { await $0.startEnrolment() }), ("starting again", { $0.startAgain() }),
            ("to a sign-up", { $0.showSignUp() }), ("to a reset", { $0.showReset() }), ("closing", { $0.close() }),
        ]
        for (name, move) in moves {
            // What no screen change may carry over, put there by hand.
            stage.model.code = "123456"
            stage.model.backupCode = "abcde-fghjk"
            stage.model.setup = TulaAuthSetup(key: PartsTests.secret, uri: PartsTests.secret)
            stage.model.backupCodes = PartsTests.codes
            stage.model.textedOff = true
            let from = stage.model.screen
            await move(stage.model)
            XCTAssertNotEqual(stage.model.screen, from, name)
            XCTAssertEqual([stage.model.code, stage.model.backupCode], ["", ""], name)
            XCTAssertEqual(stage.model.backupCodes, [], name)
            XCTAssertFalse(stage.model.textedOff, name)
            // The one key a screen may hold is the one its own answer just brought.
            XCTAssertNotEqual(stage.model.setup?.key, PartsTests.secret, name)
            XCTAssertNil(stage.model.notice, name)
        }
        XCTAssertNil(stage.model.setup)
    }
}
