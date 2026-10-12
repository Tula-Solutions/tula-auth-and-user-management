import Foundation
import XCTest

@testable import TulaAuth

// The Swift client against the real API: signing in with a provider through a browser
// session that comes back to the app (ADR 0026, ADR 0044). The provider is the API's own mock
// provider and the browser is the journey: it answers the consent page over HTTP and hands
// the client the address the API sends the browser back to. No journey opens a browser.
final class ProviderJourneys: JourneyTestCase {
    /// What a journey's browser script remembers.
    private final class Seen: @unchecked Sendable {
        private let lock = NSLock()
        private var text = ""
        var value: String {
            get { lock.withLock { text } }
            set { lock.withLock { text = newValue } }
        }
    }

    private static let contoso = "aaaabbbb-0000-cccc-1111-dddd2222eeee"
    private static let fabrikam = "bbbbcccc-1111-dddd-2222-eeee3333ffff"

    private func guid() -> String { UUID().uuidString.lowercased() }
    private func snowflake() -> String { String(UInt64.random(in: 1...999_999_999_999_999_999)) }

    /// An API whose providers are the mock provider, with Google saved.
    private func oauthServer() async throws -> Server {
        let s = try await server(oauth: true)
        try await s.provider("google")
        return s
    }

    /// The same, with the app's custom scheme and its app link listed as redirect URLs.
    private func appServer() async throws -> Server {
        let s = try await oauthServer()
        try await s.settings([
            "urls": [
                "allowedOrigins": ["http://localhost:5173"],
                "allowedRedirectUrls": [Server.schemeRedirect, Server.appLink],
            ]
        ])
        return s
    }

    private func exchanged(_ s: Server) async throws -> [Exchange] {
        try await s.exchanges("/v1/client/sign-ins/oauth/exchange")
    }

    /// Whether the client still keeps anything of a round trip: a binding or a ticket.
    private func keptNothing(_ app: App, file: StaticString = #filePath, line: UInt = #line) async throws {
        let again = try await app.tula.retryProviderSignIn()
        XCTAssertEqual(again.word, "no_answer", file: file, line: line)
    }

    /// Sign in with the password on a new client that has a browser.
    private func signedInWithPassword(_ s: Server, _ email: String) async throws -> (App, ScriptedBrowser) {
        let browser = ScriptedBrowser()
        let app = try s.client(browser: browser)
        let flow = try await app.tula.startSignIn(identifier: email)
        let step = try await flow.submitPassword(Journey.password)
        XCTAssertEqual(step.status, "complete")
        return (app, browser)
    }

    /// Connect a provider account to the signed-in user of `app`.
    private func link(
        _ s: Server, _ app: App, _ browser: ScriptedBrowser, _ provider: OAuthProvider, _ consent: [String: String],
        redirectURL: String = Server.loopbackRedirect
    ) async throws -> ProviderOutcome {
        browser.browse { url, _ in try await s.atProvider(url, consent) }
        let outcome = try await app.tula.identities.link(provider, redirectURL: redirectURL)
        try await keptNothing(app)
        return outcome
    }

    // MARK: The round trip

    func testOAuthSignUpAndSignIn() async throws {
        try await journey(
            "OAuth sign-up and sign-in",
            "a provider sign-in from the app: started as an ios client, the browser comes back, the app is signed in, and nothing of the round trip is in storage, an error or an address the client built"
        ) { _ in
            let s = try await self.appServer()
            let email = s.freshEmail()
            let returned = Seen()
            let browser = ScriptedBrowser { url, redirectURL in
                XCTAssertEqual(redirectURL, Server.loopbackRedirect)
                returned.value = try await s.atProvider(url, ["email": email])
                return returned.value
            }
            let app = try s.client(browser: browser)
            let config = try await app.tula.config()
            XCTAssertEqual(config.signIn.oauth, ["google"])

            let outcome = try await app.tula.signIn(with: .google, redirectURL: Server.loopbackRedirect)
            XCTAssertEqual(outcome.word, "signed_in")
            XCTAssertEqual(outcome.flow?.step.status, "complete")
            XCTAssertTrue(returned.value.hasPrefix("\(Server.loopbackRedirect)#tula_ticket="))
            let state = await app.state()
            XCTAssertEqual(state.user?.email, email)
            let statuses = await app.statuses()
            XCTAssertEqual(statuses, ["signed-in"])

            let start = try unwrap(try await s.exchanges("/v1/client/sign-ins/oauth").first)
            XCTAssertEqual(start.headers["x-tula-client"], "ios")
            XCTAssertNil(start.headers["origin"])
            XCTAssertEqual(start.sent as NSDictionary, ["provider": "google", "redirectUrl": Server.loopbackRedirect])
            let exchanges = try await self.exchanged(s)
            XCTAssertEqual(exchanges.count, 1)
            let ticket = try unwrap(exchanges.first?.sent["ticket"] as? String)
            let binding = try unwrap(exchanges.first?.sent["binding"] as? String)
            XCTAssertTrue(returned.value.contains(ticket))
            XCTAssertTrue(binding.hasPrefix("tula_ob_"))

            // Nothing of the round trip outlives it: the store holds the refresh token and
            // nothing else, and no request carried a ticket, a binding or a code in its path.
            try await self.keptNothing(app)
            let stored = await app.storage.get(s.storageKey)
            XCTAssertTrue(stored?.hasPrefix("tula_rt_") == true)
            for sent in try await s.exchanges() {
                for secret in ["tula_ot_", "tula_ob_", "tula_ticket", "code=", "state="] {
                    XCTAssertFalse(sent.path.contains(secret), sent.path)
                }
            }
            let visible = String(reflecting: app.tula) + String(reflecting: outcome) + String(describing: outcome)
            XCTAssertFalse(visible.contains(binding))
            XCTAssertFalse(visible.contains(ticket))
            XCTAssertTrue(browser.opened.first?.first?.contains("/v1/dev/oauth/authorize?") == true)

            // The same provider account signs in to the same user.
            let userId = state.user?.id
            try await app.session.signOut()
            let again = try await s.continueWith(.google, ["email": email])
            XCTAssertEqual(again.outcome.word, "signed_in")
            let later = await again.app.state()
            XCTAssertEqual(later.user?.id, userId)
        }
    }

