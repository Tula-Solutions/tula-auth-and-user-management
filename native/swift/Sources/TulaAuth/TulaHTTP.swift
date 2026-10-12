import Foundation

/// What sends one HTTP request. The client talks to the network through this and nothing
/// else, so that tests run against a fake and an app can put its own session behind it.
public protocol TulaHTTPTransport: Sendable {
    /// Send `request` and return the whole answer.
    ///
    /// - Throws: whatever the network layer throws when no answer came. The client turns it
    ///   into `network.failed` and keeps nothing of it.
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse)
}

/// The transport an app uses: a `URLSession` of the client's own.
///
/// The session is ephemeral and keeps nothing on disk: no cookie, no cache and no stored
/// credential, so an answer that holds tokens is never written to a URL cache. It follows no
/// redirect: the API sends none, and a redirect would carry the publishable key and the
/// attempt's secret to another address.
public final class URLSessionTransport: NSObject, TulaHTTPTransport, URLSessionTaskDelegate {
    private let session: URLSession

    /// A transport on a new ephemeral session.
    public override convenience init() {
        self.init(protocols: [])
    }

    /// A transport whose session asks `protocols` first: for the tests of this class, which
    /// answer from a `URLProtocol` and send nothing.
    init(protocols: [AnyClass]) {
        let configuration = URLSessionTransport.configuration()
        if !protocols.isEmpty {
            configuration.protocolClasses = protocols
        }
        self.session = URLSession(configuration: configuration)
        super.init()
    }

    static func configuration() -> URLSessionConfiguration {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.urlCache = nil
        configuration.urlCredentialStorage = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        return configuration
    }

    /// Send one request and hand back its body and its answer, whatever the status.
    public func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (data, response) = try await session.data(for: request, delegate: self)
        guard let http = response as? HTTPURLResponse else {
            throw URLError(.badServerResponse)
        }
        return (data, http)
    }

    /// Follow no redirect: the answer that asked for one is handed back as it is.
    public func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest
    ) async -> URLRequest? {
        // The redirect itself is handed back as the answer; it is then an error like another.
        nil
    }
}

/// Where the time comes from. An app never passes one; a test moves its own.
public protocol TulaClock: Sendable {
    /// The time now.
    func now() -> Date
}

/// The device's clock.
public struct SystemClock: TulaClock {
    /// The clock of the system.
    public init() {}
    /// The time now.
    public func now() -> Date { Date() }
}

/// The names of the headers the client sends, as the contract has them
/// (`packages/contract/src/headers.ts`).
enum TulaHeader {
    static let publishableKey = "x-tula-publishable-key"
    static let client = "x-tula-client"
    static let sessionProfile = "x-tula-session-profile"
    static let attempt = "x-tula-attempt"
}

/// The credentials and the deadline of one call.
struct CallOptions: Sendable {
    var accessToken: String?
    var attemptSecret: String?
    var timeout: TimeInterval?
}

/// A request body that is not there.
struct NoBody: Encodable, Sendable {}

/// An answer with no body (a 204).
struct NoAnswer: Decodable, Sendable {
    init() {}
    init(from decoder: Decoder) throws {}
}

/// The one place a request is put together and an answer is read.
///
/// It adds the publishable key and the client kind, applies one deadline to the whole call
/// and turns every failure into a `TulaError`. It never retries, and it never puts a token,
/// a secret or a password anywhere but a header or the JSON body.
struct ApiTransport: Sendable {
    let baseURL: String
    let publishableKey: String
    let clientKind: String
    let sessionProfile: String?
    let http: any TulaHTTPTransport
    let timeout: TimeInterval
    /// The device key's proofs; `nil` for a client with no device key, which sends none.
    var proofs: DeviceProofs?
    var clock: any TulaClock = SystemClock()

