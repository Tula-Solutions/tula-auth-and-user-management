import Foundation
import TulaAuth
import XCTest

@testable import TulaAuthUI

// What the tests of the screens' logic stand on: the real client on an API that is a table
// of answers, with its tokens in memory. No network, no Keychain, no view: what a view
// draws is the model, and the model is what is tested here. The screens themselves, on a
// simulator against the real API, are examples/swiftui/TulaExampleUITests.

/// One answer of the fake API.
struct Reply: Sendable {
    var status = 200
    var json = "{}"
    var headers: [String: String] = [:]

    /// An error whose own words are a canary: nothing a server wrote may reach a screen.
    static func error(_ status: Int, _ code: String, headers: [String: String] = [:]) -> Reply {
        Reply(
            status: status, json: #"{"status":\#(status),"code":"\#(code)","detail":"\#(Canary.serverText)"}"#,
            headers: headers)
    }
}

enum Canary {
    static let serverText = "SERVER-TEXT-CANARY"
    static let password = "Typed-Password-CANARY-1!"
}

/// A transport that answers from a table of routes. The answers of a route are given in
/// order and the last one stays until another is set. A route nobody set is a 404 the test did not ask for.
final class FakeAPI: TulaHTTPTransport, @unchecked Sendable {
    typealias Handler = @Sendable (URLRequest) async throws -> Reply

    private let lock = NSLock()
    private var handlers: [String: [Handler]] = [:]
    private var seen: [(route: String, request: URLRequest)] = []

    /// Routes whose last answer has been given: the next one set replaces it.
    private var served: Set<String> = []

    func on(_ route: String, _ handler: @escaping Handler) {
        lock.withLock {
            if served.remove(route) != nil {
                handlers[route] = [handler]
            } else {
                handlers[route, default: []].append(handler)
            }
        }
    }

    func on(_ route: String, _ reply: Reply) {
        on(route) { _ in reply }
    }

    var routes: [String] { lock.withLock { seen.map(\.route) } }

    func count(_ route: String) -> Int {
        lock.withLock { seen.filter { $0.route == route }.count }
    }

    func body(_ route: String, _ index: Int = 0) -> [String: Any] {
        let request = lock.withLock { seen.filter { $0.route == route }.map(\.request) }[index]
        guard let data = request.httpBody, let object = try? JSONSerialization.jsonObject(with: data) else {
            return [:]
        }
        return object as? [String: Any] ?? [:]
    }

    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let route = "\(request.httpMethod ?? "GET") \(request.url?.path ?? "")"
        let handler: Handler? = lock.withLock {
            seen.append((route, request))
            guard var queue = handlers[route], let first = queue.first else {
                return nil
            }
            if queue.count > 1 {
                queue.removeFirst()
                handlers[route] = queue
            } else {
                served.insert(route)
            }
            return first
        }
        let reply = try await handler?(request) ?? Reply.error(404, "request.unexpected_in_test")
        let response = HTTPURLResponse(
            url: request.url ?? URL(fileURLWithPath: "/"), statusCode: reply.status, httpVersion: "HTTP/1.1",
            headerFields: reply.headers)
        return (Data(reply.json.utf8), response ?? HTTPURLResponse())
    }
}

/// Something a test opens by hand: an answer that is held until the test lets it go.
final class Gate: @unchecked Sendable {
    private let lock = NSLock()
    private var isOpen = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func wait() async {
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            let through = lock.withLock {
                if !isOpen {
                    waiters.append(continuation)
                }
                return isOpen
            }
            if through {
                continuation.resume()
            }
        }
    }

    func open() {
        let waiting: [CheckedContinuation<Void, Never>] = lock.withLock {
            isOpen = true
            defer { waiters = [] }
            return waiters
        }
        for waiter in waiting {
            waiter.resume()
        }
    }
}

