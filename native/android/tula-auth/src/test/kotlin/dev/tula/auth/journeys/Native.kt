package dev.tula.auth.journeys

import dev.tula.auth.BrowserSession
import dev.tula.auth.DeviceKey
import dev.tula.auth.DeviceKeyStore
import dev.tula.auth.DevicePublicKey
import dev.tula.auth.GoogleSheet
import dev.tula.auth.PasskeySheet
import dev.tula.auth.ProviderOutcome
import dev.tula.auth.ProviderRefusal
import dev.tula.auth.SheetFailure
import dev.tula.auth.SoftwareDeviceKeyStore
import dev.tula.auth.TulaSheetException
import dev.tula.auth.generated.PasskeyAssertionCredential
import dev.tula.auth.generated.PasskeyAssertionCredentialResponse
import dev.tula.auth.generated.PasskeyCreationOptions
import dev.tula.auth.generated.PasskeyRegistrationCredential
import dev.tula.auth.generated.PasskeyRegistrationCredentialResponse
import dev.tula.auth.generated.PasskeyRequestOptions
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import java.io.ByteArrayOutputStream
import java.net.URI
import java.net.URLDecoder
import java.net.URLEncoder
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.MessageDigest
import java.security.SecureRandom
import java.security.Signature
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.util.Base64
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

// What stands in for a phone in the journeys: an authenticator app, a passkey authenticator
// behind the client's sheet interface, a browser that visits the mock provider, and key
// stores. Software all of it: no test shows a sheet, opens a browser or asks a Keystore.

/** The redirect URLs of the journeys. */
const val LOOPBACK_REDIRECT = "http://localhost:5173/oauth/callback"
const val SCHEME_REDIRECT = "com.example.journeys:/oauth/callback"
const val APP_LINK = "https://app.example.com/oauth/callback"

/** The relying party of the journeys' passkeys, and the app the world registers. */
const val RELYING_PARTY = "localhost"
const val PACKAGE_NAME = "com.example.journeys"

/** The app's signing certificate, and one that is not registered. */
val FINGERPRINT: String = (1..32).joinToString(":") { "%02X".format(it) }
val OTHER_FINGERPRINT: String = (1..32).joinToString(":") { "%02X".format(it + 100) }

fun base64Url(bytes: ByteArray): String = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)

