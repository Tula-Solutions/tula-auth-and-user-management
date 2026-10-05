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
- **The activity is a required argument** (added after the Phase 1 review; until then it was
  optional, and "every change is recorded" was held by tests and review only). Every store
  method that changes a user, an identity, a session, a second factor, a passkey, an API key,
  a signing key, a provider's credentials or an environment's settings takes
  `activity: Recorded` (`~/ports/activity-log`), in the port and in the memory and Postgres
  adapters alike, including the per-session builders of `SessionLimit` and `revokeByUser`
  and the entry for a password removed by `markEmailVerified`. A call without one does not
  compile, and `undefined` is not accepted: `ports/activity-log.test.ts` holds a
  `@ts-expect-error` line for each method, which `typecheck` fails on if the call ever
  compiles again.
- **Two ways to write without a record, both visible.**
  - *A write that is never recorded is a method of its own that takes no activity*:
    `upgradePasswordHash` and the signing-key store's `insert` (see "What is deliberately not
    recorded"). This was already how both were written, which is why it was chosen over a
    sentinel for them: the exception is in the port's method list, with its reason in its
    documentation, and cannot be reached by passing a different argument to a recording
    method.
  - *`Audit.none(reason)`* builds the one value (`Unrecorded`) a recording method accepts in
    place of an activity. `reason` is a closed union, `UnrecordedReason`, with one member,
    `'fixture'`: a row that stands for something that happened elsewhere, in a test or in the
    browser tests' fixture (`e2e/server.ts`). Several hundred test call sites seed stores
    this way, and giving each a real activity would fill the logs the same tests assert on.
    The server's own code has no use for it, and two things keep it out. **The value is
    branded**: `Unrecorded` has one key, a `unique symbol` that `ports/activity-log.ts`
    declares and does not export (and does not register with `Symbol.for`), so no object
    literal anywhere else is an `Unrecorded`, to the compiler or at run time. The port's
    `unrecordedFor` is the only code that can set the key, `Audit.none` is its only caller,
    and stores tell the value apart only through `isUnrecorded` (an own-property check for
    that key): a look-alike forced through a cast is taken for the activity it claims to be,
    never skipped. **And a source guard** (`ports/activity-log.test.ts`) reads every file
    under `apps/api/src` outside tests and test support and refuses any way of reaching
    either builder: a named or renamed import, a re-export, an `import()`, a namespace import
    used for anything but `Namespace.otherName` (so a computed member, or the namespace
    handed on or taken apart, is refused too), and a literal keyed `unrecorded`. The guard
    works on text with comments and string contents removed, not on a syntax tree: it is the
    second layer, and what it cannot follow it refuses. What neither layer stops is
    reflection on a value `Audit.none` already returned (`Object.getOwnPropertySymbols`),
    which needs the call the guard refuses. A new reason is a change to this ADR.
  - `environmentSettings.replace`, `passkeys.reportRegression` and the control plane's writes
    take a plain `Activity`: they have no unrecorded form at all.
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
  row-level security as the rest of the tenant data. The schema owner is not restricted:
  deleting an environment, project or workspace as the owner deletes its audit log with it, so
  export first.
- **Reading.** `GET /v1/admin/audit-logs` (secret key) lists an environment's entries newest
  first, with the usual `page`/`size` paging and exact-match filters `action`, `actorId` and
  `targetId`; the target and actor filters each have an index. In the response `action`,
  `actor.type` and `target.type` are strings, not enums, so a client keeps working when a later
  server records new kinds of action or actor.
- **What is deliberately not recorded.** Writes that change no one's access: upgrading a weak
  password hash after a successful sign-in (the password did not change); creating an
  environment's first signing keys (the server does it by itself); the bookkeeping timestamps
  `last_sign_in_at` (the sign-in itself is `session.created`) and an API key's `last_used_at`,
  a session's `last_active_at` and a passkey's use (its counter and time; the sign-in is
  `session.created`); the replay marker of a TOTP time step; an authenticator enrolment that
  is only started (it counts as nothing until confirmed, which is recorded); transient rows
  (flow attempts, verification tokens, WebAuthn challenges); and the retention job's deletes
  of rows that had already ended ([ADR 0017](0017-retention.md)). None of these store methods
  takes an activity. Workspaces, projects and
  environments are created by the seed script, outside the API. Rotating keys *is* recorded.
- **Large batches are split.** Ending every session of one user can produce thousands of
  entries; they are inserted 500 per statement, inside the same transaction.

## Consequences

- An operation made of several writes is recorded per write. Banning a user is one transaction
  for the ban and one for ending their sessions; a crash between them leaves the ban recorded
  and the sessions still open, which the ban check on refresh then closes (and records).
- Nothing reads the outbox yet. Events accumulate undelivered until the webhook worker (Phase 2)
  ships. The retention job ([ADR 0017](0017-retention.md)) deletes neither table's rows: no
  event is safe to drop before something has delivered it, so the outbox purge lands with that
  worker, and audit retention becomes a per-environment setting (default: keep). Both tables
  therefore still grow without bound.
- Not recorded: token refreshes (about one a minute per session), failed sign-ins, lockouts and
  rate-limit refusals. They have no write to share a transaction with, and they are
  attacker-driven, so recording them needs its own volume limits first.
- Event payloads (`{ actor, target, data }`) are not yet a typed contract per event type. They
  will be fixed when webhooks ship; until then treat `data` as informative.
- Audit entries keep IP addresses after a user is deleted, and outlive the sessions they name
  (which are deleted 30 days after they end). The audit retention setting has to cover that.
- Every write that records activity costs two more inserts in its transaction.
- The list uses offset paging, like the user list: entries written while a client pages shift
  later pages by that many rows, and deep pages are slow. Filtering by `action` alone scans the
  environment's log. Cursor paging can be added without changing the response shape.
- A repeated ban or key revocation answers with the row as read just after the guarded update;
  a concurrent opposite change can make that answer momentarily stale. Nothing is recorded in
  that case, so the log stays correct.
