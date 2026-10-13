import Foundation
import XCTest

@testable import TulaAuth

// The session's rules (ADR 0051), each against a fake API: single flight, the one repeat of a
// refresh that got no answer, a session kept through every failure that is not a refusal,
// and a sign-out that says when the server was not told.
final class SessionTests: XCTestCase {
    private func refreshToken(_ request: URLRequest) -> String? {
        Fixture.body(request)["refreshToken"] as? String
    }

    // MARK: Loading

    func testNothingStoredIsSignedOutWithoutARequest() async throws {
        let world = try World()
        let state = try await world.session.load()
        XCTAssertEqual(state, .signedOut)
        XCTAssertEqual(world.api.requests.count, 0)
        let token = try await world.session.getToken()
        XCTAssertNil(token)
    }

    func testAStoredTokenIsRefreshedAndTheNextOneStored() async throws {
        let world = try await World.signedIn()
        guard case .signedIn(let sessionId, let user) = await world.session.state else {
            return XCTFail("not signed in")
        }
        XCTAssertEqual(sessionId, "ses_1")
        XCTAssertEqual(user?.id, "usr_1")
        XCTAssertEqual(refreshToken(world.api.requests(Fixture.refresh)[0]), "refresh-stored")
        let stored = await world.storage.only
        XCTAssertEqual(stored, "refresh-first")
        let token = try await world.session.getToken()
        XCTAssertEqual(token, Fixture.accessToken("first"))
        // The stored token was read once; the storage is not asked again for every token.
        let reads = await world.storage.reads
        XCTAssertEqual(reads, 1)
    }

    func testTheProfileIsSentWithTheAccessTokenAndAFailedProfileKeepsTheSession() async throws {
        let world = try World()
        await world.storage.put(Fixture.storageKey, "refresh-stored")
        world.api.on(Fixture.refresh, Reply(json: Fixture.tokens("first")))
        world.api.always(Fixture.me) { _ in Reply.error(500, "internal") }
        let state = try await world.session.load()
        XCTAssertEqual(state, .signedIn(sessionId: "ses_1", user: nil))
        let sent = world.api.requests(Fixture.me)[0].value(forHTTPHeaderField: "authorization")
        XCTAssertEqual(sent, "Bearer \(Fixture.accessToken("first"))")
    }

    // MARK: Single flight

    func testRefreshIsSingleFlight() async throws {
        let world = try await World.signedIn()
        let gate = Gate()
        world.api.on(Fixture.refresh) { _ in
            await gate.wait()
            return Reply(json: Fixture.tokens("second"))
        }
        let session = world.session
        let callers = (0..<8).map { _ in Task { try await session.refresh() } }
        await eventually("the refresh is in flight") { world.api.count(Fixture.refresh) == 2 }
        // Every caller has asked by now or asks while the request waits: still one request.
        try await Task.sleep(nanoseconds: 20_000_000)
        gate.open()
        for caller in callers {
            let token = try await caller.value
            XCTAssertEqual(token, Fixture.accessToken("second"))
        }
        XCTAssertEqual(world.api.count(Fixture.refresh), 2, "one at load, one for all eight callers")
        let stored = await world.storage.only
        XCTAssertEqual(stored, "refresh-second")
    }

    func testGetTokenSharesTheRefreshUnderWay() async throws {
        let world = try await World.signedIn()
        world.clock.advance(55)
        let gate = Gate()
        world.api.on(Fixture.refresh) { _ in
            await gate.wait()
            return Reply(json: Fixture.tokens("second"))
        }
        let session = world.session
        let callers = (0..<4).map { _ in Task { try await session.getToken() } }
        await eventually("the refresh is in flight") { world.api.count(Fixture.refresh) == 2 }
        gate.open()
        for caller in callers {
            let token = try await caller.value
            XCTAssertEqual(token, Fixture.accessToken("second"))
        }
        XCTAssertEqual(world.api.count(Fixture.refresh), 2)
    }

    // MARK: When a token is refreshed

    func testATokenIsHandedOutUntilItsSkewAndRefreshedInsideIt() async throws {
        let world = try await World.signedIn()
        world.api.on(Fixture.refresh, Reply(json: Fixture.tokens("second")))
        world.clock.advance(49)
        var token = try await world.session.getToken()
        XCTAssertEqual(token, Fixture.accessToken("first"))
        XCTAssertEqual(world.api.count(Fixture.refresh), 1)
        world.clock.advance(2)
        token = try await world.session.getToken()
        XCTAssertEqual(token, Fixture.accessToken("second"))
        XCTAssertEqual(world.api.count(Fixture.refresh), 2)
    }

