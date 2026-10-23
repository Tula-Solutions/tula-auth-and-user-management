package dev.tula.auth

import dev.tula.auth.generated.ActiveOrganization
import dev.tula.auth.generated.CurrentUser
import dev.tula.auth.generated.RefreshTokenRequest
import dev.tula.auth.generated.SessionTokens
import dev.tula.auth.generated.SetActiveOrganizationRequest
import dev.tula.auth.generated.TulaJson
import dev.tula.auth.generated.TulaOperation
import dev.tula.auth.generated.TulaOperations
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.async
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.doubleOrNull
import java.time.OffsetDateTime
import java.util.Base64

/** The time, as the client reads it. A test passes one it can move. */
fun interface Clock {
    /** @return Milliseconds since the epoch. */
    fun nowMs(): Long
}

/** What the client knows about who is signed in. */
sealed class AuthState {
    /** Not known yet: [TulaClient.load] has not finished. */
    object Loading : AuthState() {
        override fun toString(): String = "Loading"
    }

    /** Nobody is signed in. */
    object SignedOut : AuthState() {
        override fun toString(): String = "SignedOut"
    }

    /** Somebody is signed in. */
    data class SignedIn(
        /** The session's id. */
        val sessionId: String,
        /** The user, or `null` while the profile could not be fetched yet. */
        val user: CurrentUser?,
    ) : AuthState() {
        /** Names the session only: a user's address is not for a log line. */
        override fun toString(): String = "SignedIn(sessionId=$sessionId)"
    }
}

/**
 * How long before an access token expires the client stops using it and refreshes instead.
 *
 * A token has to outlive the request that carries it: the time to reach the API plus any
 * difference between clocks. For a shorter-lived token the skew is capped at half its lifetime.
 */
const val ACCESS_TOKEN_EXPIRY_SKEW_MS: Long = 10_000

/**
 * How long a refresh request may take before it fails with `network.timeout`, unless the client
 * was created with a smaller timeout.
 *
 * It is deliberately shorter than the server's smallest refresh reuse grace period (10
 * seconds). A refresh whose answer is lost may already have rotated the token on the server;
 * presenting the same token again is forgiven only inside the grace period, and treated as
 * theft (the whole session is revoked) after it. The same number as `@tula-tech/core`'s
 * `REFRESH_TIMEOUT_MS`; a test of the repository holds the two equal.
 */
const val REFRESH_TIMEOUT_MS: Long = 8_000

/**
 * How long, from the start of a refresh, its one automatic repeat may still be running: the
 * server's default refresh reuse grace period.
 *
 * A refresh that gets no answer (a timeout or a network failure, never an HTTP answer) is sent
 * once more, at once. It is the only request the client repeats by itself, and it is safe by
 * design: if the server did rotate the token, it answers the same token presented again inside
 * the grace period with the same next token.
 */
const val REFRESH_RETRY_WINDOW_MS: Long = 10_000

/** The least time the repeat of a refresh is given, however long the first try took. */
internal const val MIN_REFRESH_RETRY_TIMEOUT_MS: Long = 1_000

/**
 * The longest a `Retry-After` on a failed refresh makes [TulaSession.getToken] fail fast
 * without asking again. An explicit [TulaSession.refresh] always asks.
 */
const val MAX_REFRESH_BACKOFF_MS: Long = 5 * 60_000

/** The access token in memory, with its expiry on this device's clock. */
private class Tokens(
    val accessToken: String,
    val sessionId: String,
    /** When the token expires. */
    val expiresAt: Long,
    /** When the client stops handing it out: [expiresAt] minus the skew. */
    val refreshAt: Long,
)

/** What a refresh produced. */
private class Exchange(
    /** The access token to return; `null` when nobody is signed in. */
    val token: String?,
    /** Set when this refresh installed new tokens: the generation whose state is to be settled. */
    val installed: Int? = null,
    /** The refresh worked but the new refresh token could not be stored. */
    val failure: TulaError? = null,
)

