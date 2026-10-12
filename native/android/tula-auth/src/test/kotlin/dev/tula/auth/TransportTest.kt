package dev.tula.auth

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.yield
import java.io.IOException
import java.net.SocketTimeoutException
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

private const val CONFIG = "/v1/client/config"
private const val SIGN_UPS = "/v1/client/sign-ups"

private val CONFIG_BODY = """
    {"app":{"name":"Tula","supportEmail":null},"signIn":{"methods":["password"],"oauth":[]},
    "signUp":{"password":"required"},"password":{"preset":"recommended","minLength":10,
    "maxLength":128,"requireLowercase":false,"requireUppercase":false,"requireNumber":false,
    "requireSpecial":false,"minCharacterClasses":0,"specialChars":"!","disallowUserInfo":true,
    "disallowCommon":true,"breachCheck":"block","maxRepeatedChars":null,"blockSequences":false,
    "history":0,"expiryDays":null},"mfa":{"policy":"optional","smsCode":false},
    "phone":{"enabled":false},"somethingNewer":{"kept":"out"}}
""".trimIndent()

/** One request and one answer: headers, errors, timeouts, and what is never said. */
class TransportTest {
    @Test
    fun `a call carries the key, the client kind and the profile, and nothing it was not given`() = runTest {
        val bench = Bench(sessionProfile = "back-office")
        bench.engine.on("GET", CONFIG) { ok(CONFIG_BODY) }
        val config = bench.tula.config()
        assertEquals("Tula", config.app.name)

        val request = bench.engine.requests.single()
        assertEquals("GET", request.method)
        assertEquals(TEST_BASE + CONFIG, request.url)
        assertNull(request.body)
        assertEquals(
            mapOf(
                "accept" to "application/json",
                "x-tula-publishable-key" to TEST_KEY,
                "x-tula-client" to "android",
                "x-tula-session-profile" to "back-office",
            ),
            request.headers,
        )
        assertEquals(DEFAULT_TIMEOUT_MS, request.timeoutMs)
    }

    @Test
    fun `the configuration is fetched once, until it is asked for again`() = runTest {
        val bench = Bench()
        bench.engine.on("GET", CONFIG) { ok(CONFIG_BODY) }
        bench.tula.config()
        bench.tula.config()
        assertEquals(1, bench.engine.requests.size)
        bench.tula.config(force = true)
        assertEquals(2, bench.engine.requests.size)
    }

    @Test
    fun `an error answer becomes its code, its message, its params and its field errors`() = runTest {
        val bench = Bench()
        bench.engine.on("POST", SIGN_UPS) {
            answer(
                422,
                """{"status":422,"code":"password.too_short","detail":"server words","params":{"min":10,
                    "nested":{"dropped":true},"flag":true,"ratio":0.5,"nothing":null},
                    "errors":[{"field":"password","code":"password.too_short","message":"server field words","params":{"min":10}},
                    {"field":"password","code":"password.newer_rule","message":"A rule of a newer server."},
                    {"code":"no.field"},"not an object"]}""",
            )
        }
        val error = caught { bench.tula.signUp(email = "maya@example.com", password = "short") }
        assertEquals("password.too_short", error.code)
        assertEquals(422, error.status)
        assertEquals(mapOf<String, Any>("min" to 10L, "flag" to true, "ratio" to 0.5), error.params)
        assertNull(error.retryAfterMs)
        assertEquals(2, error.errors.size)
        val known = error.errors[0]
        assertEquals("password", known.field)
        assertEquals("password.too_short", known.code)
        // The server's own words for a field problem, which say more than the general message.
        assertEquals("server field words", known.message)
        assertEquals(mapOf<String, Any>("min" to 10L), known.params)
        // A code this version has no message for keeps the server's.
        assertEquals("A rule of a newer server.", error.errors[1].message)
    }

    @Test
    fun `messages come from the app's table first, with params filled in`() = runTest {
        val bench = Bench(
            messages = mapOf(
                "auth.invalid_credentials" to "Das stimmt nicht.",
                "password.too_short" to "Mindestens {min} Zeichen, nicht {missing}.",
                "network.failed" to "Keine Verbindung.",
            ),
        )
        bench.engine.on("POST", SIGN_UPS) {
            answer(
                422,
                """{"status":422,"code":"password.too_short","detail":"x","params":{"min":12},
                    "errors":[{"field":"password","code":"password.too_short","message":"server","params":{"min":12}}]}""",
            )
        }
        val error = caught { bench.tula.signUp(email = "maya@example.com", password = "short") }
        assertEquals("Mindestens 12 Zeichen, nicht {missing}.", error.message)
        assertEquals("Mindestens 12 Zeichen, nicht {missing}.", error.errors.single().message)

        bench.engine.on("POST", SIGN_UPS) { throw IOException("down") }
        assertEquals("Keine Verbindung.", caught { bench.tula.signUp(email = "maya@example.com") }.message)
    }

