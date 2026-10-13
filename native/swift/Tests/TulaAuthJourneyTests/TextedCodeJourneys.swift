import Foundation
import XCTest

@testable import TulaAuth

/// A text message the API "sent": the memory sender's outbox, read through the fixture.
struct SentText {
    let to: String
    let text: String
}

extension Server {
    /// Text messages to the United States, and nothing else of the section.
    static var smsOn: [String: Any] {
        ["enabled": true, "allowedCountries": ["US"], "dailyMessageLimit": 500, "templates": [String: Any]()]
    }

    /// The `sms` settings with something in another place.
    static func sms(_ change: [String: Any]) -> [String: Any] {
        smsOn.merging(change) { _, new in new }
    }

    /// The text messages the API sent, oldest first. The fixture answers once every message
    /// a sign-in asked for was handed over and its code can be used.
    func texts(to: String? = nil) async throws -> [SentText] {
        let query = to.map { "?to=\($0.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? "")" } ?? ""
        let list = try await control("GET", "sms", query: query) as? [[String: Any]] ?? []
        return list.map { SentText(to: $0["to"] as? String ?? "", text: $0["text"] as? String ?? "") }
    }

    /// The code in the newest text message to a number: the last run of exactly six digits,
    /// whatever the environment wrote around it.
    func textedCode(_ to: String, file: StaticString = #filePath, line: UInt = #line) async throws -> String {
        let text = try await texts(to: to).last?.text ?? ""
        let runs = try NSRegularExpression(pattern: "(?<![0-9])[0-9]{6}(?![0-9])")
            .matches(in: text, range: NSRange(text.startIndex..., in: text))
        guard let last = runs.last, let range = Range(last.range, in: text) else {
            XCTFail("no text message with a code was sent to that number", file: file, line: line)
            throw JourneyFailure("no text message with a code was sent to that number")
        }
        return String(text[range])
    }

    /// Replace the environment's settings through the admin API, as an operator does: read
    /// them, change sections, and save under the revision that was read.
    func replaceSettings(
        file: StaticString = #filePath, line: UInt = #line, _ change: (inout [String: Any]) -> Void
    ) async throws {
        let read = try await admin("GET", "/v1/admin/settings")
        var settings = read.object["settings"] as? [String: Any] ?? [:]
        change(&settings)
        let replaced = try await admin(
            "PUT", "/v1/admin/settings", settings, headers: ["if-match": read.etag ?? ""])
        XCTAssertEqual(replaced.status, 200, file: file, line: line)
    }

    /// Replace the environment's `sms` settings.
    func setSms(_ sms: [String: Any]) async throws {
        try await replaceSettings { $0["sms"] = sms }
    }

    /// Switch the texted sign-in code on or off, with the given `sms` settings.
    func setSmsSignIn(_ smsCode: Bool, sms: [String: Any] = Server.smsOn) async throws {
        try await replaceSettings { settings in
            var signIn = settings["signIn"] as? [String: Any] ?? [:]
            var methods = signIn["methods"] as? [String: Any] ?? [:]
            methods["smsCode"] = ["enabled": smsCode]
            signIn["methods"] = methods
            settings["signIn"] = signIn
            settings["sms"] = sms
        }
    }

    /// Offer a texted code as the second step (or stop), with text messages to the United States.
    func setSmsSecondStep(_ enabled: Bool, signInBySms: Bool = false) async throws {
        try await replaceSettings { settings in
            var signIn = settings["signIn"] as? [String: Any] ?? [:]
            var methods = signIn["methods"] as? [String: Any] ?? [:]
            methods["smsCode"] = ["enabled": signInBySms]
            signIn["methods"] = methods
            settings["signIn"] = signIn
            var mfa = settings["mfa"] as? [String: Any] ?? [:]
            mfa["smsCode"] = ["enabled": enabled]
            settings["mfa"] = mfa
            settings["sms"] = Server.smsOn
        }
    }

    /// A user with a proven phone number, a minute after its code was texted.
    func withNumber(_ number: String) async throws -> (app: App, email: String) {
        let account = try await signUp()
        _ = try await account.app.tula.phone.request(phoneNumber: number)
        _ = try await account.app.tula.phone.verify(code: try await textedCode(number))
        // A number is texted at most once a minute, whoever asks.
        try await advance(61)
        return account
    }

    /// A user whose second step is a texted code, a minute after its code was texted.
    func withSmsSecondStep(_ number: String) async throws -> (app: App, email: String) {
        let account = try await withNumber(number)
        _ = try await account.app.tula.factors.startSms()
        _ = try await account.app.tula.factors.confirmSms(code: try await textedCode(number))
        try await advance(61)
        return account
    }
}

