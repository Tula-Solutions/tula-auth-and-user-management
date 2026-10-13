# ADR 0052 — Native Google and Apple, and a device key, in the Expo SDK

- Status: accepted
- Date: 2026-10-12

## Context

[ADR 0046](0046-expo-sdk.md) and [ADR 0048](0048-expo-passkeys-and-providers.md) left three
things to this record (TULA-55):

- **Google's and Apple's own sheets.** The server's half exists: a native app signs in with
  a provider's ID token in two steps of one attempt
  ([ADR 0045](0045-native-id-token-exchange.md), [ADR 0047](0047-native-apple-sign-in.md)),
  and `@tula/core` has `signIn.withIdToken`. `@tula/expo` had no hook for it and showed no
  sheet.
- **Device binding** ([ADR 0043](0043-device-binding.md)). `@tula/core` makes the proofs of
  a client that was handed a key. `createTulaExpoClient` refused a `deviceKey`: a key worth
  binding a session to is made in a phone's secure hardware, by a native module.
- **A config plugin**, so that the native pieces these need (Associated Domains, the Sign in
  with Apple entitlement, Google's client ids) are said in one place.

**Nothing in this record was run on a device, a simulator or in Expo Go.** No provider's
sheet was shown, no key was made in secure hardware, no native module was installed and no
prebuild was run. Everything is tested with stand-ins, and what that leaves unverified is in
[the Phase 2 list](../plans/phase-2-unverified.md#step-213-native-google-and-apple-and-a-device-key-in-tula-techexpo-tula-55-adr-0052).

## What exists today (read on 2026-10-12)

Read from the npm registry's metadata and from the packages' own tarballs (declarations,
native sources, READMEs). Nothing was executed.

| Package | Version | What it is |
| --- | --- | --- |
| `expo-apple-authentication` | 57.0.2 | Expo's own, and in Expo Go. `isAvailableAsync()` and `signInAsync({ requestedScopes, nonce })`, which resolves `{ identityToken, fullName: { givenName, familyName }, … }`. A dismissed sheet is a rejection whose `code` is `ERR_REQUEST_CANCELED`. iOS only: on Android `isAvailableAsync()` answers `false`. Its config plugin sets the entitlement. |
| `@react-native-google-signin/google-signin` | 16.x | The best known Google module. **The sources of its free version (16.1.5, read) have no option for the request's nonce.** The server requires the nonce (ADR 0045). |
| `react-native-nitro-google-signin` | 2.3.0 | A Nitro module (Google Sign-In SDK on iOS, Credential Manager on Android), MIT. `GoogleOneTapSignIn.configure({ webClientId, iosClientId, nonce })` and `presentExplicitSignIn()`, which resolves `{ type: 'success', data: { idToken, … } }`, `{ type: 'cancelled' }` or `{ type: 'noSavedCredentialFound' }`; a dismissal can also be a rejection whose `code` is `SIGN_IN_CANCELLED`. `checkPlayServices(showDialog)`. Needs `react-native-nitro-modules` and a development build. **It makes its native object when it is imported**, so an import in Expo Go throws. Its config plugin patches the iOS Podfile and wants the reversed iOS client id. |
| `expo-crypto`, `expo-secure-store` | 57 | Neither makes a key that cannot be exported: `expo-crypto` has digests and random bytes, the secure store holds values. **Expo has no module for a hardware-held signing key.** |
| `@pagopa/io-react-native-crypto` | 1.2.5 | A React Native module of PagoPA's (the Italian public administration's app), MIT. `generate(tag)`, `getPublicKeyFixed(tag)` (a JWK), `sign(message, tag)` (base64 DER, ECDSA with SHA-256 over the message's UTF-8 bytes), `deleteKey(tag)`. On iOS the key is a P-256 key that is always asked of the Secure Enclave, `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`; `generate` goes on only when the Keychain answered "no such item" (anything else is `KEY_ALREADY_EXISTS`), and a key the platform would not make is `WRONG_KEY_CONFIGURATION`; on Android a Keystore key, StrongBox where there is one, **with an RSA key as the fallback where an EC key cannot be made**. Not in the build, every call throws a linking error at the call. A rejection is an error whose `message` is one word of a closed list. |

So: Apple's module is the obvious one. For Google there is one maintained free module that
can carry the nonce, and it is young. For the key there is one maintained module that does
exactly this, and it is not Expo's. None of the three is "clearly right" for every app,
which is the argument for the next decision.

## Decisions

### Three more entry points, each the only importer of its module

As ADR 0048 did for the passkey sheet and the browser: `@tula/expo/apple` (`appleSheet`),
`@tula/expo/google` (`googleSheet(ids)`) and `@tula/expo/device-key` (`hardwareDeviceKeys`)
are entry points of their own, each the one file that imports its native module, and no
other source of the package imports any of them. The modules are optional peers, here and
when published. The client takes what they return as options (`apple`, `google`,
`deviceKeys`), typed by interfaces of the package (`IdTokenSheet`, `DeviceKeyStore`), so an
app may write its own over another module. The adapters take the module as an argument
(`appleSheetOver`, `googleSheetOver`, `deviceKeyStoreOver`) and are tested without it.

They are in files of their own (`id-token-adapters.ts`, `device-key-adapter.ts`) and not in
`adapters.ts`: the bundler copies a whole module into every entry point that imports from
it, and an app that offers only Apple should not carry Google's adapter.

**`@tula/expo/google` cannot be imported in Expo Go** (the module's doing, above). An app
that must also start there loads that entry point only in a development build. The other
two can be imported anywhere: Apple's is in Expo Go, and the key module's calls throw only
when made, which is read as "no key store".

### The sign-in is `@tula/core`'s; the package shows the sheet between its two steps

`signInWithIdToken(client, { provider })`, and `useSignIn().withIdToken(...)` over it:
`client.signIn.withIdToken`, the sheet with the nonce, `exchange` with the token. No account
logic, no second path to a session. The ID token is sent once in a JSON body and kept
nowhere.

- **For Apple the package hashes the nonce.** The server accepts one form in Apple's token:
  the lowercase hexadecimal SHA-256 of its nonce (ADR 0047), and `@tula/core` never hashes
  (no `crypto.subtle` on Hermes, no room in its bundle). ADR 0047 left the hash to "the
  app"; in an Expo app that is this package, so that no app writes it. The hash is the
  package's own SHA-256 in TypeScript (`sha256.ts`, held to WebCrypto and to the server's
  `appleNonceClaim` by tests), because a React Native engine has no `crypto.subtle` and a
  fourth native module for one digest is not worth an install. Google's sheet is handed the
  server's nonce as it is.
- **Apple's name goes beside the token.** What the sheet hands over as `fullName` (once,
  at the first sign-in) is passed to `exchange` as `givenName` / `familyName`; for Google
  nothing is, its token carries its own.
- **A dismissed sheet is `cancelled`**, which a hook says as `dismissed` and never as
  `error`: no exchange is made, nobody is signed in, and the next try starts an attempt of
  its own (an attempt is one token).
- **One sheet at a time, of any kind.** A call while a provider's sheet, a passkey sheet or
  a provider's browser of the same client is out is `flow.busy`, before any request; and
  the other two are refused while a provider's sheet is out.
- **A sheet holds its place for five minutes at most** (`ID_TOKEN_SHEET_CEILING_MS`, half an
  attempt's lifetime, waited for through the package's `Schedule`). A native promise can be
  left unsettled; after the ceiling the sign-in ends as one nobody answered, and whatever
  the abandoned sheet answers later is dropped, never exchanged.
- **What a sheet throws stays with it.** A module's failure, or an app's own sheet's, is the
  client code `internal` with none of its text; the adapters keep a module's code word to
  tell a dismissal apart and drop its message.

### Hidden, not broken

Whether a sheet can be shown is asked of the sheet (`IdTokenSheet.isAvailable`), each time,
never when the client is created: the module is in the build, and the device has the
sign-in (Sign in with Apple needs iOS 13; Google's is asked through Play services on
Android). A sheet that throws or rejects when asked cannot be shown.

- `useIdTokenProviders()` answers `{ google, apple }`, both `false` until the sheets have
  answered, which is after the first render: **a control is hidden until it is known to
  work**, as a passkey's is in `@tula/react`.
- `signInWithIdToken` asks again, and refuses with `storage.failed` **before any request**
  where the sheet is not there, as a provider sign-in does for a client with no browser.
- `flowScreen(step, ways)` counts a provider as a way for a client that has a browser (any
  provider) or that provider's sheet, as last known.

### A device key the client finds when it needs one

`@tula/core` took a key at construction. A key in secure hardware is found, or made, by a
native call that answers later, and may not be there at all in a given build. So
`Environment` gained one member, `deviceKey`: a `DeviceKeySource`, a function the transport
asks before each request a key proves (the six starts and the refresh) and which answers a
key, or `undefined` for "none: send this request without a proof". A key handed over as the
option `deviceKey` became such a source. A source that throws is the client code
`device.key_failed`, as a key that fails to sign is. And a `DeviceKey` may bring `proofId()`,
for an engine without `crypto.getRandomValues`: a proof's id has to be new and need not be a
secret, and the server refuses a repeat.

This changed `@tula/contract/device-binding` (one optional member) and `@tula/core` (the
source). The core's bundle grew by 42 bytes, 16,833 to 16,875, and **its budget was moved by
exactly those 42**, to 16,879, as it was for the native ID-token exchange: the room that was
left (4 bytes) could not hold it, and the alternative, a second client implementation in
`@tula/expo`, would have been auth logic outside `@tula/core`.

**The lookup and the signing are inside the call's deadline** (added after review). A key
store is a native call, and a native call can be left unsettled; awaited plainly before
the request, it would let a refresh wait for ever and hold the single flight with it,
which is what `REFRESH_TIMEOUT_MS` exists to rule out. The transport ends the wait when
the call's one deadline passes: the call fails with `network.timeout`, no request is sent,
and what the key store answers afterwards is dropped (a late rejection is handled, a late
key signs nothing that is sent). The repeat after a nonce challenge is under the same
deadline. This cost 40 more bytes (16,875 to 16,915; three shapes were measured and the
cheapest kept) and the budget moved by exactly those, to 16,919.

`@tula/expo` still refuses `deviceKey` as an option (`DECIDED_HERE`): an app hands over a
**key store** (`deviceKeys`), never a key, and the package decides which key and when.

### One key per installed app, made at the first sign-in

`DeviceKeyStore` is three functions: `isAvailable()`, `obtain(alias)` (the key under the
alias, made if there was none, and **whether it was made just now**) and `sign(alias,
data)`. The package uses one alias (`DEVICE_KEY_ALIAS`), so every session of the app on a
phone is bound to the same key; ADR 0043 already says a device does not outlive its session
and nothing reads the key to recognise one.

- A start asks for the key, so the first sign-in makes it. Two requests at once make one.
- Where `isAvailable()` is `false` (Expo Go, a device that cannot keep such a key: next
  section) the start goes without a proof and the session is not bound, where the profile allows that. Under
  `deviceBinding: 'required'` the server refuses such a start (`device.binding_required`),
  and under `'none'` it refuses a start **with** a proof (`device.binding_not_supported`):
  both are the server's rule, passed on. An app whose profile is `'none'` creates the client
  without `deviceKeys`.
- A refresh of a session that is not known to be bound carries a proof too where there is a
  key: the server reads none for an unbound session, and a session bound before the mark
  below existed is then still refreshed.

### A device that cannot keep the key signs in unbound, where the profile allows it

That a device cannot keep a P-256 key is learned only by trying to make one. The adapter
takes three of the module's words for it, and only from a `generate` that followed a lookup
which found nothing: `WRONG_KEY_CONFIGURATION` (the platform refused the key's parameters:
what iOS answers where there is no Secure Enclave to put it in), `UNSUPPORTED_DEVICE` and
`API_LEVEL_NOT_SUPPORTED`; and a key that came out as RSA. From then on, for the rest of
the run, `isAvailable()` is `false`. Every other rejection (`KEY_ALREADY_EXISTS`, a Keystore
or Keychain that would not load, anything unknown) says nothing about the device and fails
that one call.

**The start that found out is sent without a proof** (the source looks, the look rejects,
the store then says it is not there): the same request a build without the module sends.
A store that failed and still says it is there fails the start with `device.key_failed`,
and **a bound session's refresh is never sent without its proof**, whatever the store says.

The alternative was to fail that first sign-in with `device.key_failed` and let the second
try go unbound. Not taken: a user on such a device would see one sign-in fail at every
start of the app, for a reason nobody can act on. What it costs is stated instead: under
`optional`, a device that says it cannot keep a key gets a session that is not bound, by
the client's own decision and with nothing shown. The server decides nothing differently
(`required` still refuses that start), and the session's entry in `session.list()` says
`deviceBound: false`.
**Whether `WRONG_KEY_CONFIGURATION` is in fact what a simulator or an old device answers
was read from the module's source and not observed.**

### A stored session is marked with its key, and a lost key is found before any request

The refresh token of a bound session is stored as `<token>`, a line break, and the key's
public x coordinate, in the same secure-store entry. A refresh token never holds a line
break; the coordinate is public and says nothing a proof does not.

**A token is marked only on the server's word** (changed after review). `@tula/core` hands
the storage a token and nothing about the attempt or the request it came from, so "the
last start carried a proof" is not something a write can be tied to: a start that was
proven and then refused or left, followed by a refresh of a session the server never
bound, would have marked that session, and a marked session is dropped when its key is
lost. So the package's `fetch` passes through the binding (`watch`), which reads each
successful answer that issues a session (a refresh's tokens, or the `session` of a step
that completes) and remembers, by the hash of its refresh token, what to mark it with:
**this device's key when the answer's access token names it (`cnf.jkt` equal to the
thumbprint of the key this run last found), nothing otherwise**. The write of a token uses what
its own answer said. That key is remembered apart from the one a failed signature makes
the next request look for again: an answer still on its way was proven by it. The hashes
are in memory only, at most four, and are cleared when the entry is removed (a sign-out). It cannot mark a session the server did not bind to this key: the
statement is the server's, in the answer the token arrived in. What it leaves unmarked,
on the safe side: a token no watched answer brought, an answer that could not be read, a
session bound to a key this run does not hold, and a token whose answer is more than four
answers back. An unmarked bound session still refreshes with its proof; it only is not
looked at when the app starts, so **for an unmarked session a lost key is not noticed
locally**: its refreshes are refused by the server (`device.proof_invalid`) until the user
signs out and in. Whether React Native's `fetch` lets an answer be read twice
(`response.clone()`), which the marking needs, was not run. A session bound before this version, once refreshed, is
marked from then on. The access token is not verified for this and nothing is granted by
it. Not taken: tracking attempt ids from starts to completions in the package (a provider
sign-in's exchange and a ticket have no attempt in their address, and it would restate
the flows); a change to `@tula/core`'s storage interface (more bytes, for one caller).

When the app starts and the entry is marked, the key is looked for **before the token is
handed to the client**:

| What the key store says | What happens |
| --- | --- |
| The same key is there. | The token is handed on; its refreshes carry a proof. |
| It made a key just now, or holds another one. | The session cannot be refreshed by anyone. The entry is deleted (asked once) and the client starts signed out, **with no request**. The user signs in again, and the new session is bound to the new key. |
| There is no key store (`isAvailable()` is `false`, or the app no longer passes `deviceKeys`). | The same: signed out locally. A build without the module cannot refresh a bound session. |
| It cannot say (a rejection: a locked phone, a Keychain error). | The read fails. The client reports `storage.failed` and **keeps the session**; the next try asks again. |

The last row is the rule the adapter is built around: **a key that could not be reached is
never taken for a key that is gone**. `deviceKeyStoreOver` says a key was made only when the
module's `generate` resolved, which on iOS it does only for a Keychain lookup that answered
"no such item"; every other failed lookup is a rejection.

**A key is made only after two lookups in a row said "not found"** (added after review).
Dropping a session is not undone, and it rests on native behaviour nobody observed: if a
locked phone answered "not found" for a key that is there and `generate` then succeeded,
the user would be signed out. Deletion is kept, because without it a user whose key is
really gone holds a session every refresh of which is refused. What is added: the lookup
is asked a second time, at once, before any `generate`. Found the second time, that is the
key and nothing is made; any other rejection is the transient path (`storage.failed`, the
session kept, nothing made). There is no wait between the two looks: nothing known says
how long one would have to be. **This narrows the case and does not close it**: a store
that wrongly says "not found" twice and then makes a key still ends the session.

Alternatives not taken:

- **Let the refresh fail.** The server answers a bound session's refresh without its key
  with `device.proof_invalid`, which is deliberately not a `session.*` code and ends
  nothing locally. The app would be signed in with a session it can never refresh, and
  every call would try again: the retry loop the ticket rules out.
- **End the local session on `device.proof_invalid`.** That is weakening a rule of ADR 0043
  in the client: the code is also what a transient mistake gets.
- **Tell the server.** The only credential the server would take is the refresh token, and
  it is not presented without the key it is bound to. The session that was dropped
  stays in the account's list until it ends by its profile or the user ends it from a
  signed-in device. Stated in the docs.

Known limits, each stated in `docs/expo.md`:

- **A key that disappears while the app runs** is met at the next refresh as
  `device.key_failed`, with the session kept; the next start of the app finds the entry
  marked with a key that is gone and signs out.
- **Whether a reinstall loses the key is the platform's, and was not observed.** On Android
  an uninstall removes the app's data and its Keystore keys together: the app starts with
  nothing. On iOS a Keychain item can survive an uninstall, the stored token and the key
  alike; if both do, the session goes on, and if only the token does, the table's second
  row applies.
- The key is `WhenUnlockedThisDeviceOnly` on iOS: a refresh from a background task on a
  locked phone is `storage.failed` or `device.key_failed` and the session is kept, also
  where the secure store's class is `after_first_unlock`.
- **An RSA key is refused.** Where the Android module falls back to one, the package
  deletes it and says the phone has no key store for the rest of the run: a proof is ES256
  and nothing else (ADR 0043).
- **"No key store" is remembered for a run of the app, not across runs**: a device that
  cannot make the key is asked to once at every start.

### The config plugin is a function over the configuration

`@tula/expo/plugin` exports `withTula(config, props)`: a new Expo configuration with
`webcredentials:` and `applinks:` entries under `ios.associatedDomains`, a verified Android
intent filter for each app link's exact paths, `ios.usesAppleSignIn` and the
`com.apple.developer.applesignin` entitlement, and for Google the client ids under
`extra.tula.google`, `GIDClientID` and the reversed iOS client id as a URL scheme.
`reversedGoogleClientId` is exported for the Google module's own plugin, which wants the
same value.

- **It imports nothing**, so it needs no `@expo/config-plugins` and is tested on plain
  objects. It only adds, adds nothing twice, and does not change the object it was given.
  A wrong value is a `TypeError` that names the option and never the value.
- **It writes what a configuration can say and no native file.** A module with a plugin of
  its own is still listed beside it; the Google module's patches the Podfile, which a
  function over the configuration cannot do.
- **It is published as CommonJS and as a module.** Expo loads a plugin with `require`
  (`plugin.cjs`); the module beside it is for an `import`, because Node cannot see the
  names a bundled CommonJS file exports. It keeps no state, so two copies are one. There is
  no `app.plugin.js` at the package's root: an app names `@tula/expo/plugin` in `plugins`,
  or calls `withTula` in `app.config.ts`, as the example does.
- **Whether Expo's prebuild turns that configuration into the entitlements, the
  `Info.plist` and the manifest was not run**, and neither was Expo's resolution of the
  subpath as a plugin.

### The journeys

`expo`'s suite turned the `deviceKey` capability on: the eight scenarios that were
`not_built` under TULA-55 are `journey`, run by the shared journeys with the journey's
software key behind the key store's interface. The suite adds its own: Google's and Apple's
sheets through `signInWithIdToken` against the mock provider (for Apple the token carries
whatever the sheet was handed, so a sign-in is the proof that the package took the hash), a
dismissed sheet, a restart that finds the key, a lost key (signed out with no request), a
key store that cannot be reached (`storage.failed`, session kept), a build without the key
store, and a profile that binds nothing. One `not_built` entry is left, the emailed link's.

## Not decided here

- **A key per session, or rotating the key.** One alias, for good.
- **Attestation** (App Attest, Play Integrity, key attestation): ADR 0043 leaves it out.
- **Telling the server about a dropped session.**
- **Requiring user presence for a signature** (biometrics on the key): the module's keys ask
  for none, and a refresh happens with nobody looking.
- **A Google module in Expo Go**, and Google's sheet through any other module.
- **The plugin writing native files**, and an `app.plugin.js` at the package's root.
- **Opening an emailed link in the app**: still as ADR 0048 left it. *(Since decided, in
  [ADR 0055](0055-expo-emailed-link.md).)*
