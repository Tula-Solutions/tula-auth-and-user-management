package dev.tula.auth.ui

import dev.tula.auth.generated.OAuthProvider

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

    /** Sign in with a passkey, through the client's passkey sheet. */
    USE_PASSKEY,

    /** Present again the ticket of a provider sign-in whose exchange got no answer. */
    RETRY_PROVIDER,

    /** Sign in with Google: the system's account chooser where the client has it, else the browser. */
    CONTINUE_WITH_GOOGLE,

    /** Sign in with GitHub, through the browser. */
    CONTINUE_WITH_GITHUB,

    /** Sign in with Apple, through the browser. */
    CONTINUE_WITH_APPLE,

    /** Sign in with Microsoft, through the browser. */
    CONTINUE_WITH_MICROSOFT,

    /** Sign in with Discord, through the browser. */
    CONTINUE_WITH_DISCORD,

    /** Sign in with LinkedIn, through the browser. */
    CONTINUE_WITH_LINKEDIN,

    /** Sign in with X, through the browser. */
    CONTINUE_WITH_X,

    /** Sign in with Facebook, through the browser. */
    CONTINUE_WITH_FACEBOOK,

    /** Ask for a texted code: a phone number's first factor, or the second step. */
    SEND_TEXTED_CODE,

    /** Send a backup code as the second step. */
    SUBMIT_BACKUP_CODE,

    /** Take the second step with a passkey, through the client's passkey sheet. */
    USE_SECOND_PASSKEY,

    /** Take the second step with an authenticator app's code instead. */
    USE_WAY_TOTP,

    /** Take the second step with a passkey instead. */
    USE_WAY_PASSKEY,

    /** Take the second step with a texted code instead. */
    USE_WAY_TEXTED_CODE,

    /** Take the second step with a backup code instead. */
    USE_WAY_BACKUP_CODE,

    /** Start setting up an authenticator app inside the sign-in. */
    START_ENROLMENT,

    /** Confirm the authenticator app with its first code. */
    CONFIRM_ENROLMENT,

    /** Copy the setup key, on a press. */
    COPY_SETUP_KEY,

    /** Copy the backup codes, on a press. */
    COPY_BACKUP_CODES,

    /** Leave the backup codes: they are not shown again. */
    SAVED_BACKUP_CODES,
    ;

    /** The provider a "Continue with …" action is for, or `null` for every other action. */
    val provider: OAuthProvider?
        get() = when (this) {
            CONTINUE_WITH_GOOGLE -> OAuthProvider.Google
            CONTINUE_WITH_GITHUB -> OAuthProvider.Github
            CONTINUE_WITH_APPLE -> OAuthProvider.Apple
            CONTINUE_WITH_MICROSOFT -> OAuthProvider.Microsoft
            CONTINUE_WITH_DISCORD -> OAuthProvider.Discord
            CONTINUE_WITH_LINKEDIN -> OAuthProvider.Linkedin
            CONTINUE_WITH_X -> OAuthProvider.X
            CONTINUE_WITH_FACEBOOK -> OAuthProvider.Facebook
            else -> null
        }

    /** Finds the action of a provider. */
    companion object {
        /**
         * The "Continue with …" action of a provider.
         *
         * @param provider A provider.
         * @return Its action, or `null` for a provider this version has no button for.
         */
        fun of(provider: OAuthProvider): TulaAuthAction? = entries.firstOrNull { it.provider == provider }

        /**
         * The action that takes the second step another way.
         *
         * @param way A way.
         * @return The action that opens it.
         */
        fun of(way: TulaSecondWay): TulaAuthAction = when (way) {
            TulaSecondWay.TOTP -> USE_WAY_TOTP
            TulaSecondWay.PASSKEY -> USE_WAY_PASSKEY
            TulaSecondWay.TEXTED_CODE -> USE_WAY_TEXTED_CODE
            TulaSecondWay.BACKUP_CODE -> USE_WAY_BACKUP_CODE
        }
    }
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

    /** An email address or a phone number: where a texted sign-in code is on. */
    IDENTIFIER,

    /** A texted 6-digit code: the system may offer the one that just arrived. */
    SMS_CODE,

    /** A backup code: letters and digits, typed as text. */
    BACKUP_CODE,

    /** A phone number. */
    PHONE,
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

