package dev.tula.expo.screens

import android.app.Activity
import android.content.Context
import android.os.Build
import dev.tula.auth.AuthState
import dev.tula.auth.ClientErrorCodes
import dev.tula.auth.TulaClient
import dev.tula.auth.TulaError
import dev.tula.auth.android.CredentialManagerGoogleSheet
import dev.tula.auth.android.CredentialManagerPasskeySheet
import dev.tula.auth.android.CustomTabsBrowserSession
import dev.tula.auth.android.KeystoreDeviceKeyStore
import dev.tula.auth.android.KeystoreTokenStorage
import dev.tula.auth.generated.ErrorCode
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

    /** Anything that is not a code of the closed set: see [crossing]. */
    const val INTERNAL = "internal"
}

private val OWN_CODES = setOf(
    ScreensCode.NOT_CONFIGURED,
    ScreensCode.ALREADY_CONFIGURED,
    ScreensCode.INVALID_OPTIONS,
    ScreensCode.UNSUPPORTED,
    ScreensCode.INTERNAL,
)

/** The Kotlin client's own codes: what it says of a call no server answered. */
private val CLIENT_CODES = setOf(
    ClientErrorCodes.NETWORK_FAILED,
    ClientErrorCodes.NETWORK_TIMEOUT,
    ClientErrorCodes.RESPONSE_INVALID,
    ClientErrorCodes.STORAGE_FAILED,
    ClientErrorCodes.FLOW_BUSY,
    ClientErrorCodes.DEVICE_KEY_FAILED,
    ClientErrorCodes.PASSKEY_UNSUPPORTED,
    ClientErrorCodes.PASSKEY_ALREADY_ON_DEVICE,
    ClientErrorCodes.PASSKEY_FAILED,
    ClientErrorCodes.PROVIDER_UNSUPPORTED,
    ClientErrorCodes.PROVIDER_FAILED,
)

/**
 * The code that crosses to JavaScript for [raw]: [raw] itself when it is one of a closed set,
 * and `internal` for everything else.
 *
 * A `TulaError`'s code is the server's own string. The set is the module's codes, the
 * client's and the codes of the contract this version was generated from ([ErrorCode]); a
 * code a newer server made up, and anything else a server put where a code goes, is not
 * passed on (ADR 0063).
 */
internal fun crossing(raw: String): String {
    if (raw in OWN_CODES || raw in CLIENT_CODES) {
        return raw
    }
    return if (ErrorCode.of(raw) is ErrorCode.Unknown) ScreensCode.INTERNAL else raw
}

/**
 * An error as it crosses to JavaScript: a code of the closed set and one fixed sentence.
 * Nothing of what was thrown is kept: a server's own words and a platform's exception text
 * never cross, and the code is not written into the sentence either.
 */
internal class Refusal(code: String) : CodedException(crossing(code), "Tula: the call failed.", null)

/**
 * Run a call of the module, and let only a [Refusal] leave it. It is `inline`, so the block
 * may suspend where the caller may.
 */
internal inline fun <T> guarded(block: () -> T): T =
    try {
        block()
    } catch (cancelled: CancellationException) {
        throw cancelled
    } catch (refused: Refusal) {
        throw refused
    } catch (failed: TulaError) {
        throw Refusal(failed.code)
    } catch (@Suppress("TooGenericExceptionCaught") other: Throwable) {
        throw Refusal(ScreensCode.INTERNAL)
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
 * options again (a JavaScript reload) make no second client, and other options are refused.
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

    /**
     * Where the sheets and the browser find the activity. The client outlives the React
     * Native context that made it, so they are handed [Latest.read] and never a provider.
     */
    private val activities = Latest<Activity>()

    /** The client, or the code that says there is none yet. */
    fun require(): TulaClient = client ?: throw Refusal(ScreensCode.NOT_CONFIGURED)

    @Synchronized
    fun configure(context: Context?, options: Map<String, Any?>, activity: () -> Activity?) {
        // First, and whatever follows: after a JavaScript reload the caller is a new module
        // of a new context, and the context whose provider was here is gone.
        activities.replace(activity)
        // `tula-auth-android` is written for Android 9 and later (ADR 0054).
        if (context == null || Build.VERSION.SDK_INT < Build.VERSION_CODES.P) {
            throw Refusal(ScreensCode.UNSUPPORTED)
        }
        val publishableKey = options["publishableKey"] as? String
        val baseUrl = options["baseUrl"] as? String
        if (publishableKey == null || baseUrl == null) {
            throw Refusal(ScreensCode.INVALID_OPTIONS)
        }
        val sessionProfile = options["sessionProfile"] as? String
        val googleWebClientId = options["googleWebClientId"] as? String
        val deviceBinding = options["deviceBinding"] == true
        val passkeys = options["passkeys"] == true
        val withBrowser = options["browser"] == true
        val identity = listOf(
            publishableKey, baseUrl, sessionProfile, googleWebClientId, deviceBinding, passkeys, withBrowser,
        ).joinToString("\n")
        if (client != null) {
            if (madeWith == identity) {
                return
            }
            throw Refusal(ScreensCode.ALREADY_CONFIGURED)
        }
        val tabs = if (withBrowser) CustomTabsBrowserSession(activities.read) else null
        client = try {
            TulaClient(
                publishableKey = publishableKey,
                baseUrl = baseUrl,
                // The refresh token is sealed by a Keystore key and kept here and nowhere else.
                storage = KeystoreTokenStorage(context.applicationContext),
                sessionProfile = sessionProfile,
                passkeys = if (passkeys) CredentialManagerPasskeySheet(activities.read) else null,
                google = googleWebClientId?.let { CredentialManagerGoogleSheet(it, activities.read) },
                browser = tabs,
                deviceKeys = if (deviceBinding) KeystoreDeviceKeyStore() else null,
            )
        } catch (refused: IllegalArgumentException) {
            throw Refusal(ScreensCode.INVALID_OPTIONS)
        }
        browser = tabs
        madeWith = identity
    }
}
