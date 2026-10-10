---
'@tula/core': minor
'@tula/expo': minor
---

Passkeys and sign-in with a provider in an Expo app ([docs/expo.md](../docs/expo.md),
ADR 0048). **Neither has been run on a device, a simulator or in Expo Go**: both are tested
with stand-ins for the passkey sheet and the system browser
(`docs/plans/phase-2-unverified.md`).

`@tula/core`:

- `Environment.passkeyProvider` (`PasskeyProvider`: `create` and `get`, WebAuthn's JSON
  forms in and out): where a client's environment has one, a passkey is asked of it
  instead of `navigator.credentials`. A browser's client is unchanged.
- `createTulaClientWithEnvironment(options, environment)` and `runtimeEnvironment()`, for
  a package that builds a client for a runtime without a browser's globals, and the
  environment's types.

`@tula/expo`:

- `createTulaExpoClient({ passkeys, browser })`: a passkey sheet (`PasskeySheet`) and a
  system browser session (`BrowserSession`), both optional. `@tula/expo/passkeys`
  (`passkeySheet`, over `react-native-passkey` 3.6 or later; a development build) and
  `@tula/expo/browser` (`systemBrowser`, over `expo-web-browser`) are adapters, each an
  entry point with an optional peer, so an app installs only what it offers.
- `useSignIn().withPasskey()`, `submitSecondFactorWithPasskey()` (also on
  `useResetPassword`), and `usePasskeys()`: `supported`, `add()` and `stepUp()`. One
  passkey request at a time; a dismissed sheet sets `dismissed` and never `error`.
- `useSignIn().withProvider({ provider, redirectUrl })` and `retryProvider()`, and outside
  a component `signInWithProvider`, `linkProvider` and `retryProviderSignIn`. The
  provider's page opens in the system browser and returns to the app's custom scheme or
  `https` app link; the ticket is exchanged with a binding kept in memory only. A returned
  URL that is not the redirect URL asked for, one with no answer, and a ticket this client
  did not start are refused without a request. The server's
  `request.redirect_not_allowed` is passed on with its `params.reason`.
- `flowScreen(step, ways)`: a passkey and a provider count as ways only for a client that
  can do them.
- An emailed link is still not offered: asking for one fails with `storage.failed` before
  any request, and the code in the same email is the way.
