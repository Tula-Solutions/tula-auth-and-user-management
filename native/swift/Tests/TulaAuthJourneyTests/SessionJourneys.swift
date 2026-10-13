import Foundation
import XCTest

@testable import TulaAuth

// The Swift client against the real API: the session. The journeys of the `swift` column
// that are about tokens, and the four named client behaviours: what a client does on its
// own, between requests, which no HTTP scenario can show.
final class SessionJourneys: JourneyTestCase {
    /// How many of a client's next refresh answers are lost on the way back.
    private final class Losses: @unchecked Sendable {
        private let lock = NSLock()
        private var left = 0

        func next(_ count: Int) { lock.withLock { left = count } }

        func take(_ request: URLRequest) -> Bool {
            lock.withLock {
                guard request.url?.path.hasSuffix("/sessions/refresh") == true, left > 0 else { return false }
                left -= 1
                return true
            }
        }
    }

    /// A signed-in device whose next refresh answers can be lost on the way back.
    private func signedInDevice(_ s: Server) async throws -> (app: App, losses: Losses) {
        let (app, _) = try await s.signUp()
        let losses = Losses()
        app.wire.loseResponse { losses.take($0) }
        return (app, losses)
    }

    private func refreshToken(_ exchange: Exchange) -> String? {
        let body = try? JSONSerialization.jsonObject(with: Data(exchange.requestBody.utf8)) as? [String: Any]
        return body?["refreshToken"] as? String
    }

    // MARK: Rotation and sign-out

    func testRefreshRotationAndReuseDetection() async throws {
        try await journey(
            "refresh rotation and reuse detection",
            "refresh: rotates the stored token; a replay inside the grace period is forgiven, after it the session ends"
        ) { s in
            let (app, _) = try await s.signUp()
            let key = s.storageKey
            let first = try unwrap(await app.storage.get(key))
            XCTAssertTrue(first.hasPrefix("tula_rt_"))
            let firstAccess = try await app.session.getToken()

            // Rotation: a new access token and a new refresh token, stored in place of the old.
            try await s.advance(1)
            let secondAccess = try await app.session.refresh()
            let second = try unwrap(await app.storage.get(key))
            XCTAssertTrue(second.hasPrefix("tula_rt_"))
            XCTAssertNotEqual(second, first)
            XCTAssertNotEqual(secondAccess, firstAccess)

            // A second device restored from a copy of the old token, inside the grace period:
            // it is given the same next token, not a new one, and nobody is signed out.
            let copy = MemoryTokenStorage()
            await copy.set(key, first)
            let racer = try s.client(storage: copy)
            var loaded = try await racer.session.load()
            XCTAssertTrue(loaded.isSignedIn)
            let copied = await copy.get(key)
            XCTAssertEqual(copied, second)
            var state = await app.state()
            XCTAssertTrue(state.isSignedIn)

            // The same replay after the grace period is reuse: the whole session ends.
            try await s.advance(11)
            let thief = MemoryTokenStorage()
            await thief.set(key, first)
            let late = try s.client(storage: thief)
            loaded = try await late.session.load()
            XCTAssertEqual(loaded, .signedOut)
            let emptied = await thief.get(key)
            XCTAssertNil(emptied)
            var refreshes = try await s.refreshes()
            XCTAssertEqual(refreshes.last?.status, 401)
            XCTAssertTrue(refreshes.last?.responseBody.contains("session.reuse_detected") == true)

            // The legitimate client finds out at its next refresh: signed out once, no retry loop.
            let before = refreshes.count
            let token = try await app.session.refresh()
            XCTAssertNil(token)
            state = await app.state()
            XCTAssertEqual(state, .signedOut)
            let statuses = await app.statuses()
            XCTAssertEqual(statuses, ["signed-in", "signed-out"])
            let later = try await app.session.getToken()
            XCTAssertNil(later)
            refreshes = try await s.refreshes()
            XCTAssertEqual(refreshes.count, before + 1)
            let stored = await app.storage.get(key)
            XCTAssertNil(stored)
        }
    }