    func testAProviderReturnIsReadOnlyWhenItIsTheOneAskedFor() async throws {
        try await journey(
            "OAuth sign-up and sign-in",
            "what the browser comes back with is exchanged only when it is the redirect URL that was asked for and this client started the round trip; a closed browser, a refusal at the provider and an unverified address are outcomes"
        ) { _ in
            let s = try await self.appServer()
            let loopback = Server.loopbackRedirect

            // A client with no browser session is told so before any request.
            let bare = try s.client()
            let unsupported = try await caught { try await bare.tula.signIn(with: .google, redirectURL: loopback) }
            XCTAssertEqual(unsupported.code, "provider.unsupported")
            var requests = try await s.exchanges().count
            XCTAssertEqual(requests, 0)

            // Someone finishes at the provider and closes their own browser: they hold an
            // address with a ticket in it, and are not signed in.
            let stolen = Seen()
            let attacker = try s.client(
                browser: ScriptedBrowser { url, _ in
                    stolen.value = try await s.atProvider(url, ["email": s.freshEmail()])
                    return nil
                })
            var outcome = try await attacker.tula.signIn(with: .google, redirectURL: loopback)
            XCTAssertEqual(outcome.word, "cancelled")
            XCTAssertTrue(stolen.value.hasPrefix("\(loopback)#tula_ticket="))
            try await self.keptNothing(attacker)

            // That address in another client's browser completes nothing, and is not sent.
            let before = try await self.exchanged(s).count
            let victim = try s.client(browser: ScriptedBrowser { _, _ in stolen.value })
            outcome = try await victim.tula.signIn(with: .google, redirectURL: loopback)
            XCTAssertEqual(outcome.word, "not_started_here")
            var state = await victim.state()
            XCTAssertFalse(state.isSignedIn)
            let nothing = await victim.storage.get(s.storageKey)
            XCTAssertNil(nothing)
            try await self.keptNothing(victim)

            // An address that is not, character for character, the one asked for.
            let bends: [@Sendable (String) -> String] = [
                { $0.replacingOccurrences(of: loopback, with: "\(loopback)/more") },
                { $0.replacingOccurrences(of: loopback, with: "\(loopback)?next=1") },
                { $0.replacingOccurrences(of: loopback, with: "http://localhost:5173/other") },
                { $0.replacingOccurrences(of: "http://localhost:5173", with: "https://evil.example") },
                { $0.replacingOccurrences(of: "#", with: "?") },
                { String($0.prefix { $0 != "#" }) },
                { _ in "" },
            ]
            for bend in bends {
                let app = try s.client(
                    browser: ScriptedBrowser { url, _ in bend(try await s.atProvider(url, ["email": s.freshEmail()])) })
                outcome = try await app.tula.signIn(with: .google, redirectURL: loopback)
                XCTAssertTrue(["unexpected_return", "no_answer"].contains(outcome.word), outcome.word)
                state = await app.state()
                XCTAssertFalse(state.isSignedIn)
                try await self.keptNothing(app)
            }
            let empty = try s.client(browser: ScriptedBrowser { _, _ in "\(loopback)#hello=1" })
            outcome = try await empty.tula.signIn(with: .google, redirectURL: loopback)
            XCTAssertEqual(outcome.word, "no_answer")
            let after = try await self.exchanged(s).count
            XCTAssertEqual(after, before)

            // A closed browser is not an error and not a sign-in, and the app can ask again.
            let browser = ScriptedBrowser()
            let closed = try s.client(browser: browser)
            outcome = try await closed.tula.signIn(with: .google, redirectURL: loopback)
            XCTAssertEqual(outcome.word, "cancelled")
            state = await closed.state()
            XCTAssertFalse(state.isSignedIn)
            try await self.keptNothing(closed)
            browser.browse { url, _ in try await s.atProvider(url, ["email": s.freshEmail()]) }
            outcome = try await closed.tula.signIn(with: .google, redirectURL: loopback)
            XCTAssertEqual(outcome.word, "signed_in")

            // What the provider or the API refused is an outcome with a code of the contract.
            let denied = try await s.continueWith(.google, ["action": "deny"])
            XCTAssertEqual(denied.outcome.word, "oauth.access_denied")
            try await self.keptNothing(denied.app)
            let unverified = try await s.continueWith(.google, ["email": s.freshEmail(), "unverified": "1"])
            XCTAssertEqual(unverified.outcome.word, "oauth.email_unverified")
            state = await unverified.app.state()
            XCTAssertFalse(state.isSignedIn)
            requests = try await s.exchanges().count
            XCTAssertGreaterThan(requests, 0)
        }
    }

