package dev.tula.auth.journeys

import dev.tula.auth.AuthState
import dev.tula.auth.generated.OAuthProvider
import dev.tula.auth.TulaSheetException
import dev.tula.auth.SheetFailure
import dev.tula.auth.ProviderOutcome
import dev.tula.auth.TulaCeremony
import java.util.concurrent.atomic.AtomicBoolean
import dev.tula.auth.DeviceKeyStore
import dev.tula.auth.stepUpMethods
import dev.tula.auth.PasskeySheet
import dev.tula.auth.CodeStrategy
import dev.tula.auth.FlowScreen
import dev.tula.auth.HttpRequest
import dev.tula.auth.HttpResponse
import dev.tula.auth.MemoryTokenStorage
import dev.tula.auth.SignInFlow
import dev.tula.auth.SignUpFlow
import dev.tula.auth.TulaError
import dev.tula.auth.caught
import dev.tula.auth.generated.ClientConfigPhone
import dev.tula.auth.generated.FlowKind
import dev.tula.auth.generated.FlowStep
import dev.tula.auth.generated.PreparedFirstFactorStrategy
import dev.tula.auth.runTest
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlin.test.Test
import kotlin.test.assertContains
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNotEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertSame
import kotlin.test.assertTrue

private const val PASSWORD = "sturdy-Otter-plays-42-chess"
private const val NEW_PASSWORD = "quiet-Heron-wades-17-rivers"
private const val REFRESH = "/v1/client/sessions/refresh"

/** A signed-up, signed-in device. */
private class Account(val device: Device, val email: String, val flow: SignUpFlow) {
    val tula get() = device.tula
}

/** A device that submitted a password. */
private class Entry(val device: Device, val flow: SignInFlow, val step: FlowStep) {
    val tula get() = device.tula
}

/**
 * The Kotlin client, driven through its public API against the real API (a world of
 * `e2e/kotlin-fixture.ts` each): the Kotlin suite's journeys.
 *
 * What the suite owes is `conformance/client-journeys.json`, under `kotlin`: a scenario
 * decided `journey` has a test here annotated [Journey] with its name, a named behaviour
 * one annotated [Behaviour] with its id, and `GuardTest` (with
 * `.claude/hooks/kotlin-journeys.test.ts`, which reads this file's text: an annotation of
 * either kind is written on a line of its own, directly above the test) fails when the
 * list and this file disagree in either direction. They follow
 * `apps/api/src/testing/sdk-journeys.ts`, the journeys `@tula/core` and `@tula/expo` run.
 */
class JourneysTest {
    /** One journey: a world of its own, closed whatever the outcome. */
    private fun journey(run: suspend CoroutineScope.(World) -> Unit) = runTest(JOURNEY_TIMEOUT_MS) {
        World.create().use { world -> run(world) }
    }

    private suspend fun signUp(world: World, email: String = world.freshEmail()): Account {
        val device = world.client()
        val flow = device.tula.signUp(email = email, password = PASSWORD, firstName = "Maya")
        flow.verifyEmail(world.code(email))
        return Account(device, email, flow)
    }

    private suspend fun signIn(world: World, email: String, password: String = PASSWORD): Entry {
        val device = world.client()
        val flow = device.tula.signIn(email)
        return Entry(device, flow, flow.submitPassword(password))
    }

    private fun signedIn(device: Device): AuthState.SignedIn = assertIs<AuthState.SignedIn>(device.tula.state.value)

    private fun TulaError.param(name: String): Any? = params[name]

    @Test
    @Journey("sign-up")
    fun `sign-up - start, verify the emailed code, signed in with a user`() = journey { world ->
        val device = world.client()
        val tula = device.tula
        val email = world.freshEmail()
        assertEquals(AuthState.Loading, tula.state.value)

        val flow = tula.signUp(email = email, password = PASSWORD, firstName = "Maya")
        assertEquals(FlowKind.SignUp, flow.kind)
        val waiting = assertIs<FlowStep.NeedsEmailVerification>(flow.step)
        assertEquals(listOf("email_code"), waiting.value.strategies.map { it.rawValue })
        assertEquals(FlowScreen.NEEDS_EMAIL_VERIFICATION, flow.screen)
        assertEquals(AuthState.Loading, tula.state.value)

        val step = flow.verifyEmail(world.code(email))
        assertEquals("complete", step.status)
        val user = signedIn(device).user
        assertEquals(email, user?.email)
        assertEquals("Maya", user?.firstName)
        assertNull(user?.bannedAt)
        assertEquals(1, device.states.size)
        assertNotNull(tula.user().emailVerifiedAt)
        assertEquals(3, tula.session.getToken()?.split('.')?.size)
    }

    @Test
    @Journey("sign-up denied by a hook")
    fun `sign-up denied by a hook - the client gets the operator's code, stays signed out, and can start again`() =
        journey { world ->
            val hook = world.hook("before_sign_up", """{"decision":"deny","code":"disposable_email"}""")
            val device = world.client()
            val tula = device.tula
            val email = world.freshEmail()
            val flow = tula.signUp(email = email, password = PASSWORD)
            assertEquals("needs_email_verification", flow.step.status)
            assertEquals(0, hook.asked.get())

            val error = caught { flow.verifyEmail(world.code(email)) }
            assertEquals("hook.denied", error.code)
            assertEquals(403, error.status)
            assertEquals(mapOf<String, Any>("code" to "disposable_email"), error.params)
            assertEquals("This was not allowed.", error.message)
            assertEquals(1, hook.asked.get())
            assertFalse(tula.state.value is AuthState.SignedIn)
            assertNull(tula.session.getToken())

            // The attempt has ended on the server: the flow object the client holds is spent.
            assertEquals("flow.not_found", caught { flow.verifyEmail(world.code(email)) }.code)
            hook.answer = """{"decision":"allow"}"""
            val other = world.freshEmail()
            val again = tula.signUp(email = other, password = PASSWORD)
            assertEquals("complete", again.verifyEmail(world.code(other)).status)
            signedIn(device)
        }

    @Test
    @Journey("hook that times out")
    fun `hook that times out - the client is told to try again later, not that it was refused`() = journey { world ->
        val hook = world.hook("before_sign_up", answer = null, deadlineMs = 100)
        val device = world.client()
        val email = world.freshEmail()
        val flow = device.tula.signUp(email = email, password = PASSWORD)
        val started = System.nanoTime()
        val error = caught { flow.verifyEmail(world.code(email)) }
        // The hook's deadline is 100 ms: the wait is the server's, and bounded.
        assertTrue(System.nanoTime() - started < HOOK_WAIT_CEILING_NS)
        assertEquals("hook.unavailable", error.code)
        assertEquals(503, error.status)
        // Nothing of an operator's code: this was not a denial.
        assertNull(error.param("code"))
        assertEquals(1, hook.asked.get())
        assertFalse(device.tula.state.value is AuthState.SignedIn)
        assertNull(device.tula.session.getToken())
    }

    @Test
    @Journey("sign-in denied by a hook")
    fun `sign-in denied by a hook - the client gets the operator's code and no session, and a new attempt signs in`() =
        journey { world ->
            val email = signUp(world).email
            val hook = world.hook("before_session", """{"decision":"deny","code":"account_suspended"}""")
            val device = world.client()
            val tula = device.tula
            val flow = tula.signIn(email)
            assertEquals(0, hook.asked.get())
            assertEquals("auth.invalid_credentials", caught { flow.submitPassword("not-the-password-123") }.code)
            assertEquals(0, hook.asked.get())

            val error = caught { flow.submitPassword(PASSWORD) }
            assertEquals("hook.denied", error.code)
            assertEquals(403, error.status)
            assertEquals(mapOf<String, Any>("code" to "account_suspended"), error.params)
            assertEquals("This was not allowed.", error.message)
            assertEquals(1, hook.asked.get())
            assertFalse(tula.state.value is AuthState.SignedIn)
            assertNull(tula.session.getToken())

            // The attempt has ended on the server: the flow object the client holds is spent.
            assertEquals("flow.not_found", caught { flow.submitPassword(PASSWORD) }.code)
            hook.answer = """{"decision":"allow"}"""
            val again = tula.signIn(email)
            assertEquals("complete", again.submitPassword(PASSWORD).status)
            signedIn(device)
            assertEquals(2, hook.asked.get())
        }

    @Test
    @Journey("claims added by a hook")
    fun `claims added by a hook - the token the client hands out carries them, and a refresh keeps them without asking again`() =
        journey { world ->
            val hook = world.hook("before_token", """{"claims":{"plan":"pro","seats":5}}""")
            val account = signUp(world)
            assertEquals(1, hook.asked.get())
            val first = claims(account.tula.session.getToken())
            assertEquals(j("""{"plan":"pro","seats":5}"""), first["ext"])
            // Under the namespace claim only: nothing of the answer is a claim of its own.
            assertFalse(first.containsKey("plan"))

            hook.answer = """{"claims":{"plan":"free"}}"""
            val refreshed = claims(account.tula.session.refresh())
            assertEquals(j("""{"plan":"pro","seats":5}"""), refreshed["ext"])
            assertEquals(first["sid"], refreshed["sid"])
            assertEquals(1, hook.asked.get())

            // A new sign-in is a new session, and is asked about.
            val again = signIn(world, account.email)
            assertEquals(j("""{"plan":"free"}"""), claims(again.tula.session.getToken())["ext"])
            assertEquals(2, hook.asked.get())
        }

    @Test
    @Journey("sign-in hook that times out")
    fun `sign-in hook that times out - the client is told to try again later, in bounded time, and holds no session`() =
        journey { world ->
            val email = signUp(world).email
            val hook = world.hook("before_session", answer = null, deadlineMs = 100)
            val device = world.client()
            val flow = device.tula.signIn(email)
            val started = System.nanoTime()
            val error = caught { flow.submitPassword(PASSWORD) }
            assertTrue(System.nanoTime() - started < HOOK_WAIT_CEILING_NS)
            assertEquals("hook.unavailable", error.code)
            assertEquals(503, error.status)
            assertEquals("This is unavailable right now. Try again later.", error.message)
            assertNull(error.param("code"))
            assertEquals(1, hook.asked.get())
            assertFalse(device.tula.state.value is AuthState.SignedIn)
            assertNull(device.tula.session.getToken())
        }

    @Test
    @Journey("sign-in")
    fun `sign-in - password completes it, and a wrong password is the generic error`() = journey { world ->
        val email = signUp(world).email

        val wrong = world.client()
        val failing = wrong.tula.signIn(email)
        assertIs<FlowStep.NeedsPassword>(failing.step)
        val error = caught { failing.submitPassword("not-the-password-123") }
        assertEquals("auth.invalid_credentials", error.code)
        assertEquals(401, error.status)
        assertEquals("The email or password is incorrect.", error.message)
        assertEquals(AuthState.Loading, wrong.tula.state.value)
        // The same attempt can still be completed with the right password.
        assertEquals("complete", failing.submitPassword(PASSWORD).status)
        signedIn(wrong)

        // An address with no account gets the same first step and the same error.
        val ghost = world.client().tula.signIn("nobody@example.com")
        assertIs<FlowStep.NeedsPassword>(ghost.step)
        assertEquals("auth.invalid_credentials", caught { ghost.submitPassword(PASSWORD) }.code)
    }

    @Test
    @Journey("refresh rotation and reuse detection")
    fun `refresh - rotates the stored token, a replay inside the grace period is forgiven, after it the session ends`() =
        journey { world ->
            val key = world.storageKey
            val storage = MemoryTokenStorage()
            val device = world.client(storage)
            val email = world.freshEmail()
            device.tula.signUp(email = email, password = PASSWORD).verifyEmail(world.code(email))
            val first = storage.get(key)
            assertTrue(first.orEmpty().startsWith("tula_rt_"))
            val firstAccess = device.tula.session.getToken()

            // Rotation: a new access token and a new refresh token, stored in place of the old.
            world.advance(1_000)
            val secondAccess = device.tula.session.refresh()
            val second = storage.get(key)
            assertTrue(second.orEmpty().startsWith("tula_rt_"))
            assertNotEquals(first, second)
            assertNotEquals(firstAccess, secondAccess)

            // A second device restored from a copy of the old token, inside the grace period:
            // it is given the same next token, not a new one, and nobody is signed out.
            val copy = MemoryTokenStorage()
            copy.set(key, first.orEmpty())
            val racer = world.client(copy)
            assertIs<AuthState.SignedIn>(racer.tula.load())
            assertEquals(second, copy.get(key))
            signedIn(device)

            // The same replay after the grace period is reuse: the whole session ends.
            world.advance(11_000)
            val thief = MemoryTokenStorage()
            thief.set(key, first.orEmpty())
            val late = world.client(thief)
            assertEquals(AuthState.SignedOut, late.tula.load())
            assertNull(thief.get(key))
            assertEquals(401, world.refreshes().last().status)
            assertContains(world.refreshes().last().responseBody, "session.reuse_detected")

            // The legitimate client finds out at its next refresh: signed out once, no loop.
            val before = world.refreshes().size
            assertNull(device.tula.session.refresh())
            assertEquals(AuthState.SignedOut, device.tula.state.value)
            assertEquals(1, device.states.count { it == AuthState.SignedOut })
            assertNull(device.tula.session.getToken())
            assertEquals(before + 1, world.refreshes().size)
            assertNull(storage.get(key))
        }

    @Test
    @Journey("sign-out")
    fun `sign-out - ends the session on the server and in the client`() = journey { world ->
        val key = world.storageKey
        val storage = MemoryTokenStorage()
        val device = world.client(storage)
        val email = world.freshEmail()
        device.tula.signUp(email = email, password = PASSWORD).verifyEmail(world.code(email))
        val refreshToken = storage.get(key).orEmpty()

        device.tula.session.signOut()
        assertEquals(AuthState.SignedOut, device.tula.state.value)
        assertNull(storage.get(key))
        val last = world.exchanges.last()
        assertEquals("/v1/client/sessions/sign-out" to 204, last.path to last.status)

        // The refresh token is dead on the server too.
        val replay = MemoryTokenStorage()
        replay.set(key, refreshToken)
        assertEquals(AuthState.SignedOut, world.client(replay).tula.load())
        // Signing out again (nothing to revoke) is not an error.
        device.tula.session.signOut()
    }

    @Test
    @Journey("password policy")
    fun `password policy - a weak password is refused with one field error per rule`() = journey { world ->
        val tula = world.client().tula
        val email = world.freshEmail()
        val config = tula.config()

        val error = caught { tula.signUp(email = email, password = "short") }
        // The error's own code is the first rule that failed; `errors` lists every one.
        assertEquals("password.too_short", error.code)
        assertEquals(422, error.status)
        val short = error.errors.single { it.code == "password.too_short" }
        assertEquals("password", short.field)
        assertEquals("Password is too short.", short.message)
        assertEquals(mapOf<String, Any>("min" to config.password.minLength), short.params)

        val common = caught { tula.signUp(email = email, password = "password123") }
        assertContains(common.errors.map { it.code }, "password.common")

        val invalidEmail = caught { tula.signUp(email = "not-an-email", password = PASSWORD) }
        assertEquals(listOf("email" to "email.invalid"), invalidEmail.errors.map { it.field to it.code })
        assertEquals(emptyList(), world.outbox())
    }

    @Test
    @Journey("password lockout")
    fun `lockout - after repeated wrong passwords every try is rate_limited with a wait, even the right one`() =
        journey { world ->
            val email = signUp(world).email
            val device = world.client()
            val flow = device.tula.signIn(email)
            repeat(6) { attempt ->
                assertEquals("auth.invalid_credentials", caught { flow.submitPassword("wrong-password-$attempt") }.code)
            }
            val locked = caught { flow.submitPassword(PASSWORD) }
            assertEquals("rate_limited", locked.code)
            assertEquals(429, locked.status)
            val wait = assertNotNull(locked.retryAfterMs)
            assertTrue(wait > 0)
            assertEquals(wait / 1000.0, (locked.param("retryAfter") as Number).toDouble())
            assertEquals(AuthState.Loading, device.tula.state.value)

            // Once the wait is over the right password works.
            world.advance(wait + 1_000)
            assertEquals("complete", device.tula.signIn(email).submitPassword(PASSWORD).status)
        }

    @Test
    @Journey("admin ban and audit log")
    fun `a user banned by an admin is signed out at the next refresh, and cannot sign in`() = journey { world ->
        val account = signUp(world)
        val userId = signedIn(account.device).user?.id
        World.expect(200, world.admin("POST", "/v1/admin/users/$userId/ban"))

        assertNull(account.tula.session.refresh())
        assertEquals(AuthState.SignedOut, account.tula.state.value)
        assertEquals(AuthState.SignedOut, account.device.states.last())

        val flow = world.client().tula.signIn(account.email)
        val error = caught { flow.submitPassword(PASSWORD) }
        assertEquals("auth.user_banned" to 403, error.code to error.status)
    }

    @Test
    @Journey("sign-up for an existing address")
    fun `sign-up for an address that already has an account looks the same and creates nothing`() = journey { world ->
        val email = signUp(world).email
        // Past the one-email-a-minute limit for the address, which the first sign-up used.
        world.advance(61_000)
        val device = world.client()
        val flow = device.tula.signUp(email = email, password = NEW_PASSWORD)
        assertEquals("needs_email_verification", flow.step.status)
        // No code was sent to the existing account's address for this attempt, so nothing the
        // newcomer can type completes it.
        assertTrue(caught { flow.verifyEmail("000000") }.code.startsWith("verification."))
        assertEquals(AuthState.Loading, device.tula.state.value)
        // The original password still signs in: the account was not changed.
        assertEquals("complete", signIn(world, email).step.status)
    }

    @Test
    @Journey("verification code attempts")
    fun `verification - wrong codes are counted, a resend retires the old code, too many guesses lock the code`() =
        journey { world ->
            val device = world.client()
            val email = world.freshEmail()
            val flow = device.tula.signUp(email = email, password = PASSWORD)
            val firstCode = world.code(email)
            val wrongCode = if (firstCode == "000000") "111111" else "000000"

            val wrong = caught { flow.verifyEmail(wrongCode) }
            assertEquals("verification.invalid_code" to 422, wrong.code to wrong.status)
            // A resend asked for too soon is a typed rate limit with the wait.
            val tooSoon = caught { flow.resendCode() }
            assertEquals("rate_limited" to 429, tooSoon.code to tooSoon.status)
            assertTrue((tooSoon.retryAfterMs ?: 0) > 0)

            world.advance(61_000)
            assertEquals("needs_email_verification", flow.resendCode().status)
            val secondCode = world.code(email)
            // The first code was retired by the resend.
            if (secondCode != firstCode) {
                assertEquals("verification.invalid_code", caught { flow.verifyEmail(firstCode) }.code)
            }
            repeat(5) { caught { flow.verifyEmail(wrongCode) } }
            val spent = caught { flow.verifyEmail(secondCode) }
            assertEquals("verification.too_many_attempts" to 429, spent.code to spent.status)
            assertEquals(AuthState.Loading, device.tula.state.value)
        }

    @Test
    @Journey("password reset")
    fun `password reset - code and new password together, other sessions end, the old password stops working`() =
        journey { world ->
            val other = signUp(world)
            val email = other.email
            // Past the one-email-a-minute limit for the address, which the sign-up used.
            world.advance(61_000)
            val device = world.client()

            val flow = device.tula.resetPassword(email)
            assertEquals(FlowKind.PasswordReset, flow.kind)
            val waiting = assertIs<FlowStep.NeedsNewPassword>(flow.step)
            assertEquals(listOf("email_code"), waiting.value.strategies.map { it.rawValue })
            assertEquals(FlowScreen.NEEDS_NEW_PASSWORD, flow.screen)
            val code = world.code(email)

            val weak = caught { flow.submit(code = code, password = "short") }
            assertEquals("password.too_short", weak.code)
            assertContains(weak.errors.map { it.code }, "password.too_short")

            assertEquals("complete", flow.submit(code = code, password = NEW_PASSWORD).status)
            assertEquals(email, signedIn(device).user?.email)

            // Every session from before the reset is over.
            assertNull(other.tula.session.refresh())
            assertEquals(AuthState.SignedOut, other.tula.state.value)

            val old = world.client().tula.signIn(email)
            assertEquals("auth.invalid_credentials", caught { old.submitPassword(PASSWORD) }.code)
            assertEquals("complete", signIn(world, email, NEW_PASSWORD).step.status)

            // An address with no account gets the same first step.
            assertEquals("needs_new_password", world.client().tula.resetPassword("nobody@example.com").step.status)
        }

