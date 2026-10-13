package dev.tula.auth.ui

import dev.tula.auth.AuthState
import dev.tula.auth.ui.TulaAuthAction.RESEND_CODE
import dev.tula.auth.ui.TulaAuthAction.SEND_EMAIL_CODE
import dev.tula.auth.ui.TulaAuthAction.SHOW_RESET
import dev.tula.auth.ui.TulaAuthAction.SHOW_SIGN_UP
import dev.tula.auth.ui.TulaAuthAction.START
import dev.tula.auth.ui.TulaAuthAction.START_AGAIN
import dev.tula.auth.ui.TulaAuthAction.SUBMIT_CODE
import dev.tula.auth.ui.TulaAuthAction.SUBMIT_NEW_PASSWORD
import dev.tula.auth.ui.TulaAuthAction.SUBMIT_PASSWORD
import dev.tula.auth.ui.TulaAuthAction.USE_PASSWORD
import dev.tula.auth.ui.TulaAuthField.CODE
import dev.tula.auth.ui.TulaAuthField.EMAIL
import dev.tula.auth.ui.TulaAuthField.NEW_PASSWORD
import dev.tula.auth.ui.TulaAuthField.PASSWORD
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** Every screen's mapping, every action, and where a problem is said. Nothing is drawn. */
class ModelTest {
    @Test
    fun `a password sign-in goes from the address to the password to signed in`() = runTest {
        val bench = Bench()
        assertEquals(TulaAuthScreen.SignInStart, bench.screen)
        bench.onPassword()
        assertEquals(TulaAuthScreen.Password(canEmailCode = false), bench.screen)
        bench.engine.post("$SIGN_IN/password") { completed() }
        bench.type(PASSWORD, "a-password-nobody-uses")
        bench.tap(SUBMIT_PASSWORD)
        assertEquals(TulaAuthScreen.SignedIn, bench.screen)
        assertEquals(1, bench.signedIn.get())
        assertTrue(bench.client.state.value is AuthState.SignedIn)
        assertTrue(bench.engine.sent("$SIGN_IN/password").single().body.orEmpty().contains("a-password-nobody-uses"))
    }

    @Test
    fun `the address is trimmed before it is sent`() = runTest {
        val bench = Bench()
        bench.engine.post(SIGN_INS) { ok(attemptJson(NEEDS_PASSWORD)) }
        bench.begin("  $ADDRESS \n")
        assertEquals("""{"identifier":"$ADDRESS"}""", bench.engine.sent(SIGN_INS).single().body)
    }

    @Test
    fun `where a step offers both ways the password is asked and nothing is emailed by arriving`() = runTest {
        val bench = Bench()
        bench.onPassword(firstFactor("password", "email_code"))
        assertEquals(TulaAuthScreen.Password(canEmailCode = true), bench.screen)
        assertEquals(listOf(SIGN_INS), bench.engine.paths())
        bench.engine.post("$SIGN_IN/first-factor/prepare") {
            ok(attemptJson(firstFactor("password", "email_code", prepared = true)))
        }
        bench.tap(SEND_EMAIL_CODE)
        assertEquals(TulaAuthScreen.EmailCode(MASKED, canUsePassword = true), bench.screen)
        bench.tap(USE_PASSWORD)
        assertEquals(TulaAuthScreen.Password(canEmailCode = true), bench.screen)
    }

    @Test
    fun `where a code is the only way it is asked for at once`() = runTest {
        val bench = Bench()
        bench.engine.post(SIGN_INS) { ok(attemptJson(firstFactor("email_code"))) }
        bench.engine.post("$SIGN_IN/first-factor/prepare") { ok(attemptJson(firstFactor("email_code", prepared = true))) }
        bench.begin()
        assertEquals(TulaAuthScreen.EmailCode(MASKED, canUsePassword = false), bench.screen)
        assertEquals("""{"strategy":"email_code"}""", bench.engine.sent("$SIGN_IN/first-factor/prepare").single().body)
        bench.engine.post("$SIGN_IN/first-factor/attempt") { completed() }
        bench.type(CODE, "123456")
        bench.tap(SUBMIT_CODE)
        assertEquals(TulaAuthScreen.SignedIn, bench.screen)
        assertTrue(bench.engine.sent("$SIGN_IN/first-factor/attempt").single().body.orEmpty().contains("123456"))
    }

