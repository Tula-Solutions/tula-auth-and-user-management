/// <reference path="./native-modules.d.ts" />
import * as AppleAuthentication from 'expo-apple-authentication'
import type { IdTokenSheet } from './host'
import { appleSheetOver } from './id-token-adapters'

// `@tula/expo/apple`: the one module that imports `expo-apple-authentication`. An app that
// does not offer Sign in with Apple never imports it and does not need the module installed.

/**
 * Sign in with Apple's sheet, through `expo-apple-authentication` (iOS 13 and later; not
 * on Android, where it says it is not available and the control stays hidden). Give it to
 * `createTulaExpoClient` as `apple`, and sign in with `useSignIn().withIdToken({ provider:
 * 'apple' })`.
 *
 * The server accepts the token only for a registered iOS app: the token's audience is the
 * app's bundle ID, which has to be one of the environment's native apps, with Apple
 * enabled as a provider. The app needs the Sign in with Apple entitlement
 * (`@tula/expo/plugin` sets it). Expo Go includes the module, but a token made there names
 * Expo Go's bundle ID, not the app's. None of it was run on a device from this repository:
 * see `docs/expo.md`.
 *
 * @example
 * ```ts
 * import { createTulaExpoClient } from '@tula/expo'
 * import { appleSheet } from '@tula/expo/apple'
 *
 * const tula = createTulaExpoClient({ publishableKey, baseUrl, apple: appleSheet })
 * ```
 */
export const appleSheet: IdTokenSheet = appleSheetOver(AppleAuthentication)
