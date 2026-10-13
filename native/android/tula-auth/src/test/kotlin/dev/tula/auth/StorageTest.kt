package dev.tula.auth

import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpServer
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.withTimeout
import java.net.InetSocketAddress
import java.security.GeneralSecurityException
import java.security.SecureRandom
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import javax.crypto.AEADBadTagException
import javax.crypto.SecretKey
import javax.crypto.spec.SecretKeySpec
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * The sealing key in memory, so that a JVM test runs the sealer a device runs
 * ([AesGcmSealer]). `null` stands for a key that no longer exists; `broken` for a key store
 * that cannot be reached.
 */
private class MemoryKeys(@Volatile var key: SecretKey? = newKey()) : SealingKeys {
    @Volatile
    var broken = false

    override fun existing(): SecretKey? {
        if (broken) {
            throw GeneralSecurityException("the key store is unavailable")
        }
        return key
    }

    override fun obtain(): SecretKey = existing() ?: newKey().also { key = it }

    companion object {
        fun newKey(): SecretKey = SecretKeySpec(ByteArray(32).also { SecureRandom().nextBytes(it) }, "AES")
    }
}

private class MapEntries : SealedEntries {
    val values = HashMap<String, String>()

    @Volatile
    var failWrites = false

    override fun read(key: String): String? = synchronized(values) { values[key] }

    override fun write(key: String, value: String) {
        if (failWrites) {
            throw IllegalStateException("the entry could not be saved")
        }
        synchronized(values) { values[key] = value }
    }

    override fun delete(key: String) {
        synchronized(values) { values.remove(key) }
    }
}

/** The storages, and the default engine against a server on this machine. */
class StorageTest {
    @Test
    fun `the memory storage keeps, replaces and removes`() = runTest {
        val storage = MemoryTokenStorage()
        assertNull(storage.get("a"))
        storage.set("a", "one")
        storage.set("a", "two")
        assertEquals("two", storage.get("a"))
        storage.remove("a")
        storage.remove("a")
        assertNull(storage.get("a"))
    }

    @Test
    fun `the sealed storage writes nothing a reader of the entries could use`() = runTest {
        val entries = MapEntries()
        val storage = SealedTokenStorage(AesGcmSealer(MemoryKeys()), entries)
        storage.set("tula.refresh.x", "tula_rt_a-refresh-token")
        assertEquals("tula_rt_a-refresh-token", storage.get("tula.refresh.x"))

        val written = entries.values.getValue("tula.refresh.x")
        assertFalse(written.contains("tula_rt_"))
        assertFalse(String(java.util.Base64.getDecoder().decode(written), Charsets.ISO_8859_1).contains("a-refresh-token"))
        // Sealed again, the same value is other bytes: a fresh nonce every time.
        storage.set("tula.refresh.x", "tula_rt_a-refresh-token")
        assertFalse(written == entries.values.getValue("tula.refresh.x"))

        storage.remove("tula.refresh.x")
        assertNull(storage.get("tula.refresh.x"))
        assertTrue(entries.values.isEmpty())
    }

    @Test
    fun `a value whose key is gone is no token, and is removed`() = runTest {
        val entries = MapEntries()
        val keys = MemoryKeys()
        val storage = SealedTokenStorage(AesGcmSealer(keys), entries)
        storage.set("one", "tula_rt_of-one")
        // A backup restored onto another phone: the entry is there, the key is not.
        keys.key = null
        assertNull(storage.get("one"))
        assertTrue(entries.values.isEmpty())
        // Reading made no key: only a seal does.
        assertNull(keys.key)
    }

    @Test
    fun `a tag that fails while the key exists is thrown, and nothing is removed`() = runTest {
        // A key store that answers wrongly once must not cost the user their session, and
        // nothing can tell that from an entry that was altered.
        val entries = MapEntries()
        val keys = MemoryKeys()
        val storage = SealedTokenStorage(AesGcmSealer(keys), entries)
        storage.set("one", "tula_rt_of-one")
        val written = entries.values.getValue("one")

        // Moved under another name: the name is bound in.
        entries.values["two"] = written
        assertFailsWith<AEADBadTagException> { storage.get("two") }
        assertEquals(written, entries.values["two"])

        // One bit of the ciphertext turned.
        val altered = java.util.Base64.getDecoder().decode(written)
        altered[altered.size - 1] = (altered[altered.size - 1].toInt() xor 1).toByte()
        entries.values["one"] = java.util.Base64.getEncoder().encodeToString(altered)
        assertFailsWith<AEADBadTagException> { storage.get("one") }
        assertTrue(entries.values.containsKey("one"))

        // Another key than the one that sealed it (a restore onto a device that has one).
        entries.values["one"] = written
        val sealing = keys.key
        keys.key = MemoryKeys.newKey()
        assertFailsWith<AEADBadTagException> { storage.get("one") }
        assertEquals(written, entries.values["one"])
        // The same entry opens once the key store answers with the right key again.
        keys.key = sealing
        assertEquals("tula_rt_of-one", storage.get("one"))
    }

