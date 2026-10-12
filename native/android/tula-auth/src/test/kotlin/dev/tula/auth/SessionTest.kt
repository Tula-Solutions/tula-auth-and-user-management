package dev.tula.auth

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.launch
import kotlinx.coroutines.yield
import java.io.IOException
import java.util.concurrent.atomic.AtomicInteger
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNotEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertSame
import kotlin.test.assertTrue

private const val REFRESH = "/v1/client/sessions/refresh"
private const val SIGN_OUT = "/v1/client/sessions/sign-out"

/** The session manager on a scripted network: every interleaving `@tula/core`'s tests hold. */
class SessionTest {
    /** Answer each refresh with the next tokens, counting them. */
    private fun Bench.rotating(): AtomicInteger {
        val count = AtomicInteger()
        engine.on("POST", REFRESH) { ok(tokensJson("refresh-${count.incrementAndGet()}")) }
        return count
    }

    private fun Bench.refreshes() = engine.sent(REFRESH)

    @Test
    fun `load with nothing stored is signed out, and asks the server nothing`() = runTest {
        val bench = Bench()
        assertEquals(AuthState.Loading, bench.tula.state.value)
        assertEquals(AuthState.SignedOut, bench.tula.load())
        assertEquals(emptyList(), bench.engine.requests)
        assertNull(bench.tula.session.getToken())
    }

    @Test
    fun `load with a stored token refreshes once and is signed in with the user`() = runTest {
        val bench = Bench()
        bench.storage.set(TEST_STORAGE_KEY, "tula_rt_stored")
        bench.rotating()
        bench.engine.on("GET", "/v1/client/me") { ok(userJson()) }

        val state = bench.tula.load()
        assertIs<AuthState.SignedIn>(state)
        assertEquals("session-1", state.sessionId)
        assertEquals("maya@example.com", state.user?.email)
        assertEquals("""{"refreshToken":"tula_rt_stored"}""", bench.refreshes().single().body)
        assertEquals("tula_rt_refresh-1", bench.storage.get(TEST_STORAGE_KEY))
        // A second load has nothing to find out.
        bench.tula.load()
        assertEquals(1, bench.refreshes().size)
    }

    @Test
    fun `an empty stored value is no token`() = runTest {
        val bench = Bench()
        bench.storage.set(TEST_STORAGE_KEY, "")
        assertEquals(AuthState.SignedOut, bench.tula.load())
        assertEquals(emptyList(), bench.engine.requests)
    }

    @Test
    fun `a storage that cannot be read is storage_failed, and the state stays loading`() = runTest {
        val storage = FlakyStorage()
        val bench = Bench(storage = storage)
        storage.values[TEST_STORAGE_KEY] = "tula_rt_stored"
        storage.failReads = true

        val error = caught { bench.tula.load() }
        assertEquals("storage.failed", error.code)
        assertEquals(0, error.status)
        assertFalse(error.message.orEmpty().contains("canary-store-text"))
        assertEquals(AuthState.Loading, bench.tula.state.value)
        assertEquals(emptyList(), bench.engine.requests)

        // Asked again once the store answers: the session is found.
        storage.failReads = false
        bench.rotating()
        bench.engine.on("GET", "/v1/client/me") { ok(userJson()) }
        assertIs<AuthState.SignedIn>(bench.tula.load())
    }

    @Test
    fun `the token in memory is handed out until its skew, then refreshed`() = runTest {
        val bench = Bench()
        bench.signIn()
        val count = bench.rotating()
        val first = bench.tula.session.getToken()
        assertEquals(fakeJwt("first"), first)

        // A 60-second token is used for 50 seconds.
        bench.clock.advance(49_000)
        assertEquals(first, bench.tula.session.getToken())
        assertEquals(0, count.get())

        bench.clock.advance(2_000)
        assertEquals(fakeJwt("refresh-1"), bench.tula.session.getToken())
        assertEquals(1, count.get())
    }

    @Test
    fun `a short-lived token is refreshed at half its life`() = runTest {
        val bench = Bench()
        bench.engine.on("POST", "/v1/client/sign-ins") { ok(attemptJson(NEEDS_PASSWORD)) }
        bench.engine.on("POST", "/v1/client/sign-ins/attempt-1/password") {
            ok(
                attemptJson(
                    COMPLETE,
                    session = tokensJson("short", lifetimeSeconds = 10),
                ),
            )
        }
        bench.engine.on("GET", "/v1/client/me") { ok(userJson()) }
        bench.tula.signIn("maya@example.com").submitPassword("a-password-nobody-uses")
        val count = bench.rotating()

        bench.clock.advance(4_000)
        assertEquals(fakeJwt("short", 10), bench.tula.session.getToken())
        bench.clock.advance(2_000)
        assertNotEquals(fakeJwt("short", 10), bench.tula.session.getToken())
        assertEquals(1, count.get())
    }

