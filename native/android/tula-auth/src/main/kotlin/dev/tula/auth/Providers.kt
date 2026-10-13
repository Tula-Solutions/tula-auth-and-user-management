package dev.tula.auth

import dev.tula.auth.generated.FlowAttempt
import dev.tula.auth.generated.IdTokenExchangeRequest
import dev.tula.auth.generated.Identity
import dev.tula.auth.generated.IdentityLinkStart
import dev.tula.auth.generated.OAuthExchangeRequest
import dev.tula.auth.generated.OAuthProvider
import dev.tula.auth.generated.OAuthStart
import dev.tula.auth.generated.OAuthStartRequest
import dev.tula.auth.generated.TulaErrorDefinitions
import dev.tula.auth.generated.TulaOperations
import java.io.ByteArrayOutputStream
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction

// Signing in with a provider, the two ways a native app has (ADR 0045, ADR 0044): handing the
// server an ID token the platform gave the app, and a round trip through the browser that
// comes back to the app by a link.

/**
 * A started sign-in with a provider's ID token: the nonce the token must carry, and the one
 * exchange of the token.
 *
 * The attempt's secret is held inside and is never a property; the object prints as its
 * type's name. The ID token is sent once, in a JSON body, and kept nowhere.
 */
class IdTokenSignIn internal constructor(
    /**
     * The server's nonce for this attempt. The app gives it to the provider's SDK so that the
     * ID token carries it. **Google's takes it as it is**: never hash it.
     */
    val nonce: String,
    private val flow: SignInFlow,
) {
    /**
     * Hand the server the ID token. An attempt takes one token, right or wrong: after a
     * refusal the app starts again.
     *
     * @param idToken The token the provider's SDK returned.
     * @return The sign-in, at its next step: `complete`, or a second factor.
     * @throws TulaError `auth.invalid_credentials` for every refusal of the token,
     *   `service.unavailable` when the provider's keys could not be had.
     */
    suspend fun exchange(idToken: String): SignInFlow {
        flow.step(
            TulaOperations.submitSignInIdToken,
            encode(IdTokenExchangeRequest.serializer(), IdTokenExchangeRequest(idToken = idToken)),
        )
        return flow
    }

    /** Leave the attempt: its secret is forgotten and a late answer is dropped. */
    fun discard() {
        flow.discard()
    }

    /** The type's name, and nothing of what it holds. */
    override fun toString(): String = "IdTokenSignIn"
}

/** Why a provider round trip ended without an answer of the provider being used. */
sealed class ProviderRefusal {
    /**
     * The browser came back to an address that is not the redirect URL that was asked for.
     * Nothing of it was read and no request was made.
     */
    object UnexpectedReturn : ProviderRefusal() {
        override fun toString(): String = "unexpected_return"
    }

    /** The browser came back with neither a ticket nor an error, or there is nothing to try again. */
    object NoAnswer : ProviderRefusal() {
        override fun toString(): String = "no_answer"
    }

    /** This client did not start the round trip the answer belongs to, or no longer has what it kept of it. */
    object NotStartedHere : ProviderRefusal() {
        override fun toString(): String = "not_started_here"
    }

    /**
     * The provider or the API refused. [code] is a code of the contract; a code the returned
     * address carried that the contract does not define is `oauth.provider_error`.
     */
    data class Failed(val code: String) : ProviderRefusal() {
        override fun toString(): String = code
    }
}

/** What became of a provider round trip. Each prints as its name, and nothing of a flow or an identity. */
sealed class ProviderOutcome {
    /** Signed in: the flow is `complete`. */
    class SignedIn(val flow: SignInFlow) : ProviderOutcome() {
        override fun toString(): String = "ProviderOutcome.SignedIn"
    }

    /** The provider proved the first factor and the server asks for more (a second factor). */
    class NeedsStep(val flow: SignInFlow) : ProviderOutcome() {
        override fun toString(): String = "ProviderOutcome.NeedsStep"
    }

    /** The provider account is now one of the signed-in user's. */
    class Linked(val identity: Identity) : ProviderOutcome() {
        override fun toString(): String = "ProviderOutcome.Linked"
    }

    /** The user closed the browser. Not an error: nothing was sent to prove anything. */
    object Cancelled : ProviderOutcome() {
        override fun toString(): String = "ProviderOutcome.Cancelled"
    }

    /** The round trip ended without signing anyone in; see [ProviderRefusal]. */
    class Refused(val refusal: ProviderRefusal) : ProviderOutcome() {
        override fun toString(): String = "ProviderOutcome.Refused($refusal)"
    }
}

/**
 * What a client keeps of a provider round trip, in memory and nowhere else: the binding the
 * starting client was given, and a ticket whose exchange got no answer.
 */
internal class ProviderRoundTrip {
    enum class Intent { SIGN_IN, LINK }

    class Kept(val attemptId: String, val binding: String, val intent: Intent)