    func testTheSkewIsHalfOfAShortLifetime() async throws {
        let world = try World()
        await world.storage.put(Fixture.storageKey, "refresh-stored")
        world.api.on(Fixture.refresh, Reply(json: Fixture.tokens("first", lifetime: 8)))
        world.api.on(Fixture.refresh, Reply(json: Fixture.tokens("second", lifetime: 8)))
        try await world.session.load()
        world.clock.advance(3)
        var token = try await world.session.getToken()
        XCTAssertEqual(token, Fixture.accessToken("first", lifetime: 8))
        world.clock.advance(2)
        token = try await world.session.getToken()
        XCTAssertEqual(token, Fixture.accessToken("second", lifetime: 8))
    }

    func testTheLifetimeFallsBackToTheExpirySentBesideAnOpaqueToken() async throws {
        let world = try World()
        await world.storage.put(Fixture.storageKey, "refresh-stored")
        let expires = ISO8601DateFormatter().string(from: world.clock.now().addingTimeInterval(120))
        world.api.on(
            Fixture.refresh,
            Reply(
                json:
                    #"{"sessionId":"ses_1","accessToken":"opaque","accessTokenExpiresAt":"\#(expires)","refreshToken":"refresh-first"}"#
            ))
        try await world.session.load()
        world.clock.advance(100)
        let token = try await world.session.getToken()
        XCTAssertEqual(token, "opaque")
        XCTAssertEqual(world.api.count(Fixture.refresh), 1)
    }

    // MARK: A refresh that got no answer

    func testARefreshWithNoAnswerIsRepeatedOnceWithTheSameToken() async throws {
        let world = try await World.signedIn()
        world.api.on(Fixture.refresh) { _ in throw URLError(.networkConnectionLost) }
        world.api.on(Fixture.refresh, Reply(json: Fixture.tokens("second")))
        let token = try await world.session.refresh()
        XCTAssertEqual(token, Fixture.accessToken("second"))
        let sent = world.api.requests(Fixture.refresh).map(refreshToken)
        XCTAssertEqual(sent, ["refresh-stored", "refresh-first", "refresh-first"])
    }

    func testARefreshWithNoAnswerTwiceIsNotSentAThirdTimeAndKeepsTheSession() async throws {
        let world = try await World.signedIn()
        world.api.always(Fixture.refresh) { _ in throw URLError(.notConnectedToInternet) }
        let session = world.session
        let code = await thrownCode { _ = try await session.refresh() }
        XCTAssertEqual(code, TulaClientErrorCode.networkFailed)
        XCTAssertEqual(world.api.count(Fixture.refresh), 3, "the load, the try and its one repeat")
        let state = await session.state
        XCTAssertTrue(state.isSignedIn, "offline is not signed out")
        let stored = await world.storage.only
        XCTAssertEqual(stored, "refresh-first", "the stored token is left where it is")

        // The network is back: the same token still refreshes.
        world.api.always(Fixture.refresh) { _ in Reply(json: Fixture.tokens("second")) }
        let token = try await session.refresh()
        XCTAssertEqual(token, Fixture.accessToken("second"))
        XCTAssertEqual(refreshToken(world.api.requests(Fixture.refresh)[3]), "refresh-first")
    }

    func testOfflineInsideTheSkewHandsOutTheTokenThatIsStillValid() async throws {
        let world = try await World.signedIn()
        world.api.always(Fixture.refresh) { _ in throw URLError(.notConnectedToInternet) }
        world.clock.advance(55)
        let token = try await world.session.getToken()
        XCTAssertEqual(token, Fixture.accessToken("first"))
        world.clock.advance(10)
        let session = world.session
        let code = await thrownCode { _ = try await session.getToken() }
        XCTAssertEqual(code, TulaClientErrorCode.networkFailed)
        let state = await session.state
        XCTAssertTrue(state.isSignedIn)
    }

