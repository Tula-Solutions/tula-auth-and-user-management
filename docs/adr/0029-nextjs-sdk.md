# ADR 0029 — The Next.js SDK: a same-origin route handler, offline verification and server helpers

- Status: accepted
- Date: 2026-10-04

## Context

`@tula/core` and `@tula/react` (ADR 0021, ADR 0022) assume a browser talking to the API's own
host: the refresh token is an `HttpOnly` cookie of that host and the access token lives in
memory. A Next.js application also renders on a server, and that server is a different host. It
never receives the API's cookie, so it cannot tell who is signed in, protect a route, or render
a page for a user. ADR 0028 left the matching question open for `stateful` sessions ("a backend
on another host than the API cannot see the cookie") and deferred a cookie `Domain` to this
step.

Next.js 16 is the current major (16.3 at the time of writing; confirmed from the registry and
from the documentation the package ships in `node_modules/next/dist/docs`). In 16 the request
interceptor file is `proxy.ts`, exporting `proxy`, and runs in the Node.js runtime; up to 15 it
was `middleware.ts`, exporting `middleware`, in the Edge runtime by default. `cookies()` and
`headers()` are async in both. Route handlers take a web `Request`.

## Decision

A fourth publishable package, `@tula/nextjs`, with four entry points:

| Entry point | What | Where it runs |
| --- | --- | --- |
| `@tula/nextjs` | `<TulaProvider>` and every `@tula/react` export, `'use client'` | browser, and server rendering of client components |
| `@tula/nextjs/handlers` | `createTulaHandlers()`: the catch-all route handler | server |
| `@tula/nextjs/middleware` | `tulaMiddleware()` for `proxy.ts` / `middleware.ts` | Node.js or Edge |
| `@tula/nextjs/server` | `auth()`, `currentUser()`, `getToken()`; guarded by `server-only` | server |

Peers: `next` 15 and 16, `react` 19. Dependencies: `@tula/core`, `@tula/react`,
`@tula/contract` (Zod-free entry points only; `environmentIssuer` and `jwksUrl` moved to a new
one, `@tula/contract/issuer`), `jose` and `server-only`. Each entry point is built as one file
with no shared chunk, so the `'use client'` directive stays at the top of the client entry and
nothing that names the secret key can be reached from it; a test builds the package and checks
both.

### The route handler: the app's origin stands in for the API

The app mounts `createTulaHandlers()` at `app/api/tula/[...tula]/route.ts`. The browser's
`@tula/core` client is given `<origin>/api/tula` as its base URL and never talks to the API's
host. This is the answer to ADR 0028's open question: **no cookie `Domain`**. Every session
cookie becomes a first-party, host-only cookie of the app.

- **Only `/v1/client/*` is forwarded.** The path is taken from the parsed URL; an encoded slash
  or backslash, an empty segment or a dot segment is refused (404), not normalised. The admin
  API is never reachable through it. A redirect from the API is never followed and never passed
  on (502). The request body is streamed through, never read or logged, and counted on the
  way: more than 1 MiB is a 413, whether the length was declared or the body arrived in
  chunks, and an answer to a body that was cut off is not passed on. A JSON response is read
  whole (see below) up to 1 MiB (502 beyond it); anything else is streamed. Calls have a
  timeout (15 seconds).
- **Request headers are an allow-list**: `Origin`, `Sec-Fetch-*`, `Authorization`,
  `Content-Type`, `Accept`, `Accept-Language`, `If-Match`, `x-tula-client`, `x-tula-attempt`,
  `x-tula-session-profile`. The publishable key is always the app's own, whatever the browser
  sent. The browser's other cookies are not forwarded.
- **`Origin` is forwarded unchanged and never invented.** The API's origin allow-list and its
  login-CSRF rule (ADR 0019) therefore apply to the app's origin, which must be among the
  environment's `urls.allowedOrigins`. A test against the real API shows the API refusing an
  origin it does not allow through the handler.
- **The visitor's address is sent only when the app says how it is known.** The first
  version took the last entry of the request's `X-Forwarded-For` by default. Where the
  Next.js server can be reached without a proxy that appends the real address, that entry is
  the visitor's own, and the API (trusting this server) would have limited, locked out and
  audited an address the visitor chose. Trust is therefore explicit: `trustedProxyHops`
  (`TULA_TRUSTED_PROXY_HOPS`), **0 by default**. With 0 no forwarding header is read and no
  `X-Forwarded-For` is sent: the API sees the Next.js server's address for everyone, which is
  safe and coarse (one shared per-IP limit), and in production the server says so once in its
  log. With N the address is the Nth entry from the right, the one the outermost trusted
  proxy appended; fewer entries than N, or an entry that is not an address, means none.
  `clientIp(request)` replaces the rule on platforms with a header of their own. When an
  address is sent it is the one entry, and the API reads it only with `TRUST_PROXY=true`.
  **Without both, every visitor shares the Next.js server's address and one per-IP rate
  limit**: one user's failed sign-ins can lock everyone out. The Next.js server must reach
  the API directly (a proxy between them that appends its own entry hides the visitor again).
- **CSRF of the handler itself.** The browser attaches the app's cookies to a request from any
  page. Before anything is forwarded: a request marked `Sec-Fetch-Site: cross-site` is refused;
  a request with an `Origin` must name the app's own; a request that is not a `GET` or `HEAD`
  must have one. The app's origin is `TULA_APP_URL` when set, otherwise the request's
  `X-Forwarded-Host` or `Host` with its scheme, which a foreign page cannot choose for a
  visitor's browser (the rule Next.js uses for Server Actions).

### Cookies

| Cookie | Holds | Set by |
| --- | --- | --- |
| `tula_rt` | the refresh token | the handler and the middleware, from the API's `tula_rt_<environment>` |
| `tula_session` | a `stateful` session's token | the handler, from the API's `tula_session_<environment>` |
| `tula_at` | the access token (a JWT) | the handler, from any JSON answer that carries one; the middleware after a refresh |

All three: `HttpOnly`, `SameSite=Lax`, `Path=/`, no `Domain`, `Secure` over https, and over
https the `__Host-` prefix. Only the name for the request's own scheme is ever read, so an
unprefixed cookie planted from a sibling subdomain is never taken for a session. None of the
API's attributes is copied: the app's cookie is written afresh, and a value that could carry an
attribute is not written at all. `Max-Age` is the API's for the refresh and session cookies and
the token's remaining lifetime for `tula_at`.

**The refresh cookie's path is `/`, not the handler's path.** The brief for this step asked for
both a refresh cookie limited to the handler's path and a middleware that refreshes on any page
request; the two cannot both hold, because the middleware would never receive the cookie. The
middleware's refresh won: it is what makes server rendering work after the access token expires.
The cost is that the refresh token is sent with every request to the app's own server, which is
the party that forwards it to the API anyway.

The access token reaches the server because the handler reads it out of the API's answer: a
completed flow (`session.accessToken`), a refresh and a step-up (top level). The body is passed
on untouched, so the browser's client still keeps the token in memory and its single-flight
refresh works as before, through the handler. When the API clears its cookie (sign-out, a
refused refresh), the handler clears `tula_at` with it.

**A browser holds one session, of one kind.** The middleware and `auth()` read the access
token before a `stateful` session's cookie. A browser that was user A on a `hybrid` profile
and signs in as B on a `stateful` one would otherwise keep A's token cookies, and the server
would go on answering for A. So when an answer issues a session cookie the handler removes
`tula_rt` and `tula_at`, and when it issues a refresh cookie or an access token it removes
`tula_session`. Each response names a cookie at most once.

### The middleware

`tulaMiddleware({ publicRoutes | protectedRoutes, signInUrl, … })`:

1. Verifies `tula_at` **offline** with `jose` against the environment's JWKS
   (`createRemoteJWKSet`, cached in memory): `EdDSA` only, a `kid` required, `iss` the
   environment's issuer, `aud` its id, `exp` with five seconds of clock tolerance, and `sub`
   and `sid` present. No call to the API beyond the keys.
2. When the token is missing, invalid or within ten seconds of expiry and there is a refresh
   cookie, it refreshes **once**, server to server, with the cookie, the app's `Origin` and the
   visitor's address. The new token is verified like any other. The rotated cookies go on the
   response **and into the request's own `Cookie` header**, so server components of the same
   request see the new token.
3. A refresh the API refuses **because the session is over** clears the cookies; the request
   is signed out. That is decided by the error's code, not its status: `session.*` and
   `auth.user_banned`. A refresh that could not be made (no answer, 429, 5xx) changes
   nothing: a token with seconds left is still used, otherwise the request is signed out and
   the cookies stay. So does a 401 or 403 that is about the request and not the session:
   `auth.invalid_key` (a wrong publishable key) and `auth.unauthenticated`. The API answers
   the latter to a refresh when it did not take the cookie into account at all, which for
   this server-to-server call (it always presents the cookie) means the `Origin` it sent, the
   app's, is not one the environment allows. The browser's client treats that code as the
   end of a session because it cannot tell; here it can, and the API needed no change. The
   first version cleared on any 401 or 403, so one wrong `TULA_APP_URL` would have deleted
   every signed-in visitor's cookies on their next navigation. Such a refusal is logged once
   per process with what is likely wrong (`onWarning`, or `console.warn`), never with a
   token, a key or a cookie. A refresh cookie that could not be sent as a cookie at all is
   dropped without asking.
4. A protected route without a session redirects to `signInUrl` with `redirect_url`, or
   answers 401 in the contract's envelope for API routes and for anything but a `GET`. The
   sign-in and sign-up pages and the handler's path are never protected.

**`redirect_url` is always a path.** The middleware writes one, and the page that reads it
passes it through `safeRedirectPath`, which accepts a single leading `/` and refuses absolute
URLs, `//host`, backslashes and control characters. `signInUrl` itself must be such a path.
The rule is applied to the value that is **returned**, not only to the one that came in: the
URL parser removes dot segments, so `/.//host`, `/a/..//host` and `/%2e//host` all normalise to
`//host`, which a router reads as another origin. What comes back must itself start with one
`/` followed by neither a slash nor a backslash (raw or percent-encoded) and must not change
when parsed again. `@tula/react`'s `go()` is a second line: a destination with no scheme that
names a host is refused there too.

**Concurrent refreshes.** Requests arriving at one server with the same refresh token share
one call. Across servers each makes its own, and the API's reuse grace window (ADR 0008; 10
seconds by default, per profile since ADR 0028) hands each the same next token; a test against
the real API runs two instances in parallel and shows both succeed with the same cookie. The
bound: a request that still carries the old cookie **after** the window is a reuse and ends the
session. A profile with `refresh.reuseGracePeriod: null` has no window and should not be used
behind this middleware.

