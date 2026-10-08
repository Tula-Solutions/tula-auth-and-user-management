# ADR 0017 — Retention

- Status: accepted
- Date: 2026-10-03

## Context

Four kinds of rows had no end of life. Expired sign-in and sign-up attempts were purged by a
timer in `server.ts` (ADR 0009); verification tokens, sessions with their refresh tokens, and
outbox events were never deleted. On a busy deployment the session tables alone grow by a row
per sign-in and a row per token refresh, about one a minute per active session.

With more than one API instance (ADR 0016) the existing timer also ran on every instance at
once.

## Decision

**One job, `modules/retention`, deletes what no longer has a use.** In every environment:

| Rows | Deleted when | Why then |
| --- | --- | --- |
| Flow attempts (and, by cascade, their verification tokens) | past `expires_at` | An abandoned sign-up holds the hash of a password that was never used. Unchanged from ADR 0009. |
| Verification tokens | one hour past `expires_at` (`EXPIRED_VERIFICATION_TOKEN_RETENTION`) | A token is useless once expired. The hour means a request in flight at the moment of expiry still finds its token and answers `verification.expired` as usual. |
| Sessions, with their refresh tokens | 30 days after they ended (`ENDED_SESSION_RETENTION`) | Long enough to investigate a report that names a session; far past anything a client can still do with it. |

*Consumed* verification tokens need no rule of their own: every token expires (ten minutes
after it is issued), used or not, so the expiry rule removes them too. Deleting by expiry alone
also keeps "only the newest token for a subject is honoured" (ADR 0007) true without argument:
a token is never deleted while an older one for the same subject could still be live.

A session has *ended* when it was revoked, or passed its idle or absolute expiry, whichever
came first (`endedBy` in `ports/session-store.ts`, shared by both adapters). A session that can
still be refreshed has not ended and is never deleted. The reuse check (ADR 0008) needs a
rotated refresh token for the ten seconds of the grace period and, after that, only to tell
"reused" from "unknown"; thirty days after the session ended both answers are a refusal, and
presenting a purged token is answered like any unknown token. Refresh tokens are never deleted
one by one: their rows reference each other, so a chain only goes with its session, by the
foreign-key cascade.

