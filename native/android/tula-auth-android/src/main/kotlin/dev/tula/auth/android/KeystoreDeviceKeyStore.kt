package dev.tula.auth.android

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import dev.tula.auth.DeviceKey
import dev.tula.auth.DeviceKeyStore
import dev.tula.auth.DevicePublicKey
import dev.tula.auth.JcaDeviceKey
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec

private const val KEY_STORE = "AndroidKeyStore"

/** The alias of the device key in the Android Keystore, unless the app names another. */
const val DEFAULT_DEVICE_KEY_ALIAS: String = "dev.tula.auth.device"

/**
 * The device key of a bound session, in the Android Keystore.
 *
 * A P-256 key pair that signs and does nothing else. The Keystore gives no call that exports
 * a private key it made, so the key is non-exportable by the platform's API; the store asks
 * for StrongBox first and, where the device says it has none, makes the key in the Keystore's
 * default implementation. Which of the two a device used is not recorded, and the server is
 * told neither: binding proves a key signed, not where it lives.
 *
 * [existing] answers `null` only when the Keystore says it has no entry under the alias;
 * every other failure is thrown, because the client ends a session only for a key it knows
 * is gone. This store never throws `DeviceKeyUnusableException`: no Keystore exception is
 * documented to mean that a key that needs no user authentication can never be used again.
 * An app that decides so signs out and calls `TulaClient.removeDeviceKey()`.
 *
 * This class is compiled and linted, and was not run on a device or an emulator.
 *
 * @param alias The Keystore alias of the key.
 */
class KeystoreDeviceKeyStore(private val alias: String = DEFAULT_DEVICE_KEY_ALIAS) : DeviceKeyStore {
    private val lock = Any()

    private fun store(): KeyStore = KeyStore.getInstance(KEY_STORE).apply { load(null) }

    private fun found(): DeviceKey? {
        val store = store()
        if (!store.containsAlias(alias)) {
            return null
        }
        // An entry that is there and cannot be read is a failure, never "no key".
        val private = store.getKey(alias, null) as? PrivateKey
            ?: throw IllegalStateException("the device key's entry holds no private key")
        val public = store.getCertificate(alias)?.publicKey as? ECPublicKey
            ?: throw IllegalStateException("the device key's entry holds no P-256 public key")
        return OffMainThread(JcaDeviceKey(private, public))
    }

    private fun spec(strongBox: Boolean): KeyGenParameterSpec =
        KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN)
            .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
            .setDigests(KeyProperties.DIGEST_SHA256)
            .setIsStrongBoxBacked(strongBox)
            .build()

    private fun generate(strongBox: Boolean) {
        KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, KEY_STORE).run {
            initialize(spec(strongBox))
            generateKeyPair()
        }
    }

    override suspend fun existing(): DeviceKey? = withContext(Dispatchers.IO) { found() }

    override suspend fun create(): DeviceKey = withContext(Dispatchers.IO) {
        // Two calls at once make one key: the second finds the first's.
        synchronized(lock) {
            found() ?: run {
                try {
                    generate(strongBox = true)
                } catch (_: StrongBoxUnavailableException) {
                    generate(strongBox = false)
                }
                found() ?: throw IllegalStateException("the device key was made and is not there")
            }
        }
    }

    override suspend fun remove() {
        withContext(Dispatchers.IO) {
            synchronized(lock) { store().deleteEntry(alias) }
        }
    }

    override fun toString(): String = "KeystoreDeviceKeyStore"
}

/** A Keystore key whose signing, a call into another process, is kept off the caller's thread. */
private class OffMainThread(private val key: DeviceKey) : DeviceKey {
    override val publicKey: DevicePublicKey get() = key.publicKey

    override suspend fun sign(message: ByteArray): ByteArray = withContext(Dispatchers.IO) { key.sign(message) }

    override fun toString(): String = "KeystoreDeviceKey"
}