    func testProviderSignInReturnedToACustomScheme() async throws {
        try await journey(
            "provider sign-in returned to a custom scheme",
            "a provider sign-in comes back to the app's custom scheme: the listed entry, character for character, and only for a sign-in"
        ) { _ in
            let s = try await self.appServer()
            let scheme = Server.schemeRedirect
            let email = s.freshEmail()
            let returned = Seen()
            let app = try s.client(
                browser: ScriptedBrowser { url, redirectURL in
                    XCTAssertEqual(redirectURL, scheme)
                    returned.value = try await s.atProvider(url, ["email": email])
                    return returned.value
                })
            var outcome = try await app.tula.signIn(with: .google, redirectURL: scheme)
            XCTAssertTrue(returned.value.hasPrefix("\(scheme)#tula_ticket="))
            XCTAssertEqual(outcome.word, "signed_in")
            var state = await app.state()
            XCTAssertEqual(state.user?.email, email)
            let stored = await app.storage.get(s.storageKey)
            XCTAssertTrue(stored?.hasPrefix("tula_rt_") == true)
            try await self.keptNothing(app)

            // Another address of the same scheme is not the one asked for: nothing is sent.
            let before = try await self.exchanged(s).count
            let bends: [@Sendable (String) -> String] = [
                { $0.replacingOccurrences(of: scheme, with: "com.example.journeys:/elsewhere") },
                { $0.replacingOccurrences(of: scheme, with: "\(scheme)/more") },
                { $0.replacingOccurrences(of: scheme, with: "com.example.journeys://oauth/callback") },
            ]
            for bend in bends {
                let other = try s.client(
                    browser: ScriptedBrowser { url, _ in bend(try await s.atProvider(url, ["email": email])) })
                outcome = try await other.tula.signIn(with: .google, redirectURL: scheme)
                XCTAssertEqual(outcome.word, "unexpected_return")
                state = await other.state()
                XCTAssertFalse(state.isSignedIn)
            }
            let after = try await self.exchanged(s).count
            XCTAssertEqual(after, before)

            // Connecting an account from a profile is not a sign-in by a native client, and
            // the server refuses the custom scheme for it before a browser is opened.
            let (member, browser, _) = try await { () async throws -> (App, ScriptedBrowser, ProviderOutcome) in
                let made = try await s.continueWith(.google, ["email": s.freshEmail()])
                return (made.app, made.browser, made.outcome)
            }()
            let opened = browser.opened.count
            let refused = try await caught { try await member.tula.identities.link(.google, redirectURL: scheme) }
            XCTAssertEqual(refused.code, "request.redirect_not_allowed")
            XCTAssertEqual(refused.params["reason"], .string("client_not_native"))
            XCTAssertEqual(browser.opened.count, opened)
            try await self.keptNothing(member)
        }
    }

