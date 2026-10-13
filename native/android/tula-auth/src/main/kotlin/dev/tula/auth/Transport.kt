package dev.tula.auth

import dev.tula.auth.generated.TulaJson
import dev.tula.auth.generated.TulaOperation
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.async
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.isActive
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.DeserializationStrategy
import kotlinx.serialization.SerializationException
import kotlinx.serialization.SerializationStrategy
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.longOrNull
import java.net.SocketTimeoutException
import java.net.URLEncoder
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter

/** The header that carries the environment's publishable key. */
internal const val PUBLISHABLE_KEY_HEADER = "x-tula-publishable-key"

/** The header that says what kind of client is calling. */
internal const val CLIENT_HEADER = "x-tula-client"

/** The header that asks for a session profile. */
internal const val SESSION_PROFILE_HEADER = "x-tula-session-profile"

/** The header that carries an attempt's secret. */
internal const val FLOW_ATTEMPT_HEADER = "x-tula-attempt"

/** The client kind this SDK is: fixed, never an option. */
internal const val CLIENT_KIND = "android"

private val PATH_PARAMETER = Regex("\\{(\\w+)\\}")
private val SECONDS = Regex("^\\d{1,9}$")

/** What one call carries beside its operation. */
internal class CallInput(
    /** The values of the path's `{name}` placeholders. */
    val params: Map<String, String> = emptyMap(),
    /** The JSON body, already written. */
    val body: String? = null,
    /** Sent as `Authorization: Bearer …`. */
    val accessToken: String? = null,
    /** Sent as `x-tula-attempt`. */
    val attemptSecret: String? = null,
    /** This call's own timeout, in place of the transport's. */
    val timeoutMs: Long? = null,
)

/**
 * The one place a request is put together and an answer is read.
 *
 * It adds the publishable key and the client kind, applies the timeout, and turns every
 * failure into a [TulaError]. It never retries, follows no redirect and keeps nothing.
 *
 * **The timeout does not rest on the engine ending its request when it is cancelled.** The
 * request runs in the client's own scope and the call waits for it, for the timeout at most:
 * an engine that ignores cancellation (an app's own may) is left behind, its late answer
 * dropped. Waited for instead, one stuck request would hold the single refresh past the
 * server's grace window.
 */
