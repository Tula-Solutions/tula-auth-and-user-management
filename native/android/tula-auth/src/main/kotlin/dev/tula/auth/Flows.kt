package dev.tula.auth

import dev.tula.auth.generated.FirstFactorAttemptRequest
import dev.tula.auth.generated.FirstFactorAttemptRequestEmailCode
import dev.tula.auth.generated.FirstFactorAttemptRequestSmsCode
import dev.tula.auth.generated.FirstFactorPrepareRequest
import dev.tula.auth.generated.FlowAttempt
import dev.tula.auth.generated.FlowKind
import dev.tula.auth.generated.FlowStep
import dev.tula.auth.generated.NewPasswordReason
import dev.tula.auth.generated.NewPasswordRequest
import dev.tula.auth.generated.PasswordAttemptRequest
import dev.tula.auth.generated.PasswordResetRequest
import dev.tula.auth.generated.PreparedFirstFactorStrategy
import dev.tula.auth.generated.TulaOperation
import dev.tula.auth.generated.TulaOperations
import dev.tula.auth.generated.VerifyEmailRequest
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonElement

/**
 * What a flow looks like when it is shown or logged: where it stands, and nothing that could
 * continue it. The attempt's secret is never part of it.
 */
data class FlowSnapshot(
    /** The attempt's id. Useless without the secret the flow object keeps to itself. */
    val id: String,
    /** Which flow this is. */
    val kind: FlowKind,
    /** The step the server is waiting on. Changes after every action. */
    val step: FlowStep,
    /** When the attempt expires (ISO 8601). Start again after that. */
    val expiresAt: String,
)

/**
 * A first factor proven with a code the server sends: the ways [SignInFlow.prepareFirstFactor]
 * can ask for. An emailed **link** is not among them: the server honours a link only in the
 * client that asked for it, and a link in an email opens a browser, not the app. The code in
 * the same email is the way.
 */
enum class CodeStrategy(internal val prepared: PreparedFirstFactorStrategy) {
    /** A 6-digit code by email. */
    EMAIL_CODE(PreparedFirstFactorStrategy.EmailCode),

    /** A 6-digit code by text message, for a sign-in started with a phone number. */
    SMS_CODE(PreparedFirstFactorStrategy.SmsCode),
}

/**
 * Which screen a step asks for, as far as this version of the client can answer it.
 *
 * A UI draws one screen per value and [NOT_SUPPORTED] for everything else: never a blank
 * screen, never a guessed action. See [flowScreen].
 */
enum class FlowScreen {
    /** Ask for the password: [SignInFlow.submitPassword]. */
    NEEDS_PASSWORD,

    /** Offer the step's strategies this client can prove: a password, an emailed or texted code. */
    NEEDS_FIRST_FACTOR,

    /** Ask for the emailed code: `verifyEmail`. */
    NEEDS_EMAIL_VERIFICATION,

    /** Ask for a new password: [PasswordResetFlow.submit] or [SignInFlow.submitNewPassword]. */
    NEEDS_NEW_PASSWORD,

    /** The flow is over and the client is signed in. */
    COMPLETE,

    /**
     * This version has no action that answers the step: a status it does not know (a newer
     * server), or a known one that offers only ways it cannot do (an emailed link, a passkey,
     * a provider, a second factor). Say so in words; the user can start again or update the
     * app.
     */
    NOT_SUPPORTED,
}

private val FIRST_FACTORS = setOf("password", "email_code", "sms_code")

/**
 * The screen a step asks for. Total: every step, whatever a server sends, has an answer, and
 * the answer for what this version cannot act on is [FlowScreen.NOT_SUPPORTED].
 *
 * @param step The step, as the flow has it.
 * @param kind The flow the step belongs to: a sign-in's `needs_new_password` is answered only
 *   for a reason this version knows.
 * @return The screen.
 */
fun flowScreen(step: FlowStep, kind: FlowKind): FlowScreen = when (step) {
    is FlowStep.NeedsPassword -> FlowScreen.NEEDS_PASSWORD
    is FlowStep.Complete -> FlowScreen.COMPLETE
    is FlowStep.NeedsEmailVerification -> FlowScreen.NEEDS_EMAIL_VERIFICATION
    is FlowStep.NeedsFirstFactor ->
        if (step.value.strategies.any { it.rawValue in FIRST_FACTORS }) {
            FlowScreen.NEEDS_FIRST_FACTOR
        } else {
            FlowScreen.NOT_SUPPORTED
        }
    is FlowStep.NeedsNewPassword -> {
        // A password reset's step has no reason; a sign-in's has one, and only a known one
        // says which action answers it.
        val reason = step.value.reason
        val known = when (kind) {
            FlowKind.SignIn -> reason == NewPasswordReason.Expired
            FlowKind.PasswordReset -> reason == null
            else -> false
        }
        if (known) FlowScreen.NEEDS_NEW_PASSWORD else FlowScreen.NOT_SUPPORTED
    }
    // A second factor and an enrolment have no action in this version yet, and neither has a
    // status nobody has heard of.
    else -> FlowScreen.NOT_SUPPORTED
}