    func testProviderSignInReturnedToAnAppLink() async throws {
        try await journey(
            "provider sign-in returned to an app link",
            "a provider sign-in comes back to an app link, an https entry matched exactly; a profile connects an account the same way"
        ) { _ in
            let s = try await self.appServer()
            let appLink = Server.appLink
            let email = s.freshEmail()
            let returned = Seen()
            let app = try s.client(
                browser: ScriptedBrowser { url, redirectURL in
                    XCTAssertEqual(redirectURL, appLink)
                    returned.value = try await s.atProvider(url, ["email": email])
                    return returned.value
                })
            var outcome = try await app.tula.signIn(with: .google, redirectURL: appLink)
            XCTAssertTrue(returned.value.hasPrefix("\(appLink)#tula_ticket="))
            XCTAssertEqual(outcome.word, "signed_in")
            let state = await app.state()
            XCTAssertEqual(state.user?.email, email)
            try await self.keptNothing(app)

            let before = try await self.exchanged(s).count
            let other = try s.client(
                browser: ScriptedBrowser { url, _ in
                    try await s.atProvider(url, ["email": email])
                        .replacingOccurrences(of: appLink, with: "https://app.example.com/")
                })
            outcome = try await other.tula.signIn(with: .google, redirectURL: appLink)
            XCTAssertEqual(outcome.word, "unexpected_return")
            let after = try await self.exchanged(s).count
            XCTAssertEqual(after, before)

            // A signed-in user connects an account, coming back by the same app link.
            let memberEmail = s.freshEmail()
            _ = try await s.adminUser(memberEmail, verified: true)
            let (member, browser) = try await self.signedInWithPassword(s, memberEmail)
            let linked = try await self.link(
                s, member, browser, .google, ["email": s.freshEmail(), "subject": "second-account"],
                redirectURL: appLink)
            guard case .linked(let identity) = linked else {
                return XCTFail("the account was not connected: \(linked.word)")
            }
            XCTAssertEqual(identity.provider, "google")
            let identities = try await member.tula.identities.list()
            XCTAssertEqual(identities.count, 1)
        }
    }

    func testCustomSchemeRefusedForAProviderWithoutPKCE() async throws {
        try await journey(
            "custom scheme refused for a provider without PKCE",
            "a provider that binds its code with nothing but the client secret is refused the custom scheme, with the server's reason and no browser opened; an app link serves it"
        ) { _ in
            let s = try await self.appServer()
            let consents: [(OAuthProvider, String, [String: String])] = [
                (.linkedin, "linkedin", ["email": s.freshEmail(), "subject": "li-\(self.guid())"]),
                (.facebook, "facebook", ["subject": "10203040506070809"]),
            ]
            for (provider, name, consent) in consents {
                try await s.provider(name)
                let browser = ScriptedBrowser { url, _ in try await s.atProvider(url, consent) }
                let app = try s.client(browser: browser)
                let refused = try await caught {
                    try await app.tula.signIn(with: provider, redirectURL: Server.schemeRedirect)
                }
                XCTAssertEqual(refused.code, "request.redirect_not_allowed")
                XCTAssertEqual(refused.status, 400)
                XCTAssertEqual(refused.params["reason"], .string("provider_without_pkce"))
                XCTAssertEqual(browser.opened.count, 0)
                let state = await app.state()
                XCTAssertFalse(state.isSignedIn)
                try await self.keptNothing(app)

                let outcome = try await app.tula.signIn(with: provider, redirectURL: Server.appLink)
                XCTAssertEqual(outcome.word, "signed_in")
            }
            // A provider that sends PKCE comes back to the custom scheme.
            let google = try await s.continueWith(
                .google, ["email": s.freshEmail()], redirectURL: Server.schemeRedirect)
            XCTAssertEqual(google.outcome.word, "signed_in")
        }
    }

    func testAppLinkOrCustomSchemeThatIsNotListed() async throws {
        try await journey(
            "app link or custom scheme that is not listed",
            "a redirect URL that is not, character for character, a listed entry is refused at the start: no browser is opened and nothing is kept"
        ) { _ in
            let s = try await self.appServer()
            // Outside the `local` tier a loopback page is no redirect URL by itself.
            try await s.tier("dev")
            let scheme = Server.schemeRedirect
            let appLink = Server.appLink
            let unlisted = [
                "com.example.other:/oauth/callback", "\(scheme)/", "\(scheme)/more",
                "com.example.journeys:/oauth/Callback", "com.example.journeys://oauth/callback", "\(appLink)/",
                "\(appLink)?next=1", "https://app.example.com/oauth/Callback",
                "https://other.example.com/oauth/callback", Server.loopbackRedirect,
            ]
            for redirectURL in unlisted {
                let browser = ScriptedBrowser()
                let app = try s.client(browser: browser)
                let refused = try await caught { try await app.tula.signIn(with: .google, redirectURL: redirectURL) }
                XCTAssertEqual(refused.code, "request.redirect_not_allowed", redirectURL)
                XCTAssertNil(refused.params["reason"], redirectURL)
                XCTAssertEqual(browser.opened.count, 0, redirectURL)
                try await self.keptNothing(app)
                let stored = await app.storage.get(s.storageKey)
                XCTAssertNil(stored)
            }
            for redirectURL in [scheme, appLink] {
                let browser = ScriptedBrowser()
                let app = try s.client(browser: browser)
                let outcome = try await app.tula.signIn(with: .google, redirectURL: redirectURL)
                XCTAssertEqual(outcome.word, "cancelled")
                XCTAssertEqual(browser.opened.count, 1)
                XCTAssertTrue(browser.opened.first?.first?.contains("/v1/dev/oauth/authorize?") == true)
                XCTAssertEqual(browser.opened.first?.last, redirectURL)
            }
        }
    }