private class Backoff(val until: Long, val error: TulaError)

/** `exp - iat` of a JWT in milliseconds, or `null` when the token is not a readable JWT. */
private fun jwtLifetimeMs(token: String): Long? {
    return try {
        val payload = token.split('.').getOrNull(1) ?: return null
        val claims = TulaJson.parseToJsonElement(
            Base64.getUrlDecoder().decode(payload).toString(Charsets.UTF_8),
        ) as? JsonObject ?: return null
        val issued = (claims["iat"] as? JsonPrimitive)?.takeIf { !it.isString }?.doubleOrNull
        val expires = (claims["exp"] as? JsonPrimitive)?.takeIf { !it.isString }?.doubleOrNull
        if (issued != null && expires != null && expires > issued) {
            ((expires - issued) * 1000).toLong()
        } else {
            null
        }
    } catch (_: IllegalArgumentException) {
        // Not base64url: the caller falls back to the expiry sent beside the token.
        null
    } catch (_: SerializationException) {
        null
    }
}

private fun parseInstantMs(text: String?): Long? =
    try {
        text?.let { OffsetDateTime.parse(it).toInstant().toEpochMilli() }
    } catch (_: java.time.DateTimeException) {
        null
    }

/**
 * Whether an answer has what the client needs from session tokens: an access token, the
 * session's id and an expiry it can read. A successful answer is checked before it is
 * installed, because a 200 is not proof of talking to the API.
 *
 * A session with no access token (a `stateful` profile's, which is a browser's cookie) is not
 * a session for this client: it has no cookie jar.
 */
internal fun isSessionTokens(value: SessionTokens?): Boolean {
    val token = value?.accessToken
    return value != null &&
        !token.isNullOrEmpty() &&
        value.sessionId.isNotEmpty() &&
        (jwtLifetimeMs(token) != null || parseInstantMs(value.accessTokenExpiresAt) != null)
}

/** Whether a refused refresh means the session is over (as opposed to a problem that may pass). */
private fun sessionIsGone(error: TulaError): Boolean =
    error.code.startsWith("session.") ||
        error.code == "auth.unauthenticated" ||
        error.code == "auth.user_banned"

/** Whether a request ended without any answer from the API. */
private fun gotNoAnswer(error: TulaError): Boolean =
    error.code == ClientErrorCodes.NETWORK_TIMEOUT || error.code == ClientErrorCodes.NETWORK_FAILED

/** Whether the API refused the access token itself, which a refresh may cure. */
private fun tokenWasRefused(error: TulaError): Boolean =
    error.status == 401 &&
        (error.code.startsWith("session.") || error.code == "auth.unauthenticated")

/**
 * Token state, refresh and sign-out: everything the client knows about the session. A port of
 * `@tula-tech/core`'s session manager for a client that is never a browser (ADR 0054).
 *
 * The rules, all enforced here:
 * - The access token lives in memory only. The refresh token is held in memory and in
 *   [storage], and nowhere else.
 * - One refresh at a time: calls share one request.
 * - A refused refresh ends the session once: the state becomes [AuthState.SignedOut], nothing
 *   is retried.
 * - A refresh that gets no answer at all is sent once more, at once, inside the same single
 *   flight: the only automatic repeat in the client.
 * - Any other failure of a refresh keeps the session and its stored token.
 * - Whatever finishes after a sign-out or a new sign-in is discarded: every change of session
 *   bumps a generation, and a result from an older generation is never installed.
 * - Every call of [storage] is inside a deadline (the refresh's), and the deadline does not
 *   rest on the storage ending when it is cancelled: a call that never returns is
 *   `storage.failed`, the session kept, exactly as one that throws. Nothing here awaits the
 *   storage any other way than through [stored].
 *
 * Every member that reads or writes the fields below runs on [confined], a dispatcher that
 * runs one piece of work at a time: between two suspension points nothing else touches them,
 * as on the single thread the TypeScript client has.
 */
