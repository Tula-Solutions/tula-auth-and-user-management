package dev.tula.auth

import dev.tula.auth.generated.PasskeyAssertionCredential
import dev.tula.auth.generated.PasskeyCreationOptions
import dev.tula.auth.generated.PasskeyRegistrationCredential
import dev.tula.auth.generated.PasskeyRequestOptions
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.async
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.isActive
import kotlinx.coroutines.withTimeoutOrNull
import java.util.concurrent.atomic.AtomicBoolean

/**
 * How long the client waits for a sheet or the browser: the lifetime of a WebAuthn challenge.
 * After it the ceremony is over ([TulaCeremony.Dismissed]) and a late answer is dropped,
 * never used.
 */
const val SHEET_CEILING_MS: Long = 300_000

/**
 * How something the system showed the user ended: it gave an answer, or the user put it away.
 *
 * **A dismissed sheet is not an error and not a success.** Nothing was sent to prove
 * anything, nobody is signed in, and the same call works again: an app goes back to where it
 * was and says nothing, or says so in a neutral tone.
 */
sealed class TulaCeremony<out T> {
    /** The sheet answered and the server accepted what it returned. */
    class Finished<T>(
        /** What the ceremony came to. */
        val value: T,
    ) : TulaCeremony<T>() {
        /** Which of the two it is, and nothing of the value. */
        override fun toString(): String = "TulaCeremony.Finished"
    }

    /**
     * The user closed the sheet, or it never answered (the client stops waiting after
     * [SHEET_CEILING_MS]).
     */
    object Dismissed : TulaCeremony<Nothing>() {
        override fun toString(): String = "TulaCeremony.Dismissed"
    }

    /** The value of a ceremony that finished; `null` for one that was dismissed. */
    val valueOrNull: T? get() = (this as? Finished<T>)?.value
}

/** What a sheet reports instead of an answer: one of four words, and nothing else. */
enum class SheetFailure {
    /** The user closed the sheet. Not a failure: the call returns [TulaCeremony.Dismissed]. */
    DISMISSED,

    /** A passkey of this account is already on this device (a registration only). */
    ALREADY_ON_DEVICE,

    /** This device or this version of the system cannot show the sheet. */
    UNSUPPORTED,

    /** Anything else. */
    FAILED,
}

/**
 * What a sheet, a browser session or a provider's sheet throws. It carries a [SheetFailure]
 * and nothing of the platform's own exception: no cause and none of its text, which an app
 * would log. The client reads the word and drops everything else an adapter throws.
 */
class TulaSheetException(
    /** Which of the four it was. */
    val failure: SheetFailure,
) : Exception(failure.name)

/**
 * The system's passkey sheet: what makes a passkey and what signs in with one.
 *
 * The options and the credentials are WebAuthn's JSON forms, exactly as the API sends and
 * takes them (every binary value is base64url text). An app passes the Android module's
 * `CredentialManagerPasskeySheet`; a test passes a fake, and no test of this repository shows
 * a sheet.
 */
interface PasskeySheet {
    /**
     * Make a passkey for the signed-in user.
     *
     * @throws TulaSheetException with the word for what happened.
     */
    suspend fun create(options: PasskeyCreationOptions): PasskeyRegistrationCredential

    /**
     * Ask for one of the user's passkeys.
     *
     * @throws TulaSheetException with the word for what happened.
     */
    suspend fun get(options: PasskeyRequestOptions): PasskeyAssertionCredential
}

/**
 * Google's own sheet (Credential Manager with a Google ID option). An app passes the Android
 * module's `CredentialManagerGoogleSheet`; a test passes a fake.
 */
fun interface GoogleSheet {
    /**
     * Ask Google for an ID token.
     *
     * @param nonce The server's nonce for this attempt, **as it is**: Google's token carries
     *   it unchanged, and the server compares it as a string. Never hash it.
     * @return The ID token (a JWT), as text. The client sends it once and keeps it nowhere.
     * @throws TulaSheetException with the word for what happened.
     */
    suspend fun idToken(nonce: String): String
}

/**
 * The browser a provider sign-in is shown in (a Custom Tab). An app passes the Android
 * module's `CustomTabsBrowserSession`; a test passes a fake, and no test opens a browser.
 */
fun interface BrowserSession {
    /**
     * Open [url] and wait until the browser is sent to [redirectUrl] or is closed.
     *
     * @param url The provider's authorization page, as the API wrote it.
     * @param redirectUrl Where the API sends the browser back to: an app link or a custom
     *   scheme of the app.
     * @return The whole address the app was opened with, or `null` when the user closed the
     *   browser. The client reads it only when it is [redirectUrl] exactly, followed by `#`.
     * @throws TulaSheetException when the browser could not be shown.
     */
    suspend fun open(url: String, redirectUrl: String): String?
}

/** What a call that may answer `null` answered: `null` itself means "no answer in time". */
internal class Answered<T>(val value: T)

