import { drizzle } from 'drizzle-orm/node-postgres'
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core'
import { Pool } from 'pg'
import * as schema from './schema'

/** The Drizzle schema object (all Tula tables). */
export type Schema = typeof schema

/**
 * A Drizzle database over any Postgres driver (node-postgres in production, PGlite in tests).
 * Adapters depend on this type, never on a specific driver.
 */
export type Database = PgDatabase<PgQueryResultHKT, Schema>

/** A transaction handle passed to `withTenant` / `db.transaction` callbacks. */
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0]

/** A database plus the function that releases its connections. */
export interface DatabaseHandle {
  db: Database
  close: () => Promise<void>
}

/**
 * Connect to Postgres with a node-postgres pool.
 *
 * Connect as the `tula_app` runtime role (see migration 0001), never as the table owner, so that
 * row-level security applies.
 *
 * @param url - Postgres connection string.
 * @param options - Pool size (default 10).
 * @returns The database and a `close` function for graceful shutdown.
 *
 * @example
 * ```ts
 * const { db, close } = createDatabase(env.DATABASE_URL)
 * ```
 */
export function createDatabase(url: string, options: { max?: number } = {}): DatabaseHandle {
  const pool = new Pool({ connectionString: url, max: options.max ?? 10 })
  return { db: drizzle(pool, { schema }), close: () => pool.end() }
}