    @Test
    @Journey("password history")
    fun `password history - a reset to a password of the last three is password_reused and spends nothing`() =
        journey { world ->
            /** Replace the policy's `history` through the admin API, as an operator does. */
            fun remember(history: Int) = world.settings {
                it.with("password", "preset", value = JsonPrimitive("custom"))
                    .with("password", "history", value = JsonPrimitive(history))
            }
            val account = signUp(world)
            val email = account.email
            remember(3)
            // What a checklist is drawn from says how many are remembered.
            assertEquals(3, account.tula.config(force = true).password.history)

            suspend fun refused(call: suspend () -> Any?) {
                val error = caught(call)
                assertEquals("password.reused" to 422, error.code to error.status)
                assertEquals(mapOf<String, Any>("history" to 3L), error.params)
                // The message is the client's own, by code; nothing says which password it was.
                assertEquals("You have used this password recently. Choose a different one.", error.message)
                assertEquals(listOf("password.reused"), error.errors.map { it.code })
                assertEquals(mapOf<String, Any>("history" to 3L), error.errors.single().params)
            }

            // The current password is one of the three, and a refusal does not spend the code.
            world.advance(61_000)
            val first = world.client().tula.resetPassword(email)
            val firstCode = world.code(email)
            refused { first.submit(code = firstCode, password = PASSWORD) }
            assertEquals("complete", first.submit(code = firstCode, password = NEW_PASSWORD).status)

            // So is the one before it.
            world.advance(61_000)
            val second = world.client()
            val flow = second.tula.resetPassword(email)
            val code = world.code(email)
            refused { flow.submit(code = code, password = PASSWORD) }
            refused { flow.submit(code = code, password = NEW_PASSWORD) }
            assertEquals(AuthState.Loading, second.tula.state.value)
            assertEquals("complete", flow.submit(code = code, password = "amber-Lynx-skates-63-canals").status)

            // With the history back at 0 the first password is accepted again.
            remember(0)
            world.advance(61_000)
            val third = world.client().tula.resetPassword(email)
            assertEquals("complete", third.submit(code = world.code(email), password = PASSWORD).status)
            assertEquals("complete", signIn(world, email).step.status)
        }

    @Test
    @Journey("password expiry")
    fun `password expiry - a right password that is too old stops at needs_new_password, and submitNewPassword finishes the sign-in`() =
        journey { world ->
            val email = signUp(world).email
            world.settings {
                it.with("password", "preset", value = JsonPrimitive("custom"))
                    .with("password", "expiryDays", value = JsonPrimitive(1))
            }

            // Not a day old yet: the password signs in.
            assertEquals("complete", signIn(world, email).step.status)
            world.advance(86_400_000)

            val device = world.client()
            val tula = device.tula
            val flow = tula.signIn(email)
            // A wrong password is what it always was.
            assertEquals("auth.invalid_credentials", caught { flow.submitPassword("not-the-password-1") }.code)
            val step = assertIs<FlowStep.NeedsNewPassword>(flow.submitPassword(PASSWORD))
            assertEquals("expired", step.value.reason?.rawValue)
            assertEquals(emptyList(), step.value.strategies)
            assertEquals(FlowScreen.NEEDS_NEW_PASSWORD, flow.screen)
            assertFalse(tula.state.value is AuthState.SignedIn)
            assertNull(tula.session.getToken())

            // The expired password is not its own replacement, with no history in the policy too.
            val reused = caught { flow.submitNewPassword(PASSWORD) }
            assertEquals("password.reused" to 422, reused.code to reused.status)
            assertEquals(mapOf<String, Any>("history" to 1L), reused.params)
            assertEquals("You have used this password recently. Choose a different one.", reused.message)
            // A refusal leaves the flow on its step.
            assertEquals("needs_new_password", flow.step.status)
            assertFalse(tula.state.value is AuthState.SignedIn)

            assertEquals("complete", flow.submitNewPassword(NEW_PASSWORD).status)
            signedIn(device)
            assertEquals(j("""["pwd"]"""), claims(tula.session.getToken())["amr"])

            // The old password is wrong now; the new one signs in and is not asked to be replaced.
            val again = world.client().tula.signIn(email)
            assertEquals("auth.invalid_credentials", caught { again.submitPassword(PASSWORD) }.code)
            assertEquals("complete", again.submitPassword(NEW_PASSWORD).status)
        }

    @Test
    @Journey("environment settings")
    fun `config - the client sees the app name, methods and password policy an admin sets`() = journey { world ->
        val tula = world.client().tula
        val before = tula.config()
        assertEquals("Tula", before.app.name)
        assertEquals(listOf("password"), before.signIn.methods)
        assertEquals(10, before.password.minLength)

        world.settings {
            it.with("app", "name", value = JsonPrimitive("Northline"))
                .with("password", "preset", value = JsonPrimitive("custom"))
                .with("password", "minLength", value = JsonPrimitive(14))
        }

        // Kept until asked again.
        assertEquals("Tula", tula.config().app.name)
        val after = tula.config(force = true)
        assertEquals("Northline", after.app.name)
        assertEquals(14, after.password.minLength)

        // The server enforces what the config says.
        val error = caught { tula.signUp(email = world.freshEmail(), password = "twelve-chars") }
        val short = error.errors.single { it.code == "password.too_short" }
        assertEquals(mapOf<String, Any>("min" to 14L), short.params)
    }

    @Test
    @Journey("attempt binding")
    fun `attempt binding - the client sends the attempt's secret on every step, and a tampered or missing one is flow_not_found`() =
        journey { world ->
            val email = signUp(world).email

            val honest = world.client()
            honest.tula.signIn(email).submitPassword(PASSWORD)
            val sent = world.exchanges.last { it.path.endsWith("/password") }.headers["x-tula-attempt"]
            assertTrue(sent.orEmpty().startsWith("tula_at_"))
            signedIn(honest)

            val tampers = listOf<(Map<String, String>) -> Map<String, String>>(
                { it + ("x-tula-attempt" to "tula_at_not-the-secret") },
                { it - "x-tula-attempt" },
            )
            for (tamper in tampers) {
                val tampering = world.client(
                    network = Network(tamper = { request ->
                        if (request.headers.containsKey("x-tula-attempt")) {
                            HttpRequest(request.method, request.url, tamper(request.headers), request.body, request.timeoutMs)
                        } else {
                            request
                        }
                    }),
                )
                val bound = tampering.tula.signIn(email)
                val error = caught { bound.submitPassword(PASSWORD) }
                assertEquals("flow.not_found" to 404, error.code to error.status)
                assertEquals(AuthState.Loading, tampering.tula.state.value)
            }
            // Nothing was counted against the account by the refused tries.
            assertEquals("complete", signIn(world, email).step.status)
        }

    /** Switch the email methods on, as an operator does. */
    private fun emailMethods(world: World, signUpPassword: String = "required") {
        val saved = world.admin(
            "PUT",
            "/v1/admin/settings",
            """{"signIn":{"methods":{"password":{"enabled":true},"emailCode":{"enabled":true},"emailLink":{"enabled":true}}},""" +
                """"signUp":{"password":"$signUpPassword"}}""",
            mapOf("if-match" to "\"0\""),
        )
        World.expect(200, saved)
    }

    @Test
    @Journey("email code sign-in")
    fun `email code - the offered strategies, a code by email, a wrong code, the right one signs in`() = journey { world ->
        emailMethods(world)
        // A user an admin created, with no password.
        val email = world.freshEmail()
        World.expect(201, world.admin("POST", "/v1/admin/users", """{"email":"$email"}"""))
        val device = world.client()
        val tula = device.tula
        assertEquals(listOf("password", "emailCode", "emailLink"), tula.config().signIn.methods)

        val offered = listOf("password", "email_code", "email_link")
        val flow = tula.signIn(email)
        val choice = assertIs<FlowStep.NeedsFirstFactor>(flow.step)
        assertEquals(offered, choice.value.strategies.map { it.rawValue })
        assertNull(choice.value.prepared)
        // The link is offered and is not this client's to ask for: the screen is the code's.
        assertEquals(FlowScreen.NEEDS_FIRST_FACTOR, flow.screen)

        // An address with no account is offered, and answered, exactly the same.
        val ghost = world.client().tula.signIn("nobody@example.com")
        assertEquals(choice, ghost.step)
        val decoy = assertIs<FlowStep.NeedsFirstFactor>(ghost.prepareFirstFactor(CodeStrategy.EMAIL_CODE))
        assertEquals(offered, decoy.value.strategies.map { it.rawValue })
        assertEquals(PreparedFirstFactorStrategy.EmailCode, decoy.value.prepared?.strategy)
        assertEquals("n***@example.com", decoy.value.prepared?.destination)

        val prepared = assertIs<FlowStep.NeedsFirstFactor>(flow.prepareFirstFactor(CodeStrategy.EMAIL_CODE))
        assertEquals(PreparedFirstFactorStrategy.EmailCode, prepared.value.prepared?.strategy)
        val tooSoon = caught { flow.prepareFirstFactor(CodeStrategy.EMAIL_CODE) }
        assertEquals("rate_limited", tooSoon.code)
        assertEquals(60_000, tooSoon.retryAfterMs)

        val code = world.code(email)
        val wrong = code.dropLast(1) + ((code.last().digitToInt() + 1) % 10)
        val refused = caught { flow.attemptFirstFactor(CodeStrategy.EMAIL_CODE, wrong) }
        assertEquals("verification.invalid_code", refused.code)
        assertEquals(4L, refused.param("attemptsRemaining"))
        assertEquals(AuthState.Loading, tula.state.value)

        assertEquals("complete", flow.attemptFirstFactor(CodeStrategy.EMAIL_CODE, code).status)
        assertEquals(email, signedIn(device).user?.email)
        // The code proved the address.
        assertNotNull(tula.user().emailVerifiedAt)

        // The account has no password: one never works for it.
        val again = world.client().tula.signIn(email)
        assertEquals("auth.invalid_credentials", caught { again.submitPassword(PASSWORD) }.code)
    }

    @Test
    @Journey("passwordless sign-up")
    fun `passwordless sign-up - an account with no password, which then signs in by emailed code`() = journey { world ->
        // Where a sign-up needs a password, one without is refused for that field.
        World.create().use { required ->
            val refused = caught { required.client().tula.signUp(email = required.freshEmail()) }
            assertEquals("validation.failed" to 422, refused.code to refused.status)
            assertContains(refused.errors.map { it.field }, "password")
        }

        emailMethods(world, signUpPassword = "optional")
        val device = world.client()
        val tula = device.tula
        assertEquals("optional", tula.config().signUp?.password?.rawValue)
        val email = world.freshEmail()
        val signUpFlow = tula.signUp(email = email, firstName = "Ines")
        assertEquals("needs_email_verification", signUpFlow.step.status)
        assertEquals("complete", signUpFlow.verifyEmail(world.code(email)).status)
        val user = signedIn(device).user
        assertEquals(email to "Ines", user?.email to user?.firstName)
        assertEquals(false, tula.user().hasPassword)

        world.advance(61_000)
        val next = world.client()
        val flow = next.tula.signIn(email)
        assertEquals("auth.invalid_credentials", caught { flow.submitPassword(PASSWORD) }.code)
        flow.prepareFirstFactor(CodeStrategy.EMAIL_CODE)
        assertEquals("complete", flow.attemptFirstFactor(CodeStrategy.EMAIL_CODE, world.code(email)).status)
        signedIn(next)
    }

    /** Replace the `sessions` section whole: what it leaves out is the default. */
    private fun sessions(world: World, sessions: String) = world.settings { it.with("sessions", value = j(sessions)) }

    private suspend fun profileOf(device: Device): String? =
        (claims(device.tula.session.getToken())["sp"] as? JsonPrimitive)?.content

    @Test
    @Journey("session profile timeouts")
    fun `a session past its profile's limits signs the client out at its next refresh`() = journey { world ->
        val before = signUp(world)
        sessions(
            world,
            """{"profiles":{"mobile":{"accessTokenTtl":"30s","idleTimeout":"1m","absoluteTimeout":"90s"}}}""",
        )
        val active = signIn(world, before.email)
        assertEquals("mobile", profileOf(active.device))

        world.advance(50_000)
        assertNotNull(active.tula.session.refresh())
        signedIn(active.device)

        world.advance(45_000)
        // Active 45 seconds ago, but 95 seconds old: the absolute timeout ends it.
        assertNull(active.tula.session.refresh())
        assertEquals(AuthState.SignedOut, active.tula.state.value)
        // The session from before the profile was tightened ends at its next refresh too.
        assertNull(before.tula.session.refresh())
        assertEquals(AuthState.SignedOut, before.device.states.last())
    }

    @Test
    @Journey("session profile selection")
    fun `sessionProfile gets a profile the environment offers, and is otherwise ignored`() = journey { world ->
        sessions(
            world,
            """{"profiles":{"back-office":{"accessTokenTtl":"2m","clientSelectable":true},""" +
                """"kept":{"idleTimeout":"365d","absoluteTimeout":null}}}""",
        )
        val email = signUp(world).email
        suspend fun asked(sessionProfile: String?): String? {
            val device = world.client(sessionProfile = sessionProfile)
            device.tula.signIn(email).submitPassword(PASSWORD)
            return profileOf(device)
        }
        assertEquals("back-office", asked("back-office"))
        assertEquals("mobile", asked("kept"))
        assertEquals("mobile", asked("no-such-profile"))
        assertEquals("mobile", asked(null))
        // What was asked for travelled in the header, and only where it was asked for.
        val starts = world.exchanges.filter { it.path == "/v1/client/sign-ins" }
        assertEquals(
            listOf("back-office", "kept", "no-such-profile", null),
            starts.map { it.headers["x-tula-session-profile"] },
        )
    }

    @Test
    @Journey("jwt template custom claims")
    fun `the token the client hands out carries the template's claims, from the next refresh on`() = journey { world ->
        // An `android` client's sessions take the `mobile` profile.
        val account = signUp(world)
        assertNull(claims(account.tula.session.getToken())["ext"])

        sessions(
            world,
            """{"jwtTemplates":{"app":{"claims":{"role":{"value":"member"},"email":{"from":"user.email"},""" +
                """"verified":{"from":"user.email_verified"},"client":{"from":"session.client"}}}},""" +
                """"profiles":{"mobile":{"jwtTemplate":"app"}}}""",
        )
        // The token in hand is unchanged; the one a refresh brings has the claims.
        assertNull(claims(account.tula.session.getToken())["ext"])
        val refreshed = claims(account.tula.session.refresh())
        assertEquals(
            j("""{"role":"member","email":"${account.email}","verified":true,"client":"android"}"""),
            refreshed["ext"],
        )

        val again = signIn(world, account.email)
        val ext = claims(again.tula.session.getToken()).getValue("ext").jsonObject
        assertEquals(JsonPrimitive("member") to JsonPrimitive("android"), ext["role"] to ext["client"])

        sessions(world, """{"jwtTemplates":{"app":{"claims":{}}}}""")
        assertNull(claims(account.tula.session.refresh())["ext"])
    }

    @Test
    @Journey("concurrent session limit")
    fun `end_oldest signs the oldest client out, and refuse_newest fails the sign-in with session_limit_reached`() =
        journey { world ->
            sessions(world, """{"maxPerUser":2,"onLimit":"end_oldest"}""")
            val first = signUp(world)
            val second = signIn(world, first.email)
            val third = signIn(world, first.email)
            assertEquals("complete", third.step.status)
            // The oldest device finds out on its next call: its token is refused and it cannot refresh.
            assertEquals("session.revoked", caught { first.tula.user() }.code)
            assertEquals(AuthState.SignedOut, first.tula.state.value)
            assertEquals(first.email, second.tula.user().email)

            sessions(world, """{"maxPerUser":2,"onLimit":"refuse_newest"}""")
            val refused = world.client()
            val flow = refused.tula.signIn(first.email)
            val error = caught { flow.submitPassword(PASSWORD) }
            assertEquals("session.limit_reached" to 403, error.code to error.status)
            assertContains(error.message.orEmpty(), "too many devices")
            assertFalse(refused.tula.state.value is AuthState.SignedIn)

            second.tula.session.signOut()
            assertEquals("complete", signIn(world, first.email).step.status)
        }

    @Test
    @Journey("email wording")
    fun `email wording - a sign-up completes with the code from an email in the environment's own words`() =
        journey { world ->
            val saved = world.admin(
                "PUT",
                "/v1/admin/settings",
                """{"emails":{"templates":{"email_verification":{"subject":"Welcome to {{appName}}: your code is inside",""" +
                    """"body":"Welcome aboard.\n\nYour code: {{code}}\n\nGood for {{expiresInMinutes}} minutes."}}}}""",
                mapOf("if-match" to "\"0\""),
            )
            World.expect(200, saved)
            val device = world.client()
            val email = world.freshEmail()
            val flow = device.tula.signUp(email = email, password = PASSWORD)
            assertEquals("needs_email_verification", flow.step.status)

            // Nothing of the product reads a subject: only this suite's own `code` does, and
            // it finds no code in this one.
            val sent = world.outbox(email).last()
            assertEquals("Welcome to Tula: your code is inside", sent.text("subject"))
            assertTrue(runCatching { world.code(email) }.exceptionOrNull() is AssertionError)
            val text = sent.text("text")
            val code = Regex("^Your code: (\\d{6})$", RegexOption.MULTILINE).find(text)?.groupValues?.get(1)
            assertTrue(text.startsWith("Welcome aboard.\n\nYour code: $code\n\nGood for 10 minutes."))

            assertEquals("complete", flow.verifyEmail(code.orEmpty()).status)
            assertEquals(email, signedIn(device).user?.email)
        }

    private val smsOn = """{"enabled":true,"allowedCountries":["US"],"dailyMessageLimit":500,"templates":{}}"""

    /** Offer a texted sign-in code (or stop), with these `sms` settings. */
    private fun smsSignIn(world: World, smsCode: Boolean, sms: String = smsOn) = world.settings {
        it.with("signIn", "methods", "smsCode", value = j("""{"enabled":$smsCode}""")).with("sms", value = j(sms))
    }

    private fun assertSmsChoice(step: FlowStep, destination: String?) {
        val choice = assertIs<FlowStep.NeedsFirstFactor>(step)
        assertEquals(listOf("password", "sms_code"), choice.value.strategies.map { it.rawValue })
        assertEquals(destination, choice.value.prepared?.destination)
        if (destination != null) {
            assertEquals(PreparedFirstFactorStrategy.SmsCode, choice.value.prepared?.strategy)
        }
    }

    @Test
    @Journey("sign in with a texted code")
    fun `a sign-in started with a phone number is proven with the texted code, and the session says sms`() =
        journey { world ->
            val number = "+12025550143"
            smsSignIn(world, true)
            assertContains(world.client().tula.config().signIn.methods, "smsCode")
            val owner = withNumber(world, number)
            val ownerId = owner.tula.user().id

            val device = world.client()
            val tula = device.tula
            // The number as a person types it.
            val flow = tula.signIn("+1 (202) 555-0143")
            assertSmsChoice(flow.step, null)
            assertEquals(FlowScreen.NEEDS_FIRST_FACTOR, flow.screen)
            val before = world.texts().size
            val prepared = flow.prepareFirstFactor(CodeStrategy.SMS_CODE)
            assertSmsChoice(prepared, "***43")
            // The message is sent apart from the answer, so that its sending says nothing.
            assertEquals(before + 1, world.texts().size)
            val code = world.textedCode(number)
            assertFalse(world.exchanges.last().responseBody.contains(code))
            val again = caught { flow.prepareFirstFactor(CodeStrategy.SMS_CODE) }
            assertEquals("rate_limited" to 429, again.code to again.status)

            val wrong = code.dropLast(1) + ((code.last().digitToInt() + 1) % 10)
            val refused = caught { flow.attemptFirstFactor(CodeStrategy.SMS_CODE, wrong) }
            assertEquals("auth.invalid_credentials" to 401, refused.code to refused.status)
            assertEquals(emptyMap(), refused.params)
            assertFalse(tula.state.value is AuthState.SignedIn)

            val step = assertIs<FlowStep.Complete>(flow.attemptFirstFactor(CodeStrategy.SMS_CODE, code))
            assertEquals(ownerId, step.value.userId)
            signedIn(device)
            assertEquals(j("""["sms"]"""), claims(tula.session.getToken())["amr"])
            assertEquals(number, tula.user().phoneNumber)
        }