private fun sha256(bytes: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(bytes)

/** The origin Android writes into a passkey response for an app signed with [fingerprint]. */
fun androidOrigin(fingerprint: String = FINGERPRINT): String =
    "android:apk-key-hash:" + base64Url(fingerprint.split(':').map { it.toInt(16).toByte() }.toByteArray())

/** The RFC 7638 thumbprint of a device's public key: what `cnf.jkt` of a bound session holds. */
fun thumbprint(key: DevicePublicKey): String =
    base64Url(sha256("""{"crv":"P-256","kty":"EC","x":"${base64Url(key.x)}","y":"${base64Url(key.y)}"}""".toByteArray()))

/** The methods an access token says its session proved. */
fun amr(token: String?): Set<String> =
    (claims(token)["amr"] as? JsonArray)?.map { (it as JsonPrimitive).content }?.toSet().orEmpty()

fun isBackupCode(code: String): Boolean = Regex("^[a-z0-9]{5}-[a-z0-9]{5}$", RegexOption.IGNORE_CASE).matches(code)

/** A backup code of the right shape that is none of [codes]. */
fun unknownBackupCode(codes: List<String>): String = if ("zzzzz-zzzzz" in codes) "yyyyy-yyyyy" else "zzzzz-zzzzz"

/** An authenticator app: RFC 6238 with SHA-1, six digits and thirty seconds. */
object Totp {
    const val STEP_MS = 30_000L

    private fun key(secret: String): ByteArray {
        val alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
        val out = ByteArrayOutputStream()
        var bits = 0
        var value = 0
        for (char in secret.uppercase()) {
            val index = alphabet.indexOf(char)
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

    fun code(secret: String, atMs: Long, offset: Int = 0): String {
        val counter = atMs / STEP_MS + offset
        val message = ByteArray(8) { index -> (counter shr (8 * (7 - index))).toByte() }
        val mac = Mac.getInstance("HmacSHA1").apply { init(SecretKeySpec(key(secret), "HmacSHA1")) }.doFinal(message)
        val at = mac[19].toInt() and 0x0f
        val number = ((mac[at].toInt() and 0x7f) shl 24) or ((mac[at + 1].toInt() and 0xff) shl 16) or
            ((mac[at + 2].toInt() and 0xff) shl 8) or (mac[at + 3].toInt() and 0xff)
        return "%06d".format(number % 1_000_000)
    }
}

/** The code the authenticator app shows now, by the server's clock. */
fun World.totp(secret: String): String = Totp.code(secret, serverNow())

/** Six digits no nearby time step makes. */
fun World.wrongTotp(secret: String): String {
    val now = serverNow()
    val near = (-2..2).map { Totp.code(secret, now, it) }.toSet()
    return listOf("000000", "111111", "222222", "333333", "444444", "555555").first { it !in near }
}

/**
 * A software passkey authenticator: P-256 keys, attestation `none`, user verification always
 * said. It stands in for the platform; that a device writes these responses is not shown.
 */
class Authenticator {
    private class Held(val id: String, val rpId: String, val userHandle: String, val key: KeyPair)

    private val keys = CopyOnWriteArrayList<Held>()
    private val random = SecureRandom()

    private fun pair(): KeyPair =
        KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair()

    private fun bytes(count: Int) = ByteArray(count).also { random.nextBytes(it) }

    /** Hold a passkey no server knows: what an authenticator from elsewhere presents. */
    fun holdStray(rpId: String) {
        keys.add(Held(base64Url(bytes(32)), rpId, "c3RyYW5nZXI", pair()))
    }

    private fun clientData(type: String, challenge: String, origin: String): ByteArray = buildJsonObject {
        put("type", type)
        put("challenge", challenge)
        put("origin", origin)
        put("crossOrigin", false)
    }.toString().toByteArray()

    private fun cborBytes(bytes: ByteArray): ByteArray {
        val head = when {
            bytes.size < 24 -> byteArrayOf((0x40 + bytes.size).toByte())
            bytes.size < 256 -> byteArrayOf(0x58, bytes.size.toByte())
            else -> byteArrayOf(0x59, (bytes.size shr 8).toByte(), (bytes.size and 0xff).toByte())
        }
        return head + bytes
    }

    private fun cborText(text: String): ByteArray = byteArrayOf((0x60 + text.length).toByte()) + text.toByteArray()

    private fun coordinate(value: java.math.BigInteger): ByteArray {
        val raw = value.toByteArray()
        return ByteArray(32).also { out ->
            val from = maxOf(0, raw.size - 32)
            raw.copyInto(out, 32 - (raw.size - from), from, raw.size)
        }
    }

    fun create(options: PasskeyCreationOptions, origin: String): PasskeyRegistrationCredential {
        check(options.pubKeyCredParams.any { it.alg == -7L }) { "the passkey options do not offer ES256" }
        if (options.excludeCredentials.any { excluded -> keys.any { it.id == excluded.id } }) {
            throw TulaSheetException(SheetFailure.ALREADY_ON_DEVICE)
        }
        val key = pair()
        val credentialId = bytes(32)
        val id = base64Url(credentialId)
        keys.add(Held(id, options.rp.id, options.user.id, key))
        val point = (key.public as ECPublicKey).w
        val cose = byteArrayOf(0xa5.toByte(), 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21) +
            cborBytes(coordinate(point.affineX)) + byteArrayOf(0x22) + cborBytes(coordinate(point.affineY))
        val authData = sha256(options.rp.id.toByteArray()) + byteArrayOf(0x45, 0, 0, 0, 0) + ByteArray(16) +
            byteArrayOf((credentialId.size shr 8).toByte(), (credentialId.size and 0xff).toByte()) + credentialId + cose
        val attestation = byteArrayOf(0xa3.toByte()) + cborText("fmt") + cborText("none") + cborText("attStmt") +
            byteArrayOf(0xa0.toByte()) + cborText("authData") + cborBytes(authData)
        return PasskeyRegistrationCredential(
            id = id,
            rawId = id,
            response = PasskeyRegistrationCredentialResponse(
                clientDataJSON = base64Url(clientData("webauthn.create", options.challenge, origin)),
                attestationObject = base64Url(attestation),
                transports = listOf("internal"),
            ),
            type = "public-key",
        )
    }

    fun get(options: PasskeyRequestOptions, origin: String): PasskeyAssertionCredential {
        val allowed = options.allowCredentials?.map { it.id }
        val found = keys.lastOrNull { held -> allowed?.contains(held.id) ?: (held.rpId == options.rpId) }
            ?: throw IllegalStateException("this authenticator holds no credential the options accept")
        val client = clientData("webauthn.get", options.challenge, origin)
        val authData = sha256(options.rpId.toByteArray()) + byteArrayOf(0x05, 0, 0, 0, 0)
        val signature = Signature.getInstance("SHA256withECDSA").run {
            initSign(found.key.private)
            update(authData + sha256(client))
            sign()
        }
        return PasskeyAssertionCredential(
            id = found.id,
            rawId = found.id,
            response = PasskeyAssertionCredentialResponse(
                clientDataJSON = base64Url(client),
                authenticatorData = base64Url(authData),
                signature = base64Url(signature),
                userHandle = found.userHandle,
            ),
            type = "public-key",
        )
    }
}

/** The client's passkey sheet over a software [Authenticator], with the origin Android writes. */
class SoftwareSheet(
    @Volatile var authenticator: Authenticator = Authenticator(),
    @Volatile var origin: String = androidOrigin(),
) : PasskeySheet {
    /** The user closes the sheet. */
    @Volatile
    var dismisses = false

    /** Runs while the sheet is up, after the authenticator answered. */
    @Volatile
    var whileUp: (suspend () -> Unit)? = null

    /** Answer with this assertion, whatever was asked. */
    @Volatile
    var stale: PasskeyAssertionCredential? = null

    /** The last assertion the authenticator made. */
    @Volatile
    var last: PasskeyAssertionCredential? = null

    /** How often the sheet was shown. */
    val shown = AtomicInteger()

    private fun asked() {
        shown.incrementAndGet()
        if (dismisses) {
            throw TulaSheetException(SheetFailure.DISMISSED)
        }
    }

    override suspend fun create(options: PasskeyCreationOptions): PasskeyRegistrationCredential {
        asked()
        return authenticator.create(options, origin)
    }

    override suspend fun get(options: PasskeyRequestOptions): PasskeyAssertionCredential {
        asked()
        stale?.let { return it }
        val made = authenticator.get(options, origin)
        last = made
        whileUp?.invoke()
        return made
    }
}

/** A browser the journey scripts: what it was opened with, and what it comes back with. */
class ScriptedBrowser(@Volatile var script: suspend (url: String, redirectUrl: String) -> String? = { _, _ -> null }) :
    BrowserSession {
    /** Every pair it was opened with. */
    val opened = CopyOnWriteArrayList<Pair<String, String>>()

    override suspend fun open(url: String, redirectUrl: String): String? {
        opened.add(url to redirectUrl)
        return script(url, redirectUrl)
    }
}

/** Google's sheet, scripted. */
class ScriptedGoogle(@Volatile var script: suspend (nonce: String) -> String) : GoogleSheet {
    val nonces = CopyOnWriteArrayList<String>()

    override suspend fun idToken(nonce: String): String {
        nonces.add(nonce)
        return script(nonce)
    }
}

/** A key store the journey can take the key out of, as a restored backup or a cleared app does. */
class LosableKeyStore(private val inner: SoftwareDeviceKeyStore = SoftwareDeviceKeyStore()) : DeviceKeyStore {
    /** `existing()` answers this instead of the store's own, when set. */
    @Volatile
    var failing: (() -> DeviceKey?)? = null
    val looks = AtomicInteger()

    override suspend fun existing(): DeviceKey? {
        looks.incrementAndGet()
        failing?.let { return it() }
        return inner.existing()
    }

    override suspend fun create(): DeviceKey = inner.create()

    override suspend fun remove() = inner.remove()
}

private fun form(fields: Map<String, String>): String =
    fields.entries.joinToString("&") { (name, value) ->
        URLEncoder.encode(name, "UTF-8") + "=" + URLEncoder.encode(value, "UTF-8")
    }

/**
 * What a person does at the mock provider: consent, and follow the provider back to the API's
 * callback. No redirect is followed by itself, so each hop is seen.
 *
 * @return The address the API sends the browser to: the redirect URL with its fragment.
 */
fun World.atProvider(authorizationUrl: String, consent: Map<String, String>): String {
    val page = URI(authorizationUrl)
    if (!page.path.endsWith("/v1/dev/oauth/authorize")) {
        throw AssertionError("not the mock provider's page: ${page.path}")
    }
    val fields = LinkedHashMap<String, String>()
    for (pair in page.rawQuery.orEmpty().split('&').filter { it.isNotEmpty() }) {
        val cut = pair.indexOf('=')
        fields[URLDecoder.decode(pair.substring(0, cut), "UTF-8")] = URLDecoder.decode(pair.substring(cut + 1), "UTF-8")
    }
    fields.putAll(consent)
    val consented = World.raw(
        "POST",
        authorizationUrl.substringBefore('?'),
        mapOf("content-type" to "application/x-www-form-urlencoded"),
        form(fields),
        contentType = "application/x-www-form-urlencoded",
    )
    if (consented.status != 302) {
        throw AssertionError("the provider answered ${consented.status}: ${consented.body}")
    }
    val callback = consented.headers["location"] ?: throw AssertionError("the provider did not send the browser back")
    val answered = World.raw("GET", callback, emptyMap(), null)
    if (answered.status != 303 || answered.headers.containsKey("set-cookie")) {
        throw AssertionError("the callback answered ${answered.status}")
    }
    return answered.headers["location"].orEmpty()
}

/** Save a provider's credentials, as an operator does. */
fun World.provider(name: String, more: String = "") {
    val saved = admin(
        "PUT",
        "/v1/admin/oauth-providers/$name",
        """{"clientId":"journey-$name-client","clientSecret":"journey-$name-secret"$more}""",
    )
    World.expect(200, saved)
}

/** Register the journeys' Android app. @return Its id. */
fun World.registerApp(fingerprint: String = FINGERPRINT, more: String = ""): String {
    val made = admin(
        "POST",
        "/v1/admin/native-apps",
        """{"platform":"android","packageName":"$PACKAGE_NAME","sha256CertFingerprints":["$fingerprint"]$more}""",
    )
    World.expect(201, made)
    return made.json.jsonObject.text("id")
}

/** One word for an outcome, as the TypeScript journeys' results are named. */
val ProviderOutcome.word: String
    get() = when (this) {
        is ProviderOutcome.SignedIn -> "signed_in"
        is ProviderOutcome.NeedsStep -> "needs_step"
        is ProviderOutcome.Linked -> "linked"
        is ProviderOutcome.Cancelled -> "cancelled"
        is ProviderOutcome.Refused -> when (val refusal = refusal) {
            is ProviderRefusal.UnexpectedReturn -> "unexpected_return"
            is ProviderRefusal.NoAnswer -> "no_answer"
            is ProviderRefusal.NotStartedHere -> "not_started_here"
            is ProviderRefusal.Failed -> refusal.code
        }
    }

/** The flow of an outcome that has one. */
val ProviderOutcome.flow
    get() = when (this) {
        is ProviderOutcome.SignedIn -> flow
        is ProviderOutcome.NeedsStep -> flow
        else -> null
    }
