package dev.tula.auth.ui

import dev.tula.auth.AuthState
import dev.tula.auth.ui.TulaAuthAction.START
import dev.tula.auth.ui.TulaAuthAction.SUBMIT_CODE
import dev.tula.auth.ui.TulaAuthAction.SUBMIT_NEW_PASSWORD
import dev.tula.auth.ui.TulaAuthAction.SUBMIT_PASSWORD
import dev.tula.auth.ui.TulaAuthField.CODE
import dev.tula.auth.ui.TulaAuthField.EMAIL
import dev.tula.auth.ui.TulaAuthField.NEW_PASSWORD
import dev.tula.auth.ui.TulaAuthField.PASSWORD
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.launch
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * What is emptied when, what a closed screen is, and what a completion is when its screen was
 * left or its session could not be stored. Each row runs against an engine that refuses, or a
 * storage that waits or fails.
 */
class LeftAndCompletedTest {
    private suspend fun Bench.onReset() {
        model.showReset()
        engine.post(RESETS) { ok(attemptJson(RESET_STEP, "password_reset")) }
        begin()
    }

    // What a closed screen is

    @Test
    fun `a closed screen is back on the start it opened on`() = runTest {
        val bench = Bench()
        bench.type(EMAIL, ADDRESS)
        bench.onReset()
        bench.type(CODE, "123456")
        bench.type(NEW_PASSWORD, "half-chosen")
        bench.model.toggleReveal(NEW_PASSWORD)
        bench.model.close()
        // Not the reset's start: the start of the mode the model was made for.
        assertEquals(TulaAuthScreen.SignInStart, bench.screen)
        assertEquals(TulaAuthState(TulaAuthScreen.SignInStart).copy(focusRequests = bench.state.focusRequests), bench.state)
        // "Start again" from there is the sign-in's too.
        bench.model.startAgain()
        assertEquals(TulaAuthScreen.SignInStart, bench.screen)
        // The attempt went with the screen: nothing can be sent on it.
        bench.model.submitNewPassword()
        assertEquals(listOf(RESETS), bench.engine.paths())
        val signUp = Bench(TulaAuthMode.SIGN_UP)
        signUp.model.showSignIn()
        signUp.model.close()
        assertEquals(TulaAuthScreen.SignUpStart, signUp.screen)
    }

    @Test
    fun `a screen that signed somebody in closes onto its start`() = runTest {
        val bench = Bench()
        bench.onPassword()
        bench.engine.post("$SIGN_IN/password") { completed() }
        bench.type(PASSWORD, "a-password-nobody-uses")
        bench.tap(SUBMIT_PASSWORD)
        assertEquals(TulaAuthScreen.SignedIn, bench.screen)
        bench.model.close()
        assertEquals(TulaAuthScreen.SignInStart, bench.screen)
        // Nobody is signed out by closing a screen.
        assertTrue(bench.client.state.value is AuthState.SignedIn)
        assertEquals(1, bench.signedIn.get())
    }

    // What is emptied as it is sent, and what is kept to be put right

    @Test
    fun `a sign-up password the server refused is kept to be put right`() = runTest {
        val bench = Bench(TulaAuthMode.SIGN_UP)
        bench.engine.post(SIGN_UPS) { refused("password.too_short", 422) }
        bench.type(PASSWORD, "short")
        bench.model.toggleReveal(PASSWORD)
        bench.begin()
        assertEquals("short", bench.state.password)
        assertEquals(setOf(PASSWORD), bench.state.revealed)
        assertEquals(listOf("Password is too short."), bench.state.fieldErrors[PASSWORD])
    }

    @Test
    fun `a new password the server refused is kept with its code`() = runTest {
        val bench = Bench()
        bench.onReset()
        bench.engine.post("$RESET/password") { refused("password.too_short", 422) }
        bench.type(CODE, "123456")
        bench.type(NEW_PASSWORD, "short")
        bench.tap(SUBMIT_NEW_PASSWORD)
        assertEquals("short", bench.state.newPassword)
        assertEquals("123456", bench.state.code, "the same code goes with the corrected password")
        assertEquals(listOf("Password is too short."), bench.state.fieldErrors[NEW_PASSWORD])
        assertEquals(TulaAuthFocus.Field(NEW_PASSWORD), bench.state.focus)
    }

