package dev.tula.auth

import dev.tula.auth.generated.OAuthProvider
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.cancel
import kotlinx.coroutines.yield
import java.util.Base64
import java.util.concurrent.atomic.AtomicInteger
import kotlin.coroutines.cancellation.CancellationException
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNotEquals
import kotlin.test.assertNull
import kotlin.test.assertSame
import kotlin.test.assertTrue

/** A wait short enough for a test and long enough for a busy runner to start a coroutine. */
private const val SHORT_MS = 150L

/** A key store a test bends: it can throw, say the key is gone, or never answer. */
private class BentKeyStore : DeviceKeyStore {
    val inner = SoftwareDeviceKeyStore()
    val looks = AtomicInteger()
    val makes = AtomicInteger()
    val removals = AtomicInteger()

    /** What the next looks do, oldest first; past the end a look is the real one. */
    val script = ArrayDeque<suspend () -> DeviceKey?>()

    @Volatile
    var failMake: Exception? = null

    @Volatile
    var failRemove: Exception? = null

    @Volatile
    var stallRemove = false

    override suspend fun existing(): DeviceKey? {
        looks.incrementAndGet()
        val next = synchronized(script) { script.removeFirstOrNull() }
        return if (next == null) inner.existing() else next()
    }

    override suspend fun create(): DeviceKey {
        makes.incrementAndGet()
        failMake?.let { throw it }
        return inner.create()
    }

    override suspend fun remove() {
        removals.incrementAndGet()
        if (stallRemove) {
            awaitCancellation()
        }
        failRemove?.let { throw it }
        inner.remove()
    }
}

/**
 * The client's side of the sheets, the browser and the device key, on fakes: what no journey
 * against the real API can arrange (a store that never answers, two sheets at once, a
 * signature of the wrong size).
 */
class NativeWaysTest {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    private fun gate(ceilingMs: Long = SHEET_CEILING_MS) = CeremonyGate(scope, ceilingMs) { emptyMap() }

    private fun proofs(store: DeviceKeyStore) = DeviceProofs(store, scope) { emptyMap() }

    @Test
    fun `one sheet at a time - a second ceremony is refused as busy while the first is up, and the place is given back when it ends or throws`() =
        runTest {
            val gate = gate()
            val up = CompletableDeferred<Unit>()
            val close = CompletableDeferred<Unit>()
            val first = async {
                gate.ceremony {
                    up.complete(Unit)
                    close.await()
                    "first"
                }
            }
            up.await()
            val refused = caught { gate.ceremony { "second" } }
            assertEquals("flow.busy", refused.code)
            assertNull(refused.cause)
            close.complete(Unit)
            assertEquals("first", first.await())
            assertEquals("third", gate.ceremony { "third" })
            // A ceremony that throws gives the place back too.
            assertFailsWith<IllegalStateException> { gate.ceremony { throw IllegalStateException("x") } }
            assertEquals("fourth", gate.ceremony { "fourth" })
        }