internal class Transport(
    private val baseUrl: String,
    private val publishableKey: String,
    private val http: HttpEngine,
    private val timeoutMs: Long,
    private val clock: Clock,
    private val messages: () -> Messages,
    private val sessionProfile: String?,
    private val scope: CoroutineScope,
) {
    /**
     * Send one operation.
     *
     * @return The parsed body of a success; `null` for a 204.
     * @throws TulaError for every failure: an error answer, no answer, or an unreadable one.
     */
    suspend fun call(operation: TulaOperation, input: CallInput = CallInput()): JsonElement? {
        val headers = LinkedHashMap<String, String>()
        headers["accept"] = "application/json"
        headers[PUBLISHABLE_KEY_HEADER] = publishableKey
        headers[CLIENT_HEADER] = CLIENT_KIND
        if (sessionProfile != null) {
            headers[SESSION_PROFILE_HEADER] = sessionProfile
        }
        if (input.body != null) {
            headers["content-type"] = "application/json"
        }
        if (!input.accessToken.isNullOrEmpty()) {
            headers["authorization"] = "Bearer ${input.accessToken}"
        }
        if (!input.attemptSecret.isNullOrEmpty()) {
            headers[FLOW_ATTEMPT_HEADER] = input.attemptSecret
        }
        val limit = input.timeoutMs ?: timeoutMs
        val request = HttpRequest(
            method = operation.method,
            url = buildUrl(operation.path, input.params),
            headers = headers,
            body = input.body,
            timeoutMs = limit,
        )
        // In the client's scope, not the caller's: a caller's scope would wait for it.
        val sending = scope.async { http.send(request) }
        val answered = try {
            // `null` for this call's own timeout only: a timeout the caller set around the
            // call is the caller's, and passes through as the cancellation it is.
            withTimeoutOrNull(limit) { sending.await() }
        } catch (cause: CancellationException) {
            sending.cancel()
            if (!currentCoroutineContext().isActive) {
                // The caller gave up: that is not a failure of the network.
                throw cause
            }
            // The request ended by a cancellation of its own (an engine's coroutine
            // timeout, a closed client): no answer came.
            throw clientError(
                if (cause is TimeoutCancellationException) {
                    ClientErrorCodes.NETWORK_TIMEOUT
                } else {
                    ClientErrorCodes.NETWORK_FAILED
                },
                messages(),
                cause,
            )
        } catch (cause: SocketTimeoutException) {
            throw clientError(ClientErrorCodes.NETWORK_TIMEOUT, messages(), cause)
        } catch (cause: Exception) {
            throw clientError(ClientErrorCodes.NETWORK_FAILED, messages(), cause)
        }
        if (answered == null) {
            sending.cancel()
            throw clientError(ClientErrorCodes.NETWORK_TIMEOUT, messages())
        }
        val response: HttpResponse = answered

        val payload: JsonElement? = if (response.status == 204) {
            null
        } else {
            try {
                TulaJson.parseToJsonElement(response.body)
            } catch (_: SerializationException) {
                UNREADABLE
            }
        }
        if (response.status !in 200..299) {
            throw errorFromResponse(response, payload)
        }
        if (payload === UNREADABLE) {
            throw TulaError(
                code = ClientErrorCodes.RESPONSE_INVALID,
                message = formatMessage(ClientErrorCodes.RESPONSE_INVALID, messages()),
                status = response.status,
            )
        }
        return payload
    }

    /** An error for a 2xx whose body is not what the operation answers. */
    fun invalid(): TulaError = clientError(ClientErrorCodes.RESPONSE_INVALID, messages())

    /**
     * Read a success body as a generated type.
     *
     * @throws TulaError `response.invalid` when it is not one: a 200 is not proof of talking
     *   to the API (a wrong base URL and a proxy's page answer 200 too).
     */
    fun <T> decode(strategy: DeserializationStrategy<T>, payload: JsonElement?): T {
        if (payload == null) {
            throw invalid()
        }
        return try {
            TulaJson.decodeFromJsonElement(strategy, payload)
        } catch (_: SerializationException) {
            throw invalid()
        } catch (_: IllegalArgumentException) {
            throw invalid()
        }
    }

    private fun buildUrl(path: String, params: Map<String, String>): String =
        baseUrl + PATH_PARAMETER.replace(path) { match ->
            URLEncoder.encode(params[match.groupValues[1]] ?: "", "UTF-8").replace("+", "%20")
        }

    private fun errorFromResponse(response: HttpResponse, payload: JsonElement?): TulaError {
        val table = messages()
        val envelope = payload as? JsonObject
        val code = envelope?.get("code").text()
        if (envelope == null || code == null) {
            // Not the API's error envelope: a proxy's error page, or something that is not
            // this API.
            return TulaError(
                code = ClientErrorCodes.RESPONSE_INVALID,
                message = formatMessage(ClientErrorCodes.RESPONSE_INVALID, table),
                status = response.status,
                retryAfterMs = retryAfterMs(response, emptyMap()),
            )
        }
        val params = readParams(envelope["params"])
        return TulaError(
            code = code,
            message = formatMessage(code, table, params, envelope["detail"].text()),
            status = response.status,
            params = params,
            errors = readFieldErrors(envelope["errors"], table),
            retryAfterMs = retryAfterMs(response, params),
        )
    }

    private fun readFieldErrors(value: JsonElement?, table: Messages): List<TulaFieldError> {
        val problems = ArrayList<TulaFieldError>()
        for (entry in (value as? JsonArray).orEmpty()) {
            val problem = entry as? JsonObject ?: continue
            val field = problem["field"].text() ?: continue
            val code = problem["code"].text() ?: continue
            val params = readParams(problem["params"])
            // A translated message when the app's table has one; otherwise the server's own,
            // which for a validation problem says more than the code's general message.
            val message = if (table.containsKey(code)) {
                formatMessage(code, table, params)
            } else {
                problem["message"].text() ?: formatMessage(code, params = params)
            }
            problems.add(TulaFieldError(field, code, message, params))
        }
        return problems
    }

    /**
     * How long the server asked the client to wait: the `Retry-After` header (seconds or an
     * HTTP date), or the `retryAfter` param of the error when the header is not there.
     */
    private fun retryAfterMs(response: HttpResponse, params: Map<String, Any>): Long? {
        val header = response.headers["retry-after"]?.trim()
        if (header != null && SECONDS.matches(header)) {
            return header.toLong() * 1000
        }
        if (!header.isNullOrEmpty()) {
            try {
                val at = ZonedDateTime.parse(header, DateTimeFormatter.RFC_1123_DATE_TIME)
                return maxOf(0, at.toInstant().toEpochMilli() - clock.nowMs())
            } catch (_: java.time.DateTimeException) {
                // Not a date either: the error's own param, if it has one.
            }
        }
        return (params["retryAfter"] as? Number)?.let { (it.toDouble() * 1000).toLong() }
    }

    private companion object {
        /** Stands for a body that is not JSON, where `null` already means "no body". */
        val UNREADABLE: JsonElement = JsonPrimitive("\u0000unreadable")
    }
}

/** Write a request body from a generated type. */
internal fun <T> encode(strategy: SerializationStrategy<T>, value: T): String =
    TulaJson.encodeToString(strategy, value)

/** A JSON string's text; `null` for anything that is not a string. */
private fun JsonElement?.text(): String? =
    (this as? JsonPrimitive)?.takeIf { it.isString }?.content

/** An error's params: the entries that are a string, a number or a boolean. */
private fun readParams(value: JsonElement?): Map<String, Any> {
    val params = LinkedHashMap<String, Any>()
    for ((name, param) in (value as? JsonObject).orEmpty()) {
        val primitive = param as? JsonPrimitive ?: continue
        if (primitive is JsonNull) {
            continue
        }
        val read: Any? = if (primitive.isString) {
            primitive.content
        } else {
            primitive.booleanOrNull ?: primitive.longOrNull ?: primitive.doubleOrNull
        }
        if (read != null) {
            params[name] = read
        }
    }
    return params
}
