package dev.tula.auth.ui

import dev.tula.auth.ClientErrorCodes
import dev.tula.auth.TulaError
import dev.tula.auth.TulaFieldError
import dev.tula.auth.formatMessage
import dev.tula.auth.generated.TulaErrorDefinitions

/**
 * Every string the screens show: one table, in English by default.
 *
 * An app translates, or rewords, by copying the table with the properties it wants and handing
 * it to the screens:
 *
 * ```kotlin
 * val strings = TulaStrings(
 *     signInTitle = "Welcome back",
 *     errors = mapOf("auth.invalid_credentials" to "That did not match. Try again."),
 * )
 * ```
 *
 * A value in `{braces}` is filled in by the screens (`{appName}`, `{destination}`, `{time}`,
 * `{label}`, `{message}`); a string that leaves one out simply does not show it. Every string
 * is drawn as text: nothing here is parsed as HTML, Markdown or a link.
 *
 * **A server's error is shown by its code, never by the server's own words.** The message of a
 * code is `errors[code]` when the table has one, otherwise the contract's English sentence for
 * a code this version knows, otherwise [unknownError]: text a server wrote is never put on the
 * screen. The client's own `messages` table is not read by the screens: a translation of an
 * error goes in [errors].
 *
 * It is a Kotlin table and not Android string resources on purpose: the model that words a
 * problem runs on the JVM with no `Context`, where it is tested, and an app that keeps its
 * translations in `strings.xml` builds this table from them (`stringResource`) in one place.
 */
