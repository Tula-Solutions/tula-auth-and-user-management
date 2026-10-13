package dev.tula.auth.journeys

import com.sun.net.httpserver.HttpServer
import dev.tula.auth.AuthState
import dev.tula.auth.BrowserSession
import dev.tula.auth.DeviceKeyStore
import dev.tula.auth.FakeClock
import dev.tula.auth.GoogleSheet
import dev.tula.auth.HttpEngine
import dev.tula.auth.HttpRequest
import dev.tula.auth.HttpResponse
import dev.tula.auth.MemoryTokenStorage
import dev.tula.auth.PasskeySheet
import dev.tula.auth.TokenStorage
import dev.tula.auth.TulaClient
import dev.tula.auth.UrlConnectionEngine
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.InetSocketAddress
import java.net.URI
import java.net.URLEncoder
import java.util.Base64
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger

/** A scenario of `conformance/scenarios` this test is the Kotlin client's journey of. */
@Target(AnnotationTarget.FUNCTION)
@Retention(AnnotationRetention.RUNTIME)
annotation class Journey(vararg val scenarios: String)

/** A named client behaviour of `conformance/client-journeys.json` this test proves. */
@Target(AnnotationTarget.FUNCTION)
@Retention(AnnotationRetention.RUNTIME)
annotation class Behaviour(val id: String)

/** Parse a JSON literal of a test. */
fun j(text: String): JsonElement = Json.parseToJsonElement(text)

/** This object with the value at [path] replaced, the objects on the way made where missing. */
fun JsonObject.with(vararg path: String, value: JsonElement): JsonObject {
    val name = path.first()
    val next = if (path.size == 1) {
        value
    } else {
        ((this[name] as? JsonObject) ?: JsonObject(emptyMap())).with(*path.drop(1).toTypedArray(), value = value)
    }
    return JsonObject(this + (name to next))
}

/** The claims of an access token, unverified: what an application's backend would read. */
fun claims(token: String?): JsonObject {
    val payload = token.orEmpty().split('.').getOrNull(1) ?: throw AssertionError("not a JWT")
    return j(Base64.getUrlDecoder().decode(payload).toString(Charsets.UTF_8)).jsonObject
}

/** One request a client made and how the API answered it. */
class Exchange(
    val method: String,
    /** The path as the API has it, from `/v1`. */
    val path: String,
    val headers: Map<String, String>,
    val requestBody: String?,
    val status: Int,
    val responseBody: String,
)

/** An answer to a request the test itself made (an admin call, a test route). */
class Raw(val status: Int, val headers: Map<String, String>, val body: String) {
    val json: JsonElement get() = j(body)
}

/** What a journey may do to one client's network. */
class Network(
    /** While true no request leaves the device. */
    val offline: () -> Boolean = { false },
    /** The request reaches the API and is answered; the answer never arrives. */
    val loseResponse: (HttpRequest) -> Boolean = { false },
    /** Change a request on its way out. */
    val tamper: (HttpRequest) -> HttpRequest = { it },
    /** Change the API's answer on its way back. */
    val answer: (HttpRequest, HttpResponse) -> HttpResponse = { _, response -> response },
)

/** A client in a journey, with its storage and every state it has been in since it was made. */
class Device(val tula: TulaClient, val storage: TokenStorage, val states: List<AuthState>)

/** An operator's hook endpoint, listening on this machine for one journey. */
class Hook(private val server: HttpServer, private val release: CountDownLatch) {
    /** How often the API asked. */
    val asked = AtomicInteger()

    /** What to answer with; `null` never answers. */
    @Volatile
    var answer: String? = null

    fun stop() {
        release.countDown()
        server.stop(0)
    }
}

/**
 * One journey's server: a world of `e2e/kotlin-fixture.ts`. The real API on memory stores, a
 * clock only the journey moves, and an environment with keys of its own, reached over HTTP on
 * this machine as an app reaches a deployment.
 */
