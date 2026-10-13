package dev.tula.auth.android

import android.app.Activity
import androidx.credentials.CreatePublicKeyCredentialRequest
import androidx.credentials.CreatePublicKeyCredentialResponse
import androidx.credentials.CredentialManager
import androidx.credentials.CustomCredential
import androidx.credentials.GetCredentialRequest
import androidx.credentials.GetPublicKeyCredentialOption
import androidx.credentials.PublicKeyCredential
import androidx.credentials.exceptions.CreateCredentialCancellationException
import androidx.credentials.exceptions.CreateCredentialException
import androidx.credentials.exceptions.CreateCredentialProviderConfigurationException
import androidx.credentials.exceptions.CreateCredentialUnsupportedException
import androidx.credentials.exceptions.GetCredentialCancellationException
import androidx.credentials.exceptions.GetCredentialException
import androidx.credentials.exceptions.GetCredentialProviderConfigurationException
import androidx.credentials.exceptions.GetCredentialUnsupportedException
import androidx.credentials.exceptions.domerrors.InvalidStateError
import androidx.credentials.exceptions.domerrors.NotAllowedError
import androidx.credentials.exceptions.publickeycredential.CreatePublicKeyCredentialDomException
import androidx.credentials.exceptions.publickeycredential.GetPublicKeyCredentialDomException
import com.google.android.libraries.identity.googleid.GetGoogleIdOption
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential
import dev.tula.auth.CredentialFailureKind
import dev.tula.auth.GoogleSheet
import dev.tula.auth.PasskeySheet
import dev.tula.auth.SheetFailure
import dev.tula.auth.TulaSheetException
import dev.tula.auth.sheetFailureOf
import dev.tula.auth.generated.PasskeyAssertionCredential
import dev.tula.auth.generated.PasskeyCreationOptions
import dev.tula.auth.generated.PasskeyRegistrationCredential
import dev.tula.auth.generated.PasskeyRequestOptions
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json

/**
 * The JSON Credential Manager takes and gives: every member written, also one that has its
 * default (`"type":"public-key"`), no `null` for an absent one, and a member this version
 * does not know passed over.
 */
private val wire = Json {
    encodeDefaults = true
    explicitNulls = false
    ignoreUnknownKeys = true
}

/**
 * What a failed registration was, by the exception's class. Nothing else of the framework's
 * exception is kept; the client's word for each kind is `sheetFailureOf`'s, in the JVM
 * module, where it is tested.
 */
private fun creationFailure(error: CreateCredentialException): SheetFailure = sheetFailureOf(
    when {
        error is CreateCredentialCancellationException -> CredentialFailureKind.CANCELLED
        error is CreatePublicKeyCredentialDomException && error.domError is InvalidStateError ->
            CredentialFailureKind.ALREADY_REGISTERED
        error is CreatePublicKeyCredentialDomException && error.domError is NotAllowedError ->
            CredentialFailureKind.NOT_ALLOWED
        error is CreateCredentialUnsupportedException -> CredentialFailureKind.UNSUPPORTED
        error is CreateCredentialProviderConfigurationException -> CredentialFailureKind.UNSUPPORTED
        else -> CredentialFailureKind.OTHER
    },
)

/** What a failed request was, by the exception's class; see [creationFailure]. */
private fun requestFailure(error: GetCredentialException): SheetFailure = sheetFailureOf(
    when {
        error is GetCredentialCancellationException -> CredentialFailureKind.CANCELLED
        error is GetPublicKeyCredentialDomException && error.domError is NotAllowedError ->
            CredentialFailureKind.NOT_ALLOWED
        error is GetCredentialUnsupportedException -> CredentialFailureKind.UNSUPPORTED
        error is GetCredentialProviderConfigurationException -> CredentialFailureKind.UNSUPPORTED
        else -> CredentialFailureKind.OTHER
    },
)

