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
  10 to 60 seconds or `null`; `@tula/core`'s `REFRESH_TIMEOUT_MS` stays below the floor.
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
