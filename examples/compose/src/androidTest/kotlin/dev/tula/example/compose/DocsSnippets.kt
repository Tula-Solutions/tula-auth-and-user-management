package dev.tula.example.compose

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.text.BasicText
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.res.stringResource
import dev.tula.auth.TulaClient
import dev.tula.auth.android.CredentialManagerGoogleSheet
import dev.tula.auth.android.CredentialManagerPasskeySheet
import dev.tula.auth.android.CustomTabsBrowserSession
import dev.tula.auth.android.KeystoreDeviceKeyStore
import dev.tula.auth.android.KeystoreTokenStorage
import dev.tula.auth.compose.TulaAuth
import dev.tula.auth.compose.TulaAuthSlots
import dev.tula.auth.ui.TulaAuthModel
import dev.tula.auth.ui.TulaStrings
import dev.tula.example.compose.test.R

// The Android and Compose samples of the documentation (docs/kotlin.md). Each
// `// #region name` … `// #endregion` block is copied into the page by
// `bun run docs:generate`, and `bun run docs:check` fails when the page and this file differ.
//
// This file is compiled with the example's UI tests (`:compose-example:assembleDebugAndroidTest`,
// which CI's `kotlin-android` job runs) and nothing in it is run or drawn, on an emulator or
// anywhere: it shows that the classes and composables the page names exist with these
// arguments, not what they do. It is no test, and it is not part of the app.

@Suppress("unused")
internal object DocsSnippets {
    fun client(applicationContext: Context): TulaClient {
        // #region client
        val tula = TulaClient(
            publishableKey = "tula_pk_…",
            baseUrl = "https://auth.example.com",
            storage = KeystoreTokenStorage(applicationContext),
        )
        // #endregion
        return tula
    }

    fun clientWithSheets(applicationContext: Context, currentActivity: () -> Activity?): TulaClient {
        // #region client-sheets
        val front = currentActivity // your app's own way to the activity in front
        val browser = CustomTabsBrowserSession(front)
        val tula = TulaClient(
            publishableKey = "tula_pk_…",
            baseUrl = "https://auth.example.com",
            storage = KeystoreTokenStorage(applicationContext),
            passkeys = CredentialManagerPasskeySheet(front),
            google = CredentialManagerGoogleSheet(serverClientId = "….apps.googleusercontent.com", activity = front),
            browser = browser,
            deviceKeys = KeystoreDeviceKeyStore(),
        )
        // #endregion
        return tula
    }

    @Composable
    fun ownModel(client: TulaClient): TulaAuthModel {
        // #region own-model
        val model = remember { TulaAuthModel(client, onSignedIn = { /* … */ }) }
        TulaAuth(model = model)
        // and, when the screens are left for good: model.close()
        // #endregion
        return model
    }

    fun secure(activity: Activity) {
        val window = activity.window
        // #region flag-secure
        window.setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE)
        // #endregion
    }

    @Composable
    fun worded(client: TulaClient) {
        // #region strings
        TulaAuth(
            client = client,
            strings = TulaStrings(
                signInTitle = "Welcome back",
                errors = mapOf("auth.invalid_credentials" to "That did not match. Try again."),
            ),
            onSignedIn = { },
        )
        // #endregion
    }

    @Composable
    fun translated(): TulaStrings {
        // #region strings-resources
        val strings = TulaStrings(
            signInTitle = stringResource(R.string.sign_in_title),
            continueButton = stringResource(R.string.continue_button),
            // … the rest of what your app translates
        )
        // #endregion
        return strings
    }

    @Composable
    fun slots(client: TulaClient) {
        // #region slots
        TulaAuth(
            client = client,
            slots = TulaAuthSlots(
                footer = { footer -> BasicText("Acme · ${footer.text}") },
            ),
            onSignedIn = { },
        )
        // #endregion
    }
}

/** The activity a provider's page returns to, and the one that shows the screens. */
class SignInActivity : ComponentActivity() {
    private val browser = CustomTabsBrowserSession { this }

    private val client by lazy {
        TulaClient(
            publishableKey = "tula_pk_…",
            baseUrl = "https://auth.example.com",
            storage = KeystoreTokenStorage(applicationContext),
            browser = browser,
        )
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // #region screens
        setContent {
            TulaAuth(
                client = client,
                onSignedIn = { /* show your app */ },
            )
        }
        // #endregion
    }

    // #region activity
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        browser.returned(intent)
    }

    // Closed with no redirect: cancelled.
    override fun onResume() {
        super.onResume()
        browser.resumed()
    }
    // #endregion
}
