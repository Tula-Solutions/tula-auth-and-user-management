package dev.tula.auth.ui

import dev.tula.auth.TulaError
import dev.tula.auth.TulaFieldError
import dev.tula.auth.generated.TulaErrorDefinitions
import dev.tula.auth.generated.TulaThemeDefaults
import dev.tula.auth.ui.TulaAuthAction.RESEND_CODE
import dev.tula.auth.ui.TulaAuthAction.SEND_EMAIL_CODE
import dev.tula.auth.ui.TulaAuthAction.SHOW_RESET
import dev.tula.auth.ui.TulaAuthAction.SHOW_SIGN_IN
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
import dev.tula.auth.ui.TulaThemeValueType.COLOR
import dev.tula.auth.ui.TulaThemeValueType.FONT_FAMILY
import dev.tula.auth.ui.TulaThemeValueType.LENGTH
import dev.tula.auth.ui.TulaThemeValueType.SHADOW
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.io.File
import kotlin.math.abs
import kotlin.math.pow
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** What each screen offers, the strings, and the theme: the data a view draws, with no view. */
class ContentAndThemeTest {
    private val strings = TulaStrings()

    private fun content(screen: TulaAuthScreen, appName: String? = null, optional: Boolean = false) =
        TulaAuthContent.of(screen, strings, appName, optional, ADDRESS)

    private val everyScreen: List<TulaAuthScreen> = listOf(
        TulaAuthScreen.SignInStart, TulaAuthScreen.SignUpStart, TulaAuthScreen.ResetStart,
        TulaAuthScreen.Password(true), TulaAuthScreen.Password(false), TulaAuthScreen.EmailCodeOffer,
        TulaAuthScreen.EmailCode(MASKED, true), TulaAuthScreen.EmailCode(MASKED, false),
        TulaAuthScreen.EmailVerification(MASKED), TulaAuthScreen.NewPassword(MASKED),
        TulaAuthScreen.ExpiredPassword, TulaAuthScreen.SignedIn, TulaAuthScreen.NotSupported("needs_second_factor"),
    )

    // What a screen offers

    @Test
    fun `what every screen offers, and what each offer does`() {
        data class Row(
            val screen: TulaAuthScreen,
            val title: String,
            val fields: List<TulaAuthField>,
            val primary: TulaAuthAction?,
            val links: List<Pair<String, TulaAuthAction>>,
            val identity: Boolean = false,
        )
        val rows = listOf(
            Row(TulaAuthScreen.SignInStart, "Sign in", listOf(EMAIL), START, listOf("tula.link.signUp" to SHOW_SIGN_UP)),
            Row(TulaAuthScreen.SignUpStart, "Create your account", listOf(EMAIL, PASSWORD), START, listOf("tula.link.signIn" to SHOW_SIGN_IN)),
            Row(TulaAuthScreen.ResetStart, "Reset your password", listOf(EMAIL), START, listOf("tula.link.signIn" to SHOW_SIGN_IN)),
            Row(
                TulaAuthScreen.Password(true), "Enter your password", listOf(PASSWORD), SUBMIT_PASSWORD,
                listOf("tula.link.emailCode" to SEND_EMAIL_CODE, "tula.link.reset" to SHOW_RESET), identity = true,
            ),
            Row(
                TulaAuthScreen.Password(false), "Enter your password", listOf(PASSWORD), SUBMIT_PASSWORD,
                listOf("tula.link.reset" to SHOW_RESET), identity = true,
            ),
            Row(TulaAuthScreen.EmailCodeOffer, "Check your email", emptyList(), SEND_EMAIL_CODE, emptyList(), identity = true),
            Row(
                TulaAuthScreen.EmailCode(MASKED, true), "Check your email", listOf(CODE), SUBMIT_CODE,
                listOf("tula.link.resend" to RESEND_CODE, "tula.link.password" to USE_PASSWORD), identity = true,
            ),
            Row(
                TulaAuthScreen.EmailCode(MASKED, false), "Check your email", listOf(CODE), SUBMIT_CODE,
                listOf("tula.link.resend" to RESEND_CODE), identity = true,
            ),
            Row(
                TulaAuthScreen.EmailVerification(MASKED), "Check your email", listOf(CODE), SUBMIT_CODE,
                listOf("tula.link.resend" to RESEND_CODE, "tula.link.back" to START_AGAIN),
            ),
            Row(
                TulaAuthScreen.NewPassword(MASKED), "Choose a new password", listOf(CODE, NEW_PASSWORD), SUBMIT_NEW_PASSWORD,
                listOf("tula.link.resend" to RESEND_CODE, "tula.link.signIn" to SHOW_SIGN_IN),
            ),
            Row(TulaAuthScreen.ExpiredPassword, "Your password has expired", listOf(NEW_PASSWORD), SUBMIT_NEW_PASSWORD, emptyList()),
            Row(TulaAuthScreen.SignedIn, "You are signed in.", emptyList(), null, emptyList()),
            Row(TulaAuthScreen.NotSupported("x"), "This step is not supported", emptyList(), START_AGAIN, emptyList()),
        )
        assertEquals(everyScreen.size, rows.size, "a screen that is added gets a row")
        for (row in rows) {
            val made = content(row.screen)
            val name = row.screen.toString()
            assertEquals(row.title, made.title, name)
            assertEquals(row.fields, made.fields.map { it.field }, name)
            assertEquals(row.fields, row.screen.fields, name)
            assertEquals(row.primary, made.primary?.action, name)
            assertEquals(row.links, made.links.map { it.identifier to it.action }, name)
            assertEquals(row.identity, made.identity != null, name)
            // The keyboard's "done" is the main button.
            assertTrue(made.fields.all { it.submit == row.primary }, name)
            made.primary?.let { assertEquals("tula.primary", it.identifier, name) }
            made.identity?.let {
                assertEquals("tula.link.change", it.identifier, name)
                assertEquals(SHOW_SIGN_IN, it.action, name)
                assertEquals("Signing in as $ADDRESS", it.lead, name)
            }
            // No screen is a blank card: each has a title, and a way on unless it is the end.
            assertTrue(made.title.isNotEmpty(), name)
            assertTrue(made.subtitle?.isNotEmpty() ?: true, name)
            if (row.screen != TulaAuthScreen.SignedIn) {
                assertNotNull(made.primary, name)
            }
        }
    }