/** An authenticator's setup key and what its QR code is drawn from, with the words around them. */
class TulaAuthSetupContent internal constructor(
    /** What to do with the code and the key. */
    val instruction: String,
    /** What the QR code is called for a screen reader. */
    val qrLabel: String,
    /** The `otpauth://` address the QR code encodes. It holds the key: never logged, never saved. */
    val uri: String,
    /** The label of the setup key. */
    val keyLabel: String,
    /** The setup key. */
    val key: String,
    /** The hint under the key. */
    val keyHint: String,
    /** The button that copies the key. */
    val copy: TulaAuthOffer,
) {
    /** The type's name: the key is never printed. */
    override fun toString(): String = "TulaAuthSetupContent"
}

/** Backup codes, shown once, with the words around them. */
class TulaAuthCodesContent internal constructor(
    /** What the list is called. */
    val label: String,
    /** The codes. */
    val codes: List<String>,
    /** The button that copies them. */
    val copy: TulaAuthOffer,
) {
    /** The type's name: the codes are never printed. */
    override fun toString(): String = "TulaAuthCodesContent"
}

/**
 * What the model knows beyond the screen and the strings: which ways the start offers, and
 * what a setup screen and a codes screen show.
 */
data class TulaAuthSituation(
    /** The ways to sign in without typing first, known to work here. */
    val ways: List<TulaAuthWay> = emptyList(),
    /** Whether the environment has a way to sign in that starts from what is typed. */
    val canIdentify: Boolean = true,
    /** Whether a phone number can be typed where the address is. */
    val phoneSignIn: Boolean = false,
    /** Whether a provider sign-in can be tried again. */
    val canRetryProvider: Boolean = false,
    /** The setup key of the setup screen. */
    val setup: TulaAuthSetup? = null,
    /** The codes of the codes' screen. */
    val backupCodes: List<String> = emptyList(),
) {
    /** The type's name: it can hold a setup key and backup codes. */
    override fun toString(): String = "TulaAuthSituation"
}

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
    /** A sentence between the subtitle and the form, when the screen has one. */
    val note: String? = null,
    /** The word between the form and [ways] ("or"), when both are drawn. */
    val divider: String? = null,
    /** The other ways to sign in: a passkey, the providers. Buttons, drawn under the form. */
    val ways: List<TulaAuthOffer> = emptyList(),
    /** An authenticator's setup key and QR code, on the setup screen. */
    val setup: TulaAuthSetupContent? = null,
    /** The backup codes, on their screen. */
    val codes: TulaAuthCodesContent? = null,
) {
    /** Every action the screen offers. [TulaAuthModel.perform] does nothing for any other. */
    val actions: Set<TulaAuthAction>
        get() = (
            fields.map { it.submit } +
                (listOfNotNull(identity, primary, setup?.copy, codes?.copy) + links + ways).map { it.action }
            ).toSet()

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
         * @param situation What the model knows beyond that: the ways the start offers, a
         *   setup key, backup codes.
         * @return The screen's words, fields, button and links.
         */
        fun of(
            screen: TulaAuthScreen,
            strings: TulaStrings,
            appName: String? = null,
            passwordOptional: Boolean = false,
            email: String = "",
            situation: TulaAuthSituation = TulaAuthSituation(),
        ): TulaAuthContent {
            val t = strings
            val w = strings.ways
            val two = strings.secondStep
            fun smsCode(submit: TulaAuthAction) =
                TulaAuthFieldContent(TulaAuthField.CODE, TulaAuthFieldKind.SMS_CODE, t.codeLabel, t.codeHint, submit)
            fun instead(way: TulaSecondWay) = link(
                "way.${way.rawValue}",
                when (way) {
                    TulaSecondWay.TOTP -> two.useAuthenticator
                    TulaSecondWay.PASSKEY -> two.usePasskeyInstead
                    TulaSecondWay.TEXTED_CODE -> two.smsInstead
                    TulaSecondWay.BACKUP_CODE -> two.useBackupCode
                },
                TulaAuthAction.of(way),
            )
            val startAgain = link("startAgain", t.startAgain, TulaAuthAction.START_AGAIN)
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
                TulaAuthScreen.SignInStart -> {
                    val ways = situation.ways.mapNotNull { way ->
                        when (way) {
                            TulaAuthWay.Passkey -> TulaAuthOffer("tula.way.passkey", w.passkey, TulaAuthAction.USE_PASSKEY)
                            is TulaAuthWay.Provider -> {
                                val name = w.providers[way.provider.rawValue]
                                val action = TulaAuthAction.of(way.provider)
                                if (name == null || action == null) {
                                    null
                                } else {
                                    TulaAuthOffer(
                                        "tula.way.${way.provider.rawValue}",
                                        TulaStrings.format(w.continueWith, mapOf("provider" to name)),
                                        action,
                                    )
                                }
                            }
                        }
                    }
                    val typed = situation.canIdentify
                    TulaAuthContent(
                        title = t.signInTitle,
                        subtitle = appName?.let { TulaStrings.format(t.signInSubtitle, mapOf("appName" to it)) }
                            ?: t.signInSubtitleNoApp,
                        // Nothing to type and no way this app can take here: said in words,
                        // never an empty card.
                        note = if (!typed && ways.isEmpty()) w.noWayHere else null,
                        fields = when {
                            !typed -> emptyList()
                            situation.phoneSignIn -> listOf(
                                TulaAuthFieldContent(
                                    TulaAuthField.EMAIL, TulaAuthFieldKind.IDENTIFIER, w.identifierLabel, w.identifierHint,
                                    TulaAuthAction.START,
                                ),
                            )
                            else -> listOf(address(TulaAuthAction.START))
                        },
                        primary = if (typed) primary(t.continueButton, TulaAuthAction.START) else null,
                        divider = if (typed && ways.isNotEmpty()) w.divider else null,
                        ways = ways,
                        links = listOfNotNull(
                            if (situation.canRetryProvider) {
                                link("retryProvider", w.providerRetry, TulaAuthAction.RETRY_PROVIDER)
                            } else {
                                null
                            },
                            link("signUp", t.signUpLink, TulaAuthAction.SHOW_SIGN_UP, lead = t.noAccount),
                        ),
                    )
                }
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
                is TulaAuthScreen.TextedCodeOffer -> TulaAuthContent(
                    title = w.smsTitle,
                    subtitle = w.smsPrompt,
                    identity = identity,
                    primary = if (screen.unavailable) null else primary(w.smsCode, TulaAuthAction.SEND_TEXTED_CODE),
                )
                is TulaAuthScreen.TextedCode -> TulaAuthContent(
                    title = w.smsTitle,
                    subtitle = TulaStrings.format(w.smsSubtitle, mapOf("destination" to screen.destination)),
                    identity = identity,
                    fields = listOf(smsCode(TulaAuthAction.SUBMIT_CODE)),
                    primary = primary(t.signInSubmit, TulaAuthAction.SUBMIT_CODE),
                    links = listOf(link("resend", w.smsResend, TulaAuthAction.RESEND_CODE)),
                )
                is TulaAuthScreen.SecondFactor -> {
                    val others = screen.others.map(::instead) + startAgain
                    when (screen.way) {
                        TulaSecondWay.TOTP -> TulaAuthContent(
                            title = two.title,
                            subtitle = two.totpSubtitle,
                            fields = listOf(
                                TulaAuthFieldContent(
                                    TulaAuthField.CODE, TulaAuthFieldKind.CODE, two.totpLabel, t.codeHint,
                                    TulaAuthAction.SUBMIT_CODE,
                                ),
                            ),
                            primary = primary(two.submit, TulaAuthAction.SUBMIT_CODE),
                            links = others,
                        )
                        TulaSecondWay.PASSKEY -> TulaAuthContent(
                            title = two.title,
                            subtitle = two.passkeySubtitle,
                            primary = primary(two.usePasskey, TulaAuthAction.USE_SECOND_PASSKEY),
                            links = others,
                        )
                        TulaSecondWay.BACKUP_CODE -> TulaAuthContent(
                            title = two.title,
                            subtitle = two.backupSubtitle,
                            fields = listOf(
                                TulaAuthFieldContent(
                                    TulaAuthField.BACKUP_CODE, TulaAuthFieldKind.BACKUP_CODE, two.backupLabel, two.backupHint,
                                    TulaAuthAction.SUBMIT_BACKUP_CODE,
                                ),
                            ),
                            primary = primary(two.submit, TulaAuthAction.SUBMIT_BACKUP_CODE),
                            links = others,
                        )
                        TulaSecondWay.TEXTED_CODE -> {
                            val sent = screen.sent
                            if (sent == null) {
                                // Nothing is texted by arriving: the button asks, and where the
                                // server said texted codes are off the button is gone.
                                TulaAuthContent(
                                    title = two.title,
                                    subtitle = two.smsSubtitle,
                                    primary = if (screen.unavailable) {
                                        null
                                    } else {
                                        primary(two.smsSend, TulaAuthAction.SEND_TEXTED_CODE)
                                    },
                                    links = others,
                                )
                            } else {
                                TulaAuthContent(
                                    title = two.title,
                                    subtitle = TulaStrings.format(two.smsSent, mapOf("destination" to sent)),
                                    fields = listOf(smsCode(TulaAuthAction.SUBMIT_CODE)),
                                    primary = primary(two.submit, TulaAuthAction.SUBMIT_CODE),
                                    links = listOf(link("resend", two.smsResend, TulaAuthAction.RESEND_CODE)) + others,
                                )
                            }
                        }
                    }
                }
                TulaAuthScreen.EnrolmentStart -> TulaAuthContent(
                    title = two.enrolTitle,
                    subtitle = two.enrolRequired,
                    primary = primary(two.enrolStart, TulaAuthAction.START_ENROLMENT),
                    links = listOf(startAgain),
                )
                TulaAuthScreen.TotpSetup -> TulaAuthContent(
                    title = two.enrolTitle,
                    setup = situation.setup?.let {
                        TulaAuthSetupContent(
                            instruction = two.scanInstruction,
                            qrLabel = two.qrLabel,
                            uri = it.uri,
                            keyLabel = two.secretLabel,
                            key = it.key,
                            keyHint = two.secretHint,
                            copy = TulaAuthOffer("tula.copy.key", two.copyKey, TulaAuthAction.COPY_SETUP_KEY),
                        )
                    },
                    fields = listOf(
                        TulaAuthFieldContent(
                            TulaAuthField.CODE, TulaAuthFieldKind.CODE, two.totpLabel, t.codeHint,
                            TulaAuthAction.CONFIRM_ENROLMENT,
                        ),
                    ),
                    primary = primary(two.confirmSubmit, TulaAuthAction.CONFIRM_ENROLMENT),
                    links = listOf(startAgain),
                )
                TulaAuthScreen.BackupCodes -> TulaAuthContent(
                    title = two.backupCodesTitle,
                    subtitle = two.backupCodesIntro,
                    codes = TulaAuthCodesContent(
                        label = two.backupCodesList,
                        codes = situation.backupCodes,
                        copy = TulaAuthOffer("tula.copy.codes", two.copy, TulaAuthAction.COPY_BACKUP_CODES),
                    ),
                    primary = primary(two.saved, TulaAuthAction.SAVED_BACKUP_CODES),
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
