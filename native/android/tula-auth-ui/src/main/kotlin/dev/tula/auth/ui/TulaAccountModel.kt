package dev.tula.auth.ui

import dev.tula.auth.AuthState
import dev.tula.auth.ClientErrorCodes
import dev.tula.auth.TulaCeremony
import dev.tula.auth.TulaClient
import dev.tula.auth.TulaError
import dev.tula.auth.generated.CurrentUser
import dev.tula.auth.generated.Factors
import dev.tula.auth.generated.Passkey
import dev.tula.auth.generated.Session
import dev.tula.auth.stepUpMethods
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

// What is behind the account screen: the signed-in user's profile, sessions, second step,
// passkeys and phone number, and the forms that change them. One model: the forms are panels
// over the overview, and a call the server wants a recent authentication for opens the step-up
// panel and is done again after it (ADR 0062).

/** A field of the account's forms. */
enum class TulaAccountField {
    /** The current password, of a password change. */
    CURRENT_PASSWORD,

    /** The new password, of a password change. */
    NEW_PASSWORD,

    /** A 6-digit code: an authenticator's, an emailed or a texted one. */
    CODE,

    /** A backup code, of a step-up. */
    BACKUP_CODE,

    /** A phone number. */
    PHONE,

    /** The password of a step-up. */
    STEP_UP_PASSWORD,
}

/** A way to confirm it is you, as `auth.step_up_required` names it. */
enum class TulaStepUpMethod(
    /** The method's name in the API. */
    val rawValue: String,
) {
    /** The password. */
    PASSWORD("password"),

    /** A code from an authenticator app. */
    TOTP("totp"),

    /** A backup code. */
    BACKUP_CODE("backup_code"),

    /** An emailed code: asked for with a button. */
    EMAIL_CODE("email_code"),

    /** A texted code: asked for with a button. */
    SMS_CODE("sms_code"),

    /** A passkey, through the client's passkey sheet. */
    PASSKEY("passkey"),
}

/** A part of the overview that is read by itself and can fail by itself. */
enum class TulaAccountSectionId {
    /** The profile, the password and the phone number: the user. */
    PROFILE,

    /** Where the user is signed in. */
    SESSIONS,

    /** Two-step verification. */
    FACTORS,

    /** The passkeys. */
    PASSKEYS,
}

/** Something that is asked about before it is done. */
sealed class TulaAccountConfirm {
    /** Turn the authenticator app off. */
    data object TurnOffTotp : TulaAccountConfirm()

    /** Stop using a texted code as the second step. */
    data object TurnOffSms : TulaAccountConfirm()

    /** Remove the phone number. */
    data object RemovePhone : TulaAccountConfirm()

    /** Remove a passkey. [name] is the passkey's own name, for the question. */
    data class RemovePasskey(val id: String, val name: String) : TulaAccountConfirm()
}

/** What is drawn: the overview, or one form over it. */
sealed class TulaAccountPanel {
    /** The sections. */
    data object Overview : TulaAccountPanel()

    /** The current and the new password. */
    data object ChangePassword : TulaAccountPanel()

    /** An authenticator's setup key and QR code, and the field for its first code. */
    data object TotpSetup : TulaAccountPanel()

    /** Backup codes, shown once. */
    data object BackupCodes : TulaAccountPanel()

    /** The texted code that turns a texted second step on. */
    data class TextedFactorCode(val destination: String) : TulaAccountPanel()

    /** The phone number to add. */
    data object PhoneNumber : TulaAccountPanel()

    /** The texted code that proves the number. */
    data class PhoneCode(val destination: String) : TulaAccountPanel()

    /** A question before something is removed or turned off. */
    data class Confirm(val what: TulaAccountConfirm) : TulaAccountPanel()

    /**
     * "Confirm it is you". [method] is the open way, [others] the ways the server also named
     * that this client can take, in the server's order, [sent] where an emailed or texted code
     * went (its code field is drawn only then).
     */
    data class StepUp(
        val method: TulaStepUpMethod,
        val others: List<TulaStepUpMethod> = emptyList(),
        val sent: String? = null,
    ) : TulaAccountPanel()

    /** The fields the panel has, in the order they are drawn. */
    val fields: List<TulaAccountField>
        get() = when (this) {
            ChangePassword -> listOf(TulaAccountField.CURRENT_PASSWORD, TulaAccountField.NEW_PASSWORD)
            TotpSetup, is TextedFactorCode, is PhoneCode -> listOf(TulaAccountField.CODE)
            PhoneNumber -> listOf(TulaAccountField.PHONE)
            is StepUp -> when (method) {
                TulaStepUpMethod.PASSWORD -> listOf(TulaAccountField.STEP_UP_PASSWORD)
                TulaStepUpMethod.TOTP -> listOf(TulaAccountField.CODE)
                TulaStepUpMethod.BACKUP_CODE -> listOf(TulaAccountField.BACKUP_CODE)
                TulaStepUpMethod.EMAIL_CODE, TulaStepUpMethod.SMS_CODE ->
                    if (sent == null) emptyList() else listOf(TulaAccountField.CODE)
                TulaStepUpMethod.PASSKEY -> emptyList()
            }
            Overview, BackupCodes, is Confirm -> emptyList()
        }
}

/** Something a person can ask the account screen to do. */
sealed class TulaAccountAction {
    /** Read a section again after it could not be read. */
    data class Reload(val section: TulaAccountSectionId) : TulaAccountAction()

    /** Open the password form. */
    data object OpenChangePassword : TulaAccountAction()

    /** Send the password form. */
    data object SubmitPassword : TulaAccountAction()

    /** Sign one other session out. */
    data class RevokeSession(val id: String) : TulaAccountAction()

    /** Sign every other session out. */
    data object RevokeOthers : TulaAccountAction()

    /** Sign this device out. */
    data object SignOut : TulaAccountAction()

