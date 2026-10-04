# ADR 0021 — `@tula/core`, the headless TypeScript client

- Status: accepted
- Date: 2026-10-03

## Context

`@tula/core` is the first client of the API and the base of every TypeScript SDK after it
(`@tula/react`, `@tula/nextjs`, React Native). It has three jobs: drive the server's flows,
hold the session's tokens, and refresh them. The business plan (§5.7) names concurrent token
refresh as the highest-risk code in an SDK. The package has to run in browsers, Node, Bun and
edge runtimes, and should add as little as possible to an application's bundle.

## Decision

### Shape of the API

```ts
const tula = createTulaClient({ publishableKey, baseUrl, client?, storage?, fetch?,
                                onSessionChange?, messages?, timeoutMs? })

tula.state                      // { status: 'loading' | 'signed-out' } | { status: 'signed-in', sessionId, user }
tula.onChange(listener)         // → unsubscribe
await tula.load()               // restore the session; resolves 'signed-in' or 'signed-out'

const flow = await tula.signUp.start({ email, password, firstName?, lastName? })
flow.step                       // the contract's FlowStep, discriminated by `status`
await flow.verifyEmail({ code }); await flow.resendCode()

const flow = await tula.signIn.start({ identifier })
await flow.submitPassword({ password }); await flow.verifyEmail({ code }); await flow.resendCode()

const flow = await tula.resetPassword.start({ email })
await flow.submit({ code, password }); await flow.resendCode()

await tula.session.getToken()   // string | null
await tula.session.refresh(); await tula.session.signOut()
await tula.session.list(); await tula.session.revoke(id); await tula.session.revokeOthers()
await tula.user.get(); await tula.user.changePassword({ currentPassword, newPassword })
await tula.config.get({ force? })
```

- **Creating a client does nothing.** No request, no channel, no timer. A module-level client
  is therefore safe during server rendering. `load()` is the explicit "find out who is signed
  in"; `getToken()` does the same when the state is still `loading`.
- **Flows are objects that mirror the protocol.** Each has `id`, `kind`, `step`, `expiresAt`
  and only the actions of its kind. An action sends one request and resolves with the next
  step. The SDK does not check that an action is valid for the current step: the server decides
  (`flow.invalid_step`), so the SDK holds no flow logic and cannot disagree with the server.
- **`needs_second_factor` and `needs_first_factor` are typed and surfaced**, but there is no
  `submitSecondFactor` yet: the API has no route for it until step 1.8, and a method that calls
  nothing would be dead surface. The extension point is one line per action in `flows.ts`.
- **State is small and serialisable.** A token refresh is not a state change, so a UI bound to
  the state does not re-render every minute. The state object is frozen and keeps its identity
  between changes (it works as a `useSyncExternalStore` snapshot).
- **`getToken()` returns `null` when nobody is signed in** and throws only when a refresh that
  was needed could not be made. "Signed out" is an answer, not an error.
- **A flow sends one action at a time and none once complete.** A second action while one is in
  flight is refused locally with `flow.busy` (a double click would otherwise spend two guesses
  or send two emails); an action on a completed flow is refused locally with
  `flow.invalid_step`, the server's own code for it. Both have `status: 0`, which is how a
  locally raised error is told from the server's. The secret is dropped from the closure when
  the step becomes `complete`.
- **`discard()` ends an attempt.** Every flow has it. It forgets the secret, so later actions
  are refused with `flow.invalid_step` and no request, and the answer to an action that was on
  its way is dropped before anything is taken from it: that action rejects with
  `flow.invalid_step`, and a `complete` answer signs nobody in. A user who left a password
  form for a passkey must not be signed in by the password's late answer. Accepted residual,
  on `web` only: the browser has already stored the refresh cookie that answer set before the
  client drops it. The client does not act on it, but it is an ordinary session, and a reload
  would find it unless a later sign-in replaced the cookie. On a completed flow `discard()`
  does nothing.
- **Flows cannot be resumed after a reload.** The attempt's secret is kept in a closure, in
  memory only. Persisting it (even in `sessionStorage`) would put a credential where any script
  on the page can read it, to save a user retyping an email within a ten-minute attempt. It is
  not offered. Magic links (1.7) need the *starting tab* to stay open, not persistence.
- **No `autoRefresh`.** Tokens are refreshed lazily, by `getToken()`. A timer would keep every
  idle background tab refreshing for ever, which defeats the server's idle timeout (it is
  measured at refresh time) and costs a request a minute per tab. An application that wants a
  warm token calls `getToken()` when it needs one, which is the only time it matters.

### Generated layer: types and one table