    @Test
    fun `calls made at once share one refresh`() = runTest {
        val bench = Bench()
        bench.signIn()
        val gate = CompletableDeferred<Unit>()
        bench.engine.on("POST", REFRESH) {
            gate.await()
            ok(tokensJson("shared"))
        }
        bench.clock.advance(61_000)

        // The explicit refresh is the one that starts it: a call that came after the refresh
        // had ended would rightly be a refresh of its own, and a `getToken()` that comes
        // late simply finds the new token.
        val explicit = async { bench.tula.session.refresh() }
        while (bench.refreshes().isEmpty()) {
            yield()
        }
        val waiting = List(10) { async { bench.tula.session.getToken() } }
        repeat(200) { yield() }
        gate.complete(Unit)
        val tokens = waiting.awaitAll() + explicit.await()
        assertEquals(setOf(fakeJwt("shared")), tokens.toSet())
        assertEquals(1, bench.refreshes().size)
    }

    @Test
    fun `a caller that stops waiting does not take the refresh from the others`() = runTest {
        val bench = Bench()
        bench.signIn()
        val gate = CompletableDeferred<Unit>()
        bench.engine.on("POST", REFRESH) {
            gate.await()
            ok(tokensJson("kept"))
        }
        bench.clock.advance(61_000)

        val impatient = launch { bench.tula.session.getToken() }
        val patient = async { bench.tula.session.getToken() }
        while (bench.refreshes().isEmpty()) {
            yield()
        }
        impatient.cancelAndJoin()
        gate.complete(Unit)
        assertEquals(fakeJwt("kept"), patient.await())
        assertEquals(1, bench.refreshes().size)
        assertEquals("tula_rt_kept", bench.storage.get(TEST_STORAGE_KEY))
    }

    @Test
    fun `a refresh the server refuses for the session ends it once`() = runTest {
        for (code in listOf("session.reuse_detected", "session.expired", "auth.unauthenticated", "auth.user_banned")) {
            val bench = Bench()
            bench.signIn()
            bench.engine.on("POST", REFRESH) { answer(401, errorJson(code, 401)) }
            bench.clock.advance(61_000)

            assertNull(bench.tula.session.getToken(), code)
            assertEquals(AuthState.SignedOut, bench.tula.state.value)
            assertNull(bench.storage.get(TEST_STORAGE_KEY))
            // Signed out stays signed out: nothing more is asked.
            assertNull(bench.tula.session.getToken())
            assertNull(bench.tula.session.refresh())
            assertEquals(1, bench.refreshes().size, code)
        }
    }

    @Test
    fun `a refresh with no answer is sent once more, at once, with the same token`() = runTest {
        val bench = Bench()
        bench.signIn()
        val tries = AtomicInteger()
        bench.engine.on("POST", REFRESH) {
            if (tries.incrementAndGet() == 1) {
                throw IOException("connection reset: canary-network-text")
            }
            ok(tokensJson("second-try"))
        }
        bench.clock.advance(61_000)

        assertEquals(fakeJwt("second-try"), bench.tula.session.getToken())
        assertEquals(2, bench.refreshes().size)
        assertEquals(bench.refreshes()[0].body, bench.refreshes()[1].body)
        assertIs<AuthState.SignedIn>(bench.tula.state.value)
    }

    @Test
    fun `two tries without an answer fail, keep the session, and are not a third`() = runTest {
        val bench = Bench()
        bench.signIn()
        bench.engine.on("POST", REFRESH) { throw IOException("unreachable: canary-network-text") }
        val signedIn = bench.tula.state.value
        bench.clock.advance(61_000)

        val error = caught { bench.tula.session.getToken() }
        assertEquals("network.failed", error.code)
        assertEquals(0, error.status)
        assertFalse(error.message.orEmpty().contains("canary-network-text"))
        assertEquals(2, bench.refreshes().size)
        assertSame(signedIn, bench.tula.state.value)
        assertEquals("tula_rt_first", bench.storage.get(TEST_STORAGE_KEY))

        // Asked again: again two tries, and the session is still there.
        caught { bench.tula.session.getToken() }
        assertEquals(4, bench.refreshes().size)
        assertSame(signedIn, bench.tula.state.value)
    }