    /** Start setting up an authenticator app. */
    data object TurnOnTotp : TulaAccountAction()

    /** Confirm the authenticator app with its first code. */
    data object ConfirmTotp : TulaAccountAction()

    /** Copy the setup key, on a press. */
    data object CopySetupKey : TulaAccountAction()

    /** Copy the backup codes, on a press. */
    data object CopyCodes : TulaAccountAction()

    /** Leave the backup codes: they are not shown again. */
    data object SavedCodes : TulaAccountAction()

    /** Make new backup codes; the earlier ones stop working. */
    data object RegenerateCodes : TulaAccountAction()

    /** Ask for the texted code that turns a texted second step on. */
    data object TurnOnSms : TulaAccountAction()

    /** Send that code. */
    data object ConfirmSms : TulaAccountAction()

    /** Ask before something is removed or turned off. */
    data class Ask(val what: TulaAccountConfirm) : TulaAccountAction()

    /** Do what the question was about. */
    data object Confirmed : TulaAccountAction()

    /** Leave the open form. Nothing is changed. */
    data object Cancel : TulaAccountAction()

    /** Add a passkey, through the client's passkey sheet. */
    data object AddPasskey : TulaAccountAction()

    /** Open the phone number form. */
    data object OpenPhone : TulaAccountAction()

    /** Ask for the code that proves the typed number. */
    data object SendPhoneCode : TulaAccountAction()

    /** Send that code. */
    data object VerifyPhone : TulaAccountAction()

    /** Send what the step-up form holds. */
    data object SubmitStepUp : TulaAccountAction()

    /** Ask for the emailed or texted code of a step-up. */
    data object SendStepUpCode : TulaAccountAction()

    /** Confirm it is you with a passkey. */
    data object StepUpWithPasskey : TulaAccountAction()

    /** Confirm it is you another way the server named. */
    data class UseStepUpMethod(val method: TulaStepUpMethod) : TulaAccountAction()
}

/** Where the focus is asked to go on the account screen. */
sealed class TulaAccountFocus {
    /** The title of what is drawn: after a change of panel. */
    data object Title : TulaAccountFocus()

    /** A field: after a failure that is about it. */
    data class Field(val field: TulaAccountField) : TulaAccountFocus()
}

/**
 * Everything the account screen draws from, at one moment.
 *
 * **It can hold a password, a code, a setup key and backup codes** while their form is open,
 * and the user's address and number: it prints as its type's name. Never log one, never put
 * one in a `Bundle`, a `SavedStateHandle` or `rememberSaveable`.
 */
data class TulaAccountState(
    /** What is drawn. */
    val panel: TulaAccountPanel = TulaAccountPanel.Overview,
    /** The user, once read. */
    val user: CurrentUser? = null,
    /** The sessions, once read. */
    val sessions: List<Session>? = null,
    /** The second step, once read. */
    val factors: Factors? = null,
    /** The passkeys, once read. */
    val passkeys: List<Passkey>? = null,
    /** The sections that could not be read. */
    val failed: Set<TulaAccountSectionId> = emptySet(),
    /** Whether the environment requires a second step (it then cannot be turned off). */
    val mfaRequired: Boolean = false,
    /** Whether a phone number can be added. */
    val phoneEnabled: Boolean = false,
    /** Whether passkeys are on. `true` until the configuration says otherwise. */
    val passkeysOn: Boolean = true,
    /** What the fields hold. A secret is emptied as it is sent and when its form is left. */
    val text: Map<TulaAccountField, String> = emptyMap(),
    /** The password fields whose text is drawn in the clear. */
    val revealed: Set<TulaAccountField> = emptySet(),
    /** Whether a call is on its way. A second one is not started meanwhile. */
    val isPending: Boolean = false,
    /** What went wrong that is not about one field. */
    val formError: String? = null,
    /** What is wrong with each field. */
    val fieldErrors: Map<TulaAccountField, List<String>> = emptyMap(),
    /** Something that went right, in words. */
    val status: String? = null,
    /** Something that is neither: a sheet that was closed, a form that was left. */
    val notice: String? = null,
    /** Where the focus was last asked to go. */
    val focus: TulaAccountFocus = TulaAccountFocus.Title,
    /** Counts the requests to move the focus. */
    val focusRequests: Int = 0,
    /** An authenticator's setup key, only while its form is open. */
    val setup: TulaAuthSetup? = null,
    /** Backup codes, only while their form is open. */
    val backupCodes: List<String> = emptyList(),
    /** The server was told and the session is over: nothing of the account is drawn. */
    val signedOut: Boolean = false,
    /**
     * A sign-out the server could not be told of: the session may still be active there.
     * Nothing of the account is drawn, and signing out is offered again.
     */
    val signOutFailed: Boolean = false,
) {
    /** The type's name: nothing it holds is printed. */
    override fun toString(): String = "TulaAccountState"
}

/**
 * What is behind the account screen. A composable draws [content] and calls [perform]; it
 * decides nothing. No Compose and no Android: all of it is tested on the JVM.
 *
 * **It holds no token.** What a form holds is emptied when the form is left and by [close];
 * a setup key and backup codes are held only while their form is open.
 *
 * **A call the server wants a recent authentication for** (`auth.step_up_required`) opens the
 * step-up panel with the ways the server named that this client can take; once one is proven
 * the call is made again, or, where what was typed has been emptied, its form is shown again
 * with words. With no way this client can take, that is said and nothing is asked.
 *
 * **A failed sign-out is not a sign-out**: the server could not be told, the session may live
 * on there, and the screen says so and offers to sign out again. [onSignedOut] is called only
 * once the server was told.
 *
 * **The account is the session's it was read for.** The model asks the client whose session it
 * is when the account is read, when something is asked for and when an answer arrives. A
 * session that ended elsewhere (it was revoked, its refresh was refused) empties the screen and
 * is told to the app through [onSignedOut], once, however often the account is read afterwards.
 * Where the client has become another session's, everything read or typed for the one before
 * is dropped, and so is an answer that was asked as it. The model is told nothing by itself: it
 * finds out at its next call, so an app that keeps one across a sign-out reads it again.
 *
 * @param client The app's client.
 * @param strings The strings.
 * @param announce Says a message to a screen reader.
 * @param onSignedOut Called when nobody is signed in any more: once for a sign-out of this
 *   screen the server was told of, and once for a session the screen finds ended elsewhere.
 *   Never for a sign-out that failed, and never while one is waiting to be tried again.
 * @param copy Puts a text on the clipboard, marked as sensitive. Called only on a press.
 * @param formatDate Writes a time of the API (ISO 8601) for a person, or `null` for a text
 *   that is no time: a line with a time that cannot be read is left out, never drawn raw.
 */