    @Test
    fun `the fields say what they ask of the keyboard`() {
        fun kinds(screen: TulaAuthScreen) = content(screen).fields.associate { it.identifier to it.kind }
        assertEquals(mapOf("tula.field.email" to TulaAuthFieldKind.EMAIL), kinds(TulaAuthScreen.SignInStart))
        // A password that is being chosen is a new one, at a sign-up too.
        assertEquals(TulaAuthFieldKind.NEW_PASSWORD, kinds(TulaAuthScreen.SignUpStart)["tula.field.password"])
        assertEquals(TulaAuthFieldKind.PASSWORD, kinds(TulaAuthScreen.Password(false))["tula.field.password"])
        assertEquals(
            mapOf("tula.field.code" to TulaAuthFieldKind.CODE, "tula.field.new_password" to TulaAuthFieldKind.NEW_PASSWORD),
            kinds(TulaAuthScreen.NewPassword(MASKED)),
        )
        assertEquals("6 digits", content(TulaAuthScreen.EmailVerification(MASKED)).fields.single().hint)
    }

    @Test
    fun `the words that depend on the environment`() {
        assertEquals("Welcome back", content(TulaAuthScreen.SignInStart).subtitle)
        assertEquals("to continue to Acme", content(TulaAuthScreen.SignInStart, appName = "Acme").subtitle)
        // A name is a value: it is put in once, and what it holds is not read as a placeholder.
        assertEquals("to continue to {appName}{x}", content(TulaAuthScreen.SignInStart, appName = "{appName}{x}").subtitle)
        val required = content(TulaAuthScreen.SignUpStart).fields[1]
        assertEquals("Password" to null, required.label to required.hint)
        val optional = content(TulaAuthScreen.SignUpStart, optional = true).fields[1]
        assertEquals("Password (optional)", optional.label)
        assertEquals("Leave it empty to sign in with a code we email you instead.", optional.hint)
        assertEquals("Enter the 6-digit code we sent to $MASKED.", content(TulaAuthScreen.EmailCode(MASKED, false)).subtitle)
        assertEquals("Enter the 6-digit code we sent to $MASKED.", content(TulaAuthScreen.EmailVerification(MASKED)).subtitle)
        assertEquals(
            "Enter the 6-digit code we sent to $MASKED and a new password.",
            content(TulaAuthScreen.NewPassword(MASKED)).subtitle,
        )
    }

    @Test
    fun `a signed-in screen, and no other, offers nothing`() {
        for (screen in everyScreen) {
            val actions = content(screen).actions
            assertEquals(screen == TulaAuthScreen.SignedIn, actions.isEmpty(), screen.toString())
        }
    }

    @Test
    fun `an app's strings are what a screen says`() {
        val own = TulaStrings(signInTitle = "Welcome", continueButton = "Next", noAccount = "", signUpLink = "Join")
        val made = TulaAuthContent.of(TulaAuthScreen.SignInStart, own)
        assertEquals("Welcome", made.title)
        assertEquals("Next", made.primary?.title)
        assertEquals("Join", made.links.single().title)
    }