extension Journey {
    /// A code that differs from this one in its last digit.
    static func wrongCode(_ code: String) -> String {
        let last = Int(String(code.last ?? "0")) ?? 0
        return String(code.dropLast()) + String((last + 1) % 10)
    }

    /// A time as the API writes one.
    static func time(_ text: String) -> Date? {
        let format = ISO8601DateFormatter()
        format.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return format.date(from: text)
    }
}

// The Swift client against the real API: a phone number on an account, the limits of text
// messages as an app meets them, a sign-in with a texted code, and a texted code as the
// second step (ADR 0037, ADR 0025). Every code is read from the fixture's memory sender;
// no message leaves the machine.
final class TextedCodeJourneys: JourneyTestCase {
    private let choice: [FirstFactorStrategy] = [.password, .smsCode]

    /// The first-factor step of a sign-in, or a failure that says where it is instead.
    private func firstFactor(
        _ step: FlowStep, file: StaticString = #filePath, line: UInt = #line
    ) throws -> FlowStepNeedsFirstFactor {
        guard case .needsFirstFactor(let value) = step else {
            XCTFail("the sign-in is at \(step.status), not at the first factor", file: file, line: line)
            throw JourneyFailure("not at the first factor")
        }
        return value
    }

    private func secondFactor(
        _ step: FlowStep, file: StaticString = #filePath, line: UInt = #line
    ) throws -> FlowStepNeedsSecondFactor {
        guard case .needsSecondFactor(let value) = step else {
            XCTFail("the sign-in is at \(step.status), not at the second factor", file: file, line: line)
            throw JourneyFailure("not at the second factor")
        }
        return value
    }

    // MARK: A phone number on an account

    func testPhoneNumberOnAnAccount() async throws {
        try await journey(
            "phone number on an account",
            "a signed-in user adds a phone number with a texted code, and removes it; every refusal is a code the app can show"
        ) { s in
            let number = "+12025550142"
            let (app, _) = try await s.signUp()
            let (other, _) = try await s.signUp()

            // Off by default: the config says so, and asking is refused.
            let off = try await app.tula.config()
            XCTAssertEqual(off.phone, ClientConfigPhone(enabled: false))
            var refused = try await caught { try await app.tula.phone.request(phoneNumber: number) }
            XCTAssertEqual(refused.code, "sms.disabled")
            // On with no country allowed is still off.
            try await s.setSms(Server.sms(["allowedCountries": [String]()]))
            refused = try await caught { try await app.tula.phone.request(phoneNumber: number) }
            XCTAssertEqual(refused.code, "sms.disabled")
            var sent = try await s.texts()
            XCTAssertEqual(sent.count, 0)

            try await s.setSms(Server.smsOn)
            // A client made after the change reads the config as it is now, and not which countries.
            let config = try await s.client().tula.config()
            XCTAssertEqual(config.phone, ClientConfigPhone(enabled: true))
            let configs = try await s.exchanges("/v1/client/config")
            XCTAssertFalse(configs.contains { $0.responseBody.contains("allowedCountries") })

            refused = try await caught { try await app.tula.phone.request(phoneNumber: "555-0142") }
            XCTAssertEqual(refused.code, "phone.invalid")
            refused = try await caught { try await app.tula.phone.request(phoneNumber: "+4915112345678") }
            XCTAssertEqual(refused.code, "sms.country_not_allowed")
            sent = try await s.texts()
            XCTAssertEqual(sent.count, 0)

            // The number as a person types it; the receipt holds neither the number nor the code.
            let receipt = try await app.tula.phone.request(phoneNumber: "+1 (202) 555-0142")
            XCTAssertEqual(receipt.destination, "***42")
            let now = try await s.serverNow()
            XCTAssertGreaterThan(try unwrap(Journey.time(receipt.expiresAt)), now)
            let code = try await s.textedCode(number)
            let asked = try await s.exchanges("/v1/client/me/phone")
            XCTAssertFalse(asked.contains { $0.responseBody.contains(code) })
            refused = try await caught { try await app.tula.phone.request(phoneNumber: number) }
            XCTAssertEqual(refused.code, "rate_limited")
            // Pending is not the account's: nothing has changed yet.
            var user = try await app.tula.user()
            XCTAssertNil(user.phoneNumber)

            // Another user's code, a wrong one, the right one, and the right one again.
            refused = try await caught { try await other.tula.phone.verify(code: code) }
            XCTAssertEqual(refused.code, "verification.expired")
            refused = try await caught { try await app.tula.phone.verify(code: Journey.wrongCode(code)) }
            XCTAssertEqual(refused.code, "verification.invalid_code")
            user = try await app.tula.phone.verify(code: code)
            XCTAssertEqual(user.phoneNumber, number)
            XCTAssertNotNil(user.phoneNumberVerifiedAt)
            // The state shows it without another request.
            var state = await app.state()
            XCTAssertTrue(state.isSignedIn)
            XCTAssertEqual(state.user?.phoneNumber, number)
            refused = try await caught { try await app.tula.phone.verify(code: code) }
            XCTAssertEqual(refused.code, "verification.expired")
            var others = try await other.tula.user()
            XCTAssertNil(others.phoneNumber)

            // A code asked for before the country was removed, or SMS switched off, is not
            // honoured after.
            _ = try await other.tula.phone.request(phoneNumber: "+12025550143")
            let pending = try await s.textedCode("+12025550143")
            try await s.setSms(Server.sms(["allowedCountries": ["DE"]]))
            refused = try await caught { try await other.tula.phone.verify(code: pending) }
            XCTAssertEqual(refused.code, "sms.country_not_allowed")
            try await s.setSms(Server.sms(["enabled": false, "allowedCountries": ["DE"]]))
            refused = try await caught { try await other.tula.phone.verify(code: pending) }
            XCTAssertEqual(refused.code, "sms.disabled")
            others = try await other.tula.user()
            XCTAssertNil(others.phoneNumber)

            // Removing needs no text message, so it works with SMS off, and twice.
            try await app.tula.phone.remove()
            state = await app.state()
            XCTAssertTrue(state.isSignedIn)
            XCTAssertNotNil(state.user)
            XCTAssertNil(state.user?.phoneNumber)
            XCTAssertNil(state.user?.phoneNumberVerifiedAt)
            user = try await app.tula.user()
            XCTAssertNil(user.phoneNumber)
            try await app.tula.phone.remove()

            // No request of the client carried the number anywhere but the body that asked for it.
            let carrying = try await s.exchanges().filter { exchange in
                exchange.requestBody.contains("5550142") || exchange.headers.values.contains { $0.contains("5550142") }
                    || exchange.path.contains("5550142")
            }
            XCTAssertFalse(carrying.isEmpty)
            XCTAssertEqual(Set(carrying.map { "\($0.method) \($0.path)" }), ["POST /v1/client/me/phone"])
        }
    }

