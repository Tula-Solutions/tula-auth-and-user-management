# @tula/expo

Tula for an Expo app on iOS and Android, headless: [`@tula/core`](../core/README.md)'s
client with its refresh token in the device's secure store, a provider and hooks for
sign-up, sign-in, password reset and the session. It draws no screen.

The guide is [docs/expo.md](../../docs/expo.md), the reference
[docs/reference/expo.md](../../docs/reference/expo.md), the reasoning
[ADR 0046](../../docs/adr/0046-expo-sdk.md) and the example app
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
  a URL, and `client`, `storage` and `deviceKey` are not options.
- **A secure store that fails is not "signed out"**: `storage.failed`, and the running app
  keeps its session. A refused write is tried three times, and twice more by itself within about
  six seconds; if the app is ended while the
  store still holds a token the server has replaced, and started after the grace window
  (10 seconds by default), the user signs in again. `useAuth().loadError` says why the
  first load is still failing.
- **A step it has no action for is the screen `not_supported`**, never a guess.
- **iOS and Android only.** Creating a client on another platform, Expo web included, is
  a `TypeError`.
- Works with Expo SDK 57 and needs no native module beyond `expo-secure-store`.

Not in this version: sign-in with a provider, passkeys, the emailed link, device binding.
`@tula/core`'s `signIn.withIdToken` (native Google, ADR 0045) is on the client and works
with a token your app gets itself; the package wraps no Google sheet and has no hook for it.

## Working on the package

The repository installs neither Expo nor React Native: `src/native.ts` is the one module
that imports them, against the declarations in `src/native-modules.d.ts`, and everything
else takes the platform and the store as arguments.

```bash
bun test --cwd packages/expo       # the hooks, the storage adapter, and the client journeys
bun run packages:check             # build, pack and check the published shape
```

`src/journeys.test.ts` runs the journeys every client is held to
(`conformance/client-journeys.json`, column `expo`) through this package against the real
API in process, with the DOM's globals taken away. **None of it runs on a phone**: what
was and was not run against real Expo is in
[the Phase 2 list](../../docs/plans/phase-2-unverified.md).
