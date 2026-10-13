import Foundation

/// Which of the system's sheets an app gave its client: three facts, and nothing of a
/// sheet itself.
public struct TulaSheets: Hashable, Sendable {
    /// A passkey sheet (`TulaPasskeySheet`).
    public let passkeys: Bool
    /// Apple's sign-in sheet (`TulaAppleSheet`).
    public let apple: Bool
    /// The system's browser session (`TulaBrowserSession`).
    public let browser: Bool
}

/// Why a client could not be made. Every case is a fixed sentence: none repeats what it was
/// given, so a setup screen or a log can show one.
public enum TulaConfigurationError: Error, Hashable, Sendable, CustomStringConvertible {
    /// The key is not a publishable key (`tula_pk_…`). A secret key never belongs in an app.
    case notAPublishableKey
    /// The base URL is not an absolute `https` (or `http`) URL, or has a query, a fragment
    /// or a user name.
    case invalidBaseURL
    /// The timeout is not a positive number of seconds.
    case invalidTimeout

    /// A fixed sentence for the case, which never repeats what the client was given.
    public var description: String {
        switch self {
        case .notAPublishableKey:
            return "TulaClient: the key must be a publishable key (tula_pk_…); a secret key never belongs in an app"
        case .invalidBaseURL:
            return "TulaClient: the base URL must be an absolute http(s) URL with no query, fragment or user name"
        case .invalidTimeout:
            return "TulaClient: the timeout must be a positive number of seconds"
        }
    }
}

/// The Tula Auth client of an app: sign-up, sign-in and password reset as flows of the
/// server's steps, and the session they end in. It has no UI.
///
/// ```swift
/// let tula = try TulaClient(publishableKey: "tula_pk_…", baseURL: "https://auth.example.com")
/// try await tula.session.load()                       // reads the Keychain, once
/// let flow = try await tula.startSignIn(identifier: "maya@example.com")
/// if case .password = flow.screen {
///     try await flow.submitPassword(typed)
/// }
/// let token = try await tula.session.getToken()       // refreshed when it is about to expire
/// ```
///
/// The client is an `ios` client to the API: its tokens come in response bodies, and its
/// refresh token goes to the `TulaTokenStorage` it was given (the Keychain unless a test
/// says otherwise). It never logs, and no error it throws holds a token, a password, a code
/// or an attempt's secret.
public final class TulaClient: Sendable, TulaRedacted {
    /// How long one request may take, unless the client was made with another timeout.
    public static let defaultTimeout: TimeInterval = 15

    /// The session: its state, the access token, refresh and sign-out.
    public let session: TulaSession

    /// Proving again that it is the user, for a call that answered `auth.step_up_required`.
    public var stepUp: TulaStepUp { TulaStepUp(context: context) }
    /// The signed-in user's passkeys.
    public var passkeys: TulaPasskeys { TulaPasskeys(context: context) }
    /// The signed-in user's second factor.
    public var factors: TulaFactors { TulaFactors(context: context) }
    /// The signed-in user's phone number.
    public var phone: TulaPhone { TulaPhone(context: context) }
    /// Which of the system's sheets the app gave this client. A screen draws a passkey
    /// button or a provider's only where its sheet is here: a control that cannot work is
    /// not shown.
    public var sheets: TulaSheets {
        TulaSheets(passkeys: context.passkeys != nil, apple: context.apple != nil, browser: context.browser != nil)
    }
    /// The provider accounts the signed-in user signs in with.
    public var identities: TulaIdentities { TulaIdentities(context: context) }
    /// An email address for a signed-in user whose account has none (ADR 0059).
    public var emailAddress: TulaEmailAddress { TulaEmailAddress(context: context) }

    private let transport: ApiTransport
    private let context: FlowContext
    private let configCache = ConfigCache()