data class TulaStrings(
    /** Said of a button whose action is being sent. */
    val loading: String = "Loading…",
    /** Under a field that was left empty. */
    val required: String = "This field is required.",
    /** Goes back to the screen before. */
    val back: String = "Back",
    /** The last line of every screen. */
    val securedBy: String = "Secured by Tula",
    /**
     * What a field is read as, by a screen reader, when it has a problem. `{label}` is the
     * field's label and `{message}` its problems.
     */
    val fieldInvalid: String = "{label}, invalid: {message}",
    /**
     * What a problem starts with, so that it is one in words and not only in colour.
     * `{message}` is the problem.
     */
    val errorPrefix: String = "Error: {message}",
    /** After a `rate_limited` answer that says how long to wait. `{time}` is the wait. */
    val retryIn: String = "Try again in {time}.",
    /** A wait under a minute. `{seconds}` is the number. */
    val seconds: String = "{seconds}s",
    /** A wait of a minute or more. */
    val minutesSeconds: String = "{minutes}m {seconds}s",
    /** The title of the screen a sign-in starts on. */
    val signInTitle: String = "Sign in",
    /** `{appName}` is the environment's app name. */
    val signInSubtitle: String = "to continue to {appName}",
    /** The subtitle while, or where, the app's name is not known. */
    val signInSubtitleNoApp: String = "Welcome back",
    /** The label of the address field, on every screen that has one. */
    val emailLabel: String = "Email address",
    /** The button that starts a sign-in or a sign-up. */
    val continueButton: String = "Continue",
    /** The title of the password step. */
    val passwordTitle: String = "Enter your password",
    /** The label of the password field. */
    val passwordLabel: String = "Password",
    /** The button that sends the password. */
    val signInSubmit: String = "Sign in",
    /** The link from a sign-in to a password reset. */
    val forgotPassword: String = "Forgot password?",
    /** Beside the address a sign-in is for: goes back to change it. */
    val changeEmail: String = "Change",
    /** What the address a sign-in is for is read as. `{email}` is the address. */
    val signingInAs: String = "Signing in as {email}",
    /** The words before the link to the sign-up. */
    val noAccount: String = "New here?",
    /** The link from a sign-in to a sign-up. */
    val signUpLink: String = "Create an account",
    /** Said, and shown, when a flow has signed somebody in. */
    val signedIn: String = "You are signed in.",
    /** The link from the emailed code back to the password. */
    val usePassword: String = "Use your password",
    /** The button, and the link, that asks for an emailed sign-in code. */
    val emailCode: String = "Email me a code",
    /** The title of the emailed sign-in code's screens. */
    val emailCodeTitle: String = "Check your email",
    /** Under the title, before the code was asked for. */
    val emailCodePrompt: String = "We will email you a 6-digit code to sign in with.",
    /** `{destination}` is the masked address the server sent the code to. */
    val emailCodeSubtitle: String = "Enter the 6-digit code we sent to {destination}.",
    /** The link that asks for another sign-in email. */
    val emailResend: String = "Send a new email",
    /** Said, and shown, once another sign-in email was asked for. */
    val emailResent: String = "A new email is on its way.",
    /** The title of the screen a sign-up starts on. */
    val signUpTitle: String = "Create your account",
    /** Under the sign-up's title. */
    val signUpSubtitle: String = "Welcome! Sign up to get started.",
    /** The password field's label where the environment lets a sign-up go without one. */
    val passwordOptionalLabel: String = "Password (optional)",
    /** Under that field: what leaving it empty means. */
    val passwordOptionalHint: String = "Leave it empty to sign in with a code we email you instead.",
    /** The words before the link to the sign-in. */
    val haveAccount: String = "Already have an account?",
    /** The link from a sign-up to a sign-in. */
    val signInLink: String = "Sign in",
    /** The title of the step that verifies an address. */
    val verificationTitle: String = "Check your email",
    /** `{destination}` is the masked address the server sent the code to. */
    val verificationSubtitle: String = "Enter the 6-digit code we sent to {destination}.",
    /** The label of the code field. */
    val codeLabel: String = "Verification code",
    /** Under the code field: what a code looks like. */
    val codeHint: String = "6 digits",
    /** Under the code field when it holds fewer than six digits. */
    val codeIncomplete: String = "Enter the 6-digit code.",
    /** The button that sends the code. */
    val verifySubmit: String = "Verify",
    /** The link that asks for another code. */
    val resend: String = "Resend code",
    /** Said, and shown, once another code was asked for. */
    val resent: String = "A new code is on its way.",
    /** The title of the screen a reset starts on. */
    val resetTitle: String = "Reset your password",
    /** Under the reset's title. */
    val resetSubtitle: String = "Enter your email address and we will send you a code.",
    /** The button that starts a reset. */
    val sendCode: String = "Send code",
    /** The title of the step that takes the code and the new password. */
    val newPasswordTitle: String = "Choose a new password",
    /** `{destination}` is the masked address the server sent the code to. */
    val newPasswordSubtitle: String =
        "Enter the 6-digit code we sent to {destination} and a new password.",
    /** The label of a new password's field. */
    val newPasswordLabel: String = "New password",
    /** The button that sends the code and the new password. */
    val resetSubmit: String = "Reset password",
    /** The link from a reset back to the sign-in. */
    val backToSignIn: String = "Back to sign in",
    /** The title of the last step of a sign-in whose password is too old. */
    val expiredPasswordTitle: String = "Your password has expired",
    /** Under that title. */
    val expiredPasswordSubtitle: String = "Choose a new password to finish signing in.",
    /** The button that stores the new password and finishes the sign-in. */
    val expiredPasswordSubmit: String = "Save password and sign in",
    /** What the button in a password field says while the password is hidden. */
    val showPassword: String = "Show password",
    /** What it says while the password is shown. */
    val hidePassword: String = "Hide password",
    /** The title of the screen for a step this version cannot continue. */
    val notSupportedTitle: String = "This step is not supported",
    /** Under that title: what a person can do. */
    val notSupportedMessage: String =
        "This version of the app cannot continue this sign-in. Update the app, or sign in another way.",
    /** The button that discards the attempt and goes back to the first screen. */
    val startAgain: String = "Start again",
    /** Above the first screen, when a button found that its attempt was no longer open. */
    val flowLost: String = "That attempt is no longer open. Start again.",
    /**
     * On the signed-in screen, when the flow completed and the session could not be stored
     * (`storage.failed`): the client is signed in for as long as the app runs. "May", because
     * a later refresh that succeeds stores the session after all.
     */
    val sessionNotSaved: String =
        "Your session could not be saved on this device. You may be signed out when the app closes.",
    /**
     * Messages by error code (`auth.invalid_credentials`, `network.failed`), for a translation
     * or another wording. A code that is not here gets the contract's English sentence.
     */
    val errors: Map<String, String> = emptyMap(),
    /**
     * The message of a code this version does not know. The server's own words for such a code
     * are never shown.
     */
    val unknownError: String = "Something went wrong. Try again.",
) {
    /**
     * The message of an error, by its code.
     *
     * @param error A failed call's error.
     * @return `errors[code]`, or the contract's (or the client's) English sentence for a code
     *   this version knows, or [unknownError]. `{name}` placeholders are filled from the
     *   error's params.
     */
    fun message(error: TulaError): String = message(error.code, error.params)

    /**
     * The message of one field's problem, by its code.
     *
     * @param problem One entry of a [TulaError]'s `errors`.
     * @return The message, by the rule of [message].
     */
    fun message(problem: TulaFieldError): String = message(problem.code, problem.params)

    /**
     * The words of a code. Neither `TulaError.message` nor `TulaFieldError.message` is read:
     * for a field's problem the client hands on what the server wrote, and for a code this
     * version does not know the server's `detail`. Text a server wrote is not shown.
     *
     * A param is the server's too. Only a number or a boolean fills a `{placeholder}`: neither
     * can carry a sentence. A param that is text is left out, and its placeholder stays as written.
     */
    private fun message(code: String, params: Map<String, Any>): String =
        if (code in errors || code in KNOWN_CODES) {
            formatMessage(code, errors, params.filterValues { it is Number || it is Boolean })
        } else {
            unknownError
        }

    /**
     * A wait, in words: `42s` or `4m 12s`.
     *
     * @param waitMs The wait in milliseconds; a part of a second is rounded up.
     * @return The wait, in the table's words.
     */
    fun duration(waitMs: Long): String {
        val total = (waitMs.coerceIn(0, MAX_WAIT_MS) + 999) / 1000
        val minutes = total / 60
        return if (minutes > 0) {
            format(minutesSeconds, mapOf("minutes" to "$minutes", "seconds" to "${total % 60}"))
        } else {
            format(seconds, mapOf("seconds" to "$total"))
        }
    }

    /** The codes whose English sentence this version has, and the format helper. */
    companion object {
        private const val MAX_WAIT_MS = 86_400_000L

        /** The codes this version has a sentence for: the contract's, and the client's own. */
        internal val KNOWN_CODES: Set<String> by lazy {
            TulaErrorDefinitions.all.mapTo(HashSet()) { it.code.rawValue } + setOf(
                ClientErrorCodes.NETWORK_FAILED,
                ClientErrorCodes.NETWORK_TIMEOUT,
                ClientErrorCodes.RESPONSE_INVALID,
                ClientErrorCodes.STORAGE_FAILED,
                ClientErrorCodes.FLOW_BUSY,
            )
        }

        /**
         * Fill a string's `{name}` placeholders.
         *
         * A value is put in once and never read again: a value that itself holds `{braces}` is
         * shown as it is. A placeholder with no value is left as written.
         *
         * @param template A string of the table.
         * @param values The values by placeholder name.
         * @return The string with its placeholders filled.
         */
        fun format(template: String, values: Map<String, String>): String {
            val result = StringBuilder()
            var from = 0
            while (true) {
                val open = template.indexOf('{', from)
                if (open < 0) {
                    break
                }
                result.append(template, from, open)
                val close = template.indexOf('}', open + 1)
                val value = if (close < 0) null else values[template.substring(open + 1, close)]
                if (value == null) {
                    result.append('{')
                    from = open + 1
                } else {
                    result.append(value)
                    from = close + 1
                }
            }
            return result.append(template, from, template.length).toString()
        }
    }
}
