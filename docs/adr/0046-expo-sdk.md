# ADR 0046 — The Expo SDK: `@tula/core` with a secure store, headless

- Status: accepted
- Date: 2026-10-10

## Context

Phase 2 puts Tula on phones. [The plan](../plans/phase-2.md) (step 2.13, decision D8) starts
with Expo because it reuses the client that already passes everything: `@tula/core`
([ADR 0021](0021-core-sdk.md)) was written to run in React Native with a storage adapter,
and its `TokenStorage` interface is that seam. This record covers the first delivery
(TULA-36): the package, password and emailed-code sign-in, the session, an example app.
Device binding, passkeys, sign-in with a provider, the config plugin and deep links are
later deliveries (TULA-48 and the tickets after it) and are named under "Not decided
here".

The current Expo SDK is **57** (`expo` 57.0.27 and `expo-secure-store` 57.0.4, read from
the registry on 2026-10-10). The versions of React and React Native an SDK works with are
the ones it pins in `expo/bundledNativeModules.json`: for 57, **React 19.2.3 and React
Native 0.86.3**. The registry's `latest` of both is newer, and React Native's (0.87.1)
does not bundle under Expo 57: this was found by trying it, and is why the pinned numbers
are the ones written here.

`expo-secure-store` 57 was read from its packed declarations (`build/SecureStore.d.ts`)
and its documentation:

- `getItemAsync`, `setItemAsync`, `deleteItemAsync(key, options?)`; a key holds letters,
  digits, `.`, `-` and `_` only.
- iOS keeps a value in the Keychain under `keychainAccessible`; the two classes that never
  leave the device are `WHEN_UNLOCKED_THIS_DEVICE_ONLY` and
  `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`. Android encrypts with a Keystore key.
- The module enforces no size limit and says that some iOS releases refused values over
  about 2,048 bytes.
- It is part of Expo Go; `requireAuthentication` is not supported there.

## Decision

A publishable package, `@tula/expo` (`packages/expo`, `"private": true` like the others),
with one entry point.

### What it is

- **`createTulaExpoClient(options)`** returns `@tula/core`'s client, unchanged. The package
  adds no auth logic and no second session: flows, the single-flight refresh, the retry of
  a refresh that got no answer and the "a failure that is not a refusal keeps the session"
  rule are `@tula/core`'s and are not restated.
- **The package decides three options and refuses them from a caller**: `client` (the
  platform), `storage` (the secure store) and `deviceKey` (not in this version). An option
  an app could set to put the token somewhere else is not an option.
- **`<TulaProvider client>` and thin hooks**: `useTula`, `useAuth`, `useUser`,
  `useSession`, `useSignUp`, `useSignIn`, `useResetPassword`. They hold what a screen needs
  between renders (the flow, the pending state, the last error) and nothing a server
  decides.
- **No screen.** Decision D8 of the plan: the prebuilt UI comes with the native components
  (step 2.16). The package imports neither `react-dom` nor a React Native component.

### The client kind is the platform, and the web is refused

`Platform.OS` is `ios` or `android`; anything else, Expo web included, is a `TypeError`
when the client is created. A `web` client's session is an httpOnly cookie the SDK never
reads, a different design with different rules (ADR 0021, ADR 0028); an Expo web build
uses `@tula/react` or `@tula/core`. Guessing a kind for an unknown platform would choose
how tokens are delivered on a guess.

### Where the tokens are

- The **access token** is in memory only, as in every `@tula/core` client.
- The **refresh token** is in the secure store and nowhere else: never AsyncStorage, a
  file, a log line, an error or a URL. `secureStoreStorage` caches nothing.
- **The default class is `WHEN_UNLOCKED_THIS_DEVICE_ONLY`**, the plan's requirement. Its
  cost is real and is documented: an app that asks for a token while the device is locked
  (a background task) cannot read the refresh token. For that app `keychainAccess:
  'after_first_unlock'` selects the other device-only class. No class that syncs or is
  restored to another device can be selected: the option is a closed pair, checked at run
  time too.
