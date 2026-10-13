package dev.tula.auth.ui

import dev.tula.auth.AuthState
import dev.tula.auth.SheetFailure
import dev.tula.auth.TulaSheetException
import dev.tula.auth.generated.OAuthProvider
import dev.tula.auth.ui.TulaAuthAction.CONFIRM_ENROLMENT
import dev.tula.auth.ui.TulaAuthAction.CONTINUE_WITH_GITHUB
import dev.tula.auth.ui.TulaAuthAction.CONTINUE_WITH_GOOGLE
import dev.tula.auth.ui.TulaAuthAction.COPY_BACKUP_CODES
import dev.tula.auth.ui.TulaAuthAction.COPY_SETUP_KEY
import dev.tula.auth.ui.TulaAuthAction.RESEND_CODE
import dev.tula.auth.ui.TulaAuthAction.RETRY_PROVIDER
import dev.tula.auth.ui.TulaAuthAction.SAVED_BACKUP_CODES
import dev.tula.auth.ui.TulaAuthAction.SEND_TEXTED_CODE
import dev.tula.auth.ui.TulaAuthAction.SHOW_SIGN_IN
import dev.tula.auth.ui.TulaAuthAction.SHOW_SIGN_UP
import dev.tula.auth.ui.TulaAuthAction.START
import dev.tula.auth.ui.TulaAuthAction.START_AGAIN
import dev.tula.auth.ui.TulaAuthAction.START_ENROLMENT
import dev.tula.auth.ui.TulaAuthAction.SUBMIT_BACKUP_CODE
import dev.tula.auth.ui.TulaAuthAction.SUBMIT_CODE
import dev.tula.auth.ui.TulaAuthAction.USE_PASSKEY
import dev.tula.auth.ui.TulaAuthAction.USE_SECOND_PASSKEY
import dev.tula.auth.ui.TulaAuthAction.USE_WAY_BACKUP_CODE
import dev.tula.auth.ui.TulaAuthAction.USE_WAY_PASSKEY
import dev.tula.auth.ui.TulaAuthAction.USE_WAY_TEXTED_CODE
import dev.tula.auth.ui.TulaAuthAction.USE_WAY_TOTP
import dev.tula.auth.ui.TulaAuthField.BACKUP_CODE
import dev.tula.auth.ui.TulaAuthField.CODE
import dev.tula.auth.ui.TulaAuthField.EMAIL
import kotlinx.coroutines.async
import kotlinx.coroutines.launch
import java.util.concurrent.atomic.AtomicInteger
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

private const val REDIRECT = "com.example.app:/oauth/callback"
private const val OAUTH = "$SIGN_INS/oauth"
private const val EXCHANGE = "$SIGN_INS/oauth/exchange"
private const val SECOND = "$SIGN_IN/second-factor"
private const val NUMBER = "+1 (415) 555-0142"
private const val MASKED_NUMBER = "***42"
private const val SETUP_KEY = "JBSWY3DPEHPK3PXP"
private const val SETUP_URI = "otpauth://totp/Tula:maya%40example.com?secret=$SETUP_KEY&issuer=Tula"
private const val ENROLMENT = """{"status":"needs_factor_enrolment","methods":["totp"]}"""
private val CODES = listOf("aaaaa-bbbbb", "ccccc-ddddd")

private fun secondFactor(vararg options: String, sent: Boolean = false): String {
    val prepared = if (sent) ""","prepared":{"method":"sms_code","destination":"$MASKED_NUMBER"}""" else ""
    return """{"status":"needs_second_factor","options":[${options.joinToString(",") { "\"$it\"" }}]$prepared}"""
}

private fun textedFirst(sent: Boolean = false): String {
    val prepared = if (sent) ""","prepared":{"strategy":"sms_code","destination":"$MASKED_NUMBER"}""" else ""
    return """{"status":"needs_first_factor","strategies":["password","sms_code"]$prepared}"""
}

private fun oauthStart() = ok(
    """{"attempt":${attemptJson(firstFactor())},"authorizationUrl":"https://provider.example/authorize",""" +
        """"binding":"tula_ob_unit"}""",
)

private fun returned(redirectUrl: String) = "$redirectUrl#tula_ticket=tula_ot_unit&tula_attempt=attempt-1"

/** A finished attempt that also hands over backup codes, as confirming an enrolment answers. */
private fun enrolled(step: String = COMPLETE) = ok(
    attemptJson(step, session = if (step == COMPLETE) tokensJson() else null).dropLast(1) +
        ""","backupCodes":[${CODES.joinToString(",") { "\"$it\"" }}]}""",
)

/**
 * The first screen's other ways (a passkey, a provider), a texted sign-in code, the second step
 * and an authenticator set up inside a sign-in: what the model decides, on the real client.
 */
class WaysAndSecondStepTest {
    private fun passkeyBench(sheet: ScriptedPasskeySheet = ScriptedPasskeySheet()): Bench {
        val bench = Bench(passkeys = sheet)
        bench.engine.post(PASSKEY_START) { ok("""{"attempt":${attemptJson(firstFactor("passkey"))},"options":$PASSKEY_OPTIONS}""") }
        bench.engine.post("$SIGN_IN/passkey") { completed() }
        return bench
    }

    // The ways of the first screen

