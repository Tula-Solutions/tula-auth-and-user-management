/// <reference path="./native-modules.d.ts" />
import { requireNativeModule, requireNativeView } from 'expo'
import { Platform } from 'react-native'
import {
  createScreens,
  SCREENS_MODULE_NAME,
  SCREENS_VIEW_NAMES,
  type ScreensNativeModule,
  type TulaScreens,
  type TulaScreensOptions,
} from './native-screens-core'

// `@tula/expo/native-screens`: the one module that imports `expo`, and that loads this
// package's own native module (`TulaScreens`: `ios/` and `android/` of the package). An
// app that draws its own screens on the headless client never imports it.

export type { ThemeOverrides } from '@tula/contract/theme'
export {
  type CheckedTheme,
  checkTheme,
  SCREENS_MESSAGES,
  TulaAccountView,
  type TulaAccountViewProps,
  TulaAuthView,
  type TulaAuthViewProps,
  type TulaScreens,
  type TulaScreensErrorCode,
  type TulaScreensOptions,
  type TulaScreensState,
} from './native-screens-core'

const nativeModule = requireNativeModule<ScreensNativeModule>(SCREENS_MODULE_NAME)
const authView = requireNativeView<Record<string, unknown>>(
  SCREENS_MODULE_NAME,
  SCREENS_VIEW_NAMES.auth
)
const accountView = requireNativeView<Record<string, unknown>>(
  SCREENS_MODULE_NAME,
  SCREENS_VIEW_NAMES.account
)

/**
 * Set up Tula's native screens for an Expo app: the SwiftUI screens on the Swift client on
 * iOS, the Compose screens on the Kotlin client on Android (ADR 0063).
 *
 * The native client owns the session: the refresh token is in the Keychain (iOS) or
 * sealed by a Keystore key (Android) and never crosses to JavaScript; what this returns
 * asks the native client and keeps only the last state it was told (a status and two
 * ids). It is another client than `createTulaExpoClient`'s: an app uses one or the other
 * for an environment, never both (they would be two sessions).
 *
 * One native client is made for the life of the process: calling this again with the same
 * options (a reload) is fine, with other options it throws `screens.already_configured`.
 * Call it once, outside any component.
 *
 * The native module is part of this package and is not in Expo Go: importing
 * `@tula/expo/native-screens` there throws, as it does in any build made before the
 * package was installed. On Android below 9 (API 28) this throws `screens.unsupported`.
 * None of it was run in an app from this repository: see `docs/expo.md`.
 *
 * @param options - The publishable key, the API's address and what the screens may offer.
 * @returns The native client's session, as far as JavaScript may see it; give it to
 *   `<TulaAuthView>` and `<TulaAccountView>` as `tula`.
 * @throws TypeError on a platform other than iOS and Android, and for options that are not
 *   this function's (`storage`, `secureStore`, `deviceKeys`, …).
 * @throws TulaError when the native module refuses the options.
 *
 * @example
 * ```tsx
 * import { createTulaScreens, TulaAccountView, TulaAuthView } from '@tula/expo/native-screens'
 *
 * const tula = createTulaScreens({
 *   publishableKey: 'tula_pk_dev_…',
 *   baseUrl: 'https://auth.example.com',
 * })
 *
 * export default function App() {
 *   const [signedIn, setSignedIn] = useState(false)
 *   return signedIn ? (
 *     <TulaAccountView tula={tula} style={{ flex: 1 }} onSignedOut={() => setSignedIn(false)} />
 *   ) : (
 *     <TulaAuthView tula={tula} style={{ flex: 1 }} onSignedIn={() => setSignedIn(true)} />
 *   )
 * }
 * ```
 */
export function createTulaScreens(options: TulaScreensOptions): TulaScreens {
  return createScreens(
    { platform: Platform.OS, module: nativeModule, authView, accountView },
    options
  )
}