    // MARK: Which account

    func testOAuthAccountLinking() async throws {
        try await journey(
            "OAuth account linking",
            "OAuth: automatic linking needs a verified address on both sides; a profile links and unlinks, but not the last way in"
        ) { _ in
            let s = try await self.oauthServer()
            let member = s.freshEmail()
            let memberId = try await s.adminUser(member, verified: true)
            let linked = try await s.continueWith(.google, ["email": member])
            XCTAssertEqual(linked.outcome.word, "signed_in")
            var state = await linked.app.state()
            XCTAssertEqual(state.user?.id, memberId)
            var identities = try await linked.app.tula.identities.list()
            XCTAssertEqual(identities.map(\.provider), ["google"])
            try await linked.app.tula.identities.unlink(identities[0].id)
            identities = try await linked.app.tula.identities.list()
            XCTAssertEqual(identities.count, 0)

            // An account whose address nobody proved is not linked to.
            let squatted = s.freshEmail()
            _ = try await s.adminUser(squatted, verified: false)
            let refused = try await s.continueWith(.google, ["email": squatted])
            XCTAssertEqual(refused.outcome.word, "oauth.account_exists")
            state = await refused.app.state()
            XCTAssertFalse(state.isSignedIn)

            let outcome = try await self.link(
                s, linked.app, linked.browser, .google, ["email": s.freshEmail(), "subject": "another-account"])
            guard case .linked(let identity) = outcome else {
                return XCTFail("the account was not connected: \(outcome.word)")
            }
            XCTAssertEqual(identity.provider, "google")
            identities = try await linked.app.tula.identities.list()
            XCTAssertEqual(identities.count, 1)

            let only = try await s.continueWith(.google, ["email": s.freshEmail()])
            identities = try await only.app.tula.identities.list()
            let last = try unwrap(identities.first)
            let error = try await caught { try await only.app.tula.identities.unlink(last.id) }
            XCTAssertEqual(error.code, "identity.last_sign_in_method")
            identities = try await only.app.tula.identities.list()
            XCTAssertEqual(identities.count, 1)
        }
    }

    func testOAuthWithASecondFactor() async throws {
        try await journey(
            "OAuth with a second factor",
            "OAuth: a user with an authenticator comes back to a flow on the second factor, and is signed in only after it"
        ) { _ in
            let s = try await self.oauthServer()
            let email = s.freshEmail()
            let first = try await s.continueWith(.google, ["email": email])
            XCTAssertEqual(first.outcome.word, "signed_in")
            let secret = try await first.app.tula.factors.startTotp().secret
            let confirming = try await s.totp(secret)
            _ = try await first.app.tula.factors.confirmTotp(code: confirming)
            try await s.advance(31)

            let second = try await s.continueWith(.google, ["email": email])
            guard case .needsStep(let flow) = second.outcome else {
                return XCTFail("expected a flow on the second factor, got \(second.outcome.word)")
            }
            XCTAssertEqual(flow.step, .needsSecondFactor(FlowStepNeedsSecondFactor(options: [.totp, .backupCode])))
            var state = await second.app.state()
            XCTAssertFalse(state.isSignedIn)
            let stored = await second.app.storage.get(s.storageKey)
            XCTAssertNil(stored)
            let code = try await s.totp(secret)
            let done = try await flow.submitTotp(code)
            XCTAssertEqual(done.status, "complete")
            state = await second.app.state()
            XCTAssertEqual(state.user?.email, email)
            let amr = try await second.app.amr()
            XCTAssertEqual(amr, ["fed", "otp", "mfa"])
        }
    }

    // MARK: Microsoft

    private func microsoftServer(tenant: String = "common") async throws -> Server {
        let s = try await oauthServer()
        try await s.provider("microsoft", ["tenant": tenant])
        return s
    }