    @Test
    fun `a code that could not be asked for leaves the start and no attempt`() = runTest {
        val bench = Bench()
        bench.engine.post(SIGN_INS) { ok(attemptJson(firstFactor("email_code"))) }
        bench.engine.post("$SIGN_IN/first-factor/prepare") { refused("rate_limited", 429) }
        bench.begin()
        assertEquals(TulaAuthScreen.SignInStart, bench.screen)
        assertFalse(bench.state.isPending)
        assertTrue(bench.state.formError.orEmpty().isNotEmpty())
    }

    @Test
    fun `a code offered beside a way this version lacks is offered and not sent by arriving`() = runTest {
        val bench = Bench()
        bench.onPassword(firstFactor("email_code", "passkey"))
        assertEquals(TulaAuthScreen.EmailCodeOffer, bench.screen)
        assertEquals(listOf(SIGN_INS), bench.engine.paths())
        bench.engine.post("$SIGN_IN/first-factor/prepare") {
            ok(attemptJson(firstFactor("email_code", "passkey", prepared = true)))
        }
        bench.tap(SEND_EMAIL_CODE)
        assertEquals(TulaAuthScreen.EmailCode(MASKED, canUsePassword = false), bench.screen)
    }

    @Test
    fun `a step that was already prepared is the code screen`() = runTest {
        val bench = Bench()
        bench.onPassword(firstFactor("password", "email_code", prepared = true))
        assertEquals(TulaAuthScreen.EmailCode(MASKED, canUsePassword = true), bench.screen)
    }

    @Test
    fun `a sign-up proves its address with the emailed code`() = runTest {
        val bench = Bench(TulaAuthMode.SIGN_UP)
        assertEquals(TulaAuthScreen.SignUpStart, bench.screen)
        bench.engine.post(SIGN_UPS) { ok(attemptJson(VERIFICATION, "sign_up")) }
        bench.type(PASSWORD, "a-password-nobody-uses")
        bench.begin()
        assertEquals(TulaAuthScreen.EmailVerification(MASKED), bench.screen)
        assertEquals(
            """{"email":"$ADDRESS","password":"a-password-nobody-uses"}""",
            bench.engine.sent(SIGN_UPS).single().body,
        )
        bench.engine.post("$SIGN_UP/resend-code") { ok(attemptJson(VERIFICATION, "sign_up")) }
        bench.tap(RESEND_CODE)
        assertEquals(bench.model.strings.resent, bench.state.status)
        assertEquals(bench.model.strings.resent, bench.said.last())
        bench.engine.post("$SIGN_UP/verify-email") { completed("sign_up") }
        bench.type(CODE, "123456")
        bench.tap(SUBMIT_CODE)
        assertEquals(TulaAuthScreen.SignedIn, bench.screen)
        assertEquals("""{"code":"123456"}""", bench.engine.sent("$SIGN_UP/verify-email").single().body)
    }

    @Test
    fun `a sign-in of an unproven address asks for the emailed code`() = runTest {
        val bench = Bench()
        bench.onPassword()
        bench.engine.post("$SIGN_IN/password") { ok(attemptJson(VERIFICATION)) }
        bench.type(PASSWORD, "a-password-nobody-uses")
        bench.tap(SUBMIT_PASSWORD)
        assertEquals(TulaAuthScreen.EmailVerification(MASKED), bench.screen)
        bench.engine.post("$SIGN_IN/resend-code") { ok(attemptJson(VERIFICATION)) }
        bench.tap(RESEND_CODE)
        assertEquals(bench.model.strings.resent, bench.state.status)
        bench.engine.post("$SIGN_IN/verify-email") { completed() }
        bench.type(CODE, "123456")
        bench.tap(SUBMIT_CODE)
        assertEquals(TulaAuthScreen.SignedIn, bench.screen)
    }