    // The one door

    @Test
    fun `every action is performed through the one door`() = runTest {
        // Each offer of each screen a sign-in passes does what its row says.
        val bench = Bench()
        assertEquals(setOf(START, SHOW_SIGN_UP), bench.model.content.actions)
        bench.tap(SHOW_SIGN_UP)
        assertEquals(TulaAuthScreen.SignUpStart, bench.screen)
        bench.tap(SHOW_SIGN_IN)
        assertEquals(TulaAuthScreen.SignInStart, bench.screen)
        bench.onPassword(firstFactor("password", "email_code"))
        assertEquals(TulaAuthScreen.Password(canEmailCode = true), bench.screen)
        assertEquals(setOf(SUBMIT_PASSWORD, SEND_EMAIL_CODE, SHOW_RESET, SHOW_SIGN_IN), bench.model.content.actions)
        bench.engine.post("$SIGN_IN/first-factor/prepare") {
            ok(attemptJson(firstFactor("password", "email_code", prepared = true)))
        }
        bench.tap(SEND_EMAIL_CODE)
        assertEquals(TulaAuthScreen.EmailCode(MASKED, canUsePassword = true), bench.screen)
        bench.tap(RESEND_CODE)
        assertEquals("A new email is on its way.", bench.state.status)
        bench.tap(USE_PASSWORD)
        assertEquals(TulaAuthScreen.Password(canEmailCode = true), bench.screen)
        bench.tap(SHOW_RESET)
        assertEquals(TulaAuthScreen.ResetStart, bench.screen)
        bench.engine.post(RESETS) { ok(attemptJson(RESET_STEP, "password_reset")) }
        bench.tap(START)
        assertEquals(TulaAuthScreen.NewPassword(MASKED), bench.screen)
        bench.engine.post("$RESET/resend-code") { ok(attemptJson(RESET_STEP, "password_reset")) }
        bench.tap(RESEND_CODE)
        assertEquals("A new code is on its way.", bench.state.status)
        bench.engine.post("$RESET/password") { completed("password_reset") }
        bench.type(CODE, "123456")
        bench.type(NEW_PASSWORD, "another-password-nobody-uses")
        bench.tap(SUBMIT_NEW_PASSWORD)
        assertEquals(TulaAuthScreen.SignedIn, bench.screen)
        // A step with no form: its one offer starts again.
        val unknown = Bench()
        unknown.onPassword(SECOND_FACTOR)
        assertEquals(TulaAuthScreen.NotSupported("needs_second_factor"), unknown.screen)
        assertEquals(setOf(START_AGAIN), unknown.model.content.actions)
        unknown.tap(START_AGAIN)
        assertEquals(TulaAuthScreen.SignInStart, unknown.screen)
    }

    @Test
    fun `an action the open screen does not offer does nothing`() = runTest {
        for (action in TulaAuthAction.entries) {
            val bench = Bench()
            bench.onPassword()
            val before = bench.state
            val sent = bench.engine.paths().size
            if (action in bench.model.content.actions) {
                continue
            }
            bench.tap(action)
            assertEquals(before, bench.state, action.name)
            assertEquals(sent, bench.engine.paths().size, action.name)
        }
        // The signed-in screen offers nothing, so nothing does anything.
        val done = Bench()
        done.onPassword()
        done.engine.post("$SIGN_IN/password") { completed() }
        done.type(PASSWORD, "a-password-nobody-uses")
        done.tap(SUBMIT_PASSWORD)
        val sent = done.engine.paths().size
        TulaAuthAction.entries.forEach { done.tap(it) }
        assertEquals(TulaAuthScreen.SignedIn, done.screen)
        assertEquals(sent, done.engine.paths().size)
    }

    @Test
    fun `the main button of a closed screen says what is missing`() = runTest {
        val bench = Bench()
        bench.onPassword()
        bench.model.close()
        val primary = assertNotNull(bench.model.content.primary)
        assertEquals(START, primary.action, "a closed screen offers the start, not the step it was on")
        bench.tap(primary.action)
        assertEquals(listOf("This field is required."), bench.state.fieldErrors[EMAIL])
        assertEquals("This field is required.", bench.said.last())
        // And with an address it signs in: the screen that came back works.
        bench.type(EMAIL, ADDRESS)
        bench.tap(primary.action)
        assertEquals(TulaAuthScreen.Password(canEmailCode = false), bench.screen)
        assertEquals(2, bench.engine.sent(SIGN_INS).size)
    }