`src/generated/api.gen.ts` is generated from `packages/contract/openapi.json` by
`bun run --filter @tula/core generate` (`generate:check` is part of `verify`). It contains the
schemas the `/v1/client/*` operations use, each operation's path parameters, body and response,
and one runtime constant: method, path and "needs an access token" per operation id. The
hand-written transport (`transport.ts`, about 200 lines) is typed by it, so a route cannot be
called with the wrong path, body or parameters, and no URL is typed by hand.

The generator is ours (`scripts/openapi-types.ts`). `openapi-typescript` was the plan, but it
needs the TypeScript 5 compiler API and the repository is on TypeScript 7. The document uses a
small, regular subset of JSON Schema; the generator renders that subset and **fails** on any
keyword outside it rather than guessing.

The SDK's public types (`FlowStep`, `User`, `Session`, …) are aliases of the generated ones, so
its declarations do not depend on Zod. A test (`contract-parity.test.ts`) makes the compiler
prove they are identical to the contract's own types.

### Runtime dependencies and size

One runtime dependency, `@tula/contract`, and only its Zod-free entry points
([ADR 0020](0020-packaging-and-release.md)). Measured with `bun build --minify --target browser`:

| Import | Minified | Gzip |
| --- | --- | --- |
| `createTulaClient` | 19.2 kB | 6.4 kB |
| `createTulaClient` + `evaluatePassword` (adds the common-password list) | 22.5 kB | 7.7 kB |

No Zod in either. (Those were the first measurements. The emailed code and link, then
two-step verification and step-up, took the client to just under 11.0 kB gzip; the test's
budget is 12 kB.)

### Errors: one class

Every failed call throws `TulaError`: `code`, `status`, `params`, field `errors`, `retryAfterMs`
and a `message` from a locale table. Failures that never reached the API have their own codes
(`network.failed`, `network.timeout`, `response.invalid`, `storage.failed`, `flow.busy`, all
`status: 0`),
so there is one thing to catch and one field to switch on. The English table is the contract's
messages; an application passes `messages` (or calls `setMessages`) with any subset of codes,
and messages may use params as `{name}` placeholders. A code this version does not know (a
newer server) keeps the server's `detail`. Server-supplied codes and placeholder names are
looked up as own properties only, so a code such as `constructor` cannot reach an inherited
function. An error is built only from the envelope's fields:
it cannot contain a token, an attempt secret or a password.

### Where tokens live

| | `web` | `ios`, `android`, `server` |
| --- | --- | --- |
| Access token | memory | memory |
| Refresh token | the API's `HttpOnly` cookie; the SDK never sees it | memory, mirrored to the `storage` adapter |
| Requests | `credentials: 'include'` | no cookies |

Nothing is ever written to `localStorage` or `sessionStorage`. `memoryStorage()` is the default
adapter; React Native gets a secure-store adapter in Phase 2. A storage write that fails after
a successful refresh is reported once (`storage.failed`) while the session continues from
memory; silently continuing would turn into an unexplained sign-out at the next launch.

### Refresh

- **Skew: 10 seconds** (`ACCESS_TOKEN_EXPIRY_SKEW_MS`), capped at half the token's lifetime.
  A token has to outlive the request that carries it. Ten seconds of a 60-second token leaves
  50 seconds of use per token.
- **The lifetime is read from the token (`exp - iat`)**, and the expiry is kept on the device's
  own clock from the moment the token arrived. Comparing the server's absolute expiry with a
  device clock that is two minutes off would make every 60-second token look expired, or keep
  dead ones in use.
- **Single flight in one client.** Any number of `getToken()` / `refresh()` calls share one
  request and one outcome.
- **Across tabs (`web`): a Web Lock around the refresh, and a `BroadcastChannel` for the
  result.** A tab takes the lock `tula:<api>|<key>`, refreshes, and posts the new access token
  with its expiry. A tab that was waiting for the lock finds the session already replaced and
  uses that token instead of refreshing. Sign-in and sign-out are posted the same way. The
  refresh token is never in a message (a `web` client does not have it).
- **Fallbacks.** Without Web Locks, tabs may refresh at the same moment; the server's reuse
  grace period ([ADR 0008](0008-sessions.md)) answers both with the same next token. Without a
  channel, each tab refreshes for itself, one after the other. A tab that cannot get the lock
  within the longest the holder can need plus two seconds goes on without it, so a stalled
  tab cannot block the rest. "The longest the holder can need" is a request's timeout or the
  refresh budget (`refreshBudgetMs`: a refresh may be tried twice), whichever is longer; with
  only the request timeout, an app that set `timeoutMs: 5000` had a waiter give up at 7
  seconds while the holder's retry ran until 10, and both refreshed at once.
- **A refused refresh ends the session once.** `session.*`, `auth.unauthenticated` and
  `auth.user_banned` set the state to `signed-out`, clear storage, notify listeners once and
  resolve every waiter with `null`. Nothing is retried. This covers reuse detection outside the
  grace period: the client that held the newest token learns it at its next refresh. A refused
  refresh is **not** broadcast: a tab with no cookie yet gets that answer while another tab is
  completing a sign-in, and must not sign it out.
