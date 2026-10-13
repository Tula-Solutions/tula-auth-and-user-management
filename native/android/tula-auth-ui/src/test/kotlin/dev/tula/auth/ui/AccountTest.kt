package dev.tula.auth.ui

import dev.tula.auth.AuthState
import dev.tula.auth.HttpResponse
import dev.tula.auth.SheetFailure
import dev.tula.auth.ui.TulaAccountAction as A
import dev.tula.auth.ui.TulaAccountPanel as P
import kotlinx.coroutines.launch
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

private typealias F = TulaAccountField

/** The account screen's model: what it reads, what it offers, and what each refusal comes to. */
class AccountTest {
    private val words = TulaStrings()
    private val a = words.account
    private val two = words.secondStep

    private fun AccountBench.offered(action: A) = action in content.actions

    // Reading

    @Test
    fun `the account is read into sections, and a session is marked in words`() = runTest {
        val bench = AccountBench().loaded()
        assertEquals(P.Overview, bench.panel)
        assertEquals(
            listOf(
                "tula.account.profile", "tula.account.password", "tula.account.phone",
                "tula.account.sessions", "tula.account.factors", "tula.account.passkeys",
            ),
            bench.content.sections.map { it.identifier },
        )
        assertEquals(listOf("Maya", ADDRESS, a.emailVerified), bench.lines("tula.account.profile"))
        val rows = bench.section("tula.account.sessions").rows
        // This device first, marked in exactly these words.
        assertEquals(listOf(a.clientAndroid, a.clientWeb), rows.map { it.title })
        assertEquals(listOf("This device", "Bound to a device key"), rows[0].marks)
        assertEquals(emptyList(), rows[1].marks)
        assertNull(rows[0].offer)
        assertEquals(A.RevokeSession("s-2"), rows[1].offer?.action)
        assertEquals("Sign out Web browser", rows[1].offer?.label)
        assertEquals(listOf("Signed in 2026-01-01", "Last active 2026-01-02"), rows[0].details)
        // Of a session only its kind and its times are drawn: never the user agent or the address.
        val said = bench.everythingSaid()
        assertFalse("canary-user-agent" in said)
        assertFalse("203.0.113.9" in said)
        for (word in listOf("trusted", "verified device", "device verification")) {
            assertFalse(word in said.lowercase(), word)
        }
    }

    @Test
    fun `a section that could not be read says so and is read again by itself`() = runTest {
        val bench = AccountBench().loaded { engine.on("GET", FACTORS) { refused("internal", 500) } }
        assertEquals(setOf(TulaAccountSectionId.FACTORS), bench.state.failed)
        assertEquals(listOf(a.sectionFailed), bench.lines("tula.account.factors"))
        // The other sections are drawn.
        assertEquals(2, bench.section("tula.account.sessions").rows.size)
        bench.engine.on("GET", FACTORS) { ok(factorsJson()) }
        bench.tap(A.Reload(TulaAccountSectionId.FACTORS))
        assertEquals(emptySet(), bench.state.failed)
        assertEquals(listOf(a.mfaOff), bench.lines("tula.account.factors"))
        assertFalse(SERVER_WORDS in bench.everythingSaid())
    }

    @Test
    fun `a section is loading until it was read, and a time that is no time is left out`() = runTest {
        val bench = AccountBench()
        bench.signIn()
        assertTrue(bench.content.sections.all { it.loading })
        bench.engine.on("GET", PASSKEYS) { ok("""{"passkeys":[${passkeyJson().replace("2026-01-05T00:00:00.000Z", "soon")}]}""") }
        bench.model.load()
        assertFalse(bench.content.sections.any { it.loading })
        assertEquals(listOf(a.passkeySynced, a.passkeyNeverUsed), bench.section("tula.account.passkeys").rows.single().details)
    }

    @Test
    fun `the default date reads a time of the API and refuses anything else`() {
        assertNotNull(TulaAccountContent.defaultDate("2026-01-01T00:00:00.000Z"))
        assertNull(TulaAccountContent.defaultDate("soon"))
    }

    @Test
    fun `an action that is not offered does nothing`() = runTest {
        val bench = AccountBench().loaded()
        val before = bench.engine.requests.size
        for (action in listOf(A.ConfirmTotp, A.Confirmed, A.SubmitStepUp, A.VerifyPhone, A.CopyCodes, A.RevokeSession("session-1"))) {
            bench.tap(action)
        }
        assertEquals(before, bench.engine.requests.size)
        assertEquals(P.Overview, bench.panel)
    }

    @Test
    fun `nothing the account holds is printed`() = runTest {
        val bench = AccountBench().loaded()
        assertEquals("TulaAccountState", bench.state.toString())
        assertEquals("TulaAccountModel", bench.model.toString())
        assertEquals("TulaAccountContent", bench.content.toString())
    }

    // Sessions and sign-out

    @Test
    fun `one session and every other session are signed out with no proof asked`() = runTest {
        val bench = AccountBench().loaded()
        bench.engine.on("DELETE", "$SESSIONS/s-2") { NO_CONTENT }
        bench.engine.on("GET", SESSIONS) { ok("""{"data":[${sessionJson("session-1", current = true)}]}""") }
        bench.tap(A.RevokeSession("s-2"))
        assertEquals(a.deviceSignedOut, bench.state.status)
        assertEquals(1, bench.section("tula.account.sessions").rows.size)
        // With no other session there is nothing to sign out of.
        assertFalse(bench.offered(A.RevokeOthers))

        val many = AccountBench().loaded()
        many.engine.post("$SESSIONS/revoke-others") { ok("""{"revoked":3}""") }
        many.tap(A.RevokeOthers)
        assertEquals("Signed out of 3 other devices.", many.state.status)
        many.engine.post("$SESSIONS/revoke-others") { ok("""{"revoked":1}""") }
        many.tap(A.RevokeOthers)
        assertEquals(a.othersSignedOutOne, many.state.status)
        assertEquals(0, many.count("POST", STEP_UP))
    }