    @Test
    fun `a sheet's failure is one of the client's codes and nothing of what the sheet threw, and a dismissal is no error`() =
        runTest {
            val gate = gate()
            val rows = listOf(
                Triple(CeremonyGate.Kind.PASSKEY, SheetFailure.ALREADY_ON_DEVICE, "passkey.already_on_device"),
                Triple(CeremonyGate.Kind.PASSKEY, SheetFailure.UNSUPPORTED, "passkey.unsupported"),
                Triple(CeremonyGate.Kind.PASSKEY, SheetFailure.FAILED, "passkey.failed"),
                Triple(CeremonyGate.Kind.PROVIDER, SheetFailure.ALREADY_ON_DEVICE, "provider.failed"),
                Triple(CeremonyGate.Kind.PROVIDER, SheetFailure.UNSUPPORTED, "provider.unsupported"),
                Triple(CeremonyGate.Kind.PROVIDER, SheetFailure.FAILED, "provider.failed"),
            )
            for ((kind, failure, code) in rows) {
                val error = caught { gate.sheet<String>(kind) { throw TulaSheetException(failure) } }
                assertEquals(code, error.code, "$kind $failure")
                assertNull(error.cause)
            }
            for (kind in CeremonyGate.Kind.values()) {
                assertNull(gate.sheet<String>(kind) { throw TulaSheetException(SheetFailure.DISMISSED) })
                // A sheet that cancels itself is the user putting it away.
                assertNull(gate.sheet<String>(kind) { throw CancellationException("closed") })
                assertNull(gate.sheet<String>(kind) { null })
                val canary = "the-platforms-own-words-7731"
                val error = caught { gate.sheet<String>(kind) { throw IllegalStateException(canary) } }
                assertTrue(error.code.endsWith(".failed"))
                assertFalse(canary in "$error ${error.message} ${error.cause}")
            }
            assertEquals("answer", gate.sheet(CeremonyGate.Kind.PASSKEY) { "answer" })
        }

    @Test
    fun `a sheet that never answers gives its place back at the ceiling, as a dismissal, and what it says later is used by nobody`() =
        runTest {
            val gate = gate(ceilingMs = SHORT_MS)
            val cancelled = CompletableDeferred<Unit>()
            val outcome = gate.ceremony {
                gate.sheet<String>(CeremonyGate.Kind.PASSKEY) {
                    try {
                        awaitCancellation()
                    } finally {
                        cancelled.complete(Unit)
                    }
                }
            }
            assertNull(outcome)
            cancelled.await()
            assertEquals("next", gate.ceremony { "next" })
            // No time at all is no sheet at all.
            assertNull(bounded(scope, 0) { "never run" })
        }

    @Test
    fun `a caller that gives up while a sheet is up is cancelled, not answered`() = runTest {
        val gate = gate()
        val up = CompletableDeferred<Unit>()
        val waiting = async {
            gate.sheet<String>(CeremonyGate.Kind.PROVIDER) {
                up.complete(Unit)
                awaitCancellation()
            }
        }
        up.await()
        waiting.cancel()
        assertFailsWith<CancellationException> { waiting.await() }
    }

    @Test
    fun `a passkey's options and credentials are sent on only in the alphabet the server writes`() {
        assertTrue(PasskeyChecks.isBase64Url("AZaz09_-"))
        for (bad in listOf("", "a b", "a+b", "a/b", "a=", "ä")) {
            assertFalse(PasskeyChecks.isBase64Url(bad), bad)
        }
    }

    @Test
    fun `a client with no sheet, browser or key store refuses before any request, and one sheet is up at a time for the whole client`() =
        runTest {
            val bare = Bench()
            assertEquals("passkey.unsupported", caught { bare.tula.signInWithPasskey() }.code)
            assertEquals("provider.unsupported", caught { bare.tula.signInWithGoogle() }.code)
            assertEquals(
                "provider.unsupported",
                caught { bare.tula.signIn(OAuthProvider.Google, "https://app.example.com/cb") }.code,
            )
            assertEquals(emptyList(), bare.engine.paths())

            val engine = ScriptedEngine()
            val up = CompletableDeferred<Unit>()
            val close = CompletableDeferred<Unit>()
            engine.on("POST", "/v1/client/sign-ins/oauth") {
                ok(
                    """{"attempt":${attemptJson("""{"status":"needs_first_factor","strategies":[]}""")},""" +
                        """"authorizationUrl":"https://provider.example/authorize","binding":"tula_ob_unit"}""",
                )
            }
            val tula = TulaClient(
                publishableKey = TEST_KEY,
                baseUrl = TEST_BASE,
                storage = MemoryTokenStorage(),
                http = engine,
                browser = { _, _ ->
                    up.complete(Unit)
                    close.await()
                    null
                },
                google = { "never asked" },
            )
            val first = async { tula.signIn(OAuthProvider.Google, "https://app.example.com/cb") }
            up.await()
            val sent = engine.requests.size
            assertEquals("flow.busy", caught { tula.signInWithGoogle() }.code)
            assertEquals("flow.busy", caught { tula.signIn(OAuthProvider.Github, "https://app.example.com/cb") }.code)
            assertEquals(sent, engine.requests.size)
            close.complete(Unit)
            assertSame(ProviderOutcome.Cancelled, first.await())
            assertEquals("no_answer", (tula.retryProviderSignIn() as ProviderOutcome.Refused).refusal.toString())
            tula.close()
        }

