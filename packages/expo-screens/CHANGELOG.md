# @tula-tech/expo-screens

## 0.3.0

### Patch Changes

- Updated dependencies [d57ea22]
- Updated dependencies [110ae64]
- Updated dependencies [568bcec]
- Updated dependencies [595f5d9]
- Updated dependencies [2d098d6]
- Updated dependencies [e15bd1c]
- Updated dependencies [ef6030d]
- Updated dependencies [2ee73d3]
- Updated dependencies [24288d6]
- Updated dependencies [358f646]
- Updated dependencies [9c2bafb]
- Updated dependencies [ad8b8e2]
- Updated dependencies [048f982]
- Updated dependencies [721ed9e]
- Updated dependencies [ece0a87]
  - @tula-tech/contract@0.3.0
  - @tula-tech/core@0.3.0

## 0.2.0

### Patch Changes

- Updated dependencies [f56f6b5]
  - @tula-tech/contract@0.2.0
  - @tula-tech/core@0.2.0

## 0.1.1

### Patch Changes

- @tula-tech/contract@0.1.1
  - @tula-tech/core@0.1.1

## 0.1.0

### Minor Changes

- 14a7d02: A new package, `@tula-tech/expo-screens`: Tula's SwiftUI screens (iOS) and Compose screens
  (Android) as two React Native views, `<TulaAuthView>` and `<TulaAccountView>`, with the
  same props on both platforms, set up with `createTulaScreens()`. They run on the native
  client, which owns the session: the refresh token stays in the Keychain or sealed by a
  Keystore key and never crosses to JavaScript, an access token crosses only as the answer of
  `getToken()`, and a failure crosses as its code. A theme is given in the tokens of
  `@tula-tech/contract/theme` and every value is checked before it reaches a native view
  (`checkTheme`). Where the app goes after a sign-in is the `onSignedIn` callback and nothing
  else.
  
  It is a package of its own, and not an entry point of `@tula-tech/expo`, because Expo links a
  package's native module into every app that installs the package: the module (`ios/`,
  `android/`, with copies of the native SDKs' sources) is compiled only by an app that
  installed `@tula-tech/expo-screens` for the screens. `@tula-tech/expo` is unchanged, stays headless,
  and neither package depends on the other. An app uses these screens or the headless
  client, not both.
  
  The Android module declares `minSdkVersion 28` itself. The config plugin,
  `@tula-tech/expo-screens/plugin` (no options, imports nothing), raises an Android project's
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

### Patch Changes

- Updated dependencies [a036657]
- Updated dependencies [a34eb0e]
- Updated dependencies [b38efc0]
- Updated dependencies [1c76ead]
- Updated dependencies [55115bc]
- Updated dependencies [0a5e496]
- Updated dependencies [9166270]
- Updated dependencies [ac15d68]
- Updated dependencies [462aee1]
- Updated dependencies [d013691]
- Updated dependencies [f3216d0]
- Updated dependencies [75b1b36]
- Updated dependencies [7f204ac]
- Updated dependencies [ee1e737]
- Updated dependencies [9d2a864]
- Updated dependencies [9d2a864]
- Updated dependencies [4e15bd1]
- Updated dependencies [bce497c]
- Updated dependencies [ac05f56]
- Updated dependencies [bb0da88]
- Updated dependencies [8a4734a]
- Updated dependencies [f686a47]
- Updated dependencies [48d9bea]
- Updated dependencies [2dce8af]
- Updated dependencies [c760b08]
- Updated dependencies [0de4f8d]
- Updated dependencies [ea7f074]
- Updated dependencies [784639a]
- Updated dependencies [095a866]
- Updated dependencies [1f189d8]
- Updated dependencies [1b61d3e]
- Updated dependencies [c04622e]
- Updated dependencies [d72fb3d]
- Updated dependencies [07eff2f]
- Updated dependencies [9c6253e]
- Updated dependencies [82d87eb]
- Updated dependencies [fc7d990]
- Updated dependencies [596b4cd]
- Updated dependencies [894b927]
- Updated dependencies [751eae5]
- Updated dependencies [633d73b]
- Updated dependencies [633d73b]
- Updated dependencies [59c2709]
- Updated dependencies [99593eb]
- Updated dependencies [c97d084]
- Updated dependencies [79bc411]
- Updated dependencies [190bb99]
- Updated dependencies [259f896]
- Updated dependencies [61af5e2]
- Updated dependencies [a0377de]
- Updated dependencies [73cadb2]
- Updated dependencies [9c90e25]
- Updated dependencies [0435d00]
- Updated dependencies [d615c72]
- Updated dependencies [e12e6d6]
- Updated dependencies [1df35b8]
- Updated dependencies [7d7600d]
- Updated dependencies [9178d46]
- Updated dependencies [5e51183]
  - @tula-tech/contract@0.1.0
  - @tula-tech/core@0.1.0