    @Test
    fun `an entry removed as unreadable does not take a token written meanwhile`() = runTest {
        // A start reads an entry nobody can open while a sign-in stores its token: the
        // removal of the old entry must not land on the new one.
        val read = CountDownLatch(1)
        val proceed = CountDownLatch(1)
        val map = MapEntries()
        val entries = object : SealedEntries by map {
            override fun read(key: String): String? = map.read(key).also {
                if (read.count > 0) {
                    read.countDown()
                    proceed.await(10, TimeUnit.SECONDS)
                }
            }
        }
        val storage = SealedTokenStorage(AesGcmSealer(MemoryKeys()), entries)
        map.values["one"] = "not base64 !"
        val reading = async { storage.get("one") }
        withTimeout(10_000) { while (read.count > 0) delay(5) }
        val writing = async { storage.set("one", "tula_rt_new") }
        // Long enough for a write that is not held back to land before the removal.
        delay(300)
        proceed.countDown()
        assertNull(reading.await())
        writing.await()
        assertEquals("tula_rt_new", storage.get("one"))
    }

    @Test
    fun `bytes the sealer did not write are no token, and are removed`() = runTest {
        val entries = MapEntries()
        val storage = SealedTokenStorage(AesGcmSealer(MemoryKeys()), entries)
        storage.set("one", "tula_rt_of-one")
        val sealed = java.util.Base64.getDecoder().decode(entries.values.getValue("one"))
        val forms = listOf(
            ByteArray(0),
            byteArrayOf(1),
            // Another format.
            sealed.copyOf().also { it[0] = 2 },
            // Another nonce length than the one this sealer writes.
            sealed.copyOf().also { it[1] = 16 },
            // Cut short: no room for a nonce and a tag.
            sealed.copyOf(2 + 12 + 15),
        )
        for (form in forms) {
            entries.values["one"] = java.util.Base64.getEncoder().encodeToString(form)
            assertNull(storage.get("one"))
            assertFalse(entries.values.containsKey("one"))
        }
    }

    @Test
    fun `a key store or an entry store that fails is thrown, never read as no token`() = runTest {
        val entries = MapEntries()
        val keys = MemoryKeys()
        val storage = SealedTokenStorage(AesGcmSealer(keys), entries)
        storage.set("one", "tula_rt_of-one")

        keys.broken = true
        assertFailsWith<GeneralSecurityException> { storage.get("one") }
        assertFailsWith<GeneralSecurityException> { storage.set("one", "tula_rt_next") }
        // The entry is left alone: the store may answer later.
        assertTrue(entries.values.containsKey("one"))
        keys.broken = false
        assertEquals("tula_rt_of-one", storage.get("one"))

        entries.failWrites = true
        assertFailsWith<IllegalStateException> { storage.set("one", "tula_rt_next") }
    }

    @Test
    fun `an entry this storage could not have written is no token, and is removed`() = runTest {
        // It can never be opened, whatever the key store does later. Thrown, it would be
        // `storage.failed` at every start, and a sign-out could not clear it either.
        val entries = MapEntries()
        val bench = Bench(storage = SealedTokenStorage(AesGcmSealer(MemoryKeys()), entries))
        entries.values[TEST_STORAGE_KEY] = "not base64 !"
        assertEquals(AuthState.SignedOut, bench.tula.load())
        assertTrue(entries.values.isEmpty())
    }