    @Test
    fun `no way is drawn before the configuration was read, and then only what this client can take here`() = runTest {
        val all = Bench(passkeys = ScriptedPasskeySheet(), browser = { _, _ -> null }, redirectUrl = REDIRECT)
        assertEquals(emptyList(), all.state.ways)
        assertEquals(setOf(START, SHOW_SIGN_UP), all.model.content.actions)
        // A provider this version has no words for is left out, never guessed.
        all.configure(listOf("password", "passkey"), listOf("google", "github", "made_up"))
        assertEquals(
            listOf(TulaAuthWay.Passkey, TulaAuthWay.Provider(OAuthProvider.Google), TulaAuthWay.Provider(OAuthProvider.Github)),
            all.state.ways,
        )
        val content = all.model.content
        assertEquals(
            listOf("Sign in with a passkey", "Continue with Google", "Continue with GitHub"),
            content.ways.map { it.title },
        )
        assertEquals(listOf("tula.way.passkey", "tula.way.google", "tula.way.github"), content.ways.map { it.identifier })
        assertEquals("or", content.divider)
        assertEquals(setOf(START, SHOW_SIGN_UP, USE_PASSKEY, CONTINUE_WITH_GOOGLE, CONTINUE_WITH_GITHUB), content.actions)

        // No sheet and no browser: the environment's ways are not this client's.
        val none = Bench()
        none.configure(listOf("password", "passkey"), listOf("google", "github"))
        assertEquals(emptyList(), none.state.ways)
        assertNull(none.model.content.divider)

        // Google's own sheet and no redirect URL: Google, and no provider that needs the browser.
        val google = Bench(google = { "token" }, browser = { _, _ -> null })
        google.configure(listOf("password"), listOf("google", "github"))
        assertEquals(listOf<TulaAuthWay>(TulaAuthWay.Provider(OAuthProvider.Google)), google.state.ways)

        // A way is the sign-in's: the other starts offer none.
        all.tap(SHOW_SIGN_UP)
        assertEquals(emptyList(), all.model.content.ways)
    }

    @Test
    fun `a method that is the only one is said in words - nothing to type means no field, and no way here says so`() = runTest {
        val only = Bench(passkeys = ScriptedPasskeySheet())
        only.configure(listOf("passkey"))
        val content = only.model.content
        assertEquals(emptyList(), content.fields)
        assertNull(content.primary)
        assertNull(content.divider)
        assertNull(content.note)
        assertEquals(listOf(USE_PASSKEY), content.ways.map { it.action })
        // The button of a field that is not there does nothing.
        only.tap(START)
        assertEquals(emptyList(), only.engine.paths().filter { it == SIGN_INS })

        val nothing = Bench()
        nothing.configure(listOf("passkey"))
        assertEquals(nothing.model.strings.ways.noWayHere, nothing.model.content.note)
        assertEquals(emptyList(), nothing.model.content.fields)
        assertEquals(setOf(SHOW_SIGN_UP), nothing.model.content.actions)
    }

    @Test
    fun `a passkey signs in through the sheet, and a sheet that was closed is said quietly - not an error, not a success`() = runTest {
        val sheet = ScriptedPasskeySheet()
        val bench = passkeyBench(sheet)
        bench.configure(listOf("password", "passkey"))
        sheet.failure = SheetFailure.DISMISSED
        bench.tap(USE_PASSKEY)
        assertEquals(TulaAuthScreen.SignInStart, bench.screen)
        assertEquals(bench.model.strings.ways.passkeyDismissed, bench.state.notice)
        assertNull(bench.state.formError)
        assertNull(bench.state.status)
        assertFalse(bench.state.isPending)
        assertEquals(0, bench.signedIn.get())
        assertEquals(bench.model.strings.ways.passkeyDismissed, bench.said.last())
        // Nothing was sent to prove anything.
        assertEquals(emptyList(), bench.engine.sent("$SIGN_IN/passkey"))

        // The same button works again, and the notice goes with the next action.
        sheet.failure = null
        bench.tap(USE_PASSKEY)
        assertEquals(TulaAuthScreen.SignedIn, bench.screen)
        assertNull(bench.state.notice)
        assertEquals(1, bench.signedIn.get())
        assertEquals(2, sheet.asked.get())
    }

    @Test
    fun `a passkey the server refuses, a sheet that fails and a sheet that is still open are each said in their own words`() = runTest {
        val refused = passkeyBench()
        refused.configure(listOf("passkey"))
        refused.engine.post("$SIGN_IN/passkey") { refused("auth.invalid_credentials", 401) }
        refused.tap(USE_PASSKEY)
        assertEquals(refused.model.strings.ways.passkeyRefused, refused.state.formError)
        assertNull(refused.state.notice)
        assertFalse(refused.everythingSaid().contains(SERVER_WORDS))

        val sheet = ScriptedPasskeySheet()
        val failed = passkeyBench(sheet)
        failed.configure(listOf("passkey"))
        sheet.failure = SheetFailure.FAILED
        failed.tap(USE_PASSKEY)
        assertEquals(failed.model.strings.message("passkey.failed"), failed.state.formError)

        // One ceremony at a time: the client's sheet is up for somebody else.
        val held = ScriptedPasskeySheet()
        val busy = passkeyBench(held)
        busy.configure(listOf("passkey"))
        val gate = Gate()
        held.gate = gate
        val first = async { busy.client.signInWithPasskey() }
        gate.reached()
        busy.tap(USE_PASSKEY)
        assertEquals(busy.model.strings.ways.sheetBusy, busy.state.notice)
        assertNull(busy.state.formError)
        assertFalse(busy.state.isPending)
        assertEquals(1, held.asked.get())
        gate.open()
        first.await()
    }