    @Test
    fun `a sign-out the server was told of empties the screen and tells the app once`() = runTest {
        val bench = AccountBench().loaded()
        bench.engine.post(SIGN_OUT) { NO_CONTENT }
        bench.tap(A.SignOut)
        assertTrue(bench.state.signedOut)
        assertEquals(1, bench.signedOut.get())
        assertNull(bench.state.user)
        assertEquals(emptySet(), bench.content.actions)
        assertEquals(emptyList(), bench.content.sections)
    }

    @Test
    fun `a failed sign-out is not a sign-out, is said so, and can be tried again`() = runTest {
        val bench = AccountBench().loaded()
        bench.engine.post(SIGN_OUT) { refused("internal", 500) }
        bench.tap(A.SignOut)
        assertTrue(bench.state.signOutFailed)
        assertFalse(bench.state.signedOut)
        // The app is not told: the session may still be active on the server.
        assertEquals(0, bench.signedOut.get())
        assertEquals(a.signOutFailed, bench.state.formError)
        assertEquals(a.signOutFailed, bench.said.last())
        // Nothing of the account is drawn, and signing out is the one thing offered.
        assertNull(bench.state.user)
        assertEquals(emptyList(), bench.content.sections)
        assertEquals(setOf<A>(A.SignOut), bench.content.actions)
        assertFalse(SERVER_WORDS in bench.everythingSaid())

        bench.engine.post(SIGN_OUT) { NO_CONTENT }
        bench.tap(A.SignOut)
        assertTrue(bench.state.signedOut)
        assertFalse(bench.state.signOutFailed)
        assertEquals(1, bench.signedOut.get())
        assertIs<AuthState.SignedOut>(bench.client.state.value)
    }

    // The authenticator app

    @Test
    fun `an authenticator is set up, and its key and codes are held only while their form is open`() = runTest {
        val bench = AccountBench().loaded()
        bench.engine.post("$FACTORS/totp") { ok("""{"secret":"SETUPKEY234","uri":"otpauth://totp/Tula:maya?secret=SETUPKEY234"}""") }
        bench.tap(A.TurnOnTotp)
        assertEquals(P.TotpSetup, bench.panel)
        assertEquals("SETUPKEY234", bench.content.setup?.key)
        assertEquals("otpauth://totp/Tula:maya?secret=SETUPKEY234", bench.content.setup?.uri)
        // Nothing is copied until a person asks.
        assertEquals(emptyList(), bench.copied.toList())
        bench.tap(A.CopySetupKey)
        assertEquals(listOf("SETUPKEY234"), bench.copied.toList())
        assertEquals(two.copied, bench.state.status)

        // A code that is not whole is not sent.
        bench.type(F.CODE, "12 34")
        bench.tap(A.ConfirmTotp)
        assertEquals(listOf("Error: ${words.codeIncomplete}"), bench.model.problems(F.CODE))
        assertEquals(TulaAccountFocus.Field(F.CODE), bench.state.focus)
        assertEquals(0, bench.count("POST", "$FACTORS/totp/confirm"))

        // A wrong code is said at its field and emptied; the key stays to be tried again.
        bench.engine.post("$FACTORS/totp/confirm") { refused("mfa.invalid_code", 400) }
        bench.type(F.CODE, "000000")
        bench.tap(A.ConfirmTotp)
        assertEquals(listOf(two.codeWrong), bench.state.fieldErrors[F.CODE])
        assertEquals("", bench.state.text[F.CODE].orEmpty())
        assertEquals(P.TotpSetup, bench.panel)
        assertNotNull(bench.state.setup)

        bench.engine.post("$FACTORS/totp/confirm") { ok("""{"codes":["aaaaa-bbbbb","ccccc-ddddd"]}""") }
        bench.engine.on("GET", FACTORS) { ok(factorsJson(totp = true, remaining = 2)) }
        bench.type(F.CODE, "123456")
        bench.tap(A.ConfirmTotp)
        assertEquals(P.BackupCodes, bench.panel)
        // The key went with its form.
        assertNull(bench.state.setup)
        assertNull(bench.content.setup)
        assertEquals(listOf("aaaaa-bbbbb", "ccccc-ddddd"), bench.content.codes?.codes)
        // The codes are left only by saying they were saved: there is no cancel.
        assertFalse(bench.offered(A.Cancel))
        bench.tap(A.CopyCodes)
        assertEquals("aaaaa-bbbbb\nccccc-ddddd", bench.copied.last())
        bench.tap(A.SavedCodes)
        assertEquals(P.Overview, bench.panel)
        assertEquals(emptyList(), bench.state.backupCodes)
        assertNull(bench.content.codes)
        assertEquals(listOf("On since 2026-01-03.", "2 backup codes left."), bench.lines("tula.account.factors"))
    }

    @Test
    fun `leaving the setup and closing the screen forget the key`() = runTest {
        val bench = AccountBench().loaded()
        bench.engine.post("$FACTORS/totp") { ok("""{"secret":"SETUPKEY234","uri":"otpauth://totp/x?secret=SETUPKEY234"}""") }
        bench.tap(A.TurnOnTotp)
        bench.type(F.CODE, "123")
        bench.tap(A.Cancel)
        assertEquals(P.Overview, bench.panel)
        assertNull(bench.state.setup)
        assertEquals(emptyMap(), bench.state.text)
        assertEquals(a.nothingChanged, bench.state.notice)

        bench.tap(A.TurnOnTotp)
        assertNotNull(bench.state.setup)
        bench.model.close()
        assertNull(bench.state.setup)
        assertEquals(P.Overview, bench.panel)
    }

