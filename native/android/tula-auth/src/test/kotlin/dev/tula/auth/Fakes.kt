package dev.tula.auth

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import java.util.Base64
import java.util.concurrent.CopyOnWriteArrayList

/** A publishable key of the right shape that opens nothing. */
const val TEST_KEY = "tula_pk_dev_unit0000000000000000000000000000"

/** Where the unit tests' client thinks the API is. Nothing listens there. */
const val TEST_BASE = "https://auth.example.test"

/** The entry the client keeps its refresh token under, for [TEST_BASE] and [TEST_KEY]. */
val TEST_STORAGE_KEY: String = TulaClient.storageKey(TEST_BASE, TEST_KEY)

/** A clock only the test moves. */
class FakeClock(@Volatile var now: Long = 1_760_000_000_000) : Clock {
    override fun nowMs(): Long = now

    fun advance(ms: Long) {
        now += ms
    }
}

/**
 * Run a test's body, and fail it rather than hang the build when something never returns.
 * The limit is a ceiling for a stuck test, not a wait: nothing in the suite sleeps towards it.
 */
fun runTest(limitMs: Long = 30_000, block: suspend CoroutineScope.() -> Unit) {
    runBlocking { withTimeout(limitMs) { block() } }
}

/** The [TulaError] a call throws; an `AssertionError` when it throws nothing. */
suspend fun caught(block: suspend () -> Any?): TulaError {
    try {
        block()
    } catch (error: TulaError) {
        return error
    }
    throw AssertionError("expected the call to throw a TulaError")
}

private fun base64Url(text: String): String =
    Base64.getUrlEncoder().withoutPadding().encodeToString(text.toByteArray(Charsets.UTF_8))

/** An unsigned token of a JWT's shape that lives [lifetimeSeconds]; [label] makes it distinct. */
fun fakeJwt(label: String, lifetimeSeconds: Long = 60, issuedAt: Long = 1_760_000_000): String =
    base64Url("""{"alg":"none"}""") + "." +
        base64Url("""{"iat":$issuedAt,"exp":${issuedAt + lifetimeSeconds},"jti":"$label"}""") +
        ".signature-$label"

/** The body of session tokens as the API writes them. */
fun tokensJson(
    label: String,
    sessionId: String = "session-1",
    refreshToken: String? = "tula_rt_$label",
    lifetimeSeconds: Long = 60,
): String {
    val refresh = if (refreshToken == null) "" else ""","refreshToken":"$refreshToken""""
    return """{"sessionId":"$sessionId","accessToken":"${fakeJwt(label, lifetimeSeconds)}",""" +
        """"accessTokenExpiresAt":"2026-01-01T00:01:00.000Z"$refresh}"""
}

/** The body of the signed-in user as the API writes it. */
fun userJson(email: String = "maya@example.com"): String =
    """{"id":"user-1","email":"$email","emailVerifiedAt":"2026-01-01T00:00:00.000Z",""" +
        """"firstName":"Maya","lastName":null,"bannedAt":null,"lastSignInAt":null,""" +
        """"createdAt":"2026-01-01T00:00:00.000Z","hasPassword":true}"""

/** The step of a finished flow. */
const val COMPLETE = """{"status":"complete","userId":"user-1","sessionId":"session-1"}"""

/** The step that waits on the password. */
const val NEEDS_PASSWORD = """{"status":"needs_password"}"""

/** The body of an attempt as the API writes it. */
fun attemptJson(
    step: String,
    kind: String = "sign_in",
    id: String = "attempt-1",
    secret: String? = "tula_at_secret-of-$id",
    session: String? = null,
): String {
    val secretPart = if (secret == null) "" else ""","attemptSecret":"$secret""""
    val sessionPart = if (session == null) "" else ""","session":$session"""
    return """{"id":"$id","kind":"$kind","expiresAt":"2026-01-01T00:10:00.000Z",""" +
        """"step":$step$secretPart$sessionPart}"""
}

