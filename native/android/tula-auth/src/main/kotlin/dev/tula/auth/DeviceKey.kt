package dev.tula.auth

import dev.tula.auth.generated.TulaOperations
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.async
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.isActive
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject
import java.math.BigInteger
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.PrivateKey
import java.security.SecureRandom
import java.security.Signature
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.util.Base64

/** The length of a P-256 coordinate, and of each half of a signature, in bytes. */
private const val COORDINATE_BYTES = 32

/** The public half of a device key: a point of the curve P-256, and nothing else. */
class DevicePublicKey(x: ByteArray, y: ByteArray) {
    /** The point's x coordinate: 32 bytes. */
    val x: ByteArray = x.copyOf()
        get() = field.copyOf()

    /** The point's y coordinate: 32 bytes. */
    val y: ByteArray = y.copyOf()
        get() = field.copyOf()

    init {
        require(x.size == COORDINATE_BYTES && y.size == COORDINATE_BYTES) {
            "DevicePublicKey: a P-256 coordinate is 32 bytes"
        }
    }

    companion object {
        /**
         * The point of a JCA public key, as a Keystore or a key pair generator hands it out.
         *
         * @throws IllegalArgumentException for a key that is not on P-256.
         */
        fun of(key: ECPublicKey): DevicePublicKey {
            require(key.params.curve.field.fieldSize == COORDINATE_BYTES * 8) {
                "DevicePublicKey: the key is not a P-256 key"
            }
            return DevicePublicKey(fixed(key.w.affineX), fixed(key.w.affineY))
        }

        /** A coordinate as exactly 32 bytes: `BigInteger` adds a sign byte or drops leading zeros. */
        private fun fixed(value: BigInteger): ByteArray {
            val bytes = value.toByteArray().dropWhile { it == 0.toByte() }.toByteArray()
            require(bytes.size <= COORDINATE_BYTES) { "DevicePublicKey: the key is not a P-256 key" }
            return ByteArray(COORDINATE_BYTES - bytes.size) + bytes
        }
    }
}

/**
 * A key a session can be bound to (ADR 0043): its public half, and a way to sign with the
 * private half that never hands the private half out.
 */
interface DeviceKey {
    /** The public key, sent in every proof's header. */
    val publicKey: DevicePublicKey

    /**
     * Sign with ECDSA over P-256 and SHA-256.
     *
     * @param message The bytes to sign (a proof's `header.payload`).
     * @return The signature as `r` then `s`, 32 bytes each (64 bytes): JOSE's form, not the
     *   DER a JCA `Signature` writes ([EcdsaSignatures.derToRaw] converts).
     */
    suspend fun sign(message: ByteArray): ByteArray
}

/**
 * Where the client's device key is kept.
 *
 * **"There is no key" and "the key could not be had" are different answers, and the client
 * acts on the difference.** [existing] returns `null` only when the store knows there is no
 * key: a bound session whose key is gone is over, and the client ends it. It throws when it
 * cannot tell (a locked device, a store that failed): the client reports `device.key_failed`
 * and keeps the session, because the same call may work a moment later. Never answer `null`
 * for a failure, and never throw for a key that is simply not there.
 */
interface DeviceKeyStore {
    /**
     * The key of this app on this device, or `null` when there is none.
     *
     * @throws Exception when the store cannot say whether there is a key, or cannot hand it
     *   out; [DeviceKeyUnusableException] when it knows the key will never be had again.
     */
    suspend fun existing(): DeviceKey?

    /**
     * Make the key and keep it. Called only after [existing] answered `null`; a store that
     * finds a key was made meanwhile returns that one.
     *
     * **It may be called while an earlier call is still out.** The client asks one thing at a
     * time, but a removal drops the calls from before it, and a call that does not end when
     * it is cancelled can still be running when the next one starts. A store must tolerate
     * two at once and end with one key.
     */
    suspend fun create(): DeviceKey

    /**
     * Remove what is kept of the key; nothing there is not an error.
     *
     * The client calls it by itself in one case: at a sign-out, when [existing] threw
     * [DeviceKeyUnusableException]. For every other failure it is **not** called: the failure
     * may pass, and two clients that share one store share its key. An app that knows better
     * than the store removes the key itself, after a sign-out, **through
     * [TulaClient.removeDeviceKey]**, which calls this and tells the client.
     */
    suspend fun remove()
}

