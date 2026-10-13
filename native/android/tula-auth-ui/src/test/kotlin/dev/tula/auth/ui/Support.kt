package dev.tula.auth.ui

import dev.tula.auth.Clock
import dev.tula.auth.HttpEngine
import dev.tula.auth.HttpRequest
import dev.tula.auth.HttpResponse
import dev.tula.auth.MemoryTokenStorage
import dev.tula.auth.TokenStorage
import dev.tula.auth.TulaClient
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import java.util.Base64
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger

// The model is tested on the real client, over an engine that is a table of answers: what a
// screen would show is asserted without anything being drawn (ADR 0058).

const val TEST_KEY = "tula_pk_dev_unit0000000000000000000000000000"
const val TEST_BASE = "https://auth.example.test"

const val SIGN_INS = "/v1/client/sign-ins"
const val SIGN_IN = "$SIGN_INS/attempt-1"
const val SIGN_UPS = "/v1/client/sign-ups"
const val SIGN_UP = "$SIGN_UPS/attempt-1"
const val RESETS = "/v1/client/password-resets"
const val RESET = "$RESETS/attempt-1"
const val CONFIG = "/v1/client/config"

const val MASKED = "m***@example.com"
const val ADDRESS = "maya@example.com"

/** What a server writes as an error's `detail`: must never be drawn or said. */
const val SERVER_WORDS = "the server's own words"

const val COMPLETE = """{"status":"complete","userId":"user-1","sessionId":"session-1"}"""
const val NEEDS_PASSWORD = """{"status":"needs_password"}"""
const val VERIFICATION = """{"status":"needs_email_verification","destination":"$MASKED","strategies":["email_code"]}"""
const val RESET_STEP = """{"status":"needs_new_password","destination":"$MASKED","strategies":["email_code"]}"""
const val EXPIRED = """{"status":"needs_new_password","destination":"$MASKED","strategies":["email_code"],"reason":"expired"}"""
const val SECOND_FACTOR = """{"status":"needs_second_factor","options":["totp"]}"""

/** A first-factor step that offers [strategies], prepared for an emailed code or not. */
fun firstFactor(vararg strategies: String, prepared: Boolean = false): String {
    val list = strategies.joinToString(",") { "\"$it\"" }
    val sent = if (prepared) ""","prepared":{"strategy":"email_code","destination":"$MASKED"}""" else ""
    return """{"status":"needs_first_factor","strategies":[$list]$sent}"""
}

fun configJson(name: String = "Tula", password: String = "required"): String =
    """{"app":{"name":"$name","supportEmail":null},"signIn":{"methods":["password"],"oauth":[]},""" +
        """"signUp":{"password":"$password"},"password":{"preset":"recommended","minLength":10,""" +
        """"maxLength":128,"requireLowercase":false,"requireUppercase":false,"requireNumber":false,""" +
        """"requireSpecial":false,"minCharacterClasses":0,"specialChars":"!","disallowUserInfo":true,""" +
        """"disallowCommon":true,"breachCheck":"block","maxRepeatedChars":null,"blockSequences":false,""" +
        """"history":0,"expiryDays":null},"mfa":{"policy":"optional","smsCode":false},"phone":{"enabled":false}}"""

/** Fail a test rather than hang the build when something never returns. */
fun runTest(limitMs: Long = 30_000, block: suspend CoroutineScope.() -> Unit) {
    runBlocking { withTimeout(limitMs) { block() } }
}

private fun base64Url(text: String): String =
    Base64.getUrlEncoder().withoutPadding().encodeToString(text.toByteArray(Charsets.UTF_8))

private const val ISSUED_AT = 1_760_000_000L

/** The body of session tokens as the API writes them; the access token is unsigned. */
fun tokensJson(label: String = "first"): String {
    val jwt = base64Url("""{"alg":"none"}""") + "." +
        base64Url("""{"iat":$ISSUED_AT,"exp":${ISSUED_AT + 60},"jti":"$label"}""") + ".signature-$label"
    return """{"sessionId":"session-1","accessToken":"$jwt",""" +
        """"accessTokenExpiresAt":"2026-01-01T00:01:00.000Z","refreshToken":"tula_rt_$label"}"""
}

/** The body of an attempt as the API writes it. */
fun attemptJson(step: String, kind: String = "sign_in", session: String? = null): String {
    val sessionPart = if (session == null) "" else ""","session":$session"""
    return """{"id":"attempt-1","kind":"$kind","expiresAt":"2026-01-01T00:10:00.000Z",""" +
        """"step":$step,"attemptSecret":"tula_at_secret-of-attempt-1"$sessionPart}"""
}

