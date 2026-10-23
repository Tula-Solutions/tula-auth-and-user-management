package dev.tula.auth

import kotlinx.coroutines.suspendCancellableCoroutine
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URI
import java.net.URISyntaxException
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/**
 * One request of the client. It can hold a token, an attempt's secret and a password: an
 * engine sends it and keeps, logs and prints nothing of it. [toString] names the method and the
 * address only.
 */
class HttpRequest(
    /** The HTTP method, upper case. */
    val method: String,
    /** The absolute address. It never holds a token or a secret. */
    val url: String,
    /** The headers to send, by lower-case name. */
    val headers: Map<String, String>,
    /** The JSON body, or `null` for none. */
    val body: String?,
    /**
     * How long the client waits for this request, in milliseconds. The client enforces it
     * itself by cancelling the call; an engine may use it for its own socket timeouts.
     */
    val timeoutMs: Long,
) {
    override fun toString(): String = "HttpRequest($method $url)"
}

/**
 * The answer to one request. It can hold tokens: [toString] says the status only.
 */
class HttpResponse(
    /** The HTTP status. */
    val status: Int,
    /** The answer's headers, by **lower-case** name. */
    val headers: Map<String, String>,
    /** The body as text; empty for none. */
    val body: String,
) {
    override fun toString(): String = "HttpResponse($status)"
}

/**
 * How the client reaches the API. The default is [UrlConnectionEngine]; an app that already
 * has an HTTP stack (OkHttp, Ktor) adapts it in a few lines, and a test passes a fake.
 *
 * An engine sends exactly what it is given and follows **no redirect**: an answer of any
 * status is returned as it came. It never retries: the client decides the one request it
 * repeats.
 */
fun interface HttpEngine {
    /**
     * Send one request.
     *
     * @param request The request.
     * @return The answer, whatever its status.
     * @throws IOException when no answer came (no connection, a reset, a timeout of the
     *   engine's own). Anything an engine throws is taken to mean the same.
     */
    suspend fun send(request: HttpRequest): HttpResponse
}

/**
 * The default [HttpEngine]: `java.net.HttpURLConnection`, which the JVM and every Android
 * version have, so the client adds no HTTP dependency to an app.
 *
 * Each request runs on a thread of the engine's own pool and is given up (the connection is
 * closed) when the calling coroutine is cancelled, which is how the client's timeout ends it.
 * Redirects are not followed, nothing is cached and no cookie is kept.
 *
 * A desktop JVM's `HttpURLConnection` has no `PATCH`, so a `PATCH` request (renaming an
 * organization, giving a member another role, changing a domain's mode) goes through the JDK's
 * `java.net.http` client there; on Android it goes through `HttpURLConnection`, which accepts it.
 *
 * **It was tested on a desktop JVM only.** Android's `HttpURLConnection` is another
 * implementation, and the API refuses a sign-in and ends a session with a `401` that has no
 * `WWW-Authenticate` header: that Android hands over such an answer's status and body was
 * not tried on a device. An app that does not want to rest on it passes an [HttpEngine] of
 * its own (over OkHttp, for one).
 */
class UrlConnectionEngine : HttpEngine {
    private val threads: ExecutorService = Executors.newCachedThreadPool { task ->
        Thread(task, "tula-http-${NUMBER.incrementAndGet()}").apply { isDaemon = true }
    }

    /**
     * The engine that sends `PATCH`, found by name: [JdkHttpEngine] where `java.net.http`
     * exists (a JVM), `null` where it does not (Android), which sends it through
     * `HttpURLConnection`. Android's `HttpURLConnection` is OkHttp's, and its method list holds
     * `PATCH`: `HttpURLConnectionImpl.METHODS` in AOSP's `external/okhttp`
     * (`okhttp-urlconnection/src/main/java/com/squareup/okhttp/internal/huc/HttpURLConnectionImpl.java`,
     * branch `android14-release`: `Arrays.asList("OPTIONS", "GET", "HEAD", "POST", "PUT",
     * "DELETE", "TRACE", "PATCH")`). Nobody ran it on a device.
     */
    private val patching: HttpEngine? by lazy {
        try {
            Class.forName("dev.tula.auth.JdkHttpEngine").getDeclaredConstructor().newInstance() as? HttpEngine
        } catch (_: Throwable) {
            // Not there (Android), or not loadable: the connection below is the way.
            null
        }
    }

    override suspend fun send(request: HttpRequest): HttpResponse {
        if (request.method == "PATCH") {
            patching?.let { return it.send(request) }
        }
        val connection = try {
            URI(request.url).toURL().openConnection() as? HttpURLConnection
        } catch (_: IllegalArgumentException) {
            null
        } catch (_: URISyntaxException) {
            null
        } ?: throw IOException("not an http(s) address")
        return suspendCancellableCoroutine { continuation ->
            val running = threads.submit {
                try {
                    continuation.resume(exchange(connection, request))
                } catch (error: Exception) {
                    continuation.resumeWithException(error)
                } finally {
                    connection.disconnect()
                }
            }
            continuation.invokeOnCancellation {
                // Closing the socket is what ends a blocked read; an interrupt alone does not.
                connection.disconnect()
                running.cancel(true)
            }
        }
    }

    private fun exchange(connection: HttpURLConnection, request: HttpRequest): HttpResponse {
        val timeout = request.timeoutMs.coerceIn(1, Int.MAX_VALUE.toLong()).toInt()
        connection.requestMethod = request.method
        connection.instanceFollowRedirects = false
        connection.useCaches = false
        connection.connectTimeout = timeout
        connection.readTimeout = timeout
        for ((name, value) in request.headers) {
            connection.setRequestProperty(name, value)
        }
        val body = request.body
        if (body != null) {
            val bytes = body.toByteArray(Charsets.UTF_8)
            connection.doOutput = true
            // Not a streaming mode: with one, the JDK's connection throws away the body of
            // a 401 or a 407 (it cannot send a streamed body again with credentials), and
            // every refused sign-in and ended session is a 401 whose body holds the code.
            // The bodies are small, so holding one in memory costs nothing.
            connection.outputStream.use { it.write(bytes) }
        }
        val status = connection.responseCode
        val headers = HashMap<String, String>()
        for ((name, values) in connection.headerFields) {
            // The status line is the entry with no name.
            if (name != null && values.isNotEmpty()) {
                headers[name.lowercase()] = values.last()
            }
        }
        val stream = if (status >= 400) connection.errorStream else connection.inputStream
        val text = stream?.use(::readCapped) ?: ""
        return HttpResponse(status, headers, text)
    }

    private companion object {
        val NUMBER = AtomicInteger()
    }
}

/** The text of an answer's body, refused beyond [MAX_RESPONSE_BYTES]. */
internal fun readCapped(input: InputStream): String {
    // A loop of its own: `readNBytes(int)` is not on Android before API 33.
    val bytes = ByteArrayOutputStream()
    val chunk = ByteArray(8 * 1024)
    while (true) {
        val read = input.read(chunk)
        if (read < 0) {
            break
        }
        bytes.write(chunk, 0, read)
        if (bytes.size() > MAX_RESPONSE_BYTES) {
            throw IOException("the answer is too large")
        }
    }
    return bytes.toString("UTF-8")
}

/** The most of an answer that is read: 1 MiB. No answer of the client API is near this size. */
internal const val MAX_RESPONSE_BYTES = 1024 * 1024
