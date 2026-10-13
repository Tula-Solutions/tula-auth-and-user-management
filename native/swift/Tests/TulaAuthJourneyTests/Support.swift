import Foundation
import XCTest

@testable import TulaAuth

// What the journeys stand on: the real API, started by this process (native/swift/fixture/
// server.ts, run with `bun`), one fresh instance per test, and a client that talks to it
// over a real `URLSession`. It is what `server()` is to the JS journeys
// (apps/api/src/testing/sdk-journeys.ts).

struct JourneyFailure: Error, CustomStringConvertible {
    let description: String
    init(_ description: String) { self.description = description }
}

/// The repository's root, from this file's place in it.
let repositoryRoot: URL = {
    var url = URL(fileURLWithPath: #filePath)
    for _ in 0..<5 { url.deleteLastPathComponent() }
    return url
}()

/// The fixture process. Started once, by the first test that needs it, and ended with this
/// process: it exits when its standard input closes.
final class FixtureProcess: @unchecked Sendable {
    static let shared: Result<FixtureProcess, JourneyFailure> = {
        do {
            return .success(try FixtureProcess())
        } catch let failure as JourneyFailure {
            return .failure(failure)
        } catch {
            return .failure(
                JourneyFailure(
                    "the fixture could not be started: is `bun` on the PATH, and was `bun install` run at the repository's root?"
                ))
        }
    }()

    let origin: String
    private let process = Process()
    private let input = Pipe()

    private init() throws {
        let output = Pipe()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = ["bun", "run", "native/swift/fixture/server.ts"]
        process.currentDirectoryURL = repositoryRoot
        var environment = ProcessInfo.processInfo.environment
        environment["TULA_NATIVE_FIXTURE"] = "1"
        // As under `bun test`: the API's log lines would otherwise fill the pipe below.
        environment["LOG_LEVEL"] = "silent"
        process.environment = environment
        process.standardInput = input
        process.standardOutput = output
        try process.run()

        // The fixture prints one line when it listens. A process that ends first closes the
        // pipe, and the read below returns what there was.
        var line = Data()
        while !line.contains(UInt8(ascii: "\n")) {
            let chunk = output.fileHandleForReading.availableData
            if chunk.isEmpty { break }
            line.append(chunk)
        }
        guard
            let ready = try? JSONSerialization.jsonObject(with: line) as? [String: Any],
            let port = ready["port"] as? Int
        else {
            throw JourneyFailure(
                "the fixture did not start: run `TULA_NATIVE_FIXTURE=1 bun run native/swift/fixture/server.ts` at the repository's root to see why"
            )
        }
        origin = "http://127.0.0.1:\(port)"
        // Whatever else it prints is read and dropped, so that it never waits on a full pipe.
        output.fileHandleForReading.readabilityHandler = { handle in
            if handle.availableData.isEmpty {
                handle.readabilityHandler = nil
            }
        }
    }

    deinit {
        try? input.fileHandleForWriting.close()
        process.terminate()
    }
}

/// A clock a journey moves together with its server's.
final class JourneyClock: TulaClock, @unchecked Sendable {
    private let lock = NSLock()
    private var ahead: TimeInterval = 0

    func now() -> Date { lock.withLock { Date().addingTimeInterval(ahead) } }
    func advance(_ seconds: TimeInterval) { lock.withLock { ahead += seconds } }
    /// Show the time the server's clock shows: a device proof says when it was made, and the
    /// server checks.
    func set(to time: Date) { lock.withLock { ahead = time.timeIntervalSince(Date()) } }
}

/// What a journey does to the wire between its client and the server: the transport an app
/// uses, with the network taken away, an answer lost or an answer reworded on request.
final class Wire: TulaHTTPTransport, @unchecked Sendable {
    struct Lost: Error {}

    private let inner = URLSessionTransport()
    private let lock = NSLock()
    private var isOffline = false
    private var lose: (@Sendable (URLRequest) -> Bool)?
    private var reword: (@Sendable (URLRequest, Data) -> Data)?
    private var tamper: (@Sendable (URLRequest) -> URLRequest)?
    private var seen: [URLRequest] = []

    /// The device has no network: a request fails before it leaves, and reaches nobody.
    var offline: Bool {
        get { lock.withLock { isOffline } }
        set { lock.withLock { isOffline = newValue } }
    }

    /// Lose the answer of a request the server has already handled.
    func loseResponse(_ when: (@Sendable (URLRequest) -> Bool)?) { lock.withLock { lose = when } }
    /// Change an answer on its way back, as a server newer than this client would word it.
    func answer(_ with: (@Sendable (URLRequest, Data) -> Data)?) { lock.withLock { reword = with } }
    /// Change a request on its way out.
    func tamper(_ with: (@Sendable (URLRequest) -> URLRequest)?) { lock.withLock { tamper = with } }
    /// Every request the client handed to the wire, sent or not.
    var requests: [URLRequest] { lock.withLock { seen } }

    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (offline, lose, reword, tamper) = lock.withLock {
            seen.append(request)
            return (isOffline, self.lose, self.reword, self.tamper)
        }
        if offline {
            throw URLError(.notConnectedToInternet)
        }
        let (data, response) = try await inner.send(tamper?(request) ?? request)
        if lose?(request) == true {
            throw Lost()
        }
        return (reword?(request, data) ?? data, response)
    }
}