/** A finished attempt, with the session it made. */
fun completed(kind: String = "sign_in"): HttpResponse = ok(attemptJson(COMPLETE, kind, tokensJson()))

/** An error in the API's envelope. Its `detail` is [SERVER_WORDS]. */
fun errorJson(code: String, status: Int, extra: String = ""): String =
    """{"status":$status,"code":"$code","detail":"$SERVER_WORDS"$extra}"""

fun ok(body: String): HttpResponse = HttpResponse(200, emptyMap(), body)

fun refused(code: String, status: Int = 400, extra: String = "", headers: Map<String, String> = emptyMap()): HttpResponse =
    HttpResponse(status, headers, errorJson(code, status, extra))

/** An engine a test scripts: every request is recorded, and answered by its method and path. */
class ScriptedEngine : HttpEngine {
    val requests = CopyOnWriteArrayList<HttpRequest>()
    private val handlers = HashMap<String, suspend (HttpRequest) -> HttpResponse>()

    fun on(method: String, path: String, handler: suspend (HttpRequest) -> HttpResponse) {
        synchronized(handlers) { handlers["$method $path"] = handler }
    }

    fun post(path: String, handler: suspend (HttpRequest) -> HttpResponse) = on("POST", path, handler)

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

/**
 * A door a test holds shut: something waits at it ([pass]) until the test opens it, and the test
 * can wait until something is there ([reached]).
 */
class Gate {
    private val arrived = CompletableDeferred<Unit>()
    private val opened = CompletableDeferred<Unit>()

    suspend fun pass() {
        arrived.complete(Unit)
        opened.await()
    }

    suspend fun reached() = arrived.await()

    fun open() {
        opened.complete(Unit)
    }
}

/** A storage a test can make refuse a write, or hold one back. */
class TestStorage : TokenStorage {
    private val values = HashMap<String, String>()

    @Volatile
    var failWrites = false

    @Volatile
    var gate: Gate? = null

    override suspend fun get(key: String): String? = synchronized(values) { values[key] }

    override suspend fun set(key: String, value: String) {
        gate?.pass()
        if (failWrites) {
            throw IllegalStateException("the store could not be written: canary-store-text")
        }
        synchronized(values) { values[key] = value }
    }

    override suspend fun remove(key: String) {
        synchronized(values) { values.remove(key) }
    }
}

/** A model over the real client and a scripted engine, with everything a test looks at. */
class Bench(
    mode: TulaAuthMode = TulaAuthMode.SIGN_IN,
    val storage: TokenStorage = MemoryTokenStorage(),
    strings: TulaStrings = TulaStrings(),
) {
    val engine = ScriptedEngine()
    val client = TulaClient(
        publishableKey = TEST_KEY,
        baseUrl = TEST_BASE,
        storage = storage,
        http = engine,
        clock = Clock { ISSUED_AT * 1000 },
    )

    /** Everything that was announced, oldest first. */
    val said = CopyOnWriteArrayList<String>()

    /** How many times the app was told somebody is signed in. */
    val signedIn = AtomicInteger()

    val model = TulaAuthModel(client, mode, strings, announce = { said.add(it) }, onSignedIn = { signedIn.incrementAndGet() })

    val state: TulaAuthState get() = model.state.value
    val screen: TulaAuthScreen get() = state.screen

    init {
        engine.on("GET", "/v1/client/me") {
            ok("""{"id":"user-1","email":"$ADDRESS","emailVerifiedAt":"2026-01-01T00:00:00.000Z"}""")
        }
    }

    fun type(field: TulaAuthField, text: String) = model.setText(field, text)

    suspend fun tap(action: TulaAuthAction) = model.perform(action)

    /** Type an address on the open start screen and send it. */
    suspend fun begin(address: String = ADDRESS) {
        type(TulaAuthField.EMAIL, address)
        tap(TulaAuthAction.START)
    }

    /** A sign-in on its password step. */
    suspend fun onPassword(step: String = NEEDS_PASSWORD) {
        engine.post(SIGN_INS) { ok(attemptJson(step)) }
        begin()
    }

    /** What every drawn or announced word is looked for in. */
    fun everythingSaid(): String = listOfNotNull(
        state.formError, state.status, model.formProblem,
    ).plus(state.fieldErrors.values.flatten()).plus(said).joinToString("\n")
}
