---
paths:
  - "packages/expo/**"
  - "examples/expo/**"
---

# Expo SDK

Moved here from `AGENTS.md`, word for word, and canonical for this area: `AGENTS.md` lists
this file under "Area rules" and does not repeat it. A section named in a sentence as
"above" or "below" is found through that list.

## Expo SDK (`packages/expo`, see ADR 0046, ADR 0048, ADR 0052 and ADR 0055)

- **It is `@tula-tech/core`'s client and adds no auth logic.** `createTulaExpoClient` returns the
  core client; the single-flight refresh, the one repeat of a refresh that got no answer and
  "a failure that is not a refusal keeps the session" are `@tula-tech/core`'s. Never restate one
  here, and never keep a second copy of the session.
- **The refresh token is in the secure store and nowhere else** (`secureStoreStorage` over
  `expo-secure-store`), in one of the two Keychain classes that never leave the device
  (`when_unlocked`, the default, or `after_first_unlock`: a closed pair, checked at run
  time). Never AsyncStorage, a file, a cache in the adapter, a log line, an error or a URL,
  and never `requireAuthentication`. `client`, `storage` and `deviceKey` are decided by the
  package and refused from a caller (`DECIDED_HERE`): an option that could put a token
  elsewhere is not an option, and an app hands over a key store (`deviceKeys`), never a
  key.
- **A secure store that fails is not "signed out".** The adapter rejects and the client
  reports `storage.failed` with the session kept; `<TulaProvider>` stays `loading` and asks
  again with a growing delay. Only a non-empty string is a token; never turn a rejection
  into `null`. A value over `MAX_SECURE_VALUE_BYTES` is refused before the store is asked,
  and nothing is ever split across entries.