/**
 * What a device key store throws from [DeviceKeyStore.existing] for a key it **knows** will
 * never be handed out again. It is the one failure the client acts on by itself: at a
 * sign-out it removes what such a store keeps. A store throws it only for what cannot pass:
 * never for a locked device, a cancellation, a deadline or an answer it does not know.
 */
class DeviceKeyUnusableException : Exception("the device key can never be had again")

/** The two forms of an ECDSA signature over P-256. */
object EcdsaSignatures {
    /**
     * The JOSE form (`r` then `s`, 32 bytes each) of the DER signature a JCA `Signature` of
     * `SHA256withECDSA` writes.
     *
     * @throws IllegalArgumentException for bytes that are not such a signature.
     */
    fun derToRaw(der: ByteArray): ByteArray {
        var at = 0
        fun byte(): Int {
            require(at < der.size) { MALFORMED }
            return der[at++].toInt() and 0xff
        }
        fun length(): Int {
            val first = byte()
            if (first < 0x80) {
                return first
            }
            // Two integers of at most 33 bytes need one length byte more, never two.
            require(first == 0x81) { MALFORMED }
            return byte()
        }
        fun integer(): ByteArray {
            require(byte() == 0x02) { MALFORMED }
            val size = length()
            require(size > 0 && at + size <= der.size) { MALFORMED }
            val bytes = der.copyOfRange(at, at + size).dropWhile { it == 0.toByte() }.toByteArray()
            at += size
            require(bytes.size <= COORDINATE_BYTES) { MALFORMED }
            return ByteArray(COORDINATE_BYTES - bytes.size) + bytes
        }
        require(byte() == 0x30) { MALFORMED }
        require(length() == der.size - at) { MALFORMED }
        val r = integer()
        val s = integer()
        require(at == der.size) { MALFORMED }
        return r + s
    }

    private const val MALFORMED = "EcdsaSignatures: not a DER signature of a P-256 key"
}

/**
 * A [DeviceKey] over a JCA private key: it signs with `SHA256withECDSA` and hands the
 * signature out in JOSE's form. The private key is whatever the provider made it: a handle
 * into the Android Keystore that never leaves it, or a key in this process's memory.
 *
 * It prints as its type's name.
 */
class JcaDeviceKey(private val privateKey: PrivateKey, public: ECPublicKey) : DeviceKey {
    override val publicKey: DevicePublicKey = DevicePublicKey.of(public)

    override suspend fun sign(message: ByteArray): ByteArray {
        val signature = Signature.getInstance("SHA256withECDSA")
        signature.initSign(privateKey)
        signature.update(message)
        return EcdsaSignatures.derToRaw(signature.sign())
    }

    override fun toString(): String = "JcaDeviceKey"
}

/**
 * A device key store whose key is in this process's memory: for tests and for a JVM that
 * has no key store. **Not for a device**: the key is software, is gone when the process
 * ends, and a session bound to it ends then too. On Android an app passes the Android
 * module's `KeystoreDeviceKeyStore`.
 */
class SoftwareDeviceKeyStore : DeviceKeyStore {
    private val lock = Any()
    private var pair: KeyPair? = null

    private fun key(of: KeyPair): DeviceKey = JcaDeviceKey(of.private, of.public as ECPublicKey)

    override suspend fun existing(): DeviceKey? = synchronized(lock) { pair }?.let(::key)

    override suspend fun create(): DeviceKey = key(
        synchronized(lock) {
            pair ?: KeyPairGenerator.getInstance("EC").run {
                initialize(ECGenParameterSpec("secp256r1"))
                generateKeyPair().also { pair = it }
            }
        },
    )

    override suspend fun remove() {
        synchronized(lock) { pair = null }
    }

    override fun toString(): String = "SoftwareDeviceKeyStore"
}

internal fun base64Url(bytes: ByteArray): String = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)

/**
 * The proofs of a client (RFC 9449, ADR 0043): which requests carry one, the key that signs
 * them and the server's newest nonce.
 *
 * The nonce is held here, in memory, and nowhere else. A proof is made for one request and
 * never kept. Every call of the store is inside a deadline its caller gives, and the store is
 * asked one thing at a time.
 */
