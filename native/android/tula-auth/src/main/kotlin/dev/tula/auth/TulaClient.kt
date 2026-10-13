package dev.tula.auth

import dev.tula.auth.generated.ChangePasswordRequest
import dev.tula.auth.generated.ClientConfig
import dev.tula.auth.generated.CurrentUser
import dev.tula.auth.generated.IdTokenProvider
import dev.tula.auth.generated.IdTokenStart
import dev.tula.auth.generated.IdTokenStartRequest
import dev.tula.auth.generated.OAuthProvider
import dev.tula.auth.generated.PasskeySignInRequest
import dev.tula.auth.generated.PasskeySignInStart
import dev.tula.auth.generated.PasswordResetStartRequest
import dev.tula.auth.generated.SignInStartRequest
import dev.tula.auth.generated.SignUpRequest
import dev.tula.auth.generated.TulaOperations
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.withContext
import java.net.URI
import java.net.URISyntaxException

/** How long one request may take before it fails with `network.timeout`, by default. */
const val DEFAULT_TIMEOUT_MS: Long = 15_000

private const val PUBLISHABLE_KEY_PREFIX = "tula_pk_"
private const val SECRET_KEY_PREFIX = "tula_sk_"
private val SESSION_PROFILE_NAME = Regex("^[a-z0-9]+(-[a-z0-9]+)*$")
private const val MAX_SESSION_PROFILE_LENGTH = 32

/**
 * The Tula Auth client for Android and the JVM: flows, the session and its refresh. It has no
 * UI and no Android dependency.
 *
 * ```kotlin
 * val tula = TulaClient(
 *     publishableKey = "tula_pk_…",
 *     baseUrl = "https://auth.example.com",
 *     storage = KeystoreTokenStorage(context),
 * )
 * tula.load()                                   // signed in from a stored session, or not
 * val flow = tula.signIn(identifier = email)
 * flow.submitPassword(password)                 // tula.state.value is AuthState.SignedIn
 * val token = tula.session.getToken()           // for the app's own backend
 * ```
 *
 * One client per API and environment for the life of the process: two clients over one storage
 * would each refresh the same token.
 *
 * @param publishableKey The environment's publishable key (`tula_pk_…`). Never a secret key.
 * @param baseUrl The API's address, `https://…`; plain `http` is for a development server.
 * @param storage Where the refresh token is kept. There is no default on purpose: on a device
 *   it is `KeystoreTokenStorage`, and [MemoryTokenStorage] is a decision to forget the session
 *   when the process ends.
 * @param http How requests are sent.
 * @param clock The time.
 * @param timeoutMs How long one request may take. A refresh is given at most
 *   [REFRESH_TIMEOUT_MS], whatever this says.
 * @param messages The app's messages by error code; codes it lacks use English.
 * @param sessionProfile The session profile to ask for, where the environment lets a client
 *   choose one.
 * @param passkeys The system's passkey sheet. `null` (the default) means this client has no
 *   passkey call that works: each answers `passkey.unsupported` before any request.
 * @param google Google's own sheet. `null` means [signInWithGoogle] answers
 *   `provider.unsupported` before any request.
 * @param browser The browser a provider sign-in is shown in. `null` means [signIn] with a
 *   provider answers `provider.unsupported` before any request.
 * @param deviceKeys Where the device's key is kept. `null` means no session of this client is
 *   bound to a key and no request carries a proof. With one, the six calls that start an
 *   attempt and every refresh carry a proof.
 * @throws IllegalArgumentException for options that can never work. Its message never repeats
 *   a value it was given.
 */
