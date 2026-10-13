package dev.tula.expo.screens

import dev.tula.auth.ui.TulaAuthMode
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

/** The one event of the module: the session's state, when it changes. */
private const val SESSION_EVENT = "onSessionChange"

/**
 * `TulaScreens`: Tula's Compose screens and the session of the Kotlin client under them, for
 * an Expo app (ADR 0063).
 *
 * The client owns the tokens and the refresh. JavaScript is told the session's state (a
 * status and two ids) and may ask for an access token for the app's own backend; the refresh
 * token never leaves the client's storage, and nothing of a token is in an event.
 */
class TulaScreensModule : Module() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var watching: Job? = null

    override fun definition() = ModuleDefinition {
        Name("TulaScreens")

        Events(SESSION_EVENT)

        Function("configure") { options: Map<String, Any?> ->
            TulaScreensHost.configure(appContext.reactContext, options) { appContext.currentActivity }
        }

        AsyncFunction("load") Coroutine { ->
            guarded { stateBody(TulaScreensHost.require().load()) }
        }

        AsyncFunction("getState") Coroutine { ->
            stateBody(TulaScreensHost.require().state.value)
        }

        AsyncFunction("getToken") Coroutine { ->
            guarded { TulaScreensHost.require().session.getToken() }
        }

        AsyncFunction("signOut") Coroutine { ->
            guarded { TulaScreensHost.require().session.signOut() }
        }

        OnStartObserving {
            watching?.cancel()
            val client = TulaScreensHost.client
            watching = if (client == null) {
                null
            } else {
                scope.launch { client.state.collect { sendEvent(SESSION_EVENT, stateBody(it)) } }
            }
        }

        OnStopObserving {
            watching?.cancel()
            watching = null
        }

        // A provider's page comes back to the app as an intent: the browser session reads it
        // only when it is the redirect URL that was asked for, followed by `#`.
        OnNewIntent { intent ->
            TulaScreensHost.browser?.returned(intent)
        }

        OnActivityEntersForeground {
            TulaScreensHost.browser?.resumed()
        }

        OnDestroy {
            scope.cancel()
        }

        View(TulaAuthScreenView::class) {
            Events("onSignedIn")

            Prop("mode") { view: TulaAuthScreenView, mode: String? ->
                view.mode.value = if (mode == "sign-up") TulaAuthMode.SIGN_UP else TulaAuthMode.SIGN_IN
            }

            Prop("theme") { view: TulaAuthScreenView, theme: Map<String, Any?>? ->
                view.theme.value = themeOf(theme)
            }

            Prop("redirectUrl") { view: TulaAuthScreenView, redirectUrl: String? ->
                view.redirectUrl.value = redirectUrl
            }
        }

        View(TulaAccountScreenView::class) {
            Events("onSignedOut")

            Prop("theme") { view: TulaAccountScreenView, theme: Map<String, Any?>? ->
                view.theme.value = themeOf(theme)
            }
        }
    }
}
