# @tula/expo example (Expo SDK 57)

A small Expo app whose authentication is only `@tula/expo`: it signs up with an email
address and a password, signs in with a password, an emailed code, an emailed link, a passkey, a provider or
Apple's and Google's own sheets, adds a passkey to the signed-in account, and stays signed
in when it is closed and opened again, with a session bound to a key the device keeps. `@tula/expo` has no screens, so the app draws its own
from the step the server answers (`app/src/screens.tsx`); a step it has no screen for is
drawn as "not supported".

| File | What it shows |
| --- | --- |
| `app/src/tula.ts` | The one client of the app (`createTulaExpoClient`), with its passkey sheet, its browser, Apple's and Google's sheets and the device's key store, the redirect URL of a provider sign-in and the app link of an emailed link. |
| `app/app.config.ts` | The app's native configuration on top of `app.json`: `withTula` from `@tula/expo/plugin`, given the domain, Google's client ids and the emailed link's app link once. |
| `app/App.tsx` | `<TulaProvider>` and the switch between loading, signed out and signed in. |
| `app/src/screens.tsx` | Sign-up, sign-in and the signed-in screen, drawn from `flowScreen`. |
| `app/src/ways.tsx` | "Sign in with a passkey", "Sign in with Apple" and "Sign in with Google" (their own sheets, drawn only where the sheet is there), "Continue with Google" (the browser), "Email me a link instead" with the hook that hands the app's incoming URLs to the sign-in, and "Add a passkey" on the signed-in screen. |
| `app/src/ui.tsx` | The app's own fields and buttons. Nothing of Tula's. |

## Why the app is in `app/` and not a workspace package

Expo and React Native are about 500 packages. As a workspace package the app would put all
of them into every install of the repository and into `bun.lock`, for an app nothing in
`bun run verify` can start ([ADR 0046](../../docs/adr/0046-expo-sdk.md)). So this directory
has no `package.json`, the workspace does not see it, and the app in `app/` installs by
itself.

What the repository does check, on every `bun run verify`: the app's sources are compiled
(`tsconfig.json` here, part of `typecheck:scripts`) against `@tula/expo`'s own sources and
against `shims.d.ts`, which declares the few members of `react-native` and `expo` the app
uses. That catches a call of `@tula/expo` that no longer compiles. It does not check the
app against React Native's real types; the next section does.

## Run it

`@tula/expo` is not published yet, so the app installs the packed packages of this
checkout. From the repository root:

```bash
bun install
bun run packages:check               # writes .release/tula-{contract,core,expo}-0.0.0.tgz
bun install --cwd examples/expo/app  # Expo, React Native, the native modules and the three tarballs
```