    func testSignOut() async throws {
        try await journey(
            "sign-out",
            "sign-out: ends the session on the server and in the client"
        ) { s in
            let (app, _) = try await s.signUp()
            let key = s.storageKey
            let refreshToken = try unwrap(await app.storage.get(key))

            try await app.session.signOut()
            let state = await app.state()
            XCTAssertEqual(state, .signedOut)
            let stored = await app.storage.get(key)
            XCTAssertNil(stored)
            let last = try unwrap(try await s.exchanges().last)
            XCTAssertEqual(last.path, "/v1/client/sessions/sign-out")
            XCTAssertEqual(last.status, 204)

            // The refresh token is dead on the server too.
            let replay = MemoryTokenStorage()
            await replay.set(key, refreshToken)
            let loaded = try await s.client(storage: replay).session.load()
            XCTAssertEqual(loaded, .signedOut)
            // Signing out again (nothing to revoke) is not an error.
            try await app.session.signOut()
        }
    }

    /// Not a scenario of the list (no HTTP scenario can lose a request): the client's rule
    /// that a failed sign-out is not a sign-out, against the real API.
    func testAFailedSignOutIsNotASignOutAndTheRetryEndsTheSessionOnTheServer() async throws {
        let s = try await server()
        let (app, _) = try await s.signUp()
        let key = s.storageKey
        let refreshToken = try unwrap(await app.storage.get(key))

        app.wire.offline = true
        let error = try await caught { try await app.session.signOut() }
        XCTAssertEqual(error.code, TulaClientErrorCode.networkFailed)
        let state = await app.state()
        XCTAssertEqual(state, .signedOut, "this device is signed out")
        let stored = await app.storage.get(key)
        XCTAssertNil(stored)
        // The server was never told: the session is alive there, as the thrown error said.
        let other = MemoryTokenStorage()
        await other.set(key, refreshToken)
        let alive = try await s.client(storage: other).session.load()
        XCTAssertTrue(alive.isSignedIn)

        // Asked again with the network back, the server is told, with the newest token of
        // the session: the copy's refresh was inside the grace window, so the family lives
        // and ends here.
        app.wire.offline = false
        try await app.session.signOut()
        let signOuts = try await s.exchanges("/v1/client/sessions/sign-out")
        XCTAssertEqual(signOuts.map(\.status), [204])
        XCTAssertEqual(refreshToken, self.refreshToken(try unwrap(signOuts.last)))
    }

    // MARK: Session profiles

    func testSessionProfileTimeouts() async throws {
        try await journey(
            "session profile timeouts",
            "a session past its profile's limits signs the client out at its next refresh"
        ) { s in
            let (before, email) = try await s.signUp()
            try await s.settings([
                "sessions": [
                    "profiles": ["mobile": ["accessTokenTtl": "30s", "idleTimeout": "1m", "absoluteTimeout": "90s"]]
                ]
            ])
            let active = try await s.signIn(email).app
            let profile = try await active.claims()["sp"] as? String
            XCTAssertEqual(profile, "mobile")

            try await s.advance(50)
            var token = try await active.session.refresh()
            XCTAssertNotNil(token)
            var state = await active.state()
            XCTAssertTrue(state.isSignedIn)

            try await s.advance(45)
            // Active 45 seconds ago, but 95 seconds old: the absolute timeout ends it.
            token = try await active.session.refresh()
            XCTAssertNil(token)
            state = await active.state()
            XCTAssertEqual(state, .signedOut)
            // The session from before the profile was tightened ends at its next refresh too.
            token = try await before.session.refresh()
            XCTAssertNil(token)
            state = await before.state()
            XCTAssertEqual(state, .signedOut)
        }
    }

    func testSessionProfileSelection() async throws {
        try await journey(
            "session profile selection",
            "sessionProfile gets a profile the environment offers, and is otherwise ignored"
        ) { s in
            try await s.settings([
                "sessions": [
                    "profiles": [
                        "back-office": ["accessTokenTtl": "2m", "clientSelectable": true],
                        "kept": ["idleTimeout": "365d", "absoluteTimeout": NSNull()],
                    ]
                ]
            ])
            let (_, email) = try await s.signUp()
            for (asked, given) in [("back-office", "back-office"), ("kept", "mobile"), ("no-such-profile", "mobile")] {
                let app = try await s.signIn(email, sessionProfile: asked).app
                let profile = try await app.claims()["sp"] as? String
                XCTAssertEqual(profile, given, asked)
                let sent = try unwrap(try await s.exchanges("/v1/client/sign-ins").last)
                XCTAssertEqual(sent.headers["x-tula-session-profile"], asked)
            }
            let plain = try await s.signIn(email).app
            let profile = try await plain.claims()["sp"] as? String
            XCTAssertEqual(profile, "mobile")
        }
    }