    @Test
    fun `backup codes are made again, and an app that requires the second step cannot turn it off`() = runTest {
        val bench = AccountBench().loaded { engine.on("GET", FACTORS) { ok(factorsJson(totp = true, remaining = 1)) } }
        assertEquals(listOf("On since 2026-01-03.", a.codesRemainingOne), bench.lines("tula.account.factors"))
        bench.engine.post("$FACTORS/backup-codes") { ok("""{"codes":["eeeee-fffff"]}""") }
        bench.tap(A.RegenerateCodes)
        assertEquals(P.BackupCodes, bench.panel)
        assertEquals(a.regenerated, bench.state.status)
        bench.tap(A.SavedCodes)

        // Turning it off is asked about first.
        bench.tap(A.Ask(TulaAccountConfirm.TurnOffTotp))
        assertEquals(P.Confirm(TulaAccountConfirm.TurnOffTotp), bench.panel)
        assertEquals(a.turnOffConfirm, bench.content.subtitle)
        assertTrue(bench.content.primary!!.destructive)
        bench.engine.on("DELETE", "$FACTORS/totp") { NO_CONTENT }
        bench.engine.on("GET", FACTORS) { ok(factorsJson()) }
        bench.tap(A.Confirmed)
        assertEquals(P.Overview, bench.panel)
        assertEquals(a.turnedOff, bench.state.status)
        assertEquals(listOf(a.mfaOff), bench.lines("tula.account.factors"))

        val required = AccountBench().loaded {
            engine.on("GET", FACTORS) { ok(factorsJson(totp = true, remaining = 8)) }
            engine.on("GET", CONFIG) { ok(configJson(policy = "required")) }
        }
        assertTrue(a.requiredByApp in required.lines("tula.account.factors"))
        assertFalse(required.offered(A.Ask(TulaAccountConfirm.TurnOffTotp)))
        assertTrue(required.offered(A.RegenerateCodes))
    }

    // Step-up

    private suspend fun AccountBench.needsProof(vararg methods: String) {
        engine.post("$FACTORS/totp") { stepUpRequired(*methods) }
        tap(A.TurnOnTotp)
    }

    private fun AccountBench.thenAllowed() {
        engine.post("$FACTORS/totp") { ok("""{"secret":"SETUPKEY234","uri":"otpauth://totp/x?secret=SETUPKEY234"}""") }
    }

    @Test
    fun `a call that needs a proof opens the ways the server named, and is made again once one is proven`() = runTest {
        val bench = AccountBench().loaded()
        bench.needsProof("password", "totp", "backup_code", "retina")
        // The server's order, without what this version does not know.
        assertEquals(P.StepUp(TulaStepUpMethod.PASSWORD, listOf(TulaStepUpMethod.TOTP, TulaStepUpMethod.BACKUP_CODE)), bench.panel)
        assertEquals(a.stepUpTitle, bench.content.title)
        assertEquals(TulaAccountFocus.Title, bench.state.focus)

        // Nothing typed: nothing sent.
        bench.tap(A.SubmitStepUp)
        assertEquals(listOf(words.required), bench.state.fieldErrors[F.STEP_UP_PASSWORD])
        assertEquals(0, bench.count("POST", STEP_UP))

        // A wrong password is said at its field, in the screen's words.
        bench.engine.post(STEP_UP) { refused("auth.invalid_credentials", 401) }
        bench.type(F.STEP_UP_PASSWORD, "wrong")
        bench.tap(A.SubmitStepUp)
        assertEquals(listOf(a.passwordWrong), bench.state.fieldErrors[F.STEP_UP_PASSWORD])
        assertEquals(TulaAccountFocus.Field(F.STEP_UP_PASSWORD), bench.state.focus)
        // The password was emptied as it was sent.
        assertEquals("", bench.state.text[F.STEP_UP_PASSWORD].orEmpty())
        assertFalse(SERVER_WORDS in bench.everythingSaid())

        bench.engine.post(STEP_UP) { ok(tokensJson("proven")) }
        bench.thenAllowed()
        bench.type(F.STEP_UP_PASSWORD, "right")
        bench.tap(A.SubmitStepUp)
        // The call that asked was made again.
        assertEquals(P.TotpSetup, bench.panel)
        assertEquals(2, bench.count("POST", "$FACTORS/totp"))
        assertEquals("""{"method":"password","password":"right"}""", bench.engine.sent(STEP_UP).last().body)
    }