    @Test
    fun `what a browser returns is read only when it is the redirect URL, character for character, followed by a fragment`() {
        val redirect = "com.example.app:/oauth/callback"
        fun read(returned: String) = ProviderRoundTrip.read(returned, redirect)

        val (answer, refusal) = read("$redirect#tula_ticket=tula_ot_1&tula_attempt=a-1")
        assertNull(refusal)
        assertEquals(ProviderRoundTrip.Answer("tula_ot_1", "a-1", null), answer)
        // The first of a name counts, a value is percent-decoded, and an unknown name is passed over.
        assertEquals(
            ProviderRoundTrip.Answer("one", "a b", null),
            read("$redirect#x=1&tula_ticket=one&tula_ticket=two&tula_attempt=a%20b&flag").first,
        )
        assertEquals(
            ProviderRoundTrip.Answer(null, null, "oauth.access_denied"),
            read("$redirect#tula_error=oauth.access_denied").first,
        )

        val unexpected = listOf(
            "$redirect/more#tula_ticket=t",
            "$redirect?x=1#tula_ticket=t",
            "COM.EXAMPLE.APP:/oauth/callback#tula_ticket=t",
            "com.example.app://oauth/callback#tula_ticket=t",
            " $redirect#tula_ticket=t",
            "https://evil.example/#tula_ticket=t",
            "#tula_ticket=t",
        )
        for (returned in unexpected) {
            assertEquals(null to ProviderRefusal.UnexpectedReturn, read(returned), returned)
        }
        val silent = listOf(
            redirect,
            "",
            "$redirect?tula_ticket=t",
            "$redirect#",
            "$redirect#hello=1",
            "$redirect#tula_ticket=",
            // A value that is not text is not a value.
            "$redirect#tula_ticket=%zz",
            "$redirect#tula_ticket=%4",
            "$redirect#tula_ticket=%ff%fe",
        )
        for (returned in silent) {
            assertEquals(null to ProviderRefusal.NoAnswer, read(returned), returned)
        }
        // An error the contract does not define is not passed on in the server's name.
        assertEquals("oauth.provider_error", ProviderRoundTrip.known("made.up_code"))
        assertEquals("oauth.access_denied", ProviderRoundTrip.known("oauth.access_denied"))
        assertEquals(
            listOf("unexpected_return", "no_answer", "not_started_here", "a.code"),
            listOf(
                ProviderRefusal.UnexpectedReturn,
                ProviderRefusal.NoAnswer,
                ProviderRefusal.NotStartedHere,
                ProviderRefusal.Failed("a.code"),
            ).map { it.toString() },
        )
    }

    /** A client whose browser hands back a ticket for the attempt the scripted start made. */
    private class Returning(val clock: FakeClock = FakeClock()) {
        val engine = ScriptedEngine()
        val redirect = "https://app.example.com/cb"
        val tula = TulaClient(
            publishableKey = TEST_KEY,
            baseUrl = TEST_BASE,
            storage = MemoryTokenStorage(),
            http = engine,
            clock = clock,
            browser = { _, redirectUrl -> "$redirectUrl#tula_ticket=tula_ot_unit&tula_attempt=attempt-1" },
        )
        val exchange = "/v1/client/sign-ins/oauth/exchange"

