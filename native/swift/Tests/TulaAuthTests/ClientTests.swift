import Foundation
import XCTest

@testable import TulaAuth

// The client's construction, the reading of an answer that is not a success, and the rule
// that nothing an error or a refusal says repeats a secret.
final class ClientTests: XCTestCase {
    // MARK: Construction

    func testASecretKeyAndAMalformedAddressAreRefusedInFixedWords() {
        let secret = "tula_sk_live_0123456789abcdef-canary"
        let cases: [(key: String, url: String, timeout: TimeInterval, expected: TulaConfigurationError)] = [
            (secret, Fixture.base, 15, .notAPublishableKey),
            ("", Fixture.base, 15, .notAPublishableKey),
            (Fixture.key, "auth.example.test", 15, .invalidBaseURL),
            (Fixture.key, "ftp://auth.example.test", 15, .invalidBaseURL),
            (Fixture.key, "https://user-canary:pass@auth.example.test", 15, .invalidBaseURL),
            (Fixture.key, "https://auth.example.test/?canary=1", 15, .invalidBaseURL),
            (Fixture.key, "https://auth.example.test/#canary", 15, .invalidBaseURL),
            (Fixture.key, "https://", 15, .invalidBaseURL),
            (Fixture.key, Fixture.base, 0, .invalidTimeout),
            (Fixture.key, Fixture.base, -.infinity, .invalidTimeout),
            (Fixture.key, Fixture.base, .nan, .invalidTimeout),
        ]
        for entry in cases {
            XCTAssertThrowsError(
                try TulaClient(
                    publishableKey: entry.key, baseURL: entry.url, storage: MemoryTokenStorage(),
                    transport: FakeAPI(), timeout: entry.timeout)
            ) { error in
                XCTAssertEqual(error as? TulaConfigurationError, entry.expected)
                // A refusal is a fixed sentence: it never repeats what it was given.
                let said = "\(error) \(String(describing: error)) \(String(reflecting: error))"
                XCTAssertFalse(said.contains("canary"), said)
                XCTAssertFalse(said.contains("0123456789abcdef"), said)
            }
        }
        let sentences = Set(
            [TulaConfigurationError.notAPublishableKey, .invalidBaseURL, .invalidTimeout].map(\.description))
        XCTAssertEqual(sentences.count, 3)
    }

    func testTheAddressIsUsedAsWrittenWithoutATrailingSlash() throws {
        XCTAssertEqual(try TulaClient.normalize("https://auth.example.test/"), "https://auth.example.test")
        XCTAssertEqual(try TulaClient.normalize("https://auth.example.test/tula//"), "https://auth.example.test/tula")
        XCTAssertEqual(try TulaClient.normalize("http://127.0.0.1:3003"), "http://127.0.0.1:3003")
    }

    func testTheStorageEntryIsNamedForTheApiAndTheEnvironment() async throws {
        let world = try World()
        world.api.on(
            "POST /v1/client/sign-ins",
            Reply(json: Fixture.attempt("sign_in", step: Fixture.completeStep, secret: nil, session: Fixture.tokens("first"))))
        _ = try await world.client.startSignIn(identifier: "maya@example.com")
        let values = await world.storage.values
        XCTAssertEqual(values, [Fixture.storageKey: "refresh-first"])
    }

    func testAMemoryStorageKeepsReplacesAndRemoves() async {
        let storage = MemoryTokenStorage()
        var value = await storage.get("a")
        XCTAssertNil(value)
        await storage.set("a", "one")
        await storage.set("a", "two")
        value = await storage.get("a")
        XCTAssertEqual(value, "two")
        await storage.remove("a")
        value = await storage.get("a")
        XCTAssertNil(value)
    }

    // MARK: Reading an answer

    func testAnErrorIsTheContractsEnvelopeWithItsFieldsAndItsWait() async throws {
        let world = try World()
        world.api.on(
            "POST /v1/client/sign-ups",
            Reply(
                status: 422,
                json:
                    #"{"status":422,"code":"validation.failed","detail":"server text","params":{"limit":3,"nested":{"x":1}},"errors":[{"field":"password","code":"password.too_short","message":"server text","params":{"min":10}},{"field":"password","code":"password.rule_of_tomorrow","message":"Use a newer kind of password."},{"code":"no.field"}]}"#
            ))
        let client = world.client
        do {
            _ = try await client.startSignUp(email: "maya@example.com", password: "short-canary")
            XCTFail("nothing was thrown")
        } catch let error as TulaError {
            XCTAssertEqual(error.code, "validation.failed")
            XCTAssertEqual(error.status, 422)
            XCTAssertEqual(error.params, ["limit": .number(3)], "scalars only")
            XCTAssertEqual(error.errors.map(\.code), ["password.too_short", "password.rule_of_tomorrow"])
            XCTAssertEqual(error.errors[0].field, "password")
            XCTAssertEqual(error.errors[0].params, ["min": .number(10)])
            // The contract's message for a code it has, the server's own for one it has not.
            XCTAssertNotEqual(error.errors[0].message, "server text")
            XCTAssertEqual(error.errors[1].message, "Use a newer kind of password.")
            XCTAssertNotEqual(error.message, "server text")
            XCTAssertEqual(error.known, .validationFailed)
            XCTAssertEqual("\(error)", "TulaError(validation.failed, status 422)")
            XCTAssertFalse(String(describing: error).contains("canary"))
        }
    }