    @Test
    fun `another way of a step-up is taken, and the order the server gave is kept`() = runTest {
        val bench = AccountBench().loaded()
        bench.needsProof("totp", "backup_code")
        bench.tap(A.UseStepUpMethod(TulaStepUpMethod.BACKUP_CODE))
        assertEquals(P.StepUp(TulaStepUpMethod.BACKUP_CODE, listOf(TulaStepUpMethod.TOTP)), bench.panel)
        assertEquals(listOf(F.BACKUP_CODE), bench.content.fields.map { it.field })
        bench.tap(A.SubmitStepUp)
        assertEquals(listOf(two.backupRequired), bench.state.fieldErrors[F.BACKUP_CODE])

        // A spent backup code is refused like a wrong one.
        bench.engine.post(STEP_UP) { refused("mfa.invalid_code", 400) }
        bench.type(F.BACKUP_CODE, "aaaaa-bbbbb")
        bench.tap(A.SubmitStepUp)
        assertEquals(listOf(two.codeWrong), bench.state.fieldErrors[F.BACKUP_CODE])

        bench.tap(A.UseStepUpMethod(TulaStepUpMethod.TOTP))
        assertEquals(P.StepUp(TulaStepUpMethod.TOTP, listOf(TulaStepUpMethod.BACKUP_CODE)), bench.panel)
        bench.type(F.CODE, "1234")
        bench.tap(A.SubmitStepUp)
        assertEquals(listOf(words.codeIncomplete), bench.state.fieldErrors[F.CODE])
        bench.engine.post(STEP_UP) { ok(tokensJson("proven")) }
        bench.thenAllowed()
        bench.type(F.CODE, "123456")
        bench.tap(A.SubmitStepUp)
        assertEquals(P.TotpSetup, bench.panel)
    }

    @Test
    fun `a locked second step is said with the wait, in the screen's words`() = runTest {
        val bench = AccountBench().loaded()
        bench.needsProof("totp")
        bench.engine.post(STEP_UP) { refused("rate_limited", 429, headers = mapOf("retry-after" to "120")) }
        bench.type(F.CODE, "123456")
        bench.tap(A.SubmitStepUp)
        assertIs<P.StepUp>(bench.panel)
        val said = assertNotNull(bench.state.formError)
        assertTrue(words.message("rate_limited") in said, said)
        assertTrue(words.duration(120_000) in said, said)
        assertFalse(SERVER_WORDS in bench.everythingSaid())
    }

    @Test
    fun `an emailed and a texted code are asked for with a button, never by arriving`() = runTest {
        for ((method, path, which) in listOf(
            Triple("email_code", "$STEP_UP/email-code", TulaStepUpMethod.EMAIL_CODE),
            Triple("sms_code", "$STEP_UP/sms-code", TulaStepUpMethod.SMS_CODE),
        )) {
            val bench = AccountBench().loaded()
            bench.needsProof(method)
            assertEquals(P.StepUp(which), bench.panel)
            // No message yet, and no field for its code.
            assertEquals(0, bench.count("POST", path))
            assertEquals(emptyList(), bench.content.fields)
            assertFalse(bench.offered(A.SubmitStepUp))

            bench.engine.post(path) { ok("""{"method":"$method","destination":"***42","expiresAt":"2026-01-01T00:10:00.000Z"}""") }
            bench.tap(A.SendStepUpCode)
            assertEquals(P.StepUp(which, sent = "***42"), bench.panel)
            assertEquals(listOf(F.CODE), bench.content.fields.map { it.field })
            assertTrue("***42" in bench.content.subtitle.orEmpty())
            assertEquals(TulaAccountFocus.Field(F.CODE), bench.state.focus)
            assertEquals(
                if (which == TulaStepUpMethod.SMS_CODE) TulaAuthFieldKind.SMS_CODE else TulaAuthFieldKind.CODE,
                bench.content.fields.single().kind,
            )
            bench.tap(A.SendStepUpCode)
            assertEquals(words.resent, bench.state.status)
            assertEquals(2, bench.count("POST", path))

            bench.engine.post(STEP_UP) { ok(tokensJson("proven")) }
            bench.thenAllowed()
            bench.type(F.CODE, "123456")
            bench.tap(A.SubmitStepUp)
            assertEquals(P.TotpSetup, bench.panel)
        }
    }

    @Test
    fun `a texted code that cannot be sent keeps the step-up and says why by its code`() = runTest {
        val bench = AccountBench().loaded()
        bench.needsProof("sms_code")
        bench.engine.post("$STEP_UP/sms-code") { refused("sms.unavailable", 503) }
        bench.tap(A.SendStepUpCode)
        assertEquals(P.StepUp(TulaStepUpMethod.SMS_CODE), bench.panel)
        assertEquals(words.message("sms.unavailable"), bench.state.formError)
    }

    @Test
    fun `a step-up by passkey is closed quietly, refused in words, and proven`() = runTest {
        val sheet = ScriptedPasskeySheet()
        val bench = AccountBench(passkeys = sheet).loaded()
        bench.needsProof("passkey", "password")
        assertEquals(P.StepUp(TulaStepUpMethod.PASSKEY, listOf(TulaStepUpMethod.PASSWORD)), bench.panel)
        bench.engine.post("$STEP_UP/passkey") { ok(PASSKEY_OPTIONS) }

        // The user closes the sheet: neither a problem nor a success, and nothing was sent to be judged.
        sheet.failure = SheetFailure.DISMISSED
        bench.tap(A.StepUpWithPasskey)
        assertEquals(a.passkeyDismissed, bench.state.notice)
        assertNull(bench.state.formError)
        assertNull(bench.state.status)
        assertEquals(0, bench.count("POST", STEP_UP))
        assertIs<P.StepUp>(bench.panel)

        sheet.failure = null
        bench.engine.post(STEP_UP) { refused("auth.invalid_credentials", 401) }
        bench.tap(A.StepUpWithPasskey)
        assertEquals(a.stepUpPasskeyRefused, bench.state.formError)
        assertNull(bench.state.notice)

        bench.engine.post(STEP_UP) { ok(tokensJson("proven")) }
        bench.thenAllowed()
        bench.tap(A.StepUpWithPasskey)
        assertEquals(P.TotpSetup, bench.panel)
    }