    func call<Body: Encodable & Sendable, Answer: Decodable & Sendable>(
        _ operation: TulaOperation,
        params: [String: String] = [:],
        body: Body? = Optional<NoBody>.none,
        options: CallOptions = CallOptions(),
        as type: Answer.Type = NoAnswer.self
    ) async throws -> Answer {
        var path = operation.path
        for (name, value) in params {
            // One path segment and nothing else: an id that held a slash would be another route.
            var allowed = CharacterSet.alphanumerics
            allowed.insert(charactersIn: "-._~")
            guard
                let escaped = value.addingPercentEncoding(withAllowedCharacters: allowed),
                !value.isEmpty, value != ".", value != ".."
            else {
                throw TulaError.client(TulaClientErrorCode.responseInvalid)
            }
            path = path.replacingOccurrences(of: "{\(name)}", with: escaped)
        }
        guard let url = URL(string: baseURL + path) else {
            throw TulaError.client(TulaClientErrorCode.networkFailed)
        }
        var request = URLRequest(url: url)
        request.httpMethod = operation.method
        request.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        request.httpShouldHandleCookies = false
        request.setValue("application/json", forHTTPHeaderField: "accept")
        request.setValue(publishableKey, forHTTPHeaderField: TulaHeader.publishableKey)
        request.setValue(clientKind, forHTTPHeaderField: TulaHeader.client)
        if let sessionProfile {
            request.setValue(sessionProfile, forHTTPHeaderField: TulaHeader.sessionProfile)
        }
        if let body {
            do {
                request.httpBody = try JSONEncoder().encode(body)
            } catch {
                throw TulaError.client(TulaClientErrorCode.responseInvalid)
            }
            request.setValue("application/json", forHTTPHeaderField: "content-type")
        }
        if let token = options.accessToken {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "authorization")
        }
        if let secret = options.attemptSecret {
            request.setValue(secret, forHTTPHeaderField: TulaHeader.attempt)
        }
        let deadline = options.timeout ?? timeout
        // Above the client's own deadline, so that this one is never what ends a request.
        request.timeoutInterval = deadline + 5

