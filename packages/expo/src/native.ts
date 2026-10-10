/// <reference path="./native-modules.d.ts" />
import type { TulaClient } from '@tula/core'
import * as SecureStore from 'expo-secure-store'
import { Platform } from 'react-native'
import { createExpoClient, type TulaExpoClientOptions } from './client'

// The one module that imports a native package. Everything else takes what it needs as an
// argument, so it runs (and is tested) where neither exists.

/**
 * Create the Tula client for an Expo app: `@tula/core`'s client, as an `ios` or `android`
 * client, with its refresh token in the device's secure store (`expo-secure-store`).
 *
 * Creating a client sends nothing and reads nothing. Create it once, outside any component,
 * and give it to `<TulaProvider>`, which finds out who is signed in. The access token lives
 * in memory only and the refresh token in the secure store only: neither is ever written to
 * AsyncStorage, a file, a log line or a URL.
 *
 * It needs no native module beyond `expo-secure-store`, which Expo Go includes. Device
 * binding, passkeys and sign-in with a provider are not part of this version.
 *
 * @param options - The publishable key and the API's URL; optionally a session profile, a
 *   `fetch`, a listener, messages, a timeout and how the secure store is used.
 * @returns The client.
 * @throws TypeError on a platform other than iOS and Android (Expo web included), for
 *   `client`, `storage` or `deviceKey` (this package decides them), and for what
 *   `createTulaClient` refuses (a secret key, a relative URL).
 *
 * @example
 * ```tsx
 * import { createTulaExpoClient, TulaProvider } from '@tula/expo'
 *
 * const tula = createTulaExpoClient({
 *   publishableKey: 'tula_pk_dev_…',
 *   baseUrl: 'https://auth.example.com',
 * })
 *
 * export default function App() {
 *   return (
 *     <TulaProvider client={tula}>
 *       <Screens />
 *     </TulaProvider>
 *   )
 * }
 * ```
 */
export function createTulaExpoClient(options: TulaExpoClientOptions): TulaClient {
  return createExpoClient(options, { platform: Platform.OS, secureStore: SecureStore })
}
