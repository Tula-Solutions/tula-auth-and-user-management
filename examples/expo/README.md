# @tula/expo example (Expo SDK 57)

A small Expo app whose authentication is only `@tula/expo`: it signs up with an email
address and a password, signs in with a password or an emailed code, and stays signed in
when it is closed and opened again. `@tula/expo` has no screens, so the app draws its own
from the step the server answers (`app/src/screens.tsx`); a step it has no screen for is
drawn as "not supported".

| File | What it shows |
| --- | --- |
| `app/src/tula.ts` | The one client of the app (`createTulaExpoClient`). |
| `app/App.tsx` | `<TulaProvider>` and the switch between loading, signed out and signed in. |
| `app/src/screens.tsx` | Sign-up, sign-in and the signed-in screen, drawn from `flowScreen`. |
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
bun install --cwd examples/expo/app  # Expo, React Native and the three tarballs
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

```bash
bun run --cwd examples/expo/app start     # then scan the code with Expo Go, or press i / a
bun run --cwd examples/expo/app typecheck # against the real Expo and React Native types
bun run --cwd examples/expo/app bundle    # what Metro makes for iOS and Android
```

A native app sends no `Origin`, so the environment's allowed origins do not apply to it.
iOS refuses plain `http` to anything but a local address in a release build; a deployed
API is `https`.

## What was run, and what was not

Checked on 2026-10-10, on Expo 57.0.27, `expo-secure-store` 57.0.4, React Native 0.86.3 and
React 19.2.3 (the versions Expo SDK 57 pins), in a copy of `app/` outside the repository:

- `bun install` with the three packed packages: installs.
- `tsc --noEmit` against the real declarations: no error.
- `expo export --platform ios --platform android`: Metro bundles both (iOS 595 modules,
  Android 582).

**Not run: the app itself.** It was not opened in Expo Go, in a simulator or an emulator,
or on a device, so no screen of it has been seen and no value has been written to a real
Keychain or Keystore. The flows it uses are tested against the real API in process with a
stand-in for the secure store (`packages/expo/src/journeys.test.ts`).
[The Phase 2 list](../../docs/plans/phase-2-unverified.md) has every item.
