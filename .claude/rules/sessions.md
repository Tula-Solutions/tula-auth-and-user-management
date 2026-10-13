---
paths:
  - "apps/api/src/modules/session/**"
  - "apps/api/src/middleware/session-auth*"
  - "apps/api/src/middleware/cors*"
  - "packages/contract/src/session-profile*"
---

# Sessions: profiles, the stateful type and the concurrent-session rule

Moved here from `AGENTS.md`, word for word, and canonical for this area: `AGENTS.md` lists
this file under "Area rules" and does not repeat it. A section named in a sentence as
"above" or "below" is found through that list.

## Security rules (non-negotiable)

- **Session lifetimes come from the session's profile, as configured now** ([ADR 0028](../../docs/adr/0028-session-profiles.md)).
  Never a constant: read the profile with `Sessions.profileOf(deps, scope, session)` and apply
  it through the session service, which ends a session at the earlier of what was stored and
  what the profile says today. A profile is chosen only in `Sessions.create`
  (`resolveSessionProfile`): by client kind, or the one the client asked for
  (`x-tula-session-profile`) **when the environment marks it `clientSelectable`**. Never let a
  request pick a profile by any other path, and never answer differently for a profile that
  exists and one that does not. A revoked session is denylisted for `MAX_ACCESS_TOKEN_TTL`
  (the longest any profile may set), not for its own profile's lifetime. The grace window is
  10 to 60 seconds or `null`; `@tula-tech/core`'s `REFRESH_TIMEOUT_MS` stays below the floor.
- **A `stateful` session is a cookie checked against the store on every request.** Its token
  is derived (`tula_st_…`), stored only as SHA-256, never rotated, never in a response body,
  and never accepted as a refresh token (nor a refresh token as it). It is read only through
  `sessionAuth()` / `Sessions.authenticate`, set and cleared only with the helpers in
  `~/modules/session/cookies`, and honoured only when `requestMayUseSessionCookie(c)`
  (`~/middleware/cors`) says so: not `Sec-Fetch-Site: cross-site`, an `Origin` the environment
  allows, and an `Origin` present on every state-changing request. When that fails the cookie
  is ignored (the request is unauthenticated); it is never an error that says a cookie was
  there. A route under `/v1/client/*` that changes state must stay behind `publishableKey()`
  (the custom header a form cannot send). Stateful is for `web` clients only.
- **The concurrent-session rule is enforced in the session store's `create`**, in one
  transaction per user (`SessionLimit`). The service names the sessions to end (oldest by
  sign-in time) and denylists them before the store ends them; the store never chooses.
  Never count sessions and insert in two steps.
- **A session records how it was authenticated.** `Sessions.create` takes `authMethods`; the
  access token carries `auth_time` and `amr` from the session row (never "now": refresh must
  not make an old sign-in look recent). Only `Sessions.recordAuthentication` moves them.
  `amr` is a set: never compare it as an ordered array (scenarios use `{ "$set": [...] }`).

## What to test

The failure paths a change here is held to (moved from the checklist of `security.md`; the
rules themselves are above and are not repeated).

- **Profiles:** both sides of every limit you touch; a profile tightened after the session
  was created (ended at its next refresh or request), one loosened (never past the stored
  absolute limit) and a deleted one (the built-in for the client kind). For the profile a
  client asks for: an unknown name, one not offered, the other kind's built-in and an
  inherited object key (`constructor`); each gives the client kind's built-in and the same
  answer. Read profiles by own key only.
- **Stateful sessions:** the token is refused as a refresh token and a refresh token as it;
  another environment's key; a revoked, an idle and an over-age session on the **very next**
  request; and a Bearer header, when present, decides alone.
- **Cookie authentication and CSRF,** for a read and for every kind of mutating route: an
  `Origin` the environment does not allow, `Sec-Fetch-Site: cross-site` with an allowed
  `Origin`, and an unsafe method with no `Origin`. Each must leave the request
  unauthenticated with **nothing changed and no `Set-Cookie`** (a foreign page must not be
  able to clear the cookie either). The cookie has the `__Host-` prefix over https and no
  `Domain`.
- **Concurrent sessions:** simultaneous sign-ins at the limit in the shared store suite (both
  adapters); only live sessions count; another user's and another environment's sessions are
  never ended or counted; `refuse_newest` creates no session, sets no cookie, and is answered
  only after every factor was proven (a wrong password at the limit is still
  `auth.invalid_credentials`).
- **Backend verification:** `POST /v1/admin/sessions/verify` needs a secret key of the
  session's own environment, never answers a refresh token with claims, and never writes the
  token to a log or an audit entry.
- What a session is tested for in another area is in that area's file: a device key
  (`device-binding.md`), custom claims (`jwt-templates.md`), the hooks asked when one is made
  (`auth-hooks.md`).