    @Test
    fun `a reset asks for the code and the new password together`() = runTest {
        val bench = Bench()
        bench.type(EMAIL, ADDRESS)
        bench.model.showReset()
        assertEquals(TulaAuthScreen.ResetStart, bench.screen)
        assertEquals(ADDRESS, bench.state.email, "the address typed for the sign-in is carried over")
        bench.engine.post(RESETS) { ok(attemptJson(RESET_STEP, "password_reset")) }
        bench.tap(START)
        assertEquals(TulaAuthScreen.NewPassword(MASKED), bench.screen)
        bench.tap(SUBMIT_NEW_PASSWORD)
        assertEquals(listOf(bench.model.strings.codeIncomplete), bench.state.fieldErrors[CODE])
        assertEquals(listOf(bench.model.strings.required), bench.state.fieldErrors[NEW_PASSWORD])
        assertEquals(TulaAuthFocus.Field(CODE), bench.state.focus)
        bench.engine.post("$RESET/resend-code") { ok(attemptJson(RESET_STEP, "password_reset")) }
        bench.tap(RESEND_CODE)
        assertEquals(bench.model.strings.resent, bench.state.status)
        bench.engine.post("$RESET/password") { completed("password_reset") }
        bench.type(CODE, "123456")
        bench.type(NEW_PASSWORD, "another-password-nobody-uses")
        bench.tap(SUBMIT_NEW_PASSWORD)
        assertEquals(TulaAuthScreen.SignedIn, bench.screen)
        assertEquals(
            """{"code":"123456","password":"another-password-nobody-uses"}""",
            bench.engine.sent("$RESET/password").single().body,
        )
    }

    @Test
    fun `an expired password is replaced as the last step of the sign-in`() = runTest {
        val bench = Bench()
        bench.onPassword()
        bench.engine.post("$SIGN_IN/password") { ok(attemptJson(EXPIRED)) }
        bench.type(PASSWORD, "an-old-password")
        bench.tap(SUBMIT_PASSWORD)
        assertEquals(TulaAuthScreen.ExpiredPassword, bench.screen)
        bench.tap(SUBMIT_NEW_PASSWORD)
        assertEquals(listOf(bench.model.strings.required), bench.state.fieldErrors[NEW_PASSWORD])
        bench.engine.post("$SIGN_IN/new-password") { completed() }
        bench.type(NEW_PASSWORD, "another-password-nobody-uses")
        bench.tap(SUBMIT_NEW_PASSWORD)
        assertEquals(TulaAuthScreen.SignedIn, bench.screen)
        assertEquals(
            """{"password":"another-password-nobody-uses"}""",
            bench.engine.sent("$SIGN_IN/new-password").single().body,
        )
    }

    @Test
    fun `a step with no screen is not supported and never blank`() = runTest {
        val steps = mapOf(
            // The client has no action for either, and neither have the screens.
            SECOND_FACTOR to "needs_second_factor",
            """{"status":"needs_something_newer","with":"fields"}""" to "needs_something_newer",
            // Ways the client cannot prove.
            firstFactor("passkey", "email_link") to "needs_first_factor",
            // A texted code has a call in the client and no screen here yet.
            firstFactor("sms_code") to "needs_first_factor",
            // A reason for a new password this version does not know.
            """{"status":"needs_new_password","destination":"$MASKED","strategies":["email_code"],"reason":"newer"}""" to
                "needs_new_password",
        )
        for ((step, status) in steps) {
            val bench = Bench()
            bench.onPassword(step)
            assertEquals(TulaAuthScreen.NotSupported(status), bench.screen, step)
            val content = bench.model.content
            assertEquals(bench.model.strings.notSupportedTitle, content.title)
            assertEquals(bench.model.strings.notSupportedMessage, content.subtitle)
            assertEquals(setOf(START_AGAIN), content.actions)
            // Nothing is sent from there on a guess, whatever is asked.
            for (action in TulaAuthAction.entries - START_AGAIN) {
                bench.tap(action)
            }
            assertEquals(listOf(SIGN_INS), bench.engine.paths(), step)
            bench.tap(START_AGAIN)
            assertEquals(TulaAuthScreen.SignInStart, bench.screen)
        }
    }

    @Test
    fun `start again goes to the start of the flow that was open`() = runTest {
        val bench = Bench()
        bench.tap(SHOW_SIGN_UP)
        bench.engine.post(SIGN_UPS) { ok(attemptJson(VERIFICATION, "sign_up")) }
        bench.type(PASSWORD, "a-password-nobody-uses")
        bench.begin()
        bench.tap(START_AGAIN)
        assertEquals(TulaAuthScreen.SignUpStart, bench.screen)
        assertEquals(ADDRESS, bench.state.email)
        bench.model.startAgain()
        assertEquals(TulaAuthScreen.SignUpStart, bench.screen)
    }