    func testJwtTemplateCustomClaims() async throws {
        try await journey(
            "jwt template custom claims",
            "the token the client hands out carries the template's claims, from the next refresh on"
        ) { s in
            let (app, email) = try await s.signUp()
            var token = try await app.session.getToken()
            XCTAssertNil(Journey.customClaims(token))

            try await s.settings([
                "sessions": [
                    "jwtTemplates": [
                        "app": [
                            "claims": [
                                "role": ["value": "member"],
                                "email": ["from": "user.email"],
                                "verified": ["from": "user.email_verified"],
                                "client": ["from": "session.client"],
                            ]
                        ]
                    ],
                    "profiles": ["mobile": ["jwtTemplate": "app"]],
                ]
            ])
            // The token in hand is unchanged; the one a refresh brings has the claims.
            token = try await app.session.getToken()
            XCTAssertNil(Journey.customClaims(token))
            token = try await app.session.refresh()
            XCTAssertEqual(
                Journey.customClaims(token),
                ["role": "member", "email": email, "verified": true, "client": "ios"])

            let again = try await s.signIn(email).app
            let claims = Journey.customClaims(try await again.session.getToken())
            XCTAssertEqual(claims?["role"] as? String, "member")
            XCTAssertEqual(claims?["client"] as? String, "ios")

            try await s.settings(["sessions": ["jwtTemplates": ["app": ["claims": [:] as [String: Any]]]]])
            token = try await app.session.refresh()
            XCTAssertNotNil(token)
            XCTAssertNil(Journey.customClaims(token))
        }
    }

    func testConcurrentSessionLimit() async throws {
        try await journey(
            "concurrent session limit",
            "end_oldest signs the oldest client out; refuse_newest fails the sign-in with session.limit_reached"
        ) { s in
            try await s.settings(["sessions": ["maxPerUser": 2, "onLimit": "end_oldest"]])
            let (first, email) = try await s.signUp()
            let second = try await s.signIn(email)
            let third = try await s.signIn(email)
            XCTAssertEqual(third.step.status, "complete")
            // The oldest device finds out on its next call: its token is refused and it
            // cannot refresh.
            let revoked = try await caught { try await first.session.list() }
            XCTAssertEqual(revoked.code, "session.revoked")
            var state = await first.state()
            XCTAssertEqual(state, .signedOut)
            let sessions = try await second.app.session.list()
            XCTAssertEqual(sessions.count, 2)

            try await s.settings(["sessions": ["maxPerUser": 2, "onLimit": "refuse_newest"]])
            let refused = try s.client()
            let flow = try await refused.tula.startSignIn(identifier: email)
            let error = try await caught { try await flow.submitPassword(Journey.password) }
            XCTAssertEqual(error.code, "session.limit_reached")
            XCTAssertEqual(error.status, 403)
            XCTAssertTrue(error.message.contains("too many devices"), error.message)
            state = await refused.state()
            XCTAssertFalse(state.isSignedIn)

            try await second.app.session.signOut()
            let again = try await s.signIn(email)
            XCTAssertEqual(again.step.status, "complete")
        }
    }

    // MARK: The named client behaviours

    func testConcurrentRefresh() async throws {
        try await behaviour(
            "concurrent_refresh",
            "an expired access token is refreshed before use; 10 concurrent calls share one refresh"
        ) { s in
            let (app, _) = try await s.signUp()
            let first = try await app.session.getToken()

            try await s.advance(49)
            let still = try await app.session.getToken()
            XCTAssertEqual(still, first)
            var refreshes = try await s.refreshes()
            XCTAssertEqual(refreshes.count, 0)

            try await s.advance(2)
            let session = app.session
            let tokens = try await withThrowingTaskGroup(of: String?.self) { group -> [String?] in
                for _ in 0..<10 {
                    group.addTask { try await session.getToken() }
                }
                var all: [String?] = []
                for try await token in group { all.append(token) }
                return all
            }
            XCTAssertEqual(tokens.count, 10)
            XCTAssertEqual(Set(tokens).count, 1)
            XCTAssertNotNil(tokens[0])
            XCTAssertNotEqual(tokens[0], first)
            refreshes = try await s.refreshes()
            XCTAssertEqual(refreshes.count, 1, "ten callers, one request")

            // A call made with a token the server has just stopped accepting is retried once.
            try await s.advanceServer(61)
            let sessions = try await app.session.list()
            XCTAssertEqual(sessions.count, 1)
            refreshes = try await s.refreshes()
            XCTAssertEqual(refreshes.count, 2)
            let listing = try await s.exchanges("/v1/client/sessions")
            XCTAssertEqual(listing.map(\.status), [401, 200])
        }
    }