    func testAPhoneNumberChangePastTheStepUpWindow() async throws {
        try await journey(
            "phone number on an account",
            "a phone number change past the step-up window asks for a step-up, and works after it"
        ) { s in
            try await s.setSms(Server.smsOn)
            let (app, _) = try await s.signUp()
            try await s.advance(11 * 60)
            let error = try await caught { try await app.tula.phone.request(phoneNumber: "+12025550142") }
            XCTAssertEqual(error.code, "auth.step_up_required")
            XCTAssertTrue(error.stepUpMethods.contains("password"))
            let sent = try await s.texts()
            XCTAssertEqual(sent.count, 0)
            let removal = try await caught { try await app.tula.phone.remove() }
            XCTAssertEqual(removal.code, "auth.step_up_required")
            try await app.tula.stepUp.withPassword(Journey.password)
            let receipt = try await app.tula.phone.request(phoneNumber: "+12025550142")
            XCTAssertEqual(receipt.destination, "***42")
        }
    }

    // MARK: What a text message may cost

    func testTextMessagesToABlockedDestination() async throws {
        try await journey(
            "text messages to a blocked destination",
            "a number outside the country list is a code the app can show, however often it is asked, and costs the user nothing"
        ) { s in
            try await s.setSms(Server.smsOn)
            let (app, _) = try await s.signUp()
            for phoneNumber in ["+37120000042", "+37120000042", "+371 2000 0043", "+99912345678"] {
                let error = try await caught { try await app.tula.phone.request(phoneNumber: phoneNumber) }
                XCTAssertEqual(error.code, "sms.country_not_allowed")
                XCTAssertEqual(error.status, 422)
            }
            var sent = try await s.texts()
            XCTAssertEqual(sent.count, 0)
            // Nothing of the user's own allowance was spent by the refusals.
            let receipt = try await app.tula.phone.request(phoneNumber: "+12025550142")
            XCTAssertEqual(receipt.destination, "***42")
            sent = try await s.texts()
            XCTAssertEqual(sent.map(\.to), ["+12025550142"])
            let user = try await app.tula.phone.verify(code: try await s.textedCode("+12025550142"))
            XCTAssertEqual(user.phoneNumber, "+12025550142")
        }
    }

