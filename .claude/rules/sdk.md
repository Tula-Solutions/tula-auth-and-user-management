---
paths:
  - "packages/core/**"
  - "packages/react/**"
  - "examples/react-vite/**"
  - "e2e/**"
  - "packages/nextjs/**"
  - "examples/nextjs-app-router/**"
  - "packages/expo/**"
  - "packages/expo-screens/**"
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
- **`@tula/admin`** (its rules are in `publishable-packages.md`): one function (`call`), one
  error (`TulaAdminError`), no retries. The secret key is set after caller-supplied headers;
  `redirect: 'manual'`. A failed request keeps the failure's name, never its message or the
  error itself. `normalizeBaseUrl` holds the plain-http rule and `buildUrl` the path-segment
  rule (`client.invalid_param`, thrown before the request and outside the network `try`):
  keep both and their tests, and the three browser refusals (publishable key, run-time
  check, `browser` export condition) with theirs. `createAgentClient` takes an agent key
  only (a secret key is `client.invalid_agent_key`; an agent key given to
  `createAdminClient` is `client.agent_key`).
- **Device binding in `@tula/core`** (ADR 0043; the rules are in `device-binding.md`,
  "`@tula/core` makes proofs in the transport"): a proof is a new one for every request;
  `device-binding.test.ts` holds, for each `device.*` code, that it does not end the local
  session; `device.key_failed` has no `cause` on the error either.
  `device.binding_required` (the profile needs a key and the client has none) is thrown to
  the caller as it is: never retried, never answered by making a key. The bundle budget in
  `bundle.test.ts` is exact: a change here is measured again and the comment says by how
  much. `<UserProfile>` marks a session whose `deviceBound` is true with
  `userProfile.deviceBound`, in words.
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
- **Every scenario and every named client behaviour has a decision for each client** in
  `conformance/client-journeys.json`: `journey`, `not_applicable` with a reason, `not_built`
  with a ticket (never for a behaviour, never for `core`), or `undecided` only while the
  client's suite is `planned`. For `@tula/core` a journey is a `journey(…)` or
  `behaviour(…)` test in `apps/api/src/testing/sdk-journeys.ts`, and the guard fails where
  the list and the tests disagree (`conformance.md`).
- `needs_new_password` in a sign-in (`reason: 'expired'`, ADR 0041) is answered with
  `flow.submitNewPassword`.
- Check browser behaviour in a browser: `bun run playground`.

## One package's rules

This file holds what every SDK shares and what `@tula/core` and `@tula/admin` do. The rules
of one package are in its own file, and nothing of them is repeated here:

| Package | File |
| --- | --- |
| Building, entry points, Zod-free and portable code | `publishable-packages.md` |
| `@tula/react` | `react.md` |
| `@tula/nextjs` | `nextjs.md` |
| `@tula/expo` | `expo.md` |
| `@tula/expo-screens` | `expo-screens.md` |
| `@tula/cli`, `@tula/config`, `create-tula` | `cli.md` |
| `@tula/mcp`, `tula mcp` | `mcp.md` |
| Agent keys, propose tools, `tula approve` | `proposals.md` |
| The sign-in test tool | `sign-in-tests.md` |
| The client journeys of `conformance/client-journeys.json` | `conformance.md` |
| Browser tests | `e2e.md` |