    func testSessionKeptThroughAFailedRefreshOffline() async throws {
        try await behaviour(
            "session_kept_through_failed_refresh_offline",
            "offline when the token runs out: the refresh fails, the session and its stored token are kept, and it goes on when the network is back"
        ) { s in
            let (app, _) = try await s.signUp()
            let key = s.storageKey
            let stored = try unwrap(await app.storage.get(key))
            let signedIn = await app.state()

            // The access token runs out with no network. Nothing reaches the server, so
            // nothing says the session is over: the failure is the network's and the client
            // stays as it was.
            app.wire.offline = true
            try await s.advance(61)
            var error = try await caught { try await app.session.getToken() }
            XCTAssertEqual(error.code, TulaClientErrorCode.networkFailed)
            XCTAssertEqual(error.status, 0)
            // Asked again, still offline: the same, however often.
            error = try await caught { try await app.session.getToken() }
            XCTAssertEqual(error.code, TulaClientErrorCode.networkFailed)
            var refreshes = try await s.refreshes()
            XCTAssertEqual(refreshes.count, 0)
            var state = await app.state()
            XCTAssertEqual(state, signedIn)
            var statuses = await app.statuses()
            XCTAssertEqual(statuses, ["signed-in"])
            var kept = await app.storage.get(key)
            XCTAssertEqual(kept, stored)

            // Back online, the token kept through the outage is still the session's: one
            // refresh, the same session, and no change of state for the app to react to.
            app.wire.offline = false
            let token = try await app.session.getToken()
            XCTAssertNotNil(token)
            refreshes = try await s.refreshes()
            XCTAssertEqual(refreshes.map(\.status), [200])
            kept = await app.storage.get(key)
            XCTAssertNotEqual(kept, stored)
            let sessions = try await app.session.list()
            XCTAssertEqual(sessions.map(\.id), [try unwrap(signedIn.sessionId)])
            state = await app.state()
            XCTAssertEqual(state.sessionId, signedIn.sessionId)
            statuses = await app.statuses()
            XCTAssertEqual(statuses, ["signed-in"])
        }
    }

    func testAnUnknownStepIsNotSupported() async throws {
        try await behaviour(
            "unknown_step_not_supported",
            "a step from a newer server is `notSupported`, kept as it was sent: no error, nobody signed in, and no request made on a guess"
        ) { s in
            let (_, email) = try await s.signUp()
            let app = try s.client()
            // The real server's answer to the start, with its step replaced by one no client
            // of today has a screen for: what a server a few versions on may send.
            app.wire.answer { request, data in
                guard
                    request.url?.path.hasSuffix("/v1/client/sign-ins") == true,
                    var body = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                    body["attemptSecret"] != nil
                else {
                    return data
                }
                body["step"] = ["status": "needs_retina_scan", "prompt": "look into the camera"]
                return (try? JSONSerialization.data(withJSONObject: body)) ?? data
            }
            let before = try await s.exchanges().count

            let flow = try await app.tula.startSignIn(identifier: email)
            XCTAssertEqual(flow.screen, .notSupported(status: "needs_retina_scan"))
            XCTAssertEqual(
                flow.step,
                .unknown(
                    status: "needs_retina_scan",
                    raw: .object(["status": .string("needs_retina_scan"), "prompt": .string("look into the camera")])))
            XCTAssertEqual(flow.kind, .signIn)
            // The start, and nothing after it: the client proves nothing and asks nothing by
            // itself.
            let made = try await s.exchanges().dropFirst(before).map(\.path)
            XCTAssertEqual(made, ["/v1/client/sign-ins"])
            let state = await app.state()
            XCTAssertFalse(state.isSignedIn)
            let statuses = await app.statuses()
            XCTAssertEqual(statuses, [])
            let stored = await app.storage.get(s.storageKey)
            XCTAssertNil(stored)

            // The app can leave the attempt, and a new one is a sign-in like any other.
            flow.discard()
            let signedIn = try await s.signIn(email)
            XCTAssertEqual(signedIn.step.status, "complete")
        }
    }

