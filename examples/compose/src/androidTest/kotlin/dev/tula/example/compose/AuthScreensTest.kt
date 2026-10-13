package dev.tula.example.compose

import android.content.Intent
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.ComposeTimeoutException
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.junit4.v2.createEmptyComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.junit.After
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The Compose screens, in the example app, against the real API: each test is one way through
 * them, read by what a screen reader is told (the semantics tree), in a fresh environment.
 */
@RunWith(AndroidJUnit4::class)
class AuthScreensTest {
    @get:Rule
    val rule = createEmptyComposeRule()

    private lateinit var world: World
    private var scenario: ActivityScenario<MainActivity>? = null

    @Before
    fun makeWorld() {
        world = World.create()
    }

    @After
    fun giveBack() {
        scenario?.close()
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
        rule.waitUntil(WAIT_MS) { rule.onAllNodesWithTag(tag).fetchSemanticsNodes().isNotEmpty() }
    }

    private fun texts(tag: String): List<String> =
        rule.onAllNodesWithTag(tag).fetchSemanticsNodes().flatMap { node ->
            node.config.getOrNull(SemanticsProperties.Text)?.map { it.text }.orEmpty()
        }

    private fun waitForTitle(title: String) {
        try {
            rule.waitUntil(WAIT_MS) { title in texts("tula.title") }
        } catch (late: ComposeTimeoutException) {
            // What the screen says instead is what a reader of the failure needs. These are the
            // screen's own words (a title, a problem by its code's sentence): nothing typed.
            val said = TOLD.associateWith { texts(it) }.filterValues { it.isNotEmpty() }
            throw AssertionError("the screen \"$title\" did not open; the screen says $said", late)
        }
    }

    private fun type(tag: String, text: String) = rule.onNodeWithTag(tag).performTextInput(text)

    private fun tap(tag: String) = rule.onNodeWithTag(tag).performClick()

    private fun typed(tag: String): String? =
        rule.onNodeWithTag(tag).fetchSemanticsNode().config.getOrNull(SemanticsProperties.EditableText)?.text

    private val hasError = SemanticsMatcher.keyIsDefined(SemanticsProperties.Error)
    private val isPassword = SemanticsMatcher.keyIsDefined(SemanticsProperties.Password)
    private val isHeading = SemanticsMatcher.keyIsDefined(SemanticsProperties.Heading)

    @Test
    fun aSignUpVerifiesItsAddressAndSignsIn() {
        launch()
        rule.onNodeWithTag("tula.title").assertTextEquals("Sign in").assert(isHeading)
        tap("tula.link.signUp")
        waitForTitle("Create your account")
        // The step changed: the focus is on the new screen's title.
        rule.onNodeWithTag("tula.title").assertIsFocused()
        val email = world.address()
        type("tula.field.email", email)
        type("tula.field.password", PASSWORD)
        rule.onNodeWithTag("tula.field.password").assert(isPassword)
        tap("tula.primary")
        waitForTitle("Check your email")
        type("tula.field.code", world.code(email))
        tap("tula.primary")
        waitFor("example.signedIn")
        rule.onNodeWithTag("example.user").assertTextEquals(email)
        // Signing out is back on the sign-in, with nothing of the sign-up left in it.
        tap("example.signOut")
        waitForTitle("Sign in")
        check(typed("tula.field.email").isNullOrEmpty()) { "the address of the flow that ended is still drawn" }
    }

    @Test
    fun aWrongPasswordIsSaidAtItsFieldAndTheRightOneSignsIn() {
        val email = world.address()
        world.account(email, PASSWORD)
        launch()
        type("tula.field.email", email)
        tap("tula.primary")
        waitForTitle("Enter your password")
        type("tula.field.password", "not-the-password-at-all")
        tap("tula.primary")
        waitFor("tula.field.password.error.0")
        // In words, associated with the field, and the field has the focus and is empty again.
        rule.onNodeWithTag("tula.field.password.error.0").assertTextEquals("Error: The email or password is incorrect.")
        rule.onNodeWithTag("tula.field.password").assert(hasError).assertIsFocused()
        check(typed("tula.field.password").isNullOrEmpty()) { "a refused password is still in its field" }
        type("tula.field.password", PASSWORD)
        tap("tula.primary")
        waitFor("example.signedIn")
        rule.onNodeWithTag("example.user").assertTextEquals(email)
    }

