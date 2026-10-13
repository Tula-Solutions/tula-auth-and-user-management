---
paths:
  - "packages/expo-screens/**"
  - "examples/expo/**"
  - "native/swift/Sources/TulaAuthUI/**"
  - "native/android/tula-auth-compose/**"
---

# Expo native screens

Moved here from `AGENTS.md`, word for word, and canonical for this area: `AGENTS.md` lists
this file under "Area rules" and does not repeat it. A section named in a sentence as
"above" or "below" is found through that list.

## Expo native screens (`packages/expo-screens`, see ADR 0063)

`@tula/expo-screens` (`createTulaScreens`, `<TulaAuthView>`, `<TulaAccountView>`,
`checkTheme`) shows the SwiftUI and Compose screens of the native SDKs in an Expo app,
hosted in two views of the package's own Expo module (`ios/`, `android/`,
`expo-module.config.json`), on a native client that owns the session.

- **It is a package of its own, never an entry point of `@tula/expo`, and the two do not
  depend on each other.** Expo links a package's native module into every app that
  installs the package, whatever the app imports: inside `@tula/expo` the module (Compose,
  Credential Manager, three pods, and a Swift file nobody has compiled) would be compiled
  by every headless app. **`@tula/expo` holds no `expo-module.config.json`, no `ios/`, no
  `android/`, no vendoring and no `expo` peer, and gains none** (`release.test.ts` holds
  it); what the screens need goes here. ADR 0063 has the rejected alternative.
- **Never a screen written in React Native, and never a rule of a flow in this bridge.**
  What decides is the native SDKs' models.
- **`src/index.ts` is the one file that imports `expo` (its module API) and
  `react-native` (`Platform`)**; what it does is in `src/native-screens-core.ts`, which
  takes the native module and its views as arguments, so the tests pass fakes
  (`package.test.ts`). The sources import nothing but React, `@tula/core`, the Zod-free
  `@tula/contract/theme`, those two and each other. `expo`, `react` and `react-native`
  are peers, all required when packed and the two native ones optional in the workspace:
  never add `expo`, `expo-*`, `react-native` or `react-native-*` to the `dependencies` or
  `devDependencies` of a manifest of the workspace. `src/native-modules.d.ts` declares
  what is read. Importing the package in a build without its native module (Expo Go
  among them) throws: say so wherever it is documented.
- **The native `TulaClient` owns the session, and JavaScript holds no second copy.** The
  refresh token is in the native client's storage (the Keychain; `KeystoreTokenStorage`)
  and **never crosses**: no function returns it, no event or prop holds it, and it is
  never put in the secure store, AsyncStorage or JavaScript state. What JavaScript keeps
  is the last state it was told (a status, the session's id, the user's id). An access
  token crosses only as the answer of `getToken()`, on request, and is not kept. **An
  event carries the state's body or nothing** (`onSessionChange`; `onSignedIn` and
  `onSignedOut` are empty): never a token, a code, an address or a name.
  `native-screens-sources.test.ts` holds what is sent.