    @Test
    fun `an expired password's replacement the server refused is kept`() = runTest {
        val bench = Bench()
        bench.onPassword()
        bench.engine.post("$SIGN_IN/password") { ok(attemptJson(EXPIRED)) }
        bench.type(PASSWORD, "an-old-password")
        bench.tap(SUBMIT_PASSWORD)
        bench.engine.post("$SIGN_IN/new-password") { refused("password.reused", 422) }
        bench.type(NEW_PASSWORD, "an-old-password")
        bench.tap(SUBMIT_NEW_PASSWORD)
        assertEquals("an-old-password", bench.state.newPassword)
        assertEquals(1, bench.state.fieldErrors[NEW_PASSWORD]?.size)
        assertEquals(TulaAuthScreen.ExpiredPassword, bench.screen)
    }

    @Test
    fun `a code that proves an address is emptied as it is sent, right or wrong`() = runTest {
        val bench = Bench(TulaAuthMode.SIGN_UP)
        bench.engine.post(SIGN_UPS) { ok(attemptJson(VERIFICATION, "sign_up")) }
        bench.type(PASSWORD, "a-password-nobody-uses")
        bench.begin()
        val gate = Gate()
        bench.engine.post("$SIGN_UP/verify-email") {
            gate.pass()
            // Refused by something that is not about the code: it is emptied all the same.
            refused("rate_limited", 429)
        }
        bench.type(CODE, "123456")
        val sending = launch(Dispatchers.Default) { bench.tap(SUBMIT_CODE) }
        gate.reached()
        assertEquals("", bench.state.code, "emptied when it is sent, not when the answer comes")
        gate.open()
        sending.join()
        assertEquals("", bench.state.code)
        assertTrue(bench.state.formError.orEmpty().isNotEmpty())
        bench.engine.post("$SIGN_UP/verify-email") { completed("sign_up") }
        bench.type(CODE, "654321")
        bench.tap(SUBMIT_CODE)
        assertEquals("", bench.state.code)
        assertEquals(TulaAuthScreen.SignedIn, bench.screen)
    }

    @Test
    fun `a code that signs in is emptied as it is sent`() = runTest {
        val bench = Bench()
        bench.onPassword(firstFactor("email_code", prepared = true))
        bench.engine.post("$SIGN_IN/first-factor/attempt") { refused("rate_limited", 429) }
        bench.type(CODE, "123456")
        bench.tap(SUBMIT_CODE)
        assertEquals("", bench.state.code)
        assertEquals(TulaAuthScreen.EmailCode(MASKED, canUsePassword = false), bench.screen)
    }

    @Test
    fun `a reset's code the server refused is emptied and the new password kept`() = runTest {
        val bench = Bench()
        bench.onReset()
        bench.engine.post("$RESET/password") { refused("verification.invalid_code") }
        bench.type(CODE, "123456")
        bench.type(NEW_PASSWORD, "another-password-nobody-uses")
        bench.tap(SUBMIT_NEW_PASSWORD)
        assertEquals("", bench.state.code)
        assertEquals("another-password-nobody-uses", bench.state.newPassword)
        assertEquals(TulaAuthFocus.Field(CODE), bench.state.focus)
    }

    // A completion whose screen was left

    @Test
    fun `a sign-in that completed while its screen was left is said, not dropped`() = runTest {
        val storage = TestStorage()
        val bench = Bench(storage = storage)
        bench.onPassword()
        bench.engine.post("$SIGN_IN/password") { completed() }
        val gate = Gate()
        storage.gate = gate
        bench.type(PASSWORD, "a-password-nobody-uses")
        val sending = launch(Dispatchers.Default) { bench.tap(SUBMIT_PASSWORD) }
        // The answer said `complete` and the session is being stored: the flow is over.
        gate.reached()
        bench.model.showSignUp()
        assertEquals(TulaAuthScreen.SignUpStart, bench.screen)
        gate.open()
        sending.join()
        assertEquals(TulaAuthScreen.SignedIn, bench.screen)
        assertEquals(1, bench.signedIn.get())
        assertNull(bench.state.formError)
        assertTrue(bench.client.state.value is AuthState.SignedIn)
    }