**A refresh gives up inside the window.** The server-side refresh waits at most 8 seconds
(`REFRESH_TIMEOUT_MS`, or `timeoutSeconds` when that is smaller), not the general 15: the
smallest grace window a profile may set is 10 seconds, and a refresh whose answer was lost
after the API rotated the token is forgiven only inside it. A refresh that got **no answer**
(a timeout, a dropped connection) is sent once more at once, inside the same single flight
and with what is left of the 10 seconds, exactly as `@tula/core` does in the browser; an HTTP
answer of any status is never repeated. A test holds the timeout below
`MIN_REUSE_GRACE_PERIOD` and equal to the client's.

**The scheme cookies are read under.** Which cookie names a request is read under (`__Host-`
or plain) is decided in one function, `readRequestCookies`, for the interceptor, the route
handler and the server helpers (`auth()` and `currentUser()` get the request's headers and no
URL, and pass a stand-in). In order:

1. the configured app URL (`TULA_APP_URL`, the recommended way: nothing is guessed). It wins
   over everything below, in both directions;
2. a forwarded `https` (`X-Forwarded-Proto`);
3. https exactly when the request carries one of this package's `__Host-` cookies, **even if
   `X-Forwarded-Proto` says `http`**;
4. otherwise a forwarded `http`, or the request's own URL.

