package dev.tula.auth

import dev.tula.auth.generated.BackupCodes
import dev.tula.auth.generated.CurrentUser
import dev.tula.auth.generated.EmailAddressRequest
import dev.tula.auth.generated.EmailAddressVerifyRequest
import dev.tula.auth.generated.EmailCodeSent
import dev.tula.auth.generated.Factors
import dev.tula.auth.generated.Identity
import dev.tula.auth.generated.IdentityList
import dev.tula.auth.generated.OAuthProvider
import dev.tula.auth.generated.Passkey
import dev.tula.auth.generated.PasskeyCreationOptions
import dev.tula.auth.generated.PasskeyList
import dev.tula.auth.generated.PasskeyRegisterRequest
import dev.tula.auth.generated.PasskeyRequestOptions
import dev.tula.auth.generated.SmsFactorCode
import dev.tula.auth.generated.SmsFactorConfirmRequest
import dev.tula.auth.generated.StepUpEmailCode
import dev.tula.auth.generated.StepUpRequest
import dev.tula.auth.generated.StepUpRequestBackupCode
import dev.tula.auth.generated.StepUpRequestEmailCode
import dev.tula.auth.generated.StepUpRequestPasskey
import dev.tula.auth.generated.StepUpRequestPassword
import dev.tula.auth.generated.StepUpRequestSmsCode
import dev.tula.auth.generated.StepUpRequestTotp
import dev.tula.auth.generated.TotpConfirmRequest
import dev.tula.auth.generated.TotpEnrolment
import dev.tula.auth.generated.TulaOperations

// What a signed-in user does to how their account is protected: passkeys, the second factor,
// the provider accounts they sign in with, and proving again that it is them. Each of these
// may answer `auth.step_up_required`: `TulaError.stepUpMethods` says with what, and
// `TulaClient.stepUp` proves it.

/**
 * Proving again that it is the user (ADR 0025): each call answers one of the methods an
 * `auth.step_up_required` listed, and replaces the access token with one that carries the
 * proof. A user with a second factor steps up with it, never with the password alone.
 */
class TulaStepUp internal constructor(private val context: FlowContext) {
    private suspend fun prove(proof: StepUpRequest) {
        context.session.stepUp(encode(StepUpRequest.serializer(), proof))
    }

    /**
     * Step up with the account's password.
     *
     * @throws TulaError `auth.invalid_credentials`, `rate_limited`, `auth.step_up_required`
     *   (with the methods that do) for a user who has a second factor.
     */
    suspend fun withPassword(password: String): Unit =
        prove(StepUpRequest.Password(StepUpRequestPassword(password = password)))

    /**
     * Step up with the code of the user's authenticator app.
     *
     * @throws TulaError `mfa.invalid_code`, `rate_limited`.
     */
    suspend fun withTotp(code: String): Unit = prove(StepUpRequest.Totp(StepUpRequestTotp(code = code)))

    /** Step up with a backup code. A code works once. */
    suspend fun withBackupCode(code: String): Unit =
        prove(StepUpRequest.BackupCode(StepUpRequestBackupCode(code = code)))

    /**
     * Ask for a code by email, for a user with a verified address and no second factor.
     * Nothing is sent until this is called.
     *
     * @return The masked address and when the code stops working. Never the code.
     */
    suspend fun sendEmailCode(): StepUpEmailCode {
        val sent = context.transport.decode(
            StepUpEmailCode.serializer(),
            context.session.authorized(TulaOperations.sendStepUpEmailCode),
        )
        if (sent.method != "email_code" || sent.destination.isEmpty() || sent.expiresAt.isEmpty()) {
            throw context.transport.invalid()
        }
        return sent
    }

    /**
     * Step up with the code [sendEmailCode] asked for.
     *
     * @throws TulaError `verification.invalid_code`, `verification.expired`.
     */
    suspend fun withEmailCode(code: String): Unit =
        prove(StepUpRequest.EmailCode(StepUpRequestEmailCode(code = code)))

