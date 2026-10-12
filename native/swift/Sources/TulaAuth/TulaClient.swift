import Foundation

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
public final class TulaClient: Sendable {
    /// How long one request may take, unless the client was made with another timeout.
    public static let defaultTimeout: TimeInterval = 15

    /// The session: its state, the access token, refresh and sign-out.
    public let session: TulaSession

    private let transport: ApiTransport
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
    /// - Throws: `TulaConfigurationError`.
    public init(
        publishableKey: String,
        baseURL: String,
        storage: (any TulaTokenStorage)? = nil,
        transport: (any TulaHTTPTransport)? = nil,
        sessionProfile: String? = nil,
        timeout: TimeInterval = TulaClient.defaultTimeout,
        clock: any TulaClock = SystemClock()
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
            timeout: timeout
        )
        self.transport = api
        self.session = TulaSession(
            transport: api,
            storage: storage ?? TulaClient.defaultStorage(),
            clock: clock,
            // One entry per API and environment, named as `@tula/core` names it.
            scope: "\(base)|\(publishableKey)"
        )
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

    private var context: FlowContext { FlowContext(transport: transport, session: session) }

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
        return SignUpFlow(attempt: try await begin(started), resend: TulaOperations.resendSignUpCode)
    }

    /// Start a sign-in. The first step depends on the environment's settings only, never on
    /// whether the identifier has an account.
    ///
    /// - Parameter identifier: An email address. (The server also takes a phone number where
    ///   an environment signs in with a texted code; this version has no call that proves
    ///   one, so such a sign-in ends at `notSupported`.)
    public func startSignIn(identifier: String) async throws -> SignInFlow {
        let started = try await transport.call(
            TulaOperations.startSignIn, body: SignInStartRequest(identifier: identifier), as: FlowAttempt.self
        )
        return SignInFlow(attempt: try await begin(started), resend: TulaOperations.resendSignInCode)
    }

    /// Start a password reset. The answer is the same for an address with no account.
    public func startPasswordReset(email: String) async throws -> PasswordResetFlow {
        let started = try await transport.call(
            TulaOperations.startPasswordReset, body: PasswordResetStartRequest(email: email), as: FlowAttempt.self
        )
        return PasswordResetFlow(attempt: try await begin(started), resend: TulaOperations.resendPasswordResetCode)
    }

    private func begin(_ started: FlowAttempt) async throws -> FlowAttemptState {
        let attempt = try FlowAttemptState(context: context, started: started)
        _ = try await attempt.accept(started)
        return attempt
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
