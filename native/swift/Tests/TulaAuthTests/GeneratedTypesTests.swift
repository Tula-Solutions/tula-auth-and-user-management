import Foundation
import XCTest

@testable import TulaAuth

// What the generated types do with JSON this version of the SDK was not written for
// (ADR 0050). The types under Sources/TulaAuth/Generated are written by
// `bun run native:generate`; this file is written by hand and is run with `swift test`.
// No workflow of the repository runs it yet: see docs/plans/phase-2-unverified.md.
final class GeneratedTypesTests: XCTestCase {
    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(type, from: Data(json.utf8))
    }

    private func encode<T: Encodable>(_ value: T) throws -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return String(decoding: try encoder.encode(value), as: UTF8.self)
    }

    private let knownStep =
        #"{"status":"needs_first_factor","strategies":["password","email_code","passkey"],"prepared":{"strategy":"email_code","destination":"a***@example.com"}}"#
    private let unknownStep = #"{"status":"needs_hardware_key","options":["usb","nfc"],"deadline":30}"#
    private let attempt =
        #"{"id":"att_1","kind":"sign_in","expiresAt":"2026-10-10T12:00:00.000Z","step":{"status":"complete","userId":"u1","sessionId":"s1","somethingNew":true},"futureField":{"a":[1,2]}}"#
    private let policy =
        #"{"preset":"future_preset","minLength":8,"maxLength":128,"requireLowercase":false,"requireUppercase":false,"requireNumber":false,"requireSpecial":false,"minCharacterClasses":0,"specialChars":"!","disallowUserInfo":true,"disallowCommon":true,"breachCheck":"off","maxRepeatedChars":null,"blockSequences":false,"history":0,"expiryDays":90}"#

    // MARK: The flow step

    func testAKnownStepDecodesToItsCase() throws {
        guard case .needsFirstFactor(let step) = try decode(FlowStep.self, knownStep) else {
            return XCTFail("not needsFirstFactor")
        }
        XCTAssertEqual(step.strategies, [.password, .emailCode, .passkey])
        XCTAssertEqual(step.prepared?.destination, "a***@example.com")
        XCTAssertEqual(step.prepared?.strategy, .emailCode)
    }

    func testAKnownStepEncodesBackToTheSameJSON() throws {
        XCTAssertEqual(
            try encode(try decode(FlowStep.self, knownStep)),
            #"{"prepared":{"destination":"a***@example.com","strategy":"email_code"},"status":"needs_first_factor","strategies":["password","email_code","passkey"]}"#
        )
    }

    func testAStatusThisVersionDoesNotKnowIsUnknownAndNotAnError() throws {
        let step = try decode(FlowStep.self, unknownStep)
        guard case .unknown(let status, let raw) = step else {
            return XCTFail("not unknown")
        }
        XCTAssertEqual(status, "needs_hardware_key")
        XCTAssertEqual(step.status, "needs_hardware_key")
        XCTAssertEqual(
            raw,
            .object([
                "status": .string("needs_hardware_key"),
                "options": .array([.string("usb"), .string("nfc")]),
                "deadline": .number(30),
            ])
        )
    }

    func testAnUnknownStepEncodesBackUnchanged() throws {
        XCTAssertEqual(
            try encode(try decode(FlowStep.self, unknownStep)),
            #"{"deadline":30,"options":["usb","nfc"],"status":"needs_hardware_key"}"#
        )
    }

    func testAStepWithNoStatusIsAnError() {
        XCTAssertThrowsError(try decode(FlowStep.self, #"{"strategies":[]}"#))
    }

    func testAStepWithNoFieldsRoundTrips() throws {
        XCTAssertEqual(
            try encode(try decode(FlowStep.self, #"{"status":"needs_password"}"#)),
            #"{"status":"needs_password"}"#
        )
    }

    // MARK: Enums that can grow

    func testAnUnseenEnumMemberIsUnknownWithItsString() throws {
        let strategies = try decode([FirstFactorStrategy].self, #"["password","retina_scan"]"#)
        XCTAssertEqual(strategies, [.password, .unknown("retina_scan")])
        XCTAssertEqual(strategies[1].rawValue, "retina_scan")
        XCTAssertEqual(try encode(strategies), #"["password","retina_scan"]"#)
    }

    func testAnUnknownThatNamesAKnownValueEqualsIt() {
        XCTAssertEqual(FlowKind.unknown("sign_in"), FlowKind.signIn)
        XCTAssertEqual(FlowKind.unknown("sign_in").hashValue, FlowKind.signIn.hashValue)
        XCTAssertEqual(FlowKind(rawValue: "sign_in"), .signIn)
    }

    func testAnUnseenMemberInsideAKnownStepDoesNotFailTheStep() throws {
        let json = #"{"status":"needs_first_factor","strategies":["retina_scan"]}"#
        guard case .needsFirstFactor(let step) = try decode(FlowStep.self, json) else {
            return XCTFail("not needsFirstFactor")
        }
        XCTAssertEqual(step.strategies, [.unknown("retina_scan")])
    }

    // MARK: Keys

    func testUnknownKeysAreIgnoredAndMissingOptionalFieldsAreAbsent() throws {
        let value = try decode(FlowAttempt.self, attempt)
        guard case .complete(let step) = value.step else {
            return XCTFail("not complete")
        }
        XCTAssertEqual(value.kind, .signIn)
        XCTAssertNil(value.attemptSecret)
        XCTAssertNil(value.session)
        XCTAssertNil(value.backupCodes)
        XCTAssertEqual(step.userId, "u1")
        XCTAssertEqual(value.expiresAt, "2026-10-10T12:00:00.000Z")
    }

    func testAnOptionalFieldWithNoValueIsLeftOutWhenEncoded() throws {
        XCTAssertEqual(
            try encode(try decode(FlowAttempt.self, attempt)),
            #"{"expiresAt":"2026-10-10T12:00:00.000Z","id":"att_1","kind":"sign_in","step":{"sessionId":"s1","status":"complete","userId":"u1"}}"#
        )
    }

    func testAMissingRequiredFieldIsAnError() {
        XCTAssertThrowsError(
            try decode(FlowAttempt.self, #"{"id":"att_1","kind":"sign_in","step":{"status":"needs_password"}}"#)
        )
    }

    func testARequiredKeyThatMayBeNull() throws {
        let value = try decode(PasswordPolicy.self, policy)
        XCTAssertNil(value.maxRepeatedChars)
        XCTAssertEqual(value.expiryDays, 90)
        XCTAssertEqual(value.preset, .unknown("future_preset"))
        // Written as null, never left out.
        XCTAssertTrue(try encode(value).contains(#""maxRepeatedChars":null"#))
        // Missing altogether, it is an error: the document says the key is always there.
        let missing = policy.replacingOccurrences(of: #""maxRepeatedChars":null,"#, with: "")
        XCTAssertNotEqual(missing, policy)
        XCTAssertThrowsError(try decode(PasswordPolicy.self, missing))
    }

    // MARK: Errors

    func testAnErrorCodeThisVersionDoesNotKnow() throws {
        let value = try decode(
            ErrorEnvelope.self,
            #"{"status":418,"code":"teapot.short_and_stout","detail":"x","params":{"n":1,"s":"a","b":true}}"#
        )
        XCTAssertEqual(value.code, .unknown("teapot.short_and_stout"))
        XCTAssertEqual(value.code.rawValue, "teapot.short_and_stout")
        XCTAssertEqual(value.params, ["n": .number(1), "s": .string("a"), "b": .bool(true)])
        XCTAssertNil(value.errors)
    }

    func testAKnownErrorCodeAndItsDefinition() throws {
        let value = try decode(
            ErrorEnvelope.self,
            #"{"status":401,"code":"auth.invalid_credentials","detail":"x"}"#
        )
        XCTAssertEqual(value.code, .authInvalidCredentials)
        XCTAssertEqual(TulaErrorDefinitions.authInvalidCredentials.status, 401)
        XCTAssertEqual(TulaErrorDefinitions.authInvalidCredentials.code, .authInvalidCredentials)
        XCTAssertEqual(TulaErrorDefinitions.all.count, ErrorCode.allKnown.count)
    }

    // MARK: Requests

    func testARequestUnionWritesItsTag() throws {
        let request = FirstFactorAttemptRequest.emailCode(FirstFactorAttemptRequestEmailCode(code: "123456"))
        XCTAssertEqual(try encode(request), #"{"code":"123456","strategy":"email_code"}"#)
    }

    func testAClosedUnionAndAClosedEnumRefuseWhatTheyDoNotKnow() throws {
        XCTAssertThrowsError(try decode(FirstFactorAttemptRequest.self, #"{"strategy":"smoke_signal"}"#))
        XCTAssertThrowsError(try decode([OAuthProvider].self, #"["myspace"]"#))
        XCTAssertEqual(try encode(try decode([OAuthProvider].self, #"["google"]"#)), #"["google"]"#)
    }

    // MARK: Constants

    func testTheThemeHoldsTheDefaultsOfTheContract() {
        XCTAssertEqual(TulaTheme.defaults.light.primary, "#5b4cf0")
        XCTAssertEqual(TulaTheme.defaults.dark.background, "#17171c")
        XCTAssertEqual(TulaTheme.defaults.radius, "12px")
        XCTAssertEqual(TulaThemeToken.all.count, 25)
    }

    func testTheOperationTable() {
        XCTAssertEqual(TulaOperations.startSignIn.path, "/v1/client/sign-ins")
        XCTAssertEqual(TulaOperations.startSignIn.method, "POST")
        XCTAssertFalse(TulaOperations.startSignIn.requiresSession)
        XCTAssertTrue(TulaOperations.getMe.requiresSession)
    }
}
