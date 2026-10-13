package dev.tula.example.compose

import dev.tula.auth.BrowserSession
import dev.tula.auth.GoogleSheet
import dev.tula.auth.PasskeySheet

/**
 * Example only, and of the debug build only. What the UI tests put in place of the system's
 * sheets: a passkey sheet, Google's account chooser and a browser cannot be driven by a test,
 * so a test scripts one here before it starts the activity.
 *
 * This file is in the `debug` source set, which is what the UI tests run against. The release
 * build has a file of the same name (`src/release`) with the same four properties, all `null`
 * and none of them settable: a release build of the example can only show the system's sheets.
 * An app has no such thing at all: it gives its client the adapters of `tula-auth-android`.
 */
object ExampleSheets {
    /** A passkey sheet in place of Credential Manager's. */
    @Volatile
    var passkeys: PasskeySheet? = null

    /** An account chooser in place of Google's. */
    @Volatile
    var google: GoogleSheet? = null

    /** A browser session. The example wires none of its own: its manifest claims no redirect URL. */
    @Volatile
    var browser: BrowserSession? = null

    /** Where a provider's page returns to, for a scripted browser session. */
    @Volatile
    var redirectUrl: String? = null

    /** Back to the system's sheets. */
    fun reset() {
        passkeys = null
        google = null
        browser = null
        redirectUrl = null
    }
}
