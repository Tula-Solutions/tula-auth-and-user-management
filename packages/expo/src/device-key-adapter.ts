import { base64Bytes } from './bytes'
import { DEVICE_KEY_ALIAS, type DeviceKeyStore } from './device-key-store'
import { wordOf } from './native-words'

// The device key store over its native module. The module is an argument, so the adapter
// runs (and is tested) where it is not installed; `device-key.ts` hands in the real one.

/** `@pagopa/io-react-native-crypto`, as far as the adapter calls it. */
export interface DeviceCryptoModuleLike {
  getPublicKeyFixed(keyTag: string): Promise<unknown>
  generate(keyTag: string): Promise<unknown>
  sign(message: string, keyTag: string): Promise<string>
  deleteKey(keyTag: string): Promise<void>
}

/** A rejection with nothing of the module's own text, which can quote a key's tag. */
function keyStoreFailure(): Error {
  return new Error('The device key store failed.')
}

/** The module's words for a device or an OS version that cannot keep such a key. */
const NO_KEY_STORE: readonly string[] = ['UNSUPPORTED_DEVICE', 'API_LEVEL_NOT_SUPPORTED']

/**
 * The module's words for a key that could not be made where there was none: the two above,
 * and what it says when the platform refused the key's own parameters (no Secure Enclave
 * to put a P-256 key in).
 */
const CANNOT_MAKE: readonly string[] = [...NO_KEY_STORE, 'WRONG_KEY_CONFIGURATION']

/**
 * An ECDSA signature as `r` then `s`, 32 bytes each, from its DER form
 * (`SEQUENCE { INTEGER r, INTEGER s }`), or `null` for bytes that are not one.
 */
function rawSignature(der: Uint8Array | null): Uint8Array | null {
  if (!der || der.length < 8 || der[0] !== 0x30 || der[1] !== der.length - 2) {
    return null
  }
  const raw = new Uint8Array(64)
  let at = 2
  for (const offset of [0, 32]) {
    const length = der[at + 1] as number
    if (der[at] !== 0x02 || length === undefined || at + 2 + length > der.length) {
      return null
    }
    let start = at + 2
    let size = length
    // A leading zero keeps a positive integer positive; it is not part of the number.
    while (size > 32 && der[start] === 0) {
      start += 1
      size -= 1
    }
    if (size > 32 || size === 0) {
      return null
    }
    raw.set(der.subarray(start, start + size), offset + 32 - size)
    at += 2 + length
  }
  return at === der.length ? raw : null
}

/**
 * A device key store over `@pagopa/io-react-native-crypto`: a P-256 key in the Secure
 * Enclave on iOS and in the Android Keystore (StrongBox where the device has it), which the
 * module never exports.
 *
 * Read from the module's tarball, version 1.2.5 (`lib/module/index.js`,
 * `ios/IoReactNativeCrypto.swift`, the Kotlin module), and from nothing that ran:
 *
 * - where the native module is not in the build (Expo Go) every call **throws at the call**
 *   (a proxy that throws a linking error): that is "no key store";
 * - a rejection is an error whose `message` is one word of a closed list;
 * - `getPublicKeyFixed` rejects with `PUBLIC_KEY_NOT_FOUND` for a key that is not there
 *   **and, on iOS, for any Keychain lookup that did not succeed** (a locked device among
 *   them), so that word alone never means "gone". `generate` refuses
 *   (`KEY_ALREADY_EXISTS`) unless the lookup said "not found": a key is taken as newly
 *   made only when `generate` resolved, **and `generate` is called only after two lookups
 *   in a row said "not found"** (the second at once, with no wait): found the second time
 *   it is the key, and any other rejection is a failure with nothing made. That narrows
 *   the case of a lookup that wrongly says "not found" once; it does not close it;
 * - on Android `generate` falls back to an RSA key where it cannot make an EC one. A proof
 *   cannot be signed with it: the key is deleted again and the device is said to have no
 *   key store for the rest of the run;
 * - a `generate` that found nothing under the tag and still could not make a key
 *   (`WRONG_KEY_CONFIGURATION`, `UNSUPPORTED_DEVICE`, `API_LEVEL_NOT_SUPPORTED`) is the
 *   same: no key store for the rest of the run. Any other rejection says nothing about the
 *   device and is a failure of that one call;
 * - `sign` takes text and answers a base64 DER signature over its UTF-8 bytes with SHA-256;
 *   a proof's signing input is ASCII, so the text is those bytes.
 *
 * **No key was made, found or lost on a device to see any of it**
 * (`docs/plans/phase-2-unverified.md`). Nothing of the module's own text leaves here.
 *
 * @param module - The module.
 * @returns The key store `createTulaExpoClient` takes as `deviceKeys`.
 */
export function deviceKeyStoreOver(module: DeviceCryptoModuleLike): DeviceKeyStore {
  /** Set once the device has shown that it cannot make an EC key. */
  let unable = false
  return {
    async isAvailable() {
      if (unable) {
        return false
      }
      let lookup: Promise<unknown>
      try {
        // The lookup is the cheapest call the module has; what it answers is not used.
        lookup = module.getPublicKeyFixed(DEVICE_KEY_ALIAS)
      } catch {
        // Thrown at the call, not rejected: the native module is not in this build.
        return false
      }
      try {
        await lookup
        return true
      } catch (thrown) {
        return !NO_KEY_STORE.includes(wordOf(thrown, 'message'))
      }
    },
    async obtain(alias) {
      /** One look under the alias: the key, or `absent` when the module said "not found". */
      const absent = {}
      const look = async (): Promise<unknown> => {
        try {
          return await module.getPublicKeyFixed(alias)
        } catch (thrown) {
          if (wordOf(thrown, 'message') !== 'PUBLIC_KEY_NOT_FOUND') {
            throw keyStoreFailure()
          }
          return absent
        }
      }
      let created = false
      let jwk = await look()
      if (jwk === absent) {
        // "The key is gone" ends a bound session for good, on a native lookup's word that
        // nobody has seen on a device. So one "not found" is not taken for it: the lookup is
        // asked again, at once, and a key is made only when it says the same. A key found
        // the second time is the key; a rejection is a failure, with nothing made.
        jwk = await look()
      }
      if (jwk === absent) {
        try {
          // Resolves only when nothing was under the alias: the one proof there was no key.
          await module.generate(alias)
          created = true
          jwk = await module.getPublicKeyFixed(alias)
        } catch (refused) {
          // Nothing was there and nothing could be made: this device keeps no such key.
          unable = unable || CANNOT_MAKE.includes(wordOf(refused, 'message'))
          throw keyStoreFailure()
        }
      }
      const { kty, crv, x, y } = (typeof jwk === 'object' && jwk !== null ? jwk : {}) as Record<
        string,
        unknown
      >
      if (kty !== 'EC' || crv !== 'P-256' || typeof x !== 'string' || typeof y !== 'string') {
        if (created) {
          unable = true
          await Promise.resolve()
            .then(() => module.deleteKey(alias))
            .catch(() => undefined)
        }
        throw keyStoreFailure()
      }
      return { publicJwk: { kty, crv, x, y }, created }
    },
    async sign(alias, data) {
      let text = ''
      for (const byte of data) {
        if (byte > 0x7f) {
          throw keyStoreFailure()
        }
        text += String.fromCharCode(byte)
      }
      let answer: unknown
      try {
        answer = await module.sign(text, alias)
      } catch {
        throw keyStoreFailure()
      }
      const signature = rawSignature(typeof answer === 'string' ? base64Bytes(answer) : null)
      if (!signature) {
        throw keyStoreFailure()
      }
      return signature
    },
  }
}
