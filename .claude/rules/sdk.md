---
paths:
  - "packages/core/**"
  - "packages/react/**"
  - "examples/react-vite/**"
  - "e2e/**"
  - "packages/nextjs/**"
  - "examples/nextjs-app-router/**"
  - "packages/expo/**"
  - "packages/admin/**"
  - "packages/config/**"
  - "packages/cli/**"
  - "packages/mcp/**"
  - "packages/create-tula/**"
  - "examples/tula-config/**"
---

# SDK rules

- SDKs hold **no auth logic** beyond rendering flow steps, storing tokens and refreshing. Flow
  decisions come from the server (`FlowStep` in `@tula/contract`).
- Every public export is part of the semver surface: JSDoc with `@example`, no breaking changes
  without a major changeset.
- Token refresh is **single-flight**: concurrent requests hitting an expired token share one
  refresh, in one client and (through a Web Lock and a `BroadcastChannel`) across tabs. Every
  change to `packages/core/src/session.ts` needs a test for the interleaving it touches:
  refresh racing sign-out, a refused refresh with waiters, another tab's message arriving
  mid-refresh. A result that arrives for an older session generation is never installed.
- A refused refresh (`session.*`, `auth.unauthenticated`, `auth.user_banned`) ends the session
  once: no retry, one notification. Any other failure keeps the session. The only automatic
  retry in the SDK is one immediate repeat of a refresh that got no answer (`network.timeout`,
  `network.failed`), inside the single flight and inside `REFRESH_RETRY_WINDOW_MS`; an HTTP
  answer of any status is never retried. Honour `Retry-After` by failing fast, not by sleeping.
- Storage: httpOnly cookies on web (SDK never reads the refresh token), Keychain/Keystore on
  native, memory otherwise. Never `localStorage` or `sessionStorage` for any token or for an
  attempt's secret, and never a token, secret or password in an error, a log line or a
  `toJSON`.
- **The one permitted use of `localStorage`** is the emailed-link binding
  (`packages/core/src/email-link.ts`, key `tula.link.<attempt id>`): a new tab of the same
  browser has to read it, and it is not a token and not the attempt's secret (alone it
  authorizes nothing; with the emailed token it only marks an attempt proven, and the session
  still goes to the tab holding the secret). Every access is guarded: without storage the link
  is unavailable and the code path remains. It is removed when the link is used, the sign-in
  completes or the flow is discarded, and expires on the device's own clock. Nothing else may
  be added to it.
- **The one permitted use of `sessionStorage`** is the OAuth binding
  (`packages/core/src/oauth.ts`, key `tula.oauth.<attempt id>`, ADR 0026): the page is replaced
  by the provider's and loaded afresh, so memory does not survive, and only the same tab may
  read it back. Like the link binding it is not a token and not the attempt's secret (which is
  deliberately lost with the navigation; the exchange returns a new one). It is removed on
  every **definitive** outcome of `handleOAuthCallback()` (success, and any refusal by the
  API), and expires on the device's clock. The one case it is kept: the exchange got no answer
  (`network.failed`, `network.timeout`) or a `rate_limited`. Then the error is thrown, the
  binding stays, and the ticket is held **in memory only** (a closure of the client, for 60
  seconds; never storage, the address, an error, a log line or `toJSON`) so that a second
  `handleOAuthCallback()` retries; sign-out, `signIn.discardOAuthCallback()` and a new round
  trip forget it. An OAuth ticket is read from the URL fragment and removed from the address
  before any request; a code from the fragment is passed on only if the contract defines it.
  `redirectUrl` must be on the page's origin (`link.cross_origin`).
- An emailed link leads to a page on the **same origin** as the page that asked (the binding is
  in that origin's storage); `prepareFirstFactor` refuses another origin with
  `link.cross_origin` where a page origin is known. `verification.expired` never removes a
  binding: an old or forged link must not undo the current one.
- An emailed link's token is read from the URL **fragment** and removed from the address
  (`history.replaceState`) before any request; it is sent only in a JSON body.
- A wait (`waitForEmailLink`) leaves nothing running: one timer per round, cancelled before the
  wait settles; it ends on completion, abort, `discard()`, sign-out or an error, and obeys
  `Retry-After`. Each caller leaves with its own signal; a wait restarted in the same tick as
  its predecessor was aborted must keep going.
- A signed-out client stays signed out: no late 401, in-flight refresh or other tab's message
  about an ended session may sign it back in. A 200 is validated (hand-written guards) before
  tokens or a flow are built from it. Look server-supplied keys up with `ownString` /
  `Object.hasOwn`, never by plain indexing.
- The refresh request's timeout (`REFRESH_TIMEOUT_MS`) must stay below `MIN_REUSE_GRACE_PERIOD`
  in `packages/contract/src/session-profile.ts`: the smallest refresh grace window a session
  profile may set, other than none at all (ADR 0028); a test holds it.
- **A `stateful` session has no token.** Only a `web` client accepts a session without an
  access token (`isStatefulSession`); for it `getToken()` returns `null` and asks nothing,
  calls go out without `Authorization` and rely on the httpOnly cookie, a 401 signs the client
  and its other tabs out at once (no refresh, no retry), and nothing of the session is ever
  put in storage or a cross-tab message beyond its id. Never synthesize a token for it.
- `flow.discard()` ends an attempt, on every kind of flow: the secret is forgotten (later
  actions throw `flow.invalid_step` without a request) and an answer still in flight is
  dropped in `accept` before anything is taken from it, so a late `complete` never reaches
  `session.adopt`. A change to `createAttempt` keeps the test that holds a response, discards
  and resolves it with `complete`. Accepted residual (ADR 0021): on `web` the browser has
  already stored that answer's refresh cookie, so a reload would find the session unless a
  later sign-in replaced the cookie.
- **A sign-out the server was not told of can be sent again.** A non-`web` client has dropped
  its refresh token by the time a failed `signOut()` rejects, so it keeps that token **in
  memory only** (`undelivered`, a closure of the session manager; never storage, a cross-tab
  message, an error, a log line or `toJSON`) and the next `signOut()` presents it. Nothing
  else reads it: no refresh may present it, and the client stays signed out throughout. It is
  forgotten when delivered, on a `session.*` answer to the sign-out and when a new session is
  adopted; there is no timer (ADR 0021 says why). Keep the tests of all three.
- One error class: every failed call throws `TulaError` with a contract code or one of the
  client's own (`network.failed`, `network.timeout`, `response.invalid`, `storage.failed`,
  `flow.busy`, `link.cross_origin`, `passkey.unsupported`, `passkey.cancelled`,
  `passkey.already_on_device`, `passkey.failed`), all `status: 0`.