/**
 * One call of something outside the client (a key store, a sheet), for [limitMs] at most.
 *
 * The call runs in the client's own scope and is waited for: one that does not end when it
 * is cancelled (a blocked call of a key store does not) is left behind and what it answers
 * late is dropped. Never rest a deadline on the other side honouring cancellation.
 *
 * @return The answer; `null` when none came in time.
 * @throws CancellationException when the caller was cancelled, or the work cancelled itself.
 */
internal suspend fun <T> bounded(scope: CoroutineScope, limitMs: Long, work: suspend () -> T): Answered<T>? {
    if (limitMs <= 0) {
        return null
    }
    val running = scope.async { Answered(work()) }
    return try {
        withTimeoutOrNull(limitMs) { running.await() } ?: run {
            running.cancel()
            null
        }
    } catch (cause: CancellationException) {
        running.cancel()
        throw cause
    }
}

/**
 * One system sheet at a time, for a whole client.
 *
 * A second ceremony while one is out is refused with `flow.busy` before any request: it is
 * never joined (its answer would be for another challenge) and never queued.
 */
internal class CeremonyGate(
    private val scope: CoroutineScope,
    private val ceilingMs: Long,
    private val messages: () -> Messages,
) {
    private val taken = AtomicBoolean(false)

    /** What a sheet's failure is called. Passkeys and providers have their own codes. */
    enum class Kind { PASSKEY, PROVIDER }

    /**
     * Run one ceremony, from before its first request until its last answer.
     *
     * @throws TulaError `flow.busy` when another is under way, before [body] runs.
     */
    suspend fun <T> ceremony(body: suspend () -> T): T {
        if (!taken.compareAndSet(false, true)) {
            throw clientError(ClientErrorCodes.FLOW_BUSY, messages())
        }
        try {
            return body()
        } finally {
            taken.set(false)
        }
    }

    private fun code(kind: Kind, failure: SheetFailure): String = when (kind) {
        Kind.PASSKEY -> when (failure) {
            SheetFailure.ALREADY_ON_DEVICE -> ClientErrorCodes.PASSKEY_ALREADY_ON_DEVICE
            SheetFailure.UNSUPPORTED -> ClientErrorCodes.PASSKEY_UNSUPPORTED
            else -> ClientErrorCodes.PASSKEY_FAILED
        }
        Kind.PROVIDER -> when (failure) {
            SheetFailure.UNSUPPORTED -> ClientErrorCodes.PROVIDER_UNSUPPORTED
            else -> ClientErrorCodes.PROVIDER_FAILED
        }
    }

    /**
     * Wait for a sheet, at most the ceiling.
     *
     * @return The sheet's answer; `null` inside when the user dismissed it or it did not
     *   answer in time (the outer `null`), which a caller reads the same way.
     * @throws TulaError one of the client's codes, and nothing of what the sheet threw.
     */
    suspend fun <T : Any> sheet(kind: Kind, show: suspend () -> T?): T? =
        try {
            bounded(scope, ceilingMs, show)?.value
        } catch (cause: CancellationException) {
            if (!currentCoroutineContext().isActive) {
                throw cause
            }
            // The sheet cancelled itself: that is the user putting it away.
            null
        } catch (known: TulaSheetException) {
            if (known.failure == SheetFailure.DISMISSED) {
                null
            } else {
                throw clientError(code(kind, known.failure), messages())
            }
        } catch (_: Exception) {
            // A framework's own exception: its text is the platform's and is not kept.
            throw clientError(code(kind, SheetFailure.FAILED), messages())
        }
}

private val BASE64URL = Regex("^[A-Za-z0-9_-]+$")

/**
 * The checks of what a passkey sheet returned and of what the API answered, before either is
 * used: a 200 is not proof of talking to the API, and a sheet is an adapter somebody wrote.
 * Nothing here keeps what it checks.
 */
internal object PasskeyChecks {
    fun isBase64Url(text: String): Boolean = BASE64URL.matches(text)

    fun usable(options: PasskeyRequestOptions): Boolean =
        isBase64Url(options.challenge) && options.rpId.isNotEmpty()

    fun usable(options: PasskeyCreationOptions): Boolean =
        isBase64Url(options.challenge) && options.rp.id.isNotEmpty() && isBase64Url(options.user.id)

    fun usable(credential: PasskeyAssertionCredential): Boolean =
        isBase64Url(credential.id) && credential.type == "public-key" &&
            isBase64Url(credential.response.clientDataJSON) &&
            isBase64Url(credential.response.authenticatorData) &&
            isBase64Url(credential.response.signature)

    fun usable(credential: PasskeyRegistrationCredential): Boolean =
        isBase64Url(credential.id) && credential.type == "public-key" &&
            isBase64Url(credential.response.clientDataJSON) &&
            isBase64Url(credential.response.attestationObject)
}
