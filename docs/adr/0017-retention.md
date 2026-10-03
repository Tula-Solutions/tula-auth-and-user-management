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

**Audit entries are never deleted by this job.** Their retention is a per-environment setting
since step 1.2 (`audit.retentionDays`, default: keep; [ADR 0018](0018-environment-settings.md)),
which is stored and validated but not acted on yet: this job still deletes no audit entry.

**Outbox events are not deleted yet.** The plan was to delete *delivered* events older than 30
days. The `events` table has a `delivered_at` column, but nothing sets it: delivery is the
webhook worker of Phase 2, so today every event is undelivered and none is safe to drop.
Shipping the delete now would mean dead code and a `DELETE` grant on the outbox for the runtime
role (migration 0003 deliberately gives it none) with nothing to use it. The delete, its grant
and a policy limiting it to delivered rows land with the worker that marks rows delivered.

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
tables involved, always under row-level security, so no grant changed. (An earlier rule said
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
- `events` and `audit_logs` still grow without bound until Phase 2 and step 1.2 respectively.
