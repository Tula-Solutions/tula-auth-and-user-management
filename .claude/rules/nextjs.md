---
paths:
  - "packages/nextjs/**"
  - "examples/nextjs-app-router/**"
  - "e2e/tests/nextjs/**"
---

# Next.js SDK

Moved here from `AGENTS.md`, word for word, and canonical for this area: `AGENTS.md` lists
this file under "Area rules" and does not repeat it. A section named in a sentence as
"above" or "below" is found through that list.

## Next.js SDK (see ADR 0029)

- **The browser talks to the app's origin, never to the API's host.** The route handler
  (`createTulaHandlers`, mounted at `app/api/tula/[...tula]/route.ts`) forwards `/v1/client/*`
  and nothing else. It forwards the browser's `Origin` and `Sec-Fetch-Site` **unchanged** and
  never invents an `Origin`: the API's allow-list and login-CSRF rules must keep deciding.
  Request and response headers are allow-lists; a redirect from the API is never followed or
  passed on; nothing of a request or response is logged.
- **The handler refuses what does not come from the app's own pages**, before forwarding: a
  cross-site request, a foreign `Origin`, and any request other than `GET`/`HEAD` with no
  `Origin`.
- **Three first-party cookies** (`tula_rt`, `tula_session`, `tula_at`): `HttpOnly`,
  `SameSite=Lax`, `Path=/`, no `Domain`, `Secure` and `__Host-` over https. Write them only
  with `setCookieLine` / `clearCookieLine` (`packages/nextjs/src/cookies.ts`), never copy an
  attribute from the API's cookie, and read only the name for the request's own scheme.
  Where that scheme was taken from a `__Host-` cookie on the request (no app URL, no forwarded
  `https`), every answer that sets or clears a cookie also expires the plain-named ones
  (`supersededCookieLines`): a session signed out of must not come back under the other name.
- **A session is verified, never assumed.** `verifyAccessToken` (`EdDSA` only, `kid`, `iss`,
  `aud`, `exp`, `sub`, `sid`) runs in the middleware and again in `auth()`. The one header
  that carries claims (`x-tula-auth`, stateful sessions) is honoured only with this app's HMAC
  over the claims and the session cookie; the middleware strips any copy the browser sent.
  Never add a header that is trusted for being present.
- **A `redirect_url` is a path on this origin**: written by the middleware, read through
  `safeRedirectPath`. Never pass one to a redirect or a component any other way.
  `safeRedirectPath` checks the value it **returns**: the URL parser turns `/.//host` into
  `//host`, so a check of the input alone is not enough. Keep its table and the test that
  builds paths from dot, encoded and empty segments.
- **Cookie names are chosen in one place, `readRequestCookies`, for the interceptor, the
  handler and the server helpers alike** (`auth()` and `currentUser()` see no URL and build a
  stand-in with `requestFromHeaders`). The scheme is, in order: the configured app URL
  (`TULA_APP_URL`, the recommended way; it wins over everything); a forwarded `https`; and
  otherwise https exactly when the request carries one of the SDK's `__Host-` cookies,
  **even if `X-Forwarded-Proto` says `http`**. Next.js writes `x-forwarded-proto` itself from
  its own socket when no proxy sent it, so the header is never absent and `http` in it is not
  evidence; a browser stores a `__Host-` cookie only from an https response of that exact
  host. Never read both names for one request, and write tests of this with the header sets
  Next.js really produces (the forwarded scheme always present). **The app's origin never
  follows a cookie** (`appOrigin`: the handler's same-origin check, the `Origin` of a
  refresh): with no app URL and no forwarded `https` the handler refuses every write behind a
  TLS-terminating proxy, on purpose, and says why once (`explainRefusal`, fixed text).
- **A call to the API is built once, from its URL and parts** (`callApi(config, url, init)`).
  Never build a `Request` from another `Request` in this package: the Edge runtime of
  Next.js 15 keeps only the URL of the one it is given, so a copied `POST` reaches the API as
  a bare `GET` (`middleware.test.ts` runs the refresh and the stateful check under such a
  `Request`). `package.test.ts` lists every `new Request(` of the sources with its first
  argument: a new one is added there on purpose, after checking it is a string or a `URL`.
- **The middleware imports no Node API** (it runs in the Edge runtime on Next.js 15), and the
  client entry (`src/index.ts`, `src/provider.tsx`) imports nothing that reads the server
  configuration: `package.test.ts` builds the package and checks both, and that the client
  entry's output has no reference to the secret key. Every entry point is one file; keep
  `splitting: false`.