/**
 * The passkey sheet of Android's Credential Manager.
 *
 * The options the server sent are handed over as JSON and the credential comes back as JSON;
 * neither is kept, logged or put in an error. A sheet the user put away is
 * [SheetFailure.DISMISSED], which the client reports as a dismissal and not as an error:
 * that is Credential Manager's own cancellation exception and nothing else. A WebAuthn
 * `NotAllowedError` is [SheetFailure.FAILED] until a device has shown it means a cancel. A
 * request that finds no passkey on the device is [SheetFailure.FAILED]: Credential Manager
 * reports it apart from a dismissal, and nothing was shown that a user put away.
 *
 * The server accepts a response only from an app the environment's operator registered
 * (its package name and the SHA-256 fingerprint of its signing certificate), and the device
 * shows a passkey of the relying party only when that domain's `assetlinks.json` names the
 * app: see `docs/native-apps.md`.
 *
 * This class is compiled and linted, and was not run on a device or an emulator.
 *
 * @param activity The activity the sheet is shown over, asked for at each ceremony so that
 *   none is held; `null` (no activity is in front) is [SheetFailure.FAILED].
 */
class CredentialManagerPasskeySheet(private val activity: () -> Activity?) : PasskeySheet {
    override suspend fun create(options: PasskeyCreationOptions): PasskeyRegistrationCredential {
        val over = activity() ?: throw TulaSheetException(SheetFailure.FAILED)
        val request = CreatePublicKeyCredentialRequest(
            wire.encodeToString(PasskeyCreationOptions.serializer(), options),
        )
        val made = try {
            CredentialManager.create(over).createCredential(over, request)
        } catch (error: CreateCredentialException) {
            throw TulaSheetException(creationFailure(error))
        }
        val answer = made as? CreatePublicKeyCredentialResponse ?: throw TulaSheetException(SheetFailure.FAILED)
        return try {
            wire.decodeFromString(PasskeyRegistrationCredential.serializer(), answer.registrationResponseJson)
        } catch (_: SerializationException) {
            throw TulaSheetException(SheetFailure.FAILED)
        }
    }

    override suspend fun get(options: PasskeyRequestOptions): PasskeyAssertionCredential {
        val over = activity() ?: throw TulaSheetException(SheetFailure.FAILED)
        val request = GetCredentialRequest.Builder()
            .addCredentialOption(
                GetPublicKeyCredentialOption(wire.encodeToString(PasskeyRequestOptions.serializer(), options)),
            )
            .build()
        val found = try {
            CredentialManager.create(over).getCredential(over, request).credential
        } catch (error: GetCredentialException) {
            throw TulaSheetException(requestFailure(error))
        }
        val answer = found as? PublicKeyCredential ?: throw TulaSheetException(SheetFailure.FAILED)
        return try {
            wire.decodeFromString(PasskeyAssertionCredential.serializer(), answer.authenticationResponseJson)
        } catch (_: SerializationException) {
            throw TulaSheetException(SheetFailure.FAILED)
        }
    }

    override fun toString(): String = "CredentialManagerPasskeySheet"
}

/**
 * Google's account sheet through Credential Manager, for a sign-in with Google's ID token.
 *
 * The sheet is given the server's nonce as it is and the ID token it answers is returned to
 * the client, which exchanges it; the token is kept nowhere. Every account on the device is
 * offered, not only one that signed in to this app before.
 *
 * This class is compiled and linted, and was not run on a device or an emulator.
 *
 * @param serverClientId The OAuth client id of type "Web application" of the app's Google
 *   project: the audience of the token. The environment's Google provider has it as its
 *   client id, or lists the app's Android client id among its additional client ids.
 * @param activity The activity the sheet is shown over, asked for at each ceremony so that
 *   none is held; `null` is [SheetFailure.FAILED].
 */
class CredentialManagerGoogleSheet(
    private val serverClientId: String,
    private val activity: () -> Activity?,
) : GoogleSheet {
    override suspend fun idToken(nonce: String): String {
        val over = activity() ?: throw TulaSheetException(SheetFailure.FAILED)
        val option = GetGoogleIdOption.Builder()
            .setServerClientId(serverClientId)
            .setNonce(nonce)
            .setFilterByAuthorizedAccounts(false)
            .build()
        val request = GetCredentialRequest.Builder().addCredentialOption(option).build()
        val found = try {
            CredentialManager.create(over).getCredential(over, request).credential
        } catch (error: GetCredentialException) {
            throw TulaSheetException(requestFailure(error))
        }
        if (found !is CustomCredential || found.type != GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL) {
            throw TulaSheetException(SheetFailure.FAILED)
        }
        return try {
            GoogleIdTokenCredential.createFrom(found.data).idToken
        } catch (_: Exception) {
            // The library's own parsing exception: its text may quote what it was given.
            throw TulaSheetException(SheetFailure.FAILED)
        }
    }

    override fun toString(): String = "CredentialManagerGoogleSheet"
}
