package dev.tula.example.compose

import androidx.test.platform.app.InstrumentationRegistry
import dev.tula.auth.MemoryTokenStorage
import dev.tula.auth.TulaClient
import dev.tula.auth.generated.FlowStep
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URI
import java.net.URLEncoder
import java.util.UUID
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/** An authenticator app: RFC 6238 with SHA-1, six digits and thirty seconds. */
private object Totp {
    private const val STEP_MS = 30_000L
    private const val ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"

    private fun key(secret: String): ByteArray {
        val out = java.io.ByteArrayOutputStream()
        var bits = 0
        var value = 0
        for (char in secret.uppercase()) {
            val index = ALPHABET.indexOf(char)
            if (index < 0) {
                continue
            }
            value = (value shl 5) or index
            bits += 5
            if (bits >= 8) {
                out.write((value shr (bits - 8)) and 0xff)
                bits -= 8
            }
        }
        return out.toByteArray()
    }

    fun code(secret: String, atMs: Long): String {
        val counter = atMs / STEP_MS
        val message = ByteArray(8) { index -> (counter shr (8 * (7 - index))).toByte() }
        val mac = Mac.getInstance("HmacSHA1").apply { init(SecretKeySpec(key(secret), "HmacSHA1")) }.doFinal(message)
        val at = mac[19].toInt() and 0x0f
        val number = ((mac[at].toInt() and 0x7f) shl 24) or ((mac[at + 1].toInt() and 0xff) shl 16) or
            ((mac[at + 2].toInt() and 0xff) shl 8) or (mac[at + 3].toInt() and 0xff)
        return "%06d".format(java.util.Locale.ROOT, number % 1_000_000)
    }
}

/**
 * One environment of the real API, made for one test by the fixture
 * (`e2e/kotlin-fixture.ts`, started by `native/android/fixture/ui-tests.ts`).
 *
 * The fixture listens on the machine's loopback address; the runner forwards that port into
 * the device (`adb reverse`), so the address is the same `http://127.0.0.1:<port>` here as
 * there, which is what the fixture's test routes insist on.
 */
class World private constructor(private val origin: String, private val id: String, val publishableKey: String) {
    /** The API's address for this world's environment. */
    val apiUrl: String = "$origin/w/$id"

    /** An address nobody else in the run has. */
    fun address(): String = "maya-${UUID.randomUUID().toString().take(8)}@example.com"

    private fun test(method: String, route: String, body: String? = null): Pair<Int, String> =
        request(method, "$origin/__test/worlds/$id$route", body)

    /** The code of the newest email to [email] whose subject leads with one, waited for. */
    fun code(email: String, not: String? = null): String {
        val deadline = System.currentTimeMillis() + WAIT_MS
        while (true) {
            val (status, body) = test("GET", "/outbox?to=" + URLEncoder.encode(email, "UTF-8"))
            check(status == 200) { "the outbox answered $status" }
            val emails = JSONArray(body)
            val codes = (0 until emails.length()).mapNotNull {
                CODE_SUBJECT.find(emails.getJSONObject(it).getString("subject"))?.groupValues?.get(1)
            }
            val newest = codes.lastOrNull()
            if (newest != null && newest != not) {
                return newest
            }
            check(System.currentTimeMillis() < deadline) { "no email with a code was sent to the address" }
            Thread.sleep(POLL_MS)
        }
    }

    /** Replace the environment's settings with what [change] makes of them (the admin call is relayed). */
    fun settings(change: (JSONObject) -> Unit) {
        val read = admin("GET", "/v1/admin/settings", null, emptyMap())
        check(read.getInt("status") == 200) { "the settings could not be read" }
        val settings = JSONObject(read.getString("body")).getJSONObject("settings")
        change(settings)
        val etag = read.getJSONObject("headers").getString("etag")
        val saved = admin("PUT", "/v1/admin/settings", settings.toString(), mapOf("if-match" to etag))
        check(saved.getInt("status") == 200) { "the settings were refused: ${saved.getInt("status")}" }
    }

    private fun admin(method: String, path: String, body: String?, headers: Map<String, String>): JSONObject {
        val asked = JSONObject().put("method", method).put("path", path).put("headers", JSONObject(headers))
        if (body != null) {
            asked.put("body", body)
        }
        val (status, answer) = test("POST", "/admin", asked.toString())
        check(status == 200) { "the admin relay answered $status" }
        return JSONObject(answer)
    }

