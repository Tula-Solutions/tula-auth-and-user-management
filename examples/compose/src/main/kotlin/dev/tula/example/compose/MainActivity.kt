package dev.tula.example.compose

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.edit
import dev.tula.auth.AuthState
import dev.tula.auth.TulaClient
import dev.tula.auth.TulaError
import dev.tula.auth.android.CredentialManagerGoogleSheet
import dev.tula.auth.android.CredentialManagerPasskeySheet
import dev.tula.auth.android.KeystoreTokenStorage
import dev.tula.auth.compose.TulaAccount
import dev.tula.auth.compose.TulaAuth
import dev.tula.auth.compose.tulaSensitiveCopy
import dev.tula.auth.ui.TulaAccountModel

/**
 * Where the API is, and the environment's publishable key: all the app has to be told. With
 * the Google OAuth client id of the environment's provider, Google's account chooser is
 * offered too.
 */
data class ExampleConfiguration(val apiUrl: String, val publishableKey: String, val googleClientId: String? = null) {
    /** Reads and keeps the configuration. Neither value is a secret; neither is in the repository. */
    companion object {
        /** The intent extra that names the API's address (`adb shell am start -e tula_api_url …`). */
        const val EXTRA_API_URL = "tula_api_url"

        /** The intent extra that holds the publishable key. */
        const val EXTRA_PUBLISHABLE_KEY = "tula_publishable_key"

        /** The intent extra that holds the Google OAuth client id (not a secret), for the account chooser. */
        const val EXTRA_GOOGLE_CLIENT_ID = "tula_google_client_id"

        private const val PREFERENCES = "tula-example"

        /**
         * What the intent that started the app said, or `null` when it said nothing.
         *
         * Only a debuggable build listens. The activity is exported (it is the launcher), so any
         * app on the device can start it with extras of its own: a build that is not debuggable
         * would otherwise draw the sign-in over an address a stranger chose.
         */
        fun of(intent: Intent, debuggable: Boolean): ExampleConfiguration? {
            if (!debuggable) return null
            val url = intent.getStringExtra(EXTRA_API_URL).orEmpty()
            val key = intent.getStringExtra(EXTRA_PUBLISHABLE_KEY).orEmpty()
            val google = intent.getStringExtra(EXTRA_GOOGLE_CLIENT_ID)?.takeIf { it.isNotEmpty() }
            return if (url.isEmpty() || key.isEmpty()) null else ExampleConfiguration(url, key, google)
        }

        /** What was typed on the setup screen on an earlier run. */
        fun saved(context: Context): ExampleConfiguration? {
            val kept = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
            val url = kept.getString(EXTRA_API_URL, null).orEmpty()
            val key = kept.getString(EXTRA_PUBLISHABLE_KEY, null).orEmpty()
            return if (url.isEmpty() || key.isEmpty()) null else ExampleConfiguration(url, key)
        }

        /** Keep what was typed on the setup screen, or forget it with `null`. */
        fun save(context: Context, configuration: ExampleConfiguration?) {
            context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE).edit {
                putString(EXTRA_API_URL, configuration?.apiUrl)
                putString(EXTRA_PUBLISHABLE_KEY, configuration?.publishableKey)
            }
        }
    }
}

/** The example's one activity. */
class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // An app that wants no screenshot of its sign-in sets FLAG_SECURE here; the screens do
        // not. The example leaves it off so that its screens can be looked at.
        val debuggable = applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0
        val told = ExampleConfiguration.of(intent, debuggable) ?: ExampleConfiguration.saved(this)
        setContent { ExampleApp(told) }
    }
}

private val INK = Color(0xFF0F172A)
private val PAPER = Color(0xFFFFFFFF)
private val ACCENT = Color(0xFF4338CA)
private val BODY = TextStyle(color = INK, fontSize = 16.sp)

/** The app: a setup screen until it knows where the API is, then the session. */
@Composable
fun ExampleApp(told: ExampleConfiguration?) {
    val context = LocalContext.current
    var configuration by remember { mutableStateOf(told) }
    var refusal by remember { mutableStateOf<String?>(null) }
    Box(Modifier.fillMaxSize().background(PAPER).safeDrawingPadding()) {
        val current = configuration
        // The client refuses a key that is not a publishable key and an address it cannot
        // call, with a sentence that repeats neither.
        val client = remember(current) {
            current?.let {
                try {
                    // The sheets are asked for the activity at each use, so that none is held.
                    val activity = { context as? Activity }
                    TulaClient(
                        it.publishableKey, it.apiUrl, KeystoreTokenStorage(context),
                        passkeys = ExampleSheets.passkeys ?: CredentialManagerPasskeySheet(activity),
                        google = ExampleSheets.google ?: it.googleClientId?.let { id -> CredentialManagerGoogleSheet(id, activity) },
                        browser = ExampleSheets.browser,
                    )
                } catch (error: IllegalArgumentException) {
                    refusal = error.message
                    null
                }
            }
        }
        if (client == null) {
            SetupScreen(refusal) {
                refusal = null
                ExampleConfiguration.save(context, it)
                configuration = it
            }
        } else {
            DisposableEffect(client) { onDispose { client.close() } }
            SessionScreen(client) {
                ExampleConfiguration.save(context, null)
                configuration = null
            }
        }
    }
}