    @Test
    fun `the repeat is given what is left of the grace window, and never less than a second`() = runTest {
        val bench = Bench()
        bench.signIn()
        bench.engine.on("POST", REFRESH) {
            // The first try used most of the window before it failed.
            bench.clock.advance(7_500)
            throw IOException("unreachable")
        }
        bench.clock.advance(61_000)
        caught { bench.tula.session.getToken() }
        val (first, second) = bench.refreshes()
        assertEquals(REFRESH_TIMEOUT_MS, first.timeoutMs)
        assertEquals(2_500, second.timeoutMs)

        // A first try that outlasted the window still leaves the repeat a second.
        bench.engine.requests.clear()
        bench.engine.on("POST", REFRESH) {
            bench.clock.advance(20_000)
            throw IOException("unreachable")
        }
        caught { bench.tula.session.refresh() }
        assertEquals(MIN_REFRESH_RETRY_TIMEOUT_MS, bench.refreshes()[1].timeoutMs)
    }

    @Test
    fun `a refresh never waits longer than the grace window allows, whatever the client's timeout`() = runTest {
        val slow = Bench(timeoutMs = 60_000)
        slow.signIn()
        slow.rotating()
        slow.tula.session.refresh()
        assertEquals(REFRESH_TIMEOUT_MS, slow.refreshes().single().timeoutMs)
        assertEquals(60_000, slow.engine.sent("/v1/client/sign-ins").single().timeoutMs)

        val quick = Bench(timeoutMs = 3_000)
        quick.signIn()
        quick.rotating()
        quick.tula.session.refresh()
        assertEquals(3_000, quick.refreshes().single().timeoutMs)
        assertTrue(REFRESH_TIMEOUT_MS < REFRESH_RETRY_WINDOW_MS)
    }

    @Test
    fun `an http answer of any status is never repeated, and keeps the session`() = runTest {
        for (status in listOf(400, 403, 404, 429, 500, 502, 503)) {
            val bench = Bench()
            bench.signIn()
            bench.engine.on("POST", REFRESH) { answer(status, errorJson("internal", status)) }
            bench.clock.advance(61_000)

            val error = caught { bench.tula.session.getToken() }
            assertEquals(status, error.status)
            assertEquals(1, bench.refreshes().size, "status $status")
            assertIs<AuthState.SignedIn>(bench.tula.state.value)
            assertEquals("tula_rt_first", bench.storage.get(TEST_STORAGE_KEY))
        }
    }

    @Test
    fun `a 200 that is not session tokens installs nothing and keeps the session`() = runTest {
        for (body in listOf("""{"hello":"world"}""", """{"sessionId":"s"}""", "<html>a proxy</html>", "[]")) {
            val bench = Bench()
            bench.signIn()
            bench.engine.on("POST", REFRESH) { ok(body) }
            bench.clock.advance(61_000)

            assertEquals("response.invalid", caught { bench.tula.session.getToken() }.code, body)
            assertEquals(1, bench.refreshes().size)
            assertIs<AuthState.SignedIn>(bench.tula.state.value)
            assertEquals("tula_rt_first", bench.storage.get(TEST_STORAGE_KEY))
        }
    }

    @Test
    fun `retry-after makes getToken fail fast, and an explicit refresh still asks`() = runTest {
        val bench = Bench()
        bench.signIn()
        bench.engine.on("POST", REFRESH) {
            answer(429, errorJson("rate_limited", 429), mapOf("retry-after" to "30"))
        }
        bench.clock.advance(61_000)

        val first = caught { bench.tula.session.getToken() }
        assertEquals("rate_limited", first.code)
        assertEquals(30_000, first.retryAfterMs)
        // Inside the wait: the same error, and no request.
        bench.clock.advance(10_000)
        assertSame(first, caught { bench.tula.session.getToken() })
        assertEquals(1, bench.refreshes().size)
        // The application asking now is answered by the server.
        caught { bench.tula.session.refresh() }
        assertEquals(2, bench.refreshes().size)
        // After the wait an implicit refresh asks again.
        bench.clock.advance(31_000)
        bench.rotating()
        assertNotNull(bench.tula.session.getToken())
    }