    @Test
    fun `a sign-in password is emptied as it is sent, right or wrong`() = runTest {
        val bench = Bench()
        bench.onPassword()
        bench.engine.post("$SIGN_IN/password") { refused("auth.invalid_credentials", 401) }
        bench.type(PASSWORD, "a-wrong-password")
        bench.tap(SUBMIT_PASSWORD)
        assertEquals("", bench.state.password)
        assertEquals(TulaAuthScreen.Password(canEmailCode = false), bench.screen)
        assertEquals(1, bench.state.fieldErrors[PASSWORD]?.size)
        assertEquals(TulaAuthFocus.Field(PASSWORD), bench.state.focus)
        bench.engine.post("$SIGN_IN/password") { completed() }
        bench.type(PASSWORD, "the-right-password")
        bench.tap(SUBMIT_PASSWORD)
        assertEquals("", bench.state.password)
    }

    @Test
    fun `every change of screen empties the password, the code and the new password`() = runTest {
        val bench = Bench()
        bench.onPassword(firstFactor("password", "email_code"))
        bench.type(PASSWORD, "half-typed")
        bench.model.toggleReveal(PASSWORD)
        bench.engine.post("$SIGN_IN/first-factor/prepare") {
            ok(attemptJson(firstFactor("password", "email_code", prepared = true)))
        }
        bench.tap(SEND_EMAIL_CODE)
        assertEquals("", bench.state.password)
        assertEquals(emptySet(), bench.state.revealed)
        bench.type(CODE, "1234")
        bench.tap(USE_PASSWORD)
        assertEquals("", bench.state.code)
        bench.type(PASSWORD, "half-typed-again")
        bench.tap(SHOW_RESET)
        assertEquals("", bench.state.password)
        assertEquals(ADDRESS, bench.state.email)
        bench.engine.post(RESETS) { ok(attemptJson(RESET_STEP, "password_reset")) }
        bench.tap(START)
        bench.type(CODE, "123456")
        bench.type(NEW_PASSWORD, "half-chosen")
        bench.tap(TulaAuthAction.SHOW_SIGN_IN)
        assertEquals(listOf("", "", ""), listOf(bench.state.password, bench.state.code, bench.state.newPassword))
    }

    @Test
    fun `the model prints as its name and nothing it holds`() = runTest {
        val bench = Bench()
        bench.onPassword()
        bench.type(PASSWORD, "canary-password")
        for (printed in listOf("${bench.model}", "${bench.state}", "${bench.model.state.value}")) {
            assertFalse(printed.contains("canary-password"), printed)
            assertFalse(printed.contains(ADDRESS), printed)
        }
        assertEquals("TulaAuthModel", bench.model.toString())
        assertEquals("TulaAuthState", bench.state.toString())
    }

    @Test
    fun `a code field keeps six ASCII digits`() {
        assertEquals("123456", TulaAuthModel.digits("12 34-56 78"))
        assertEquals("", TulaAuthModel.digits("abc"))
        assertEquals("12", TulaAuthModel.digits("１２12"), "full-width digits are not a code's")
        val bench = Bench()
        bench.type(CODE, "a1b2c3d4e5f6g7")
        assertEquals("123456", bench.state.code)
        assertEquals("123456", bench.state.text(CODE))
    }

    @Test
    fun `an answer that arrives after the screen was left signs nobody in`() = runTest {
        val bench = Bench()
        bench.onPassword()
        val gate = Gate()
        bench.engine.post("$SIGN_IN/password") {
            gate.pass()
            completed()
        }
        bench.type(PASSWORD, "a-password-nobody-uses")
        val sending = launch(Dispatchers.Default) { bench.tap(SUBMIT_PASSWORD) }
        gate.reached()
        assertTrue(bench.state.isPending)
        bench.model.close()
        gate.open()
        sending.join()
        assertEquals(TulaAuthScreen.SignInStart, bench.screen)
        assertEquals(0, bench.signedIn.get())
        assertFalse(bench.client.state.value is AuthState.SignedIn)
        assertNull(bench.state.formError)
        assertFalse(bench.state.isPending)
    }

    @Test
    fun `a start that answers after the screen closed is discarded`() = runTest {
        val bench = Bench()
        val gate = Gate()
        bench.engine.post(SIGN_INS) {
            gate.pass()
            ok(attemptJson(NEEDS_PASSWORD))
        }
        bench.type(EMAIL, ADDRESS)
        val sending = launch(Dispatchers.Default) { bench.tap(START) }
        gate.reached()
        bench.model.close()
        gate.open()
        sending.join()
        assertEquals(TulaAuthScreen.SignInStart, bench.screen)
        assertEquals("", bench.state.email)
        assertFalse(bench.state.isPending)
        // Nothing is left that a password could be sent on.
        bench.tap(SUBMIT_PASSWORD)
        assertEquals(listOf(SIGN_INS), bench.engine.paths())
    }