    @Test
    fun `a sign-in that completed while its screen was closing is told to the app`() = runTest {
        val storage = TestStorage()
        val bench = Bench(storage = storage)
        bench.onPassword()
        bench.engine.post("$SIGN_IN/password") { completed() }
        val gate = Gate()
        storage.gate = gate
        bench.type(PASSWORD, "a-password-nobody-uses")
        val sending = launch(Dispatchers.Default) { bench.tap(SUBMIT_PASSWORD) }
        gate.reached()
        bench.model.close()
        assertEquals(0, bench.signedIn.get())
        gate.open()
        sending.join()
        // After `close()`, and once.
        assertEquals(1, bench.signedIn.get())
        assertEquals(TulaAuthScreen.SignedIn, bench.screen)
    }

    @Test
    fun `a start that completed while its screen was left is said, not discarded`() = runTest {
        val storage = TestStorage()
        val bench = Bench(TulaAuthMode.SIGN_UP, storage)
        // A sign-up that needs no proof completes at its start.
        bench.engine.post(SIGN_UPS) { completed("sign_up") }
        val gate = Gate()
        storage.gate = gate
        bench.type(PASSWORD, "a-password-nobody-uses")
        bench.type(EMAIL, ADDRESS)
        val sending = launch(Dispatchers.Default) { bench.tap(START) }
        gate.reached()
        bench.model.close()
        gate.open()
        sending.join()
        assertEquals(TulaAuthScreen.SignedIn, bench.screen)
        assertEquals(1, bench.signedIn.get())
    }

    @Test
    fun `a late completion ends the flow that was opened meanwhile`() = runTest {
        val storage = TestStorage()
        val bench = Bench(storage = storage)
        bench.onPassword()
        bench.engine.post("$SIGN_IN/password") { completed() }
        val gate = Gate()
        storage.gate = gate
        bench.type(PASSWORD, "a-password-nobody-uses")
        val sending = launch(Dispatchers.Default) { bench.tap(SUBMIT_PASSWORD) }
        gate.reached()
        // The screen is left, comes back, and a second sign-in is started and typed into.
        bench.model.close()
        bench.onPassword()
        bench.type(PASSWORD, "typed-into-the-second")
        assertEquals(TulaAuthScreen.Password(canEmailCode = false), bench.screen)
        gate.open()
        sending.join()
        assertEquals(TulaAuthScreen.SignedIn, bench.screen)
        assertEquals("", bench.state.password)
        assertEquals(1, bench.signedIn.get())
        // The second attempt went with it: nothing more is requested.
        val sent = bench.engine.paths().size
        bench.model.submitPassword()
        assertEquals(sent, bench.engine.paths().size)
    }

    @Test
    fun `an action whose caller was cancelled leaves the screen usable, and says a completion`() = runTest {
        val bench = Bench()
        bench.onPassword()
        val gate = Gate()
        bench.engine.post("$SIGN_IN/password") {
            gate.pass()
            refused("auth.invalid_credentials", 401)
        }
        bench.type(PASSWORD, "a-password-nobody-uses")
        val sending = launch(Dispatchers.Default) { bench.tap(SUBMIT_PASSWORD) }
        gate.reached()
        sending.cancelAndJoin()
        assertFalse(bench.state.isPending)
        assertEquals(TulaAuthScreen.Password(canEmailCode = false), bench.screen)
        gate.open()
        // A start that is cancelled is the same.
        val start = Bench()
        val held = Gate()
        start.engine.post(SIGN_INS) {
            held.pass()
            ok(attemptJson(NEEDS_PASSWORD))
        }
        start.type(EMAIL, ADDRESS)
        val starting = launch(Dispatchers.Default) { start.tap(START) }
        held.reached()
        starting.cancelAndJoin()
        assertFalse(start.state.isPending)
        held.open()
        // A caller cancelled while the session of a completed flow is being stored: the client
        // finishes in its own scope, and the completion is still said.
        val storage = TestStorage()
        val done = Bench(storage = storage)
        done.onPassword()
        done.engine.post("$SIGN_IN/password") { completed() }
        val storing = Gate()
        storage.gate = storing
        done.type(PASSWORD, "a-password-nobody-uses")
        val completing = launch(Dispatchers.Default) { done.tap(SUBMIT_PASSWORD) }
        storing.reached()
        completing.cancelAndJoin()
        assertEquals(TulaAuthScreen.SignedIn, done.screen)
        assertEquals(1, done.signedIn.get())
        storing.open()
        // Cancellation is handed on, never swallowed.
        assertTrue(completing.isCancelled)
        assertTrue(runCatching { throw CancellationException("x") }.isFailure)
    }

