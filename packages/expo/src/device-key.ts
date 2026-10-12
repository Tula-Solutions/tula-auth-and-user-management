/// <reference path="./native-modules.d.ts" />
import * as DeviceCrypto from '@pagopa/io-react-native-crypto'
import { deviceKeyStoreOver } from './device-key-adapter'
import type { DeviceKeyStore } from './device-key-store'

// `@tula/expo/device-key`: the one module that imports `@pagopa/io-react-native-crypto`.
// An app whose sessions are not bound to a device key never imports it and does not need
// the module installed.

/**
 * The device's key store, through `@pagopa/io-react-native-crypto`: a P-256 key in the
 * Secure Enclave on iOS and in the Android Keystore, which cannot be exported. Give it to
 * `createTulaExpoClient` as `deviceKeys`: every sign-in then carries a proof by that key,
 * the session is bound to it, and every refresh carries a new proof (ADR 0043, ADR 0052).
 *
 * The module is native code that Expo Go does not include. There every call of it fails at
 * once, which this store reports as "no key store": the app runs, its sign-ins carry no
 * proof and its sessions are not bound (where the session profile says `required`, the
 * server then refuses the sign-in with `device.binding_required`).
 *
 * A stored session whose key is gone (the app's data was cleared, the key store was reset)
 * is dropped when the app starts, with no request, and the user signs in again. None of it
 * was run on a device from this repository: see `docs/expo.md`.
 *
 * @example
 * ```ts
 * import { createTulaExpoClient } from '@tula/expo'
 * import { hardwareDeviceKeys } from '@tula/expo/device-key'
 *
 * const tula = createTulaExpoClient({ publishableKey, baseUrl, deviceKeys: hardwareDeviceKeys })
 * ```
 */
export const hardwareDeviceKeys: DeviceKeyStore = deviceKeyStoreOver(DeviceCrypto)
