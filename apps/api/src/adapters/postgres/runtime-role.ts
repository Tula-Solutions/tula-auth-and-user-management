import type { Database } from '@tula-tech/db'
import { sql } from 'drizzle-orm'

/**
 * What a refused runtime role says. Fixed: it names no role, host or credential (H-227).
 */
export const RUNTIME_ROLE_REFUSAL =
  'the API connects to the database as a role that bypasses row-level security (a superuser, a role with BYPASSRLS, or the owner of the tables); connect as the tula_api runtime role'

/** What `pg_roles` and `pg_tables` say about the login the pool uses. */
export interface RuntimeRoleFacts {
  superuser: boolean
  bypassRls: boolean
  ownedTables: number
}

/**
 * Decide whether the login may serve requests.
 *
 * Row-level security does not apply to a superuser, a BYPASSRLS role or a table's owner, so
 * such a login would silently turn tenancy off (ADR 0001).
 *
 * @param facts - The login's facts; `undefined` when the query returned nothing.
 * @returns `null` when it is fine, else the fixed refusal. Fails closed on no answer.
 */
export function judgeRuntimeRole(facts: RuntimeRoleFacts | undefined): string | null {
  if (!facts || facts.superuser || facts.bypassRls || facts.ownedTables > 0) {
    return RUNTIME_ROLE_REFUSAL
  }
  return null
}

/**
 * Check the pool's login on the real database. Postgres only: memory adapters have no role.
 *
 * @param db - The runtime database.
 * @throws Error with `RUNTIME_ROLE_REFUSAL` when the role would bypass row-level security.
 */
export async function assertRuntimeRole(db: Database): Promise<void> {
  const result = (await db.execute(sql`
    select r.rolsuper as "superuser", r.rolbypassrls as "bypassRls",
           (select count(*) from pg_tables where schemaname = 'tula' and tableowner = current_user)::int as "ownedTables"
    from pg_roles r where r.rolname = current_user
  `)) as { rows: RuntimeRoleFacts[] }
  const refusal = judgeRuntimeRole(result.rows[0])
  if (refusal) {
    throw new Error(refusal)
  }
}