    func testARefreshWhoseAnswerIsLostOnce() async throws {
        try await behaviour(
            "refresh_without_answer",
            "one lost response: getToken() alone ends with a working session, the family intact and the next token stored"
        ) { s in
            let (app, losses) = try await self.signedInDevice(s)
            let before = try unwrap(await app.storage.get(s.storageKey))
            try await s.advance(61)

            // The server rotates the token; the answer never arrives. The client asks again
            // at once with the token it still holds, and is given the same next token.
            losses.next(1)
            let token = try await app.session.getToken()
            XCTAssertNotNil(token)
            var refreshes = try await s.refreshes()
            XCTAssertEqual(refreshes.map(\.status), [200, 200])
            XCTAssertEqual(refreshes.map(self.refreshToken), [before, before])
            XCTAssertEqual(refreshes[0].responseBody.contains("tula_rt_"), true)
            let first = try JSONDecoder().decode(SessionTokens.self, from: Data(refreshes[0].responseBody.utf8))
            let second = try JSONDecoder().decode(SessionTokens.self, from: Data(refreshes[1].responseBody.utf8))
            XCTAssertEqual(first.refreshToken, second.refreshToken, "the same next token, never a new one")
            let state = await app.state()
            XCTAssertTrue(state.isSignedIn)
            let sessions = try await app.session.list()
            XCTAssertEqual(sessions.count, 1)
            let stored = await app.storage.get(s.storageKey)
            XCTAssertEqual(stored, second.refreshToken)

            // The family was not revoked: the next rotation works, with one request.
            try await s.advance(61)
            let next = try await app.session.getToken()
            XCTAssertNotNil(next)
            refreshes = try await s.refreshes()
            XCTAssertEqual(refreshes.map(\.status), [200, 200, 200])
            let statuses = await app.statuses()
            XCTAssertEqual(statuses, ["signed-in"])
        }
    }

    func testARefreshWhoseAnswerIsLostTwice() async throws {
        try await behaviour(
            "refresh_without_answer",
            "both tries lost, then asked again inside the grace period: the stored token is still the old one, and it still works"
        ) { s in
            let (app, losses) = try await self.signedInDevice(s)
            let before = try unwrap(await app.storage.get(s.storageKey))
            try await s.advance(61)

            losses.next(2)
            let error = try await caught { try await app.session.getToken() }
            XCTAssertEqual(error.code, TulaClientErrorCode.networkFailed)
            // Two tries, no third; the session and its stored token are kept.
            var refreshes = try await s.refreshes()
            XCTAssertEqual(refreshes.map(\.status), [200, 200])
            let state = await app.state()
            XCTAssertTrue(state.isSignedIn)
            var stored = await app.storage.get(s.storageKey)
            XCTAssertEqual(stored, before)

            try await s.advance(3)
            var token = try await app.session.getToken()
            XCTAssertNotNil(token)
            refreshes = try await s.refreshes()
            XCTAssertEqual(refreshes.map(\.status), [200, 200, 200])
            stored = await app.storage.get(s.storageKey)
            XCTAssertNotEqual(stored, before)
            try await s.advance(61)
            token = try await app.session.getToken()
            XCTAssertNotNil(token)
            let statuses = await app.statuses()
            XCTAssertEqual(statuses, ["signed-in"])
        }
    }

    // MARK: More of the session, beyond the list

    func testBothTriesLostThenAskedAgainAfterTheGracePeriodEndsTheSessionOnce() async throws {
        let s = try await server()
        let (app, losses) = try await signedInDevice(s)
        try await s.advance(61)
        losses.next(2)
        _ = try await caught { try await app.session.getToken() }

        try await s.advance(11)
        var token = try await app.session.getToken()
        XCTAssertNil(token)
        var refreshes = try await s.refreshes()
        XCTAssertEqual(refreshes.last?.status, 401)
        XCTAssertTrue(refreshes.last?.responseBody.contains("session.reuse_detected") == true)
        let statuses = await app.statuses()
        XCTAssertEqual(statuses, ["signed-in", "signed-out"])
        let stored = await app.storage.get(s.storageKey)
        XCTAssertNil(stored)
        // No retry loop.
        token = try await app.session.getToken()
        XCTAssertNil(token)
        refreshes = try await s.refreshes()
        XCTAssertEqual(refreshes.count, 3)
    }