    @Test
    fun `a problem is worded as one, for the eye and for a screen reader`() = runTest {
        val bench = Bench()
        val field = bench.model.content.fields.single()
        assertEquals("Email address", bench.model.spokenLabel(field))
        assertEquals(emptyList(), bench.model.problems(EMAIL))
        assertNull(bench.model.formProblem)
        bench.tap(START)
        // In words, not only in colour.
        assertEquals(listOf("Error: This field is required."), bench.model.problems(EMAIL))
        assertEquals("Email address, invalid: This field is required.", bench.model.spokenLabel(field))
        bench.engine.post(SIGN_INS) { refused("rate_limited", 429) }
        bench.begin()
        assertTrue(assertNotNull(bench.model.formProblem).startsWith("Error: "))
        // An app's own wording of both.
        val own = Bench(strings = TulaStrings(errorPrefix = "Problem: {message}", fieldInvalid = "{label} ({message})"))
        own.tap(START)
        assertEquals(listOf("Problem: This field is required."), own.model.problems(EMAIL))
        assertEquals("Email address (This field is required.)", own.model.spokenLabel(own.model.content.fields.single()))
    }

    // Strings

    @Test
    fun `placeholders are filled once, and a value is never read again`() {
        assertEquals("to a, b", TulaStrings.format("to {x}, {y}", mapOf("x" to "a", "y" to "b")))
        assertEquals("{y} and b", TulaStrings.format("{x} and {y}", mapOf("x" to "{y}", "y" to "b")))
        assertEquals("kept {unknown} as written", TulaStrings.format("kept {unknown} as written", emptyMap()))
        assertEquals("an open { and a", TulaStrings.format("an open { and {x}", mapOf("x" to "a")))
        assertEquals("no close {x", TulaStrings.format("no close {x", mapOf("x" to "a")))
        assertEquals("", TulaStrings.format("", mapOf("x" to "a")))
        assertEquals("aa", TulaStrings.format("{x}{x}", mapOf("x" to "a")))
    }

    @Test
    fun `a wait is said in words`() {
        assertEquals("42s", strings.duration(42_000))
        assertEquals("1s", strings.duration(1), "a part of a second is rounded up")
        assertEquals("0s", strings.duration(0))
        assertEquals("0s", strings.duration(-5))
        assertEquals("4m 12s", strings.duration(252_000))
        assertEquals("1m 0s", strings.duration(59_001))
        assertEquals("1440m 0s", strings.duration(Long.MAX_VALUE), "a wait is bounded to a day")
        assertEquals("7 sec", TulaStrings(seconds = "{seconds} sec").duration(7_000))
    }

    @Test
    fun `an error is worded by its code`() {
        fun error(code: String, params: Map<String, Any> = emptyMap()) =
            TulaError(code, SERVER_WORDS, 400, params, emptyList(), null)
        assertEquals("The email or password is incorrect.", strings.message(error("auth.invalid_credentials")))
        // A code this version does not know: never the server's own words.
        assertEquals("Something went wrong. Try again.", strings.message(error("made.up_code")))
        val own = TulaStrings(errors = mapOf("auth.invalid_credentials" to "No match.", "made.up_code" to "Known here: {n}"))
        assertEquals("No match.", own.message(error("auth.invalid_credentials")))
        assertEquals("Known here: 3", own.message(error("made.up_code", mapOf("n" to 3))))
        // A field's problem the same way: the client hands on the server's text, which is not read.
        val problem = TulaFieldError("password", "password.too_short", SERVER_WORDS, mapOf("min" to 10))
        assertFalse(strings.message(problem).contains(SERVER_WORDS))
        assertEquals("Something went wrong. Try again.", strings.message(TulaFieldError("password", "made.up_code", SERVER_WORDS, emptyMap())))
        // The client's own codes have a sentence too.
        for (code in listOf("network.failed", "network.timeout", "response.invalid", "storage.failed", "flow.busy")) {
            val said = strings.message(error(code))
            assertTrue(said.isNotEmpty() && said != strings.unknownError, code)
        }
    }

    @Test
    fun `every code of the contract has a sentence`() {
        assertTrue(TulaErrorDefinitions.all.size > 50)
        for (definition in TulaErrorDefinitions.all) {
            val code = definition.code.rawValue
            val said = strings.message(TulaError(code, SERVER_WORDS, definition.status, emptyMap(), emptyList(), null))
            assertTrue(said.isNotEmpty(), code)
            assertFalse(said.contains(SERVER_WORDS), code)
            assertTrue(said != strings.unknownError, code)
        }
    }