internal class SessionManager(
    private val transport: Transport,
    private val storage: TokenStorage,
    private val clock: Clock,
    private val scope: CoroutineScope,
    private val confined: CoroutineDispatcher,
    private val refreshTimeoutMs: Long,
    private val storageKey: String,
    private val messages: () -> Messages,
    /** The device key's proofs; `null` for a client with no device key. */
    private val proofs: DeviceProofs? = null,
    /** Called when the session ends here: what else belonged to it is forgotten. */
    private val onEnd: () -> Unit = {},
) {
    private val current = MutableStateFlow<AuthState>(AuthState.Loading)

    /** The state, and every change of it. */
    val state: StateFlow<AuthState> get() = current

    private var tokens: Tokens? = null

    /** The refresh token, mirrored from [storage]. */
    private var refreshToken: String? = null

    /** Whether [refreshToken] reflects [storage] (read once, then kept in step). */
    private var storageRead = false

    /** Bumped whenever the session changes hands: sign-in, refresh, sign-out. */
    private var generation = 0
    private var refreshing: Deferred<String?>? = null

    /** After a 429 or 503 with `Retry-After`: fail fast until then instead of asking again. */
    private var backoff: Backoff? = null

    /** A refresh token issued to a refresh that lost to a sign-out, kept so sign-out can revoke it. */
    private var orphan: String? = null

    /**
     * The refresh token of a sign-out the server was never told of (the request got no answer,
     * or one that was not about the session). The client is signed out and stays so; this is
     * kept only so that the next sign-out can send it. Memory only: never storage, an error or
     * a log line, and nothing but [signOut] reads it (no refresh presents it). Forgotten once
     * delivered, when the API answers that the session is over, and when a new session is
     * adopted.
     */
    private var undelivered: String? = null

    private fun setState(next: AuthState) {
        if (next != current.value) {
            current.value = next
        }
    }

    /** Forget the session in this client. */
    private fun endLocal() {
        generation += 1
        tokens = null
        refreshToken = null
        storageRead = true
        backoff = null
        onEnd()
        setState(AuthState.SignedOut)
    }

    private suspend fun fetchUser(accessToken: String): CurrentUser? =
        try {
            transport.decode(
                CurrentUser.serializer(),
                transport.call(TulaOperations.getMe, CallInput(accessToken = accessToken)),
            )
        } catch (_: TulaError) {
            // The session itself is fine; the profile is fetched again by `user()` or by the
            // next refresh, and until then the state says `user = null`.
            null
        }

    /** Publish the state for the tokens installed at [mine], unless the session has moved on. */
    private suspend fun settle(mine: Int) {
        val held = tokens
        if (held == null || generation != mine) {
            return
        }
        val now = current.value
        val known = if (now is AuthState.SignedIn && now.sessionId == held.sessionId) now.user else null
        val user = known ?: fetchUser(held.accessToken)
        if (generation != mine) {
            return
        }
        setState(AuthState.SignedIn(held.sessionId, user))
    }

    /** Install freshly issued tokens in memory. [isSessionTokens] has been asked first. */
    private fun commit(issued: SessionTokens): Int {
        generation += 1
        val now = clock.nowMs()
        val accessToken = issued.accessToken ?: ""
        // The lifetime, not the absolute expiry, is what the client keeps: the device's clock
        // can be minutes off, and with a 60-second token that would make every token look
        // expired, or keep dead ones in use.
        val lifetime = jwtLifetimeMs(accessToken)
            ?: maxOf(0, (parseInstantMs(issued.accessTokenExpiresAt) ?: now) - now)
        tokens = Tokens(
            accessToken = accessToken,
            sessionId = issued.sessionId,
            expiresAt = now + lifetime,
            refreshAt = now + lifetime - minOf(ACCESS_TOKEN_EXPIRY_SKEW_MS, lifetime / 2),
        )
        backoff = null
        if (!issued.refreshToken.isNullOrEmpty()) {
            refreshToken = issued.refreshToken
            storageRead = true
        }
        return generation
    }

    /**
     * One call of the storage, inside the refresh's deadline. Every failure is the same
     * `storage.failed`: what the storage threw, no answer in time, a storage that cancelled
     * itself. Nothing of what it threw is kept.
     *
     * The call runs in the client's own scope and is waited for, for the deadline at most: a
     * storage that does not end when cancelled (a blocked call of a key store does not) is
     * left behind and what it answers late is dropped. Waited for instead, one stuck call
     * would hold the single refresh, and every caller that joined it, for ever. A call left
     * behind may still land: a write that does is the token the client holds, and a later
     * call of a storage that works one at a time waits its turn inside its own deadline.
     */
    private suspend fun <T> stored(work: suspend () -> T): T {
        val running = scope.async { Answered(work()) }
        val answered = try {
            withTimeoutOrNull(refreshTimeoutMs) { running.await() }
        } catch (cause: CancellationException) {
            running.cancel()
            if (!currentCoroutineContext().isActive) {
                // The caller itself was cancelled: that is not the storage's failure.
                throw cause
            }
            throw clientError(ClientErrorCodes.STORAGE_FAILED, messages())
        } catch (_: Exception) {
            throw clientError(ClientErrorCodes.STORAGE_FAILED, messages())
        }
        if (answered == null) {
            running.cancel()
            throw clientError(ClientErrorCodes.STORAGE_FAILED, messages())
        }
        return answered.value
    }

    private suspend fun persist(issued: SessionTokens): TulaError? {
        val token = issued.refreshToken
        if (token.isNullOrEmpty()) {
            return null
        }
        return try {
            stored { storage.set(storageKey, token) }
            null
        } catch (error: TulaError) {
            error
        }
    }

    private suspend fun storedRefreshToken(): String? {
        if (!storageRead) {
            val value = stored { storage.get(storageKey) }
            // A sign-in may have finished while the store was being read; its token is newer.
            if (!storageRead) {
                // An empty string is no token: only a non-empty one is presented.
                refreshToken = value?.takeIf { it.isNotEmpty() }
                storageRead = true
            }
        }
        return refreshToken
    }

    private suspend fun removeStored() {
        try {
            stored { storage.remove(storageKey) }
        } catch (_: TulaError) {
            // The session is over whatever the store says; a token left behind is refused by
            // the server at the next start.
        }
    }

    private suspend fun askForTokens(body: String, timeoutMs: Long): SessionTokens? {
        val answer = transport.call(
            TulaOperations.refreshSession,
            CallInput(body = body, timeoutMs = timeoutMs),
        )
        return try {
            transport.decode(SessionTokens.serializer(), answer)
        } catch (_: TulaError) {
            null
        }
    }

    private suspend fun exchange(started: Int): Exchange {
        fun now() = Exchange(tokens?.accessToken)
        // The user may have signed out or in while this waited. Whatever is current is the answer.
        if (generation != started) {
            return now()
        }
        val presented = storedRefreshToken()
        if (generation != started) {
            return now()
        }
        if (presented == null) {
            endLocal()
            return Exchange(null)
        }
        val body = encode(RefreshTokenRequest.serializer(), RefreshTokenRequest(refreshToken = presented))
        val sentAt = clock.nowMs()
        val issued: SessionTokens? = try {
            try {
                askForTokens(body, refreshTimeoutMs)
            } catch (error: TulaError) {
                if (!gotNoAnswer(error) || generation != started) {
                    throw error
                }
                // The one automatic repeat (see REFRESH_RETRY_WINDOW_MS): no answer came, so
                // the server may or may not have rotated the token. Presenting the same token
                // again at once is answered with the same next token if it did, and is an
                // ordinary refresh if it did not.
                val left = REFRESH_RETRY_WINDOW_MS - (clock.nowMs() - sentAt)
                askForTokens(body, minOf(refreshTimeoutMs, maxOf(MIN_REFRESH_RETRY_TIMEOUT_MS, left)))
            }
        } catch (error: TulaError) {
            if (generation != started) {
                return now()
            }
            if (error.code == "device.proof_invalid" && proofs != null) {
                // The one `device.*` answer that can end a session, and only when the key
                // store said twice that the key is gone. A key that could not be had is
                // never read as gone.
                val verdict = proofs.verdict(refreshTimeoutMs)
                if (generation != started) {
                    return now()
                }
                when (verdict) {
                    DeviceProofs.Verdict.GONE -> {
                        endForLostKey(presented)
                        return Exchange(null)
                    }
                    DeviceProofs.Verdict.CONTRADICTED ->
                        throw clientError(ClientErrorCodes.DEVICE_KEY_FAILED, messages())
                    DeviceProofs.Verdict.THERE, DeviceProofs.Verdict.UNSURE -> Unit
                }
            }
            if (sessionIsGone(error)) {
                endLocal()
                removeStored()
                return Exchange(null)
            }
            val wait = error.retryAfterMs
            if (wait != null) {
                backoff = Backoff(clock.nowMs() + minOf(wait, MAX_REFRESH_BACKOFF_MS), error)
            }
            throw error
        }
        if (issued == null || !isSessionTokens(issued)) {
            // A 200 that is not session tokens (a wrong base URL, a proxy's page). Nothing is
            // installed or stored, and the session this client has is left alone.
            throw transport.invalid()
        }
        if (generation != started) {
            // Signed out (or signed in as someone else) while the request was in flight. The
            // tokens are not installed; the refresh token is kept only so that sign-out can
            // revoke it.
            if (!issued.refreshToken.isNullOrEmpty()) {
                orphan = issued.refreshToken
            }
            return now()
        }
        val installed = commit(issued)
        return Exchange(issued.accessToken, installed, persist(issued))
    }

    /**
     * The session was bound to a device key that is gone: it is over. Forget it here, then
     * tell the server, which asks no proof for a sign-out. When the server could not be told
     * the token is kept, in memory, for the next [signOut].
     */
    private suspend fun endForLostKey(presented: String) {
        endLocal()
        val mine = generation
        removeStored()
        try {
            // Inside the shared refresh, which every caller of `getToken()` waits on: the
            // server is given the refresh's own deadline to answer and no longer.
            transport.call(
                TulaOperations.signOut,
                CallInput(
                    body = encode(RefreshTokenRequest.serializer(), RefreshTokenRequest(presented)),
                    timeoutMs = refreshTimeoutMs,
                ),
            )
        } catch (error: TulaError) {
            if (generation == mine && !error.code.startsWith("session.")) {
                undelivered = presented
            }
        }
    }

    private suspend fun runRefresh(explicit: Boolean): String? {
        // An explicit `refresh()` is the application (or the user) asking now: it always asks.
        // Only the implicit refreshes wait out a `Retry-After`.
        val waiting = backoff
        if (!explicit && waiting != null && clock.nowMs() < waiting.until) {
            throw waiting.error
        }
        val result = exchange(generation)
        if (result.installed != null) {
            settle(result.installed)
        }
        if (result.failure != null) {
            throw result.failure
        }
        return result.token
    }

    /**
     * The refresh in flight, or a new one. It runs in the client's own scope, so that a caller
     * who stops waiting does not take the refresh away from the others.
     */
    private fun startRefresh(explicit: Boolean): Deferred<String?> {
        refreshing?.let { return it }
        lateinit var run: Deferred<String?>
        run = scope.async(confined, CoroutineStart.LAZY) {
            try {
                runRefresh(explicit)
            } finally {
                if (refreshing === run) {
                    refreshing = null
                }
            }
        }
        refreshing = run
        run.start()
        return run
    }

    /** Wait for a refresh in flight, whatever it ends in. */
    private suspend fun idleNow() {
        try {
            refreshing?.await()
        } catch (_: TulaError) {
            // Its own callers hear of it.
        }
    }

    /** @return A usable access token, or `null` when nobody is signed in. */
    suspend fun getToken(): String? = withContext(confined) {
        if (current.value is AuthState.SignedOut) {
            return@withContext null
        }
        tokens?.let { held ->
            if (clock.nowMs() < held.refreshAt) {
                return@withContext held.accessToken
            }
        }
        try {
            startRefresh(false).await()
        } catch (error: TulaError) {
            // The refresh could not be made (offline, rate limited). A token inside its skew
            // is still valid for a few seconds: better to use it than to fail a request that
            // would work.
            val held = tokens
            if (held != null && clock.nowMs() < held.expiresAt) {
                held.accessToken
            } else {
                throw error
            }
        }
    }

    /** @return A new access token, or `null` when nobody is signed in. */
    suspend fun refresh(): String? = withContext(confined) { startRefresh(true).await() }

    /** @return The state, once it is no longer [AuthState.Loading]. */
    suspend fun load(): AuthState = withContext(confined) {
        if (current.value is AuthState.Loading) {
            startRefresh(false).await()
        }
        current.value
    }

    /** Resolves when no refresh is in flight. */
    suspend fun idle(): Unit = withContext(confined) { idleNow() }

    /**
     * Takes in the session a completed flow returned: in memory, in the storage, in the state.
     *
     * The work runs in the client's own scope, as a sign-out's does: the server has made the
     * session by now, and a caller that is cancelled half-way (the screen that asked is gone)
     * must not leave one that is neither stored nor shown.
     *
     * @param issued Tokens a completed flow returned.
     */
    suspend fun adopt(issued: SessionTokens) {
        scope.async(confined) {
            if (!isSessionTokens(issued)) {
                throw transport.invalid()
            }
            // A new session: an earlier one's sign-out is no longer this client's to retry.
            undelivered = null
            val installed = commit(issued)
            val failure = persist(issued)
            settle(installed)
            if (failure != null) {
                throw failure
            }
        }.await()
    }

    /**
     * Ends the session here and on the server. When the server could not be told it throws,
     * the client is signed out all the same, and calling it again tells the server.
     *
     * The work runs in the client's own scope: a caller that is cancelled half-way does not
     * leave a session the server was never told to end and that nothing remembers.
     */
    suspend fun signOut() {
        scope.async(confined) { endEverywhere() }.await()
    }

    private suspend fun endEverywhere() {
        val pending = refreshing
        val unread = !storageRead
        var presented = refreshToken
        var failure: TulaError? = null
        orphan = null
        // Local state first, so the app is signed out whatever the network does next.
        endLocal()
        val mine = generation
        // A refresh already in flight may be rotating the token right now. Wait for it, then
        // end the session with whatever is newest, so nothing outlives the sign-out. Never
        // without bound: a refresh that has not settled within its own timeout is left to
        // end by itself (its result is of an older generation and is not installed), and the
        // sign-out goes on with the newest token it has.
        if (pending != null) {
            withTimeoutOrNull(refreshTimeoutMs) {
                try {
                    pending.await()
                } catch (_: TulaError) {
                    // Nothing was issued.
                }
            }
        }
        if (unread) {
            try {
                presented = stored { storage.get(storageKey) }?.takeIf { it.isNotEmpty() }
            } catch (error: TulaError) {
                // The token cannot be read, so the server cannot be told: the caller hears
                // of it. The entry is still removed below: an entry that cannot be opened
                // (its tag fails) would otherwise be one no sign-out could clear.
                failure = error
            }
        }
        try {
            // After the refresh has settled, so a token it was storing does not reappear. A
            // sign-in that finished meanwhile has stored its own token; that one stays.
            if (generation == mine) {
                stored { storage.remove(storageKey) }
            }
        } catch (error: TulaError) {
            failure = error
        }
        val newest = orphan ?: presented ?: undelivered
        orphan = null
        if (newest != null) {
            try {
                transport.call(
                    TulaOperations.signOut,
                    CallInput(body = encode(RefreshTokenRequest.serializer(), RefreshTokenRequest(newest))),
                )
                undelivered = null
            } catch (error: TulaError) {
                // The server may still hold the session: the caller must know, even though
                // this client is signed out.
                failure = error
                // The token has just been dropped, so it is held for the retry, unless the
                // API said the session is over or a sign-in finished meanwhile (whose own
                // token the next sign-out presents).
                if (generation == mine) {
                    undelivered = if (error.code.startsWith("session.")) null else newest
                }
            }
        }
        // A device key that can never be had again would fail the next sign-in too: with
        // nobody signed in, what such a store keeps is removed. Any other store is left alone.
        proofs?.dropUnusableKey(refreshTimeoutMs)
        if (failure != null) {
            throw failure
        }
    }

    /**
     * Remove the device key through the client, which then forgets a look for it that is
     * still out.
     *
     * @throws TulaError `device.key_failed` when the store refused, `network.timeout` when
     *   it did not answer.
     */
    suspend fun removeDeviceKey() {
        proofs?.remove(refreshTimeoutMs)
    }

    /**
     * Prove again that it is the user: sends the proof and installs the access token the
     * server answers with, for the same session. The refresh token is not replaced.
     *
     * @param body The step-up request, already written.
     * @throws TulaError what the API refused the proof with; `auth.unauthenticated` when the
     *   client was signed out, or signed in as someone else, while the proof was in flight.
     */
    suspend fun stepUp(body: String): Unit = withContext(confined) {
        // A refresh already in flight would otherwise hand the proof a token about to be replaced.
        idleNow()
        var left = generation
        val answer = transport.decode(
            SessionTokens.serializer(),
            authorized(TulaOperations.stepUpSession, CallInput(body = body)) { left = generation },
        )
        if (!isSessionTokens(answer)) {
            throw transport.invalid()
        }
        if (current.value is AuthState.SignedOut || tokens?.sessionId != answer.sessionId) {
            throw unauthenticated()
        }
        if (generation == left && refreshing == null) {
            // Only the access token: the session's refresh token is the one it had.
            settle(commit(SessionTokens(answer.sessionId, answer.accessToken, answer.accessTokenExpiresAt)))
            return@withContext
        }
        // The session was refreshed meanwhile: its newest token is asked for, which carries
        // what was just proven.
        idleNow()
        if (tokens?.sessionId != answer.sessionId || startRefresh(true).await() == null) {
            throw unauthenticated()
        }
    }

    /**
     * Make an organization the one the session acts in (`PUT /v1/client/me/organizations/active`)
     * and take the access token that carries it.
     *
     * As [stepUp] does, it installs only the access token of the answer: choosing does not
     * rotate the refresh token, and one a misbehaving server put in the answer is ignored.
     * When the session's token was replaced while the call was on its way, or a refresh is
     * running, the answer's token is not installed (it is a result for an older generation):
     * one refresh, started after the choice was accepted, carries it.
     *
     * @param organizationId The organization, or `null` for the personal account.
     * @return The answer: the session's id and the organization it acts in now.
     * @throws TulaError what the API refused with; `response.invalid` for an answer that is
     *   not the choice that was asked for; `auth.unauthenticated` when the client was signed
     *   out, or signed in as someone else, while the call was in flight.
     */
    suspend fun setActiveOrganization(organizationId: String?): ActiveOrganization = withContext(confined) {
        // A refresh already in flight would otherwise hand the choice a token about to be replaced.
        idleNow()
        var left = generation
        val answer = transport.decode(
            ActiveOrganization.serializer(),
            authorized(
                TulaOperations.setActiveOrganization,
                CallInput(body = encode(SetActiveOrganizationRequest.serializer(), SetActiveOrganizationRequest(organizationId))),
            ) { left = generation },
        )
        val issued = SessionTokens(answer.sessionId, answer.accessToken, answer.accessTokenExpiresAt)
        // A 200 is not proof of talking to the API: the answer must name the choice and carry
        // a token this client can install (a stateful session's answer has none, and is not a
        // session for this client).
        if (!isSessionTokens(issued) || answer.organizationId != organizationId || organizationId?.isEmpty() == true) {
            throw transport.invalid()
        }
        // Signed out, or signed in as someone else, while the call was in flight: the answer
        // is about a session this client no longer has.
        if (current.value is AuthState.SignedOut || tokens?.sessionId != answer.sessionId) {
            throw unauthenticated()
        }
        if (generation == left && refreshing == null) {
            settle(commit(issued))
            return@withContext answer
        }
        idleNow()
        if (tokens?.sessionId != answer.sessionId || startRefresh(true).await() == null) {
            throw unauthenticated()
        }
        answer
    }

    private fun unauthenticated(): TulaError = TulaError(
        code = "auth.unauthenticated",
        message = formatMessage("auth.unauthenticated", messages()),
        status = 401,
    )

    /**
     * Calls an operation that needs the user's access token, refreshing once if the API
     * refuses the token.
     */
    suspend fun authorized(
        operation: TulaOperation,
        input: CallInput = CallInput(),
        /** Called on the client's dispatcher just before each request is sent. */
        sending: () -> Unit = {},
    ): JsonElement? =
        withContext(confined) {
            val accessToken = getToken() ?: throw unauthenticated()
            try {
                sending()
                transport.call(operation, input.with(accessToken))
            } catch (error: TulaError) {
                if (!tokenWasRefused(error)) {
                    throw error
                }
                // The API refused a token this client thought was good (it expired on the way,
                // or the session was revoked). One refresh, one retry; a second refusal goes
                // to the caller. Unless the client was signed out while the call was in
                // flight: then the refusal is simply true.
                if (current.value is AuthState.SignedOut) {
                    throw error
                }
                val replaced = tokens?.accessToken?.takeIf { it != accessToken }
                val next = replaced ?: startRefresh(true).await() ?: throw error
                sending()
                transport.call(operation, input.with(next))
            }
        }

    /**
     * Fetches the signed-in user and shows the answer in the state, when the session it was
     * asked under is still the current one.
     *
     * A result belongs to the session it was asked for: an answer that arrives after a
     * sign-out and another user's sign-in is returned to its caller and shown nowhere.
     */
    suspend fun fetchUser(): CurrentUser = userFrom(TulaOperations.getMe)

    /**
     * Makes an authorized call whose answer is the signed-in user, and shows that answer in
     * the state under [fetchUser]'s rule (the one place a user reaches the state after a
     * sign-in).
     *
     * @param operation A client operation that answers `CurrentUser`.
     * @param input Its body.
     * @return The user the server answered.
     */
    suspend fun userFrom(operation: TulaOperation, input: CallInput = CallInput()): CurrentUser = withContext(confined) {
        // A token first, so that a client still loading has its session before it is named.
        getToken() ?: throw unauthenticated()
        val asked = (current.value as? AuthState.SignedIn)?.sessionId
        val user = transport.decode(CurrentUser.serializer(), authorized(operation, input))
        val now = current.value
        if (now is AuthState.SignedIn && now.sessionId == asked) {
            setState(now.copy(user = user))
        }
        user
    }

    /**
     * Makes an authorized call that changes the signed-in user and answers nothing, and shows
     * the change in the state under [fetchUser]'s rule: only while the session it was asked
     * under is still the current one, and only where the state holds a user.
     *
     * @param operation A client operation that answers no body.
     * @param input Its parameters.
     * @param change What the call did to the user.
     */
    suspend fun changeUser(
        operation: TulaOperation,
        input: CallInput = CallInput(),
        change: (CurrentUser) -> CurrentUser,
    ): Unit = withContext(confined) {
        getToken() ?: throw unauthenticated()
        val asked = (current.value as? AuthState.SignedIn)?.sessionId
        authorized(operation, input)
        val now = current.value
        val user = (now as? AuthState.SignedIn)?.user
        if (now is AuthState.SignedIn && now.sessionId == asked && user != null) {
            setState(now.copy(user = change(user)))
        }
    }

    private fun CallInput.with(accessToken: String): CallInput =
        CallInput(params, body, accessToken, attemptSecret, timeoutMs)
}
