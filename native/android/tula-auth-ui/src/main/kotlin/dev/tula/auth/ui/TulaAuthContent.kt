package dev.tula.auth.ui

// What a screen holds, as data: its words, its fields, its main button and its links, and the
// action of the model each of them performs. A composable draws a `TulaAuthContent` from top to
// bottom and decides nothing: which button a step has, and what it does, is said here, where a
// JVM test can read it (a composable runs only when Compose draws it).

/**
 * Something a person can ask a screen to do. Every button, link and keyboard "done" of a screen
 * is one of these, performed by [TulaAuthModel.perform].
 */
enum class TulaAuthAction {
    /** Start the flow of the open start screen with what its fields hold. */
    START,

    /** Send the password of a sign-in. */
    SUBMIT_PASSWORD,

    /** Ask for the emailed code that signs in. */
    SEND_EMAIL_CODE,

    /** Send the emailed code. */
    SUBMIT_CODE,

    /** Ask for the email again. */
    RESEND_CODE,

    /** Send the new password (with the code, in a reset). */
    SUBMIT_NEW_PASSWORD,

    /** Go from the emailed code back to the password. */
    USE_PASSWORD,

    /** Leave what is open for the start of a sign-in. */
    SHOW_SIGN_IN,

    /** Leave what is open for the start of a sign-up. */
    SHOW_SIGN_UP,

    /** Leave what is open for the start of a password reset. */
    SHOW_RESET,

    /** Leave what is open for the start of the same kind of flow. */
    START_AGAIN,
}

/** What a field asks of the keyboard and of the system's autofill. */
enum class TulaAuthFieldKind {
    /** An email address. */
    EMAIL,

    /** A password the account already has. */
    PASSWORD,

    /** A password that is being chosen. */
    NEW_PASSWORD,

    /** A 6-digit code. */
    CODE,
}

/** One field of a screen. */
data class TulaAuthFieldContent(
    /** The field. */
    val field: TulaAuthField,
    /** What it asks of the keyboard and of autofill. */
    val kind: TulaAuthFieldKind,
    /** Its label. */
    val label: String,
    /** A hint under it, when it has one. */
    val hint: String?,
    /** What the keyboard's "done" does: the screen's main action. */
    val submit: TulaAuthAction,
) {
    /** What the field is found by in a UI test: `tula.field.email`. */
    val identifier: String get() = "tula.field.${this.field.name.lowercase()}"
}

/** A button or a link of a screen: its words and the action it performs. */
data class TulaAuthOffer(
    /** What the control is found by in a UI test: `tula.primary`, `tula.link.reset`. */
    val identifier: String,
    /** The words on it. */
    val title: String,
    /** What it does. */
    val action: TulaAuthAction,
    /** A sentence drawn before it, when it has one: "New here?". */
    val lead: String? = null,
)

private fun link(name: String, title: String, action: TulaAuthAction, lead: String? = null) =
    TulaAuthOffer("tula.link.$name", title, action, lead)

private fun primary(title: String, action: TulaAuthAction) = TulaAuthOffer("tula.primary", title, action)

/**
 * Everything a screen holds, in the order it is drawn: the title and what is under it, the
 * address a sign-in is for (with the way to change it), the fields, the main button, the links.
 */