    @Test
    fun `with no way this client can take, that is said and nothing is asked`() = runTest {
        // A passkey is the one way, and this client was given no passkey sheet.
        for (methods in listOf(arrayOf("passkey"), arrayOf(), arrayOf("retina"))) {
            val bench = AccountBench().loaded()
            bench.needsProof(*methods)
            assertEquals(P.Overview, bench.panel)
            assertEquals(a.stepUpNoMethod, bench.state.formError)
            assertEquals(a.stepUpNoMethod, bench.said.last())
            assertEquals(0, bench.count("POST", STEP_UP))
        }
    }

    @Test
    fun `a proof that is itself asked for a proof ends there`() = runTest {
        val bench = AccountBench().loaded()
        bench.needsProof("password")
        bench.engine.post(STEP_UP) { stepUpRequired("password") }
        bench.type(F.STEP_UP_PASSWORD, "right")
        bench.tap(A.SubmitStepUp)
        assertIs<P.StepUp>(bench.panel)
        assertEquals(a.stepUpNoMethod, bench.state.formError)
    }

    @Test
    fun `a step-up that is left changes nothing and does not make the call again`() = runTest {
        val bench = AccountBench().loaded()
        bench.needsProof("password")
        bench.type(F.STEP_UP_PASSWORD, "typed")
        bench.tap(A.Cancel)
        assertEquals(P.Overview, bench.panel)
        assertEquals(a.nothingChanged, bench.state.notice)
        assertEquals(emptyMap(), bench.state.text)
        assertEquals(1, bench.count("POST", "$FACTORS/totp"))
        assertEquals(0, bench.count("POST", STEP_UP))
    }

    // The password

    @Test
    fun `a password change says a wrong current password and a refused new one at their fields`() = runTest {
        val bench = AccountBench().loaded()
        bench.tap(A.OpenChangePassword)
        assertEquals(P.ChangePassword, bench.panel)
        bench.tap(A.SubmitPassword)
        assertEquals(setOf(F.CURRENT_PASSWORD, F.NEW_PASSWORD), bench.state.fieldErrors.keys)
        assertEquals(0, bench.count("POST", "$ME/password"))

        bench.engine.post("$ME/password") { refused("auth.invalid_credentials", 401) }
        bench.type(F.CURRENT_PASSWORD, "old-wrong")
        bench.type(F.NEW_PASSWORD, "the-new-password")
        bench.model.toggleReveal(F.NEW_PASSWORD)
        assertEquals(setOf(F.NEW_PASSWORD), bench.state.revealed)
        bench.tap(A.SubmitPassword)
        assertEquals(listOf(a.currentPasswordWrong), bench.state.fieldErrors[F.CURRENT_PASSWORD])
        // The current password is emptied as it is sent; the one being chosen is kept.
        assertEquals("", bench.state.text[F.CURRENT_PASSWORD].orEmpty())
        assertEquals("the-new-password", bench.state.text[F.NEW_PASSWORD])

        bench.engine.post("$ME/password") {
            refused(
                "request.validation_failed", 422,
                ""","errors":[{"field":"newPassword","code":"password.too_short","message":"$SERVER_WORDS","params":{"minLength":12}}]""",
            )
        }
        bench.type(F.CURRENT_PASSWORD, "old")
        bench.tap(A.SubmitPassword)
        assertEquals(setOf(F.NEW_PASSWORD), bench.state.fieldErrors.keys)
        assertEquals(TulaAccountFocus.Field(F.NEW_PASSWORD), bench.state.focus)
        assertFalse(SERVER_WORDS in bench.everythingSaid())

        bench.engine.post("$ME/password") { NO_CONTENT }
        bench.type(F.CURRENT_PASSWORD, "old")
        bench.tap(A.SubmitPassword)
        assertEquals(P.Overview, bench.panel)
        assertEquals(a.passwordChanged, bench.state.status)
        assertEquals(emptyMap(), bench.state.text)
        assertEquals(emptySet(), bench.state.revealed)
    }

    @Test
    fun `a password change that needs a proof comes back to its form, to be typed again`() = runTest {
        val bench = AccountBench().loaded()
        bench.tap(A.OpenChangePassword)
        bench.engine.post("$ME/password") { stepUpRequired("totp") }
        bench.type(F.CURRENT_PASSWORD, "old")
        bench.type(F.NEW_PASSWORD, "the-new-password")
        bench.tap(A.SubmitPassword)
        assertEquals(P.StepUp(TulaStepUpMethod.TOTP), bench.panel)
        // Neither password outlived its form.
        assertEquals(emptyMap(), bench.state.text)
        bench.engine.post(STEP_UP) { ok(tokensJson("proven")) }
        bench.type(F.CODE, "123456")
        bench.tap(A.SubmitStepUp)
        assertEquals(P.ChangePassword, bench.panel)
        assertEquals(a.stepUpDone, bench.state.status)
        assertEquals(1, bench.count("POST", "$ME/password"))
    }

    @Test
    fun `an account with no password is told how to set one`() = runTest {
        val bench = AccountBench().loaded { engine.on("GET", ME) { ok(userJson(password = false, email = null)) } }
        assertEquals(listOf(a.passwordNotSet), bench.lines("tula.account.password"))
        assertFalse(bench.offered(A.OpenChangePassword))
        assertEquals(listOf("Maya", a.noEmail), bench.lines("tula.account.profile"))
    }

    // Passkeys

