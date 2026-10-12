/// <reference path="./native-modules.d.ts" />
import { GoogleOneTapSignIn } from 'react-native-nitro-google-signin'
import type { IdTokenSheet } from './host'
import { type GoogleClientIds, googleSheetOver } from './id-token-adapters'

// `@tula/expo/google`: the one module that imports `react-native-nitro-google-signin`. An
// app that does not offer Google's native sheet never imports it and does not need the
// module installed.

export type { GoogleClientIds } from './id-token-adapters'

/**
 * Google's account sheet, through `react-native-nitro-google-signin` (the Google Sign-In
 * SDK on iOS, Credential Manager on Android). Give what it returns to
 * `createTulaExpoClient` as `google`, and sign in with `useSignIn().withIdToken({
 * provider: 'google' })`.
 *
 * The module is the one maintained Google sign-in module found that lets an app set the
 * request's nonce, which the server requires (ADR 0045, ADR 0051). It is native code that
 * Expo Go does not include, **and it reaches for that code when it is imported**: importing
 * `@tula/expo/google` in Expo Go throws. An app that must also start in Expo Go loads this
 * entry point only in a development build (a `require` behind its own check), and creates
 * the client without `google` otherwise; the control is then hidden
 * (`useIdTokenProviders().google` is `false`).
 *
 * The server accepts the token only for a client id the environment's Google provider
 * lists: the web client id is the token's audience on Android and the iOS client id on
 * iOS, so the iOS one goes among the provider's `additionalClientIds`. None of it was run
 * on a device from this repository: see `docs/expo.md`.
 *
 * @param ids - The web client id and, for iOS, the iOS client id. Neither is a secret.
 * @returns The sheet.
 *
 * @example
 * ```ts
 * import { createTulaExpoClient } from '@tula/expo'
 * import { googleSheet } from '@tula/expo/google'
 *
 * const tula = createTulaExpoClient({
 *   publishableKey,
 *   baseUrl,
 *   google: googleSheet({ webClientId, iosClientId }),
 * })
 * ```
 */
export function googleSheet(ids: GoogleClientIds): IdTokenSheet {
  return googleSheetOver(GoogleOneTapSignIn, ids)
}
