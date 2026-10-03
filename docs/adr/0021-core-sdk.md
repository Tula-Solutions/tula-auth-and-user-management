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
| `createTulaClient` | 17.5 kB | 5.9 kB |
| `createTulaClient` + `evaluatePassword` (adds the common-password list) | 20.7 kB | 7.2 kB |

No Zod in either.

### Errors: one class

Every failed call throws `TulaError`: `code`, `status`, `params`, field `errors`, `retryAfterMs`
and a `message` from a locale table. Failures that never reached the API have their own codes
(`network.failed`, `network.timeout`, `response.invalid`, `storage.failed`, all `status: 0`),
so there is one thing to catch and one field to switch on. The English table is the contract's
messages; an application passes `messages` (or calls `setMessages`) with any subset of codes,
and messages may use params as `{name}` placeholders. A code this version does not know (a
newer server) keeps the server's `detail`. An error is built only from the envelope's fields:
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
  within one request timeout plus two seconds goes on without it, so a stalled tab cannot
  block the rest.
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
- **Generations.** Every change of session (sign-in, refresh, sign-out, a message from another
  tab) bumps a counter; a result that arrives for an older generation is discarded. This is
  what makes "refresh racing sign-out" safe: the late tokens are not installed, and the
  refresh token they carried is used only to revoke the session.
- **Sign-out** clears memory and state and tells other tabs first, then waits for any refresh
  in flight, clears storage, and tells the server. If the server cannot be told the call
  rejects (the session may live on, and a browser still has its cookie), but the client is
  signed out either way.

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
- If a refresh and a sign-in as someone else overlap across tabs, the cookie may end up
  belonging to either session. The next refresh makes every tab agree with the cookie, and
  the state is corrected (the user is fetched again when the session id changes).
