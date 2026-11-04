import Foundation
import TulaAuth

// The Swift samples of the documentation (docs/swift.md, docs/methods/*.md). Each
// `// #region name` … `// #endregion` block is copied into the pages by
// `bun run docs:generate`, and `bun run docs:check` fails when a page and this file differ.
//
// This file is compiled with the package's tests (`swift build --build-tests`, `swift test`)
// and nothing in it is run: it shows that the calls the pages name exist with these
// arguments, not what they do. What they do is the unit tests' and the journeys' to show.

/// What an app does with what a call answered. The pages' samples name these; they are the
/// app's own.
private enum App {
    static func showSignIn() {}
    static func showApp(_: CurrentUser?) {}
    static func draw(_: FlowScreen) {}
    static func proceed(_: SignInFlow) {}
    static func explain(_: ProviderRefusal) {}
    /// Google's own SDK, which the app calls: the client never does.
    static func askGoogle(nonce _: String) async throws -> String { "" }
}

enum DocsSnippets {
    static func client() throws -> TulaClient {
        // #region client
        let tula = try TulaClient(
            publishableKey: "tula_pk_…",
            baseURL: "https://auth.example.com"
        )
        // #endregion
        return tula
    }

    static func clientWithDeviceKey() throws -> TulaClient {
        // #region client-device-key
        let tula = try TulaClient(
            publishableKey: "tula_pk_…",
            baseURL: "https://auth.example.com",
            deviceKeys: KeychainDeviceKeyStore()
        )
        // #endregion
        return tula
    }

    static func session(tula: TulaClient) async throws {
        // #region session
        _ = try await tula.session.load()  // reads the Keychain, once
        for await state in await tula.session.updates() {
            switch state {
            case .loading: break  // not known yet
            case .signedOut: App.showSignIn()
            case .signedIn(_, let user): App.showApp(user)
            }
        }
        // #endregion
    }

    static func token(tula: TulaClient) async throws {
        // #region token
        // The access token for a request to your own backend: refreshed first when it is
        // about to expire, `nil` when nobody is signed in.
        let token = try await tula.session.getToken()
        // #endregion
        _ = token
    }

    static func signOut(tula: TulaClient) async {
        // #region sign-out
        do {
            try await tula.session.signOut()
        } catch {
            // Signed out here, but the server could not be told: the session may live on there.
        }
        // #endregion
    }

    static func sessions(tula: TulaClient, other: String) async throws {
        // #region sessions
        let sessions = try await tula.session.list()  // every session of the signed-in user
        try await tula.session.revoke(other)  // one of them, by its id
        let ended = try await tula.session.revokeOthers()  // all but this one; how many ended
        // #endregion
        _ = (sessions, ended)
    }

    static func password(tula: TulaClient, email: String, password: String, typed: String, newPassword: String)
        async throws
    {
        // #region password
        let flow = try await tula.startSignUp(email: email, password: password)
        // The server emailed a code.
        try await flow.verifyEmail(code: typed)  // .complete: tula.session is signed in

        let signIn = try await tula.startSignIn(identifier: email)
        try await signIn.submitPassword(typed)

        let reset = try await tula.startPasswordReset(email: email)
        try await reset.submit(code: typed, password: newPassword)
        // #endregion
    }

    static func expiredPassword(signIn: SignInFlow, newPassword: String) async throws {
        // #region password-expired
        if case .newPassword = signIn.screen {
            // The password was right and is too old: the sign-in ends with a new one.
            try await signIn.submitNewPassword(newPassword)
        }
        // #endregion
    }

    static func changePassword(tula: TulaClient, current: String, newPassword: String) async throws {
        // #region password-change
        try await tula.changePassword(current: current, new: newPassword)
        // #endregion
    }

    static func emailCode(tula: TulaClient, email: String, typed: String) async throws {
        // #region email-code
        let signIn = try await tula.startSignIn(identifier: email)
        if case .firstFactor = signIn.screen {
            try await signIn.prepareEmailCode()  // nothing is emailed until this is called
            try await signIn.attemptEmailCode(typed)
        }
        // #endregion
    }

    static func smsCode(tula: TulaClient, phoneNumber: String, typed: String) async throws {
        // #region sms-code
        let signIn = try await tula.startSignIn(identifier: phoneNumber)
        if case .firstFactor = signIn.screen {
            try await signIn.prepareSmsCode()  // nothing is texted until this is called
            try await signIn.attemptSmsCode(typed)
        }
        // #endregion
    }

    static func passkey(tula: TulaClient) async throws {
        // #region passkey
        switch try await tula.signInWithPasskey() {
        case .finished(let flow): App.proceed(flow)  // complete, or the step the server asks for
        case .dismissed: break  // the user closed the sheet: say nothing
        }
        // #endregion
    }

    static func addPasskey(tula: TulaClient) async throws {
        // #region passkey-add
        // Signed in, after a step-up. `.dismissed` when the user closed the sheet.
        let added = try await tula.passkeys.add(name: "iPhone")
        let passkeys = try await tula.passkeys.list()
        // #endregion
        _ = (added, passkeys)
    }

    static func idToken(tula: TulaClient) async throws {
        // #region id-token
        // Apple: the client runs the sheet.
        let result = try await tula.signInWithApple()

        // Google: the app gets the token from Google's SDK, the client exchanges it.
        let attempt = try await tula.startIdTokenSignIn(provider: .google)
        let idToken = try await App.askGoogle(nonce: attempt.nonce)
        let flow = try await attempt.exchange(idToken: idToken)
        // #endregion
        _ = (result, flow)
    }

