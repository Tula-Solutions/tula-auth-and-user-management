import { PGlite } from '@electric-sql/pglite'
import { type SQL, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import type { Database } from './client'
import { MIGRATION_CONFIG } from './migrate'
import * as schema from './schema'

/** An in-process, fully migrated Postgres for tests. */
export interface TestDatabase {
  /** Drizzle handle, connected as the `tula_app` role so row-level security applies. */
  db: Database
  /** Switch the session role, e.g. to `postgres` to inspect data across tenants. */
  setRole: (role: 'tula_app' | 'postgres') => Promise<void>
  close: () => Promise<void>
}

/**
 * Create a fresh PGlite database with every migration applied.
 *
 * PGlite is real Postgres compiled to WASM, so RLS, constraints and SQL behave as in production.
 * The handle starts as the unprivileged `tula_app` role (the API's runtime role).
 *
 * @returns The migrated test database.
 *
 * @example
 * ```ts
 * const { db, close } = await createTestDatabase()
 * afterAll(close)
 * ```
 */
export async function createTestDatabase(): Promise<TestDatabase> {
  const client = new PGlite()
  const db = drizzle(client, { schema })
  await migrate(db, MIGRATION_CONFIG)
  const setRole = async (role: 'tula_app' | 'postgres') => {
    await db.execute(sql.raw(role === 'postgres' ? 'reset role' : 'set role tula_app'))
  }
  await setRole('tula_app')
  return { db, setRole, close: () => client.close() }
}

/** Ids of a workspace → project → environment chain created for a test. */
export interface TestTenant {
  workspaceId: string
  projectId: string
  environmentId: string
}

/**
 * Insert a workspace, project and development environment.
 *
 * @param db - A database connected with rights on the control-plane tables.
 * @param kind - Environment kind (default `development`).
 * @returns The created ids.
 */
export async function createTestTenant(
  db: Database,
  kind: 'development' | 'production' = 'development'
): Promise<TestTenant> {
  const [workspace] = await db
    .insert(schema.workspaces)
    .values({ name: 'Test workspace' })
    .returning({ id: schema.workspaces.id })
  const [project] = await db
    .insert(schema.projects)
    .values({ workspaceId: workspace!.id, name: 'Test project' })
    .returning({ id: schema.projects.id })
  const [environment] = await db
    .insert(schema.environments)
    .values({ projectId: project!.id, kind })
    .returning({ id: schema.environments.id })
  return { workspaceId: workspace!.id, projectId: project!.id, environmentId: environment!.id }
}

/**
 * Run raw SQL and return its rows, typed.
 *
 * `Database` is driver-agnostic, so `db.execute()` returns `unknown`; both node-postgres and PGlite
 * results expose `rows`, which this narrows for test assertions.
 *
 * @param db - The database.
 * @param query - A `sql` template.
 * @returns The result rows.
 */
export async function queryRows<T>(db: Database, query: SQL): Promise<T[]> {
  const result = (await db.execute(query)) as { rows: T[] }
  return result.rows
}
