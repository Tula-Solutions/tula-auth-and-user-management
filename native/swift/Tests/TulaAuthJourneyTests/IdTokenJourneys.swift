import CryptoKit
import Foundation
import XCTest

@testable import TulaAuth

// The Swift client against the real API: signing in with an ID token the platform handed
// the app (ADR 0045, ADR 0047). Google's token comes from the app, which got it from
// Google's SDK; Apple's comes from the Sign in with Apple sheet, which here is the journey.
// The tokens are the API's own mock provider's: no journey asks Google or Apple anything.
final class IdTokenJourneys: JourneyTestCase {
    private static let webClient = "1234567890-journeyweb.apps.googleusercontent.com"
    private static let iosClient = "1234567890-journeyios.apps.googleusercontent.com"
    private static let otherClient = "1234567890-journeyandroid.apps.googleusercontent.com"
    private static let strangerClient = "9999999999-someoneelsesapp.apps.googleusercontent.com"
    private static let appleTeam = "J0URNEYTEA"
    private static let appleBundle = "app.tula.journey.ios"
    private static let appleSecondBundle = "app.tula.journey.ios.second"
    private static let appleServicesId = "app.tula.journey.signin"

    private func idTokenExchanges(_ s: Server) async throws -> [Exchange] {
        try await s.exchanges().filter { $0.path.hasSuffix("/id-token") }
    }

    // MARK: Google

    private func googleServer(_ additional: [String] = [iosClient]) async throws -> Server {
        let s = try await server(oauth: true)
        try await s.provider("google")
        try await self.listed(s, additional)
        return s
    }

    private func listed(_ s: Server, _ additional: [String], enabled: Bool = true) async throws {
        let saved = try await s.admin(
            "PUT", "/v1/admin/oauth-providers/google",
            ["clientId": IdTokenJourneys.webClient, "additionalClientIds": additional, "enabled": enabled])
        XCTAssertEqual(saved.status, 200)
    }

    /// A token as Google's SDK hands the iOS app one: for the web client, asked by the app's.
    private func googleToken(
        _ s: Server, _ nonce: String?, _ email: String, _ change: [String: Any] = [:], expired: Bool = false
    ) async throws -> String {
        var claims: [String: Any] = [
            "aud": IdTokenJourneys.webClient, "azp": IdTokenJourneys.iosClient, "sub": "google-\(email)",
            "email": email, "email_verified": true,
        ]
        if let nonce { claims["nonce"] = nonce }
        claims.merge(change) { _, new in new }
        return try await s.idToken("google", claims, expired: expired)
    }

