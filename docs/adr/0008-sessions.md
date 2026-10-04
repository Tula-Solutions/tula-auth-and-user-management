# ADR 0008 — Sessions and refresh-token rotation

- Status: accepted
- Date: 2026-10-01

## Context

Phase 0 ships the `hybrid` session type (business plan §5.3): a short-lived access token that
any service can verify offline, plus a long-lived refresh token the server controls. The risks
are a stolen refresh token, concurrent refreshes from several tabs, and revoked sessions whose
access tokens are still unexpired.

## Decision

- **Access tokens** are EdDSA JWTs with a 60-second TTL, signed with the environment's active
  key and carrying `iss, sub, aud, sid, pid, eid, iat, exp, v`.
- **Refresh tokens are opaque, single-use and stored only as SHA-256.** Each is derived, not
  random: `tula_rt_` + `HMAC(key, "parent:<parent id>")`, or `"session:<id>"` for the first one,
  with a key derived from `TULA_MASTER_KEY` for the `refresh-tokens` purpose.
- **A session is the token family.** One `sessions` row owns the whole chain of `refresh_tokens`
  rows; revoking the session invalidates every token at once.
- **Rotation is one guarded transaction:** lock the session row, insert the child, mark the
  parent used only if it is still unused. Of several concurrent refreshes exactly one rotates.
- **Reuse detection.** Presenting a used token revokes the session (`session.reuse_detected`),
  however old that token is: reuse is judged before the token's own expiry.
  The session keeps answering with that code, so the legitimate holder of the newest token
  learns why they were signed out.
- **One exception: the reuse grace period (10 s).** A used token presented again within the
  window, while its child is still unused, returns the *same* child (re-derived) with a fresh
  access token. Nothing new is minted. This makes racing tabs and retried requests idempotent;
  deriving the child from the parent is what makes it possible without storing a recoverable
  token. Outside the window, or once the child has rotated, it is reuse.
- **Timeouts.** Idle: 7 days since the last refresh. Absolute: 30 days from sign-in, whatever
  the activity. The idle expiry is capped at the absolute one. Both are checked against the
  injected clock on every refresh.
- **Revocation reaches access tokens through a denylist.** `sessionAuth` verifies tokens with
  cached keys and no database hit, then checks the token's `sid` against a `RevokedSessions`
  port. Entries live for one access-token TTL. Every revocation path goes through the session
  service, which adds the entry *before* updating the database, so a failure between the two
  steps can never leave a revoked session with a working access token.
- **Delivery.** Native and server clients send and receive the refresh token in the body.
  Browsers use a cookie: `HttpOnly`, `SameSite=Lax`, `Secure` over https (with the `__Secure-`
  prefix), path `/v1/client/sessions`, named per environment because one API host can serve
  several. Whichever way the token arrived is how the next one is returned; a cookie that turns
  out to be unusable is cleared.
- **Sign-out takes the refresh token** (body or cookie), not the access token, so it works with
  an expired access token. It always answers 204.
- **Device management.** A user can list their active sessions and revoke one or all others.
  Another user's session and a missing one both answer 404.

> **Since ADR 0028** the numbers in this record (60 seconds, 7 and 30 days, the 10-second grace
> window) are the *defaults* of a session profile, which an environment can change per profile;
> a session's limits are read from its profile as configured now; denylist entries live for the
> longest access-token lifetime any profile may set (15 minutes); and a second session type,
> `stateful`, is checked against the store on every request instead of carrying tokens. See
> [ADR 0028](0028-session-profiles.md).

## Consequences

- The denylist is shared through Redis when `REDIS_URL` is set, which `staging` and `prod`
  require ([ADR 0016](0016-redis-and-multiple-instances.md)): a session revoked on one instance
  is refused by all of them at once. If Redis cannot be reached, requests carrying an access
  token and revocations are refused with `service.unavailable` (503); refresh keeps working.
  Without `REDIS_URL` (`local` and `dev` only) the denylist is in process memory, and another
  instance would accept a revoked session's access token for up to 60 seconds.
- Rotating `TULA_MASTER_KEY` changes the derivation key. Stored hashes still match tokens already
  issued, but the grace-period replay re-derives the child with the new key and would return a
  token that does not match its stored hash; affected clients sign in again.
- A client that retries a refresh more than 10 seconds late is signed out. That is the intended
  trade-off: beyond the window a retry is indistinguishable from theft.
- Reuse is logged (`refresh token reuse detected`) and recorded as a `session.reuse_detected`
  event and audit entry, in the same transaction as the revocation (ADR 0012).
- Expired and revoked sessions are deleted 30 days after they ended, by session, and the
  cascade removes their token chains ([ADR 0017](0017-retention.md)). A refresh token of a
  purged session is answered like any unknown token.