    class Held(val ticket: String, val untilMs: Long)

    /** What the fragment of a returned address says: a ticket and its attempt, or an error. */
    class Answer(val ticket: String?, val attemptId: String?, val error: String?) {
        /** A ticket completes a sign-in with the binding: it is never printed. */
        override fun toString(): String = "Answer"
    }

    private val lock = Any()
    private var kept: Kept? = null
    private var held: Held? = null

    fun keep(next: Kept) = synchronized(lock) {
        kept = next
        held = null
    }

    fun hold(next: Held) = synchronized(lock) { held = next }

    fun current(): Pair<Kept, Held>? = synchronized(lock) {
        val binding = kept
        val ticket = held
        if (binding != null && ticket != null) binding to ticket else null
    }

    fun forget() = synchronized(lock) {
        kept = null
        held = null
    }

    companion object {
        /**
         * How long a ticket whose exchange got no answer is kept for another try. The API
         * honours a ticket for 60 seconds.
         */
        const val TICKET_HOLD_MS: Long = 60_000

        /**
         * The failures of an exchange that say nothing about the ticket: the same call again
         * may work. The last two are raised before the request about the ticket is sent (by
         * the refresh a link's exchange may need first).
         */
        val RETRYABLE: Set<String> = setOf(
            ClientErrorCodes.NETWORK_FAILED,
            ClientErrorCodes.NETWORK_TIMEOUT,
            "rate_limited",
            ClientErrorCodes.STORAGE_FAILED,
            ClientErrorCodes.DEVICE_KEY_FAILED,
        )

        private val contractCodes: Set<String> by lazy {
            TulaErrorDefinitions.all.map { it.code.rawValue }.toSet()
        }

        /**
         * The code of an error the address carried. The address is untrusted: only a code the
         * contract defines is passed on.
         */
        fun known(code: String): String = if (code in contractCodes) code else "oauth.provider_error"

        /**
         * Read a returned address, **only when it is the redirect URL that was asked for,
         * character for character, followed by `#`**. Neither side is normalised.
         *
         * @return The fragment's answer, or the refusal: [ProviderRefusal.NoAnswer] for an
         *   address with no fragment or one with neither a ticket nor an error,
         *   [ProviderRefusal.UnexpectedReturn] for any other address.
         */
        fun read(returned: String, redirectUrl: String): Pair<Answer?, ProviderRefusal?> {
            val at = returned.indexOf('#')
            if (at < 0) {
                return null to ProviderRefusal.NoAnswer
            }
            if (returned.substring(0, at) != redirectUrl) {
                return null to ProviderRefusal.UnexpectedReturn
            }
            var ticket: String? = null
            var attemptId: String? = null
            var error: String? = null
            for (pair in returned.substring(at + 1).split('&')) {
                val cut = pair.indexOf('=')
                if (cut < 0) {
                    continue
                }
                val value = percentDecoded(pair.substring(cut + 1))?.takeIf { it.isNotEmpty() } ?: continue
                // The first of a name counts: a later one cannot replace it.
                when (pair.substring(0, cut)) {
                    "tula_ticket" -> ticket = ticket ?: value
                    "tula_attempt" -> attemptId = attemptId ?: value
                    "tula_error" -> error = error ?: value
                }
            }
            if (ticket == null && error == null) {
                return null to ProviderRefusal.NoAnswer
            }
            return Answer(ticket, attemptId, error) to null
        }

        /** Percent-decoding and nothing else (a `+` is a plus); `null` for what is not UTF-8. */
        fun percentDecoded(text: String): String? {
            val bytes = ByteArrayOutputStream()
            var index = 0
            while (index < text.length) {
                val char = text[index]
                if (char == '%') {
                    val hex = text.substring(index + 1, minOf(index + 3, text.length))
                    val byte = hex.takeIf { it.length == 2 }?.toIntOrNull(16) ?: return null
                    bytes.write(byte)
                    index += 3
                } else {
                    bytes.write(char.toString().toByteArray(Charsets.UTF_8))
                    index += 1
                }
            }
            return try {
                Charsets.UTF_8.newDecoder()
                    .onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT)
                    .decode(java.nio.ByteBuffer.wrap(bytes.toByteArray()))
                    .toString()
            } catch (_: CharacterCodingException) {
                null
            }
        }
    }
}

/** A flow for an attempt the API just answered with, its session adopted when it is complete. */
internal suspend fun FlowContext.begin(started: FlowAttempt): SignInFlow =
    SignInFlow(this, started).also { it.accept(started) }

