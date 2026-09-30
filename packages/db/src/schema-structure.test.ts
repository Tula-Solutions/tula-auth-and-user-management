import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { eq, getTableName, is } from 'drizzle-orm'
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core'
import * as schema from './schema'
import { withTenant } from './tenant'
import { createTestDatabase, createTestTenant, type TestDatabase, type TestTenant } from './testing'

const tables = (Object.values(schema) as unknown[]).filter((value): value is PgTable =>
  is(value, PgTable)
)
const tenantTables = tables.filter((table) =>
  getTableConfig(table).columns.some((column) => column.name === 'environment_id')
)

describe('declared schema', () => {
  test('every table lives in the tula schema', () => {
    expect(tables.map((table) => getTableConfig(table).schema)).toEqual(tables.map(() => 'tula'))
  })

  test('every foreign key resolves to a real table', () => {
    for (const table of tables) {
      for (const fk of getTableConfig(table).foreignKeys) {
        const reference = fk.reference()
        expect(getTableName(reference.foreignTable)).toBeString()
        expect(reference.foreignColumns.length).toBe(reference.columns.length)
      }
    }
  })

  test.each(tenantTables.filter((table) => getTableName(table) !== 'api_keys').map(getTableName))(
    '%s has the composite environment/project FK and the isolation policy',
    (name) => {
      const table = tenantTables.find((candidate) => getTableName(candidate) === name)!
      const config = getTableConfig(table)
      const composite = config.foreignKeys.find(
        (fk) => fk.getName() === `${name}_environment_project_fk`
      )
      expect(composite?.reference().columns.map((column) => column.name)).toEqual([
        'environment_id',
        'project_id',
      ])
      expect(config.policies.map((policy) => policy.name)).toEqual([`${name}_tenant_isolation`])
    }
  )
})

describe('timestamps', () => {
  let testDb: TestDatabase
  let tenant: TestTenant

  beforeAll(async () => {
    testDb = await createTestDatabase()
    tenant = await createTestTenant(testDb.db)
  })

  afterAll(() => testDb.close())

  test('updated_at moves forward on update, created_at does not', async () => {
    await withTenant(testDb.db, tenant.environmentId, async (tx) => {
      const [user] = await tx
        .insert(schema.users)
        .values({ ...tenant, email: 't@t.test', emailNormalized: 't@t.test' })
        .returning()
      await Bun.sleep(5)
      const [updated] = await tx
        .update(schema.users)
        .set({ firstName: 'Maya' })
        .where(eq(schema.users.id, user!.id))
        .returning()
      expect(updated!.createdAt).toEqual(user!.createdAt)
      expect(updated!.updatedAt.getTime()).toBeGreaterThan(user!.updatedAt.getTime())
    })
  })
})
