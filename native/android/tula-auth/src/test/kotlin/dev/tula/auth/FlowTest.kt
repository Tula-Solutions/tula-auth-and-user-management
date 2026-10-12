package dev.tula.auth

import dev.tula.auth.generated.FlowKind
import dev.tula.auth.generated.FlowStep
import dev.tula.auth.generated.TulaJson
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.yield
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue

private const val SIGN_INS = "/v1/client/sign-ins"
private const val SECRET = "tula_at_secret-of-attempt-1"

/** The flow protocol on a scripted network: start, every step, the secret, discard. */
class FlowTest {
    private fun step(json: String): FlowStep = TulaJson.decodeFromString(FlowStep.serializer(), json)

    @Test
    fun `a sign-up sends what it was given and its steps carry the attempt's secret`() = runTest {
        val bench = Bench()
        val waiting = """{"status":"needs_email_verification","destination":"m***@example.com","strategies":["email_code"]}"""
        bench.engine.on("POST", "/v1/client/sign-ups") { ok(attemptJson(waiting, kind = "sign_up")) }
        bench.engine.on("POST", "/v1/client/sign-ups/attempt-1/resend-code") { ok(attemptJson(waiting, kind = "sign_up", secret = null)) }
        bench.engine.on("POST", "/v1/client/sign-ups/attempt-1/verify-email") {
            ok(attemptJson(COMPLETE, kind = "sign_up", secret = null, session = tokensJson("first")))
        }
        bench.engine.on("GET", "/v1/client/me") { ok(userJson()) }

        val flow = bench.tula.signUp(email = "maya@example.com", password = "a-password-nobody-uses", firstName = "Maya")
        assertEquals(FlowKind.SignUp, flow.kind)
        assertEquals("attempt-1", flow.id)
        assertEquals("2026-01-01T00:10:00.000Z", flow.expiresAt)
        assertEquals(FlowScreen.NEEDS_EMAIL_VERIFICATION, flow.screen)
        val start = bench.engine.requests.single()
        assertEquals(
            """{"email":"maya@example.com","password":"a-password-nobody-uses","firstName":"Maya"}""",
            start.body,
        )
        // A start has no attempt yet, and so no secret.
        assertNull(start.headers[FLOW_ATTEMPT_HEADER])
        assertEquals(TEST_KEY, start.headers[PUBLISHABLE_KEY_HEADER])
        assertEquals("android", start.headers[CLIENT_HEADER])

        assertEquals("needs_email_verification", flow.resendCode().status)
        assertEquals("complete", flow.verifyEmail("123456").status)
        val steps = bench.engine.requests.drop(1).take(2)
        assertEquals(listOf(SECRET, SECRET), steps.map { it.headers[FLOW_ATTEMPT_HEADER] })
        assertNull(steps[0].body)
        assertEquals("""{"code":"123456"}""", steps[1].body)
        assertEquals(FlowScreen.COMPLETE, flow.screen)
        assertIs<AuthState.SignedIn>(bench.tula.state.value)
    }

    @Test
    fun `every sign-in step goes to its own route with its own body`() = runTest {
        val bench = Bench()
        val choice = """{"status":"needs_first_factor","strategies":["password","email_code","sms_code"]}"""
        val routes = listOf("password", "new-password", "verify-email", "resend-code", "first-factor/prepare", "first-factor/attempt")
        bench.engine.on("POST", SIGN_INS) { ok(attemptJson(choice)) }
        for (route in routes) {
            bench.engine.on("POST", "$SIGN_INS/attempt-1/$route") { ok(attemptJson(choice, secret = null)) }
        }
        val flow = bench.tula.signIn("maya@example.com")
        assertEquals(FlowScreen.NEEDS_FIRST_FACTOR, flow.screen)

        flow.submitPassword("the-password")
        flow.submitNewPassword("the-next-password")
        flow.verifyEmail("111111")
        flow.resendCode()
        flow.prepareFirstFactor(CodeStrategy.EMAIL_CODE)
        flow.prepareFirstFactor(CodeStrategy.SMS_CODE)
        flow.attemptFirstFactor(CodeStrategy.EMAIL_CODE, "222222")
        flow.attemptFirstFactor(CodeStrategy.SMS_CODE, "333333")

        assertEquals(
            listOf(
                SIGN_INS to """{"identifier":"maya@example.com"}""",
                "$SIGN_INS/attempt-1/password" to """{"password":"the-password"}""",
                "$SIGN_INS/attempt-1/new-password" to """{"password":"the-next-password"}""",
                "$SIGN_INS/attempt-1/verify-email" to """{"code":"111111"}""",
                "$SIGN_INS/attempt-1/resend-code" to null,
                "$SIGN_INS/attempt-1/first-factor/prepare" to """{"strategy":"email_code"}""",
                "$SIGN_INS/attempt-1/first-factor/prepare" to """{"strategy":"sms_code"}""",
                "$SIGN_INS/attempt-1/first-factor/attempt" to """{"strategy":"email_code","code":"222222"}""",
                "$SIGN_INS/attempt-1/first-factor/attempt" to """{"strategy":"sms_code","code":"333333"}""",
            ),
            bench.engine.paths().zip(bench.engine.requests.map { it.body }),
        )
        assertTrue(bench.engine.requests.drop(1).all { it.headers[FLOW_ATTEMPT_HEADER] == SECRET })
    }