    func testTextMessagesPastTheDailyLimit() async throws {
        try await journey(
            "text messages past the daily limit",
            "past the environment’s daily limit a request is rate limited, with a wait that ends with the day"
        ) { s in
            try await s.setSms(Server.sms(["allowedCountries": ["US", "GB"]]))
            let (app, _) = try await s.signUp()
            let (other, _) = try await s.signUp()
            _ = try await app.tula.phone.request(phoneNumber: "+12025550142")
            let code = try await s.textedCode("+12025550142")
            // The day is spent from here on. An hour later the hourly limits are open again, so
            // what refuses is the day's own count.
            try await s.setSms(Server.sms(["allowedCountries": ["US", "GB"], "dailyMessageLimit": 1]))
            try await s.advance(61 * 60)
            try await other.tula.stepUp.withPassword(Journey.password)
            let now = Int((try await s.serverNow().timeIntervalSince1970 * 1000).rounded())
            let error = try await caught { try await other.tula.phone.request(phoneNumber: "+447700900142") }
            XCTAssertEqual(error.code, "rate_limited")
            XCTAssertEqual(error.status, 429)
            // The wait ends with the UTC day, and the answer names no limit.
            let untilTheDayEnds = (Double(86_400_000 - now % 86_400_000) / 1000).rounded(.up)
            XCTAssertEqual(error.retryAfter, untilTheDayEnds)
            XCTAssertEqual(Array(error.params.keys), ["retryAfter"])
            let abroad = try await s.texts(to: "+447700900142")
            XCTAssertEqual(abroad.count, 0)
            var sent = try await s.texts()
            XCTAssertEqual(sent.count, 1)
            let others = try await other.tula.user()
            XCTAssertNil(others.phoneNumber)
            // The client is told only whether a number can be added.
            let config = try await s.client().tula.config()
            XCTAssertEqual(config.phone, ClientConfigPhone(enabled: true))
            // A code is good for ten minutes: the one from before the limit was spent an hour ago
            // has expired, and a new one cannot be had today.
            try await app.tula.stepUp.withPassword(Journey.password)
            let expired = try await caught { try await app.tula.phone.verify(code: code) }
            XCTAssertEqual(expired.code, "verification.expired")
            let spent = try await caught { try await app.tula.phone.request(phoneNumber: "+12025550142") }
            XCTAssertEqual(spent.code, "rate_limited")
            sent = try await s.texts()
            XCTAssertEqual(sent.count, 1)
        }
    }

    func testTextMessageWording() async throws {
        try await journey(
            "text message wording",
            "text message wording: a phone number is proven with the code from a text in the environment’s own words, and nothing of the built-in text"
        ) { s in
            let number = "+12025550142"
            try await s.setSms(
                Server.sms(["templates": ["phone_verification": ["text": "Welcome to {{appName}}. Use {{code}} now"]]]))
            let (app, _) = try await s.signUp()
            _ = try await app.tula.phone.request(phoneNumber: number)

            // Nothing of the client reads a message: the code is the last run of six digits,
            // whatever the environment wrote around it.
            let code = try await s.textedCode(number)
            let text = try await s.texts(to: number).last?.text
            // This environment has no origin, so there is no last line and the sentence is all.
            XCTAssertEqual(text, "Welcome to Tula. Use \(code) now")

            let user = try await app.tula.phone.verify(code: code)
            XCTAssertEqual(user.phoneNumber, number)
        }
    }

    // MARK: Signing in with a texted code