    @Test
    @Journey("a texted sign-in code for an unknown number")
    fun `asking for a texted code answers the same for a number nobody holds, and sends nothing`() = journey { world ->
        smsSignIn(world, true, """{"enabled":true,"allowedCountries":["US","FR"],"dailyMessageLimit":500,"templates":{}}""")

        val device = world.client()
        val flow = device.tula.signIn("+33639980142")
        assertSmsChoice(flow.step, null)
        assertSmsChoice(flow.prepareFirstFactor(CodeStrategy.SMS_CODE), "***42")
        assertEquals("rate_limited", caught { flow.prepareFirstFactor(CodeStrategy.SMS_CODE) }.code)
        assertEquals(emptyList(), world.texts())
        val usage = world.admin("GET", "/v1/admin/sms/usage?days=1")
        assertFalse(usage.body.contains("+33"))
        for (guess in listOf("000000", "123456")) {
            val refused = caught { flow.attemptFirstFactor(CodeStrategy.SMS_CODE, guess) }
            assertEquals("auth.invalid_credentials" to 401, refused.code to refused.status)
        }

        // An address that asks for a texted code is an unknown number.
        val byEmail = world.client().tula.signIn(world.freshEmail())
        val masked = assertIs<FlowStep.NeedsFirstFactor>(byEmail.prepareFirstFactor(CodeStrategy.SMS_CODE))
        assertEquals("***", masked.value.prepared?.destination)
        assertEquals(
            "auth.invalid_credentials",
            caught { byEmail.attemptFirstFactor(CodeStrategy.SMS_CODE, "000000") }.code,
        )

        // A country that is not on the list is refused, whoever holds the number.
        val abroad = world.client().tula.signIn("+4915112345678")
        assertEquals("sms.country_not_allowed", caught { abroad.prepareFirstFactor(CodeStrategy.SMS_CODE) }.code)
        assertEquals(emptyList(), world.texts())
        assertFalse(device.tula.state.value is AuthState.SignedIn)
    }

    @Test
    @Journey("a texted sign-in code after the method is switched off")
    fun `a code texted while the method was on is refused once the method, text messages or the country is off`() =
        journey { world ->
            val number = "+12025550144"
            smsSignIn(world, true)
            withNumber(world, number)

            val device = world.client()
            val tula = device.tula
            val flow = tula.signIn(number)
            flow.prepareFirstFactor(CodeStrategy.SMS_CODE)
            val code = world.textedCode(number)
            val sent = world.texts().size
            suspend fun attempt() = caught { flow.attemptFirstFactor(CodeStrategy.SMS_CODE, code) }

            smsSignIn(world, false)
            val off = attempt()
            assertEquals("auth.method_disabled" to 403, off.code to off.status)
            assertEquals("auth.method_disabled", caught { flow.prepareFirstFactor(CodeStrategy.SMS_CODE) }.code)
            // With the password the only method left, the step is the password's own.
            assertIs<FlowStep.NeedsPassword>(world.client().tula.signIn(number).step)

            smsSignIn(world, true, """{"enabled":false,"allowedCountries":["US"],"dailyMessageLimit":500,"templates":{}}""")
            assertEquals("sms.disabled", attempt().code)
            smsSignIn(world, true, """{"enabled":true,"allowedCountries":["DE"],"dailyMessageLimit":500,"templates":{}}""")
            assertEquals("sms.country_not_allowed", attempt().code)
            assertEquals(sent, world.texts().size)
            assertFalse(tula.state.value is AuthState.SignedIn)

            // Nothing was used up by the refusals.
            smsSignIn(world, true)
            assertEquals("complete", flow.attemptFirstFactor(CodeStrategy.SMS_CODE, code).status)
            assertEquals(j("""["sms"]"""), claims(tula.session.getToken())["amr"])
        }

    @Test
    @Journey("a profile that requires a device key refuses a native sign-in without one")
    fun `device binding required - a client with no device key is told so at the start, by a code of its own`() =
        journey { world ->
            sessions(world, """{"profiles":{"mobile":{"deviceBinding":"required"}}}""")
            val device = world.client()
            val tula = device.tula
            val email = world.freshEmail()
            val signUpError = caught { tula.signUp(email = email, password = PASSWORD) }
            assertEquals("device.binding_required" to 400, signUpError.code to signUpError.status)
            // The same for a sign-in, whoever it names: nothing was looked up.
            assertEquals("device.binding_required", caught { tula.signIn(email) }.code)
            // One request each, with no proof: the client does not retry what it cannot answer.
            assertEquals(listOf(400, 400), world.exchanges.map { it.status })
            assertTrue(world.exchanges.none { it.headers.containsKey("dpop") })
            // A device code never ends anything: the client is as it was, and holds no session.
            assertEquals(AuthState.Loading, tula.state.value)
            assertEquals(AuthState.SignedOut, tula.load())
            assertNull(tula.session.getToken())
            // Nothing was made or sent for the refused starts.
            assertFalse(world.userExists(email))
            assertEquals(emptyList(), world.outbox())
        }

    @Test
    @Journey("a session that is not bound behaves as before")
    fun `device binding - a client without a device key sends no proof and gets a session with no key`() =
        journey { world ->
            val account = signUp(world)
            assertNull(claims(account.tula.session.getToken())["cnf"])
            world.advance(1_000)
            assertNotNull(account.tula.session.refresh())
            assertTrue(world.exchanges.none { it.headers.containsKey("dpop") })
            assertEquals(listOf(200), world.refreshes().map { it.status })
        }

    @Test
    @Behaviour("concurrent_refresh")
    fun `an expired access token is refreshed before use, and ten calls at once share one refresh`() = journey { world ->
        val account = signUp(world)
        val tula = account.tula
        val first = tula.session.getToken()

        world.advance(49_000)
        assertEquals(first, tula.session.getToken())
        assertEquals(0, world.refreshes().size)

        world.advance(2_000)
        val tokens = List(10) { async { tula.session.getToken() } }.awaitAll()
        assertEquals(1, tokens.toSet().size)
        assertNotEquals(first, tokens.first())
        assertEquals(1, world.refreshes().size)

        // A call made with a token the server has just stopped accepting is retried once.
        world.advanceServerOnly(61_000)
        assertEquals(account.email, tula.user().email)
        assertEquals(2, world.refreshes().size)
        val profile = world.exchanges.filter { it.path == "/v1/client/me" }.takeLast(2)
        assertEquals(listOf(401, 200), profile.map { it.status })
    }

    /** A signed-in device whose next refresh answers can be lost on the way back. */
    private class Lossy(val device: Device, private val remaining: IntArray) {
        fun loseNext(count: Int) {
            remaining[0] = count
        }
    }

    private suspend fun lossy(world: World): Lossy {
        val remaining = intArrayOf(0)
        val device = world.client(
            network = Network(loseResponse = { request ->
                if (request.url.endsWith(REFRESH) && remaining[0] > 0) {
                    remaining[0] -= 1
                    true
                } else {
                    false
                }
            }),
        )
        val email = world.freshEmail()
        device.tula.signUp(email = email, password = PASSWORD).verifyEmail(world.code(email))
        return Lossy(device, remaining)
    }

    @Test
    @Behaviour("refresh_without_answer")
    fun `one lost answer - getToken alone ends with a working session and the family intact`() = journey { world ->
        val lossy = lossy(world)
        val tula = lossy.device.tula
        world.advance(61_000)

        // The server rotates the token; the answer never arrives. The client asks again at
        // once with the token it still holds, and is given the same next token.
        lossy.loseNext(1)
        assertNotNull(tula.session.getToken())
        assertEquals(listOf(200, 200), world.refreshes().map { it.status })
        assertEquals(world.refreshes()[0].requestBody, world.refreshes()[1].requestBody)
        assertEquals(world.refreshes()[0].responseBody.refreshToken(), world.refreshes()[1].responseBody.refreshToken())
        signedIn(lossy.device)
        assertNotNull(tula.user().id)

        // The family was not revoked: the next rotation works, with one request.
        world.advance(61_000)
        assertNotNull(tula.session.getToken())
        assertEquals(listOf(200, 200, 200), world.refreshes().map { it.status })
        assertEquals(1, lossy.device.states.size)
    }

    @Test
    @Behaviour("refresh_without_answer")
    fun `both tries lost, then asked again inside the grace period - still the same next token, session intact`() =
        journey { world ->
            val lossy = lossy(world)
            val tula = lossy.device.tula
            world.advance(61_000)

            lossy.loseNext(2)
            assertEquals("network.failed", caught { tula.session.getToken() }.code)
            // Two tries, no third.
            assertEquals(listOf(200, 200), world.refreshes().map { it.status })
            signedIn(lossy.device)

            world.advance(3_000)
            assertNotNull(tula.session.getToken())
            assertEquals(listOf(200, 200, 200), world.refreshes().map { it.status })
            world.advance(61_000)
            assertNotNull(tula.session.getToken())
            assertEquals(1, lossy.device.states.size)
        }

    @Test
    fun `both tries lost, then asked again after the grace period - the server sees reuse and the client signs out, once`() =
        journey { world ->
            val lossy = lossy(world)
            val tula = lossy.device.tula
            world.advance(61_000)
            lossy.loseNext(2)
            caught { tula.session.getToken() }

            world.advance(11_000)
            assertNull(tula.session.getToken())
            assertEquals(401, world.refreshes().last().status)
            assertContains(world.refreshes().last().responseBody, "session.reuse_detected")
            assertEquals(listOf("SignedIn", "SignedOut"), lossy.device.states.map { it::class.simpleName })
            assertNull(lossy.device.storage.get(world.storageKey))
            // No retry loop.
            assertNull(tula.session.getToken())
            assertEquals(3, world.refreshes().size)
        }

    @Test
    fun `an idle session past its timeout is over - the client signs out, once`() = journey { world ->
        val account = signUp(world)
        world.advance(8L * 24 * 60 * 60 * 1000)
        assertNull(account.tula.session.getToken())
        assertEquals(listOf("SignedIn", "SignedOut"), account.device.states.map { it::class.simpleName })
        assertEquals(1, world.refreshes().size)
    }

    @Test
    @Behaviour("session_kept_through_failed_refresh_offline")
    fun `offline when the token runs out - the refresh fails, the session and its stored token are kept, and it goes on when the network is back`() =
        journey { world ->
            var offline = false
            val storage = MemoryTokenStorage()
            val device = world.client(storage, network = Network(offline = { offline }))
            val tula = device.tula
            val email = world.freshEmail()
            tula.signUp(email = email, password = PASSWORD).verifyEmail(world.code(email))
            val stored = assertNotNull(storage.get(world.storageKey))
            val signedIn = signedIn(device)

            // The access token runs out with no network. Nothing reaches the server, so
            // nothing says the session is over: the failure is the network's and the client
            // stays as it was.
            offline = true
            world.advance(61_000)
            val error = caught { tula.session.getToken() }
            assertEquals("network.failed" to 0, error.code to error.status)
            // Asked again, still offline: the same, however often.
            assertEquals("network.failed", caught { tula.session.getToken() }.code)
            assertEquals(0, world.refreshes().size)
            assertSame(signedIn, tula.state.value)
            assertEquals(1, device.states.size)
            assertEquals(stored, storage.get(world.storageKey))

            // Back online, the token kept through the outage is still the session's: one
            // refresh, the same session, and no change of state for the application to react to.
            offline = false
            val token = assertNotNull(tula.session.getToken())
            assertEquals(listOf(200), world.refreshes().map { it.status })
            assertNotEquals(stored, storage.get(world.storageKey))
            assertEquals(JsonPrimitive(signedIn.sessionId), claims(token)["sid"])
            assertEquals(email, tula.user().email)
            assertEquals(1, device.states.size)
        }

    @Test
    @Behaviour("unknown_step_not_supported")
    fun `a step from a newer server is kept as it was sent and is not supported - no error, nobody signed in, no request made on a guess`() =
        journey { world ->
            val email = signUp(world).email
            val newer = j("""{"status":"needs_retina_scan","prompt":"look into the camera"}""").jsonObject
            val storage = MemoryTokenStorage()
            val device = world.client(
                storage,
                // The real server's answer to the start, with its step replaced by one no
                // client of today has a screen for: what a server a few versions on may send.
                network = Network(answer = { request, response ->
                    if (request.url.endsWith("/v1/client/sign-ins") && response.status == 200) {
                        HttpResponse(200, response.headers, JsonObject(j(response.body).jsonObject + ("step" to newer)).toString())
                    } else {
                        response
                    }
                }),
            )
            val before = world.exchanges.size

            val flow = device.tula.signIn(email)
            val step = assertIs<FlowStep.Unknown>(flow.step)
            assertEquals("needs_retina_scan", step.status)
            assertEquals(newer, step.raw)
            assertEquals(FlowKind.SignIn, flow.kind)
            // What a UI draws for it: "not supported", never a blank screen or a guess.
            assertEquals(FlowScreen.NOT_SUPPORTED, flow.screen)
            // The start, and nothing after it: the client proves nothing and asks nothing by itself.
            assertEquals(listOf("/v1/client/sign-ins"), world.exchanges.drop(before).map { it.path })
            assertFalse(device.tula.state.value is AuthState.SignedIn)
            assertEquals(emptyList(), device.states)
            assertNull(storage.get(world.storageKey))

            // The application can leave the attempt, and a new one is a sign-in like any other.
            flow.discard()
            assertEquals("complete", signIn(world, email).step.status)
        }

    /** A user with an authenticator app, a time step after its code confirmed the enrolment. */
    private class Enrolled(val device: Device, val email: String, val secret: String, val codes: List<String>) {
        val tula get() = device.tula
    }

    private suspend fun enrolled(world: World): Enrolled {
        val account = signUp(world)
        val secret = account.tula.factors.startTotp().secret
        val codes = account.tula.factors.confirmTotp(world.totp(secret))
        // The next sign-in's code is of another time step: a code is accepted once.
        world.advance(Totp.STEP_MS)
        return Enrolled(account.device, account.email, secret, codes)
    }

    private fun options(step: FlowStep): List<String> =
        assertIs<FlowStep.NeedsSecondFactor>(step).value.options.map { it.rawValue }

    /** A device that proved the password and waits at the second factor. */
    private suspend fun atSecondFactor(
        world: World,
        email: String,
        password: String = PASSWORD,
        offered: List<String> = listOf("totp", "backup_code"),
        passkeys: PasskeySheet? = null,
    ): Entry {
        val device = world.client(passkeys = passkeys)
        val flow = device.tula.signIn(email)
        val step = flow.submitPassword(password)
        assertEquals(offered, options(step))
        assertFalse(device.tula.state.value is AuthState.SignedIn)
        return Entry(device, flow, step)
    }

    private suspend fun proven(device: Device): Set<String> = amr(device.tula.session.getToken())

    private fun stepUps(world: World) = world.sent("/v1/client/sessions/step-up")

    @Test
    @Journey("two-step enrolment and sign-in")
    fun `two-step verification - enrol an authenticator, then sign in with the password and its code`() =
        journey { world ->
            val account = signUp(world)
            val tula = account.tula
            var factors = tula.factors.get()
            assertFalse(factors.totp.enabled)
            assertNull(factors.totp.confirmedAt)
            assertEquals(0, factors.backupCodes.remaining)
            assertEquals(false, factors.sms?.enabled)

            val enrolment = tula.factors.startTotp()
            val secret = enrolment.secret
            assertTrue(Regex("^[A-Z2-7]{32}$").matches(secret))
            assertTrue(enrolment.uri.startsWith("otpauth://totp/"))
            assertContains(enrolment.uri, "secret=$secret")
            assertFalse(tula.factors.get().totp.enabled)

            val refused = caught { tula.factors.confirmTotp(world.wrongTotp(secret)) }
            assertEquals("mfa.invalid_code", refused.code)
            assertEquals(422, refused.status)
            val before = world.refreshes().size
            val codes = tula.factors.confirmTotp(world.totp(secret))
            assertEquals(10, codes.size)
            assertTrue(codes.all(::isBackupCode))
            // The client refreshed by itself, so that its token says what was proven.
            assertEquals(before + 1, world.refreshes().size)
            assertContains(proven(account.device), "mfa")
            factors = tula.factors.get()
            assertTrue(factors.totp.enabled)
            assertEquals(10, factors.backupCodes.remaining)
            val visible = "$tula ${tula.state.value} ${tula.factors}"
            for (hidden in codes + secret) {
                assertFalse(hidden in visible)
            }

            world.advance(Totp.STEP_MS)
            val second = atSecondFactor(world, account.email)
            assertEquals(FlowScreen.NEEDS_SECOND_FACTOR, second.flow.screen)
            assertEquals("complete", second.flow.submitTotp(world.totp(secret)).status)
            assertEquals(account.email, signedIn(second.device).user?.email)
            assertTrue(proven(second.device).containsAll(setOf("pwd", "otp", "mfa")))
            assertEquals(10, second.tula.factors.get().backupCodes.remaining)
        }

    @Test
    @Journey("second factor lockout")
    fun `second factor lockout - six wrong codes, then every try is rate_limited, for the user and not the attempt`() =
        journey { world ->
            val user = enrolled(world)
            val first = atSecondFactor(world, user.email)
            val wrong = world.wrongTotp(user.secret)
            repeat(6) {
                val error = caught { first.flow.submitTotp(wrong) }
                assertEquals("mfa.invalid_code", error.code)
                assertEquals(422, error.status)
            }
            val locked = caught { first.flow.submitTotp(wrong) }
            assertEquals("rate_limited", locked.code)
            assertEquals(429, locked.status)
            assertTrue((locked.retryAfterMs ?: 0) > 0)
            assertEquals("rate_limited", caught { first.flow.submitBackupCode(user.codes[0]) }.code)
            assertEquals("needs_second_factor", first.flow.step.status)

            // The count is the user's: a new attempt with the right code is locked out too.
            val again = atSecondFactor(world, user.email)
            val still = caught { again.flow.submitTotp(world.totp(user.secret)) }
            assertEquals("rate_limited", still.code)
            assertEquals(429, still.status)
            assertFalse(again.tula.state.value is AuthState.SignedIn)
            assertFalse(first.tula.state.value is AuthState.SignedIn)
        }

    @Test
    @Journey("authenticator code replay")
    fun `an authenticator code is accepted once - not after it confirmed the enrolment, and not on a second sign-in`() =
        journey { world ->
            val account = signUp(world)
            val secret = account.tula.factors.startTotp().secret
            val confirming = world.totp(secret)
            account.tula.factors.confirmTotp(confirming)

            val first = atSecondFactor(world, account.email)
            var replayed = caught { first.flow.submitTotp(confirming) }
            assertEquals("mfa.invalid_code", replayed.code)
            assertEquals(422, replayed.status)
            assertFalse(first.tula.state.value is AuthState.SignedIn)

            world.advance(Totp.STEP_MS)
            val next = world.totp(secret)
            assertEquals("complete", first.flow.submitTotp(next).status)
            signedIn(first.device)

            val second = atSecondFactor(world, account.email)
            replayed = caught { second.flow.submitTotp(next) }
            assertEquals("mfa.invalid_code", replayed.code)
            assertFalse(second.tula.state.value is AuthState.SignedIn)
        }

    @Test
    @Journey("backup codes")
    fun `backup codes - each works once and says how many are left, and a new set replaces the old one`() =
        journey { world ->
            val user = enrolled(world)
            val codes = user.codes

            val first = atSecondFactor(world, user.email)
            var refused = caught { first.flow.submitBackupCode(unknownBackupCode(codes)) }
            assertEquals("mfa.invalid_code", refused.code)
            assertEquals(422, refused.status)
            var used = first.flow.submitBackupCode("  ${codes[0]}  ")
            assertEquals("complete", used.step.status)
            assertEquals(9, used.remaining)
            signedIn(first.device)
            assertEquals(9, first.tula.factors.get().backupCodes.remaining)
            assertFalse(codes[0] in "${first.flow} $used ${first.flow.snapshot()}")

            val second = atSecondFactor(world, user.email)
            refused = caught { second.flow.submitBackupCode(codes[0]) }
            assertEquals("mfa.invalid_code", refused.code)
            used = second.flow.submitBackupCode(codes[1])
            assertEquals("complete", used.step.status)
            assertEquals(8, used.remaining)

            val fresh = second.tula.factors.regenerateBackupCodes()
            assertEquals(10, fresh.size)
            assertTrue(fresh.none { it in codes })
            assertEquals(10, second.tula.factors.get().backupCodes.remaining)

            val third = atSecondFactor(world, user.email)
            assertEquals("mfa.invalid_code", caught { third.flow.submitBackupCode(codes[2]) }.code)
            used = third.flow.submitBackupCode(fresh[0])
            assertEquals("complete", used.step.status)
            assertEquals(9, used.remaining)
            signedIn(third.device)
        }