    func testAnHTTPAnswerIsNeverRepeated() async throws {
        let world = try await World.signedIn()
        world.api.always(Fixture.refresh) { _ in Reply.error(500, "internal") }
        let session = world.session
        let code = await thrownCode { _ = try await session.refresh() }
        XCTAssertEqual(code, "internal")
        XCTAssertEqual(world.api.count(Fixture.refresh), 2, "the load and one try: an answer is not repeated")
        let state = await session.state
        XCTAssertTrue(state.isSignedIn)
        let stored = await world.storage.only
        XCTAssertEqual(stored, "refresh-first")
    }

    func testARetryAfterMakesGetTokenFailFastAndAnExplicitRefreshStillAsks() async throws {
        let world = try await World.signedIn()
        world.api.always(Fixture.refresh) { _ in Reply.error(429, "rate_limited", headers: ["Retry-After": "30"]) }
        world.clock.advance(70)
        let session = world.session
        var code = await thrownCode { _ = try await session.getToken() }
        XCTAssertEqual(code, "rate_limited")
        XCTAssertEqual(world.api.count(Fixture.refresh), 2)
        code = await thrownCode { _ = try await session.getToken() }
        XCTAssertEqual(code, "rate_limited")
        XCTAssertEqual(world.api.count(Fixture.refresh), 2, "inside the wait nothing is asked")
        code = await thrownCode { _ = try await session.refresh() }
        XCTAssertEqual(world.api.count(Fixture.refresh), 3, "the app asking now always asks")
        world.clock.advance(31)
        world.api.always(Fixture.refresh) { _ in Reply(json: Fixture.tokens("second")) }
        let token = try await session.getToken()
        XCTAssertEqual(token, Fixture.accessToken("second"))
    }

    func testARefreshGivesUpAtItsDeadlineWhateverTheTransportDoes() async throws {
        let world = try await World.signedIn(timeout: 0.2)
        let gate = Gate()
        world.api.always(Fixture.refresh) { _ in
            // Never answers, and does not stop when it is cancelled.
            await gate.wait()
            return Reply(json: Fixture.tokens("late"))
        }
        let session = world.session
        let started = Date()
        let code = await thrownCode { _ = try await session.refresh() }
        XCTAssertEqual(code, TulaClientErrorCode.networkTimeout)
        XCTAssertLessThan(Date().timeIntervalSince(started), 2)
        XCTAssertEqual(world.api.count(Fixture.refresh), 3, "the load, the try and its one repeat")
        let state = await session.state
        XCTAssertTrue(state.isSignedIn)
        gate.open()
    }

    /// The numbers are `@tula/core`'s, read from its source: a change there fails here.
    func testTheRefreshDeadlinesAreCoresAndBelowTheSmallestGraceWindow() throws {
        let root = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        let core = try String(contentsOf: root.appendingPathComponent("packages/core/src/session.ts"), encoding: .utf8)
        let profile = try String(
            contentsOf: root.appendingPathComponent("packages/contract/src/session-profile.ts"), encoding: .utf8)
        XCTAssertTrue(core.contains("export const REFRESH_TIMEOUT_MS = 8_000\n"))
        XCTAssertTrue(core.contains("export const REFRESH_RETRY_WINDOW_MS = 10_000\n"))
        XCTAssertTrue(core.contains("export const ACCESS_TOKEN_EXPIRY_SKEW_MS = 10_000\n"))
        XCTAssertTrue(core.contains("export const MAX_REFRESH_BACKOFF_MS = 5 * 60_000\n"))
        XCTAssertTrue(profile.contains("export const MIN_REUSE_GRACE_PERIOD: Duration = '10s'\n"))
        XCTAssertEqual(TulaSession.refreshTimeout, 8)
        XCTAssertEqual(TulaSession.refreshRetryWindow, 10)
        XCTAssertEqual(TulaSession.accessTokenExpirySkew, 10)
        XCTAssertEqual(TulaSession.maxRefreshBackoff, 300)
        XCTAssertLessThan(TulaSession.refreshTimeout, 10)
    }

    // MARK: A refusal

    func testARefusedRefreshEndsTheSessionOnce() async throws {
        for code in ["session.reuse_detected", "session.expired", "auth.unauthenticated", "auth.user_banned"] {
            let world = try await World.signedIn()
            world.api.always(Fixture.refresh) { _ in Reply.error(401, code) }
            let token = try await world.session.refresh()
            XCTAssertNil(token, code)
            let state = await world.session.state
            XCTAssertEqual(state, .signedOut, code)
            let stored = await world.storage.only
            XCTAssertNil(stored, code)
            let later = try await world.session.getToken()
            XCTAssertNil(later)
            XCTAssertEqual(world.api.count(Fixture.refresh), 2, "nothing is retried after a refusal")
        }
    }