    @Test
    fun `a failure that arrives after the screen was left is not shown`() = runTest {
        val bench = Bench()
        bench.onPassword()
        val gate = Gate()
        bench.engine.post("$SIGN_IN/password") {
            gate.pass()
            refused("auth.invalid_credentials", 401)
        }
        bench.type(PASSWORD, "a-wrong-password")
        val sending = launch(Dispatchers.Default) { bench.tap(SUBMIT_PASSWORD) }
        gate.reached()
        bench.tap(SHOW_RESET)
        gate.open()
        sending.join()
        assertEquals(TulaAuthScreen.ResetStart, bench.screen)
        assertNull(bench.state.formError)
        assertEquals(emptyMap(), bench.state.fieldErrors)
        assertEquals(emptyList(), bench.said.toList())
    }

    @Test
    fun `leaving discards the attempt`() = runTest {
        val bench = Bench()
        bench.onPassword()
        bench.tap(SHOW_RESET)
        bench.tap(TulaAuthAction.SHOW_SIGN_IN)
        // The password step is gone with its flow: no request can be made on it.
        bench.model.submitPassword()
        assertEquals(listOf(SIGN_INS), bench.engine.paths())
        assertEquals(TulaAuthScreen.SignInStart, bench.screen)
    }

    @Test
    fun `one action at a time`() = runTest {
        val bench = Bench()
        bench.onPassword(firstFactor("password", "email_code"))
        val gate = Gate()
        bench.engine.post("$SIGN_IN/password") {
            gate.pass()
            refused("auth.invalid_credentials", 401)
        }
        bench.type(PASSWORD, "a-password-nobody-uses")
        val sending = launch(Dispatchers.Default) { bench.tap(SUBMIT_PASSWORD) }
        gate.reached()
        assertTrue(bench.state.isPending)
        bench.type(PASSWORD, "typed-meanwhile")
        bench.tap(SUBMIT_PASSWORD)
        bench.tap(SEND_EMAIL_CODE)
        assertEquals(listOf(SIGN_INS, "$SIGN_IN/password"), bench.engine.paths())
        assertEquals("typed-meanwhile", bench.state.password, "a tap that was not taken empties nothing")
        gate.open()
        sending.join()
        assertFalse(bench.state.isPending)
    }

    @Test
    fun `an empty field is said at the field without a request`() = runTest {
        val bench = Bench(TulaAuthMode.SIGN_UP)
        bench.tap(START)
        val required = bench.model.strings.required
        assertEquals(mapOf(EMAIL to listOf(required), PASSWORD to listOf(required)), bench.state.fieldErrors)
        assertEquals(TulaAuthFocus.Field(EMAIL), bench.state.focus)
        assertEquals(listOf(required), bench.said.toList())
        assertEquals(emptyList(), bench.engine.paths())
        val signIn = Bench()
        signIn.onPassword()
        signIn.tap(SUBMIT_PASSWORD)
        assertEquals(listOf(required), signIn.state.fieldErrors[PASSWORD])
        assertEquals(listOf(SIGN_INS), signIn.engine.paths())
    }

    @Test
    fun `a refused password is said at the password in the contract's words`() = runTest {
        val bench = Bench()
        bench.onPassword()
        bench.engine.post("$SIGN_IN/password") { refused("auth.invalid_credentials", 401) }
        bench.type(PASSWORD, "a-wrong-password")
        bench.tap(SUBMIT_PASSWORD)
        assertEquals(listOf("The email or password is incorrect."), bench.state.fieldErrors[PASSWORD])
        assertNull(bench.state.formError)
        assertEquals("The email or password is incorrect.", bench.said.last())
        assertFalse(bench.everythingSaid().contains(SERVER_WORDS))
    }

