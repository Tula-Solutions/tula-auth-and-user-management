package dev.tula.auth.ui

import dev.tula.auth.AuthState
import dev.tula.auth.ClientErrorCodes
import dev.tula.auth.CodeStrategy
import dev.tula.auth.Flow
import dev.tula.auth.FlowScreen
import dev.tula.auth.PasswordResetFlow
import dev.tula.auth.SignInFlow
import dev.tula.auth.SignUpFlow
import dev.tula.auth.TulaClient
import dev.tula.auth.TulaError
import dev.tula.auth.flowScreen
import dev.tula.auth.generated.FlowStep
import dev.tula.auth.generated.SignUpPasswordMode
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** Which of the flows the screens open on. */
enum class TulaAuthMode {
    /** Sign in. */
    SIGN_IN,

    /** Sign up. */
    SIGN_UP,
}

/** A field of a screen. */
enum class TulaAuthField {
    /** The email address. */
    EMAIL,

    /** The password of a sign-in or a sign-up. */
    PASSWORD,

    /** The emailed 6-digit code. */
    CODE,

    /** The new password of a reset or of an expired password. */
    NEW_PASSWORD,
}

/**
 * The screen that is drawn: one per step of the server this version has a form for, the three
 * forms that start a flow, and [NotSupported] for every other step.
 */
sealed class TulaAuthScreen {
    /** Ask for the address a sign-in is for. */
    data object SignInStart : TulaAuthScreen()

    /** Ask for the address, and the password, of a new account. */
    data object SignUpStart : TulaAuthScreen()

    /** Ask for the address a password reset is for. */
    data object ResetStart : TulaAuthScreen()

    /** Ask for the password. [canEmailCode]: the step also offers an emailed code. */
    data class Password(val canEmailCode: Boolean) : TulaAuthScreen()

    /**
     * The step offers an emailed code and no password: offer to send it. Nothing is emailed by
     * arriving here.
     */
    data object EmailCodeOffer : TulaAuthScreen()

    /**
     * Ask for the emailed code that signs in. [canUsePassword]: the step also offers the
     * password. [destination] is the masked address the server sent the code to.
     */
    data class EmailCode(val destination: String, val canUsePassword: Boolean) : TulaAuthScreen()

    /** Ask for the emailed code that proves the address. */
    data class EmailVerification(val destination: String) : TulaAuthScreen()

    /** A reset: ask for the emailed code and the new password together. */
    data class NewPassword(val destination: String) : TulaAuthScreen()

    /** A sign-in whose password has expired: ask for a new one. */
    data object ExpiredPassword : TulaAuthScreen()

    /** The flow is over and the client is signed in. */
    data object SignedIn : TulaAuthScreen()

    /**
     * A step this version has no screen for. [status] is the step's status as the server wrote
     * it: for a developer's eyes, never drawn.
     */
    data class NotSupported(val status: String) : TulaAuthScreen()

    /** The fields the screen has, in the order they are drawn. */
    val fields: List<TulaAuthField>
        get() = when (this) {
            SignInStart, ResetStart -> listOf(TulaAuthField.EMAIL)
            SignUpStart -> listOf(TulaAuthField.EMAIL, TulaAuthField.PASSWORD)
            is Password -> listOf(TulaAuthField.PASSWORD)
            is EmailCode, is EmailVerification -> listOf(TulaAuthField.CODE)
            is NewPassword -> listOf(TulaAuthField.CODE, TulaAuthField.NEW_PASSWORD)
            ExpiredPassword -> listOf(TulaAuthField.NEW_PASSWORD)
            EmailCodeOffer, SignedIn, is NotSupported -> emptyList()
        }
}

/** Where the focus (the keyboard's and a screen reader's) is asked to go. */
sealed class TulaAuthFocus {
    /** The screen's title: after a step change. */
    data object Title : TulaAuthFocus()

    /** A field: after a failure that is about it. */
    data class Field(val field: TulaAuthField) : TulaAuthFocus()
}

/**
 * Everything a screen draws from, at one moment. A new value is published for every change.
 *
 * **It can hold a password or a code** ([password], [code], [newPassword]) while their screen is
 * open, so it prints as its type's name and nothing else. Never log one, never put one in a
 * `Bundle`, a `SavedStateHandle` or `rememberSaveable`.
 */