    /**
     * Ask for a code by text message, for a user whose only second factor is a texted code.
     *
     * @return The masked number and when the code stops working. Never the code.
     */
    suspend fun sendSmsCode(): SmsFactorCode = context.receipt(
        context.session.authorized(TulaOperations.sendStepUpSmsCode),
    )

    /** Step up with the code [sendSmsCode] asked for. */
    suspend fun withSmsCode(code: String): Unit = prove(StepUpRequest.SmsCode(StepUpRequestSmsCode(code = code)))

    /**
     * Step up with a passkey: asks the API for the options, shows the passkey sheet and
     * proves what it returns.
     *
     * @return Finished, or [TulaCeremony.Dismissed] when the user closed the sheet (nothing
     *   was sent to be judged).
     * @throws TulaError `flow.busy`, `passkey.unsupported`, `passkey.failed`,
     *   `auth.invalid_credentials` for an assertion the API refuses.
     */
    suspend fun withPasskey(): TulaCeremony<Unit> = context.gate.ceremony {
        context.requirePasskeys()
        val options = context.transport.decode(
            PasskeyRequestOptions.serializer(),
            context.session.authorized(TulaOperations.getStepUpPasskeyOptions),
        )
        val credential = context.assertion(options) ?: return@ceremony TulaCeremony.Dismissed
        prove(StepUpRequest.Passkey(StepUpRequestPasskey(credential = credential)))
        TulaCeremony.Finished(Unit)
    }

    override fun toString(): String = "TulaStepUp"
}

/** A receipt for a texted code: the masked number and the expiry, checked. */
private fun FlowContext.receipt(payload: kotlinx.serialization.json.JsonElement?): SmsFactorCode {
    val sent = transport.decode(SmsFactorCode.serializer(), payload)
    if (sent.method != "sms_code" || sent.destination.isEmpty() || sent.expiresAt.isEmpty()) {
        throw transport.invalid()
    }
    return sent
}

/**
 * The signed-in user's passkeys (ADR 0027). Never key material: a name, whether it is synced,
 * and when it was added and last used.
 */
class TulaPasskeys internal constructor(private val context: FlowContext) {
    /** The user's passkeys, oldest first. */
    suspend fun list(): List<Passkey> = context.transport.decode(
        PasskeyList.serializer(),
        context.session.authorized(TulaOperations.listMyPasskeys),
    ).passkeys

    /**
     * Make a passkey on this device and register it. Nothing of the ceremony is kept.
     *
     * @param name A name for it, shown in the list. The server names it otherwise.
     * @return The passkey, or [TulaCeremony.Dismissed] when the user closed the sheet:
     *   nothing was registered.
     * @throws TulaError `flow.busy` while another sheet of the client is out,
     *   `passkey.unsupported`, `passkey.already_on_device`, `passkey.failed`,
     *   `auth.step_up_required`.
     */
    suspend fun add(name: String? = null): TulaCeremony<Passkey> = context.gate.ceremony {
        val sheet = context.requirePasskeys()
        val options = context.transport.decode(
            PasskeyCreationOptions.serializer(),
            context.session.authorized(TulaOperations.startPasskeyRegistration),
        )
        if (!PasskeyChecks.usable(options)) {
            throw context.transport.invalid()
        }
        val credential = context.gate.sheet(CeremonyGate.Kind.PASSKEY) { sheet.create(options) }
            ?: return@ceremony TulaCeremony.Dismissed
        if (!PasskeyChecks.usable(credential)) {
            throw context.error(ClientErrorCodes.PASSKEY_FAILED)
        }
        val passkey = context.transport.decode(
            Passkey.serializer(),
            context.session.authorized(
                TulaOperations.finishPasskeyRegistration,
                CallInput(body = encode(PasskeyRegisterRequest.serializer(), PasskeyRegisterRequest(credential, name))),
            ),
        )
        if (passkey.id.isEmpty()) {
            throw context.transport.invalid()
        }
        TulaCeremony.Finished(passkey)
    }

