import Foundation

/// What the client knows about who is signed in.
public enum AuthState: Hashable, Sendable {
    /// Nothing has been asked yet: the stored refresh token has not been read.
    case loading
    /// Signed in. `user` is `nil` until the profile has been fetched (it is fetched with the
    /// session, and again by `TulaClient.user()`).
    case signedIn(sessionId: String, user: CurrentUser?)
    /// Nobody is signed in.
    case signedOut

    /// Whether somebody is signed in.
    public var isSignedIn: Bool {
        if case .signedIn = self { return true }
        return false
    }
}

/// The session of a client: the tokens, their refresh and the sign-out.
///
/// It behaves as `@tula/core`'s session manager does (ADR 0021, ADR 0051); the rules are the
/// same and are all held here:
///
/// - The access token lives in memory only. The refresh token is in memory and in the
///   client's `TulaTokenStorage` (the Keychain), and nowhere else.
/// - **One refresh at a time.** Calls that need a token at the same moment share one request
///   and one result.
/// - **A refused refresh ends the session once** (`session.*`, `auth.unauthenticated`,
///   `auth.user_banned`): the state becomes `signedOut`, nothing is retried.
/// - **Any other failure keeps the session**: offline, a timeout, a rate limit, a Keychain
///   that cannot be read. The stored token is left where it is.
/// - **A refresh that got no answer is sent once more, at once**, with the same token, inside
///   the same single flight. It is the only request the client repeats by itself, and it is
///   safe because the server answers a token re-presented inside its grace window with the
///   same next token. An HTTP answer of any status is never repeated.
/// - **A `device.*` answer never ends the session** (ADR 0043), with one exception: a
///   refresh refused for its proof (`device.proof_invalid`) when the device key store says,
///   without failing, that there is no key. That session can never be refreshed again, so it
///   is ended here and the server is told. A store that failed, and a key that is there and
///   was refused, keep the session.
/// - Whatever finishes after a sign-out or a new sign-in is discarded: every change of
///   session bumps a generation, and a result of an older one is never installed.
public actor TulaSession: TulaRedacted {
    /// How long before an access token expires the client stops handing it out and refreshes
    /// (capped at half the token's lifetime).
    public static let accessTokenExpirySkew: TimeInterval = 10

    /// How long a refresh request may take. Below the smallest grace window a session profile
    /// may set (`MIN_REUSE_GRACE_PERIOD`, 10 seconds), so that the client gives up while
    /// presenting the same token again is still forgiven. Equal to `@tula/core`'s
    /// `REFRESH_TIMEOUT_MS`; a test holds the two equal.
    public static let refreshTimeout: TimeInterval = 8

    /// How long, from the start of a refresh, its one repeat may still be running.
    public static let refreshRetryWindow: TimeInterval = 10

    /// The least time the repeat of a refresh is given, however long the first try took.
    static let minRefreshRetryTimeout: TimeInterval = 1

    /// The longest a `Retry-After` on a failed refresh makes `getToken()` fail fast.
    public static let maxRefreshBackoff: TimeInterval = 300

    private struct Tokens: TulaRedacted {
        let accessToken: String
        let sessionId: String
        let expiresAt: Date
        var refreshAt: Date
    }

    private struct Exchange: TulaRedacted {
        var token: String?
        var installed: Int?
        var failure: TulaError?
    }

    private let transport: ApiTransport
    private let storage: any TulaTokenStorage
    private let clock: any TulaClock
    private let storageKey: String
    private let refreshTimeout: TimeInterval
    /// What the client keeps of a provider round trip: forgotten when the session ends.
    private let roundTrip: ProviderRoundTrip?

    /// The current state.
    public private(set) var state: AuthState = .loading
    private var tokens: Tokens?
    /// The refresh token, mirrored from the storage.
    private var refreshToken: String?
    /// Whether `refreshToken` reflects the storage (read once, then kept in step).
    private var storageRead = false
    /// Bumped whenever the session changes hands: a sign-in, a refresh, a sign-out.
    private var generation = 0
    private var refreshing: (id: Int, task: Task<String?, Error>)?
    private var refreshes = 0
    /// After an answer with `Retry-After`: fail fast until then instead of asking again.
    private var backoff: (until: Date, error: TulaError)?
    /// A refresh token issued to a refresh that lost to a sign-out, kept so that the sign-out
    /// can revoke it.
    private var orphan: String?
    /// The refresh token of a sign-out the server was never told of. Memory only; nothing but
    /// `signOut()` reads it, and no refresh presents it.
    private var undelivered: String?
    private var listeners: [Int: AsyncStream<AuthState>.Continuation] = [:]
    private var listenerIds = 0

    init(
        transport: ApiTransport,
        storage: any TulaTokenStorage,
        clock: any TulaClock,
        scope: String,
        roundTrip: ProviderRoundTrip? = nil
    ) {
        self.roundTrip = roundTrip
        self.transport = transport
        self.storage = storage
        self.clock = clock
        self.storageKey = "tula.refresh.\(scope)"
        self.refreshTimeout = min(TulaSession.refreshTimeout, transport.timeout)
    }

    // MARK: State

    /// The state now and every state after it, until the stream is dropped.
    public func updates() -> AsyncStream<AuthState> {
        let (stream, continuation) = AsyncStream<AuthState>.makeStream(bufferingPolicy: .unbounded)
        listenerIds += 1
        let id = listenerIds
        listeners[id] = continuation
        continuation.yield(state)
        continuation.onTermination = { [weak self] _ in
            Task { await self?.forget(listener: id) }
        }
        return stream
    }

    private func forget(listener id: Int) {
        listeners[id] = nil
    }

    private func setState(_ next: AuthState) {
        guard next != state else {
            return
        }
        state = next
        for listener in listeners.values {
            listener.yield(next)
        }
    }

    /// Read the stored session, once: the state is no longer `loading` when this returns.
    ///
    /// - Throws: `TulaError` when the stored token could not be read (`storage.failed`) or
    ///   refreshed for a reason that is not a refusal; the state is then still `loading`
    ///   and the stored token is kept.
    @discardableResult
    public func load() async throws -> AuthState {
        if state == .loading {
            _ = try await sharedRefresh(explicit: false)
        }
        return state
    }

    // MARK: Tokens

    /// A usable access token, refreshed first when the one in memory is about to expire;
    /// `nil` when nobody is signed in.
    ///
    /// - Throws: `TulaError` when a refresh was needed and could not be made. The session is
    ///   kept: the same call works when the network is back. `storage.failed` after a
    ///   refresh means the new token is in memory and could not be stored: the storage still
    ///   holds the one the server has replaced, until the next refresh that succeeds.
    public func getToken() async throws -> String? {
        if state == .signedOut {
            return nil
        }
        if let tokens, clock.now() < tokens.refreshAt {
            return tokens.accessToken
        }
        do {
            return try await sharedRefresh(explicit: false)
        } catch {
            // The refresh could not be made. A token inside its skew is still valid for a few
            // seconds: better to use it than to fail a request that would work.
            if let tokens, clock.now() < tokens.expiresAt {
                return tokens.accessToken
            }
            throw error
        }
    }

    /// Ask for a new access token now; `nil` when nobody is signed in (or the server just
    /// said the session is over).
    public func refresh() async throws -> String? {
        try await sharedRefresh(explicit: true)
    }

    private func sharedRefresh(explicit: Bool) async throws -> String? {
        if let refreshing {
            return try await refreshing.task.value
        }
        refreshes += 1
        let id = refreshes
        // Not the caller's task: a caller that is cancelled must not cancel the refresh the
        // others are waiting for, and a refresh under way has to record what it was issued.
        let task = Task<String?, Error> {
            defer { self.finished(refresh: id) }
            return try await self.runRefresh(explicit: explicit)
        }
        refreshing = (id, task)
        return try await task.value
    }

    private func finished(refresh id: Int) {
        if refreshing?.id == id {
            refreshing = nil
        }
    }

    private func runRefresh(explicit: Bool) async throws -> String? {
        // An explicit `refresh()` is the app asking now: it always asks. Only the implicit
        // refreshes wait out a `Retry-After`.
        if !explicit, let backoff, clock.now() < backoff.until {
            throw backoff.error
        }
        let result = try await exchange(started: generation)
        if let installed = result.installed {
            await settle(installed)
        }
        if let failure = result.failure {
            throw failure
        }
        return result.token
    }

    private func exchange(started: Int) async throws -> Exchange {
        if generation != started {
            return Exchange(token: tokens?.accessToken)
        }
        let presented = try await storedRefreshToken()
        if generation != started {
            return Exchange(token: tokens?.accessToken)
        }
        guard let presented, !presented.isEmpty else {
            endLocal()
            return Exchange(token: nil)
        }
        let body = RefreshTokenRequest(refreshToken: presented)
        let sentAt = clock.now()
        let issued: SessionTokens
        do {
            do {
                issued = try await transport.call(
                    TulaOperations.refreshSession,
                    body: body,
                    options: CallOptions(timeout: refreshTimeout),
                    as: SessionTokens.self
                )
            } catch let error as TulaError where TulaSession.gotNoAnswer(error) && generation == started {
                // The one automatic repeat: no answer came, so the server may or may not have
                // rotated the token. Presenting the same token again at once is answered with
                // the same next token if it did, and is an ordinary refresh if it did not.
                let left = TulaSession.refreshRetryWindow - clock.now().timeIntervalSince(sentAt)
                issued = try await transport.call(
                    TulaOperations.refreshSession,
                    body: body,
                    options: CallOptions(
                        timeout: min(refreshTimeout, max(TulaSession.minRefreshRetryTimeout, left))
                    ),
                    as: SessionTokens.self
                )
            }
        } catch {
            if generation != started {
                return Exchange(token: tokens?.accessToken)
            }
            if let refusal = error as? TulaError {
                if refusal.code == "device.proof_invalid", let proofs = transport.proofs {
                    // The one `device.*` answer that can end a session, and only when the key
                    // store said twice that the key is gone.
                    let verdict = await proofs.verdict(within: refreshTimeout)
                    if generation != started {
                        return Exchange(token: tokens?.accessToken)
                    }
                    switch verdict {
                    case .gone:
                        await endForLostKey(presented)
                        return Exchange(token: nil)
                    case .contradicted:
                        throw TulaError.client(TulaClientErrorCode.deviceKeyFailed)
                    case .there, .unsure:
                        break
                    }
                }
                if TulaSession.sessionIsGone(refusal) {
                    endLocal()
                    try? await storage.remove(storageKey)
                    return Exchange(token: nil)
                }
                if let wait = refusal.retryAfter {
                    backoff = (
                        clock.now().addingTimeInterval(min(wait, TulaSession.maxRefreshBackoff)),
                        refusal
                    )
                }
            }
            throw error
        }
        guard lifetime(of: issued) != nil, let accessToken = issued.accessToken else {
            // A 200 that is not session tokens. Nothing is installed or stored, and the
            // session this client has is left alone.
            throw TulaError.client(TulaClientErrorCode.responseInvalid)
        }
        if generation != started {
            // Signed out (or signed in as someone else) while the request was in flight. The
            // tokens are not installed; the refresh token is kept only for the sign-out.
            if let token = issued.refreshToken {
                orphan = token
            }
            return Exchange(token: tokens?.accessToken)
        }
        let installed = commit(issued)
        return Exchange(token: accessToken, installed: installed, failure: await persist(issued))
    }

    private func storedRefreshToken() async throws -> String? {
        if !storageRead {
            let value: String?
            do {
                value = try await storage.get(storageKey)
            } catch {
                throw TulaError.client(TulaClientErrorCode.storageFailed)
            }
            // A sign-in may have finished while the store was being read; its token is newer.
            if !storageRead {
                refreshToken = value
                storageRead = true
            }
        }
        return refreshToken
    }

    private func persist(_ issued: SessionTokens) async -> TulaError? {
        guard let token = issued.refreshToken else {
            return nil
        }
        do {
            try await storage.set(storageKey, token)
            return nil
        } catch {
            return TulaError.client(TulaClientErrorCode.storageFailed)
        }
    }

    /// Install freshly issued tokens in memory.
    private func commit(_ issued: SessionTokens) -> Int {
        generation += 1
        let now = clock.now()
        let lifetime = self.lifetime(of: issued) ?? 0
        tokens = Tokens(
            accessToken: issued.accessToken ?? "",
            sessionId: issued.sessionId,
            expiresAt: now.addingTimeInterval(lifetime),
            refreshAt: now.addingTimeInterval(lifetime - min(TulaSession.accessTokenExpirySkew, lifetime / 2))
        )
        backoff = nil
        if let token = issued.refreshToken {
            refreshToken = token
            storageRead = true
        }
        return generation
    }

    /// Publish the state for the tokens installed at `mine`, unless the session has moved on.
    private func settle(_ mine: Int) async {
        guard let current = tokens, generation == mine else {
            return
        }
        var user: CurrentUser?
        if case .signedIn(current.sessionId, let known) = state {
            user = known
        }
        if user == nil {
            // The session itself is fine when this fails; the profile is fetched again by
            // `TulaClient.user()` or the next refresh.
            user = try? await transport.call(
                TulaOperations.getMe,
                options: CallOptions(accessToken: current.accessToken),
                as: CurrentUser.self
            )
        }
        guard generation == mine else {
            return
        }
        setState(.signedIn(sessionId: current.sessionId, user: user))
    }

    /// Forget the session in this client.
    private func endLocal() {
        generation += 1
        tokens = nil
        refreshToken = nil
        storageRead = true
        backoff = nil
        roundTrip?.forget()
        setState(.signedOut)
    }

    /// The session was bound to a device key that is gone: it is over. Forget it here, then
    /// tell the server, which asks no proof for a sign-out. When the server could not be
    /// told the token is kept, in memory, for the next `signOut()`.
    private func endForLostKey(_ presented: String) async {
        endLocal()
        let mine = generation
        try? await storage.remove(storageKey)
        do {
            // Inside the shared refresh, which every caller of `getToken()` is waiting on: the
            // server is given the refresh's own deadline to answer and no longer.
            _ = try await transport.call(
                TulaOperations.signOut, body: RefreshTokenRequest(refreshToken: presented),
                options: CallOptions(timeout: refreshTimeout), as: NoAnswer.self)
        } catch {
            let code = (error as? TulaError)?.code ?? ""
            if generation == mine, !code.hasPrefix("session.") {
                undelivered = presented
            }
        }
    }

    // MARK: Signing in and out

    /// Install the tokens a completed flow returned.
    func adopt(_ issued: SessionTokens) async throws {
        guard lifetime(of: issued) != nil else {
            throw TulaError.client(TulaClientErrorCode.responseInvalid)
        }
        // A new session: an earlier one's sign-out is no longer this client's to retry.
        undelivered = nil
        let installed = commit(issued)
        let failure = await persist(issued)
        await settle(installed)
        if let failure {
            throw failure
        }
    }

    /// End the session here and on the server.
    ///
    /// **A failed sign-out is not a sign-out.** When the server could not be told, this
    /// throws: the client is signed out all the same (its tokens are gone from memory and
    /// from the storage), but the session may live on at the server until it is told.
    /// Calling `signOut()` again tells it: the token of the failed try is kept in memory for
    /// that, and for nothing else. An app must not report "signed out" for a call that threw.
    ///
    /// Two cases a second call cannot put right, both `storage.failed`: a stored token that
    /// could not be **removed** is still in the storage and signs the user in again at the
    /// next launch; and a stored token that was never read and could not be read now is
    /// removed without the server being told, because the client never held it (that
    /// session lives on at the server until it ends by itself or is revoked from another
    /// session).
    ///
    /// A key store that says its key will never be had again
    /// (`TulaDeviceKeyStoreError.unusable`) is asked to remove it, best effort: a removal
    /// that fails is not this call's failure. **A sign-out whose task is cancelled while
    /// the store is being asked removes nothing**, also when the store then says "never
    /// again": the call stops waiting for the store, and nobody is left to act on its
    /// answer. The next sign-out asks again.
    ///
    /// - Throws: `TulaError`: what the request failed with, or `storage.failed` when the
    ///   stored token could not be removed.
    public func signOut() async throws {
        let pending = refreshing?.task
        let unread = !storageRead
        var presented = refreshToken
        var failure: TulaError?
        orphan = nil
        // Local state first, so the app is signed out whatever the network does next.
        endLocal()
        let mine = generation
        // A refresh already in flight may be rotating the token right now. Wait for it, then
        // end the session with whatever is newest, so that nothing outlives the sign-out.
        _ = try? await pending?.value
        if unread {
            do {
                presented = try await storage.get(storageKey)
            } catch {
                failure = TulaError.client(TulaClientErrorCode.storageFailed)
            }
        }
        // A sign-in that finished meanwhile has stored its own token; that one stays.
        // Otherwise the stored token is removed also when it could not be read: a token left
        // behind would sign the user back in at the next launch.
        if generation == mine {
            do {
                try await storage.remove(storageKey)
            } catch {
                failure = TulaError.client(TulaClientErrorCode.storageFailed)
            }
        }
        let newest = orphan ?? presented ?? undelivered
        orphan = nil
        if let newest {
            do {
                _ = try await transport.call(
                    TulaOperations.signOut,
                    body: RefreshTokenRequest(refreshToken: newest),
                    as: NoAnswer.self
                )
                undelivered = nil
            } catch {
                let refusal = error as? TulaError ?? TulaError.client(TulaClientErrorCode.networkFailed)
                failure = refusal
                // The token was just dropped, so it is held for the retry, unless the API
                // said the session is over or a sign-in finished meanwhile.
                if generation == mine {
                    undelivered = refusal.code.hasPrefix("session.") ? nil : newest
                }
            }
        }
        // A device key that cannot be had would fail the next sign-in too: with nobody
        // signed in here, what the store keeps of it is removed.
        if generation == mine, let proofs = transport.proofs {
            await proofs.dropUnusableKey(within: refreshTimeout)
        }
        if let failure {
            throw failure
        }
    }

    /// Resolves when no refresh is in flight.
    func idle() async {
        _ = try? await refreshing?.task.value
    }

    /// A session was revoked on the server: end the local state if it is this one.
    func ended(_ sessionId: String) async {
        guard tokens?.sessionId == sessionId else {
            return
        }
        endLocal()
        try? await storage.remove(storageKey)
    }

    func setUser(_ user: CurrentUser) {
        if case .signedIn(let sessionId, _) = state {
            setState(.signedIn(sessionId: sessionId, user: user))
        }
    }

    /// The id of the session that is signed in, once who is signed in has been settled (a
    /// client that has not loaded yet restores its session here); `nil` when nobody is.
    func settledSessionId() async throws -> String? {
        _ = try await getToken()
        if case .signedIn(let sessionId, _) = state {
            return sessionId
        }
        return nil
    }

    /// Correct the state's user after a call that changed it, as `@tula/core`'s `asUser`
    /// does: the user belongs to the session that asked, so when that session ended, or
    /// somebody else signed in, while the request was in flight, nothing is installed.
    ///
    /// - Parameters:
    ///   - asked: The session that asked (`settledSessionId()` before the call).
    ///   - change: What the user is now, from what the state held; `nil` installs nothing.
    func setUser(askedBy asked: String?, _ change: @Sendable (CurrentUser?) -> CurrentUser?) {
        guard let asked, case .signedIn(let sessionId, let held) = state, sessionId == asked,
            let user = change(held)
        else {
            return
        }
        setState(.signedIn(sessionId: sessionId, user: user))
    }

    // MARK: Calls as the signed-in user

    /// Send an operation with the user's access token, refreshing once if the API refuses the
    /// token (it expired on the way, or the session was revoked).
    func authorized<Body: Encodable & Sendable, Answer: Decodable & Sendable>(
        _ operation: TulaOperation,
        params: [String: String] = [:],
        body: Body? = Optional<NoBody>.none,
        as type: Answer.Type = NoAnswer.self
    ) async throws -> Answer {
        try await sent(operation, params: params, body: body, as: type).answer
    }

    /// As `authorized`, with the session's generation when the request that was answered left.
    private func sent<Body: Encodable & Sendable, Answer: Decodable & Sendable>(
        _ operation: TulaOperation,
        params: [String: String] = [:],
        body: Body? = Optional<NoBody>.none,
        as type: Answer.Type = NoAnswer.self
    ) async throws -> (answer: Answer, generation: Int) {
        guard let accessToken = try await getToken() else {
            throw TulaError(code: "auth.unauthenticated", status: 401)
        }
        do {
            let left = generation
            let answer = try await transport.call(
                operation, params: params, body: body,
                options: CallOptions(accessToken: accessToken), as: type
            )
            return (answer, left)
        } catch let error as TulaError where TulaSession.tokenWasRefused(error) {
            // Signed out while the call was in flight: the refusal is simply true.
            if state == .signedOut {
                throw error
            }
            var next: String?
            if let tokens, tokens.accessToken != accessToken {
                next = tokens.accessToken
            } else {
                next = try await sharedRefresh(explicit: false)
            }
            guard let next else {
                throw error
            }
            let left = generation
            let answer = try await transport.call(
                operation, params: params, body: body,
                options: CallOptions(accessToken: next), as: type
            )
            return (answer, left)
        }
    }

    /// Prove again that it is the user (`POST /v1/client/sessions/step-up`), and take the
    /// access token that says so.
    ///
    /// Only the access token of the answer is installed: a step-up does not rotate the
    /// refresh token. When the session's token was replaced while the proof was on its way,
    /// neither token is trusted and one refresh, started after the proof was accepted, is
    /// what carries it.
    func stepUp(_ proof: StepUpRequest) async throws {
        // A refresh already in flight would otherwise hand the proof a token about to be replaced.
        await idle()
        let (answer, left) = try await sent(TulaOperations.stepUpSession, body: proof, as: SessionTokens.self)
        guard lifetime(of: answer) != nil else {
            throw TulaError.client(TulaClientErrorCode.responseInvalid)
        }
        // Signed out, or signed in as someone else, while the proof was in flight: the answer
        // is about a session this client no longer has.
        guard state != .signedOut, tokens?.sessionId == answer.sessionId else {
            throw TulaError(code: "auth.unauthenticated", status: 401)
        }
        if generation == left, refreshing == nil {
            let installed = commit(
                SessionTokens(
                    sessionId: answer.sessionId, accessToken: answer.accessToken,
                    accessTokenExpiresAt: answer.accessTokenExpiresAt))
            await settle(installed)
            return
        }
        await idle()
        guard tokens?.sessionId == answer.sessionId, try await sharedRefresh(explicit: true) != nil else {
            throw TulaError(code: "auth.unauthenticated", status: 401)
        }
    }

    /// The signed-in user's sessions, this one marked `current`.
    public func list() async throws -> [Session] {
        try await authorized(TulaOperations.listSessions, as: SessionList.self).data
    }

    /// End one of the user's sessions. Ending this client's own signs it out here too.
    public func revoke(_ sessionId: String) async throws {
        _ = try await authorized(TulaOperations.revokeSession, params: ["sessionId": sessionId], as: NoAnswer.self)
        await ended(sessionId)
    }

    /// End every session of the user but this one.
    ///
    /// - Returns: How many were ended.
    public func revokeOthers() async throws -> Int {
        try await authorized(TulaOperations.revokeOtherSessions, as: RevokedSessions.self).revoked
    }

    // MARK: Reading an answer

    /// How long the access token of an answer is valid, measured by the server (`exp - iat`
    /// of the token, so that a device clock minutes off does not matter), or from the expiry
    /// sent beside it. `nil` when the answer is not session tokens this client can install:
    /// a successful answer is checked before it is used, because a 200 is not proof of
    /// talking to the API.
    private func lifetime(of issued: SessionTokens) -> TimeInterval? {
        guard let token = issued.accessToken, !token.isEmpty, !issued.sessionId.isEmpty else {
            return nil
        }
        if let lifetime = TulaSession.jwtLifetime(token) {
            return lifetime
        }
        guard let text = issued.accessTokenExpiresAt, let expires = TulaSession.date(text) else {
            return nil
        }
        return max(0, expires.timeIntervalSince(clock.now()))
    }

    static func jwtLifetime(_ token: String) -> TimeInterval? {
        let parts = token.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 3 else {
            return nil
        }
        var payload = parts[1].replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        payload += String(repeating: "=", count: (4 - payload.count % 4) % 4)
        guard
            let data = Data(base64Encoded: payload),
            case .object(let claims)? = try? JSONDecoder().decode(TulaJSONValue.self, from: data),
            case .number(let issuedAt)? = claims["iat"],
            case .number(let expires)? = claims["exp"],
            expires > issuedAt
        else {
            return nil
        }
        return expires - issuedAt
    }

    static func date(_ text: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: text) {
            return date
        }
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: text)
    }

    /// Whether a refused refresh means the session is over (as opposed to a problem that may
    /// pass).
    static func sessionIsGone(_ error: TulaError) -> Bool {
        error.code.hasPrefix("session.") || error.code == "auth.unauthenticated" || error.code == "auth.user_banned"
    }

    /// Whether a request ended without any answer from the API.
    static func gotNoAnswer(_ error: TulaError) -> Bool {
        error.code == TulaClientErrorCode.networkTimeout || error.code == TulaClientErrorCode.networkFailed
    }

    /// Whether the API refused the access token itself, which a refresh may cure.
    static func tokenWasRefused(_ error: TulaError) -> Bool {
        error.status == 401 && (error.code.hasPrefix("session.") || error.code == "auth.unauthenticated")
    }
}