Rule 3 used to sit below any forwarded scheme and applied only when the header was absent. A
live run behind a proxy that ends TLS and sends no `X-Forwarded-Proto` showed that this never
happens under a real Next.js server: it fills the header in from its own socket
(`base-server.js`: `req.headers['x-forwarded-proto'] ??= isHttps ? 'https' : 'http'`; 15.5 and
16.3), so `auth()` always saw `http` there. With `appUrl` given to the interceptor and the
handler as an option and not in the environment, they wrote the `__Host-` names, `auth()` read
the plain ones, and the protected page and the sign-in page sent the browser to each other
without end. The unit tests had passed because they built a header set no Next.js server
produces; they now use the ones it does.

Why the cookie may outrank the header:

- A browser stores a `__Host-` cookie only from an https response, with `Path=/` and no
  `Domain`, and sends it to nothing but that exact host over a secure connection. Its presence
  is better evidence of how the page was loaded than a header the framework derived from the
  socket between it and the proxy.
- Reading the `__Host-` names because one is present cannot be induced from outside: a
  sibling subdomain can plant a plain `tula_at`, never a `__Host-` one. And once one is
  present the plain names are not read at all, so the planted cookie is ignored as before.
- A hand-built `Cookie` header over plain http changes only which names are read for the
  sender's own request. Whatever token is found is verified against the environment's keys
  all the same, and a `Secure` cookie written in answer goes to the sender alone.
