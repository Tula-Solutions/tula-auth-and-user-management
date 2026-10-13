package dev.tula.auth

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import java.util.Base64
import java.util.concurrent.ConcurrentHashMap
import javax.crypto.Cipher
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Where the client keeps its refresh token between runs of the app.
 *
 * The refresh token is a long-lived credential. On a device, back this with the platform's
 * secure store: `KeystoreTokenStorage` of the `tula-auth-android` module. Never plain
 * `SharedPreferences`, a file or a database.
 *
 * A storage that fails **throws**; it never answers `null` for a read that could not be made.
 * `null` means "there is no token", and the client signs out on it. On a throw the client
 * reports `storage.failed` and keeps the session it has.
 */
interface TokenStorage {
    /**
     * @param key The entry's name.
     * @return The stored value, or `null` when there is none.
     */
    suspend fun get(key: String): String?

    /**
     * @param key The entry's name.
     * @param value The value to store.
     */
    suspend fun set(key: String, value: String)

    /** @param key The entry to delete. Deleting a missing entry is not an error. */
    suspend fun remove(key: String)
}

/**
 * A [TokenStorage] that keeps values in memory: the session lasts as long as the process. For
 * tests and for tools; an app on a device uses the Keystore-backed storage.
 */
class MemoryTokenStorage : TokenStorage {
    private val values = ConcurrentHashMap<String, String>()

    override suspend fun get(key: String): String? = values[key]

    override suspend fun set(key: String, value: String) {
        values[key] = value
    }

    override suspend fun remove(key: String) {
        values.remove(key)
    }
}

/**
 * Seals and opens a value with a key the device holds. The Android implementation is an
 * AES-256-GCM key in the Android Keystore; a test uses a key in memory.
 */
interface ValueSealer {
    /**
     * @param plaintext What to protect.
     * @param context Bound into the result: it opens only with the same context.
     * @return The sealed bytes.
     */
    fun seal(plaintext: ByteArray, context: ByteArray): ByteArray

    /**
     * @param sealed What [seal] returned.
     * @param context The context it was sealed with.
     * @return The plaintext, or `null` when the value **can never be opened** on this device,
     *   which is two cases and no third: the key that would open it does not exist (a backup
     *   restored onto another phone, the app's data partly cleared), or the bytes are not
     *   something this sealer wrote.
     * @throws Exception for every other failure, **a failed authentication tag while the key
     *   exists among them**: a key store that misbehaves now may answer later, and must not
     *   read as "no token".
     */
    fun open(sealed: ByteArray, context: ByteArray): ByteArray?
}

/** A plain key-value store that holds only what a [ValueSealer] sealed. */
interface SealedEntries {
    /** @return The entry, or `null` when there is none. */
    fun read(key: String): String?

    /** Write the entry, durably: return only once it is saved, and throw when it is not. */
    fun write(key: String, value: String)

    /** Delete the entry; a missing one is not an error. Throw when the delete failed. */
    fun delete(key: String)
}

/**
 * A [TokenStorage] that writes nothing but sealed values: what reaches [entries] is
 * `base64(seal(value))`, with the entry's name bound in, so a sealed token cannot be moved
 * under another name.
 *
 * A value that can never be opened ([ValueSealer.open] answers `null`: no key, or bytes the
 * sealer did not write; or the entry is not base64 and so not this storage's writing) is
 * removed and read as "no token". Every other failure is thrown, nothing is removed, and the
 * client keeps the session: a value whose authentication tag fails while the key exists is
 * one of those. Such an entry goes when the user signs out or signs in again: [remove] and
 * [set] never open what is stored.
 *
 * The sealer and the entries may block (a Keystore operation, a write to disk): every call
 * runs on `Dispatchers.IO`, **one at a time**: a read that removes an entry it could not
 * open is a read and then a removal, and a token written between the two would be removed
 * with it. Two storages over the same entries do not share the lock: one per file.
 */