    @Test
    fun `a passkey whose answer arrives after the screen was left signs in all the same, and one that was closed changes nothing`() = runTest {
        val sheet = ScriptedPasskeySheet()
        val bench = passkeyBench(sheet)
        bench.configure(listOf("passkey"))
        val gate = Gate()
        sheet.gate = gate
        val tap = launch { bench.tap(USE_PASSKEY) }
        gate.reached()
        bench.model.close()
        gate.open()
        tap.join()
        // The flow completed: the client is signed in, whatever is open now.
        assertEquals(TulaAuthScreen.SignedIn, bench.screen)
        assertEquals(1, bench.signedIn.get())

        val closed = ScriptedPasskeySheet()
        val left = passkeyBench(closed)
        left.configure(listOf("passkey"))
        val second = Gate()
        closed.gate = second
        closed.failure = SheetFailure.DISMISSED
        val other = launch { left.tap(USE_PASSKEY) }
        second.reached()
        left.model.showSignUp()
        second.open()
        other.join()
        assertEquals(TulaAuthScreen.SignUpStart, left.screen)
        assertNull(left.state.notice)
        assertEquals(0, left.signedIn.get())
    }

    @Test
    fun `Google signs in through its own sheet where the client has one, and a closed chooser is said quietly`() = runTest {
        val answers = AtomicInteger()
        val bench = Bench(
            google = {
                if (answers.incrementAndGet() == 1) throw TulaSheetException(SheetFailure.DISMISSED)
                "an-id-token"
            },
        )
        bench.engine.post("$SIGN_INS/id-token") { ok("""{"attempt":${attemptJson(firstFactor())},"nonce":"nonce-1"}""") }
        bench.engine.post("$SIGN_IN/id-token") { completed() }
        bench.configure(listOf("password"), listOf("google"))
        bench.tap(CONTINUE_WITH_GOOGLE)
        assertEquals(bench.model.strings.ways.providerCancelled, bench.state.notice)
        assertNull(bench.state.formError)
        assertEquals(TulaAuthScreen.SignInStart, bench.screen)
        // No exchange was made, and no browser was asked for.
        assertEquals(emptyList(), bench.engine.sent("$SIGN_IN/id-token"))
        assertEquals(emptyList(), bench.engine.sent(OAUTH))

        bench.tap(CONTINUE_WITH_GOOGLE)
        assertEquals(TulaAuthScreen.SignedIn, bench.screen)
        assertEquals(1, bench.signedIn.get())
    }

    @Test
    fun `a provider signs in through the browser - closed, refused, and a step that asks for more`() = runTest {
        var back: (String) -> String? = { null }
        val bench = Bench(browser = { _, redirectUrl -> back(redirectUrl) }, redirectUrl = REDIRECT)
        bench.engine.post(OAUTH) { oauthStart() }
        bench.configure(listOf("password"), listOf("github"))

        // The user closed the browser.
        bench.tap(CONTINUE_WITH_GITHUB)
        assertEquals(bench.model.strings.ways.providerCancelled, bench.state.notice)
        assertNull(bench.state.formError)
        assertEquals(REDIRECT, bench.engine.sent(OAUTH).single().body.orEmpty().substringAfter("redirectUrl\":\"").substringBefore('"'))

        // The provider said no: a code of the contract, in the table's words.
        back = { "$it#tula_error=oauth.access_denied" }
        bench.tap(CONTINUE_WITH_GITHUB)
        assertEquals(bench.model.strings.message("oauth.access_denied"), bench.state.formError)
        assertNull(bench.state.notice)

        // An address that is not the one asked for is refused without a request.
        back = { "https://elsewhere.example/#tula_ticket=t" }
        bench.tap(CONTINUE_WITH_GITHUB)
        assertEquals(bench.model.strings.ways.providerRefused, bench.state.formError)
        assertEquals(emptyList(), bench.engine.sent(EXCHANGE))

        // The provider proved the first factor and the server asks for a second.
        back = ::returned
        bench.engine.post(EXCHANGE) { ok(attemptJson(SECOND_FACTOR)) }
        bench.tap(CONTINUE_WITH_GITHUB)
        assertEquals(TulaAuthScreen.SecondFactor(TulaSecondWay.TOTP), bench.screen)
        bench.engine.post(SECOND) { completed() }
        bench.type(CODE, "123456")
        bench.tap(SUBMIT_CODE)
        assertEquals(TulaAuthScreen.SignedIn, bench.screen)
    }

