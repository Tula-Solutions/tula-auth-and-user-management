/// <reference path="./native-modules.d.ts" />
import { Passkey } from 'react-native-passkey'
import { passkeySheetOver } from './adapters'
import type { PasskeySheet } from './host'

// `@tula/expo/passkeys`: the one module that imports `react-native-passkey`. An app that
// uses no passkeys never imports it and does not need the module installed.

/**
 * The platform's passkey sheet, through `react-native-passkey` (Apple's authorization API
 * on iOS 15 and later, Credential Manager on Android 9 and later). Give it to
 * `createTulaExpoClient` as `passkeys`.
 *
 * The module is native code that Expo Go does not include: it needs a development build.
 * A passkey also needs the app to be associated with the relying party's domain (the two
 * files the Tula API serves for a registered native app), and on iOS that domain's origin
 * among the environment's allowed origins. None of that was run on a device from this
 * repository: see `docs/expo.md`.
 *
 * @example
 * ```ts
 * import { createTulaExpoClient } from '@tula/expo'
 * import { passkeySheet } from '@tula/expo/passkeys'
 *
 * const tula = createTulaExpoClient({ publishableKey, baseUrl, passkeys: passkeySheet })
 * ```
 */
export const passkeySheet: PasskeySheet = passkeySheetOver(Passkey)
