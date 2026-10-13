package dev.tula.auth

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** The account calls the screens needed: a phone number, ending sessions, which sheets were given. */
class AccountTest {
    private fun userWithNumber(): String = userJson().dropLast(1) +
        ""","phoneNumber":"+14155550142","phoneNumberVerifiedAt":"2026-02-02T00:00:00.000Z"}"""

    private fun knownUser(bench: Bench) = assertIs<AuthState.SignedIn>(bench.tula.state.value).user

    @Test
    fun `a phone number is asked for, proven and removed, and the state follows without another read`() = runTest {
        val bench = Bench()
        bench.signIn()
        bench.tula.user()
        bench.engine.on("POST", "/v1/client/me/phone") {
            answer(202, """{"destination":"***42","expiresAt":"2026-01-01T00:10:00.000Z"}""")
        }
        bench.engine.on("POST", "/v1/client/me/phone/verify") { ok(userWithNumber()) }
        bench.engine.on("DELETE", "/v1/client/me/phone") { answer(204, "") }

        val receipt = bench.tula.phone.request("+1 (415) 555-0142")
        assertEquals("***42", receipt.destination)
        // The number travels as it was typed, in the body and nowhere else.
        val asked = bench.engine.sent("/v1/client/me/phone").single()
        assertEquals("""{"phoneNumber":"+1 (415) 555-0142"}""", asked.body)
        assertNull(knownUser(bench)?.phoneNumber)

        val user = bench.tula.phone.verify("123456")
        assertEquals("+14155550142", user.phoneNumber)
        assertEquals("""{"code":"123456"}""", bench.engine.sent("/v1/client/me/phone/verify").single().body)
        assertEquals("+14155550142", knownUser(bench)?.phoneNumber)

        val reads = bench.engine.sent("/v1/client/me").size
        bench.tula.phone.remove()
        assertNull(knownUser(bench)?.phoneNumber)
        assertNull(knownUser(bench)?.phoneNumberVerifiedAt)
        assertEquals(reads, bench.engine.sent("/v1/client/me").size)
        assertEquals("TulaPhone", bench.tula.phone.toString())
    }

    @Test
    fun `a receipt that names no destination is not taken, and a refusal is the server's code`() = runTest {
        val bench = Bench()
        bench.signIn()
        bench.engine.on("POST", "/v1/client/me/phone") { ok("""{"destination":"","expiresAt":"2026-01-01T00:10:00.000Z"}""") }
        assertEquals("response.invalid", assertFailsWith<TulaError> { bench.tula.phone.request("+14155550142") }.code)

        bench.engine.on("POST", "/v1/client/me/phone") {
            answer(403, errorJson("auth.step_up_required", 403, ""","params":{"methods":"password,totp"}"""))
        }
        val refused = assertFailsWith<TulaError> { bench.tula.phone.request("+14155550142") }
        assertEquals("auth.step_up_required", refused.code)
        assertEquals(listOf("password", "totp"), refused.stepUpMethods)

        bench.engine.on("DELETE", "/v1/client/me/phone") { answer(403, errorJson("auth.step_up_required", 403)) }
        assertEquals("auth.step_up_required", assertFailsWith<TulaError> { bench.tula.phone.remove() }.code)
    }

    @Test
    fun `a removal that was refused changes nothing in the state, and nobody signed in is refused before a request`() = runTest {
        val bench = Bench()
        bench.signIn()
        bench.engine.on("GET", "/v1/client/me") { ok(userWithNumber()) }
        bench.tula.user()
        bench.engine.on("DELETE", "/v1/client/me/phone") { answer(429, errorJson("rate_limited", 429)) }
        assertEquals("rate_limited", assertFailsWith<TulaError> { bench.tula.phone.remove() }.code)
        assertEquals("+14155550142", knownUser(bench)?.phoneNumber)

        val nobody = Bench()
        assertEquals("auth.unauthenticated", assertFailsWith<TulaError> { nobody.tula.phone.remove() }.code)
        assertEquals("auth.unauthenticated", assertFailsWith<TulaError> { nobody.tula.phone.request("+14155550142") }.code)
        assertTrue(nobody.engine.requests.isEmpty())
    }

    @Test
    fun `one session and every other session are ended by their own calls, and an id that is no path segment sends nothing`() = runTest {
        val bench = Bench()
        bench.signIn()
        bench.engine.on("DELETE", "/v1/client/sessions/session-2") { answer(204, "") }
        bench.engine.on("POST", "/v1/client/sessions/revoke-others") { ok("""{"revoked":3}""") }

        bench.tula.revokeSession("session-2")
        assertEquals(1, bench.engine.sent("/v1/client/sessions/session-2").size)
        assertEquals(3, bench.tula.revokeOtherSessions())

        val before = bench.engine.requests.size
        for (id in listOf("", "..", "a/b")) {
            assertEquals("response.invalid", assertFailsWith<TulaError> { bench.tula.revokeSession(id) }.code)
        }
        assertEquals(before, bench.engine.requests.size)

        bench.engine.on("DELETE", "/v1/client/sessions/gone") { answer(404, errorJson("resource.not_found", 404)) }
        assertEquals("resource.not_found", assertFailsWith<TulaError> { bench.tula.revokeSession("gone") }.code)
    }

    @Test
    fun `the client says which sheets it was given, and nothing of them`() {
        val none = Bench().tula
        assertEquals(TulaSheets(passkeys = false, google = false, browser = false), none.sheets)
        val some = TulaClient(
            publishableKey = TEST_KEY,
            baseUrl = TEST_BASE,
            storage = MemoryTokenStorage(),
            http = ScriptedEngine(),
            google = GoogleSheet { "token" },
            browser = BrowserSession { _, _ -> null },
        )
        assertFalse(some.sheets.passkeys)
        assertTrue(some.sheets.google)
        assertTrue(some.sheets.browser)
    }
}