        init {
            engine.on("POST", "/v1/client/sign-ins/oauth") {
                ok(
                    """{"attempt":${attemptJson("""{"status":"needs_first_factor","strategies":[]}""")},""" +
                        """"authorizationUrl":"https://provider.example/authorize","binding":"tula_ob_unit"}""",
                )
            }
            engine.on("GET", "/v1/client/me") { ok(userJson()) }
        }
    }

    @Test
    fun `a ticket whose exchange got no answer is kept for one more try, for a minute, and an answer about it forgets it`() =
        runTest {
            val bench = Returning()
            val asked = AtomicInteger()
            bench.engine.on("POST", bench.exchange) {
                if (asked.incrementAndGet() == 1) {
                    throw java.io.IOException("the connection died")
                }
                ok(attemptJson(COMPLETE, session = tokensJson("first")))
            }
            val lost = caught { bench.tula.signIn(OAuthProvider.Google, bench.redirect) }
            assertEquals("network.failed", lost.code)
            val outcome = bench.tula.retryProviderSignIn()
            assertIs<ProviderOutcome.SignedIn>(outcome)
            assertEquals("ProviderOutcome.SignedIn", outcome.toString())
            assertIs<AuthState.SignedIn>(bench.tula.state.value)
            // The same ticket and binding went twice, and nothing is left for a third time.
            val sent = bench.engine.sent(bench.exchange).map { it.body }
            assertEquals(2, sent.size)
            assertEquals(sent[0], sent[1])
            assertEquals("no_answer", (bench.tula.retryProviderSignIn() as ProviderOutcome.Refused).refusal.toString())
            bench.tula.close()

            // Past the minute the client says the ticket is over without asking.
            val late = Returning()
            late.engine.on("POST", late.exchange) { throw java.io.IOException("the connection died") }
            assertEquals("network.failed", caught { late.tula.signIn(OAuthProvider.Google, late.redirect) }.code)
            late.clock.advance(ProviderRoundTrip.TICKET_HOLD_MS)
            val over = late.tula.retryProviderSignIn()
            assertEquals("oauth.ticket_invalid", (over as ProviderOutcome.Refused).refusal.toString())
            assertEquals("ProviderOutcome.Refused(oauth.ticket_invalid)", over.toString())
            assertEquals(1, late.engine.sent(late.exchange).size)
            late.tula.close()

            // The app can let a kept ticket go.
            val left = Returning()
            left.engine.on("POST", left.exchange) { throw java.io.IOException("the connection died") }
            assertEquals("network.failed", caught { left.tula.signIn(OAuthProvider.Google, left.redirect) }.code)
            left.tula.discardProviderSignIn()
            assertEquals("no_answer", (left.tula.retryProviderSignIn() as ProviderOutcome.Refused).refusal.toString())
            assertEquals(1, left.engine.sent(left.exchange).size)
            left.tula.close()
        }

