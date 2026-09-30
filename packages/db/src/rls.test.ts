import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { eq, sql } from 'drizzle-orm'
import * as schema from './schema'
import { withTenant } from './tenant'
import {
  createTestDatabase,
  createTestTenant,
  queryRows,
  type TestDatabase,
  type TestTenant,
} from './testing'

let testDb: TestDatabase
let a: TestTenant
let b: TestTenant

async function insertUser(tenant: TestTenant, email: string) {
  return withTenant(testDb.db, tenant.environmentId, async (tx) => {
    const [user] = await tx
      .insert(schema.users)
      .values({ ...tenant, email, emailNormalized: email })
      .returning()
    return user!
  })
}

beforeAll(async () => {
  testDb = await createTestDatabase()
  a = await createTestTenant(testDb.db)
  b = await createTestTenant(testDb.db)
  await insertUser(a, 'maya@a.test')
  await insertUser(b, 'maya@b.test')
})

afterAll(() => testDb.close())

describe('row-level security guardrail', () => {
  test('every tula table with environment_id has RLS enabled AND forced, except api_keys', async () => {
    await testDb.setRole('postgres')
    const rows = await queryRows<{ table: string; enabled: boolean; forced: boolean }>(
      testDb.db,
      sql`
      select c.relname as table, c.relrowsecurity as enabled, c.relforcerowsecurity as forced
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'tula' and c.relkind = 'r'
        and exists (
          select 1 from pg_attribute a
          where a.attrelid = c.oid and a.attname = 'environment_id' and not a.attisdropped
        )
      order by c.relname
    `
    )
    await testDb.setRole('tula_app')
    // api_keys is the documented exception: resolving a key is what determines the tenant.
    const tenantTables = rows.filter((row) => row.table !== 'api_keys')
    expect(tenantTables.length).toBeGreaterThanOrEqual(10)
    expect(
      tenantTables.filter((row) => !row.enabled || !row.forced).map((row) => row.table)
    ).toEqual([])
  })
})

describe('tenant isolation (as the tula_app runtime role)', () => {
  test('an environment only sees its own rows', async () => {
    const emails = await withTenant(testDb.db, a.environmentId, (tx) =>
      tx.select({ email: schema.users.email }).from(schema.users)
    )
    expect(emails).toEqual([{ email: 'maya@a.test' }])
  })

  test('outside withTenant nothing is visible (fails closed)', async () => {
    expect(await testDb.db.select().from(schema.users)).toEqual([])
  })

  test('cannot insert a row into another environment', async () => {
    const attempt = withTenant(testDb.db, a.environmentId, (tx) =>
      tx.insert(schema.users).values({ ...b, email: 'x@b.test', emailNormalized: 'x@b.test' })
    )
    await expect(attempt).rejects.toThrow()
  })

  test('cannot update or delete another environment’s rows', async () => {
    const updated = await withTenant(testDb.db, a.environmentId, (tx) =>
      tx
        .update(schema.users)
        .set({ firstName: 'Hacked' })
        .where(eq(schema.users.emailNormalized, 'maya@b.test'))
        .returning()
    )
    const deleted = await withTenant(testDb.db, a.environmentId, (tx) =>
      tx.delete(schema.users).where(eq(schema.users.emailNormalized, 'maya@b.test')).returning()
    )
    expect(updated).toEqual([])
    expect(deleted).toEqual([])
    const stillThere = await withTenant(testDb.db, b.environmentId, (tx) =>
      tx.select({ firstName: schema.users.firstName }).from(schema.users)
    )
    expect(stillThere).toEqual([{ firstName: null }])
  })

  test('cannot move a row to another environment by updating environment_id', async () => {
    const attempt = withTenant(testDb.db, a.environmentId, (tx) =>
      tx.update(schema.users).set({ environmentId: b.environmentId, projectId: b.projectId })
    )
    await expect(attempt).rejects.toThrow()
  })

  test('the tenant setting does not outlive the transaction', async () => {
    await withTenant(testDb.db, a.environmentId, async () => undefined)
    const [row] = await queryRows<{ value: string | null }>(
      testDb.db,
      sql`select current_setting('tula.environment_id', true) as value`
    )
    expect(row?.value ?? '').toBe('')
  })

  test('the runtime role cannot read the migration history', async () => {
    await expect(
      (async () => await testDb.db.execute(sql`select * from drizzle.__drizzle_migrations`))()
    ).rejects.toThrow()
  })
})