    static func provider(tula: TulaClient) async throws {
        // #region provider
        switch try await tula.signIn(with: .github, redirectURL: "https://app.example.com/return") {
        case .signedIn(let flow): App.proceed(flow)
        case .needsStep(let flow): App.draw(flow.screen)  // a second factor
        case .cancelled: break  // the user closed the browser
        case .refused(let why): App.explain(why)
        case .linked: break  // only from identities.link
        }
        // #endregion
    }

    static func secondStep(flow: SignInFlow, typed: String) async throws {
        // #region second-step
        if case .secondFactor = flow.screen {
            try await flow.submitTotp(typed)  // the authenticator app's code
            // or: a backup code, whose answer says how many are left
            let spent = try await flow.submitBackupCode(typed)
            // or: a texted code, asked for first (nothing is texted on arrival)
            try await flow.prepareSmsSecondFactor()
            try await flow.submitSmsCode(typed)
            // or: a passkey, where the client was given a sheet
            let ceremony = try await flow.submitSecondFactorWithPasskey()
            _ = (spent.remaining, ceremony)
        }
        // #endregion
    }

    static func stepUp(tula: TulaClient, typed: String) async throws {
        // #region step-up
        do {
            try await tula.factors.disableTotp()
        } catch let error as TulaError where error.code == "auth.step_up_required" {
            // error.stepUpMethods says how: "totp", "backup_code", "passkey", "password", "email_code"
            try await tula.stepUp.withTotp(typed)
        }
        // #endregion
    }

    static func enrolTotp(tula: TulaClient, typed: String) async throws {
        // #region totp-enrol
        let enrolment = try await tula.factors.startTotp()  // the setup key, shown once
        let backupCodes = try await tula.factors.confirmTotp(code: typed)  // shown once too
        // #endregion
        _ = (enrolment, backupCodes)
    }

    static func emailAddress(tula: TulaClient, typed: String) async throws {
        // #region email-address
        let receipt = try await tula.emailAddress.request("ada@example.com")
        // receipt.destination is the masked address; the code is in the email.
        let user = try await tula.emailAddress.verify(code: typed)
        // #endregion
        _ = (receipt, user)
    }

    static func organizations(tula: TulaClient) async throws {
        // #region organizations
        let page = try await tula.organizations.list()  // each with the user's role and its permissions
        if page.data.isEmpty {
            let acme = try await tula.organizations.create(name: "Acme", slug: "acme")
            try await tula.organizations.setActive(acme.id)  // the next access token carries the claims
        }
        if let organization = try await tula.organizations.active() {
            // Read from the access token, to decide what to draw: your server checks the same keys.
            if organization.has(permission: "org:billing:read") {
                // show the billing tab
            }
            if organization.has(role: "admin") {
                // show the admin tab
            }
        }
        try await tula.organizations.clearActive()  // back to the personal account
        // #endregion
    }

    static func invitation(tula: TulaClient, openedWith url: URL) async throws {
        // #region invitation
        // The app was opened by the link in the emailed invitation (a universal link, say).
        guard let link = TulaInvitationLink.read(url) else { return }
        // The token is a secret. It was in the address's fragment, which no server saw.
        let preview = try await tula.organizations.invitations.preview(token: link.token)
        // preview.organizationName, preview.role and preview.email, to prefill a sign-up.
        // Once the user is signed in as preview.email, with its address verified:
        let joined = try await tula.organizations.invitations.accept(token: link.token)
        try await tula.organizations.setActive(joined.id)
        // or: try await tula.organizations.invitations.decline(token: link.token)
        // #endregion
    }

    static func organizationMembers(tula: TulaClient, organizationId: String) async throws {
        // #region organization-members
        // The server decides from the role the user holds now, on every call.
        let members = try await tula.organizations.members.list(organizationId: organizationId)
        let roles = try await tula.organizations.roles(organizationId: organizationId)  // the roles the user may give
        if let member = members.data.first, roles.data.contains(where: { $0.key == "admin" }) {
            try await tula.organizations.members.changeRole(
                organizationId: organizationId, userId: member.userId, role: "admin")
        }
        try await tula.organizations.update(organizationId: organizationId, name: "Acme Inc")
        try await tula.organizations.leave(organizationId: organizationId)  // refused for the last manager
        try await tula.organizations.remove(organizationId: organizationId)  // deletes it for good
        // #endregion
    }

    static func organizationDomains(tula: TulaClient, organizationId: String, typed: String) async throws {
        // #region organization-domains
        // Claim a domain: a code is emailed to an address on it.
        let claim = try await tula.organizations.domains.start(
            organizationId: organizationId, domain: "acme.com", email: "ada@acme.com", mode: .suggest)
        let proved = try await tula.organizations.domains.verify(
            organizationId: organizationId, domainId: claim.id, code: typed)
        // proved.status is .verified until proved.expiresAt; later .needsReverification.
        _ = try await tula.organizations.domains.update(
            organizationId: organizationId, domainId: proved.id, mode: .autoJoin)
        try await tula.organizations.domains.remove(organizationId: organizationId, domainId: proved.id)
        // #endregion
    }

    static func suggestions(tula: TulaClient) async throws {
        // #region organization-suggestions
        // Organizations whose verified domain is the one of the user's verified address:
        let offered = try await tula.organizations.suggestions()
        if let first = offered.data.first {
            _ = try await tula.organizations.join(first.id)  // with the environment's default role
        }
        // #endregion
    }
}