Start a Tula API ([the React example](../react-vite/README.md#run-it-against-a-local-api)
has the steps) and make a publishable key. Then copy `app/.env.example` to `app/.env.local`
and fill in both values:

- `EXPO_PUBLIC_TULA_API_URL` is the API **as the phone reaches it**. On a device
  `localhost` is the phone itself: use the computer's address on the network
  (`http://192.168.…:3003`), and start the API so that it listens there. The Android
  emulator reaches the computer as `http://10.0.2.2:3003`; the iOS simulator shares the
  computer's `localhost`.
- `EXPO_PUBLIC_TULA_PUBLISHABLE_KEY` is the environment's publishable key. It is public by
  design and ends up in the app's bundle. Never put a secret key in an `EXPO_PUBLIC_*`
  variable.

Started without one of them, or with a value the client refuses (an address that is no
URL, a secret key), the app draws a screen titled "Set up .env.local" that names the
variable that is not set, and no value: the client is made while the app's first module
loads, and thrown from there the same mistake would be a red screen with a stack trace
(`app/src/tula.ts`). Expo reads `.env.local` when it starts, so a change needs a restart
of `expo start`. A value that is well formed and wrong (a key of another environment, an
address nothing answers at) cannot be seen when the client is made: the app then stays on
"Loading…" and says why under it, from `useAuth().loadError`, while it keeps trying.

Four more variables are optional, and are read by `app/app.config.ts` (for the native
configuration) and by `app/src/tula.ts` (for the client), so each is written once:

- `EXPO_PUBLIC_TULA_DOMAIN`: the domain the app shares credentials with (the
  environment's `passkeys.rpId`). Unset, the app has no associated domain.
- `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID` and `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID`: Google's OAuth
  client ids, for its own sheet. Unset, the app offers no "Sign in with Google" sheet.
  Neither is a secret.
- `EXPO_PUBLIC_TULA_EMAIL_LINK_URL`: the app link an emailed sign-in link leads to
  ([below](#an-emailed-link)). Unset, the app asks for no link.

**The app needs a development build; Expo Go cannot run it.** Passkeys come from
`react-native-passkey`, Google's sheet from `react-native-nitro-google-signin` and the
device key from `@pagopa/io-react-native-crypto`: native modules Expo Go does not
contain, and the app imports all three (`@tula/expo/passkeys`, `@tula/expo/google` and
`@tula/expo/device-key`, in `app/src/tula.ts`). Build the app once with
`bunx expo run:ios` or `bunx expo run:android` in `app/`, then start it as below. To try
the password and the emailed code in Expo Go instead, take the `passkeys`, `google` and
`deviceKeys` lines and their imports out of `app/src/tula.ts` (the import of
`@tula/expo/google` alone would stop the app from starting there, by the Google module's
source: not tried): the buttons then
leave the screens by themselves, and the session is not bound.
**No such build has been completed** ([below](#what-was-run-and-what-was-not)): what the
iOS one needs is the next section, and the Android one was not tried.

```bash
bun run --cwd examples/expo/app start     # for the development build; press i / a
bun run --cwd examples/expo/app typecheck # against the real Expo and React Native types
bun run --cwd examples/expo/app bundle    # what Metro makes for iOS and Android
```

Expo SDK 57 pins TypeScript `~6.0.3` and the app asks for `^5.9.0`: the typecheck passes
with what that installs. A known mismatch, left as it is.

A native app sends no `Origin`, so the environment's allowed origins do not apply to it.
iOS refuses plain `http` to anything but a local address in a release build; a deployed
API is `https`.

## Building for iOS

Seen on one Mac, on 2026-10-12. The build did not complete there, so this is what is known
to be needed, not a list that is known to be enough.

- **Swift 6.2, which Xcode 26 is said to ship (Xcode 26 was not tried).** With Xcode 16.4 (Swift 6.1.2) the build fails in the
  phase `[CP-User] Build ExpoModulesJSI xcframework`:

  ```text
  package 'apple' is using Swift tools version 6.2.0 but the installed version is 6.1.0
  ```

  `expo-modules-jsi` 57.1.2 is compiled from source during the build, and its
  `apple/Package.swift` declares Swift tools version 6.2. The xcframework in the npm
  package is a stub, so there is nothing prebuilt to fall back on.
- **CocoaPods.** `pod install` succeeded with 1.17.0.
- **`node` on `PATH`**, also when the app is driven with `bun`: the generated Podfile and
  the script that builds the JSI framework both call `node`.

**What a build writes into the checkout.** `bunx expo run:ios` in `app/`
writes an `ios/` directory and rewrites two scripts of `app/package.json`: `ios` and
`android` become `expo run:ios` and `expo run:android` (they are `expo start --ios` and
`expo start --android`). `app/.gitignore` lists `ios/` and `android/`, so the directory
stays out of a commit; the two scripts do not, so put them back
(`git restore examples/expo/app/package.json`) before committing. Or build in a copy of
`app/` outside the repository, where neither matters: the three `file:` paths in its
`package.json` (and the two under `overrides`) then have to point at the tarballs in
`.release/`.

## A passkey and a provider

Both need more than the two values above, and neither works against a bare local API.

**A provider.** `app/src/tula.ts` returns to `com.example.tula:/oauth/callback` (the app's
`scheme` in `app/app.json`). Add exactly that string to the environment's allowed redirect
URLs and switch a provider on. A custom scheme is accepted for a provider that binds its
code with PKCE (Google, GitHub, Microsoft, Discord, X) and refused for Apple, LinkedIn and
Facebook, which need an `https` app link
([docs/expo.md](../../docs/expo.md#sign-in-with-a-provider)). The browser that opens is the
phone's: the API's address has to be one that browser reaches too, and the mock provider
(`OAUTH_MOCK_PROVIDER`) is served only on a loopback address, so it is of use in the iOS
simulator and not on a device.

**A passkey.** The platforms tie a passkey to a domain the app is associated with, over
`https`: there is no passkey for `localhost` or for an address on the local network. It
takes a public `https` address for the API's association files (a tunnel will do), that
domain as the environment's `passkeys.rpId` and in its allowed origins, the app registered
under **Native apps** (the bundle ID and team of `app/app.json`, or the package name and
the signing certificate's SHA-256 fingerprint), and the domain in the app's own
configuration (`webcredentials:<domain>` under Associated Domains on iOS; Android reads
`assetlinks.json` from the domain). [docs/native-apps.md](../../docs/native-apps.md) and
[docs/expo.md](../../docs/expo.md#passkeys) have the steps.

## Apple's and Google's own sheets, and the device key

**None of this was run**: not installed, not bundled, not built, and no sheet was shown
([below](#what-was-run-and-what-was-not)).

**Sign in with Apple** needs the Apple provider enabled, and this app registered under
**Native apps** as an iOS app: its bundle ID (`app/app.json`) is the audience the server
accepts in Apple's token. `app/app.config.ts` asks `withTula` for the entitlement. iOS
only: on Android the button is not drawn.

**Sign in with Google** needs the Google provider enabled with the **web** client id as
its `clientId` (or among its `additionalClientIds`), and the two variables above. On iOS
the Google module's own config plugin is given the reversed iOS client id by
`app/app.config.ts`.

**The device key** needs nothing of the environment while its session profile's
`deviceBinding` is `optional` (the default for a native client). The signed-in screen
says "bound to a device key" for a session that is. Under `none` take the `deviceKeys`
line out of `app/src/tula.ts`: the server refuses a sign-in that brings a proof.
[docs/expo.md](../../docs/expo.md#a-session-bound-to-a-device-key) says what happens
when the key is lost.

## An emailed link

**None of this was run**: no emailed link ever opened this app
([below](#what-was-run-and-what-was-not)).

Where the environment offers the emailed link (`signIn.methods.emailLink`) and
`EXPO_PUBLIC_TULA_EMAIL_LINK_URL` is set, the sign-in screen has "Email me a link
instead". The variable is an `https` URL such as `https://app.example.com/sign-in/link`,
and three things have to agree with it:

- it is listed, character for character, among the environment's allowed redirect URLs;
- its path is among this app's `appLinkPaths` under **Native apps**, and the domain serves
  the two association files ([docs/native-apps.md](../../docs/native-apps.md));
- `app/app.config.ts` gives its domain and path to `withTula` (`appLinks`), which needs a
  new build of the app.

The link is opened by the app that asked for it, while it still runs: `app/src/ways.tsx`
hands every URL the app is opened with to `signIn.openEmailLink`. A link opened after the
app was ended, on another phone or in a browser signs nobody in and uses nothing up; the
screen then says to ask again, and the code in the same email works on any device.
"I opened the link: finish signing in" asks the sign-in to finish (`finishEmailLink`): it
is for a link that was opened while the network gave no answer, which the server may have
taken all the same, and it changes nothing where no link was taken.
[docs/expo.md](../../docs/expo.md#the-emailed-link) has the rules.

## What was run, and what was not

Checked on 2026-10-10, on Expo 57.0.27, `expo-secure-store` 57.0.4, React Native 0.86.3 and
React 19.2.3 (the versions Expo SDK 57 pins), in a copy of `app/` outside the repository:

- `bun install` with the three packed packages: installs.
- `tsc --noEmit` against the real declarations: no error.
- `expo export --platform ios --platform android`: Metro bundles both (iOS 595 modules,
  Android 593).

Those three runs were of the app as it was before its setup screen (`app/src/setup.ts`)
and before its passkey and provider screens (`app/src/ways.tsx`, with
`expo-web-browser` and `react-native-passkey`).

Run again on 2026-10-12, on one Mac, with the two native modules in the app
(`react-native-passkey`, `expo-web-browser`); the app has no lockfile, so the versions
were what the ranges in `app/package.json` gave that day:

- An install from the packed packages, with both modules: installs.
- `tsc --noEmit` against the real declarations: no error. Expo warns that it expects
  TypeScript `~6.0.3` where the app has `^5.9.0`.
- A Metro bundle for each platform: iOS 607 modules, Android 605.
- `pod install` (CocoaPods 1.17.0): succeeds.
- The iOS build (`expo run:ios`), with Xcode 16.4: **fails**, in the phase that compiles
  `expo-modules-jsi` ([Building for iOS](#building-for-ios)). It was not tried with
  Xcode 26.

**Nothing was run after Apple's and Google's sheets, the device key and `app.config.ts`
were added** (TULA-55): no install with `expo-apple-authentication`,
`react-native-nitro-google-signin`, `react-native-nitro-modules` and
`@pagopa/io-react-native-crypto`, no `tsc` against their real declarations, no Metro
bundle, no prebuild with the config plugin, no build. Their version ranges in
`app/package.json` are the registry's of 2026-10-12 and were never resolved together.
The repository compiles the app's sources against `@tula/expo`'s own sources and the
shim, and nothing more.

**Nothing was run after the emailed link was added** (TULA-73) either: no install, no
`tsc` against real declarations, no bundle, no prebuild with `appLinks`, no build. The
app's use of React Native's `Linking` is compiled against the shim's own declaration of
it.

**The iOS build never completed, so the app has never been launched**: not in a simulator,
not on a device, and (it imports a module Expo Go lacks) not in Expo Go. No screen of it
has been seen, the setup screen included: what decides the first screen is tested without
Expo (`.claude/hooks/expo-example.test.ts`). No value has been written to a real Keychain
or Keystore.

**Nothing was run for Android beyond the bundle**: no `expo run:android`, no Gradle, no
emulator.

**No passkey sheet, no system browser and no provider's sheet has been opened, and no key
was made in secure hardware.** `@tula/expo` declares the
members of the modules it calls by hand (`packages/expo/src/native-modules.d.ts`,
copied from the versions named there); whether the typecheck above compares that copy
with the real packages was not looked at.

The flows the app uses are tested against the real API in process with a
stand-in for the secure store (`packages/expo/src/journeys.test.ts`).
[The Phase 2 list](../../docs/plans/phase-2-unverified.md) has every item.