    @Test
    fun `a code this version does not know is said with the fallback, never the server's words`() = runTest {
        val bench = Bench()
        bench.engine.post(SIGN_INS) {
            refused(
                "brand.new_code",
                extra = ""","errors":[{"field":"identifier","code":"brand.new_field","message":"$SERVER_WORDS"}]""",
            )
        }
        bench.begin()
        assertEquals(listOf(bench.model.strings.unknownError), bench.state.fieldErrors[EMAIL])
        assertFalse(bench.everythingSaid().contains(SERVER_WORDS))
        assertFalse(bench.model.problems(EMAIL).joinToString().contains(SERVER_WORDS))
        bench.engine.post(SIGN_INS) { refused("brand.new_code") }
        bench.tap(START)
        assertEquals(bench.model.strings.unknownError, bench.state.formError)
        assertFalse(bench.everythingSaid().contains(SERVER_WORDS))
    }

    @Test
    fun `an answer that is no answer is said by the client's code`() = runTest {
        val bench = Bench()
        bench.engine.post(SIGN_INS) { ok("<html>a proxy's page</html>") }
        bench.begin()
        assertEquals("The server sent a response this app could not read.", bench.state.formError)
        assertEquals(TulaAuthScreen.SignInStart, bench.screen)
    }

    @Test
    fun `each refused rule is said under its field`() = runTest {
        val bench = Bench(TulaAuthMode.SIGN_UP)
        bench.engine.post(SIGN_UPS) {
            refused(
                "password.too_short",
                422,
                ""","errors":[{"field":"password","code":"password.too_short","message":"$SERVER_WORDS","params":{"min":10}},""" +
                    """{"field":"password","code":"password.common","message":"$SERVER_WORDS"},""" +
                    """{"field":"password","code":"password.common","message":"$SERVER_WORDS"},""" +
                    """{"field":"email","code":"validation.failed","message":"$SERVER_WORDS"}]""",
            )
        }
        bench.type(PASSWORD, "short")
        bench.begin()
        val password = bench.state.fieldErrors[PASSWORD].orEmpty()
        assertEquals(2, password.size, "a rule is said once")
        assertEquals("Password is too short.", password.first())
        assertEquals(1, bench.state.fieldErrors[EMAIL]?.size)
        assertEquals(TulaAuthFocus.Field(EMAIL), bench.state.focus, "the first field with a problem")
        assertFalse(bench.everythingSaid().contains(SERVER_WORDS))
        assertEquals("short", bench.state.password)
    }

    @Test
    fun `a problem of a field the screen does not have is said above the form`() = runTest {
        val bench = Bench()
        bench.engine.post(SIGN_INS) {
            refused(
                "validation.failed",
                422,
                ""","errors":[{"field":"somethingElse","code":"validation.failed","message":"$SERVER_WORDS"}]""",
            )
        }
        bench.begin()
        assertEquals(emptyMap(), bench.state.fieldErrors)
        assertTrue(bench.state.formError.orEmpty().isNotEmpty())
        assertEquals(bench.state.formError, bench.said.last())
        // A password's problem on a screen with no password field goes above the form too.
        bench.engine.post(SIGN_INS) { refused("password.too_short", 422) }
        bench.tap(START)
        assertEquals(emptyMap(), bench.state.fieldErrors)
        assertTrue(bench.state.formError.orEmpty().isNotEmpty())
    }

    @Test
    fun `a wrong code is said at the code`() = runTest {
        val bench = Bench()
        bench.onPassword(firstFactor("email_code", prepared = true))
        bench.engine.post("$SIGN_IN/first-factor/attempt") { refused("verification.invalid_code") }
        bench.tap(SUBMIT_CODE)
        assertEquals(listOf(bench.model.strings.codeIncomplete), bench.state.fieldErrors[CODE])
        assertEquals(listOf(SIGN_INS), bench.engine.paths(), "an incomplete code is not sent")
        bench.type(CODE, "123456")
        bench.tap(SUBMIT_CODE)
        assertEquals(1, bench.state.fieldErrors[CODE]?.size)
        assertEquals(TulaAuthFocus.Field(CODE), bench.state.focus)
        assertEquals("", bench.state.code)
        bench.engine.post("$SIGN_IN/first-factor/prepare") { ok(attemptJson(firstFactor("email_code", prepared = true))) }
        bench.tap(RESEND_CODE)
        assertEquals(bench.model.strings.emailResent, bench.state.status)
        assertEquals(emptyMap(), bench.state.fieldErrors)
    }

    @Test
    fun `a wait the server asks for is said in words`() = runTest {
        val bench = Bench()
        bench.engine.post(SIGN_INS) { refused("rate_limited", 429, headers = mapOf("retry-after" to "42")) }
        bench.begin()
        assertTrue(bench.state.formError.orEmpty().endsWith(" Try again in 42s."), bench.state.formError)
    }