    /// - Parameters:
    ///   - publishableKey: The environment's publishable key (`tula_pk_…`).
    ///   - baseURL: The API's address, e.g. `https://auth.example.com`.
    ///   - storage: Where the refresh token is kept. The Keychain by default; a test passes
    ///     `MemoryTokenStorage`.
    ///   - transport: What sends requests. A `URLSession` of the client's own by default.
    ///   - sessionProfile: A session profile to ask for by name, where the environment lets
    ///     a client choose one.
    ///   - timeout: How long one request may take, in seconds. A refresh never takes longer
    ///     than `TulaSession.refreshTimeout`, whatever this says.
    ///   - clock: Where the time comes from. Only a test passes one.
    ///   - deviceKeys: Where the client's device key is kept. With one, every session this
    ///     client signs in to is bound to the key and every refresh carries a proof signed
    ///     by it (ADR 0043); an app passes `KeychainDeviceKeyStore()`. Without one (the
    ///     default) the client sends no proof and its sessions are not bound.
    ///   - passkeys: The system's passkey sheet; an app passes `SystemPasskeySheet()`.
    ///     Without one every passkey call throws `passkey.unsupported`.
    ///   - apple: The Sign in with Apple sheet; an app passes `SystemAppleSheet()`.
    ///   - browser: The system's browser session for a provider sign-in; an app passes
    ///     `SystemBrowserSession()`.
    /// - Throws: `TulaConfigurationError`.
    public init(
        publishableKey: String,
        baseURL: String,
        storage: (any TulaTokenStorage)? = nil,
        transport: (any TulaHTTPTransport)? = nil,
        sessionProfile: String? = nil,
        timeout: TimeInterval = TulaClient.defaultTimeout,
        clock: any TulaClock = SystemClock(),
        deviceKeys: (any TulaDeviceKeyStore)? = nil,
        passkeys: (any TulaPasskeySheet)? = nil,
        apple: (any TulaAppleSheet)? = nil,
        browser: (any TulaBrowserSession)? = nil
    ) throws {
        guard publishableKey.hasPrefix("tula_pk_") else {
            throw TulaConfigurationError.notAPublishableKey
        }
        guard timeout.isFinite, timeout > 0 else {
            throw TulaConfigurationError.invalidTimeout
        }
        let base = try TulaClient.normalize(baseURL)
        let api = ApiTransport(
            baseURL: base,
            publishableKey: publishableKey,
            clientKind: "ios",
            sessionProfile: sessionProfile,
            http: transport ?? URLSessionTransport(),
            timeout: timeout,
            proofs: deviceKeys.map { DeviceProofs(store: $0) },
            clock: clock
        )
        let roundTrip = ProviderRoundTrip()
        self.transport = api
        self.session = TulaSession(
            transport: api,
            storage: storage ?? TulaClient.defaultStorage(),
            clock: clock,
            // One entry per API and environment, named as `@tula-tech/core` names it.
            scope: "\(base)|\(publishableKey)",
            roundTrip: roundTrip
        )
        self.context = FlowContext(
            transport: api, session: session, passkeys: passkeys, apple: apple, browser: browser, clock: clock,
            roundTrip: roundTrip)
    }

    private static func defaultStorage() -> any TulaTokenStorage {
        #if canImport(Security)
        return KeychainTokenStorage()
        #else
        return MemoryTokenStorage()
        #endif
    }

    /// The origin and path of the API's address, without a trailing slash.
    static func normalize(_ baseURL: String) throws -> String {
        guard
            let parts = URLComponents(string: baseURL),
            let scheme = parts.scheme?.lowercased(), scheme == "https" || scheme == "http",
            let host = parts.host, !host.isEmpty,
            parts.query == nil, parts.fragment == nil, parts.user == nil, parts.password == nil
        else {
            throw TulaConfigurationError.invalidBaseURL
        }
        var text = baseURL
        while text.hasSuffix("/") {
            text.removeLast()
        }
        return text
    }

    // MARK: Flows

    /// Start a sign-up. The server emails a code; the flow's step says so.
    ///
    /// - Parameters:
    ///   - email: The address to sign up with.
    ///   - password: The password; left out where the environment lets an account have none.
    /// - Throws: `TulaError`: a refused password has one entry of `errors` per broken rule.
    public func startSignUp(
        email: String,
        password: String? = nil,
        firstName: String? = nil,
        lastName: String? = nil
    ) async throws -> SignUpFlow {
        let started = try await transport.call(
            TulaOperations.startSignUp,
            body: SignUpRequest(email: email, password: password, firstName: firstName, lastName: lastName),
            as: FlowAttempt.self
        )
        return SignUpFlow(attempt: try await begin(started), operations: .signUp)
    }