    @Test
    fun `the English table is the default, and no string is empty`() {
        val table = TulaStrings::class.java.declaredFields.filter { it.type == String::class.java }
        assertTrue(table.size > 60)
        for (field in table) {
            field.isAccessible = true
            assertTrue((field.get(strings) as String).isNotEmpty(), field.name)
        }
        assertEquals(emptyMap(), strings.errors)
        assertEquals("Sign in", strings.signInTitle)
        // Nothing of the table is printed with a client's or a model's state.
        assertEquals("TulaAuthState", TulaAuthState(TulaAuthScreen.SignInStart).copy(password = "canary").toString())
        assertEquals("TulaAuthModel", Bench().model.toString())
    }

    // The grammar

    @Test
    fun `what the grammar accepts`() {
        val rows = listOf(
            COLOR to "#5b4cf0", COLOR to "#FFF", COLOR to "rgb(0, 0, 0)", COLOR to "rgba(15 23 42 / 0.5)",
            COLOR to "hsl(210 40% 96%)", COLOR to "transparent", COLOR to "rebeccapurple", COLOR to "  #fff  ",
            LENGTH to "0", LENGTH to "12px", LENGTH to "0.75rem", LENGTH to ".5em", LENGTH to "100%", LENGTH to "-2px",
            FONT_FAMILY to "ui-sans-serif, system-ui", FONT_FAMILY to "\"Inter Tight\", sans-serif",
            FONT_FAMILY to "'IBM Plex Mono'", SHADOW to "none", SHADOW to "0 1px 2px rgba(0, 0, 0, 0.1)",
            SHADOW to "0 1px 2px rgb(0 0 0 / 0.1), inset 0 0 0 1px #fff",
        )
        for ((type, value) in rows) {
            assertTrue(TulaThemeGrammar.isValid(type, value), "${type.rawValue}: $value")
        }
    }

    @Test
    fun `what the grammar refuses`() {
        val rows = listOf(
            COLOR to "", COLOR to "   ", COLOR to "#5b4cf", COLOR to "#ggg", COLOR to "url(https://example.test/x)",
            COLOR to "var(--x)", COLOR to "red; background: blue", COLOR to "expression(alert(1))", COLOR to "#fff}",
            COLOR to "rgb(0,0,0", COLOR to "/* x */ red", COLOR to "re\u0000d", COLOR to "réd", COLOR to "x".repeat(201),
            LENGTH to "12", LENGTH to "px", LENGTH to "12 px", LENGTH to "calc(1px + 1px)", LENGTH to "1e3px",
            FONT_FAMILY to "", FONT_FAMILY to "Inter;", FONT_FAMILY to "\"Inter", FONT_FAMILY to "a,,b",
            FONT_FAMILY to "url(x)", SHADOW to "", SHADOW to "1px", SHADOW to "0 1px red blue", SHADOW to "0 1px 2px 3px 4px red",
            SHADOW to "inset", SHADOW to "0 1px 2px rgb(0 0 0",
        )
        for ((type, value) in rows) {
            assertFalse(TulaThemeGrammar.isValid(type, value), "${type.rawValue}: $value")
        }
    }

    @Test
    fun `the grammar gives the contract's verdict for every value of the shared corpus`() {
        val root = assertNotNull(System.getProperty("tula.repository.root"), "the build names the repository's root")
        val cases = Json.parseToJsonElement(File(root, "packages/contract/src/theme-cases.json").readText()).jsonArray
        assertTrue(cases.size >= 78, "the corpus is the contract's, whole")
        val types = TulaThemeValueType.entries.associateBy { it.rawValue }
        var stricter = 0
        for (case in cases) {
            val row = case.jsonObject
            val type = assertNotNull(types[row.getValue("type").jsonPrimitive.content])
            val value = row.getValue("value").jsonPrimitive.content
            val valid = row.getValue("valid").jsonPrimitive.boolean
            val verdict = TulaThemeGrammar.isValid(type, value)
            if (valid && !verdict) {
                // The one place this copy is stricter: anything outside ASCII is refused.
                assertTrue(value.any { it.code > 0x7F }, "refused, and the contract accepts: ${type.rawValue} [$value]")
                stricter++
            } else {
                assertEquals(valid, verdict, "${type.rawValue} [$value]")
            }
        }
        assertTrue(stricter < cases.size / 10, "stricter for a few rows of Unicode white space, not for a kind of value")
    }

    @Test
    fun `the length cap counts as the contract does`() {
        // 200 UTF-16 code units, white space at the ends included.
        assertTrue(TulaThemeGrammar.isValid(FONT_FAMILY, "a".repeat(200)))
        assertFalse(TulaThemeGrammar.isValid(FONT_FAMILY, "a".repeat(201)))
        assertFalse(TulaThemeGrammar.isValid(FONT_FAMILY, " " + "a".repeat(200)))
        assertEquals(200, TulaThemeGrammar.MAX_LENGTH)
    }