/** `TulaAuth` while nobody is signed in; who is, and `TulaAccount`, once somebody is. */
@Composable
private fun SessionScreen(client: TulaClient, forget: () -> Unit) {
    val state by client.state.collectAsState()
    var problem by remember { mutableStateOf<String?>(null) }
    // A sign-out the server could not be told of signs the client out locally all the same.
    // The account screen says so and offers it again, so it stays until that went through.
    var signOutFailed by remember { mutableStateOf(false) }
    // The sign-in screens stay until they say the sign-in is done (`onSignedIn`). The client is
    // signed in a moment earlier than that where an authenticator was set up inside the sign-in:
    // its backup codes are still to be shown, once, and an app that left for its own screens on
    // the client's state alone would never show them.
    var signingIn by remember { mutableStateOf(false) }
    LaunchedEffect(client) {
        try {
            client.load()
        } catch (error: TulaError) {
            // The stored session could not be read: the client keeps what it has.
            problem = error.message
        }
    }
    val now = state
    when {
        now is AuthState.Loading -> Column(Modifier.padding(24.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            BasicText("Loading…", Modifier.testTag("example.loading"), style = BODY)
            problem?.let { BasicText(it, Modifier.semantics { liveRegion = LiveRegionMode.Polite }, style = BODY) }
            ExampleButton("Use another API", "example.forget", forget)
        }
        (now is AuthState.SignedIn && !signingIn) || signOutFailed -> Column(Modifier.fillMaxSize()) {
            if (now is AuthState.SignedIn) {
                Column(Modifier.padding(start = 24.dp, top = 24.dp, end = 24.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    BasicText(
                        "Signed in",
                        Modifier.testTag("example.signedIn").semantics { heading() },
                        style = BODY.copy(fontSize = 24.sp, fontWeight = FontWeight.SemiBold),
                    )
                    // An account may have no email address (a first sign-in with X or Facebook).
                    BasicText(now.user?.email ?: "An account with no email address", Modifier.testTag("example.user"), style = BODY)
                }
            }
            AccountScreen(client, Modifier.weight(1f)) { signOutFailed = it }
        }
        // Where the app goes afterwards is this callback and nothing else.
        else -> {
            SideEffect { signingIn = true }
            TulaAuth(client, redirectUrl = ExampleSheets.redirectUrl, onSignedIn = { signingIn = false })
        }
    }
}

/**
 * The account screen over a model the example keeps, so that it can tell a sign-out that failed
 * from one that went through.
 */
@Composable
private fun AccountScreen(client: TulaClient, modifier: Modifier, failed: (Boolean) -> Unit) {
    val context = LocalContext.current
    val model = remember(client) { TulaAccountModel(client, copy = tulaSensitiveCopy(context)) }
    DisposableEffect(model) { onDispose { model.close() } }
    val account by model.state.collectAsState()
    LaunchedEffect(account.signOutFailed) { failed(account.signOutFailed) }
    TulaAccount(model, modifier)
}

/** Asks where the API is, when the app was not told. */
@Composable
private fun SetupScreen(refusal: String?, done: (ExampleConfiguration) -> Unit) {
    var url by remember { mutableStateOf("http://10.0.2.2:3003") }
    var key by remember { mutableStateOf("") }
    Column(Modifier.padding(24.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        BasicText(
            "Tula example",
            Modifier.testTag("example.setup").semantics { heading() },
            style = BODY.copy(fontSize = 24.sp, fontWeight = FontWeight.SemiBold),
        )
        refusal?.let { BasicText("Error: $it", Modifier.semantics { liveRegion = LiveRegionMode.Polite }, style = BODY) }
        SetupField("API address", "example.apiUrl", url) { url = it }
        SetupField("Publishable key (tula_pk_…)", "example.publishableKey", key) { key = it }
        ExampleButton("Continue", "example.continue") { done(ExampleConfiguration(url.trim(), key.trim())) }
    }
}

@Composable
private fun SetupField(label: String, tag: String, value: String, change: (String) -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        BasicText(label, style = BODY)
        BasicTextField(
            value = value,
            onValueChange = change,
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = 48.dp)
                .border(1.dp, INK, RoundedCornerShape(8.dp))
                .padding(12.dp)
                .semantics { contentDescription = label }
                .testTag(tag),
            textStyle = BODY,
            singleLine = true,
            keyboardOptions = KeyboardOptions(
                capitalization = KeyboardCapitalization.None,
                autoCorrectEnabled = false,
                keyboardType = KeyboardType.Uri,
            ),
        )
    }
}

@Composable
private fun ExampleButton(title: String, tag: String, onClick: () -> Unit) {
    Box(
        Modifier
            .fillMaxWidth()
            .heightIn(min = 48.dp)
            .background(ACCENT, RoundedCornerShape(8.dp))
            .clickable(role = Role.Button, onClick = onClick)
            .testTag(tag),
        contentAlignment = Alignment.Center,
    ) {
        BasicText(title, style = BODY.copy(color = PAPER, fontWeight = FontWeight.SemiBold))
    }
}
