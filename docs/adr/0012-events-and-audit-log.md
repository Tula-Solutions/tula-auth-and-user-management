# ADR 0012 — Events outbox and audit log

- Status: accepted
- Date: 2026-10-01

## Context

Two things need a reliable record of what happens in an environment. Webhooks (Phase 2) need
every auth event, exactly as it happened, to deliver later. Operators need an audit trail: who
did what, to whom, from where. A record written *after* the change, as a separate step, can be
lost when the process dies in between, and then the system has done something it has no record
of.

## Decision

- **One record, two tables.** Each recorded action is an *activity*: a type, an actor, a target,
  an origin (IP and user agent) and a few details. It is written to `events` (the outbox: type
  and payload, `delivered_at` null) and to `audit_logs` (actor, target, origin, metadata). The
  two rows share an id. They are separate tables because their lives differ: events are a
  delivery queue that can be trimmed once delivered; audit entries are kept.
- **Written in the same transaction as the change.** Stores take the activity as an argument of
  the write it describes (`deps.users.delete(env, id, activity)`), and insert it inside that
  write's transaction. The change and its record either both happen or neither does: if the
  record cannot be written, the change is rolled back. There is deliberately no standalone
  "write an audit entry" method.
- **Recorded only when something changed.** A store records the activity only if its guarded
  write took effect. Revoking an already-revoked session, banning an already-banned user or
  revoking a key twice writes nothing more.
- **What is recorded.** `user.created`, `user.email_verified`, `user.banned`, `user.unbanned`,
  `user.deleted`, `user.password_changed`, `session.created`, `session.revoked` (with its
  `reason`), `session.reuse_detected`, `api_key.created`, `api_key.revoked` and
  `signing_key.rotated`. The list is `ACTIVITY_TYPES` in `@tula/contract`.
- **A replayed refresh token is `session.reuse_detected`,** not `session.revoked`, so it can be
  alerted on by itself. A session ends with exactly one of the two.
- **Actors.** `admin` is a secret key (the id is the API key's, so a leaked key's actions can be
  listed); `user` is a signed-in user, or the user a refresh token or a completed flow proves;
  `system` is the server acting by itself (reuse detection, the ban check on refresh, the
  `api-key:create` script). `agent` is reserved for the MCP server.
- **Never in a record:** passwords, hashes, tokens, codes, key material or email addresses.
  Users are named by id only, so an entry stays meaningful, and holds no personal data beyond
  the origin, after the user is deleted. Event payloads leave out the IP and user agent.
- **The origin is validated where the record is built.** `audit_logs.ip_address` is `inet`; a
  value that is not an address would fail the insert and, by the rule above, undo the change.
  Anything that does not parse is stored as `null`; the user agent is cut at 512 characters.
- **Append-only for the server.** The runtime database role has only `SELECT` and `INSERT` on
  `audit_logs` (and no `DELETE` on `events`), and both tables are under the same fail-closed
  row-level security as the rest of the tenant data.
- **Reading.** `GET /v1/admin/audit-logs` (secret key) lists an environment's entries newest
  first, with the usual `page`/`size` paging and exact-match filters `action`, `actorId` and
  `targetId`. In the response `action` and `target.type` are strings, not enums, so a client
  keeps working when a later server records new kinds of action.

## Consequences

- An operation made of several writes is recorded per write. Banning a user is one transaction
  for the ban and one for ending their sessions; a crash between them leaves the ban recorded
  and the sessions still open, which the ban check on refresh then closes (and records).
- Nothing reads the outbox yet. Events accumulate undelivered until the webhook worker (Phase 2)
  ships; there is no retention job for either table. Both need one before a busy production
  deployment.
- Not recorded: token refreshes (about one a minute per session), failed sign-ins, lockouts and
  rate-limit refusals. They have no write to share a transaction with, and they are
  attacker-driven, so recording them needs its own volume limits first.
- Event payloads (`{ actor, target, data }`) are not yet a typed contract per event type. They
  will be fixed when webhooks ship; until then treat `data` as informative.
- Audit entries keep IP addresses after a user is deleted. A retention policy has to cover that.
- Every write that records activity costs two more inserts in its transaction.
