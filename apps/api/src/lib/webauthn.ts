import {
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server'
import { PASSKEY_ALGORITHMS } from '@tula/contract'
import { randomToken } from '~/lib/crypto'

/** Bytes of randomness in a WebAuthn challenge. */
export const CHALLENGE_BYTES = 32

/** What a ceremony's response must have been made for. */
export interface Expected {
  /** The challenge the server issued, base64url. */
  challenge: string
  /**
   * The origins the response's client data may carry: a page's (`https://app.northline.app`)
   * or the ones a registered native app presents (ADR 0027, "Passkeys from a native app").
   * Decided by `Passkeys.relyingParty` and by nothing a request body holds. The response's
   * origin must be **one of them, as the same string**: nothing is parsed, folded or trimmed.
   * An empty list accepts nothing.
   */
  origins: readonly string[]
  /** The environment's relying-party id. */
  rpId: string
}

/** A credential a registration ceremony produced. Nothing in it is a secret. */
export interface RegisteredCredential {
  /** The credential id, base64url. */
  credentialId: string
  /** The COSE public key. */
  publicKey: Uint8Array
  signCount: number
  transports: string[]
  aaguid: string
  /** The authenticator may copy the credential to the user's other devices. */
  backupEligible: boolean
  /** It currently is copied. */
  backedUp: boolean
}

/** The stored half of a credential that an assertion is checked against. */
export interface StoredCredential {
  credentialId: string
  publicKey: Uint8Array
}

/** What a verified assertion says about its authenticator. */
export interface VerifiedAssertion {
  /** The signature counter in the assertion; `0` for an authenticator that keeps none. */
  signCount: number
  backupEligible: boolean
  backedUp: boolean
}

/**
 * A fresh WebAuthn challenge: 32 bytes from the CSPRNG, as unpadded base64url.
 *
 * @returns The challenge.
 */
export function newChallenge(): string {
  return randomToken(CHALLENGE_BYTES)
}

/**
 * Whether an authenticator's signature counter shows a cloned credential: it kept a counter
 * before or keeps one now, and the new value is not greater than the stored one.
 *
 * Both zero is an authenticator that keeps no counter (every synced passkey): never a
 * regression.
 *
 * @param stored - The counter recorded at the credential's last use.
 * @param presented - The counter in the assertion.
 * @returns `true` when the assertion must be refused.
 */
export function counterRegressed(stored: number, presented: number): boolean {
  return (stored > 0 || presented > 0) && presented <= stored
}

/**
 * Verify what `navigator.credentials.create()` returned.
 *
 * Checks, through `@simplewebauthn/server`: the client data's type, challenge and origin; the
 * RP ID hash; the user-present and **user-verified** flags; that the key's algorithm is one of
 * `PASSKEY_ALGORITHMS`; and the attestation statement (`none` is what is asked for). Never
 * throws for a response that does not verify: every reason is the same `null`, so nothing
 * about why reaches a client or a log.
 *
 * @param response - The client's `RegistrationResponseJSON`, already shape-checked.
 * @param expected - The challenge issued, the origins accepted and the relying-party id.
 * @returns The credential to store, or `null`.
 */
export async function verifyRegistration(
  response: unknown,
  expected: Expected
): Promise<RegisteredCredential | null> {
  if (expected.origins.length === 0) {
    return null
  }
  try {
    const { verified, registrationInfo } = await verifyRegistrationResponse({
      response: response as RegistrationResponseJSON,
      expectedChallenge: expected.challenge,
      // A list: the library then asks whether it includes the response's origin, an exact
      // comparison of strings.
      expectedOrigin: [...expected.origins],
      expectedRPID: expected.rpId,
      requireUserVerification: true,
      supportedAlgorithmIDs: [...PASSKEY_ALGORITHMS],
    })
    if (!verified || !registrationInfo.userVerified) {
      return null
    }
    const { credential } = registrationInfo
    return {
      credentialId: credential.id,
      publicKey: new Uint8Array(credential.publicKey),
      signCount: credential.counter,
      transports: [...(credential.transports ?? [])],
      aaguid: registrationInfo.aaguid,
      backupEligible: registrationInfo.credentialDeviceType === 'multiDevice',
      backedUp: registrationInfo.credentialBackedUp,
    }
  } catch {
    return null
  }
}

/**
 * Verify what `navigator.credentials.get()` returned, against a stored credential.
 *
 * Checks the client data's type, challenge and origin, the RP ID hash, the user-present and
 * **user-verified** flags, and the signature with the stored public key. The signature counter
 * is **not** judged here: the caller compares it with {@link counterRegressed}, so that a
 * regression can be recorded as one. Never throws for a response that does not verify.
 *
 * @param response - The client's `AuthenticationResponseJSON`, already shape-checked.
 * @param expected - The challenge issued, the origins accepted and the relying-party id.
 * @param credential - The stored credential the response names.
 * @returns What the assertion says about its authenticator, or `null`.
 */
export async function verifyAssertion(
  response: unknown,
  expected: Expected,
  credential: StoredCredential
): Promise<VerifiedAssertion | null> {
  if (expected.origins.length === 0) {
    return null
  }
  try {
    const { verified, authenticationInfo } = await verifyAuthenticationResponse({
      response: response as AuthenticationResponseJSON,
      expectedChallenge: expected.challenge,
      expectedOrigin: [...expected.origins],
      expectedRPID: expected.rpId,
      // A counter of 0, so the library's own check passes and the caller's records.
      credential: {
        id: credential.credentialId,
        publicKey: new Uint8Array(credential.publicKey),
        counter: 0,
      },
      requireUserVerification: true,
    })
    if (!verified || !authenticationInfo.userVerified) {
      return null
    }
    return {
      signCount: authenticationInfo.newCounter,
      backupEligible: authenticationInfo.credentialDeviceType === 'multiDevice',
      backedUp: authenticationInfo.credentialBackedUp,
    }
  } catch {
    return null
  }
}
