import type { DevicePublicJwk } from '@tula/core'

// What a device key store is, apart from what is done with one (`device-binding.ts`), so
// that an adapter of a native module imports the interface and nothing else.

/**
 * A key the device keeps and never hands out, as this package asks for it: the Secure
 * Enclave on iOS, the Keystore (StrongBox or the TEE) on Android, through whatever native
 * module the app has. `@tula/expo/device-key` is one over `@pagopa/io-react-native-crypto`;
 * an app may write its own.
 *
 * The key is ECDSA over P-256, cannot be exported, and lives under an alias this package
 * chooses ({@link DEVICE_KEY_ALIAS}). There is one for the installed app, used by every
 * session it starts.
 *
 * **`obtain` must tell "there is no key" from "the key cannot be reached right now".** The
 * first is answered by making one (`created: true`), and a stored session bound to the old
 * key is then over. The second (a locked device, a key store that is busy) is a rejection:
 * the session is kept and the client says `storage.failed` or `device.key_failed`. A store
 * that cannot tell rejects.
 *
 * @example
 * ```ts
 * const keys: DeviceKeyStore = {
 *   isAvailable: () => MyModule.hasSecureHardware(),
 *   obtain: (alias) => MyModule.findOrCreateKey(alias),
 *   sign: (alias, data) => MyModule.sign(alias, data),
 * }
 * ```
 */
export interface DeviceKeyStore {
  /**
   * Whether this app can keep such a key at all (the native module is in the build and the
   * device has the hardware). Asked each time a key is needed, never when the client is
   * created. `false` is taken as final for this run of the app; a store that cannot say
   * rejects.
   */
  isAvailable(): boolean | Promise<boolean>
  /**
   * Find the key under `alias`, or make one when there is certainly none.
   *
   * @param alias - The key's name in the key store.
   * @returns The public key, and whether it was made by this call.
   */
  obtain(alias: string): Promise<ObtainedDeviceKey>
  /**
   * Sign with the key under `alias`: ECDSA over P-256 and SHA-256.
   *
   * @param alias - The key's name in the key store.
   * @param data - The bytes to sign. Always ASCII (a proof's `header.payload`).
   * @returns The signature as `r` then `s`, 32 bytes each. A platform that produces a DER
   *   signature converts it before returning.
   */
  sign(alias: string, data: Uint8Array): Promise<Uint8Array>
}

/**
 * What {@link DeviceKeyStore.obtain} answers.
 *
 * @example
 * ```ts
 * const obtained: ObtainedDeviceKey = { publicJwk, created: false }
 * ```
 */
export interface ObtainedDeviceKey {
  /** The public half: a P-256 point, coordinates as base64url without padding. */
  publicJwk: DevicePublicJwk
  /** Whether the key was made by this call: there was none under the alias before. */
  created: boolean
}

/**
 * The name the device's key is kept under. One key for the installed app: it binds every
 * session the app starts and earns nothing by itself (ADR 0043: a device does not outlive
 * its session).
 *
 * @example
 * ```ts
 * await keys.obtain(DEVICE_KEY_ALIAS)
 * ```
 */
export const DEVICE_KEY_ALIAS = 'tula.device-key'