- **The provider retries a failed load for ever and says why** (`useAuth().loadError`: the
  last try's `TulaError`, `null` once a try succeeds or somebody signs in). Never sort
  codes into ones worth retrying, and never put anything but the client's own error there.
  Its `code` and `message` may be shown (the message is the client's sentence for the
  code, or the server's own message for a code the client does not know); its `cause` is the store's or the runtime's own
  error and the docs say not to show or log it: never word the error as holding no secret.
- **No refusal of the constructor repeats what it was given** (the example shows them on
  its setup screen): a new `TypeError` of `createExpoClient` or `secureStoreStorage` gets
  a row in the canary test of `client.test.ts`, which also counts the sentences.
- **A refused write is tried three times, in the adapter** (`SECURE_WRITE_RETRY_DELAYS_MS`;
  a read and a delete once, a value too large never), **and after the last refusal twice
  more by itself** (`SECURE_REWRITE_DELAYS_MS`, 1 s and 5 s: few and bounded; never a
  loop, never a third). A try that is **waiting**, now or later, never lands over a newer write or
  a sign-out of the same entry: the order is one counter **per store object and entry, in
  the module** (`entries`, a `WeakMap`), never per adapter, so two clients over one store
  see each other. A newer write or a delete calls a waiting try off, and its timer is
  `unref`ed where the runtime has that. **A write already in the store's hands is not
  recalled, and never say it is**: a later try that is taken after a sign-out is followed
  by one delete of the entry (asked once, a refusal left at that, never a loop), and one
  overtaken by a newer write gets nothing added, its order against that write being the
  native layer's (a test pins the fake's order and says so in its name). Never add a
  delete after a newer write: it would take a signed-in user's token. Every call the
  timer makes is started inside a promise (`started`), so a store that throws at the
  call cannot throw out of a timer. Keep the tests of each ("offered again, later",
  "two adapters over one secure store"). **The adapter waits only through its `Schedule`**
  (`ExpoRuntime.schedule`): a test passes `fakeSchedule` and never sleeps; one test checks
  the real default. **"The session is kept" is true of the running app only**:
  after three refused writes the store holds a token the server has replaced, and an app
  ended then and started past the grace window is signed out by the server
  (`session.reuse_detected`). `getToken()` reports none of it (`@tula-tech/core`'s behaviour,
  unchanged). Say all of that wherever `storage.failed` is documented, and never word a
  failed write as harmless.
- **iOS and Android only.** Any other `Platform.OS`, Expo web included, is a `TypeError` at
  construction: never guess a client kind.
- **Headless.** No component, no stylesheet, no `react-dom` and no React Native component
  in `src/` outside tests. A flow hook's `screen` is `flowScreen(step, waysOf(client))`:
  the status where the hooks have an action, `not_supported` otherwise (an unknown status,
  or a known one that offers only ways this client cannot do: an emailed link without
  `emailLinkUrl`, a passkey without a sheet the device supports, a provider without a browser and without
  that provider's own sheet). A new action
  widens the lists in `screens.ts` in the same change, with a row in its table test.
- **Six modules import a native package, one each, and nothing else does**:
  `src/native.ts` (`expo-secure-store`, `react-native`), `src/passkeys.ts`
  (`react-native-passkey`), `src/browser.ts` (`expo-web-browser`), `src/apple.ts`
  (`expo-apple-authentication`), `src/google.ts` (`react-native-nitro-google-signin`) and
  `src/device-key.ts` (`@pagopa/io-react-native-crypto`). The last five are entry points
  of their own (`@tula-tech/expo/passkeys`, `/browser`, `/apple`, `/google`, `/device-key`)
  that **no other source of the package imports** (`package.test.ts`): an app that does
  not offer a way never loads its module and does not install it. Never import one from
  `index.ts`, and never reach a native module with a `require` in a `try`. Everything
  else takes the platform, the store, the sheets, the browser and the key store as
  arguments (the adapters take the modules as arguments too, and are tested without
  them: `src/adapters.ts`, and `src/id-token-adapters.ts` and `src/device-key-adapter.ts`
  apart from it, because the bundler copies a whole module into every entry point that
  imports from it). The repository installs none of them (510 lockfile entries for the
  first two imports alone): they are peers marked optional here. Packed, the secure store
  and React Native are required and **only the other five stay optional**
  (`publishConfig.peerDependenciesMeta`; the release harness test holds both).
  `src/native-modules.d.ts` declares what the modules read, copied from the packages' own
  declarations, with the versions in its comment. **`@tula-tech/expo/google` throws when it is
  imported where its module is not in the build** (the module's doing): say so wherever
  the entry point is documented. Never add `expo`,
  `expo-*`, `react-native` or `react-native-*` to a manifest of the workspace.
- **A passkey is asked for through `Environment.passkeyProvider`, and one at a time**
  ([ADR 0048](../../docs/adr/0048-expo-passkeys-and-providers.md)). `@tula-tech/core` asks the
  provider where the environment has one and `navigator.credentials` otherwise; the four
  `passkey.*` codes are still decided there, from the rejection's `name`. `@tula-tech/expo`
  puts `oneAtATime(sheet)` between the two: a request while another is out is **refused**
  (`AbortError`, so `passkey.cancelled`), never joined (its answer would be for another
  challenge) and never queued, and the place stays taken until the sheet itself answered
  or `PASSKEY_SHEET_CEILING_MS` passed (five minutes, the challenge's lifetime, held
  equal to the contract's by a test and waited for through the package's `Schedule`):
  after it a late answer is dropped, never used. The hooks ask `requireFreeSheet` first
  and say `flow.busy` for a place that is taken, before any request; never a new code
  for it, and never `dismissed` for a sheet nobody was shown.
  An adapter maps a module's failure to a `name` and **drops the module's message**. The
  device is asked whether it has passkeys each time, never when the client is created.
- **A dismissed sheet and a closed browser are `dismissed`, never `error`** (the flow
  hooks, `usePasskeys`; the outcome `cancelled` of `signInWithProvider`): nothing was
  sent to prove anything, nobody is signed in, and the action works again. Keep the test
  of each.
- **A provider round trip keeps its binding in memory and reads one URL.** The client's
  `tabStorage` is a `Map` in `createHost`'s closure: never the secure store, a file, a
  log line, an error or a URL the package builds. The client's `page` has an address
  only inside `signInWithProvider` / `linkProvider` (cleared in a `finally`), so
  `signIn.withOAuth` and `handleOAuthCallback` called on the client directly are refused
  or find nothing. **What the browser returns is read only when it is the redirect URL
  that was asked for, character for character, followed by `#`** (iOS matches by scheme,
  Android by prefix); anything else, a return with no answer and a ticket with no binding
  in this client are refused **without a request**. Never normalise either side, never
  hand a deep link to the client, and never judge the redirect URL in the package: the
  server's `request.redirect_not_allowed` (with `params.reason`) is thrown as it is. One
  round trip at a time (`flow.busy`). A new refused form of a returned URL gets a row in
  the table of `src/native-ways.test.tsx`.
- **An emailed link is asked for and opened only by a client created with `emailLinkUrl`**
  ([ADR 0055](../../docs/adr/0055-expo-emailed-link.md); `src/email-link.ts`): one `https` app
  link with no query, fragment, user name, backslash or white space, judged at
  construction with one fixed sentence (never a custom scheme: any app can claim one, and the
  server refuses one for a link). Without it nothing has changed: asking is
  `storage.failed` before any request and a step that offers only a link is
  `not_supported`. The server and `@tula-tech/core` were not changed for it, and are not to be.
  - **The link's binding is in memory and nowhere else** (`memoryLinks` in `host.ts`: the
    environment's `linkStorage`, a `Map` in the client's closure), for
    `EMAIL_LINK_BINDING_TTL_MS` (fifteen minutes, held equal to `@tula-tech/core`'s by a test)
    on the device's clock in either direction. Never the secure store, AsyncStorage, a
    file, a log line, an error or a URL. **Do not move it to the secure store to make a
    link survive the app being ended**: only the holder of the attempt's secret
    completes, that secret is in memory, and a binding that outlived it would let a
    restarted app spend a link nobody can finish. Persisting an attempt (its secret, a
    call that resumes one) is a decision of its own, named in the ADR.
  - **A URL the app was opened with is read only when it is `emailLinkUrl`, character for
    character, followed by `#`, with a token and an attempt in its fragment, for the
    sign-in it was handed with, while the client still keeps that attempt's binding.**
    Anything else is refused **without a request** (`unexpected_url`, `no_link`,
    `not_started_here`): a platform hands an app whatever matched by host and path
    prefix, and anybody can open an app with a URL. Never normalise either side, never
    send a link to find out whether it is this client's, and never read a link from
    anywhere but what the app passed to `openEmailLink`. A new refused form gets a row in
    the table of `src/email-link.test.tsx`.
  - **Accepting a link signs nobody in.** `openEmailLink` presents the link once
    (`handleEmailLink({ waitMs: 0 })`, the page's address cleared in a `finally`) and
    then asks the flow that asked, once, to finish; no polling. A refusal the server
    sent to the link spent nothing. **A link request that got no answer may have been
    taken** (the token spent, the attempt proven, the binding still kept, so the same URL
    is then `expired`): never word it as "nothing was spent", and never ask the flow to
    finish on that guess. `finishEmailLink()` is the documented thing to try after a lost
    answer or an `expired` for a link the sign-in asked for (unchanged step and nothing
    counted where the link was not taken; `journeys.test.ts` holds both against the real
    API). A link taken whose finishing call got no answer is
    `accepted` with `failure`, and `finishEmailLink()` asks again. One link at a time,
    and never beside a provider's round trip (`flow.busy`: they share the client's one
    address).
  - **The hook says `verification.different_browser` and `verification.expired`**, the
    contract's codes for the same answers, the first without a request; no code was
    added. `openEmailLink(url)` resolves `null` for a URL that is not the client's link,
    so an app hands over every URL it is opened with. The package imports no native
    module for it: the app passes the URL from React Native's `Linking`.
  - **After the app was ended the link opens nothing, and the docs say so**: the user
    asks again, and the old email's code is of no use either. Never word a link as
    working after a restart, or on a phone at all: no emailed link has opened an app
    through this package (`docs/plans/phase-2-unverified.md`, "Step 2.13, an emailed
    link").
- **The versions written anywhere are the ones the Expo SDK pins**
  (`expo/bundledNativeModules.json`: for SDK 57, React 19.2.3 and React Native 0.86.3),
  never the registry's `latest`: React Native's did not bundle under Expo 57.
- **Its suite is `src/journeys.test.ts`**: the shared journeys (`sdkJourneys`, below)
  through this package's client, as an `ios` client on a fake secure store, with the DOM's
  globals taken away (`hideDom()`: a path that needs `window`, `document` or web storage
  fails there). Four capabilities are on: `idToken` (`signIn.withIdToken` on the client as
  it is; the suite's own journeys go through `signInWithIdToken` and scripted sheets),
  `oauth` (a fake `BrowserSession` the journey scripts, against the mock provider),
  `passkeys` (a `PasskeySheet` over the journeys' software authenticator, the client
  registered as a native app) and `deviceKey` (the journey's software key behind the
  `DeviceKeyStore` interface: `src/testing/fake-device-keys.ts`). The emailed link's
  journey is the suite's own (`withEmailLink` on its device; the URL is handed over as an
  operating system would hand it). What a later scenario leaves out is
  `not_built` in `expo`'s column of `conformance/client-journeys.json`, with its ticket;
  today there is none.
  The suite's own test holds the count per ticket. A
  feature that arrives (a provider, a passkey, a device key) turns its capability on and
  its entries into `journey` in the same change. `not_applicable` is only for what an app
  can never reach (an administrator's routes, a browser's cookie session, the deployment).
- **The example is `examples/expo/app`, and `examples/expo` is not a workspace package**
  (no `package.json` there, on purpose). It installs by itself from the packed packages,
  and with `react-native-passkey` in it needs a development build (not Expo Go).
  The repository compiles its sources against `@tula-tech/expo`'s sources and
  `examples/expo/shims.d.ts` (`typecheck:scripts`); a React Native member the app starts
  to use is added to the shim, from React Native's own declaration.
- **Apple's and Google's sheets are shown between `@tula-tech/core`'s two steps, and nothing
  else is added** ([ADR 0052](../../docs/adr/0052-expo-native-providers-and-device-keys.md);
  `signInWithIdToken`, `useSignIn().withIdToken`). **For Apple the package hashes the
  nonce** (`sha256Hex`, the package's own SHA-256, held to WebCrypto and to the server's
  `appleNonceClaim` by tests): `@tula-tech/core` never does, and an app never has to. Google's
  sheet gets the nonce as it is; Apple's name goes beside the token and Google's never.
  A dismissed sheet is the outcome `cancelled` and a hook's `dismissed`, never `error`,
  and no exchange is made. One sheet of any kind at a time (`flow.busy` before any
  request, across a provider's sheet, a passkey sheet and the browser); a sheet holds its
  place for `ID_TOKEN_SHEET_CEILING_MS` at most, waited through the `Schedule`, and a
  late answer is dropped. **What a sheet throws never reaches an error**: the failure is
  the client code `internal`, whose `cause` is a fixed sentence of the package's and
  never the sheet's own error; an adapter keeps a
  module's code word to tell a dismissal apart and drops its message. The ID token is
  kept nowhere. Keep the canaries of `src/id-token-sign-in.test.tsx`.
- **A control for a provider's sheet is hidden until the sheet says it is there**
  (`useIdTokenProviders()`: both `false` until asked, after mount, never during render;
  `IdTokenSheet.isAvailable` is asked each time, never when the client is created, and a
  throw or a rejection is "not there"). `signInWithIdToken` asks again and refuses with
  `storage.failed` before any request.
- **A session is bound to the device's key through a key store the app hands over, and
  the package decides which key and when** (`src/device-binding.ts`, ADR 0052). One
  alias (`DEVICE_KEY_ALIAS`); the key is looked for at a start, made if there is none,
  one look at a time. Where `isAvailable()` is not `true` a start goes without a proof
  (the server's profile then decides: never answer `device.binding_required` by making
  a software key). **A bound session's refresh is proved by its own key or not sent**:
  never by another key, never without a proof.
- **A stored token is marked only on the server's word.** `@tula-tech/core` tells the storage
  nothing about the attempt a token came from, so the client's `fetch` goes through the
  binding's `watch`: for each successful answer that issues a session (a refresh's
  tokens, a completing step's `session`) it remembers, by the hash of the refresh token,
  this device's x coordinate **when the answer's access token says `cnf.jkt` is the key
  this run last found, and nothing otherwise**; `set` writes what its own token's answer said.
  The key compared with is kept apart from the one a failed signature makes the next
  request look for again (an answer on its way was proven by it), and the hashes are in
  memory only, at most four, and cleared when the entry is removed.
  Never mark from "a start carried a proof" (a start that fails or is left would mark
  the next refresh of an unbound session, which a lost key then deletes), never keep a
  mark across a write, and never let a failure to read an answer be anything but "not
  marked". The access token is read for that one fact and trusted for nothing. Keep the
  tests of "which sessions are marked" in `src/device-binding.test.ts`.
- **A stored bound session is marked with its key, and a lost key is found before any
  request.** The entry is `<token>`, a line break, the key's public x coordinate. At a
  read of a marked entry: the same key means the token is handed on; **a key made just
  now, another key, or no key store means the entry is removed (asked once) and the read
  answers `null`: signed out locally, no request, no retry**; **a rejection means the
  read rejects (`storage.failed`, session kept)**. A key that could not be reached is
  never taken for a key that is gone: `deviceKeyStoreOver` says `created` only when the
  module's `generate` resolved, **calls `generate` only after two lookups in a row said
  "not found"** (found at the second look it is the key; any other rejection is a
  failure with nothing made), and every failed lookup that is not "no such key" is a
  rejection. Never make a key on one "not found", and never word the two looks as
  closing the case: no device was asked. Never end the local session for a `device.*` code, never weaken a server
  rule to spare the sign-in, and never tell "gone" from an error's text. The server is
  not told of the dropped session (stated in `docs/expo.md`).
- **"This device cannot keep the key" is three of the module's words and an RSA key,
  and only after a lookup that found nothing** (`CANNOT_MAKE` in
  `src/device-key-adapter.ts`: `WRONG_KEY_CONFIGURATION`, `UNSUPPORTED_DEVICE`,
  `API_LEVEL_NOT_SUPPORTED`): the store then says it is not there for the rest of the
  run, and the start that found out goes without a proof. Any other rejection fails that
  call and says nothing about the device. A new word in that list is a decision in ADR
  0052: it turns a failure into an unbound session.
- **The config plugin is a function over the configuration that imports nothing**
  (`src/plugin.ts`, `@tula-tech/expo/plugin`: `withTula`, `reversedGoogleClientId`). No
  `@expo/config-plugins`, no native file, no state; it only adds, adds nothing twice,
  leaves its input alone, and a refusal names the option and never the value. It is
  built as CommonJS (what Expo `require`s) and as a module (`package.test.ts` requires
  the built `plugin.cjs` and holds that it imports nothing).
- **Never say it runs on a phone until it has.** What was run against real Expo (an
  install, `tsc`, a Metro bundle) and what was not (the app itself) is in
  `docs/plans/phase-2-unverified.md`, the three sections of "Step 2.13"; an item is struck
  out there, with what was run, when someone runs it. **No passkey sheet, no system
  browser and no provider's sheet has been opened by this package, no key was made in a
  phone's secure hardware, and Expo never ran the plugin as it is now** (an earlier form
  of it, with an option for the native screens that has since moved to
  `@tula-tech/expo-screens/plugin`, was run once by `expo prebuild` in a scratch app, without
  the `google` option, and no app was built from what it wrote: "Step 2.16"): never word a passkey, a
  provider sign-in, Apple's or Google's sheet, a hardware key or the plugin as working on
  iOS or Android, in a doc, a README, a changeset or a JSDoc, until one has. A key is
  "a key the device keeps" or "non-exportable by the module's source", never "verified".

## Tests and hooks in detail

What the section above does not say (moved from `sdk.md`).

- Tests pass `FakeSecureStore` and a platform name to `createExpoClient`, and fakes as the
  `passkeys`, `browser`, `apple`, `google` and `deviceKeys` options (`fakeDeviceKeys` in
  `src/testing/fake-device-keys.ts`). Hook tests need a renderer and register happy-dom
  (`src/testing/dom.ts`).
- After an `await` a hook checks it is still the same flow and session before setting state,
  as `@tula-tech/react`'s do. Expo web uses `@tula-tech/react`.
- `src/plugin.ts` is tested on plain objects.
- A provider round trip never takes a URL from anywhere but the browser session.
  `native-ways.test.tsx` has the canaries of a ceremony and a round trip (nothing in the
  secure store, a log, an error or a URL), and a new path keeps them.
