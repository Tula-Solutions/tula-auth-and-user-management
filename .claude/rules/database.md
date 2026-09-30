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
  any table with `environment_id` that isn't enabled + forced (except the documented `api_keys`).
- Tenant data is only read/written inside `withTenant(db, environmentId, fn)`. Outside it,
  policies match nothing — a missing `withTenant` shows up as "no rows", not a leak.
- Runtime connects as `tula_api` (in role `tula_app`); migrations run as the owner. Migration
  history lives in `drizzle.__drizzle_migrations`, unreachable by the runtime role.
- The runtime grant matrix (migration 0003) is least-privilege: control plane has no DELETE,
  `audit_logs` is append-only, `events` has no DELETE. Retention purges and admin deletes run
  under the owner (`DATABASE_MIGRATION_URL`), never the request path. New tables get **no**
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
