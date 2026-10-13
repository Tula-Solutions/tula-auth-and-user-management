/// <reference path="./native-modules.d.ts" />
import * as WebBrowser from 'expo-web-browser'
import { browserSessionOver } from './adapters'
import type { BrowserSession } from './host'

// `@tula/expo/browser`: the one module that imports `expo-web-browser`. An app that offers
// no provider sign-in never imports it and does not need the module installed.

/**
 * The system browser's authentication session, through `expo-web-browser`
 * (`ASWebAuthenticationSession` on iOS, a Custom Tab on Android). Give it to
 * `createTulaExpoClient` as `browser`.
 *
 * Expo Go includes the module. Whether each platform hands the redirect back to the app
 * (a custom scheme the app registered, or an app link with its association file) was not
 * run on a device from this repository: see `docs/expo.md`.
 *
 * @example
 * ```ts
 * import { createTulaExpoClient } from '@tula/expo'
 * import { systemBrowser } from '@tula/expo/browser'
 *
 * const tula = createTulaExpoClient({ publishableKey, baseUrl, browser: systemBrowser })
 * ```
 */
export const systemBrowser: BrowserSession = browserSessionOver(WebBrowser)
