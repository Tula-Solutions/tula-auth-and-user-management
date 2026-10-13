package dev.tula.auth.android

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import dev.tula.auth.BrowserReturn
import dev.tula.auth.BrowserSession
import dev.tula.auth.SheetFailure
import dev.tula.auth.TulaSheetException

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
 * A platform opens an app with whatever matches its filter, and anybody can open an app with
 * a URL. So [returned] takes an address for the browser's return only when it is the redirect
 * URL the sign-in asked for, character for character, followed by `#` (the rule is
 * [BrowserReturn]'s, in the JVM module, where it is tested); any other intent is the app's
 * own and leaves a waiting sign-in waiting. The address is then passed on as it is, and the
 * client reads it by the same rule before any request.
 *
 * This class is compiled and linted, and was not run on a device or an emulator.
 *
 * @param activity The activity the tab is opened from, asked for at each sign-in so that
 *   none is held; `null` is [SheetFailure.FAILED].
 */
class CustomTabsBrowserSession(private val activity: () -> Activity?) : BrowserSession {
    private val waiting = BrowserReturn()

    override suspend fun open(url: String, redirectUrl: String): String? {
        val from = activity() ?: throw TulaSheetException(SheetFailure.FAILED)
        return waiting.await(redirectUrl) {
            val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url))
            intent.putExtras(Bundle().apply { putBinder(EXTRA_CUSTOM_TABS_SESSION, null) })
            try {
                from.startActivity(intent)
            } catch (_: ActivityNotFoundException) {
                // No browser on the device.
                throw TulaSheetException(SheetFailure.UNSUPPORTED)
            }
        }
    }

    /**
     * Hand over the intent the app was opened with. Every intent may be handed over: one
     * that is not the return is left to the app.
     *
     * @param intent The intent of `onNewIntent` or `onCreate`.
     * @return `true` only when a sign-in was waiting and the intent's address is the
     *   redirect URL that sign-in asked for, character for character, followed by `#`: the
     *   sign-in then has it. `false` means the intent is the app's own to handle, and a
     *   waiting sign-in still waits. A return to the redirect URL with no fragment is
     *   `false` too: it carries no answer, and the sign-in ends as cancelled at [resumed].
     */
    fun returned(intent: Intent?): Boolean = waiting.returned(intent?.dataString)

    /**
     * Say that the activity that asked is in front again. With a sign-in still waiting, the
     * tab was closed without a redirect and the sign-in is cancelled.
     */
    fun resumed() {
        waiting.closed()
    }

    override fun toString(): String = "CustomTabsBrowserSession"
}
