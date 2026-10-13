import Foundation
import XCTest

@testable import TulaAuth

// What the unit tests of the client stand on: an API that is a table of answers, a storage
// that can be told to fail, a clock that is moved by hand. No network, no Keychain, no
// process. The client against the real API is Tests/TulaAuthJourneyTests.

/// One answer of the fake API.
struct Reply: Sendable {
    var status = 200
    var json = "{}"
    var headers: [String: String] = [:]

    static func error(_ status: Int, _ code: String, headers: [String: String] = [:]) -> Reply {
        Reply(status: status, json: #"{"status":\#(status),"code":"\#(code)","detail":"server text"}"#, headers: headers)
    }
}

/// A transport that answers from a table of routes (`"POST /v1/client/sign-ins"`). The
/// answers of a route are given in order and the last one stays until another is set. A route nobody set is a 404
/// the test did not ask for, and is counted.
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

    /// Every later request of the route gets this answer, whatever was queued.
    func always(_ route: String, _ handler: @escaping Handler) {
        lock.withLock {
            served.remove(route)
            handlers[route] = [handler]
        }
    }

    var requests: [URLRequest] { lock.withLock { seen.map(\.request) } }
    var routes: [String] { lock.withLock { seen.map(\.route) } }

    func count(_ route: String) -> Int {
        lock.withLock { seen.filter { $0.route == route }.count }
    }

    func requests(_ route: String) -> [URLRequest] {
        lock.withLock { seen.filter { $0.route == route }.map(\.request) }
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
            url: request.url ?? URL(fileURLWithPath: "/"),
            statusCode: reply.status,
            httpVersion: "HTTP/1.1",
            headerFields: reply.headers
        )
        return (Data(reply.json.utf8), response ?? HTTPURLResponse())
    }
}

/// Something a test opens by hand. It does not stop waiting when its task is cancelled, on
/// purpose: a transport that ignores cancellation is what the client's deadline has to beat.
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

/// A clock a test moves.
final class FakeClock: TulaClock, @unchecked Sendable {
    private let lock = NSLock()
    private var time = Date(timeIntervalSince1970: 1_800_000_000)

    func now() -> Date { lock.withLock { time } }
    func advance(_ seconds: TimeInterval) { lock.withLock { time = time.addingTimeInterval(seconds) } }
}

struct StorageFailure: Error {}

/// A token storage that fails when told to, and counts what it was asked.
actor FakeStorage: TulaTokenStorage {
    private(set) var values: [String: String] = [:]
    private(set) var reads = 0
    private var failing: Set<String> = []

    func fail(_ calls: String...) { failing = Set(calls) }
    func put(_ key: String, _ value: String) { values[key] = value }
    var only: String? { values.count == 1 ? values.values.first : nil }

    func get(_ key: String) async throws -> String? {
        reads += 1
        if failing.contains("get") { throw StorageFailure() }
        return values[key]
    }

    func set(_ key: String, _ value: String) async throws {
        if failing.contains("set") { throw StorageFailure() }
        values[key] = value
    }

    func remove(_ key: String) async throws {
        if failing.contains("remove") { throw StorageFailure() }
        values[key] = nil
    }
}

enum Fixture {
    static let key = "tula_pk_test_0123456789abcdef"
    static let base = "https://auth.example.test"
    /// The entry the client keeps its refresh token under.
    static let storageKey = "tula.refresh.\(base)|\(key)"

    static let refresh = "POST /v1/client/sessions/refresh"
    static let signOut = "POST /v1/client/sessions/sign-out"
    static let me = "GET /v1/client/me"