    func testMicrosoftSignUpAndSignIn() async throws {
        try await journey(
            "Microsoft sign-up and sign-in",
            "Microsoft: the config offers it, a sign-up comes back signed in, and the same account signs in again whatever address is reported"
        ) { _ in
            let s = try await self.microsoftServer()
            let email = s.freshEmail()
            let account = ["tenant_id": ProviderJourneys.contoso, "object_id": self.guid()]
            let config = try await s.client().tula.config()
            XCTAssertEqual(config.signIn.oauth, ["google", "microsoft"])
            let first = try await s.continueWith(.microsoft, account.merging(["email": email]) { $1 })
            XCTAssertEqual(first.outcome.word, "signed_in")
            var state = await first.app.state()
            XCTAssertEqual(state.user?.email, email)
            try await self.keptNothing(first.app)
            let identities = try await first.app.tula.identities.list()
            XCTAssertEqual(identities.map(\.provider), ["microsoft"])
            let userId = state.user?.id
            try await first.app.session.signOut()

            // The account is its tenant and object id: another address changes nothing.
            let again = try await s.continueWith(
                .microsoft, account.merging(["email": s.freshEmail(), "unverified": "1"]) { $1 })
            XCTAssertEqual(again.outcome.word, "signed_in")
            state = await again.app.state()
            XCTAssertEqual(state.user?.id, userId)
            XCTAssertEqual(state.user?.email, email)

            // The same object id in another tenant is another account.
            let other = try await s.continueWith(
                .microsoft,
                [
                    "email": s.freshEmail(), "tenant_id": ProviderJourneys.fabrikam,
                    "object_id": account["object_id"] ?? "",
                ])
            XCTAssertEqual(other.outcome.word, "signed_in")
            state = await other.app.state()
            XCTAssertNotEqual(state.user?.id, userId)

            let unvouched = try await s.continueWith(
                .microsoft,
                [
                    "email": s.freshEmail(), "tenant_id": ProviderJourneys.fabrikam, "object_id": self.guid(),
                    "unverified": "1",
                ])
            XCTAssertEqual(unvouched.outcome.word, "oauth.email_unverified")
            state = await unvouched.app.state()
            XCTAssertFalse(state.isSignedIn)
            try await self.keptNothing(unvouched.app)
        }
    }

    func testMicrosoftAccountOfAnotherTenant() async throws {
        try await journey(
            "Microsoft sign-up and sign-in",
            "Microsoft: an account of a tenant the environment does not accept comes back as a provider error"
        ) { _ in
            let s = try await self.microsoftServer(tenant: ProviderJourneys.contoso)
            let email = s.freshEmail()
            let outsider = try await s.continueWith(
                .microsoft, ["email": email, "tenant_id": ProviderJourneys.fabrikam, "object_id": self.guid()])
            XCTAssertEqual(outsider.outcome.word, "oauth.provider_error")
            let state = await outsider.app.state()
            XCTAssertFalse(state.isSignedIn)
            let stored = await outsider.app.storage.get(s.storageKey)
            XCTAssertNil(stored)
            let member = try await s.continueWith(
                .microsoft, ["email": email, "tenant_id": ProviderJourneys.contoso, "object_id": self.guid()])
            XCTAssertEqual(member.outcome.word, "signed_in")
        }
    }

    func testMicrosoftAccountLinking() async throws {
        try await journey(
            "Microsoft account linking",
            "Microsoft: an address without the verified-domain claim links to nobody; with it, and a verified Tula address, it links; a profile links whatever the claim"
        ) { _ in
            let s = try await self.microsoftServer()
            try await self.linking(s, .microsoft, "microsoft") {
                ["tenant_id": ProviderJourneys.contoso, "object_id": self.guid()]
            }
        }
    }

    // MARK: Providers that report an address

    /// A sign-up, the same account again under another address, and an address the provider
    /// does not vouch for.
    private func signUpAndSignIn(
        _ s: Server, _ provider: OAuthProvider, _ name: String, account: () -> [String: String]
    ) async throws {
        let email = s.freshEmail()
        let mine = account()
        let config = try await s.client().tula.config()
        XCTAssertEqual(config.signIn.oauth, ["google", name])
        let first = try await s.continueWith(provider, mine.merging(["email": email]) { $1 })
        XCTAssertEqual(first.outcome.word, "signed_in")
        var state = await first.app.state()
        XCTAssertEqual(state.user?.email, email)
        try await keptNothing(first.app)
        let identities = try await first.app.tula.identities.list()
        XCTAssertEqual(identities.map(\.provider), [name])
        let userId = state.user?.id
        try await first.app.session.signOut()

        let again = try await s.continueWith(
            provider, mine.merging(["email": s.freshEmail(), "unverified": "1"]) { $1 })
        XCTAssertEqual(again.outcome.word, "signed_in")
        state = await again.app.state()
        XCTAssertEqual(state.user?.id, userId)
        XCTAssertEqual(state.user?.email, email)

        let unvouched = try await s.continueWith(
            provider, account().merging(["email": s.freshEmail(), "unverified": "1"]) { $1 })
        XCTAssertEqual(unvouched.outcome.word, "oauth.email_unverified")
        state = await unvouched.app.state()
        XCTAssertFalse(state.isSignedIn)
        try await keptNothing(unvouched.app)
    }

