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
- **Reuse detection.** Presenting a used token revokes the session (`session.reuse_detected`).
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
  service, which adds the entry.
- **Delivery.** Native and server clients send and receive the refresh token in the body.
  Browsers use a cookie: `HttpOnly`, `SameSite=Lax`, `Secure` over https (with the `__Secure-`
  prefix), path `/v1/client/sessions`, named per environment because one API host can serve
  several. Whichever way the token arrived is how the next one is returned; a cookie that turns
  out to be unusable is cleared.
- **Sign-out takes the refresh token** (body or cookie), not the access token, so it works with
  an expired access token. It always answers 204.
- **Device management.** A user can list their active sessions and revoke one or all others.
  Another user's session and a missing one both answer 404.

## Consequences

- The denylist is in process memory in Phase 0: with several API instances, a revoked session's
  access token can still be accepted by another instance for up to 60 seconds. The Redis adapter
  (Phase 1) closes this.
- Rotating `TULA_MASTER_KEY` changes the derivation key. Stored hashes still match tokens already
  issued, but the grace-period replay re-derives the child with the new key and would return a
  token that does not match its stored hash; affected clients sign in again.
- A client that retries a refresh more than 10 seconds late is signed out. That is the intended
  trade-off: beyond the window a retry is indistinguishable from theft.
- Reuse is logged (`refresh token reuse detected`); the `session.reuse_detected` event for
  webhooks arrives with the events outbox (Step 5.9).
- Expired and revoked sessions are not pruned yet; a cleanup job deletes them by session, and
  the cascade removes their token chains.