    func testSignInWithATextedCode() async throws {
        try await journey(
            "sign in with a texted code",
            "a sign-in started with a phone number is proven with the texted code; the session says `sms`, and is not a recent authentication"
        ) { s in
            let number = "+12025550143"
            try await s.setSmsSignIn(true)
            let config = try await s.client().tula.config()
            XCTAssertTrue(config.signIn.methods.contains("smsCode"))
            let owner = try await s.withNumber(number)
            let ownerId = try await owner.app.tula.user().id

            let app = try s.client()
            // The number as a person types it.
            let flow = try await app.tula.startSignIn(identifier: "+1 (202) 555-0143")
            let offered = try self.firstFactor(flow.step)
            XCTAssertEqual(offered.strategies, self.choice)
            XCTAssertNil(offered.prepared)
            guard case .firstFactor = flow.screen else {
                return XCTFail("a texted code is a way this client has")
            }
            let before = try await s.texts().count
            let prepared = try self.firstFactor(try await flow.prepareSmsCode())
            XCTAssertEqual(prepared.strategies, self.choice)
            XCTAssertEqual(
                prepared.prepared, FlowStepNeedsFirstFactorPrepared(strategy: .smsCode, destination: "***43"))
            // The message is sent apart from the answer, so that its sending says nothing.
            let after = try await s.texts().count
            XCTAssertEqual(after, before + 1)
            let code = try await s.textedCode(number)
            let asked = try await s.exchanges("/v1/client/sign-ins/\(flow.id)/first-factor/prepare")
            XCTAssertEqual(asked.count, 1)
            XCTAssertFalse(asked.contains { $0.responseBody.contains(code) })
            let again = try await caught { try await flow.prepareSmsCode() }
            XCTAssertEqual(again.code, "rate_limited")
            XCTAssertEqual(again.status, 429)

            let refused = try await caught { try await flow.attemptSmsCode(Journey.wrongCode(code)) }
            XCTAssertEqual(refused.code, "auth.invalid_credentials")
            XCTAssertEqual(refused.status, 401)
            XCTAssertTrue(refused.params.isEmpty)
            var state = await app.state()
            XCTAssertFalse(state.isSignedIn)

            let step = try await flow.attemptSmsCode(code)
            guard case .complete(let done) = step else {
                return XCTFail("the sign-in is at \(step.status), not complete")
            }
            XCTAssertEqual(done.userId, ownerId)
            state = await app.state()
            XCTAssertTrue(state.isSignedIn)
            let amr = try await app.amr()
            XCTAssertEqual(amr, ["sms"])

            // A phone number alone is not a recent authentication, and no way to step up.
            let stepUp = try await caught { try await app.tula.phone.remove() }
            XCTAssertEqual(stepUp.code, "auth.step_up_required")
            XCTAssertEqual(stepUp.stepUpMethods, ["password", "email_code"])
            let user = try await app.tula.user()
            XCTAssertEqual(user.phoneNumber, number)
        }
    }

    func testATextedSignInCodeForAnUnknownNumber() async throws {
        try await journey(
            "a texted sign-in code for an unknown number",
            "asking for a texted code answers the same for a number nobody holds, and sends nothing; every guess is the generic failure"
        ) { s in
            try await s.setSmsSignIn(true, sms: Server.sms(["allowedCountries": ["US", "FR"]]))

            let app = try s.client()
            let flow = try await app.tula.startSignIn(identifier: "+33639980142")
            let offered = try self.firstFactor(flow.step)
            XCTAssertEqual(offered.strategies, self.choice)
            XCTAssertNil(offered.prepared)
            let prepared = try self.firstFactor(try await flow.prepareSmsCode())
            XCTAssertEqual(prepared.strategies, self.choice)
            XCTAssertEqual(
                prepared.prepared, FlowStepNeedsFirstFactorPrepared(strategy: .smsCode, destination: "***42"))
            let again = try await caught { try await flow.prepareSmsCode() }
            XCTAssertEqual(again.code, "rate_limited")
            var sent = try await s.texts()
            XCTAssertEqual(sent.count, 0)
            let usage = try await s.admin("GET", "/v1/admin/sms/usage?days=1")
            XCTAssertEqual(usage.status, 200)
            let counted = String(
                decoding: try JSONSerialization.data(withJSONObject: try unwrap(usage.json), options: [.fragmentsAllowed]),
                as: UTF8.self)
            XCTAssertFalse(counted.contains("+33"))
            for guess in ["000000", "123456"] {
                let refused = try await caught { try await flow.attemptSmsCode(guess) }
                XCTAssertEqual(refused.code, "auth.invalid_credentials")
                XCTAssertEqual(refused.status, 401)
            }

            // An address that asks for a texted code is an unknown number.
            let byEmail = try await s.client().tula.startSignIn(identifier: s.freshEmail())
            let masked = try self.firstFactor(try await byEmail.prepareSmsCode())
            XCTAssertEqual(masked.prepared, FlowStepNeedsFirstFactorPrepared(strategy: .smsCode, destination: "***"))
            let guessed = try await caught { try await byEmail.attemptSmsCode("000000") }
            XCTAssertEqual(guessed.code, "auth.invalid_credentials")

            // A country that is not on the list is refused, whoever holds the number.
            let abroad = try await s.client().tula.startSignIn(identifier: "+4915112345678")
            let blocked = try await caught { try await abroad.prepareSmsCode() }
            XCTAssertEqual(blocked.code, "sms.country_not_allowed")
            sent = try await s.texts()
            XCTAssertEqual(sent.count, 0)
            let state = await app.state()
            XCTAssertFalse(state.isSignedIn)
        }
    }

