---
'@tula/expo': minor
---

`@tula/expo/native-screens`: Tula's SwiftUI screens (iOS) and Compose screens (Android) as
two React Native views, `<TulaAuthView>` and `<TulaAccountView>`, with the same props on
both platforms, set up with `createTulaScreens()`. They run on the native client, which
owns the session: the refresh token stays in the Keychain or sealed by a Keystore key and
never crosses to JavaScript, an access token crosses only as the answer of `getToken()`,
and a failure crosses as its code. A theme is given in the tokens of
`@tula/contract/theme` and every value is checked before it reaches a native view. Where
the app goes after a sign-in is the `onSignedIn` callback and nothing else.

The package now ships a native module of its own (`ios/`, `android/`, linked by Expo's
autolinking) with copies of the native SDKs' sources, and names `expo` as an optional peer.
The config plugin gains `nativeScreens: true`, which raises an Android project's
`minSdkVersion` to 28. An app uses these screens or the headless client, not both.

Written and partly compiled, never run: the Android module was compiled inside a scratch
Expo SDK 57 app; on iOS the two libraries were compiled and the file that uses Expo's
module API was not. No screen has been drawn through this entry point in a simulator, an
emulator or on a phone.

After a review: the native module passes on only an error code of a closed set (its own,
the native client's, and the contract's as the package was generated; anything else,
a code a newer server gained included, is `internal`), under one fixed sentence that does
not hold the code; on Android every `configure` replaces the activity provider, so a
JavaScript reload does not leave the sheets with a dead context's; on iOS the module ends
its watching task when it is destroyed. The Android module compiles the Kotlin SDK against
older libraries than the SDK is tested on (listed in `docs/expo.md`), and the config
plugin's `nativeScreens` is said as what it is: it adds, and raises one value
(`android.minSdkVersion` below 28), never lowers.
