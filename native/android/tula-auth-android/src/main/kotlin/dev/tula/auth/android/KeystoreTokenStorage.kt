package dev.tula.auth.android

import android.content.Context
import android.content.SharedPreferences
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import dev.tula.auth.AesGcmSealer
import dev.tula.auth.SealedEntries
import dev.tula.auth.SealedTokenStorage
import dev.tula.auth.SealingKeys
import dev.tula.auth.TokenStorage
import dev.tula.auth.ValueSealer
import java.io.IOException
import java.security.KeyStore
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey

private const val KEY_STORE = "AndroidKeyStore"

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
 * no other device can open. Where the device has no key, such a value is read as "no token"
 * and removed. Where a key exists and the value's authentication tag fails, the storage
 * **throws**: the client reports `storage.failed`, keeps the session it has and deletes
 * nothing; the entry goes when the user signs out or signs in again.
 *
 * Android's Auto Backup and device transfer copy the preferences file unless the app
 * excludes it; `docs/kotlin.md` has the two rules to add, naming [DEFAULT_PREFERENCES_NAME].
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
 * A [ValueSealer] over one AES-256-GCM key in the Android Keystore: `AesGcmSealer`, which
 * decides what a value that does not open means, over [AndroidKeystoreKeys].
 *
 * @param alias The key's Keystore alias. The key is made at the first [seal].
 */
class AndroidKeystoreSealer(alias: String = DEFAULT_KEY_ALIAS) :
    ValueSealer by AesGcmSealer(AndroidKeystoreKeys(alias))

/**
 * The sealing key in the Android Keystore: AES-256-GCM, made there, not exportable, and
 * asking for no user authentication.
 *
 * @param alias The key's Keystore alias.
 */
class AndroidKeystoreKeys(private val alias: String = DEFAULT_KEY_ALIAS) : SealingKeys {
    private val lock = Any()

    private fun store(): KeyStore = KeyStore.getInstance(KEY_STORE).apply { load(null) }

    override fun existing(): SecretKey? = store().getKey(alias, null) as? SecretKey

    override fun obtain(): SecretKey = synchronized(lock) {
        existing() ?: KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEY_STORE).run {
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
