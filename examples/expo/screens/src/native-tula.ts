import { createTulaScreens } from '@tula-tech/expo-screens'
import { setUp } from './setup'

// The app's other way to sign in: Tula's own native screens (SwiftUI on iOS, Compose on
// Android) instead of the screens this app draws, from a package of their own
// (`@tula-tech/expo-screens`). This module is loaded only by the other root
// (`index.screens.ts`): the native screens are on a native client of their own, which owns
// the session, and an app is on that client or on `createTulaExpoClient`'s (`tula.ts`),
// never on both.
//
// Nothing of this file was run: see `../README.md`, "What was run, and what was not".

const values = {
  publishableKey: process.env.EXPO_PUBLIC_TULA_PUBLISHABLE_KEY,
  baseUrl: process.env.EXPO_PUBLIC_TULA_API_URL,
}
const googleWebClientId = process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID

// #region native-screens
function createScreens(publishableKey: string, baseUrl: string) {
  return createTulaScreens({
    publishableKey,
    // The address of the Tula API as the phone reaches it: never `localhost` on a device.
    baseUrl,
    // What the screens may offer. Each is a switch and nothing else: the native client
    // makes its own passkey sheet, browser session and device key, and JavaScript is
    // handed none of them. A way that is switched off is not drawn.
    passkeys: true,
    browser: true,
    apple: true,
    deviceBinding: true,
    // Android only: Google's own sheet, for the environment's Google provider.
    ...(googleWebClientId && { googleWebClientId }),
  })
}
// #endregion

/**
 * Where a provider's page comes back to, as in `tula.ts`: the app's own scheme, listed
 * character for character in the environment's allowed redirect URLs.
 */
export const REDIRECT_URL = 'com.example.tula:/oauth/callback'

/**
 * The native screens' session, or what `.env.local` is missing for it: a value that is not
 * set or that is refused is a screen that says so (`NativeApp.tsx`), never an error thrown
 * while this module loads.
 */
export const setup = setUp(values, createScreens)