/** What flows need from the client. */
internal class FlowContext(
    val transport: Transport,
    val session: SessionManager,
    val confined: CoroutineDispatcher,
    val messages: () -> Messages,
)

/** What identifies an attempt to the API: its id in the path, its secret in a header. */
internal class Binding(val attemptId: String, val attemptSecret: String) {
    fun input(body: String? = null): CallInput =
        CallInput(params = mapOf("attemptId" to attemptId), body = body, attemptSecret = attemptSecret)
}

/**
 * Whether an answer has what a flow object is built from: the attempt's id and, once the step
 * is `complete`, session tokens the client can install. A 200 that lacks them is not this API
 * and must not become a flow.
 */
private fun isUsableAttempt(value: FlowAttempt): Boolean =
    value.id.isNotEmpty() &&
        if (value.step.status == "complete") isSessionTokens(value.session) else value.session == null

/**
 * A flow in progress: a sign-up, a sign-in or a password reset. [step] says what the server is
 * waiting for; each action sends one request and returns the next step. When the step is
 * `complete` the client is signed in.
 *
 * A flow sends one action at a time. A second action while one is in flight is refused with
 * `flow.busy`, and any action once the flow has completed or was discarded with
 * `flow.invalid_step`; both are raised by the client (status `0`) without a request.
 *
 * The attempt's secret is held in this object's private state, in memory, until the flow
 * completes or is discarded. It is not a property, is never written to storage, and is in no
 * [toString], error or snapshot.
 */
abstract class Flow internal constructor(
    private val context: FlowContext,
    started: FlowAttempt,
) {
    private val lock = Any()
    private var secret: String?
    private var busy = false

    /** The caller left the attempt ([discard]): nothing of it is taken any more. */
    private var discarded = false

    // Only what the snapshot shows is kept: not the secret, and not a completed flow's tokens.
    private var current: FlowSnapshot

    init {
        if (!isUsableAttempt(started) ||
            (started.attemptSecret.isNullOrEmpty() && started.step.status != "complete")
        ) {
            // Without the secret no later call can succeed; fail here rather than with a
            // puzzling `flow.not_found` on the next step.
            throw context.transport.invalid()
        }
        secret = started.attemptSecret?.takeIf { it.isNotEmpty() }
        current = FlowSnapshot(started.id, started.kind, started.step, started.expiresAt)
    }

    /** The attempt's id. */
    val id: String get() = snapshot().id

    /** Which flow this is. */
    val kind: FlowKind get() = snapshot().kind

    /** The step the server is waiting on. */
    val step: FlowStep get() = snapshot().step

    /** When the attempt expires (ISO 8601). */
    val expiresAt: String get() = snapshot().expiresAt

    /** The screen the current step asks for; see [flowScreen]. */
    val screen: FlowScreen get() = snapshot().let { flowScreen(it.step, it.kind) }

    /** @return Where the flow stands. The attempt's secret is never included. */
    fun snapshot(): FlowSnapshot = synchronized(lock) { current }

    /** The snapshot's text: the attempt's secret is not in it. */
    override fun toString(): String = snapshot().toString()

    /**
     * Leave this attempt, for good: call it when the user goes back, starts again, picks
     * another way to sign in or closes the screen.
     *
     * The flow forgets the attempt's secret, so every later action is refused with
     * `flow.invalid_step` and no request, and the answer to an action still on its way is
     * dropped: that action throws `flow.invalid_step`, and even a `complete` answer signs
     * nobody in. On a flow that has completed it does nothing.
     */
    fun discard() {
        synchronized(lock) {
            if (current.step.status != "complete") {
                discarded = true
                secret = null
            }
        }
    }

    /** An error the flow raises itself, before any request (status `0`). */
    private fun refused(code: String): TulaError = clientError(code, context.messages())

    /** Take the server's answer as the flow's new state, and sign in when it completes. */
    internal suspend fun accept(next: FlowAttempt): FlowStep {
        synchronized(lock) {
            // An answer to an action that was on its way when the attempt was left. The user
            // is doing something else by now: a `complete` here must not sign them in, and
            // nothing of it is kept.
            if (discarded) {
                throw refused(ClientErrorCodes.FLOW_INVALID_STEP)
            }
            // Checked before anything changes: an answer that cannot be used leaves the flow
            // on the step it was on, and signs nobody in.
            if (!isUsableAttempt(next)) {
                throw context.transport.invalid()
            }
            current = FlowSnapshot(next.id, next.kind, next.step, next.expiresAt)
            if (next.step.status == "complete") {
                // A completed attempt accepts nothing more, so its secret has no further use.
                secret = null
            }
        }
        next.session?.let { context.session.adopt(it) }
        return next.step
    }

    /**
     * Run one action on this attempt, alone.
     *
     * Two things are refused here, without a request, because the client knows the answer and
     * a request could only do harm: an action on a flow that is over (`flow.invalid_step`),
     * and a second action while one is still being sent (`flow.busy`: a button tapped twice
     * would otherwise spend two guesses, or send two emails).
     */
    private suspend fun <T> exclusive(action: suspend (Binding) -> T): T =
        withContext(context.confined) {
            synchronized(lock) {
                if (secret == null) {
                    throw refused(ClientErrorCodes.FLOW_INVALID_STEP)
                }
                if (busy) {
                    throw refused(ClientErrorCodes.FLOW_BUSY)
                }
                busy = true
            }
            try {
                // An action can complete the flow and set the session. It must not overlap a
                // refresh of the session it replaces.
                context.session.idle()
                // Read again: the attempt may have been discarded while this waited.
                val bound = synchronized(lock) {
                    Binding(current.id, secret ?: throw refused(ClientErrorCodes.FLOW_INVALID_STEP))
                }
                action(bound)
            } finally {
                synchronized(lock) { busy = false }
            }
        }

    /** Send one call on this attempt and take the server's answer as the new step. */
    internal suspend fun step(operation: TulaOperation, body: String? = null): FlowStep =
        exclusive { bound ->
            accept(context.transport.attempt(context.transport.call(operation, bound.input(body))))
        }
}