- **Other failures keep the session.** A network error, 5xx, 429 or 503 rejects every waiter
  with the same error. With `Retry-After`, the client fails fast until then instead of asking
  again. A token still inside its skew is handed out when the refresh could not be made.
- **A 401 on an authenticated call** (a `session.*` code or `auth.unauthenticated`, not a
  wrong current password) triggers one refresh and one retry. A second 401 goes to the caller.
- **The refresh request has its own timeout: 8 seconds** (`REFRESH_TIMEOUT_MS`, or `timeoutMs`
  if the app set a smaller one), because the general 15 seconds is longer than the server's
  10-second reuse grace period. A refresh the server rotated but whose answer was lost can only
  be repeated safely inside that window; with a 15-second timeout the earliest possible retry
  was already reuse, and a slow network signed the user out everywhere.
- **The one automatic retry.** A refresh that gets no answer (`network.timeout` or
  `network.failed`; never after an HTTP answer of any status, and never after an unreadable
  200) is sent once more, at once, inside the same single flight, so every waiter sees one
  outcome. This is the only exception to "nothing is retried automatically", and it is the one
  request that is safe to repeat by design: the server answers a token re-presented inside the
  grace period with the same next token. Leaving it to the application meant a slow network
  signed users out on every device. The retry is given what is left of 10 seconds from the
  start of the first try (`REFRESH_RETRY_WINDOW_MS`, the default grace period), at least one
  second and at most the refresh timeout: after an 8-second timeout it has 2 seconds, so the
  two tries end about when a retry stops being safe. If it fails too, the network error goes to
  the callers, the session is kept, and nothing more is sent. A sign-out during the first try
  cancels the retry. An operator who sets `refresh.reuseGracePeriod` below 8 seconds removes
  the margin. One lost response, two lost responses retried inside the window, and the same
  after the window are pinned by journeys against the real API.
- **`Retry-After` is capped at five minutes** (`MAX_REFRESH_BACKOFF_MS`) for the fail-fast
  window, and an explicit `session.refresh()` ignores the window and asks: a proxy answering
  `Retry-After: 86400` must not lock a session for a day.
- **A 204's empty body is read to its end.** Chromium records a `fetch` whose body nobody
  consumed as `net::ERR_ABORTED` when the response is collected, with or without an
  `AbortSignal` (a plain `fetch` of a 204 shows the same), so every successful sign-out and
  password change looked like a failed request in the network panel. The client never aborts a
  request that got its answer; the only abort is the timeout.
- **`user.get()` belongs to the session that asked.** The user is installed into the state
  only if the session that was current when the request started still is.
- **A 200 is checked before it is installed.** Refresh answers and a completed flow's `session`
  must have a string `accessToken`, a string `sessionId` and a readable expiry; a flow answer
  must have an `id` and a `step.status`. Otherwise `response.invalid`, with nothing installed,
  stored or broadcast. The guards are a few hand-written checks, not a schema library.
- **Signed out stays signed out.** A 401 that arrives after a sign-out does not trigger the
  refresh-and-retry. A tab remembers the ids of sessions it ended and ignores another tab's
  `session` message for them (the echo of a refresh that was in flight); while its own sign-out
  request is still on the way it ignores every `session` message, since a tab that never loaded
  does not know which session its cookie holds. A new sign-in elsewhere (another session id)
  still propagates, and the tab's own refresh can still restore a session whose sign-out never
  reached the server.
- **Generations.** Every change of session (sign-in, refresh, sign-out, a message from another
  tab) bumps a counter; a result that arrives for an older generation is discarded. This is
  what makes "refresh racing sign-out" safe: the late tokens are not installed, and the
  refresh token they carried is used only to revoke the session.
- **Sign-out** clears memory and state and tells other tabs first, then waits for any refresh
  in flight, clears storage, and tells the server. If the server cannot be told the call
  rejects (the session may live on, and a browser still has its cookie), but the client is
  signed out either way.
- **A sign-out that was not delivered can be sent again.** A browser's second `signOut()`
  sends its cookie again. Any other kind of client has by then dropped its refresh token, so a
  second call would have nothing to send, ask nothing and resolve, and an application that
  offers "Try again" would report a session ended that the server still holds. Such a client
  therefore keeps the token of a sign-out the server did not confirm, in a closure of the
  session manager and nowhere else (never storage, a cross-tab message, an error, a log line
  or `toJSON`), and only `signOut()` reads it: no refresh presents it, so the client stays
  signed out. It is forgotten when a sign-out is delivered, when the API answers the sign-out
  with a `session.*` code (the session is over), and when a new session is adopted. It is
  kept for the client's lifetime otherwise, deliberately without a timer: the token is as
  live on the server whether the client remembers it or not, so forgetting it early protects
  nothing and only removes the one way this device has to revoke it. It does not survive the
  process: after a restart the session ends by revocation elsewhere or by expiry.