    @Test
    fun `splitting keeps what is in parentheses together`() {
        val comma: (Char) -> Boolean = { it == ',' }
        assertEquals(listOf("a", " rgb(0, 0, 0)", " b"), TulaThemeGrammar.splitOutsideParentheses("a, rgb(0, 0, 0), b", comma))
        assertEquals(listOf("a"), TulaThemeGrammar.splitOutsideParentheses("a", comma))
        assertEquals(listOf("", ""), TulaThemeGrammar.splitOutsideParentheses(",", comma))
        // Unbalanced either way is no list at all.
        assertNull(TulaThemeGrammar.splitOutsideParentheses("rgb(0, 0", comma))
        assertNull(TulaThemeGrammar.splitOutsideParentheses("a), b", comma))
    }

    // What this version draws

    private fun close(a: Double, b: Double) = abs(a - b) < 0.002

    private fun assertColor(value: String, red: Double, green: Double, blue: Double, opacity: Double = 1.0) {
        val color = assertNotNull(TulaColorValue.of(value), value)
        assertTrue(
            close(color.red, red) && close(color.green, green) && close(color.blue, blue) && close(color.opacity, opacity),
            "$value is ${color.red}, ${color.green}, ${color.blue}, ${color.opacity}",
        )
    }

    @Test
    fun `the colours this version draws`() {
        assertColor("#fff", 1.0, 1.0, 1.0)
        assertColor("#FFFFFF", 1.0, 1.0, 1.0)
        assertColor("#0008", 0.0, 0.0, 0.0, 0.533)
        assertColor("#5b4cf0", 0x5b / 255.0, 0x4c / 255.0, 0xf0 / 255.0)
        assertColor("#5b4cf080", 0x5b / 255.0, 0x4c / 255.0, 0xf0 / 255.0, 0.502)
        assertColor("rgb(255, 0, 0)", 1.0, 0.0, 0.0)
        assertColor("rgb(100% 0% 50%)", 1.0, 0.0, 0.5)
        assertColor("rgba(15, 23, 42, 0.5)", 15 / 255.0, 23 / 255.0, 42 / 255.0, 0.5)
        assertColor("rgb(0 0 0 / 25%)", 0.0, 0.0, 0.0, 0.25)
        assertColor("rgb(300, -5, 0)", 1.0, 0.0, 0.0)
        assertColor("hsl(0, 100%, 50%)", 1.0, 0.0, 0.0)
        assertColor("hsl(120deg 100% 50%)", 0.0, 1.0, 0.0)
        assertColor("hsla(240, 100%, 50%, 0.5)", 0.0, 0.0, 1.0, 0.5)
        assertColor("hsl(-120, 100%, 50%)", 0.0, 0.0, 1.0)
        assertColor("hsl(0, 0%, 50%)", 0.5, 0.5, 0.5)
        assertColor("transparent", 0.0, 0.0, 0.0, 0.0)
        assertColor("black", 0.0, 0.0, 0.0)
        assertColor("WHITE", 1.0, 1.0, 1.0)
        assertColor("  #fff ", 1.0, 1.0, 1.0)
        val one = assertNotNull(TulaColorValue.of("#fff"))
        assertEquals(one, TulaColorValue.of("white"))
        assertEquals(one.hashCode(), TulaColorValue.of("rgb(255,255,255)").hashCode())
        assertFalse(one.equals("#fff"))
        assertTrue(one.toString().isNotEmpty())
    }

    @Test
    fun `a colour the grammar accepts and this version cannot draw is refused, not guessed`() {
        val rows = listOf(
            "rebeccapurple", "red", "currentcolor", "hwb(0 0% 0%)", "lab(50% 40 59)", "oklch(60% 0.15 50)",
            "color(display-p3 1 0 0)", "rgb(0, 0)", "rgb(a, b, c)", "rgb(1, 2, 3, 4, 5)", "hsl(0, 100, 50)",
            "hsl(0turn 100% 50%)", "rgb(1.2.3, 0, 0)", "rgb(--1, 0, 0)", "rgb(., 0, 0)", "rgb(0, 0, 0, x)",
        )
        for (value in rows) {
            assertNull(TulaColorValue.of(value), value)
        }
        // And one the grammar refuses is never read at all.
        assertNull(TulaColorValue.of("#fff; x"))
        assertNull(TulaColorValue.of("#12345"))
    }