    @Test
    fun aFieldLeftEmptyIsSaidInWords() {
        launch()
        tap("tula.primary")
        waitFor("tula.field.email.error.0")
        rule.onNodeWithTag("tula.field.email.error.0").assertTextEquals("Error: This field is required.")
        rule.onNodeWithTag("tula.field.email").assert(hasError).assertIsFocused()
        rule.onNodeWithTag("tula.field.email").assert(
            SemanticsMatcher.expectValue(
                SemanticsProperties.ContentDescription,
                listOf("Email address, invalid: This field is required."),
            ),
        )
    }

    @Test
    fun aShownPasswordIsReadAndAHiddenOneIsNot() {
        launch()
        tap("tula.link.signUp")
        waitForTitle("Create your account")
        type("tula.field.password", PASSWORD)
        check(typed("tula.field.password") != PASSWORD) { "a hidden password is in the semantics tree" }
        rule.onNodeWithTag("tula.field.password.reveal").assertTextEquals("Show password")
        tap("tula.field.password.reveal")
        rule.waitUntil(WAIT_MS) { typed("tula.field.password") == PASSWORD }
        rule.onNodeWithTag("tula.field.password.reveal").assertTextEquals("Hide password")
        // Leaving the screen hides it again, and empties it.
        tap("tula.link.signIn")
        waitForTitle("Sign in")
        tap("tula.link.signUp")
        waitForTitle("Create your account")
        check(typed("tula.field.password").isNullOrEmpty()) { "a password outlived its screen" }
        rule.onNodeWithTag("tula.field.password.reveal").assertTextEquals("Show password")
    }

    @Test
    fun anActivityThatIsMadeAgainKeepsNothingThatWasTyped() {
        val email = world.address()
        world.account(email, PASSWORD)
        launch()
        type("tula.field.email", email)
        tap("tula.primary")
        waitForTitle("Enter your password")
        type("tula.field.password", PASSWORD)
        // The system destroys the activity and makes it again, handing back what was saved:
        // nothing of the screens was. The flow that was open is gone with its screen.
        scenario?.recreate()
        waitForTitle("Sign in")
        check(typed("tula.field.email").isNullOrEmpty()) { "an address came back from saved state" }
        check(rule.onAllNodesWithTag("tula.field.password").fetchSemanticsNodes().isEmpty()) {
            "the password step came back from saved state"
        }
    }

    @Test
    fun anEmailedCodeSignsIn() {
        val email = world.address()
        world.account(email, PASSWORD)
        world.settings {
            it.getJSONObject("signIn").getJSONObject("methods").put("emailCode", JSONObject().put("enabled", true))
        }
        launch()
        type("tula.field.email", email)
        tap("tula.primary")
        waitForTitle("Enter your password")
        val earlier = world.code(email)
        tap("tula.link.emailCode")
        waitFor("tula.field.code")
        rule.onNodeWithTag("tula.title").assertTextEquals("Check your email")
        type("tula.field.code", world.code(email, not = earlier))
        tap("tula.primary")
        waitFor("example.signedIn")
    }

    @Test
    fun aPasswordResetChoosesANewPasswordAndSignsIn() {
        val email = world.address()
        world.account(email, PASSWORD)
        launch()
        type("tula.field.email", email)
        tap("tula.primary")
        waitForTitle("Enter your password")
        tap("tula.link.reset")
        waitForTitle("Reset your password")
        val earlier = world.code(email)
        // The address typed for the sign-in went with its screen: it is typed again.
        if (typed("tula.field.email").isNullOrEmpty()) {
            type("tula.field.email", email)
        }
        tap("tula.primary")
        waitForTitle("Choose a new password")
        type("tula.field.code", world.code(email, not = earlier))
        type("tula.field.new_password", "$PASSWORD-and-a-new-one")
        tap("tula.primary")
        waitFor("example.signedIn")
    }

    private companion object {
        const val WAIT_MS = 20_000L
        const val PASSWORD = "correct-horse-battery-staple-41"
        val TOLD = listOf(
            "tula.title",
            "tula.form.error",
            "tula.status",
            "tula.field.email.error.0",
            "tula.field.password.error.0",
            "tula.field.code.error.0",
            "tula.field.new_password.error.0",
        )
    }
}