    @Test
    fun `a client over a sealed storage that fails keeps its session and says storage_failed`() = runTest {
        val keys = MemoryKeys()
        val bench = Bench(storage = SealedTokenStorage(AesGcmSealer(keys), MapEntries()))
        bench.signIn()
        bench.engine.on("POST", "/v1/client/sessions/refresh") { ok(tokensJson("next")) }
        keys.broken = true
        assertEquals("storage.failed", caught { bench.tula.session.refresh() }.code)
        assertIs<AuthState.SignedIn>(bench.tula.state.value)
    }

    @Test
    fun `an entry whose tag fails is storage_failed at a start, is left alone, and a sign-out clears it`() = runTest {
        val entries = MapEntries()
        val keys = MemoryKeys()
        val sealed = SealedTokenStorage(AesGcmSealer(keys), entries)
        sealed.set(TEST_STORAGE_KEY, "tula_rt_stored")
        val written = entries.values.getValue(TEST_STORAGE_KEY)
        keys.key = MemoryKeys.newKey()

        val bench = Bench(storage = sealed)
        assertEquals("storage.failed", caught { bench.tula.session.refresh() }.code)
        // Not "no token": nothing was deleted, and no request was made on a guess.
        assertEquals(written, entries.values[TEST_STORAGE_KEY])
        assertTrue(bench.engine.requests.isEmpty())

        // The token could not be read, so the server cannot be told: the sign-out says so.
        // The entry is cleared all the same, and the next start is an ordinary signed-out one.
        assertEquals("storage.failed", caught { bench.tula.session.signOut() }.code)
        assertTrue(entries.values.isEmpty())
        assertEquals(AuthState.SignedOut, bench.tula.state.value)
        assertEquals(AuthState.SignedOut, Bench(storage = sealed).tula.load())
    }

    @Test
    fun `a sign-in writes over an entry whose tag fails`() = runTest {
        val entries = MapEntries()
        val keys = MemoryKeys()
        val sealed = SealedTokenStorage(AesGcmSealer(keys), entries)
        sealed.set(TEST_STORAGE_KEY, "tula_rt_stored")
        keys.key = MemoryKeys.newKey()

        val bench = Bench(storage = sealed)
        bench.signIn()
        assertIs<AuthState.SignedIn>(bench.tula.state.value)
        assertEquals("tula_rt_first", sealed.get(TEST_STORAGE_KEY))
    }

    /** A server on a loopback port for one test. */
    private fun serve(handler: (HttpExchange) -> Unit, test: suspend CoroutineScope.(String) -> Unit) {
        val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        val threads = Executors.newCachedThreadPool()
        server.executor = threads
        server.createContext("/") { exchange ->
            try {
                handler(exchange)
            } finally {
                exchange.close()
            }
        }
        server.start()
        try {
            runTest { test("http://127.0.0.1:${server.address.port}") }
        } finally {
            server.stop(0)
            threads.shutdownNow()
        }
    }

    private fun HttpExchange.reply(status: Int, body: String, headers: Map<String, String> = emptyMap()) {
        for ((name, value) in headers) {
            responseHeaders.add(name, value)
        }
        val bytes = body.toByteArray(Charsets.UTF_8)
        if (bytes.isEmpty()) {
            sendResponseHeaders(status, -1)
        } else {
            sendResponseHeaders(status, bytes.size.toLong())
            responseBody.use { it.write(bytes) }
        }
    }

    @Test
    fun `the default engine sends the method, headers and body, and reads the answer`() {
        var seen = ""
        serve({ exchange ->
            seen = listOf(
                exchange.requestMethod,
                exchange.requestURI.toString(),
                exchange.requestHeaders.getFirst("x-tula-client"),
                exchange.requestHeaders.getFirst("content-type"),
                exchange.requestBody.readBytes().toString(Charsets.UTF_8),
            ).joinToString(" | ")
            exchange.reply(201, """{"ok":"ja ✓"}""", mapOf("Retry-After" to "3", "X-Twice" to "one"))
        }) { base ->
            val response = UrlConnectionEngine().send(
                HttpRequest(
                    "POST",
                    "$base/v1/thing?x=1",
                    mapOf("x-tula-client" to "android", "content-type" to "application/json"),
                    """{"name":"Zoë"}""",
                    5_000,
                ),
            )
            assertEquals("""POST | /v1/thing?x=1 | android | application/json | {"name":"Zoë"}""", seen)
            assertEquals(201, response.status)
            assertEquals("""{"ok":"ja ✓"}""", response.body)
            // Names are lower case, whatever the server wrote.
            assertEquals("3", response.headers["retry-after"])
            assertEquals("one", response.headers["x-twice"])
        }
    }

