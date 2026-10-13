package dev.tula.auth.ui

import dev.tula.auth.AuthState
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue
import dev.tula.auth.ui.TulaAccountAction as A
import dev.tula.auth.ui.TulaAccountPanel as P
import dev.tula.auth.ui.TulaAccountSectionId as S

private const val OTHER = "zoe@example.com"

/**
 * The account screen and the client's session: one that ended elsewhere, one that became
 * another user's, and a screen that was closed between a proof and the call it was for.
 */
class AccountSessionTest {
    /** The server ended the session: every call is refused, and so is the refresh. */
    private fun AccountBench.endElsewhere() {
        for (path in listOf(ME, SESSIONS, FACTORS, PASSKEYS)) {
            engine.on("GET", path) { refused("auth.unauthenticated", 401) }
        }
        engine.post("$SESSIONS/refresh") { refused("session.revoked", 401) }
        engine.post("$SESSIONS/revoke-others") { refused("auth.unauthenticated", 401) }
    }

    /** Somebody else signs in on the same client, after a sign-out this screen did not make. */
    private suspend fun AccountBench.becomeAnother() {
        engine.post(SIGN_OUT) { NO_CONTENT }
        client.session.signOut()
        engine.post("$SIGN_IN/password") {
            ok(attemptJson(COMPLETE, session = tokensJson("other").replace("session-1", "session-9")))
        }
        engine.on("GET", ME) { ok(userJson(email = OTHER)) }
        engine.on("GET", SESSIONS) { ok("""{"data":[${sessionJson("session-9", current = true)}]}""") }
        client.signIn(OTHER).submitPassword("another-password-nobody-uses")
        assertEquals("session-9", assertIs<AuthState.SignedIn>(client.state.value).sessionId)
    }

    @Test
    fun `a session that ended elsewhere is told to the app once, however often the account is read`() = runTest {
        val bench = AccountBench().loaded()
        bench.endElsewhere()
        bench.model.load()
        assertIs<AuthState.SignedOut>(bench.client.state.value)
        assertEquals(1, bench.signedOut.get())
        assertTrue(bench.state.signedOut)
        // Nothing of the account is left, and no section says it could not be read.
        assertNull(bench.state.user)
        assertEquals(emptySet(), bench.state.failed)
        assertEquals(emptyList(), bench.content.sections)
        assertEquals(emptySet(), bench.content.actions)

        val sent = bench.engine.requests.size
        bench.model.load()
        bench.model.load()
        assertEquals(1, bench.signedOut.get())
        // Nobody is signed in: there is nothing to ask the server.
        assertEquals(sent, bench.engine.requests.size)

        // Somebody signs in again: the end of that session is one to tell.
        bench.signIn()
        bench.model.load()
        assertFalse(bench.state.signedOut)
        assertEquals(ADDRESS, bench.state.user?.email)
        bench.endElsewhere()
        bench.model.load()
        assertEquals(2, bench.signedOut.get())
    }

    @Test
    fun `a screen that never saw a session reports no sign-out`() = runTest {
        // Nobody ever signed in on this client: there is no session whose end could be told.
        val bench = AccountBench()
        bench.client.load()
        assertIs<AuthState.SignedOut>(bench.client.state.value)
        bench.model.load()
        bench.model.load()
        assertEquals(0, bench.signedOut.get())
        assertFalse(bench.state.signedOut)
        assertFalse(bench.state.signOutFailed)
        assertNull(bench.state.user)
        assertEquals(emptySet<S>(), bench.state.failed)
        assertNull(bench.state.formError)
        // Nothing was asked of the server either.
        assertEquals(emptyList(), bench.engine.requests.toList())

        // Once somebody signs in and that session ends elsewhere, it is told, once.
        bench.signIn()
        bench.model.load()
        assertEquals(ADDRESS, bench.state.user?.email)
        bench.endElsewhere()
        bench.model.load()
        bench.model.load()
        assertEquals(1, bench.signedOut.get())
        assertTrue(bench.state.signedOut)
    }

    @Test
    fun `an action that finds the session ended tells the app, and says no error of its own`() = runTest {
        val bench = AccountBench().loaded()
        bench.endElsewhere()
        bench.tap(A.RevokeOthers)
        assertEquals(1, bench.signedOut.get())
        assertTrue(bench.state.signedOut)
        assertNull(bench.state.formError)
        assertFalse(bench.state.isPending)
        assertNull(bench.state.sessions)
    }

