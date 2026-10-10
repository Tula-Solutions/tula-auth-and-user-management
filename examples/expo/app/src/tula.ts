import { createTulaExpoClient } from '@tula/expo'
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
  })
}
// #endregion

/**
 * The app's one client, or what `.env.local` is missing for it: a value that is not set or
 * that the client refuses is a screen that says so (`App.tsx`), never an error thrown while
 * this module loads.
 */
export const setup = setUp(values, createClient)
