package dev.tula.example.compose

import dev.tula.auth.BrowserSession
import dev.tula.auth.GoogleSheet
import dev.tula.auth.PasskeySheet

/**
 * Example only. The release build's side of the seam the UI tests script in the debug build
 * (`src/debug`): the same four properties, each `null` and none of them settable, so that a
 * release build of the example shows the system's sheets and nothing can put another in their
 * place.
 */
object ExampleSheets {
    /** Always the system's passkey sheet. */
    val passkeys: PasskeySheet? = null

    /** Always Google's own account chooser. */
    val google: GoogleSheet? = null

    /** No browser session: the example's manifest claims no redirect URL. */
    val browser: BrowserSession? = null

    /** No redirect URL, for the same reason. */
    val redirectUrl: String? = null
}