    @Test
    fun `a code this version does not know keeps the server's words`() = runTest {
        val bench = Bench()
        bench.engine.on("GET", CONFIG) { answer(418, errorJson("teapot.short_and_stout", 418)) }
        val error = caught { bench.tula.config() }
        assertEquals("teapot.short_and_stout", error.code)
        assertEquals("the server's own words", error.message)
        assertEquals(formatMessage("internal"), formatMessage("no.such.code"))
        assertEquals("a fallback", formatMessage("no.such.code", fallback = "a fallback"))
        assertEquals("5 and 2.5", formatMessage("x", mapOf("x" to "{a} and {b}"), mapOf("a" to 5.0, "b" to 2.5)))
    }

    @Test
    fun `an answer that is not the API's is response_invalid, with its status`() = runTest {
        val bench = Bench()
        val notOurs = listOf(
            answer(502, "<html>Bad gateway</html>"),
            answer(500, """{"message":"another service"}"""),
            answer(404, """["a list"]"""),
            answer(503, "", mapOf("retry-after" to "7")),
            ok("<html>a captive portal</html>"),
            ok(""),
        )
        for (response in notOurs) {
            bench.engine.on("GET", CONFIG) { response }
            val error = caught { bench.tula.config(force = true) }
            assertEquals("response.invalid", error.code, response.body)
            assertEquals(response.status, error.status)
        }
        bench.engine.on("GET", CONFIG) { answer(503, "", mapOf("retry-after" to "7")) }
        assertEquals(7_000, caught { bench.tula.config(force = true) }.retryAfterMs)
        // A 200 that is JSON and not the type that was asked for.
        bench.engine.on("GET", CONFIG) { ok("""{"app":"not an object"}""") }
        assertEquals("response.invalid", caught { bench.tula.config(force = true) }.code)
        // A 204 where a body was owed.
        bench.engine.on("GET", CONFIG) { answer(204, "") }
        assertEquals("response.invalid", caught { bench.tula.config(force = true) }.code)
    }

    @Test
    fun `how long to wait comes from the header, a date, or the error's own param`() = runTest {
        val bench = Bench()
        val limited = errorJson("rate_limited", 429, ""","params":{"retryAfter":12}""")
        suspend fun waitOf(headers: Map<String, String>, body: String = limited): Long? {
            bench.engine.on("GET", CONFIG) { answer(429, body, headers) }
            return caught { bench.tula.config(force = true) }.retryAfterMs
        }
        assertEquals(30_000, waitOf(mapOf("retry-after" to " 30 ")))
        // 2025-10-09T08:53:20Z is the fake clock's time; the date is 40 seconds later.
        assertEquals(40_000, waitOf(mapOf("retry-after" to "Thu, 09 Oct 2025 08:54:00 GMT")))
        // A date in the past is no wait at all.
        assertEquals(0, waitOf(mapOf("retry-after" to "Wed, 01 Jan 2020 00:00:00 GMT")))
        // Neither a number nor a date: the error's param.
        assertEquals(12_000, waitOf(mapOf("retry-after" to "soon")))
        assertEquals(12_000, waitOf(emptyMap()))
        assertNull(waitOf(emptyMap(), errorJson("rate_limited", 429)))
    }

    @Test
    fun `no answer in time is network_timeout, and the request is given up`() = runTest {
        val bench = Bench(timeoutMs = 50)
        val never = CompletableDeferred<HttpResponse>()
        var cancelled = false
        bench.engine.on("GET", CONFIG) {
            try {
                never.await()
            } finally {
                cancelled = true
            }
        }
        val error = caught { bench.tula.config() }
        assertEquals("network.timeout", error.code)
        assertEquals(0, error.status)
        assertTrue(cancelled)

        bench.engine.on("GET", CONFIG) { throw SocketTimeoutException("Read timed out") }
        assertEquals("network.timeout", caught { bench.tula.config() }.code)
    }

    @Test
    fun `anything else an engine throws is network_failed, and its text is only the cause's`() = runTest {
        val bench = Bench()
        bench.engine.on("GET", CONFIG) { throw IllegalStateException("canary-engine-text") }
        val error = caught { bench.tula.config() }
        assertEquals("network.failed", error.code)
        assertFalse(error.message.orEmpty().contains("canary-engine-text"))
        assertEquals("canary-engine-text", error.cause?.message)
    }