    @Test
    fun `an exchange that got no answer can be tried again, and leaving the screen drops what was kept`() = runTest {
        val asked = AtomicInteger()
        val bench = Bench(browser = { _, redirectUrl -> returned(redirectUrl) }, redirectUrl = REDIRECT)
        bench.engine.post(OAUTH) { oauthStart() }
        bench.engine.post(EXCHANGE) {
            if (asked.incrementAndGet() == 1) throw java.io.IOException("the connection died") else completed()
        }
        bench.configure(listOf("password"), listOf("github"))
        assertFalse(RETRY_PROVIDER in bench.model.content.actions)
        bench.tap(CONTINUE_WITH_GITHUB)
        assertEquals(bench.model.strings.message("network.failed"), bench.state.formError)
        assertTrue(bench.state.canRetryProvider)
        assertEquals("Try again", bench.model.content.links.first { it.action == RETRY_PROVIDER }.title)
        bench.tap(RETRY_PROVIDER)
        assertEquals(TulaAuthScreen.SignedIn, bench.screen)
        assertEquals(2, bench.engine.sent(EXCHANGE).size)

        // Left before trying again: the ticket is forgotten, and the link with it.
        val left = Bench(browser = { _, redirectUrl -> returned(redirectUrl) }, redirectUrl = REDIRECT)
        left.engine.post(OAUTH) { oauthStart() }
        left.engine.post(EXCHANGE) { throw java.io.IOException("the connection died") }
        left.configure(listOf("password"), listOf("github"))
        left.tap(CONTINUE_WITH_GITHUB)
        assertTrue(left.state.canRetryProvider)
        left.tap(SHOW_SIGN_UP)
        left.tap(SHOW_SIGN_IN)
        assertFalse(left.state.canRetryProvider)
        left.tap(RETRY_PROVIDER)
        assertEquals(1, left.engine.sent(EXCHANGE).size)
        // A refusal that is an answer keeps nothing to try again.
        val answered = Bench(browser = { _, redirectUrl -> returned(redirectUrl) }, redirectUrl = REDIRECT)
        answered.engine.post(OAUTH) { oauthStart() }
        answered.engine.post(EXCHANGE) { refused("oauth.account_exists", 409) }
        answered.configure(listOf("password"), listOf("github"))
        answered.tap(CONTINUE_WITH_GITHUB)
        assertEquals(answered.model.strings.message("oauth.account_exists"), answered.state.formError)
        assertFalse(answered.state.canRetryProvider)
    }

    @Test
    fun `every provider has its action and its words, and every way of the second step its link`() {
        val strings = TulaStrings()
        for (provider in OAuthProvider.entries) {
            val action = assertNotNull(TulaAuthAction.of(provider), provider.rawValue)
            assertEquals(provider, action.provider)
            assertNotNull(strings.ways.providers[provider.rawValue], provider.rawValue)
        }
        assertNull(START.provider)
        assertEquals(
            listOf(USE_WAY_TOTP, USE_WAY_PASSKEY, USE_WAY_TEXTED_CODE, USE_WAY_BACKUP_CODE),
            TulaSecondWay.entries.map { TulaAuthAction.of(it) },
        )
    }

    // A texted code that signs in

    @Test
    fun `what is taken for a phone number`() {
        for (number in listOf("+14155550142", NUMBER, "+44 7700 900142", " +1-415-555-0142 ", "+12345678")) {
            assertTrue(TulaAuthModel.isPhoneNumber(number), number)
        }
        for (other in listOf("", ADDRESS, "4155550142", "+0415555014", "+1415", "+1415555014299999", "+1415555o142", "+")) {
            assertFalse(TulaAuthModel.isPhoneNumber(other), other)
        }
    }

    @Test
    fun `a phone number is shown the texted code and nothing else, and nothing is texted by arriving`() = runTest {
        val bench = Bench()
        bench.configure(listOf("password", "smsCode"))
        val first = bench.model.content.fields.single()
        assertEquals(TulaAuthFieldKind.IDENTIFIER, first.kind)
        assertEquals(bench.model.strings.ways.identifierLabel, first.label)
        assertNotNull(first.hint)
        bench.engine.post(SIGN_INS) { ok(attemptJson(textedFirst())) }
        bench.begin(NUMBER)
        assertEquals(TulaAuthScreen.TextedCodeOffer(), bench.screen)
        assertEquals(emptyList(), bench.engine.sent("$SIGN_IN/first-factor/prepare"))
        assertEquals(setOf(SEND_TEXTED_CODE, SHOW_SIGN_IN), bench.model.content.actions)
        // The words never say a message was sent to this number.
        assertEquals(bench.model.strings.ways.smsPrompt, bench.model.content.subtitle)

        bench.engine.post("$SIGN_IN/first-factor/prepare") { ok(attemptJson(textedFirst(sent = true))) }
        bench.tap(SEND_TEXTED_CODE)
        assertEquals(TulaAuthScreen.TextedCode(MASKED_NUMBER), bench.screen)
        assertTrue(bench.engine.sent("$SIGN_IN/first-factor/prepare").single().body.orEmpty().contains("sms_code"))
        val field = bench.model.content.fields.single()
        assertEquals(TulaAuthFieldKind.SMS_CODE, field.kind)

        // A wrong code is said about the code, in this screen's words, and read again.
        bench.engine.post("$SIGN_IN/first-factor/attempt") { refused("auth.invalid_credentials", 401) }
        bench.type(CODE, "000000")
        bench.tap(SUBMIT_CODE)
        assertEquals(listOf(bench.model.strings.ways.smsCodeWrong), bench.state.fieldErrors[CODE])
        assertEquals("", bench.state.code)
        assertEquals(TulaAuthFocus.Field(CODE), bench.state.focus)
        assertFalse(bench.everythingSaid().contains(SERVER_WORDS))

        bench.tap(RESEND_CODE)
        assertEquals(bench.model.strings.ways.smsResent, bench.state.status)

        bench.engine.post("$SIGN_IN/first-factor/attempt") { completed() }
        bench.type(CODE, "123456")
        bench.tap(SUBMIT_CODE)
        assertEquals(TulaAuthScreen.SignedIn, bench.screen)
        assertTrue(bench.engine.sent("$SIGN_IN/first-factor/attempt").last().body.orEmpty().contains("sms_code"))
    }