class TulaClient internal constructor(
    publishableKey: String,
    baseUrl: String,
    storage: TokenStorage,
    http: HttpEngine,
    clock: Clock,
    timeoutMs: Long,
    messages: Messages,
    sessionProfile: String?,
    passkeys: PasskeySheet?,
    google: GoogleSheet?,
    browser: BrowserSession?,
    deviceKeys: DeviceKeyStore?,
    sheetCeilingMs: Long,
) : AutoCloseable {
    constructor(
        publishableKey: String,
        baseUrl: String,
        storage: TokenStorage,
        http: HttpEngine = UrlConnectionEngine(),
        clock: Clock = Clock { System.currentTimeMillis() },
        timeoutMs: Long = DEFAULT_TIMEOUT_MS,
        messages: Messages = emptyMap(),
        sessionProfile: String? = null,
        passkeys: PasskeySheet? = null,
        google: GoogleSheet? = null,
        browser: BrowserSession? = null,
        deviceKeys: DeviceKeyStore? = null,
    ) : this(
        publishableKey, baseUrl, storage, http, clock, timeoutMs, messages, sessionProfile,
        passkeys, google, browser, deviceKeys, SHEET_CEILING_MS,
    )

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    /** One piece of the client's work at a time: see [SessionManager]. */
    private val confined = Dispatchers.Default.limitedParallelism(1)
    private val table: Messages = HashMap(messages)
    private val transport: Transport
    private val manager: SessionManager
    private val flows: FlowContext
    private val roundTrip = ProviderRoundTrip()

    @Volatile
    private var configuration: ClientConfig? = null

    init {
        require(publishableKey.startsWith(PUBLISHABLE_KEY_PREFIX)) {
            if (publishableKey.startsWith(SECRET_KEY_PREFIX)) {
                "TulaClient: this is a secret key. Never put one in an app; use the publishable key"
            } else {
                "TulaClient: `publishableKey` must be a publishable key (tula_pk_…)"
            }
        }
        val base = normalizeBaseUrl(baseUrl)
        require(timeoutMs > 0) { "TulaClient: `timeoutMs` must be a positive number" }
        require(
            sessionProfile == null ||
                (sessionProfile.length <= MAX_SESSION_PROFILE_LENGTH &&
                    SESSION_PROFILE_NAME.matches(sessionProfile)),
        ) {
            "TulaClient: `sessionProfile` must be a profile name: lowercase letters, digits " +
                "and single hyphens, at most 32 characters"
        }
        require(sheetCeilingMs > 0) { "TulaClient: the sheet ceiling must be a positive number" }
        val proofs = deviceKeys?.let { DeviceProofs(it, scope) { table } }
        val gate = CeremonyGate(scope, sheetCeilingMs) { table }
        transport = Transport(
            baseUrl = base,
            publishableKey = publishableKey,
            http = http,
            timeoutMs = timeoutMs,
            clock = clock,
            messages = { table },
            sessionProfile = sessionProfile,
            scope = scope,
            proofs = proofs,
        )
        manager = SessionManager(
            transport = transport,
            storage = storage,
            clock = clock,
            scope = scope,
            confined = confined,
            refreshTimeoutMs = minOf(timeoutMs, REFRESH_TIMEOUT_MS),
            // One entry per API and environment, so two environments do not share a session.
            storageKey = storageKeyFor(base, publishableKey),
            messages = { table },
            proofs = proofs,
            // What a provider round trip kept belongs to whoever was signed in.
            onEnd = { roundTrip.forget() },
        )
        flows = FlowContext(
            transport = transport,
            session = manager,
            confined = confined,
            messages = { table },
            scope = scope,
            clock = clock,
            gate = gate,
            roundTrip = roundTrip,
            passkeys = passkeys,
            google = google,
            browser = browser,
        )
    }

    /** Who is signed in, and every change of it. Starts as [AuthState.Loading]. */
    val state: StateFlow<AuthState> get() = manager.state

    /** The session: its access token, refresh and sign-out. */
    val session: TulaSession = TulaSession(manager)

    /**
     * Find out whether a session was kept from an earlier run: reads the stored refresh token
     * and, if there is one, refreshes. Call it once when the app starts.
     *
     * @return The state, no longer [AuthState.Loading].
     * @throws TulaError `storage.failed`, `network.failed`, `network.timeout` and the like
     *   when it could not be found out. The state stays [AuthState.Loading]: nothing said the
     *   session is over, so ask again.
     */
    suspend fun load(): AuthState = manager.load()

    /**
     * Start a sign-up.
     *
     * @param email The address.
     * @param password The password; leave it out where the environment's sign-ups need none.
     * @param firstName The user's given name.
     * @param lastName The user's family name.
     * @return The flow, waiting on the emailed code.
     * @throws TulaError a `password.*` code with per-field [TulaError.errors] for a password
     *   the policy refuses, `validation.failed`, `rate_limited`.
     */
    suspend fun signUp(
        email: String,
        password: String? = null,
        firstName: String? = null,
        lastName: String? = null,
    ): SignUpFlow = withContext(confined) {
        val started = transport.attempt(
            transport.call(
                TulaOperations.startSignUp,
                CallInput(
                    body = encode(
                        SignUpRequest.serializer(),
                        SignUpRequest(email, password, firstName, lastName),
                    ),
                ),
            ),
        )
        SignUpFlow(flows, started).also { it.accept(started) }
    }

    /**
     * Start a sign-in. The answer does not depend on whether the identifier has an account.
     *
     * @param identifier The email address, or a phone number in E.164 form where the
     *   environment offers a texted code.
     * @return The flow, waiting on a first factor.
     */
    suspend fun signIn(identifier: String): SignInFlow = withContext(confined) {
        val started = transport.attempt(
            transport.call(
                TulaOperations.startSignIn,
                CallInput(body = encode(SignInStartRequest.serializer(), SignInStartRequest(identifier))),
            ),
        )
        SignInFlow(flows, started).also { it.accept(started) }
    }

    /**
     * Start a password reset: a code is emailed if the address has an account, and the answer
     * is the same if it has none.
     *
     * @param email The account's address.
     * @return The flow, waiting on the code and the new password.
     */
    suspend fun resetPassword(email: String): PasswordResetFlow = withContext(confined) {
        val started = transport.attempt(
            transport.call(
                TulaOperations.startPasswordReset,
                CallInput(
                    body = encode(PasswordResetStartRequest.serializer(), PasswordResetStartRequest(email)),
                ),
            ),
        )
        PasswordResetFlow(flows, started).also { it.accept(started) }
    }

    /**
     * Sign in with a passkey: asks the API for the options, shows the passkey sheet and
     * proves what it returns. An attempt of its own, with no identifier; it never stops at a
     * second factor.
     *
     * @return The flow, `complete` (or waiting on what the server still asks for), or
     *   [TulaCeremony.Dismissed] when the user closed the sheet: nothing was sent to be
     *   judged and nobody is signed in.
     * @throws TulaError `passkey.unsupported` without a sheet and `flow.busy` while another
     *   sheet of the client is out, both before any request; `passkey.failed`;
     *   `auth.invalid_credentials` for every assertion the API refuses.
     */
    suspend fun signInWithPasskey(): TulaCeremony<SignInFlow> = flows.gate.ceremony {
        flows.requirePasskeys()
        val started = transport.decode(
            PasskeySignInStart.serializer(),
            transport.call(TulaOperations.startPasskeySignIn),
        )
        val flow = withContext(confined) { flows.begin(started.attempt) }
        val credential = try {
            flows.assertion(started.options)
        } catch (error: TulaError) {
            flow.discard()
            throw error
        }
        if (credential == null) {
            flow.discard()
            return@ceremony TulaCeremony.Dismissed
        }
        flow.step(
            TulaOperations.submitSignInPasskey,
            encode(PasskeySignInRequest.serializer(), PasskeySignInRequest(credential)),
        )
        TulaCeremony.Finished(flow)
    }

    /**
     * Start a sign-in with a provider's ID token (ADR 0045), for an app that shows the
     * provider's sheet itself. [signInWithGoogle] does both steps with the client's sheet.
     *
     * @param provider The provider. An Android client is taken for Google only: Apple on
     *   Android signs in through the browser ([signIn] with a provider).
     * @return The nonce the token must carry, and the one exchange.
     * @throws TulaError `auth.method_disabled`, `rate_limited`.
     */
    suspend fun startIdTokenSignIn(provider: IdTokenProvider = IdTokenProvider.Google): IdTokenSignIn =
        withContext(confined) {
            val started = transport.decode(
                IdTokenStart.serializer(),
                transport.call(
                    TulaOperations.startIdTokenSignIn,
                    CallInput(body = encode(IdTokenStartRequest.serializer(), IdTokenStartRequest(provider))),
                ),
            )
            if (started.nonce.isEmpty()) {
                throw transport.invalid()
            }
            IdTokenSignIn(started.nonce, flows.begin(started.attempt))
        }

    /**
     * Sign in with Google's own sheet: starts the attempt, hands the sheet the server's nonce
     * as it is, and exchanges the ID token it returns. The token is kept nowhere.
     *
     * @return The flow, `complete` or waiting on a second factor; or
     *   [TulaCeremony.Dismissed] when the user closed the sheet: no exchange was made.
     * @throws TulaError `provider.unsupported` without a sheet and `flow.busy` while another
     *   sheet of the client is out, both before any request; `provider.failed`;
     *   `auth.invalid_credentials` for a token the API refuses.
     */
    suspend fun signInWithGoogle(): TulaCeremony<SignInFlow> {
        val sheet = flows.google ?: throw flows.error(ClientErrorCodes.PROVIDER_UNSUPPORTED)
        return flows.gate.ceremony {
            val started = startIdTokenSignIn(IdTokenProvider.Google)
            val token = try {
                flows.gate.sheet(CeremonyGate.Kind.PROVIDER) { sheet.idToken(started.nonce) }
            } catch (error: TulaError) {
                started.discard()
                throw error
            }
            if (token == null) {
                started.discard()
                return@ceremony TulaCeremony.Dismissed
            }
            if (token.isEmpty()) {
                started.discard()
                throw flows.error(ClientErrorCodes.PROVIDER_FAILED)
            }
            TulaCeremony.Finished(started.exchange(token))
        }
    }

    /**
     * Sign in with a provider through the browser: starts the attempt, opens the provider's
     * page, and exchanges the ticket the API sends the browser back with.
     *
     * What the browser returns is read only when it is [redirectUrl], character for
     * character, followed by `#`. The binding the start was given is kept in memory and
     * nowhere else.
     *
     * @param provider The provider.
     * @param redirectUrl Where the API sends the browser back to: an app link, or a custom
     *   scheme of the app for a provider that binds its code with PKCE. One of the
     *   environment's allowed redirect URLs; the server judges it, never the client.
     * @return What became of it. A closed browser is [ProviderOutcome.Cancelled].
     * @throws TulaError `provider.unsupported` without a browser and `flow.busy` while
     *   another sheet of the client is out, both before any request;
     *   `request.redirect_not_allowed`, `auth.method_disabled` as the API answered them;
     *   `network.failed`, `network.timeout`, `rate_limited` for an exchange that got no
     *   answer: the ticket is kept for a minute and [retryProviderSignIn] presents it again.
     */
    suspend fun signIn(provider: OAuthProvider, redirectUrl: String): ProviderOutcome =
        flows.providerRoundTrip(ProviderRoundTrip.Intent.SIGN_IN, provider, redirectUrl)

    /**
     * Present again the ticket of a round trip whose exchange got no answer.
     *
     * @return What became of it; refused with [ProviderRefusal.NoAnswer] when nothing is held.
     */
    suspend fun retryProviderSignIn(): ProviderOutcome = flows.gate.ceremony { flows.exchangeTicket() }

    /** Forget what a provider round trip kept: its binding and a ticket waiting for a retry. */
    fun discardProviderSignIn() {
        roundTrip.forget()
    }

    /**
     * Prove again that it is the user, for a call that answered `auth.step_up_required`.
     */
    val stepUp: TulaStepUp get() = TulaStepUp(flows)

    /** The signed-in user's second factor. */
    val factors: TulaFactors get() = TulaFactors(flows)

    /** The signed-in user's passkeys. */
    val passkeys: TulaPasskeys get() = TulaPasskeys(flows)

    /** The provider accounts the signed-in user signs in with. */
    val identities: TulaIdentities get() = TulaIdentities(flows)

    /**
     * Change the signed-in user's password. The user's other sessions end.
     *
     * @throws TulaError `auth.invalid_credentials` for a wrong current password, a
     *   `password.*` code for one the policy refuses, `auth.step_up_required` for a user
     *   with a second factor who has not proven it lately.
     */
    suspend fun changePassword(currentPassword: String, newPassword: String) {
        manager.authorized(
            TulaOperations.changeMyPassword,
            CallInput(
                body = encode(
                    ChangePasswordRequest.serializer(),
                    ChangePasswordRequest(currentPassword, newPassword),
                ),
            ),
        )
    }

    /**
     * Remove the device's key from the key store the client was given. A session bound to it
     * cannot be refreshed afterwards: sign out first.
     *
     * @throws TulaError `device.key_failed` when the store refused, did not answer in time or
     *   there is none.
     */
    suspend fun removeDeviceKey(): Unit = manager.removeDeviceKey()

    /**
     * Fetch the signed-in user, and put the answer in [state] when the session it was asked
     * under is still the current one.
     *
     * @throws TulaError `auth.unauthenticated` when nobody is signed in.
     */
    suspend fun user(): CurrentUser = manager.fetchUser()

    /**
     * The environment's public configuration: the app's name, the enabled sign-in methods and
     * the password policy. Fetched once and kept.
     *
     * @param force Ignore the kept answer and ask again.
     */
    suspend fun config(force: Boolean = false): ClientConfig {
        configuration?.takeUnless { force }?.let { return it }
        val fetched = transport.decode(
            ClientConfig.serializer(),
            transport.call(TulaOperations.getClientConfig),
        )
        configuration = fetched
        return fetched
    }

    /**
     * Stop the client's own work (a refresh in flight). The session is neither ended nor
     * forgotten: a new client over the same storage finds it. For tests and for a process that
     * builds more than one client.
     */
    override fun close() {
        scope.cancel()
    }

    companion object {
        /**
         * The name the client stores its refresh token under: one per API and environment.
         *
         * @param baseUrl The API's address, as the client was given it.
         * @param publishableKey The environment's publishable key.
         */
        fun storageKey(baseUrl: String, publishableKey: String): String =
            storageKeyFor(normalizeBaseUrl(baseUrl), publishableKey)
    }
}