    @Test
    fun `add a passkey is drawn only once it is known to work`() = runTest {
        // No sheet: said in words, and the list can still be removed from.
        val none = AccountBench().loaded { engine.on("GET", PASSKEYS) { ok("""{"passkeys":[${passkeyJson()}]}""") } }
        assertFalse(none.offered(A.AddPasskey))
        assertTrue(a.addUnsupported in none.lines("tula.account.passkeys"))
        // The client has no call that renames one: said, not faked.
        assertTrue(a.renameUnavailable in none.lines("tula.account.passkeys"))
        assertTrue(none.offered(A.Ask(TulaAccountConfirm.RemovePasskey("pk-1", "Pixel"))))

        // The factors were not read: the button waits for them.
        val unread = AccountBench(passkeys = ScriptedPasskeySheet())
        unread.signIn()
        unread.engine.on("GET", FACTORS) { refused("internal", 500) }
        unread.model.load()
        assertFalse(unread.offered(A.AddPasskey))
        assertTrue(a.addUnchecked in unread.lines("tula.account.passkeys"))

        // Passkeys are off: nothing about adding one.
        val off = AccountBench(passkeys = ScriptedPasskeySheet()).loaded { engine.on("GET", CONFIG) { ok(configJson()) } }
        assertFalse(off.offered(A.AddPasskey))
        assertEquals(listOf(a.passkeysIntro, a.passkeysEmpty), off.lines("tula.account.passkeys"))

        // A passkey would take the second step over from a texted code: said before the button.
        val texted = AccountBench(passkeys = ScriptedPasskeySheet()).loaded {
            engine.on("GET", FACTORS) { ok(factorsJson(sms = smsJson(enabled = true))) }
        }
        assertTrue(texted.offered(A.AddPasskey))
        assertTrue(a.replacesTextedCode in texted.lines("tula.account.passkeys"))
    }

    @Test
    fun `the passkeys section waits for the factors while they are being read`() = runTest {
        val bench = AccountBench(passkeys = ScriptedPasskeySheet())
        bench.signIn()
        val state = TulaAccountState(passkeys = emptyList())
        val content = TulaAccountContent.of(state, words, passkeySheet = true) { it }
        assertTrue(a.addChecking in content.sections.single { it.identifier == "tula.account.passkeys" }.lines)
        assertFalse(A.AddPasskey in content.actions)
    }

    @Test
    fun `a passkey is added, a closed sheet is said quietly, and a second sheet is refused as busy`() = runTest {
        val sheet = ScriptedPasskeySheet()
        val bench = AccountBench(passkeys = sheet).loaded()
        bench.engine.post("$PASSKEYS/options") { ok(CREATION_OPTIONS) }
        bench.engine.post(PASSKEYS) { ok(passkeyJson()) }

        sheet.failure = SheetFailure.DISMISSED
        bench.tap(A.AddPasskey)
        assertEquals(a.passkeyDismissed, bench.state.notice)
        assertNull(bench.state.formError)
        assertNull(bench.state.status)
        assertEquals(0, bench.count("POST", PASSKEYS))

        // One ceremony at a time: a second one, asked while the sheet is open, is refused.
        sheet.failure = null
        val gate = Gate()
        sheet.gate = gate
        val second = bench.another()
        second.load()
        val first = launch { bench.tap(A.AddPasskey) }
        gate.reached()
        assertTrue(bench.state.isPending)
        second.perform(A.AddPasskey)
        assertEquals(a.sheetBusy, second.state.value.notice)
        assertNull(second.state.value.formError)
        assertEquals(2, sheet.asked.get())

        bench.engine.on("GET", PASSKEYS) { ok("""{"passkeys":[${passkeyJson(used = true, synced = false)}]}""") }
        gate.open()
        first.join()
        assertEquals(a.passkeyAdded, bench.state.status)
        val row = bench.section("tula.account.passkeys").rows.single()
        assertEquals("Pixel", row.title)
        assertEquals(listOf(a.passkeySingleDevice, "Added 2026-01-05", "Last used 2026-01-06"), row.details)
        assertEquals("Remove Pixel", row.offer?.label)
    }

    @Test
    fun `a sheet that fails is said by its code`() = runTest {
        val sheet = ScriptedPasskeySheet()
        val bench = AccountBench(passkeys = sheet).loaded()
        bench.engine.post("$PASSKEYS/options") { ok(CREATION_OPTIONS) }
        sheet.failure = SheetFailure.FAILED
        bench.tap(A.AddPasskey)
        assertEquals(words.message("passkey.failed"), bench.state.formError)
        assertFalse(bench.state.isPending)
    }

    @Test
    fun `removing the last way to sign in is refused by the server and said by its code`() = runTest {
        val bench = AccountBench().loaded { engine.on("GET", PASSKEYS) { ok("""{"passkeys":[${passkeyJson()}]}""") } }
        val what = TulaAccountConfirm.RemovePasskey("pk-1", "Pixel")
        bench.tap(A.Ask(what))
        assertEquals(P.Confirm(what), bench.panel)
        assertEquals("Remove “Pixel”? You will no longer be able to sign in with it.", bench.content.subtitle)
        assertEquals(a.removeConfirmButton, bench.content.primary?.title)
        assertEquals(0, bench.count("DELETE", "$PASSKEYS/pk-1"))

        bench.engine.on("DELETE", "$PASSKEYS/pk-1") { refused("passkey.last_sign_in_method", 409) }
        bench.tap(A.Confirmed)
        // Still asked, with the reason in the contract's words for the code.
        assertEquals(P.Confirm(what), bench.panel)
        assertEquals(words.message("passkey.last_sign_in_method"), bench.state.formError)
        assertFalse(SERVER_WORDS in bench.everythingSaid())
        assertNull(bench.state.status)

        bench.engine.on("DELETE", "$PASSKEYS/pk-1") { NO_CONTENT }
        bench.engine.on("GET", PASSKEYS) { ok("""{"passkeys":[]}""") }
        bench.tap(A.Confirmed)
        assertEquals(P.Overview, bench.panel)
        assertEquals(a.passkeyRemoved, bench.state.status)
        assertEquals(emptyList(), bench.section("tula.account.passkeys").rows)
    }

