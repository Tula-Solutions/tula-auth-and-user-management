---
'@tula/nextjs': patch
---

`auth()` no longer disagrees with the interceptor behind a proxy that ends TLS and sends no
`X-Forwarded-Proto`.

Next.js writes `x-forwarded-proto` itself (`http`, from its own socket) when no proxy sent it,
so the rule "read the `__Host-` cookie names when a `__Host-` cookie is present and nothing
says the scheme" never applied under a real Next.js server. With `appUrl` passed to the
interceptor and the handler as an option and no `TULA_APP_URL`, a signed-in visitor was sent
back and forth between a protected page and the sign-in page without end.

- With no app URL configured, a request that carries one of the SDK's `__Host-` cookies is
  read under the `__Host-` names even if `X-Forwarded-Proto` says `http`. The interceptor, the
  route handler and `auth()` / `currentUser()` now choose the names by the same rule. A
  configured app URL still wins over everything, and a forwarded `https` still means https.
- With neither an app URL nor a forwarded `https`, the handler still refuses every write from
  an https page (`request.origin_not_allowed`); it now reports the likely cause once
  (`onWarning`, or `console.warn`): set `TULA_APP_URL`, or have the proxy send
  `X-Forwarded-Proto: https`.

- Where the `__Host-` names are in use only because such a cookie arrived, an answer that
  sets or clears one of the app's cookies (a sign-in, a refresh, a sign-out, a refused
  refresh) now also expires `tula_at`, `tula_rt` and `tula_session`. On `localhost`, where
  cookies are shared across ports, an earlier sign-in over http could otherwise come back
  after a sign-out. With an app URL or a forwarded `https` nothing changes.

Setting `TULA_APP_URL` remains the recommended way.