    /// Start a sign-in. The first step depends on the environment's settings only, never on
    /// whether the identifier has an account.
    ///
    /// - Parameter identifier: An email address, or, where an environment signs in with a
    ///   texted code, a phone number with its country code (`SignInFlow.prepareSmsCode`,
    ///   `attemptSmsCode`).
    public func startSignIn(identifier: String) async throws -> SignInFlow {
        let started = try await transport.call(
            TulaOperations.startSignIn, body: SignInStartRequest(identifier: identifier), as: FlowAttempt.self
        )
        return SignInFlow(attempt: try await begin(started), operations: .signIn)
    }

    /// Start a password reset. The answer is the same for an address with no account.
    public func startPasswordReset(email: String) async throws -> PasswordResetFlow {
        let started = try await transport.call(
            TulaOperations.startPasswordReset, body: PasswordResetStartRequest(email: email), as: FlowAttempt.self
        )
        return PasswordResetFlow(attempt: try await begin(started), operations: .passwordReset)
    }

    private func begin(_ started: FlowAttempt) async throws -> FlowAttemptState {
        try await context.begin(started)
    }

    // MARK: Passkeys

    /// Sign in with a passkey: one call starts the attempt, shows the system's sheet and
    /// submits what it returns. There is no identifier: the passkey says who it is.
    ///
    /// Nothing of the ceremony is kept: not the challenge, not the credential.
    ///
    /// - Returns: The sign-in at its next step (normally `complete`: a passkey sign-in never
    ///   stops at a second factor), or `dismissed` when the user closed the sheet: nobody
    ///   is signed in and the attempt is left.
    /// - Throws: `TulaError`: `flow.busy` while another sheet of the client is out,
    ///   `passkey.unsupported` for a client with no passkey sheet, `passkey.failed`, and
    ///   `auth.invalid_credentials` for every refusal by the API.
    public func signInWithPasskey() async throws -> TulaCeremony<SignInFlow> {
        let context = self.context
        return try await context.gate.ceremony {
            try context.requirePasskeys()
            let started = try await context.transport.call(
                TulaOperations.startPasskeySignIn, as: PasskeySignInStart.self)
            let attempt = try await context.begin(started.attempt)
            do {
                guard let credential = try await context.assertion(started.options) else {
                    attempt.discard()
                    return .dismissed
                }
                _ = try await attempt.step(
                    TulaOperations.submitSignInPasskey, body: PasskeySignInRequest(credential: credential))
                return .finished(SignInFlow(attempt: attempt, operations: .signIn))
            } catch {
                // One assertion per challenge: after a failure the attempt is no use.
                attempt.discard()
                throw error
            }
        }
    }

    // MARK: Providers

    /// Start a sign-in with a provider's ID token (Google's, Apple's), which the app gets
    /// from the platform's own SDK with the returned nonce in the request.
    ///
    /// The client never talks to the provider: asking for the token is the app's call. For
    /// Apple, `signInWithApple()` does both.
    ///
    /// - Throws: `TulaError`: `auth.method_disabled` where the provider is off (for Apple
    ///   also where the environment has no iOS app registered).
    public func startIdTokenSignIn(provider: IdTokenProvider) async throws -> IdTokenSignIn {
        let started = try await transport.call(
            TulaOperations.startIdTokenSignIn, body: IdTokenStartRequest(provider: provider), as: IdTokenStart.self)
        guard !started.nonce.isEmpty else {
            throw TulaError.client(TulaClientErrorCode.responseInvalid)
        }
        return IdTokenSignIn(nonce: started.nonce, attempt: try await begin(started.attempt))
    }

    /// Sign in with Apple: starts the attempt, shows the Sign in with Apple sheet with the
    /// hash of the server's nonce, and hands the server the identity token.
    ///
    /// - Returns: The sign-in at its next step, or `dismissed` when the user closed the
    ///   sheet: nobody is signed in and the attempt is left.
    /// - Throws: `TulaError`: `flow.busy`, `provider.unsupported` for a client with no
    ///   Apple sheet, `provider.failed`, `auth.method_disabled`, `auth.invalid_credentials`.
    public func signInWithApple() async throws -> TulaCeremony<SignInFlow> {
        let context = self.context
        guard let sheet = context.apple else {
            throw TulaError.client(TulaClientErrorCode.providerUnsupported)
        }
        return try await context.gate.ceremony {
            let pending = try await self.startIdTokenSignIn(provider: .apple)
            let hashed = pending.appleNonce
            do {
                guard
                    let credential = try await context.gate.sheet(
                        .provider, { try await sheet.authorize(hashedNonce: hashed) })
                else {
                    pending.discard()
                    return .dismissed
                }
                return .finished(
                    try await pending.exchange(
                        idToken: credential.idToken, givenName: credential.givenName,
                        familyName: credential.familyName))
            } catch {
                pending.discard()
                throw error
            }
        }
    }