/** Read a flow answer; `response.invalid` for anything else. */
internal fun Transport.attempt(payload: JsonElement?): FlowAttempt =
    decode(FlowAttempt.serializer(), payload)

/**
 * A sign-up in progress.
 *
 * ```kotlin
 * val flow = tula.signUp(email = email, password = password)
 * // flow.screen == FlowScreen.NEEDS_EMAIL_VERIFICATION
 * flow.verifyEmail(code)
 * // tula.state.value is AuthState.SignedIn
 * ```
 */
class SignUpFlow internal constructor(context: FlowContext, started: FlowAttempt) :
    Flow(context, started) {
    /**
     * Submit the emailed 6-digit code (step `needs_email_verification`).
     *
     * @return The next step: `complete` when the code is right.
     * @throws TulaError `verification.invalid_code`, `verification.expired` or
     *   `verification.too_many_attempts`.
     */
    suspend fun verifyEmail(code: String): FlowStep =
        step(TulaOperations.verifySignUpEmail, encode(VerifyEmailRequest.serializer(), VerifyEmailRequest(code)))

    /**
     * Email a fresh code and retire the previous one. The server sends at most one a minute.
     *
     * @throws TulaError `rate_limited` (with `retryAfterMs`) when asked too soon.
     */
    suspend fun resendCode(): FlowStep = step(TulaOperations.resendSignUpCode)
}

/**
 * A sign-in in progress.
 *
 * ```kotlin
 * val flow = tula.signIn(identifier = email)
 * when (flow.screen) {
 *     FlowScreen.NEEDS_PASSWORD -> flow.submitPassword(password)
 *     FlowScreen.NEEDS_FIRST_FACTOR -> {
 *         flow.prepareFirstFactor(CodeStrategy.EMAIL_CODE)
 *         flow.attemptFirstFactor(CodeStrategy.EMAIL_CODE, code)
 *     }
 *     else -> showNotSupported()
 * }
 * ```
 */
