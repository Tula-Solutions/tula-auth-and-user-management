---
'@tula/nextjs': minor
'@tula/contract': minor
'@tula/core': minor
'@tula/react': minor
---

`@tula/nextjs`: Tula for the Next.js App Router (ADR 0029).

- `@tula/nextjs/handlers`: `createTulaHandlers()`, a catch-all route handler that stands in
  for the API's `/v1/client/*` on the app's own origin. The browser's client talks to it and
  never to the API's host, so the refresh cookie, a `stateful` session's cookie and a new
  access-token cookie are first-party, `HttpOnly` cookies of the app. It forwards the
  browser's `Origin` unchanged, refuses requests that do not come from the app's own pages,
  never forwards the admin API and never follows a redirect. It trusts no forwarding header
  by default: the visitor's address reaches the API only with `trustedProxyHops`
  (`TULA_TRUSTED_PROXY_HOPS`) or `clientIp`. A sign-in replaces the browser's session
  whatever its kind, and request bodies and JSON answers are capped at 1 MiB.
- `@tula/nextjs/middleware`: `tulaMiddleware()` for `proxy.ts` (Next.js 16) or `middleware.ts`
  (Next.js 15). Verifies the access token offline against the environment's JWKS, refreshes it
  once through the API when it is missing or expiring, protects routes by matcher and
  redirects to sign-in with a same-origin `redirect_url` (`safeRedirectPath`). It clears the
  cookies only when the API says the session is over; a refusal caused by the app's own
  configuration (origin, key) keeps them and is reported once (`onWarning`).
- `@tula/nextjs` refuses a configuration that would send the secret key (`stateful` session
  profiles) to a plain `http:` `apiUrl` that is not this machine; `allowInsecureHttp`
  (`TULA_ALLOW_INSECURE_HTTP=true`) allows it on a private network you trust.
- `@tula/nextjs/server`: `auth()`, `currentUser()` and `getToken()` for Server Components,
  Route Handlers and Server Actions.
- `@tula/nextjs`: `<TulaProvider>` for the App Router (takes the server's `initialState`, so
  the first paint is right) and every `@tula/react` component and hook, marked `'use client'`.
- `@tula/contract/issuer`: `environmentIssuer` and `jwksUrl` as a Zod-free entry point (still
  exported from the index).
- `@tula/core`: `TulaClient` has an optional `serverState`, set by a framework integration.
  `@tula/react` renders it during server rendering and hydration instead of `loading`.