    @Test
    fun `an address is never shown the texted code, and where only a texted code signs in an address is refused at the field`() = runTest {
        val address = Bench()
        address.onPassword(textedFirst())
        assertEquals(TulaAuthScreen.Password(canEmailCode = false), address.screen)
        assertFalse(SEND_TEXTED_CODE in address.model.content.actions)

        val only = Bench()
        only.engine.post(SIGN_INS) { ok(attemptJson(firstFactor("sms_code", "passkey"))) }
        only.begin()
        assertEquals(TulaAuthScreen.SignInStart, only.screen)
        assertEquals(listOf(only.model.strings.ways.numberForm), only.state.fieldErrors[EMAIL])
        assertEquals(TulaAuthFocus.Field(EMAIL), only.state.focus)
        assertFalse(only.state.isPending)
        // The same form takes a number next.
        only.engine.post(SIGN_INS) { ok(attemptJson(firstFactor("sms_code"))) }
        only.begin(NUMBER)
        assertEquals(TulaAuthScreen.TextedCodeOffer(), only.screen)
    }

    @Test
    fun `a texted code an operator switched off takes its button away and leaves the sentence`() = runTest {
        for (code in listOf("sms.disabled", "auth.method_disabled", "sms.country_not_allowed")) {
            val bench = Bench()
            bench.engine.post(SIGN_INS) { ok(attemptJson(textedFirst())) }
            bench.begin(NUMBER)
            bench.engine.post("$SIGN_IN/first-factor/prepare") { refused(code, 403) }
            bench.tap(SEND_TEXTED_CODE)
            assertEquals(TulaAuthScreen.TextedCodeOffer(unavailable = true), bench.screen, code)
            assertEquals(bench.model.strings.message(code), bench.state.formError, code)
            assertNull(bench.model.content.primary, code)
            bench.tap(SEND_TEXTED_CODE)
            assertEquals(1, bench.engine.sent("$SIGN_IN/first-factor/prepare").size, code)
        }
        // A sender that failed may work next time: the button stays.
        val later = Bench()
        later.engine.post(SIGN_INS) { ok(attemptJson(textedFirst())) }
        later.begin(NUMBER)
        later.engine.post("$SIGN_IN/first-factor/prepare") { refused("sms.unavailable", 503) }
        later.tap(SEND_TEXTED_CODE)
        assertEquals(TulaAuthScreen.TextedCodeOffer(), later.screen)
        assertNotNull(later.model.content.primary)
    }

    // The second step

    @Test
    fun `an authenticator's code - incomplete, wrong, replayed, locked, right`() = runTest {
        val bench = Bench()
        bench.onPassword(SECOND_FACTOR)
        assertEquals(TulaAuthScreen.SecondFactor(TulaSecondWay.TOTP), bench.screen)
        assertEquals("Two-step verification", bench.model.content.title)
        assertEquals(setOf(SUBMIT_CODE, START_AGAIN), bench.model.content.actions)

        bench.type(CODE, "123")
        bench.tap(SUBMIT_CODE)
        assertEquals(listOf(bench.model.strings.codeIncomplete), bench.state.fieldErrors[CODE])
        assertEquals(emptyList(), bench.engine.sent(SECOND))

        // Wrong, and the same code again (a time step is accepted once): the same answer, said
        // at the field in the second step's own words.
        for (code in listOf("auth.invalid_credentials", "mfa.invalid_code")) {
            bench.engine.post(SECOND) { refused(code, 401) }
            bench.type(CODE, "123456")
            bench.tap(SUBMIT_CODE)
            assertEquals(listOf("That code is incorrect."), bench.state.fieldErrors[CODE], code)
            assertEquals("", bench.state.code, code)
            assertEquals(TulaAuthFocus.Field(CODE), bench.state.focus, code)
        }
        assertTrue(bench.engine.sent(SECOND).first().body.orEmpty().contains("\"totp\""))

        // Locked: said above the form, with the wait.
        bench.engine.post(SECOND) { refused("rate_limited", 429, headers = mapOf("retry-after" to "42")) }
        bench.type(CODE, "123456")
        bench.tap(SUBMIT_CODE)
        assertTrue(bench.state.formError.orEmpty().endsWith(" Try again in 42s."), bench.state.formError)
        assertEquals(TulaAuthScreen.SecondFactor(TulaSecondWay.TOTP), bench.screen)
        assertFalse(bench.everythingSaid().contains(SERVER_WORDS))

        bench.engine.post(SECOND) { completed() }
        bench.type(CODE, "123456")
        bench.tap(SUBMIT_CODE)
        assertEquals(TulaAuthScreen.SignedIn, bench.screen)
        assertEquals(1, bench.signedIn.get())
    }