    /**
     * Remove a passkey from the account. The last way to sign in cannot be removed
     * (`passkey.last_sign_in_method`). The passkey stays on the device: the system's
     * password manager removes it there.
     */
    suspend fun remove(id: String) {
        context.session.authorized(TulaOperations.removePasskey, CallInput(params = mapOf("passkeyId" to id)))
    }

    override fun toString(): String = "TulaPasskeys"
}

/**
 * The signed-in user's second factor (ADR 0025): an authenticator app and its backup codes,
 * or a texted code.
 *
 * A setup key, its URI and backup codes are returned once and kept nowhere in the client.
 */
class TulaFactors internal constructor(private val context: FlowContext) {
    /**
     * Whether an authenticator app is confirmed, since when, how many backup codes are
     * unused, and where a texted code stands. Never a secret.
     */
    suspend fun get(): Factors =
        context.transport.decode(Factors.serializer(), context.session.authorized(TulaOperations.getMyFactors))

    /**
     * Start enrolling an authenticator app. It counts for nothing until confirmed, and lapses
     * after ten minutes; calling it again replaces the pending secret.
     *
     * @return The setup key and its `otpauth://` URI, once.
     */
    suspend fun startTotp(): TotpEnrolment {
        val enrolment = context.transport.decode(
            TotpEnrolment.serializer(),
            context.session.authorized(TulaOperations.startTotpEnrolment),
        )
        if (enrolment.secret.isEmpty() || !enrolment.uri.startsWith("otpauth://")) {
            throw context.transport.invalid()
        }
        return enrolment
    }

    /**
     * Confirm the authenticator app with a code it shows. The user's other sessions end. The
     * client then refreshes this session, so that its next access token says the second
     * factor was proven; when that refresh cannot be made the codes are returned all the
     * same, and the next `getToken()` tries again.
     *
     * @return The backup codes, once.
     * @throws TulaError `mfa.invalid_code`, `mfa.enrolment_expired`.
     */
    suspend fun confirmTotp(code: String): List<String> {
        val codes = codes(
            context.session.authorized(
                TulaOperations.confirmTotpEnrolment,
                CallInput(body = encode(TotpConfirmRequest.serializer(), TotpConfirmRequest(code))),
            ),
        )
        refreshQuietly()
        return codes
    }

    /**
     * Turn the authenticator app off: removes it and every backup code.
     *
     * @throws TulaError `mfa.not_enabled`, `mfa.required_by_policy`, `auth.step_up_required`.
     */
    suspend fun disableTotp() {
        context.session.authorized(TulaOperations.disableTotp)
    }

    /**
     * Replace the user's backup codes. The earlier ones stop working.
     *
     * @return The new codes, once.
     */
    suspend fun regenerateBackupCodes(): List<String> =
        codes(context.session.authorized(TulaOperations.regenerateBackupCodes))

    /**
     * Start enrolling a texted code as the second factor: a code is texted to the account's
     * proven phone number. For a user with no authenticator app and no passkey.
     *
     * @return The masked number and when the code stops working. Never the code.
     */
    suspend fun startSms(): SmsFactorCode =
        context.receipt(context.session.authorized(TulaOperations.startSmsFactorEnrolment))

    /**
     * Confirm the texted code. The client then refreshes this session, as [confirmTotp] does.
     *
     * @return The user's factors after the change.
     */
    suspend fun confirmSms(code: String): Factors {
        val factors = context.transport.decode(
            Factors.serializer(),
            context.session.authorized(
                TulaOperations.confirmSmsFactorEnrolment,
                CallInput(body = encode(SmsFactorConfirmRequest.serializer(), SmsFactorConfirmRequest(code))),
            ),
        )
        refreshQuietly()
        return factors
    }