/// A token storage whose writes wait for a gate: a completed flow's session is then being
/// stored for as long as a test wants.
actor HeldStorage: TulaTokenStorage {
    private var values: [String: String] = [:]
    private(set) var writes = 0
    private let gate: Gate

    init(_ gate: Gate) { self.gate = gate }

    func get(_ key: String) async throws -> String? { values[key] }

    func set(_ key: String, _ value: String) async throws {
        writes += 1
        await gate.wait()
        values[key] = value
    }

    func remove(_ key: String) async throws { values[key] = nil }
}

/// What a storage that refuses throws: a Keychain that is locked, full or gone.
struct WriteRefused: Error {}

/// A token storage that refuses its first writes: the session of a flow that completed is
/// then in the client's memory and nowhere else.
actor RefusingStorage: TulaTokenStorage {
    private var values: [String: String] = [:]
    private(set) var refused = 0
    private var left: Int

    /// - Parameter writes: How many writes are refused before one is taken.
    init(refusing writes: Int = 1) { left = writes }

    func get(_ key: String) async throws -> String? { values[key] }

    func set(_ key: String, _ value: String) async throws {
        if left > 0 {
            left -= 1
            refused += 1
            throw WriteRefused()
        }
        values[key] = value
    }

    func remove(_ key: String) async throws { values[key] = nil }
}

/// The answers of the API, as the server writes them.
enum Wire {
    static let key = "tula_pk_test_0123456789abcdef"
    static let base = "https://auth.example.test"

    static let signIns = "POST /v1/client/sign-ins"
    static let signUps = "POST /v1/client/sign-ups"
    static let resets = "POST /v1/client/password-resets"
    static let password = "POST /v1/client/sign-ins/att_1/password"
    static let prepare = "POST /v1/client/sign-ins/att_1/first-factor/prepare"
    static let attempt = "POST /v1/client/sign-ins/att_1/first-factor/attempt"
    static let newPassword = "POST /v1/client/sign-ins/att_1/new-password"
    static let signInVerify = "POST /v1/client/sign-ins/att_1/verify-email"
    static let signUpVerify = "POST /v1/client/sign-ups/att_1/verify-email"
    static let signUpResend = "POST /v1/client/sign-ups/att_1/resend-code"
    static let resetSubmit = "POST /v1/client/password-resets/att_1/password"
    static let resetResend = "POST /v1/client/password-resets/att_1/resend-code"
    static let config = "GET /v1/client/config"

    static let needsPassword = #"{"status":"needs_password"}"#
    static let both = #"{"status":"needs_first_factor","strategies":["password","email_code"]}"#
    static let codeOnly = #"{"status":"needs_first_factor","strategies":["email_code"]}"#
    static let bothPrepared =
        #"{"status":"needs_first_factor","strategies":["password","email_code"],"prepared":{"strategy":"email_code","destination":"m***@example.com"}}"#
    static let codeOnlyPrepared =
        #"{"status":"needs_first_factor","strategies":["email_code"],"prepared":{"strategy":"email_code","destination":"m***@example.com"}}"#
    static let verification =
        #"{"status":"needs_email_verification","destination":"m***@example.com","strategies":["email_code"]}"#
    static let reset = #"{"status":"needs_new_password","destination":"m***@example.com","strategies":["email_code"]}"#
    static let expired =
        #"{"status":"needs_new_password","destination":"m***@example.com","strategies":[],"reason":"expired"}"#
    static let secondFactor = #"{"status":"needs_second_factor","options":["totp","backup_code"]}"#
    static let complete = #"{"status":"complete","userId":"usr_1","sessionId":"ses_1"}"#