    @Test
    fun `a password reset sends the code and the new password together`() = runTest {
        val bench = Bench()
        val waiting = """{"status":"needs_new_password","destination":"m***@example.com","strategies":["email_code"]}"""
        bench.engine.on("POST", "/v1/client/password-resets") { ok(attemptJson(waiting, kind = "password_reset")) }
        bench.engine.on("POST", "/v1/client/password-resets/attempt-1/resend-code") {
            ok(attemptJson(waiting, kind = "password_reset", secret = null))
        }
        bench.engine.on("POST", "/v1/client/password-resets/attempt-1/password") {
            ok(attemptJson(COMPLETE, kind = "password_reset", secret = null, session = tokensJson("first")))
        }
        bench.engine.on("GET", "/v1/client/me") { ok(userJson()) }

        val flow = bench.tula.resetPassword("maya@example.com")
        assertEquals(FlowKind.PasswordReset, flow.kind)
        assertEquals(FlowScreen.NEEDS_NEW_PASSWORD, flow.screen)
        flow.resendCode()
        assertEquals("complete", flow.submit(code = "123456", password = "a-new-password").status)
        assertEquals(
            listOf("""{"email":"maya@example.com"}""", null, """{"code":"123456","password":"a-new-password"}"""),
            bench.engine.requests.take(3).map { it.body },
        )
        assertIs<AuthState.SignedIn>(bench.tula.state.value)
    }

    @Test
    fun `a second action while one is in flight is flow_busy, with no request`() = runTest {
        val bench = Bench()
        val gate = CompletableDeferred<Unit>()
        bench.engine.on("POST", SIGN_INS) { ok(attemptJson(NEEDS_PASSWORD)) }
        bench.engine.on("POST", "$SIGN_INS/attempt-1/password") {
            gate.await()
            ok(attemptJson(NEEDS_PASSWORD, secret = null))
        }
        val flow = bench.tula.signIn("maya@example.com")
        val first = async { flow.submitPassword("one") }
        while (bench.engine.requests.size < 2) {
            yield()
        }

        val error = caught { flow.submitPassword("two") }
        assertEquals("flow.busy", error.code)
        assertEquals(0, error.status)
        assertEquals(2, bench.engine.requests.size)
        gate.complete(Unit)
        first.await()
        // Free again once the first has been answered.
        flow.submitPassword("three")
        assertEquals(3, bench.engine.requests.size)
    }

    @Test
    fun `a completed flow takes no more actions`() = runTest {
        val bench = Bench()
        val flow = bench.signIn()
        val sent = bench.engine.requests.size
        val error = caught { flow.submitPassword("again") }
        assertEquals("flow.invalid_step", error.code)
        assertEquals(0, error.status)
        assertEquals(sent, bench.engine.requests.size)
        // Discarding a finished flow does nothing: the client stays signed in.
        flow.discard()
        assertIs<AuthState.SignedIn>(bench.tula.state.value)
    }

    @Test
    fun `a discarded flow takes no more actions and sends nothing`() = runTest {
        val bench = Bench()
        bench.engine.on("POST", SIGN_INS) { ok(attemptJson(NEEDS_PASSWORD)) }
        val flow = bench.tula.signIn("maya@example.com")
        flow.discard()
        assertEquals("flow.invalid_step", caught { flow.submitPassword("late") }.code)
        assertEquals(1, bench.engine.requests.size)
        // What is left to show is where it stood.
        assertEquals("needs_password", flow.step.status)
    }

    @Test
    fun `an answer that arrives after discard signs nobody in`() = runTest {
        val bench = Bench()
        val gate = CompletableDeferred<Unit>()
        bench.engine.on("POST", SIGN_INS) { ok(attemptJson(NEEDS_PASSWORD)) }
        bench.engine.on("POST", "$SIGN_INS/attempt-1/password") {
            gate.await()
            ok(attemptJson(COMPLETE, secret = null, session = tokensJson("late")))
        }
        val flow = bench.tula.signIn("maya@example.com")
        val submitting = async { caught { flow.submitPassword("the-password") } }
        while (bench.engine.requests.size < 2) {
            yield()
        }
        flow.discard()
        gate.complete(Unit)

        assertEquals("flow.invalid_step", submitting.await().code)
        assertEquals(AuthState.Loading, bench.tula.state.value)
        assertNull(bench.storage.get(TEST_STORAGE_KEY))
        assertEquals("needs_password", flow.step.status)
        // Nothing asked for the profile of a session that was never taken.
        assertEquals(emptyList(), bench.engine.sent("/v1/client/me"))
    }