    static func base64url(_ text: String) -> String {
        Data(text.utf8).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    /// A token with the shape of an access token: only `iat`, `exp` and a name are read.
    static func accessToken(_ name: String, lifetime: Int = 60) -> String {
        let payload = #"{"iat":1000,"exp":\#(1000 + lifetime),"jti":"\#(name)"}"#
        return "\(base64url(#"{"alg":"EdDSA"}"#)).\(base64url(payload)).signature-\(name)"
    }

    static func tokens(_ name: String, session: String = "ses_1", lifetime: Int = 60) -> String {
        #"{"sessionId":"\#(session)","accessToken":"\#(accessToken(name, lifetime: lifetime))","accessTokenExpiresAt":"2030-01-01T00:00:00.000Z","refreshToken":"refresh-\#(name)"}"#
    }

    static let user =
        #"{"id":"usr_1","email":"maya@example.com","emailVerifiedAt":"2026-01-01T00:00:00.000Z","firstName":null,"lastName":null,"bannedAt":null,"lastSignInAt":null,"createdAt":"2026-01-01T00:00:00.000Z","phoneNumber":null,"phoneNumberVerifiedAt":null,"hasPassword":true}"#

    static func attempt(
        _ kind: String, step: String, secret: String? = "attempt-secret-1", session: String? = nil
    ) -> String {
        var json = #"{"id":"att_1","kind":"\#(kind)","expiresAt":"2030-01-01T00:00:00.000Z","step":\#(step)"#
        if let secret { json += #","attemptSecret":"\#(secret)""# }
        if let session { json += #","session":\#(session)"# }
        return json + "}"
    }

    static let completeStep = #"{"status":"complete","userId":"usr_1","sessionId":"ses_1"}"#

    static func body(_ request: URLRequest) -> [String: Any] {
        guard let data = request.httpBody, let object = try? JSONSerialization.jsonObject(with: data) else {
            return [:]
        }
        return object as? [String: Any] ?? [:]
    }
}

/// A client on the fakes.
struct World {
    let api = FakeAPI()
    let storage = FakeStorage()
    let clock = FakeClock()
    let client: TulaClient

    init(
        timeout: TimeInterval = 5, sessionProfile: String? = nil,
        deviceKeys: (any TulaDeviceKeyStore)? = nil, passkeys: (any TulaPasskeySheet)? = nil,
        apple: (any TulaAppleSheet)? = nil, browser: (any TulaBrowserSession)? = nil
    ) throws {
        client = try TulaClient(
            publishableKey: Fixture.key,
            baseURL: Fixture.base,
            storage: storage,
            transport: api,
            sessionProfile: sessionProfile,
            timeout: timeout,
            clock: clock,
            deviceKeys: deviceKeys,
            passkeys: passkeys,
            apple: apple,
            browser: browser
        )
        api.always(Fixture.me) { _ in Reply(json: Fixture.user) }
    }

    var session: TulaSession { client.session }

    /// A client that is signed in: a stored token, refreshed once. The storage then holds
    /// `refresh-first` and the API has seen one refresh.
    static func signedIn(
        timeout: TimeInterval = 5,
        deviceKeys: (any TulaDeviceKeyStore)? = nil, passkeys: (any TulaPasskeySheet)? = nil,
        browser: (any TulaBrowserSession)? = nil
    ) async throws -> World {
        let world = try World(timeout: timeout, deviceKeys: deviceKeys, passkeys: passkeys, browser: browser)
        await world.storage.put(Fixture.storageKey, "refresh-stored")
        world.api.on(Fixture.refresh, Reply(json: Fixture.tokens("first")))
        let state = try await world.session.load()
        XCTAssertTrue(state.isSignedIn)
        return world
    }
}

/// The code of the `TulaError` a call throws; fails when it throws nothing or something else.
func thrownCode(
    _ work: () async throws -> Void, file: StaticString = #filePath, line: UInt = #line
) async -> String? {
    do {
        try await work()
        XCTFail("nothing was thrown", file: file, line: line)
        return nil
    } catch let error as TulaError {
        return error.code
    } catch {
        XCTFail("not a TulaError", file: file, line: line)
        return nil
    }
}

/// Wait until something another task does has happened.
func eventually(
    _ what: String, file: StaticString = #filePath, line: UInt = #line, _ holds: () async -> Bool
) async {
    for _ in 0..<2_000 {
        if await holds() { return }
        try? await Task.sleep(nanoseconds: 2_000_000)
    }
    XCTFail("never happened: \(what)", file: file, line: line)
}