    @Test
    fun `the lengths this version measures`() {
        fun points(value: String, text: Boolean = false) = TulaResolvedTheme.points(value, text)
        assertEquals(0.0, points("0"))
        assertEquals(12.0, points("12px"))
        assertEquals(12.0, points("12pt"))
        assertEquals(12.0, points("0.75rem"))
        assertEquals(8.0, points(".5em"))
        assertEquals(16.0, points("1REM"))
        assertEquals(200.0, points("200px"))
        // A share of something a native screen does not have.
        for (value in listOf("50%", "2ch", "2ex", "10vw", "10vh", "10vmin", "10vmax")) {
            assertNull(points(value), value)
        }
        assertNull(points("-2px"))
        assertNull(points("201px"))
        assertNull(points("12"))
        assertNull(points("calc(1px)"))
        // A text that could not be read.
        assertNull(points("10px", text = true))
        assertEquals(11.0, points("11px", text = true))
        assertEquals(0.0, points("0", text = false))
        assertNull(points("0", text = true))
    }

    @Test
    fun `the first family decides the typeface`() {
        assertEquals(TulaFontFamily.System, TulaFontFamily.of("ui-sans-serif, system-ui, sans-serif"))
        assertEquals(TulaFontFamily.System, TulaFontFamily.of("Monospace"))
        assertEquals(TulaFontFamily.Named("Inter"), TulaFontFamily.of("Inter, sans-serif"))
        assertEquals(TulaFontFamily.Named("Inter Tight"), TulaFontFamily.of("\"Inter Tight\", sans-serif"))
        assertEquals(TulaFontFamily.Named("IBM Plex Mono"), TulaFontFamily.of(" 'IBM Plex Mono' "))
        assertNull(TulaFontFamily.of("Inter; x"))
        assertNull(TulaFontFamily.of(""))
    }

    // A theme, resolved

    @Test
    fun `the default theme resolves whole`() {
        val theme = TulaResolvedTheme.defaults
        assertEquals(emptyList(), theme.refused)
        assertTrue(theme.radius > 0 && theme.radiusSmall > 0 && theme.spacing > 0)
        assertTrue(theme.fontSizeSmall >= 11 && theme.fontSize > theme.fontSizeSmall && theme.fontSizeTitle > theme.fontSize)
        assertEquals(TulaFontFamily.System, theme.fontFamily)
        assertEquals(TulaFontFamily.System, theme.fontFamilyMono)
        assertTrue(theme.light != theme.dark)
        // Resolving the defaults again is the same value, with nothing refused.
        assertEquals(theme, TulaResolvedTheme.of(TulaThemeDefaults.theme))
        assertEquals(theme, TulaResolvedTheme.of(TulaThemeDefaults.theme.copy()))
    }

    @Test
    fun `every token of the contract is checked, and nothing else`() {
        val scheme = TulaResolvedTheme.COLOR_TOKENS.map { Triple(it.first, "scheme", "color") } +
            TulaResolvedTheme.CHECKED_ONLY.map { Triple(it.first, "scheme", it.third.rawValue) }
        val shared = TulaResolvedTheme.LENGTH_TOKENS.map { Triple(it.first, "shared", "length") } +
            TulaResolvedTheme.FONT_TOKENS.map { Triple(it.first, "shared", "fontFamily") }
        val contract = TulaThemeDefaults.tokens.map { Triple(it.key, it.scope, it.type) }
        assertEquals(contract.toSet(), (scheme + shared).toSet())
        assertEquals(contract.size, scheme.size + shared.size, "no token twice")
    }

    @Test
    fun `an app's values are used`() {
        val base = TulaThemeDefaults.theme
        val theme = base.copy(
            light = base.light.copy(primary = "#0f766e"),
            dark = base.dark.copy(primary = "hsl(0, 100%, 50%)"),
            radius = "4px",
            fontSize = "1.25rem",
            fontFamily = "Inter, sans-serif",
            fontFamilyMono = "'IBM Plex Mono', monospace",
        )
        val resolved = TulaResolvedTheme.of(theme)
        assertEquals(emptyList(), resolved.refused)
        assertEquals(TulaColorValue.of("#0f766e"), resolved.light.primary)
        assertEquals(TulaColorValue.of("#ff0000"), resolved.dark.primary)
        assertEquals(4.0, resolved.radius)
        assertEquals(20.0, resolved.fontSize)
        assertEquals(TulaFontFamily.Named("Inter"), resolved.fontFamily)
        assertEquals(TulaFontFamily.Named("IBM Plex Mono"), resolved.fontFamilyMono)
        // What was not changed is the default's.
        assertEquals(TulaResolvedTheme.defaults.light.background, resolved.light.background)
        assertEquals(TulaResolvedTheme.defaults.spacing, resolved.spacing)
    }

