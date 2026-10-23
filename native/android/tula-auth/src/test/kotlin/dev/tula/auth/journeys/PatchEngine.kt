package dev.tula.auth.journeys

import dev.tula.auth.HttpEngine
import dev.tula.auth.HttpRequest
import dev.tula.auth.HttpResponse
import dev.tula.auth.UrlConnectionEngine
import kotlinx.coroutines.future.await
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest as JdkRequest
import java.net.http.HttpResponse as JdkResponse
import java.time.Duration

/**
 * The engine the journeys use: [UrlConnectionEngine] for every method it can send, and the
 * JDK's own client for `PATCH`, which `HttpURLConnection` refuses (the member and organization
 * calls that change something are `PATCH` routes).
 *
 * This lives in the tests on purpose: `java.net.http` is not on Android, so the library
 * cannot use it. An app that calls those routes passes an [HttpEngine] that can send `PATCH`
 * (over OkHttp, say); the journeys show the client is right when the engine is.
 */
class PatchEngine : HttpEngine {
    private val urlConnection = UrlConnectionEngine()
    private val jdk: HttpClient = HttpClient.newBuilder().followRedirects(HttpClient.Redirect.NEVER).build()

    override suspend fun send(request: HttpRequest): HttpResponse {
        if (request.method != "PATCH") {
            return urlConnection.send(request)
        }
        val builder = JdkRequest.newBuilder(URI(request.url))
            .timeout(Duration.ofMillis(request.timeoutMs))
            .method("PATCH", JdkRequest.BodyPublishers.ofString(request.body ?: ""))
        for ((name, value) in request.headers) {
            builder.header(name, value)
        }
        val answer = jdk.sendAsync(builder.build(), JdkResponse.BodyHandlers.ofString()).await()
        val headers = answer.headers().map().mapNotNull { (name, values) ->
            values.lastOrNull()?.let { name.lowercase() to it }
        }.toMap()
        return HttpResponse(answer.statusCode(), headers, answer.body())
    }
}