/** One round trip through the browser. */
internal suspend fun FlowContext.providerRoundTrip(
    intent: ProviderRoundTrip.Intent,
    provider: OAuthProvider,
    redirectUrl: String,
): ProviderOutcome {
    val browser = browser ?: throw error(ClientErrorCodes.PROVIDER_UNSUPPORTED)
    return gate.ceremony {
        // A new round trip replaces one that was waiting for a retry.
        roundTrip.forget()
        // The redirect URL is sent as it is: the server judges it, never the client.
        val body = encode(OAuthStartRequest.serializer(), OAuthStartRequest(provider, redirectUrl))
        val attemptId: String
        val url: String
        val binding: String
        when (intent) {
            ProviderRoundTrip.Intent.SIGN_IN -> {
                val started = transport.decode(
                    OAuthStart.serializer(),
                    transport.call(TulaOperations.startOAuthSignIn, CallInput(body = body)),
                )
                attemptId = started.attempt.id
                url = started.authorizationUrl
                binding = started.binding
            }
            ProviderRoundTrip.Intent.LINK -> {
                val started = transport.decode(
                    IdentityLinkStart.serializer(),
                    session.authorized(TulaOperations.startIdentityLink, CallInput(body = body)),
                )
                attemptId = started.attemptId
                url = started.authorizationUrl
                binding = started.binding
            }
        }
        if (attemptId.isEmpty() || binding.isEmpty() || !(url.startsWith("https://") || url.startsWith("http://"))) {
            throw transport.invalid()
        }
        roundTrip.keep(ProviderRoundTrip.Kept(attemptId, binding, intent))
        val returned = try {
            gate.sheet(CeremonyGate.Kind.PROVIDER) { browser.open(url, redirectUrl) }
        } catch (error: TulaError) {
            roundTrip.forget()
            throw error
        }
        if (returned == null) {
            roundTrip.forget()
            return@ceremony ProviderOutcome.Cancelled
        }
        val (answer, refusal) = ProviderRoundTrip.read(returned, redirectUrl)
        if (answer == null) {
            roundTrip.forget()
            return@ceremony ProviderOutcome.Refused(refusal ?: ProviderRefusal.NoAnswer)
        }
        val ticket = answer.ticket
        if (answer.error != null || ticket == null) {
            roundTrip.forget()
            return@ceremony ProviderOutcome.Refused(
                ProviderRefusal.Failed(ProviderRoundTrip.known(answer.error.orEmpty())),
            )
        }
        if (answer.attemptId != attemptId) {
            // An answer for a round trip this client did not start: nothing is sent.
            roundTrip.forget()
            return@ceremony ProviderOutcome.Refused(ProviderRefusal.NotStartedHere)
        }
        roundTrip.hold(ProviderRoundTrip.Held(ticket, clock.nowMs() + ProviderRoundTrip.TICKET_HOLD_MS))
        exchangeTicket()
    }
}

/** Exchange the ticket that is held, with the binding that was kept. */
internal suspend fun FlowContext.exchangeTicket(): ProviderOutcome {
    val (kept, held) = roundTrip.current() ?: return ProviderOutcome.Refused(ProviderRefusal.NoAnswer)
    if (clock.nowMs() >= held.untilMs) {
        // The API no longer honours it: say so without asking.
        roundTrip.forget()
        return ProviderOutcome.Refused(ProviderRefusal.Failed("oauth.ticket_invalid"))
    }
    val body = encode(
        OAuthExchangeRequest.serializer(),
        OAuthExchangeRequest(ticket = held.ticket, attemptId = kept.attemptId, binding = kept.binding),
    )
    try {
        val outcome = when (kept.intent) {
            ProviderRoundTrip.Intent.LINK -> {
                val identity = transport.decode(
                    Identity.serializer(),
                    session.authorized(TulaOperations.exchangeIdentityLinkTicket, CallInput(body = body)),
                )
                if (identity.id.isEmpty()) {
                    throw transport.invalid()
                }
                ProviderOutcome.Linked(identity)
            }
            ProviderRoundTrip.Intent.SIGN_IN -> {
                val next = transport.attempt(transport.call(TulaOperations.exchangeOAuthTicket, CallInput(body = body)))
                // The ticket was answered: what follows (keeping the session) is not about it.
                roundTrip.forget()
                val flow = begin(next)
                if (next.step.status == "complete") ProviderOutcome.SignedIn(flow) else ProviderOutcome.NeedsStep(flow)
            }
        }
        roundTrip.forget()
        return outcome
    } catch (error: TulaError) {
        if (roundTrip.current() != null && error.code in ProviderRoundTrip.RETRYABLE) {
            // No answer about the ticket: it and the binding are kept for another try.
            throw error
        }
        roundTrip.forget()
        // One of the client's own codes is not an answer about the ticket to report as the
        // provider's: it is thrown. (`response.invalid` carries the answer's status.)
        if (error.status == 0 || error.code == ClientErrorCodes.RESPONSE_INVALID) {
            throw error
        }
        if (error.code == "oauth.different_browser") {
            return ProviderOutcome.Refused(ProviderRefusal.NotStartedHere)
        }
        return ProviderOutcome.Refused(ProviderRefusal.Failed(error.code))
    }
}