    @Test
    @Journey("password reset with a second factor")
    fun `a password reset stops at the second factor - no session until the authenticator's code`() =
        journey { world ->
            val before = enrolled(world)
            world.advance(61_000)
            val device = world.client()
            val flow = device.tula.resetPassword(before.email)
            val step = flow.submit(world.code(before.email), NEW_PASSWORD)
            assertEquals(listOf("totp", "backup_code"), options(step))
            assertEquals(FlowScreen.NEEDS_SECOND_FACTOR, flow.screen)
            assertFalse(device.tula.state.value is AuthState.SignedIn)

            val refused = caught { flow.submitTotp(world.wrongTotp(before.secret)) }
            assertEquals("mfa.invalid_code", refused.code)
            assertEquals(422, refused.status)
            assertEquals("needs_second_factor", flow.step.status)

            assertEquals("complete", flow.submitTotp(world.totp(before.secret)).status)
            assertEquals(before.email, signedIn(device).user?.email)

            // The reset ended the session the password was changed under.
            assertNull(before.tula.session.refresh())
            assertEquals(AuthState.SignedOut, before.tula.state.value)
            world.advance(Totp.STEP_MS)
            atSecondFactor(world, before.email, password = NEW_PASSWORD)
        }

    @Test
    @Journey("step-up")
    fun `step-up - a sensitive call says what to prove, a step-up installs a fresh token for the same session, and the repeated call succeeds`() =
        journey { world ->
            val account = signUp(world)
            val tula = account.tula
            val sessionId = signedIn(account.device).sessionId

            val wrongPassword = caught { tula.stepUp.withPassword("wrong-password-1") }
            assertEquals("auth.invalid_credentials", wrongPassword.code)
            assertEquals(401, wrongPassword.status)
            signedIn(account.device)
            val tokenBefore = tula.session.getToken()
            val stored = account.device.storage.get(world.storageKey)
            world.advance(1_000)
            tula.stepUp.withPassword(PASSWORD)
            assertNotEquals(tokenBefore, tula.session.getToken())
            assertEquals(sessionId, signedIn(account.device).sessionId)
            assertContains(proven(account.device), "pwd")
            // A step-up answers an access token and no refresh token: what is stored stays.
            assertEquals(200, stepUps(world).last().status)
            assertFalse("refreshToken" in stepUps(world).last().responseBody)
            assertEquals(stored, account.device.storage.get(world.storageKey))
            assertEquals(0, world.refreshes().size)
            assertTrue(account.device.states.all { it is AuthState.SignedIn })

            val noFactor = caught { tula.stepUp.withTotp("123456") }
            assertEquals("auth.step_up_required", noFactor.code)
            assertEquals(listOf("password", "email_code"), noFactor.stepUpMethods)

            val secret = tula.factors.startTotp().secret
            val codes = tula.factors.confirmTotp(world.totp(secret))
            assertEquals(10, tula.factors.get().backupCodes.remaining)

            world.advance(11 * 60_000)
            val refusals = listOf(
                caught { tula.factors.regenerateBackupCodes() },
                caught { tula.factors.disableTotp() },
                caught { tula.changePassword(PASSWORD, NEW_PASSWORD) },
            )
            for (refused in refusals) {
                assertEquals("auth.step_up_required", refused.code)
                assertEquals(403, refused.status)
                assertEquals(listOf("totp", "backup_code"), refused.stepUpMethods)
            }
            val asked = stepUps(world).size

            // With a second factor the password alone steps nothing up.
            assertEquals(listOf("totp", "backup_code"), caught { tula.stepUp.withPassword(PASSWORD) }.stepUpMethods)
            val badCode = caught { tula.stepUp.withBackupCode(unknownBackupCode(codes)) }
            assertEquals("mfa.invalid_code", badCode.code)
            assertEquals(422, badCode.status)
            assertEquals(asked + 2, stepUps(world).size)

            val refreshes = world.refreshes().size
            tula.stepUp.withBackupCode(codes[0])
            assertEquals(refreshes, world.refreshes().size)
            assertTrue(proven(account.device).containsAll(setOf("backup_code", "mfa")))
            assertEquals(sessionId, signedIn(account.device).sessionId)

            assertEquals(10, tula.factors.regenerateBackupCodes().size)
            // What was proven is the session's: a refresh keeps it.
            tula.session.refresh()
            assertContains(proven(account.device), "mfa")
            tula.changePassword(PASSWORD, NEW_PASSWORD)
            signedIn(account.device)
        }

    @Test
    @Journey("step-up window per profile")
    fun `a sensitive call past the profile's window asks for a step-up, and works again after it`() =
        journey { world ->
            world.settings {
                it.with("sessions", "profiles", "mobile", "accessTokenTtl", value = JsonPrimitive("5m"))
                    .with("sessions", "profiles", "mobile", "stepUpAfter", value = JsonPrimitive("1m"))
            }
            val account = signUp(world)
            val tula = account.tula
            tula.factors.startTotp()
            world.advance(61_000)
            val error = caught { tula.factors.startTotp() }
            assertEquals("auth.step_up_required", error.code)
            assertContains(error.stepUpMethods, "password")
            // Only what changes how the account is protected asks: the user is still read.
            assertTrue(tula.user().id.isNotEmpty())
            tula.stepUp.withPassword(PASSWORD)
            assertTrue(tula.factors.startTotp().secret.isNotEmpty())
        }

    @Test
    @Journey("admin second factor reset")
    fun `an admin resets a user's second factor - their sessions end at once, and the next sign-in needs the password alone`() =
        journey { world ->
            val user = enrolled(world)
            val userId = signedIn(user.device).user?.id
            World.expect(204, world.admin("DELETE", "/v1/admin/users/$userId/factors"))

            assertEquals(401, caught { user.tula.factors.get() }.status)
            assertEquals(AuthState.SignedOut, user.tula.state.value)
            assertEquals(1, user.device.states.count { it == AuthState.SignedOut })

            val again = signIn(world, user.email)
            assertEquals("complete", again.step.status)
            val factors = again.tula.factors.get()
            assertFalse(factors.totp.enabled)
            assertEquals(0, factors.backupCodes.remaining)
        }

    @Test
    @Journey("required second factor")
    fun `policy required - sign-in and sign-up stop at the enrolment and complete with backup codes, and the factor cannot be turned off`() =
        journey { world ->
            val existing = signUp(world)
            assertEquals("optional", existing.tula.config().mfa?.policy?.rawValue)
            world.settings { it.with("mfa", "policy", value = JsonPrimitive("required")) }
            assertEquals("required", existing.tula.config(force = true).mfa?.policy?.rawValue)

            val entry = signIn(world, existing.email)
            val asked = assertIs<FlowStep.NeedsFactorEnrolment>(entry.step)
            assertEquals(listOf("totp"), asked.value.methods.map { it.rawValue })
            assertEquals(FlowScreen.NEEDS_FACTOR_ENROLMENT, entry.flow.screen)
            assertFalse(entry.tula.state.value is AuthState.SignedIn)
            val enrolment = entry.flow.startTotpEnrolment()
            val secret = enrolment.secret
            assertEquals(32, secret.length)
            assertTrue(enrolment.uri.startsWith("otpauth://totp/"))
            assertEquals("needs_factor_enrolment", entry.flow.step.status)
            val refused = caught { entry.flow.confirmTotpEnrolment(world.wrongTotp(secret)) }
            assertEquals("mfa.invalid_code", refused.code)
            assertEquals(422, refused.status)
            assertFalse(entry.tula.state.value is AuthState.SignedIn)

            val result = entry.flow.confirmTotpEnrolment(world.totp(secret))
            assertEquals("complete", result.step.status)
            assertNull(result.failure)
            assertEquals(10, result.backupCodes.size)
            assertTrue(result.backupCodes.all(::isBackupCode))
            assertEquals(existing.email, signedIn(entry.device).user?.email)
            assertContains(proven(entry.device), "mfa")
            val visible = "${entry.flow} ${entry.flow.snapshot()} ${entry.tula} ${entry.tula.state.value} $result"
            for (hidden in result.backupCodes + secret) {
                assertFalse(hidden in visible)
            }

            val disable = caught { entry.tula.factors.disableTotp() }
            assertEquals("mfa.required_by_policy", disable.code)
            assertEquals(403, disable.status)
            assertTrue(entry.tula.factors.get().totp.enabled)

            // A sign-up stops at the same step, after its emailed code.
            val newcomer = world.client()
            val address = world.freshEmail()
            val joining = newcomer.tula.signUp(email = address, password = PASSWORD)
            val verified = joining.verifyEmail(world.code(address))
            assertIs<FlowStep.NeedsFactorEnrolment>(verified)
            assertEquals(FlowScreen.NEEDS_FACTOR_ENROLMENT, joining.screen)
            assertFalse(newcomer.tula.state.value is AuthState.SignedIn)
            val theirs = joining.startTotpEnrolment()
            val joined = joining.confirmTotpEnrolment(world.totp(theirs.secret))
            assertEquals("complete", joined.step.status)
            assertEquals(10, joined.backupCodes.size)
            assertEquals(address, signedIn(newcomer).user?.email)

            world.advance(Totp.STEP_MS)
            val later = atSecondFactor(world, address)
            assertEquals("complete", later.flow.submitTotp(world.totp(theirs.secret)).status)
        }

    /** Switch the texted second step on or off, with text messages sent to the US. */
    private fun smsSecondStep(world: World, enabled: Boolean, signInBySms: Boolean = false) = world.settings {
        it.with("signIn", "methods", "smsCode", value = j("""{"enabled":$signInBySms}"""))
            .with("mfa", "smsCode", value = j("""{"enabled":$enabled}"""))
            .with("sms", value = j(smsOn))
    }

    /** A user who proved a phone number with the texted code, a minute after it was texted. */
    private suspend fun withNumber(world: World, number: String): Account {
        val account = signUp(world)
        account.tula.phone.request(number)
        account.tula.phone.verify(world.textedCode(number))
        // A number is texted at most once a minute, whoever asks.
        world.advance(61_000)
        return account
    }

    @Test
    @Journey("a texted code as the second factor")
    fun `a user with a proven number enrols a texted code, signs in with password and code, and is not let through once the option is off`() =
        journey { world ->
            val number = "+12025550145"
            smsSecondStep(world, true)

            val bare = signUp(world)
            val none = bare.tula.factors.get().sms
            assertEquals(listOf(false, false, false), listOf(none?.enabled, none?.inUse, none?.available))
            val needsNumber = caught { bare.tula.factors.startSms() }
            assertEquals("mfa.phone_number_required", needsNumber.code)
            assertEquals(409, needsNumber.status)

            val owner = withNumber(world, number)
            assertEquals(true, owner.tula.factors.get().sms?.available)
            val before = world.texts().size
            val receipt = owner.tula.factors.startSms()
            assertEquals("sms_code", receipt.method)
            assertEquals("***45", receipt.destination)
            assertEquals(before + 1, world.texts().size)
            val enrolCode = world.textedCode(number)
            val wrong = enrolCode.dropLast(1) + ((enrolCode.last().digitToInt() + 1) % 10)
            val refused = caught { owner.tula.factors.confirmSms(wrong) }
            assertEquals("mfa.invalid_code", refused.code)
            assertEquals(422, refused.status)
            assertEquals(false, owner.tula.factors.get().sms?.enabled)
            val factors = owner.tula.factors.confirmSms(enrolCode)
            assertEquals(listOf(true, true, false), listOf(factors.sms?.enabled, factors.sms?.inUse, factors.sms?.available))
            assertFalse(factors.totp.enabled)
            // A texted code is never `mfa`.
            assertEquals(setOf("email", "sms"), proven(owner.device))
            assertEquals("mfa.already_enabled", caught { owner.tula.factors.startSms() }.code)

            world.advance(61_000)
            val sent = world.texts().size
            val entry = atSecondFactor(world, owner.email, offered = listOf("sms_code"))
            assertEquals(FlowScreen.NEEDS_SECOND_FACTOR, entry.flow.screen)
            // Nothing is texted by arriving at the step, and the enrolment's code proves nothing here.
            assertEquals(sent, world.texts().size)
            assertEquals("mfa.invalid_code", caught { entry.flow.submitSmsCode(enrolCode) }.code)

            val prepared = assertIs<FlowStep.NeedsSecondFactor>(entry.flow.prepareSmsCode())
            assertEquals("sms_code", prepared.value.prepared?.method?.rawValue)
            assertEquals("***45", prepared.value.prepared?.destination)
            assertEquals(sent + 1, world.texts().size)
            val code = world.textedCode(number)
            assertFalse(code in prepared.toString())
            val soon = caught { entry.flow.prepareSmsCode() }
            assertEquals("rate_limited", soon.code)
            assertEquals(429, soon.status)
            assertEquals("complete", entry.flow.submitSmsCode(code).status)
            assertEquals(setOf("pwd", "sms"), proven(entry.device))

            // Off means refused, never skipped.
            smsSecondStep(world, false)
            val later = atSecondFactor(world, owner.email, offered = listOf("sms_code"))
            val off = caught { later.flow.prepareSmsCode() }
            assertEquals("auth.method_disabled", off.code)
            assertEquals(403, off.status)
            assertEquals("auth.method_disabled", caught { later.flow.submitSmsCode(code) }.code)
            assertFalse(later.tula.state.value is AuthState.SignedIn)
            assertEquals(sent + 1, world.texts().size)

            entry.tula.factors.disableSms()
            assertEquals(false, entry.tula.factors.get().sms?.enabled)
            assertEquals(number, entry.tula.user().phoneNumber)
            assertEquals("complete", signIn(world, owner.email).step.status)
        }

    @Test
    @Journey("a texted code is never used beside an authenticator app")
    fun `a user with an authenticator app cannot enrol a texted code, and their sign-in never offers one`() =
        journey { world ->
            val number = "+12025550146"
            smsSecondStep(world, true)
            val owner = withNumber(world, number)
            val secret = owner.tula.factors.startTotp().secret
            owner.tula.factors.confirmTotp(world.totp(secret))
            val sent = world.texts().size

            val sms = owner.tula.factors.get().sms
            assertEquals(listOf(false, false, false), listOf(sms?.enabled, sms?.inUse, sms?.available))
            val refused = caught { owner.tula.factors.startSms() }
            assertEquals("mfa.sms_not_allowed", refused.code)
            assertEquals(409, refused.status)
            assertEquals("mfa.sms_not_allowed", caught { owner.tula.factors.confirmSms("123456") }.code)

            val entry = atSecondFactor(world, owner.email)
            val prepare = caught { entry.flow.prepareSmsCode() }
            assertEquals("flow.invalid_step", prepare.code)
            assertEquals(409, prepare.status)
            assertEquals("flow.invalid_step", caught { entry.flow.submitSmsCode("123456") }.code)
            assertFalse(entry.tula.state.value is AuthState.SignedIn)
            assertEquals(sent, world.texts().size)

            world.advance(Totp.STEP_MS)
            assertEquals("complete", entry.flow.submitTotp(world.totp(secret)).status)
            assertEquals(setOf("mfa", "otp", "pwd"), proven(entry.device))
        }

    @Test
    @Journey("a texted sign-in code is not completed by a texted second step")
    fun `a sign-in started with the phone number is refused for a user whose second step is a texted code, and with the password it asks for the code`() =
        journey { world ->
            val number = "+12025550147"
            smsSecondStep(world, true, signInBySms = true)
            val owner = withNumber(world, number)
            owner.tula.factors.startSms()
            owner.tula.factors.confirmSms(world.textedCode(number))
            world.advance(61_000)

            val device = world.client()
            val flow = device.tula.signIn(number)
            flow.prepareFirstFactor(CodeStrategy.SMS_CODE)
            val code = world.textedCode(number)
            val sent = world.texts().size
            val refused = caught { flow.attemptFirstFactor(CodeStrategy.SMS_CODE, code) }
            assertEquals("mfa.needs_other_sign_in", refused.code)
            assertEquals(403, refused.status)
            assertFalse(device.tula.state.value is AuthState.SignedIn)
            assertEquals("needs_first_factor", flow.step.status)
            assertEquals("flow.invalid_step", caught { flow.prepareSmsCode() }.code)
            assertEquals(sent, world.texts().size)

            atSecondFactor(world, owner.email, offered = listOf("sms_code"))
        }

    /** A device whose session is bound to the key its store holds. */
    private class Bound(val device: Device, val keys: LosableKeyStore, val email: String, val jkt: String) {
        val tula get() = device.tula
    }

    private suspend fun boundDevice(world: World): Bound {
        val keys = LosableKeyStore()
        val device = world.client(deviceKeys = keys)
        val email = world.freshEmail()
        device.tula.signUp(email = email, password = PASSWORD).verifyEmail(world.code(email))
        signedIn(device)
        val key = assertNotNull(keys.existing())
        return Bound(device, keys, email, thumbprint(key.publicKey))
    }

    /** Another client over a copy of a device's stored refresh token. */
    private suspend fun copyOf(world: World, device: Device, deviceKeys: DeviceKeyStore? = null): Device {
        val copy = MemoryTokenStorage()
        copy.set(world.storageKey, assertNotNull(device.storage.get(world.storageKey)))
        return world.client(storage = copy, deviceKeys = deviceKeys)
    }

    private fun jkt(token: String?): String? =
        ((claims(token)["cnf"] as? JsonObject)?.get("jkt") as? JsonPrimitive)?.content

    private val Exchange.proof: String? get() = headers.entries.firstOrNull { it.key.equals("dpop", true) }?.value

    private val Exchange.code: String? get() = (j(responseBody).jsonObject["code"] as? JsonPrimitive)?.content

    private fun signUps(world: World) = world.sent("/v1/client/sign-ups")

    @Test
    @Journey("a session bound to a device key is refreshed with a proof")
    fun `device binding - a client with a device key answers the nonce challenge by itself, gets a session bound to the key, and refreshes it with a new proof each time`() =
        journey { world ->
            val bound = boundDevice(world)
            val starts = signUps(world)
            assertEquals(listOf(400, 200), starts.map { it.status })
            assertEquals("device.nonce_required", starts.first().code)
            assertNotNull(starts.first().proof)
            assertNotEquals(starts.first().proof, starts.last().proof)
            // Only a start and a refresh carry a proof.
            assertNull(world.exchanges.first { it.path.endsWith("/verify-email") }.proof)
            assertEquals(bound.jkt, jkt(bound.tula.session.getToken()))

            val first = bound.device.storage.get(world.storageKey)
            world.advance(1_000)
            assertEquals(bound.jkt, jkt(bound.tula.session.refresh()))
            assertNotEquals(first, bound.device.storage.get(world.storageKey))
            world.advance(1_000)
            bound.tula.session.refresh()
            val sent = world.refreshes()
            assertEquals(listOf(200, 200), sent.map { it.status })
            assertEquals(3, sent.first().proof?.split('.')?.size)
            assertNotEquals(sent.first().proof, sent.last().proof)

            val listed = bound.tula.sessions()
            assertEquals(listOf(true), listed.map { it.deviceBound })
            assertFalse(bound.jkt in listed.toString())
            assertFalse(bound.jkt in "${bound.tula} ${bound.tula.state.value}")
        }

    @Test
    @Journey("a bound session's refresh without a proof is refused and changes nothing")
    fun `device binding - a copy of the stored refresh token on a client with no key is refused, is not signed out by it, and costs the device nothing`() =
        journey { world ->
            val bound = boundDevice(world)
            val token = bound.device.storage.get(world.storageKey)
            val thief = copyOf(world, bound.device)
            val error = caught { thief.tula.session.refresh() }
            assertEquals("device.proof_invalid", error.code)
            assertEquals(401, error.status)
            assertNull(world.refreshes().last().proof)
            // A `device.*` answer ends nothing: the copy is kept, and so is the device's.
            assertEquals(token, thief.storage.get(world.storageKey))
            assertEquals(token, bound.device.storage.get(world.storageKey))
            assertTrue(bound.tula.session.refresh().orEmpty().startsWith("ey"))
            signedIn(bound.device)
            assertNotEquals(token, bound.device.storage.get(world.storageKey))
        }

