import type { TokenStorage } from '@tula/core'

/**
 * When the device lets the stored refresh token be read. Both keep it on this device only: it
 * is never synced and never restored to another device from a backup.
 *
 * - `when_unlocked` (the default): only while the device is unlocked.
 * - `after_first_unlock`: from the first unlock after a restart, also while locked. For an
 *   app that asks for a token from a background task; see the README for what the default
 *   costs such an app.
 *
 * iOS only (`kSecAttrAccessible`). On Android the value is encrypted with a Keystore key
 * whatever this says.
 *
 * @example
 * ```ts
 * const access: KeychainAccess = 'after_first_unlock'
 * ```
 */
export type KeychainAccess = 'when_unlocked' | 'after_first_unlock'

/**
 * How the refresh token is kept in the device's secure store.
 *
 * @example
 * ```ts
 * const options: SecureStorageOptions = { keychainAccess: 'after_first_unlock' }
 * ```
 */
export interface SecureStorageOptions {
  /** When the token can be read (iOS). Defaults to `when_unlocked`. */
  keychainAccess?: KeychainAccess
  /**
   * The Keychain service (iOS) or Keystore alias (Android) to keep the token under, for an
   * app that separates its own entries. Changing it later hides the stored token: the user
   * signs in again.
   */
  keychainService?: string
}

/** The options `expo-secure-store` takes with a read, a write or a delete, as far as used here. */
interface SecureStoreItemOptions {
  keychainService?: string
  keychainAccessible?: number
}

/**
 * The part of `expo-secure-store` this package uses. The module itself satisfies it; tests
 * pass a fake.
 *
 * @example
 * ```ts
 * import * as SecureStore from 'expo-secure-store'
 * const store: SecureStoreLike = SecureStore
 * ```
 */
export interface SecureStoreLike {
  /** Resolves with the value or `null`; rejects when the store cannot be read. */
  getItemAsync(key: string, options?: SecureStoreItemOptions): Promise<string | null>
  /** Rejects when the value cannot be stored. */
  setItemAsync(key: string, value: string, options?: SecureStoreItemOptions): Promise<void>
  /** Rejects when the value cannot be deleted. */
  deleteItemAsync(key: string, options?: SecureStoreItemOptions): Promise<void>
  /** `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`. */
  readonly WHEN_UNLOCKED_THIS_DEVICE_ONLY: number
  /** `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`. */
  readonly AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: number
}

/**
 * The largest value the adapter stores, in bytes of UTF-8.
 *
 * `expo-secure-store` enforces no limit of its own and says that some iOS releases refused
 * values above about 2048 bytes. A refresh token is about 50 characters, so nothing this
 * package stores comes near; the adapter refuses a larger value itself, so that what happens
 * to one does not depend on the phone it happens on.
 *
 * @example
 * ```ts
 * expect(new TextEncoder().encode(refreshToken).length).toBeLessThan(MAX_SECURE_VALUE_BYTES)
 * ```
 */
export const MAX_SECURE_VALUE_BYTES = 2048

/** What a secure-store key may hold besides the escape character: letters, digits, `.` and `-`. */
const PLAIN = /^[A-Za-z0-9.-]$/

/**
 * The UTF-8 bytes of one code point. Written out because the package asks the runtime for
 * nothing a React Native engine may lack (`TextEncoder` is not in every one).
 */
function utf8(codePoint: number): number[] {
  if (codePoint < 0x80) {
    return [codePoint]
  }
  if (codePoint < 0x800) {
    return [0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f)]
  }
  if (codePoint < 0x10000) {
    return [0xe0 | (codePoint >> 12), 0x80 | ((codePoint >> 6) & 0x3f), 0x80 | (codePoint & 0x3f)]
  }
  return [
    0xf0 | (codePoint >> 18),
    0x80 | ((codePoint >> 12) & 0x3f),
    0x80 | ((codePoint >> 6) & 0x3f),
    0x80 | (codePoint & 0x3f),
  ]
}