    @Test
    fun `the ways of the second step are offered in one order, the open one stays open, and a passkey only with a sheet`() = runTest {
        val bench = Bench(passkeys = ScriptedPasskeySheet())
        bench.onPassword(secondFactor("backup_code", "sms_code", "passkey", "totp", "retina"))
        assertEquals(
            TulaAuthScreen.SecondFactor(
                TulaSecondWay.TOTP,
                listOf(TulaSecondWay.PASSKEY, TulaSecondWay.TEXTED_CODE, TulaSecondWay.BACKUP_CODE),
            ),
            bench.screen,
        )
        assertEquals(
            listOf("tula.link.way.passkey", "tula.link.way.sms_code", "tula.link.way.backup_code", "tula.link.startAgain"),
            bench.model.content.links.map { it.identifier },
        )
        // What was typed for the way that is left is emptied.
        bench.type(CODE, "123456")
        bench.tap(USE_WAY_BACKUP_CODE)
        val backup = assertIs<TulaAuthScreen.SecondFactor>(bench.screen)
        assertEquals(TulaSecondWay.BACKUP_CODE, backup.way)
        assertEquals(listOf(TulaSecondWay.TOTP, TulaSecondWay.PASSKEY, TulaSecondWay.TEXTED_CODE), backup.others)
        assertEquals("", bench.state.code)
        assertEquals(TulaAuthFocus.Title, bench.state.focus)
        // A way the open screen does not offer does nothing.
        bench.tap(USE_WAY_BACKUP_CODE)
        assertEquals(backup, bench.screen)

        // A refused code leaves the chosen way open.
        bench.engine.post(SECOND) { refused("auth.invalid_credentials", 401) }
        bench.type(BACKUP_CODE, "aaaaa-bbbbb")
        bench.tap(SUBMIT_BACKUP_CODE)
        assertEquals(backup, bench.screen)
        assertEquals(listOf("That code is incorrect."), bench.state.fieldErrors[BACKUP_CODE])
        bench.tap(USE_WAY_TOTP)
        assertEquals(TulaSecondWay.TOTP, assertIs<TulaAuthScreen.SecondFactor>(bench.screen).way)

        // No sheet: a passkey is not among the ways, and alone it is "not supported".
        val none = Bench()
        none.onPassword(secondFactor("passkey", "totp"))
        assertEquals(TulaAuthScreen.SecondFactor(TulaSecondWay.TOTP), none.screen)
        assertFalse(USE_WAY_PASSKEY in none.model.content.actions)
    }

    @Test
    fun `a backup code is emptied as it is sent, and an empty one is asked for`() = runTest {
        val bench = Bench()
        bench.onPassword(secondFactor("totp", "backup_code"))
        bench.tap(USE_WAY_BACKUP_CODE)
        val field = bench.model.content.fields.single()
        assertEquals(TulaAuthFieldKind.BACKUP_CODE, field.kind)
        assertEquals("tula.field.backup_code", field.identifier)
        bench.tap(SUBMIT_BACKUP_CODE)
        assertEquals(listOf(bench.model.strings.secondStep.backupRequired), bench.state.fieldErrors[BACKUP_CODE])
        assertEquals(emptyList(), bench.engine.sent(SECOND))

        val gate = Gate()
        bench.engine.post(SECOND) {
            gate.pass()
            completed()
        }
        bench.type(BACKUP_CODE, " aaaaa-bbbbb ")
        val tap = launch { bench.tap(SUBMIT_BACKUP_CODE) }
        gate.reached()
        assertEquals("", bench.state.backupCode)
        assertTrue(bench.state.isPending)
        gate.open()
        tap.join()
        assertEquals(TulaAuthScreen.SignedIn, bench.screen)
        assertTrue(bench.engine.sent(SECOND).single().body.orEmpty().contains("\"aaaaa-bbbbb\""))
        // A field keeps no more than a code could be.
        bench.model.setText(BACKUP_CODE, "x".repeat(100))
        assertEquals(TulaAuthModel.BACKUP_CODE_MAX, bench.state.backupCode.length)
    }

    @Test
    fun `a texted second step is asked for with a button, and its code field is there only after a send`() = runTest {
        val bench = Bench()
        bench.onPassword(secondFactor("sms_code"))
        assertEquals(TulaAuthScreen.SecondFactor(TulaSecondWay.TEXTED_CODE), bench.screen)
        assertEquals(emptyList(), bench.engine.sent("$SECOND/prepare"))
        assertEquals(emptyList(), bench.model.content.fields)
        assertEquals(setOf(SEND_TEXTED_CODE, START_AGAIN), bench.model.content.actions)
        // Nothing to submit or to send again before a message went.
        bench.tap(SUBMIT_CODE)
        bench.tap(RESEND_CODE)
        assertEquals(emptyList(), bench.engine.paths().filter { it.startsWith(SECOND) })

        bench.engine.post("$SECOND/prepare") { ok(attemptJson(secondFactor("sms_code", sent = true))) }
        bench.tap(SEND_TEXTED_CODE)
        assertEquals(TulaAuthScreen.SecondFactor(TulaSecondWay.TEXTED_CODE, sent = MASKED_NUMBER), bench.screen)
        assertEquals(TulaAuthFieldKind.SMS_CODE, bench.model.content.fields.single().kind)
        assertTrue(bench.model.content.subtitle.orEmpty().contains(MASKED_NUMBER))
        bench.tap(RESEND_CODE)
        assertEquals(bench.model.strings.secondStep.smsResent, bench.state.status)
        assertEquals(2, bench.engine.sent("$SECOND/prepare").size)

        bench.engine.post(SECOND) { completed() }
        bench.type(CODE, "123456")
        bench.tap(SUBMIT_CODE)
        assertEquals(TulaAuthScreen.SignedIn, bench.screen)
        assertTrue(bench.engine.sent(SECOND).single().body.orEmpty().contains("sms_code"))

        // Switched off by an operator: the button goes, the other ways stay.
        val off = Bench()
        off.onPassword(secondFactor("sms_code", "backup_code"))
        off.engine.post("$SECOND/prepare") { refused("sms.disabled", 403) }
        off.tap(SEND_TEXTED_CODE)
        assertEquals(
            TulaAuthScreen.SecondFactor(TulaSecondWay.TEXTED_CODE, listOf(TulaSecondWay.BACKUP_CODE), unavailable = true),
            off.screen,
        )
        assertNull(off.model.content.primary)
        assertEquals(setOf(USE_WAY_BACKUP_CODE, START_AGAIN), off.model.content.actions)
    }