    @Test
    @Journey("a bound session's refresh with a proof of another key is refused")
    fun `device binding - a copy on a client with a key of its own is refused and not signed out, and the device goes on until its own key is gone, which ends its session`() =
        journey { world ->
            val bound = boundDevice(world)
            val other = LosableKeyStore().also { it.create() }
            val thief = copyOf(world, bound.device, deviceKeys = other)
            assertEquals("device.proof_invalid", caught { thief.tula.session.refresh() }.code)
            assertEquals(listOf(401), world.refreshes().map { it.status })
            assertNotNull(world.refreshes().first().proof)
            // Its key is there, so the refusal says nothing about the session: it is kept.
            assertNotNull(thief.storage.get(world.storageKey))
            assertTrue(bound.tula.session.refresh().orEmpty().startsWith("ey"))
            signedIn(bound.device)

            // The key is lost (a restored backup, cleared app data): the refresh goes without
            // a proof, is refused, the store says twice that there is no key, and the session
            // ends here and on the server.
            bound.keys.remove()
            world.advance(1_000)
            assertNull(bound.tula.session.refresh())
            assertEquals(AuthState.SignedOut, bound.tula.state.value)
            assertNull(bound.device.storage.get(world.storageKey))
            assertEquals(401, world.refreshes().last().status)
            assertNull(world.refreshes().last().proof)
            assertEquals(listOf(204), world.sent("/v1/client/sessions/sign-out").map { it.status })
        }

    @Test
    @Journey("a proof is accepted once")
    fun `device binding - a proof captured off the wire and sent again is refused, and the device goes on`() =
        journey { world ->
            val bound = boundDevice(world)
            bound.tula.session.refresh()
            val used = assertNotNull(world.refreshes().last().proof)
            val replay = Network(
                tamper = { request ->
                    if (request.headers.keys.any { it.equals("dpop", true) }) {
                        HttpRequest(request.method, request.url, request.headers + ("dpop" to used), request.body, request.timeoutMs)
                    } else {
                        request
                    }
                },
            )
            val replayer = world.client(storage = bound.device.storage, deviceKeys = bound.keys, network = replay)
            val token = bound.device.storage.get(world.storageKey)
            assertEquals("device.proof_invalid", caught { replayer.tula.session.refresh() }.code)
            assertEquals(used, world.refreshes().last().proof)
            assertEquals(token, bound.device.storage.get(world.storageKey))
            assertTrue(bound.tula.session.refresh().orEmpty().startsWith("ey"))
        }

    @Test
    @Journey("a proof with a stale nonce is asked for a fresh one")
    fun `device binding - a client whose nonce has gone stale is given a fresh one and repeats the refresh once, inside the same call`() =
        journey { world ->
            val bound = boundDevice(world)
            val token = bound.device.storage.get(world.storageKey)
            world.advance(11 * 60_000)
            val (one, two) = listOf(async { bound.tula.session.refresh() }, async { bound.tula.session.refresh() }).awaitAll()
            assertEquals(one, two)
            val sent = world.refreshes()
            assertEquals(listOf(400, 200), sent.map { it.status })
            assertEquals("device.nonce_required", sent.first().code)
            // The challenge spent nothing: the same token is presented again, with a new proof.
            assertEquals(listOf(token, token), sent.map { it.requestBody?.refreshToken() })
            assertNotEquals(sent.first().proof, sent.last().proof)
            signedIn(bound.device)
        }

    @Test
    @Journey("the reuse grace window still requires a proof")
    fun `device binding - a refresh whose answer was lost is repeated with a new proof and gets the same next token, and the rotated token without a proof gets nothing`() =
        journey { world ->
            val bound = boundDevice(world)
            val first = bound.device.storage.get(world.storageKey)
            val lose = AtomicBoolean(false)
            val flaky = world.client(
                storage = bound.device.storage,
                deviceKeys = bound.keys,
                network = Network(loseResponse = { it.url.endsWith(REFRESH) && lose.getAndSet(false) }),
            )
            lose.set(true)
            assertTrue(flaky.tula.session.refresh().orEmpty().startsWith("ey"))
            // The lost answer was the nonce challenge: the repeat was challenged and answered.
            assertEquals(listOf(400, 400, 200), world.refreshes().map { it.status })
            val second = assertNotNull(bound.device.storage.get(world.storageKey))
            assertNotEquals(first, second)

            lose.set(true)
            val before = world.refreshes().size
            world.advance(1_000)
            assertTrue(flaky.tula.session.refresh().orEmpty().startsWith("ey"))
            val sent = world.refreshes().drop(before)
            assertEquals(listOf(200, 200), sent.map { it.status })
            assertEquals(listOf(second, second), sent.map { it.requestBody?.refreshToken() })
            assertNotEquals(sent.first().proof, sent.last().proof)
            val handed = sent.map { it.responseBody.refreshToken() }
            assertEquals(handed.first(), handed.last())
            assertEquals(handed.first(), bound.device.storage.get(world.storageKey))

            // The rotated token, inside the grace window and past it, without a proof.
            val copy = MemoryTokenStorage().also { it.set(world.storageKey, second) }
            val thief = world.client(storage = copy)
            assertEquals("device.proof_invalid", caught { thief.tula.session.refresh() }.code)
            world.advance(11_000)
            assertEquals("device.proof_invalid", caught { thief.tula.session.refresh() }.code)
            assertTrue(flaky.tula.session.refresh().orEmpty().startsWith("ey"))
            signedIn(flaky)
        }

    @Test
    @Journey("a profile that requires a device key lets a bound native sign-in through")
    fun `device binding required - a client with a device key signs up as under optional, its session list says the session is bound, and it refreshes with a proof`() =
        journey { world ->
            world.settings {
                it.with("sessions", "profiles", "mobile", "deviceBinding", value = JsonPrimitive("required"))
            }
            val bound = boundDevice(world)
            assertEquals(listOf(400, 200), signUps(world).map { it.status })
            assertEquals(bound.jkt, jkt(bound.tula.session.getToken()))
            val listed = bound.tula.sessions()
            assertEquals(listOf(true), listed.map { it.deviceBound })
            assertFalse(bound.jkt in listed.toString())
            world.advance(1_000)
            assertEquals(bound.jkt, jkt(bound.tula.session.refresh()))
            assertNotNull(world.refreshes().last().proof)
        }

    @Test
    @Journey("a profile with no device binding refuses a proof")
    fun `device binding none - a client that has a device key is refused at the start and not quietly signed in unbound, and one without a key signs in`() =
        journey { world ->
            world.settings {
                it.with("sessions", "profiles", "mobile", "deviceBinding", value = JsonPrimitive("none"))
            }
            val keyed = world.client(deviceKeys = LosableKeyStore())
            val email = world.freshEmail()
            val error = caught { keyed.tula.signUp(email = email, password = PASSWORD) }
            assertEquals("device.binding_not_supported", error.code)
            assertEquals(400, error.status)
            assertEquals(listOf(400), signUps(world).map { it.status })
            assertNull(keyed.tula.session.getToken())
            assertFalse(world.userExists(email))

            val plain = signUp(world)
            assertNull(jkt(plain.tula.session.getToken()))
            assertEquals(listOf(false), plain.tula.sessions().map { it.deviceBound })
            assertNull(signUps(world).last().proof)
        }

    /** Passkeys on, for the journeys' relying party. */
    private fun passkeysOn(world: World, change: (JsonObject) -> JsonObject = { it }) = world.settings {
        change(
            it.with("signIn", "methods", "passkey", value = j("""{"enabled":true}"""))
                .with("passkeys", "rpId", value = JsonPrimitive(RELYING_PARTY))
                .with("urls", "allowedOrigins", value = j("""["http://localhost:5173"]""")),
        )
    }

    private fun passkeysOff(world: World) =
        passkeysOn(world) { it.with("signIn", "methods", "passkey", value = j("""{"enabled":false}""")) }

    /** A signed-up device whose passkey sheet is a software authenticator. */
    private class Keyed(val device: Device, val sheet: SoftwareSheet, val email: String) {
        val tula get() = device.tula
    }

    private suspend fun keyedSignUp(world: World, authenticator: Authenticator, origin: String = androidOrigin()): Keyed {
        val sheet = SoftwareSheet(authenticator, origin)
        val device = world.client(passkeys = sheet)
        val email = world.freshEmail()
        device.tula.signUp(email = email, password = PASSWORD).verifyEmail(world.code(email))
        return Keyed(device, sheet, email)
    }

    /** Another install of the app, holding the same authenticator (a synced passkey). */
    private fun visitor(world: World, authenticator: Authenticator, origin: String = androidOrigin()): Device =
        world.client(passkeys = SoftwareSheet(authenticator, origin))

    private fun passkeyCalls(world: World, from: Int = 0) = world.exchanges.drop(from).filter { "passkey" in it.path }

    @Test
    @Journey("passkey registration and sign-in")
    fun `a signed-in user adds a passkey, and another install signs in with it and nothing else - a dismissed sheet is neither an error nor a sign-in`() =
        journey { world ->
            passkeysOn(world)
            world.registerApp()

            // A client with no sheet has no passkey call that sends anything.
            val bare = signUp(world)
            assertEquals("passkey.unsupported", caught { bare.tula.passkeys.add() }.code)
            assertEquals("passkey.unsupported", caught { bare.tula.signInWithPasskey() }.code)
            assertEquals(0, passkeyCalls(world).size)

            val authenticator = Authenticator()
            val owner = keyedSignUp(world, authenticator)
            val passkey = assertNotNull(owner.tula.passkeys.add(name = "Pixel").valueOrNull)
            assertEquals("Pixel", passkey.name)
            assertFalse(passkey.synced)
            assertNull(passkey.lastUsedAt)
            assertEquals(listOf(passkey), owner.tula.passkeys.list())
            assertContains(owner.tula.config(force = true).signIn.methods, "passkey")
            // The same authenticator again: the sheet says the passkey is already there.
            assertEquals("passkey.already_on_device", caught { owner.tula.passkeys.add() }.code)

            val other = visitor(world, authenticator)
            val flow = assertNotNull(other.tula.signInWithPasskey().valueOrNull)
            assertEquals("complete", flow.step.status)
            assertEquals(owner.email, signedIn(other).user?.email)
            assertEquals(setOf("hwk", "user", "mfa"), proven(other))
            assertNotNull(other.tula.passkeys.list().first().lastUsedAt)
            // Nothing of the ceremony is kept where it could be printed.
            val start = world.sent("/v1/client/sign-ins/passkey").last()
            val challenge = j(start.responseBody).jsonObject.getValue("options").jsonObject.text("challenge")
            assertFalse(challenge in "$flow ${flow.snapshot()} ${other.tula} ${other.tula.state.value}")

            // The user closes the sheet: a value, nobody signed in, and the same call works again.
            val sheet = SoftwareSheet(authenticator).also { it.dismisses = true }
            val dismissing = world.client(passkeys = sheet)
            val before = world.exchanges.size
            val outcome = dismissing.tula.signInWithPasskey()
            assertSame(TulaCeremony.Dismissed, outcome)
            assertNull(outcome.valueOrNull)
            assertFalse(dismissing.tula.state.value is AuthState.SignedIn)
            assertEquals(emptyList(), dismissing.states)
            // The options were asked for and nothing was sent to be judged.
            assertEquals(1, passkeyCalls(world, before).size)
            assertEquals(1, sheet.shown.get())
            sheet.dismisses = false
            assertEquals("complete", dismissing.tula.signInWithPasskey().valueOrNull?.step?.status)

            // A passkey nobody registered is the one generic refusal.
            val stranger = visitor(world, Authenticator().also { it.holdStray(RELYING_PARTY) })
            val refused = caught { stranger.tula.signInWithPasskey() }
            assertEquals("auth.invalid_credentials", refused.code)
            assertEquals(401, refused.status)

            passkeysOff(world)
            assertEquals("auth.method_disabled", caught { visitor(world, authenticator).tula.signInWithPasskey() }.code)
        }

    @Test
    @Journey("passkeys switched off mid-attempt")
    fun `passkeys are switched off while the sheet is up - the attempt cannot finish with one, nobody is signed in, and nothing can be started or registered until they are on again`() =
        journey { world ->
            passkeysOn(world)
            world.registerApp()
            val authenticator = Authenticator()
            val owner = keyedSignUp(world, authenticator)
            val passkey = assertNotNull(owner.tula.passkeys.add().valueOrNull)

            val sheet = SoftwareSheet(authenticator)
            sheet.whileUp = { passkeysOff(world) }
            val device = world.client(passkeys = sheet)
            val before = world.exchanges.size
            val refused = caught { device.tula.signInWithPasskey() }
            assertEquals("auth.method_disabled", refused.code)
            assertEquals(403, refused.status)
            assertFalse(device.tula.state.value is AuthState.SignedIn)
            assertEquals(listOf(200, 403), passkeyCalls(world, before).filter { it.path.endsWith("/passkey") }.map { it.status })

            sheet.whileUp = null
            assertEquals("auth.method_disabled", caught { device.tula.signInWithPasskey() }.code)
            assertEquals("auth.method_disabled", caught { owner.tula.passkeys.add() }.code)
            assertFalse("passkey" in device.tula.config(force = true).signIn.methods)
            assertEquals(listOf(passkey.id), owner.tula.passkeys.list().map { it.id })

            passkeysOn(world)
            assertEquals("complete", device.tula.signInWithPasskey().valueOrNull?.step?.status)
            assertEquals(owner.email, signedIn(device).user?.email)

            // A passkey can be removed while they are off: taking a way in away needs no ceremony.
            passkeysOff(world)
            owner.tula.passkeys.remove(passkey.id)
            assertEquals(0, owner.tula.passkeys.list().size)
        }

    @Test
    @Journey("passkey assertion replay")
    fun `a sheet that answers a new attempt with an assertion made for an earlier one gets the one generic refusal and signs nobody in, and the passkey works again afterwards`() =
        journey { world ->
            passkeysOn(world)
            world.registerApp()
            val authenticator = Authenticator()
            val owner = keyedSignUp(world, authenticator)
            owner.tula.passkeys.add()

            val sheet = SoftwareSheet(authenticator)
            val first = world.client(passkeys = sheet)
            assertEquals("complete", first.tula.signInWithPasskey().valueOrNull?.step?.status)
            val stale = assertNotNull(sheet.last)

            // The client holds nothing to present twice; a sheet that does is refused by the server.
            sheet.stale = stale
            val replayer = world.client(passkeys = sheet)
            val before = world.exchanges.size
            repeat(2) {
                val refused = caught { replayer.tula.signInWithPasskey() }
                assertEquals("auth.invalid_credentials", refused.code)
                assertEquals(401, refused.status)
            }
            assertFalse(replayer.tula.state.value is AuthState.SignedIn)
            assertEquals(emptyList(), replayer.states)
            val sent = passkeyCalls(world, before).filter { it.path.endsWith("/passkey") }
            assertEquals(listOf(200, 401, 200, 401), sent.map { it.status })
            assertContains(sent[1].requestBody.orEmpty(), stale.response.signature)

            sheet.stale = null
            assertEquals("complete", replayer.tula.signInWithPasskey().valueOrNull?.step?.status)
            assertEquals(owner.email, signedIn(replayer).user?.email)
        }

    @Test
    @Journey("a passkey satisfies two-step verification")
    fun `with an authenticator app enrolled, the passkey signs in on its own and also serves as the second factor`() =
        journey { world ->
            passkeysOn(world)
            world.registerApp()
            val authenticator = Authenticator()
            val owner = keyedSignUp(world, authenticator)
            owner.tula.passkeys.add()
            val secret = owner.tula.factors.startTotp().secret
            owner.tula.factors.confirmTotp(world.totp(secret))

            assertEquals("complete", visitor(world, authenticator).tula.signInWithPasskey().valueOrNull?.step?.status)

            val sheet = SoftwareSheet(authenticator)
            val all = listOf("totp", "backup_code", "passkey")
            val second = atSecondFactor(world, owner.email, offered = all, passkeys = sheet)
            assertEquals(FlowScreen.NEEDS_SECOND_FACTOR, second.flow.screen)
            sheet.dismisses = true
            assertSame(TulaCeremony.Dismissed, second.flow.submitSecondFactorWithPasskey())
            assertEquals("needs_second_factor", second.flow.step.status)
            assertFalse(second.tula.state.value is AuthState.SignedIn)
            sheet.dismisses = false
            assertEquals("complete", second.flow.submitSecondFactorWithPasskey().valueOrNull?.status)
            signedIn(second.device)
            assertEquals(setOf("pwd", "hwk", "user", "mfa"), proven(second.device))

            // A client with no sheet is offered the same step and cannot take that way.
            val bare = atSecondFactor(world, owner.email, offered = all)
            assertEquals("passkey.unsupported", caught { bare.flow.submitSecondFactorWithPasskey() }.code)

            world.settings { it.with("mfa", "policy", value = JsonPrimitive("required")) }
            assertEquals("complete", visitor(world, authenticator).tula.signInWithPasskey().valueOrNull?.step?.status)
        }

    @Test
    @Journey("step-up with a passkey", "the last way to sign in cannot be removed")
    fun `a stale session steps up with its passkey, and the last way in cannot be removed`() =
        journey { world ->
            passkeysOn(world)
            world.registerApp()
            val authenticator = Authenticator()
            val owner = keyedSignUp(world, authenticator)
            val first = assertNotNull(owner.tula.passkeys.add(name = "First").valueOrNull)
            val tablet = Authenticator()
            owner.sheet.authenticator = tablet
            val second = assertNotNull(owner.tula.passkeys.add(name = "Second").valueOrNull)

            world.advance(11 * 60_000)
            val stale = caught { owner.tula.factors.startTotp() }
            assertEquals("auth.step_up_required", stale.code)
            assertEquals(listOf("passkey", "password", "email_code"), stale.stepUpMethods)
            owner.sheet.dismisses = true
            assertSame(TulaCeremony.Dismissed, owner.tula.stepUp.withPasskey())
            assertEquals("auth.step_up_required", caught { owner.tula.factors.startTotp() }.code)
            owner.sheet.dismisses = false
            assertIs<TulaCeremony.Finished<Unit>>(owner.tula.stepUp.withPasskey())
            assertTrue(proven(owner.device).containsAll(setOf("hwk", "user", "mfa")))

            passkeysOn(world) {
                it.with(
                    "signIn",
                    "methods",
                    value = j(
                        """{"password":{"enabled":false},"emailCode":{"enabled":false},"emailLink":{"enabled":false},""" +
                            """"passkey":{"enabled":true},"smsCode":{"enabled":false}}""",
                    ),
                )
            }
            owner.tula.passkeys.remove(first.id)
            val last = caught { owner.tula.passkeys.remove(second.id) }
            assertEquals("passkey.last_sign_in_method", last.code)
            assertEquals(409, last.status)
            assertEquals(1, owner.tula.passkeys.list().size)
            assertEquals("auth.invalid_credentials", caught { visitor(world, authenticator).tula.signInWithPasskey() }.code)
            assertEquals("complete", visitor(world, tablet).tula.signInWithPasskey().valueOrNull?.step?.status)
        }