- **Step-up installs a token without rotating anything** ([ADR 0025](0025-mfa.md)).
  `session.stepUp(proof)` asks the API to prove a factor again and gets back an access token
  for the **same** session and no refresh token. The token is installed under the generation
  it was asked under, and handed to other tabs. If the session's token was replaced while the
  proof was on its way (a refresh here or in another tab), the step-up's token is not put
  over the newer one: the client refreshes once more instead, so the token it ends with was
  issued after the proof. **The ordering rule across tabs:** of two tokens for one session,
  the one issued later wins; a token another tab announces late never replaces a newer one.
  After `mfa.confirmTotp` the client refreshes for the same reason (the token in hand does
  not say `mfa` yet); the backup codes are returned whether or not that refresh could be made.
  The client never prompts and never retries an action that answered
  `auth.step_up_required`: `isStepUpRequired` and `stepUpMethods` read the error, and the UI
  layer decides.
- **Secrets pass through.** A TOTP secret, its URI and backup codes are returned to the caller
  once and kept on no object, in no storage and in no error.

### Portability

No `Buffer`, `process` or `node:` import. `tsconfig.portable.json` typechecks the shipped
sources (and what they import from the contract) with `lib: ["ES2022", "DOM", "DOM.Iterable"]`
and `types: []`; `typecheck:portable` runs with `typecheck` in `verify`. `fetch` is injectable.
`credentials` is set only for the `web` kind, because some edge runtimes reject the option.

### Tests, and the conformance rule

- Unit tests in the package with a fake `fetch`, fake Web Locks, a fake channel hub and a
  manual clock cover every interleaving above. Coverage threshold: 95% (currently above 99%).
- **Journey tests live in `apps/api/src/sdk-journeys.test.ts`**: the SDK's public API against
  the real server in process (`fetch: (request) => app.request(request)`, a cookie jar and an
  `Origin` header for the `web` kind). They are in the API package because the dependency
  direction is clean there (`@tula/core` is a dev dependency of the API; the SDK never depends
  on the server), following `conformance.test.ts`.
- **Rule 2 of the Phase 1 plan as built.** The plan said the SDK would get a runner target that
  drives the JSON scenarios through it. The scenarios are HTTP-level (paths, headers, bodies):
  an SDK that hides those cannot "run" them without a second, lossy mapping. They stay the
  conformance suite for servers and for native SDKs. For this SDK, a guard test reads the
  scenario names and requires each to be covered by a named journey or listed as server-only
  with a reason, so a new scenario cannot be added without deciding its SDK coverage. Today
  twelve are covered and one (`two instances`) is server-only.

## Consequences

- **The app and the API must be same-site for the `web` kind.** The refresh cookie is
  `SameSite=Lax` on the API's origin. `app.example.com` with `auth.example.com` works, as do two
  localhost ports. An app on another site needs a first-party proxy, which `@tula/nextjs`
  (1.12) provides. The app's origin must also be in the environment's `urls.allowedOrigins`.
- A fresh visitor's `load()` costs one request that answers 401 (the SDK cannot see whether an
  `HttpOnly` cookie exists). It shows in the browser's network panel. A non-secret "was signed
  in" hint could skip it; not done, because a wrong hint would hide a valid session.
- A client that is offline at start stays `loading` and `load()` rejects; the app decides when
  to try again.
- `baseUrl` must be absolute. A relative base for the first-party proxy comes with 1.12.
- There is no `destroy()`: a `web` client's channel lives as long as the page. Creating many
  clients in one page (hot reload) leaves old channels open until the page goes.
- **Without Web Locks, two orderings can still revoke a session family.** Both need one tab to
  refresh twice while another tab's refresh with the original cookie is still in flight
  (possible through an explicit `refresh()` or the 401 retry, not through `getToken()` alone,
  which refreshes at most every 50 seconds): (1) tab A rotates P→C1 and at once C1→C2; tab B's
  request carrying P reaches the server after that, and a used token whose child has itself
  been rotated is reuse even inside the grace period. (2) The same, but B's request was
  answered first (with C1) and its `Set-Cookie` is applied after A's C2: the jar now holds the
  used C1, and the next refresh, typically 50 seconds later, is reuse. A request stalled in
  transit for more than ten seconds is a third. Web Locks rule all three out; browsers lack
  them only in insecure contexts (plain http off localhost) and very old versions.
- If a refresh and a sign-in as someone else overlap across tabs, the cookie may end up
  belonging to either session. The next refresh makes every tab agree with the cookie, and
  the state is corrected (the user is fetched again when the session id changes).