    private static func base64url(_ text: String) -> String {
        Data(text.utf8).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    static let tokens: String = {
        let access = "\(base64url(#"{"alg":"EdDSA"}"#)).\(base64url(#"{"iat":1000,"exp":1060,"jti":"first"}"#)).signature"
        return
            #"{"sessionId":"ses_1","accessToken":"\#(access)","accessTokenExpiresAt":"2030-01-01T00:00:00.000Z","refreshToken":"refresh-first"}"#
    }()

    /// An attempt as a start answers it (with its secret) or a later step does (without).
    static func flow(_ kind: String, _ step: String, start: Bool = false) -> Reply {
        var json = #"{"id":"att_1","kind":"\#(kind)","expiresAt":"2030-01-01T00:00:00.000Z","step":\#(step)"#
        if start { json += #","attemptSecret":"attempt-secret-1""# }
        if step == complete { json += #","session":\#(tokens)"# }
        return Reply(json: json + "}")
    }

    static func config(name: String, signUpPassword: String) -> Reply {
        Reply(
            json:
                #"{"app":{"name":"\#(name)","supportEmail":null},"signIn":{"methods":["password"]},"signUp":{"password":"\#(signUpPassword)"},"password":{"preset":"recommended","minLength":10,"maxLength":128,"requireLowercase":false,"requireUppercase":false,"requireNumber":false,"requireSpecial":false,"minCharacterClasses":0,"specialChars":"!","disallowUserInfo":true,"disallowCommon":true,"breachCheck":"off","maxRepeatedChars":null,"blockSequences":false,"history":0,"expiryDays":null}}"#
        )
    }
}

/// What a model said to VoiceOver, and how often it reported a sign-in.
@MainActor
final class Heard {
    var said: [String] = []
    var signedIn = 0
    /// How often an account screen reported that nobody is signed in any more.
    var signedOut = 0
    /// What a model put on the pasteboard a test gave it: never the system's.
    var copied: [String] = []
}

/// A model on the fakes.
@MainActor
struct Stage {
    let api = FakeAPI()
    let client: TulaClient
    let model: TulaAuthModel
    let heard = Heard()

    init(
        mode: TulaAuthMode = .signIn, strings: TulaStrings = .english,
        storage: any TulaTokenStorage = MemoryTokenStorage(), passkeys: (any TulaPasskeySheet)? = nil,
        apple: (any TulaAppleSheet)? = nil, browser: (any TulaBrowserSession)? = nil,
        options: TulaAuthOptions = TulaAuthOptions()
    ) throws {
        // The sheets are scripted fakes (Sheets.swift) or nothing: no test shows one.
        client = try TulaClient(
            publishableKey: Wire.key, baseURL: Wire.base, storage: storage, transport: api, passkeys: passkeys,
            apple: apple, browser: browser)
        let heard = self.heard
        model = TulaAuthModel(
            client: client, mode: mode, strings: strings, options: options, announce: { heard.said.append($0) },
            copy: { heard.copied.append($0) }, onSignedIn: { heard.signedIn += 1 })
        api.on(
            "GET /v1/client/me",
            Reply(
                json:
                    #"{"id":"usr_1","email":"maya@example.com","emailVerifiedAt":"2026-01-01T00:00:00.000Z","firstName":null,"lastName":null,"bannedAt":null,"lastSignInAt":null,"createdAt":"2026-01-01T00:00:00.000Z","phoneNumber":null,"phoneNumberVerifiedAt":null,"hasPassword":true}"#
            ))
    }

    /// A sign-in that has reached the step `step`.
    func signIn(to step: String) async {
        api.on(Wire.signIns, Wire.flow("sign_in", step, start: true))
        model.email = "maya@example.com"
        await model.start()
    }

    var isSignedIn: Bool {
        get async { await client.session.state.isSignedIn }
    }

    /// Everything the model shows a person, in one string: for a canary.
    var shown: String {
        ([model.formError, model.status, model.notice] + model.fieldErrors.values.flatMap { $0 } + heard.said)
            .compactMap { $0 }.joined(separator: "\n")
    }
}

/// Wait until something another task does has happened.
@MainActor
func eventually(_ what: String, file: StaticString = #filePath, line: UInt = #line, _ holds: () async -> Bool) async {
    for _ in 0..<2_000 {
        if await holds() { return }
        try? await Task.sleep(nanoseconds: 2_000_000)
    }
    XCTFail("never happened: \(what)", file: file, line: line)
}