- **No forwarding header is trusted by default.** The visitor's address is sent to the API
  only when the app says how it is known: `trustedProxyHops` (`TULA_TRUSTED_PROXY_HOPS`,
  default 0; the Nth `X-Forwarded-For` entry from the right) or `clientIp`. Never read a
  client-supplied address by any other rule. The API also needs `TRUST_PROXY=true`; without
  both, every visitor shares the Next.js server's address and one per-IP rate limit. Say so
  wherever the setup is documented.
- **A browser holds one session.** When an answer issues a `stateful` session's cookie the
  handler removes `tula_rt` and `tula_at`, and the other way round: the server reads the
  token first, and an earlier user's must not answer for the new one.
- A refresh the API refuses **for the session** (`session.*`, `auth.user_banned`) clears the
  cookies. Anything else changes nothing, including a 401/403 about the request itself
  (`auth.invalid_key`, and `auth.unauthenticated`, which here means the app's origin is not
  allowed): the request is signed out, the cookies stay, and a warning names the likely
  misconfiguration, once, with no secret in it.
- The handler caps what it passes on (1 MiB request body, counted while streaming; 1 MiB JSON
  answer). Parallel refreshes rely on the profile's reuse grace window: `real-api.test.ts`
  holds both sides of it against the real API in process.
- **The server-side refresh gives up inside the grace window**: at most `REFRESH_TIMEOUT_MS`
  (8 s, below `MIN_REUSE_GRACE_PERIOD`; a test holds it and that it equals `@tula/core`'s),
  whatever `timeoutSeconds` says, and a refresh that got no answer is repeated once, at once,
  inside the single flight. An HTTP answer of any status is never repeated.

## Modules and tests in detail

What the section above does not say (moved from `sdk.md`).

- Four entry points: `.` (`'use client'`), `./server` (`import 'server-only'`),
  `./middleware` and `./handlers`. Peers: `next` 15 and 16, `react` 19. In Next.js 16 the
  interceptor file is `proxy.ts` (Node.js runtime); in 15 it is `middleware.ts`.
- `src/index.ts`, `src/provider.tsx` and `src/paths.ts` are the browser's half: they import
  nothing from `config.ts`, `upstream.ts`, `session.ts` or `verify.ts`. Configuration is read
  in server code only, on first use (never at module load: `next build` runs without it).
- The route handler sends the app's own publishable key and, where the app said how the
  visitor's address is known, that address as the one `X-Forwarded-For` entry (no forwarding
  header of the request is ever copied). A request body over the cap is a 413 and a buffered
  JSON answer over it a 502. Which cookies an answer removes is `changes` in `handlers.ts`:
  one entry per cookie.
- A cookie's value is checked with `isCookieValue` before it is written.
- A new claim check goes in `verifyAccessToken` and gets a failure-path test in
  `middleware.test.ts` (run for both the middleware and `auth()`).
- Custom claims (ADR 0036) reach application code only through `sessionClaims` (`verify.ts`),
  which replaces `ext` with what `readCustomClaims` accepts or removes it: for a verified
  token, the stateful check's answer and the opened `x-tula-auth` header
  alike. `auth().customClaims` is a frozen record of `unknown` values (empty when signed in
  with none, `null` when signed out). `custom-claims.test.ts` runs its malformed table for
  the middleware and for `auth()` alone; a new way a session's claims arrive gets a row
  there. `@tula/core` and `@tula/react` do not expose them.
- `x-tula-auth` is sealed with `sealClaims`, opened with `openClaims` and stripped from every
  incoming request by `resolveSession`. Tests cover a forged header with and without the
  middleware.
- The middleware refreshes at most once per request and shares a refresh among requests with
  the same token in one process. What ends a session is `endsSession` in `upstream.ts`; on
  any other failure the cookies stay, and a refusal of the request is reported once through
  `config.warn`. The handler's refusal of an https `Origin` for a host it takes to be http
  is reported once through `config.warn` with fixed text (no host, no `Origin`, no cookie).
  Warnings carry no token, key or cookie. Change the refresh path and the parallel-refresh
  and past-the-grace-window tests of `real-api.test.ts` must still hold; `upstream.test.ts`
  holds the timeout.
- `signInUrl` is checked with `safeRedirectPath` when the middleware is created.
- Where the cookie rule chose the names (`cookies.superseded`) the interceptor also drops the
  plain-named cookies from the request it passes on. Never expire them where the app URL or a
  forwarded `https` chose.
- The provider wraps the client it creates: `serverState` for the first paint, and a
  `session.signOut()` that refreshes the router after the request has reached the server. Do
  not call `router.refresh()` for a sign-out before then: the cookies are still there.
- A new page of the example gets an axe check in both colour schemes in `e2e/tests/nextjs/`.
