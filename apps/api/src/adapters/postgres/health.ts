import type { Database } from '@tula/db'
import { sql } from 'drizzle-orm'
import type { HealthProbe } from '~/ports/health-probe'

/**
 * Readiness probe that runs `select 1`.
 *
 * @param db - The database.
 * @returns A probe named `database`.
 */
export function databaseProbe(db: Database): HealthProbe {
  return {
    name: 'database',
    async check() {
      await db.execute(sql`select 1`)
    },
  }
}
