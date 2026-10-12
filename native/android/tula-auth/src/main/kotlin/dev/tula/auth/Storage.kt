package dev.tula.auth

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.util.Base64
import java.util.concurrent.ConcurrentHashMap

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
     * @return The plaintext, or `null` when the value **can never be opened** on this device:
     *   the key that sealed it no longer exists, or the device's key is another one (a backup
     *   restored onto another phone, app data partly cleared).
     * @throws Exception for every other failure: a key store that could not be reached now
     *   may be reached later, and must not read as "no token".
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
 * A value that can never be opened ([ValueSealer.open] answers `null`) is removed and read as
 * "no token". Every other failure is thrown, and the client keeps the session.
 *
 * The sealer and the entries may block (a Keystore operation, a write to disk): every call
 * runs on `Dispatchers.IO`.
 */
class SealedTokenStorage(
    private val sealer: ValueSealer,
    private val entries: SealedEntries,
) : TokenStorage {
    override suspend fun get(key: String): String? = withContext(Dispatchers.IO) {
        val stored = entries.read(key) ?: return@withContext null
        val opened = sealer.open(Base64.getDecoder().decode(stored), key.toByteArray(Charsets.UTF_8))
        if (opened == null) {
            entries.delete(key)
            return@withContext null
        }
        opened.toString(Charsets.UTF_8)
    }

    override suspend fun set(key: String, value: String): Unit = withContext(Dispatchers.IO) {
        val sealed = sealer.seal(value.toByteArray(Charsets.UTF_8), key.toByteArray(Charsets.UTF_8))
        entries.write(key, Base64.getEncoder().encodeToString(sealed))
    }

    override suspend fun remove(key: String): Unit = withContext(Dispatchers.IO) {
        entries.delete(key)
    }
}