    /** Turn the texted second factor off. */
    suspend fun disableSms() {
        context.session.authorized(TulaOperations.disableSmsFactor)
    }

    private suspend fun refreshQuietly() {
        try {
            context.session.refresh()
        } catch (_: TulaError) {
            // The change was made; the next `getToken()` asks again.
        }
    }

    private fun codes(payload: kotlinx.serialization.json.JsonElement?): List<String> {
        val codes = context.transport.decode(BackupCodes.serializer(), payload).codes
        if (codes.isEmpty() || codes.any { it.isEmpty() }) {
            throw context.transport.invalid()
        }
        return codes
    }

    override fun toString(): String = "TulaFactors"
}

/**
 * An email address for a signed-in account that has none (ADR 0059): an account whose first
 * sign-in was with a provider that gives no address.
 *
 * Both calls are refused `email.already_set` for an account that has an address, and need a
 * recent authentication (`auth.step_up_required`; a user with nothing to step up with signs
 * in again with their provider).
 */
class TulaEmailAddress internal constructor(private val context: FlowContext) {
    /**
     * Email a code to an address to add to the account. Nothing is stored on the account
     * until [verify]. An address another account holds is answered like a free one, and no
     * code confirms it.
     *
     * @param email The address to prove.
     * @return The masked address and when the code stops working. Never the code.
     * @throws TulaError `email.invalid`, `email.already_set`, `rate_limited`,
     *   `auth.step_up_required`.
     */
    suspend fun request(email: String): EmailCodeSent {
        val sent = context.transport.decode(
            EmailCodeSent.serializer(),
            context.session.authorized(
                TulaOperations.requestEmailAddressCode,
                CallInput(body = encode(EmailAddressRequest.serializer(), EmailAddressRequest(email))),
            ),
        )
        if (sent.destination.isEmpty() || sent.expiresAt.isEmpty()) {
            throw context.transport.invalid()
        }
        return sent
    }

    /**
     * Confirm the address with the emailed code. The account then has it, verified, and the
     * client's state shows the user with it.
     *
     * @param code The code from the email.
     * @return The user after the change.
     * @throws TulaError `verification.invalid_code`, `verification.expired`,
     *   `email.already_set`.
     */
    suspend fun verify(code: String): CurrentUser = context.session.userFrom(
        TulaOperations.verifyEmailAddress,
        CallInput(body = encode(EmailAddressVerifyRequest.serializer(), EmailAddressVerifyRequest(code))),
    )

    override fun toString(): String = "TulaEmailAddress"
}

/** The provider accounts the signed-in user signs in with (ADR 0026). */
class TulaIdentities internal constructor(private val context: FlowContext) {
    /** The user's connected accounts: a provider and when it was connected. Never a provider's token. */
    suspend fun list(): List<Identity> = context.transport.decode(
        IdentityList.serializer(),
        context.session.authorized(TulaOperations.listMyIdentities),
    ).data

    /**
     * Connect a provider account, through the browser.
     *
     * @param provider The provider.
     * @param redirectUrl Where the API sends the browser back to; one of the environment's
     *   allowed redirect URLs. The server judges it, never the client. (A link start is a
     *   `web` attempt to the server: it takes an app link, and refuses a custom scheme with
     *   `request.redirect_not_allowed`.)
     * @return Linked, cancelled or refused.
     */
    suspend fun link(provider: OAuthProvider, redirectUrl: String): ProviderOutcome =
        context.providerRoundTrip(ProviderRoundTrip.Intent.LINK, provider, redirectUrl)

    /** Disconnect a provider account. The last way to sign in cannot be removed. */
    suspend fun unlink(id: String) {
        context.session.authorized(TulaOperations.deleteMyIdentity, CallInput(params = mapOf("identityId" to id)))
    }

    override fun toString(): String = "TulaIdentities"
}