internal class DeviceProofs(
    private val store: DeviceKeyStore,
    private val scope: CoroutineScope,
    private val messages: () -> Messages,
) {
    /** What a request needs a key for. */
    enum class Use {
        /** The start of an attempt: its session is bound to the key, made when there is none. */
        START,

        /** The refresh of a session: only a key that exists can prove it. */
        REFRESH,
    }

    /** What the store says of the key after the server refused a proof. */
    enum class Verdict {
        /** The store has the key: the refusal was about the proof. */
        THERE,

        /** The store said twice that there is no key: the session cannot be refreshed again. */
        GONE,

        /** The store could not say whether there is a key. */
        UNSURE,

        /** The store said "no key" once and then something else: it is believed neither way. */
        CONTRADICTED,
    }

    /** The server's newest nonce. */
    @Volatile
    var nonce: String? = null

    private val looking = Flight<DeviceKey?>()
    private val making = Flight<DeviceKey>()
    private val random = SecureRandom()

    private fun failed(): TulaError = clientError(ClientErrorCodes.DEVICE_KEY_FAILED, messages())

    private fun timedOut(): TulaError = clientError(ClientErrorCodes.NETWORK_TIMEOUT, messages())

    /**
     * One call of the store at a time, shared by everyone who asks while it is out.
     *
     * A waiter ends at its own deadline and the call goes on for the others, so a store that
     * never answers is asked once, not once more for every refresh that gives up. [drop]
     * ends every waiter and lets the call's answer fall: the next caller starts a new call.
     */
    private inner class Flight<T> {
        private val lock = Any()
        private var running: Deferred<T>? = null

        suspend fun value(limitMs: Long, work: suspend () -> T): Answered<T>? {
            if (limitMs <= 0) {
                return null
            }
            val flight = synchronized(lock) {
                running ?: scope.async(start = CoroutineStart.LAZY) { work() }.also { running = it }
            }
            flight.invokeOnCompletion { synchronized(lock) { if (running === flight) running = null } }
            flight.start()
            return withTimeoutOrNull(limitMs) { Answered(flight.await()) }
        }

        fun drop() {
            synchronized(lock) { running.also { running = null } }?.cancel()
        }
    }

    /** A look or a making, with every failure but the caller's own cancellation told apart. */
    private suspend fun <T> asked(flight: Flight<T>, limitMs: Long, work: suspend () -> T): T {
        val answered = try {
            flight.value(limitMs, work)
        } catch (cause: CancellationException) {
            if (!currentCoroutineContext().isActive) {
                throw cause
            }
            // Dropped by a removal, or the store cancelled itself: nothing to prove with.
            throw failed()
        }
        return (answered ?: throw timedOut()).value
    }

    /**
     * The key a request is proven with; `null` for a refresh when there is no key.
     *
     * @throws TulaError `device.key_failed` when the store could not hand one out (what it
     *   threw is dropped), `network.timeout` when it did not answer inside [limitMs].
     */
    suspend fun key(use: Use, limitMs: Long): DeviceKey? {
        val started = System.nanoTime()
        try {
            asked(looking, limitMs) { store.existing() }?.let { return it }
            if (use == Use.REFRESH) {
                return null
            }
            // A making that answers after its caller gave up still made a key, with nothing
            // sent: the next start finds it.
            return asked(making, limitMs - (System.nanoTime() - started) / 1_000_000) { store.create() }
        } catch (error: TulaError) {
            throw error
        } catch (cause: CancellationException) {
            throw cause
        } catch (_: Exception) {
            throw failed()
        }
    }

    private enum class Look { FOUND, NONE, UNKNOWN }

    private suspend fun look(limitMs: Long): Look =
        try {
            if (asked(looking, limitMs) { store.existing() } == null) Look.NONE else Look.FOUND
        } catch (cause: CancellationException) {
            throw cause
        } catch (_: Exception) {
            Look.UNKNOWN
        }

    /**
     * Ask the store whether the key is gone, **twice**: ending a session cannot be undone,
     * and one "no key" is not enough to do it on. Only two looks that both say "no key" are
     * [Verdict.GONE]. This narrows the case and does not close it: a store that is wrong
     * twice in a row still ends the session.
     *
     * Each look has half of [withinMs]; a look that does not answer in time could not tell.
     */
    suspend fun verdict(withinMs: Long): Verdict {
        when (look(withinMs / 2)) {
            Look.FOUND -> return Verdict.THERE
            Look.UNKNOWN -> return Verdict.UNSURE
            Look.NONE -> Unit
        }
        return if (look(withinMs / 2) == Look.NONE) Verdict.GONE else Verdict.CONTRADICTED
    }

    private fun forgetFlights() {
        looking.drop()
        making.drop()
    }

    /**
     * Remove what the store keeps of the key, inside [withinMs], and forget a look or a
     * making that is still out: its answer would be the key that was just removed.
     *
     * **A removal the store refused forgets nothing; one whose outcome is not known (no
     * answer in time, the caller cancelled) forgets as one that succeeded does**: the store's
     * call may still remove the key afterwards.
     *
     * @throws TulaError `network.timeout` when the store did not answer in time,
     *   `device.key_failed` when it refused. What the store threw is dropped.
     */
    suspend fun remove(withinMs: Long) {
        val answered = try {
            bounded(scope, withinMs) { store.remove() }
        } catch (cause: CancellationException) {
            forgetFlights()
            if (!currentCoroutineContext().isActive) {
                throw cause
            }
            throw failed()
        } catch (_: Exception) {
            throw failed()
        }
        forgetFlights()
        if (answered == null) {
            throw timedOut()
        }
    }

    /**
     * At a sign-out: when the store says its key will **never** be had again
     * ([DeviceKeyUnusableException], the store's own word), remove what it keeps, so that the
     * next sign-in makes a new key instead of failing on the old one for ever. Everything
     * else leaves the store alone: such a failure may pass, and the store may be shared with
     * a client whose session is bound to the key. Best effort: a removal that fails is left
     * at that.
     */
    suspend fun dropUnusableKey(withinMs: Long) {
        try {
            looking.value(withinMs) { store.existing() }
        } catch (_: DeviceKeyUnusableException) {
            try {
                remove(withinMs)
            } catch (_: TulaError) {
                // The next sign-out tries again.
            }
        } catch (cause: CancellationException) {
            if (!currentCoroutineContext().isActive) {
                throw cause
            }
        } catch (_: Exception) {
            // Could not tell: the store is left alone.
        }
    }

    /**
     * A proof for one request: a JWT of type `dpop+jwt` signed by the key, with the key's
     * public half in its header and the request's method, the API's address, the time, a
     * unique id and the server's nonce as its claims.
     *
     * @throws TulaError `device.key_failed` when the key did not sign, `network.timeout`
     *   when it did not answer inside [limitMs].
     */
    suspend fun proof(key: DeviceKey, method: String, url: String, nowMs: Long, limitMs: Long): String {
        val id = ByteArray(16).also(random::nextBytes)
        val held = nonce
        val point = key.publicKey
        // The header's `jwk` is a public P-256 key and nothing else: the server refuses a
        // `kid`, a `d` or any other member.
        val header = buildJsonObject {
            put("typ", "dpop+jwt")
            put("alg", "ES256")
            putJsonObject("jwk") {
                put("kty", "EC")
                put("crv", "P-256")
                put("x", base64Url(point.x))
                put("y", base64Url(point.y))
            }
        }
        val claims = buildJsonObject {
            put("htm", method)
            put("htu", url)
            put("iat", nowMs / 1000)
            put("jti", base64Url(id))
            if (held != null) {
                put("nonce", held)
            }
        }
        val signed = base64Url(header.toString().toByteArray(Charsets.UTF_8)) + "." +
            base64Url(claims.toString().toByteArray(Charsets.UTF_8))
        val signature = try {
            bounded(scope, limitMs) { key.sign(signed.toByteArray(Charsets.UTF_8)) }
        } catch (cause: CancellationException) {
            if (!currentCoroutineContext().isActive) {
                throw cause
            }
            throw failed()
        } catch (_: Exception) {
            throw failed()
        } ?: throw timedOut()
        if (signature.value.size != COORDINATE_BYTES * 2) {
            throw failed()
        }
        return signed + "." + base64Url(signature.value)
    }

    companion object {
        /**
         * The requests a device key proves: the six that start an attempt and the refresh of
         * a session. A closed set, as `@tula/core`'s `PROVEN`; the server reads a proof
         * nowhere else.
         */
        val PROVEN: Map<String, Use> = mapOf(
            TulaOperations.startSignUp.id to Use.START,
            TulaOperations.startSignIn.id to Use.START,
            TulaOperations.startPasswordReset.id to Use.START,
            TulaOperations.startPasskeySignIn.id to Use.START,
            TulaOperations.startOAuthSignIn.id to Use.START,
            TulaOperations.startIdTokenSignIn.id to Use.START,
            TulaOperations.refreshSession.id to Use.REFRESH,
        )

        /** The request header a proof travels in. */
        const val HEADER = "dpop"

        /** The response header a nonce comes in, lower case as the engine hands headers over. */
        const val NONCE_HEADER = "dpop-nonce"
    }
}
