# @tula/expo

Tula for an Expo app on iOS and Android, headless: [`@tula/core`](../core/README.md)'s
client with its refresh token in the device's secure store, a provider and hooks for
sign-up, sign-in (a password, a code, a passkey, a provider, Apple's and Google's own
sheets), password reset and the session, which can be bound to a key the device keeps;
and a config plugin. It draws no screen. An app that wants Tula's own screens takes
`@tula/expo/native-screens` instead: the SwiftUI and Compose screens of the native SDKs,
on a native client that owns the session ([below](#tulas-native-screens)).

The guide is [docs/expo.md](../../docs/expo.md), the reference
[docs/reference/expo.md](../../docs/reference/expo.md), the reasoning
[ADR 0046](../../docs/adr/0046-expo-sdk.md),
[ADR 0048](../../docs/adr/0048-expo-passkeys-and-providers.md),
[ADR 0052](../../docs/adr/0052-expo-native-providers-and-device-keys.md) and, for the native
screens, [ADR 0063](../../docs/adr/0063-expo-native-screens.md), and the example app
[examples/expo](../../examples/expo/README.md).

```tsx
import { createTulaExpoClient, TulaProvider, useAuth, useSignIn } from '@tula/expo'

const tula = createTulaExpoClient({
  publishableKey: 'tula_pk_dev_…',
  baseUrl: 'https://auth.example.com',
})

export default function App() {
  return (
    <TulaProvider client={tula}>
      <Screens />
    </TulaProvider>
  )
}
```

## What it holds to

- **The refresh token is in the secure store and nowhere else** (`expo-secure-store`:
  the Keychain, or Keystore-encrypted storage), in a class that never leaves the device.
  The access token is in memory. Neither is ever in AsyncStorage, a log line, an error or
  a URL, and `client`, `storage` and `deviceKey` are not options (an app hands over a key
  store, `deviceKeys`, never a key).
- **A secure store that fails is not "signed out"**: `storage.failed`, and the running app
  keeps its session. A refused write is tried three times, and twice more by itself within about
  six seconds; if the app is ended while the
  store still holds a token the server has replaced, and started after the grace window
  (10 seconds by default), the user signs in again. `useAuth().loadError` says why the
  first load is still failing.
- **A step it has no action for is the screen `not_supported`**, never a guess.
- **A passkey and a provider are options, each with a module the app may leave out.**
  `passkeys: passkeySheet` from `@tula/expo/passkeys` (`react-native-passkey`; a
  development build) and `browser: systemBrowser` from `@tula/expo/browser`
  (`expo-web-browser`), or objects of the app's own. One passkey request at a time; a
  dismissed sheet and a closed browser are `dismissed`, never an error and never a
  sign-in.
- **A provider's ticket is exchanged only with the binding this client kept, in memory.**
  What the browser comes back with is read only when it is the redirect URL that was
  asked for, exactly; anything else is refused without a request. Nothing of a passkey
  ceremony or a round trip is written to storage, a log line, an error or a URL.
- **Apple's and Google's own sheets are options too**: `apple: appleSheet` from
  `@tula/expo/apple` (`expo-apple-authentication`) and `google: googleSheet(ids)` from
  `@tula/expo/google` (`react-native-nitro-google-signin`; a development build, and the
  import throws in Expo Go). `useSignIn().withIdToken({ provider })` shows the sheet and
  exchanges its ID token; for Apple the package hashes the server's nonce. A control is
  hidden until its sheet is known to be there (`useIdTokenProviders()`), and a dismissed
  sheet is `dismissed`.
- **A session can be bound to a key the device keeps**: `deviceKeys: hardwareDeviceKeys`
  from `@tula/expo/device-key` (`@pagopa/io-react-native-crypto`; a development build).
  Every refresh then carries a proof. A stored session whose key is gone is dropped when
  the app starts, with no request, and the user signs in again; a key store that cannot
  be reached is `storage.failed`, and the session is kept.
- **`@tula/expo/plugin`** (`withTula`) adds Associated Domains, the Sign in with Apple
  entitlement and Google's client ids to the Expo configuration. It writes no native
  file.
- **iOS and Android only.** Creating a client on another platform, Expo web included, is
  a `TypeError`.
- Works with Expo SDK 57 and needs no native module beyond `expo-secure-store` for the
  password and the codes.

An emailed sign-in link opens the app where the client was created with `emailLinkUrl`
(an `https` app link): the link is read only in the app, and the run of it, that asked,
and the code in the same email works everywhere else
([the guide](../../docs/expo.md#the-emailed-link)). **No passkey sheet, no system browser
and no provider's sheet has been opened by this package yet, no key was made in a phone's
secure hardware, and no emailed link ever opened an app**: all
of it is tested with stand-ins. Expo ran the config plugin once, in a scratch prebuild;
no app was built from what it wrote.

## Tula's native screens

```tsx
import { createTulaScreens, TulaAccountView, TulaAuthView } from '@tula/expo/native-screens'

const tula = createTulaScreens({
  publishableKey: 'tula_pk_dev_…',
  baseUrl: 'https://auth.example.com',
})

// <TulaAuthView tula={tula} style={{ flex: 1 }} onSignedIn={() => …} />
// <TulaAccountView tula={tula} style={{ flex: 1 }} onSignedOut={() => …} />
```

- **They are the native SDKs' screens**, hosted in two views of this package's own Expo
  module (`ios/`, `android/`): SwiftUI on iOS, Compose on Android, the same props on
  both. Nothing is drawn in React Native. A development build; not Expo Go; iOS 16 and
  Android 9 (API 28).
- **The native client owns the session.** The refresh token stays in its storage (the
  Keychain; an entry sealed by a Keystore key) and never crosses to JavaScript; an access
  token crosses only as the answer of `tula.getToken()`; an event holds a status and two
  ids, or nothing. An app is on these screens or on `createTulaExpoClient`, never both:
  they would be two sessions, and the package does not stop it.
- **Where the app goes next is `onSignedIn`**: the screens read no URL and no deep link.
- **A theme value is checked** with the contract's `isValidThemeValue` before it reaches
  a native view, and again there; a refused one is named by token, never by value.
- **A failure crosses as its code**; the sentence is looked up in JavaScript.
- **Written and partly compiled; never run.** The Android module was compiled in a scratch
  Expo app; on iOS the two libraries were, and the file that uses Expo's module API was
  not. No screen was drawn through this entry point anywhere
  ([what was run](../../docs/plans/phase-2-unverified.md#step-216-the-expo-native-screens-tula-62-adr-0063)).

The native SDKs' sources are copied into `ios/vendor` and `android/vendor` when the
package is built (`scripts/vendor-native.ts`, the `prebuild` script): the copies are
ignored by git and never edited. `src/native-screens-sources.test.ts` reads the module's
Swift and Kotlin sources and holds the names they exchange with the JavaScript equal.

## Working on the package

The repository installs neither Expo nor React Native, nor any of the optional native
modules: `src/native.ts`, `src/passkeys.ts`, `src/browser.ts`, `src/apple.ts`,
`src/google.ts`, `src/device-key.ts` and `src/native-screens.ts` are the seven modules that
import one, against the
declarations in `src/native-modules.d.ts`, and everything else takes the platform, the
store, the sheets, the browser and the key store as arguments.

```bash
bun test --cwd packages/expo       # the hooks, the storage adapter, and the client journeys
bun run packages:check             # build, pack and check the published shape
```

`src/journeys.test.ts` runs the journeys every client is held to
(`conformance/client-journeys.json`, column `expo`) through this package against the real
API in process, with the DOM's globals taken away. **None of it runs on a phone**: what
was and was not run against real Expo is in
[the Phase 2 list](../../docs/plans/phase-2-unverified.md).