data class TulaAuthState(
    /** The screen to draw. */
    val screen: TulaAuthScreen,
    /** The address field. */
    val email: String = "",
    /** The password field of a sign-in or a sign-up. Emptied when its screen is left. */
    val password: String = "",
    /** The code field. Emptied when its screen is left. */
    val code: String = "",
    /** The new-password field. Emptied when its screen is left. */
    val newPassword: String = "",
    /** Whether an action is being sent. A second one is not started meanwhile. */
    val isPending: Boolean = false,
    /** What went wrong that is not about one field, in the table's words. */
    val formError: String? = null,
    /** What is wrong with each field, in the table's words. */
    val fieldErrors: Map<TulaAuthField, List<String>> = emptyMap(),
    /** Something that went right, in words: "A new code is on its way." */
    val status: String? = null,
    /** Where the focus was last asked to go. */
    val focus: TulaAuthFocus = TulaAuthFocus.Title,
    /** Counts the requests to move the focus: a screen moves it when this changes. */
    val focusRequests: Int = 0,
    /** The environment's app name, once [TulaAuthModel.loadConfig] has read it. */
    val appName: String? = null,
    /** Whether a sign-up may leave the password out (`signUp.password: optional`). */
    val passwordOptional: Boolean = false,
    /** The secret fields whose text is drawn in the clear ("show password"). */
    val revealed: Set<TulaAuthField> = emptySet(),
) {
    /** The type's name: what the fields hold is never printed. */
    override fun toString(): String = "TulaAuthState"

    /**
     * What a field holds.
     *
     * @param field A field.
     * @return Its text.
     */
    fun text(field: TulaAuthField): String = when (field) {
        TulaAuthField.EMAIL -> email
        TulaAuthField.PASSWORD -> password
        TulaAuthField.CODE -> code
        TulaAuthField.NEW_PASSWORD -> newPassword
    }
}

/**
 * What is behind the screens: which one is drawn, what the fields hold, what went wrong, and
 * the actions of the buttons. A composable draws [state] and calls [perform]; it decides
 * nothing. The model has no Compose and no Android in it, so all of it is tested on the JVM.
 *
 * **It holds no token.** A password and a code are in [state] only while their screen is open:
 * every change of screen, the completion and [close] empty all three. It prints as its type's
 * name, and nothing it holds is logged.
 *
 * **A flow that is left is discarded** ([Flow.discard]): by [close], by going to another flow
 * and by starting again. An answer that arrives afterwards changes nothing here and signs
 * nobody in. A flow that had already completed when it was left is not one of those: it cannot
 * be discarded (the client is signed in), so its answer is shown and reported like any other
 * completion.
 *
 * **No action is silent.** A button of the open screen does what it says, marks what is
 * missing, says what went wrong, or, where its flow is gone, lands on the start of the flow
 * with words. An action the open screen does not offer does nothing.
 *
 * It may be called from any thread: every change is made under one lock, and never across a
 * suspension. [announce] and [onSignedIn] are called outside that lock, on the thread whose
 * call made the change.
 *
 * @param client The app's client.
 * @param mode The flow to open on.
 * @param strings The strings.
 * @param announce Says a message to a screen reader. The screens pass the platform's; a test
 *   passes its own.
 * @param onSignedIn Called once for each flow that completed, when the client is signed in:
 *   also when the flow's screen was left or closed meanwhile (so it can be called after
 *   [close]), and also when the session could not be stored.
 */
