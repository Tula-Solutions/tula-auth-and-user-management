import CryptoKit
import Foundation
import XCTest

@testable import TulaAuth

// Signing in with a provider on a fake API: the ID token exchange, Sign in with Apple
// through a fake sheet, and the round trip through a fake browser session. What a returned
// address must be to be read at all is a table.
final class ProviderTests: XCTestCase {
    private let idTokens = "POST /v1/client/sign-ins/id-token"
    private let exchangeToken = "POST /v1/client/sign-ins/att_1/id-token"
    private let oauth = "POST /v1/client/sign-ins/oauth"
    private let exchange = "POST /v1/client/sign-ins/oauth/exchange"
    private let redirect = "com.example.app://callback"

    private func idTokenStart() -> Reply {
        Reply(
            json:
                #"{"attempt":\#(Fixture.attempt("sign_in", step: #"{"status":"needs_first_factor","strategies":["oauth_apple"]}"#)),"nonce":"server-nonce"}"#
        )
    }

    private func complete() -> Reply {
        Reply(json: Fixture.attempt("sign_in", step: Fixture.completeStep, secret: nil, session: Fixture.tokens("first")))
    }

    private func oauthStart() -> Reply {
        Reply(
            json:
                #"{"attempt":\#(Fixture.attempt("sign_in", step: #"{"status":"needs_first_factor","strategies":["oauth_google"]}"#)),"authorizationUrl":"https://provider.example/authorize?state=s","binding":"CANARY-binding"}"#
        )
    }

    // MARK: The ID token

    func testAnIdTokenIsExchangedOnceWithTheAttemptsSecret() async throws {
        let world = try World()
        world.api.on(idTokens, idTokenStart())
        world.api.on(exchangeToken, complete())
        let pending = try await world.client.startIdTokenSignIn(provider: .google)
        XCTAssertEqual(pending.nonce, "server-nonce")
        XCTAssertEqual(
            pending.appleNonce,
            SHA256.hash(data: Data("server-nonce".utf8)).map { String(format: "%02x", $0) }.joined())
        XCTAssertEqual("\(pending)", "IdTokenSignIn")
        XCTAssertEqual(Fixture.body(world.api.requests(idTokens)[0])["provider"] as? String, "google")
        let flow = try await pending.exchange(idToken: "CANARY-id-token")
        XCTAssertEqual(flow.screen, .complete)
        let sent = world.api.requests(exchangeToken)[0]
        XCTAssertEqual(sent.value(forHTTPHeaderField: "x-tula-attempt"), "attempt-secret-1")
        XCTAssertEqual(Fixture.body(sent)["idToken"] as? String, "CANARY-id-token")
        XCTAssertNil(Fixture.body(sent)["givenName"], "a name that is not there is a key left out")
    }

