import { createTulaExpoClient } from '@tula/expo'
import { systemBrowser } from '@tula/expo/browser'
import { passkeySheet } from '@tula/expo/passkeys'
import { setUp } from './setup'

// One client for the app, made outside any component. Making it sends nothing and reads
// nothing: `<TulaProvider>` finds out who is signed in.
//
// The two values are public (a publishable key is meant to ship in an app) and come from
// `.env.local`: Expo puts every `EXPO_PUBLIC_*` variable into the bundle. Each is read by
// its full name: Expo replaces `process.env.EXPO_PUBLIC_…` where it is written out, and
// nothing else.
const values = {
  publishableKey: process.env.EXPO_PUBLIC_TULA_PUBLISHABLE_KEY,
  baseUrl: process.env.EXPO_PUBLIC_TULA_API_URL,
}

// #region client
function createClient(publishableKey: string, baseUrl: string) {
  return createTulaExpoClient({
    publishableKey,
    // The address of the Tula API as the phone reaches it: never `localhost` on a device.
    baseUrl,
    // The platform's passkey sheet (`react-native-passkey`) and the system browser's
    // authentication session (`expo-web-browser`). Both are optional: leave one out, with
    // its import and its package, and the app offers no passkey, or no provider.
    passkeys: passkeySheet,
    browser: systemBrowser,
  })
}
// #endregion

// #region redirect-url
/**
 * Where a provider sign-in comes back to: the app's own scheme (`scheme` in `app.json`),
 * listed character for character in the environment's allowed redirect URLs. A custom
 * scheme is accepted for a provider that binds its code with PKCE (Google, GitHub,
 * Microsoft, Discord, X); for the others the app needs an `https` app link.
 */
export const REDIRECT_URL = 'com.example.tula:/oauth/callback'
// #endregion

/**
 * The app's one client, or what `.env.local` is missing for it: a value that is not set or
 * that the client refuses is a screen that says so (`App.tsx`), never an error thrown while
 * this module loads.
 */
export const setup = setUp(values, createClient)