## 0.1.0-alpha.1

### Patch Changes

- @tula-tech/contract@0.1.0-alpha.1
  - @tula-tech/core@0.1.0-alpha.1

## 0.1.0-alpha.0

### Minor Changes

- 14a7d02: A new package, `@tula-tech/expo-screens`: Tula's SwiftUI screens (iOS) and Compose screens
  (Android) as two React Native views, `<TulaAuthView>` and `<TulaAccountView>`, with the
  same props on both platforms, set up with `createTulaScreens()`. They run on the native
  client, which owns the session: the refresh token stays in the Keychain or sealed by a
  Keystore key and never crosses to JavaScript, an access token crosses only as the answer of
  `getToken()`, and a failure crosses as its code. A theme is given in the tokens of
  `@tula-tech/contract/theme` and every value is checked before it reaches a native view
  (`checkTheme`). Where the app goes after a sign-in is the `onSignedIn` callback and nothing
  else.
  
  It is a package of its own, and not an entry point of `@tula-tech/expo`, because Expo links a
  package's native module into every app that installs the package: the module (`ios/`,
  `android/`, with copies of the native SDKs' sources) is compiled only by an app that
  installed `@tula-tech/expo-screens` for the screens. `@tula-tech/expo` is unchanged, stays headless,
  and neither package depends on the other. An app uses these screens or the headless
  client, not both.
  
  The Android module declares `minSdkVersion 28` itself. The config plugin,
  `@tula-tech/expo-screens/plugin` (no options, imports nothing), raises an Android project's
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

### Patch Changes

- Updated dependencies [a036657]
- Updated dependencies [a34eb0e]
- Updated dependencies [b38efc0]
- Updated dependencies [1c76ead]
- Updated dependencies [55115bc]
- Updated dependencies [0a5e496]
- Updated dependencies [9166270]
- Updated dependencies [ac15d68]
- Updated dependencies [462aee1]
- Updated dependencies [d013691]
- Updated dependencies [f3216d0]
- Updated dependencies [75b1b36]
- Updated dependencies [7f204ac]
- Updated dependencies [ee1e737]
- Updated dependencies [9d2a864]
- Updated dependencies [9d2a864]
- Updated dependencies [4e15bd1]
- Updated dependencies [bce497c]
- Updated dependencies [ac05f56]
- Updated dependencies [bb0da88]
- Updated dependencies [8a4734a]
- Updated dependencies [f686a47]
- Updated dependencies [48d9bea]
- Updated dependencies [2dce8af]
- Updated dependencies [c760b08]
- Updated dependencies [0de4f8d]
- Updated dependencies [ea7f074]
- Updated dependencies [784639a]
- Updated dependencies [095a866]
- Updated dependencies [1f189d8]
- Updated dependencies [1b61d3e]
- Updated dependencies [c04622e]
- Updated dependencies [d72fb3d]
- Updated dependencies [07eff2f]
- Updated dependencies [9c6253e]
- Updated dependencies [82d87eb]
- Updated dependencies [fc7d990]
- Updated dependencies [596b4cd]
- Updated dependencies [894b927]
- Updated dependencies [751eae5]
- Updated dependencies [633d73b]
- Updated dependencies [633d73b]
- Updated dependencies [59c2709]
- Updated dependencies [99593eb]
- Updated dependencies [c97d084]
- Updated dependencies [79bc411]
- Updated dependencies [190bb99]
- Updated dependencies [259f896]
- Updated dependencies [61af5e2]
- Updated dependencies [a0377de]
- Updated dependencies [73cadb2]
- Updated dependencies [9c90e25]
- Updated dependencies [0435d00]
- Updated dependencies [d615c72]
- Updated dependencies [e12e6d6]
- Updated dependencies [1df35b8]
- Updated dependencies [7d7600d]
- Updated dependencies [9178d46]
- Updated dependencies [5e51183]
  - @tula-tech/contract@0.1.0-alpha.0
  - @tula-tech/core@0.1.0-alpha.0
