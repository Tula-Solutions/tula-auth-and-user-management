---
paths:
  - "packages/db/**"
---

# Database rules (packages/db)

- One table per file in `src/schema/<kebab-plural>.ts`, re-exported from `src/schema/index.ts`.
- Use the mixins: `primaryKey()` (uuid v7), `timestamps()`, and `tenantColumns()` on every table
  that holds per-environment data. Index foreign keys and every column used in lookups.
- Every tenant table must be added to the RLS migration (ENABLE + FORCE ROW LEVEL SECURITY with
  the `environment_id = current_setting('tula.environment_id')::uuid` policy). The RLS integration
  test must cover it.
- Secrets are never stored in plaintext: hashes for tokens/codes/keys, AES-256-GCM (via
  `TULA_MASTER_KEY`) for things that must be decrypted (signing keys, TOTP seeds).
- Workflow: edit schema → `bun run db:generate` → read the SQL → commit the migration.
  Never `drizzle-kit push`. Never edit a migration that is already on `develop`.
- Column names are snake_case in SQL, camelCase in TypeScript.