    @Test
    @Journey("passkey registration from a native app", "passkey sign-in from a native app")
    fun `an Android app adds a passkey and signs in with it once the operator has registered it - before that there is no ceremony`() =
        journey { world ->
            passkeysOn(world)
            val authenticator = Authenticator()
            val owner = keyedSignUp(world, authenticator)

            var refused = caught { owner.tula.passkeys.add() }
            assertEquals("request.origin_not_allowed", refused.code)
            assertEquals(403, refused.status)
            refused = caught { visitor(world, authenticator).tula.signInWithPasskey() }
            assertEquals("request.origin_not_allowed", refused.code)
            assertEquals(0, owner.sheet.shown.get())

            world.registerApp()
            val added = assertNotNull(owner.tula.passkeys.add(name = "Pixel").valueOrNull)
            assertEquals("Pixel", added.name)
            assertNull(added.lastUsedAt)
            // What the client sends says what it is, and never an origin of its own.
            for (sent in passkeyCalls(world)) {
                assertEquals("android", sent.headers["x-tula-client"])
                assertFalse(sent.headers.keys.any { it.equals("origin", true) })
            }

            val again = visitor(world, authenticator)
            assertEquals("complete", again.tula.signInWithPasskey().valueOrNull?.step?.status)
            assertEquals(owner.email, signedIn(again).user?.email)
            assertEquals(setOf("hwk", "user", "mfa"), proven(again))

            // The origin an iOS app's response carries is not an Android app's.
            val ios = caught { visitor(world, authenticator, origin = "https://$RELYING_PARTY").tula.signInWithPasskey() }
            assertEquals("auth.invalid_credentials", ios.code)
            assertEquals(401, ios.status)
        }

    @Test
    @Journey("passkey sign-in from an unregistered app")
    fun `a response with an origin the environment's apps do not have gets the one generic answer and cannot add a passkey - with the app removed there is no ceremony, and the passkey stays`() =
        journey { world ->
            passkeysOn(world)
            val appId = world.registerApp()
            val authenticator = Authenticator()
            val owner = keyedSignUp(world, authenticator)
            owner.tula.passkeys.add()

            // Another app: signed with a certificate nobody registered.
            val stranger = visitor(world, authenticator, origin = androidOrigin(OTHER_FINGERPRINT))
            var refused = caught { stranger.tula.signInWithPasskey() }
            assertEquals("auth.invalid_credentials", refused.code)
            assertEquals(401, refused.status)
            assertFalse(stranger.tula.state.value is AuthState.SignedIn)
            assertEquals(emptyList(), stranger.states)
            owner.sheet.authenticator = Authenticator()
            owner.sheet.origin = androidOrigin(OTHER_FINGERPRINT)
            refused = caught { owner.tula.passkeys.add() }
            assertEquals("passkey.registration_failed", refused.code)
            assertEquals(422, refused.status)

            World.expect(204, world.admin("DELETE", "/v1/admin/native-apps/$appId"))
            assertEquals("request.origin_not_allowed", caught { visitor(world, authenticator).tula.signInWithPasskey() }.code)
            assertEquals(1, owner.tula.passkeys.list().size)
        }

    @Test
    @Journey("passkey sign-in with a fingerprint that is not the registered one")
    fun `an Android build whose certificate the operator takes away is refused from then on, in every spelling of an origin, and the registered build goes on`() =
        journey { world ->
            passkeysOn(world)
            val appId = world.registerApp(more = "")
            World.expect(
                200,
                world.admin(
                    "PATCH",
                    "/v1/admin/native-apps/$appId",
                    """{"sha256CertFingerprints":["$FINGERPRINT","$OTHER_FINGERPRINT"]}""",
                ),
            )
            val authenticator = Authenticator()
            val owner = keyedSignUp(world, authenticator)
            owner.tula.passkeys.add()
            val otherBuild = androidOrigin(OTHER_FINGERPRINT)
            assertEquals("complete", visitor(world, authenticator, otherBuild).tula.signInWithPasskey().valueOrNull?.step?.status)

            World.expect(
                200,
                world.admin("PATCH", "/v1/admin/native-apps/$appId", """{"sha256CertFingerprints":["$FINGERPRINT"]}"""),
            )
            var refused = caught { visitor(world, authenticator, otherBuild).tula.signInWithPasskey() }
            assertEquals("auth.invalid_credentials", refused.code)
            assertEquals(401, refused.status)
            owner.sheet.authenticator = Authenticator()
            owner.sheet.origin = otherBuild
            refused = caught { owner.tula.passkeys.add() }
            assertEquals("passkey.registration_failed", refused.code)
            assertEquals(422, refused.status)
            assertEquals(1, owner.tula.passkeys.list().size)

            // The registered certificate in any other spelling, and no other kind of origin.
            val bytes = FINGERPRINT.split(':').map { it.toInt(16).toByte() }.toByteArray()
            val spellings = listOf(
                "android:apk-key-hash:" + java.util.Base64.getEncoder().encodeToString(bytes),
                "android:apk-key-hash:" + java.util.Base64.getUrlEncoder().encodeToString(bytes),
                "android:apk-key-hash:$FINGERPRINT",
                androidOrigin() + "/",
                "https://$RELYING_PARTY",
                "http://localhost:5173",
            )
            for (origin in spellings) {
                val error = caught { visitor(world, authenticator, origin).tula.signInWithPasskey() }
                assertEquals("auth.invalid_credentials", error.code, origin)
                assertEquals(401, error.status)
            }
            // No refusal locked anything.
            assertEquals("complete", visitor(world, authenticator).tula.signInWithPasskey().valueOrNull?.step?.status)
        }

    /** A journey in a world whose providers are the API's own mock, with Google configured. */
    private fun oauthJourney(run: suspend CoroutineScope.(World) -> Unit) = runTest(JOURNEY_TIMEOUT_MS) {
        World.create(oauth = true).use { world ->
            world.provider("google")
            run(world)
        }
    }

    /** Create an account as an administrator does. @return Its id. */
    private fun adminUser(world: World, email: String, verified: Boolean): String {
        val made = world.admin(
            "POST",
            "/v1/admin/users",
            """{"email":"$email","password":"$PASSWORD"${if (verified) ""","emailVerified":true""" else ""}}""",
        )
        World.expect(201, made)
        return made.json.jsonObject.text("id")
    }

    private val webClient = "1234567890-journeyweb.apps.googleusercontent.com"
    private val androidClient = "1234567890-journeyandroid.apps.googleusercontent.com"
    private val otherClient = "1234567890-journeyother.apps.googleusercontent.com"
    private val strangerClient = "9999999999-someoneelsesapp.apps.googleusercontent.com"

    /** Google with the web client id and the listed Android client ids. */
    private fun listed(world: World, additional: List<String>, enabled: Boolean = true) {
        val ids = additional.joinToString(",") { "\"$it\"" }
        val saved = world.admin(
            "PUT",
            "/v1/admin/oauth-providers/google",
            """{"clientId":"$webClient","additionalClientIds":[$ids],"enabled":$enabled}""",
        )
        World.expect(200, saved)
    }

    /** A journey with Google's native sign-in set up. */
    private fun googleJourney(run: suspend CoroutineScope.(World) -> Unit) = oauthJourney { world ->
        listed(world, listOf(androidClient))
        run(world)
    }

    /** What Google's sheet would hand the app for [email], with this nonce. */
    private fun googleToken(
        world: World,
        nonce: String?,
        email: String,
        change: Map<String, JsonPrimitive> = emptyMap(),
        expired: Boolean = false,
    ): String {
        val claims = LinkedHashMap<String, JsonPrimitive>()
        claims["aud"] = JsonPrimitive(webClient)
        claims["azp"] = JsonPrimitive(androidClient)
        claims["sub"] = JsonPrimitive("google-$email")
        claims["email"] = JsonPrimitive(email)
        claims["email_verified"] = JsonPrimitive(true)
        if (nonce != null) {
            claims["nonce"] = JsonPrimitive(nonce)
        }
        claims.putAll(change)
        return world.idToken("google", JsonObject(claims), expired)
    }

    private fun idTokenCalls(world: World) = world.exchanges.filter { it.path.endsWith("/id-token") }

    @Test
    @Journey("native Google sign-up and sign-in")
    fun `native Google - the sheet is handed the server's nonce as it is, the token is exchanged and the app is signed in, and a dismissed sheet is neither`() =
        googleJourney { world ->
            val email = world.freshEmail()
            val minted = ArrayList<String>()
            val sheet = ScriptedGoogle { nonce ->
                googleToken(world, nonce, email, mapOf("given_name" to JsonPrimitive("Maya"))).also { minted.add(it) }
            }

            // A client with no sheet sends nothing.
            val bare = world.client()
            assertEquals("provider.unsupported", caught { bare.tula.signInWithGoogle() }.code)
            assertEquals(0, world.exchanges.size)

            val device = world.client(google = sheet)
            val flow = assertNotNull(device.tula.signInWithGoogle().valueOrNull)
            assertEquals("complete", flow.step.status)
            assertEquals(setOf("fed"), proven(device))
            val me = device.tula.user()
            assertEquals(email, me.email)
            assertEquals("Maya", me.firstName)
            assertFalse(me.hasPassword)
            assertNotNull(me.emailVerifiedAt)

            val sent = idTokenCalls(world)
            assertEquals(listOf(200, 200), sent.map { it.status })
            assertEquals(j("""{"provider":"google"}"""), j(sent[0].requestBody.orEmpty()))
            assertEquals(JsonObject(mapOf("idToken" to JsonPrimitive(minted.single()))), j(sent[1].requestBody.orEmpty()))
            assertEquals("android", sent[1].headers["x-tula-client"])
            // The sheet got the server's nonce, unhashed.
            val nonce = j(sent[0].responseBody).jsonObject.text("nonce")
            assertEquals(listOf(nonce), sheet.nonces.toList())
            assertEquals(43, nonce.length)
            // Neither the token nor the nonce is kept where it could be read.
            val visible = "$flow ${flow.snapshot()} ${device.tula} ${device.tula.state.value}"
            val stored = assertNotNull(device.storage.get(world.storageKey))
            for (hidden in listOf(minted.single(), nonce)) {
                assertFalse(hidden in visible)
                assertFalse(hidden in stored)
            }

            // The app shows the sheet itself: the two steps apart, with the Android client id as the audience.
            val other = world.client()
            val pending = other.tula.startIdTokenSignIn()
            assertNotEquals(nonce, pending.nonce)
            assertEquals("IdTokenSignIn", pending.toString())
            val token = googleToken(
                world,
                pending.nonce,
                email,
                mapOf("aud" to JsonPrimitive(androidClient), "azp" to JsonPrimitive(androidClient)),
            )
            val again = assertIs<FlowStep.Complete>(pending.exchange(token).step)
            assertEquals(me.id, again.value.userId)

            // The user closes Google's sheet: the attempt is left, and no token is exchanged.
            val closing = world.client(google = { throw TulaSheetException(SheetFailure.DISMISSED) })
            val before = idTokenCalls(world).size
            assertSame(TulaCeremony.Dismissed, closing.tula.signInWithGoogle())
            assertFalse(closing.tula.state.value is AuthState.SignedIn)
            assertEquals(1, idTokenCalls(world).size - before)
            // A sheet that fails says so in the client's word, with nothing of what it threw.
            val failing = world.client(google = { throw IllegalStateException("the sheet's own words $it") })
            val failed = caught { failing.tula.signInWithGoogle() }
            assertEquals("provider.failed", failed.code)
            assertFalse("the sheet's own words" in "$failed ${failed.message}")
            assertNull(failed.cause)
        }

    @Test
    @Journey("native Google sign-in and existing accounts")
    fun `native Google - a verified account is linked and signed in, and an unverified one and an unverified provider address are refused with their own codes`() =
        googleJourney { world ->
            val member = world.freshEmail()
            val memberId = adminUser(world, member, verified = true)
            val device = world.client()
            val linking = device.tula.startIdTokenSignIn()
            val linked = assertIs<FlowStep.Complete>(linking.exchange(googleToken(world, linking.nonce, member)).step)
            assertEquals(memberId, linked.value.userId)
            assertEquals(listOf("google"), device.tula.identities.list().map { it.provider })
            assertTrue(device.tula.user().hasPassword)

            val squatted = world.freshEmail()
            adminUser(world, squatted, verified = false)
            val other = world.client()
            val refused = other.tula.startIdTokenSignIn()
            var error = caught { refused.exchange(googleToken(world, refused.nonce, squatted)) }
            assertEquals("oauth.account_exists", error.code)
            assertEquals(409, error.status)

            val unvouched = other.tula.startIdTokenSignIn()
            val loose = googleToken(world, unvouched.nonce, world.freshEmail(), mapOf("email_verified" to JsonPrimitive(false)))
            error = caught { unvouched.exchange(loose) }
            assertEquals("oauth.email_unverified", error.code)
            assertEquals(403, error.status)
            assertFalse(other.tula.state.value is AuthState.SignedIn)
        }

    @Test
    @Journey("native Google ID token refused")
    fun `native Google - every token the server does not accept is the one generic error to the app, and nobody is signed in`() =
        googleJourney { world ->
            val email = world.freshEmail()
            val device = world.client()
            val stranger = JsonPrimitive(strangerClient)
            val unlisted = JsonPrimitive(otherClient)
            val wrong = listOf(
                Triple(mapOf("aud" to stranger, "azp" to stranger), false, true),
                Triple(mapOf("azp" to stranger), false, true),
                Triple(mapOf("nonce" to JsonPrimitive("the-nonce-of-another-sign-in")), false, true),
                Triple(emptyMap(), false, false),
                Triple(emptyMap(), true, true),
                Triple(mapOf("aud" to unlisted, "azp" to unlisted), false, true),
            )
            val messages = HashSet<String?>()
            for ((change, expired, withNonce) in wrong) {
                val pending = device.tula.startIdTokenSignIn()
                val token = googleToken(world, pending.nonce.takeIf { withNonce }, email, change, expired)
                val error = caught { pending.exchange(token) }
                assertEquals("auth.invalid_credentials", error.code, change.toString())
                assertEquals(401, error.status)
                messages.add(error.message)
            }
            assertEquals(1, messages.size)
            assertFalse(device.tula.state.value is AuthState.SignedIn)
            assertFalse(world.userExists(email))

            // Once the operator lists the client id, its token is accepted.
            listed(world, listOf(androidClient, otherClient))
            val pending = world.client().tula.startIdTokenSignIn()
            val token = googleToken(world, pending.nonce, email, mapOf("aud" to unlisted, "azp" to unlisted))
            assertEquals("complete", pending.exchange(token).step.status)
        }

    @Test
    @Journey("native Google ID token used once")
    fun `native Google - a sign-in takes one token, a copied token and a right token after a wrong one are refused, and a provider switched off mid-sign-in uses nothing up`() =
        googleJourney { world ->
            val email = world.freshEmail()
            val device = world.client()
            val pending = device.tula.startIdTokenSignIn()
            val idToken = googleToken(world, pending.nonce, email)
            assertEquals("complete", pending.exchange(idToken).step.status)
            val sent = idTokenCalls(world).size
            // The flow is over: the client refuses without a request.
            assertEquals("flow.invalid_step", caught { pending.exchange(idToken) }.code)
            assertEquals(sent, idTokenCalls(world).size)

            val thief = world.client()
            val theirs = thief.tula.startIdTokenSignIn()
            assertEquals("auth.invalid_credentials", caught { theirs.exchange(idToken) }.code)
            assertFalse(thief.tula.state.value is AuthState.SignedIn)

            // An attempt takes one token, right or wrong.
            val second = world.client()
            val retried = second.tula.startIdTokenSignIn()
            assertEquals("auth.invalid_credentials", caught { retried.exchange(googleToken(world, "not-the-nonce", email)) }.code)
            assertEquals("auth.invalid_credentials", caught { retried.exchange(googleToken(world, retried.nonce, email)) }.code)

            val waiting = second.tula.startIdTokenSignIn()
            val good = googleToken(world, waiting.nonce, email)
            listed(world, listOf(androidClient), enabled = false)
            val off = caught { waiting.exchange(good) }
            assertEquals("auth.method_disabled", off.code)
            assertEquals(403, off.status)
            assertEquals("auth.method_disabled", caught { second.tula.startIdTokenSignIn() }.code)
            listed(world, listOf(androidClient))
            assertEquals("complete", waiting.exchange(good).step.status)
            signedIn(second)
        }

    private val contoso = "aaaabbbb-0000-cccc-1111-dddd2222eeee"
    private val fabrikam = "bbbbcccc-1111-dddd-2222-eeee3333ffff"

    private fun guid(): String = java.util.UUID.randomUUID().toString()

    private fun snowflake(): String = (1 + kotlin.random.Random.nextLong(999_999_999_999_999_998)).toString()

    /** Where an app's sign-in comes back to, listed by the operator. */
    private fun appRedirects(world: World) = world.settings {
        it.with("urls", "allowedOrigins", value = j("""["http://localhost:5173"]"""))
            .with("urls", "allowedRedirectUrls", value = j("""["$SCHEME_REDIRECT","$APP_LINK"]"""))
    }

    private fun exchanged(world: World) = world.sent("/v1/client/sign-ins/oauth/exchange")

    /** A round trip leaves nothing to try again. */
    private suspend fun keptNothing(device: Device) {
        assertEquals("no_answer", device.tula.retryProviderSignIn().word)
    }

    /** A device, the browser it was given and what its sign-in with a provider came to. */
    private class Returned(val outcome: ProviderOutcome, val device: Device, val browser: ScriptedBrowser) {
        val tula get() = device.tula
    }

    private suspend fun continueWith(
        world: World,
        provider: OAuthProvider,
        consent: Map<String, String>,
        redirectUrl: String = LOOPBACK_REDIRECT,
    ): Returned {
        val browser = ScriptedBrowser { url, _ -> world.atProvider(url, consent) }
        val device = world.client(browser = browser)
        return Returned(device.tula.signIn(provider, redirectUrl), device, browser)
    }

    private suspend fun signedInWithPassword(world: World, email: String): Pair<Device, ScriptedBrowser> {
        val browser = ScriptedBrowser()
        val device = world.client(browser = browser)
        assertEquals("complete", device.tula.signIn(email).submitPassword(PASSWORD).status)
        return device to browser
    }

    private suspend fun link(
        world: World,
        device: Device,
        browser: ScriptedBrowser,
        provider: OAuthProvider,
        consent: Map<String, String>,
        redirectUrl: String = LOOPBACK_REDIRECT,
    ): ProviderOutcome {
        browser.script = { url, _ -> world.atProvider(url, consent) }
        return device.tula.identities.link(provider, redirectUrl).also { keptNothing(device) }
    }

    @Test
    @Journey("OAuth sign-up and sign-in")
    fun `a provider sign-in from the app - started as an android client, the browser comes back, the app is signed in, and nothing of the round trip is kept`() =
        oauthJourney { world ->
            appRedirects(world)
            val email = world.freshEmail()
            var returned = ""
            val browser = ScriptedBrowser { url, redirectUrl ->
                assertEquals(LOOPBACK_REDIRECT, redirectUrl)
                world.atProvider(url, mapOf("email" to email)).also { returned = it }
            }
            val device = world.client(browser = browser)
            assertEquals(listOf("google"), device.tula.config().signIn.oauth)

            val outcome = device.tula.signIn(OAuthProvider.Google, LOOPBACK_REDIRECT)
            assertEquals("signed_in", outcome.word)
            assertEquals("complete", outcome.flow?.step?.status)
            assertTrue(returned.startsWith("$LOOPBACK_REDIRECT#tula_ticket="))
            assertEquals(email, signedIn(device).user?.email)
            assertEquals(1, device.states.size)

            val start = world.sent("/v1/client/sign-ins/oauth").first()
            assertEquals("android", start.headers["x-tula-client"])
            assertFalse(start.headers.keys.any { it.equals("origin", true) })
            assertEquals(
                j("""{"provider":"google","redirectUrl":"$LOOPBACK_REDIRECT"}"""),
                j(start.requestBody.orEmpty()),
            )
            assertEquals(1, exchanged(world).size)
            val sent = j(exchanged(world).first().requestBody.orEmpty()).jsonObject
            val ticket = sent.text("ticket")
            val binding = sent.text("binding")
            assertContains(returned, ticket)
            assertTrue(binding.startsWith("tula_ob_"))

            keptNothing(device)
            assertTrue(device.storage.get(world.storageKey).orEmpty().startsWith("tula_rt_"))
            // Nothing of the round trip travels in an address the client built.
            for (exchange in world.exchanges) {
                for (secret in listOf("tula_ot_", "tula_ob_", "tula_ticket", "code=", "state=")) {
                    assertFalse(secret in exchange.path, exchange.path)
                }
            }
            val visible = "${device.tula} $outcome ${outcome.flow} ${device.tula.state.value}"
            assertFalse(binding in visible)
            assertFalse(ticket in visible)
            assertContains(browser.opened.first().first, "/v1/dev/oauth/authorize?")

            val userId = signedIn(device).user?.id
            device.tula.session.signOut()
            val again = continueWith(world, OAuthProvider.Google, mapOf("email" to email))
            assertEquals("signed_in", again.outcome.word)
            assertEquals(userId, signedIn(again.device).user?.id)
        }

