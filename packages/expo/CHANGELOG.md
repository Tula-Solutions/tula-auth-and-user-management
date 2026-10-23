# @tula-tech/expo

## 0.2.0

### Patch Changes

- @tula-tech/core@0.2.0

## 0.1.1

### Patch Changes

- @tula-tech/core@0.1.1

## 0.1.0

### Minor Changes

- 3698877: An emailed sign-in link opened in an Expo app ([docs/expo.md](../docs/expo.md#the-emailed-link),
  ADR 0055). **No emailed link has opened an app through this package, on a phone or in a
  simulator**: it is tested against the real API in process, with the URL handed over as an
  operating system would hand it (`docs/plans/phase-2-unverified.md`).
  
  - `createTulaExpoClient({ emailLinkUrl })`: the one `https` app link the app's emailed
    links lead to, with no query, fragment, user name, backslash or white space. Not a
    custom scheme. Without the option nothing changes: asking for a
    link is `storage.failed` before any request, and a step that offers only a link is the
    screen `not_supported`.
  - `useSignIn()`: `prepareFirstFactor({ strategy: 'email_link' })`, `openEmailLink(url)`
    for every URL the app is opened with, and `finishEmailLink()`. Without the hooks:
    `requestEmailLink`, `openEmailLink`, `isEmailLink`, and the type `EmailLinkOutcome`.
  - A URL is sent to the server only when it is `emailLinkUrl`, character for character,
    followed by a link of the sign-in that asked, while the client still keeps that link's
    binding. Anything else is refused without a request and uses nothing up.
  - A link whose request got no answer (`network.failed`, `network.timeout`) may have been
    taken all the same, and the same URL is then `verification.expired`. Nothing is asked on
    a guess: `finishEmailLink()` is what to try after either, and it changes nothing where
    the link was not taken.
  - The binding is kept in memory only, for fifteen minutes at most: never in the secure
    store, a file, a log line, an error or a URL. **A link opened after the app was ended
    and started again signs nobody in**: the user asks again. The code in the same email
    works on any device.
  - `flowScreen` counts `email_link` as a way for a client that has `emailLinkUrl`
    (`FlowWays.emailLink`).
  
  The server and `@tula-tech/core` are unchanged.
- ac05f56: Apple's and Google's own sign-in sheets, a session bound to a device key, and a config
  plugin in an Expo app ([docs/expo.md](../docs/expo.md), ADR 0052). **None of it has been
  run on a device, a simulator or in Expo Go**: no provider's sheet was shown, no key was
  made in a phone's secure hardware, none of the three native modules was installed, and
  Expo never ran the plugin. All of it is tested with stand-ins
  (`docs/plans/phase-2-unverified.md`).
  
  `@tula-tech/contract`:
  
  - `DeviceKey.proofId?()` (`@tula-tech/contract/device-binding`): a key may bring the id of its
    proofs, for a runtime with no `crypto.getRandomValues`. Left out, nothing changes.
  
  `@tula-tech/core`:
  
  - `Environment.deviceKey` (`DeviceKeySource`): for a runtime that finds its key by a call
    that takes time, the transport asks for the key before each request a key proves, and
    `undefined` means "send this one without a proof". A source that throws is
    `device.key_failed`. Finding the key and signing with it are inside the call's
    deadline: a key store that never answers is `network.timeout`, with nothing sent. `createTulaClient({ deviceKey })` is unchanged.
  
  `@tula-tech/expo`:
  
  - `createTulaExpoClient({ apple, google, deviceKeys })`, all optional. `@tula-tech/expo/apple`
    (`appleSheet`, over `expo-apple-authentication`), `@tula-tech/expo/google` (`googleSheet(ids)`,
    over `react-native-nitro-google-signin` 2.3 or later; a development build, and the
    import throws in Expo Go) and `@tula-tech/expo/device-key` (`hardwareDeviceKeys`, over
    `@pagopa/io-react-native-crypto` 1.2.5 or later; a development build) are adapters, each
    an entry point with an optional peer.
  - `useSignIn().withIdToken({ provider })` and, outside a component,
    `signInWithIdToken(client, { provider })`: the sheet is shown between the two steps of
    `@tula-tech/core`'s `signIn.withIdToken`. For Apple the package hands the sheet the SHA-256 of
    the server's nonce and passes the sheet's name on beside the token. A dismissed sheet
    sets `dismissed` and never `error`; one sheet of any kind at a time (`flow.busy`).
  - `useIdTokenProviders()`: `{ google, apple }`, `false` until the sheet is known to be
    there, so a control is hidden where the native module or the sign-in is missing.
  - With `deviceKeys`, a session is bound to a key the device keeps and every refresh
    carries a proof. A stored session whose key is gone (a new key, another key, no key
    store) is dropped when the app starts, with no request: the user signs in again. A
    token is marked as bound only when the server's answer says it is, and a key is made
    only after the key store said "not found" twice. A key
    store that cannot be reached is `storage.failed` and the session is kept. `deviceKey`
    is still refused as an option: an app hands over a key store (`DeviceKeyStore`).
  - `@tula-tech/expo/plugin`: `withTula(config, props)` adds Associated Domains, app-link intent
    filters, the Sign in with Apple entitlement and Google's client ids to an Expo
    configuration, and `reversedGoogleClientId(iosClientId)`. It writes no native file.
  - `flowScreen(step, ways)`: a provider counts as a way for a client with a browser or
    with that provider's sheet.
- bb0da88: Passkeys and sign-in with a provider in an Expo app ([docs/expo.md](../docs/expo.md),
  ADR 0048). **Neither has been run on a device, a simulator or in Expo Go**: both are tested
  with stand-ins for the passkey sheet and the system browser
  (`docs/plans/phase-2-unverified.md`).
  
  `@tula-tech/core`:
  
  - `Environment.passkeyProvider` (`PasskeyProvider`: `create` and `get`, WebAuthn's JSON
    forms in and out): where a client's environment has one, a passkey is asked of it
    instead of `navigator.credentials`. A browser's client is unchanged.
  - `createTulaClientWithEnvironment(options, environment)` and `runtimeEnvironment()`, for
    a package that builds a client for a runtime without a browser's globals, and the
    environment's types.
  
  `@tula-tech/expo`:
  
  - `createTulaExpoClient({ passkeys, browser })`: a passkey sheet (`PasskeySheet`) and a
    system browser session (`BrowserSession`), both optional. `@tula-tech/expo/passkeys`
    (`passkeySheet`, over `react-native-passkey` 3.6 or later; a development build) and
    `@tula-tech/expo/browser` (`systemBrowser`, over `expo-web-browser`) are adapters, each an
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
- 02ca214: `@tula-tech/expo`: the headless Expo SDK ([docs/expo.md](../docs/expo.md), ADR 0046).
  
  - `createTulaExpoClient(options)`: `@tula-tech/core`'s client as an `ios` or `android` client,
    with its refresh token in the device's secure store (`expo-secure-store`) and its access
    token in memory only. It refuses any other platform, Expo web included, and takes no
    `client`, `storage` or `deviceKey`.
  - `<TulaProvider client>` and the hooks `useAuth`, `useUser`, `useSession`, `useSignUp`,
    `useSignIn`, `useResetPassword` and `useTula`. No screen is drawn: a flow hook says which
    screen to draw (`screen`), and `not_supported` for a step, or a step whose every offered
    way, this version does not know (`flowScreen`).
  - `secureStoreStorage(store, options)` for an app that builds its own client:
    `keychainAccess` (`when_unlocked`, the default, or `after_first_unlock`; both stay on the
    device) and `keychainService`. A value over `MAX_SECURE_VALUE_BYTES` (2,048) is refused
    before the store is asked, and a store that cannot be read or written is
    `storage.failed`, never "signed out". A write the store refuses is tried three times, and twice more
    by itself within about six seconds.
  - `useAuth().loadError`: why the provider's last try to load the session failed (a
    `TulaError`, or `null`), while it keeps trying.
  
  Sign-up, sign-in with a password, an emailed or a texted code, password reset, the second
  step (authenticator app, backup code, texted code) and the session's devices. Device
  binding, passkeys and sign-in with a provider are not part of this version. Nothing of it
  has been run in Expo Go, on a simulator or on a device yet (`docs/plans/phase-2-unverified.md`).