    @Test
    fun `a removal that needs a proof is made again after it, with nothing asked twice`() = runTest {
        val bench = AccountBench().loaded { engine.on("GET", PASSKEYS) { ok("""{"passkeys":[${passkeyJson()}]}""") } }
        bench.tap(A.Ask(TulaAccountConfirm.RemovePasskey("pk-1", "Pixel")))
        bench.engine.on("DELETE", "$PASSKEYS/pk-1") { stepUpRequired("password") }
        bench.tap(A.Confirmed)
        assertIs<P.StepUp>(bench.panel)
        bench.engine.post(STEP_UP) { ok(tokensJson("proven")) }
        bench.engine.on("DELETE", "$PASSKEYS/pk-1") { NO_CONTENT }
        bench.type(F.STEP_UP_PASSWORD, "right")
        bench.tap(A.SubmitStepUp)
        assertEquals(P.Overview, bench.panel)
        assertEquals(a.passkeyRemoved, bench.state.status)
        assertEquals(2, bench.count("DELETE", "$PASSKEYS/pk-1"))
    }

    @Test
    fun `an answer that arrives after the screen was closed changes nothing`() = runTest {
        val bench = AccountBench().loaded { engine.on("GET", PASSKEYS) { ok("""{"passkeys":[${passkeyJson()}]}""") } }
        bench.tap(A.Ask(TulaAccountConfirm.RemovePasskey("pk-1", "Pixel")))
        val gate = Gate()
        var answer: HttpResponse = NO_CONTENT
        bench.engine.on("DELETE", "$PASSKEYS/pk-1") {
            gate.pass()
            answer
        }
        for (late in listOf(NO_CONTENT, refused("passkey.last_sign_in_method", 409), stepUpRequired("password"))) {
            answer = late
            bench.tap(A.Ask(TulaAccountConfirm.RemovePasskey("pk-1", "Pixel")))
            val call = launch { bench.tap(A.Confirmed) }
            gate.reached()
            bench.model.close()
            gate.open()
            call.join()
            assertEquals(P.Overview, bench.panel)
            assertNull(bench.state.status)
            assertNull(bench.state.formError)
            assertFalse(bench.state.isPending)
        }
    }

    @Test
    fun `a second press while a call is on its way sends nothing`() = runTest {
        val bench = AccountBench().loaded()
        val gate = Gate()
        bench.engine.post("$SESSIONS/revoke-others") {
            gate.pass()
            ok("""{"revoked":1}""")
        }
        val call = launch { bench.tap(A.RevokeOthers) }
        gate.reached()
        bench.tap(A.RevokeOthers)
        bench.tap(A.OpenChangePassword)
        assertEquals(P.Overview, bench.panel)
        gate.open()
        call.join()
        assertEquals(1, bench.count("POST", "$SESSIONS/revoke-others"))
    }

    // The phone number and the texted second step

    @Test
    fun `a phone number is added, proven and removed`() = runTest {
        val bench = AccountBench().loaded()
        assertEquals(listOf(a.phoneNone), bench.lines("tula.account.phone"))
        bench.tap(A.OpenPhone)
        assertEquals(P.PhoneNumber, bench.panel)
        bench.type(F.PHONE, "415 555 0142")
        bench.tap(A.SendPhoneCode)
        assertEquals(listOf(words.ways.numberForm), bench.state.fieldErrors[F.PHONE])
        assertEquals(0, bench.count("POST", "$ME/phone"))

        bench.engine.post("$ME/phone") { ok("""{"destination":"***42","expiresAt":"2026-01-01T00:10:00.000Z"}""") }
        bench.type(F.PHONE, "+14155550142")
        bench.tap(A.SendPhoneCode)
        assertEquals(P.PhoneCode("***42"), bench.panel)
        assertEquals(TulaAuthFieldKind.SMS_CODE, bench.content.fields.single().kind)

        // "Use a different number" goes back with the number still typed.
        bench.tap(A.OpenPhone)
        assertEquals(P.PhoneNumber, bench.panel)
        assertEquals("+14155550142", bench.state.text[F.PHONE])
        bench.tap(A.SendPhoneCode)

        bench.engine.post("$ME/phone/verify") { refused("verification.invalid_code", 400) }
        bench.type(F.CODE, "000000")
        bench.tap(A.VerifyPhone)
        assertEquals(listOf(words.message("verification.invalid_code")), bench.state.fieldErrors[F.CODE])
        assertEquals("", bench.state.text[F.CODE].orEmpty())

        bench.engine.post("$ME/phone/verify") { ok(userJson(phone = "+14155550142")) }
        bench.type(F.CODE, "123456")
        bench.tap(A.VerifyPhone)
        assertEquals(P.Overview, bench.panel)
        assertEquals(a.phoneAdded, bench.state.status)
        assertEquals(listOf("+14155550142", a.phoneVerified), bench.lines("tula.account.phone"))
        // The typed number went with its form.
        assertEquals(emptyMap(), bench.state.text)

        bench.tap(A.Ask(TulaAccountConfirm.RemovePhone))
        assertEquals(a.phoneRemoveConfirm, bench.content.subtitle)
        bench.engine.on("DELETE", "$ME/phone") { NO_CONTENT }
        bench.engine.on("GET", ME) { ok(userJson()) }
        bench.tap(A.Confirmed)
        assertEquals(a.phoneRemoved, bench.state.status)
        assertEquals(listOf(a.phoneNone), bench.lines("tula.account.phone"))
    }