    @Test
    @Journey("OAuth sign-up and sign-in")
    fun `what the browser comes back with is exchanged only when it is the redirect URL that was asked for and this client started the round trip`() =
        oauthJourney { world ->
            appRedirects(world)
            val loopback = LOOPBACK_REDIRECT
            fun consent() = mapOf("email" to world.freshEmail())

            val bare = world.client()
            assertEquals("provider.unsupported", caught { bare.tula.signIn(OAuthProvider.Google, loopback) }.code)
            assertEquals(0, world.exchanges.size)

            // An attacker finishes at the provider and hands a victim the address it came back with.
            var stolen = ""
            val attacker = world.client(
                browser = ScriptedBrowser { url, _ ->
                    stolen = world.atProvider(url, consent())
                    null
                },
            )
            var outcome = attacker.tula.signIn(OAuthProvider.Google, loopback)
            assertEquals("cancelled", outcome.word)
            assertTrue(stolen.startsWith("$loopback#tula_ticket="))
            keptNothing(attacker)

            val before = exchanged(world).size
            val victim = world.client(browser = ScriptedBrowser { _, _ -> stolen })
            outcome = victim.tula.signIn(OAuthProvider.Google, loopback)
            assertEquals("not_started_here", outcome.word)
            assertFalse(victim.tula.state.value is AuthState.SignedIn)
            assertNull(victim.storage.get(world.storageKey))
            keptNothing(victim)

            val bends: List<(String) -> String> = listOf(
                { it.replace(loopback, "$loopback/more") },
                { it.replace(loopback, "$loopback?next=1") },
                { it.replace(loopback, "http://localhost:5173/other") },
                { it.replace("http://localhost:5173", "https://evil.example") },
                { it.replace("http://localhost:5173", "HTTP://LOCALHOST:5173") },
                { it.replace("#", "?") },
                { it.substringBefore('#') },
                { "" },
            )
            for (bend in bends) {
                val device = world.client(browser = ScriptedBrowser { url, _ -> bend(world.atProvider(url, consent())) })
                outcome = device.tula.signIn(OAuthProvider.Google, loopback)
                assertContains(listOf("unexpected_return", "no_answer"), outcome.word)
                assertFalse(device.tula.state.value is AuthState.SignedIn)
                keptNothing(device)
            }
            val empty = world.client(browser = ScriptedBrowser { _, _ -> "$loopback#hello=1" })
            assertEquals("no_answer", empty.tula.signIn(OAuthProvider.Google, loopback).word)
            // None of them was a request about a ticket.
            assertEquals(before, exchanged(world).size)

            // A closed browser is an outcome, and the same call works again.
            val browser = ScriptedBrowser()
            val closed = world.client(browser = browser)
            outcome = closed.tula.signIn(OAuthProvider.Google, loopback)
            assertSame(ProviderOutcome.Cancelled, outcome)
            assertFalse(closed.tula.state.value is AuthState.SignedIn)
            keptNothing(closed)
            browser.script = { url, _ -> world.atProvider(url, consent()) }
            assertEquals("signed_in", closed.tula.signIn(OAuthProvider.Google, loopback).word)

            val denied = continueWith(world, OAuthProvider.Google, mapOf("action" to "deny"))
            assertEquals("oauth.access_denied", denied.outcome.word)
            keptNothing(denied.device)
            val unverified = continueWith(world, OAuthProvider.Google, consent() + ("unverified" to "1"))
            assertEquals("oauth.email_unverified", unverified.outcome.word)
            assertFalse(unverified.tula.state.value is AuthState.SignedIn)
        }

    @Test
    @Journey("provider sign-in returned to a custom scheme")
    fun `a provider sign-in comes back to the app's custom scheme - the listed entry, character for character, and only for a sign-in`() =
        oauthJourney { world ->
            appRedirects(world)
            val email = world.freshEmail()
            var returned = ""
            val device = world.client(
                browser = ScriptedBrowser { url, redirectUrl ->
                    assertEquals(SCHEME_REDIRECT, redirectUrl)
                    world.atProvider(url, mapOf("email" to email)).also { returned = it }
                },
            )
            var outcome = device.tula.signIn(OAuthProvider.Google, SCHEME_REDIRECT)
            assertTrue(returned.startsWith("$SCHEME_REDIRECT#tula_ticket="))
            assertEquals("signed_in", outcome.word)
            assertEquals(email, signedIn(device).user?.email)
            assertTrue(device.storage.get(world.storageKey).orEmpty().startsWith("tula_rt_"))
            keptNothing(device)

            val before = exchanged(world).size
            val bends: List<(String) -> String> = listOf(
                { it.replace(SCHEME_REDIRECT, "com.example.journeys:/elsewhere") },
                { it.replace(SCHEME_REDIRECT, "$SCHEME_REDIRECT/more") },
                { it.replace(SCHEME_REDIRECT, "com.example.journeys://oauth/callback") },
            )
            for (bend in bends) {
                val other = world.client(
                    browser = ScriptedBrowser { url, _ -> bend(world.atProvider(url, mapOf("email" to email))) },
                )
                outcome = other.tula.signIn(OAuthProvider.Google, SCHEME_REDIRECT)
                assertEquals("unexpected_return", outcome.word)
                assertFalse(other.tula.state.value is AuthState.SignedIn)
            }
            assertEquals(before, exchanged(world).size)

            // Connecting an account is a `web` attempt to the server, which a custom scheme is refused.
            val member = continueWith(world, OAuthProvider.Google, mapOf("email" to world.freshEmail()))
            val opened = member.browser.opened.size
            val refused = caught { member.tula.identities.link(OAuthProvider.Google, SCHEME_REDIRECT) }
            assertEquals("request.redirect_not_allowed", refused.code)
            assertEquals("client_not_native", refused.param("reason"))
            assertEquals(opened, member.browser.opened.size)
            keptNothing(member.device)
        }

    @Test
    @Journey("provider sign-in returned to an app link")
    fun `a provider sign-in comes back to an app link, an https entry matched exactly, and a profile connects an account the same way`() =
        oauthJourney { world ->
            appRedirects(world)
            val email = world.freshEmail()
            var returned = ""
            val device = world.client(
                browser = ScriptedBrowser { url, redirectUrl ->
                    assertEquals(APP_LINK, redirectUrl)
                    world.atProvider(url, mapOf("email" to email)).also { returned = it }
                },
            )
            var outcome = device.tula.signIn(OAuthProvider.Google, APP_LINK)
            assertTrue(returned.startsWith("$APP_LINK#tula_ticket="))
            assertEquals("signed_in", outcome.word)
            assertEquals(email, signedIn(device).user?.email)
            keptNothing(device)

            val before = exchanged(world).size
            val other = world.client(
                browser = ScriptedBrowser { url, _ ->
                    world.atProvider(url, mapOf("email" to email)).replace(APP_LINK, "https://app.example.com/")
                },
            )
            outcome = other.tula.signIn(OAuthProvider.Google, APP_LINK)
            assertEquals("unexpected_return", outcome.word)
            assertEquals(before, exchanged(world).size)

            val memberEmail = world.freshEmail()
            adminUser(world, memberEmail, verified = true)
            val (member, browser) = signedInWithPassword(world, memberEmail)
            val consent = mapOf("email" to world.freshEmail(), "subject" to "second-account")
            val linked = link(world, member, browser, OAuthProvider.Google, consent, redirectUrl = APP_LINK)
            assertEquals("google", assertIs<ProviderOutcome.Linked>(linked).identity.provider)
            assertEquals(1, member.tula.identities.list().size)
        }

    @Test
    @Journey("custom scheme refused for a provider without PKCE")
    fun `a provider that binds its code with nothing but the client secret is refused the custom scheme, with the server's reason and no browser opened, and an app link serves it`() =
        oauthJourney { world ->
            appRedirects(world)
            val consents = listOf(
                Triple(OAuthProvider.Linkedin, "linkedin", mapOf("email" to world.freshEmail(), "subject" to "li-${guid()}")),
                Triple(OAuthProvider.Facebook, "facebook", mapOf("subject" to "10203040506070809")),
            )
            for ((provider, name, consent) in consents) {
                world.provider(name)
                val browser = ScriptedBrowser { url, _ -> world.atProvider(url, consent) }
                val device = world.client(browser = browser)
                val refused = caught { device.tula.signIn(provider, SCHEME_REDIRECT) }
                assertEquals("request.redirect_not_allowed", refused.code)
                assertEquals(400, refused.status)
                assertEquals("provider_without_pkce", refused.param("reason"))
                assertEquals(0, browser.opened.size)
                assertFalse(device.tula.state.value is AuthState.SignedIn)
                keptNothing(device)

                assertEquals("signed_in", device.tula.signIn(provider, APP_LINK).word)
            }
            val google = continueWith(world, OAuthProvider.Google, mapOf("email" to world.freshEmail()), SCHEME_REDIRECT)
            assertEquals("signed_in", google.outcome.word)
        }

    @Test
    @Journey("app link or custom scheme that is not listed")
    fun `a redirect URL that is not, character for character, a listed entry is refused at the start - no browser is opened and nothing is kept`() =
        oauthJourney { world ->
            appRedirects(world)
            world.tier("dev")
            val unlisted = listOf(
                "com.example.other:/oauth/callback",
                "$SCHEME_REDIRECT/",
                "$SCHEME_REDIRECT/more",
                "com.example.journeys:/oauth/Callback",
                "com.example.journeys://oauth/callback",
                "$APP_LINK/",
                "$APP_LINK?next=1",
                "https://app.example.com/oauth/Callback",
                "https://other.example.com/oauth/callback",
                LOOPBACK_REDIRECT,
            )
            for (redirectUrl in unlisted) {
                val browser = ScriptedBrowser()
                val device = world.client(browser = browser)
                val refused = caught { device.tula.signIn(OAuthProvider.Google, redirectUrl) }
                assertEquals("request.redirect_not_allowed", refused.code, redirectUrl)
                assertNull(refused.param("reason"), redirectUrl)
                assertEquals(0, browser.opened.size, redirectUrl)
                keptNothing(device)
                assertNull(device.storage.get(world.storageKey))
            }
            for (redirectUrl in listOf(SCHEME_REDIRECT, APP_LINK)) {
                val browser = ScriptedBrowser()
                val device = world.client(browser = browser)
                assertEquals("cancelled", device.tula.signIn(OAuthProvider.Google, redirectUrl).word)
                assertEquals(1, browser.opened.size)
                assertContains(browser.opened.first().first, "/v1/dev/oauth/authorize?")
                assertEquals(redirectUrl, browser.opened.first().second)
            }
        }

    @Test
    @Journey("OAuth account linking")
    fun `OAuth - automatic linking needs a verified address on both sides, and a profile links and unlinks, but not the last way in`() =
        oauthJourney { world ->
            val member = world.freshEmail()
            val memberId = adminUser(world, member, verified = true)
            val linked = continueWith(world, OAuthProvider.Google, mapOf("email" to member))
            assertEquals("signed_in", linked.outcome.word)
            assertEquals(memberId, signedIn(linked.device).user?.id)
            var identities = linked.tula.identities.list()
            assertEquals(listOf("google"), identities.map { it.provider })
            linked.tula.identities.unlink(identities[0].id)
            assertEquals(0, linked.tula.identities.list().size)

            val squatted = world.freshEmail()
            adminUser(world, squatted, verified = false)
            val refused = continueWith(world, OAuthProvider.Google, mapOf("email" to squatted))
            assertEquals("oauth.account_exists", refused.outcome.word)
            assertFalse(refused.tula.state.value is AuthState.SignedIn)

            val consent = mapOf("email" to world.freshEmail(), "subject" to "another-account")
            val outcome = link(world, linked.device, linked.browser, OAuthProvider.Google, consent)
            assertEquals("google", assertIs<ProviderOutcome.Linked>(outcome).identity.provider)
            assertEquals(1, linked.tula.identities.list().size)
            assertFalse("another-account" in outcome.toString())

            val only = continueWith(world, OAuthProvider.Google, mapOf("email" to world.freshEmail()))
            identities = only.tula.identities.list()
            assertEquals("identity.last_sign_in_method", caught { only.tula.identities.unlink(identities.first().id) }.code)
            assertEquals(1, only.tula.identities.list().size)
        }

    @Test
    @Journey("OAuth with a second factor")
    fun `OAuth - a user with an authenticator comes back to a flow on the second factor, and is signed in only after it`() =
        oauthJourney { world ->
            val email = world.freshEmail()
            val first = continueWith(world, OAuthProvider.Google, mapOf("email" to email))
            assertEquals("signed_in", first.outcome.word)
            val secret = first.tula.factors.startTotp().secret
            first.tula.factors.confirmTotp(world.totp(secret))
            world.advance(31_000)

            val second = continueWith(world, OAuthProvider.Google, mapOf("email" to email))
            val flow = assertIs<ProviderOutcome.NeedsStep>(second.outcome).flow
            assertEquals(listOf("totp", "backup_code"), options(flow.step))
            assertFalse(second.tula.state.value is AuthState.SignedIn)
            assertNull(second.device.storage.get(world.storageKey))
            assertEquals("complete", flow.submitTotp(world.totp(secret)).status)
            assertEquals(email, signedIn(second.device).user?.email)
            assertEquals(setOf("fed", "otp", "mfa"), proven(second.device))
        }

    @Test
    @Journey("step-up by emailed code")
    fun `step-up by email - a user with no password asks for a code, proves it and repeats the sensitive call, and with a second factor the code is gone`() =
        oauthJourney { world ->
            val email = world.freshEmail()
            val account = continueWith(world, OAuthProvider.Google, mapOf("email" to email))
            assertEquals("signed_in", account.outcome.word)
            val tula = account.tula
            assertFalse(tula.user().hasPassword)
            val sessionId = signedIn(account.device).sessionId
            fun sends() = world.sent("/v1/client/sessions/step-up/email-code")

            world.advance(11 * 60_000)
            val refused = caught { tula.factors.startTotp() }
            assertEquals("auth.step_up_required", refused.code)
            assertEquals(listOf("email_code"), refused.stepUpMethods)
            // Nothing is emailed until the client asks.
            assertEquals(0, sends().size)

            val receipt = tula.stepUp.sendEmailCode()
            assertEquals("email_code", receipt.method)
            assertTrue(receipt.destination.drop(1).startsWith("***@"))
            assertTrue(receipt.expiresAt.isNotEmpty())
            val code = world.code(email)
            assertFalse(code in sends().last().responseBody)
            val again = caught { tula.stepUp.sendEmailCode() }
            assertEquals("rate_limited", again.code)
            assertEquals(429, again.status)
            assertNotNull(again.retryAfterMs)

            val wrong = caught { tula.stepUp.withEmailCode(if (code == "000000") "111111" else "000000") }
            assertEquals("verification.invalid_code", wrong.code)
            assertEquals(422, wrong.status)
            val stored = account.device.storage.get(world.storageKey)
            tula.stepUp.withEmailCode(code)
            assertEquals(sessionId, signedIn(account.device).sessionId)
            assertEquals(setOf("fed", "email"), proven(account.device))
            assertEquals(stored, account.device.storage.get(world.storageKey))
            val spent = caught { tula.stepUp.withEmailCode(code) }
            assertEquals("verification.expired", spent.code)
            assertEquals(410, spent.status)

            val secret = tula.factors.startTotp().secret
            tula.factors.confirmTotp(world.totp(secret))
            // With a second factor an emailed code steps nothing up.
            assertEquals(listOf("totp", "backup_code"), caught { tula.stepUp.sendEmailCode() }.stepUpMethods)
            assertEquals(listOf("totp", "backup_code"), caught { tula.stepUp.withEmailCode(code) }.stepUpMethods)
        }

    private suspend fun signUpAndSignIn(world: World, provider: OAuthProvider, name: String, account: () -> Map<String, String>) {
        val email = world.freshEmail()
        val mine = account()
        assertEquals(listOf("google", name), world.client().tula.config().signIn.oauth)
        val first = continueWith(world, provider, mine + ("email" to email))
        assertEquals("signed_in", first.outcome.word)
        assertEquals(email, signedIn(first.device).user?.email)
        keptNothing(first.device)
        assertEquals(listOf(name), first.tula.identities.list().map { it.provider })
        val userId = signedIn(first.device).user?.id
        first.tula.session.signOut()

        // The same account signs in whatever address the provider reports for it now.
        val again = continueWith(world, provider, mine + mapOf("email" to world.freshEmail(), "unverified" to "1"))
        assertEquals("signed_in", again.outcome.word)
        assertEquals(userId, signedIn(again.device).user?.id)
        assertEquals(email, again.tula.user().email)

        val unvouched = continueWith(world, provider, account() + mapOf("email" to world.freshEmail(), "unverified" to "1"))
        assertEquals("oauth.email_unverified", unvouched.outcome.word)
        assertFalse(unvouched.tula.state.value is AuthState.SignedIn)
        keptNothing(unvouched.device)
    }

    private suspend fun linking(world: World, provider: OAuthProvider, name: String, account: () -> Map<String, String>) {
        val member = world.freshEmail()
        val memberId = adminUser(world, member, verified = true)

        val attacker = account() + ("unverified" to "1")
        val taken = continueWith(world, provider, attacker + ("email" to member))
        assertEquals("oauth.email_unverified", taken.outcome.word)
        assertFalse(taken.tula.state.value is AuthState.SignedIn)
        assertNull(taken.device.storage.get(world.storageKey))
        // The answer does not say whether the address has an account.
        val nobody = continueWith(world, provider, attacker + ("email" to world.freshEmail()))
        assertEquals(taken.outcome.word, nobody.outcome.word)

        val linked = continueWith(world, provider, account() + ("email" to member))
        assertEquals("signed_in", linked.outcome.word)
        assertEquals(memberId, signedIn(linked.device).user?.id)
        assertEquals(listOf(name), linked.tula.identities.list().map { it.provider })

        val squatted = world.freshEmail()
        adminUser(world, squatted, verified = false)
        assertEquals("oauth.account_exists", continueWith(world, provider, account() + ("email" to squatted)).outcome.word)

        val colleagueEmail = world.freshEmail()
        adminUser(world, colleagueEmail, verified = true)
        val (colleague, browser) = signedInWithPassword(world, colleagueEmail)
        val second = account() + ("unverified" to "1")
        val outcome = link(world, colleague, browser, provider, second + ("email" to world.freshEmail()))
        assertEquals(name, assertIs<ProviderOutcome.Linked>(outcome).identity.provider)
        colleague.tula.session.signOut()
        val back = continueWith(world, provider, second + ("email" to world.freshEmail()))
        assertEquals("signed_in", back.outcome.word)
        assertEquals(colleagueEmail, back.tula.user().email)
    }

    private suspend fun signUpWithNoAddress(world: World, provider: OAuthProvider, name: String) {
        val subject = snowflake()
        assertEquals(listOf("google", name), world.client().tula.config().signIn.oauth)
        val first = continueWith(world, provider, mapOf("subject" to subject))
        assertEquals("signed_in", first.outcome.word)
        val user = first.tula.user()
        assertNull(user.email)
        assertNull(user.emailVerifiedAt)
        assertFalse(user.hasPassword)
        keptNothing(first.device)
        assertEquals(listOf(name), first.tula.identities.list().map { it.provider })
        first.tula.session.signOut()

        val again = continueWith(world, provider, mapOf("subject" to subject))
        assertEquals("signed_in", again.outcome.word)
        assertEquals(user.id, again.tula.user().id)
        assertNull(again.tula.user().email)
        again.tula.session.signOut()

        // An address on the consent form is never read.
        val reported = world.freshEmail()
        val other = continueWith(world, provider, mapOf("subject" to snowflake(), "email" to reported))
        assertEquals("signed_in", other.outcome.word)
        val another = other.tula.user()
        assertNull(another.email)
        assertNotEquals(user.id, another.id)
        assertTrue(world.exchanges.none { reported in it.responseBody })
    }

