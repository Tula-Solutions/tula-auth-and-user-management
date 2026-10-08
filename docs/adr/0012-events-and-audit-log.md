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
  delivery queue that can be trimmed once delivered; audit entries are kept for as long as
  the environment says (for ever, unless it sets a period).
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
  `signing_key.rotated` at first; later steps added two-step verification, identities,
  passkeys, step-up, settings and OAuth providers. The list is `ACTIVITY_TYPES`, in
  `@tula/contract/event-types`: an entry point that imports no Zod, so a receiver can switch
  on a type without a schema library.
- **An event's payload is a typed, versioned contract** (added in Phase 2, step 2.1, before
  anything delivers one). `events.payload` holds the event exactly as a webhook will deliver
  it:

  ```json
  {
    "id": "0199c2f5-0000-7000-8000-000000000018",
    "type": "session.revoked",
    "schemaVersion": 1,
    "occurredAt": "2026-10-08T09:30:00.000Z",
    "actor": { "type": "user", "id": "0199c2f4-7a10-7c3e-9b1a-5d2e8f4a6c01" },
    "target": { "type": "session", "id": "0199c2f4-7a11-7d42-8e0b-1c9a3b7d5e02" },
    "data": { "userId": "0199c2f4-7a10-7c3e-9b1a-5d2e8f4a6c01", "reason": "sign_out" }
  }
  ```

  - `id` is the activity's id, shared with its audit entry: a receiver drops a repeated
    delivery by it. The payload carries its own `id`, `type` and `occurredAt` (they are also
    columns of `events`) so that a delivery is this one value and nothing assembled later.
  - Every type has a `data` schema (`EVENT_DATA_SCHEMAS`), an envelope schema around it
    (`EVENT_SCHEMAS`; `TulaEventSchema` is their union by `type`), a target type
    (`EVENT_TARGET_TYPES`: what `target.id` is the id of) and an example (`EVENT_FIXTURES`),
    all in `@tula/contract`. The records are typed so that a type without one does not
    compile, and the contract's tests check the same at run time. The schemas are published
    as components of the OpenAPI document (`TulaEvent`, `<Name>Event`, `<Name>EventData`); no
    route returns one, so `createApp` adds them where the document is assembled. The union
    is `TulaEvent`, not `Event`: that name is the DOM's in every browser and worker, and a
    published type cannot be renamed once receivers import it. A component the events and
    the routes share by name (`OAuthProvider`, `SessionClient`) is held identical by a test.
  - `schemaVersion` is `EVENT_SCHEMA_VERSION` (1). **Within a version a payload only grows**:
    a later server may add a type, an optional field or a value to a closed set, and a
    receiver ignores what it does not know. Removing or renaming a field, making one
    required, or changing what one means is a new version.
  - **A payload is an allow-list.** A field is in a payload because the contract names it,
    never because a call site passed it. A `data` schema holds ids the server made (UUIDs),
    values from closed sets (enums: `method`, `reason`, `provider`, `client`, `kind`),
    booleans and a revision number. Never an email address, a name, an IP address, a user
    agent, a token, a code, a hash or key material.
  - **Two strings are not ids, and their patterns do not make them secret-proof.**
    `environment.settings_updated` carries `changed`, the dotted **names** of the settings
    that changed (never a value), and `managedBy`, the name of the tool that applies a
    config file. Both are bounded (a name of at most 128 characters of letters, digits, `_`,
    `-` and dots, at most 256 of them; `CONFIG_TOOL_PATTERN`), and a token-shaped string
    fits either. What keeps a secret out is that each has exactly one producer: `changed` is
    built by `Settings.changedKeys` from the keys of the settings document, and `managedBy`
    is the `x-tula-managed-by` header, validated when the request is read (the one value in
    any payload that a client supplied). A new string field needs the same argument.
  - **The names in `changed` are an open set.** They follow the settings document: a later
    server lists settings this version does not have, and a name holds what an operator
    chose where the document is keyed by it (a session profile:
    `sessions.profiles.back-office.idleTimeout`). A receiver treats each name as opaque
    text. A test in the settings service builds the largest document there can be (ten
    profiles with 32-character names) and holds every one of its keys, and their number,
    inside the bounds: a list that did not fit would be dropped from the payload whole.
  - **`user.passkey_removed` is one type with two shapes**, told apart by `method`: `user`
    (the owner removed one passkey) carries `passkeyId` and never `canStillSignIn`;
    `admin_reset` (every passkey of the user was removed) carries `canStillSignIn` and never
    `passkeyId`. The schema refuses any other combination; it is deliberately not two types.
    The OpenAPI component cannot say the rule (both fields are optional there, and its
    description states it): a receiver generated from the document does not enforce it.
  - **One function builds it**, `eventPayload` (`~/lib/event-payload`), called by the memory
    and the Postgres stores alike. It keeps a key of the activity's `data` only if the type's
    schema names it **and** that field's own schema accepts the value, so a named field
    cannot carry a string where an enum or an id belongs. What it refuses it drops and logs
    by key (never by value), together with the keys the schema requires and the payload
    lacks; it never throws, because a record that cannot be written undoes the change it
    records. An `occurredAt` that is not a time (an invalid `Date`, whose `toISOString`
    throws) is replaced by the time the payload is built, and logged. That only keeps the
    builder from being what fails: the stores write the same `occurredAt` to the event's and
    the audit entry's own columns, so such a write is not rescued by it.
  - **Call sites are checked at compile time.** `Audit.entry` takes a union discriminated by
    `type`: each type's `target.type` and `data` are the contract's, so recording a detail
    the contract has no field for does not compile. `Activity.data` itself stays loose (a
    store adds to it, and the log may hold another version's entries).
  - **The audit entry is not narrowed.** `audit_logs.metadata` keeps the activity's `data` as
    given, and `GET /v1/admin/audit-logs` answers as before. The allow-list is about what
    leaves the deployment.
  - **A canary test** (`apps/api/src/event-canary.test.ts`) runs every conformance scenario
    against the API in process with a recognisable address and password in every variable
    and the wire tapped: whatever a request carried, whatever a response handed out as a
    secret and whatever was emailed is then searched for in every recorded payload (and in
    every audit entry's details). Every request header is tapped, whatever its name, so a
    header the API starts to read is covered without anyone listing it. A client-supplied
    value that may be in a payload is an explicit entry of the test's `MAY_APPEAR`, with
    the one field it may be in, and is a leak anywhere else: the managing tool's name
    (`managedBy`), and a session profile's name, which a client sends in
    `x-tula-session-profile` and which is in `changed` because an admin named a profile so
    (tapping every header is what showed it). `conformance.test.ts` also holds every recorded payload to
    its schema and to "nothing was dropped", so a call site and the contract cannot drift.
  - A new activity type is three things: its name (and target type) in `event-types.ts`, a
    `data` schema in `EVENT_DATA_SCHEMAS` and an example in `EVENT_FIXTURES`.
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
- **Never rewritten, and deleted only past the environment's retention period** (changed on
  2026-10-08, approved by the repository's owner; until then: "append-only for the server",
  with `SELECT` and `INSERT` only). The audit log is no longer append-only for the runtime
  database role: it has `SELECT`, `INSERT` and, since migration `0017`, `DELETE` on
  `audit_logs`, so that the retention job can delete an environment's entries older than its
  `audit.retentionDays` ([ADR 0017](0017-retention.md#audit-entries-added-2026-10-08)). An
  environment that sets no period (the default) keeps every entry. What bounds the new
  privilege is in the database: the table's fail-closed tenant policy confines a delete to
  the environment in scope; a second, restrictive policy (`audit_logs_retention_floor`)
  refuses any entry younger than one day, the shortest period that can be set; and the role
  still has no `UPDATE` (an entry cannot be changed, or backdated to get under that floor)
  and no `TRUNCATE`. `ActivityLog.deleteAuditBefore` is the only code that deletes, and the
  retention job its only caller (a test holds that). `events` is unchanged: no `DELETE`, under
  the same row-level security. The schema owner is not restricted: deleting an environment,
  project or workspace as the owner deletes its audit log with it, so export first.
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
  takes an activity. The retention job's delete of **audit entries** past an environment's
  period is not recorded either (`deleteAuditBefore` takes no activity): an entry cannot
  record its own end, and one per run would grow the log the period bounds. What is recorded
  is the decision, the change of `audit.retentionDays` (`environment.settings_updated`);
  each purge that deleted something is a line in the server's log with the environment, the
  period and the count. A summarising activity type for it is an open question. Workspaces, projects and
  environments are created by the seed script, outside the API. Rotating keys *is* recorded.
- **Large batches are split.** Ending every session of one user can produce thousands of
  entries; they are inserted 500 per statement, inside the same transaction.

## Consequences

- An operation made of several writes is recorded per write. Banning a user is one transaction
  for the ban and one for ending their sessions; a crash between them leaves the ban recorded
  and the sessions still open, which the ban check on refresh then closes (and records).
- Nothing reads the outbox yet. Events accumulate undelivered until the webhook worker (Phase 2)
  ships. The retention job ([ADR 0017](0017-retention.md)) deletes no event: none is safe to
  drop before something has delivered it, so the outbox purge lands with that worker, and the
  outbox still grows without bound. Audit entries are deleted where an environment has set
  `audit.retentionDays`, and kept for ever where it has not (the default). An event therefore
  outlives the audit entry it shares an id with.
- Not recorded: token refreshes (about one a minute per session), failed sign-ins, lockouts and
  rate-limit refusals. They have no write to share a transaction with, and they are
  attacker-driven, so recording them needs its own volume limits first.
- Event payloads were `{ actor, target, data }` with an untyped `data` until Phase 2, step
  2.1; they are now the typed, versioned event described above. **The stored shape changed
  with no migration**: nothing had read the outbox and nothing was deployed, so a database
  that holds rows of the earlier shape (a development one) holds rows no delivery worker
  should send. They are told apart by `schemaVersion`, which the earlier shape lacks; what the
  worker does with such a row is decided with the worker (2.2).
- The payload schemas are a public contract from the first delivery: a mistake in one (a
  field that should not have been there, a name that reads badly) costs a new
  `schemaVersion`. Each `data` field is therefore what its call sites record today and no
  more; three of them are judgement calls, listed in the step's review: the names of changed
  settings (`environment.settings_updated.changed`, which include an operator's own session
  profile names), the managing tool's name (`managedBy`, operator-supplied, bound by
  `CONFIG_TOOL_PATTERN`), and `canStillSignIn` on `user.passkey_removed`.
- A payload that is not the event its schema describes is stored anyway, never refused: one
  whose call site left out a required field, or gave fields that do not go together (the
  pairing of `user.passkey_removed`). The builder checks the finished `data` against the
  whole schema and logs, by name, what is missing and what breaks such a rule; the compiler
  and the conformance run (which parses every recorded payload with its whole schema) are
  what keep it from happening.
- Audit entries keep IP addresses after a user is deleted, and outlive the sessions they name
  (which are deleted 30 days after they end). The audit retention setting is what covers
  that: with a period set, an entry and the address in it are gone once it is older.
- With a period set, the log no longer answers "what happened" beyond it, and the entry that
  records who set or shortened the period (`environment.settings_updated`, `weakened: true`)
  is deleted by that period like any other. After that the server's log line of each purge
  is the only durable trace, and it names no actor: keep the API's logs, outside the reach of
  the API's credentials. A deployment that needs longer than it keeps exports the entries
  first.
- Every write that records activity costs two more inserts in its transaction.
- The list uses offset paging, like the user list: entries written while a client pages shift
  later pages by that many rows, and deep pages are slow. Filtering by `action` alone scans the
  environment's log. Cursor paging can be added without changing the response shape.
- A repeated ban or key revocation answers with the row as read just after the guarded update;
  a concurrent opposite change can make that answer momentarily stale. Nothing is recorded in
  that case, so the log stays correct.