    /// Which account a provider's address reaches: nobody's when the provider does not
    /// vouch for it, a verified member's when it does, and a profile's own choice always.
    private func linking(
        _ s: Server, _ provider: OAuthProvider, _ name: String, account: () -> [String: String]
    ) async throws {
        let member = s.freshEmail()
        let memberId = try await s.adminUser(member, verified: true)

        let attacker = account().merging(["unverified": "1"]) { $1 }
        let taken = try await s.continueWith(provider, attacker.merging(["email": member]) { $1 })
        XCTAssertEqual(taken.outcome.word, "oauth.email_unverified")
        var state = await taken.app.state()
        XCTAssertFalse(state.isSignedIn)
        let stored = await taken.app.storage.get(s.storageKey)
        XCTAssertNil(stored)
        // The answer is the same for an address nobody has.
        let nobody = try await s.continueWith(provider, attacker.merging(["email": s.freshEmail()]) { $1 })
        XCTAssertEqual(nobody.outcome.word, taken.outcome.word)

        let linked = try await s.continueWith(provider, account().merging(["email": member]) { $1 })
        XCTAssertEqual(linked.outcome.word, "signed_in")
        state = await linked.app.state()
        XCTAssertEqual(state.user?.id, memberId)
        let identities = try await linked.app.tula.identities.list()
        XCTAssertEqual(identities.map(\.provider), [name])

        let squatted = s.freshEmail()
        _ = try await s.adminUser(squatted, verified: false)
        let refused = try await s.continueWith(provider, account().merging(["email": squatted]) { $1 })
        XCTAssertEqual(refused.outcome.word, "oauth.account_exists")

        // A signed-in user connects an account whatever the provider says of its address,
        // and that account then signs them in.
        let colleagueEmail = s.freshEmail()
        _ = try await s.adminUser(colleagueEmail, verified: true)
        let (colleague, browser) = try await signedInWithPassword(s, colleagueEmail)
        let second = account().merging(["unverified": "1"]) { $1 }
        let outcome = try await link(s, colleague, browser, provider, second.merging(["email": s.freshEmail()]) { $1 })
        guard case .linked(let identity) = outcome else {
            return XCTFail("the account was not connected: \(outcome.word)")
        }
        XCTAssertEqual(identity.provider, name)
        try await colleague.session.signOut()
        let back = try await s.continueWith(provider, second.merging(["email": s.freshEmail()]) { $1 })
        XCTAssertEqual(back.outcome.word, "signed_in")
        state = await back.app.state()
        XCTAssertEqual(state.user?.email, colleagueEmail)
    }

    private func server(with name: String) async throws -> Server {
        let s = try await oauthServer()
        try await s.provider(name)
        return s
    }

    func testDiscordSignUpAndSignIn() async throws {
        try await journey(
            "Discord sign-up and sign-in",
            "Discord: the config offers it, a sign-up comes back signed in, and the same account signs in again whatever address is reported"
        ) { _ in
            let s = try await self.server(with: "discord")
            try await self.signUpAndSignIn(s, .discord, "discord") { ["subject": self.snowflake()] }
        }
    }

    func testDiscordAccountLinking() async throws {
        try await journey(
            "Discord account linking",
            "Discord: an unverified address links to nobody; a verified one, and a verified Tula address, links; a profile links whatever the provider says"
        ) { _ in
            let s = try await self.server(with: "discord")
            try await self.linking(s, .discord, "discord") { ["subject": self.snowflake()] }
        }
    }

    func testLinkedInSignUpAndSignIn() async throws {
        try await journey(
            "LinkedIn sign-up and sign-in",
            "LinkedIn: the config offers it, a sign-up comes back signed in, and the same account signs in again whatever address is reported"
        ) { _ in
            let s = try await self.server(with: "linkedin")
            try await self.signUpAndSignIn(s, .linkedin, "linkedin") { ["subject": "li-\(self.guid())"] }
        }
    }

    func testLinkedInAccountLinking() async throws {
        try await journey(
            "LinkedIn account linking",
            "LinkedIn: an unverified address links to nobody; a verified one, and a verified Tula address, links; a profile links whatever the provider says"
        ) { _ in
            let s = try await self.server(with: "linkedin")
            try await self.linking(s, .linkedin, "linkedin") { ["subject": "li-\(self.guid())"] }
        }
    }

