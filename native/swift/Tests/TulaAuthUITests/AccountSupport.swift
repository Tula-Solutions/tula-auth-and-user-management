import Foundation
import TulaAuth
import XCTest

@testable import TulaAuthUI

// What the tests of the account screen stand on: the real client, signed in from a stored
// refresh token, on the table of answers of `FakeAPI`. No sheet is shown (a passkey sheet is
// `ScriptedPasskeySheet` or nothing), no pasteboard is touched (what the model copies goes to
// `Heard.copied`) and no Keychain is asked (the tokens are in memory).

/// The account's routes and answers, as the server writes them.
enum Account {
    static let storageKey = "tula.refresh.\(Wire.base)|\(Wire.key)"

    static let refresh = "POST /v1/client/sessions/refresh"
    static let signOut = "POST /v1/client/sessions/sign-out"
    static let me = "GET /v1/client/me"
    static let sessions = "GET /v1/client/sessions"
    static let factors = "GET /v1/client/me/factors"
    static let passkeys = "GET /v1/client/me/passkeys"
    static let revokeOthers = "POST /v1/client/sessions/revoke-others"
    static func revoke(_ id: String) -> String { "DELETE /v1/client/sessions/\(id)" }
    static let password = "POST /v1/client/me/password"
    static let totpStart = "POST /v1/client/me/factors/totp"
    static let totpConfirm = "POST /v1/client/me/factors/totp/confirm"
    static let totpOff = "DELETE /v1/client/me/factors/totp"
    static let backupCodes = "POST /v1/client/me/factors/backup-codes"
    static let smsStart = "POST /v1/client/me/factors/sms"
    static let smsConfirm = "POST /v1/client/me/factors/sms/confirm"
    static let smsOff = "DELETE /v1/client/me/factors/sms"
    static let phone = "POST /v1/client/me/phone"
    static let phoneVerify = "POST /v1/client/me/phone/verify"
    static let phoneRemove = "DELETE /v1/client/me/phone"
    static let passkeyOptions = "POST /v1/client/me/passkeys/options"
    static let passkeyAdd = "POST /v1/client/me/passkeys"
    static func passkeyRename(_ id: String) -> String { "PATCH /v1/client/me/passkeys/\(id)" }
    static func passkeyRemove(_ id: String) -> String { "DELETE /v1/client/me/passkeys/\(id)" }
    static let stepUp = "POST /v1/client/sessions/step-up"
    static let stepUpEmail = "POST /v1/client/sessions/step-up/email-code"
    static let stepUpSms = "POST /v1/client/sessions/step-up/sms-code"
    static let stepUpPasskey = "POST /v1/client/sessions/step-up/passkey"

    static let day = "2026-01-01T00:00:00.000Z"
    static let maskedEmail = "m***@example.com"

    private static func text(_ value: String?) -> String { value.map { "\"\($0)\"" } ?? "null" }

    static func user(
        email: String? = "maya@example.com", verified: Bool = true, first: String? = nil, last: String? = nil,
        phone: String? = nil, hasPassword: Bool = true
    ) -> String {
        #"{"id":"usr_1","email":\#(text(email)),"emailVerifiedAt":\#(verified ? text(day) : "null"),"firstName":\#(text(first)),"lastName":\#(text(last)),"bannedAt":null,"lastSignInAt":null,"createdAt":"\#(day)","phoneNumber":\#(text(phone)),"phoneNumberVerifiedAt":\#(phone == nil ? "null" : text(day)),"hasPassword":\#(hasPassword)}"#
    }

    static func session(_ id: String, client: String = "ios", current: Bool = false, bound: Bool = false) -> String {
        #"{"id":"\#(id)","client":"\#(client)","userAgent":"CANARY-user-agent","ipAddress":"203.0.113.7","createdAt":"\#(day)","lastActiveAt":"2026-01-02T00:00:00.000Z","expiresAt":"2026-02-01T00:00:00.000Z","current":\#(current),"deviceBound":\#(bound)}"#
    }