private fun storageKeyFor(base: String, publishableKey: String): String =
    "tula.refresh.$base|$publishableKey"

/** The origin and path of the API's address, without a trailing slash. */
internal fun normalizeBaseUrl(baseUrl: String): String {
    val uri = try {
        URI(baseUrl)
    } catch (_: URISyntaxException) {
        throw IllegalArgumentException("TulaClient: `baseUrl` must be an absolute URL")
    }
    val scheme = uri.scheme?.lowercase()
    require(scheme == "https" || scheme == "http") { "TulaClient: `baseUrl` must be an http(s) URL" }
    val host = uri.host
    require(!host.isNullOrEmpty()) { "TulaClient: `baseUrl` must be an absolute URL" }
    // What a request could not be sent with, or would send to nobody's benefit.
    require(uri.rawUserInfo == null && uri.rawQuery == null && uri.rawFragment == null) {
        "TulaClient: `baseUrl` is an address and a path, with no user name, query or fragment"
    }
    val port = if (uri.port == -1) "" else ":${uri.port}"
    val path = (uri.rawPath ?: "").trimEnd('/')
    return "$scheme://${host.lowercase()}$port$path"
}

/**
 * The session of a [TulaClient].
 *
 * ```kotlin
 * val token = tula.session.getToken() ?: return showSignIn()
 * api.get("/orders", bearer = token)
 * ```
 */