    private suspend fun neverLinksByAddress(world: World, provider: OAuthProvider, name: String) {
        val member = world.freshEmail()
        val memberId = adminUser(world, member, verified = true)

        val stranger = continueWith(world, provider, mapOf("subject" to snowflake(), "email" to member))
        assertEquals("signed_in", stranger.outcome.word)
        val made = stranger.tula.user()
        assertNull(made.email)
        assertNotEquals(memberId, made.id)
        val identities = stranger.tula.identities.list()
        assertEquals(listOf(name), identities.map { it.provider })
        val refused = caught { stranger.tula.identities.unlink(identities[0].id) }
        assertEquals("identity.last_sign_in_method", refused.code)
        assertEquals(409, refused.status)
        assertEquals(1, stranger.tula.identities.list().size)

        val (device, browser) = signedInWithPassword(world, member)
        assertEquals(0, device.tula.identities.list().size)
        val subject = snowflake()
        val outcome = link(world, device, browser, provider, mapOf("subject" to subject))
        assertEquals(name, assertIs<ProviderOutcome.Linked>(outcome).identity.provider)
        device.tula.session.signOut()
        val back = continueWith(world, provider, mapOf("subject" to subject))
        assertEquals("signed_in", back.outcome.word)
        assertEquals(memberId, back.tula.user().id)
        assertEquals(member, back.tula.user().email)
    }

    @Test
    @Journey("Microsoft sign-up and sign-in")
    fun `Microsoft - a sign-up comes back signed in, the same account signs in again whatever address is reported, and another tenant's is another account`() =
        oauthJourney { world ->
            world.provider("microsoft", ""","tenant":"common"""")
            val objectId = guid()
            signUpAndSignIn(world, OAuthProvider.Microsoft, "microsoft") { mapOf("tenant_id" to contoso, "object_id" to guid()) }
            val email = world.freshEmail()
            val mine = continueWith(world, OAuthProvider.Microsoft, mapOf("email" to email, "tenant_id" to contoso, "object_id" to objectId))
            // The same object id in another tenant is somebody else.
            val other = continueWith(
                world,
                OAuthProvider.Microsoft,
                mapOf("email" to world.freshEmail(), "tenant_id" to fabrikam, "object_id" to objectId),
            )
            assertEquals("signed_in", other.outcome.word)
            assertNotEquals(mine.tula.user().id, other.tula.user().id)
        }

    @Test
    @Journey("Microsoft sign-up and sign-in")
    fun `Microsoft - an account of a tenant the environment does not accept comes back as a provider error`() =
        oauthJourney { world ->
            world.provider("microsoft", ""","tenant":"$contoso"""")
            val email = world.freshEmail()
            val outsider = continueWith(
                world,
                OAuthProvider.Microsoft,
                mapOf("email" to email, "tenant_id" to fabrikam, "object_id" to guid()),
            )
            assertEquals("oauth.provider_error", outsider.outcome.word)
            assertFalse(outsider.tula.state.value is AuthState.SignedIn)
            assertNull(outsider.device.storage.get(world.storageKey))
            val member = continueWith(
                world,
                OAuthProvider.Microsoft,
                mapOf("email" to email, "tenant_id" to contoso, "object_id" to guid()),
            )
            assertEquals("signed_in", member.outcome.word)
        }

    @Test
    @Journey("Microsoft account linking")
    fun `Microsoft - an address without the verified-domain claim links to nobody, with it and a verified Tula address it links, and a profile links whatever the claim`() =
        oauthJourney { world ->
            world.provider("microsoft", ""","tenant":"common"""")
            linking(world, OAuthProvider.Microsoft, "microsoft") { mapOf("tenant_id" to contoso, "object_id" to guid()) }
        }

    @Test
    @Journey("Discord sign-up and sign-in")
    fun `Discord - the config offers it, a sign-up comes back signed in, and the same account signs in again whatever address is reported`() =
        oauthJourney { world ->
            world.provider("discord")
            signUpAndSignIn(world, OAuthProvider.Discord, "discord") { mapOf("subject" to snowflake()) }
        }

    @Test
    @Journey("Discord account linking")
    fun `Discord - an unverified address links to nobody, a verified one and a verified Tula address links, and a profile links whatever the provider says`() =
        oauthJourney { world ->
            world.provider("discord")
            linking(world, OAuthProvider.Discord, "discord") { mapOf("subject" to snowflake()) }
        }

    @Test
    @Journey("LinkedIn sign-up and sign-in")
    fun `LinkedIn - the config offers it, a sign-up comes back signed in, and the same account signs in again whatever address is reported`() =
        oauthJourney { world ->
            world.provider("linkedin")
            signUpAndSignIn(world, OAuthProvider.Linkedin, "linkedin") { mapOf("subject" to "li-${guid()}") }
        }

    @Test
    @Journey("LinkedIn account linking")
    fun `LinkedIn - an unverified address links to nobody, a verified one and a verified Tula address links, and a profile links whatever the provider says`() =
        oauthJourney { world ->
            world.provider("linkedin")
            linking(world, OAuthProvider.Linkedin, "linkedin") { mapOf("subject" to "li-${guid()}") }
        }

    @Test
    @Journey("X sign-up and sign-in")
    fun `X - a sign-up comes back signed in to an account with no email address, the same id signs it in again, and an address on the consent form is never read`() =
        oauthJourney { world ->
            world.provider("x")
            signUpWithNoAddress(world, OAuthProvider.X, "x")
        }

    @Test
    @Journey("X never links by address")
    fun `X - a consent form that names a member's address makes a new account and touches nobody's, its only identity cannot be removed, and a profile still connects one`() =
        oauthJourney { world ->
            world.provider("x")
            neverLinksByAddress(world, OAuthProvider.X, "x")
        }

    @Test
    @Journey("Facebook sign-up and sign-in")
    fun `Facebook - a sign-up comes back signed in to an account with no email address, the same id signs it in again, and an address on the consent form is never read`() =
        oauthJourney { world ->
            world.provider("facebook")
            signUpWithNoAddress(world, OAuthProvider.Facebook, "facebook")
        }

    @Test
    @Journey("Facebook never links by address")
    fun `Facebook - a consent form that names a member's address makes a new account and touches nobody's, its only identity cannot be removed, and a profile still connects one`() =
        oauthJourney { world ->
            world.provider("facebook")
            neverLinksByAddress(world, OAuthProvider.Facebook, "facebook")
        }

    /** A world with X configured: an account made through it has no email address (ADR 0059). */
    private fun xJourney(run: suspend CoroutineScope.(World) -> Unit) = oauthJourney { world ->
        world.provider("x")
        run(world)
    }

    /** A new account made by a first sign-in with X: signed in, with no address. */
    private suspend fun withX(world: World): Returned {
        val returned = continueWith(world, OAuthProvider.X, mapOf("subject" to snowflake()))
        assertEquals("signed_in", returned.outcome.word)
        assertNull(signedIn(returned.device).user?.email)
        return returned
    }

    private fun dependents(world: World): JsonObject {
        val read = world.admin("GET", "/v1/admin/oauth-providers/x/dependents")
        World.expect(200, read)
        return read.json.jsonObject
    }

    @Test
    @Journey("an email address for an account without one")
    fun `an account with no address - its user asks for a code, proves the address and has it, a taken address is answered like a free one and confirms nothing, and an old session is told to sign in again`() =
        xJourney { world ->
            val tula = withX(world).tula
            val address = world.freshEmail()

            assertEquals("email.invalid", caught { tula.emailAddress.request("not an address") }.code)
            val receipt = tula.emailAddress.request(address)
            assertTrue(Regex("^.\\*\\*\\*@.*").matches(receipt.destination), receipt.destination)
            assertTrue(receipt.expiresAt.isNotEmpty())
            val code = world.code(address)
            // The code is in the inbox and in nothing the client was sent.
            assertFalse(world.sent("/v1/client/me/email").last().responseBody.contains(code))
            // Asking stores nothing on the account.
            assertNull(tula.user().email)
            val again = caught { tula.emailAddress.request(address) }
            assertEquals("rate_limited" to 429, again.code to again.status)

            val wrong = if (code == "000000") "111111" else "000000"
            assertEquals("verification.invalid_code", caught { tula.emailAddress.verify(wrong) }.code)
            val user = tula.emailAddress.verify(code)
            assertEquals(address, user.email)
            assertFalse(user.hasPassword)
            assertNotNull(user.emailVerifiedAt)
            // The client shows the address without asking again.
            assertEquals(address, assertIs<AuthState.SignedIn>(tula.state.value).user?.email)
            // The calls are for an account with no address only.
            assertEquals("email.already_set", caught { tula.emailAddress.request(world.freshEmail()) }.code)
            assertEquals("email.already_set", caught { tula.emailAddress.verify(code) }.code)

            // Another person asks for that address: the same receipt, and no code confirms it.
            val other = withX(world).tula
            val taken = other.emailAddress.request(address)
            assertEquals(receipt.destination, taken.destination)
            assertTrue(taken.expiresAt.isNotEmpty())
            assertEquals("verification.invalid_code", caught { other.emailAddress.verify(code) }.code)
            assertNull(other.user().email)

            // Past the step-up window a user with nothing to step up with is told so: no
            // method is listed, and they sign in again with their provider.
            val late = withX(world).tula
            world.advance(11 * 60_000L)
            val refused = caught { late.emailAddress.request(world.freshEmail()) }
            assertEquals("auth.step_up_required", refused.code)
            assertEquals(emptyList(), refused.stepUpMethods)
            assertNull(late.user().email)
        }

    @Test
    @Journey("an administrator gives an account an email address")
    fun `an administrator gives an account with no address one - the client sees it unverified, and the user's own call then answers that the account has an address`() =
        xJourney { world ->
            val tula = withX(world).tula
            val id = tula.user().id
            val address = world.freshEmail()
            val set = world.admin("PUT", "/v1/admin/users/$id/email", """{"email":"$address"}""")
            World.expect(200, set)
            assertEquals(id, set.json.jsonObject.text("id"))
            assertEquals(address, set.json.jsonObject.text("email"))
            assertTrue(set.json.jsonObject["emailVerifiedAt"] is JsonNull)

            val seen = tula.user()
            assertEquals(address, seen.email)
            assertNull(seen.emailVerifiedAt)
            assertEquals("email.already_set", caught { tula.emailAddress.request(world.freshEmail()) }.code)
            // Never a replacement, and never an address another account holds.
            val again = world.admin("PUT", "/v1/admin/users/$id/email", """{"email":"${world.freshEmail()}"}""")
            assertEquals(409, again.status)
            assertEquals("email.already_set", again.json.jsonObject.text("code"))
            val other = withX(world).tula
            val conflict = world.admin("PUT", "/v1/admin/users/${other.user().id}/email", """{"email":"$address"}""")
            assertEquals(409, conflict.status)
            assertEquals("resource.conflict", conflict.json.jsonObject.text("code"))
            assertNull(other.user().email)
        }

    @Test
    @Journey("accounts that depend on a provider are counted before it is switched off")
    fun `the accounts that could not sign in without a provider are counted - switching it off is not refused, and the client is then told the method is off`() =
        xJourney { world ->
            assertEquals(j("""{"provider":"x","accounts":0,"more":false}"""), dependents(world))
            withX(world)
            withX(world)
            assertEquals(j("""{"provider":"x","accounts":2,"more":false}"""), dependents(world))

            world.provider("x", ""","enabled":false""")
            // What the client observes: the provider is no longer offered, and a start says so.
            assertEquals(listOf("google"), world.client().tula.config().signIn.oauth)
            val refused = caught { continueWith(world, OAuthProvider.X, mapOf("subject" to snowflake())) }
            assertEquals("auth.method_disabled", refused.code)
        }

    private fun sms(world: World, sms: String) = world.settings { it.with("sms", value = j(sms)) }

    private fun wrong(code: String): String = code.dropLast(1) + ((code.last().digitToInt() + 1) % 10)

    @Test
    @Journey("phone number on an account")
    fun `a signed-in user adds a phone number with a texted code, and removes it - every refusal is a code the app can show`() =
        journey { world ->
            val number = "+12025550142"
            val app = signUp(world)
            val other = signUp(world)

            // Off by default: the config says so, and asking is refused.
            assertEquals(ClientConfigPhone(enabled = false), app.tula.config().phone)
            assertEquals("sms.disabled", caught { app.tula.phone.request(number) }.code)
            // On with no country allowed is still off.
            sms(world, """{"enabled":true,"allowedCountries":[],"dailyMessageLimit":500,"templates":{}}""")
            assertEquals("sms.disabled", caught { app.tula.phone.request(number) }.code)
            assertEquals(emptyList(), world.texts())

            sms(world, smsOn)
            // A client made after the change reads the config as it is now, and not which countries.
            assertEquals(ClientConfigPhone(enabled = true), world.client().tula.config().phone)
            assertFalse(world.sent("/v1/client/config").any { it.responseBody.contains("allowedCountries") })

            assertEquals("phone.invalid", caught { app.tula.phone.request("555-0142") }.code)
            assertEquals("sms.country_not_allowed", caught { app.tula.phone.request("+4915112345678") }.code)
            assertEquals(emptyList(), world.texts())

            // The number as a person types it; the receipt holds neither the number nor the code.
            val receipt = app.tula.phone.request("+1 (202) 555-0142")
            assertEquals("***42", receipt.destination)
            assertTrue(java.time.Instant.parse(receipt.expiresAt).toEpochMilli() > world.serverNow())
            val code = world.textedCode(number)
            assertFalse(world.sent("/v1/client/me/phone").any { it.responseBody.contains(code) })
            assertEquals("rate_limited", caught { app.tula.phone.request(number) }.code)
            // Pending is not the account's: nothing has changed yet.
            assertNull(app.tula.user().phoneNumber)

            // Another user's code, a wrong one, the right one, and the right one again.
            assertEquals("verification.expired", caught { other.tula.phone.verify(code) }.code)
            assertEquals("verification.invalid_code", caught { app.tula.phone.verify(wrong(code)) }.code)
            val proven = app.tula.phone.verify(code)
            assertEquals(number, proven.phoneNumber)
            assertNotNull(proven.phoneNumberVerifiedAt)
            // The state shows it without another request.
            assertEquals(number, signedIn(app.device).user?.phoneNumber)
            assertEquals("verification.expired", caught { app.tula.phone.verify(code) }.code)
            assertNull(other.tula.user().phoneNumber)

            // A code asked for before the country was removed, or text messages switched off,
            // is not honoured after.
            other.tula.phone.request("+12025550143")
            val pending = world.textedCode("+12025550143")
            sms(world, """{"enabled":true,"allowedCountries":["DE"],"dailyMessageLimit":500,"templates":{}}""")
            assertEquals("sms.country_not_allowed", caught { other.tula.phone.verify(pending) }.code)
            sms(world, """{"enabled":false,"allowedCountries":["DE"],"dailyMessageLimit":500,"templates":{}}""")
            assertEquals("sms.disabled", caught { other.tula.phone.verify(pending) }.code)
            assertNull(other.tula.user().phoneNumber)

            // Removing needs no text message, so it works with text messages off, and twice.
            app.tula.phone.remove()
            val after = signedIn(app.device).user
            assertNotNull(after)
            assertNull(after.phoneNumber)
            assertNull(after.phoneNumberVerifiedAt)
            assertNull(app.tula.user().phoneNumber)
            app.tula.phone.remove()

            // No request of the client carried the number anywhere but the body that asked for it.
            val carrying = world.exchanges.filter { exchange ->
                exchange.requestBody.orEmpty().contains("5550142") || exchange.path.contains("5550142") ||
                    exchange.headers.values.any { it.contains("5550142") }
            }
            assertEquals(setOf("POST /v1/client/me/phone"), carrying.map { "${it.method} ${it.path}" }.toSet())
        }

    @Test
    @Journey("phone number on an account")
    fun `a phone number change past the step-up window asks for a step-up, and works after it`() = journey { world ->
        sms(world, smsOn)
        val app = signUp(world)
        world.advance(11 * 60_000)
        val error = caught { app.tula.phone.request("+12025550142") }
        assertEquals("auth.step_up_required", error.code)
        assertContains(error.stepUpMethods, "password")
        assertEquals(emptyList(), world.texts())
        assertEquals("auth.step_up_required", caught { app.tula.phone.remove() }.code)
        app.tula.stepUp.withPassword(PASSWORD)
        assertEquals("***42", app.tula.phone.request("+12025550142").destination)
    }

    @Test
    @Journey("text messages to a blocked destination")
    fun `a number outside the country list is a code the app can show, however often it is asked, and costs the user nothing`() =
        journey { world ->
            sms(world, smsOn)
            val app = signUp(world)
            for (typed in listOf("+37120000042", "+37120000042", "+371 2000 0043", "+99912345678")) {
                val error = caught { app.tula.phone.request(typed) }
                assertEquals("sms.country_not_allowed" to 422, error.code to error.status)
            }
            assertEquals(emptyList(), world.texts())
            // Nothing of the user's own allowance was spent by the refusals.
            assertEquals("***42", app.tula.phone.request("+12025550142").destination)
            assertEquals(1, world.texts().size)
            assertEquals(1, world.texts("+12025550142").size)
            assertEquals("+12025550142", app.tula.phone.verify(world.textedCode("+12025550142")).phoneNumber)
        }

    @Test
    @Journey("text messages past the daily limit")
    fun `past the environment's daily limit a request is rate limited, with a wait that ends with the day`() =
        journey { world ->
            sms(world, """{"enabled":true,"allowedCountries":["US","GB"],"dailyMessageLimit":500,"templates":{}}""")
            val app = signUp(world)
            val other = signUp(world)
            app.tula.phone.request("+12025550142")
            val code = world.textedCode("+12025550142")
            // The day is spent from here on. An hour later the hourly limits are open again, so
            // what refuses is the day's own count.
            sms(world, """{"enabled":true,"allowedCountries":["US","GB"],"dailyMessageLimit":1,"templates":{}}""")
            world.advance(61 * 60_000)
            other.tula.stepUp.withPassword(PASSWORD)
            val now = world.serverNow()
            val error = caught { other.tula.phone.request("+447700900142") }
            assertEquals("rate_limited" to 429, error.code to error.status)
            // The wait ends with the UTC day, and the answer names no limit.
            val day = 86_400_000L
            assertEquals((day - now % day + 999) / 1000 * 1000, error.retryAfterMs)
            assertEquals(setOf("retryAfter"), error.params.keys)
            assertEquals(emptyList(), world.texts("+447700900142"))
            assertEquals(1, world.texts().size)
            assertNull(other.tula.user().phoneNumber)
            // The client is told only whether a number can be added.
            assertEquals(ClientConfigPhone(enabled = true), world.client().tula.config().phone)
            // A code is good for ten minutes: the one from before the limit was spent an hour ago
            // has expired, and a new one cannot be had today.
            app.tula.stepUp.withPassword(PASSWORD)
            assertEquals("verification.expired", caught { app.tula.phone.verify(code) }.code)
            assertEquals("rate_limited", caught { app.tula.phone.request("+12025550142") }.code)
            assertEquals(1, world.texts().size)
        }

    @Test
    @Journey("text message wording")
    fun `a phone number is proven with the code from a text in the environment's own words, and nothing of the built-in text`() =
        journey { world ->
            val number = "+12025550142"
            val wording = "Welcome to {{appName}}. Use {{code}} now"
            sms(
                world,
                """{"enabled":true,"allowedCountries":["US"],"dailyMessageLimit":500,""" +
                    """"templates":{"phone_verification":{"text":"$wording"}}}""",
            )
            val app = signUp(world)
            app.tula.phone.request(number)
            // Nothing of the client reads a message: the code is the last run of six digits,
            // whatever the environment wrote around it.
            val code = world.textedCode(number)
            // This environment has no origin, so there is no last line and the sentence is all.
            assertEquals("Welcome to Tula. Use $code now", world.texts(number).last())
            assertEquals(number, app.tula.phone.verify(code).phoneNumber)
        }

    private fun String.refreshToken(): String? =
        (j(this).jsonObject["refreshToken"] as? JsonPrimitive)?.takeIf { it !is JsonNull }?.content

    private companion object {
        /**
         * The most one journey may take. They run the real API over HTTP on this machine, and
         * a busy runner has needed several seconds for one (`JOURNEY_TIMEOUT_MS` of the
         * TypeScript journeys is 20 seconds for the same reason, in process).
         */
        const val JOURNEY_TIMEOUT_MS = 60_000L

        /** A hook with a 100 ms deadline is given up on well inside this, slow runner or not. */
        const val HOOK_WAIT_CEILING_NS = 3_000_000_000L
    }
}
