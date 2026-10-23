package dev.tula.auth

import java.io.IOException
import java.net.Proxy
import java.net.ProxySelector
import java.net.SocketAddress
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest as JdkRequest
import java.net.http.HttpResponse as JdkResponse
import java.io.InputStream
import java.time.Duration
import java.util.concurrent.atomic.AtomicReference
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.suspendCancellableCoroutine

/**
 * An [HttpEngine] over the JDK's `java.net.http.HttpClient` (Java 11), which [UrlConnectionEngine]
 * uses for `PATCH` on a JVM: `HttpURLConnection` there refuses the method ("Invalid HTTP
 * method: PATCH"), and renaming an organization, giving a member another role and changing a
 * domain's mode are `PATCH` routes.
 *
 * **Android has no `java.net.http`, and never loads this class**: [UrlConnectionEngine] finds
 * it by name at run time and, where it is missing, sends `PATCH` through `HttpURLConnection`,
 * whose Android implementation (OkHttp's) lists `PATCH` among its methods. The class is
 * reached by name only, so nothing that is compiled for Android refers to it.
 *
 * It is meant to behave as [UrlConnectionEngine] does: HTTP/1.1, no redirect followed, no cookie
 * kept, the system's default proxy selector (read per request), the whole answer read up to the
 * same cap, an exception for a request that got no answer, and the answer's stream closed when
 * the caller is cancelled. The request's timeout bounds the wait for the answer's headers only;
 * a body that stalls is ended by the caller's cancellation, which the client's own deadline is. It sends no proxy credentials: `Authenticator` is not consulted.
 */
internal class JdkHttpEngine : HttpEngine {
    private val client: HttpClient = HttpClient.newBuilder()
        .version(HttpClient.Version.HTTP_1_1)
        .followRedirects(HttpClient.Redirect.NEVER)
        .proxy(
            object : ProxySelector() {
                override fun select(uri: URI?): List<Proxy> =
                    ProxySelector.getDefault()?.select(uri) ?: listOf(Proxy.NO_PROXY)

                override fun connectFailed(uri: URI?, address: SocketAddress?, failure: IOException?) {
                    ProxySelector.getDefault()?.connectFailed(uri, address, failure)
                }
            },
        )
        .build()

    override suspend fun send(request: HttpRequest): HttpResponse {
        val timeout = Duration.ofMillis(request.timeoutMs.coerceAtLeast(1))
        val built = try {
            val body = request.body
            JdkRequest.newBuilder(URI(request.url))
                .timeout(timeout)
                .method(
                    request.method,
                    if (body == null) JdkRequest.BodyPublishers.noBody() else JdkRequest.BodyPublishers.ofString(body),
                )
                .also { builder -> request.headers.forEach { (name, value) -> builder.header(name, value) } }
                .build()
        } catch (_: IllegalArgumentException) {
            // An address that is not one, or a header the JDK client reserves (the client sends none).
            throw IOException("not an http(s) request")
        }
        return suspendCancellableCoroutine { continuation ->
            val future = client.sendAsync(built, JdkResponse.BodyHandlers.ofInputStream())
            val stream = AtomicReference<InputStream?>(null)
            continuation.invokeOnCancellation {
                future.cancel(true)
                // A body being read when the caller gives up: closing the stream ends the read.
                runCatching { stream.get()?.close() }
            }
            future.whenComplete { answer, error ->
                if (error != null) {
                    continuation.resumeWithException(error as? IOException ?: IOException("the request failed"))
                    return@whenComplete
                }
                try {
                    stream.set(answer.body())
                    if (!continuation.isActive) {
                        answer.body().close()
                        return@whenComplete
                    }
                    val headers = HashMap<String, String>()
                    for ((name, values) in answer.headers().map()) {
                        if (values.isNotEmpty()) {
                            headers[name.lowercase()] = values.last()
                        }
                    }
                    continuation.resume(HttpResponse(answer.statusCode(), headers, answer.body().use(::readCapped)))
                } catch (error: Throwable) {
                    continuation.resumeWithException(error as? IOException ?: IOException("the request failed"))
                }
            }
        }
    }
}