/** An error in the API's envelope. */
fun errorJson(code: String, status: Int, extra: String = ""): String =
    """{"status":$status,"code":"$code","detail":"the server's own words"$extra}"""

fun ok(body: String, headers: Map<String, String> = emptyMap()): HttpResponse =
    HttpResponse(200, headers, body)

fun answer(status: Int, body: String, headers: Map<String, String> = emptyMap()): HttpResponse =
    HttpResponse(status, headers, body)

/**
 * An [HttpEngine] a unit test scripts: every request is recorded, and answered by the handler
 * for its method and path. A request nobody expects fails the test's call with an error that
 * is not a [TulaError]'s cause by accident: it says which request it was.
 */
class ScriptedEngine : HttpEngine {
    /** Every request that was sent, oldest first. */
    val requests = CopyOnWriteArrayList<HttpRequest>()
    private val handlers = HashMap<String, suspend (HttpRequest) -> HttpResponse>()

    /** Answer `method path` (the path as the API has it, from `/v1`) with [handler]. */
    fun on(method: String, path: String, handler: suspend (HttpRequest) -> HttpResponse) {
        synchronized(handlers) { handlers["$method $path"] = handler }
    }

    fun paths(): List<String> = requests.map { it.url.removePrefix(TEST_BASE) }

    fun sent(path: String): List<HttpRequest> = requests.filter { it.url == TEST_BASE + path }

    override suspend fun send(request: HttpRequest): HttpResponse {
        requests.add(request)
        val name = "${request.method} ${request.url.removePrefix(TEST_BASE)}"
        val handler = synchronized(handlers) { handlers[name] }
            ?: throw AssertionError("no answer was scripted for $name")
        return handler(request)
    }
}

/** A [TokenStorage] whose reads, writes and removals a test can make fail. */
class FlakyStorage : TokenStorage {
    val values = HashMap<String, String>()

    @Volatile
    var failReads = false

    @Volatile
    var failWrites = false

    @Volatile
    var failRemovals = false

    override suspend fun get(key: String): String? {
        if (failReads) {
            throw IllegalStateException("the store could not be read: canary-store-text")
        }
        return synchronized(values) { values[key] }
    }

    override suspend fun set(key: String, value: String) {
        if (failWrites) {
            throw IllegalStateException("the store could not be written: canary-store-text")
        }
        synchronized(values) { values[key] = value }
    }

    override suspend fun remove(key: String) {
        if (failRemovals) {
            throw IllegalStateException("the store could not be changed: canary-store-text")
        }
        synchronized(values) { values.remove(key) }
    }
}

/** A client over a scripted engine, with everything a unit test looks at. */
class Bench(
    val engine: ScriptedEngine = ScriptedEngine(),
    val storage: TokenStorage = MemoryTokenStorage(),
    val clock: FakeClock = FakeClock(),
    timeoutMs: Long = DEFAULT_TIMEOUT_MS,
    sessionProfile: String? = null,
    messages: Messages = emptyMap(),
) {
    val tula = TulaClient(
        publishableKey = TEST_KEY,
        baseUrl = TEST_BASE,
        storage = storage,
        http = engine,
        clock = clock,
        timeoutMs = timeoutMs,
        messages = messages,
        sessionProfile = sessionProfile,
    )

    /** Script the two calls a sign-in makes, and sign in: tokens `first`, the user's profile. */
    suspend fun signIn(label: String = "first"): SignInFlow {
        engine.on("POST", "/v1/client/sign-ins") { ok(attemptJson(NEEDS_PASSWORD)) }
        engine.on("POST", "/v1/client/sign-ins/attempt-1/password") {
            ok(attemptJson(COMPLETE, session = tokensJson(label)))
        }
        engine.on("GET", "/v1/client/me") { ok(userJson()) }
        val flow = tula.signIn("maya@example.com")
        flow.submitPassword("a-password-nobody-uses")
        return flow
    }
}