    @Test
    fun `an error leaves the flow on its step and usable`() = runTest {
        val bench = Bench()
        var right = false
        bench.engine.on("POST", SIGN_INS) { ok(attemptJson(NEEDS_PASSWORD)) }
        bench.engine.on("POST", "$SIGN_INS/attempt-1/password") {
            if (right) {
                ok(attemptJson(COMPLETE, secret = null, session = tokensJson("first")))
            } else {
                answer(401, errorJson("auth.invalid_credentials", 401))
            }
        }
        bench.engine.on("GET", "/v1/client/me") { ok(userJson()) }
        val flow = bench.tula.signIn("maya@example.com")
        val error = caught { flow.submitPassword("wrong") }
        assertEquals("auth.invalid_credentials", error.code)
        assertEquals("The email or password is incorrect.", error.message)
        assertEquals("needs_password", flow.step.status)
        right = true
        assertEquals("complete", flow.submitPassword("right").status)
    }

    @Test
    fun `a start that is not an attempt is response_invalid, and no flow`() = runTest {
        val unusable = listOf(
            "<html>a proxy's page</html>",
            """{"hello":"world"}""",
            // No secret: no later call could succeed.
            attemptJson(NEEDS_PASSWORD, secret = null),
            attemptJson(NEEDS_PASSWORD, secret = ""),
            attemptJson(NEEDS_PASSWORD, id = ""),
            // Tokens before the flow is complete.
            attemptJson(NEEDS_PASSWORD, session = tokensJson("early")),
            // Complete, with no session or one the client cannot use.
            attemptJson(COMPLETE),
            attemptJson(COMPLETE, session = """{"sessionId":"stateful-1"}"""),
            // A known status without what it must carry.
            attemptJson("""{"status":"complete"}""", session = tokensJson("first")),
        )
        for (body in unusable) {
            val bench = Bench()
            bench.engine.on("POST", SIGN_INS) { ok(body) }
            val error = caught { bench.tula.signIn("maya@example.com") }
            assertEquals("response.invalid", error.code, body)
            assertEquals(AuthState.Loading, bench.tula.state.value)
            assertNull(bench.storage.get(TEST_STORAGE_KEY))
        }
    }

    @Test
    fun `a step answer that cannot be used leaves the flow where it was`() = runTest {
        val bench = Bench()
        bench.engine.on("POST", SIGN_INS) { ok(attemptJson(NEEDS_PASSWORD)) }
        bench.engine.on("POST", "$SIGN_INS/attempt-1/password") { ok(attemptJson(COMPLETE, secret = null)) }
        val flow = bench.tula.signIn("maya@example.com")
        assertEquals("response.invalid", caught { flow.submitPassword("the-password") }.code)
        assertEquals("needs_password", flow.step.status)
        assertEquals(AuthState.Loading, bench.tula.state.value)
    }

    @Test
    fun `a start that is already complete signs in`() = runTest {
        val bench = Bench()
        bench.engine.on("POST", SIGN_INS) { ok(attemptJson(COMPLETE, secret = null, session = tokensJson("first"))) }
        bench.engine.on("GET", "/v1/client/me") { ok(userJson()) }
        val flow = bench.tula.signIn("maya@example.com")
        assertEquals(FlowScreen.COMPLETE, flow.screen)
        assertIs<AuthState.SignedIn>(bench.tula.state.value)
        assertEquals("flow.invalid_step", caught { flow.submitPassword("more") }.code)
    }

    @Test
    fun `a step this version does not know is kept as it was sent and is not supported`() = runTest {
        val bench = Bench()
        val newer = """{"status":"needs_retina_scan","prompt":"look into the camera"}"""
        bench.engine.on("POST", SIGN_INS) { ok(attemptJson(newer)) }
        val flow = bench.tula.signIn("maya@example.com")

        val unknown = flow.step
        assertIs<FlowStep.Unknown>(unknown)
        assertEquals("needs_retina_scan", unknown.status)
        assertEquals(newer, unknown.raw.toString())
        assertEquals(FlowScreen.NOT_SUPPORTED, flow.screen)
        assertEquals(1, bench.engine.requests.size)
        assertEquals(AuthState.Loading, bench.tula.state.value)
    }

