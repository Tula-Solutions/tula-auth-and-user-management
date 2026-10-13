package dev.tula.auth.ui

import dev.tula.auth.generated.Factors
import dev.tula.auth.generated.Passkey
import dev.tula.auth.generated.Session
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle

// What the account screen offers, as data. A composable iterates it and calls the model's
// `perform`; it decides nothing, and so everything here is tested on the JVM (ADR 0062).

/** A button or a link of the account screen. */
data class TulaAccountOffer(
    /** The test tag. */
    val identifier: String,
    /** What is drawn. */
    val title: String,
    /** What a press asks for. */
    val action: TulaAccountAction,
    /** What a screen reader says where the title alone would not tell two buttons apart. */
    val label: String? = null,
    /** Whether a press removes or turns something off. Said by the title; never by colour alone. */
    val destructive: Boolean = false,
)

/** A field of an account form. */
data class TulaAccountFieldContent(
    /** Which field. */
    val field: TulaAccountField,
    /** How it is typed into. */
    val kind: TulaAuthFieldKind,
    /** The label above it, and its name for a screen reader. */
    val label: String,
    /** The hint under it. */
    val hint: String?,
    /** What the keyboard's "done" asks for. */
    val submit: TulaAccountAction,
) {
    /** The test tag. */
    val identifier: String get() = "tula.account.field.${this.field.name.lowercase()}"
}

/** One thing of a list: a session, a passkey. */
data class TulaAccountRow(
    /** The test tag. */
    val identifier: String,
    /** What it is called. */
    val title: String,
    /** What is known of it, a line each. */
    val details: List<String>,
    /** What it is marked as, in words: "This device", "Bound to a device key". */
    val marks: List<String>,
    /** What can be done with it. */
    val offer: TulaAccountOffer?,
)

/** A part of the overview. */
data class TulaAccountSection(
    /** The test tag. */
    val identifier: String,
    /** Its heading. */
    val title: String,
    /** What it says, a line each. */
    val lines: List<String> = emptyList(),
    /** Its list. */
    val rows: List<TulaAccountRow> = emptyList(),
    /** What it offers. */
    val offers: List<TulaAccountOffer> = emptyList(),
    /** Whether it has not been read yet. */
    val loading: Boolean = false,
)

/**
 * Everything the account screen draws at one moment: the overview's sections, or one form.
 *
 * **It can hold a setup key and backup codes** while their form is open: it prints as its
 * type's name.
 */