    func testSessionsListDevicesRevokeAnotherRevokeTheOthersRevokeThisOne() async throws {
        let s = try await server()
        let (first, email) = try await s.signUp()
        let second = try await s.signIn(email).app
        let third = try await s.signIn(email).app

        var sessions = try await first.session.list()
        XCTAssertEqual(sessions.count, 3)
        XCTAssertEqual(sessions.filter(\.current).count, 1)
        let current = try unwrap(sessions.first(where: \.current))
        var state = await first.state()
        XCTAssertEqual(state.sessionId, current.id)

        let secondId = try unwrap(await second.state().sessionId)
        try await first.session.revoke(secondId)
        state = await first.state()
        XCTAssertTrue(state.isSignedIn)
        var token = try await second.session.refresh()
        XCTAssertNil(token)

        let ended = try await first.session.revokeOthers()
        XCTAssertEqual(ended, 1)
        token = try await third.session.refresh()
        XCTAssertNil(token)
        sessions = try await first.session.list()
        XCTAssertEqual(sessions.count, 1)

        let missing = try await caught { try await first.session.revoke("00000000-0000-7000-8000-000000000000") }
        XCTAssertEqual(missing.code, "resource.not_found")
        XCTAssertEqual(missing.status, 404)

        try await first.session.revoke(current.id)
        state = await first.state()
        XCTAssertEqual(state, .signedOut)
    }

    func testChangePasswordNeedsTheCurrentOneAppliesThePolicyAndEndsTheOtherSessions() async throws {
        let s = try await server()
        let (first, email) = try await s.signUp()
        let other = try await s.signIn(email).app

        let wrong = try await caught {
            try await first.tula.changePassword(current: "wrong-current-1", new: Journey.newPassword)
        }
        XCTAssertEqual(wrong.code, "auth.invalid_credentials")
        XCTAssertEqual(wrong.status, 401)
        // A wrong current password is not a refused token: no refresh, still signed in.
        var state = await first.state()
        XCTAssertTrue(state.isSignedIn)
        let refreshes = try await s.refreshes()
        XCTAssertEqual(refreshes.count, 0)

        let weak = try await caught { try await first.tula.changePassword(current: Journey.password, new: "short") }
        XCTAssertTrue(weak.errors.map(\.code).contains("password.too_short"))

        try await first.tula.changePassword(current: Journey.password, new: Journey.newPassword)
        state = await first.state()
        XCTAssertTrue(state.isSignedIn)
        var token = try await first.session.refresh()
        XCTAssertNotNil(token)
        token = try await other.session.refresh()
        XCTAssertNil(token)
        let signedIn = try await s.signIn(email, password: Journey.newPassword)
        XCTAssertEqual(signedIn.step.status, "complete")
    }

    func testAnIdleSessionPastItsTimeoutIsOverAndTheClientSignsOutOnce() async throws {
        let s = try await server()
        let (app, _) = try await s.signUp()
        try await s.advance(8 * 24 * 60 * 60)
        let token = try await app.session.getToken()
        XCTAssertNil(token)
        let statuses = await app.statuses()
        XCTAssertEqual(statuses, ["signed-in", "signed-out"])
        let refreshes = try await s.refreshes()
        XCTAssertEqual(refreshes.count, 1)
    }

    func testAnAppStartedAgainLoadsItsSessionFromTheStorage() async throws {
        let s = try await server()
        let (app, email) = try await s.signUp()
        try await s.advance(1)
        // "Started again": a new client with the same storage and nothing in memory.
        let restarted = try s.client(storage: app.storage)
        let before = await restarted.state()
        XCTAssertEqual(before, .loading)
        let state = try await restarted.session.load()
        XCTAssertEqual(state.user?.email, email)
        let refreshes = try await s.refreshes()
        XCTAssertEqual(refreshes.map(\.status), [200])
        // Loading twice asks once.
        _ = try await restarted.session.load()
        let again = try await s.refreshes()
        XCTAssertEqual(again.count, 1)
    }
}