    func testATextedSignInCodeAfterTheMethodIsSwitchedOff() async throws {
        try await journey(
            "a texted sign-in code after the method is switched off",
            "a code texted while the method was on is refused once the method, text messages or the country is off, and works again when they are back"
        ) { s in
            let number = "+12025550144"
            try await s.setSmsSignIn(true)
            _ = try await s.withNumber(number)

            let app = try s.client()
            let flow = try await app.tula.startSignIn(identifier: number)
            try await flow.prepareSmsCode()
            let code = try await s.textedCode(number)
            let sent = try await s.texts().count

            try await s.setSmsSignIn(false)
            var refused = try await caught { try await flow.attemptSmsCode(code) }
            XCTAssertEqual(refused.code, "auth.method_disabled")
            XCTAssertEqual(refused.status, 403)
            refused = try await caught { try await flow.prepareSmsCode() }
            XCTAssertEqual(refused.code, "auth.method_disabled")
            let later = try await s.client().tula.startSignIn(identifier: number)
            // With the password the only method left, the step is the password's own.
            XCTAssertEqual(later.step.status, "needs_password")
            XCTAssertEqual(later.screen, .password)

            try await s.setSmsSignIn(true, sms: Server.sms(["enabled": false]))
            refused = try await caught { try await flow.attemptSmsCode(code) }
            XCTAssertEqual(refused.code, "sms.disabled")
            try await s.setSmsSignIn(true, sms: Server.sms(["allowedCountries": ["DE"]]))
            refused = try await caught { try await flow.attemptSmsCode(code) }
            XCTAssertEqual(refused.code, "sms.country_not_allowed")
            let still = try await s.texts().count
            XCTAssertEqual(still, sent)
            let state = await app.state()
            XCTAssertFalse(state.isSignedIn)

            // Nothing was used up by the refusals.
            try await s.setSmsSignIn(true)
            let step = try await flow.attemptSmsCode(code)
            XCTAssertEqual(step.status, "complete")
            let amr = try await app.amr()
            XCTAssertEqual(amr, ["sms"])
        }
    }

    // MARK: A texted code as the second step

