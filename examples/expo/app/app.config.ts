import { type ExpoConfigLike, reversedGoogleClientId, withTula } from '@tula/expo/plugin'

// The app's native configuration, on top of `app.json`: Expo calls this with what the file
// holds, when the app is started and when it is built. Everything Tula needs of the native
// side is said here once, to `withTula`, from the same `.env.local` the app itself reads.
//
// Nothing of this file was run: see `README.md`, "What was run, and what was not".

// The domain the app shares credentials with (the environment's `passkeys.rpId`). Unset,
// the app has no associated domain and no passkey.
const domain = process.env.EXPO_PUBLIC_TULA_DOMAIN
// Google's OAuth client ids, for its native sheet. Unset, the app offers none.
const webClientId = process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID
const iosClientId = process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID
// The app link an emailed sign-in link leads to: its domain and its exact path. Unset, the
// app opens no `https` link.
const [, linkDomain, linkPath] =
  /^https:\/\/([^/]+)(\/.+)$/.exec(process.env.EXPO_PUBLIC_TULA_EMAIL_LINK_URL ?? '') ?? []

// The native screens instead of the app's own (`index.ts`): the same variable the app reads.
const nativeScreens = process.env.EXPO_PUBLIC_TULA_NATIVE_SCREENS === '1'

// #region config
export default function config(context: { config: ExpoConfigLike }): ExpoConfigLike {
  const plugins: unknown[] = [
    // Each native module's own plugin stays in the list: `withTula` writes what a
    // configuration can say and no native file. Google's patches the iOS Podfile, and is
    // given the same reversed client id `withTula` writes.
    'expo-apple-authentication',
    ...(iosClientId
      ? [
          [
            'react-native-nitro-google-signin',
            { iosUrlScheme: reversedGoogleClientId(iosClientId) },
          ],
        ]
      : []),
  ]
  return withTula(
    { ...context.config, plugins },
    {
      // `webcredentials:<domain>` under Associated Domains: what a passkey needs on iOS.
      ...(domain && { domains: [domain] }),
      // `applinks:<domain>` on iOS and a verified intent filter for the exact path on
      // Android: what has the operating system open the emailed link in the app.
      ...(linkDomain && linkPath && { appLinks: [{ domain: linkDomain, paths: [linkPath] }] }),
      // What Tula's native screens need of the project: Android 9 (API 28) as its lowest
      // version. Their native module is part of `@tula/expo` and is linked by Expo itself.
      ...(nativeScreens && { nativeScreens: true }),
      // The Sign in with Apple entitlement.
      apple: true,
      ...(webClientId && {
        google: { webClientId, ...(iosClientId && { iosClientId }) },
      }),
    }
  )
}
// #endregion
