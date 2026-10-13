# @tula/expo-screens

Tula's native screens as Expo components: the SwiftUI screens of the Swift SDK on iOS and
the Compose screens of the Kotlin SDK on Android, hosted in two views of this package's own
Expo native module, on a native client that owns the session. Design and its limits:
[ADR 0063](../../docs/adr/0063-expo-native-screens.md); the guide is
[docs/expo.md](../../docs/expo.md).

It is a package of its own, apart from the headless [`@tula/expo`](../expo/README.md), and
does not depend on it. Expo links a package's native module into every app that installs the
package, so the module lives where only an app that asked for the screens installs it: an
app on the headless client compiles none of it (no Compose, no Credential Manager, no
Android 9 minimum).

> **Written and partly compiled; never run.** The Android module was compiled once, in a
> scratch Expo 57 app, before it was moved into this package. On iOS the two vendored
> libraries and `TulaScreensHost.swift` were type-checked; `TulaScreensModule.swift`, the
> file that uses Expo's module API, has never been compiled. Nothing native was compiled
> after the move, no app was built, no Metro bundle was made, and no screen was drawn
> through this package anywhere
> ([what was run](../../docs/plans/phase-2-unverified.md#step-216-the-expo-native-screens-tula-62-adr-0063)).
> Nothing is published yet.

```tsx
import { createTulaScreens, TulaAccountView, TulaAuthView } from '@tula/expo-screens'

const tula = createTulaScreens({
  publishableKey: 'tula_pk_dev_…',
  baseUrl: 'https://auth.example.com',
})

// <TulaAuthView tula={tula} style={{ flex: 1 }} onSignedIn={() => …} />
// <TulaAccountView tula={tula} style={{ flex: 1 }} onSignedOut={() => …} />
```

```ts
// app.config.ts
export default { name: 'Example', slug: 'example', plugins: ['@tula/expo-screens/plugin'] }
```

- **They are the native SDKs' screens**: SwiftUI on iOS, Compose on Android, the same props
  on both. Nothing is drawn in React Native. A development build; not Expo Go; iOS 16 and
  Android 9 (API 28).
- **The native client owns the session.** The refresh token stays in its storage (the
  Keychain; an entry sealed by a Keystore key) and never crosses to JavaScript; an access
  token crosses only as the answer of `tula.getToken()`; an event holds a status and two
  ids, or nothing. An app is on these screens or on `@tula/expo`'s
  `createTulaExpoClient`, never both for one environment: they would be two sessions, and
  neither package stops it.
- **Where the app goes next is `onSignedIn`**: the screens read no URL and no deep link.
- **A theme value is checked** with the contract's `isValidThemeValue` (`checkTheme`)
  before it reaches a native view, and again there; a refused one is named by token, never
  by value.
- **A failure crosses as its code**; the sentence is looked up in JavaScript.
- **Android 9 is the module's own minimum** (`minSdkVersion 28` in `android/build.gradle`).
  The config plugin (`@tula/expo-screens/plugin`) raises the app's
  `android.minSdkVersion` Gradle property to 28 and never lowers a higher one; without it
  an app with a lower minimum fails its manifest merge (the manifest merger's documented
  behaviour, not tried here). The plugin imports nothing, takes no options, and only adds
  and raises that one value.

## Development

The native SDKs' sources are copied into `ios/vendor` and `android/vendor` when the package
is built (`scripts/vendor-native.ts`, the `prebuild` script): the copies are ignored by git
and never edited. Change the source under `native/`, then build.
`src/native-screens-sources.test.ts` reads the module's Swift and Kotlin sources as text and
holds the names they exchange with the JavaScript equal; it compiles nothing.

The repository installs neither Expo nor React Native: `src/native-modules.d.ts` declares
the members `src/index.ts` reads, and `src/index.ts` is the one file that imports either.

```bash
bun run --filter @tula/expo-screens test
bun run --filter @tula/expo-screens build   # vendors the native sources, then bunup
```
