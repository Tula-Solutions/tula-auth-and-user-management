# ADR 0028 — Session profiles, the stateful session type and session rules

- Status: accepted
- Date: 2026-10-04

## Context

Until now every session was the same: `hybrid` (ADR 0008), 60-second access tokens, 7 days
idle, 30 days absolute, a 10-second refresh grace window, constants in the code. Operators need
different lifetimes for different clients (a browser, a phone, a back office), a session type
whose revocation is instant and that gives browser JavaScript no token at all, a limit on how
many sessions a user may have, and a way to ask for re-authentication sooner on some sessions.

## Decision

### Profiles

- **`sessions.profiles` in the environment's settings** (ADR 0018) is a map of named profiles.
  `web` and `mobile` are always present; up to 10 more may be added under kebab-case names of
  at most 32 characters. Each profile has `type`, `accessTokenTtl`, `idleTimeout`,
  `absoluteTimeout`, `refresh.reuseGracePeriod`, `stepUpAfter` and `clientSelectable`. Every
  field has a default and the defaults are what every session got before: an environment that
  saved nothing behaves exactly as it did.
- **Bounds**, enforced by the contract schema on input (unknown keys refused) and applied
  leniently on read (unknown keys dropped):

  | Field | Range | Default |
  | --- | --- | --- |
  | `accessTokenTtl` | 30 s to 15 min | 60 s |
  | `idleTimeout` | 1 min to 365 d | 7 d |
  | `absoluteTimeout` | `idleTimeout` to 365 d, or `null` (no cap) | 30 d |
  | `refresh.reuseGracePeriod` | 10 s to 60 s, or `null` (none) | 10 s |
  | `stepUpAfter` | 1 min to 24 h, or `null` (ten minutes) | `null` |

  `mobile` must be `hybrid`. `accessTokenTtl` must not be longer than `idleTimeout` (a field
  error on `accessTokenTtl`): activity is noticed once per `accessTokenTtl`, so a longer one
  would time an active `stateful` user out and let a `hybrid` access token outlive its idle
  session. This rule is **input only**. A stored document is not refused for it on read (it
  could have been saved before the rule, and a document that cannot be read fails every
  request of its environment); instead `Sessions.authenticate` writes activity whenever less
  idle time is left than the write interval, so even such a profile never signs out a user
  who keeps making requests.
- **The grace window has a floor of 10 seconds, or is absent.** `@tula/core` gives one refresh
  8 seconds (`REFRESH_TIMEOUT_MS`) and retries once with the same token inside 10 seconds. A
  window between "none" and 10 seconds would turn a slow network into `session.reuse_detected`
  for every SDK user, so it is not accepted. `null` is the deliberate choice of strict
  rotation: every replay ends the session, an honest retry included. A core test holds
  `REFRESH_TIMEOUT_MS` below the floor (`MIN_REUSE_GRACE_PERIOD`).