/** How many bytes of UTF-8 a text is. */
function byteLength(text: string): number {
  let bytes = 0
  for (const character of text) {
    bytes += utf8(character.codePointAt(0) as number).length
  }
  return bytes
}

/**
 * The secure-store key for one of the client's storage keys.
 *
 * `expo-secure-store` accepts letters, digits, `.`, `-` and `_` in a key, and `@tula/core`
 * names its entry after the API's address and the publishable key
 * (`tula.refresh.https://…|tula_pk_…`). Every other character, and `_` itself, is written as
 * `_` and the two hexadecimal digits of each of its UTF-8 bytes, so two different keys never
 * share an entry.
 *
 * @param key - The client's storage key.
 * @returns The key to give the secure store.
 *
 * @example
 * ```ts
 * secureStoreKey('tula.refresh.https://auth.example.com')
 * // 'tula.refresh.https_3a_2f_2fauth.example.com'
 * ```
 */
export function secureStoreKey(key: string): string {
  let encoded = ''
  for (const character of key) {
    if (PLAIN.test(character)) {
      encoded += character
      continue
    }
    for (const byte of utf8(character.codePointAt(0) as number)) {
      encoded += `_${byte.toString(16).padStart(2, '0')}`
    }
  }
  return encoded
}

/**
 * A `TokenStorage` for `@tula/core` that keeps values in the device's secure store: the
 * Keychain on iOS, Keystore-encrypted preferences on Android.
 *
 * The client uses it for one thing, its refresh token. Nothing is cached here and nothing is
 * logged; a read, a write or a delete the store refuses rejects, which the client reports as
 * `storage.failed` without ending the session. A value over {@link MAX_SECURE_VALUE_BYTES} is
 * refused before the store is asked. No error made here holds a value.
 *
 * `requireAuthentication` is never set: a refresh would ask for the user's face or
 * fingerprint every minute, and Expo Go does not support it.
 *
 * @param store - `expo-secure-store` (or, in a test, a fake of it).
 * @param options - When the token can be read on iOS, and the service to keep it under.
 * @returns The storage adapter.
 * @throws TypeError for a `keychainAccess` that is not one of the two, or a `keychainService`
 *   that is not a non-empty string.
 *
 * @example
 * ```ts
 * import * as SecureStore from 'expo-secure-store'
 * const storage = secureStoreStorage(SecureStore)
 * ```
 */
export function secureStoreStorage(
  store: SecureStoreLike,
  options: SecureStorageOptions = {}
): TokenStorage {
  const { keychainAccess = 'when_unlocked', keychainService } = options
  if (keychainAccess !== 'when_unlocked' && keychainAccess !== 'after_first_unlock') {
    throw new TypeError(
      '@tula/expo: `keychainAccess` is `when_unlocked` or `after_first_unlock`; the token is never kept in a class that leaves the device'
    )
  }
  if (
    keychainService !== undefined &&
    (typeof keychainService !== 'string' || keychainService === '')
  ) {
    throw new TypeError('@tula/expo: `keychainService` must be a non-empty string')
  }
  // Read when an entry is touched, not here: the module's constants are native values.
  const itemOptions = (): SecureStoreItemOptions => ({
    keychainAccessible:
      keychainAccess === 'after_first_unlock'
        ? store.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY
        : store.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    ...(keychainService !== undefined && { keychainService }),
  })
  return {
    async get(key) {
      const value = await store.getItemAsync(secureStoreKey(key), itemOptions())
      // Anything but a non-empty string is no token: the client then knows it has none.
      return typeof value === 'string' && value !== '' ? value : null
    },
    async set(key, value) {
      if (byteLength(value) > MAX_SECURE_VALUE_BYTES) {
        throw new RangeError(
          `@tula/expo: a value over ${MAX_SECURE_VALUE_BYTES} bytes is not kept in the secure store`
        )
      }
      await store.setItemAsync(secureStoreKey(key), value, itemOptions())
    },
    async remove(key) {
      await store.deleteItemAsync(secureStoreKey(key), itemOptions())
    },
  }
}
