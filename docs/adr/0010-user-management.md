# ADR 0010 — User management and password changes

- Status: accepted
- Date: 2026-10-01

## Context

Servers and the dashboard need to manage an environment's users, and a signed-in user needs
to read their own record and change their password. Every action that takes access away
(ban, delete, password change) has to end sessions reliably.

## Decision

- **Admin routes take a secret key** (`/v1/admin/users`): list, create, get, delete, ban,
  unban and set password. A user in another environment is indistinguishable from a missing
  one (404).
- **Lists follow the payhub convention:** `q`, `page`, `size` (max 100) and `sort` in the
  query, `{ meta: { totalCount, totalPages, page, perPage }, data }` in the response. `q`
  matches part of the email or a name, case-insensitively, with `%` and `_` escaped so they
  match literally. Sort keys are an allow-list; `id` breaks ties so paging is stable, and users
  without a value sort last in both directions.
- **Admin create reports a taken email** (409). The caller holds a secret key, so unlike
  sign-up there is nothing to hide. The password must meet the policy; the email is unverified
  unless `emailVerified` is set (for imports).
- **Ban** records the ban first, then revokes every session (`user_banned`). Sign-in already
  refuses banned users, and **refresh now checks the ban too**, so a session created in the
  instant between the ban and the revocation dies on its first refresh. **Unban** revokes the
  user's sessions once more before clearing the ban, so such a session can't outlive a quick
  unban either.
- **Delete** revokes the user's sessions through the session service (so their access tokens
  are denylisted) and then deletes the user; identities, credentials, sessions, refresh tokens
  and flow attempts go by cascade.
- **Admin set-password** ends *every* session of the user (`password_changed`).
- **A user changing their own password** must give the current one, so a stolen access token
  alone cannot take the account over. Wrong guesses back off exponentially per user (ADR 0011),
  on top of a per-IP limit; a correct one clears them. On success every *other* session ends and the device making the change
  stays signed in.
- **Every session-ending path goes through `~/modules/session/service`,** which denylists
  before it revokes (ADR 0008).

## Deviation from the plan

The plan says a password change "revokes all sessions". Changing your own password keeps the
current device signed in and ends the others, which is what users expect and loses nothing:
the caller has just proven they know the password. An admin reset still ends all sessions.

## Consequences

- There is no self-service "forgot password" flow yet. The pieces exist (`password_reset`
  verification tokens, `Sessions.revokeAllForUser`, the flow engine), but the plan's step list
  does not include it; until it lands, a reset goes through an admin.
- Admin actions are not audited yet; the audit log arrives with Step 5.9.
- The refresh-time ban check costs one user lookup per refresh (about once a minute per
  session).
- Someone holding a stolen access token can fail the current-password check on purpose and
  make the real user wait before changing their password (ADR 0011).
- Setting a password for a user with no password credential answers 409. No such user can exist
  yet; when passwordless users arrive (Phase 1) this path must create the credential.
- Offset paging gets slow on very large user tables; cursor paging can be added without
  changing the response shape.