    @Test
    fun `a caller that is cancelled is cancelled, not told the network failed`() = runTest {
        val bench = Bench()
        val gate = CompletableDeferred<Unit>()
        bench.engine.on("GET", CONFIG) {
            gate.await()
            ok(CONFIG_BODY)
        }
        var outcome: Throwable? = null
        val asking = async {
            try {
                bench.tula.config()
            } catch (error: TulaError) {
                outcome = error
            }
        }
        while (bench.engine.requests.isEmpty()) {
            yield()
        }
        asking.cancelAndJoin()
        assertNull(outcome)
        assertTrue(asking.isCancelled)
    }

    @Test
    fun `nothing an error, a request or an answer prints holds what was sent`() = runTest {
        val bench = Bench()
        bench.signIn()
        bench.engine.on("POST", "/v1/client/sessions/refresh") { answer(500, errorJson("internal", 500)) }
        val error = caught { bench.tula.session.refresh() }
        val printed = bench.engine.requests.joinToString { it.toString() } +
            error.toString() + error.message + error.params + error.errors +
            ok(tokensJson("first")).toString() + bench.tula.state.value
        for (secret in listOf("tula_rt_", "tula_at_", "a-password-nobody-uses", fakeJwt("first"), TEST_KEY)) {
            assertFalse(printed.contains(secret), secret)
        }
        assertEquals("HttpResponse(200)", ok("{}").toString())
        assertEquals("HttpRequest(GET https://auth.example.test/x)", HttpRequest("GET", "$TEST_BASE/x", emptyMap(), null, 1).toString())
    }

    @Test
    fun `options that can never work are refused, without repeating what was given`() {
        val storage = MemoryTokenStorage()
        fun refused(
            key: String = TEST_KEY,
            base: String = TEST_BASE,
            timeoutMs: Long = DEFAULT_TIMEOUT_MS,
            profile: String? = null,
        ): String {
            val error = assertFailsWith<IllegalArgumentException> {
                TulaClient(key, base, storage, timeoutMs = timeoutMs, sessionProfile = profile)
            }
            return error.message.orEmpty()
        }
        val canary = "canary0value"
        val messages = listOf(
            refused(key = "tula_sk_dev_$canary"),
            refused(key = canary),
            refused(key = ""),
            refused(base = "ftp://$canary.example"),
            refused(base = "$canary/no-scheme"),
            refused(base = "https://"),
            refused(base = "https://exa mple.com/$canary"),
            refused(base = "https://user:$canary@auth.example.com"),
            refused(base = "https://auth.example.com/?q=$canary"),
            refused(base = "https://auth.example.com/#$canary"),
            refused(timeoutMs = 0),
            refused(timeoutMs = -5),
            refused(profile = "Back-Office-$canary"),
            refused(profile = "a--b"),
            refused(profile = "-a"),
            refused(profile = ""),
            refused(profile = "a".repeat(33)),
        )
        for (message in messages) {
            assertTrue(message.startsWith("TulaClient: "), message)
            assertFalse(message.contains(canary), message)
        }
        assertTrue(messages[0].contains("secret key"))
        // What is accepted.
        TulaClient(TEST_KEY, "http://localhost:3003", storage, sessionProfile = "back-office-2").close()
    }

    @Test
    fun `the base address is the origin and the path, with no trailing slash`() {
        assertEquals("https://auth.example.com", normalizeBaseUrl("HTTPS://Auth.Example.com/"))
        assertEquals("https://auth.example.com/tula", normalizeBaseUrl("https://auth.example.com/tula///"))
        assertEquals("http://127.0.0.1:4318/w/abc", normalizeBaseUrl("http://127.0.0.1:4318/w/abc"))
        assertEquals(
            "tula.refresh.https://auth.example.com|$TEST_KEY",
            TulaClient.storageKey("https://auth.example.com/", TEST_KEY),
        )
    }

    @Test
    fun `a path parameter is one path segment`() = runTest {
        val bench = Bench()
        val odd = "a/b c?d#e"
        bench.engine.on("POST", "/v1/client/sign-ins") { ok(attemptJson(NEEDS_PASSWORD, id = odd)) }
        bench.engine.on("POST", "/v1/client/sign-ins/a%2Fb%20c%3Fd%23e/password") {
            ok(attemptJson(NEEDS_PASSWORD, id = odd, secret = null))
        }
        bench.tula.signIn("maya@example.com").submitPassword("the-password")
        assertEquals(2, bench.engine.requests.size)
    }
}
