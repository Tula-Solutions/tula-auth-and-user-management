# ADR 0063 — Tula's native screens in an Expo app

- Status: accepted
- Ticket: TULA-62

## Context

`@tula/expo` is headless ([ADR 0046](0046-expo-sdk.md)): a client, a provider and hooks, and
every screen is the app's. The Swift and Kotlin SDKs have since gained screens of their own:
`TulaAuthView` and `TulaAccountView` in SwiftUI ([ADR 0057](0057-swiftui-screens.md),
[ADR 0060](0060-swiftui-second-step-and-account.md)), `TulaAuth` and `TulaAccount` in
Compose ([ADR 0061](0061-compose-screens.md),
[ADR 0062](0062-compose-second-step-and-account.md)). An Expo app that wants prebuilt
screens should get those, and not a third set written in React Native: a third set is a
third place for every rule of the first two (what is emptied when, what is never texted by
arriving, what "not supported" is), and a third thing nobody has run on a phone.

Those screens are not free-standing views. Each is drawn on its platform's `TulaClient`,
which keeps the refresh token, refreshes it and holds the flows. `@tula/expo`'s headless
client is `@tula/core`'s, with its own stored token. So "show the native screens in an Expo
app" is first a question of which client owns the session, and only then of how a SwiftUI
or a Compose screen becomes a React Native view.

Nothing of the native SDKs is published: there is no pod and no Maven artifact an Expo app
could ask for.

## Decision

### An entry point of its own, and the package's own native module

`@tula/expo/native-screens` is a seventh entry point that imports a native package, and the
only one that imports `expo` (for `requireNativeModule` and `requireNativeView`; it also
reads `Platform` from `react-native`). No other source of the package imports it
(`package.test.ts`), so an app on the headless client never loads it. What can be tested
without a native module is in `native-screens-core.ts`, which takes the module and the two
views as arguments; the tests hand it fakes.

The native module is **the package's own**: `ios/` and `android/` of `@tula/expo`, named by
`expo-module.config.json` and linked by Expo's autolinking. This is new for the package,
which until now called other packages' native modules and shipped none.

`expo` is an optional peer here and when published: an app on the headless client alone
does not need the module API.

### The native SDKs' sources are copied into the package when it is built

`scripts/vendor-native.ts` (the package's `prebuild` script) copies the `.swift` files of
`native/swift/Sources/{TulaAuth,TulaAuthUI}` to `ios/vendor/` and the `.kt` files of the
four Gradle modules' `src/main/kotlin` to `android/vendor/`. The copies are ignored by git,
never edited, and packed (`files` lists `ios` and `android`). On iOS they are two pods
beside the module's (`TulaAuth`, `TulaAuthUI`, under the libraries' own module names, so
the sources compile unchanged); on Android they are source directories of the module's one
Gradle library, compiled with the app's own Kotlin and Android Gradle plugin and with the
Compose and serialization compiler plugins at the app's Kotlin version. Only `.swift` and
`.kt` files are taken, and a symbolic link under a source stops the copy.

**Nothing of `TulaAuth`, `TulaAuthUI`, `tula-auth`, `tula-auth-ui`, `tula-auth-android` or
`tula-auth-compose` was changed or made public for this.** The module uses their public
API, as an app would.

Alternatives:

- **Depend on published artifacts** (a pod, a Maven coordinate). The right shape once the
  native SDKs are published; today there is nothing to depend on, and publishing them is a
  release decision of its own ([releasing.md](../releasing.md)). When they are, the vendored
  directories give way to two dependencies and this section is rewritten.
- **A path from the app into a checkout** (a `:path` pod, an included Gradle build). Works
  only for an app inside this repository.
- **Commit the copies.** Two copies of every native source in the tree, kept equal by a
  test. The copy made at build time cannot drift from what is packed.
- **Swift Package Manager for the iOS half.** An Expo module is a pod; mixing a Swift
  package into a CocoaPods-built app is not something Expo's tooling does for a module.

The cost: the Android half is compiled with whatever Kotlin, Android Gradle plugin and
Compose the app has, not with the versions the SDK's own build pins. It was compiled once
with one set (below). The module's Gradle file names its libraries' versions itself, and
they have to be kept in step with `native/android/gradle/libs.versions.toml` by hand.