    @Test
    fun `a wait the server asks for is capped`() = runTest {
        val bench = Bench()
        bench.signIn()
        bench.engine.on("POST", REFRESH) {
            answer(503, errorJson("service.unavailable", 503), mapOf("retry-after" to "86400"))
        }
        bench.clock.advance(61_000)
        caught { bench.tula.session.getToken() }
        bench.clock.advance(MAX_REFRESH_BACKOFF_MS + 1)
        bench.rotating()
        assertNotNull(bench.tula.session.getToken())
    }

    @Test
    fun `a token inside its skew is still used when the refresh cannot be made`() = runTest {
        val bench = Bench()
        bench.signIn()
        bench.engine.on("POST", REFRESH) { throw IOException("unreachable") }
        // Past the moment the client stops handing the token out, before it expires.
        bench.clock.advance(55_000)
        assertEquals(fakeJwt("first"), bench.tula.session.getToken())
        bench.clock.advance(6_000)
        assertEquals("network.failed", caught { bench.tula.session.getToken() }.code)
    }

    @Test
    fun `a refresh that worked but could not be stored says so, and the session goes on in memory`() = runTest {
        val storage = FlakyStorage()
        val bench = Bench(storage = storage)
        bench.signIn()
        bench.rotating()
        storage.failWrites = true

        val error = caught { bench.tula.session.refresh() }
        assertEquals("storage.failed", error.code)
        assertIs<AuthState.SignedIn>(bench.tula.state.value)
        // The new tokens are in use: the next refresh presents the one that was not stored.
        assertEquals(fakeJwt("refresh-1"), bench.tula.session.getToken())
        storage.failWrites = false
        bench.tula.session.refresh()
        assertEquals("""{"refreshToken":"tula_rt_refresh-1"}""", bench.refreshes().last().body)
    }

    @Test
    fun `sign-out ends the session here and on the server`() = runTest {
        val bench = Bench()
        bench.signIn()
        bench.engine.on("POST", SIGN_OUT) { answer(204, "") }

        bench.tula.session.signOut()
        assertEquals(AuthState.SignedOut, bench.tula.state.value)
        assertNull(bench.storage.get(TEST_STORAGE_KEY))
        assertEquals("""{"refreshToken":"tula_rt_first"}""", bench.engine.sent(SIGN_OUT).single().body)
        assertNull(bench.tula.session.getToken())
        // Again, with nothing to revoke: no request, no error.
        bench.tula.session.signOut()
        assertEquals(1, bench.engine.sent(SIGN_OUT).size)
    }

    @Test
    fun `a failed sign-out is not a sign-out, and the next one tells the server`() = runTest {
        val bench = Bench()
        bench.signIn()
        var reachable = false
        bench.engine.on("POST", SIGN_OUT) {
            if (!reachable) {
                throw IOException("unreachable")
            }
            answer(204, "")
        }

        val error = caught { bench.tula.session.signOut() }
        assertEquals("network.failed", error.code)
        // Signed out here all the same, and the stored token is gone.
        assertEquals(AuthState.SignedOut, bench.tula.state.value)
        assertNull(bench.storage.get(TEST_STORAGE_KEY))
        // Nothing but a sign-out presents the token that was kept for the retry.
        assertNull(bench.tula.session.refresh())
        assertEquals(0, bench.refreshes().size)

        reachable = true
        bench.tula.session.signOut()
        assertEquals("""{"refreshToken":"tula_rt_first"}""", bench.engine.sent(SIGN_OUT).last().body)
        // Delivered: a third sign-out has nothing to send.
        bench.tula.session.signOut()
        assertEquals(2, bench.engine.sent(SIGN_OUT).size)
    }

    @Test
    fun `the undelivered token is forgotten when the server says the session is over`() = runTest {
        val bench = Bench()
        bench.signIn()
        bench.engine.on("POST", SIGN_OUT) { answer(401, errorJson("session.revoked", 401)) }
        assertEquals("session.revoked", caught { bench.tula.session.signOut() }.code)
        bench.tula.session.signOut()
        assertEquals(1, bench.engine.sent(SIGN_OUT).size)
    }

    @Test
    fun `the undelivered token is forgotten when a new session is adopted`() = runTest {
        val bench = Bench()
        bench.signIn()
        bench.engine.on("POST", SIGN_OUT) { throw IOException("unreachable") }
        caught { bench.tula.session.signOut() }

        bench.signIn("second")
        bench.engine.on("POST", SIGN_OUT) { answer(204, "") }
        bench.tula.session.signOut()
        bench.tula.session.signOut()
        // The new session's token, once; never the old one's.
        assertEquals(
            listOf("""{"refreshToken":"tula_rt_first"}""", """{"refreshToken":"tula_rt_second"}"""),
            bench.engine.sent(SIGN_OUT).map { it.body },
        )
    }