        var key: (any TulaDeviceKey)?
        if let proofs, let use = DeviceProofs.proven[operation.id] {
            key = try await proofs.key(for: use)
        }
        // One deadline for the whole call, the repeat after a nonce challenge included: a
        // refresh has to give up inside the server's grace window.
        let started = DispatchTime.now().uptimeNanoseconds
        var (data, response) = try await proven(request, key, operation, path, deadline, started)
        // The server asked for its nonce (RFC 9449, section 8): the same request once more,
        // with a new proof that carries it. Once: a second challenge is an error like another.
        if key != nil, response.statusCode == 400,
            ApiTransport.error(from: data, response: response).code == "device.nonce_required"
        {
            (data, response) = try await proven(request, key, operation, path, deadline, started)
        }
        guard (200..<300).contains(response.statusCode) else {
            throw ApiTransport.error(from: data, response: response)
        }
        if Answer.self == NoAnswer.self, let nothing = NoAnswer() as? Answer {
            return nothing
        }
        do {
            return try JSONDecoder().decode(type, from: data)
        } catch {
            // A 2xx that is not what the operation answers: not proof of talking to the API.
            throw TulaError(code: TulaClientErrorCode.responseInvalid, status: response.statusCode)
        }
    }

    /// One request, with a new proof when the call is proven (the server accepts a proof
    /// once), inside what is left of the call's deadline. The answer's nonce is kept.
    private func proven(
        _ unproven: URLRequest, _ key: (any TulaDeviceKey)?, _ operation: TulaOperation, _ path: String,
        _ deadline: TimeInterval, _ started: UInt64
    ) async throws -> (Data, HTTPURLResponse) {
        var request = unproven
        if let key, let proofs {
            request.setValue(
                try await proofs.proof(key, method: operation.method, url: baseURL + path, now: clock.now()),
                forHTTPHeaderField: DeviceProofs.header)
        }
        let spent = TimeInterval(DispatchTime.now().uptimeNanoseconds - started) / 1_000_000_000
        let answer = try await send(request, within: deadline - spent)
        if let proofs, let nonce = answer.1.value(forHTTPHeaderField: DeviceProofs.nonceHeader), !nonce.isEmpty {
            proofs.nonce = nonce
        }
        return answer
    }

    /// One request under one deadline. No answer in time is `network.timeout`; any other
    /// failure to get an answer is `network.failed`. What the network layer threw is dropped.
    /// A caller whose task is cancelled stops the request, and a transport that honours that
    /// ends it as `network.failed`: the client has no code of its own for a cancelled call.
    private func send(_ request: URLRequest, within deadline: TimeInterval) async throws -> (Data, HTTPURLResponse) {
        let http = self.http
        let race = Race()
        // Not a task group: a group waits for every child before it returns, and the deadline
        // must hold also for a transport that does not stop when it is cancelled (a refresh
        // has to give up inside the server's grace window whatever the transport does).
        let work = Task {
            do {
                race.finish(.success(try await http.send(request)))
            } catch {
                race.finish(.failure(TulaError.client(TulaClientErrorCode.networkFailed)))
            }
        }
        let timer = Task {
            do {
                try await Task.sleep(nanoseconds: UInt64(max(0, deadline) * 1_000_000_000))
            } catch {
                return
            }
            race.finish(.failure(TulaError.client(TulaClientErrorCode.networkTimeout)))
        }
        defer {
            work.cancel()
            timer.cancel()
        }
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { race.wait($0) }
        } onCancel: {
            work.cancel()
        }
    }

    /// The first of an answer and a deadline; whatever comes second is dropped.
    private final class Race: @unchecked Sendable {
        typealias Outcome = Result<(Data, HTTPURLResponse), Error>
        private let lock = NSLock()
        private var outcome: Outcome?
        private var waiter: CheckedContinuation<(Data, HTTPURLResponse), Error>?

        func finish(_ result: Outcome) {
            let resumed: CheckedContinuation<(Data, HTTPURLResponse), Error>? = lock.withLock {
                guard outcome == nil else {
                    return nil
                }
                outcome = result
                defer { waiter = nil }
                return waiter
            }
            resumed?.resume(with: result)
        }

        func wait(_ continuation: CheckedContinuation<(Data, HTTPURLResponse), Error>) {
            let known: Outcome? = lock.withLock {
                if outcome == nil {
                    waiter = continuation
                }
                return outcome
            }
            if let known {
                continuation.resume(with: known)
            }
        }
    }

    /// The error of an answer that is not a success: the API's envelope, read leniently (a
    /// code this version does not know is kept as it is), or `response.invalid` for anything
    /// that is not the envelope.
    static func error(from data: Data, response: HTTPURLResponse) -> TulaError {
        let header = response.value(forHTTPHeaderField: "retry-after")
        guard
            case .object(let payload)? = try? JSONDecoder().decode(TulaJSONValue.self, from: data),
            case .string(let code)? = payload["code"]
        else {
            return TulaError(
                code: TulaClientErrorCode.responseInvalid,
                status: response.statusCode,
                retryAfter: retryAfter(header: header, params: [:])
            )
        }
        let params = scalars(payload["params"])
        var fields: [TulaFieldError] = []
        if case .array(let entries)? = payload["errors"] {
            for case .object(let entry) in entries {
                guard case .string(let field)? = entry["field"], case .string(let fieldCode)? = entry["code"] else {
                    continue
                }
                var message = TulaError.defaultMessage(fieldCode)
                if message == nil, case .string(let own)? = entry["message"] {
                    message = own
                }
                fields.append(
                    TulaFieldError(
                        field: field,
                        code: fieldCode,
                        message: message ?? fieldCode,
                        params: scalars(entry["params"])
                    )
                )
            }
        }
        var message = TulaError.defaultMessage(code)
        if message == nil, case .string(let detail)? = payload["detail"] {
            message = detail
        }
        return TulaError(
            code: code,
            status: response.statusCode,
            message: message,
            params: params,
            errors: fields,
            retryAfter: retryAfter(header: header, params: params)
        )
    }

    private static func scalars(_ value: TulaJSONValue?) -> [String: TulaJSONValue] {
        guard case .object(let object)? = value else {
            return [:]
        }
        return object.filter { _, value in
            switch value {
            case .string, .number, .bool: return true
            default: return false
            }
        }
    }

    /// `Retry-After` in seconds, or the `retryAfter` parameter of a `rate_limited` error when
    /// a proxy dropped the header. An HTTP date is not read: the API sends seconds.
    private static func retryAfter(header: String?, params: [String: TulaJSONValue]) -> TimeInterval? {
        if let header, let seconds = UInt32(header.trimmingCharacters(in: .whitespaces)) {
            return TimeInterval(seconds)
        }
        if case .number(let seconds)? = params["retryAfter"], seconds >= 0 {
            return seconds
        }
        return nil
    }
}