### Patch Changes

- Updated dependencies [b38efc0]
- Updated dependencies [ac15d68]
- Updated dependencies [f3216d0]
- Updated dependencies [75b1b36]
- Updated dependencies [9d2a864]
- Updated dependencies [4e15bd1]
- Updated dependencies [ac05f56]
- Updated dependencies [bb0da88]
- Updated dependencies [8a4734a]
- Updated dependencies [f686a47]
- Updated dependencies [48d9bea]
- Updated dependencies [c760b08]
- Updated dependencies [095a866]
- Updated dependencies [1f189d8]
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
- Updated dependencies [59c2709]
- Updated dependencies [c97d084]
- Updated dependencies [190bb99]
- Updated dependencies [a0377de]
- Updated dependencies [9c90e25]
- Updated dependencies [d615c72]
- Updated dependencies [1df35b8]
- Updated dependencies [7d7600d]
- Updated dependencies [5e51183]
  - @tula-tech/core@0.1.0

## 0.1.0-alpha.1

### Patch Changes

- @tula-tech/core@0.1.0-alpha.1

## 0.1.0-alpha.0

### Minor Changes

- 3698877: An emailed sign-in link opened in an Expo app ([docs/expo.md](../docs/expo.md#the-emailed-link),
  ADR 0055). **No emailed link has opened an app through this package, on a phone or in a
  simulator**: it is tested against the real API in process, with the URL handed over as an
  operating system would hand it (`docs/plans/phase-2-unverified.md`).
  
  - `createTulaExpoClient({ emailLinkUrl })`: the one `https` app link the app's emailed
    links lead to, with no query, fragment, user name, backslash or white space. Not a
    custom scheme. Without the option nothing changes: asking for a
    link is `storage.failed` before any request, and a step that offers only a link is the
    screen `not_supported`.
  - `useSignIn()`: `prepareFirstFactor({ strategy: 'email_link' })`, `openEmailLink(url)`
    for every URL the app is opened with, and `finishEmailLink()`. Without the hooks:
    `requestEmailLink`, `openEmailLink`, `isEmailLink`, and the type `EmailLinkOutcome`.
  - A URL is sent to the server only when it is `emailLinkUrl`, character for character,
    followed by a link of the sign-in that asked, while the client still keeps that link's
    binding. Anything else is refused without a request and uses nothing up.
  - A link whose request got no answer (`network.failed`, `network.timeout`) may have been
    taken all the same, and the same URL is then `verification.expired`. Nothing is asked on
    a guess: `finishEmailLink()` is what to try after either, and it changes nothing where
    the link was not taken.
  - The binding is kept in memory only, for fifteen minutes at most: never in the secure
    store, a file, a log line, an error or a URL. **A link opened after the app was ended
    and started again signs nobody in**: the user asks again. The code in the same email
    works on any device.
  - `flowScreen` counts `email_link` as a way for a client that has `emailLinkUrl`
    (`FlowWays.emailLink`).
  
  The server and `@tula-tech/core` are unchanged.
- ac05f56: Apple's and Google's own sign-in sheets, a session bound to a device key, and a config
  plugin in an Expo app ([docs/expo.md](../docs/expo.md), ADR 0052). **None of it has been
  run on a device, a simulator or in Expo Go**: no provider's sheet was shown, no key was
  made in a phone's secure hardware, none of the three native modules was installed, and
  Expo never ran the plugin. All of it is tested with stand-ins
  (`docs/plans/phase-2-unverified.md`).
  
  `@tula-tech/contract`:
  
  - `DeviceKey.proofId?()` (`@tula-tech/contract/device-binding`): a key may bring the id of its
    proofs, for a runtime with no `crypto.getRandomValues`. Left out, nothing changes.
  
  `@tula-tech/core`:
  
  - `Environment.deviceKey` (`DeviceKeySource`): for a runtime that finds its key by a call
    that takes time, the transport asks for the key before each request a key proves, and
    `undefined` means "send this one without a proof". A source that throws is
    `device.key_failed`. Finding the key and signing with it are inside the call's
    deadline: a key store that never answers is `network.timeout`, with nothing sent. `createTulaClient({ deviceKey })` is unchanged.
  
  `@tula-tech/expo`:
  
  - `createTulaExpoClient({ apple, google, deviceKeys })`, all optional. `@tula-tech/expo/apple`
    (`appleSheet`, over `expo-apple-authentication`), `@tula-tech/expo/google` (`googleSheet(ids)`,
    over `react-native-nitro-google-signin` 2.3 or later; a development build, and the
    import throws in Expo Go) and `@tula-tech/expo/device-key` (`hardwareDeviceKeys`, over
    `@pagopa/io-react-native-crypto` 1.2.5 or later; a development build) are adapters, each
    an entry point with an optional peer.
  - `useSignIn().withIdToken({ provider })` and, outside a component,
    `signInWithIdToken(client, { provider })`: the sheet is shown between the two steps of
    `@tula-tech/core`'s `signIn.withIdToken`. For Apple the package hands the sheet the SHA-256 of
    the server's nonce and passes the sheet's name on beside the token. A dismissed sheet
    sets `dismissed` and never `error`; one sheet of any kind at a time (`flow.busy`).
  - `useIdTokenProviders()`: `{ google, apple }`, `false` until the sheet is known to be
    there, so a control is hidden where the native module or the sign-in is missing.
  - With `deviceKeys`, a session is bound to a key the device keeps and every refresh
    carries a proof. A stored session whose key is gone (a new key, another key, no key
    store) is dropped when the app starts, with no request: the user signs in again. A
    token is marked as bound only when the server's answer says it is, and a key is made
    only after the key store said "not found" twice. A key
    store that cannot be reached is `storage.failed` and the session is kept. `deviceKey`
    is still refused as an option: an app hands over a key store (`DeviceKeyStore`).
  - `@tula-tech/expo/plugin`: `withTula(config, props)` adds Associated Domains, app-link intent
    filters, the Sign in with Apple entitlement and Google's client ids to an Expo
    configuration, and `reversedGoogleClientId(iosClientId)`. It writes no native file.
  - `flowScreen(step, ways)`: a provider counts as a way for a client with a browser or
    with that provider's sheet.
- bb0da88: Passkeys and sign-in with a provider in an Expo app ([docs/expo.md](../docs/expo.md),
  ADR 0048). **Neither has been run on a device, a simulator or in Expo Go**: both are tested
  with stand-ins for the passkey sheet and the system browser
  (`docs/plans/phase-2-unverified.md`).
  
  `@tula-tech/core`:
  
  - `Environment.passkeyProvider` (`PasskeyProvider`: `create` and `get`, WebAuthn's JSON
    forms in and out): where a client's environment has one, a passkey is asked of it
    instead of `navigator.credentials`. A browser's client is unchanged.
  - `createTulaClientWithEnvironment(options, environment)` and `runtimeEnvironment()`, for
    a package that builds a client for a runtime without a browser's globals, and the
    environment's types.
  
  `@tula-tech/expo`:
  
  - `createTulaExpoClient({ passkeys, browser })`: a passkey sheet (`PasskeySheet`) and a
    system browser session (`BrowserSession`), both optional. `@tula-tech/expo/passkeys`
    (`passkeySheet`, over `react-native-passkey` 3.6 or later; a development build) and
    `@tula-tech/expo/browser` (`systemBrowser`, over `expo-web-browser`) are adapters, each an
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
- 02ca214: `@tula-tech/expo`: the headless Expo SDK ([docs/expo.md](../docs/expo.md), ADR 0046).
  
  - `createTulaExpoClient(options)`: `@tula-tech/core`'s client as an `ios` or `android` client,
    with its refresh token in the device's secure store (`expo-secure-store`) and its access
    token in memory only. It refuses any other platform, Expo web included, and takes no
    `client`, `storage` or `deviceKey`.
  - `<TulaProvider client>` and the hooks `useAuth`, `useUser`, `useSession`, `useSignUp`,
    `useSignIn`, `useResetPassword` and `useTula`. No screen is drawn: a flow hook says which
    screen to draw (`screen`), and `not_supported` for a step, or a step whose every offered
    way, this version does not know (`flowScreen`).
  - `secureStoreStorage(store, options)` for an app that builds its own client:
    `keychainAccess` (`when_unlocked`, the default, or `after_first_unlock`; both stay on the
    device) and `keychainService`. A value over `MAX_SECURE_VALUE_BYTES` (2,048) is refused
    before the store is asked, and a store that cannot be read or written is
    `storage.failed`, never "signed out". A write the store refuses is tried three times, and twice more
    by itself within about six seconds.
  - `useAuth().loadError`: why the provider's last try to load the session failed (a
    `TulaError`, or `null`), while it keeps trying.
  
  Sign-up, sign-in with a password, an emailed or a texted code, password reset, the second
  step (authenticator app, backup code, texted code) and the session's devices. Device
  binding, passkeys and sign-in with a provider are not part of this version. Nothing of it
  has been run in Expo Go, on a simulator or on a device yet (`docs/plans/phase-2-unverified.md`).

### Patch Changes

- Updated dependencies [b38efc0]
- Updated dependencies [ac15d68]
- Updated dependencies [f3216d0]
- Updated dependencies [75b1b36]
- Updated dependencies [9d2a864]
- Updated dependencies [4e15bd1]
- Updated dependencies [ac05f56]
- Updated dependencies [bb0da88]
- Updated dependencies [8a4734a]
- Updated dependencies [f686a47]
- Updated dependencies [48d9bea]
- Updated dependencies [c760b08]
- Updated dependencies [095a866]
- Updated dependencies [1f189d8]
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
- Updated dependencies [59c2709]
- Updated dependencies [c97d084]
- Updated dependencies [190bb99]
- Updated dependencies [a0377de]
- Updated dependencies [9c90e25]
- Updated dependencies [d615c72]
- Updated dependencies [1df35b8]
- Updated dependencies [7d7600d]
- Updated dependencies [5e51183]
  - @tula-tech/core@0.1.0-alpha.0