    @Test
    fun `the screen's own sign-out is told once, and a failed one never as a session that ended`() = runTest {
        val bench = AccountBench().loaded()
        bench.engine.post(SIGN_OUT) { NO_CONTENT }
        bench.tap(A.SignOut)
        assertEquals(1, bench.signedOut.get())
        bench.model.load()
        bench.model.load()
        assertEquals(1, bench.signedOut.get())

        val failed = AccountBench().loaded()
        failed.engine.post(SIGN_OUT) { refused("internal", 500) }
        failed.tap(A.SignOut)
        assertTrue(failed.state.signOutFailed)
        failed.model.load()
        // The client holds no session, and the app is still not told: the server was not.
        assertEquals(0, failed.signedOut.get())
        assertTrue(failed.state.signOutFailed)
        assertFalse(failed.state.signedOut)
        assertEquals(failed.model.strings.account.signOutFailed, failed.state.formError)
        assertEquals(setOf<A>(A.SignOut), failed.content.actions)
    }

    @Test
    fun `a model that outlives its user shows nothing of them to the next one`() = runTest {
        val bench = AccountBench().loaded()
        assertEquals(ADDRESS, bench.state.user?.email)
        assertEquals(2, bench.state.sessions?.size)
        bench.becomeAnother()

        val gate = Gate()
        bench.engine.on("GET", ME) {
            gate.pass()
            ok(userJson(email = OTHER))
        }
        val read = launch { bench.model.load() }
        gate.reached()
        // While the new user's account is being read, nothing of the old one is drawn.
        assertNull(bench.state.user)
        assertNull(bench.state.sessions)
        assertNull(bench.state.factors)
        assertNull(bench.state.passkeys)
        assertFalse(ADDRESS in bench.content.sections.flatMap { it.lines }.joinToString())
        gate.open()
        read.join()
        assertEquals(OTHER, bench.state.user?.email)
        assertEquals(listOf("session-9"), bench.state.sessions?.map { it.id })
        // Nobody's session ended as far as the app needs to hear: somebody is signed in.
        assertEquals(0, bench.signedOut.get())
    }

    @Test
    fun `an answer of the session that was is dropped`() = runTest {
        val bench = AccountBench().loaded()
        val gate = Gate()
        bench.engine.on("GET", SESSIONS) {
            gate.pass()
            ok("""{"data":[${sessionJson("s-old", "web")},${sessionJson("session-1", current = true)}]}""")
        }
        val late = launch { bench.model.load() }
        gate.reached()
        bench.becomeAnother()
        bench.engine.on("GET", SESSIONS) {
            gate.pass()
            ok("""{"data":[${sessionJson("s-old", "web")}]}""")
        }
        gate.open()
        late.join()
        // What was asked as the old user is nobody's now: not their sessions, nor what the
        // rest of that reading brought.
        assertNull(bench.state.sessions)
        assertNull(bench.state.user)
        assertEquals(emptySet<S>(), bench.state.failed)
        assertEquals(0, bench.signedOut.get())
    }

    @Test
    fun `a screen closed between a proof and the call it was for sends nothing more`() = runTest {
        val bench = AccountBench().loaded()
        bench.engine.post("$SESSIONS/revoke-others") { stepUpRequired("password") }
        bench.tap(A.RevokeOthers)
        assertIs<P.StepUp>(bench.panel)
        bench.engine.post(STEP_UP) { ok(tokensJson("proven")) }
        bench.engine.post("$SESSIONS/revoke-others") { ok("""{"revoked":1}""") }
        // Whoever watches the state closes the screen the moment the proof is accepted: after
        // the step-up, before the other sessions are asked to be ended again. (The act is one
        // of the overview, which a closed screen is on: only the model can stop it.)
        var proving = false
        val watcher = launch(Dispatchers.Unconfined) {
            bench.model.state.first {
                if (it.panel is P.StepUp) {
                    proving = true
                    false
                } else {
                    proving
                }
            }
            bench.model.close()
        }
        bench.type(TulaAccountField.STEP_UP_PASSWORD, "right")
        bench.tap(A.SubmitStepUp)
        watcher.join()
        assertEquals(1, bench.count("POST", STEP_UP))
        assertEquals(1, bench.count("POST", "$SESSIONS/revoke-others"))
        assertEquals(P.Overview, bench.panel)
        assertNull(bench.state.status)
        assertEquals(2, bench.state.sessions?.size)
        assertFalse(bench.state.isPending)
    }

    @Test
    fun `a proof for one user's call is not spent on the next user`() = runTest {
        val bench = AccountBench().loaded()
        bench.engine.post("$SESSIONS/revoke-others") { stepUpRequired("password") }
        bench.tap(A.RevokeOthers)
        assertIs<P.StepUp>(bench.panel)
        bench.becomeAnother()
        bench.engine.post(STEP_UP) { ok(tokensJson("proven").replace("session-1", "session-9")) }
        bench.type(TulaAccountField.STEP_UP_PASSWORD, "right")
        bench.tap(A.SubmitStepUp)
        // The step-up's form was the old user's: it is gone, and nothing was sent from it.
        assertEquals(0, bench.count("POST", STEP_UP))
        assertEquals(1, bench.count("POST", "$SESSIONS/revoke-others"))
        assertEquals(P.Overview, bench.panel)
    }
}
