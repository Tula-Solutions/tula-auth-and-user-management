import {
  createTulaClientWithEnvironment,
  runtimeEnvironment,
  type TulaClient,
  type TulaClientOptions,
} from '@tula/core'
import { createDeviceBinding } from './device-binding'
import type { DeviceKeyStore } from './device-key-store'
import { type BrowserSession, createHost, type IdTokenSheet, type PasskeySheet } from './host'
import {
  type Schedule,
  type SecureStorageOptions,
  type SecureStoreLike,
  secureStoreStorage,
} from './secure-storage'

/**
 * Options of `createTulaExpoClient`: those of `@tula/core`'s client without the three this
 * package decides itself. The client kind is the platform's (`ios` or `android`), the storage
 * is the device's secure store, and a device key is found in the key store given as
 * `deviceKeys`, never handed over as an object.
 *
 * @example
 * ```ts
 * const options: TulaExpoClientOptions = {
 *   publishableKey: 'tula_pk_dev_…',
 *   baseUrl: 'https://auth.example.com',
 * }
 * ```
 */
export interface TulaExpoClientOptions
  extends Omit<TulaClientOptions, 'client' | 'storage' | 'deviceKey'> {
  /** How the refresh token is kept in the secure store. */
  secureStore?: SecureStorageOptions
  /**
   * The platform's passkey sheet: `passkeySheet` of `@tula/expo/passkeys`, or an app's
   * own. Left out, the client has no passkeys (`passkey.unsupported`, before any request).
   */
  passkeys?: PasskeySheet
  /**
   * The system browser's authentication session, for signing in with a provider:
   * `systemBrowser` of `@tula/expo/browser`, or an app's own. Left out, a provider sign-in
   * is refused before any request.
   */
  browser?: BrowserSession
  /**
   * Google's native sign-in sheet: `googleSheet(…)` of `@tula/expo/google`, or an app's
   * own. Left out, signing in with Google's sheet is refused before any request.
   */
  google?: IdTokenSheet
  /**
   * Sign in with Apple's sheet: `appleSheet` of `@tula/expo/apple`, or an app's own. Left
   * out, signing in with Apple's sheet is refused before any request.
   */
  apple?: IdTokenSheet
  /**
   * The device's key store: `hardwareDeviceKeys` of `@tula/expo/device-key`, or an app's
   * own. With one, every sign-in this client starts carries a proof by a key that cannot
   * leave the device, the session is bound to it, and every refresh carries a proof
   * (ADR 0043, ADR 0052). Left out, sessions are not bound.
   *
   * Give one only where the session profile of the app's sign-ins allows a key
   * (`deviceBinding` `optional` or `required`): under `none` the server refuses a
   * start that brings a proof (`device.binding_not_supported`).
   */
  deviceKeys?: DeviceKeyStore
  /**
   * The app link an emailed sign-in link leads to: an `https` URL on a domain associated
   * with the app, exactly as the environment lists it among its redirect URLs
   * (`https://app.example.com/auth/link`). With it, a sign-in can ask for an emailed link
   * and the app can open one (`useSignIn().openEmailLink`, ADR 0055): a link is asked for
   * with this URL only, and only this URL, character for character, is ever read. Left out,
   * asking for an emailed link is refused before any request and the code in the same
   * email is the way.
   *
   * The link's binding is kept in memory, never in the secure store: a link opened after
   * the app was ended and started again is refused, and the user starts again.
   */
  emailLinkUrl?: string
}

/**
 * Whether `value` can be the app link of an emailed link: `https`, nothing a fragment
 * would start in, no white space. Whether the environment lists it is the server's to say.
 */
function isAppLink(value: unknown): value is string {
  return typeof value === 'string' && /^https:\/\/[^\s#]+$/.test(value)
}

/** What the client takes from the app's runtime: tests pass their own. */
export interface ExpoRuntime {
  /** React Native's `Platform.OS`. */
  platform: string
  /** `expo-secure-store`. */
  secureStore: SecureStoreLike
  /**
   * How the secure-store adapter waits, and the ceiling of a passkey sheet. The runtime's
   * timers when left out.
   */
  schedule?: Schedule
}

/** Options this package sets itself; a caller that passes one has misread what it does. */
const DECIDED_HERE = {
  client: 'the client kind is the platform the app runs on',
  storage: 'the refresh token is kept in the secure store and nowhere else',
  deviceKey:
    'a session is bound to a key the device keeps: give the key store as `deviceKeys`, never a key',
} as const

/**
 * Build the client for a runtime. `createTulaExpoClient` calls it with the app's own.
 *
 * @param options - The publishable key, the API's URL and the rest of the client's options.
 * @param runtime - The platform's name and the secure store.
 * @returns The `@tula/core` client.
 * @throws TypeError on a platform other than iOS and Android, for an option this package
 *   decides itself, for an `emailLinkUrl` that is no `https` URL, and for what
 *   `createTulaClient` refuses.
 */
export function createExpoClient(options: TulaExpoClientOptions, runtime: ExpoRuntime): TulaClient {
  const { platform } = runtime
  if (platform !== 'ios' && platform !== 'android') {
    throw new TypeError(
      '@tula/expo runs in iOS and Android apps. On the web (Expo web included) use `@tula/react` or `@tula/core`, which keep the session in an httpOnly cookie.'
    )
  }
  for (const [name, why] of Object.entries(DECIDED_HERE)) {
    if (Object.hasOwn(options, name)) {
      throw new TypeError(`createTulaExpoClient: \`${name}\` is not an option: ${why}`)
    }
  }
  const { secureStore, passkeys, browser, google, apple, deviceKeys, emailLinkUrl, ...rest } =
    options
  if (emailLinkUrl !== undefined && !isAppLink(emailLinkUrl)) {
    // A custom scheme is any app's to claim, and the server refuses one for an emailed link.
    throw new TypeError(
      'createTulaExpoClient: `emailLinkUrl` is the app link an emailed sign-in link leads to: an `https://` URL with no fragment and no white space, exactly as the environment lists it among its redirect URLs.'
    )
  }
  // The secure store keeps the token; the binding remembers, beside it, which key the
  // stored session belongs to, and is where the client's proofs get their key.
  const binding = createDeviceBinding({
    store: deviceKeys,
    storage: secureStoreStorage(runtime.secureStore, secureStore, runtime.schedule),
  })
  const { environment, adopt } = createHost({
    passkeys,
    browser,
    google,
    apple,
    emailLinkUrl,
    deviceKey: binding.source,
    schedule: runtime.schedule,
  })
  const client = createTulaClientWithEnvironment(
    {
      ...rest,
      client: platform,
      storage: binding.storage,
      // With a key store, the binding reads which key each issued session is bound to.
      fetch: binding.watch(rest.fetch),
    },
    environment(runtimeEnvironment())
  )
  adopt(client)
  return client
}