/// One exchange a client made with a journey's server, as the server saw it.
struct Exchange {
    let method: String
    let path: String
    let status: Int
    let headers: [String: String]
    let requestBody: String
    let responseBody: String
}

/// An email the server "sent".
struct SentEmail {
    let to: String
    let subject: String
    let text: String
}

/// The answer of a request made as an operator's backend.
struct AdminAnswer {
    let status: Int
    let etag: String?
    let json: Any?
    var object: [String: Any] { json as? [String: Any] ?? [:] }
}

/// Every state a client's session has published since the client was made.
actor StateLog {
    private(set) var seen: [AuthState] = []
    func add(_ state: AuthState) { seen.append(state) }
}

extension AuthState {
    /// The state's name, as `@tula-tech/core` spells it.
    var status: String {
        switch self {
        case .loading: return "loading"
        case .signedIn: return "signed-in"
        case .signedOut: return "signed-out"
        }
    }

    var user: CurrentUser? {
        if case .signedIn(_, let user) = self { return user }
        return nil
    }

    var sessionId: String? {
        if case .signedIn(let sessionId, _) = self { return sessionId }
        return nil
    }
}

/// A client of a journey, with what the journey can do to it.
struct App {
    let tula: TulaClient
    let storage: MemoryTokenStorage
    let wire: Wire
    let log: StateLog
    var session: TulaSession { tula.session }

    /// The state now.
    func state() async -> AuthState { await tula.session.state }

    /// The states the session has been through since the client was made, by name, without
    /// the `loading` it began in. Updates reach a listener a moment after they are made, so
    /// this waits for the newest to be the state the session has.
    func statuses() async -> [String] {
        for _ in 0..<500 {
            let now = await tula.session.state.status
            let seen = await log.seen.map(\.status)
            if seen.last == now { return Array(seen.dropFirst()) }
            try? await Task.sleep(nanoseconds: 2_000_000)
        }
        return Array(await log.seen.map(\.status).dropFirst())
    }

    /// The claims of the access token the client hands out now.
    func claims() async throws -> [String: Any] {
        Journey.claims(try await tula.session.getToken())
    }
}

enum Journey {
    static let password = "sturdy-Otter-plays-42-chess"
    static let newPassword = "quiet-Heron-wades-17-rivers"

    /// The payload of an access token; empty for what is not one.
    static func claims(_ token: String?) -> [String: Any] {
        let parts = (token ?? "").split(separator: ".")
        guard parts.count == 3 else { return [:] }
        var payload = parts[1].replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        payload += String(repeating: "=", count: (4 - payload.count % 4) % 4)
        guard let data = Data(base64Encoded: payload) else { return [:] }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
    }

    /// The custom claims of a token (the `ext` namespace); `nil` when it has none.
    static func customClaims(_ token: String?) -> NSDictionary? {
        claims(token)["ext"] as? NSDictionary
    }
}

/// One API in memory, as a journey sees it.
final class Server: @unchecked Sendable {
    let id: String
    let baseURL: String
    let publishableKey: String
    let clock = JourneyClock()
    private let origin: String
    private let http = URLSession(configuration: .ephemeral)
    private let lock = NSLock()
    private var addresses = 0

    private init(origin: String, id: String, baseURL: String, publishableKey: String) {
        self.origin = origin
        self.id = id
        self.baseURL = baseURL
        self.publishableKey = publishableKey
    }

    static func create(oauth: Bool = false) async throws -> Server {
        let fixture = try FixtureProcess.shared.get()
        let made = try await request(
            URLSession.shared, "POST", "\(fixture.origin)/__test/servers", body: ["oauth": oauth])
        guard
            let answer = made as? [String: Any], let id = answer["id"] as? String,
            let baseURL = answer["baseUrl"] as? String, let key = answer["publishableKey"] as? String
        else {
            throw JourneyFailure("the fixture did not make a server")
        }
        let server = Server(origin: fixture.origin, id: id, baseURL: baseURL, publishableKey: key)
        if let now = answer["now"] as? Double {
            server.clock.set(to: Date(timeIntervalSince1970: now / 1000))
        }
        return server
    }