    // A completion whose session could not be stored

    @Test
    fun `a flow that completed is signed in also when its session could not be stored`() = runTest {
        data class Row(val name: String, val reach: suspend (Bench) -> Unit, val path: String, val kind: String, val send: suspend (Bench) -> Unit)
        val rows = listOf(
            Row("a password", { it.onPassword() }, "$SIGN_IN/password", "sign_in") {
                it.type(PASSWORD, "a-password-nobody-uses")
                it.tap(SUBMIT_PASSWORD)
            },
            Row("an emailed sign-in code", { it.onPassword(firstFactor("email_code", prepared = true)) }, "$SIGN_IN/first-factor/attempt", "sign_in") {
                it.type(CODE, "123456")
                it.tap(SUBMIT_CODE)
            },
            Row(
                "a sign-up's code",
                {
                    it.model.showSignUp()
                    it.engine.post(SIGN_UPS) { ok(attemptJson(VERIFICATION, "sign_up")) }
                    it.type(PASSWORD, "a-password-nobody-uses")
                    it.begin()
                },
                "$SIGN_UP/verify-email",
                "sign_up",
            ) {
                it.type(CODE, "123456")
                it.tap(SUBMIT_CODE)
            },
        )
        for (row in rows) {
            val storage = TestStorage()
            val bench = Bench(storage = storage)
            row.reach(bench)
            bench.engine.post(row.path) { completed(row.kind) }
            storage.failWrites = true
            row.send(bench)
            assertEquals(TulaAuthScreen.SignedIn, bench.screen, row.name)
            assertEquals(1, bench.signedIn.get(), row.name)
            assertEquals(bench.model.strings.sessionNotSaved, bench.state.formError, row.name)
            assertEquals(bench.model.strings.sessionNotSaved, bench.said.last(), row.name)
            assertTrue(bench.client.state.value is AuthState.SignedIn, row.name)
            assertFalse(bench.everythingSaid().contains("canary-store-text"), row.name)
            // The form is gone: a second submit has nothing to send on.
            val sent = bench.engine.paths().size
            row.send(bench)
            assertEquals(sent, bench.engine.paths().size, row.name)
        }
    }

    @Test
    fun `a start that completed at once is signed in also when its session could not be stored`() = runTest {
        val storage = TestStorage()
        val bench = Bench(TulaAuthMode.SIGN_UP, storage)
        bench.engine.post(SIGN_UPS) { completed("sign_up") }
        storage.failWrites = true
        bench.type(PASSWORD, "a-password-nobody-uses")
        bench.begin()
        assertEquals(TulaAuthScreen.SignedIn, bench.screen)
        assertEquals(1, bench.signedIn.get())
        assertEquals(bench.model.strings.sessionNotSaved, bench.state.formError)
    }

    @Test
    fun `a start that failed before anybody was signed in is said on its form`() = runTest {
        val bench = Bench()
        // The code alone decides nothing: nobody is signed in.
        bench.engine.post(SIGN_INS) { refused("storage.failed", 500) }
        bench.begin()
        assertEquals(TulaAuthScreen.SignInStart, bench.screen)
        assertEquals(0, bench.signedIn.get())
        assertEquals("Your session could not be saved on this device.", bench.state.formError)
    }

    @Test
    fun `the words of a session that was not saved say when it ends`() {
        val words = TulaStrings().sessionNotSaved
        assertTrue(words.contains("could not be saved"))
        // "May": a later refresh that succeeds stores the session after all.
        assertTrue(words.contains("may be signed out when the app closes"))
    }

    @Test
    fun `the note of a session that was not saved goes with its screen`() = runTest {
        val storage = TestStorage()
        val bench = Bench(storage = storage)
        bench.onPassword()
        bench.engine.post("$SIGN_IN/password") { completed() }
        storage.failWrites = true
        bench.type(PASSWORD, "a-password-nobody-uses")
        bench.tap(SUBMIT_PASSWORD)
        assertEquals(bench.model.strings.sessionNotSaved, bench.state.formError)
        bench.model.close()
        assertNull(bench.state.formError)
    }