    @Test
    fun `the server's answer about a ticket is an outcome, a start that is not one is refused, and a return for another attempt sends nothing`() =
        runTest {
            val refused = Returning()
            refused.engine.on("POST", refused.exchange) {
                answer(403, errorJson("oauth.different_browser", 403))
            }
            val outcome = refused.tula.signIn(OAuthProvider.Google, refused.redirect)
            assertEquals("not_started_here", (outcome as ProviderOutcome.Refused).refusal.toString())
            refused.engine.on("POST", refused.exchange) { answer(409, errorJson("oauth.account_exists", 409)) }
            val exists = refused.tula.signIn(OAuthProvider.Google, refused.redirect)
            assertEquals(ProviderRefusal.Failed("oauth.account_exists"), (exists as ProviderOutcome.Refused).refusal)
            // An answer that is no answer is the client's own error, thrown.
            refused.engine.on("POST", refused.exchange) { ok("not json") }
            assertEquals("response.invalid", caught { refused.tula.signIn(OAuthProvider.Google, refused.redirect) }.code)
            refused.tula.close()

            for (start in listOf(
                """"authorizationUrl":"javascript:alert(1)","binding":"tula_ob_unit"""",
                """"authorizationUrl":"https://provider.example/a","binding":""""",
            )) {
                val bent = Returning()
                bent.engine.on("POST", "/v1/client/sign-ins/oauth") {
                    ok("""{"attempt":${attemptJson("""{"status":"needs_first_factor","strategies":[]}""")},$start}""")
                }
                assertEquals("response.invalid", caught { bent.tula.signIn(OAuthProvider.Google, bent.redirect) }.code)
                assertEquals(0, bent.engine.sent(bent.exchange).size)
                bent.tula.close()
            }

            val engine = ScriptedEngine()
            engine.on("POST", "/v1/client/sign-ins/oauth") {
                ok(
                    """{"attempt":${attemptJson("""{"status":"needs_first_factor","strategies":[]}""")},""" +
                        """"authorizationUrl":"https://provider.example/authorize","binding":"tula_ob_unit"}""",
                )
            }
            val other = TulaClient(
                publishableKey = TEST_KEY,
                baseUrl = TEST_BASE,
                storage = MemoryTokenStorage(),
                http = engine,
                browser = { _, redirectUrl -> "$redirectUrl#tula_ticket=tula_ot_unit&tula_attempt=someone-elses" },
            )
            val stray = other.signIn(OAuthProvider.Google, "https://app.example.com/cb")
            assertEquals("not_started_here", (stray as ProviderOutcome.Refused).refusal.toString())
            assertEquals(listOf("/v1/client/sign-ins/oauth"), engine.paths())
            other.close()
        }

    @Test
    fun `a DER signature becomes the 64 bytes a proof carries, and anything else is refused`() {
        fun der(r: ByteArray, s: ByteArray): ByteArray {
            val body = byteArrayOf(0x02, r.size.toByte()) + r + byteArrayOf(0x02, s.size.toByte()) + s
            val length = if (body.size < 0x80) byteArrayOf(body.size.toByte()) else byteArrayOf(0x81.toByte(), body.size.toByte())
            return byteArrayOf(0x30) + length + body
        }
        val one = EcdsaSignatures.derToRaw(der(byteArrayOf(1), byteArrayOf(2)))
        assertEquals(64, one.size)
        assertEquals(1, one[31].toInt())
        assertEquals(2, one[63].toInt())
        // A leading zero that keeps a number positive is dropped; 33 bytes with it are 32 without.
        val high = ByteArray(33).also { it[1] = 0x80.toByte() }
        val padded = EcdsaSignatures.derToRaw(der(high, ByteArray(32) { 7 }))
        assertEquals(0x80.toByte(), padded[0])
        assertEquals(7, padded[63].toInt())
        // The long form of a length.
        val long = EcdsaSignatures.derToRaw(der(ByteArray(33).also { it[1] = 0x80.toByte() }, high) + ByteArray(0))
        assertEquals(64, long.size)

        val malformed = listOf(
            byteArrayOf(),
            byteArrayOf(0x31, 0x00),
            byteArrayOf(0x30),
            byteArrayOf(0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01),
            byteArrayOf(0x30, 0x06, 0x03, 0x01, 0x01, 0x02, 0x01, 0x02),
            byteArrayOf(0x30, 0x04, 0x02, 0x00, 0x02, 0x00),
            byteArrayOf(0x30, 0x82.toByte(), 0x00, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x02),
            der(byteArrayOf(1), byteArrayOf(2)) + byteArrayOf(0),
            der(ByteArray(34) { 1 }, byteArrayOf(2)),
            byteArrayOf(0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x09, 0x02),
        )
        for (bytes in malformed) {
            assertFailsWith<IllegalArgumentException>(bytes.joinToString(" ")) { EcdsaSignatures.derToRaw(bytes) }
        }
    }