### One session owner: the native client

The native screens run on the native `TulaClient`, and **that client owns the session**:
the refresh token is in its storage (the Keychain on iOS, an entry sealed by a Keystore key
on Android: the SDKs' own default and `KeystoreTokenStorage`), it refreshes, it binds a
session to a device key. JavaScript holds no second copy of the session. What it keeps is
the last *state* the native client told it: a status, the session's id and the user's id.

`createTulaScreens(options)` makes that client, once for the process. The options are
strings and booleans (`SCREENS_OPTION_TYPES`): the key, the address, a session profile, and
switches for what the screens may offer (`deviceBinding`, `passkeys`, `apple`, `browser`,
and on Android `googleWebClientId`). The native side builds the SDK's own adapters for what
is switched on. An option that would hand over a storage, a key store or `fetch` is refused
by name, as `createTulaExpoClient` refuses `client`, `storage` and `deviceKey`.

`configure` is synchronous and the client is one per process: called again with the same
options (a JavaScript reload keeps the native process) it does nothing; with other options
it is refused (`screens.already_configured`). Two native clients over one stored token would
each refresh it, and the second refresh is a reuse.

**An app is on the native screens or on the headless client, and nothing enforces it.** The
two are different clients with different stored tokens; an app that makes both has two
sessions. A guard was considered (a registry both entry points write to, so that the second
`create…` throws) and not built: the headless client's module would have to know of an
entry point it must not import, or both would need a third shared module with state, for a
mistake the docs name and the example avoids by loading one root. It is the first thing to
revisit if the mistake is seen.

Alternatives for the owner:

- **JavaScript owns the session and hands the native screens a token.** The native screens
  are written on `TulaClient` and cannot run on a token alone; it would mean a refresh
  token crossing the bridge, and two things that can refresh it.
- **Both own it, kept in step.** Two copies of a rotating, single-use token are the thing
  the session rules exist to prevent.
- **The headless hooks re-implemented over the native client** (so that `useAuth()` and the
  flow hooks work with either owner). A second implementation of every hook over a bridge,
  for an app that chose the native screens precisely not to draw flows. Not built; the
  facade below is what such an app needs.

### What crosses to JavaScript, and what never does

| | Crosses | How |
| --- | --- | --- |
| The session's state | A status and two ids | `getState`, `load`, and the event `onSessionChange` |
| An access token | Yes, **on request only** | The answer of `getToken()` |
| The refresh token | **Never** | No function returns it; no event or prop holds it |
| A password, a code, a setup key, backup codes | Never | They are the native screens' |
| A failure | Its code | The native error's `code`; the sentence is JavaScript's |
| Completion | Nothing | `onSignedIn`, `onSignedOut`: events with an empty body |

**The access token crosses on request.** An app on the native screens still calls its own
backend from JavaScript and needs a bearer token for it. `getToken()` asks the native
client, which refreshes when it has to, and returns the answer; JavaScript does not keep
it. The alternatives were to have no such call (the app could then not call its backend
from JavaScript at all, or would add a native module of its own to do exactly this) and to
push tokens in an event as they change (a token in every listener and in the bridge's
queue, whether or not anybody wants one). On request, it is where `@tula/core`'s
`getToken()` already puts an access token: in the caller's hands, for about a minute.

**A failure crosses as a code.** The native module throws one exception type with a fixed
sentence around a code. The code is the client's own or the contract's
(`TulaError.code`); JavaScript looks the sentence up (`SCREENS_MESSAGES`, then
`@tula/core`'s table) and a code with no sentence is `internal`. So a server's `detail`
for a code this version does not know, a framework's error text and an exception's message
never reach JavaScript, and the `TulaError` has no `cause`. The module logs nothing.

The module's own codes are four: `screens.not_configured`, `screens.already_configured`,
`screens.invalid_options` and `screens.unsupported`. They are client codes of this entry
point, like `@tula/core`'s `network.failed`: not in the contract, never sent by a server.

### The same props on both platforms, and the destination is a callback

`<TulaAuthView tula mode redirectUrl onSignedIn theme onThemeRefused style testID>` and
`<TulaAccountView tula onSignedOut theme onThemeRefused style testID>`. Both platforms'
views take the same props under the same names; `native-screens-sources.test.ts` reads the
Swift and the Kotlin module and holds the module's name, its two views, functions, events,
props, option names, codes and theme tokens equal to the JavaScript's.

**Where the app goes after a sign-in is `onSignedIn`, and nothing else.** Neither view
takes a destination, the native views read no URL, intent or deep link, and the events
carry nothing. `redirectUrl` is the one address a view is given: where a provider's page
returns to, passed to the native screens as the app wrote it and judged by the server
alone, as in every client.

No `strings` prop. The native screens' words are tables of their own (`TulaStrings`); a
prop would be text from a JavaScript bundle drawn by a native screen, with the placeholder
and length questions that go with it. English only is the stated cost, and a decision for
later.

### A theme value is validated twice

`theme` takes `ThemeOverrides` of `@tula/contract/theme`. `checkTheme` walks the contract's
`THEME_TOKENS`, keeps a value only when it is a string that `isValidThemeValue` accepts for
its token's type, and leaves out everything else, a key that is no token included. What it
left out is named by token (`light.primary`; `(unknown)` for a key that is no token, whose
name is the caller's own text) through `onThemeRefused`, never by value. The native side
gets a plain map of strings and treats it as untrusted again: it fills the SDK's theme type
by token name and the SDK's own `TulaResolvedTheme` applies its copy of the grammar and its
conversion, which refuses what it cannot draw. A value refused there is the default's and
is not reported back.

`@tula/contract` became a dependency of `@tula/expo` for this (it was reached only through
`@tula/core` before). The entry point used is the Zod-free `@tula/contract/theme`.

### The config plugin raises Android's lowest version, and writes one line to do it

The Kotlin SDK needs Android 9 (API 28: `java.time`, `Base64`, StrongBox) and an Expo
project's default is lower. `withTula(config, { nativeScreens: true })` sets
`mods.android.gradleProperties`, the one mod the plugin sets, to a function that raises
`android.minSdkVersion` to 28 in the lines Expo hands it and calls the mod that was there
before. It never lowers a value, and applying the plugin twice chains one function. The
plugin still imports nothing (the mod is a plain function; `@expo/config-plugins` is not
needed to write it).

The module also refuses by itself below API 28 (`screens.unsupported`), because an app can
be built without the plugin; and lint's `NewApi` findings at a lower `minSdk` are the
reason it has to.

Nothing is written for iOS: the pods say their own lowest version (16.0).

## What was compiled, and what was not

The whole list, with commands and versions, is
[the Phase 2 list](../plans/phase-2-unverified.md#step-216-the-expo-native-screens-tula-62-adr-0063).
In short, in a scratch Expo SDK 57 app outside the repository:

- **Android**: the module with the four vendored source sets compiled, assembled and was
  linted.
- **iOS**: the two vendored libraries compiled as pods for the simulator; the module's
  Expo-free file type-checked against the two libraries; **the file that uses Expo's module
  API was not compiled** (`expo-modules-jsi` needs Swift 6.2; the machine had Xcode 16.4). It is
  written against Expo's interface as read.
- **Expo ran the config plugin** in `expo prebuild`.
- **Nothing was run**: no app was built to the end, no screen was drawn through this entry
  point, no JavaScript of it was bundled by Metro, and no test in the repository loads the
  native module. `verify` has neither toolchain: it holds the names the two sides exchange
  to each other, from the sources' text.

## Not decided here

- **Publishing the native SDKs**, after which the vendoring goes.
- **A guard against two session owners** in one app.
- **A `strings` prop**, and any other way for JavaScript to hand a native screen text.
- **Slots.** The SwiftUI and Compose slots take native views; a React Native child inside
  a native screen is a different mechanism on each platform.
- **A column for these screens in `conformance/client-journeys.json`.** The flows are the
  Swift and Kotlin clients', whose columns exist; what is new here is a bridge, and its
  tests are the package's own.
- **The hooks over the native client.**
