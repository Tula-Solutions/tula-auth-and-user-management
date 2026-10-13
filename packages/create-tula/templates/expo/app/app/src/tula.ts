import { createTulaExpoClient } from '@tula/expo'
import { appleSheet } from '@tula/expo/apple'
import { systemBrowser } from '@tula/expo/browser'
import { hardwareDeviceKeys } from '@tula/expo/device-key'
import { googleSheet } from '@tula/expo/google'
import { passkeySheet } from '@tula/expo/passkeys'
import { setUp } from './setup'

// One client for the app, made outside any component. Making it sends nothing and reads
// nothing: `<TulaProvider>` finds out who is signed in.
//
// The values are public (a publishable key is meant to ship in an app, and a Google client
// id is no secret) and come from `.env.local`: Expo puts every `EXPO_PUBLIC_*` variable into
// the bundle. Each is read by its full name: Expo replaces `process.env.EXPO_PUBLIC_…` where
// it is written out, and nothing else.
const values = {
  publishableKey: process.env.EXPO_PUBLIC_TULA_PUBLISHABLE_KEY,
  baseUrl: process.env.EXPO_PUBLIC_TULA_API_URL,
}

// The same two variables `app.config.ts` gives the config plugin: the ids are written once.
const googleWebClientId = process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID
const googleIosClientId = process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID

// #region email-link-url
/**
 * The app link an emailed sign-in link leads to: an `https` URL of a domain associated with
 * the app, listed character for character in the environment's allowed redirect URLs.
 * `app.config.ts` gives the same variable to the config plugin. Unset, the app asks for no
 * link: the code in the email is the way.
 */
export const EMAIL_LINK_URL = process.env.EXPO_PUBLIC_TULA_EMAIL_LINK_URL || undefined
// #endregion

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
    // Sign in with Apple's own sheet (`expo-apple-authentication`) and Google's
    // (`react-native-nitro-google-signin`). Optional in the same way; Google's is given
    // only where the app was configured with a client id.
    apple: appleSheet,
    ...(googleWebClientId && {
      google: googleSheet({
        webClientId: googleWebClientId,
        ...(googleIosClientId && { iosClientId: googleIosClientId }),
      }),
    }),
    // The device's key store (`@pagopa/io-react-native-crypto`): a session is bound to a
    // key made there, and every refresh proves it. Leave it out where the environment's
    // session profile has `deviceBinding: 'none'`.
    deviceKeys: hardwareDeviceKeys,
    // Where an emailed sign-in link leads: with it the client can ask for one, and reads a
    // URL the app is opened with only when it is this one, followed by the link.
    ...(EMAIL_LINK_URL && { emailLinkUrl: EMAIL_LINK_URL }),
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