**An environment's audit entries are deleted once they are older than the period the
environment set, and never otherwise** (`audit.retentionDays`,
[ADR 0018](0018-environment-settings.md); changed on 2026-10-08, see
[Audit entries](#audit-entries-added-2026-10-08) below). The default is `null`: keep them for
ever. Until that change the setting was stored and validated and this job deleted no audit
entry.

**Outbox events are not deleted yet.** The plan was to delete *delivered* events older than 30
days. The `events` table has a `delivered_at` column, but nothing sets it: delivery is the
webhook worker of Phase 2, so today every event is undelivered and none is safe to drop.
Shipping the delete now would mean dead code and a `DELETE` grant on the outbox for the runtime
role (migration 0003 deliberately gives it none) with nothing to use it. The delete, its grant
and a policy limiting it to delivered rows land with the worker that marks rows delivered.
*Since 2026-10-08 a worker marks them ([ADR 0034](0034-webhooks.md)), and since the step after
that this job deletes them: see
[Outbox events and webhook deliveries](#outbox-events-and-webhook-deliveries-added-2026-10-08)
below, which replaces this paragraph.*

**Deletes go through the stores, per environment, in batches.** Each store has one purge method
(`deleteExpired`, `deleteEnded`) taking an environment, a cutoff and a limit. The Postgres
adapters run it inside `withTenant`, so row-level security scopes it exactly like a request:
environment A's purge cannot touch environment B's rows, and the shared adapter suites prove
that for memory and Postgres alike. A call deletes at most 500 rows (`RETENTION_BATCH_SIZE`) in
its own short transaction, and the service repeats it until a batch comes back short, up to 200
batches per table, per environment, per run (`RETENTION_MAX_BATCHES`). A backlog larger than
100,000 rows is finished by the following runs rather than by one run that never ends, and no
run holds row locks for longer than one batch.

**It runs as the API's own database role.** The runtime role already had `DELETE` on the four
tables involved, always under row-level security, so no grant changed (the two audit logs
came later, each with a grant of its own: see below). (An earlier rule said
purges would run as the schema owner; the API has no owner connection, and running tenant
deletes under row-level security is the stronger arrangement.)

**It runs on boot and every ten minutes, on one instance at a time.** Every instance starts the
timer; `Retention.run` asks the `JobLock` port for the job, and the others are told at once that
it is taken and skip the round, silently. Behind the port is a Postgres session-level advisory
lock (`pg_try_advisory_lock` on a fixed key, in a namespace of Tula's own), held on a
connection checked out for the purpose and released when the run settles:

- *Postgres, not Redis,* because the job is database work. An instance that cannot reach the
  database cannot hold the lock, and Redis stays optional in `local` and `dev`.
- *Session-level, not transaction-level,* so the run is not wrapped in one long transaction;
  it does its work in short ones on other connections.
- *A crashed holder cannot block anyone:* Postgres releases the lock when its connection drops.
  A connection whose unlock did not succeed is destroyed rather than returned to the pool.
- *The key never changes* (`JOB_LOCK_IDS`), so instances of two versions agree on it during a
  rolling upgrade.

Skipping, rather than waiting, also means a run that is still going when its next round comes
is not started twice.

**A failure in one environment is logged and skipped**, so it cannot keep the environments
after it from being purged; that environment is retried on the next run. A run logs one line
with counts only (environments visited and failed, rows deleted per table): `info` when
something was deleted, `warn` when an environment failed, `debug` otherwise so an idle server's
log stays quiet.

### The instance audit log (added with ADR 0032)

The control plane's own log (`tula.instance_audit_logs`: dashboard sign-ins, workspaces,
projects) is the one audit log with an end. Anyone who can reach the API can add a failed
sign-in to it (sampled to one entry a minute per address, ADR 0032), so it is kept for a
period the deployment sets, `INSTANCE_AUDIT_RETENTION_DAYS` (default 365, at least 30), and
older entries are deleted by this job through `ControlPlane.deleteAuditBefore(cutoff, limit)`
in batches, oldest first. It runs once per pass, outside the per-environment loop; a failure
is logged, counted in `failed`, and does not stop the environments' purge. The runtime role
gained `DELETE` on that table for it (migration `0016`), and still has no `UPDATE`.

When this was added an environment's audit log (`audit_logs`) was left as it was: never
deleted by this job, the runtime role unable to delete from it. That changed with the next
section.

### Audit entries (added 2026-10-08)

Approved by the repository's owner on 2026-10-08 (TULA-9). It replaces "an environment's audit
entries are never deleted by this job" above and "append-only for the server" in
[ADR 0012](0012-events-and-audit-log.md).

**What is deleted.** In each environment whose settings hold a number in `audit.retentionDays`
(1 to 3650), the rows of `audit_logs` that occurred more than that many days before the run.
An entry exactly as old as the period is kept, like the instance audit log's. Nothing else:
not the outbox event that shares the entry's id (an event has its own period, below), and no
entry of an environment whose period is `null`, which is the default and
what an environment that never saved settings has. The deletion is permanent; there is no
archive and no undo. An operator who needs the entries longer than the period exports them
first (`GET /v1/admin/audit-logs`).

**Why.** The setting has existed since step 1.2 and did nothing, which is worse than not
having it: an operator who set 90 days had every reason to believe 90 days was what was
kept. Audit entries hold IP addresses and user agents and outlive the users and sessions
they name, so a deployment under a data-retention rule needs an end it can state; and a
table that only grows is a cost that eventually decides for the operator. The default stays
"for ever" because deleting evidence must be something an operator asked for.

**How.** `ActivityLog.deleteAuditBefore(environmentId, before, limit)`, in the memory and
Postgres adapters and the shared suite, is the purge method of this table, the same shape as
the others: per environment, inside `withTenant`, 500 rows a call, oldest first on the
`(environment_id, occurred_at)` index, repeated up to the run's ceiling. It is the last step of
an environment's pass, inside the same failure boundary: a failure anywhere in the pass is
logged, counted and retried on the next run, and the other environments are still purged.

Three things are particular to it, because it is the one purge whose rows did not end by
themselves:

- *The period is read past the settings cache* (`Settings.get(deps, scope, true)`), one query
  per environment per run. Every other reader accepts settings that trail a change by up to
  30 seconds; here, a period lengthened a moment ago on another instance would be undercut
  by the stale one, and what that deletes cannot be put back.
- *Anything but a whole number of days, 1 or more, means "keep"* (`auditCutoff`). The admin
  API stores nothing else, but a document is `jsonb` that a hand or another version can
  change, and zero or a negative number would otherwise put the cutoff at or after "now".
  Settings that cannot be read at all fail the environment's pass and keep its entries.
- *It says what it did.* A run that deleted entries logs, per environment, the environment's
  id, the period applied and the count (`audit entries past the retention period deleted`,
  at `info`), beside the run's one line, which now has an `auditLogs` count.

**The grant, and what bounds it.** The runtime role had `SELECT` and `INSERT` on `audit_logs`
and nothing else (migration `0003`). Migration `0017` grants it `DELETE`. The table is no
longer append-only for that role; what it still cannot do, and what limits the delete, is
held by the database and not only by this job:

| Bound | Held by |
| --- | --- |
| Only the environment in scope; nothing at all outside a tenant scope | `audit_logs_tenant_isolation`, the `FOR ALL` policy every tenant table has, under forced row-level security. It covered `DELETE` already; no policy was widened. |
| No entry of the last day, whatever the statement asks | `audit_logs_retention_floor`, a **restrictive** policy `FOR DELETE` added by `0017`: `occurred_at < now() - interval '1 day'`. One day is the shortest period that can be set, so the job never asks for less; a bug in it, or anything else that runs as the runtime role, cannot erase what happened in the last 24 hours. |
| An entry cannot be changed, or moved back in time to get under that floor | No `UPDATE` grant, as before. |
| The table cannot be emptied in one statement | No `TRUNCATE` grant, as before. |

The floor is the database's clock (`now()`), the job's cutoff the API's; a skew between them
can only delay the delete of an entry that is about a day old, never hasten one. The memory
adapter has no such floor: it is a property of the database, tested on PGlite and on a real
server (`packages/db/src/boundaries.test.ts`, `adapters/postgres/activity.test.ts`, the shared
suite in `stores.integration.ts`). It is the only table with a second policy, and the test
that counted "exactly one policy per tenant table" now counts one *permissive* policy per
table and names this one as the only other.

**What the one-day floor bounds, and what it does not.** It bounds a bad *cutoff*: a
statement that asks for entries younger than a day gets none of them, whoever wrote it. It
does not bound a bad *period*. A period of one day is a valid setting, and with it everything
older than a day goes; the floor has no opinion on whether the environment's period was
meant. Someone who holds a secret key, a dashboard session or the runtime role can set an
environment's period to one day and wait for the next runs. Two clocks are involved, too: the
job's cutoff and the policy's `now()` are read when the purge runs (the API's clock and the
database's), while `occurred_at` was written earlier by whichever instance recorded the
entry, from its own clock. An entry stamped in the future by an instance whose clock ran
ahead is kept longer than the period; one stamped in the past is deleted sooner, and the
floor moves with the stamp, not with when the row was really written. The floor is a guard
against a wrong statement, not proof of an entry's age.

**A shorter period asks first.** Because a bad period is the case nothing in the database
stops, setting a period where there was none, or shortening one, is a weakening in the
contract's one definition (`settingsWeakenings` lists `audit.retentionDays`; lengthening it,
keeping it or removing it is not one). So the audit entry of such a change carries
`weakened: true`, `tula diff` warns and adds "deletes audit entries older than N days, for
good", `tula apply --yes` refuses the plan without `--allow-weaker`, and the dashboard's
editor asks before saving, in the words "This deletes older audit entries for good". There
is no opt-in switch beside the setting and no dry-run pass: nothing has been released, so
no deployment holds a number it set while the setting did nothing; the upgrade note in
`docs/self-host.md` and the changeset say to check all the same.

**The record of who shortened it does not last.** The change is recorded as
`environment.settings_updated` (the key `audit.retentionDays`, `weakened: true`, the actor),
but that entry is in the log the period governs: once it is older than the new period it is
deleted like any other. From then on the only trace that entries were deleted, and under
what period, is the server's log line of each purge (environment id, period, count), which
names no actor. Keep the API's logs for at least as long as the audit log would have been
kept, and ship them somewhere the API's own credentials cannot rewrite. A summarising audit
entry that the purge spares is the open question under "Not recorded as activity" below.

**Not recorded as activity.** The deletes write no audit entry and no event, like every
other delete of this job ([ADR 0012](0012-events-and-audit-log.md), "What is deliberately not
recorded"). An entry per deleted row is absurd; an entry per run would add 144 rows a day to
each environment's log for doing nothing new, in the log the period exists to bound, and
would itself be deleted a period later. The decision an operator made is the change of the
setting, and that is recorded. Whether a purge should also leave one summarising entry
("N entries older than D were deleted") is left open on purpose: it needs a new activity
type, and how types are defined is being changed elsewhere.

**Nothing reads old entries.** The only reader of `audit_logs` is the admin list
(`Audit.list`, and the MCP and dashboard views over it). "A new device"
([ADR 0023](0023-security-notices.md)) is decided from the session table, lockouts and rate
limits from their own stores, the passkey counter from the passkey row. No behaviour changes
when old entries go; what changes is what an operator can look up.

### Outbox events and webhook deliveries (added 2026-10-08)

With retries and the delivery log (TULA-42, [ADR 0034](0034-webhooks.md)). It replaces
"outbox events are not deleted yet" above.

**What is deleted**, per environment, in batches, through two methods of the delivery store
that take an environment, a cutoff and a limit like every other purge here:

| | Period | Constant | Store method |
| --- | --- | --- | --- |
| Deliveries that have ended (`delivered` or `failed`), with every request recorded for them | 90 days after they were queued | `ENDED_DELIVERY_RETENTION` | `deleteEndedBefore` |
| Outbox events the worker has settled | 30 days after they were settled | `SETTLED_EVENT_RETENTION` | `deleteSettledEvents` |

Both periods are constants, like the session's and the token's.

**Why thirty days for an event.** An event's row is its payload, and the payload has one use
left once the worker has queued its deliveries: being sent again. The worker itself is done
with a delivery after a day and a few hours, and gives up whatever is left after three days;
"send it again" is for an operator who learns later that their receiver dropped something. A
month covers a billing cycle's worth of "we only noticed at month end", and it is the period
this record planned from the start. It is also far longer than any receiver needs to remember
ids for: a repeat can only come while the event exists, so thirty-one days of remembered ids
is always enough.

**Why ninety days for a delivery, and why longer than its event.** The record of a delivery is
small and holds nothing sensitive: ids, a type, times, status codes, durations and the
server's own fixed words; no payload, no address, and nothing of a receiver's answer. Its use
is an operator asking "what happened to our webhooks last quarter", which outlives the
payload's use. So the log is kept three times as long as the thing it is a log of.

**How the two are kept apart.** Until this step a delivery row referenced its event with a
foreign key that cascaded, so deleting an event at thirty days would have deleted the record
of its deliveries with it. That reference is no longer a foreign key (migration `0019`): the
delivery keeps the event's id and type as plain columns, and outlives the event. For the
sixty days in between, the delivery reads exactly as before and "send it again" answers
`webhook.cannot_redeliver` with the reason `event_gone`.

**An event is never deleted from under a delivery that is still to be sent.**
`deleteSettledEvents` leaves any event that a `pending` delivery is of, whatever its age. In
practice nothing is pending that long (the worker gives a delivery up at three days), so this
is a guard, not a path; and should an event's row be gone all the same, the worker gives the
delivery up with the word `event_gone` instead of failing the round.

**The order inside a run** is deliveries, then events. Neither depends on the other.

**What bounds the two new deletes in the database**, as migration `0017` bounded the audit
log's (migration `0019`):

- The tenant policy of each table covers `DELETE`: only rows of the environment in scope, and
  none when no environment is set.
- A restrictive policy on each, ANDed with it. `events_retention_floor`: only an event that
  is settled (`delivered_at` is set) **and** that happened more than a day ago.
  `webhook_deliveries_retention_floor`: only a delivery that is not `pending` **and** was
  queued more than seven days ago. Whatever a statement asks for, the API's role cannot
  delete an event no worker has settled, a delivery the worker still has, or anything recent.
- The floors cannot be got past by changing a row first. The runtime role may update exactly
  one column of `events` (`delivered_at`; the grant on the whole table that it held since
  `0003` is revoked), so it cannot backdate `occurred_at`; and of a delivery only its state
  columns, not `created_at`. It *can* set `delivered_at` or `state`, which is the worker's
  job; that is why each floor also has a time on a column it cannot touch.
- `webhook_delivery_attempts` gets no `DELETE` at all: its rows go with their delivery, by a
  cascade, which runs as the table's owner.

These floors are deliberately far below the periods (a day against thirty, a week against
ninety): they are what stops a bug or a wrong cutoff from emptying a table, not a second
definition of the period.

**Not recorded**, like every other delete of rows that had already ended
([ADR 0012](0012-events-and-audit-log.md)): the run's log line has the counts (`events`,
`webhookDeliveries`).

**An event and the audit entry of the same id still have separate lives.** Deleting one does
not delete the other, in either direction.

## Consequences

- The lock is a session-level advisory lock, so `DATABASE_URL` must be a direct connection or a
  session-mode pooler. Behind a transaction-mode pooler (PgBouncer in `transaction` mode) the
  lock and its release can land on different server connections, and retention would stop
  without an error.
- A session's row is gone 30 days after it ended, but the audit entries about it
  (`session.created`, `session.revoked`) stay and still name its id.
- The retention periods are constants, the same for every environment. Per-environment
  settings arrive in 1.2; these are candidates.
- The lock occupies one of the instance's ten pooled connections for the length of a run.
- PGlite, which the unit tests use, has a single session, and a session may retake its own
  advisory lock, so it cannot show two runners excluding each other. That is proved against a
  real server with two pools (`packages/db/src/advisory-lock.integration.ts` and
  `apps/api/src/adapters/postgres/job-lock.integration.ts`, both part of
  `bun run test:integration`); the unit tests prove the same behaviour suite on the memory
  adapter and prove the SQL is valid.
- The purge finds its rows through each table's `environment_id` index and filters the rest.
  If a table grows large enough for that to matter, an index on the cutoff column is the fix.
- `events` and `webhook_deliveries` no longer grow without bound (since 2026-10-08: thirty
  and ninety days, below). `audit_logs` grows without bound in every environment that has not
  set `audit.retentionDays`, which is the default.
- A session's audit entries can now be gone before or after its row, depending on the
  environment's period; neither waits for the other.
- An idle pass costs one more query per environment (the fresh settings read), and one more
  where a period is set.