- A forwarded `https` still means https, and a configured app URL of `http:` still means the
  plain names whatever cookies arrive.

**The app's origin never follows a cookie.** `appOrigin` (the handler's same-origin check,
and the `Origin` the server-side refresh presents to the API) stays: the app URL, else the
forwarded scheme and host, else the request's URL. The two legitimately differ. The origin
has to be known before any cookie exists (the first sign-in), it is what stands between a
foreign page and the visitor's cookies, and a stale `__Host-` cookie on `localhost` (cookies
are not scoped by port) must not make a development server refuse its own pages. So with no
app URL and no forwarded `https` behind a TLS-terminating proxy the handler still refuses
every write (`request.origin_not_allowed`): failing closed, and unable to sign anyone in.
What changed is that it says so: the first refusal of an `Origin` that is the request's own
host over https, where the server took the host to be on http, is reported once through
`onWarning` with a fixed text naming `TULA_APP_URL` and `X-Forwarded-Proto` (no host, no
`Origin` and no cookie in it, since all three are the sender's to choose). In that state no
`__Host-` cookie can be written, so the three places agree that nobody is signed in.

Accepted residual: a `__Host-` cookie of this package left on a host by another deployment
of it (in practice `localhost`, across ports, in a browser that sends `Secure` cookies to
`http://localhost`) makes an app there with no app URL use the `__Host-` names. All three
places then use them, and the browser that sent one stores the ones written back, so the
app works; setting `TULA_APP_URL` removes the guess.

What was not acceptable in that state: the app's own earlier cookies, under the plain names,
stayed in the browser. A visitor signed in over http, then a stray `__Host-tula_rt` arrived,
a new sign-in wrote the `__Host-` cookies, a sign-out cleared only those, and the next
request, with no `__Host-` cookie left, read the plain names again: the earlier session was
back after the visitor had signed out. So **where the cookie rule chose the names, any
answer that sets or clears one of the app's cookies also expires all three plain-named
ones** (`supersededCookieLines`): in the route handler, and in the interceptor, which also
takes them out of the cookies the rest of the request sees, so that `auth()` cannot read
what the interceptor just turned away from. One browser holds one session. This is not done
where the scheme came from the app URL or a forwarded `https`: an https app never wrote the
plain names, and a cookie under them there is somebody else's (a sibling subdomain's, at
worst) and is neither read nor touched. The cost on `localhost` is that a stray `__Host-`
cookie whose refresh is refused signs the http session out as well; the visitor signs in
again and holds one set of cookies.

Both changes are covered by unit tests with Next.js's real header sets; the https
arrangement they came from has not been run again.

**Clocks.** Expiry is judged by the Next.js server's clock against an `exp` written by the
API's. The two must agree to within the five-second tolerance (NTP); an API whose clock runs
ahead issues tokens this server keeps accepting for that much longer. The browser tests found
this the direct way: the fixture's clock can be moved forward, so the `nextjs` project runs
before the scenarios that move it and asserts that it has not been.

**Revocation.** Offline verification cannot see a revoked session: it keeps working here until
its access token expires (at most one `accessTokenTtl`, 60 seconds by default), and is signed
out at the next refresh. `currentUser()` asks the API and sees it at once.