    func testATextedCodeAsTheSecondFactor() async throws {
        try await journey(
            "a texted code as the second factor",
            "a user with a proven number enrols a texted code, signs in with password and code, steps up with one, and is not let through once the option is off"
        ) { s in
            let number = "+12025550145"
            try await s.setSmsSecondStep(true)
            let config = try await s.client().tula.config()
            XCTAssertEqual(config.mfa, ClientConfigMfa(policy: .optional, smsCode: true))

            // Without a number nothing is offered, and asking is refused.
            let (bare, _) = try await s.signUp()
            let none = try await bare.tula.factors.get()
            XCTAssertEqual(none.sms, FactorsSms(enabled: false, enabledAt: nil, inUse: false, available: false))
            var refused = try await caught { try await bare.tula.factors.startSms() }
            XCTAssertEqual(refused.code, "mfa.phone_number_required")
            XCTAssertEqual(refused.status, 409)

            let owner = try await s.withNumber(number)
            let ownerId = try await owner.app.tula.user().id
            var factors = try await owner.app.tula.factors.get()
            XCTAssertEqual(factors.sms?.enabled, false)
            XCTAssertEqual(factors.sms?.available, true)
            let before = try await s.texts().count
            let receipt = try await owner.app.tula.factors.startSms()
            XCTAssertEqual(receipt.method, "sms_code")
            XCTAssertEqual(receipt.destination, "***45")
            XCTAssertNotNil(Journey.time(receipt.expiresAt))
            var sent = try await s.texts().count
            XCTAssertEqual(sent, before + 1)
            let enrolCode = try await s.textedCode(number)
            refused = try await caught { try await owner.app.tula.factors.confirmSms(code: Journey.wrongCode(enrolCode)) }
            XCTAssertEqual(refused.code, "mfa.invalid_code")
            XCTAssertEqual(refused.status, 422)
            factors = try await owner.app.tula.factors.get()
            XCTAssertEqual(factors.sms?.enabled, false)
            let refreshes = try await s.refreshes().count
            factors = try await owner.app.tula.factors.confirmSms(code: enrolCode)
            XCTAssertEqual(factors.sms?.enabled, true)
            XCTAssertEqual(factors.sms?.inUse, true)
            XCTAssertEqual(factors.sms?.available, false)
            XCTAssertFalse(factors.totp.enabled)
            // The client refreshed: its token says the step was proven, and never `mfa`.
            let refreshed = try await s.refreshes().count
            XCTAssertEqual(refreshed, refreshes + 1)
            var amr = try await owner.app.amr()
            XCTAssertEqual(amr, ["email", "sms"])
            refused = try await caught { try await owner.app.tula.factors.startSms() }
            XCTAssertEqual(refused.code, "mfa.already_enabled")

            // Sign-in: the password is not enough, and nothing is texted until the client asks.
            try await s.advance(61)
            sent = try await s.texts().count
            let (app, flow, step) = try await s.signIn(owner.email)
            let asked = try self.secondFactor(step)
            XCTAssertEqual(asked.options, [.smsCode])
            XCTAssertNil(asked.prepared)
            guard case .secondFactor = flow.screen else {
                return XCTFail("a texted code is a second factor this client can ask for")
            }
            var state = await app.state()
            XCTAssertFalse(state.isSignedIn)
            var texted = try await s.texts().count
            XCTAssertEqual(texted, sent)
            refused = try await caught { try await flow.submitSmsCode(enrolCode) }
            XCTAssertEqual(refused.code, "mfa.invalid_code")
            XCTAssertEqual(refused.status, 422)

            let prepared = try self.secondFactor(try await flow.prepareSmsSecondFactor())
            XCTAssertEqual(prepared.options, [.smsCode])
            XCTAssertEqual(prepared.prepared, FlowStepNeedsSecondFactorPrepared(method: .smsCode, destination: "***45"))
            texted = try await s.texts().count
            XCTAssertEqual(texted, sent + 1)
            let code = try await s.textedCode(number)
            let prepares = try await s.exchanges("/v1/client/sign-ins/\(flow.id)/second-factor/prepare")
            XCTAssertEqual(prepares.count, 1)
            XCTAssertFalse(prepares.contains { $0.responseBody.contains(code) })
            refused = try await caught { try await flow.prepareSmsSecondFactor() }
            XCTAssertEqual(refused.code, "rate_limited")
            XCTAssertEqual(refused.status, 429)
            let done = try await flow.submitSmsCode(code)
            guard case .complete(let completed) = done else {
                return XCTFail("the sign-in is at \(done.status), not complete")
            }
            XCTAssertEqual(completed.userId, ownerId)
            state = await app.state()
            XCTAssertTrue(state.isSignedIn)
            amr = try await app.amr()
            XCTAssertEqual(amr, ["pwd", "sms"])

            // Past the step-up window a sensitive call asks for the texted code again, and
            // nothing is texted until the client asks for that either.
            try await s.advance(11 * 60)
            let stale = try await caught { try await app.tula.factors.startTotp() }
            XCTAssertEqual(stale.code, "auth.step_up_required")
            XCTAssertEqual(stale.stepUpMethods, ["sms_code"])
            texted = try await s.texts().count
            XCTAssertEqual(texted, sent + 1)
            let stepUp = try await app.tula.stepUp.sendSmsCode()
            XCTAssertEqual(stepUp.method, "sms_code")
            XCTAssertEqual(stepUp.destination, "***45")
            texted = try await s.texts().count
            XCTAssertEqual(texted, sent + 2)
            let stepUpCode = try await s.textedCode(number)
            refused = try await caught { try await app.tula.stepUp.withSmsCode(Journey.wrongCode(stepUpCode)) }
            XCTAssertEqual(refused.code, "mfa.invalid_code")
            // The sign-in's code is no step-up code.
            XCTAssertNotEqual(stepUpCode, code)
            try await app.tula.stepUp.withSmsCode(stepUpCode)
            state = await app.state()
            XCTAssertTrue(state.isSignedIn)
            amr = try await app.amr()
            XCTAssertEqual(amr, ["pwd", "sms"])

            // Switched off: the step is still asked for, and can be neither sent nor proven.
            try await s.setSmsSecondStep(false)
            let later = try await s.signIn(owner.email)
            let still = try self.secondFactor(later.step)
            XCTAssertEqual(still.options, [.smsCode])
            XCTAssertNil(still.prepared)
            refused = try await caught { try await later.flow.prepareSmsSecondFactor() }
            XCTAssertEqual(refused.code, "auth.method_disabled")
            XCTAssertEqual(refused.status, 403)
            refused = try await caught { try await later.flow.submitSmsCode(stepUpCode) }
            XCTAssertEqual(refused.code, "auth.method_disabled")
            XCTAssertEqual(refused.status, 403)
            state = await later.app.state()
            XCTAssertFalse(state.isSignedIn)
            texted = try await s.texts().count
            XCTAssertEqual(texted, sent + 2)

            // The session that proved it removes it; the number stays, and the password signs in.
            try await app.tula.factors.disableSms()
            factors = try await app.tula.factors.get()
            XCTAssertEqual(factors.sms?.enabled, false)
            let user = try await app.tula.user()
            XCTAssertEqual(user.phoneNumber, number)
            let plain = try await s.signIn(owner.email)
            XCTAssertEqual(plain.step.status, "complete")
        }
    }