    // MARK: Providers that give no address

    private func signUpWithNoAddress(_ s: Server, _ provider: OAuthProvider, _ name: String) async throws {
        let subject = snowflake()
        let config = try await s.client().tula.config()
        XCTAssertEqual(config.signIn.oauth, ["google", name])
        let first = try await s.continueWith(provider, ["subject": subject])
        XCTAssertEqual(first.outcome.word, "signed_in")
        let user = try unwrap(await first.app.user())
        XCTAssertNil(user.email)
        XCTAssertNil(user.emailVerifiedAt)
        XCTAssertFalse(user.hasPassword)
        try await keptNothing(first.app)
        let identities = try await first.app.tula.identities.list()
        XCTAssertEqual(identities.map(\.provider), [name])
        try await first.app.session.signOut()

        let again = try await s.continueWith(provider, ["subject": subject])
        XCTAssertEqual(again.outcome.word, "signed_in")
        let same = await again.app.user()
        XCTAssertEqual(same?.id, user.id)
        XCTAssertNil(same?.email)
        try await again.app.session.signOut()

        // An address on the consent form is never read.
        let reported = s.freshEmail()
        let other = try await s.continueWith(provider, ["subject": snowflake(), "email": reported])
        XCTAssertEqual(other.outcome.word, "signed_in")
        let another = try unwrap(await other.app.user())
        XCTAssertNil(another.email)
        XCTAssertNotEqual(another.id, user.id)
        for sent in try await s.exchanges() {
            XCTAssertFalse(sent.responseBody.contains(reported))
        }
    }

    private func neverLinksByAddress(_ s: Server, _ provider: OAuthProvider, _ name: String) async throws {
        let member = s.freshEmail()
        let memberId = try await s.adminUser(member, verified: true)

        let stranger = try await s.continueWith(provider, ["subject": snowflake(), "email": member])
        XCTAssertEqual(stranger.outcome.word, "signed_in")
        let made = try unwrap(await stranger.app.user())
        XCTAssertNil(made.email)
        XCTAssertNotEqual(made.id, memberId)
        var identities = try await stranger.app.tula.identities.list()
        XCTAssertEqual(identities.map(\.provider), [name])
        let only = identities[0].id
        let refused = try await caught { try await stranger.app.tula.identities.unlink(only) }
        XCTAssertEqual(refused.code, "identity.last_sign_in_method")
        XCTAssertEqual(refused.status, 409)
        identities = try await stranger.app.tula.identities.list()
        XCTAssertEqual(identities.count, 1)

        let (app, browser) = try await signedInWithPassword(s, member)
        identities = try await app.tula.identities.list()
        XCTAssertEqual(identities.count, 0)
        let subject = snowflake()
        let outcome = try await link(s, app, browser, provider, ["subject": subject])
        guard case .linked(let identity) = outcome else {
            return XCTFail("the account was not connected: \(outcome.word)")
        }
        XCTAssertEqual(identity.provider, name)
        try await app.session.signOut()
        let back = try await s.continueWith(provider, ["subject": subject])
        XCTAssertEqual(back.outcome.word, "signed_in")
        let user = await back.app.user()
        XCTAssertEqual(user?.id, memberId)
        XCTAssertEqual(user?.email, member)
    }

    func testXSignUpAndSignIn() async throws {
        try await journey(
            "X sign-up and sign-in",
            "X: a sign-up comes back signed in to an account with no email address, the same id signs it in again, and an address on the consent form is never read"
        ) { _ in
            let s = try await self.server(with: "x")
            try await self.signUpWithNoAddress(s, .x, "x")
        }
    }

    func testXNeverLinksByAddress() async throws {
        try await journey(
            "X never links by address",
            "X: a consent form that names a member's address makes a new account and touches nobody's; its only identity cannot be removed; a profile still connects one"
        ) { _ in
            let s = try await self.server(with: "x")
            try await self.neverLinksByAddress(s, .x, "x")
        }
    }

    func testFacebookSignUpAndSignIn() async throws {
        try await journey(
            "Facebook sign-up and sign-in",
            "Facebook: a sign-up comes back signed in to an account with no email address, the same id signs it in again, and an address on the consent form is never read"
        ) { _ in
            let s = try await self.server(with: "facebook")
            try await self.signUpWithNoAddress(s, .facebook, "facebook")
        }
    }

    func testFacebookNeverLinksByAddress() async throws {
        try await journey(
            "Facebook never links by address",
            "Facebook: a consent form that names a member's address makes a new account and touches nobody's; its only identity cannot be removed; a profile still connects one"
        ) { _ in
            let s = try await self.server(with: "facebook")
            try await self.neverLinksByAddress(s, .facebook, "facebook")
        }
    }
}