    /// Sign in with a provider through the system's browser session: the provider's page,
    /// and back to the app by a link.
    ///
    /// The returned address is read only when it is `redirectURL` exactly, followed by
    /// `#`; anything else is refused without a request. What the client keeps of the round
    /// trip (the binding, and a ticket whose exchange got no answer) is in memory only.
    ///
    /// - Parameters:
    ///   - provider: The provider.
    ///   - redirectURL: Where the API sends the browser back to: an app link (`https://…`)
    ///     or a custom scheme of the app, as listed in the environment's allowed redirect
    ///     URLs. The server judges it, never the client: `request.redirect_not_allowed` is
    ///     thrown as it is (a custom scheme is refused for a provider without PKCE).
    /// - Throws: `TulaError`: `flow.busy`, `provider.unsupported` for a client with no
    ///   browser session, `provider.failed`, what the start was refused with, and
    ///   `network.failed`, `network.timeout` or `rate_limited` for an exchange that may be
    ///   tried again with `retryProviderSignIn()`.
    public func signIn(with provider: OAuthProvider, redirectURL: String) async throws -> ProviderOutcome {
        try await context.providerRoundTrip(.signIn, provider: provider, redirectURL: redirectURL)
    }

    /// Try again the exchange of a round trip that got no answer. The ticket is kept for
    /// 60 seconds, in memory; with nothing to try the outcome is `refused(.noAnswer)`.
    public func retryProviderSignIn() async throws -> ProviderOutcome {
        let context = self.context
        return try await context.gate.ceremony { try await context.exchangeTicket() }
    }

    /// Forget a round trip that was waiting for another try.
    public func discardProviderSignIn() {
        context.roundTrip.forget()
    }

    // MARK: The signed-in user

    /// The signed-in user, fetched now. The session's state is given the answer.
    public func user() async throws -> CurrentUser {
        let user = try await session.authorized(TulaOperations.getMe, as: CurrentUser.self)
        await session.setUser(user)
        return user
    }

    /// Change the signed-in user's password. The user's other sessions end; this one stays.
    public func changePassword(current: String, new: String) async throws {
        _ = try await session.authorized(
            TulaOperations.changeMyPassword,
            body: ChangePasswordRequest(currentPassword: current, newPassword: new),
            as: NoAnswer.self
        )
    }

    // MARK: The device key

    /// Remove the client's device key from its key store, for a key that never opens again
    /// (`device.key_failed` at every start): the next sign-in then makes a new key.
    ///
    /// **Call this, not the store's own `remove()`**: the client then also forgets a look for
    /// the key that is still out, so that a sign-in that starts afterwards is not handed the
    /// key that was just removed. Sign out first: a session bound to the key cannot be
    /// refreshed after this and is ended at its next refresh. **The same holds for a sign-in
    /// that is under way**: a start that already holds the key when this runs binds its
    /// session to the removed key, and that session is ended at its next refresh. Call this
    /// with no sign-in in flight. A client with no key store does nothing.
    ///
    /// - Throws: `network.timeout` when the store did not answer in time, and
    ///   `device.key_failed` when it refused or when the calling task was cancelled (the
    ///   client has no code of its own for a cancelled call). After a timeout or a
    ///   cancellation the store may still remove the key: the client has forgotten its looks
    ///   as if it had, and calling again is safe.
    public func removeDeviceKey() async throws {
        try await transport.proofs?.remove(within: transport.timeout)
    }

    // MARK: The environment

    /// What a sign-in screen is drawn from: the app's name, the sign-in methods and the
    /// password policy. Kept after the first answer; `force` asks again.
    public func config(force: Bool = false) async throws -> ClientConfig {
        if !force, let cached = await configCache.value {
            return cached
        }
        let fresh = try await transport.call(TulaOperations.getClientConfig, as: ClientConfig.self)
        await configCache.set(fresh)
        return fresh
    }
}

private actor ConfigCache {
    var value: ClientConfig?
    func set(_ next: ClientConfig) { value = next }
}
