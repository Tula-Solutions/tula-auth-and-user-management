---
'@tula/contract': minor
'@tula/core': minor
'@tula/expo': minor
---

Apple's and Google's own sign-in sheets, a session bound to a device key, and a config
plugin in an Expo app ([docs/expo.md](../docs/expo.md), ADR 0051). **None of it has been
run on a device, a simulator or in Expo Go**: no provider's sheet was shown, no key was
made in a phone's secure hardware, none of the three native modules was installed, and
Expo never ran the plugin. All of it is tested with stand-ins
(`docs/plans/phase-2-unverified.md`).

`@tula/contract`:

- `DeviceKey.proofId?()` (`@tula/contract/device-binding`): a key may bring the id of its
  proofs, for a runtime with no `crypto.getRandomValues`. Left out, nothing changes.

`@tula/core`:

- `Environment.deviceKey` (`DeviceKeySource`): for a runtime that finds its key by a call
  that takes time, the transport asks for the key before each request a key proves, and
  `undefined` means "send this one without a proof". A source that throws is
  `device.key_failed`. `createTulaClient({ deviceKey })` is unchanged.

`@tula/expo`:

- `createTulaExpoClient({ apple, google, deviceKeys })`, all optional. `@tula/expo/apple`
  (`appleSheet`, over `expo-apple-authentication`), `@tula/expo/google` (`googleSheet(ids)`,
  over `react-native-nitro-google-signin` 2.3 or later; a development build, and the
  import throws in Expo Go) and `@tula/expo/device-key` (`hardwareDeviceKeys`, over
  `@pagopa/io-react-native-crypto` 1.2.5 or later; a development build) are adapters, each
  an entry point with an optional peer.
- `useSignIn().withIdToken({ provider })` and, outside a component,
  `signInWithIdToken(client, { provider })`: the sheet is shown between the two steps of
  `@tula/core`'s `signIn.withIdToken`. For Apple the package hands the sheet the SHA-256 of
  the server's nonce and passes the sheet's name on beside the token. A dismissed sheet
  sets `dismissed` and never `error`; one sheet of any kind at a time (`flow.busy`).
- `useIdTokenProviders()`: `{ google, apple }`, `false` until the sheet is known to be
  there, so a control is hidden where the native module or the sign-in is missing.
- With `deviceKeys`, a session is bound to a key the device keeps and every refresh
  carries a proof. A stored session whose key is gone (a new key, another key, no key
  store) is dropped when the app starts, with no request: the user signs in again. A key
  store that cannot be reached is `storage.failed` and the session is kept. `deviceKey`
  is still refused as an option: an app hands over a key store (`DeviceKeyStore`).
- `@tula/expo/plugin`: `withTula(config, props)` adds Associated Domains, app-link intent
  filters, the Sign in with Apple entitlement and Google's client ids to an Expo
  configuration, and `reversedGoogleClientId(iosClientId)`. It writes no native file.
- `flowScreen(step, ways)`: a provider counts as a way for a client with a browser or
  with that provider's sheet.