    static func sessions(_ list: [String]) -> String { #"{"data":[\#(list.joined(separator: ","))]}"# }

    /// The sessions of a user who is signed in here and in a browser.
    static let twoSessions = sessions([session("ses_1", current: true), session("ses_2", client: "web")])

    /// - Parameter sms: The `sms` member as written, or `nil` for a server that sends none.
    static func factors(totp: Bool = false, codes: Int = 0, sms: String? = nil) -> String {
        #"{"totp":{"enabled":\#(totp),"confirmedAt":\#(totp ? text(day) : "null")},"backupCodes":{"remaining":\#(codes)}\#(sms.map { #","sms":\#($0)"# } ?? "")}"#
    }

    static func sms(enabled: Bool, inUse: Bool, available: Bool) -> String {
        #"{"enabled":\#(enabled),"enabledAt":\#(enabled ? text(day) : "null"),"inUse":\#(inUse),"available":\#(available)}"#
    }

    static func passkey(_ id: String = "pk_1", name: String = "iPhone", synced: Bool = true, used: Bool = false) -> String {
        #"{"id":"\#(id)","name":"\#(name)","synced":\#(synced),"createdAt":"\#(day)","lastUsedAt":\#(used ? text(day) : "null")}"#
    }

    static func passkeys(_ list: [String]) -> String { #"{"passkeys":[\#(list.joined(separator: ","))]}"# }

    /// The configuration of an environment, with what the account screen reads of it.
    static func config(mfa: String = "optional", phone: Bool = false) -> Reply {
        let plain = Wire.config(name: "Acme", signUpPassword: "required").json
        return Reply(json: String(plain.dropLast()) + #","mfa":{"policy":"\#(mfa)"},"phone":{"enabled":\#(phone)}}"#)
    }

    static let creationOptions =
        #"{"rp":{"id":"example.test","name":"Example"},"user":{"id":"dXNyXzE","name":"maya@example.com","displayName":"Maya"},"challenge":"Y2hhbGxlbmdl","pubKeyCredParams":[{"type":"public-key","alg":-7}],"timeout":300000,"excludeCredentials":[],"authenticatorSelection":{"residentKey":"required","requireResidentKey":true,"userVerification":"required"},"attestation":"none"}"#

    static let codes = Reply(json: #"{"codes":["aaaaa-bbbbb","ccccc-ddddd"]}"#)
    static let none = Reply(status: 204, json: "")

    /// The server wants proof, by these ways, in its order.
    static func stepUpRequired(_ methods: String) -> Reply {
        Reply(
            status: 403,
            json:
                #"{"status":403,"code":"auth.step_up_required","detail":"\#(Canary.serverText)","params":{"methods":"\#(methods)"}}"#
        )
    }

    static func sent(_ method: String, to destination: String) -> Reply {
        Reply(json: #"{"method":"\#(method)","destination":"\#(destination)","expiresAt":"2030-01-01T00:00:00.000Z"}"#)
    }

    static func decoded<Value: Decodable>(_ json: String, file: StaticString = #filePath, line: UInt = #line) -> Value {
        do {
            return try JSONDecoder().decode(Value.self, from: Data(json.utf8))
        } catch {
            preconditionFailure("a fixture of the account tests does not decode: \(error)")
        }
    }

    /// How the tests say a date: the day, as the server wrote it.
    static func formatDate(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withFullDate]
        return formatter.string(from: date)
    }

    /// The sessions of an answer of the list route.
    static func sessionList(_ json: String) -> [Session] {
        let list: SessionList = decoded(json)
        return list.data
    }
}

/// An account model on the fakes, its client signed in.
@MainActor
struct AccountStage {
    let api = FakeAPI()
    let client: TulaClient
    let model: TulaAccountModel
    let heard = Heard()

    /// - Parameters:
    ///   - user, sessions, factors, passkeys, config: What the account's first read answers.
    ///     `nil` for a part whose read fails.
    init(
        strings: TulaStrings = .english, sheet: ScriptedPasskeySheet? = nil, user: String? = Account.user(),
        sessions: String? = Account.twoSessions, factors: String? = Account.factors(),
        passkeys: String? = Account.passkeys([]), config: Reply = Account.config()
    ) async throws {
        let storage = MemoryTokenStorage()
        await storage.set(Account.storageKey, "refresh-stored")
        client = try TulaClient(
            publishableKey: Wire.key, baseURL: Wire.base, storage: storage, transport: api, passkeys: sheet)
        api.on(Account.refresh, Reply(json: Wire.tokens))
        let state = try await client.session.load()
        XCTAssertTrue(state.isSignedIn, "the account's client is signed in")
        let heard = self.heard
        model = TulaAccountModel(
            client: client, strings: strings, formatDate: Account.formatDate, announce: { heard.said.append($0) },
            copy: { heard.copied.append($0) }, onSignedOut: { heard.signedOut += 1 })
        let failed = Reply.error(500, "internal")
        api.on(Account.me, user.map { Reply(json: $0) } ?? failed)
        api.on(Account.sessions, sessions.map { Reply(json: $0) } ?? failed)
        api.on(Account.factors, factors.map { Reply(json: $0) } ?? failed)
        api.on(Account.passkeys, passkeys.map { Reply(json: $0) } ?? failed)
        api.on(Wire.config, config)
    }

    /// A stage whose account was read.
    static func loaded(
        strings: TulaStrings = .english, sheet: ScriptedPasskeySheet? = nil, user: String? = Account.user(),
        sessions: String? = Account.twoSessions, factors: String? = Account.factors(),
        passkeys: String? = Account.passkeys([]), config: Reply = Account.config()
    ) async throws -> AccountStage {
        let stage = try await AccountStage(
            strings: strings, sheet: sheet, user: user, sessions: sessions, factors: factors, passkeys: passkeys,
            config: config)
        await stage.model.load()
        return stage
    }

    var isSignedIn: Bool {
        get async { await client.session.state.isSignedIn }
    }

    /// Everything the model shows or says, with what it holds of a setup: for a canary.
    var everything: String {
        var parts: [String] = [model.formError, model.status, model.notice].compactMap { $0 }
        parts += model.fieldErrors.values.flatMap { $0 }
        parts += heard.said
        parts += [model.setup?.key, model.setup?.uri].compactMap { $0 }
        parts += model.backupCodes
        parts += heard.copied
        return parts.joined(separator: "\n")
    }

    /// The step-up's answer: the session's tokens again, now carrying the proof.
    func acceptProof() {
        api.on(Account.stepUp, Reply(json: Wire.tokens))
    }

    /// Nothing secret is held: asserted after every change of panel and after `close()`.
    func assertNothingSecretIsHeld(_ when: String, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertEqual(model.password, "", "password, \(when)", file: file, line: line)
        XCTAssertEqual(model.currentPassword, "", "current password, \(when)", file: file, line: line)
        XCTAssertEqual(model.newPassword, "", "new password, \(when)", file: file, line: line)
        XCTAssertEqual(model.code, "", "code, \(when)", file: file, line: line)
        XCTAssertEqual(model.backupCode, "", "backup code, \(when)", file: file, line: line)
        XCTAssertNil(model.setup, "setup key, \(when)", file: file, line: line)
        XCTAssertEqual(model.backupCodes, [], "backup codes, \(when)", file: file, line: line)
        XCTAssertEqual(model.revealed, [], "revealed, \(when)", file: file, line: line)
    }
}