    @Test
    fun `a device's public key is two 32-byte coordinates, copied in and out, and a software key signs with it`() = runTest {
        assertFailsWith<IllegalArgumentException> { DevicePublicKey(ByteArray(31), ByteArray(32)) }
        assertFailsWith<IllegalArgumentException> { DevicePublicKey(ByteArray(32), ByteArray(33)) }
        val x = ByteArray(32) { 1 }
        val key = DevicePublicKey(x, ByteArray(32) { 2 })
        x[0] = 9
        key.x[0] = 9
        assertEquals(1, key.x[0].toInt())

        val other = java.security.KeyPairGenerator.getInstance("EC").run {
            initialize(java.security.spec.ECGenParameterSpec("secp384r1"))
            generateKeyPair()
        }
        assertFailsWith<IllegalArgumentException> {
            DevicePublicKey.of(other.public as java.security.interfaces.ECPublicKey)
        }

        val store = SoftwareDeviceKeyStore()
        assertNull(store.existing())
        val made = store.create()
        assertEquals(64, made.sign("message".toByteArray()).size)
        // Making again is the same key, and nothing of it prints.
        assertTrue(made.publicKey.x.contentEquals(store.create().publicKey.x))
        assertTrue(made.publicKey.x.contentEquals(store.existing()?.publicKey?.x))
        assertEquals("JcaDeviceKey SoftwareDeviceKeyStore", "$made $store")
        store.remove()
        assertNull(store.existing())
        assertEquals("the device key can never be had again", DeviceKeyUnusableException().message)
    }

    @Test
    fun `the key for a start is found or made, for a refresh only found, and a store that throws is the client's code with nothing of the cause`() =
        runTest {
            val store = BentKeyStore()
            val proofs = proofs(store)
            assertNull(proofs.key(DeviceProofs.Use.REFRESH, SHORT_MS))
            assertEquals(0, store.makes.get())
            val made = assertIs<DeviceKey>(proofs.key(DeviceProofs.Use.START, SHORT_MS))
            assertEquals(1, store.makes.get())
            assertTrue(made.publicKey.x.contentEquals(proofs.key(DeviceProofs.Use.REFRESH, SHORT_MS)?.publicKey?.x))
            assertEquals(1, store.makes.get())

            val canary = "the-key-stores-own-words-4410"
            store.script.add { throw IllegalStateException(canary) }
            val looking = caught { proofs.key(DeviceProofs.Use.REFRESH, SHORT_MS) }
            assertEquals("device.key_failed", looking.code)
            assertFalse(canary in "$looking ${looking.message} ${looking.cause}")
            assertNull(looking.cause)

            store.inner.remove()
            store.failMake = IllegalStateException(canary)
            val making = caught { proofs.key(DeviceProofs.Use.START, SHORT_MS) }
            assertEquals("device.key_failed", making.code)
            assertNull(making.cause)
            // A store that cancels its own call is a failure, not a cancelled caller.
            store.script.add { throw CancellationException("the store gave up") }
            assertEquals("device.key_failed", caught { proofs.key(DeviceProofs.Use.REFRESH, SHORT_MS) }.code)
        }

    @Test
    fun `a key store that never answers is a timeout inside the call's deadline, is asked once however many callers wait, and no time is no look`() =
        runTest {
            val store = BentKeyStore()
            val proofs = proofs(store)
            val release = CompletableDeferred<DeviceKey?>()
            repeat(1) { store.script.add { release.await() } }
            val first = async { caught { proofs.key(DeviceProofs.Use.REFRESH, SHORT_MS) } }
            while (store.looks.get() == 0) {
                yield()
            }
            // A second caller joins the look that is out, under its own deadline.
            val second = caught { proofs.key(DeviceProofs.Use.REFRESH, SHORT_MS) }
            assertEquals("network.timeout", second.code)
            assertEquals("network.timeout", first.await().code)
            assertEquals(1, store.looks.get())
            assertEquals("network.timeout", caught { proofs.key(DeviceProofs.Use.REFRESH, 0) }.code)
            assertEquals(1, store.looks.get())
            release.complete(null)
        }