class SignInFlow internal constructor(context: FlowContext, started: FlowAttempt) :
    Flow(context, started) {
    /**
     * Submit the password (step `needs_password`, or `needs_first_factor` offering `password`).
     *
     * @throws TulaError `auth.invalid_credentials` for every wrong address or password alike,
     *   and `rate_limited` (with `retryAfterMs`) while the account is locked.
     */
    suspend fun submitPassword(password: String): FlowStep = step(
        TulaOperations.submitSignInPassword,
        encode(PasswordAttemptRequest.serializer(), PasswordAttemptRequest(password)),
    )

    /**
     * Replace a password that has expired (step `needs_new_password` with the reason
     * `expired`) and finish the sign-in. Every other session of the user ends. A refused
     * password leaves the flow on the step.
     *
     * @throws TulaError a `password.*` code with per-field [TulaError.errors] when the
     *   password is refused (`password.reused` for the expired one), `flow.invalid_step` when
     *   the account's password was replaced some other way meanwhile.
     */
    suspend fun submitNewPassword(password: String): FlowStep = step(
        TulaOperations.submitSignInNewPassword,
        encode(NewPasswordRequest.serializer(), NewPasswordRequest(password)),
    )

    /**
     * Submit the emailed 6-digit code (step `needs_email_verification`: the account's address
     * was never verified).
     *
     * @throws TulaError `verification.invalid_code`, `verification.expired` or
     *   `verification.too_many_attempts`.
     */
    suspend fun verifyEmail(code: String): FlowStep =
        step(TulaOperations.verifySignInEmail, encode(VerifyEmailRequest.serializer(), VerifyEmailRequest(code)))

    /**
     * Email a fresh code and retire the previous one. The server sends at most one a minute.
     *
     * @throws TulaError `rate_limited` (with `retryAfterMs`) when asked too soon.
     */
    suspend fun resendCode(): FlowStep = step(TulaOperations.resendSignInCode)

    /**
     * Ask for the code that proves a first factor (step `needs_first_factor` offering it). The
     * answer is the same whether or not the address or the number has an account. Nothing is
     * sent until this is called.
     *
     * @return The step, still `needs_first_factor`, now with `prepared`.
     * @throws TulaError `rate_limited` (with `retryAfterMs`) when asked too soon,
     *   `auth.method_disabled`, and for a texted code `sms.disabled`,
     *   `sms.country_not_allowed` or `sms.unavailable`.
     */
    suspend fun prepareFirstFactor(strategy: CodeStrategy): FlowStep = step(
        TulaOperations.prepareSignInFirstFactor,
        encode(FirstFactorPrepareRequest.serializer(), FirstFactorPrepareRequest(strategy.prepared)),
    )

    /**
     * Prove a first factor with the code that was sent.
     *
     * @throws TulaError `verification.invalid_code`, `verification.expired`,
     *   `verification.too_many_attempts`, or `rate_limited` while the address is locked. For
     *   [CodeStrategy.SMS_CODE] every failure is `auth.invalid_credentials`.
     */
    suspend fun attemptFirstFactor(strategy: CodeStrategy, code: String): FlowStep {
        val request = when (strategy) {
            CodeStrategy.EMAIL_CODE ->
                FirstFactorAttemptRequest.EmailCode(FirstFactorAttemptRequestEmailCode(code = code))
            CodeStrategy.SMS_CODE ->
                FirstFactorAttemptRequest.SmsCode(FirstFactorAttemptRequestSmsCode(code = code))
        }
        return step(
            TulaOperations.attemptSignInFirstFactor,
            encode(FirstFactorAttemptRequest.serializer(), request),
        )
    }
}

/**
 * A password reset in progress. The emailed code and the new password travel together, so a
 * verified attempt never works as a credential on its own. A completed reset ends the user's
 * other sessions and signs this client in.
 *
 * ```kotlin
 * val flow = tula.resetPassword(email = email)
 * flow.submit(code = code, password = newPassword)
 * ```
 */
class PasswordResetFlow internal constructor(context: FlowContext, started: FlowAttempt) :
    Flow(context, started) {
    /**
     * Submit the emailed code and the new password (step `needs_new_password`).
     *
     * @return The next step: `complete`, or `needs_second_factor` for a user who has one.
     * @throws TulaError `verification.*` for the code, or the first unmet password rule's
     *   code with one field error per unmet rule.
     */
    suspend fun submit(code: String, password: String): FlowStep = step(
        TulaOperations.submitPasswordReset,
        encode(PasswordResetRequest.serializer(), PasswordResetRequest(code, password)),
    )

    /**
     * Email a fresh code and retire the previous one. The server sends at most one a minute.
     *
     * @throws TulaError `rate_limited` (with `retryAfterMs`) when asked too soon.
     */
    suspend fun resendCode(): FlowStep = step(TulaOperations.resendPasswordResetCode)
}
