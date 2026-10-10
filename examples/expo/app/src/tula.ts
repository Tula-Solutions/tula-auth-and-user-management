import { createTulaExpoClient } from '@tula/expo'

// One client for the app, made outside any component. Making it sends nothing and reads
// nothing: `<TulaProvider>` finds out who is signed in.
//
// The two values are public (a publishable key is meant to ship in an app) and come from
// `.env.local`: Expo puts every `EXPO_PUBLIC_*` variable into the bundle.

// #region client
export const tula = createTulaExpoClient({
  publishableKey: process.env.EXPO_PUBLIC_TULA_PUBLISHABLE_KEY ?? '',
  // The address of the Tula API as the phone reaches it: never `localhost` on a device.
  baseUrl: process.env.EXPO_PUBLIC_TULA_API_URL ?? '',
})
// #endregion