class TulaAccountContent internal constructor(
    /** The title of what is drawn. It takes the focus on a change of panel. */
    val title: String,
    /** A sentence under the title. */
    val subtitle: String? = null,
    /** The fields of the open form. */
    val fields: List<TulaAccountFieldContent> = emptyList(),
    /** The main button of the open form. */
    val primary: TulaAccountOffer? = null,
    /** The links under the form. */
    val links: List<TulaAccountOffer> = emptyList(),
    /** The overview's sections. Empty while a form is open. */
    val sections: List<TulaAccountSection> = emptyList(),
    /** An authenticator's QR code and setup key. */
    val setup: TulaAuthSetupContent? = null,
    /** Backup codes. */
    val codes: TulaAuthCodesContent? = null,
    /** The button that copies the setup key, or the backup codes: only ever on a press. */
    val copy: TulaAccountOffer? = null,
) {
    /** Everything that can be asked for now. */
    val actions: Set<TulaAccountAction>
        get() = (
            listOfNotNull(primary, copy) + links + sections.flatMap { section ->
                section.offers + section.rows.mapNotNull { it.offer }
            }
            ).mapTo(LinkedHashSet()) { it.action }

    /** The type's name: nothing it holds is printed. */
    override fun toString(): String = "TulaAccountContent"

    /** How the content is made from the model's state. */
    companion object {
        /**
         * Write a time of the API for a person, in the device's zone and locale.
         *
         * @param iso A time as the API writes it (ISO 8601).
         * @return The time in words, or `null` for a text that is no time.
         */
        fun defaultDate(iso: String): String? = try {
            OffsetDateTime.parse(iso).atZoneSameInstant(ZoneId.systemDefault())
                .format(DateTimeFormatter.ofLocalizedDateTime(FormatStyle.MEDIUM, FormatStyle.SHORT))
        } catch (_: Exception) {
            null
        }

        /**
         * What is drawn for a state.
         *
         * @param state The model's state.
         * @param strings The strings.
         * @param passkeySheet Whether the client was given a passkey sheet.
         * @param formatDate Writes a time for a person, or `null`.
         * @return The content.
         */
        fun of(
            state: TulaAccountState,
            strings: TulaStrings,
            passkeySheet: Boolean,
            formatDate: (String) -> String?,
        ): TulaAccountContent {
            val a = strings.account
            if (state.signedOut) {
                return TulaAccountContent(title = a.title)
            }
            if (state.signOutFailed) {
                return TulaAccountContent(title = a.title, primary = TulaAccountOffer("tula.account.signOut", a.signOut, TulaAccountAction.SignOut))
            }
            return when (val panel = state.panel) {
                TulaAccountPanel.Overview -> overview(state, strings, passkeySheet, formatDate)
                else -> form(panel, state, strings)
            }
        }

        private fun fill(template: String, name: String, value: String): String = TulaStrings.format(template, mapOf(name to value))

        private val cancel = { a: TulaAccountStrings -> TulaAccountOffer("tula.account.cancel", a.cancel, TulaAccountAction.Cancel) }

        private fun field(
            field: TulaAccountField,
            kind: TulaAuthFieldKind,
            label: String,
            submit: TulaAccountAction,
            hint: String? = null,
        ) = TulaAccountFieldContent(field, kind, label, hint, submit)

        private fun form(panel: TulaAccountPanel, state: TulaAccountState, strings: TulaStrings): TulaAccountContent {
            val a = strings.account
            val two = strings.secondStep
            val back = listOf(cancel(a))
            return when (panel) {
                TulaAccountPanel.ChangePassword -> TulaAccountContent(
                    title = a.passwordTitle,
                    fields = listOf(
                        field(TulaAccountField.CURRENT_PASSWORD, TulaAuthFieldKind.PASSWORD, a.currentPasswordLabel, TulaAccountAction.SubmitPassword),
                        field(TulaAccountField.NEW_PASSWORD, TulaAuthFieldKind.NEW_PASSWORD, strings.newPasswordLabel, TulaAccountAction.SubmitPassword),
                    ),
                    primary = TulaAccountOffer("tula.account.submit", a.changePassword, TulaAccountAction.SubmitPassword),
                    links = back,
                )
                TulaAccountPanel.TotpSetup -> TulaAccountContent(
                    title = two.enrolTitle,
                    fields = listOf(
                        field(TulaAccountField.CODE, TulaAuthFieldKind.CODE, two.totpLabel, TulaAccountAction.ConfirmTotp, strings.codeHint),
                    ),
                    primary = TulaAccountOffer("tula.account.submit", two.confirmSubmit, TulaAccountAction.ConfirmTotp),
                    links = back,
                    setup = state.setup?.let {
                        TulaAuthSetupContent(
                            instruction = two.scanInstruction,
                            qrLabel = two.qrLabel,
                            uri = it.uri,
                            keyLabel = two.secretLabel,
                            key = it.key,
                            keyHint = two.secretHint,
                        )
                    },
                    copy = state.setup?.let { TulaAccountOffer("tula.copy.key", two.copyKey, TulaAccountAction.CopySetupKey) },
                )
                TulaAccountPanel.BackupCodes -> TulaAccountContent(
                    title = two.backupCodesTitle,
                    subtitle = two.backupCodesIntro,
                    primary = TulaAccountOffer("tula.account.submit", two.saved, TulaAccountAction.SavedCodes),
                    codes = TulaAuthCodesContent(label = two.backupCodesList, codes = state.backupCodes),
                    copy = TulaAccountOffer("tula.copy.codes", two.copy, TulaAccountAction.CopyCodes),
                )
                is TulaAccountPanel.TextedFactorCode -> TulaAccountContent(
                    title = a.mfaTitle,
                    subtitle = fill(a.smsFactorSent, "destination", panel.destination),
                    fields = listOf(
                        field(TulaAccountField.CODE, TulaAuthFieldKind.SMS_CODE, strings.codeLabel, TulaAccountAction.ConfirmSms, strings.codeHint),
                    ),
                    primary = TulaAccountOffer("tula.account.submit", two.submit, TulaAccountAction.ConfirmSms),
                    links = back,
                )
                TulaAccountPanel.PhoneNumber -> TulaAccountContent(
                    title = a.phoneTitle,
                    fields = listOf(
                        field(TulaAccountField.PHONE, TulaAuthFieldKind.PHONE, a.phoneNumberLabel, TulaAccountAction.SendPhoneCode, a.phoneNumberHint),
                    ),
                    primary = TulaAccountOffer("tula.account.submit", a.phoneSend, TulaAccountAction.SendPhoneCode),
                    links = back,
                )
                is TulaAccountPanel.PhoneCode -> TulaAccountContent(
                    title = a.phoneTitle,
                    subtitle = fill(a.phoneCodeSent, "destination", panel.destination),
                    fields = listOf(
                        field(TulaAccountField.CODE, TulaAuthFieldKind.SMS_CODE, strings.codeLabel, TulaAccountAction.VerifyPhone, strings.codeHint),
                    ),
                    primary = TulaAccountOffer("tula.account.submit", two.submit, TulaAccountAction.VerifyPhone),
                    links = listOf(TulaAccountOffer("tula.account.differentNumber", a.phoneDifferent, TulaAccountAction.OpenPhone)) + back,
                )
                is TulaAccountPanel.Confirm -> {
                    val (title, question, button) = when (val what = panel.what) {
                        TulaAccountConfirm.TurnOffTotp -> Triple(a.mfaTitle, a.turnOffConfirm, a.turnOff)
                        TulaAccountConfirm.TurnOffSms -> Triple(a.mfaTitle, a.smsTurnOffConfirm, a.smsTurnOff)
                        TulaAccountConfirm.RemovePhone -> Triple(a.phoneTitle, a.phoneRemoveConfirm, a.phoneRemove)
                        is TulaAccountConfirm.RemovePasskey ->
                            Triple(a.passkeysTitle, fill(a.removeConfirm, "name", what.name), a.removeConfirmButton)
                    }
                    TulaAccountContent(
                        title = title,
                        subtitle = question,
                        primary = TulaAccountOffer("tula.account.submit", button, TulaAccountAction.Confirmed, destructive = true),
                        links = back,
                    )
                }
                is TulaAccountPanel.StepUp -> stepUp(panel, strings)
                TulaAccountPanel.Overview -> TulaAccountContent(title = a.title)
            }
        }

        private fun stepUp(panel: TulaAccountPanel.StepUp, strings: TulaStrings): TulaAccountContent {
            val a = strings.account
            val two = strings.secondStep
            val submit = TulaAccountOffer("tula.account.submit", a.stepUpSubmit, TulaAccountAction.SubmitStepUp)
            val code = { kind: TulaAuthFieldKind ->
                listOf(field(TulaAccountField.CODE, kind, strings.codeLabel, TulaAccountAction.SubmitStepUp, strings.codeHint))
            }
            val others = panel.others.map { method ->
                val title = when (method) {
                    TulaStepUpMethod.PASSWORD -> a.passwordInstead
                    TulaStepUpMethod.TOTP -> two.useAuthenticator
                    TulaStepUpMethod.BACKUP_CODE -> two.useBackupCode
                    TulaStepUpMethod.EMAIL_CODE -> a.emailInstead
                    TulaStepUpMethod.SMS_CODE -> a.smsInstead
                    TulaStepUpMethod.PASSKEY -> two.usePasskeyInstead
                }
                TulaAccountOffer("tula.account.way.${method.rawValue}", title, TulaAccountAction.UseStepUpMethod(method))
            } + cancel(a)
            val again = { title: String -> listOf(TulaAccountOffer("tula.account.resend", title, TulaAccountAction.SendStepUpCode)) }
            return when (panel.method) {
                TulaStepUpMethod.PASSWORD -> TulaAccountContent(
                    title = a.stepUpTitle,
                    subtitle = a.stepUpPassword,
                    fields = listOf(
                        field(TulaAccountField.STEP_UP_PASSWORD, TulaAuthFieldKind.PASSWORD, strings.passwordLabel, TulaAccountAction.SubmitStepUp),
                    ),
                    primary = submit,
                    links = others,
                )
                TulaStepUpMethod.TOTP -> TulaAccountContent(
                    title = a.stepUpTitle,
                    subtitle = a.stepUpTotp,
                    fields = listOf(
                        field(TulaAccountField.CODE, TulaAuthFieldKind.CODE, two.totpLabel, TulaAccountAction.SubmitStepUp, strings.codeHint),
                    ),
                    primary = submit,
                    links = others,
                )
                TulaStepUpMethod.BACKUP_CODE -> TulaAccountContent(
                    title = a.stepUpTitle,
                    subtitle = a.stepUpBackup,
                    fields = listOf(
                        field(TulaAccountField.BACKUP_CODE, TulaAuthFieldKind.BACKUP_CODE, two.backupLabel, TulaAccountAction.SubmitStepUp, two.backupHint),
                    ),
                    primary = submit,
                    links = others,
                )
                // Nothing is emailed or texted by arriving: a person asks, and the code field
                // is there only once a message was sent.
                TulaStepUpMethod.EMAIL_CODE -> if (panel.sent == null) {
                    TulaAccountContent(
                        title = a.stepUpTitle,
                        subtitle = a.stepUpEmailPrompt,
                        primary = TulaAccountOffer("tula.account.send", a.stepUpEmailSend, TulaAccountAction.SendStepUpCode),
                        links = others,
                    )
                } else {
                    TulaAccountContent(
                        title = a.stepUpTitle,
                        subtitle = fill(a.stepUpEmailSent, "destination", panel.sent),
                        fields = code(TulaAuthFieldKind.CODE),
                        primary = submit,
                        links = again(strings.resend) + others,
                    )
                }
                TulaStepUpMethod.SMS_CODE -> if (panel.sent == null) {
                    TulaAccountContent(
                        title = a.stepUpTitle,
                        subtitle = a.stepUpSmsPrompt,
                        primary = TulaAccountOffer("tula.account.send", a.stepUpSmsSend, TulaAccountAction.SendStepUpCode),
                        links = others,
                    )
                } else {
                    TulaAccountContent(
                        title = a.stepUpTitle,
                        subtitle = fill(a.stepUpSmsSent, "destination", panel.sent),
                        fields = code(TulaAuthFieldKind.SMS_CODE),
                        primary = submit,
                        links = again(two.smsResend) + others,
                    )
                }
                TulaStepUpMethod.PASSKEY -> TulaAccountContent(
                    title = a.stepUpTitle,
                    subtitle = a.stepUpPasskey,
                    primary = TulaAccountOffer("tula.account.passkey", two.usePasskey, TulaAccountAction.StepUpWithPasskey),
                    links = others,
                )
            }
        }

        // The overview

        private fun unread(id: TulaAccountSectionId, identifier: String, title: String, state: TulaAccountState, a: TulaAccountStrings) =
            if (id in state.failed) {
                TulaAccountSection(
                    identifier = identifier,
                    title = title,
                    lines = listOf(a.sectionFailed),
                    offers = listOf(TulaAccountOffer("$identifier.reload", a.reload, TulaAccountAction.Reload(id))),
                )
            } else {
                TulaAccountSection(identifier = identifier, title = title, loading = true)
            }

        private fun overview(
            state: TulaAccountState,
            strings: TulaStrings,
            passkeySheet: Boolean,
            formatDate: (String) -> String?,
        ): TulaAccountContent {
            val a = strings.account
            val dated = { template: String, iso: String? -> iso?.let(formatDate)?.let { fill(template, "date", it) } }
            val sections = ArrayList<TulaAccountSection>()

            val user = state.user
            if (user == null) {
                sections.add(unread(TulaAccountSectionId.PROFILE, "tula.account.profile", a.profileTitle, state, a))
            } else {
                val name = listOfNotNull(user.firstName, user.lastName).joinToString(" ").trim()
                val email = user.email
                sections.add(
                    TulaAccountSection(
                        identifier = "tula.account.profile",
                        title = a.profileTitle,
                        lines = listOfNotNull(
                            name.ifEmpty { null },
                            email ?: a.noEmail,
                            email?.let { if (user.emailVerifiedAt != null) a.emailVerified else a.emailUnverified },
                        ),
                    ),
                )
                sections.add(
                    if (user.hasPassword) {
                        TulaAccountSection(
                            identifier = "tula.account.password",
                            title = a.passwordTitle,
                            offers = listOf(TulaAccountOffer("tula.account.password.change", a.changePassword, TulaAccountAction.OpenChangePassword)),
                        )
                    } else {
                        TulaAccountSection("tula.account.password", a.passwordTitle, lines = listOf(a.passwordNotSet))
                    },
                )
                val number = user.phoneNumber
                sections.add(
                    TulaAccountSection(
                        identifier = "tula.account.phone",
                        title = a.phoneTitle,
                        lines = listOfNotNull(
                            number ?: a.phoneNone,
                            number?.let { a.phoneVerified.takeIf { user.phoneNumberVerifiedAt != null } },
                            a.phoneUnavailable.takeIf { !state.phoneEnabled && number == null },
                        ),
                        offers = listOfNotNull(
                            TulaAccountOffer("tula.account.phone.add", if (number == null) a.phoneAdd else a.phoneChange, TulaAccountAction.OpenPhone)
                                .takeIf { state.phoneEnabled },
                            number?.let {
                                TulaAccountOffer(
                                    "tula.account.phone.remove", a.phoneRemove, TulaAccountAction.Ask(TulaAccountConfirm.RemovePhone),
                                    destructive = true,
                                )
                            },
                        ),
                    ),
                )
            }

            sections.add(
                state.sessions?.let { sessions(it, a, dated) }
                    ?: unread(TulaAccountSectionId.SESSIONS, "tula.account.sessions", a.sessionsTitle, state, a),
            )
            sections.add(
                state.factors?.let { factors(it, state.mfaRequired, a, dated) }
                    ?: unread(TulaAccountSectionId.FACTORS, "tula.account.factors", a.mfaTitle, state, a),
            )
            sections.add(
                state.passkeys?.let { passkeys(it, state, passkeySheet, a, dated) }
                    ?: unread(TulaAccountSectionId.PASSKEYS, "tula.account.passkeys", a.passkeysTitle, state, a),
            )
            return TulaAccountContent(
                title = a.title,
                sections = sections,
                primary = TulaAccountOffer("tula.account.signOut", a.signOut, TulaAccountAction.SignOut),
            )
        }

        private fun sessions(all: List<Session>, a: TulaAccountStrings, dated: (String, String?) -> String?): TulaAccountSection {
            // This device first; the rest in the server's order.
            val rows = all.sortedByDescending { it.current }.map { session ->
                val device = when (session.client.rawValue) {
                    "web" -> a.clientWeb
                    "ios" -> a.clientIos
                    "android" -> a.clientAndroid
                    "server" -> a.clientServer
                    else -> a.unknownDevice
                }
                TulaAccountRow(
                    identifier = "tula.account.session.${session.id}",
                    title = device,
                    details = listOfNotNull(dated(a.signedInOn, session.createdAt), dated(a.lastActive, session.lastActiveAt)),
                    // In words, and in exactly these: the server knows a key signed, not whose
                    // hands a device is in.
                    marks = listOfNotNull(a.thisDevice.takeIf { session.current }, a.deviceBound.takeIf { session.deviceBound }),
                    offer = if (session.current) {
                        null
                    } else {
                        TulaAccountOffer(
                            identifier = "tula.account.session.${session.id}.signOut",
                            title = a.signOutDevice,
                            action = TulaAccountAction.RevokeSession(session.id),
                            label = fill(a.signOutDeviceLabel, "device", device),
                            destructive = true,
                        )
                    },
                )
            }
            return TulaAccountSection(
                identifier = "tula.account.sessions",
                title = a.sessionsTitle,
                rows = rows,
                offers = listOfNotNull(
                    TulaAccountOffer("tula.account.sessions.signOutOthers", a.signOutOthers, TulaAccountAction.RevokeOthers, destructive = true)
                        .takeIf { all.any { session -> !session.current } },
                ),
            )
        }

        private fun factors(
            factors: Factors,
            required: Boolean,
            a: TulaAccountStrings,
            dated: (String, String?) -> String?,
        ): TulaAccountSection {
            val lines = ArrayList<String>()
            val offers = ArrayList<TulaAccountOffer>()
            if (factors.totp.enabled) {
                lines.add(dated(a.mfaOn, factors.totp.confirmedAt) ?: a.turnedOn)
                val left = factors.backupCodes.remaining
                lines.add(if (left == 1L) a.codesRemainingOne else fill(a.codesRemaining, "count", left.toString()))
                offers.add(TulaAccountOffer("tula.account.factors.regenerate", a.regenerate, TulaAccountAction.RegenerateCodes))
                if (required) {
                    lines.add(a.requiredByApp)
                } else {
                    offers.add(
                        TulaAccountOffer(
                            "tula.account.factors.turnOff", a.turnOff, TulaAccountAction.Ask(TulaAccountConfirm.TurnOffTotp),
                            destructive = true,
                        ),
                    )
                }
            } else {
                lines.add(a.mfaOff)
                offers.add(TulaAccountOffer("tula.account.factors.turnOn", a.turnOn, TulaAccountAction.TurnOnTotp))
            }
            val sms = factors.sms
            if (sms != null && sms.enabled) {
                lines.add(dated(a.smsOn, sms.enabledAt) ?: a.smsTurnedOn)
                // A texted code beside a stronger factor is not asked for: said, not hidden.
                lines.add(if (sms.inUse) a.smsWeaker else a.smsNotInUse)
                offers.add(
                    TulaAccountOffer(
                        "tula.account.factors.sms.turnOff", a.smsTurnOff, TulaAccountAction.Ask(TulaAccountConfirm.TurnOffSms),
                        destructive = true,
                    ),
                )
            } else if (sms != null && sms.available) {
                lines.add(a.smsOffer)
                offers.add(TulaAccountOffer("tula.account.factors.sms.turnOn", a.smsTurnOn, TulaAccountAction.TurnOnSms))
            }
            return TulaAccountSection("tula.account.factors", a.mfaTitle, lines = lines, offers = offers)
        }

        private fun passkeys(
            all: List<Passkey>,
            state: TulaAccountState,
            sheet: Boolean,
            a: TulaAccountStrings,
            dated: (String, String?) -> String?,
        ): TulaAccountSection {
            val lines = arrayListOf(a.passkeysIntro)
            val offers = ArrayList<TulaAccountOffer>()
            if (all.isEmpty()) {
                lines.add(a.passkeysEmpty)
            } else {
                // The client has no call that renames a passkey (TULA-76): said, not faked.
                lines.add(a.renameUnavailable)
            }
            // With passkeys off the list is still shown, to be removed from, without "Add".
            if (state.passkeysOn) {
                val factors = state.factors
                when {
                    !sheet -> lines.add(a.addUnsupported)
                    // Adding a passkey can take the second step over from a texted code: the
                    // button is there only once the account's factors were read.
                    factors == null ->
                        lines.add(if (TulaAccountSectionId.FACTORS in state.failed) a.addUnchecked else a.addChecking)
                    else -> {
                        if (factors.sms?.inUse == true) {
                            lines.add(a.replacesTextedCode)
                        }
                        offers.add(TulaAccountOffer("tula.account.passkeys.add", a.passkeyAdd, TulaAccountAction.AddPasskey))
                    }
                }
            }
            val rows = all.map { passkey ->
                TulaAccountRow(
                    identifier = "tula.account.passkey.${passkey.id}",
                    title = passkey.name,
                    details = listOfNotNull(
                        if (passkey.synced) a.passkeySynced else a.passkeySingleDevice,
                        dated(a.passkeyCreated, passkey.createdAt),
                        if (passkey.lastUsedAt == null) a.passkeyNeverUsed else dated(a.passkeyLastUsed, passkey.lastUsedAt),
                    ),
                    marks = emptyList(),
                    offer = TulaAccountOffer(
                        identifier = "tula.account.passkey.${passkey.id}.remove",
                        title = a.remove,
                        action = TulaAccountAction.Ask(TulaAccountConfirm.RemovePasskey(passkey.id, passkey.name)),
                        label = fill(a.removeLabel, "name", passkey.name),
                        destructive = true,
                    ),
                )
            }
            return TulaAccountSection("tula.account.passkeys", a.passkeysTitle, lines = lines, rows = rows, offers = offers)
        }
    }
}
