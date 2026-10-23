package dev.tula.auth

import java.io.IOException
import java.net.ProxySelector
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest as JdkRequest
import java.net.http.HttpResponse as JdkResponse
import java.time.Duration
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
 * It behaves as [UrlConnectionEngine] does: HTTP/1.1, no redirect followed, no cookie kept,
 * the system's proxy selector, the whole answer read up to the same cap, and an exception for
 * a request that got no answer.
 */
internal class JdkHttpEngine : HttpEngine {
    private val client: HttpClient = HttpClient.newBuilder()
        .version(HttpClient.Version.HTTP_1_1)
        .followRedirects(HttpClient.Redirect.NEVER)
        .proxy(ProxySelector.getDefault())
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
            throw IOException("not an http(s) address")
        }
        return suspendCancellableCoroutine { continuation ->
            val future = client.sendAsync(built, JdkResponse.BodyHandlers.ofInputStream())
            continuation.invokeOnCancellation { future.cancel(true) }
            future.whenComplete { answer, error ->
                if (error != null) {
                    continuation.resumeWithException(error as? IOException ?: IOException("the request failed"))
                    return@whenComplete
                }
                try {
                    val headers = HashMap<String, String>()
                    for ((name, values) in answer.headers().map()) {
                        if (values.isNotEmpty()) {
                            headers[name.lowercase()] = values.last()
                        }
                    }
                    continuation.resume(HttpResponse(answer.statusCode(), headers, answer.body().use(::readCapped)))
                } catch (error: IOException) {
                    continuation.resumeWithException(error)
                }
            }
        }
    }
}