    @Test
    fun `a flow whose session could not be stored is signed in also when its screen was left`() = runTest {
        val storage = TestStorage()
        val bench = Bench(storage = storage)
        bench.onPassword()
        bench.engine.post("$SIGN_IN/password") { completed() }
        val gate = Gate()
        storage.gate = gate
        storage.failWrites = true
        bench.type(PASSWORD, "a-password-nobody-uses")
        val sending = launch(Dispatchers.Default) { bench.tap(SUBMIT_PASSWORD) }
        gate.reached()
        bench.model.close()
        gate.open()
        sending.join()
        assertEquals(TulaAuthScreen.SignedIn, bench.screen)
        assertEquals(1, bench.signedIn.get())
        assertEquals(bench.model.strings.sessionNotSaved, bench.state.formError)
    }

    // Showing a password

    @Test
    fun `a password is hidden until asked for, and only a secret field can be shown`() = runTest {
        val bench = Bench(TulaAuthMode.SIGN_UP)
        assertEquals(emptySet(), bench.state.revealed)
        bench.model.toggleReveal(EMAIL)
        bench.model.toggleReveal(CODE)
        bench.model.toggleReveal(NEW_PASSWORD)
        assertEquals(emptySet(), bench.state.revealed, "not a secret, or not a field of this screen")
        bench.model.toggleReveal(PASSWORD)
        assertEquals(setOf(PASSWORD), bench.state.revealed)
        bench.model.toggleReveal(PASSWORD)
        assertEquals(emptySet(), bench.state.revealed)
    }

    @Test
    fun `a shown password is hidden again when its screen changes, closes, or it is sent`() = runTest {
        val bench = Bench()
        bench.onPassword(firstFactor("password", "email_code"))
        bench.model.toggleReveal(PASSWORD)
        bench.model.showReset()
        assertEquals(emptySet(), bench.state.revealed)
        bench.model.showSignIn()
        bench.onPassword()
        bench.model.toggleReveal(PASSWORD)
        bench.model.close()
        assertEquals(emptySet(), bench.state.revealed)
        bench.onPassword()
        bench.model.toggleReveal(PASSWORD)
        bench.engine.post("$SIGN_IN/password") { refused("auth.invalid_credentials", 401) }
        bench.type(PASSWORD, "a-wrong-password")
        bench.tap(SUBMIT_PASSWORD)
        // The field came back empty; the next password typed is not drawn in the clear.
        assertEquals(emptySet(), bench.state.revealed)
    }

    @Test
    fun `an action whose flow is gone lands on the start with words`() = runTest {
        data class Row(val name: String, val reach: suspend (Bench) -> Unit, val act: suspend (TulaAuthModel) -> Unit, val start: TulaAuthScreen)
        val rows = listOf(
            Row("the password", { it.onPassword() }, { it.submitPassword() }, TulaAuthScreen.SignInStart),
            Row("the offer of a code", { it.onPassword(firstFactor("email_code", "passkey")) }, { it.sendEmailCode() }, TulaAuthScreen.SignInStart),
            Row("the code", { it.onPassword(firstFactor("email_code", prepared = true)) }, { it.submitCode() }, TulaAuthScreen.SignInStart),
            Row("another email", { it.onPassword(firstFactor("email_code", prepared = true)) }, { it.resendCode() }, TulaAuthScreen.SignInStart),
            Row("a reset's password", { it.onReset() }, { it.submitNewPassword() }, TulaAuthScreen.ResetStart),
            Row("a reset's other code", { it.onReset() }, { it.resendCode() }, TulaAuthScreen.ResetStart),
            Row(
                "an expired password",
                {
                    it.onPassword()
                    it.engine.post("$SIGN_IN/password") { ok(attemptJson(EXPIRED)) }
                    it.type(PASSWORD, "an-old-password")
                    it.tap(SUBMIT_PASSWORD)
                },
                { it.submitNewPassword() },
                TulaAuthScreen.SignInStart,
            ),
        )
        for (row in rows) {
            val bench = Bench()
            row.reach(bench)
            val sent = bench.engine.paths().size
            // Nothing in the model leaves a step open without its flow; the test does.
            bench.model.leave()
            row.act(bench.model)
            assertEquals(row.start, bench.screen, row.name)
            assertEquals(bench.model.strings.flowLost, bench.state.formError, row.name)
            assertEquals(bench.model.strings.flowLost, bench.said.last(), row.name)
            assertEquals(sent, bench.engine.paths().size, row.name)
        }
    }
}
