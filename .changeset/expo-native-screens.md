---
'@tula/expo-screens': minor
---

A new package, `@tula/expo-screens`: Tula's SwiftUI screens (iOS) and Compose screens
(Android) as two React Native views, `<TulaAuthView>` and `<TulaAccountView>`, with the
same props on both platforms, set up with `createTulaScreens()`. They run on the native
client, which owns the session: the refresh token stays in the Keychain or sealed by a
Keystore key and never crosses to JavaScript, an access token crosses only as the answer of
`getToken()`, and a failure crosses as its code. A theme is given in the tokens of
`@tula/contract/theme` and every value is checked before it reaches a native view
(`checkTheme`). Where the app goes after a sign-in is the `onSignedIn` callback and nothing
else.

It is a package of its own, and not an entry point of `@tula/expo`, because Expo links a
package's native module into every app that installs the package: the module (`ios/`,
`android/`, with copies of the native SDKs' sources) is compiled only by an app that
installed `@tula/expo-screens` for the screens. `@tula/expo` is unchanged, stays headless,
and neither package depends on the other. An app uses these screens or the headless
client, not both.

The Android module declares `minSdkVersion 28` itself. The config plugin,
`@tula/expo-screens/plugin` (no options, imports nothing), raises an Android project's
`android.minSdkVersion` to 28 and never lowers a higher one; without it an app with a lower
minimum fails its manifest merge (the manifest merger's documented behaviour, not tried).

Written and partly compiled, never run: the Android module was compiled once inside a
scratch Expo SDK 57 app, before it became this package; on iOS the two libraries and the
host file were type-checked and the file that uses Expo's module API was never compiled.
Nothing native was compiled after the move into this package. No app was built, no Metro
bundle was made, and no screen has been drawn through it in a simulator, an emulator or on
a phone.

The native module passes on only an error code of a closed set (its own, the native
client's, and the contract's as the package was generated; anything else, a code a newer
server gained included, is `internal`), under one fixed sentence that does not hold the
code. The Android module compiles the Kotlin SDK against older libraries than the SDK is
tested on (listed in `docs/expo.md`).