    @Test
    fun `a key is gone only when two looks both say so - a look that finds it, throws or contradicts the first keeps the session`() =
        runTest {
            val none: suspend () -> DeviceKey? = { null }
            val throws: suspend () -> DeviceKey? = { throw IllegalStateException("locked") }
            val key = SoftwareDeviceKeyStore().create()
            val found: suspend () -> DeviceKey? = { key }
            val rows = listOf(
                listOf(found) to DeviceProofs.Verdict.THERE,
                listOf(throws) to DeviceProofs.Verdict.UNSURE,
                listOf(none, none) to DeviceProofs.Verdict.GONE,
                listOf(none, found) to DeviceProofs.Verdict.CONTRADICTED,
                listOf(none, throws) to DeviceProofs.Verdict.CONTRADICTED,
            )
            for ((looks, verdict) in rows) {
                val store = BentKeyStore()
                looks.forEach { store.script.add(it) }
                assertEquals(verdict, proofs(store).verdict(2 * SHORT_MS))
                assertEquals(looks.size, store.looks.get())
            }
            // A look that never answers is not "gone".
            val stalled = BentKeyStore()
            stalled.script.add { awaitCancellation() }
            assertEquals(DeviceProofs.Verdict.UNSURE, proofs(stalled).verdict(2 * SHORT_MS))
        }

    @Test
    fun `removing the key - a refusal and a store that never answers are errors, and a key that can never be had again is removed only for the store's own word`() =
        runTest {
            val store = BentKeyStore()
            val proofs = proofs(store)
            proofs.key(DeviceProofs.Use.START, SHORT_MS)
            proofs.remove(SHORT_MS)
            assertNull(store.inner.existing())

            store.failRemove = IllegalStateException("refused")
            val refused = caught { proofs.remove(SHORT_MS) }
            assertEquals("device.key_failed", refused.code)
            assertNull(refused.cause)
            store.failRemove = CancellationException("the store gave up")
            assertEquals("device.key_failed", caught { proofs.remove(SHORT_MS) }.code)
            store.failRemove = null
            store.stallRemove = true
            assertEquals("network.timeout", caught { proofs.remove(SHORT_MS) }.code)
            store.stallRemove = false

            // At a sign-out: only "never again" removes.
            val before = store.removals.get()
            store.script.add { throw IllegalStateException("locked") }
            proofs.dropUnusableKey(SHORT_MS)
            store.script.add { throw CancellationException("the store gave up") }
            proofs.dropUnusableKey(SHORT_MS)
            proofs.dropUnusableKey(SHORT_MS)
            assertEquals(before, store.removals.get())
            store.script.add { throw DeviceKeyUnusableException() }
            proofs.dropUnusableKey(SHORT_MS)
            assertEquals(before + 1, store.removals.get())
            // A removal that fails there is not the sign-out's failure.
            store.failRemove = IllegalStateException("refused")
            store.script.add { throw DeviceKeyUnusableException() }
            proofs.dropUnusableKey(SHORT_MS)
            assertEquals(before + 2, store.removals.get())
        }