    @Test
    fun `a passkey as the second step - finished, closed, refused`() = runTest {
        val sheet = ScriptedPasskeySheet()
        val bench = Bench(passkeys = sheet)
        bench.onPassword(secondFactor("passkey"))
        assertEquals(TulaAuthScreen.SecondFactor(TulaSecondWay.PASSKEY), bench.screen)
        assertEquals(setOf(USE_SECOND_PASSKEY, START_AGAIN), bench.model.content.actions)
        bench.engine.post("$SECOND/passkey/options") { ok(PASSKEY_OPTIONS) }

        sheet.failure = SheetFailure.DISMISSED
        bench.tap(USE_SECOND_PASSKEY)
        assertEquals(bench.model.strings.ways.passkeyDismissed, bench.state.notice)
        assertNull(bench.state.formError)
        assertEquals(emptyList(), bench.engine.sent(SECOND))

        sheet.failure = null
        bench.engine.post(SECOND) { refused("auth.invalid_credentials", 401) }
        bench.tap(USE_SECOND_PASSKEY)
        assertEquals(bench.model.strings.ways.passkeyRefused, bench.state.formError)
        assertNull(bench.state.notice)

        bench.engine.post(SECOND) { completed() }
        bench.tap(USE_SECOND_PASSKEY)
        assertEquals(TulaAuthScreen.SignedIn, bench.screen)
        assertEquals(1, bench.signedIn.get())
    }

    // An authenticator set up inside a sign-in

    private suspend fun onSetup(bench: Bench) {
        bench.onPassword(ENROLMENT)
        assertEquals(TulaAuthScreen.EnrolmentStart, bench.screen)
        bench.engine.post("$SIGN_IN/factor-enrolment/totp") { ok("""{"secret":"$SETUP_KEY","uri":"$SETUP_URI"}""") }
        bench.tap(START_ENROLMENT)
        assertEquals(TulaAuthScreen.TotpSetup, bench.screen)
    }

    @Test
    fun `an enrolment shows the key, then the backup codes, and tells the app only when the codes were left`() = runTest {
        val bench = Bench()
        bench.onPassword(ENROLMENT)
        assertEquals(bench.model.strings.secondStep.enrolRequired, bench.model.content.subtitle)
        assertEquals(setOf(START_ENROLMENT, START_AGAIN), bench.model.content.actions)
        onSetupFrom(bench)
        val setup = assertNotNull(bench.model.content.setup)
        assertEquals(SETUP_KEY, setup.key)
        assertEquals(SETUP_URI, setup.uri)
        assertEquals(CONFIRM_ENROLMENT, bench.model.content.fields.single().submit)
        // Copied only on a press, through the app's clipboard.
        assertEquals(emptyList(), bench.copied)
        bench.tap(COPY_SETUP_KEY)
        assertEquals(listOf(SETUP_KEY), bench.copied)
        assertEquals("Copied.", bench.state.status)

        // A wrong code keeps the key on the screen.
        bench.engine.post("$SIGN_IN/factor-enrolment/totp/confirm") { refused("mfa.invalid_code", 422) }
        bench.type(CODE, "000000")
        bench.tap(CONFIRM_ENROLMENT)
        assertEquals(listOf("That code is incorrect."), bench.state.fieldErrors[CODE])
        assertEquals(SETUP_KEY, bench.state.setup?.key)
        bench.type(CODE, "12")
        bench.tap(CONFIRM_ENROLMENT)
        assertEquals(listOf(bench.model.strings.codeIncomplete), bench.state.fieldErrors[CODE])

        bench.engine.post("$SIGN_IN/factor-enrolment/totp/confirm") { enrolled() }
        bench.type(CODE, "123456")
        bench.tap(CONFIRM_ENROLMENT)
        assertEquals(TulaAuthScreen.BackupCodes, bench.screen)
        assertNull(bench.state.setup)
        assertEquals(CODES, assertNotNull(bench.model.content.codes).codes)
        // The client is signed in, and the app is not told yet: the codes are shown once.
        assertIs<AuthState.SignedIn>(bench.client.state.value)
        assertEquals(0, bench.signedIn.get())
        assertEquals(setOf(COPY_BACKUP_CODES, SAVED_BACKUP_CODES), bench.model.content.actions)
        bench.tap(COPY_BACKUP_CODES)
        assertEquals(CODES.joinToString("\n"), bench.copied.last())

        bench.tap(SAVED_BACKUP_CODES)
        assertEquals(TulaAuthScreen.SignedIn, bench.screen)
        assertEquals(1, bench.signedIn.get())
        assertEquals(emptyList(), bench.state.backupCodes)
        assertNull(bench.model.content.codes)
        // Nothing is left to copy.
        bench.tap(COPY_BACKUP_CODES)
        bench.tap(COPY_SETUP_KEY)
        assertEquals(2, bench.copied.size)
    }