    @Test
    fun `a sign-out whose stored token cannot be removed says so, after telling the server`() = runTest {
        val storage = FlakyStorage()
        val bench = Bench(storage = storage)
        bench.signIn()
        bench.engine.on("POST", SIGN_OUT) { answer(204, "") }
        storage.failRemovals = true

        assertEquals("storage.failed", caught { bench.tula.session.signOut() }.code)
        assertEquals(AuthState.SignedOut, bench.tula.state.value)
        assertEquals(1, bench.engine.sent(SIGN_OUT).size)
    }

    @Test
    fun `a sign-out before load reads the stored token and revokes it`() = runTest {
        val bench = Bench()
        bench.storage.set(TEST_STORAGE_KEY, "tula_rt_never-loaded")
        bench.engine.on("POST", SIGN_OUT) { answer(204, "") }
        bench.tula.session.signOut()
        assertEquals("""{"refreshToken":"tula_rt_never-loaded"}""", bench.engine.sent(SIGN_OUT).single().body)
        assertNull(bench.storage.get(TEST_STORAGE_KEY))
        assertEquals(AuthState.SignedOut, bench.tula.state.value)
    }

    @Test
    fun `a refresh that loses to a sign-out installs nothing, and its token is revoked`() = runTest {
        val bench = Bench()
        bench.signIn()
        val gate = CompletableDeferred<Unit>()
        bench.engine.on("POST", REFRESH) {
            gate.await()
            ok(tokensJson("late"))
        }
        bench.engine.on("POST", SIGN_OUT) { answer(204, "") }
        bench.clock.advance(61_000)

        val refreshing = async { bench.tula.session.getToken() }
        while (bench.refreshes().isEmpty()) {
            yield()
        }
        val leaving = async { bench.tula.session.signOut() }
        // Signed out at once, whatever the network does next.
        while (bench.tula.state.value != AuthState.SignedOut) {
            yield()
        }
        gate.complete(Unit)
        leaving.await()

        assertNull(refreshing.await())
        assertEquals(AuthState.SignedOut, bench.tula.state.value)
        assertNull(bench.storage.get(TEST_STORAGE_KEY))
        // The newest token is the one the server is told to end.
        assertEquals("""{"refreshToken":"tula_rt_late"}""", bench.engine.sent(SIGN_OUT).single().body)
        assertNull(bench.tula.session.getToken())
    }

    @Test
    fun `a refused refresh that arrives after a new sign-in does not sign the new session out`() = runTest {
        val bench = Bench()
        bench.signIn()
        val gate = CompletableDeferred<Unit>()
        bench.engine.on("POST", REFRESH) {
            gate.await()
            answer(401, errorJson("session.revoked", 401))
        }
        bench.engine.on("POST", SIGN_OUT) { answer(204, "") }
        bench.clock.advance(61_000)
        val stale = async { bench.tula.session.getToken() }
        while (bench.refreshes().isEmpty()) {
            yield()
        }
        // The user signs out and in again while the old refresh is still out.
        val leaving = async { bench.tula.session.signOut() }
        while (bench.tula.state.value != AuthState.SignedOut) {
            yield()
        }
        gate.complete(Unit)
        leaving.await()
        stale.await()
        bench.signIn("second")

        assertIs<AuthState.SignedIn>(bench.tula.state.value)
        assertEquals(fakeJwt("second"), bench.tula.session.getToken())
        assertEquals("tula_rt_second", bench.storage.get(TEST_STORAGE_KEY))
    }

    @Test
    fun `an authorized call is retried once after the server refuses the token`() = runTest {
        val bench = Bench()
        bench.signIn()
        bench.rotating()
        val calls = AtomicInteger()
        bench.engine.on("GET", "/v1/client/me") {
            if (calls.incrementAndGet() == 1) {
                answer(401, errorJson("session.expired", 401))
            } else {
                ok(userJson("after@example.com"))
            }
        }

        assertEquals("after@example.com", bench.tula.user().email)
        assertEquals(1, bench.refreshes().size)
        val sent = bench.engine.sent("/v1/client/me").takeLast(2).map { it.headers["authorization"] }
        assertEquals(listOf("Bearer ${fakeJwt("first")}", "Bearer ${fakeJwt("refresh-1")}"), sent)
        assertEquals("after@example.com", (bench.tula.state.value as AuthState.SignedIn).user?.email)
    }