    @Test
    fun `a proof names the method, the address and the nonce, has an id of its own, and a key that fails to sign is the client's code`() =
        runTest {
            val proofs = proofs(SoftwareDeviceKeyStore())
            val key = SoftwareDeviceKeyStore().create()
            fun part(proof: String, index: Int) = String(Base64.getUrlDecoder().decode(proof.split('.')[index]))

            val first = proofs.proof(key, "POST", "https://auth.example.test/v1/x", 1_760_000_000_999, SHORT_MS)
            assertEquals(3, first.split('.').size)
            assertTrue(""""alg":"ES256"""" in part(first, 0))
            assertTrue(""""typ":"dpop+jwt"""" in part(first, 0))
            assertFalse(""""d":""" in part(first, 0))
            assertTrue(""""htm":"POST"""" in part(first, 1))
            assertTrue(""""htu":"https://auth.example.test/v1/x"""" in part(first, 1))
            assertTrue(""""iat":1760000000""" in part(first, 1))
            assertFalse("nonce" in part(first, 1))
            proofs.nonce = "nonce-1"
            val second = proofs.proof(key, "POST", "https://auth.example.test/v1/x", 1_760_000_000_999, SHORT_MS)
            assertTrue(""""nonce":"nonce-1"""" in part(second, 1))
            assertNotEquals(part(first, 1).substringAfter("jti"), part(second, 1).substringAfter("jti").substringBefore(",\"nonce"))

            class Signing(val how: suspend () -> ByteArray) : DeviceKey {
                override val publicKey = key.publicKey

                override suspend fun sign(message: ByteArray): ByteArray = how()
            }
            val canary = "the-keys-own-words-9902"
            val rows = listOf<Pair<suspend () -> ByteArray, String>>(
                suspend { throw IllegalStateException(canary) } to "device.key_failed",
                suspend { throw CancellationException("the key gave up") } to "device.key_failed",
                suspend { ByteArray(63) } to "device.key_failed",
                suspend { awaitCancellation() } to "network.timeout",
            )
            for ((how, code) in rows) {
                val error = caught { proofs.proof(Signing(how), "POST", "https://auth.example.test/v1/x", 0, SHORT_MS) }
                assertEquals(code, error.code)
                assertNull(error.cause)
                assertFalse(canary in "$error ${error.message}")
            }
        }

    @Test
    fun `a start with a key store that never answers sends nothing and times out, and one that throws sends nothing either`() =
        runTest {
            val store = BentKeyStore()
            val engine = ScriptedEngine()
            val tula = TulaClient(
                publishableKey = TEST_KEY,
                baseUrl = TEST_BASE,
                storage = MemoryTokenStorage(),
                http = engine,
                timeoutMs = 2 * SHORT_MS,
                deviceKeys = store,
            )
            store.script.add { throw IllegalStateException("locked") }
            assertEquals("device.key_failed", caught { tula.signIn("maya@example.com") }.code)
            assertEquals(emptyList(), engine.paths())

            // With the store answering, the start carries a proof.
            engine.on("POST", "/v1/client/sign-ins") { ok(attemptJson(NEEDS_PASSWORD)) }
            tula.signIn("maya@example.com")
            assertEquals(3, engine.requests.single().headers.getValue("dpop").split('.').size)

            // A look that never answers is the call's timeout, and the next call joins that
            // look instead of asking the store a second time.
            val looks = store.looks.get()
            store.script.add { awaitCancellation() }
            assertEquals("network.timeout", caught { tula.signIn("maya@example.com") }.code)
            assertEquals("network.timeout", caught { tula.signIn("maya@example.com") }.code)
            assertEquals(looks + 1, store.looks.get())
            assertEquals(1, engine.requests.size)
            tula.close()
        }

    @Test
    fun `the client's own key removal goes through the store, and a client with no store has nothing to remove`() = runTest {
        val store = BentKeyStore()
        store.inner.create()
        val tula = TulaClient(
            publishableKey = TEST_KEY,
            baseUrl = TEST_BASE,
            storage = MemoryTokenStorage(),
            http = ScriptedEngine(),
            deviceKeys = store,
        )
        tula.removeDeviceKey()
        assertEquals(1, store.removals.get())
        assertNull(store.inner.existing())
        store.failRemove = IllegalStateException("refused")
        assertEquals("device.key_failed", caught { tula.removeDeviceKey() }.code)
        tula.close()
        Bench().tula.removeDeviceKey()
        scope.cancel()
    }
}