class TulaAccountModel(
    private val client: TulaClient,
    strings: TulaStrings = TulaStrings(),
    private val announce: (String) -> Unit = {},
    private val onSignedOut: (() -> Unit)? = null,
    private val copy: (String) -> Unit = {},
    private val formatDate: (String) -> String? = TulaAccountContent::defaultDate,
) {
    private val lock = Any()

    // Everything below is read and written under `lock`.
    private var s = TulaAccountState()
    private var words = strings

    /**
     * Grows when the screen is closed, the session ends or the client's session is another
     * one: an older answer is dropped.
     */
    private var generation = 0

    /** The session what is drawn was read for; `null` until one was seen, and after one ended. */
    private var shownFor: String? = null

    /** This screen's own sign-out is on its way: the session it ends did not end elsewhere. */
    private var signingOut = false

    /** What to do once a step-up was proven. */
    private var owed: Owed? = null

    private val effects = ArrayList<() -> Unit>()
    private val published = MutableStateFlow(s)

    /** Where a proven step-up goes back to, and the action that is then done again, if any. */
    private class Owed(val back: TulaAccountPanel, val again: TulaAccountAction?)

    /** What the screen draws, and every change of it. */
    val state: StateFlow<TulaAccountState> = published.asStateFlow()

    /** The strings the messages are taken from. */
    var strings: TulaStrings
        get() = synchronized(lock) { words }
        set(value) = locked { words = value }

    /** What is drawn now. */
    val content: TulaAccountContent
        get() = synchronized(lock) { TulaAccountContent.of(s, words, client.sheets.passkeys, formatDate) }

    /** The type's name: nothing the model holds is printed. */
    override fun toString(): String = "TulaAccountModel"

    private inline fun <T> locked(crossinline change: () -> T): T {
        val after: List<() -> Unit>
        val result: T
        synchronized(lock) {
            try {
                result = change()
            } finally {
                published.value = s
            }
            after = effects.toList()
            effects.clear()
        }
        after.forEach { it() }
        return result
    }

    private fun say(message: String) {
        effects.add { announce(message) }
    }

    /**
     * Under the lock: bring the screen to the client's session. Where that is another one than
     * what is drawn was read for, nothing of the one before is kept: not what was read, not
     * what was typed, not a step-up that was owed a call.
     */
    private fun sync() {
        val now = (client.state.value as? AuthState.SignedIn)?.sessionId ?: return
        if (now == shownFor) {
            return
        }
        // The first session this screen sees, with nothing drawn yet, is simply its own.
        val untouched = shownFor == null && !s.signedOut && !s.signOutFailed
        shownFor = now
        if (!untouched) {
            generation += 1
            owed = null
            s = TulaAccountState()
        }
    }

    /** Under the lock: the generation, once the screen was brought to the client's session. */
    private fun current(): Int {
        sync()
        return generation
    }

    /**
     * Under the lock: whether the client holds no session and this screen did not end it. If
     * so the account is nobody's: the screen is emptied and the app is told, once. Not while
     * this screen's own sign-out is on its way or failed: that one is said by itself.
     */
    private fun endedElsewhere(): Boolean {
        if (client.state.value !is AuthState.SignedOut || s.signedOut || s.signOutFailed || signingOut) {
            return false
        }
        generation += 1
        owed = null
        shownFor = null
        s = TulaAccountState(signedOut = true)
        onSignedOut?.let { effects.add(it) }
        return true
    }

    private fun ask(target: TulaAccountFocus) {
        s = s.copy(focus = target, focusRequests = s.focusRequests + 1)
    }

    private fun clearMessages() {
        s = s.copy(formError = null, fieldErrors = emptyMap(), status = null, notice = null)
    }

    /**
     * Go to a panel. Every field is emptied, the setup key and the codes with them; the typed
     * phone number alone is kept between its form, a step-up and its code.
     */
    private fun show(next: TulaAccountPanel, setup: TulaAuthSetup? = null, codes: List<String> = emptyList()) {
        val number = s.text[TulaAccountField.PHONE]
        val keeps = next is TulaAccountPanel.StepUp || next is TulaAccountPanel.PhoneCode || next == TulaAccountPanel.PhoneNumber
        clearMessages()
        s = s.copy(
            panel = next,
            text = if (keeps && number != null) mapOf(TulaAccountField.PHONE to number) else emptyMap(),
            revealed = emptySet(),
            setup = setup,
            backupCodes = codes,
        )
        ask(TulaAccountFocus.Title)
    }

    /**
     * The screen is closing: forget what every form held and go back to the overview. An
     * answer still on its way changes nothing. Nobody is signed out by it.
     */
    fun close(): Unit = locked {
        generation += 1
        owed = null
        s = s.copy(isPending = false)
        show(TulaAccountPanel.Overview)
    }

    /**
     * Take what was typed into a field. A code field keeps the digits of a code.
     *
     * @param field A field of the open panel.
     * @param typed What it holds now.
     */
    fun setText(field: TulaAccountField, typed: String): Unit = locked {
        val kept = when (field) {
            TulaAccountField.CODE -> TulaAuthModel.digits(typed)
            TulaAccountField.BACKUP_CODE -> typed.take(TulaAuthModel.BACKUP_CODE_MAX)
            TulaAccountField.PHONE -> typed.take(PHONE_MAX)
            else -> typed
        }
        s = s.copy(text = s.text + (field to kept))
    }

    /**
     * "Show password" and "hide password" for a password field of the open panel.
     *
     * @param field A password field.
     */
    fun toggleReveal(field: TulaAccountField): Unit = locked {
        if (field in SECRETS && field in s.panel.fields) {
            s = s.copy(revealed = if (field in s.revealed) s.revealed - field else s.revealed + field)
        }
    }

    /**
     * What is wrong with a field, each worded as a problem ("Error: …").
     *
     * @param field A field.
     * @return Its problems, in words.
     */
    fun problems(field: TulaAccountField): List<String> = synchronized(lock) {
        s.fieldErrors[field].orEmpty().map { TulaStrings.format(words.errorPrefix, mapOf("message" to it)) }
    }

    /** What went wrong that is not about one field, worded as a problem. */
    val formProblem: String?
        get() = synchronized(lock) {
            s.formError?.let { TulaStrings.format(words.errorPrefix, mapOf("message" to it)) }
        }

    // Reading

    /**
     * Read the account: the user, the sessions, the second step, the passkeys and what the
     * environment allows. Each is read by itself: one that fails is said in its section, with
     * a way to read it again, and the others are drawn.
     */
    suspend fun load() {
        val asked = locked<Int?> {
            sync()
            // Nobody is signed in: there is nothing to ask, and nothing to say a second time.
            if (endedElsewhere() || s.signedOut || s.signOutFailed) null else generation
        } ?: return
        for (section in TulaAccountSectionId.entries) {
            read(section, asked)
        }
        val config = try {
            client.config()
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            return
        }
        locked {
            if (asked == current()) {
                s = s.copy(
                    mfaRequired = config.mfa?.policy?.rawValue == "required",
                    phoneEnabled = config.phone?.enabled == true,
                    passkeysOn = "passkey" in config.signIn.methods,
                )
            }
        }
    }

    private suspend fun read(section: TulaAccountSectionId, asked: Int) {
        val change: (TulaAccountState) -> TulaAccountState = try {
            when (section) {
                TulaAccountSectionId.PROFILE -> client.user().let { read -> { it.copy(user = read) } }
                TulaAccountSectionId.SESSIONS -> client.sessions().let { read -> { it.copy(sessions = read) } }
                TulaAccountSectionId.FACTORS -> client.factors.get().let { read -> { it.copy(factors = read) } }
                TulaAccountSectionId.PASSKEYS -> client.passkeys.list().let { read -> { it.copy(passkeys = read) } }
            }
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            locked {
                // A session that ended is not a section that could not be read.
                if (!endedElsewhere() && asked == current() && !s.signedOut && !s.signOutFailed) {
                    s = s.copy(failed = s.failed + section)
                }
            }
            return
        }
        locked {
            if (asked == current() && !s.signedOut && !s.signOutFailed) {
                s = change(s).copy(failed = s.failed - section)
            }
        }
    }

    private suspend fun refresh(vararg sections: TulaAccountSectionId) {
        val asked = locked { current() }
        for (section in sections) {
            read(section, asked)
        }
    }

    // Actions

    /**
     * Do what a button or a link of what is drawn asks. An action that is not offered now does
     * nothing: it cannot be asked for.
     *
     * @param action An action of [content].
     */
    suspend fun perform(action: TulaAccountAction) {
        if (locked { offered(action) }) {
            execute(action)
        }
    }

    /** Under the lock: whether what is drawn for the client's session offers an action. */
    private fun offered(action: TulaAccountAction): Boolean {
        sync()
        return action in TulaAccountContent.of(s, words, client.sheets.passkeys, formatDate).actions
    }

    /**
     * Do again what a step-up was proven for, if it is still this screen's to do: the screen
     * was not closed, the form not left and the session not changed since the proof was
     * accepted, and what is drawn still offers the act.
     *
     * @param again The act, or `null` when what it sends has to be typed again.
     * @param proved The generation the proof was accepted under.
     */
    private suspend fun repeat(again: TulaAccountAction?, proved: Int) {
        if (again != null && locked { proved == current() && offered(again) }) {
            execute(again)
        }
    }

    private suspend fun execute(action: TulaAccountAction) {
        when (action) {
            is TulaAccountAction.Reload -> refresh(action.section)
            TulaAccountAction.OpenChangePassword -> open(TulaAccountPanel.ChangePassword)
            TulaAccountAction.OpenPhone -> open(TulaAccountPanel.PhoneNumber)
            is TulaAccountAction.Ask -> open(TulaAccountPanel.Confirm(action.what))
            TulaAccountAction.Cancel -> cancel()
            TulaAccountAction.SubmitPassword -> submitPassword()
            is TulaAccountAction.RevokeSession -> revoke(action)
            TulaAccountAction.RevokeOthers -> revokeOthers()
            TulaAccountAction.SignOut -> signOut()
            TulaAccountAction.TurnOnTotp -> turnOnTotp()
            TulaAccountAction.ConfirmTotp -> confirmTotp()
            TulaAccountAction.CopySetupKey -> copySecret(setupKey = true)
            TulaAccountAction.CopyCodes -> copySecret(setupKey = false)
            TulaAccountAction.SavedCodes -> locked {
                if (s.panel == TulaAccountPanel.BackupCodes) {
                    show(TulaAccountPanel.Overview)
                }
            }
            TulaAccountAction.RegenerateCodes -> regenerate()
            TulaAccountAction.TurnOnSms -> turnOnSms()
            TulaAccountAction.ConfirmSms -> confirmSms()
            TulaAccountAction.Confirmed -> confirmed()
            TulaAccountAction.AddPasskey -> addPasskey()
            TulaAccountAction.SendPhoneCode -> sendPhoneCode()
            TulaAccountAction.VerifyPhone -> verifyPhone()
            TulaAccountAction.SubmitStepUp -> submitStepUp()
            TulaAccountAction.SendStepUpCode -> sendStepUpCode()
            TulaAccountAction.StepUpWithPasskey -> stepUpWithPasskey()
            is TulaAccountAction.UseStepUpMethod -> locked {
                val panel = s.panel as? TulaAccountPanel.StepUp ?: return@locked
                if (action.method in panel.others && !s.isPending) {
                    val all = listOf(panel.method) + panel.others
                    // The server's order is kept: the open way is the one that moved.
                    show(TulaAccountPanel.StepUp(action.method, all.filter { it != action.method }))
                }
            }
        }
    }

    private fun open(panel: TulaAccountPanel): Unit = locked {
        if (!s.isPending) {
            show(panel)
        }
    }

    private fun cancel(): Unit = locked {
        if (s.panel == TulaAccountPanel.Overview) {
            return@locked
        }
        // A call still on its way is the form's: its answer is dropped with the form.
        generation += 1
        owed = null
        s = s.copy(isPending = false)
        show(TulaAccountPanel.Overview)
        s = s.copy(notice = words.account.nothingChanged)
        say(words.account.nothingChanged)
    }

    private fun begin(): Int? {
        if (s.isPending) {
            return null
        }
        s = s.copy(isPending = true)
        clearMessages()
        return generation
    }

    /** Whether nothing is missing; otherwise the fields are marked and the first takes the focus. */
    private fun require(missing: List<TulaAccountField>, message: String? = null): Boolean {
        if (s.isPending) {
            return false
        }
        val first = missing.firstOrNull() ?: return true
        clearMessages()
        val said = message ?: words.required
        s = s.copy(fieldErrors = missing.associateWith { listOf(if (it == first) said else words.required) })
        ask(TulaAccountFocus.Field(first))
        say(said)
        return false
    }

    private fun typed(field: TulaAccountField): String = s.text[field].orEmpty()

    private fun empty(vararg fields: TulaAccountField) {
        s = s.copy(text = s.text - fields.toSet(), revealed = s.revealed - fields.toSet())
    }

    /**
     * Make one call for what is drawn.
     *
     * @param after Where a proven step-up goes back to, and what is then done again.
     * @param prepare Under the lock: check what was typed and hand back the call, or `null`
     *   when there is nothing to send.
     * @param then Under the lock, with the answer, when what is drawn is still what asked.
     * @return Whether the call was made and answered for what is drawn.
     */
    private suspend fun <T> call(after: Owed, prepare: () -> (suspend () -> T)?, then: (T) -> Unit): Boolean {
        var asked = 0
        val send = locked<(suspend () -> T)?> {
            val made = prepare() ?: return@locked null
            asked = begin() ?: return@locked null
            made
        } ?: return false
        val answer = try {
            send()
        } catch (cancelled: CancellationException) {
            locked {
                if (asked == current()) {
                    s = s.copy(isPending = false)
                }
            }
            throw cancelled
        } catch (error: Exception) {
            locked { fail(error, asked, after) }
            return false
        }
        return locked {
            if (asked != current()) {
                return@locked false
            }
            s = s.copy(isPending = false)
            then(answer)
            true
        }
    }

    private fun here(again: TulaAccountAction?): Owed = synchronized(lock) { Owed(s.panel, again) }

    private fun fail(error: Exception, asked: Int, after: Owed) {
        if (endedElsewhere() || asked != current()) {
            return
        }
        s = s.copy(isPending = false)
        if (error !is TulaError) {
            s = s.copy(formError = words.unknownError)
            say(words.unknownError)
            return
        }
        when (error.code) {
            STEP_UP_REQUIRED -> stepUp(error, after)
            ClientErrorCodes.FLOW_BUSY -> {
                s = s.copy(notice = words.account.sheetBusy)
                say(words.account.sheetBusy)
            }
            else -> place(error)
        }
    }

    // Step-up

    /** The server wants a recent authentication: open the ways it named that this client can take. */
    private fun stepUp(error: TulaError, after: Owed) {
        val methods = error.stepUpMethods.mapNotNull { name -> TulaStepUpMethod.entries.firstOrNull { it.rawValue == name } }
            .filter { it != TulaStepUpMethod.PASSKEY || client.sheets.passkeys }
            .distinct()
        val first = methods.firstOrNull()
        if (first == null || s.panel is TulaAccountPanel.StepUp) {
            // No way this client can take (or a proof that itself asks for a proof): nothing
            // can be asked for here.
            s = s.copy(formError = words.account.stepUpNoMethod)
            say(words.account.stepUpNoMethod)
            return
        }
        owed = after
        show(TulaAccountPanel.StepUp(first, methods.drop(1)))
    }

    /** Under the lock: a step-up was proven. Go back, and hand out what is done again. */
    private fun proven(): TulaAccountAction? {
        val was = owed
        owed = null
        show(was?.back ?: TulaAccountPanel.Overview)
        if (was?.again == null) {
            // What was typed was emptied as it was sent: it is typed again.
            s = s.copy(status = words.account.stepUpDone)
            say(words.account.stepUpDone)
        }
        return was?.again
    }

    private suspend fun submitStepUp() {
        var again: TulaAccountAction? = null
        var proved = 0
        val done = call(
            after = here(null),
            prepare = prepare@{
                val panel = s.panel as? TulaAccountPanel.StepUp ?: return@prepare null
                val field = panel.fields.firstOrNull() ?: return@prepare null
                val value = typed(field).let { if (field == TulaAccountField.STEP_UP_PASSWORD) it else it.trim() }
                val missing = when {
                    field == TulaAccountField.CODE && value.length != TulaAuthModel.CODE_LENGTH -> words.codeIncomplete
                    field == TulaAccountField.BACKUP_CODE && value.isEmpty() -> words.secondStep.backupRequired
                    value.isEmpty() -> words.required
                    else -> null
                }
                if (missing != null) {
                    require(listOf(field), missing)
                    return@prepare null
                }
                empty(field)
                val proof: suspend () -> Unit = when (panel.method) {
                    TulaStepUpMethod.PASSWORD -> ({ client.stepUp.withPassword(value) })
                    TulaStepUpMethod.TOTP -> ({ client.stepUp.withTotp(value) })
                    TulaStepUpMethod.BACKUP_CODE -> ({ client.stepUp.withBackupCode(value) })
                    TulaStepUpMethod.EMAIL_CODE -> ({ client.stepUp.withEmailCode(value) })
                    TulaStepUpMethod.SMS_CODE -> ({ client.stepUp.withSmsCode(value) })
                    TulaStepUpMethod.PASSKEY -> return@prepare null
                }
                proof
            },
            then = {
                again = proven()
                proved = generation
            },
        )
        if (done) {
            repeat(again, proved)
        }
    }

    private suspend fun sendStepUpCode() {
        call<String>(
            after = here(null),
            prepare = prepare@{
                val panel = s.panel as? TulaAccountPanel.StepUp ?: return@prepare null
                when (panel.method) {
                    TulaStepUpMethod.EMAIL_CODE -> ({ client.stepUp.sendEmailCode().destination })
                    TulaStepUpMethod.SMS_CODE -> ({ client.stepUp.sendSmsCode().destination })
                    else -> null
                }
            },
            then = { destination ->
                val panel = s.panel as? TulaAccountPanel.StepUp ?: return@call
                val again = panel.sent != null
                s = s.copy(panel = panel.copy(sent = destination))
                if (again) {
                    s = s.copy(status = words.resent)
                    say(words.resent)
                } else {
                    ask(TulaAccountFocus.Field(TulaAccountField.CODE))
                }
            },
        )
    }

    private suspend fun stepUpWithPasskey() {
        var again: TulaAccountAction? = null
        var proved = 0
        val done = call<TulaCeremony<Unit>>(
            after = here(null),
            prepare = prepare@{
                val panel = s.panel as? TulaAccountPanel.StepUp ?: return@prepare null
                if (panel.method == TulaStepUpMethod.PASSKEY) ({ client.stepUp.withPasskey() }) else null
            },
            then = { outcome ->
                when (outcome) {
                    is TulaCeremony.Finished<*> -> {
                        again = proven()
                        proved = generation
                    }
                    TulaCeremony.Dismissed -> {
                        s = s.copy(notice = words.account.passkeyDismissed)
                        say(words.account.passkeyDismissed)
                    }
                }
            },
        )
        if (done) {
            repeat(again, proved)
        }
    }

    // The password

    private suspend fun submitPassword() {
        val done = call(
            after = here(null),
            prepare = prepare@{
                if (s.panel != TulaAccountPanel.ChangePassword) {
                    return@prepare null
                }
                val current = typed(TulaAccountField.CURRENT_PASSWORD)
                val next = typed(TulaAccountField.NEW_PASSWORD)
                val missing = listOf(TulaAccountField.CURRENT_PASSWORD to current, TulaAccountField.NEW_PASSWORD to next)
                    .filter { it.second.isEmpty() }.map { it.first }
                if (!require(missing)) {
                    return@prepare null
                }
                // The current password is emptied as it is sent; the one being chosen is kept
                // when it is refused, to be put right.
                empty(TulaAccountField.CURRENT_PASSWORD)
                suspend { client.changePassword(current, next) }
            },
            then = {
                show(TulaAccountPanel.Overview)
                s = s.copy(status = words.account.passwordChanged)
                say(words.account.passwordChanged)
            },
        )
        if (done) {
            refresh(TulaAccountSectionId.SESSIONS)
        }
    }

    // Sessions

    private suspend fun revoke(action: TulaAccountAction.RevokeSession) {
        val done = call(
            after = here(action),
            prepare = { suspend { client.revokeSession(action.id) } },
            then = {
                s = s.copy(sessions = s.sessions?.filter { it.id != action.id }, status = words.account.deviceSignedOut)
                say(words.account.deviceSignedOut)
            },
        )
        if (done) {
            refresh(TulaAccountSectionId.SESSIONS)
        }
    }

    private suspend fun revokeOthers() {
        val done = call(
            after = here(TulaAccountAction.RevokeOthers),
            prepare = { suspend { client.revokeOtherSessions() } },
            then = { count ->
                val message = if (count == 1L) {
                    words.account.othersSignedOutOne
                } else {
                    TulaStrings.format(words.account.othersSignedOut, mapOf("count" to count.toString()))
                }
                s = s.copy(sessions = s.sessions?.filter { it.current }, status = message)
                say(message)
            },
        )
        if (done) {
            refresh(TulaAccountSectionId.SESSIONS)
        }
    }

    /**
     * Sign this device out. A sign-out the server could not be told of is not a sign-out: the
     * screen says so and offers it again, and the app is told only once it went through.
     */
    private suspend fun signOut() {
        val asked = locked { begin()?.also { signingOut = true } } ?: return
        try {
            client.session.signOut()
        } catch (cancelled: CancellationException) {
            locked {
                signingOut = false
                if (asked == current()) {
                    s = s.copy(isPending = false)
                }
            }
            throw cancelled
        } catch (_: Exception) {
            locked {
                signingOut = false
                generation += 1
                owed = null
                shownFor = null
                // Nothing of the account is kept: the client holds no session any more.
                s = TulaAccountState(signOutFailed = true, formError = words.account.signOutFailed)
                ask(TulaAccountFocus.Title)
                say(words.account.signOutFailed)
            }
            return
        }
        locked {
            signingOut = false
            generation += 1
            owed = null
            shownFor = null
            s = TulaAccountState(signedOut = true)
            onSignedOut?.let { effects.add(it) }
        }
    }

    // Two-step verification

    private suspend fun turnOnTotp() {
        call(
            after = Owed(TulaAccountPanel.Overview, TulaAccountAction.TurnOnTotp),
            prepare = { suspend { client.factors.startTotp() } },
            then = { show(TulaAccountPanel.TotpSetup, setup = TulaAuthSetup(it.secret, it.uri)) },
        )
    }

    private suspend fun confirmTotp() {
        val done = call(
            // The key is emptied with its form: after a step-up the setup starts again.
            after = Owed(TulaAccountPanel.Overview, TulaAccountAction.TurnOnTotp),
            prepare = prepare@{
                if (s.panel != TulaAccountPanel.TotpSetup) {
                    return@prepare null
                }
                val code = typed(TulaAccountField.CODE)
                val missing = if (code.length == TulaAuthModel.CODE_LENGTH) emptyList() else listOf(TulaAccountField.CODE)
                if (!require(missing, words.codeIncomplete)) {
                    return@prepare null
                }
                empty(TulaAccountField.CODE)
                suspend { client.factors.confirmTotp(code) }
            },
            then = { codes ->
                show(TulaAccountPanel.BackupCodes, codes = codes)
                s = s.copy(status = words.account.turnedOn)
                say(words.account.turnedOn)
            },
        )
        if (done) {
            refresh(TulaAccountSectionId.FACTORS)
        }
    }

    private suspend fun regenerate() {
        val done = call(
            after = Owed(TulaAccountPanel.Overview, TulaAccountAction.RegenerateCodes),
            prepare = { suspend { client.factors.regenerateBackupCodes() } },
            then = { codes ->
                show(TulaAccountPanel.BackupCodes, codes = codes)
                s = s.copy(status = words.account.regenerated)
                say(words.account.regenerated)
            },
        )
        if (done) {
            refresh(TulaAccountSectionId.FACTORS)
        }
    }

    private suspend fun turnOnSms() {
        call(
            after = Owed(TulaAccountPanel.Overview, TulaAccountAction.TurnOnSms),
            prepare = { suspend { client.factors.startSms() } },
            then = { show(TulaAccountPanel.TextedFactorCode(it.destination)) },
        )
    }

    private suspend fun confirmSms() {
        call(
            after = here(null),
            prepare = prepare@{
                if (s.panel !is TulaAccountPanel.TextedFactorCode) {
                    return@prepare null
                }
                val code = typed(TulaAccountField.CODE)
                val missing = if (code.length == TulaAuthModel.CODE_LENGTH) emptyList() else listOf(TulaAccountField.CODE)
                if (!require(missing, words.codeIncomplete)) {
                    return@prepare null
                }
                empty(TulaAccountField.CODE)
                suspend { client.factors.confirmSms(code) }
            },
            then = { factors ->
                show(TulaAccountPanel.Overview)
                s = s.copy(factors = factors, status = words.account.smsTurnedOn)
                say(words.account.smsTurnedOn)
            },
        )
    }

    /** "Yes" to the open question. */
    private suspend fun confirmed() {
        val what = synchronized(lock) { (s.panel as? TulaAccountPanel.Confirm)?.what } ?: return
        val a = synchronized(lock) { words.account }
        val (send, said, sections) = when (what) {
            TulaAccountConfirm.TurnOffTotp ->
                Triple(suspend { client.factors.disableTotp() }, a.turnedOff, listOf(TulaAccountSectionId.FACTORS))
            TulaAccountConfirm.TurnOffSms ->
                Triple(suspend { client.factors.disableSms() }, a.smsTurnedOff, listOf(TulaAccountSectionId.FACTORS))
            TulaAccountConfirm.RemovePhone ->
                Triple(suspend { client.phone.remove() }, a.phoneRemoved, listOf(TulaAccountSectionId.PROFILE, TulaAccountSectionId.FACTORS))
            is TulaAccountConfirm.RemovePasskey ->
                Triple(suspend { client.passkeys.remove(what.id) }, a.passkeyRemoved, listOf(TulaAccountSectionId.PASSKEYS, TulaAccountSectionId.FACTORS))
        }
        val done = call(
            after = here(TulaAccountAction.Confirmed),
            prepare = { if (s.panel == TulaAccountPanel.Confirm(what)) send else null },
            then = {
                show(TulaAccountPanel.Overview)
                s = s.copy(status = said)
                say(said)
            },
        )
        if (done) {
            refresh(*sections.toTypedArray())
        }
    }

    // Passkeys

    private suspend fun addPasskey() {
        var added = false
        val done = call(
            after = Owed(TulaAccountPanel.Overview, TulaAccountAction.AddPasskey),
            prepare = { suspend { client.passkeys.add() } },
            then = { outcome ->
                when (outcome) {
                    is TulaCeremony.Finished<*> -> {
                        added = true
                        s = s.copy(status = words.account.passkeyAdded)
                        say(words.account.passkeyAdded)
                    }
                    TulaCeremony.Dismissed -> {
                        s = s.copy(notice = words.account.passkeyDismissed)
                        say(words.account.passkeyDismissed)
                    }
                }
            },
        )
        if (done && added) {
            refresh(TulaAccountSectionId.PASSKEYS, TulaAccountSectionId.FACTORS)
        }
    }

    // The phone number

    private suspend fun sendPhoneCode() {
        call(
            after = here(TulaAccountAction.SendPhoneCode),
            prepare = prepare@{
                if (s.panel != TulaAccountPanel.PhoneNumber) {
                    return@prepare null
                }
                val number = typed(TulaAccountField.PHONE).trim()
                if (!TulaAuthModel.isPhoneNumber(number)) {
                    require(listOf(TulaAccountField.PHONE), words.ways.numberForm)
                    return@prepare null
                }
                suspend { client.phone.request(number) }
            },
            then = { show(TulaAccountPanel.PhoneCode(it.destination)) },
        )
    }

    private suspend fun verifyPhone() {
        val done = call(
            after = here(null),
            prepare = prepare@{
                if (s.panel !is TulaAccountPanel.PhoneCode) {
                    return@prepare null
                }
                val code = typed(TulaAccountField.CODE)
                val missing = if (code.length == TulaAuthModel.CODE_LENGTH) emptyList() else listOf(TulaAccountField.CODE)
                if (!require(missing, words.codeIncomplete)) {
                    return@prepare null
                }
                empty(TulaAccountField.CODE)
                suspend { client.phone.verify(code) }
            },
            then = { user ->
                show(TulaAccountPanel.Overview)
                s = s.copy(user = user, status = words.account.phoneAdded)
                say(words.account.phoneAdded)
            },
        )
        if (done) {
            refresh(TulaAccountSectionId.FACTORS)
        }
    }

    /** "Copy": hand the setup key, or the backup codes, to the app's clipboard. Only ever on a press. */
    private fun copySecret(setupKey: Boolean): Unit = locked {
        val text = if (setupKey) {
            s.setup?.key?.takeIf { s.panel == TulaAccountPanel.TotpSetup }
        } else {
            s.backupCodes.takeIf { s.panel == TulaAccountPanel.BackupCodes && it.isNotEmpty() }?.joinToString("\n")
        } ?: return@locked
        effects.add { copy(text) }
        s = s.copy(status = words.secondStep.copied)
        say(words.secondStep.copied)
    }

    // Where a problem is shown

    private fun target(code: String, named: String?): TulaAccountField? {
        val fields = s.panel.fields
        val typedCode = if (TulaAccountField.BACKUP_CODE in fields) TulaAccountField.BACKUP_CODE else TulaAccountField.CODE
        val chosen =
            if (TulaAccountField.STEP_UP_PASSWORD in fields) TulaAccountField.STEP_UP_PASSWORD else TulaAccountField.NEW_PASSWORD
        val byName = when (named) {
            "currentPassword" -> TulaAccountField.CURRENT_PASSWORD
            "password", "newPassword" -> chosen
            "code" -> typedCode
            "phoneNumber" -> TulaAccountField.PHONE
            else -> null
        }
        val found = byName ?: if (code == INVALID_CREDENTIALS) {
            // The proof of the open form: the current password, or what a step-up asked for.
            fields.firstOrNull()
        } else {
            when (code.substringBefore('.')) {
                "password" -> chosen
                "verification", "mfa" -> typedCode
                "phone" -> TulaAccountField.PHONE
                else -> null
            }
        }
        return found?.takeIf { it in fields }
    }

    /** What a refused proof is called on the open form. */
    private fun wrong(field: TulaAccountField?): String? = when (field) {
        TulaAccountField.CURRENT_PASSWORD -> words.account.currentPasswordWrong
        TulaAccountField.STEP_UP_PASSWORD -> words.account.passwordWrong
        TulaAccountField.CODE, TulaAccountField.BACKUP_CODE -> words.secondStep.codeWrong
        else -> null
    }

    private fun place(error: TulaError) {
        val fields = LinkedHashMap<TulaAccountField, MutableList<String>>()
        var above: String? = null
        fun add(field: TulaAccountField, message: String) {
            val messages = fields.getOrPut(field) { ArrayList() }
            if (message !in messages) {
                messages.add(message)
            }
        }
        for (problem in error.errors) {
            val field = target(problem.code, problem.field)
            if (field != null) add(field, words.message(problem)) else above = words.message(error)
        }
        if (error.errors.isEmpty()) {
            val field = target(error.code, null)
            val refused = error.code == INVALID_CREDENTIALS || error.code == MFA_INVALID_CODE
            val passkey = (s.panel as? TulaAccountPanel.StepUp)?.method == TulaStepUpMethod.PASSKEY
            when {
                refused && passkey -> above = words.account.stepUpPasskeyRefused
                field != null -> add(field, wrong(field).takeIf { refused } ?: words.message(error))
                else -> above = words.message(error)
            }
        }
        val wait = error.retryAfterMs
        if (wait != null && wait > 0 && above != null) {
            above += " " + TulaStrings.format(words.retryIn, mapOf("time" to words.duration(wait)))
        }
        s = s.copy(fieldErrors = fields, formError = above)
        // A code the server refused is read again, not sent again.
        empty(*fields.keys.filter { it == TulaAccountField.CODE || it == TulaAccountField.BACKUP_CODE }.toTypedArray())
        val first = s.panel.fields.firstOrNull { it in fields }
        if (first != null) {
            ask(TulaAccountFocus.Field(first))
        }
        say(above ?: first?.let { fields[it]?.firstOrNull() } ?: words.unknownError)
    }

    /** The limits of what a field keeps, and the codes the model reads. */
    companion object {
        /** The most a phone number field keeps. */
        const val PHONE_MAX: Int = 32

        private const val STEP_UP_REQUIRED = "auth.step_up_required"
        private const val INVALID_CREDENTIALS = "auth.invalid_credentials"
        private const val MFA_INVALID_CODE = "mfa.invalid_code"

        private val SECRETS = setOf(
            TulaAccountField.CURRENT_PASSWORD, TulaAccountField.NEW_PASSWORD, TulaAccountField.STEP_UP_PASSWORD,
        )
    }
}