    @Test
    fun `a message of the app's own table is used`() = runTest {
        val strings = TulaStrings(errors = mapOf("auth.invalid_credentials" to "That did not match."))
        val bench = Bench(strings = strings)
        bench.onPassword()
        bench.engine.post("$SIGN_IN/password") { refused("auth.invalid_credentials", 401) }
        bench.type(PASSWORD, "a-wrong-password")
        bench.tap(SUBMIT_PASSWORD)
        assertEquals(listOf("That did not match."), bench.state.fieldErrors[PASSWORD])
        // A table handed over later words what is said from then on.
        bench.model.strings = TulaStrings(required = "Needed.")
        bench.tap(SUBMIT_PASSWORD)
        assertEquals(listOf("Needed."), bench.state.fieldErrors[PASSWORD])
    }

    @Test
    fun `every change of screen asks for the focus on the title`() = runTest {
        val bench = Bench()
        assertEquals(TulaAuthFocus.Title, bench.state.focus)
        val before = bench.state.focusRequests
        bench.onPassword()
        assertEquals(TulaAuthFocus.Title, bench.state.focus)
        assertEquals(before + 1, bench.state.focusRequests)
        bench.tap(SUBMIT_PASSWORD)
        assertEquals(TulaAuthFocus.Field(PASSWORD), bench.state.focus)
        assertEquals(before + 2, bench.state.focusRequests)
        bench.tap(SHOW_RESET)
        assertEquals(TulaAuthFocus.Title, bench.state.focus)
        assertEquals(before + 3, bench.state.focusRequests)
    }

    @Test
    fun `the app's name and an optional password come from the environment`() = runTest {
        val bench = Bench(TulaAuthMode.SIGN_UP)
        bench.engine.on("GET", CONFIG) { ok(configJson(name = "Acme", password = "optional")) }
        bench.model.loadConfig()
        assertEquals("Acme", bench.state.appName)
        assertTrue(bench.state.passwordOptional)
        // A sign-up may then leave the password out, and none is sent.
        bench.engine.post(SIGN_UPS) { ok(attemptJson(VERIFICATION, "sign_up")) }
        bench.begin()
        assertEquals("""{"email":"$ADDRESS"}""", bench.engine.sent(SIGN_UPS).single().body)
        val nameless = Bench()
        nameless.engine.on("GET", CONFIG) { ok(configJson(name = "")) }
        nameless.model.loadConfig()
        assertNull(nameless.state.appName)
        assertFalse(nameless.state.passwordOptional)
    }

    @Test
    fun `an environment that cannot be read changes nothing`() = runTest {
        val bench = Bench()
        bench.engine.on("GET", CONFIG) { refused("internal", 500) }
        bench.model.loadConfig()
        assertNull(bench.state.appName)
        assertFalse(bench.state.passwordOptional)
        assertNull(bench.state.formError)
        assertEquals(emptyList(), bench.said.toList())
    }

    @Test
    fun `the fields of every screen`() {
        val fields = mapOf(
            TulaAuthScreen.SignInStart to listOf(EMAIL),
            TulaAuthScreen.SignUpStart to listOf(EMAIL, PASSWORD),
            TulaAuthScreen.ResetStart to listOf(EMAIL),
            TulaAuthScreen.Password(true) to listOf(PASSWORD),
            TulaAuthScreen.EmailCodeOffer to emptyList(),
            TulaAuthScreen.EmailCode(MASKED, false) to listOf(CODE),
            TulaAuthScreen.EmailVerification(MASKED) to listOf(CODE),
            TulaAuthScreen.NewPassword(MASKED) to listOf(CODE, NEW_PASSWORD),
            TulaAuthScreen.ExpiredPassword to listOf(NEW_PASSWORD),
            TulaAuthScreen.SignedIn to emptyList(),
            TulaAuthScreen.NotSupported("x") to emptyList(),
        )
        for ((screen, expected) in fields) {
            assertEquals(expected, screen.fields, "$screen")
            // What is drawn is what the screen says it has, in that order.
            assertEquals(expected, TulaAuthContent.of(screen, TulaStrings()).fields.map { it.field }, "$screen")
        }
        val state = TulaAuthState(TulaAuthScreen.SignInStart, email = "a", password = "b", code = "c", newPassword = "d")
        assertEquals(listOf("a", "b", "c", "d"), TulaAuthField.entries.map(state::text))
    }
}
