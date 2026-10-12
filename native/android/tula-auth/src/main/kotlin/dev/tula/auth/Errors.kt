package dev.tula.auth

import dev.tula.auth.generated.TulaErrorDefinitions

/**
 * Messages by error code, for one language. A table may cover only some codes; the rest fall
 * back to English. A message can use an error's params as `{name}` placeholders.
 */
typealias Messages = Map<String, String>

/**
 * The codes the client raises itself, before or instead of an answer of the API. They sit next
 * to the contract's codes ([dev.tula.auth.generated.ErrorCode]) so that a caller has one thing
 * to catch and one field to look at. [TulaError.status] is `0` for all of them.
 *
 * One contract code is also raised by the client: `flow.invalid_step`, with status `0`, for an
 * action on a flow that has completed or was discarded.
 */
object ClientErrorCodes {
    /** The request never reached the API, or its answer never came back. */
    const val NETWORK_FAILED: String = "network.failed"

    /** No answer came in time. */
    const val NETWORK_TIMEOUT: String = "network.timeout"

    /** The answer was not what the API sends (a proxy's page, a wrong base URL). */
    const val RESPONSE_INVALID: String = "response.invalid"

    /** The token storage failed. The session, if there is one, is kept in memory. */
    const val STORAGE_FAILED: String = "storage.failed"

    /** A flow was asked for a second action while one was still being sent. */
    const val FLOW_BUSY: String = "flow.busy"

    internal const val FLOW_INVALID_STEP: String = "flow.invalid_step"

    internal val messages: Messages = mapOf(
        NETWORK_FAILED to "Could not reach the server. Check your connection and try again.",
        NETWORK_TIMEOUT to "The server took too long to answer. Try again.",
        RESPONSE_INVALID to "The server sent a response this app could not read.",
        STORAGE_FAILED to "Your session could not be saved on this device.",
        FLOW_BUSY to "Another step of this flow is still being sent. Wait for it to finish.",
    )
}

/** One field-level problem of a failed request, e.g. each password rule that was not met. */
class TulaFieldError(
    /** The request field the problem is about, e.g. `password`. */
    val field: String,
    /** The problem's code, e.g. `password.too_short`. */
    val code: String,
    /** A message for the user, from the client's message table. */
    val message: String,
    /** The problem's params, e.g. `min` → `10`. Values are strings, numbers or booleans. */
    val params: Map<String, Any>,
)

/**
 * The one error every failed call of the client throws.
 *
 * [code] is a contract code (`auth.invalid_credentials`, `password.too_short`,
 * `rate_limited`, …) or one of [ClientErrorCodes]. [message] is ready to show. An error never
 * holds a token, an attempt's secret, a password or a code.
 *
 * [cause], where there is one, is the runtime's own error (of the network or of the storage).
 * Its text is the platform's: do not show it to a user.
 */
class TulaError(
    /** A contract error code, or one of the client's own. */
    val code: String,
    message: String,
    /** HTTP status of the API's answer; `0` when the request got none. */
    val status: Int = 0,
    /** Values that give the error its specifics, e.g. `min` → `10`. */
    val params: Map<String, Any> = emptyMap(),
    /** Field-level problems (`validation.failed`, password rules). Empty when there are none. */
    val errors: List<TulaFieldError> = emptyList(),
    /**
     * How long to wait before trying again, in milliseconds, when the server said
     * (`Retry-After`). The client never waits or retries for it by itself.
     */
    val retryAfterMs: Long? = null,
    cause: Throwable? = null,
) : Exception(message, cause)

/** The English message of every contract code and of the client's own. */
internal val englishMessages: Messages by lazy {
    val table = HashMap<String, String>(ClientErrorCodes.messages)
    for (definition in TulaErrorDefinitions.all) {
        table[definition.code.rawValue] = definition.message
    }
    table
}

private val PLACEHOLDER = Regex("\\{(\\w+)\\}")

/**
 * The message for an error code, with `{name}` placeholders filled from [params]. A placeholder
 * with no matching param is left as it is.
 *
 * @param code The error code.
 * @param messages The app's table; a code it lacks uses English.
 * @param params The error's params.
 * @param fallback Used when neither table knows the code (a newer server's own message).
 * @return The message.
 */
fun formatMessage(
    code: String,
    messages: Messages = emptyMap(),
    params: Map<String, Any> = emptyMap(),
    fallback: String? = null,
): String {
    val template = messages[code]
        ?: englishMessages[code]
        ?: fallback
        ?: englishMessages.getValue("internal")
    return PLACEHOLDER.replace(template) { match ->
        params[match.groupValues[1]]?.let(::paramText) ?: match.value
    }
}

/** A param as a reader writes it: a whole number without a decimal point. */
private fun paramText(value: Any): String =
    if (value is Double && value % 1.0 == 0.0 && value in -1e15..1e15) {
        value.toLong().toString()
    } else {
        value.toString()
    }

/** An error the client raises itself: no answer of the API stands behind it. */
internal fun clientError(code: String, messages: Messages, cause: Throwable? = null): TulaError =
    TulaError(code = code, message = formatMessage(code, messages), cause = cause)
