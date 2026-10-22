package dev.tula.example.compose

import android.app.UiAutomation
import android.content.Intent
import android.os.Build
import android.os.SystemClock
import android.view.WindowInsets
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.ComposeTimeoutException
import androidx.compose.ui.test.junit4.v2.createEmptyComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.After
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The screen captures of the documentation (docs/kotlin.md, "What the screens look like"): the
 * same screens the other UI tests drive, photographed one by one in both colour schemes.
 *
 * These run only for `bun run native/android/fixture/ui-tests.ts --screenshots <dir>`, which
 * hands the device's directory over as the instrumentation argument `tulaCaptureDir`; without
 * it every test here is skipped, so a normal run is unchanged. A picture is the device's own
 * `screencap` of the real screen, named `<screen>.<step>.<theme>.png`; the script pulls them,
 * turns them into the files the documentation serves and writes the manifest. Nothing is drawn
 * or edited here.
 */
@RunWith(AndroidJUnit4::class)
class CaptureTest {
    @get:Rule
    val rule = createEmptyComposeRule()

    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private lateinit var directory: String
    private lateinit var world: World
    private var scenario: ActivityScenario<MainActivity>? = null

    @Before
    fun makeWorld() {
        val named = InstrumentationRegistry.getArguments().getString("tulaCaptureDir")
        assumeTrue("not a capture run: start it with --screenshots <dir>", !named.isNullOrEmpty())
        directory = named!!
        ExampleSheets.reset()
        world = World.create()
    }

    @After
    fun giveBack() {
        scenario?.close()
        if (::world.isInitialized) {
            world.close()
        }
        shell("cmd uimode night no")
    }

    /** Run a shell command as the shell user (the test's own process cannot write the directory) and wait for it. */
    private fun shell(command: String) {
        val automation: UiAutomation = instrumentation.uiAutomation
        automation.executeShellCommand(command).use { descriptor ->
            java.io.FileInputStream(descriptor.fileDescriptor).use { it.readBytes() }
        }
    }

    private fun launch(dark: Boolean) {
        shell("cmd uimode night ${if (dark) "yes" else "no"}")
        val context = instrumentation.targetContext
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
            throw AssertionError("the screen \"$title\" did not open; it says ${texts("tula.title")}", late)
        }
    }

    private fun type(tag: String, text: String) = rule.onNodeWithTag(tag).performScrollTo().performTextInput(text)

    private fun tap(tag: String) {
        // The press goes where the control is once the screen has stopped moving.
        SystemClock.sleep(SETTLE_MS)
        rule.onNodeWithTag(tag).performScrollTo().performClick()
    }

    /** Put the keyboard away (API 30 and later: the emulator the script starts is newer), then photograph the screen. */
    private fun capture(screen: String, step: String, dark: Boolean) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            scenario?.onActivity { it.window.insetsController?.hide(WindowInsets.Type.ime()) }
        }
        SystemClock.sleep(SETTLE_MS * 2)
        val theme = if (dark) "dark" else "light"
        shell("screencap -p $directory/$screen.$step.$theme.png")
    }

    private fun signIn(email: String) {
        type("tula.field.email", email)
        tap("tula.primary")
        waitForTitle("Enter your password")
        type("tula.field.password", PASSWORD)
        tap("tula.primary")
    }

    private fun tourSignInAndReset(dark: Boolean) {
        val email = world.address()
        world.account(email, PASSWORD)
        launch(dark)
        waitForTitle("Sign in")
        capture("sign-in", "email", dark)
        type("tula.field.email", email)
        tap("tula.primary")
        waitForTitle("Enter your password")
        capture("sign-in", "password", dark)
        tap("tula.link.reset")
        waitForTitle("Reset your password")
        capture("reset", "request", dark)
        tap("tula.primary")
        waitForTitle("Choose a new password")
        capture("reset", "new-password", dark)
    }

    private fun tourSignUp(dark: Boolean) {
        val email = world.address()
        launch(dark)
        waitForTitle("Sign in")
        tap("tula.link.signUp")
        waitForTitle("Create your account")
        capture("sign-up", "create", dark)
        type("tula.field.email", email)
        type("tula.field.password", PASSWORD)
        tap("tula.primary")
        waitForTitle("Check your email")
        capture("sign-up", "verify", dark)
    }

    private fun tourSecondStepAndAccount(dark: Boolean) {
        val email = world.address()
        world.account(email, PASSWORD)
        world.settings { it.getJSONObject("mfa").put("policy", "required") }
        launch(dark)
        waitForTitle("Sign in")
        signIn(email)
        waitForTitle("Set up two-step verification")
        capture("second-step", "setup", dark)
        tap("tula.primary")
        waitFor("tula.setup.key")
        capture("second-step", "authenticator", dark)
        val secret = texts("tula.setup.key").single()
        type("tula.field.code", world.totp(secret))
        tap("tula.primary")
        waitForTitle("Save your backup codes")
        capture("second-step", "backup-codes", dark)
        tap("tula.primary")
        waitFor("example.signedIn")
        waitFor("tula.account")
        waitForTitle("Account")
        // The sessions are read after the screen is drawn: the capture waits for them.
        rule.waitUntil(WAIT_MS) { rule.onAllNodesWithText("This device").fetchSemanticsNodes().isNotEmpty() }
        capture("account", "overview", dark)
        rule.onNodeWithTag("tula.account.signOut").performScrollTo().performClick()
        waitForTitle("Sign in")
        signIn(email)
        waitForTitle("Two-step verification")
        capture("second-step", "verify", dark)
    }

    @Test fun signInAndResetLight() = tourSignInAndReset(false)

    @Test fun signInAndResetDark() = tourSignInAndReset(true)

    @Test fun signUpLight() = tourSignUp(false)

    @Test fun signUpDark() = tourSignUp(true)

    @Test fun secondStepAndAccountLight() = tourSecondStepAndAccount(false)

    @Test fun secondStepAndAccountDark() = tourSecondStepAndAccount(true)

    private companion object {
        const val WAIT_MS = 20_000L

        /** How long the screen is given to stop moving: a step's transition, the keyboard going. */
        const val SETTLE_MS = 500L
        const val PASSWORD = "correct-horse-battery-staple-41"
    }
}