    /**
     * An account with a verified address and a password, made as an app would make one: a
     * sign-up through the client, with the emailed code. Nobody is left signed in.
     */
    fun account(email: String, password: String) {
        runBlocking {
            TulaClient(publishableKey, apiUrl, MemoryTokenStorage()).use { client ->
                val flow = client.signUp(email, password)
                if (flow.step is FlowStep.NeedsEmailVerification) {
                    flow.verifyEmail(code(email))
                }
                check(flow.step is FlowStep.Complete) { "the sign-up stopped at ${flow.step.status}" }
                client.session.signOut()
            }
        }
        // The sign-up was emailed a code a moment ago, and the server sends an address its
        // next one only after a wait. The account is not new in what the test is about: the
        // server's clock is moved past the wait, as a journey does.
        advance(SETTLED_MS)
    }

    /** What an operator does through the admin API (the call is relayed; the key stays in the fixture). */
    fun operator(method: String, path: String, body: String, expected: Int) {
        val answer = admin(method, path, body, emptyMap())
        check(answer.getInt("status") == expected) { "the admin API answered ${answer.getInt("status")} for $method $path" }
    }

    /** The time the server thinks it is: its clock is fixed, and moved only by [advance]. */
    fun serverNow(): Long {
        val (status, body) = test("GET", "/now")
        check(status == 200) { "the fixture's clock could not be read: $status" }
        return JSONObject(body).getLong("now")
    }

    /** The code an authenticator app with [secret] shows now, by the server's clock. */
    fun totp(secret: String): String = Totp.code(secret, serverNow())

    /**
     * An account whose second step is an authenticator app, made as an app would: a sign-up, then
     * the enrolment through the client. Nobody is left signed in.
     *
     * @return The authenticator's setup key and the account's backup codes.
     */
    fun accountWithAuthenticator(email: String, password: String): Pair<String, List<String>> {
        account(email, password)
        val made = runBlocking {
            TulaClient(publishableKey, apiUrl, MemoryTokenStorage()).use { client ->
                val flow = client.signIn(email)
                flow.submitPassword(password)
                check(flow.step is FlowStep.Complete) { "the sign-in stopped at ${flow.step.status}" }
                val secret = client.factors.startTotp().secret
                val codes = client.factors.confirmTotp(totp(secret))
                client.session.signOut()
                secret to codes
            }
        }
        // An authenticator's code is taken once: the one that confirmed the enrolment is of this
        // half minute, so the server's clock is moved to a later one.
        advance(SETTLED_MS)
        return made
    }

    /** A second place the account is signed in: a client of its own, left signed in. */
    fun signedInElsewhere(email: String, password: String) {
        runBlocking {
            val client = TulaClient(publishableKey, apiUrl, MemoryTokenStorage())
            val flow = client.signIn(email)
            flow.submitPassword(password)
            check(flow.step is FlowStep.Complete) { "the sign-in stopped at ${flow.step.status}" }
            // Closed without a sign-out: the session lives on at the server.
            client.close()
        }
    }

    /** Move the server's clock forward (the fixture's own; the device's is not touched). */
    fun advance(ms: Long) {
        val (status, _) = test("POST", "/advance", """{"ms":$ms}""")
        check(status == 200) { "the fixture's clock was not moved: $status" }
    }

    /** Give the world back. */
    fun close() {
        request("DELETE", "$origin/__test/worlds/$id", null)
    }

    /** Makes a world. */
    companion object {
        private const val WAIT_MS = 15_000L
        private const val POLL_MS = 150L
        private const val SETTLED_MS = 2 * 60_000L
        private const val TIMEOUT_MS = 10_000
        private val CODE_SUBJECT = Regex("""^(\d{6})\b""")

        /** A new environment of the fixture the runner started. */
        fun create(): World {
            val origin = InstrumentationRegistry.getArguments().getString("tulaFixtureUrl")
            check(!origin.isNullOrEmpty()) {
                "These tests run against the real API: start them with " +
                    "`bun run native/android/fixture/ui-tests.ts`, which starts it and says where it is."
            }
            val (status, body) = request("POST", "$origin/__test/worlds", "{}")
            check(status == 201) { "the fixture made no world: $status" }
            val made = JSONObject(body)
            return World(origin, made.getString("id"), made.getString("publishableKey"))
        }

        private fun request(method: String, url: String, body: String?): Pair<Int, String> {
            val connection = URI(url).toURL().openConnection() as HttpURLConnection
            try {
                connection.requestMethod = method
                connection.connectTimeout = TIMEOUT_MS
                connection.readTimeout = TIMEOUT_MS
                if (body != null) {
                    connection.doOutput = true
                    connection.setRequestProperty("content-type", "application/json")
                    connection.outputStream.use { it.write(body.toByteArray()) }
                }
                val status = connection.responseCode
                val stream = if (status >= 400) connection.errorStream else connection.inputStream
                return status to (stream?.bufferedReader()?.use { it.readText() } ?: "")
            } finally {
                connection.disconnect()
            }
        }
    }
}