class World private constructor(
    private val fixture: String,
    private val id: String,
    val publishableKey: String,
) : AutoCloseable {
    /** The API's address, as a client is given it. */
    val baseUrl = "$fixture/w/$id"

    /** The entry a client of this world keeps its refresh token under. */
    val storageKey: String = TulaClient.storageKey(baseUrl, publishableKey)

    /** The devices' clock, moved together with the server's by [advance]. */
    val clock = FakeClock()

    /** Every request the world's clients made, oldest first. */
    val exchanges = CopyOnWriteArrayList<Exchange>()

    private val real = UrlConnectionEngine()
    private val watching = CoroutineScope(Dispatchers.Unconfined + Job())
    private val clients = CopyOnWriteArrayList<TulaClient>()
    private val hooks = CopyOnWriteArrayList<Hook>()
    private var addresses = 0

    /** A new device with this world's key. */
    fun client(
        storage: TokenStorage = MemoryTokenStorage(),
        sessionProfile: String? = null,
        network: Network = Network(),
        passkeys: PasskeySheet? = null,
        google: GoogleSheet? = null,
        browser: BrowserSession? = null,
        deviceKeys: DeviceKeyStore? = null,
    ): Device {
        val wire = HttpEngine { original ->
            if (network.offline()) {
                throw IOException("the network is unreachable")
            }
            val request = network.tamper(original)
            val served = real.send(request)
            val response = network.answer(request, served)
            exchanges.add(
                Exchange(
                    request.method,
                    request.url.removePrefix(baseUrl),
                    request.headers,
                    request.body,
                    response.status,
                    response.body,
                ),
            )
            if (network.loseResponse(request)) {
                throw IOException("the response was lost on the way back")
            }
            response
        }
        val tula = TulaClient(
            publishableKey = publishableKey,
            baseUrl = baseUrl,
            storage = storage,
            http = wire,
            clock = clock,
            sessionProfile = sessionProfile,
            passkeys = passkeys,
            google = google,
            browser = browser,
            deviceKeys = deviceKeys,
        )
        clients.add(tula)
        // Every change of state, as an application that collects the flow sees them. The
        // first value is where every client starts and is left out.
        val states = CopyOnWriteArrayList<AuthState>()
        watching.launch { tula.state.drop(1).collect { states.add(it) } }
        return Device(tula, storage, states)
    }

    /** An address nobody in this world has used. */
    fun freshEmail(): String {
        addresses += 1
        return "kotlin-user-$addresses@example.com"
    }

    /** The requests to the refresh route, oldest first. */
    fun refreshes(): List<Exchange> = exchanges.filter { it.path == "/v1/client/sessions/refresh" }

    /** Move the server's clock and the devices' together. */
    fun advance(ms: Long) {
        advanceServerOnly(ms)
        clock.advance(ms)
    }

    /** Move the server's clock alone: the devices believe no time has passed. */
    fun advanceServerOnly(ms: Long) {
        expect(200, test("POST", "advance", """{"ms":$ms}"""))
    }

    /** What time the server thinks it is: its clock is fixed and only a journey moves it. */
    fun serverNow(): Long = test("GET", "now").json.jsonObject.getValue("now").jsonPrimitive.content.toLong()

    /** The requests to [path], oldest first. */
    fun sent(path: String): List<Exchange> = exchanges.filter { it.path == path }

    /** The deployment's tier: `local` allows loopback redirect URLs, `dev` does not. */
    fun tier(tier: String) {
        expect(200, test("POST", "tier", """{"tier":"$tier"}"""))
    }

    /**
     * What a provider's sheet would hand the app: a token of the mock provider's, for a world
     * made with `oauth`.
     */
    fun idToken(provider: String, claims: JsonObject, expired: Boolean = false): String {
        val asked = buildJsonObject {
            put("provider", provider)
            put("claims", claims)
            put("expired", expired)
        }
        val minted = test("POST", "idtoken", asked.toString())
        expect(200, minted)
        return minted.json.jsonObject.text("token")
    }

    /** Every email sent to [to] (to anyone without it), oldest first: `to`, `subject`, `text`. */
    fun outbox(to: String? = null): List<JsonObject> =
        test("GET", "outbox" + query("to", to)).json.jsonArray.map { it.jsonObject }

    /** The code of the newest email to [email] whose subject leads with one. */
    fun code(email: String): String =
        outbox(email).mapNotNull { CODE_SUBJECT.find(it.text("subject"))?.groupValues?.get(1) }.lastOrNull()
            ?: throw AssertionError("no email with a code was sent to $email")

    /** The text of every message texted to [to] (to anyone without it), oldest first. */
    fun texts(to: String? = null): List<String> =
        test("GET", "sms" + query("to", to)).json.jsonArray.map { it.jsonObject.text("text") }

    /** The code of the newest message texted to [to]: its last run of exactly six digits. */
    fun textedCode(to: String): String =
        texts(to).lastOrNull()?.let { SIX_DIGITS.findAll(it).lastOrNull()?.value }
            ?: throw AssertionError("no text message with a code was sent to that number")

    /** Whether an account has this address. */
    fun userExists(email: String): Boolean =
        test("GET", "users" + query("email", email)).json.jsonObject["exists"]?.jsonPrimitive?.content == "true"

    /** Give an account a proven phone number, as confirming a texted code does. */
    fun givePhoneNumber(email: String, number: String) {
        expect(200, test("POST", "phone", """{"email":"$email","phoneNumber":"$number"}"""))
    }

    /**
     * Call the admin API as an operator's backend does. The world's secret key stays in the
     * fixture's process: the call is relayed, and this test never holds the key.
     */
    fun admin(method: String, path: String, body: String? = null, headers: Map<String, String> = emptyMap()): Raw {
        val asked = buildJsonObject {
            put("method", method)
            put("path", path)
            if (body != null) {
                put("body", body)
            }
            putJsonObject("headers") { headers.forEach { (name, value) -> put(name, value) } }
        }
        val relayed = test("POST", "admin", asked.toString())
        expect(200, relayed)
        val answer = relayed.json.jsonObject
        return Raw(
            status = answer.getValue("status").jsonPrimitive.content.toInt(),
            headers = answer.getValue("headers").jsonObject.mapValues { it.value.jsonPrimitive.content },
            body = answer.text("body"),
        )
    }

    /** Replace the environment's settings with what [change] makes of the current ones. */
    fun settings(change: (JsonObject) -> JsonObject) {
        val read = admin("GET", "/v1/admin/settings")
        expect(200, read)
        val current = read.json.jsonObject.getValue("settings").jsonObject
        val saved = admin(
            "PUT",
            "/v1/admin/settings",
            change(current).toString(),
            mapOf("if-match" to read.headers.getValue("etag")),
        )
        expect(200, saved)
    }

    /**
     * Register a hook whose endpoint is a listener of this process, as `withHook` of the
     * TypeScript journeys does. A hook that answers gets the longest deadline a hook may have
     * (a cold first request has taken longer than 100 ms on a busy runner); only a journey
     * about a hook that never answers asks for a short one.
     */
    fun hook(point: String, answer: String?, deadlineMs: Int = 5_000): Hook {
        val release = CountDownLatch(1)
        val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        val hook = Hook(server, release)
        hook.answer = answer
        server.executor = Executors.newCachedThreadPool { task -> Thread(task).apply { isDaemon = true } }
        server.createContext("/") { exchange ->
            hook.asked.incrementAndGet()
            exchange.requestBody.readBytes()
            val body = hook.answer
            if (body == null) {
                release.await()
            } else {
                val bytes = body.toByteArray(Charsets.UTF_8)
                exchange.responseHeaders.add("content-type", "application/json")
                exchange.sendResponseHeaders(200, bytes.size.toLong())
                exchange.responseBody.use { it.write(bytes) }
            }
            exchange.close()
        }
        server.start()
        hooks.add(hook)
        val created = admin(
            "POST",
            "/v1/admin/hooks",
            """{"point":"$point","url":"http://127.0.0.1:${server.address.port}/$point",""" +
                """"enabled":true,"deadlineMs":$deadlineMs,"failureMode":"deny"}""",
        )
        expect(201, created)
        return hook
    }

    private fun test(method: String, route: String, body: String? = null): Raw =
        raw(method, "$fixture/__test/worlds/$id/$route", emptyMap(), body)

    override fun close() {
        watching.cancel()
        clients.forEach { it.close() }
        hooks.forEach { it.stop() }
        raw("DELETE", "$fixture/__test/worlds/$id", emptyMap(), null)
    }

    companion object {
        private val CODE_SUBJECT = Regex("^(\\d{6})\\b")
        private val SIX_DIGITS = Regex("(?<!\\d)\\d{6}(?!\\d)")

        /**
         * Where the fixture listens. The journeys are never skipped for want of it: without
         * the real API they fail, and say how to start it.
         */
        fun fixtureUrl(): String =
            System.getProperty("tula.fixture.url").orEmpty().ifEmpty {
                throw AssertionError(
                    "The journeys run against the real API. Run them with `bun run native:kotlin:test` " +
                        "from the repository's root, which starts it (TULA_FIXTURE_URL was not set).",
                )
            }

        /**
         * A new world.
         *
         * @param oauth Every provider is the API's own mock.
         */
        fun create(oauth: Boolean = false): World {
            val fixture = fixtureUrl()
            val made = raw("POST", "$fixture/__test/worlds", emptyMap(), """{"oauth":$oauth}""")
            expect(201, made)
            val world = made.json.jsonObject
            return World(fixture, world.text("id"), world.text("publishableKey")).also {
                // A proof carries the time, and an authenticator's code is made of it.
                it.clock.now = it.serverNow()
            }
        }

        fun expect(status: Int, answer: Raw) {
            if (answer.status != status) {
                throw AssertionError("expected $status and got ${answer.status}: ${answer.body}")
            }
        }

        private fun query(name: String, value: String?): String =
            if (value == null) "" else "?$name=" + URLEncoder.encode(value, "UTF-8")

        /** One plain request of the test's own. */
        fun raw(
            method: String,
            url: String,
            headers: Map<String, String>,
            body: String?,
            contentType: String = "application/json",
        ): Raw {
            val connection = URI(url).toURL().openConnection() as HttpURLConnection
            try {
                connection.requestMethod = method
                connection.instanceFollowRedirects = false
                connection.connectTimeout = 10_000
                connection.readTimeout = 30_000
                headers.forEach { (name, value) -> connection.setRequestProperty(name, value) }
                if (body != null) {
                    connection.doOutput = true
                    connection.setRequestProperty("content-type", contentType)
                    connection.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
                }
                val status = connection.responseCode
                val stream = if (status >= 400) connection.errorStream else connection.inputStream
                val text = stream?.use { it.readBytes().toString(Charsets.UTF_8) }.orEmpty()
                val answered = connection.headerFields
                    .filterKeys { it != null }
                    .mapKeys { it.key.lowercase() }
                    .mapValues { it.value.last() }
                return Raw(status, answered, text)
            } finally {
                connection.disconnect()
            }
        }
    }
}

/** A string member of a JSON object; an `AssertionError` when it is not one. */
fun JsonObject.text(name: String): String =
    (this[name] as? JsonPrimitive)?.takeIf { it.isString }?.content
        ?: throw AssertionError("\"$name\" is not a string in $this")

/** The strings of a JSON array member. */
fun JsonObject.texts(name: String): List<String> =
    (this[name] as? JsonArray)?.map { it.jsonPrimitive.content } ?: throw AssertionError("\"$name\" is not a list in $this")
