package dev.tula.auth.android

import android.content.Context
import android.content.SharedPreferences
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import dev.tula.auth.SealedEntries
import dev.tula.auth.SealedTokenStorage
import dev.tula.auth.TokenStorage
import dev.tula.auth.ValueSealer
import java.io.IOException
import java.security.GeneralSecurityException
import java.security.KeyStore
import javax.crypto.AEADBadTagException
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

private const val KEY_STORE = "AndroidKeyStore"
private const val TRANSFORMATION = "AES/GCM/NoPadding"
private const val TAG_BITS = 128
private const val FORMAT: Byte = 1

/** The Keystore alias of the key that seals the client's tokens, unless an app names another. */
const val DEFAULT_KEY_ALIAS: String = "dev.tula.auth.tokens"

/** The preferences file that holds the sealed tokens, unless an app names another. */
const val DEFAULT_PREFERENCES_NAME: String = "dev.tula.auth.tokens"

/**
 * The [TokenStorage] for a device: the refresh token sealed with an AES-256-GCM key that is
 * made in the Android Keystore and never leaves it, and only the sealed value written to the
 * app's private preferences.
 *
 * ```kotlin
 * val tula = TulaClient(
 *     publishableKey = "tula_pk_…",
 *     baseUrl = "https://auth.example.com",
 *     storage = KeystoreTokenStorage(applicationContext),
 * )
 * ```
 *
 * The key asks for no user authentication (a refresh in the background must work while the
 * device is locked) and is not exportable, so a backup of the preferences file holds a value
 * no other device can open: there it is read as "no token" and removed.
 *
 * @param context Any context; the application's is what is kept.
 * @param keyAlias The Keystore alias of the sealing key.
 * @param preferencesName The preferences file of the sealed values.
 */
class KeystoreTokenStorage(
    context: Context,
    keyAlias: String = DEFAULT_KEY_ALIAS,
    preferencesName: String = DEFAULT_PREFERENCES_NAME,
) : TokenStorage by SealedTokenStorage(
    AndroidKeystoreSealer(keyAlias),
    PreferenceEntries(
        context.applicationContext.getSharedPreferences(preferencesName, Context.MODE_PRIVATE),
    ),
)

/**
 * A [ValueSealer] over one AES-256-GCM key in the Android Keystore. A sealed value is
 * `version, nonce length, nonce, ciphertext and tag`; the context is the additional
 * authenticated data.
 *
 * @param alias The key's Keystore alias. The key is made at the first [seal].
 */
class AndroidKeystoreSealer(private val alias: String = DEFAULT_KEY_ALIAS) : ValueSealer {
    private val lock = Any()

    private fun store(): KeyStore = KeyStore.getInstance(KEY_STORE).apply { load(null) }

    private fun existingKey(): SecretKey? = store().getKey(alias, null) as? SecretKey

    private fun key(): SecretKey = synchronized(lock) {
        existingKey() ?: KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEY_STORE).run {
            init(
                KeyGenParameterSpec.Builder(
                    alias,
                    KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
                )
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setKeySize(256)
                    .build(),
            )
            generateKey()
        }
    }

    override fun seal(plaintext: ByteArray, context: ByteArray): ByteArray {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        // The Keystore picks the nonce: a key made there refuses a caller's own by default.
        cipher.init(Cipher.ENCRYPT_MODE, key())
        cipher.updateAAD(context)
        val sealed = cipher.doFinal(plaintext)
        val nonce = cipher.iv
        return byteArrayOf(FORMAT, nonce.size.toByte()) + nonce + sealed
    }

    override fun open(sealed: ByteArray, context: ByteArray): ByteArray? {
        if (sealed.size < 2 || sealed[0] != FORMAT) {
            throw GeneralSecurityException("not a value this sealer wrote")
        }
        val nonceLength = sealed[1].toInt()
        if (nonceLength <= 0 || sealed.size < 2 + nonceLength) {
            throw GeneralSecurityException("not a value this sealer wrote")
        }
        // No key: the value was sealed on another device or before the app's data was cleared.
        val key = existingKey() ?: return null
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(TAG_BITS, sealed, 2, nonceLength))
        cipher.updateAAD(context)
        return try {
            cipher.doFinal(sealed, 2 + nonceLength, sealed.size - 2 - nonceLength)
        } catch (_: AEADBadTagException) {
            // The device's key is not the one that sealed it, or the entry was moved or
            // altered: it can never be opened.
            null
        }
    }
}

/** [SealedEntries] over a private `SharedPreferences` file. It holds sealed values only. */
internal class PreferenceEntries(private val preferences: SharedPreferences) : SealedEntries {
    override fun read(key: String): String? = preferences.getString(key, null)

    override fun write(key: String, value: String) {
        // `commit`, not `apply`: the client has to know the token is on disk.
        if (!preferences.edit().putString(key, value).commit()) {
            throw IOException("the entry could not be saved")
        }
    }

    override fun delete(key: String) {
        if (!preferences.edit().remove(key).commit()) {
            throw IOException("the entry could not be removed")
        }
    }
}