    func testNativeGoogleSignUpAndSignIn() async throws {
        try await journey(
            "native Google sign-up and sign-in",
            "native ID token: the app starts, hands the server's nonce to the provider's SDK, exchanges the token and is signed in; the same account signs in again"
        ) { _ in
            let s = try await self.googleServer()
            let email = s.freshEmail()
            let app = try s.client()
            let pending = try await app.tula.startIdTokenSignIn(provider: .google)
            XCTAssertEqual(pending.nonce.count, 43)
            XCTAssertTrue(pending.nonce.allSatisfy { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" })
            XCTAssertEqual(String(reflecting: pending), "IdTokenSignIn")
            var state = await app.state()
            XCTAssertFalse(state.isSignedIn)

            let idToken = try await self.googleToken(s, pending.nonce, email, ["given_name": "Maya"])
            let flow = try await pending.exchange(idToken: idToken)
            XCTAssertEqual(flow.step.status, "complete")
            state = await app.state()
            XCTAssertTrue(state.isSignedIn)
            let amr = try await app.amr()
            XCTAssertEqual(amr, ["fed"])
            let me = try await app.tula.user()
            XCTAssertEqual(me.email, email)
            XCTAssertEqual(me.firstName, "Maya")
            XCTAssertFalse(me.hasPassword)
            XCTAssertNotNil(me.emailVerifiedAt)

            let sent = try await self.idTokenExchanges(s)
            XCTAssertEqual(sent.map(\.status), [200, 200])
            XCTAssertEqual(sent[0].sent as NSDictionary, ["provider": "google"])
            // The token goes once, by itself: nothing of a name, an audience or a nonce beside it.
            XCTAssertEqual(sent[1].sent as NSDictionary, ["idToken": idToken])
            XCTAssertEqual(sent[1].headers["x-tula-client"], "ios")
            // The token and the nonce are kept nowhere.
            let visible = String(reflecting: flow) + String(reflecting: app.tula) + String(reflecting: pending)
            XCTAssertFalse(visible.contains(idToken))
            XCTAssertFalse(visible.contains(pending.nonce))
            let stored = try unwrap(await app.storage.get(s.storageKey))
            XCTAssertFalse(stored.contains(idToken))
            XCTAssertFalse(stored.contains(pending.nonce))

            let other = try s.client()
            let again = try await other.tula.startIdTokenSignIn(provider: .google)
            XCTAssertNotEqual(again.nonce, pending.nonce)
            let token = try await self.googleToken(
                s, again.nonce, email, ["aud": IdTokenJourneys.iosClient, "azp": IdTokenJourneys.iosClient])
            let signedIn = try await again.exchange(idToken: token)
            guard case .complete(let done) = signedIn.step else {
                return XCTFail("the second sign-in is at \(signedIn.step.status)")
            }
            XCTAssertEqual(done.userId, me.id)
        }
    }

    func testNativeGoogleSignInAndExistingAccounts() async throws {
        try await journey(
            "native Google sign-in and existing accounts",
            "native ID token: a verified account is linked and signed in; an unverified one and an unverified provider address are refused with their own codes, and the client stays signed out"
        ) { _ in
            let s = try await self.googleServer()
            let member = s.freshEmail()
            let memberId = try await s.adminUser(member, verified: true)
            let app = try s.client()
            let linking = try await app.tula.startIdTokenSignIn(provider: .google)
            let token = try await self.googleToken(s, linking.nonce, member)
            let linked = try await linking.exchange(idToken: token)
            guard case .complete(let done) = linked.step else {
                return XCTFail("the sign-in is at \(linked.step.status)")
            }
            XCTAssertEqual(done.userId, memberId)
            let identities = try await app.tula.identities.list()
            XCTAssertEqual(identities.map(\.provider), ["google"])
            let me = try await app.tula.user()
            XCTAssertTrue(me.hasPassword)

            let squatted = s.freshEmail()
            _ = try await s.adminUser(squatted, verified: false)
            let other = try s.client()
            let refused = try await other.tula.startIdTokenSignIn(provider: .google)
            let theirs = try await self.googleToken(s, refused.nonce, squatted)
            var error = try await caught { try await refused.exchange(idToken: theirs) }
            XCTAssertEqual(error.code, "oauth.account_exists")
            XCTAssertEqual(error.status, 409)

            let unvouched = try await other.tula.startIdTokenSignIn(provider: .google)
            let loose = try await self.googleToken(s, unvouched.nonce, s.freshEmail(), ["email_verified": false])
            error = try await caught { try await unvouched.exchange(idToken: loose) }
            XCTAssertEqual(error.code, "oauth.email_unverified")
            XCTAssertEqual(error.status, 403)
            let state = await other.state()
            XCTAssertFalse(state.isSignedIn)
        }
    }

    func testNativeGoogleIdTokenRefused() async throws {
        try await journey(
            "native Google ID token refused",
            "native ID token: every token the server does not accept is the one generic error to the app, and nobody is signed in"
        ) { _ in
            let s = try await self.googleServer()
            let email = s.freshEmail()
            let app = try s.client()
            let stranger = IdTokenJourneys.strangerClient
            let unlisted = IdTokenJourneys.otherClient
            // What is wrong with each token, the change to its claims, and whether it expired.
            let wrong: [(String, [String: Any], Bool, Bool)] = [
                ("another app's audience", ["aud": stranger, "azp": stranger], false, true),
                ("another app as the authorized party", ["azp": stranger], false, true),
                ("another nonce", ["nonce": "the-nonce-of-another-sign-in"], false, true),
                ("no nonce", [:], false, false),
                ("expired", [:], true, true),
                ("a client id nobody listed", ["aud": unlisted, "azp": unlisted], false, true),
            ]
            var messages = Set<String>()
            for (what, change, expired, withNonce) in wrong {
                let pending = try await app.tula.startIdTokenSignIn(provider: .google)
                let token = try await self.googleToken(
                    s, withNonce ? pending.nonce : nil, email, change, expired: expired)
                let error = try await caught { try await pending.exchange(idToken: token) }
                XCTAssertEqual(error.code, "auth.invalid_credentials", what)
                XCTAssertEqual(error.status, 401, what)
                messages.insert(error.message)
            }
            XCTAssertEqual(messages.count, 1)
            let state = await app.state()
            XCTAssertFalse(state.isSignedIn)
            let exists = try await s.userExists(email)
            XCTAssertFalse(exists)

            // Once the operator lists that client id, its tokens are taken.
            try await self.listed(s, [IdTokenJourneys.iosClient, unlisted])
            let later = try s.client()
            let pending = try await later.tula.startIdTokenSignIn(provider: .google)
            let token = try await self.googleToken(s, pending.nonce, email, ["aud": unlisted, "azp": unlisted])
            let flow = try await pending.exchange(idToken: token)
            XCTAssertEqual(flow.step.status, "complete")
        }
    }

    func testNativeGoogleIdTokenUsedOnce() async throws {
        try await journey(
            "native Google ID token used once",
            "native ID token: a sign-in takes one token; a second exchange, a copied token and a right token after a wrong one are refused, and a provider switched off mid-sign-in uses nothing up"
        ) { _ in
            let s = try await self.googleServer()
            let email = s.freshEmail()
            let app = try s.client()
            let pending = try await app.tula.startIdTokenSignIn(provider: .google)
            let idToken = try await self.googleToken(s, pending.nonce, email)
            let flow = try await pending.exchange(idToken: idToken)
            XCTAssertEqual(flow.step.status, "complete")
            // The attempt is over: the client refuses a second exchange by itself.
            let sent = try await self.idTokenExchanges(s).count
            var error = try await caught { try await pending.exchange(idToken: idToken) }
            XCTAssertEqual(error.code, "flow.invalid_step")
            let after = try await self.idTokenExchanges(s).count
            XCTAssertEqual(after, sent)

            // A copy of the token in another sign-in carries another sign-in's nonce.
            let thief = try s.client()
            let theirs = try await thief.tula.startIdTokenSignIn(provider: .google)
            error = try await caught { try await theirs.exchange(idToken: idToken) }
            XCTAssertEqual(error.code, "auth.invalid_credentials")
            var state = await thief.state()
            XCTAssertFalse(state.isSignedIn)

            // An attempt is one token, right or wrong.
            let second = try s.client()
            let retried = try await second.tula.startIdTokenSignIn(provider: .google)
            let bad = try await self.googleToken(s, "not-the-nonce", email)
            error = try await caught { try await retried.exchange(idToken: bad) }
            XCTAssertEqual(error.code, "auth.invalid_credentials")
            let late = try await self.googleToken(s, retried.nonce, email)
            error = try await caught { try await retried.exchange(idToken: late) }
            XCTAssertEqual(error.code, "auth.invalid_credentials")

            // The provider switched off while a sign-in waits: refused, and nothing used up.
            let waiting = try await second.tula.startIdTokenSignIn(provider: .google)
            let good = try await self.googleToken(s, waiting.nonce, email)
            try await self.listed(s, [IdTokenJourneys.iosClient], enabled: false)
            error = try await caught { try await waiting.exchange(idToken: good) }
            XCTAssertEqual(error.code, "auth.method_disabled")
            XCTAssertEqual(error.status, 403)
            error = try await caught { try await second.tula.startIdTokenSignIn(provider: .google) }
            XCTAssertEqual(error.code, "auth.method_disabled")
            try await self.listed(s, [IdTokenJourneys.iosClient])
            let done = try await waiting.exchange(idToken: good)
            XCTAssertEqual(done.step.status, "complete")
            state = await second.state()
            XCTAssertTrue(state.isSignedIn)
        }
    }

    // MARK: Apple

    private func appleServer(_ apps: [String] = [appleBundle]) async throws -> Server {
        let s = try await server(oauth: true)
        try await s.provider("google")
        let saved = try await s.admin(
            "PUT", "/v1/admin/oauth-providers/apple",
            [
                "clientId": IdTokenJourneys.appleServicesId, "teamId": IdTokenJourneys.appleTeam,
                "keyId": "J0URNEYKEY", "privateKey": P256.Signing.PrivateKey().pemRepresentation,
            ])
        XCTAssertEqual(saved.status, 200)
        for bundleId in apps {
            try await s.registerIosApp(bundleId, teamId: IdTokenJourneys.appleTeam)
        }
        return s
    }

    /// A token as Apple's sheet hands the app one. `passed` is what the sheet was given as
    /// its nonce, which Apple writes into the token as it is.
    private static func appleToken(
        _ s: Server, _ passed: String?, _ email: String?, _ change: [String: String] = [:], expired: Bool = false
    ) async throws -> String {
        var claims: [String: Any] = [
            "aud": IdTokenJourneys.appleBundle, "sub": "apple-\(email ?? "nobody")", "nonce_supported": true,
        ]
        if let passed { claims["nonce"] = passed }
        if let email {
            claims["email"] = email
            claims["email_verified"] = "true"
            claims["is_private_email"] = "false"
        }
        claims.merge(change) { _, new in new }
        return try await s.idToken("apple", claims, expired: expired)
    }

    /// An app whose Sign in with Apple sheet is the journey: Apple is handed the hashed
    /// nonce the client made, and answers a token with it.
    private func appleApp(
        _ s: Server, _ email: String?, _ change: [String: String] = [:], givenName: String? = nil,
        familyName: String? = nil
    ) throws -> App {
        try s.client(
            apple: ScriptedApple { hashed in
                TulaAppleCredential(
                    idToken: try await IdTokenJourneys.appleToken(s, hashed, email, change), givenName: givenName,
                    familyName: familyName)
            })
    }

    func testNativeAppleSignUpAndSignIn() async throws {
        try await journey(
            "native Apple sign-up and sign-in",
            "native Apple ID token: the client hashes the server's nonce for the sheet, exchanges the token with the name the sheet gave it and is signed in; the same Apple account signs in again with no address"
        ) { _ in
            let s = try await self.appleServer([])
            let email = s.freshEmail()

            // A client with no sheet is told so before any request.
            let bare = try s.client()
            let unsupported = try await caught { try await bare.tula.signInWithApple() }
            XCTAssertEqual(unsupported.code, "provider.unsupported")
            var sent = try await self.idTokenExchanges(s)
            XCTAssertEqual(sent.count, 0)

            // With no iOS app registered there is no method.
            let app = try self.appleApp(s, email, givenName: "Maya", familyName: "Okafor")
            let disabled = try await caught { try await app.tula.signInWithApple() }
            XCTAssertEqual(disabled.code, "auth.method_disabled")
            XCTAssertEqual(disabled.status, 403)
            try await s.registerIosApp(IdTokenJourneys.appleBundle, teamId: IdTokenJourneys.appleTeam)

            // A dismissed sheet is not an error and not a sign-in.
            let dismissing = try s.client(apple: ScriptedApple { _ in throw TulaSheetError.dismissed })
            let dismissed = try await dismissing.tula.signInWithApple()
            XCTAssertNil(dismissed.value)
            var state = await dismissing.state()
            XCTAssertFalse(state.isSignedIn)

            let outcome = try await app.tula.signInWithApple()
            let flow = try unwrap(outcome.value)
            XCTAssertEqual(flow.step.status, "complete")
            state = await app.state()
            XCTAssertTrue(state.isSignedIn)
            let amr = try await app.amr()
            XCTAssertEqual(amr, ["fed"])
            let me = try await app.tula.user()
            XCTAssertEqual(me.email, email)
            XCTAssertEqual(me.firstName, "Maya")
            XCTAssertEqual(me.lastName, "Okafor")
            XCTAssertFalse(me.hasPassword)
            XCTAssertNotNil(me.emailVerifiedAt)
            let identities = try await app.tula.identities.list()
            XCTAssertEqual(identities.map(\.provider), ["apple"])
            sent = try await self.idTokenExchanges(s).filter { $0.status == 200 }
            // The name travels beside the token, unsigned; the token is sent once.
            let body = try unwrap(sent.last?.sent)
            XCTAssertEqual(Set(body.keys), ["givenName", "familyName", "idToken"])
            XCTAssertEqual(body["givenName"] as? String, "Maya")
            let idToken = try unwrap(body["idToken"] as? String)
            XCTAssertFalse((String(reflecting: flow) + String(reflecting: app.tula)).contains(idToken))

            // The same Apple account later: no address in the token, and another name
            // beside it, which renames nobody.
            let later = try self.appleApp(
                s, nil, ["sub": "apple-\(email)"], givenName: "Somebody", familyName: "Else")
            let again = try unwrap(try await later.tula.signInWithApple().value)
            guard case .complete(let done) = again.step else {
                return XCTFail("the second sign-in is at \(again.step.status)")
            }
            XCTAssertEqual(done.userId, me.id)
            let same = try await later.tula.user()
            XCTAssertEqual(same.firstName, "Maya")
            XCTAssertEqual(same.lastName, "Okafor")

            // An account that hides its address is one of its own.
            let relay = "journey-\(UUID().uuidString.lowercased())@privaterelay.appleid.com"
            let hidden = try self.appleApp(s, relay, ["is_private_email": "true"])
            _ = try await hidden.tula.signInWithApple()
            let relayed = try await hidden.tula.user()
            XCTAssertEqual(relayed.email, relay)
            XCTAssertNil(relayed.firstName)
            XCTAssertFalse(relayed.hasPassword)
            XCTAssertNotEqual(relayed.id, me.id)
        }
    }

    func testNativeAppleSignInAndExistingAccounts() async throws {
        try await journey(
            "native Apple sign-in and existing accounts",
            "native Apple ID token: a verified account is linked and signed in; an unverified one, an address Apple does not vouch for and a first sign-in with no address are refused with their own codes"
        ) { _ in
            let s = try await self.appleServer()
            let member = s.freshEmail()
            let memberId = try await s.adminUser(member, verified: true)
            let app = try self.appleApp(s, member)
            let linked = try unwrap(try await app.tula.signInWithApple().value)
            guard case .complete(let done) = linked.step else {
                return XCTFail("the sign-in is at \(linked.step.status)")
            }
            XCTAssertEqual(done.userId, memberId)
            let identities = try await app.tula.identities.list()
            XCTAssertEqual(identities.map(\.provider), ["apple"])
            let me = try await app.tula.user()
            XCTAssertTrue(me.hasPassword)

            let squatted = s.freshEmail()
            _ = try await s.adminUser(squatted, verified: false)
            let other = try self.appleApp(s, squatted)
            var error = try await caught { try await other.tula.signInWithApple() }
            XCTAssertEqual(error.code, "oauth.account_exists")
            XCTAssertEqual(error.status, 409)

            let unvouched = try self.appleApp(s, s.freshEmail(), ["email_verified": "false"])
            error = try await caught { try await unvouched.tula.signInWithApple() }
            XCTAssertEqual(error.code, "oauth.email_unverified")
            XCTAssertEqual(error.status, 403)

            // A first sign-in with no address has no account to make; a name does not help.
            let bare = try self.appleApp(s, nil, givenName: "Nobody")
            error = try await caught { try await bare.tula.signInWithApple() }
            XCTAssertEqual(error.code, "oauth.email_missing")
            XCTAssertEqual(error.status, 403)
            for refused in [other, unvouched, bare] {
                let state = await refused.state()
                XCTAssertFalse(state.isSignedIn)
            }
        }
    }

    func testNativeAppleIdTokenRefused() async throws {
        try await journey(
            "native Apple ID token refused",
            "native Apple ID token: every token the server does not accept, the unhashed nonce among them, is the one generic error to the app, and nobody is signed in"
        ) { _ in
            let s = try await self.appleServer()
            let email = s.freshEmail()
            let app = try s.client()
            typealias Make = (IdTokenSignIn) async throws -> String
            let wrong: [(String, Make)] = [
                (
                    "another app's bundle id",
                    { try await IdTokenJourneys.appleToken(s, $0.appleNonce, email, ["aud": "com.someoneelse.theirapp"]) }
                ),
                (
                    "the Services ID of the web sign-in",
                    { try await IdTokenJourneys.appleToken(s, $0.appleNonce, email, ["aud": IdTokenJourneys.appleServicesId]) }
                ),
                ("the nonce itself, not its hash", { try await IdTokenJourneys.appleToken(s, $0.nonce, email) }),
                (
                    "the hash in upper case",
                    { try await IdTokenJourneys.appleToken(s, $0.appleNonce.uppercased(), email) }
                ),
                (
                    "another nonce",
                    { _ in try await IdTokenJourneys.appleToken(s, sha256Hex("the-nonce-of-another-sign-in"), email) }
                ),
                ("no nonce", { _ in try await IdTokenJourneys.appleToken(s, nil, email) }),
                ("expired", { try await IdTokenJourneys.appleToken(s, $0.appleNonce, email, [:], expired: true) }),
                (
                    "an app nobody registered",
                    {
                        try await IdTokenJourneys.appleToken(
                            s, $0.appleNonce, email, ["aud": IdTokenJourneys.appleSecondBundle])
                    }
                ),
                ("not a token", { _ in "eyJhbGciOiJub25lIn0.e30." }),
            ]
            var messages = Set<String>()
            for (what, make) in wrong {
                let pending = try await app.tula.startIdTokenSignIn(provider: .apple)
                // The hash the client hands the sheet is the lowercase hexadecimal SHA-256.
                XCTAssertEqual(pending.appleNonce.count, 64)
                XCTAssertEqual(pending.appleNonce, pending.appleNonce.lowercased())
                let token = try await make(pending)
                let error = try await caught { try await pending.exchange(idToken: token) }
                XCTAssertEqual(error.code, "auth.invalid_credentials", what)
                XCTAssertEqual(error.status, 401, what)
                messages.insert(error.message)
            }
            XCTAssertEqual(messages.count, 1)
            let state = await app.state()
            XCTAssertFalse(state.isSignedIn)
            let exists = try await s.userExists(email)
            XCTAssertFalse(exists)

            // Once the operator registers that app, its tokens are taken.
            try await s.registerIosApp(IdTokenJourneys.appleSecondBundle, teamId: IdTokenJourneys.appleTeam)
            let second = try self.appleApp(s, email, ["aud": IdTokenJourneys.appleSecondBundle])
            let flow = try unwrap(try await second.tula.signInWithApple().value)
            XCTAssertEqual(flow.step.status, "complete")
        }
    }

    func testNativeAppleIdTokenUsedOnce() async throws {
        try await journey(
            "native Apple ID token used once",
            "native Apple ID token: a sign-in takes one token; a second exchange, a copied token and a right token after a wrong one are refused, and an app removed mid-sign-in takes its bundle id away at once"
        ) { _ in
            let s = try await self.appleServer([])
            let appId = try await s.registerIosApp(IdTokenJourneys.appleBundle, teamId: IdTokenJourneys.appleTeam)
            let email = s.freshEmail()
            let app = try s.client()
            let pending = try await app.tula.startIdTokenSignIn(provider: .apple)
            let idToken = try await IdTokenJourneys.appleToken(s, pending.appleNonce, email)
            let flow = try await pending.exchange(idToken: idToken)
            XCTAssertEqual(flow.step.status, "complete")
            // The attempt is over: the client refuses a second exchange by itself.
            let sent = try await self.idTokenExchanges(s).count
            var error = try await caught { try await pending.exchange(idToken: idToken) }
            XCTAssertEqual(error.code, "flow.invalid_step")
            let after = try await self.idTokenExchanges(s).count
            XCTAssertEqual(after, sent)

            let thief = try s.client()
            let theirs = try await thief.tula.startIdTokenSignIn(provider: .apple)
            error = try await caught { try await theirs.exchange(idToken: idToken) }
            XCTAssertEqual(error.code, "auth.invalid_credentials")
            var state = await thief.state()
            XCTAssertFalse(state.isSignedIn)

            let second = try s.client()
            let retried = try await second.tula.startIdTokenSignIn(provider: .apple)
            let bad = try await IdTokenJourneys.appleToken(s, sha256Hex("not-the-nonce"), email)
            error = try await caught { try await retried.exchange(idToken: bad) }
            XCTAssertEqual(error.code, "auth.invalid_credentials")
            let late = try await IdTokenJourneys.appleToken(s, retried.appleNonce, email)
            error = try await caught { try await retried.exchange(idToken: late) }
            XCTAssertEqual(error.code, "auth.invalid_credentials")

            // The app is removed while a sign-in waits: there is no method, and nothing is
            // used up; registered again, the same token completes.
            let waiting = try await second.tula.startIdTokenSignIn(provider: .apple)
            let good = try await IdTokenJourneys.appleToken(s, waiting.appleNonce, email)
            var removed = try await s.admin("DELETE", "/v1/admin/native-apps/\(appId)")
            XCTAssertEqual(removed.status, 204)
            error = try await caught { try await waiting.exchange(idToken: good) }
            XCTAssertEqual(error.code, "auth.method_disabled")
            XCTAssertEqual(error.status, 403)
            error = try await caught { try await second.tula.startIdTokenSignIn(provider: .apple) }
            XCTAssertEqual(error.code, "auth.method_disabled")
            try await s.registerIosApp(IdTokenJourneys.appleBundle, teamId: IdTokenJourneys.appleTeam)
            let done = try await waiting.exchange(idToken: good)
            XCTAssertEqual(done.step.status, "complete")
            state = await second.state()
            XCTAssertTrue(state.isSignedIn)

            // One of two apps removed: its bundle id is no audience any more, at once.
            let secondAppId = try await s.registerIosApp(
                IdTokenJourneys.appleSecondBundle, teamId: IdTokenJourneys.appleTeam)
            let third = try s.client()
            let last = try await third.tula.startIdTokenSignIn(provider: .apple)
            let theirToken = try await IdTokenJourneys.appleToken(
                s, last.appleNonce, email, ["aud": IdTokenJourneys.appleSecondBundle])
            removed = try await s.admin("DELETE", "/v1/admin/native-apps/\(secondAppId)")
            XCTAssertEqual(removed.status, 204)
            error = try await caught { try await last.exchange(idToken: theirToken) }
            XCTAssertEqual(error.code, "auth.invalid_credentials")
            XCTAssertEqual(error.status, 401)
            state = await third.state()
            XCTAssertFalse(state.isSignedIn)
        }
    }
}