- **The server chooses the profile, when the session is created**: `web` for a browser,
  `mobile` for every other client kind. A client may *ask* for a profile with the
  `x-tula-session-profile` header, read when the attempt starts (like `x-tula-client`) and kept
  on the attempt. It gets that profile only when the environment marks it `clientSelectable`
  (default `false`). Anything else it names (an unknown profile, one not offered, the other
  kind's built-in) is **not an error**: the session gets its kind's built-in. A client can
  therefore never give itself a longer-lived session than the operator offered, and cannot
  learn which names exist. A malformed name is a validation error.
- **The session row records the profile's name; the limits are read as configured now.** On
  every refresh (and, for `stateful`, every request) the session ends at the earlier of what
  was stored and what its profile says today, so tightening a timeout ends an over-age session
  at its next refresh. Loosening never moves a session past the absolute limit it was created
  with; a longer idle timeout applies from the next activity on. A session whose profile was
  deleted falls back to the built-in for its client kind; so does a native session stored as
  `web` before profiles existed.
- **Revocation outlives any profile.** A revoked session stays on the denylist for 15 minutes
  (`MAX_ACCESS_TOKEN_TTL`), not for its profile's lifetime, because the profile may have been
  shortened since the token was signed. A retired signing key is kept for twice that.
- Access tokens carry the profile's name as the optional claim **`sp`**.
- A settings change that lets sessions live longer or be had more freely (a longer timeout,
  token lifetime, grace window or step-up window on an existing profile, a profile opened to
  clients or removed, a raised or removed session limit) is recorded with `weakened: true`.
  So is a **new** profile that clients may select and that is looser in any limit than the
  built-in `web` profile of the same document (a longer idle or absolute timeout, token
  lifetime or grace window, a later step-up or none of its own): naming it gets a client a
  session the built-in would not have given. A new profile that is no looser than `web`, or
  that clients cannot select, is not.

### The `stateful` type

- **What it is.** The browser holds one opaque token (`tula_st_…`) in an `HttpOnly`,
  `SameSite=Lax`, `Secure` cookie. It is derived like a refresh token
  (`HMAC(key, "stateful:<session id>")`), stored only as SHA-256 as the session's single,
  never-rotated token row, and looked up in the session store on **every** request
  (`Sessions.authenticate`). No JWT and no refresh token are issued: a completed flow answers
  `session: { sessionId }` and nothing else. Revocation takes effect on the very next request,
  on every instance, with no denylist and no token lifetime in between.
- **The rest of the API does not fork.** `sessionAuth()` accepts a Bearer access token or, when
  there is no `Authorization` header, the session cookie, and sets the same `c.var.session`
  claims either way (built from the row for a stateful session). `requireRecentAuth()`, the
  routes and the services are unchanged. A Bearer token that is present decides alone.
- **A session's type is fixed when it is created** (`sessions.type`); changing a profile's type
  affects new sessions only. A session token is refused where a refresh token is expected and
  the other way round.
- **Activity** is written at most once per `accessTokenTtl` of the profile (the idle timeout
  has that precision, as it has for `hybrid`), and always when less idle time is left than
  that interval. That write is also when a ban is caught.
- **Browsers only.** A native client has no cookie jar the API can rely on: a client that is
  not `web` asking for a stateful profile gets `mobile`, and `@tula/core` refuses a token-less
  session for any other client kind.
- **Cookie.** Name `__Host-tula_session_<environment id>` over https (no prefix over plain
  http, which only local development has), `Path=/`, no `Domain`. `Path=/` is deliberate: the
  `__Host-` prefix requires it, and a deployment that serves the API under the application's
  own host needs the application's backend to receive the cookie. `Max-Age` is the absolute
  timeout (400 days when there is none); the server's idle timeout ends the session sooner.
- **Backend verification.** A resource server cannot verify a cookie offline.
  `POST /v1/admin/sessions/verify` (secret key) takes the cookie's value and answers with the
  claims an access token would carry (`sub`, `sid`, `auth_time`, `amr`, `sp`, `exp` = how long
  the answer may be relied on). It accepts a `hybrid` access token too (verified, then checked
  against the denylist), never a refresh token.
- **`POST /v1/client/sessions/refresh` with only the session cookie** answers
  `{ sessionId }`: the "am I still signed in" check a page makes on load. Nothing is rotated.
- **Redis.** A stateful request needs Postgres only. Revoking still writes the denylist first
  and so fails closed when Redis is down (ADR 0016).

### CSRF: why the session cookie cannot be used by another site

A cookie that authenticates every `/v1/client/*` route makes each mutating route a CSRF target
in a way a Bearer token never is. Four independent things stand in the way, and
`requestMayUseSessionCookie` (`~/middleware/cors`) is the one place the server-side ones live:

1. **`SameSite=Lax`.** Browsers attach the cookie to cross-site requests only for top-level
   `GET` navigations. No cross-site `fetch`, form `POST`, image or frame carries it.
2. **A required custom header.** Every client route requires `x-tula-publishable-key`. A form
   cannot send it; a cross-origin `fetch` can only after a CORS preflight, which is answered
   for allowed origins alone. So even a same-site but different-origin page (a sibling
   subdomain, where `SameSite` does not help) cannot produce the request unless its origin is
   on the allow-list.
3. **The `Origin` allow-list, checked on the request itself.** The cookie counts only when
   `Origin` is one the environment allows, and a state-changing request (anything but `GET`,
   `HEAD`, `OPTIONS`) must **have** an `Origin`: browsers send one on every such request, so
   one without it is not a page's `fetch`. A read without `Origin` (a same-origin `GET`) is
   served; its response is readable only where CORS allows.
4. **`Sec-Fetch-Site: cross-site` is refused** whatever `Origin` says.

Request bodies are JSON, which a form cannot produce with the right content type either; that
is a consequence of how the routes are written, not a defence the argument rests on: (2) alone
already rules out every request a page can make without a preflight. When a check fails the cookie is **ignored**, not
refused: the request is not signed in (`auth.unauthenticated`), nothing changes, and the
response neither confirms a cookie was there nor clears it. Sign-out from a foreign origin is a
no-op 204. Starting a sign-in from a foreign origin was already refused (ADR 0019), so a
foreign page cannot have the cookie *set* either (login CSRF).

Not defended against, by design: script running on an allowed origin (XSS). It cannot read the
token, which is the gain over `hybrid`, but it can make requests as the user while the page is
open, as with any cookie session.

### Rule 1: concurrent sessions

- `sessions.maxPerUser` (1 to 100, `null` = unlimited) and `sessions.onLimit`
  (`end_oldest`, the default, or `refuse_newest`). Only live sessions count.
- **Enforced in `Sessions.create`**, which the flow engine's `finish` is the only sign-in
  caller of, and atomically in the store: `SessionStore.create(session, token, activity,
  limit)` ends the sessions it is told to end, counts and inserts in one transaction that
  sign-ins of one user take in turn (Postgres: `SELECT … FOR UPDATE` on the user's row; memory:
  one synchronous step). Simultaneous sign-ins can never leave a user over the limit; the
  shared store suite proves it for both adapters.
- **`end_oldest`** ends the oldest sessions by sign-in time (reason `session_limit`, actor
  `system`, audited in the same transaction). The service reads the user's sessions, puts the
  ones to end on the denylist **first**, then asks the store to end exactly those; the store
  never picks a victim itself, so a session is never revoked in the database without being
  denylisted. When another sign-in got in between, the store writes nothing and the service
  reads again (four passes, then `service.unavailable`). Before it gives up, the service ends
  every session it put on the denylist (reason `session_limit`, audited), so none is left
  denylisted but not revoked: refused until the entry lapses and then alive again. That ends
  nothing wrongly. Each was among the oldest of a user at the limit, and the store refuses
  only when the user is full **without** them, so the rule ends them whoever wins; one the
  winning sign-in already ended is left untouched.
- **"Live" is judged by the stored expiry, not by the profile as configured now.** The count
  and the list it is taken from read `idle_expires_at` and `absolute_expires_at` as written at
  the session's last activity. A session that a since-tightened profile already treats as
  expired therefore holds a place until it is next used (and refused), until its stored
  expiry passes, or until `end_oldest` ends it as one of the oldest. Counting by today's
  limits would need the profile of every row inside the store's transaction, and the store
  does not read settings; the cost is a sign-in refused (`refuse_newest`) or an older live
  session ended (`end_oldest`) a little earlier than strictly needed, never a user over the
  limit.
- **`refuse_newest`** answers `session.limit_reached` (403) with no session and no cookie. It
  is answered only after every factor was proven, so it tells nothing to someone who could not
  sign in anyway; the attempt is spent. A user can be kept out by their own stale sessions:
  they sign out elsewhere, reset their password (which ends every session), wait for a
  timeout, or an operator calls `DELETE /v1/admin/users/:userId/sessions` (new, audited,
  reason `revoked_by_admin`). The error's message says the first two.

### Rule 2: step-up window per profile

`stepUpAfter` replaces the ten-minute default of `requireRecentAuth()` for sessions of that
profile (read from the `sp` claim, as configured now). It **only tunes the window of routes
that already require recent authentication**; it never makes an ordinary route ask ("re-
authenticate every N minutes" is what `absoluteTimeout` is for). A route that passes an
explicit `maxAgeSeconds` keeps it.

### `@tula/core`

- `createTulaClient({ sessionProfile })` sends the header.
- On a stateful profile the client holds no token: `getToken()` returns `null` and asks
  nothing, calls go out without `Authorization` (the transport already sends credentials for
  the `web` kind), the session is learned on load from the session check and `/v1/client/me`,
  a 401 on any call signs the client and its other tabs out at once (no refresh, no retry),
  and sign-out and cross-tab messages are unchanged (the message carries no token).
  Single-flight refresh is not used.

## Consequences

- `SessionTokens.accessToken` and `accessTokenExpiresAt` are optional in the contract. A client
  written against the old shape breaks only on a profile the operator made stateful.
- Stateful costs one indexed Postgres read per request and at most one write per
  `accessTokenTtl`. It is opt-in.
- The cookie is host-only. A backend on another host than the API cannot see it; such a
  deployment proxies the API under the application's host, or stays on `hybrid`. A
  configurable cookie `Domain` is deferred to the Next.js step (1.12), which has to decide it.
- Profile changes reach other instances with the settings cache (5 seconds with Redis, 30
  without). Nothing here depends on taking effect everywhere at once.
- A stateful session's idle timeout is not shown to the browser: the cookie outlives it and the
  next request is simply refused.
- A sign-in that loses the `end_oldest` race four times answers `service.unavailable` after
  ending the sessions it named: the user is left with room, and the retry signs in.

## Deferred

- The other session types of the business plan (`stateless`, `long-lived`, `kiosk`).
- JWT templates and custom claims: a hook surface that needs its own design (Phase 2, with
  webhooks).
- A cookie `Domain` for stateful sessions, and a stateful session for native clients.
- Showing a profile's limits in `GET /v1/client/config` (nothing needs them yet).
