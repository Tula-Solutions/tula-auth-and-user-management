---
paths:
  - "packages/core/**"
  - "packages/react/**"
  - "examples/react-vite/**"
  - "e2e/**"
  - "packages/nextjs/**"
  - "packages/expo/**"
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
- The refresh request's timeout (`REFRESH_TIMEOUT_MS`) must stay below the default
  `refresh.reuseGracePeriod` in `packages/contract/src/session-profile.ts`; a test holds it.
- One error class: every failed call throws `TulaError` with a contract code or one of the
  client's own (`network.failed`, `network.timeout`, `response.invalid`, `storage.failed`,
  `flow.busy`, `link.cross_origin`, `passkey.unsupported`, `passkey.cancelled`,
  `passkey.already_on_device`, `passkey.failed`), all `status: 0`.
- **Passkeys (ADR 0027) use no WebAuthn dependency.** `packages/core/src/passkey.ts` calls
  `navigator.credentials` through `Environment.passkeys`, with the browser's JSON helpers where
  they exist and its own base64url conversion otherwise. A ceremony's failure is one of the
  four `passkey.*` client codes and never carries the browser's message or the credential;
  nothing of a ceremony (challenge, response) is kept. What the authenticator returns is
  checked before it is sent, and a 200 from a passkey route before anything is built from it.
  An autofill request (`withPasskey({ autofill: true })`) takes the caller's signal, restarts
  with a fresh attempt before its challenge lapses, and leaves no timer behind.
- Types come from `src/generated/api.gen.ts` (run `bun run core:generate` after
  `contract:generate`); run-time imports from the contract use its Zod-free entry points only.
  No `Buffer`, `process` or `node:` import: `typecheck:portable` must pass.
- Every conformance scenario is covered by a journey in `apps/api/src/sdk-journeys.test.ts` or
  listed there as server-only with a reason (the guard test enforces it). The JSON scenarios
  themselves are HTTP-level and are run by servers and native SDKs.
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
- Destinations are developer-supplied props only, passed through `go()` / `safeUrl()`.
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