    @Test
    fun `a number that needs a proof is sent again after it without being typed twice`() = runTest {
        val bench = AccountBench().loaded()
        bench.tap(A.OpenPhone)
        bench.engine.post("$ME/phone") { stepUpRequired("password") }
        bench.type(F.PHONE, "+14155550142")
        bench.tap(A.SendPhoneCode)
        assertIs<P.StepUp>(bench.panel)
        bench.engine.post(STEP_UP) { ok(tokensJson("proven")) }
        bench.engine.post("$ME/phone") { ok("""{"destination":"***42","expiresAt":"2026-01-01T00:10:00.000Z"}""") }
        bench.type(F.STEP_UP_PASSWORD, "right")
        bench.tap(A.SubmitStepUp)
        assertEquals(P.PhoneCode("***42"), bench.panel)
        assertEquals("""{"phoneNumber":"+14155550142"}""", bench.engine.sent("$ME/phone").last().body)
    }

    @Test
    fun `where phone numbers are off none can be added, and that is said`() = runTest {
        val bench = AccountBench().loaded { engine.on("GET", CONFIG) { ok(configJson()) } }
        assertEquals(listOf(a.phoneNone, a.phoneUnavailable), bench.lines("tula.account.phone"))
        assertFalse(bench.offered(A.OpenPhone))
    }

    @Test
    fun `a texted second step is offered only where the server says it can be, and turned on with a code`() = runTest {
        val none = AccountBench().loaded { engine.on("GET", FACTORS) { ok(factorsJson(sms = smsJson(enabled = false, available = false))) } }
        assertFalse(none.offered(A.TurnOnSms))

        val bench = AccountBench().loaded { engine.on("GET", FACTORS) { ok(factorsJson(sms = smsJson(enabled = false))) } }
        assertTrue(a.smsOffer in bench.lines("tula.account.factors"))
        // Nothing is texted by arriving.
        assertEquals(0, bench.count("POST", "$FACTORS/sms"))
        bench.engine.post("$FACTORS/sms") { ok("""{"method":"sms_code","destination":"***42","expiresAt":"2026-01-01T00:10:00.000Z"}""") }
        bench.tap(A.TurnOnSms)
        assertEquals(P.TextedFactorCode("***42"), bench.panel)
        bench.tap(A.ConfirmSms)
        assertEquals(listOf(words.codeIncomplete), bench.state.fieldErrors[F.CODE])
        bench.engine.post("$FACTORS/sms/confirm") { ok(factorsJson(sms = smsJson(enabled = true))) }
        bench.type(F.CODE, "123456")
        bench.tap(A.ConfirmSms)
        assertEquals(P.Overview, bench.panel)
        assertEquals(a.smsTurnedOn, bench.state.status)
        assertEquals(
            listOf(a.mfaOff, "A code by text message is your second step since 2026-01-04.", a.smsWeaker),
            bench.lines("tula.account.factors"),
        )

        bench.tap(A.Ask(TulaAccountConfirm.TurnOffSms))
        assertEquals(a.smsTurnOffConfirm, bench.content.subtitle)
        bench.engine.on("DELETE", "$FACTORS/sms") { NO_CONTENT }
        bench.engine.on("GET", FACTORS) { ok(factorsJson(sms = smsJson(enabled = false))) }
        bench.tap(A.Confirmed)
        assertEquals(a.smsTurnedOff, bench.state.status)
    }

    @Test
    fun `a texted code beside a stronger step is said to be not in use`() = runTest {
        val bench = AccountBench().loaded {
            engine.on("GET", FACTORS) { ok(factorsJson(totp = true, remaining = 8, sms = smsJson(enabled = true, inUse = false))) }
        }
        assertTrue(a.smsNotInUse in bench.lines("tula.account.factors"))
        assertFalse(a.smsWeaker in bench.lines("tula.account.factors"))
    }

    // What a field keeps

    @Test
    fun `a field keeps what it is for, and only a password field of the open form is revealed`() = runTest {
        val bench = AccountBench().loaded()
        bench.type(F.CODE, "12a34 5678")
        assertEquals("123456", bench.state.text[F.CODE])
        bench.type(F.PHONE, "+".padEnd(60, '1'))
        assertEquals(TulaAccountModel.PHONE_MAX, bench.state.text[F.PHONE]?.length)
        bench.type(F.BACKUP_CODE, "x".repeat(60))
        assertEquals(TulaAuthModel.BACKUP_CODE_MAX, bench.state.text[F.BACKUP_CODE]?.length)
        // No password field is open on the overview.
        bench.model.toggleReveal(F.NEW_PASSWORD)
        assertEquals(emptySet(), bench.state.revealed)
        bench.tap(A.OpenChangePassword)
        bench.model.toggleReveal(F.CODE)
        bench.model.toggleReveal(F.CURRENT_PASSWORD)
        assertEquals(setOf(F.CURRENT_PASSWORD), bench.state.revealed)
        bench.model.toggleReveal(F.CURRENT_PASSWORD)
        assertEquals(emptySet(), bench.state.revealed)
    }

    @Test
    fun `the strings can be replaced, and a problem above the form is worded as one`() = runTest {
        val bench = AccountBench().loaded()
        bench.model.strings = TulaStrings(account = TulaAccountStrings(title = "Mon compte"))
        assertEquals("Mon compte", bench.content.title)
        assertEquals("Mon compte", bench.model.strings.account.title)
        assertNull(bench.model.formProblem)
        bench.needsProof()
        assertEquals("Error: ${a.stepUpNoMethod}", bench.model.formProblem)
    }
}
