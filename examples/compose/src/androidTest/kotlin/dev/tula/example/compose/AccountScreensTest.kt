package dev.tula.example.compose

import android.content.Intent
import android.os.Build
import android.os.SystemClock
import android.view.WindowInsets
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.ComposeTimeoutException
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.SemanticsNodeInteraction
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertHeightIsAtLeast
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.isFocused
import androidx.compose.ui.test.junit4.v2.createEmptyComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.unit.dp
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import dev.tula.auth.generated.PasskeyAssertionCredential
import dev.tula.auth.generated.PasskeyCreationOptions
import dev.tula.auth.generated.PasskeyRegistrationCredential
import dev.tula.auth.generated.PasskeyRequestOptions
import dev.tula.auth.PasskeySheet
import dev.tula.auth.SheetFailure
import dev.tula.auth.TulaSheetException
import org.junit.After
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.atomic.AtomicInteger

/**
 * The second step of a sign-in, an authenticator set up inside one, and the account screen, in
 * the example app against the real API: each test is one way through them, read by what a
 * screen reader is told (the semantics tree), in a fresh environment.
 *
 * The codes of an authenticator app are computed here from the setup key, by the server's
 * clock. **A passkey sheet cannot be driven by a test**, so the one test with a passkey gives
 * the app a scripted sheet ([ExampleSheets]) that is closed without a passkey: what is tested
 * is what the screen says of that, not Credential Manager.
 */
@RunWith(AndroidJUnit4::class)
class AccountScreensTest {
    @get:Rule
    val rule = createEmptyComposeRule()

    private lateinit var world: World
    private var scenario: ActivityScenario<MainActivity>? = null

    @Before
    fun makeWorld() {
        ExampleSheets.reset()
        world = World.create()
    }

    @After
    fun giveBack() {
        scenario?.close()
        ExampleSheets.reset()
        world.close()
    }