    @Test
    fun `the screen of every step, and not supported for what has no action`() {
        val signIn = FlowKind.SignIn
        val table = listOf(
            Triple(NEEDS_PASSWORD, signIn, FlowScreen.NEEDS_PASSWORD),
            Triple(COMPLETE, signIn, FlowScreen.COMPLETE),
            Triple("""{"status":"needs_email_verification","destination":"m","strategies":["email_code"]}""", signIn, FlowScreen.NEEDS_EMAIL_VERIFICATION),
            Triple("""{"status":"needs_first_factor","strategies":["password","email_link"]}""", signIn, FlowScreen.NEEDS_FIRST_FACTOR),
            Triple("""{"status":"needs_first_factor","strategies":["sms_code"]}""", signIn, FlowScreen.NEEDS_FIRST_FACTOR),
            // Only ways this version cannot do: a link, a passkey, a provider, one nobody knows.
            Triple("""{"status":"needs_first_factor","strategies":["email_link","passkey","google","retina"]}""", signIn, FlowScreen.NOT_SUPPORTED),
            Triple("""{"status":"needs_first_factor","strategies":[]}""", signIn, FlowScreen.NOT_SUPPORTED),
            // A reset's step has no reason; a sign-in's is answered only for one that is known.
            Triple("""{"status":"needs_new_password","destination":"m","strategies":["email_code"]}""", FlowKind.PasswordReset, FlowScreen.NEEDS_NEW_PASSWORD),
            Triple("""{"status":"needs_new_password","destination":"m","strategies":[],"reason":"expired"}""", signIn, FlowScreen.NEEDS_NEW_PASSWORD),
            Triple("""{"status":"needs_new_password","destination":"m","strategies":[],"reason":"breached"}""", signIn, FlowScreen.NOT_SUPPORTED),
            Triple("""{"status":"needs_new_password","destination":"m","strategies":[]}""", signIn, FlowScreen.NOT_SUPPORTED),
            Triple("""{"status":"needs_new_password","destination":"m","strategies":[],"reason":"expired"}""", FlowKind.PasswordReset, FlowScreen.NOT_SUPPORTED),
            Triple("""{"status":"needs_new_password","destination":"m","strategies":[],"reason":"expired"}""", FlowKind.SignUp, FlowScreen.NOT_SUPPORTED),
            // No action of this version answers these.
            Triple("""{"status":"needs_second_factor","options":["totp"]}""", signIn, FlowScreen.NOT_SUPPORTED),
            Triple("""{"status":"needs_factor_enrolment","methods":["totp"]}""", signIn, FlowScreen.NOT_SUPPORTED),
            Triple("""{"status":"needs_identifier"}""", signIn, FlowScreen.NOT_SUPPORTED),
            Triple("""{"status":"needs_something_new"}""", signIn, FlowScreen.NOT_SUPPORTED),
        )
        for ((json, kind, screen) in table) {
            assertEquals(screen, flowScreen(step(json), kind), "$json in $kind")
        }
    }

    @Test
    fun `nothing a flow prints holds the attempt's secret`() = runTest {
        val bench = Bench()
        bench.engine.on("POST", SIGN_INS) { ok(attemptJson(NEEDS_PASSWORD)) }
        val flow = bench.tula.signIn("maya@example.com")
        for (text in listOf(flow.toString(), flow.snapshot().toString(), flow.step.toString())) {
            assertFalse(text.contains("tula_at_"), text)
        }
        assertTrue(flow.toString().contains("attempt-1"))
    }

    @Test
    fun `a flow waits for a refresh in flight before it sends its action`() = runTest {
        val bench = Bench()
        bench.signIn()
        val gate = CompletableDeferred<Unit>()
        bench.engine.on("POST", "/v1/client/sessions/refresh") {
            gate.await()
            ok(tokensJson("refreshed"))
        }
        bench.engine.on("POST", SIGN_INS) { ok(attemptJson(NEEDS_PASSWORD, id = "attempt-2")) }
        bench.engine.on("POST", "$SIGN_INS/attempt-2/password") {
            ok(attemptJson(COMPLETE, id = "attempt-2", secret = null, session = tokensJson("second", sessionId = "session-2")))
        }
        val flow = bench.tula.signIn("maya@example.com")
        val refreshing = async { bench.tula.session.refresh() }
        while (bench.engine.sent("/v1/client/sessions/refresh").isEmpty()) {
            yield()
        }
        val submitting = async { flow.submitPassword("the-password") }
        // The action is not sent while the old session's refresh is still out.
        repeat(50) { yield() }
        assertEquals(emptyList(), bench.engine.sent("$SIGN_INS/attempt-2/password"))
        gate.complete(Unit)
        refreshing.await()
        submitting.await()
        // The newer session is the one that stays.
        assertEquals("session-2", (bench.tula.state.value as AuthState.SignedIn).sessionId)
        assertEquals("tula_rt_second", bench.storage.get(TEST_STORAGE_KEY))
    }
}
