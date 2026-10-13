package dev.tula.expo.screens

import android.app.Activity
import android.content.Context
import android.os.Build
import dev.tula.auth.AuthState
import dev.tula.auth.TulaClient
import dev.tula.auth.TulaError
import dev.tula.auth.android.CredentialManagerGoogleSheet
import dev.tula.auth.android.CredentialManagerPasskeySheet
import dev.tula.auth.android.CustomTabsBrowserSession
import dev.tula.auth.android.KeystoreDeviceKeyStore
import dev.tula.auth.android.KeystoreTokenStorage
import expo.modules.kotlin.exception.CodedException
import kotlinx.coroutines.CancellationException

/** The module's own codes, beside the client's. The JavaScript side has the sentence of each. */
internal object ScreensCode {
    /** A call before `configure`. */
    const val NOT_CONFIGURED = "screens.not_configured"

    /** A second `configure` with other options: one client for the life of the process. */
    const val ALREADY_CONFIGURED = "screens.already_configured"

    /** Options the native client refuses. */
    const val INVALID_OPTIONS = "screens.invalid_options"

    /** A device the Kotlin SDK does not run on (below Android 9), or no application yet. */
    const val UNSUPPORTED = "screens.unsupported"

    /** Anything that is not the client's own error. */
    const val INTERNAL = "internal"
}

/**
 * An error as it crosses to JavaScript: a code and nothing else. The message is one fixed
 * sentence, and nothing of what was thrown is kept: a server's own words and a platform's
 * exception text never cross (ADR 0063).
 */
internal fun coded(code: String): CodedException = CodedException(code, "Tula: the call failed ($code).", null)

/** Run a call of the client, and let only a code leave it. */
internal suspend fun <T> guarded(block: suspend () -> T): T =
    try {
        block()
    } catch (cancelled: CancellationException) {
        throw cancelled
    } catch (refused: CodedException) {
        throw refused
    } catch (failed: TulaError) {
        throw coded(failed.code)
    } catch (@Suppress("TooGenericExceptionCaught") other: Throwable) {
        throw coded(ScreensCode.INTERNAL)
    }

/** What the session is, as JavaScript is told: a status and two ids. Never a token. */
internal fun stateBody(state: AuthState): Map<String, Any?> = when (state) {
    is AuthState.Loading -> mapOf("status" to "loading")
    is AuthState.SignedOut -> mapOf("status" to "signed-out")
    is AuthState.SignedIn -> mapOf(
        "status" to "signed-in",
        "sessionId" to state.sessionId,
        "userId" to state.user?.id,
    )
}

/**
 * The one client of the process, and what it was made with.
 *
 * The Kotlin client is "one per API and environment for the life of the process": two over one
 * storage would each refresh the same token. So `configure` makes the client once; the same
 * options again (a JavaScript reload) change nothing, and other options are refused.
 */
internal object TulaScreensHost {
    @Volatile
    var client: TulaClient? = null
        private set

    /** The browser a provider sign-in is shown in, when the app asked for one. */
    @Volatile
    var browser: CustomTabsBrowserSession? = null
        private set

    private var madeWith: String? = null

    /** The client, or the code that says there is none yet. */
    fun require(): TulaClient = client ?: throw coded(ScreensCode.NOT_CONFIGURED)

    @Synchronized
    fun configure(context: Context?, options: Map<String, Any?>, activity: () -> Activity?) {
        // `tula-auth-android` is written for Android 9 and later (ADR 0054).
        if (context == null || Build.VERSION.SDK_INT < Build.VERSION_CODES.P) {
            throw coded(ScreensCode.UNSUPPORTED)
        }
        val publishableKey = options["publishableKey"] as? String
        val baseUrl = options["baseUrl"] as? String
        if (publishableKey == null || baseUrl == null) {
            throw coded(ScreensCode.INVALID_OPTIONS)
        }
        val sessionProfile = options["sessionProfile"] as? String
        val googleWebClientId = options["googleWebClientId"] as? String
        val flags = listOf("deviceBinding", "passkeys", "browser").map { options[it] == true }
        val identity = listOf(publishableKey, baseUrl, sessionProfile, googleWebClientId, flags).joinToString("\n")
        if (client != null) {
            if (madeWith == identity) {
                return
            }
            throw coded(ScreensCode.ALREADY_CONFIGURED)
        }
        val (deviceBinding, passkeys, withBrowser) = flags
        val tabs = if (withBrowser) CustomTabsBrowserSession(activity) else null
        client = try {
            TulaClient(
                publishableKey = publishableKey,
                baseUrl = baseUrl,
                // The refresh token is sealed by a Keystore key and kept here and nowhere else.
                storage = KeystoreTokenStorage(context.applicationContext),
                sessionProfile = sessionProfile,
                passkeys = if (passkeys) CredentialManagerPasskeySheet(activity) else null,
                google = googleWebClientId?.let { CredentialManagerGoogleSheet(it, activity) },
                browser = tabs,
                deviceKeys = if (deviceBinding) KeystoreDeviceKeyStore() else null,
            )
        } catch (refused: IllegalArgumentException) {
            throw coded(ScreensCode.INVALID_OPTIONS)
        }
        browser = tabs
        madeWith = identity
    }
}
