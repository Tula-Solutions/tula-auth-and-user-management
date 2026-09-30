import { sql } from 'drizzle-orm'
import type { Database, Transaction } from './client'
import { TENANT_SETTING } from './tenant-columns'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Run `fn` in a transaction scoped to one environment.
 *
 * Sets the transaction-local `tula.environment_id` that every row-level-security policy reads, so
 * queries inside `fn` can only see and write that environment's rows. The setting disappears when
 * the transaction ends, so it can't leak to the next request on a pooled connection.
 *
 * @param db - The database.
 * @param environmentId - The environment (tenant) id.
 * @param fn - Work to run inside the scoped transaction.
 * @returns Whatever `fn` returns.
 * @throws If `environmentId` isn't a UUID, or whatever `fn` throws (the transaction rolls back).
 *
 * @example
 * ```ts
 * const user = await withTenant(db, environmentId, (tx) =>
 *   tx.query.users.findFirst({ where: eq(users.emailNormalized, email) })
 * )
 * ```
 */
export async function withTenant<T>(
  db: Database,
  environmentId: string,
  fn: (tx: Transaction) => Promise<T>
): Promise<T> {
  // Belt and braces: the value is bound as a parameter anyway, but a non-UUID here is a bug.
  if (!UUID.test(environmentId)) {
    throw new Error('withTenant: environmentId must be a UUID')
  }
  return db.transaction(async (tx) => {
    // set_config(..., true) == SET LOCAL, but unlike SET it accepts a bind parameter.
    await tx.execute(sql`select set_config(${TENANT_SETTING}, ${environmentId}, true)`)
    return fn(tx)
  })
}