data class TulaAuthContent(
    /** The screen's title. */
    val title: String,
    /** What is under the title, when the screen has it. */
    val subtitle: String? = null,
    /** The address a sign-in is for, as the offer's `lead`, and the link that changes it. */
    val identity: TulaAuthOffer? = null,
    /** The fields. */
    val fields: List<TulaAuthFieldContent> = emptyList(),
    /** The main button. */
    val primary: TulaAuthOffer? = null,
    /** The links under it. */
    val links: List<TulaAuthOffer> = emptyList(),
) {
    /** Every action the screen offers. [TulaAuthModel.perform] does nothing for any other. */
    val actions: Set<TulaAuthAction>
        get() = (fields.map { it.submit } + (listOfNotNull(identity, primary) + links).map { it.action }).toSet()

    /** Makes the content of a screen. */
    companion object {
        /**
         * What a screen holds.
         *
         * @param screen The screen.
         * @param strings The strings its words are taken from.
         * @param appName The environment's app name, when it is known.
         * @param passwordOptional Whether a sign-up may leave the password out.
         * @param email The address typed for the sign-in.
         * @return The screen's words, fields, button and links.
         */
        fun of(
            screen: TulaAuthScreen,
            strings: TulaStrings,
            appName: String? = null,
            passwordOptional: Boolean = false,
            email: String = "",
        ): TulaAuthContent {
            val t = strings
            fun address(submit: TulaAuthAction) =
                TulaAuthFieldContent(TulaAuthField.EMAIL, TulaAuthFieldKind.EMAIL, t.emailLabel, null, submit)
            fun code(submit: TulaAuthAction) =
                TulaAuthFieldContent(TulaAuthField.CODE, TulaAuthFieldKind.CODE, t.codeLabel, t.codeHint, submit)
            fun chosen(submit: TulaAuthAction) = TulaAuthFieldContent(
                TulaAuthField.NEW_PASSWORD, TulaAuthFieldKind.NEW_PASSWORD, t.newPasswordLabel, null, submit,
            )
            val identity = link(
                "change", t.changeEmail, TulaAuthAction.SHOW_SIGN_IN,
                lead = TulaStrings.format(t.signingInAs, mapOf("email" to email)),
            )
            // No `else`: a screen that is added does not compile until it has its words here.
            return when (screen) {
                TulaAuthScreen.SignInStart -> TulaAuthContent(
                    title = t.signInTitle,
                    subtitle = appName?.let { TulaStrings.format(t.signInSubtitle, mapOf("appName" to it)) }
                        ?: t.signInSubtitleNoApp,
                    fields = listOf(address(TulaAuthAction.START)),
                    primary = primary(t.continueButton, TulaAuthAction.START),
                    links = listOf(link("signUp", t.signUpLink, TulaAuthAction.SHOW_SIGN_UP, lead = t.noAccount)),
                )
                TulaAuthScreen.SignUpStart -> TulaAuthContent(
                    title = t.signUpTitle,
                    subtitle = t.signUpSubtitle,
                    fields = listOf(
                        address(TulaAuthAction.START),
                        // A password that is being chosen, though it is the sign-up's `password`.
                        TulaAuthFieldContent(
                            TulaAuthField.PASSWORD,
                            TulaAuthFieldKind.NEW_PASSWORD,
                            if (passwordOptional) t.passwordOptionalLabel else t.passwordLabel,
                            if (passwordOptional) t.passwordOptionalHint else null,
                            TulaAuthAction.START,
                        ),
                    ),
                    primary = primary(t.continueButton, TulaAuthAction.START),
                    links = listOf(link("signIn", t.signInLink, TulaAuthAction.SHOW_SIGN_IN, lead = t.haveAccount)),
                )
                TulaAuthScreen.ResetStart -> TulaAuthContent(
                    title = t.resetTitle,
                    subtitle = t.resetSubtitle,
                    fields = listOf(address(TulaAuthAction.START)),
                    primary = primary(t.sendCode, TulaAuthAction.START),
                    links = listOf(link("signIn", t.backToSignIn, TulaAuthAction.SHOW_SIGN_IN)),
                )
                is TulaAuthScreen.Password -> TulaAuthContent(
                    title = t.passwordTitle,
                    identity = identity,
                    fields = listOf(
                        TulaAuthFieldContent(
                            TulaAuthField.PASSWORD, TulaAuthFieldKind.PASSWORD, t.passwordLabel, null,
                            TulaAuthAction.SUBMIT_PASSWORD,
                        ),
                    ),
                    primary = primary(t.signInSubmit, TulaAuthAction.SUBMIT_PASSWORD),
                    links = listOfNotNull(
                        if (screen.canEmailCode) link("emailCode", t.emailCode, TulaAuthAction.SEND_EMAIL_CODE) else null,
                        link("reset", t.forgotPassword, TulaAuthAction.SHOW_RESET),
                    ),
                )
                TulaAuthScreen.EmailCodeOffer -> TulaAuthContent(
                    title = t.emailCodeTitle,
                    subtitle = t.emailCodePrompt,
                    identity = identity,
                    primary = primary(t.emailCode, TulaAuthAction.SEND_EMAIL_CODE),
                )
                is TulaAuthScreen.EmailCode -> TulaAuthContent(
                    title = t.emailCodeTitle,
                    subtitle = TulaStrings.format(t.emailCodeSubtitle, mapOf("destination" to screen.destination)),
                    identity = identity,
                    fields = listOf(code(TulaAuthAction.SUBMIT_CODE)),
                    primary = primary(t.signInSubmit, TulaAuthAction.SUBMIT_CODE),
                    links = listOfNotNull(
                        link("resend", t.emailResend, TulaAuthAction.RESEND_CODE),
                        if (screen.canUsePassword) link("password", t.usePassword, TulaAuthAction.USE_PASSWORD) else null,
                    ),
                )
                is TulaAuthScreen.EmailVerification -> TulaAuthContent(
                    title = t.verificationTitle,
                    subtitle = TulaStrings.format(t.verificationSubtitle, mapOf("destination" to screen.destination)),
                    fields = listOf(code(TulaAuthAction.SUBMIT_CODE)),
                    primary = primary(t.verifySubmit, TulaAuthAction.SUBMIT_CODE),
                    links = listOf(
                        link("resend", t.resend, TulaAuthAction.RESEND_CODE),
                        link("back", t.back, TulaAuthAction.START_AGAIN),
                    ),
                )
                is TulaAuthScreen.NewPassword -> TulaAuthContent(
                    title = t.newPasswordTitle,
                    subtitle = TulaStrings.format(t.newPasswordSubtitle, mapOf("destination" to screen.destination)),
                    fields = listOf(
                        code(TulaAuthAction.SUBMIT_NEW_PASSWORD),
                        chosen(TulaAuthAction.SUBMIT_NEW_PASSWORD),
                    ),
                    primary = primary(t.resetSubmit, TulaAuthAction.SUBMIT_NEW_PASSWORD),
                    links = listOf(
                        link("resend", t.resend, TulaAuthAction.RESEND_CODE),
                        link("signIn", t.backToSignIn, TulaAuthAction.SHOW_SIGN_IN),
                    ),
                )
                TulaAuthScreen.ExpiredPassword -> TulaAuthContent(
                    title = t.expiredPasswordTitle,
                    subtitle = t.expiredPasswordSubtitle,
                    fields = listOf(chosen(TulaAuthAction.SUBMIT_NEW_PASSWORD)),
                    primary = primary(t.expiredPasswordSubmit, TulaAuthAction.SUBMIT_NEW_PASSWORD),
                )
                TulaAuthScreen.SignedIn -> TulaAuthContent(title = t.signedIn)
                // Every step this version has no form for ends here: said in words, with a way
                // out, and never a blank screen.
                is TulaAuthScreen.NotSupported -> TulaAuthContent(
                    title = t.notSupportedTitle,
                    subtitle = t.notSupportedMessage,
                    primary = primary(t.startAgain, TulaAuthAction.START_AGAIN),
                )
            }
        }
    }
}