- **A failure crosses as a code of a closed set, and as nothing else.** A `TulaError`'s
  code is whatever string the server sent, so each native side passes it through one
  function (`crossing`, in `TulaScreensHost` of both platforms): the module's own codes,
  the native client's own, and the codes of the generated `ErrorCode` cross as they
  are; **every other string is `internal`** (a code a newer server gained included,
  until the package is generated again: said in the docs). The exception is one type
  with one fixed sentence that does not hold the code; JavaScript finds the sentence
  (`SCREENS_MESSAGES`, then `@tula/core`'s table), with no `cause`. Every function of
  the module, `configure` included, runs inside the guard that lets only that exception
  leave. Never pass a server's `detail`, a framework's error text or an exception's
  message over the bridge, in an error, an event or a prop, never write a code into the
  sentence, and the module logs nothing. Its own codes are `screens.*`, client codes of
  this package: never added to the contract. **What holds this is the sources'
  text** (the mutation rows of `native-screens-sources.test.ts`): no error has crossed
  a real bridge, so never word it as seen.
- **The Android client outlives the React Native context that made it, so nothing of a
  context is captured when it is made.** The sheets and the browser are handed
  `Latest.read` (`Latest.kt`: plain Kotlin, a `@Volatile` holder), and **every**
  `configure` replaces the activity provider first, before any check and before the
  same-options return: after a JavaScript reload the provider of the context that is
  gone must not be asked. Never hand a sheet a provider directly, and never move the
  replacement below a return. Nothing in `verify` or CI runs Kotlin for this module:
  the sources test pins the wiring (with the row that moves the line below the return),
  and `Latest.kt` was run once by hand with `kotlinc`.
- **On iOS the module ends its watching task in `OnDestroy`**, as the Android module
  does; a new task the module starts is ended there too.
- **The options are strings and booleans** (`SCREENS_OPTION_TYPES`), and an option that
  would hand over a storage, a key store or `fetch` is refused by name
  (`DECIDED_NATIVELY`). `configure` makes one native client for the process: the same
  options again are a no-op, other options are `screens.already_configured`. Never make
  a second native client over the same stored token.
- **An app is on the native screens or on the headless client, never both, and nothing
  stops it** (two clients, two stored tokens, two sessions: each signs in by itself,
  neither is told of the other's sign-in or sign-out). The docs say so in those plain
  words, and that the Android token file is in backups unless the app excludes it
  (`docs/expo.md`, held to `DEFAULT_PREFERENCES_NAME` by
  `.claude/hooks/kotlin-journeys.test.ts`; the plugin sets no backup rule: undecided in
  ADR 0063). The
  example runs the headless root, and its other root (`examples/expo/screens`)
  is files an app does not hold until they are copied in; a guard is a decision in ADR
  0063. Never have one package depend on the other, and never copy a session between
  them.
- **The destination after a sign-in is `onSignedIn` and nothing else.** Neither view
  takes a destination; nothing reads a URL, an intent or a deep link. `redirectUrl` is
  where a provider's page returns to, passed on as written and judged by the server.
  There is no `strings` prop: text from a JavaScript bundle drawn by a native screen is
  a decision in ADR 0063.
- **A theme value is checked twice.** `checkTheme` keeps a value only when the
  contract's `isValidThemeValue` accepts it for its token (`THEME_TOKENS`; never a
  second grammar, never a key that is no token) and names what it left out by token,
  `(unknown)` for a key that is none, never by value; the native side treats what it
  gets as untrusted again and hands it to the SDK's own resolver. Never pass a theme
  to a native view by another path.
- **The native SDKs' sources are copied in when the package is built**
  (`scripts/vendor-native.ts`, the `prebuild` script: `ios/vendor`, `android/vendor`,
  ignored by git, only `.swift` and `.kt` files, a symbolic link stops it). Never edit
  or commit a copy, and never change or make public anything of `TulaAuth`,
  `TulaAuthUI`, `tula-auth`, `tula-auth-ui`, `tula-auth-android` or `tula-auth-compose`
  for the bridge: it is an app on their public API. `packages/expo-screens/turbo.json` names
  the native directories as inputs. **A source root, and every directory above it up
  to the repository's root, is a real directory or nothing is removed or copied**
  (`directoryProblem` in `scripts/vendor.ts`, `lstat` on each part and the real path
  compared, as `packages/core/scripts/native/tree.ts` does; `vendor.test.ts` runs it on
  a tree of its own). **A packed `@tula/expo-screens` holds a known source of each of the six
  copied directories or packing fails** (`REQUIRED_PACKED_FILES`, `missingPackedFiles`
  in `scripts/publish-manifest.ts`; `release.test.ts` holds the list to `VENDORED`).
- **The Android module compiles the vendored Kotlin SDK against older libraries than
  the SDK is tested on, every one of them, and says so.** They are the SDK's own
  libraries and no other, but `android/build.gradle` names versions of its own, because
  an Expo SDK 57 app's Kotlin (2.1) cannot read what the catalog's set is published
  with. Never word them as "kept in step" with
  `native/android/gradle/libs.versions.toml`: none of the SDK's tests ran against this
  set. `.claude/hooks/expo-native-libraries.test.ts` reads both files and fails for a
  shared library whose version differs without an entry that names both versions and a
  written reason, for an entry that no longer matches either file, and for a library
  the catalog does not have; Dependabot watches the file from `/packages/expo-screens/android`
  (its own group: an update there is not a routine bump, the list changes with it and
  the pair is tried in an Expo app). A reason says what was tried, never more: six of
  the eight were tried only together. **The module's build file declares
  `minSdkVersion 28`** (only an app that installed this package links it): an app with
  a lower minimum fails its manifest merge unless the plugin raised the project
  (documented behaviour of the manifest merger, not tried), and `configure` still
  refuses below API 28.
- **The two sides are held to each other from their text**: the module's name, its two
  views, functions, events, props, option names, codes and theme tokens
  (`native-screens-sources.test.ts`). A new function, prop, option or code is added on
  both platforms and in the JavaScript in one change. `verify` compiles neither half.
- **The config plugin is the package's own, `@tula/expo-screens/plugin`
  (`src/plugin.ts`: `withTulaScreens`, `withRaisedMinSdk`), under the rules of
  `@tula/expo/plugin`**: a function over the configuration that imports nothing, built
  as CommonJS and as a module (`package.test.ts` requires the built `plugin.cjs` and
  holds that it imports nothing). It takes no options: anything handed to it as options
  is refused in one fixed sentence that repeats nothing it was given. **It raises
  `android.minSdkVersion` to 28 and never lowers it** (through the one mod it sets,
  `mods.android.gradleProperties`, chained once however often the plugin is applied): a
  lower value the project had is overwritten, the one value already there that it
  changes; a value of 28 or more is the same line handed back (a test holds both); the
  object it was given is not changed. Its order against `expo-build-properties` was not
  shown: never word the plugin as winning or yielding there. **`@tula/expo/plugin` has
  no `nativeScreens` option and gets none**: an app on the headless client lists that
  plugin and never this one.
- **Never say more than was compiled** (`docs/plans/phase-2-unverified.md`, "Step
  2.16"): the Android module compiled once in a scratch Expo app **while it was still
  inside `@tula/expo`, as it was before the review's changes**; on iOS the two libraries
  compiled as pods, `TulaScreensHost.swift` was type-checked and
  **`TulaScreensModule.swift` was never compiled**. **Nothing native was compiled after
  the move into this package** (the module's own `minSdkVersion 28` among it), Expo's
  autolinking was not tried on it, and `@tula/expo-screens/plugin` was not run by Expo.
  **No screen was drawn through this package**, in a simulator, an emulator, on a phone
  or in Expo Go, no app was built and no JavaScript of it was bundled by Metro: never
  word the native screens as working, shown or tested in an Expo app until one has.