    func testARefusedTokenIsInNoErrorAndALeftAttemptSendsNothing() async throws {
        let world = try World()
        let started = idTokenStart()
        world.api.always(idTokens) { _ in started }
        world.api.on(exchangeToken, Reply.error(401, "auth.invalid_credentials"))
        let pending = try await world.client.startIdTokenSignIn(provider: .google)
        do {
            _ = try await pending.exchange(idToken: "CANARY-id-token")
            XCTFail("nothing was thrown")
        } catch {
            XCTAssertEqual((error as? TulaError)?.code, "auth.invalid_credentials")
            XCTAssertFalse(everythingOf(error).contains("CANARY"))
        }
        let left = try await world.client.startIdTokenSignIn(provider: .google)
        left.discard()
        let code = await thrownCode { _ = try await left.exchange(idToken: "x") }
        XCTAssertEqual(code, "flow.invalid_step")
        XCTAssertEqual(world.api.count(exchangeToken), 1)

        world.api.always(idTokens) { _ in
            Reply(json: #"{"attempt":\#(Fixture.attempt("sign_in", step: #"{"status":"needs_password"}"#)),"nonce":""}"#)
        }
        let invalid = await thrownCode { _ = try await world.client.startIdTokenSignIn(provider: .apple) }
        XCTAssertEqual(invalid, "response.invalid")
    }

    func testSignInWithAppleHandsTheSheetTheHashOfTheNonceAndTheServerTheTokenAndTheName() async throws {
        let apple = FakeApple()
        let world = try World(apple: apple)
        let started = idTokenStart()
        world.api.always(idTokens) { _ in started }
        world.api.on(exchangeToken, complete())
        guard case .finished(let flow) = try await world.client.signInWithApple() else {
            return XCTFail("the ceremony did not finish")
        }
        XCTAssertEqual(flow.screen, .complete)
        XCTAssertEqual(apple.nonces, [sha256Hex("server-nonce")])
        XCTAssertEqual(apple.nonces[0].count, 64)
        XCTAssertEqual(apple.nonces[0], apple.nonces[0].lowercased())
        let body = Fixture.body(world.api.requests(exchangeToken)[0])
        XCTAssertEqual(body["idToken"] as? String, "CANARY-id-token")
        XCTAssertEqual(body["givenName"] as? String, "Maya")
        XCTAssertEqual(body["familyName"] as? String, "Okafor")
        XCTAssertEqual(Fixture.body(world.api.requests(idTokens)[0])["provider"] as? String, "apple")

        apple.answer = .failure(TulaSheetError.dismissed)
        guard case .dismissed = try await world.client.signInWithApple() else {
            return XCTFail("a dismissed sheet is its own outcome")
        }
        XCTAssertEqual(world.api.count(exchangeToken), 1, "nothing was sent to be judged")

        apple.answer = .failure(LoudFailure())
        do {
            _ = try await world.client.signInWithApple()
            XCTFail("nothing was thrown")
        } catch {
            XCTAssertEqual((error as? TulaError)?.code, "provider.failed")
            XCTAssertFalse(everythingOf(error).contains("CANARY"))
        }
        apple.answer = .failure(TulaSheetError.unsupported)
        let unsupported = await thrownCode { _ = try await world.client.signInWithApple() }
        XCTAssertEqual(unsupported, "provider.unsupported")

        let without = try World()
        let none = await thrownCode { _ = try await without.client.signInWithApple() }
        XCTAssertEqual(none, "provider.unsupported")
        XCTAssertEqual(without.api.requests.count, 0)
    }

    // MARK: The browser round trip

    func testARoundTripExchangesTheTicketWithTheBindingItKept() async throws {
        let browser = FakeBrowser()
        let redirect = self.redirect
        browser.answer = { _, _ in "\(redirect)#tula_ticket=CANARY-ticket&tula_attempt=att_1" }
        let world = try World(browser: browser)
        world.api.on(oauth, oauthStart())
        world.api.on(exchange, complete())
        guard case .signedIn(let flow) = try await world.client.signIn(with: .google, redirectURL: redirect) else {
            return XCTFail("not signed in")
        }
        XCTAssertEqual(flow.screen, .complete)
        XCTAssertEqual(browser.opened.map(\.url), ["https://provider.example/authorize?state=s"])
        XCTAssertEqual(browser.opened.map(\.redirect), [redirect])
        let started = Fixture.body(world.api.requests(oauth)[0])
        XCTAssertEqual(started["provider"] as? String, "google")
        XCTAssertEqual(started["redirectUrl"] as? String, redirect)
        let body = Fixture.body(world.api.requests(exchange)[0])
        XCTAssertEqual(body["ticket"] as? String, "CANARY-ticket")
        XCTAssertEqual(body["attemptId"] as? String, "att_1")
        XCTAssertEqual(body["binding"] as? String, "CANARY-binding")
        // Nothing is kept once the exchange has its answer.
        guard case .refused(.noAnswer) = try await world.client.retryProviderSignIn() else {
            return XCTFail("there was something to try again")
        }
        XCTAssertEqual(world.api.count(exchange), 1)
    }

    func testAProviderThatProvedTheFirstFactorCanLeaveAStep() async throws {
        let browser = FakeBrowser()
        let redirect = self.redirect
        browser.answer = { _, _ in "\(redirect)#tula_attempt=att_1&tula_ticket=t" }
        let world = try World(browser: browser)
        world.api.on(oauth, oauthStart())
        world.api.on(exchange, Reply(json: Fixture.attempt("sign_in", step: Fixture.secondFactor, secret: "second-secret")))
        guard case .needsStep(let flow) = try await world.client.signIn(with: .github, redirectURL: redirect) else {
            return XCTFail("not waiting on a step")
        }
        XCTAssertEqual(flow.step.status, "needs_second_factor")
        world.api.on("POST /v1/client/sign-ins/att_1/second-factor", complete())
        _ = try await flow.submitTotp("123456")
        XCTAssertEqual(
            world.api.requests("POST /v1/client/sign-ins/att_1/second-factor")[0].value(forHTTPHeaderField: "x-tula-attempt"),
            "second-secret", "the exchange gave the attempt a new secret")
    }

    func testAReturnedAddressIsReadOnlyWhenItIsTheRedirectUrlExactly() async throws {
        let table: [(String?, String)] = [
            (nil, "cancelled"),
            ("com.example.app://callback", "noAnswer"),
            ("com.example.app://callback#", "noAnswer"),
            ("com.example.app://callback#other=1", "noAnswer"),
            ("com.example.app://callback/#tula_ticket=t&tula_attempt=att_1", "unexpectedReturn"),
            ("com.example.app://callback?x=1#tula_ticket=t&tula_attempt=att_1", "unexpectedReturn"),
            ("COM.EXAMPLE.APP://callback#tula_ticket=t&tula_attempt=att_1", "unexpectedReturn"),
            ("com.example.app://callback/extra#tula_ticket=t&tula_attempt=att_1", "unexpectedReturn"),
            ("com.example.other://callback#tula_ticket=t&tula_attempt=att_1", "unexpectedReturn"),
            ("https://evil.example/#tula_ticket=t&tula_attempt=att_1", "unexpectedReturn"),
            ("com.example.app://callback#tula_ticket=t&tula_attempt=att_other", "notStartedHere"),
            ("com.example.app://callback#tula_ticket=t", "notStartedHere"),
            ("com.example.app://callback#tula_error=oauth.access_denied&tula_attempt=att_1", "error:oauth.access_denied"),
            ("com.example.app://callback#tula_error=CANARY%20made%20up", "error:oauth.provider_error"),
        ]
        for (returned, expected) in table {
            let browser = FakeBrowser()
            browser.answer = { _, _ in returned }
            let world = try World(browser: browser)
            world.api.on(oauth, oauthStart())
            let outcome = try await world.client.signIn(with: .google, redirectURL: redirect)
            let said: String
            switch outcome {
            case .cancelled: said = "cancelled"
            case .refused(.noAnswer): said = "noAnswer"
            case .refused(.unexpectedReturn): said = "unexpectedReturn"
            case .refused(.notStartedHere): said = "notStartedHere"
            case .refused(.error(let code)): said = "error:\(code)"
            default: said = "other"
            }
            XCTAssertEqual(said, expected, returned ?? "closed")
            XCTAssertEqual(world.api.count(exchange), 0, "refused without a request: \(returned ?? "closed")")
            let state = await world.session.state
            XCTAssertFalse(state.isSignedIn)
            // And nothing was kept for another try.
            guard case .refused(.noAnswer) = try await world.client.retryProviderSignIn() else {
                return XCTFail("something was kept: \(returned ?? "closed")")
            }
        }
    }

    func testAnExchangeThatGotNoAnswerCanBeTriedAgainForAMinute() async throws {
        let browser = FakeBrowser()
        let redirect = self.redirect
        browser.answer = { _, _ in "\(redirect)#tula_ticket=CANARY-ticket&tula_attempt=att_1" }
        let world = try World(browser: browser)
        world.api.on(oauth, oauthStart())
        world.api.on(exchange) { _ in throw URLError(.notConnectedToInternet) }
        do {
            _ = try await world.client.signIn(with: .google, redirectURL: redirect)
            XCTFail("nothing was thrown")
        } catch {
            XCTAssertEqual((error as? TulaError)?.code, "network.failed")
            XCTAssertFalse(everythingOf(error).contains("CANARY"))
        }
        world.api.on(exchange, Reply.error(429, "rate_limited", headers: ["retry-after": "2"]))
        let limited = await thrownCode { _ = try await world.client.retryProviderSignIn() }
        XCTAssertEqual(limited, "rate_limited")
        world.api.on(exchange, complete())
        guard case .signedIn = try await world.client.retryProviderSignIn() else {
            return XCTFail("the retry did not sign in")
        }
        XCTAssertEqual(world.api.count(exchange), 3)
        XCTAssertEqual(browser.opened.count, 1, "a retry opens no browser")
        XCTAssertEqual(Fixture.body(world.api.requests(exchange)[2])["ticket"] as? String, "CANARY-ticket")
    }

    func testAHeldTicketIsForgottenAfterAMinuteBySignOutAndWhenAsked() async throws {
        func held() async throws -> World {
            let browser = FakeBrowser()
            let redirect = self.redirect
            browser.answer = { _, _ in "\(redirect)#tula_ticket=t&tula_attempt=att_1" }
            let world = try World(browser: browser)
            world.api.on(oauth, oauthStart())
            world.api.on(exchange) { _ in throw URLError(.timedOut) }
            _ = await thrownCode { _ = try await world.client.signIn(with: .google, redirectURL: redirect) }
            return world
        }
        var world = try await held()
        world.clock.advance(61)
        guard case .refused(.error(code: "oauth.ticket_invalid")) = try await world.client.retryProviderSignIn() else {
            return XCTFail("a ticket past its minute was offered again")
        }
        XCTAssertEqual(world.api.count(exchange), 1, "said without asking")

        world = try await held()
        world.client.discardProviderSignIn()
        guard case .refused(.noAnswer) = try await world.client.retryProviderSignIn() else {
            return XCTFail("a discarded round trip was tried again")
        }

        world = try await held()
        _ = try await world.session.load()
        try await world.session.signOut()
        guard case .refused(.noAnswer) = try await world.client.retryProviderSignIn() else {
            return XCTFail("a round trip outlived the sign-out")
        }
        XCTAssertEqual(world.api.count(exchange), 1)
    }

    func testARefusedExchangeIsAnOutcomeAndForgetsTheTicket() async throws {
        for (code, expected) in [
            ("oauth.different_browser", ProviderRefusal.notStartedHere),
            ("oauth.account_exists", .error(code: "oauth.account_exists")),
            ("hook.denied", .error(code: "hook.denied")),
        ] {
            let browser = FakeBrowser()
            let redirect = self.redirect
            browser.answer = { _, _ in "\(redirect)#tula_ticket=t&tula_attempt=att_1" }
            let world = try World(browser: browser)
            world.api.on(oauth, oauthStart())
            world.api.on(exchange, Reply.error(409, code))
            guard case .refused(let refusal) = try await world.client.signIn(with: .google, redirectURL: redirect) else {
                return XCTFail("not refused")
            }
            XCTAssertEqual(refusal, expected)
            guard case .refused(.noAnswer) = try await world.client.retryProviderSignIn() else {
                return XCTFail("a refused ticket was kept")
            }
        }
        // An answer that is not the API's is thrown, and nothing is kept.
        let browser = FakeBrowser()
        let redirect = self.redirect
        browser.answer = { _, _ in "\(redirect)#tula_ticket=t&tula_attempt=att_1" }
        let world = try World(browser: browser)
        world.api.on(oauth, oauthStart())
        world.api.on(exchange, Reply(json: #"{"not":"an attempt"}"#))
        let invalid = await thrownCode { _ = try await world.client.signIn(with: .google, redirectURL: redirect) }
        XCTAssertEqual(invalid, "response.invalid")
        guard case .refused(.noAnswer) = try await world.client.retryProviderSignIn() else {
            return XCTFail("an unusable answer left a ticket")
        }
    }

    func testTheStartIsTheServersToJudgeAndABrowserThatFailsSaysNothingOfItsOwn() async throws {
        let browser = FakeBrowser()
        let world = try World(browser: browser)
        world.api.on(
            oauth,
            Reply(
                status: 400,
                json:
                    #"{"status":400,"code":"request.redirect_not_allowed","detail":"x","params":{"reason":"provider_without_pkce"}}"#
            ))
        do {
            _ = try await world.client.signIn(with: .apple, redirectURL: redirect)
            XCTFail("nothing was thrown")
        } catch {
            XCTAssertEqual((error as? TulaError)?.code, "request.redirect_not_allowed")
            XCTAssertEqual((error as? TulaError)?.params["reason"], .string("provider_without_pkce"))
        }
        XCTAssertEqual(browser.opened.count, 0)

        world.api.on(oauth, Reply(json: #"{"attempt":\#(Fixture.attempt("sign_in", step: #"{"status":"needs_password"}"#)),"authorizationUrl":"javascript:alert(1)","binding":"b"}"#))
        let invalid = await thrownCode { _ = try await world.client.signIn(with: .google, redirectURL: self.redirect) }
        XCTAssertEqual(invalid, "response.invalid")
        XCTAssertEqual(browser.opened.count, 0, "an address that is not a page is not opened")

        browser.answer = { _, _ in throw LoudFailure() }
        world.api.on(oauth, oauthStart())
        do {
            _ = try await world.client.signIn(with: .google, redirectURL: redirect)
            XCTFail("nothing was thrown")
        } catch {
            XCTAssertEqual((error as? TulaError)?.code, "provider.failed")
            XCTAssertFalse(everythingOf(error).contains("CANARY"))
        }
        browser.answer = { _, _ in throw TulaSheetError.unsupported }
        world.api.on(oauth, oauthStart())
        let unsupported = await thrownCode { _ = try await world.client.signIn(with: .google, redirectURL: self.redirect) }
        XCTAssertEqual(unsupported, "provider.unsupported")

        let without = try World()
        let none = await thrownCode { _ = try await without.client.signIn(with: .google, redirectURL: self.redirect) }
        XCTAssertEqual(none, "provider.unsupported")
        XCTAssertEqual(without.api.requests.count, 0)
    }

    // MARK: Connecting an account

    func testAProviderAccountIsLinkedListedAndUnlinked() async throws {
        let browser = FakeBrowser()
        let link = "https://app.example.com/callback"
        browser.answer = { _, _ in "\(link)#tula_ticket=t&tula_attempt=att_9" }
        let world = try await World.signedIn(browser: browser)
        let startRoute = "POST /v1/client/me/identities/oauth"
        let exchangeRoute = "POST /v1/client/me/identities/oauth/exchange"
        let identity = #"{"id":"idn_1","provider":"github","createdAt":"2026-01-01T00:00:00.000Z"}"#
        world.api.on(
            startRoute,
            Reply(
                json:
                    #"{"attemptId":"att_9","expiresAt":"2030-01-01T00:00:00.000Z","authorizationUrl":"https://provider.example/authorize","binding":"link-binding"}"#
            ))
        world.api.on(exchangeRoute, Reply(json: identity))
        guard case .linked(let linked) = try await world.client.identities.link(.github, redirectURL: link) else {
            return XCTFail("not linked")
        }
        XCTAssertEqual(linked.id, "idn_1")
        let sent = world.api.requests(exchangeRoute)[0]
        XCTAssertEqual(Fixture.body(sent)["binding"] as? String, "link-binding")
        XCTAssertEqual(sent.value(forHTTPHeaderField: "authorization"), "Bearer \(Fixture.accessToken("first"))")

        world.api.on("GET /v1/client/me/identities", Reply(json: #"{"data":[\#(identity)]}"#))
        let list = try await world.client.identities.list()
        XCTAssertEqual(list.map(\.provider), ["github"])
        world.api.on("DELETE /v1/client/me/identities/idn_1", Reply(status: 204, json: ""))
        try await world.client.identities.unlink("idn_1")

        world.api.on(startRoute, Reply(json: #"{"attemptId":"att_9","expiresAt":"x","authorizationUrl":"https://p.example","binding":"b"}"#))
        world.api.on(exchangeRoute, Reply(json: #"{"id":"","provider":"github","createdAt":"x"}"#))
        let invalid = await thrownCode { _ = try await world.client.identities.link(.github, redirectURL: link) }
        XCTAssertEqual(invalid, "response.invalid")
    }

    // MARK: The system sheets, as far as they decide without the system

    func testAFrameworksErrorIsAWordAndItsBytesAreTheApisJson() {
        func failure(_ domain: String, _ code: Int) -> NSError {
            NSError(domain: domain, code: code, userInfo: [NSLocalizedDescriptionKey: LoudFailure.text])
        }
        XCTAssertEqual(SystemSheetWire.word(for: failure(SystemSheetWire.authorizationDomain, 1001)), .dismissed)
        XCTAssertEqual(SystemSheetWire.word(for: failure(SystemSheetWire.browserDomain, 1)), .dismissed)
        XCTAssertEqual(SystemSheetWire.word(for: failure(SystemSheetWire.authorizationDomain, 1006)), .alreadyOnDevice)
        XCTAssertEqual(SystemSheetWire.word(for: failure(SystemSheetWire.authorizationDomain, 1000)), .failed)
        XCTAssertEqual(SystemSheetWire.word(for: failure("another.domain", 1001)), .failed)
        XCTAssertEqual(SystemSheetWire.word(for: LoudFailure()), .failed)

        let id = Data([0xfb, 0xff])
        let made = SystemSheetWire.registration(id: id, clientData: Data("c".utf8), attestation: Data("a".utf8))
        XCTAssertEqual(made?.id, "-_8")
        XCTAssertEqual(made?.rawId, "-_8")
        XCTAssertEqual(made?.type, "public-key")
        XCTAssertEqual(made?.response.attestationObject, "YQ")
        XCTAssertTrue(made.map(PasskeyChecks.usable) ?? false)
        XCTAssertNil(SystemSheetWire.registration(id: id, clientData: Data(), attestation: nil))
        XCTAssertNil(SystemSheetWire.registration(id: Data(), clientData: Data(), attestation: Data([1])))

        let found = SystemSheetWire.assertion(
            id: id, clientData: Data("c".utf8), authenticatorData: Data("d".utf8), signature: Data("s".utf8),
            userID: Data("u".utf8))
        XCTAssertEqual(found?.response.userHandle, "dQ")
        XCTAssertTrue(found.map(PasskeyChecks.usable) ?? false)
        let anonymous = SystemSheetWire.assertion(
            id: id, clientData: Data("c".utf8), authenticatorData: Data("d".utf8), signature: Data("s".utf8), userID: Data())
        XCTAssertNotNil(anonymous)
        XCTAssertNil(anonymous?.response.userHandle)
        XCTAssertNil(
            SystemSheetWire.assertion(id: id, clientData: Data(), authenticatorData: nil, signature: Data([1]), userID: nil))

        var name = PersonNameComponents()
        name.givenName = "Maya"
        name.familyName = "Okafor"
        let apple = SystemSheetWire.apple(identityToken: Data("a.b.c".utf8), name: name)
        XCTAssertEqual(apple?.idToken, "a.b.c")
        XCTAssertEqual(apple?.givenName, "Maya")
        XCTAssertEqual(apple?.familyName, "Okafor")
        XCTAssertNil(SystemSheetWire.apple(identityToken: nil, name: name))
        XCTAssertNil(SystemSheetWire.apple(identityToken: Data(), name: nil))
        XCTAssertNil(SystemSheetWire.apple(identityToken: Data([0xff, 0xfe]), name: nil))
    }

    func testARedirectUrlIsListenedForByItsSchemeOrByItsHostAndPath() {
        XCTAssertEqual(SystemSheetWire.callback(for: "com.example.app://callback"), .scheme("com.example.app"))
        XCTAssertEqual(SystemSheetWire.callback(for: "COM.Example.App:/x"), .scheme("com.example.app"))
        XCTAssertEqual(
            SystemSheetWire.callback(for: "https://app.example.com/auth/callback"),
            .https(host: "app.example.com", path: "/auth/callback"))
        XCTAssertNil(SystemSheetWire.callback(for: "http://localhost:3000/callback"), "the system listens for no http")
        XCTAssertNil(SystemSheetWire.callback(for: "https:///nohost"))
        XCTAssertNil(SystemSheetWire.callback(for: "no scheme at all"))
    }

    func testTheReadingOfAReturnedAddress() {
        let redirect = "https://app.example.com/cb"
        XCTAssertEqual(
            try? ProviderRoundTrip.read("\(redirect)#tula_ticket=a%2Bb&tula_attempt=att&tula_ticket=second&x", redirectURL: redirect).get(),
            ProviderRoundTrip.Answer(ticket: "a+b", attemptId: "att", error: nil), "the first of a name counts")
        XCTAssertEqual(
            try? ProviderRoundTrip.read("\(redirect)#tula_error=oauth.access_denied", redirectURL: redirect).get().error,
            "oauth.access_denied")
        XCTAssertEqual(ProviderRoundTrip.known("oauth.access_denied"), "oauth.access_denied")
        XCTAssertEqual(ProviderRoundTrip.known("network.failed"), "oauth.provider_error", "a client code is no contract code")
        XCTAssertEqual(ProviderRoundTrip.known("<script>"), "oauth.provider_error")
        XCTAssertEqual(ProviderRoundTrip.ticketHold, 60)
    }
}