    func testACodeThisVersionDoesNotKnowIsKeptWithTheServersWords() async throws {
        let world = try World()
        world.api.on(
            "POST /v1/client/sign-ins",
            Reply(status: 409, json: #"{"status":409,"code":"flow.rule_of_tomorrow","detail":"Come back tomorrow."}"#))
        let client = world.client
        do {
            _ = try await client.startSignIn(identifier: "maya@example.com")
            XCTFail("nothing was thrown")
        } catch let error as TulaError {
            XCTAssertEqual(error.code, "flow.rule_of_tomorrow")
            XCTAssertEqual(error.message, "Come back tomorrow.")
            XCTAssertEqual(error.known, .unknown("flow.rule_of_tomorrow"))
        }
    }

    func testTheWaitIsTheHeadersOrTheParameterAProxyLeft() async throws {
        let world = try World()
        let route = "POST /v1/client/sign-ins"
        world.api.on(route, Reply.error(429, "rate_limited", headers: ["Retry-After": " 12 "]))
        world.api.on(route, Reply(status: 429, json: #"{"status":429,"code":"rate_limited","params":{"retryAfter":7}}"#))
        world.api.on(route, Reply.error(429, "rate_limited", headers: ["Retry-After": "Wed, 21 Oct 2026 07:28:00 GMT"]))
        world.api.on(route, Reply(status: 503, json: "<html>upstream</html>", headers: ["Retry-After": "4"]))
        let client = world.client
        var waits: [TimeInterval?] = []
        var codes: [String] = []
        for _ in 0..<4 {
            do {
                _ = try await client.startSignIn(identifier: "maya@example.com")
            } catch let error as TulaError {
                waits.append(error.retryAfter)
                codes.append(error.code)
            }
        }
        XCTAssertEqual(waits, [12, 7, nil, 4])
        XCTAssertEqual(codes, ["rate_limited", "rate_limited", "rate_limited", TulaClientErrorCode.responseInvalid])
    }

    func testAnAnswerThatIsNotTheApisIsResponseInvalidWithItsStatus() async throws {
        let world = try World()
        world.api.on("GET /v1/client/config", Reply(status: 200, json: "<html>a captive portal</html>"))
        world.api.on("GET /v1/client/config", Reply(status: 302, json: ""))
        let client = world.client
        for status in [200, 302] {
            do {
                _ = try await client.config(force: true)
                XCTFail("nothing was thrown")
            } catch let error as TulaError {
                XCTAssertEqual(error.code, TulaClientErrorCode.responseInvalid)
                XCTAssertEqual(error.status, status)
            }
        }
    }

    func testNoAnswerIsNetworkFailedAndHoldsNothingOfWhatTheNetworkSaid() async throws {
        struct Loud: Error, CustomStringConvertible {
            let description = "canary: the transport's own words"
        }
        let world = try World()
        world.api.on("POST /v1/client/sign-ins") { _ in throw Loud() }
        let client = world.client
        do {
            _ = try await client.startSignIn(identifier: "maya@example.com")
            XCTFail("nothing was thrown")
        } catch let error as TulaError {
            XCTAssertEqual(error.code, TulaClientErrorCode.networkFailed)
            XCTAssertEqual(error.status, 0)
            XCTAssertFalse(String(reflecting: error).contains("canary"))
            XCTAssertNotEqual(error.message, error.code)
        }
    }

    func testAnAnswerPastTheDeadlineIsNetworkTimeout() async throws {
        let world = try World(timeout: 0.05)
        let gate = Gate()
        world.api.on("POST /v1/client/sign-ins") { _ in
            await gate.wait()
            return Reply.error(500, "internal")
        }
        let client = world.client
        let code = await thrownCode { _ = try await client.startSignIn(identifier: "maya@example.com") }
        XCTAssertEqual(code, TulaClientErrorCode.networkTimeout)
        XCTAssertEqual(world.api.requests.count, 1, "only a refresh is ever repeated")
        gate.open()
    }

    func testAPathParameterIsOneSegment() async throws {
        let world = try await World.signedIn()
        let session = world.session
        _ = await thrownCode { try await session.revoke("../me?x=1#y") }
        let url = world.api.requests.last?.url?.absoluteString
        XCTAssertEqual(url, "\(Fixture.base)/v1/client/sessions/..%2Fme%3Fx%3D1%23y")
        let before = world.api.requests.count
        let code = await thrownCode { try await session.revoke("") }
        XCTAssertEqual(code, TulaClientErrorCode.responseInvalid)
        XCTAssertEqual(world.api.requests.count, before, "an empty id is no request")
    }

    func testEveryClientCodeHasItsOwnSentence() {
        let codes = [
            TulaClientErrorCode.networkFailed, TulaClientErrorCode.networkTimeout,
            TulaClientErrorCode.responseInvalid, TulaClientErrorCode.storageFailed, TulaClientErrorCode.flowBusy,
            TulaClientErrorCode.deviceKeyFailed, TulaClientErrorCode.passkeyUnsupported,
            TulaClientErrorCode.passkeyAlreadyOnDevice, TulaClientErrorCode.passkeyFailed,
            TulaClientErrorCode.providerUnsupported, TulaClientErrorCode.providerFailed,
        ]
        let messages = Set(codes.compactMap(TulaClientErrorCode.message))
        XCTAssertEqual(messages.count, codes.count)
        for code in codes {
            XCTAssertEqual(TulaError.client(code).status, 0)
            XCTAssertEqual(TulaError.client(code).known, .unknown(code), "a client code is not a contract code")
        }
        XCTAssertNil(TulaClientErrorCode.message("auth.invalid_credentials"))
        // A contract code the client raises itself has the contract's message.
        XCTAssertNotEqual(TulaError.client("flow.invalid_step").message, "flow.invalid_step")
    }

    // MARK: The signed-in user

    func testTheUserIsFetchedAndGivenToTheState() async throws {
        let world = try await World.signedIn()
        world.api.always(Fixture.me) { _ in
            Reply(json: Fixture.user.replacingOccurrences(of: #""firstName":null"#, with: #""firstName":"Maya""#))
        }
        let user = try await world.client.user()
        XCTAssertEqual(user.firstName, "Maya")
        guard case .signedIn(_, let known) = await world.session.state else {
            return XCTFail("not signed in")
        }
        XCTAssertEqual(known?.firstName, "Maya")
    }

    func testAPasswordChangeGoesInTheBodyWithTheAccessToken() async throws {
        let world = try await World.signedIn()
        let route = "POST /v1/client/me/password"
        world.api.on(route, Reply(status: 204, json: ""))
        try await world.client.changePassword(current: "the old one", new: "a new long passphrase")
        let request = world.api.requests(route)[0]
        XCTAssertEqual(Fixture.body(request)["currentPassword"] as? String, "the old one")
        XCTAssertEqual(Fixture.body(request)["newPassword"] as? String, "a new long passphrase")
        XCTAssertEqual(request.value(forHTTPHeaderField: "authorization"), "Bearer \(Fixture.accessToken("first"))")
    }

    // MARK: The transport an app uses

    /// No request leaves the machine: the session is given a `URLProtocol` that answers.
    func testTheSystemTransportHandsARedirectBackInsteadOfFollowingIt() async throws {
        final class Stub: URLProtocol, @unchecked Sendable {
            private static let lock = NSLock()
            nonisolated(unsafe) private static var urls: [URL] = []
            static var seen: [URL] { lock.withLock { urls } }
            override class func canInit(with request: URLRequest) -> Bool { true }
            override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
            override func stopLoading() {}
            override func startLoading() {
                guard let url = request.url else { return }
                Stub.lock.withLock { Stub.urls.append(url) }
                let moved = url.path == "/moved"
                let response = HTTPURLResponse(
                    url: url, statusCode: moved ? 302 : 200, httpVersion: "HTTP/1.1",
                    headerFields: moved ? ["Location": "https://elsewhere.example.test/landed"] : [:])
                if moved, let response, let next = URL(string: "https://elsewhere.example.test/landed") {
                    // A session that follows the redirect stops this load and starts one for
                    // the new address; one that does not takes the rest of this answer.
                    client?.urlProtocol(self, wasRedirectedTo: URLRequest(url: next), redirectResponse: response)
                }
                if let response {
                    client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
                }
                client?.urlProtocol(self, didLoad: Data("{}".utf8))
                client?.urlProtocolDidFinishLoading(self)
            }
        }
        let transport = URLSessionTransport(protocols: [Stub.self])
        let moved = try XCTUnwrap(URL(string: "https://auth.example.test/moved"))
        let (_, response) = try await transport.send(URLRequest(url: moved))
        XCTAssertEqual(response.statusCode, 302)
        XCTAssertEqual(Stub.seen.map(\.host), ["auth.example.test"], "nothing was sent to the other address")
        let plain = try XCTUnwrap(URL(string: "https://auth.example.test/ok"))
        let (data, ok) = try await transport.send(URLRequest(url: plain))
        XCTAssertEqual(ok.statusCode, 200)
        XCTAssertEqual(String(decoding: data, as: UTF8.self), "{}")
    }

    func testTheSystemTransportKeepsNoCookieCacheOrCredential() {
        let configuration = URLSessionTransport.configuration()
        XCTAssertNil(configuration.httpCookieStorage)
        XCTAssertNil(configuration.urlCache)
        XCTAssertNil(configuration.urlCredentialStorage)
        XCTAssertFalse(configuration.httpShouldSetCookies)
    }
}