    func testATextedCodeIsNeverUsedBesideAnAuthenticatorApp() async throws {
        try await journey(
            "a texted code is never used beside an authenticator app",
            "a user with an authenticator app cannot enrol a texted code, and their sign-in never offers one"
        ) { s in
            let number = "+12025550146"
            try await s.setSmsSecondStep(true)
            let owner = try await s.withNumber(number)
            let secret = try await owner.app.tula.factors.startTotp().secret
            _ = try await owner.app.tula.factors.confirmTotp(code: try await s.totp(secret))
            let sent = try await s.texts().count

            let factors = try await owner.app.tula.factors.get()
            XCTAssertEqual(factors.sms?.enabled, false)
            XCTAssertEqual(factors.sms?.inUse, false)
            XCTAssertEqual(factors.sms?.available, false)
            var refused = try await caught { try await owner.app.tula.factors.startSms() }
            XCTAssertEqual(refused.code, "mfa.sms_not_allowed")
            XCTAssertEqual(refused.status, 409)
            refused = try await caught { try await owner.app.tula.factors.confirmSms(code: "123456") }
            XCTAssertEqual(refused.code, "mfa.sms_not_allowed")

            let (app, flow, step) = try await s.signIn(owner.email)
            let asked = try self.secondFactor(step)
            XCTAssertEqual(asked.options, [.totp, .backupCode])
            XCTAssertNil(asked.prepared)
            // The server's own refusal (a 409), not the client's: the request was made.
            refused = try await caught { try await flow.prepareSmsSecondFactor() }
            XCTAssertEqual(refused.code, "flow.invalid_step")
            XCTAssertEqual(refused.status, 409)
            refused = try await caught { try await flow.submitSmsCode("123456") }
            XCTAssertEqual(refused.code, "flow.invalid_step")
            XCTAssertEqual(refused.status, 409)
            let state = await app.state()
            XCTAssertFalse(state.isSignedIn)
            let texted = try await s.texts().count
            XCTAssertEqual(texted, sent)

            // The attempt is unharmed: the authenticator's next code completes it, as `mfa`.
            try await s.advance(Totp.step)
            let done = try await flow.submitTotp(try await s.totp(secret))
            XCTAssertEqual(done.status, "complete")
            let amr = try await app.amr()
            XCTAssertEqual(amr, ["mfa", "otp", "pwd"])
        }
    }

    func testATextedSignInCodeIsNotCompletedByATextedSecondStep() async throws {
        try await journey(
            "a texted sign-in code is not completed by a texted second step",
            "a sign-in started with the phone number is refused for a user whose second step is a texted code; with the password it asks for the code"
        ) { s in
            let number = "+12025550147"
            try await s.setSmsSecondStep(true, signInBySms: true)
            let owner = try await s.withSmsSecondStep(number)

            let app = try s.client()
            let flow = try await app.tula.startSignIn(identifier: number)
            try await flow.prepareSmsCode()
            let code = try await s.textedCode(number)
            let sent = try await s.texts().count
            var refused = try await caught { try await flow.attemptSmsCode(code) }
            XCTAssertEqual(refused.code, "mfa.needs_other_sign_in")
            XCTAssertEqual(refused.status, 403)
            let state = await app.state()
            XCTAssertFalse(state.isSignedIn)
            // Not moved to a second step: there is no second text to ask for.
            XCTAssertEqual(flow.step.status, "needs_first_factor")
            refused = try await caught { try await flow.prepareSmsSecondFactor() }
            XCTAssertEqual(refused.code, "flow.invalid_step")
            let texted = try await s.texts().count
            XCTAssertEqual(texted, sent)

            let byPassword = try await s.signIn(owner.email)
            let asked = try self.secondFactor(byPassword.step)
            XCTAssertEqual(asked.options, [.smsCode])
            XCTAssertNil(asked.prepared)
            let other = await byPassword.app.state()
            XCTAssertFalse(other.isSignedIn)
        }
    }
}