    func testARefusalThatIsNotAboutTheSessionKeepsIt() async throws {
        let world = try await World.signedIn()
        world.api.always(Fixture.refresh) { _ in Reply.error(401, "auth.invalid_key") }
        let session = world.session
        let code = await thrownCode { _ = try await session.refresh() }
        XCTAssertEqual(code, "auth.invalid_key")
        let state = await session.state
        XCTAssertTrue(state.isSignedIn)
        let stored = await world.storage.only
        XCTAssertEqual(stored, "refresh-first")
    }

    func testA200ThatIsNotSessionTokensInstallsNothing() async throws {
        let world = try await World.signedIn()
        world.api.on(Fixture.refresh, Reply(json: #"{"sessionId":"ses_1"}"#))
        world.api.on(Fixture.refresh, Reply(json: "<html>a proxy</html>"))
        let session = world.session
        var code = await thrownCode { _ = try await session.refresh() }
        XCTAssertEqual(code, TulaClientErrorCode.responseInvalid)
        code = await thrownCode { _ = try await session.refresh() }
        XCTAssertEqual(code, TulaClientErrorCode.responseInvalid)
        let stored = await world.storage.only
        XCTAssertEqual(stored, "refresh-first")
        let token = try await session.getToken()
        XCTAssertEqual(token, Fixture.accessToken("first"))
    }

    // MARK: The storage

    func testAStorageThatCannotBeReadIsNotSignedOut() async throws {
        let world = try World()
        await world.storage.put(Fixture.storageKey, "refresh-stored")
        await world.storage.fail("get")
        world.api.on(Fixture.refresh, Reply(json: Fixture.tokens("first")))
        let session = world.session
        let code = await thrownCode { _ = try await session.load() }
        XCTAssertEqual(code, TulaClientErrorCode.storageFailed)
        var state = await session.state
        XCTAssertEqual(state, .loading, "not signed out: nothing is known yet")
        XCTAssertEqual(world.api.requests.count, 0)
        let stored = await world.storage.only
        XCTAssertEqual(stored, "refresh-stored")

        await world.storage.fail()
        state = try await session.load()
        XCTAssertTrue(state.isSignedIn)
    }

    func testAStorageThatCannotBeWrittenKeepsTheSessionAndSaysSo() async throws {
        let world = try await World.signedIn()
        await world.storage.fail("set")
        world.api.on(Fixture.refresh, Reply(json: Fixture.tokens("second")))
        world.api.on(Fixture.refresh, Reply(json: Fixture.tokens("third")))
        let session = world.session
        let code = await thrownCode { _ = try await session.refresh() }
        XCTAssertEqual(code, TulaClientErrorCode.storageFailed)
        let state = await session.state
        XCTAssertTrue(state.isSignedIn)
        let token = try await session.getToken()
        XCTAssertEqual(token, Fixture.accessToken("second"), "the running app has the new tokens")
        // What the docs say of it: the storage still holds the token the server has replaced,
        // so an app ended now and started past the grace window would be signed out.
        let stale = await world.storage.only
        XCTAssertNotEqual(stale, "refresh-second")
        XCTAssertNotNil(stale)
        // The next refresh presents the token the memory has, not the stale stored one.
        await world.storage.fail()
        _ = try await session.refresh()
        XCTAssertEqual(refreshToken(world.api.requests(Fixture.refresh)[2]), "refresh-second")
        let stored = await world.storage.only
        XCTAssertEqual(stored, "refresh-third")
    }

    // MARK: Signing out

    func testSignOutTellsTheServerAndForgetsTheToken() async throws {
        let world = try await World.signedIn()
        world.api.on(Fixture.signOut, Reply(status: 204, json: ""))
        try await world.session.signOut()
        let state = await world.session.state
        XCTAssertEqual(state, .signedOut)
        let stored = await world.storage.only
        XCTAssertNil(stored)
        XCTAssertEqual(refreshToken(world.api.requests(Fixture.signOut)[0]), "refresh-first")
        // Nothing is left to revoke: a second sign-out asks nothing.
        try await world.session.signOut()
        XCTAssertEqual(world.api.count(Fixture.signOut), 1)
    }

    func testAFailedSignOutIsNotASignOut() async throws {
        let world = try await World.signedIn()
        world.api.on(Fixture.signOut) { _ in throw URLError(.notConnectedToInternet) }
        world.api.on(Fixture.signOut, Reply(status: 204, json: ""))
        let session = world.session
        let code = await thrownCode { try await session.signOut() }
        XCTAssertEqual(code, TulaClientErrorCode.networkFailed, "the server was not told, and the call says so")
        let state = await session.state
        XCTAssertEqual(state, .signedOut, "this device is signed out all the same")
        let stored = await world.storage.only
        XCTAssertNil(stored, "the token of a failed sign-out is not left in the storage")
        let token = try await session.getToken()
        XCTAssertNil(token, "and no refresh presents it")
        XCTAssertEqual(world.api.count(Fixture.refresh), 1)

        // Asked again, the same token is what the server is told to end.
        try await session.signOut()
        XCTAssertEqual(world.api.requests(Fixture.signOut).map(refreshToken), ["refresh-first", "refresh-first"])
        try await session.signOut()
        XCTAssertEqual(world.api.count(Fixture.signOut), 2)
    }

    func testASignOutTheServerRefusedForTheSessionIsNotKeptForARetry() async throws {
        let world = try await World.signedIn()
        world.api.always(Fixture.signOut) { _ in Reply.error(401, "session.revoked") }
        let session = world.session
        let code = await thrownCode { try await session.signOut() }
        XCTAssertEqual(code, "session.revoked")
        try await session.signOut()
        XCTAssertEqual(world.api.count(Fixture.signOut), 1)
    }

    func testASignOutWhoseStorageFailsSaysSoAndStillTellsTheServer() async throws {
        let world = try await World.signedIn()
        await world.storage.fail("remove")
        world.api.on(Fixture.signOut, Reply(status: 204, json: ""))
        let session = world.session
        let code = await thrownCode { try await session.signOut() }
        XCTAssertEqual(code, TulaClientErrorCode.storageFailed)
        XCTAssertEqual(world.api.count(Fixture.signOut), 1)
        let state = await session.state
        XCTAssertEqual(state, .signedOut)
    }

    func testASignOutDuringARefreshEndsTheSessionWithTheNewestToken() async throws {
        let world = try await World.signedIn()
        let gate = Gate()
        world.api.on(Fixture.refresh) { _ in
            await gate.wait()
            return Reply(json: Fixture.tokens("second"))
        }
        world.api.on(Fixture.signOut, Reply(status: 204, json: ""))
        let session = world.session
        let refresh = Task { try await session.refresh() }
        await eventually("the refresh is in flight") { world.api.count(Fixture.refresh) == 2 }
        let signOut = Task { try await session.signOut() }
        await eventually("the sign-out has ended the local session") { await session.state == .signedOut }
        gate.open()
        try await signOut.value
        let token = try await refresh.value
        XCTAssertNil(token, "the refresh that lost installs nothing")
        let state = await session.state
        XCTAssertEqual(state, .signedOut)
        let stored = await world.storage.only
        XCTAssertNil(stored)
        XCTAssertEqual(
            refreshToken(world.api.requests(Fixture.signOut)[0]), "refresh-second",
            "the token the refresh was issued is the one that is revoked")
    }

    func testSignOutBeforeTheStorageWasReadRevokesTheStoredToken() async throws {
        let world = try World()
        await world.storage.put(Fixture.storageKey, "refresh-stored")
        world.api.on(Fixture.signOut, Reply(status: 204, json: ""))
        try await world.session.signOut()
        XCTAssertEqual(refreshToken(world.api.requests(Fixture.signOut)[0]), "refresh-stored")
        let stored = await world.storage.only
        XCTAssertNil(stored)
    }

    func testSignOutRemovesAStoredTokenItCouldNotRead() async throws {
        // Never read, and unreadable now: the client cannot tell the server about a token it
        // never held, but it must not leave it behind to sign the user in at the next launch.
        let world = try World()
        await world.storage.put(Fixture.storageKey, "refresh-stored")
        await world.storage.fail("get")
        let session = world.session
        let code = await thrownCode { try await session.signOut() }
        XCTAssertEqual(code, TulaClientErrorCode.storageFailed)
        XCTAssertEqual(world.api.requests.count, 0, "there is no token to present")
        let stored = await world.storage.only
        XCTAssertNil(stored)
        let state = await session.state
        XCTAssertEqual(state, .signedOut)
    }

    // MARK: Calls as the user

    func testACallWhoseTokenIsRefusedRefreshesOnceAndIsSentAgain() async throws {
        let world = try await World.signedIn()
        let list = "GET /v1/client/sessions"
        world.api.on(list, Reply.error(401, "session.expired"))
        world.api.on(
            list,
            Reply(
                json:
                    #"{"data":[{"id":"ses_1","client":"ios","userAgent":null,"ipAddress":null,"createdAt":"2026-01-01T00:00:00.000Z","lastActiveAt":"2026-01-01T00:00:00.000Z","expiresAt":"2026-02-01T00:00:00.000Z","current":true,"deviceBound":false}]}"#
            ))
        world.api.on(Fixture.refresh, Reply(json: Fixture.tokens("second")))
        let sessions = try await world.session.list()
        XCTAssertEqual(sessions.map(\.id), ["ses_1"])
        let sent = world.api.requests(list).map { $0.value(forHTTPHeaderField: "authorization") }
        XCTAssertEqual(sent, ["Bearer \(Fixture.accessToken("first"))", "Bearer \(Fixture.accessToken("second"))"])
    }

    func testACallRefusedTwiceThrowsAndACallWithNobodySignedInAsksNothing() async throws {
        let world = try await World.signedIn()
        let list = "GET /v1/client/sessions"
        world.api.always(list) { _ in Reply.error(401, "auth.unauthenticated") }
        world.api.on(Fixture.refresh, Reply(json: Fixture.tokens("second")))
        let session = world.session
        var code = await thrownCode { _ = try await session.list() }
        XCTAssertEqual(code, "auth.unauthenticated")
        XCTAssertEqual(world.api.count(list), 2)

        let empty = try World()
        let other = empty.session
        code = await thrownCode { _ = try await other.list() }
        XCTAssertEqual(code, "auth.unauthenticated")
        XCTAssertEqual(empty.api.requests.count, 0)
    }

    func testRevokingThisSessionSignsOutHereAndRevokingAnotherDoesNot() async throws {
        let world = try await World.signedIn()
        world.api.always("DELETE /v1/client/sessions/ses_other") { _ in Reply(status: 204, json: "") }
        world.api.always("DELETE /v1/client/sessions/ses_1") { _ in Reply(status: 204, json: "") }
        world.api.always("POST /v1/client/sessions/revoke-others") { _ in Reply(json: #"{"revoked":2}"#) }
        try await world.session.revoke("ses_other")
        var state = await world.session.state
        XCTAssertTrue(state.isSignedIn)
        let ended = try await world.session.revokeOthers()
        XCTAssertEqual(ended, 2)
        try await world.session.revoke("ses_1")
        state = await world.session.state
        XCTAssertEqual(state, .signedOut)
        let stored = await world.storage.only
        XCTAssertNil(stored)
    }

    // MARK: The state

    func testUpdatesGiveTheStateNowAndEveryStateAfter() async throws {
        let world = try World()
        await world.storage.put(Fixture.storageKey, "refresh-stored")
        world.api.on(Fixture.refresh, Reply(json: Fixture.tokens("first")))
        world.api.on(Fixture.signOut, Reply(status: 204, json: ""))
        var updates = await world.session.updates().makeAsyncIterator()
        let first = await updates.next()
        XCTAssertEqual(first, .loading)
        try await world.session.load()
        let second = await updates.next()
        XCTAssertEqual(second?.isSignedIn, true)
        try await world.session.signOut()
        let third = await updates.next()
        XCTAssertEqual(third, .signedOut)
    }

    func testTheHelpersThatReadAnAnswer() {
        XCTAssertEqual(TulaSession.jwtLifetime(Fixture.accessToken("a", lifetime: 90)), 90)
        XCTAssertNil(TulaSession.jwtLifetime("opaque"))
        XCTAssertNil(TulaSession.jwtLifetime("a.!!!.c"))
        XCTAssertNil(TulaSession.jwtLifetime("a.\(Fixture.base64url(#"{"iat":10,"exp":10}"#)).c"))
        XCTAssertNotNil(TulaSession.date("2030-01-01T00:00:00.000Z"))
        XCTAssertNotNil(TulaSession.date("2030-01-01T00:00:00Z"))
        XCTAssertNil(TulaSession.date("tomorrow"))
        XCTAssertFalse(AuthState.loading.isSignedIn)
    }
}