    private static func request(_ http: URLSession, _ method: String, _ url: String, body: Any? = nil) async throws -> Any {
        guard let address = URL(string: url) else { throw JourneyFailure("not a URL") }
        var request = URLRequest(url: address)
        request.httpMethod = method
        if let body {
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            request.setValue("application/json", forHTTPHeaderField: "content-type")
        }
        let (data, response) = try await http.data(for: request)
        guard (response as? HTTPURLResponse)?.statusCode == 200 else {
            throw JourneyFailure("the fixture refused \(method) \(address.path): \(String(decoding: data, as: UTF8.self))")
        }
        return try JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])
    }

    func control(_ method: String, _ action: String, query: String = "", body: Any? = nil) async throws -> Any {
        try await Server.request(http, method, "\(origin)/__test/servers/\(id)/\(action)\(query)", body: body)
    }

    func remove() async {
        _ = try? await Server.request(http, "DELETE", "\(origin)/__test/servers/\(id)")
    }

    /// The entry a client of this server keeps its refresh token under.
    var storageKey: String { "tula.refresh.\(baseURL)|\(publishableKey)" }

    /// A new client: an app on a device of its own.
    func client(
        storage: MemoryTokenStorage = MemoryTokenStorage(), sessionProfile: String? = nil,
        deviceKeys: (any TulaDeviceKeyStore)? = nil, passkeys: (any TulaPasskeySheet)? = nil,
        apple: (any TulaAppleSheet)? = nil, browser: (any TulaBrowserSession)? = nil
    ) throws -> App {
        let wire = Wire()
        let tula = try TulaClient(
            publishableKey: publishableKey, baseURL: baseURL, storage: storage, transport: wire,
            sessionProfile: sessionProfile, clock: clock, deviceKeys: deviceKeys, passkeys: passkeys, apple: apple,
            browser: browser)
        let log = StateLog()
        let session = tula.session
        Task {
            for await state in await session.updates() {
                await log.add(state)
            }
        }
        return App(tula: tula, storage: storage, wire: wire, log: log)
    }

    func freshEmail() -> String {
        let next = lock.withLock { () -> Int in
            addresses += 1
            return addresses
        }
        return "swift-user-\(next)@example.com"
    }

    // MARK: What the server did

    func emails(to: String? = nil) async throws -> [SentEmail] {
        let query = to.map { "?to=\($0.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? "")" } ?? ""
        let list = try await control("GET", "emails", query: query) as? [[String: Any]] ?? []
        return list.map {
            SentEmail(
                to: $0["to"] as? String ?? "", subject: $0["subject"] as? String ?? "", text: $0["text"] as? String ?? "")
        }
    }

    /// The code of the newest email to `email` whose subject leads with one: a security
    /// notice can follow it.
    func code(_ email: String) async throws -> String {
        for sent in try await emails(to: email).reversed() {
            let lead = sent.subject.prefix(6)
            if lead.count == 6, lead.allSatisfy(\.isNumber), sent.subject.dropFirst(6).first?.isNumber != true {
                return String(lead)
            }
        }
        throw JourneyFailure("no email with a code was sent to \(email)")
    }

    func exchanges(_ path: String? = nil) async throws -> [Exchange] {
        let list = try await control("GET", "exchanges") as? [[String: Any]] ?? []
        return list.map {
            Exchange(
                method: $0["method"] as? String ?? "", path: $0["path"] as? String ?? "",
                status: $0["status"] as? Int ?? 0, headers: $0["headers"] as? [String: String] ?? [:],
                requestBody: $0["requestBody"] as? String ?? "", responseBody: $0["responseBody"] as? String ?? "")
        }.filter { path == nil || $0.path == path }
    }

    func refreshes() async throws -> [Exchange] {
        try await exchanges("/v1/client/sessions/refresh")
    }

    func userExists(_ email: String) async throws -> Bool {
        let query = "?email=\(email.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? "")"
        return (try await control("GET", "users", query: query) as? [String: Any])?["exists"] as? Bool ?? false
    }

    // MARK: What a journey does to the server

    /// Move the server's clock and the clock of this server's clients together.
    func advance(_ seconds: TimeInterval) async throws {
        _ = try await control("POST", "advance", body: ["ms": Int(seconds * 1000)])
        clock.advance(seconds)
    }

    /// Move the server's clock alone: the client still believes its token is good.
    func advanceServer(_ seconds: TimeInterval) async throws {
        _ = try await control("POST", "advance", body: ["ms": Int(seconds * 1000)])
    }

    /// The environment's settings as an operator saved them (the defaults, with these
    /// sections in their place).
    func settings(_ sections: [String: Any]) async throws {
        _ = try await control("POST", "settings", body: ["settings": sections])
    }

    /// A request of an operator's backend. The secret key stays in the fixture.
    @discardableResult
    func admin(_ method: String, _ path: String, _ body: Any? = nil, headers: [String: String] = [:]) async throws
        -> AdminAnswer
    {
        var relayed: [String: Any] = ["method": method, "path": path, "headers": headers]
        if let body { relayed["body"] = body }
        let answer = try await control("POST", "admin", body: relayed) as? [String: Any] ?? [:]
        let text = answer["body"] as? String ?? ""
        return AdminAnswer(
            status: answer["status"] as? Int ?? 0,
            etag: answer["etag"] as? String,
            json: try? JSONSerialization.jsonObject(with: Data(text.utf8), options: [.fragmentsAllowed]))
    }

    /// Register a hook whose receiver answers `answer` (`nil`: it never answers).
    func hook(_ point: String, answer: [String: Any]?, deadlineMs: Int = 5000) async throws -> Int {
        var body: [String: Any] = ["point": point, "deadlineMs": deadlineMs]
        if let answer { body["answer"] = ["body": answer] }
        return (try await control("POST", "hooks", body: body) as? [String: Any])?["index"] as? Int ?? 0
    }

    func setHook(_ index: Int, answer: [String: Any]) async throws {
        _ = try await control("PUT", "hooks", body: ["index": index, "answer": ["body": answer]])
    }

    /// How often each hook's receiver was asked, in order of registration.
    func asked() async throws -> [Int] {
        try await control("GET", "hooks") as? [Int] ?? []
    }

    // MARK: The steps most journeys begin with

    /// Sign up and verify through the client; returns the signed-in app.
    func signUp(email: String? = nil, password: String? = Journey.password, sessionProfile: String? = nil) async throws
        -> (app: App, email: String)
    {
        let app = try client(sessionProfile: sessionProfile)
        let address = email ?? freshEmail()
        let flow = try await app.tula.startSignUp(email: address, password: password, firstName: "Maya")
        try await flow.verifyEmail(code: try await code(address))
        return (app, address)
    }

    /// Sign in with the password on a new client.
    func signIn(_ email: String, password: String = Journey.password, sessionProfile: String? = nil) async throws
        -> (app: App, flow: SignInFlow, step: FlowStep)
    {
        let app = try client(sessionProfile: sessionProfile)
        let flow = try await app.tula.startSignIn(identifier: email)
        let step = try await flow.submitPassword(password)
        return (app, flow, step)
    }
}