    @Test
    fun `a second refusal goes to the caller, and other errors are not retried`() = runTest {
        val bench = Bench()
        bench.signIn()
        bench.rotating()
        bench.engine.on("GET", "/v1/client/me") { answer(401, errorJson("auth.unauthenticated", 401)) }
        val before = bench.engine.sent("/v1/client/me").size
        assertEquals("auth.unauthenticated", caught { bench.tula.user() }.code)
        assertEquals(before + 2, bench.engine.sent("/v1/client/me").size)

        bench.engine.on("GET", "/v1/client/me") { answer(403, errorJson("auth.step_up_required", 403)) }
        assertEquals("auth.step_up_required", caught { bench.tula.user() }.code)
        assertEquals(before + 3, bench.engine.sent("/v1/client/me").size)
        assertEquals(1, bench.refreshes().size)
    }

    @Test
    fun `an authorized call with nobody signed in asks nothing`() = runTest {
        val bench = Bench()
        bench.tula.load()
        val error = caught { bench.tula.user() }
        assertEquals("auth.unauthenticated", error.code)
        assertEquals(401, error.status)
        assertEquals(emptyList(), bench.engine.requests)
    }

    @Test
    fun `a profile that cannot be fetched leaves the user out and the session in`() = runTest {
        val bench = Bench()
        bench.engine.on("POST", "/v1/client/sign-ins") { ok(attemptJson(NEEDS_PASSWORD)) }
        bench.engine.on("POST", "/v1/client/sign-ins/attempt-1/password") {
            ok(attemptJson(COMPLETE, session = tokensJson("first")))
        }
        bench.engine.on("GET", "/v1/client/me") { answer(500, errorJson("internal", 500)) }
        bench.tula.signIn("maya@example.com").submitPassword("a-password-nobody-uses")

        val state = bench.tula.state.value
        assertIs<AuthState.SignedIn>(state)
        assertNull(state.user)
        // Fetched later by the application.
        bench.engine.on("GET", "/v1/client/me") { ok(userJson()) }
        bench.tula.user()
        assertEquals("maya@example.com", (bench.tula.state.value as AuthState.SignedIn).user?.email)
    }

    @Test
    fun `a session with no access token is not a session for this client`() = runTest {
        val bench = Bench()
        bench.engine.on("POST", "/v1/client/sign-ins") { ok(attemptJson(NEEDS_PASSWORD)) }
        bench.engine.on("POST", "/v1/client/sign-ins/attempt-1/password") {
            ok(attemptJson(COMPLETE, session = """{"sessionId":"stateful-1"}"""))
        }
        val flow = bench.tula.signIn("maya@example.com")
        assertEquals("response.invalid", caught { flow.submitPassword("a-password-nobody-uses") }.code)
        assertEquals(AuthState.Loading, bench.tula.state.value)
        assertNull(bench.storage.get(TEST_STORAGE_KEY))
    }

    @Test
    fun `a token that is no jwt takes its life from the expiry beside it`() = runTest {
        val bench = Bench()
        val future = "2099-01-01T00:00:00.000Z"
        bench.storage.set(TEST_STORAGE_KEY, "tula_rt_stored")
        bench.engine.on("POST", REFRESH) {
            ok("""{"sessionId":"s","accessToken":"opaque","accessTokenExpiresAt":"$future","refreshToken":"tula_rt_n"}""")
        }
        bench.engine.on("GET", "/v1/client/me") { ok(userJson()) }
        assertIs<AuthState.SignedIn>(bench.tula.load())
        assertEquals("opaque", bench.tula.session.getToken())
        assertEquals(1, bench.refreshes().size)
    }

    @Test
    fun `the state says who is signed in without printing their address`() = runTest {
        val bench = Bench()
        bench.signIn()
        val text = bench.tula.state.value.toString()
        assertEquals("SignedIn(sessionId=session-1)", text)
        assertEquals("Loading", AuthState.Loading.toString())
        assertEquals("SignedOut", AuthState.SignedOut.toString())
    }

    @Test
    fun `a closed client stops its own work and keeps what is stored`() = runTest {
        val bench = Bench()
        bench.signIn()
        bench.tula.close()
        assertEquals("tula_rt_first", bench.storage.get(TEST_STORAGE_KEY))
    }
}