class SealedTokenStorage(
    private val sealer: ValueSealer,
    private val entries: SealedEntries,
) : TokenStorage {
    private val oneAtATime = Mutex()

    private suspend fun <T> blocking(work: () -> T): T =
        oneAtATime.withLock { withContext(Dispatchers.IO) { work() } }

    override suspend fun get(key: String): String? = blocking {
        val stored = entries.read(key) ?: return@blocking null
        val sealed = try {
            Base64.getDecoder().decode(stored)
        } catch (_: IllegalArgumentException) {
            // Not something this storage wrote: it can never be opened.
            null
        }
        val opened = sealed?.let { sealer.open(it, key.toByteArray(Charsets.UTF_8)) }
        if (opened == null) {
            entries.delete(key)
            return@blocking null
        }
        opened.toString(Charsets.UTF_8)
    }

    override suspend fun set(key: String, value: String): Unit = blocking {
        val sealed = sealer.seal(value.toByteArray(Charsets.UTF_8), key.toByteArray(Charsets.UTF_8))
        entries.write(key, Base64.getEncoder().encodeToString(sealed))
    }

    override suspend fun remove(key: String): Unit = blocking {
        entries.delete(key)
    }
}

/** The one key an [AesGcmSealer] seals with, wherever it is kept. */
interface SealingKeys {
    /** @return The key, or `null` when none exists. It never makes one. */
    fun existing(): SecretKey?

    /** @return The key, made now when none exists. */
    fun obtain(): SecretKey

    /**
     * Remove the key, whatever state it is in, and make a new one. Called only where a value
     * is about to be sealed and the key could not be had ([AesGcmSealer.seal]): what was
     * sealed under the old key opens no more.
     *
     * @return The new key.
     */
    fun replace(): SecretKey
}

private const val TRANSFORMATION = "AES/GCM/NoPadding"
private const val TAG_BITS = 128
private const val FORMAT: Byte = 1

/** The nonce a provider makes for AES-GCM, and the only length the Android Keystore takes. */
private const val NONCE_BYTES = 12

/**
 * A [ValueSealer] over one AES-GCM key. A sealed value is `version, nonce length, nonce,
 * ciphertext and tag`; the context is the additional authenticated data.
 *
 * What [open] answers for a value it cannot open is decided here, for every key store:
 *
 * - bytes this sealer did not write (another format, another nonce length, cut short) and
 *   **no key** are `null`: the value can never be opened;
 * - **a tag that fails while the key exists is thrown** ([javax.crypto.AEADBadTagException]),
 *   like every other failure of the key store. A key store that answers wrongly once must
 *   not cost the user their session, and nothing here can tell that from an entry that was
 *   altered.
 *
 * **A key that cannot be had is replaced when a value is sealed, and never when one is
 * opened.** Sealing writes the only value kept under the key, so a key the store can no
 * longer load (or that no longer takes an encryption) is removed and made again
 * ([SealingKeys.replace]): otherwise no sign-in on the device could keep its session again.
 * Opening never replaces and never deletes: a store that fails now may answer later, and the
 * value it would open is a session. The cost of a replacement is the value sealed before it:
 * if the write that follows fails, that entry's tag fails until a later write or a sign-out.
 *
 * @param keys Where the key is: the Android Keystore on a device, memory in a test.
 */
class AesGcmSealer(private val keys: SealingKeys) : ValueSealer {
    override fun seal(plaintext: ByteArray, context: ByteArray): ByteArray {
        val cipher = try {
            encrypting(keys.obtain())
        } catch (_: Exception) {
            // The key cannot be loaded or used. A replacement that fails too is thrown.
            encrypting(keys.replace())
        }
        cipher.updateAAD(context)
        val sealed = cipher.doFinal(plaintext)
        val nonce = cipher.iv
        return byteArrayOf(FORMAT, nonce.size.toByte()) + nonce + sealed
    }

    private fun encrypting(key: SecretKey): Cipher =
        // The provider picks the nonce: a key made in the Android Keystore refuses a
        // caller's own by default.
        Cipher.getInstance(TRANSFORMATION).apply { init(Cipher.ENCRYPT_MODE, key) }

    override fun open(sealed: ByteArray, context: ByteArray): ByteArray? {
        // Not a value this sealer wrote: it can never be opened, so it is no token. Thrown,
        // it would be a storage that fails at every start.
        if (sealed.size < 2 || sealed[0] != FORMAT) {
            return null
        }
        val nonceLength = sealed[1].toInt()
        if (nonceLength != NONCE_BYTES || sealed.size < 2 + nonceLength + TAG_BITS / 8) {
            return null
        }
        // No key: the value was sealed on another device or before the app's data was cleared.
        val key = keys.existing() ?: return null
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(TAG_BITS, sealed, 2, nonceLength))
        cipher.updateAAD(context)
        // A failed tag is thrown, on purpose: see the class's own words.
        return cipher.doFinal(sealed, 2 + nonceLength, sealed.size - 2 - nonceLength)
    }
}