    private fun launch() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val intent = Intent(context, MainActivity::class.java)
            .putExtra(ExampleConfiguration.EXTRA_API_URL, world.apiUrl)
            .putExtra(ExampleConfiguration.EXTRA_PUBLISHABLE_KEY, world.publishableKey)
        scenario = ActivityScenario.launch(intent)
        waitFor("tula.title")
    }

    private fun waitFor(tag: String) {
        try {
            rule.waitUntil(WAIT_MS) { rule.onAllNodesWithTag(tag).fetchSemanticsNodes().isNotEmpty() }
        } catch (late: ComposeTimeoutException) {
            throw AssertionError("nothing tagged \"$tag\" was drawn; the screen says ${said()}", late)
        }
    }

    private fun waitForGone(tag: String) {
        rule.waitUntil(WAIT_MS) { rule.onAllNodesWithTag(tag).fetchSemanticsNodes().isEmpty() }
    }

    private fun waitForText(text: String) {
        try {
            rule.waitUntil(WAIT_MS) { rule.onAllNodesWithText(text).fetchSemanticsNodes().isNotEmpty() }
        } catch (late: ComposeTimeoutException) {
            throw AssertionError("\"$text\" was not said; the screen says ${said()}", late)
        }
    }

    private fun texts(tag: String): List<String> =
        rule.onAllNodesWithTag(tag).fetchSemanticsNodes().flatMap { node ->
            node.config.getOrNull(SemanticsProperties.Text)?.map { it.text }.orEmpty()
        }

    // The screen's own words (a title, a problem by its code's sentence): nothing typed, no key.
    // Of a code field only how many characters it holds: a field the model emptied was sent,
    // one that still holds its code belongs to an action that never started.
    // And of the main button whether it can be seen now: one that is drawn outside what the
    // screen shows cannot have been pressed where it is.
    private fun said(): Map<String, List<String>> =
        TOLD.associateWith { texts(it) }.filterValues { it.isNotEmpty() } +
            HELD.associateWith { held(it) }.filterValues { it.isNotEmpty() } +
            BUTTONS.associate { "$it, out of sight" to outOfSight(it) }.filterValues { it.isNotEmpty() }

    private fun outOfSight(tag: String): List<String> =
        rule.onAllNodesWithTag(tag).fetchSemanticsNodes().mapNotNull { node ->
            val seen = node.boundsInRoot
            val whole = node.size
            if (seen.width < whole.width || seen.height < whole.height) "${seen.width.toInt()}x${seen.height.toInt()} of ${whole.width}x${whole.height}" else null
        }

    private fun held(tag: String): List<String> =
        rule.onAllNodesWithTag(tag).fetchSemanticsNodes().mapNotNull { node ->
            node.config.getOrNull(SemanticsProperties.EditableText)?.let { "${it.text.length} characters" }
        }

    private fun waitForTitle(title: String) {
        try {
            rule.waitUntil(WAIT_MS) { title in texts("tula.title") }
        } catch (late: ComposeTimeoutException) {
            throw AssertionError("the screen \"$title\" did not open; the screen says ${said()}", late)
        }
    }

    private fun type(tag: String, text: String) = rule.onNodeWithTag(tag).performScrollTo().performTextInput(text)

    private fun tap(tag: String) = still { rule.onNodeWithTag(tag) }.performClick()

    /**
     * Bring a control into sight and hand it back once it can be pressed where it is: whole in
     * sight, not moved for [STILL_MS], and with the keyboard where the focus says it will be.
     *
     * The keyboard is the system's and comes when the system gets to it, some time after a
     * field took the focus; the screen then gets shorter. A press sent before that goes to
     * where the button was: on a long form (a setup key, a QR code, a field, a button) it
     * reached nothing in three of twelve runs, with the code still in its field. A person
     * waits for the screen to stop moving as well.
     */
    private fun still(find: () -> SemanticsNodeInteraction): SemanticsNodeInteraction {
        var last: Rect? = null
        var since = 0L
        var unsettled = 0L
        try {
            rule.waitUntil(WAIT_MS) {
                val node = find().performScrollTo().fetchSemanticsNode()
                val seen = node.boundsInRoot
                val whole = seen.width >= node.size.width - 0.5f && seen.height >= node.size.height - 0.5f
                val now = SystemClock.uptimeMillis()
                if (!whole || seen != last) {
                    last = seen
                    since = now
                    return@waitUntil false
                }
                if (keyboardAsExpected()) {
                    unsettled = 0L
                } else if (unsettled == 0L) {
                    unsettled = now
                }
                // A device that shows no keyboard (a hardware one is attached) never agrees:
                // it is given up on after KEYBOARD_MS, and the press is made as it was before.
                val keyboard = unsettled == 0L || now - unsettled >= KEYBOARD_MS
                keyboard && now - since >= STILL_MS
            }
        } catch (late: ComposeTimeoutException) {
            throw AssertionError("a control could not be brought into sight and kept still; the screen says ${said()}", late)
        }
        return find()
    }

    /** Whether the keyboard is up exactly when a text field has the focus. Not known before API 30. */
    private fun keyboardAsExpected(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
            return true
        }
        val wanted = rule.onAllNodes(isFocused() and hasSetTextAction()).fetchSemanticsNodes().isNotEmpty()
        var shown = wanted
        scenario?.onActivity { activity ->
            activity.window.decorView.rootWindowInsets?.let { shown = it.isVisible(WindowInsets.Type.ime()) }
        }
        return shown == wanted
    }

    private fun typed(tag: String): String? =
        rule.onNodeWithTag(tag).fetchSemanticsNode().config.getOrNull(SemanticsProperties.EditableText)?.text

    private val hasError = SemanticsMatcher.keyIsDefined(SemanticsProperties.Error)

    /** The sign-in's first two screens: the address, then the password. */
    private fun signInWithPassword(email: String) {
        launch()
        type("tula.field.email", email)
        tap("tula.primary")
        waitForTitle("Enter your password")
        type("tula.field.password", PASSWORD)
        tap("tula.primary")
    }

    /** Signed in, with the account screen drawn and its sessions read. */
    private fun openAccount(email: String) {
        signInWithPassword(email)
        waitFor("tula.account")
        rule.onNodeWithTag("example.user").assertTextEquals(email)
        waitForTitle("Account")
        waitForText("This device")
    }

    /** A code of the right form that the authenticator does not show now. */
    private fun wrongCode(secret: String): String {
        val right = world.totp(secret)
        return right.dropLast(1) + ((right.last() - '0' + 1) % 10)
    }

    @Test
    fun theSecondStepRefusesAWrongCodeAtItsFieldAndTakesTheAuthenticators() {
        val email = world.address()
        val (secret, _) = world.accountWithAuthenticator(email, PASSWORD)
        signInWithPassword(email)
        waitForTitle("Two-step verification")
        // The step changed: the focus is on the new screen's title, and nobody is signed in.
        rule.onNodeWithTag("tula.title").assertIsFocused()
        check(rule.onAllNodesWithTag("example.signedIn").fetchSemanticsNodes().isEmpty()) { "signed in before the second step" }
        type("tula.field.code", wrongCode(secret))
        tap("tula.primary")
        waitFor("tula.field.code.error.0")
        rule.onNodeWithTag("tula.field.code.error.0").assertTextEquals("Error: That code is incorrect.")
        rule.onNodeWithTag("tula.field.code").assert(hasError).assertIsFocused()
        check(typed("tula.field.code").isNullOrEmpty()) { "a refused code is still in its field" }
        type("tula.field.code", world.totp(secret))
        tap("tula.primary")
        waitFor("example.signedIn")
        rule.onNodeWithTag("example.user").assertTextEquals(email)
    }

    @Test
    fun theSecondStepTakesABackupCode() {
        val email = world.address()
        val (_, codes) = world.accountWithAuthenticator(email, PASSWORD)
        signInWithPassword(email)
        waitForTitle("Two-step verification")
        // The other way is a link of the screen, large enough to hit.
        still { rule.onNodeWithTag("tula.link.way.backup_code") }.assertHeightIsAtLeast(48.dp).performClick()
        waitFor("tula.field.backup_code")
        type("tula.field.backup_code", codes.first())
        tap("tula.primary")
        waitFor("example.signedIn")
    }

    @Test
    fun anAuthenticatorIsSetUpInsideASignInAndItsKeyAndCodesGoWithTheirScreens() {
        val email = world.address()
        world.account(email, PASSWORD)
        world.settings { it.getJSONObject("mfa").put("policy", "required") }
        signInWithPassword(email)
        waitForTitle("Set up two-step verification")
        // Nothing was asked for by arriving: the key is made when the button is pressed.
        check(rule.onAllNodesWithTag("tula.setup.key").fetchSemanticsNodes().isEmpty()) { "a setup key before it was asked for" }
        tap("tula.primary")
        waitFor("tula.setup.key")
        rule.onNodeWithTag("tula.qr").performScrollTo().assertExists()
        val secret = texts("tula.setup.key").single()
        type("tula.field.code", world.totp(secret))
        tap("tula.primary")
        waitForTitle("Save your backup codes")
        // The key and its QR code went with their screen; the codes are here, and nobody is
        // signed in until they were said to be saved.
        check(rule.onAllNodesWithTag("tula.setup.key").fetchSemanticsNodes().isEmpty()) { "the setup key outlived its screen" }
        check(rule.onAllNodesWithTag("tula.qr").fetchSemanticsNodes().isEmpty()) { "the QR code outlived its screen" }
        check(texts("tula.codes.0").single().isNotEmpty()) { "no backup code is drawn" }
        check(rule.onAllNodesWithTag("example.signedIn").fetchSemanticsNodes().isEmpty()) { "signed in before the codes were saved" }
        tap("tula.primary")
        waitFor("example.signedIn")
        check(rule.onAllNodesWithTag("tula.codes").fetchSemanticsNodes().isEmpty()) { "the backup codes outlived their screen" }
    }

    @Test
    fun theAccountMarksThisDeviceAndSignsAnotherOneOut() {
        val email = world.address()
        world.account(email, PASSWORD)
        world.signedInElsewhere(email, PASSWORD)
        openAccount(email)
        val others = SemanticsMatcher("another session's sign-out") { node ->
            val tag = node.config.getOrNull(SemanticsProperties.TestTag).orEmpty()
            tag.startsWith("tula.account.session.") && tag.endsWith(".signOut")
        }
        rule.waitUntil(WAIT_MS) { rule.onAllNodes(others).fetchSemanticsNodes().size == 1 }
        still { rule.onNode(others) }.assertHeightIsAtLeast(48.dp).performClick()
        waitForText("That device was signed out.")
        rule.waitUntil(WAIT_MS) { rule.onAllNodes(others).fetchSemanticsNodes().isEmpty() }
        // This device is still signed in.
        rule.onNodeWithTag("example.user").assertTextEquals(email)
    }

    @Test
    fun anAuthenticatorIsTurnedOnFromTheAccount() {
        val email = world.address()
        world.account(email, PASSWORD)
        openAccount(email)
        tap("tula.account.factors.turnOn")
        waitFor("tula.setup.key")
        val secret = texts("tula.setup.key").single()
        type("tula.account.field.code", world.totp(secret))
        tap("tula.account.submit")
        waitFor("tula.codes")
        check(rule.onAllNodesWithTag("tula.setup.key").fetchSemanticsNodes().isEmpty()) { "the setup key outlived its form" }
        tap("tula.account.submit")
        waitForGone("tula.codes")
        waitFor("tula.account.factors.turnOff")
    }

    @Test
    fun aChangeAfterTenMinutesAsksToConfirmItIsYouAndThenGoesOn() {
        val email = world.address()
        world.account(email, PASSWORD)
        openAccount(email)
        // The server asks for a recent authentication once the sign-in is older than ten minutes.
        world.advance(11 * 60_000L)
        tap("tula.account.factors.turnOn")
        waitForTitle("Confirm it is you")
        rule.onNodeWithTag("tula.title").assertIsFocused()
        type("tula.account.field.step_up_password", PASSWORD)
        tap("tula.account.submit")
        // What was asked for is carried out after the confirmation, without asking again.
        waitFor("tula.setup.key")
    }

    @Test
    fun aSignOutFromTheAccountReturnsToTheSignIn() {
        val email = world.address()
        world.account(email, PASSWORD)
        openAccount(email)
        still { rule.onNodeWithTag("tula.account.signOut") }.assertHeightIsAtLeast(48.dp).performClick()
        waitFor("tula.screen")
        waitForTitle("Sign in")
        check(rule.onAllNodesWithTag("tula.account").fetchSemanticsNodes().isEmpty()) { "the account is still drawn" }
    }

    @Test
    fun aPasskeySheetThatIsClosedIsSaidQuietlyAndSignsNobodyIn() {
        // Passkeys on, for this app: the server takes a native passkey request only from a
        // registered app.
        world.settings {
            it.getJSONObject("signIn").getJSONObject("methods").put("passkey", org.json.JSONObject().put("enabled", true))
            it.put("passkeys", org.json.JSONObject().put("rpId", "localhost"))
        }
        world.operator(
            "POST", "/v1/admin/native-apps",
            """{"platform":"android","packageName":"dev.tula.example.compose","sha256CertFingerprints":["$FINGERPRINT"]}""",
            201,
        )
        // In place of Credential Manager's sheet: one that is closed without a passkey.
        val shown = AtomicInteger()
        ExampleSheets.passkeys = object : PasskeySheet {
            override suspend fun create(options: PasskeyCreationOptions): PasskeyRegistrationCredential =
                throw TulaSheetException(SheetFailure.DISMISSED)

            override suspend fun get(options: PasskeyRequestOptions): PasskeyAssertionCredential {
                shown.incrementAndGet()
                throw TulaSheetException(SheetFailure.DISMISSED)
            }
        }
        launch()
        waitFor("tula.way.passkey")
        tap("tula.way.passkey")
        waitFor("tula.notice")
        rule.onNodeWithTag("tula.notice").assertTextEquals("The passkey request was cancelled. Nothing was changed; you can try again.")
        // A notice: not a problem of the form, and nobody is signed in.
        check(rule.onAllNodesWithTag("tula.form.error").fetchSemanticsNodes().isEmpty()) { "a closed sheet was said as an error" }
        check(rule.onAllNodesWithTag("example.signedIn").fetchSemanticsNodes().isEmpty()) { "a closed sheet signed somebody in" }
        check(shown.get() == 1) { "the sheet was asked ${shown.get()} times" }
        // The button works again.
        tap("tula.way.passkey")
        rule.waitUntil(WAIT_MS) { shown.get() == 2 }
    }

    private companion object {
        const val WAIT_MS = 20_000L

        /** How long a control has to stay where it is before it is pressed. */
        const val STILL_MS = 300L

        /** How long a keyboard that does not come, or does not go, is waited for. */
        const val KEYBOARD_MS = 5_000L
        const val PASSWORD = "correct-horse-battery-staple-41"
        val FINGERPRINT: String = (1..32).joinToString(":") { "%02X".format(it) }
        val TOLD = listOf(
            "tula.title",
            "tula.form.error",
            "tula.status",
            "tula.notice",
            // The main button: "Loading…" there is a request still on its way, its own title
            // an action that never started or whose answer changed nothing.
            "tula.primary",
            "tula.account.submit",
            "tula.field.code.error.0",
            "tula.field.backup_code.error.0",
            "tula.field.password.error.0",
            "tula.account.field.code.error.0",
            "tula.account.field.step_up_password.error.0",
        )
        val HELD = listOf("tula.field.code", "tula.account.field.code")
        val BUTTONS = listOf("tula.primary", "tula.account.submit")
    }
}