/// The base of every journey test case: `journey` and `behaviour` name what a test is the
/// Swift client's coverage of, and give it a server of its own.
///
/// **The two calls are read from this target's sources** by native/swift/fixture/journeys.ts,
/// which holds them to the `swift` column of conformance/client-journeys.json with the
/// checks every client's suite uses. So each is the first statement of a `test…` method,
/// with its names written out as string literals; that script fails for one anywhere else,
/// and for a test that may not run.
class JourneyTestCase: XCTestCase {
    private var servers: [Server] = []

    override func tearDown() async throws {
        for server in servers {
            await server.remove()
        }
        servers = []
    }

    func server(oauth: Bool = false) async throws -> Server {
        let server = try await Server.create(oauth: oauth)
        servers.append(server)
        return server
    }

    /// Run a test that is the client's coverage of a conformance scenario (or of several).
    func journey(_ scenario: String, _ title: String, _ run: (Server) async throws -> Void) async throws {
        try await run(try await server())
    }

    func journey(_ scenarios: [String], _ title: String, _ run: (Server) async throws -> Void) async throws {
        try await run(try await server())
    }

    /// Run a test that is the client's proof of a named client behaviour.
    func behaviour(_ id: String, _ title: String, _ run: (Server) async throws -> Void) async throws {
        try await run(try await server())
    }
}

/// `XCTUnwrap` for a value that was awaited: its argument is not an autoclosure.
func unwrap<T>(_ value: T?, file: StaticString = #filePath, line: UInt = #line) throws -> T {
    try XCTUnwrap(value, file: file, line: line)
}

/// The `TulaError` a call throws.
func caught<T>(
    _ work: () async throws -> T, file: StaticString = #filePath, line: UInt = #line
) async throws -> TulaError {
    do {
        _ = try await work()
    } catch let error as TulaError {
        return error
    }
    XCTFail("expected the call to throw a TulaError", file: file, line: line)
    throw JourneyFailure("expected the call to throw a TulaError")
}