class TulaSession internal constructor(private val manager: SessionManager) {
    /**
     * A usable access token: the one in memory while it is fresh, a new one otherwise. Calls
     * made at the same moment share one refresh.
     *
     * @return The token, or `null` when nobody is signed in.
     * @throws TulaError when a refresh was needed and could not be made (`network.failed`,
     *   `network.timeout`, `rate_limited`, `storage.failed`, …). The session is kept: only the
     *   API saying the session is over ends it, and that answers `null`.
     */
    suspend fun getToken(): String? = manager.getToken()

    /**
     * Refresh now, whatever the token in memory says.
     *
     * @return The new access token, or `null` when nobody is signed in.
     * @throws TulaError as [getToken]; `storage.failed` when the refresh worked and the new
     *   refresh token could not be saved (the session goes on in memory).
     */
    suspend fun refresh(): String? = manager.refresh()

    /**
     * Sign out: here first, then on the server.
     *
     * **A failed sign-out is not a sign-out.** When the server could not be told (or the
     * stored token could not be removed) this throws: the client is signed out, the session
     * may still be alive on the server, and calling it again tells the server. Navigate away
     * only after a call that returned.
     *
     * @throws TulaError `network.failed`, `network.timeout`, `storage.failed` or what the API
     *   answered.
     */
    suspend fun signOut(): Unit = manager.signOut()
}
