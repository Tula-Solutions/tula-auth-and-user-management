import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { eq, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { Pool } from 'pg'
import { createDatabase, type DatabaseHandle } from './client'
import { MIGRATION_CONFIG } from './migrate'
import * as schema from './schema'
import { withTenant } from './tenant'
import { createTestTenant, queryRows, type TestTenant } from './testing'

// Runs against the docker-compose Postgres (`docker compose up -d postgres`) with the real
// node-postgres pool, as the non-owner tula_api login. Only run via `bun run test:integration`
// (plain `bun test` doesn't discover *.integration.ts). Missing URLs fail loudly: a silently
// skipped suite would look green in CI.
const runtimeUrl = process.env.DATABASE_URL
const migrationUrl = process.env.DATABASE_MIGRATION_URL
if (!runtimeUrl || !migrationUrl) {
  throw new Error(
    'Integration tests need DATABASE_URL and DATABASE_MIGRATION_URL (see .env.example)'
  )
}

describe('Postgres integration', () => {
  let handle: DatabaseHandle
  let a: TestTenant
  let b: TestTenant
  const marker = `it-${Date.now()}`

  beforeAll(async () => {
    const owner = new Pool({ connectionString: migrationUrl, max: 1 })
    await migrate(drizzle(owner), MIGRATION_CONFIG)
    await owner.end()
    // A single pooled connection makes "does the setting leak to the next checkout?" deterministic.
    handle = createDatabase(runtimeUrl, { max: 1 })
    a = await createTestTenant(handle.db)
    b = await createTestTenant(handle.db)
    for (const [tenant, email] of [
      [a, `${marker}@a.test`],
      [b, `${marker}@b.test`],
    ] as const) {
      await withTenant(handle.db, tenant.environmentId, (tx) =>
        tx.insert(schema.users).values({ ...tenant, email, emailNormalized: email })
      )
    }
  })

  afterAll(async () => {
    // Cleanup runs as the owner: the runtime role deliberately has no DELETE on the control plane.
    // Deleting the workspaces cascades to everything the test created.
    const owner = createDatabase(migrationUrl, { max: 1 })
    for (const tenant of [a, b]) {
      await owner.db.delete(schema.workspaces).where(eq(schema.workspaces.id, tenant.workspaceId))
    }
    await owner.close()
    await handle.close()
  })

  test('the runtime login is not a superuser and does not own the tables', async () => {
    const rows = await queryRows<{ superuser: boolean; owner: boolean }>(
      handle.db,
      sql`
      select r.rolsuper as superuser,
             exists (select 1 from pg_tables where schemaname = 'tula' and tableowner = current_user) as owner
      from pg_roles r where r.rolname = current_user
    `
    )
    expect(rows[0]).toEqual({ superuser: false, owner: false })
  })

  test('each environment sees only its own users over the pool', async () => {
    const seen = await withTenant(handle.db, a.environmentId, (tx) =>
      tx.select({ email: schema.users.email }).from(schema.users)
    )
    expect(seen).toEqual([{ email: `${marker}@a.test` }])
  })

  test('the tenant setting does not leak to the next query on the same pooled connection', async () => {
    await withTenant(handle.db, a.environmentId, async () => undefined)
    expect(await handle.db.select().from(schema.users)).toEqual([])
  })

  test('cross-environment writes are rejected', async () => {
    const attempt = withTenant(handle.db, a.environmentId, (tx) =>
      tx.insert(schema.users).values({ ...b, email: 'x@b.test', emailNormalized: 'x@b.test' })
    )
    await expect(attempt).rejects.toThrow()
  })

  test('the runtime role cannot read the migration history', async () => {
    await expect(
      (async () => await handle.db.execute(sql`select 1 from drizzle.__drizzle_migrations`))()
    ).rejects.toThrow()
  })
})