- **Passkeys (ADR 0027) use no WebAuthn dependency.** `packages/core/src/passkey.ts` calls
  `navigator.credentials` through `Environment.passkeys`, with the browser's JSON helpers where
  they exist and its own base64url conversion otherwise; where the environment has a
  `passkeyProvider` (ADR 0048: a runtime with no `navigator.credentials`, supplied through
  `createTulaClientWithEnvironment`) that is asked instead, with the options and the
  credential in WebAuthn's JSON form, and its rejection's `name` decides the code exactly
  as a browser's does. A ceremony's failure is one of the
  four `passkey.*` client codes and never carries the browser's message or the credential;
  nothing of a ceremony (challenge, response) is kept. What the authenticator returns is
  checked before it is sent, and a 200 from a passkey route before anything is built from it.
  An autofill request (`withPasskey({ autofill: true })`) takes the caller's signal, restarts
  with a fresh attempt before its challenge lapses, and leaves no timer behind.
- Types come from `src/generated/api.gen.ts` (run `bun run core:generate` after
  `contract:generate`); run-time imports from the contract use its Zod-free entry points only.
  No `Buffer`, `process` or `node:` import: `typecheck:portable` must pass.
- Every conformance scenario, and every named client behaviour, has a decision for every
  client in `conformance/client-journeys.json`: `journey`, `not_applicable` with a reason
  (no client of that kind can ever reach it), `not_built` with a `ticket` and a reason (a
  scenario this client has no call for yet; never a behaviour, never for `core`),
  or `undecided` (only while that client's `suite` is `planned`). For `@tula/core` a
  `journey` is a `journey('<scenario name>', …)` or a `behaviour('<id>', …)` test in
  `apps/api/src/testing/sdk-journeys.ts` (`sdkJourneys(target)`, which
  `apps/api/src/sdk-journeys.test.ts` runs for `core` and `packages/expo/src/journeys.test.ts`
  for `expo`), and the guard there fails when the file and the tests
  disagree in either direction. A new SDK's suite (Swift, Kotlin) reads the same file,
  sets its `suite` to `exists` and decides everything in that change, and checks with
  `@tula/conformance`'s `clientJourneyListProblems` and `clientSuiteProblems` or the same
  rules from `conformance/client-journeys.schema.json`. The JSON scenarios themselves are
  HTTP-level and are run by servers and native SDKs.
- `needs_new_password` in a sign-in (`reason: 'expired'`, ADR 0041) is answered with
  `flow.submitNewPassword`; `<SignIn>` draws `ExpiredPasswordScreen` for that reason and
  the "not supported" screen for the step with no reason or one it does not know. Its
  history line is drawn for `max(history, 1)`: the expired password is refused whatever the
  policy remembers. Its words are `localization.expiredPassword`.
- Check browser behaviour in a browser: `bun run playground`.

## React SDK (`packages/react`, ADR 0022)

- Runtime dependencies: `@tula/core` and the contract's Zod-free entry points. No CSS
  framework, icon library, CSS-in-JS runtime or router. React is a peer (18.2+ and 19).
- Components draw `step.status` and contain no flow logic. The default branch of a step
  `switch` is `UnsupportedScreen`. A new method is a screen plus an entry in
  `FIRST_FACTOR_FORMS`. An effect that starts a wait aborts it in its cleanup and must survive
  being run twice (StrictMode); a hook that reads the page's address does so through
  `@tula/core`, never `location` itself.
- One stylesheet, `src/styles.css`: every selector inside `:where()`, classes prefixed
  `tula-`, colours only through the private `--_tula-*` properties. Its token block is
  generated (`bun run --filter @tula/react generate`) from `@tula/contract/theme`; change
  tokens there. `package.test.tsx` enforces all of it.
- Every stylable part goes through `el('<name>')` with a name from `ELEMENT_NAMES` (class
  `tula-<kebab>` and `data-tula-element`). Adding a name is additive; removing or renaming one
  is breaking.
- Every user-visible string is in `src/localization.ts`. Server error messages come from
  `@tula/core` by code; never copy one into the table.
- Nothing during render touches `window`, `document`, `Date.now()` or storage (`ssr-render.tsx`
  proves it in a process without a DOM). No `dangerouslySetInnerHTML`. No `console`.
- Destinations are developer-supplied props only, passed through `go()` / `safeUrl()`. A
  relative destination means this origin: a value with no scheme that names a host is refused.
- Sign-out from a component goes through `useTulaContext().signOut`: no navigation unless the
  server was told; otherwise the provider's `SignOutFailedDialog` says the session may still
  be active and offers a retry. Never `client.session.signOut().catch(() => undefined)`.
  The dialog belongs to the client whose sign-out failed: it is not drawn for another
  `client` the provider is given later, so its retry never reaches a different client.
- A provider dialog (`Modal` in `components/prompts.tsx`) gives the focus back to what had it
  when it opened; when that is gone or was the document (the "Sign out" item after the client
  signed out, a sign-in form after an enrolment) it goes to the first tabbable element of the
  page (`firstTabbable`), and stays put only when the page has none.
- Theme values reach the page only through `themeToCssVariables`, which validates them
  (`isValidThemeValue`). They are untrusted: never interpolate one into CSS or a style
  attribute yourself.
- After an `await` on the API, check the session is still the one the call started under
  before setting state; never share an in-flight request across sessions. Do not drop a flow
  object in an effect cleanup (`<Activity>` re-runs effects with state kept).
- Passwords and codes: component state only while the form is on screen; cleared on submit of
  a sign-in password and on completion.
- Accessibility: a real `<form>` and `<label>` per field (`TextField`), errors through
  `errors` (sets `aria-invalid`, `aria-describedby`, `role="alert"`), `Button` for anything
  that can be pending (`aria-disabled`, never `disabled`), focus on the title when a screen
  changes (`Card focusTitle`). Tab order follows the document: put a secondary action after
  the field it belongs to.
- Tests: `bun test` in happy-dom (preload `src/testing/setup.ts`), Testing Library queries by
  role and label, the world from `src/testing/harness.tsx`. Coverage is per file (90%).
  Absence is `expectAbsent(screen.queryBy…(…))`, never `expect(…).toBeNull()` on a query's
  result (a failing matcher formats the element's whole window). An awaited `findBy…`,
  `waitFor` or `w.user` call returns after the last commit's effects and the renders they
  asked for (`src/testing/settle.ts`), not after work a timer or a later task starts: do not
  configure another `asyncWrapper`.
- The texted sign-in code (`sms_code`, ADR 0037): the first field takes a phone number only
  where the client configuration lists `smsCode` (then a text field with
  `autocomplete="username"`; an email field's own validation would refuse a number). A
  number is shown `sms_code` and nothing else (a password for a number signs nobody in), an
  address is never shown it. **Nothing is texted on arrival**: a message costs money, so
  the screen asks with a button. The words never claim a message was sent ("if you can
  sign in with this number…"), and `auth.invalid_credentials` on this screen is said about
  the code, not about a password.
- A texted code as the second step (`sms_code`, ADR 0025): the second-factor screen, the
  step-up dialog and the account page ask for the message with a button and draw the code
  field only after a send of that screen succeeded. **Nothing is texted on arrival**, also
  where it is the only option. `@tula/core` never asks by itself
  (`flow.prepareSecondFactor`, `session.prepareStepUp`, `mfa.startSms`). The account page
  offers it only where `Factors.sms.available`, and says in words when an enrolled one is
  not in use beside a stronger factor.
- A passkey is listed among a screen's other ways only once the browser is known to have
  WebAuthn (`usePasskeySupport() === true`), on the first-factor, second-factor and step-up
  screens alike: "not ruled out yet" is for the screen itself, never for a link. The accepted
  cost is that a browser with WebAuthn draws the link one commit after the screen; do not
  "fix" that by reading support during render.
- Browser tests live in `e2e/tests`. A new screen or state gets a scenario and an
  `expectAccessible` call in both colour schemes; no axe rule is disabled without a comment
  saying why. `e2e/server.ts` must keep refusing to start without `E2E=1`.
- Passkeys (ADR 0027): every ceremony the components start is in `components/passkey.tsx`.
  Support is asked after mount (`usePasskeySupport`), never while rendering; the sign-in button
  and the profile's "Add a passkey" are left out where the browser has no WebAuthn, and a
  second factor or step-up that is only a passkey says so. The autofill request is started
  from an effect with a signal per run, never marks the form pending, and is aborted before
  the button's own ceremony (one WebAuthn request per page) and started again after every
  ceremony of the button that did not sign in. A sign-in the component runs outside the flow
  hook (`client.signIn.withPasskey`) takes `useCompletion`'s `hold` before its first await and
  releases it after handing its flow on: never a timer. `passkey.cancelled` goes to
  `Status` with `tone='neutral'` (not the success colour, not an alert), and focus returns to
  the button. The profile's section always loads the list: with the method off it shows what
  the user has (rename, remove) without "Add". Component tests fake
  `navigator.credentials` through the world's `passkeys` option; browser tests use a DevTools
  virtual authenticator (`addVirtualAuthenticator` in `e2e/tests/support.ts`), which answers a
  conditional request by itself unless told to wait (`setAnswering(false)`).
- A texted second step (ADR 0025): `TextedCodeForm` (`components/mfa.tsx`) is the one form,
  for the second-factor screen, the step-up dialog and the profile's enrolment. On a
  refusal an operator's setting causes (`SWITCHED_OFF`: `auth.method_disabled`,
  `sms.disabled`, `sms.country_not_allowed`) it shows the code's message and removes its
  own controls (send, field, resend): never leave a button that can only be refused again.
  `sms.unavailable` keeps the button. `<UserProfile>`
  says a dormant texted code is "not asked for while … and … your second step again"
  (`mfa.smsNotInUse`), and `PasskeysSection` with `secondStep: 'texted_code'` writes
  `passkey.replacesTextedCode` above "Add a passkey" as the button's description, before
  any ceremony. **"Add a passkey" is unavailable until the two-step section has read the
  account's factors** (`secondStep: 'checking'`, said with `passkey.addChecking`), and
  stays so when that read failed (`'unchecked'`, `passkey.addUnchecked`, no retry control:
  the two-step section says its failed read the same way): focusable, `aria-disabled`,
  described by the reason. What was read belongs to the session it was read for. The two
  sections tell each other what changed through `UserProfileSections` (`onSecondStep`,
  `revision`), never through a second request of their own.
- Two-step verification (ADR 0025): `needs_second_factor` and `needs_factor_enrolment` have
  screens (`components/mfa.tsx`); an option this version does not know is left out, never
  guessed. The setup key, its QR code and backup codes are state only while their screen is
  open: a test asserts nothing of them is left in the DOM afterwards. Backup codes of an
  in-flow enrolment and the step-up dialog are drawn by the provider (`components/prompts.tsx`),
  because the component that asked may be unmounted; completion waits for "I have saved these
  codes". Sensitive calls go through `useStepUp()`; no component decides which calls those are.
  The QR code comes from `src/qr` (no dependency), loaded with `import('../qr')` so it stays a
  separate chunk (a test holds both budgets), drawn dark on white with a four-module quiet
  zone, and decoded by `jsqr` in tests.

## Expo SDK (`packages/expo`, ADR 0046, ADR 0048, ADR 0052, ADR 0055, ADR 0063)

- `@tula/core`'s client with a secure-store `TokenStorage`, a provider and hooks. No auth
  logic, no second session, no component, no `react-dom`.
- The refresh token goes through `secureStoreStorage` only: one of the two device-only
  Keychain classes, no cache, a value over `MAX_SECURE_VALUE_BYTES` refused, a rejection of
  the store passed on (the client says `storage.failed` and keeps the session; never
  `null` for a failed read). A refused write is tried three times
  (`SECURE_WRITE_RETRY_DELAYS_MS`) and then twice more by itself
  (`SECURE_REWRITE_DELAYS_MS`); a try that waits never lands over a newer write or a
  sign-out of the entry, by any adapter over the same store object. A write already in
  the store's hands is not recalled: after a sign-out it is followed by one delete, after
  a newer write by nothing (the order is the native layer's; never word it as kept); every wait goes through the `Schedule`;
  a read and a delete are asked once. `useAuth().loadError` is the last failed load's
  `TulaError` while `loading`, and the provider keeps trying whatever the code. `client`, `storage` and `deviceKey` are refused as options.
- `src/native.ts` is the only module that imports `expo-secure-store` or `react-native`,
  `src/passkeys.ts` the only one that imports `react-native-passkey`, `src/browser.ts`
  `expo-web-browser`, `src/apple.ts` `expo-apple-authentication`, `src/google.ts`
  `react-native-nitro-google-signin` and `src/device-key.ts`
  `@pagopa/io-react-native-crypto`, and `src/native-screens.ts` `expo` (its module API);
  the last six are entry points no other source imports. None is installed here, and `src/native-modules.d.ts` declares what they
  read. Tests pass `FakeSecureStore` and a platform name to `createExpoClient`, and fakes
  as the `passkeys`, `browser`, `apple`, `google` and `deviceKeys` options
  (`fakeDeviceKeys` in `src/testing/fake-device-keys.ts`).
- A provider's own sheet (`id-token-sign-in.ts`): `@tula/core`'s `signIn.withIdToken`,
  the sheet, the exchange. Apple's sheet gets `sha256Hex(nonce)` and its name goes beside
  the token; Google's gets the nonce as it is. A dismissal is `cancelled` / `dismissed`,
  never `error`; a sheet's failure is `internal` and carries nothing the sheet threw; one sheet of any kind
  at a time (`flow.busy`); `useIdTokenProviders()` is `false` for both until the sheets
  answered. `src/id-token-sign-in.test.tsx` has the canaries.
- Device binding (`device-binding.ts`): the app gives a `DeviceKeyStore`, never a key.
  A bound session's entry is the token, a line break and its key's x coordinate, written
  only when the answer that issued the token says so (`watch` over the client's `fetch`
  reads the access token's `cnf.jkt`; never from "a start carried a proof"). The adapter
  makes a key only after two lookups in a row said "not found". A read
  of a marked entry whose key was made just now, is another one or has no key store is
  removed and answers `null` (signed out, no request); a key store that rejects makes
  the read reject (`storage.failed`, session kept). A bound refresh is proved by its own
  key or not sent. Only `CANNOT_MAKE`'s words and an RSA key make a store "not there";
  a new word is a decision in ADR 0052.
- `src/plugin.ts` imports nothing and is tested on plain objects; it is built as
  CommonJS and as a module, and writes no native file.
- A passkey goes through `oneAtATime(sheet)`: a second request while one is out is
  refused as called off, never joined or queued; the place is given up after
  `PASSKEY_SHEET_CEILING_MS` and a late answer dropped; the hooks say `flow.busy` for a
  place that is taken (`requireFreeSheet`), before any request. `passkey.cancelled` and a closed browser
  set a hook's `dismissed`, never its `error`. An adapter keeps a module's failure word
  and drops its message.
- A provider round trip (`provider-sign-in.ts`) keeps the binding in memory
  (`createHost`), gives the client an address only while it runs, and reads the returned
  URL only when it is the redirect URL asked for, exactly, with a fragment; everything
  else is refused without a request. It never judges the redirect URL (the server does)
  and never takes a URL from anywhere but the browser session. Nothing of a ceremony or a
  round trip goes to the secure store, a log, an error or a URL: `native-ways.test.tsx`
  has the canaries, and a new path keeps them.
- An emailed link (`email-link.ts`, ADR 0055) is asked for and opened only by a client
  created with `emailLinkUrl` (an `https` app link; without it asking is `storage.failed`
  before any request). Its binding is in memory only (`memoryLinks`), fifteen minutes,
  never the secure store. A URL the app was opened with is read only when it is that app
  link, exactly, followed by `#` and a link of the sign-in it was handed with, whose
  binding the client still keeps; everything else is refused without a request, and a new
  refused form gets a row in the table of `email-link.test.tsx`. Accepting a link signs
  nobody in: the flow that asked is then asked once to finish. A link request that got no
  answer may have been taken (never "nothing was spent"), and nothing is asked on that
  guess: `finishEmailLink()` is what the docs name for it and for a following `expired`.
  `emailLinkUrl` has no query, fragment, `@`, backslash or white space. Never persist the binding
  or the attempt's secret, and never say a link works on a phone.
- Another platform than `ios` and `android` is a `TypeError` (Expo web uses `@tula/react`).
- A hook's `screen` is `flowScreen(step, waysOf(client))`; a status or a set of ways the
  client has no action for is `not_supported`. After an `await` a hook checks it is still the same flow and session
  before setting state, as `@tula/react`'s do.
- `src/journeys.test.ts` runs the shared journeys with the DOM's globals hidden; hook tests
  need a renderer and register happy-dom (`src/testing/dom.ts`). A feature added here
  turns its capability on in the journey target and its `not_built` entries of
  `conformance/client-journeys.json` into `journey`, and lowers the count the suite's
  "what is not built" test holds.
- The native screens (`native-screens.ts`, `native-screens-core.ts`, ADR 0063) are the
  SwiftUI and Compose screens in two views of the package's own Expo module (`ios/`,
  `android/`), on a native client that owns the session. The refresh token never
  crosses to JavaScript; an access token only as `getToken()`'s answer; an event holds
  the state (a status, two ids) or nothing; a failure crosses as its code and the
  sentence is looked up here. Options are strings and booleans. A theme goes through
  `checkTheme` (the contract's `isValidThemeValue`, refusals named by token) and is
  checked again natively. No destination prop, no `strings` prop, no rule of a flow.
  The core takes the native module and views as arguments (tests pass fakes);
  `native-screens-sources.test.ts` reads the Swift and Kotlin sources and holds the
  exchanged names equal: a new function, prop, option or code changes all three sides.
  `ios/vendor` and `android/vendor` are copies made by `scripts/vendor-native.ts`,
  never edited or committed. An app uses these screens or the headless client, not both.
- The example (`examples/expo/app`) is not a workspace package. Nothing here was run on a
  phone; no passkey sheet, system browser or provider's sheet was ever opened, no
  hardware key made, and no native screen drawn through `native-screens`; Expo ran the
  plugin once, in a scratch prebuild:
  `docs/plans/phase-2-unverified.md`, the sections of "Step 2.13" and "Step 2.16".

## Next.js SDK (`packages/nextjs`, ADR 0029)

- Four entry points, each built as one file (`splitting: false`): `.` (`'use client'`),
  `./server` (`import 'server-only'`), `./middleware` and `./handlers`. Peers: `next` 15 and
  16, `react` 19. In Next.js 16 the interceptor file is `proxy.ts` (Node.js runtime); in 15 it
  is `middleware.ts` (Edge runtime), so `src/middleware.ts` and everything it imports use web
  platform APIs only. `package.test.ts` builds the package and holds all of this.
- `src/index.ts`, `src/provider.tsx` and `src/paths.ts` are the browser's half: they import
  nothing from `config.ts`, `upstream.ts`, `session.ts` or `verify.ts`, and never name the
  secret key. Configuration is read in server code only, on first use (never at module load:
  `next build` runs without it).
- The route handler forwards `/v1/client/*` only, with allow-listed headers, the app's own
  publishable key, the browser's `Origin` unchanged (never an invented one) and, only when
  `trustedProxyHops` or `clientIp` says how it is known, the visitor's address as the one
  `X-Forwarded-For` entry (default: none; no forwarding header of the request is ever
  copied). It refuses, before forwarding, a cross-site request, a foreign `Origin` and an
  unsafe method with no `Origin`. It never follows or passes on a redirect, caps the request
  body while streaming it (413) and a buffered JSON answer (502), and never logs a request or
  a response. An answer that issues a session cookie removes the token cookies and the other
  way round (`changes` in `handlers.ts`: one entry per cookie).
- Cookies are written only through `setCookieLine` / `clearCookieLine`; a value is checked
  with `isCookieValue` first. Over https only the `__Host-` names are read.
- `verifyAccessToken` is the only way a token becomes a session, in the middleware and in
  `auth()`. A new claim check goes there and gets a failure-path test in `middleware.test.ts`
  (run for both the middleware and `auth()`).
- Custom claims (ADR 0036) reach application code only through `sessionClaims` (`verify.ts`),
  which replaces `ext` with what `readCustomClaims` accepts or removes it: for a verified
  token, the stateful check's answer and the opened `x-tula-auth` header alike.
  `auth().customClaims` is a frozen record of `unknown` values (empty when signed in with
  none, `null` when signed out). `custom-claims.test.ts` runs its malformed table for the
  middleware and for `auth()` alone; a new way a session's claims arrive gets a row there.
  `@tula/core` and `@tula/react` do not expose them.
- `x-tula-auth` is the only header that carries claims, and only for stateful sessions: sealed
  with `sealClaims`, opened with `openClaims`, stripped from every incoming request by
  `resolveSession`. Tests cover a forged header with and without the middleware.
- The middleware refreshes at most once per request, shares a refresh among requests with the
  same token in one process, clears cookies only when the API says the session is over
  (`endsSession` in `upstream.ts`: `session.*`, `auth.user_banned`; **not**
  `auth.unauthenticated` or `auth.invalid_key`, which are about the request) and leaves them
  on any other failure, reporting a refusal of the request once through `config.warn`. The
  refresh waits at most `REFRESH_TIMEOUT_MS` (below `MIN_REUSE_GRACE_PERIOD`; `upstream.test.ts`
  holds it) and is repeated once, at once, only when it got no answer at all.
  Warnings carry no token, key or cookie. `real-api.test.ts` runs the package against the real API in process: change
  the refresh path and its parallel-refresh and past-the-grace-window tests must still hold.
- A destination read from the address bar goes through `safeRedirectPath`; `signInUrl` is
  checked with it when the middleware is created. It validates what it returns (the parser
  normalises `/.//host` to `//host`), not only what it was given.
- Which cookie names a request is read under is decided only in `readRequestCookies`
  (`upstream.ts`), which the interceptor, the handler and the server helpers all go through
  (the helpers with the stand-in of `requestFromHeaders`): the app URL, then a forwarded
  `https`, then "https iff a `__Host-` cookie of ours is present", which outranks a forwarded
  `http` because Next.js fills `x-forwarded-proto` in itself when no proxy sent it. One cookie
  name per request. Where the cookie rule chose the names (`cookies.superseded`), whatever
  sets or clears one of the app's cookies also sends `supersededCookieLines(cookies)`, which
  expires the plain-named ones (and the interceptor drops them from the request it passes
  on): left behind they are read again once the `__Host-` ones are gone. Never do that where
  the app URL or a forwarded `https` chose. A test of this uses the headers Next.js produces:
  `x-forwarded-proto` is always there. `appOrigin` (same-origin check, the refresh's `Origin`) never follows a
  cookie; the handler's refusal of an https `Origin` for a host it takes to be http is
  reported once through `config.warn` with fixed text (no host, no `Origin`, no cookie).
- The provider wraps the client it creates: `serverState` for the first paint, and a
  `session.signOut()` that refreshes the router after the request has reached the server. Do
  not call `router.refresh()` for a sign-out before then: the cookies are still there.
- Browser tests: `e2e/tests/nextjs/` (project `nextjs`). A new page of the example gets an axe
  check in both colour schemes there.

## Admin client, config and CLI (`packages/{admin,config,cli}`, ADR 0030)

- `@tula/admin`: types come from `src/generated/api.gen.ts` (`bun run admin:generate` after
  `contract:generate`); run-time imports from the contract use its Zod-free entry points only,
  and `typecheck:portable` must pass. One function (`call`), one error (`TulaAdminError`), no
  retries. The secret key stays in the closure of `createAdminClient`: never a property, an
  error, a log line or a `toJSON`; it is set after caller-supplied headers; `redirect:
  'manual'`. A failed request keeps the failure's name, never its message or the error itself.
  `normalizeBaseUrl` allows plain http for loopback hosts only (else `allowInsecureHttp`), and
  `buildUrl` refuses a path parameter that is not one path segment (`client.invalid_param`,
  thrown before the request and outside the network `try`): keep both and their tests.
  Keep the three browser refusals (publishable key, run-time check, `browser` export
  condition) and their tests.
- `@tula/config` may use Zod (tooling only). The config's `settings` is the contract's
  `EnvironmentSettingsInputSchema`; do not redeclare a setting here. A provider secret is a
  `SecretRef` and nothing else: keep the `@ts-expect-error` test that a literal does not
  compile and the run-time test that it is refused without being repeated. No error of this
  package carries a value from the file or the environment. A webhook endpoint
  (`webhooks: [{ url, eventTypes, enabled? }]`) takes its fields from the contract's request
  schemas by `shape` and has **no** field for a secret: keep its `@ts-expect-error` and
  run-time tests too. Its problems are named by position (`webhooks.2.url`), never by
  address, and an address with a user name or a password is refused here (not in the
  contract: the API answers it with `webhook.url_not_allowed`). Event types are normalised on load (sorted, each once), and an environment
  without the list must keep hashing as it did (a test pins the value).
- `@tula/cli`: commands take a `CommandContext` and write through `output`; no `console`, no
  `process.stdout` outside `process-io.ts` (built by `createProcessIo` from injectable parts,
  unit-tested with fake streams and file modes). No option takes a secret. `apply` refuses
  `plan.unknown` without `--allow-unknown` and, under `--yes`, `plan.weakened` without
  `--allow-weaker`, before any write: a new kind of destructive plan gets the same treatment
  and a zero-writes test (a plan that removes a webhook endpoint: `--allow-webhook-removal`).
  A plan that creates a webhook endpoint is refused before any write unless the run says
  what becomes of the signing secret (`--secrets-file`, `--show-secrets`,
  `--discard-secrets`); the secret is given to `output.redact` as soon as the API answers,
  unless `--show-secrets`. The file is created with `Host.createSecretFile` (exclusive;
  anything at the path is refused) before the first write, rewritten with
  `Host.writeSecretFile` only while it holds what the run last wrote, and removed if the
  run put nothing in it; a secret that could not be written is reported as not kept, with
  its endpoint as created. `Host.readFile` refuses anything that is not a regular file
  without opening it: keep the named-pipe tests (host, `apply`, `dev`). Webhook operations are
  ordered after the settings and the providers, and the endpoints are read again before the
  first of them. `planBlockers` (an address the server has twice, more than ten endpoints)
  fail `diff` with exit 1 and stop `apply` before any write. Hooks (`hooks`, keyed by
  point; `planHooks`) are identified by point, an entry is the whole hook (what it leaves
  out is the API's default, managed), there is no field for a secret, and what weakens is
  the contract's `hookWeakenings` in `plan.weakened`; their writes come last and their
  secrets go where an endpoint's go. Native apps (`nativeApps`, a list; `planNativeApps`)
  are identified by platform and identifier, fingerprints and `appLinkPaths` are sets
  normalised on load (`appLinkPaths` left out of an entry is unmanaged: kept, no
  operation, one line with the count; written, also as `[]`, it is the whole set; a gained
  path is `….appLinkPaths` in `plan.weakened`),
  what weakens is the contract's `nativeAppWeakenings`, and their writes come after the
  hooks (removals, narrowing changes, widening changes, registrations), with the apps read
  again before the first; more than 20 is a `planBlocker`. Exit codes are `EXIT`
  (`diff`: 0 / 2 / 1). The diff engine (`src/diff.ts`) is pure and table-tested; a change to
  how a field is compared, to the write order, or to when a secret is sent needs a row there
  and a line in `docs/config.md`. Behaviour against the real API is tested in
  `src/real-api.test.ts` (the API in process, as `@tula/nextjs` does), and the output of every
  run in that file is checked for secrets. A test that spawns the executable gives the spawn a
  `timeout`.
- `@tula/cli`, the 1.14 commands (ADR 0031). `tula dev` spawns only through `io.host`
  (`Host`: an argument vector, a timeout on every spawn, never a shell line) and touches the
  database only by running what the API image ships; a new step gets a fake-host test and an
  idempotence test (a second run changes nothing). It writes only inside its marked block of
  `.env.local` (found by `findBlock`: whole-line markers, the end after the start), closes the
  file's mode on every run (`host.restrictFile`) and prints the secret key only with
  `--show-keys`. The real host writes through a temporary file opened `wx` under a random
  name and refuses a symbolic link at the file (`lstat`, then `O_NOFOLLOW`) instead of
  writing or changing a mode through it, and anything else that is not a regular file (a
  named pipe would make the open wait for ever: refused from the `lstat`, before any open,
  and the open is `O_NONBLOCK` with the kind checked again on the handle). `tula doctor` talks to the
  API through `createInstanceClient` and never to a dependency; whatever the server sends is
  passed through `printable()` (controls to a space; `Cf`, `Co`, `Cn` and lone surrogates
  removed, by class with the `u` flag, written as `\u{…}` escapes) before it is printed, and an answer the CLI cannot read is a
  failing check, never a crash. A URL in the server's answer is never requested unless its
  origin is the API URL's own and it carries no credentials, and then only `<origin>/v1/status`. `tula dev --tunnel` (ADR 0049) runs the tunnel tool
  only through `io.host`, from the one `TunnelService` in `src/tunnel.ts`: no credential
  and no flag that rewrites `Host` in any vector, a loopback `http` target, the tool's
  text only through `printable()`. It writes `TULA_PUBLIC_URL`, `TULA_ISSUER` and
  `TULA_TUNNEL_TARGET` inside the block, never a setting and never a Compose file or
  `.env`; it stops before anything is started when the mock provider or the development
  inbox is on. Whatever opens a tunnel closes it on a later failure, and `tula dev down`
  and a plain `tula dev` close a recorded one; a port with a handler that is not this
  project's is never opened over or closed, and is refused before migrate and seed. The
  order is stop `api`, write the record (`TULA_TUNNEL_TARGET`), open, `up -d api`; the
  record leaves the block only after a close that ended `closed` or `gone`. A run listens
  through `host.onInterrupt` (`SIGINT`, `SIGTERM`, `SIGHUP`) and closes what it opened
  with `shielded` commands (a second signal does not cut the close short); `SIGKILL`,
  `SIGQUIT`, a crash and a power loss leave the record for `tula dev down`, and nothing
  may claim more. A step added after the tunnel is opened ends with a `halt()` when its
  command swallows an interrupt. Its tests are `src/dev-tunnel.test.ts` (a
  fake Docker and a fake `tailscale`): a new step gets the idempotence test and the
  "tunnel is closed" test there. `tula policy test` never sends the password: it reaches only
  `evaluatePassword`, and is redacted on the error stream (`output.redact(value, 'errors')`);
  its tests assert it is absent from all output and from every request.
- `create-tula`: no dependency at run time; secrets only from `crypto.getRandomValues`, never
  a default; `.env` and `.env.local` are never replaced; the name is validated before any
  write. `.gitignore` is written first and `.env` last, an existing `.gitignore` is merged
  (`withIgnoreLines`), and `refuseSymlinks` runs before the first write. `templates/<framework>/app` and `templates/<framework>/package.json` are generated
  (`bun run --filter create-tula templates:sync`): edit the example in `examples/`, not the
  copy. The templates are found from the running module's directory (`findTemplates`), which
  differs between `src/` and the built `dist/`: keep its test.
- `@tula/mcp` (ADR 0033): tools get `ReadOnlyAdmin` (`read-only.ts`), never the admin client;
  `READ_OPERATIONS` holds `GET` ids only and the facade refuses anything else by type, per
  call and at construction. Every result is `project(value, shape)`: name the fields, never
  spread an API answer, never write a value into a sentence. `sanitize.ts` owns the caps (512
  characters a string, 100 entries, 64,000 characters a result), the cleaning and
  `SECRET_SHAPES`. `cleanText` keeps its order: cut to `inputWindow(max)`, remove what a
  reader cannot see (Unicode classes with the `u` flag, never a list of code points; written
  as `\u{…}` escapes), then match secret shapes, then cap. A new pattern is linear and gets a
  row in the "work is bounded" table; results are checked a code point at a time with
  `testing/hidden.ts`. The facade forwards the parameters and an `AbortSignal`, nothing else;
  every request a tool makes carries its call's signal (`withSignal`, the doctor's `signal`),
  and read tools run four at a time with sixteen waiting (`busy` beyond). Inputs are
  `z.strictObject`; no input carries a credential.
  `draft_settings_change` (`settings-draft.ts`, group `draft`, ADR 0056) answers a
  settings change as edits by key to the config file and makes none: it gets
  `ReadOnlyAdmin` and its input only, reads no file and never calls `loadConfig`, names a
  setting only by a path `SETTINGS_DOCUMENT_SHAPE` has, writes a provider's secret only as
  `env(secretEnv)` (a variable's name, never one of `DEPLOYMENT_CREDENTIALS`), refuses a
  value the projection would alter (`not_returnable`), and takes validity and weakenings
  from the contract and `@tula/config`, never a rule of its own.
  A new tool goes in `TOOLS`, in the tests' argument tables (the enumeration, canary and
  real-API tests run every tool), and in `docs/mcp.md`. Scaffold tools return files and
  write nothing; `scaffolds.gen.ts` is generated (`bun run --filter create-tula
  templates:sync`), so change the example in `examples/`. `detect.ts` reads one
  `package.json` inside the server's directory: keep its confinement table. In `@tula/cli`,
  `tula mcp` writes only protocol frames to standard output (the wire and spawned tests hold
  this), resolves credentials once at start from the environment or a file, and refuses `-`
  for every key file. `@tula/mcp` is loaded there with `import()` and nowhere else in the CLI
  (`lazy-load.test.ts`): the command's metadata stays static.
- The sign-in test in `@tula/mcp` (ADR 0058): `test_signin` gets `SignInTester`
  (`testing-sign-in.ts`), a third facade over `TEST_OPERATIONS` (one `POST` a kind of
  client, checked by type and at construction) whose `run` takes a signal and nothing
  else. It is the one tool that changes live data and the only one of group `test`; the
  other two facades gain nothing from it, and its result is the report through `project`.
- Proposals in the SDKs (ADR 0053): a propose tool of `@tula/mcp` gets `ProposingAdmin`
  (`proposing.ts`), a facade of its own over `PROPOSE_OPERATIONS` (`createProposal`, a
  `POST` under `/v1/agent/`, checked by type and at construction); it never shares a file,
  a type or a method with `ReadOnlyAdmin`, and nothing that changes data directly or
  approves is ever added to it. `@tula/admin`'s `createAgentClient` takes an agent key
  only (a secret key is `client.invalid_agent_key`, an agent key given to
  `createAdminClient` is `client.agent_key`). `tula mcp` resolves the agent key first and
  then does not read the secret key; `tula approve` is the human's command, refuses an
  agent key, prints the proposal before it asks and sends back the operation and target it
  printed. It says a proposal whose agent key was revoked as that, and a ban whose
  sessions could not be ended (`failureReason: 'incomplete'`) as "banned, sessions not
  ended, end them", with exit 1: never as carried out, and never as nothing done.
  `ProposalRequest` is a union made from `PROPOSABLE` (four operations, each with its own
  kind of target); the test that hands the facade an irreversible operation, one that sets
  or returns a secret and a bulk one, as lines that must not compile and calls that are
  refused, is never loosened for a new tool. A propose tool goes through `ask`
  (`tools.ts`), which refuses an answer that is not the proposal asked for
  (`response.invalid`), and is run by both injection tests because they iterate
  `PROPOSE_TOOL_NAMES` over `testing/injection.ts` (invisible characters as `\u{…}`
  escapes). For `disable_oauth_provider` and a provider that is on, the question also says
  how many accounts depend on it (`dependentsOf`: one read through `readDependents`, fixed
  words for a count that was not read and for a server without one, never a number then,
  never a failed run). `tula approve` has a `CONSEQUENCES` sentence per operation, shows a provider
  as "on now", "already off" or "not configured now" and a session with its owner (id,
  address, name), client kind, sign-in time and "live now" or "already ended" (two reads
  with the operator's key; a failed read is fixed words beside the bare id, never a
  guess, and never the user agent or the IP address), says "so nothing changed" where the
  approval answers `changed: false`, and says
  `production_environment` (not spent) and `last_sign_in_method` (spent, the provider
  still on) in words, exit 1. It runs at a terminal or not at all: `io.isTTY` not true,
  or no `io.prompt`, is one fixed refusal before the key is resolved and before any
  request; it has no `--yes` (never add one, under any name), `--json` still asks, and
  `--secret-key-file -` is refused. Never read `process.stdin.isTTY` in a command. `@tula/config` leaves `agents.proposalsInProduction: false`
  out of the fingerprint; in the file, left out is `false` and managed.
- **Device binding in `@tula/core`** (ADR 0043): `createTulaClient({ deviceKey })`, never
  for a `web` client (a `TypeError` at construction). Proofs are made in `transport.ts`
  for the operations of `PROVEN` (the six starts and `refreshSession`) and nothing else,
  a new one for every request; the nonce is the newest `DPoP-Nonce`, held in the
  transport's closure and never in storage; `device.nonce_required` is repeated once,
  inside the same call and deadline, so a refresh stays inside the single flight and
  `REFRESH_TIMEOUT_MS`. A `device.*` code never ends the local session
  (`device-binding.test.ts` holds each). A key whose `sign` throws is the client code
  `device.key_failed`, with nothing of the cause (no `cause` on the error either). A runtime that finds its key later hands the environment a `DeviceKeySource` (`Environment.deviceKey`, ADR 0052): asked before each proven request, it answers a key or `undefined` (no proof), and a throw is the same `device.key_failed`. The lookup and the signing are inside the call's deadline: one that never settles is `network.timeout`, nothing sent. The bundle budget in `bundle.test.ts` is
  exact: a change here is measured again and the comment says by how much.
  `device.binding_required` (the profile needs a key and the client has none) is thrown to
  the caller as it is: never retried, never answered by making a key. `<UserProfile>`
  marks a session whose `deviceBound` is true with `userProfile.deviceBound` ("Bound to a
  device key"), in words; no string of the SDK says a device is verified or trusted.
- **`signIn.withIdToken`** (ADR 0045): a start (`startIdTokenSignIn`, in `PROVEN`) that
  answers `{ nonce, exchange }`; the attempt's secret stays in the closure and out of
  what the object serializes to, the ID token is sent once in a JSON body and kept
  nowhere (not in an error, a log line or the flow), and a 200 is validated before
  anything is built from it. `@tula/core` never talks to Google: asking for the token is
  the app's call to the platform's SDK. No new error code. For Apple (ADR 0047)
  `exchange(idToken, name?)` passes the sheet's `givenName` / `familyName` on beside the
  token (the token is spread last: a name object can never replace it), and **the client
  never hashes the nonce**: `pending.nonce` is the server's value for every provider, and
  the app hands the sheet its SHA-256 (no `crypto.subtle` on Hermes, and no room in the
  bundle budget for a hash of the client's own).
