package dev.tula.auth.android

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import dev.tula.auth.BrowserSession
import dev.tula.auth.SheetFailure
import dev.tula.auth.TulaSheetException
import kotlinx.coroutines.CompletableDeferred
import java.util.concurrent.atomic.AtomicReference

/**
 * The extra that asks a browser to open an address as a Custom Tab. It is the protocol's own
 * name, which `androidx.browser` only wraps: the session needs no library for it.
 */
private const val EXTRA_CUSTOM_TABS_SESSION = "android.support.customtabs.extra.SESSION"

/**
 * A provider's sign-in page in a Custom Tab of the user's browser, and the address the app
 * is opened with afterwards.
 *
 * The page is opened in the user's browser, never in a web view of the app: the provider's
 * password is typed where the app cannot read it. The browser comes back by opening the app
 * with the redirect URL, an app link or a custom scheme the app declares in its manifest, and
 * the app hands that address over:
 *
 * - the activity that receives the redirect calls [returned] with the intent it was opened
 *   with (`onNewIntent`, or `onCreate` for an activity of its own);
 * - the activity that asked calls [resumed] from `onResume`: coming back to the front with
 *   no redirect is the user closing the tab, which is a cancelled sign-in and not an error.
 *
 * The session passes the address on as it is. Whether it is the redirect URL that was asked
 * for, character for character, is the client's to judge, and anything else is refused there
 * without a request: a platform opens an app with whatever matches its filter, and anybody
 * can open an app with a URL.
 *
 * This class is compiled and linted, and was not run on a device or an emulator.
 *
 * @param activity The activity the tab is opened from, asked for at each sign-in so that
 *   none is held; `null` is [SheetFailure.FAILED].
 */
class CustomTabsBrowserSession(private val activity: () -> Activity?) : BrowserSession {
    private val waiting = AtomicReference<CompletableDeferred<String?>?>(null)

    override suspend fun open(url: String, redirectUrl: String): String? {
        val from = activity() ?: throw TulaSheetException(SheetFailure.FAILED)
        val answer = CompletableDeferred<String?>()
        // The client shows one sheet at a time; an answer nobody waits for any more is dropped.
        waiting.getAndSet(answer)?.complete(null)
        try {
            val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url))
            intent.putExtras(Bundle().apply { putBinder(EXTRA_CUSTOM_TABS_SESSION, null) })
            try {
                from.startActivity(intent)
            } catch (_: ActivityNotFoundException) {
                // No browser on the device.
                throw TulaSheetException(SheetFailure.UNSUPPORTED)
            }
            return answer.await()
        } finally {
            waiting.compareAndSet(answer, null)
        }
    }

    /**
     * Hand over the intent the app was opened with.
     *
     * @param intent The intent of `onNewIntent` or `onCreate`.
     * @return Whether a sign-in was waiting and the intent carried an address: `false` means
     *   the intent is the app's own to handle.
     */
    fun returned(intent: Intent?): Boolean {
        val address = intent?.dataString ?: return false
        val answer = waiting.getAndSet(null) ?: return false
        answer.complete(address)
        return true
    }

    /**
     * Say that the activity that asked is in front again. With a sign-in still waiting, the
     * tab was closed without a redirect and the sign-in is cancelled.
     */
    fun resumed() {
        waiting.getAndSet(null)?.complete(null)
    }

    override fun toString(): String = "CustomTabsBrowserSession"
}