    @Test
    fun `the default engine reads the body of a 401 and a 407 answer to a request that had a body`() {
        // The JDK's connection drops such an answer's body when the request's body was
        // streamed: every refused sign-in and every ended session is a 401 with a code.
        serve({ exchange ->
            exchange.requestBody.readBytes()
            val status = if (exchange.requestURI.path == "/proxy") 407 else 401
            exchange.reply(status, """{"code":"auth.invalid_credentials"}""")
        }) { base ->
            val engine = UrlConnectionEngine()
            for (path in listOf("/refused", "/proxy")) {
                val response = engine.send(
                    HttpRequest("POST", base + path, mapOf("content-type" to "application/json"), """{"a":1}""", 5_000),
                )
                assertEquals("""{"code":"auth.invalid_credentials"}""", response.body)
            }
        }
    }

    @Test
    fun `the default engine hands back an error answer, an empty one and a redirect as they are`() {
        serve({ exchange ->
            when (exchange.requestURI.path) {
                "/error" -> exchange.reply(422, """{"code":"validation.failed"}""")
                "/empty" -> exchange.reply(204, "")
                "/gone" -> exchange.reply(500, "")
                else -> exchange.reply(302, "", mapOf("Location" to "/error"))
            }
        }) { base ->
            val engine = UrlConnectionEngine()
            suspend fun get(path: String) = engine.send(HttpRequest("GET", base + path, emptyMap(), null, 5_000))
            assertEquals(422 to """{"code":"validation.failed"}""", get("/error").let { it.status to it.body })
            assertEquals(204 to "", get("/empty").let { it.status to it.body })
            assertEquals(500 to "", get("/gone").let { it.status to it.body })
            // Not followed: the client never goes where an answer points.
            val redirect = get("/moved")
            assertEquals(302, redirect.status)
            assertEquals("/error", redirect.headers["location"])
        }
    }

    @Test
    fun `the default engine gives up a request whose caller is cancelled`() {
        val released = CountDownLatch(1)
        serve({ exchange ->
            // Never answers while the test runs.
            released.await()
            exchange.reply(200, "{}")
        }) { base ->
            val engine = UrlConnectionEngine()
            val asking = async {
                engine.send(HttpRequest("GET", "$base/slow", emptyMap(), null, 60_000))
            }
            delay(200)
            // Ends at once, not after the request's own minute.
            withTimeout(5_000) {
                asking.cancel()
                asking.join()
            }
            assertTrue(asking.isCancelled)
            released.countDown()
        }
    }

    @Test
    fun `the default engine's own timeout, an answer that is too large and no server are failures`() {
        val released = CountDownLatch(1)
        serve({ exchange ->
            when (exchange.requestURI.path) {
                "/large" -> {
                    exchange.sendResponseHeaders(200, 0)
                    val chunk = ByteArray(64 * 1024) { 'a'.code.toByte() }
                    try {
                        exchange.responseBody.use { body -> repeat(20) { body.write(chunk) } }
                    } catch (_: java.io.IOException) {
                        // The engine stopped reading: that is the test.
                    }
                }
                else -> {
                    released.await()
                    exchange.reply(200, "{}")
                }
            }
        }) { base ->
            val engine = UrlConnectionEngine()
            assertFailsWith<java.net.SocketTimeoutException> {
                engine.send(HttpRequest("GET", "$base/slow", emptyMap(), null, 200))
            }
            released.countDown()
            assertFailsWith<java.io.IOException> {
                engine.send(HttpRequest("GET", "$base/large", emptyMap(), null, 5_000))
            }
            assertFailsWith<java.io.IOException> {
                engine.send(HttpRequest("GET", "ftp://127.0.0.1/x", emptyMap(), null, 1_000))
            }
            assertFailsWith<java.io.IOException> {
                engine.send(HttpRequest("GET", "not an address", emptyMap(), null, 1_000))
            }
        }
        // Nothing listens on a port that was just closed.
        val closed = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0).let { server ->
            server.start()
            server.address.port.also { server.stop(0) }
        }
        runTest {
            val bench = TulaClient(TEST_KEY, "http://127.0.0.1:$closed", MemoryTokenStorage())
            assertEquals("network.failed", caught { bench.config() }.code)
            bench.close()
        }
    }
}