    @Test
    fun `a refused value is replaced by the default, and named by its token, never its value`() {
        val base = TulaThemeDefaults.theme
        val canary = "url(https://canary.example.test/x)"
        val theme = base.copy(
            light = base.light.copy(primary = canary, shadow = "0 1px red blue"),
            dark = base.dark.copy(text = "rebeccapurple", shadow = canary),
            radius = "50%",
            fontSizeSmall = "4px",
            fontFamily = "Inter; $canary",
            fontFamilyMono = canary,
        )
        val resolved = TulaResolvedTheme.of(theme)
        val defaults = TulaResolvedTheme.defaults
        assertEquals(
            listOf("light.primary", "light.shadow", "dark.text", "dark.shadow", "radius", "fontSizeSmall", "fontFamily", "fontFamilyMono"),
            resolved.refused,
        )
        // Never drawn: each is the default's value.
        assertEquals(defaults.light.primary, resolved.light.primary)
        assertEquals(defaults.dark.text, resolved.dark.text)
        assertEquals(defaults.radius, resolved.radius)
        assertEquals(defaults.fontSizeSmall, resolved.fontSizeSmall)
        assertEquals(defaults.fontFamily, resolved.fontFamily)
        assertEquals(defaults.fontFamilyMono, resolved.fontFamilyMono)
        assertEquals(defaults.copy(refused = resolved.refused), resolved)
        assertFalse(resolved.toString().contains("canary"))
        assertFalse(resolved.refused.joinToString().contains("canary"))
    }

    @Test
    fun `the appearance is the scheme the system is in`() {
        val theme = TulaResolvedTheme.defaults
        assertEquals(theme.light, theme.scheme(dark = false))
        assertEquals(theme.dark, theme.scheme(dark = true))
    }

    // Contrast (WCAG 2.2)

    private fun luminance(color: TulaColorValue): Double {
        fun linear(channel: Double) = if (channel <= 0.04045) channel / 12.92 else ((channel + 0.055) / 1.055).pow(2.4)
        return 0.2126 * linear(color.red) + 0.7152 * linear(color.green) + 0.0722 * linear(color.blue)
    }

    private fun contrast(a: TulaColorValue, b: TulaColorValue): Double {
        val light = maxOf(luminance(a), luminance(b))
        val dark = minOf(luminance(a), luminance(b))
        return (light + 0.05) / (dark + 0.05)
    }

    @Test
    fun `the arithmetic is WCAG's`() {
        val black = assertNotNull(TulaColorValue.of("#000"))
        val white = assertNotNull(TulaColorValue.of("#fff"))
        assertTrue(abs(contrast(black, white) - 21) < 0.001)
        assertTrue(abs(contrast(white, white) - 1) < 0.001)
        // #767676 on white is the textbook 4.54:1.
        assertTrue(abs(contrast(assertNotNull(TulaColorValue.of("#767676")), white) - 4.54) < 0.01)
    }

    @Test
    fun `every text of the default theme has contrast on what it is drawn on, in both schemes`() {
        val theme = TulaResolvedTheme.defaults
        for ((name, scheme) in listOf("light" to theme.light, "dark" to theme.dark)) {
            // Text and the surface a screen draws it on: 4.5 to 1 (WCAG 1.4.3).
            val text = listOf(
                Triple("the title and the labels on the background", scheme.text, scheme.background),
                Triple("what is typed, in a field", scheme.text, scheme.input),
                Triple("subtitles, hints and the last line on the background", scheme.textMuted, scheme.background),
                Triple("a link on the background", scheme.link, scheme.background),
                Triple("the main button's words", scheme.primaryText, scheme.primary),
                Triple("the main button's words while it is pressed", scheme.primaryText, scheme.primaryHover),
                Triple("a field's problem on the background", scheme.danger, scheme.background),
                Triple("the form's problem on its surface", scheme.danger, scheme.dangerSurface),
                Triple("a status on the background", scheme.success, scheme.background),
            )
            for ((what, front, behind) in text) {
                assertEquals(1.0, front.opacity, "$name: $what is opaque")
                assertEquals(1.0, behind.opacity, "$name: $what is on something opaque")
                assertTrue(contrast(front, behind) >= 4.5, "$name: $what is ${contrast(front, behind)}")
            }
            // What is not text and must be told apart: 3 to 1 (WCAG 1.4.11).
            val edges = listOf(
                Triple("a field's edge", scheme.borderStrong, scheme.background),
                Triple("the edge of the field with the focus", scheme.focus, scheme.background),
                Triple("the edge of a field with a problem", scheme.danger, scheme.input),
                Triple("the button that shows a password", scheme.textMuted, scheme.input),
            )
            for ((what, front, behind) in edges) {
                assertTrue(contrast(front, behind) >= 3, "$name: $what is ${contrast(front, behind)}")
            }
        }
    }
}