class TulaAuthModel(
    private val client: TulaClient,
    mode: TulaAuthMode = TulaAuthMode.SIGN_IN,
    strings: TulaStrings = TulaStrings(),
    private val announce: (String) -> Unit = {},
    private val onSignedIn: (() -> Unit)? = null,
) {
    private val lock = Any()

    /** The start the model opened on: where a closed screen is again. */
    private val initialScreen: TulaAuthScreen =
        if (mode == TulaAuthMode.SIGN_UP) TulaAuthScreen.SignUpStart else TulaAuthScreen.SignInStart

    // Everything below is read and written under `lock`.
    private var s = TulaAuthState(screen = initialScreen)
    private var words = strings
    private var flow: Flow? = null

    /** The start of the kind of flow that is open: where "Start again" goes. */
    private var startScreen: TulaAuthScreen = initialScreen

    /** Grows whenever a flow is left: an answer asked for under an older number is dropped. */
    private var generation = 0

    /** What is to be said or told once the lock is let go. */
    private val effects = ArrayList<() -> Unit>()

    private val published = MutableStateFlow(s)

    /** What the screens draw, and every change of it. */
    val state: StateFlow<TulaAuthState> = published.asStateFlow()

    /** The strings the messages are taken from. */
    var strings: TulaStrings
        get() = synchronized(lock) { words }
        set(value) = locked { words = value }

    /** What the open screen holds: what a screen draws. */
    val content: TulaAuthContent get() = synchronized(lock) { contentNow() }

    /** The type's name: nothing the model holds is printed. */
    override fun toString(): String = "TulaAuthModel"

    /**
     * Make a change under the lock, publish it, and only then say what it asked to be said: a
     * callback that calls the model again must not find the lock held.
     */
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

    private fun contentNow(): TulaAuthContent =
        TulaAuthContent.of(s.screen, words, s.appName, s.passwordOptional, s.email)

    private fun say(message: String) {
        effects.add { announce(message) }
    }

    // Going from one flow to another

    /** Leave what is open and show the start of a sign-in. */
    fun showSignIn(): Unit = locked { open(TulaAuthScreen.SignInStart) }

    /** Leave what is open and show the start of a sign-up. */
    fun showSignUp(): Unit = locked { open(TulaAuthScreen.SignUpStart) }

    /**
     * Leave what is open and show the start of a password reset. The address typed for the
     * sign-in is kept.
     */
    fun showReset(): Unit = locked { open(TulaAuthScreen.ResetStart) }

    /** Leave what is open and show the start of the same kind of flow again. */
    fun startAgain(): Unit = locked { open(startScreen) }

    /**
     * The screen is closing: discard the flow, forget what every field held, the address
     * included, and go back to the start the model opened on.
     *
     * A screen that goes away and comes back keeps its model when the app hoists it, so a
     * closed model is never left on a step: its flow is gone, and a step without one would have
     * buttons that can do nothing. It closes onto the start of its own mode also when what was
     * open is a reset reached from a sign-in, or a finished sign-in. Nobody is signed out by it.
     */
    fun close(): Unit = locked {
        startScreen = initialScreen
        leave()
        s = s.copy(email = "")
        show(initialScreen)
    }

    /** From the emailed code back to the password, where the step offers both. */
    fun usePassword(): Unit = locked {
        val screen = s.screen
        if (screen is TulaAuthScreen.EmailCode && screen.canUsePassword && !s.isPending) {
            show(TulaAuthScreen.Password(canEmailCode = true))
        }
    }

    /**
     * "Show password" and "hide password": draw a secret field's text in the clear, or stop. A
     * field the open screen does not have, and one that is no secret, stay as they are.
     *
     * @param field A password field of the open screen.
     */
    fun toggleReveal(field: TulaAuthField): Unit = locked {
        val secret = field == TulaAuthField.PASSWORD || field == TulaAuthField.NEW_PASSWORD
        if (secret && field in s.screen.fields) {
            s = s.copy(revealed = if (field in s.revealed) s.revealed - field else s.revealed + field)
        }
    }

    /**
     * Take what was typed, or pasted, into a field. A code field keeps the digits of a code and
     * nothing else.
     *
     * @param field The field.
     * @param typed What it holds now.
     */
    fun setText(field: TulaAuthField, typed: String): Unit = locked {
        s = when (field) {
            TulaAuthField.EMAIL -> s.copy(email = typed)
            TulaAuthField.PASSWORD -> s.copy(password = typed)
            TulaAuthField.CODE -> s.copy(code = digits(typed))
            TulaAuthField.NEW_PASSWORD -> s.copy(newPassword = typed)
        }
    }

    private fun open(start: TulaAuthScreen) {
        startScreen = start
        leave()
        show(start)
    }

    /**
     * Discard the flow, drop whatever is still on its way, and empty the secret fields. The
     * screen is the caller's to change: nothing but a test leaves it where it was.
     */
    internal fun leave() {
        synchronized(lock) {
            flow?.discard()
            flow = null
            generation += 1
            s = s.copy(isPending = false)
            wipe()
            clearMessages()
            published.value = s
        }
    }

    private fun wipe() {
        s = s.copy(password = "", code = "", newPassword = "", revealed = emptySet())
    }

    private fun clearMessages() {
        s = s.copy(formError = null, fieldErrors = emptyMap(), status = null)
    }

    private fun show(next: TulaAuthScreen) {
        if (next == s.screen) {
            return
        }
        wipe()
        clearMessages()
        s = s.copy(screen = next)
        ask(TulaAuthFocus.Title)
        if (next == TulaAuthScreen.SignedIn) {
            flow = null
            onSignedIn?.let { effects.add(it) }
        }
    }

    /**
     * An action the open screen offers found no flow to send it on. Nothing in this file leaves
     * a step open without its flow, so this is a defence and not a path; but a button that did
     * nothing would be worse than one that says the attempt is over.
     */
    private fun lost() {
        open(startScreen)
        s = s.copy(formError = words.flowLost)
        say(words.flowLost)
    }

    /**
     * A flow completed and the screen does not show it: it was left meanwhile, or the action
     * that completed it threw. The client is signed in, whatever is open now. Leave that and
     * say so, once.
     *
     * @param saved `false` when the session could not be stored (`storage.failed`): the client
     *   holds it in memory, so it lasts as long as the app runs, and the signed-in screen says
     *   that in words.
     */
    private fun arrived(saved: Boolean = true) {
        leave()
        show(TulaAuthScreen.SignedIn)
        if (!saved) {
            s = s.copy(formError = words.sessionNotSaved)
            say(words.sessionNotSaved)
        }
    }

    /**
     * Whether a start that threw signed the client in all the same: the answer said `complete`,
     * the session is in the client's memory, and only storing it failed. A start hands back no
     * flow to ask, so the client's own state is asked. Nothing else a start does writes to the
     * storage, so this error says a session was adopted.
     */
    private fun completedBy(error: Throwable): Boolean =
        error is TulaError && error.code == ClientErrorCodes.STORAGE_FAILED &&
            client.state.value is AuthState.SignedIn

    private fun ask(target: TulaAuthFocus) {
        s = s.copy(focus = target, focusRequests = s.focusRequests + 1)
    }

    // The environment

    /**
     * Read what the screens are worded from: the app's name, and whether a sign-up may leave
     * the password out. A failure changes nothing: the screens then say less.
     */
    suspend fun loadConfig() {
        val config = try {
            client.config()
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            return
        }
        locked {
            s = s.copy(
                appName = config.app.name.ifEmpty { null },
                passwordOptional = config.signUp?.password?.rawValue == SignUpPasswordMode.Optional.rawValue,
            )
        }
    }

    // Actions

    /**
     * Do what a button, a link or the keyboard's "done" of the open screen asks.
     *
     * An action the open screen does not offer does nothing: it cannot be asked for.
     *
     * @param action An action of [content].
     */
    suspend fun perform(action: TulaAuthAction) {
        if (action !in content.actions) {
            return
        }
        when (action) {
            TulaAuthAction.START -> start()
            TulaAuthAction.SUBMIT_PASSWORD -> submitPassword()
            TulaAuthAction.SEND_EMAIL_CODE -> sendEmailCode()
            TulaAuthAction.SUBMIT_CODE -> submitCode()
            TulaAuthAction.RESEND_CODE -> resendCode()
            TulaAuthAction.SUBMIT_NEW_PASSWORD -> submitNewPassword()
            TulaAuthAction.USE_PASSWORD -> usePassword()
            TulaAuthAction.SHOW_SIGN_IN -> showSignIn()
            TulaAuthAction.SHOW_SIGN_UP -> showSignUp()
            TulaAuthAction.SHOW_RESET -> showReset()
            TulaAuthAction.START_AGAIN -> startAgain()
        }
    }

    /** What an action found under the lock: nothing to send, or what to send and under which generation. */
    private class Sending<T>(val asked: Int, val what: T)

    /** The main button of a screen that starts a flow. */
    internal suspend fun start() {
        val plan = locked<Sending<suspend () -> Flow>?> {
            val screen = s.screen
            val address = s.email.trim()
            val typed = s.password
            val missing = ArrayList<TulaAuthField>()
            if (address.isEmpty()) {
                missing.add(TulaAuthField.EMAIL)
            }
            if (screen == TulaAuthScreen.SignUpStart && typed.isEmpty() && !s.passwordOptional) {
                missing.add(TulaAuthField.PASSWORD)
            }
            if (!require(missing)) {
                return@locked null
            }
            val send: suspend () -> Flow = when (screen) {
                TulaAuthScreen.SignInStart -> ({ startSignIn(address) })
                TulaAuthScreen.SignUpStart -> ({ client.signUp(email = address, password = typed.ifEmpty { null }) })
                TulaAuthScreen.ResetStart -> ({ client.resetPassword(address) })
                else -> return@locked null
            }
            begin()?.let { Sending(it, send) }
        } ?: return
        val started = try {
            plan.what()
        } catch (cancelled: CancellationException) {
            locked { stopped(plan.asked) }
            throw cancelled
        } catch (error: Exception) {
            locked { if (completedBy(error)) arrived(saved = false) else fail(error, plan.asked) }
            return
        }
        locked {
            if (plan.asked != generation) {
                // Left while the start was on its way: the attempt is nobody's. A start that
                // completed at once cannot be discarded: somebody is signed in.
                if (screenOf(started) == TulaAuthScreen.SignedIn) arrived() else started.discard()
            } else {
                flow = started
                s = s.copy(isPending = false)
                show(screenOf(started))
            }
        }
    }

    private suspend fun startSignIn(address: String): SignInFlow {
        val started = client.signIn(address)
        // Where an emailed code is the only way in there is nothing to choose: ask for it, so
        // that the user goes from their address straight to the code.
        val step = started.step
        if (step is FlowStep.NeedsFirstFactor && step.value.prepared == null &&
            step.value.strategies.map { it.rawValue } == listOf(EMAIL_CODE)
        ) {
            try {
                started.prepareFirstFactor(CodeStrategy.EMAIL_CODE)
            } catch (error: Throwable) {
                started.discard()
                throw error
            }
        }
        return started
    }

    /**
     * The main button of the password screen. The field is emptied as the password is sent,
     * right or wrong.
     */
    internal suspend fun submitPassword() {
        val plan = locked<Sending<Pair<SignInFlow, String>>?> {
            if (s.screen !is TulaAuthScreen.Password || s.isPending) {
                return@locked null
            }
            val open = flow as? SignInFlow
            if (open == null) {
                lost()
                return@locked null
            }
            if (!require(if (s.password.isEmpty()) listOf(TulaAuthField.PASSWORD) else emptyList())) {
                return@locked null
            }
            val typed = s.password
            s = s.copy(password = "", revealed = s.revealed - TulaAuthField.PASSWORD)
            begin()?.let { Sending(it, open to typed) }
        } ?: return
        val (open, typed) = plan.what
        send(open, plan.asked) { open.submitPassword(typed) }
    }

    /** "Email me a code": ask the server to send the code that signs in. */
    internal suspend fun sendEmailCode() {
        val plan = locked<Sending<SignInFlow>?> {
            val screen = s.screen
            val offered = screen == TulaAuthScreen.EmailCodeOffer ||
                (screen is TulaAuthScreen.Password && screen.canEmailCode)
            if (!offered || s.isPending) {
                return@locked null
            }
            val open = flow as? SignInFlow
            if (open == null) {
                lost()
                return@locked null
            }
            begin()?.let { Sending(it, open) }
        } ?: return
        send(plan.what, plan.asked) { plan.what.prepareFirstFactor(CodeStrategy.EMAIL_CODE) }
    }

    /**
     * The main button of a screen that asks for the emailed code. The field is emptied as the
     * code is sent, right or wrong: a refused code is read from the email again.
     */
    internal suspend fun submitCode() {
        val plan = locked<Sending<Pair<Flow, suspend () -> FlowStep>>?> {
            if (s.isPending) {
                return@locked null
            }
            val screen = s.screen
            val open = flow
            val typed = s.code
            val action: (suspend () -> FlowStep)? = when {
                screen is TulaAuthScreen.EmailCode && open is SignInFlow ->
                    ({ open.attemptFirstFactor(CodeStrategy.EMAIL_CODE, typed) })
                screen is TulaAuthScreen.EmailVerification && open is SignInFlow -> ({ open.verifyEmail(typed) })
                screen is TulaAuthScreen.EmailVerification && open is SignUpFlow -> ({ open.verifyEmail(typed) })
                else -> null
            }
            if (screen !is TulaAuthScreen.EmailCode && screen !is TulaAuthScreen.EmailVerification) {
                return@locked null
            }
            if (action == null || open == null) {
                lost()
                return@locked null
            }
            val missing = if (typed.length == CODE_LENGTH) emptyList() else listOf(TulaAuthField.CODE)
            if (!require(missing, words.codeIncomplete)) {
                return@locked null
            }
            s = s.copy(code = "")
            begin()?.let { Sending(it, open to action) }
        } ?: return
        send(plan.what.first, plan.asked, action = plan.what.second)
    }

    /** Ask for the email again. */
    internal suspend fun resendCode() {
        var done = ""
        val plan = locked<Sending<Pair<Flow, suspend () -> FlowStep>>?> {
            if (s.isPending) {
                return@locked null
            }
            val screen = s.screen
            val open = flow
            val action: (suspend () -> FlowStep)? = when (screen) {
                is TulaAuthScreen.EmailCode -> (open as? SignInFlow)?.let { signIn ->
                    done = words.emailResent
                    ({ signIn.prepareFirstFactor(CodeStrategy.EMAIL_CODE) })
                }
                is TulaAuthScreen.EmailVerification, is TulaAuthScreen.NewPassword -> {
                    done = words.resent
                    when (open) {
                        is SignInFlow -> ({ open.resendCode() })
                        is SignUpFlow -> ({ open.resendCode() })
                        is PasswordResetFlow -> ({ open.resendCode() })
                        else -> null
                    }
                }
                else -> return@locked null
            }
            if (action == null || open == null) {
                lost()
                return@locked null
            }
            begin()?.let { Sending(it, open to action) }
        } ?: return
        send(plan.what.first, plan.asked, done, plan.what.second)
    }

    /**
     * The main button of a screen that asks for a new password. A password that is being chosen
     * is kept when the server refuses it, to be put right; in a reset the code is kept with it
     * unless the code is what was refused.
     */
    internal suspend fun submitNewPassword() {
        val plan = locked<Sending<Pair<Flow, suspend () -> FlowStep>>?> {
            if (s.isPending) {
                return@locked null
            }
            val screen = s.screen
            val open = flow
            val typed = s.newPassword
            val typedCode = s.code
            when (screen) {
                is TulaAuthScreen.NewPassword -> {
                    if (open !is PasswordResetFlow) {
                        lost()
                        return@locked null
                    }
                    val missing = ArrayList<TulaAuthField>()
                    if (typedCode.length != CODE_LENGTH) {
                        missing.add(TulaAuthField.CODE)
                    }
                    if (typed.isEmpty()) {
                        missing.add(TulaAuthField.NEW_PASSWORD)
                    }
                    val message = if (missing.firstOrNull() == TulaAuthField.CODE) words.codeIncomplete else null
                    if (!require(missing, message)) {
                        return@locked null
                    }
                    begin()?.let { Sending(it, open to suspend { open.submit(typedCode, typed) }) }
                }
                TulaAuthScreen.ExpiredPassword -> {
                    if (open !is SignInFlow) {
                        lost()
                        return@locked null
                    }
                    if (!require(if (typed.isEmpty()) listOf(TulaAuthField.NEW_PASSWORD) else emptyList())) {
                        return@locked null
                    }
                    begin()?.let { Sending(it, open to suspend { open.submitNewPassword(typed) }) }
                }
                else -> null
            }
        } ?: return
        send(plan.what.first, plan.asked, action = plan.what.second)
    }

    // Running an action

    /**
     * Whether nothing is missing. Otherwise the fields are marked and the first takes the
     * focus, without a request.
     */
    private fun require(missing: List<TulaAuthField>, message: String? = null): Boolean {
        if (s.isPending) {
            return false
        }
        val first = missing.firstOrNull() ?: return true
        clearMessages()
        val said = message ?: words.required
        s = s.copy(fieldErrors = missing.associateWith { listOf(if (it == first) said else words.required) })
        ask(TulaAuthFocus.Field(first))
        say(said)
        return false
    }

    private fun begin(): Int? {
        if (s.isPending) {
            return null
        }
        s = s.copy(isPending = true)
        clearMessages()
        return generation
    }

    /** The caller was cancelled before an answer was taken: the screen can be used again. */
    private fun stopped(asked: Int) {
        if (asked == generation) {
            s = s.copy(isPending = false)
        }
    }

    /** Send one action of the open flow and show the step it answers. */
    private suspend fun send(open: Flow, asked: Int, done: String? = null, action: suspend () -> FlowStep) {
        try {
            action()
        } catch (cancelled: CancellationException) {
            // The caller gave up; the client finishes a completion in its own scope whatever
            // happens here, so a flow that completed is still said.
            locked { if (screenOf(open) == TulaAuthScreen.SignedIn) arrived() else stopped(asked) }
            throw cancelled
        } catch (error: Exception) {
            // An action that throws after its answer was taken: the answer said `complete`,
            // the client adopted the session, and storing it failed. The flow is over whatever
            // the error says, and whether or not its screen was left: a form kept open could
            // only answer `flow.invalid_step` to somebody who is signed in.
            locked { if (screenOf(open) == TulaAuthScreen.SignedIn) arrived(saved = false) else fail(error, asked) }
            return
        }
        locked {
            val next = screenOf(open)
            if (asked != generation) {
                // Left while the answer was on its way. The flow was discarded then, and a
                // discarded flow takes nothing from an answer (the action throws): the one
                // answer that reaches this line is of a flow that had completed before it was
                // left, which no discard undoes. The client is signed in, and a model that
                // dropped that would show a form to a signed-in user and tell the app nothing.
                if (next == TulaAuthScreen.SignedIn) {
                    arrived()
                }
                return@locked
            }
            s = s.copy(isPending = false)
            if (next == s.screen) {
                s = s.copy(status = done)
                done?.let(::say)
            } else {
                show(next)
            }
        }
    }

    private fun fail(error: Exception, asked: Int) {
        if (asked != generation) {
            return
        }
        s = s.copy(isPending = false)
        // Everything the client throws is a `TulaError`. Anything else is a bug somewhere, and
        // is said with the table's fallback: its own words were not written for a user.
        if (error !is TulaError) {
            s = s.copy(formError = words.unknownError)
            say(words.unknownError)
            return
        }
        place(error)
        // A code the server refused is not sent again: it is read from the email again.
        if (TulaAuthField.CODE in s.fieldErrors) {
            s = s.copy(code = "")
        }
    }

    // Where a problem is shown

    /** The field of the open screen a problem belongs to, or `null` for "above the form". */
    private fun target(code: String, named: String?): TulaAuthField? {
        val fields = s.screen.fields
        val secret = if (TulaAuthField.NEW_PASSWORD in fields) TulaAuthField.NEW_PASSWORD else TulaAuthField.PASSWORD
        val byName = when (named) {
            "email", "identifier" -> TulaAuthField.EMAIL
            "password", "newPassword" -> secret
            "code" -> TulaAuthField.CODE
            else -> null
        }
        val found = byName ?: if (code == INVALID_CREDENTIALS) {
            // The server never says which part was wrong: shown at the last thing typed.
            fields.lastOrNull()
        } else {
            when (code.substringBefore('.')) {
                "email" -> TulaAuthField.EMAIL
                "password" -> secret
                "verification" -> TulaAuthField.CODE
                else -> null
            }
        }
        return found?.takeIf { it in fields }
    }

    private fun place(error: TulaError) {
        val fields = LinkedHashMap<TulaAuthField, MutableList<String>>()
        var above: String? = null
        fun add(field: TulaAuthField, message: String) {
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
            if (field != null) add(field, words.message(error)) else above = words.message(error)
        }
        val wait = error.retryAfterMs
        if (wait != null && wait > 0 && above != null) {
            above += " " + TulaStrings.format(words.retryIn, mapOf("time" to words.duration(wait)))
        }
        s = s.copy(fieldErrors = fields, formError = above)
        val first = s.screen.fields.firstOrNull { it in fields }
        if (first != null) {
            ask(TulaAuthFocus.Field(first))
        }
        say(above ?: first?.let { fields[it]?.firstOrNull() } ?: words.unknownError)
    }

    // What is drawn of a problem

    /**
     * What is wrong with a field, each worded as a problem ("Error: …"): what is drawn under it.
     *
     * @param field A field.
     * @return Its problems, in words.
     */
    fun problems(field: TulaAuthField): List<String> = synchronized(lock) {
        s.fieldErrors[field].orEmpty().map { TulaStrings.format(words.errorPrefix, mapOf("message" to it)) }
    }

    /** What went wrong that is not about one field, worded as a problem: drawn above the form. */
    val formProblem: String?
        get() = synchronized(lock) {
            s.formError?.let { TulaStrings.format(words.errorPrefix, mapOf("message" to it)) }
        }

    /**
     * What a screen reader reads for a field: its label, and its problems when it has any.
     *
     * @param field A field of [content].
     * @return The label, or the label with the problems.
     */
    fun spokenLabel(field: TulaAuthFieldContent): String = synchronized(lock) {
        val problems = s.fieldErrors[field.field].orEmpty()
        if (problems.isEmpty()) {
            field.label
        } else {
            TulaStrings.format(
                words.fieldInvalid,
                mapOf("label" to field.label, "message" to problems.joinToString(" ")),
            )
        }
    }

    // The screen of a step

    private fun screenOf(open: Flow): TulaAuthScreen {
        val snapshot = open.snapshot()
        val step = snapshot.step
        return when (flowScreen(step, snapshot.kind)) {
            FlowScreen.NEEDS_PASSWORD -> TulaAuthScreen.Password(canEmailCode = false)
            FlowScreen.NEEDS_FIRST_FACTOR -> firstFactor(step)
            FlowScreen.NEEDS_EMAIL_VERIFICATION ->
                (step as? FlowStep.NeedsEmailVerification)?.let { TulaAuthScreen.EmailVerification(it.value.destination) }
            FlowScreen.NEEDS_NEW_PASSWORD -> (step as? FlowStep.NeedsNewPassword)?.let {
                if (it.value.reason == null) TulaAuthScreen.NewPassword(it.value.destination) else TulaAuthScreen.ExpiredPassword
            }
            FlowScreen.COMPLETE -> TulaAuthScreen.SignedIn
            FlowScreen.NOT_SUPPORTED -> null
        } ?: TulaAuthScreen.NotSupported(step.status)
    }

    /**
     * The screen of a first factor. A texted code has a call in the client and no screen here
     * yet: a step that offers it beside a password or an emailed code is drawn without it, and
     * one that offers nothing else is "not supported".
     */
    private fun firstFactor(step: FlowStep): TulaAuthScreen? {
        val value = (step as? FlowStep.NeedsFirstFactor)?.value ?: return null
        val offered = value.strategies.map { it.rawValue }
        val password = PASSWORD in offered
        val prepared = value.prepared
        return when {
            prepared != null && prepared.strategy.rawValue == EMAIL_CODE ->
                TulaAuthScreen.EmailCode(prepared.destination, canUsePassword = password)
            password -> TulaAuthScreen.Password(canEmailCode = EMAIL_CODE in offered)
            EMAIL_CODE in offered -> TulaAuthScreen.EmailCodeOffer
            else -> null
        }
    }

    /** The length of a code, and what a code field keeps. */
    companion object {
        /** How many digits an emailed code has. */
        const val CODE_LENGTH: Int = 6

        private const val EMAIL_CODE = "email_code"
        private const val PASSWORD = "password"
        private const val INVALID_CREDENTIALS = "auth.invalid_credentials"

        /**
         * Keep what a code field holds to the digits of a code.
         *
         * @param typed What the field holds, typed or pasted.
         * @return At most six ASCII digits.
         */
        fun digits(typed: String): String = typed.filter { it in '0'..'9' }.take(CODE_LENGTH)
    }
}
