---
paths:
  - "packages/db/**"
---

# Database rules (packages/db)

- One table per file in `src/schema/<kebab-plural>.ts`, re-exported from `src/schema/index.ts`.
  Every table uses the `tula` pg schema (`tula.table(...)`).
- Mixins: `primaryKey()` (uuid v7) and `timestamps()` everywhere. Tenant tables spread
  `tenantColumns()` and return `...tenantConstraints('<table>', t)` from the third argument —
  that adds the composite `(environment_id, project_id)` FK, the index and the RLS policy.
- **New tenant table → add `ALTER TABLE tula.<table> FORCE ROW LEVEL SECURITY;` in a custom
  migration** (`bunx drizzle-kit generate --custom --name <name>`). `src/rls.test.ts` fails for
  any table with `environment_id` that isn't enabled + forced (except the documented `api_keys`,
  which has no RLS but does declare the composite FK itself).
- Tenant data is only read/written inside `withTenant(db, environmentId, fn)`. Outside it,
  policies match nothing — a missing `withTenant` shows up as "no rows", not a leak.
- Runtime connects as `tula_api` (in role `tula_app`); migrations run as the owner. Migration
  history lives in `drizzle.__drizzle_migrations`, unreachable by the runtime role.
- The runtime grant matrix (migration 0003) is least-privilege: control plane has no DELETE
  (except `instance_audit_logs`, which the retention job purges after
  `INSTANCE_AUDIT_RETENTION_DAYS`: migration 0016, DELETE but never UPDATE),
  `audit_logs` has SELECT, INSERT and DELETE but never UPDATE (migration 0017: the retention
  job deletes an environment's entries past its `audit.retentionDays`, and the restrictive
  policy `audit_logs_retention_floor` refuses any entry younger than a day). The webhook
  tables (migrations 0018 and 0019): `events` has SELECT, INSERT, **UPDATE of `delivered_at`
  only** (never grant UPDATE on the table again: a payload must not be rewritable) and DELETE
  inside `events_retention_floor` (settled and more than a day old); `webhook_deliveries` has
  SELECT, INSERT, UPDATE of its eight state columns only (not the endpoint, the event, the
  type, the test flag or `created_at`) and DELETE inside `webhook_deliveries_retention_floor`
  (not `pending` and more than seven days old); `webhook_delivery_attempts` is append-only,
  SELECT and INSERT, and goes only by cascade from its delivery. `webhook_endpoints`
  (migration 0020) holds two sealed secrets at most: `secret`, and `previous_secret` with
  `previous_secret_expires_at`, set and cleared together (the check
  `webhook_endpoints_previous_secret_whole`); the role's table-level UPDATE from 0018 covers
  them, and no grant changed. Neither of the last two has
  a column for anything of a receiver's answer beyond a status code. `hooks` (migration 0021):
  SELECT, INSERT and DELETE, and UPDATE of seven columns only (the address, `enabled`,
  `deadline_ms`, `failure_mode`, `updated_at` and the two last-failure columns: never
  `secret`, `point`, the id, the tenant columns or `created_at`; a rotation would extend the
  grant deliberately); one row per `(environment_id, point)`; `deadline_ms`
  held to 100..5000 by the check `hooks_deadline_bounds` (never widen it: the API's schema
  is not the only writer a table has); `last_failed_at` and `last_failure_reason` set
  together; and no column for anything an endpoint answered, with one exception that is
  not on that table: `sessions.hook_claims` (migration 0022), the claims a `before_token`
  hook answered with, nullable jsonb held by the check `sessions_hook_claims_bounds` to an
  object of at most 4,096 bytes of its text (the claims' own rules are the service's, on
  write and again on read). `hooks.point` is text with no check: a new point needs no
  migration. Three tables have a
  second policy (`audit_logs`, `events`, `webhook_deliveries`), and a second policy is always
  restrictive and `FOR DELETE`. `webhook_deliveries.event_id` is deliberately **not** a
  foreign key (the log outlives the event). Admin deletes run under the owner
  (`DATABASE_MIGRATION_URL`), never the request path. The retention job (ADR 0017) deletes
  expired tenant rows as the runtime role, per environment inside `withTenant`, through batched
  store methods. A migration that has to change rows of a tenant table lifts `FORCE ROW LEVEL
  SECURITY` for the backfill and restores it in the same file (0019): the owner is bound by
  the policy too, and a migration sets no environment. New tables get **no**
  default grants: add them to the matrix in the same migration (a test fails otherwise). Run all
  migrations as the same owner role (default privileges are per-owner).
- Refresh tokens are pruned by deleting sessions (cascade), never token-by-token.
- Secrets are never stored in plaintext: SHA-256 for high-entropy tokens/keys, HMAC-SHA256 for
  low-entropy codes, AES-256-GCM (via `TULA_MASTER_KEY`) only for things that must be decrypted
  (signing keys, TOTP seeds). Prefer deriving over storing recoverable secrets.
- Child → parent references between tenant tables use `tenantForeignKey()` (composite on
  `environment_id`) and the parent declares `tenantParentKey()`: FK checks bypass RLS.
- Workflow: edit schema → `bun run db:generate` → **read the SQL** → commit the migration.
  `bun run db:check` (in `verify`) fails on schema drift. Never `drizzle-kit push`; never edit a
  migration that is already on `develop`.
- Tests: PGlite via `createTestDatabase()` / `createTestTenant()` from `@tula/db/testing`
  (runs as `tula_app`, RLS enforced). Real-Postgres checks go in `*.integration.ts`.
- Drizzle builders are thenables, not Promises: wrap them before `expect(...).rejects`.