    private suspend fun onSetupFrom(bench: Bench) {
        bench.engine.post("$SIGN_IN/factor-enrolment/totp") { ok("""{"secret":"$SETUP_KEY","uri":"$SETUP_URI"}""") }
        bench.tap(START_ENROLMENT)
        assertEquals(TulaAuthScreen.TotpSetup, bench.screen)
    }

    @Test
    fun `the setup key and the backup codes are held only while their screen is open, and neither is printed`() = runTest {
        val left = Bench()
        onSetup(left)
        assertEquals("TulaAuthSetup", left.state.setup.toString())
        assertFalse(left.model.content.toString().contains(SETUP_KEY))
        assertFalse(left.state.toString().contains(SETUP_KEY))
        left.tap(START_AGAIN)
        assertEquals(TulaAuthScreen.SignInStart, left.screen)
        assertNull(left.state.setup)
        assertNull(left.model.content.setup)

        // Closed on the codes: they are gone, and the app is told the sign-in is over.
        val closed = Bench()
        onSetup(closed)
        closed.engine.post("$SIGN_IN/factor-enrolment/totp/confirm") { enrolled() }
        closed.type(CODE, "123456")
        closed.tap(CONFIRM_ENROLMENT)
        assertFalse(closed.model.content.toString().contains(CODES.first()))
        assertEquals(0, closed.signedIn.get())
        closed.model.close()
        assertEquals(emptyList(), closed.state.backupCodes)
        assertEquals(1, closed.signedIn.get())
        assertEquals(TulaAuthScreen.SignInStart, closed.screen)
        closed.model.close()
        assertEquals(1, closed.signedIn.get())
    }

    @Test
    fun `an enrolment whose session could not be stored still shows the codes, and says so once they were left`() = runTest {
        val storage = TestStorage()
        val bench = Bench(storage = storage)
        onSetup(bench)
        bench.engine.post("$SIGN_IN/factor-enrolment/totp/confirm") { enrolled() }
        storage.failWrites = true
        bench.type(CODE, "123456")
        bench.tap(CONFIRM_ENROLMENT)
        assertEquals(TulaAuthScreen.BackupCodes, bench.screen)
        assertEquals(CODES, bench.state.backupCodes)
        assertNull(bench.state.formError)
        bench.tap(SAVED_BACKUP_CODES)
        assertEquals(TulaAuthScreen.SignedIn, bench.screen)
        assertEquals(bench.model.strings.sessionNotSaved, bench.state.formError)
        assertEquals(1, bench.signedIn.get())
        assertFalse(bench.everythingSaid().contains("canary-store-text"))
    }

    @Test
    fun `a setup or a confirmation answered after the screen was left shows no key and no codes, and a completion is still said`() = runTest {
        val bench = Bench()
        bench.onPassword(ENROLMENT)
        val gate = Gate()
        bench.engine.post("$SIGN_IN/factor-enrolment/totp") {
            gate.pass()
            ok("""{"secret":"$SETUP_KEY","uri":"$SETUP_URI"}""")
        }
        val start = launch { bench.tap(START_ENROLMENT) }
        gate.reached()
        bench.model.showSignUp()
        gate.open()
        start.join()
        assertEquals(TulaAuthScreen.SignUpStart, bench.screen)
        assertNull(bench.state.setup)

        val late = Bench()
        onSetup(late)
        val second = Gate()
        late.engine.post("$SIGN_IN/factor-enrolment/totp/confirm") {
            second.pass()
            enrolled()
        }
        late.type(CODE, "123456")
        val confirm = launch { late.tap(CONFIRM_ENROLMENT) }
        second.reached()
        late.model.close()
        second.open()
        confirm.join()
        // A discarded flow takes nothing from its answer: nobody is signed in, nothing is shown.
        assertEquals(emptyList(), late.state.backupCodes)
        assertNull(late.state.setup)
        assertEquals(TulaAuthScreen.SignInStart, late.screen)
        assertEquals(0, late.signedIn.get())
    }

    @Test
    fun `an enrolment that does not complete the sign-in goes on to the step the server asks for`() = runTest {
        val bench = Bench()
        onSetup(bench)
        bench.engine.post("$SIGN_IN/factor-enrolment/totp/confirm") { enrolled(EXPIRED) }
        bench.type(CODE, "123456")
        bench.tap(CONFIRM_ENROLMENT)
        assertEquals(TulaAuthScreen.BackupCodes, bench.screen)
        bench.tap(SAVED_BACKUP_CODES)
        assertEquals(TulaAuthScreen.ExpiredPassword, bench.screen)
        assertEquals(0, bench.signedIn.get())
        assertEquals(emptyList(), bench.state.backupCodes)
    }

    @Test
    fun `no string of the nested tables is empty, and none says a device is trusted or verified`() {
        val strings = TulaStrings()
        var count = 0
        for (table in listOf<Any>(strings.ways, strings.secondStep, strings.account)) {
            for (field in table.javaClass.declaredFields.filter { it.type == String::class.java }) {
                field.isAccessible = true
                val text = field.get(table) as String
                assertTrue(text.isNotEmpty(), field.name)
                for (claim in listOf("trusted device", "verified device", "device verification")) {
                    assertFalse(text.lowercase().contains(claim), field.name)
                }
                count += 1
            }
        }
        assertTrue(count > 150, "$count strings")
        assertEquals("Bound to a device key", strings.account.deviceBound)
        assertTrue(strings.ways.providers.values.none { it.isEmpty() })
    }
}