- **A store that cannot be read or written is not "signed out".** The adapter rejects, the
  client reports `storage.failed`, and the running app keeps its session. The provider
  keeps the state at `loading` and asks again with a growing delay (2 to 30 seconds) while
  the first read fails. Treating a locked Keychain as "no session" would sign a user out
  for having a locked phone. **That a locked read rejects is documentation, not
  observation**: no device was asked. If it resolves `null` instead, the client that read
  it is signed out locally until the app starts again; it asks the server nothing and
  leaves the entry alone (a test holds that), so the session is found at the next start.
- **The provider retries a failed first load for ever and says why**
  (`useAuth().loadError`: the last try's `TulaError`, `null` once a try succeeds or
  somebody signs in). It does not sort codes into "will pass" and "will not": a wrong
  publishable key (`auth.invalid_key`) is about the request, the session is rightly kept,
  and an app that stopped trying would need a restart after the key is fixed in a
  development build. What was missing was the reason, which no hook exposed.
- **A write the store refuses is tried three times, and after that the stored token can be
  a replaced one** (`SECURE_WRITE_RETRY_DELAYS_MS`: again after 50 ms and 200 ms; a read
  and a delete are asked once; a value that is too large is not retried). A refresh's
  write comes after the server has rotated the token. When every try fails the running
  app is unaffected (the newest token is in memory; `refresh()`, `load()` and a sign-in
  throw `storage.failed`, and `getToken()`, which is `@tula/core`'s and unchanged,
  returns the token it has and reports nothing) and each later refresh stores its own
  token. **Because `getToken()` says nothing and that next write is an access token's
  lifetime away, the adapter offers the value to the store twice more by itself**
  (`SECURE_REWRITE_DELAYS_MS`: 1 second after the last refusal, 5 seconds after that;
  two tries, then none; both numbers a guess). It writes only while that value is still
  the newest thing asked of the entry: a newer write or a delete calls a waiting try off, and
  its timer does not keep a process alive. **A later try that is already inside the store
  cannot be called off.** If a sign-out arrives then and the write is taken after it, the
  adapter deletes the entry once more (one delete; refused, the value stays and nothing
  is tried again: a loop against a store that refuses is worse than the rare leftover,
  which the server's sign-out has already made worthless). If a newer write arrives then,
  nothing is added: the adapter asked for the two in the right order, which one the native
  layer completes last is not its to see, and a delete or a third write could only make
  that worse. An older token that lands last is replaced by the next refresh's write, and
  is the "app ended before a later write lands" case below until then. **But an app ended before a later write lands starts next time with a rotated
  token**: inside the profile's grace window it is handed the same next token and is
  signed in; after it the server answers `session.reuse_detected`, revokes the family,
  and the user signs in again. The retry is in the adapter, where a write that waits to be tried
  again cannot land over a newer one or over a sign-out, and `@tula/core` was not changed
  for it. **The order is kept per store object and entry (key and service), in the module,
  not per adapter**: two adapters over one store, which is what two clients or a client
  made again are, see each other's newer write and sign-out. It is not kept across two
  store objects over one Keychain or across processes, and it orders what the adapter
  asks, not what a native layer completes. The adapter waits through an injectable
  schedule (`ExpoRuntime.schedule`, the third argument of `secureStoreStorage`), so no test
  but the one of the default sleeps. Nothing closes the window. What could (a longer
  grace window on the server, a second copy of the token on the device) each gives
  something away and is a decision of its own, not made here.
- **A value over 2,048 bytes is refused by the adapter itself** (`MAX_SECURE_VALUE_BYTES`),
  before the store is asked. A refresh token is about 50 characters, so the limit is far
  away; refusing it here makes what happens to a larger value the same on every phone,
  instead of depending on the iOS release. Nothing is split across entries: a token in
  two halves has a state where one half is written.
- **Keys are encoded, not hashed.** `@tula/core` names its entry after the API's address
  and the publishable key, which hold characters a secure-store key may not. Each such
  character, and `_` itself, becomes `_` and its UTF-8 bytes in hexadecimal: the mapping
  is one to one, so two clients never share an entry, and it needs no digest function (not
  every React Native engine has `crypto.subtle`).
- `requireAuthentication` is never set: a refresh a minute would ask for a face or a
  fingerprint each time.

### A step the package cannot act on is a screen called `not_supported`

`flowScreen(step)` (and each flow hook's `screen`) answers the step's status where the
hooks have an action for it and `not_supported` otherwise: a status this version does not
know, a first or second factor that offers only ways it cannot do (a passkey, a provider,
an emailed link), an enrolment of an unknown method, a new-password step with an unknown
reason. It reads the step as data from a newer server, never throws and never guesses an
action. This is the behaviour `unknown_step_not_supported` of the client-journey list.

### The hooks are the package's own, for now

The plan says the hooks shared with `@tula/react` "move to where both can import them
without a DOM". They were not moved. `@tula/react`'s hooks are entangled with what only
its components need: the provider's dialogs (`prompts`), `useCompletion`'s hold for
passkey sign-in, focus handling, destinations checked by `safeUrl`. Extracting the part
without a DOM is a refactoring of a package under a browser test suite, for a saving of
about 400 lines here. The rule the two share is kept instead: a result belongs to the
session it was asked for, and a flow that is left is discarded. Moving them is still the
plan when the native UI (2.16) needs more of them.

### The dependency footprint, and where the example app lives

Measured on 2026-10-10 in a directory outside the repository: `expo`, `expo-secure-store`,
`react-native` and `react` are **510 entries of a lockfile, 285 top-level directories in
`node_modules`, and 72.6 seconds** of a first install. The package needs two imports from
them (`Platform.OS` and the secure store).

- **`expo-secure-store` and `react-native` are peer dependencies, marked optional in the
  repository only.** The repository installs neither; `packages/expo/src/native-modules.d.ts`
  declares the members `native.ts` uses, copied from the two packages' own declarations.
  The published manifest drops the "optional" mark (`publishConfig.peerDependenciesMeta: {}`),
  so an application is told when one is missing. An ambient declaration never shadows a
  module that resolves, so an application is checked against the real types.
- **One module imports a native package** (`native.ts`, 12 lines of code). Everything else
  takes the platform and the store as arguments, and is tested with a fake store.
- **The example app is `examples/expo/app`, and `examples/expo` is not a workspace
  package**: as one it would add the 510 entries to `bun.lock` and to every install, the
  API image's build context included, for an app nothing in `bun run verify` can start. It
  installs by itself, from the packed packages of the checkout (`.release/*.tgz`, with
  `overrides` for the nested `@tula/core` and `@tula/contract`, which the registry does not
  have).
- **The repository still compiles the app's sources** on every `verify`
  (`examples/expo/tsconfig.json`, in `typecheck:scripts`), against `@tula/expo`'s sources
  and a shim of the React Native components the app uses. That catches the app falling
  behind the package; it does not check the app against React Native's real types.

### How it is tested

Under `bun test`, with no simulator.

- **The journeys are `@tula/core`'s, run again through this package.** The suite that
  drives `@tula/core` against the real API in process moved from a test file into a
  function, `sdkJourneys(target)` (`apps/api/src/testing/sdk-journeys.ts`).
  `apps/api/src/sdk-journeys.test.ts` calls it for `core`; `packages/expo/src/journeys.test.ts`
  calls it with a target whose clients are made by this package (kind `ios`, a fake secure
  store) and whose capabilities are all off: no browser, no provider, no passkey, no
  device key. The journeys behind a capability are not declared for a target without it,
  and the client-journey list (`conformance/client-journeys.json`) is what says each of
  them is `not_built`, with its ticket: the guard fails in both directions, so a
  capability cannot hide a journey the list promises.
- **The suite runs with the DOM's globals taken away** (`hideDom()`), so a dependency on
  `window`, `document` or `localStorage` in a path a phone takes fails here.
- The package's own tests: the storage adapter against a fake store that can fail each
  call, the client's refusals, the hooks in happy-dom (React needs a renderer; happy-dom
  and `react-dom` are development dependencies for that and nothing the package imports),
  and the packed manifest.
- The suite is in `packages/expo`, not `apps/api`: the API image's install stage copies no
  manifest of a browser or app package, and the API must not depend on this one. The
  package declares `@tula/api` and `@tula/conformance` as development dependencies, which
  is what makes Turborepo run its tests again when a file of either, or the list itself,
  changes (the `transit` task; `.claude/hooks/turbo-inputs.test.ts`).

`expo` sets its `suite` to `exists` in the list. Of the list's 99 scenarios 48 are a
`journey`, 38 are `not_built`, 13 are `not_applicable`, and the four named behaviours are
journeys (47, 36 and 12 of 95 before the four scenarios of a profile's device-binding
option were added).

**"Not in this version of the package" is its own decision, `not_built`.** The first
draft of this delivery wrote the 36 of that time as `not_applicable`, whose rule is that no client
of that kind can reach the scenario; an app reaches provider sign-in, passkeys and device
binding, and `@tula/expo` only has no call for them yet. A list that cannot tell "never"
from "later" hides a debt, so the list's format gained the decision: `not_built` carries
the ticket that builds the feature (`TULA-48` for 30: providers, passkeys, the emailed
link and the redirects into an app; `TULA-55` for device binding: 6 then, 8 since the
scenarios of a profile that requires a key) and a reason that
says what is missing. It is allowed only for a scenario of a client whose suite exists,
the guard fails for one with a test behind it, and `notBuilt(list, client)` counts them:
`packages/expo/src/journeys.test.ts` holds the count per ticket, so the debt shrinks on
purpose and cannot grow unnoticed. The 13 that stay `not_applicable` are what no app does
(an administrator's routes, a browser's cookie session and a browser's sign-up, properties
of the deployment).

### What was run against the real thing

In a copy of the example outside the repository, on the versions above: the install, `tsc
--noEmit` against the real Expo and React Native declarations (clean), and `expo export`
for iOS and Android (Metro bundles both: 595 and 593 modules). **The app was not opened:
not in Expo Go, a simulator, an emulator or on a device.** No value has been written to a
real Keychain or Keystore by this code. [The Phase 2 list](../plans/phase-2-unverified.md)
has each item. The example's setup screen came after those runs and was compiled by the
repository only.

## Consequences

- An Expo app gets Tula with one package and `expo-secure-store`, and works in Expo Go as
  far as this version goes, as far as anything short of running it can show.
- The peer range is `expo-secure-store >=57.0.0` and `react ^19.0.0`. Only SDK 57 was
  installed and bundled; an older SDK is outside the range and a newer one is untested.
- Two suites now run the same journeys. A journey added to `sdkJourneys` runs for both
  clients unless it is behind a capability, and then the list must say so for `expo`
  (`not_built`, with a ticket).
- The client-journey list has a fourth decision, and every reader of it (the Swift and
  Kotlin suites, when they exist) has to know it: `conformance/README.md` says what.
- An app that reads a token from a background task must choose `after_first_unlock`; the
  default fails closed for it (`storage.failed`), which is the intended direction (if a
  locked read rejects, which no device has shown).
- A secure store that refuses a write for longer than the tries last (three in a quarter
  of a second, two more within about six seconds), in an app that is then ended and not
  started again within the grace window, costs that user a sign-in.
  An app that only calls `getToken()` is not told when a write failed.
- A user who restores a phone from a backup, or moves to a new one, signs in again: the
  token is device-only on purpose.

## Not decided here

Each is a decision of its own, in the ticket that builds it:

- **Device binding** (TULA-55): a key the device cannot export needs a native module;
  `deviceKey` is refused until then, rather than offered with a software key that would
  claim what it does not give.
- **Passkeys** (TULA-48) and **native Google and Apple** (TULA-55): native modules, not
  available in Expo Go.
- **Sign-in with a provider** through the system browser, and **the emailed link**
  (TULA-48): both
  need the app to hold a binding across leaving and re-entering it (ADR 0024, ADR 0026),
  in the secure store rather than web storage, and a link into the app, which is untrusted
  input. `@tula/core` keeps those bindings in `sessionStorage` and `localStorage` today;
  where they go on a phone is not settled, so neither is offered.
- **App-state-aware refresh.** The plan asks that a foregrounded app refresh and a
  backgrounded one hold no lock. `@tula/core` refreshes when a token is asked for and holds
  no lock between requests on a native client (the Web Lock is a browser's), so nothing is
  held in the background today; a refresh on foregrounding is an optimisation not built.
- **The config plugin** and a `create-tula` template.
- **Moving the shared hooks** out of `@tula/react`.