### Stateful sessions

A `stateful` session has no token to verify offline. Two options were on the table: ask the
client API with the cookie (`POST /v1/client/sessions/refresh` answers only a session id, no
user), or ask `POST /v1/admin/sessions/verify` with a secret key (answers the full claims).
**The second**: with `TULA_SECRET_KEY` set, the middleware asks the API on **every matched
request** that carries the session cookie, one network call each, which the API counts as
activity. Without a secret key such a session is signed out as far as the server is concerned
(the browser's client still works through the handler, and the cookie is kept).

So that `auth()` does not ask a second time, the middleware hands the claims on in a request
header, `x-tula-auth`. **The header is not trusted for being present.** Its value is the claims
plus an HMAC over them and over a digest of the session cookie they were verified for, keyed by
the secret key; `auth()` checks the signature, the cookie and the claims' issuer, audience and
expiry, and otherwise asks the API itself. The middleware also removes any copy the browser
sent, on every path including the route handler's. A forged header therefore fails even on a
route the middleware's matcher does not cover.

For `hybrid` sessions no header is trusted at all: `auth()` verifies the access-token cookie
again (offline; the keys are cached).

### Server helpers

`auth()` returns `{ isSignedIn, userId, sessionId, claims, getToken() }` or the signed-out
shape. `currentUser()` calls `GET /v1/client/me` with the request's token (or a stateful
session's cookie). Both are wrapped in React's `cache`, so they run once per request. They read
their configuration from the environment (`TULA_API_URL`, `NEXT_PUBLIC_TULA_PUBLISHABLE_KEY`,
`TULA_ENVIRONMENT_ID`, optionally `TULA_ISSUER`, `TULA_APP_URL`, `TULA_SECRET_KEY`), resolved
on first use so that `next build` does not need it. They do not refresh: that is the
middleware's part, and without it an expired token reads as signed out.

### The provider

`<TulaProvider>` creates the `@tula/core` client pointed at the handler and passes it to
`@tula/react`'s provider. It takes the server's `initialState` (`{ sessionId, user? }` or
`null`). To make the first paint right on both sides of hydration, `TulaClient` gained an
optional `serverState`, which `@tula/react` uses as the `useSyncExternalStore` server snapshot
instead of `loading`; the provider wraps the client so that it answers with that state until
the client's own first refresh. When the browser's client finds itself in another session
(signed in, or signed out by the server) the router is refreshed so Server Components render
again; a sign-out made in the page refreshes after the request has reached the server.

## Consequences

- An app's origin, not the API's, is what the environment's `urls.allowedOrigins` must list.
- For per-visitor rate limits the Next.js server needs `TULA_TRUSTED_PROXY_HOPS` (or
  `clientIp`) and the API `TRUST_PROXY=true`, reached directly. Without both, all visitors
  share one address at the API.
- The server side knows the user without a database call for `hybrid` sessions, and with one
  API call per request for `stateful` ones.
- A secret key is needed only for `stateful` profiles. It is read only by the server entry
  points; the client entry's built output is tested to contain no reference to it.
- `auth()` in the root layout makes every route dynamic. An app that wants static pages leaves
  `initialState` out there and accepts `loading` for the first paint.
- `examples/nextjs-app-router` and a second Playwright project (`nextjs`) cover protected
  routes, server rendering, expiry and refresh, sign-out, revocation, a stateful profile,
  cross-site requests, `redirect_url`, an OAuth round trip and an emailed link (both finish
  on a callback page of the app, through the handler: the provider returns to the API's host,
  which sends the browser to the app's page with a ticket in the fragment; the bindings live
  in the app origin's storage) and axe in both colour schemes. The example is built once
  per run, in the browser-test job, not in `verify`.

## Deferred

- `auth.protect()` and role or permission checks (nothing to check yet).
- The Pages Router, and Server Actions that refresh a session themselves.
- Caching a stateful session's verification between requests.
- A tab that learns of a sign-out from another tab re-renders its Server Components while the
  sign-out request may still be in flight, and can show the signed-in server render until its
  next navigation. Every request is still verified by the middleware.
